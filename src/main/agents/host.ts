// Connects the agent service to the rest of Corillo's main process: its open
// documents, the files on disk, and the window (for saving the person's
// pending edits, locking a tab while an agent edits, and showing new text).
import * as fs from "node:fs";
import * as net from "node:net";
import * as path from "node:path";
import { clipboard, ipcMain } from "electron";
import { handBackSentence } from "../../core/agents";
import type { CommentService } from "../comment-service";
import { exportForAgent, exportSuggestion, isMadeFrom } from "../export";
import { ExportError } from "../export-prep";
import { AgentService, noHooks, type AgentDoc, type AgentHooks, type AgentHost, type FlushResult } from "./agent-service";
import { AgentError } from "./shapes";
import { listenForAgents } from "./socket-server";
import { checkOpenable, createProblem, openProblem } from "./file-checks";
import { ChangedMeanwhile, FileProblem, problemText, readOpenText, readsBackAs, sameFile, type StillAs } from "../files";
import { agentChangeArrived } from "../memory-note";

const FLUSH_TIMEOUT_MS = 10_000;

interface MainDoc extends AgentDoc {
  diskText: string;
  /** Deleted or in the Trash, as far as Corillo has found out. */
  missing?: boolean;
}

/** What the main process lends the agents. */
export interface MainParts {
  docs: Map<string, MainDoc>;
  openDocument(filePath: string, options: { background?: boolean }): MainDoc | null;
  /** The document in front in the window, if any. */
  front?(): MainDoc | null;
  readText(filePath: string): string;
  /** Writes the file whole, reading it back (see files.ts's writeDocument): its text if it changed again straight after, else null. */
  writeFileAtomic(filePath: string, text: string, stillAs?: StillAs): string | null;
  /** Corillo made a new file here: a new document, even if one by that name was here before. */
  created(filePath: string): void;
  /** Corillo wrote the document's file. */
  saved(doc: MainDoc): void;
  /** These web pictures wait for the person in the document (an agent's reply options would add them). Required (G21-10). */
  picturesWait(storeId: string, addresses: string[]): void;
  /** The file holds another app's change Corillo hasn't taken in yet: record it as Corillo records any outside change. */
  outside?(doc: MainDoc, text: string): void;
  /** The document's file isn't at its path: find out where it went (the tab follows a rename or move). */
  lookFor?(doc: MainDoc): void;
  send(channel: string, ...args: unknown[]): void;
  /** These agents are on a document: Corillo remembers them for the @ list in comments. */
  seen?(names: string[]): void;
  /** The agents connected now changed (see AgentHost.connected). */
  connected?(names: string[], left?: string, clients?: string[]): void;
}

/** Nothing is at the path (or its folder is gone), as readDisk's "missing" has it. */
function isGone(filePath: string): boolean {
  try {
    fs.statSync(filePath);
    return false;
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code;
    return code === "ENOENT" || code === "ENOTDIR";
  }
}

export function setUpAgents(parts: MainParts, comments: CommentService, hooks: AgentHooks = noHooks) {
  const { docs, send } = parts;
  const withStore = (storeId: string) => [...docs.values()].filter((d) => d.storeId === storeId);

  let nextFlush = 1;
  /** Each ask to save a tab's pending edits: what waits on the answer, until it times out. */
  const flushes = new Map<number, (result: FlushResult) => void>();
  /** The tab each ask is for, kept until the window answers or goes, past the time-out: its save may still be on its way. */
  const flushingTabs = new Map<number, string>();
  ipcMain.on("agent:flushed", (_e, requestId: number, result: string) => {
    flushingTabs.delete(requestId);
    flushes.get(requestId)?.(result === "saved" || result === "conflict" || result === "unsaved" ? result : "no-answer");
    flushes.delete(requestId);
  });

  const host: AgentHost = {
    find(filePath) {
      const abs = path.resolve(filePath);
      // Also the same file by another path: through a linked folder, or with other capitals.
      const found = [...docs.values()].find((d) => d.filePath === abs) ?? [...docs.values()].find((d) => sameFile(d.filePath, abs));
      if (found) return found;
      // A path the document had before it was renamed or moved outside Corillo, if nothing else is there now.
      return fs.existsSync(abs) ? null : ([...docs.values()].find((d) => d.formerPaths?.has(abs)) ?? null);
    },
    open(filePath) {
      checkOpenable(filePath, parts.readText);
      const doc = parts.openDocument(filePath, { background: true });
      if (!doc) throw new AgentError(`Corillo couldn't open ${path.basename(filePath)}.`);
      return doc;
    },
    openDocs: () => [...docs.values()],
    front: () => parts.front?.() ?? null,
    byStoreId: (storeId) => withStore(storeId)[0] ?? null,
    read(doc) {
      try {
        // Read as an open document, not as a file being opened: its text may start like a PDF's (R22-4).
        return readOpenText(doc.filePath);
      } catch (err) {
        // A file that is gone is read as Corillo last knew it (the person chooses where it goes). One that is there
        // but can't be read as text is said so, in the words an open gets (the review of Batch 21, G21-5).
        if (isGone(doc.filePath)) return (doc as MainDoc).diskText;
        // Which file, and what to do next, as the take's other refusals say (R22-13).
        if (err instanceof FileProblem) throw new AgentError(`Corillo can't read ${path.basename(doc.filePath)} as it is now. ${err.message} Ask the person to sort it out, then try again.`);
        throw new AgentError(openProblem(err, doc.filePath));
      }
    },
    write(doc, text, from) {
      const d = doc as MainDoc;
      const name = path.basename(d.filePath);
      // A document moved or deleted outside Corillo is never re-created unasked: the person chooses where it goes.
      // (Whether it's there is a look at the folder, not a read of the whole file.)
      const gone = isGone(d.filePath);
      if (gone && !d.missing) {
        parts.lookFor?.(d);
        throw new AgentError(
          `${name} isn't where it was a moment ago: it was renamed, moved or deleted outside Corillo, so your change wasn't made. Try again in a few seconds: if it was renamed or moved, Corillo follows it and your change goes to its new place.`,
        );
      }
      if (gone) {
        throw new AgentError(
          `${name} was moved or deleted outside Corillo, so your change wasn't made. The person can save it where it was or somewhere else in Corillo. Call finish_editing and tell them in the chat.`,
        );
      }
      // Another app's change the agent's edit was made on goes into the history as its own version first, not as the agent's.
      if (from !== undefined && from !== d.diskText) parts.outside?.(d, from);
      let changedAfter: string | null;
      try {
        // Only onto the text the edit was made from: another app's save landing meanwhile is never written over (A16-1).
        changedAfter = parts.writeFileAtomic(d.filePath, text, from === undefined ? undefined : { text: from });
      } catch (err) {
        // Another app saved the file in the moment Corillo was writing: the agent can act on that (Batch 18, A16-1).
        if (err instanceof ChangedMeanwhile) throw new AgentError("The file changed while your edit was being saved. Read it again and redo your edit.");
        throw new AgentError(`Your change to ${name} couldn't be saved: ${problemText(err)}. Nothing was changed.`);
      }
      d.diskText = text;
      // The window shows the change while the history records it here.
      send("agent:text", d.id, text);
      agentChangeArrived(docs); // counted for Corillo's memory note (memory-note.ts)
      parts.saved(d);
      // Changed again straight after (a cloud folder, another app): taken in as any outside change, never written over.
      if (changedAfter !== null) send("doc:changed-on-disk", d.id, changedAfter);
    },
    coming(doc, text) {
      send("agent:text-coming", doc.id, text);
    },
    create(filePath, text) {
      try {
        fs.mkdirSync(path.dirname(filePath), { recursive: true });
        fs.writeFileSync(filePath, text, { encoding: "utf8", flag: "wx" });
      } catch (err) {
        if ((err as NodeJS.ErrnoException).code === "EEXIST") {
          throw new AgentError(`There's already a file at ${filePath}. Choose another name, or open it with open_document.`);
        }
        throw new AgentError(createProblem(err, filePath));
      }
      parts.created(filePath);
      // Read back, as every save is (roadmap Batch 14, item 1): another app may have changed it in the same moment.
      if (!readsBackAs(filePath, text)) {
        throw new AgentError(`${path.basename(filePath)} was made, but it doesn't hold the text you gave: something else changed it at the same moment. Open it (open_document) and read it before you go on.`);
      }
    },
    flush(doc, lock) {
      return new Promise((resolve) => {
        const requestId = nextFlush++;
        const timer = setTimeout(() => {
          flushes.delete(requestId);
          resolve("no-answer");
        }, FLUSH_TIMEOUT_MS);
        flushes.set(requestId, (result) => {
          clearTimeout(timer);
          resolve(result);
        });
        flushingTabs.set(requestId, doc.id);
        send("agent:flush", requestId, doc.id, lock);
      });
    },
    announce(storeId, agents) {
      for (const d of withStore(storeId)) send("agents:changed", d.id, agents);
      if (agents.length) parts.seen?.(agents.map((a) => a.name));
    },
    backToYou(storeId) {
      for (const d of withStore(storeId)) send("agent:back-to-you", d.id);
    },
    forYou(storeId, agentName) {
      for (const d of withStore(storeId)) send("agent:for-you", d.id, agentName);
    },
    sendLost(storeId, agentName, why) {
      for (const d of withStore(storeId)) send("agent:send-lost", d.id, agentName, why);
    },
    connected(names, left, clients) {
      parts.connected?.(names, left, clients);
    },
    passEnded(storeId, summary) {
      for (const d of withStore(storeId)) send("agent:pass-ended", d.id, summary);
    },
    kindOf(filePath) {
      try {
        return fs.statSync(filePath).isDirectory() ? "folder" : "file";
      } catch {
        return null;
      }
    },
    picturesWait(doc, addresses) {
      parts.picturesWait(doc.storeId, addresses);
    },
    exportPlace(doc, kind) {
      return exportSuggestion(doc.filePath, kind);
    },
    isMadeFrom(doc, filePath) {
      return isMadeFrom(doc.filePath, filePath);
    },
    async exportDocument(doc, kind, outputPath, agentName) {
      try {
        const result = await exportForAgent(doc.filePath, kind, outputPath);
        // The person sees the same notice as after their own export, saying who made it.
        send("export:by-agent", { outputPath: result.outputPath, name: path.basename(result.outputPath), notes: result.notes, agent: agentName, docId: doc.id });
        return result;
      } catch (err) {
        if (err instanceof ExportError) throw new AgentError(`The export didn't work: ${err.message}`);
        throw err;
      }
    },
  };

  // The tests shorten the little while an agent has to wait again after a pass.
  const grace = Number(process.env.CORILLO_WAIT_GRACE_MS);
  const service = new AgentService(host, comments, hooks, Number.isFinite(grace) && grace > 0 ? { graceMs: grace } : {});

  // The person presses Take over in the editing notice.
  ipcMain.handle("agent:take-over", (_e, docId: string) => {
    const doc = docs.get(docId);
    if (doc) return service.takeOver(doc.storeId);
  });

  // Send to Claude in the Comments panel: the agent listening on the document gets it (roadmap Batch 2, item 1).
  ipcMain.handle("agent:send", (_e, docId: unknown, agent: unknown) => {
    const doc = typeof docId === "string" ? docs.get(docId) : undefined;
    if (!doc) return { sent: false, problem: "That document isn't open." };
    return service.send(doc.storeId, typeof agent === "string" ? agent : undefined);
  });
  // Copy for Claude, where no agent is listening: the sentence to paste in its chat.
  ipcMain.handle("agent:copy-for", (_e, docId: unknown, comments: unknown) => {
    const doc = typeof docId === "string" ? docs.get(docId) : undefined;
    if (!doc) return false;
    clipboard.writeText(handBackSentence(doc.filePath, typeof comments === "number" ? comments : 0));
    return true;
  });

  let server: net.Server | null = null;
  let socketFile = "";
  let problem: string | null = null;
  return {
    service,
    /** Start listening for agents. Only the one running Corillo does this. `first`: what a call waits for first, if anything. */
    listen(socketPath: string, first?: () => Promise<void> | null): void {
      socketFile = socketPath;
      server = listenForAgents(socketPath, service, (text) => (problem = text), first);
    },
    /** Why agents can't reach Corillo, in words for the person (for the Connect Agents screen), or null. */
    problem: () => problem,
    /** Whether the tab is saving the person's edits because an agent asked: the one save the guard lets through while an agent holds it. */
    flushing: (tabId: string) => [...flushingTabs.values()].includes(tabId),
    /** The window closed: it answers nothing, so no tab is saving for an agent any more. */
    windowGone(): void {
      flushingTabs.clear();
    },
    close(): void {
      service.quitting(); // every agent waiting for a review is told, while it can still hear
      server?.close();
      server = null;
      if (socketFile && process.platform !== "win32") fs.rmSync(socketFile, { force: true });
    },
  };
}
