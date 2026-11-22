// The document on disk: its file watched, followed when it moves, saved, and changes from outside or from an agent taken in.
// It runs without Electron: main.ts lends it the open documents, the window's messages and Corillo's records
// (setUpDisk), so its save path is unit-tested over a throwaway folder (tests/unit/doc-on-disk.test.ts).
import * as fs from "node:fs";
import * as path from "node:path";
import { pathToFileURL } from "node:url";
import type { PassNote, Thread } from "../core/comments";
import { shownName } from "../core/doc-names";
import { addedWebPictures, forgetReadTexts, webPicturesOfText } from "../core/web-pictures";
import { ChangedMeanwhile, problemText, readDisk, readText, realTarget, fileStamp, writeDocument, type StillAs } from "./files";
import { RecordsUnreadable } from "./store";
import { changingPlaces, inTrash, placeAvailable, putAway, stillOnDisk, thereNow, whereNow, type Identity } from "./whereabouts";
import type { MainParts } from "./agents/host";
import type * as History from "./history";
import type { RecoveryStore } from "./recovery";
import type { VersionHistory } from "./version-store";

export interface OpenDoc {
  id: string;
  /** The document's folder in Corillo's data folder (comments, history). */
  storeId: string;
  filePath: string;
  /** The file's text as Corillo last read or wrote it. */
  diskText: string;
  watcher?: fs.FSWatcher;
  /** The file was deleted outside Corillo, or moved to the Trash (or can't be found). */
  missing?: boolean;
  /** The file's identity on disk as Corillo last saw it, to find it again if it's renamed or moved. */
  identity?: Identity;
  /** Where it was before it was renamed or moved outside Corillo, so an agent using an old path still finds it. */
  formerPaths?: Set<string>;
  /** Corillo is finding out where the file went (waiting a moment first). */
  looking?: NodeJS.Timeout | true;
}

/** A document as the window gets it, to open in a tab (the bridge takes this shape from here). */
export interface DocInfo {
  id: string;
  name: string;
  filePath: string;
  dirUrl: string;
  text: string;
  threads: Thread[];
  /** Agents' notes about their passes, waiting for the person (roadmap Batch 2, item 3). */
  notes: PassNote[];
  /** Web pictures an agent added, waiting for the person to show them (roadmap Batch 18, item 1). */
  waitingPictures: string[];
  /** Past the list's cap, every web picture in the document waits but these (roadmap Batch 19, item 2); null if the list says which. */
  everyWebPictureWaits: string[] | null;
}

/** Why a document's file can't be found: deleted, on a drive or cloud folder that isn't there, or Corillo can't tell. */
export type MissingKind = "deleted" | "away" | "unknown";

/** Where a document's file is now, after it was renamed or moved outside Corillo. */
export interface NewPlace {
  name: string;
  filePath: string;
  dirUrl: string;
}

/** What Rename or Move, and Save somewhere else, answer the window (main.ts). */
export interface RenameResult {
  info: DocInfo;
  oldDirUrl: string;
  /** Where the pictures folder was and is now, if it moved. */
  movedImages: { from: string; to: string } | null;
  /** Saved somewhere else, and the file there changed again in the moment after, to this text. */
  changedAfter?: string;
}

/** What main.ts lends the document on disk. */
interface DiskHost {
  docs: Map<string, OpenDoc>;
  send(channel: string, ...args: unknown[]): void;
  notice(text: string, detail: string, docId?: string): void;
  store: Pick<VersionHistory, "idFor" | "created" | "saved" | "moved" | "noticedMissing" | "markEveryWebPictureWaits">;
  recovery: Pick<RecoveryStore, "clear">;
  historyHooks: Pick<typeof History.historyHooks, "saved" | "overwriting" | "outside">;
  replaceRecent(oldPath: string, newPath: string): void;
  picturesWait(storeId: string, change: { wait?: string[]; shown?: string[] }): void;
  /** These wait in the document, in the app's own list (waiting-pictures.ts) and its records, with no tab told: the way round when picturesWait failed. */
  keepWaiting(storeId: string, wait: string[]): void;
}

let docs: DiskHost["docs"];
let send: DiskHost["send"];
let notice: DiskHost["notice"];
let store: DiskHost["store"];
let recovery: DiskHost["recovery"];
let historyHooks: DiskHost["historyHooks"];
let replaceRecent: DiskHost["replaceRecent"];
let picturesWait: DiskHost["picturesWait"];
let keepWaiting: DiskHost["keepWaiting"];

/** Given its parts once, as main.ts starts (and by each unit test). */
export function setUpDisk(host: DiskHost): void {
  ({ docs, send, notice, store, recovery, historyHooks, replaceRecent, picturesWait, keepWaiting } = host);
}

/**
 * Corillo's own records of a document (where it is, for its comments and
 * history) are brought up to date once the document itself is safe. A
 * problem with them (the data folder full, or not allowed) never shows as
 * the document not being saved: it's said in the window's corner, once per
 * spell of trouble (his call, roadmap Batch 22, item 2, G21-18). The spell
 * ends when an update given as `ends` goes through (at a save, the last of
 * its records, and only if the ones before it went through too: R22-8),
 * or the document closes: kept with the open document itself, the mark goes
 * with it, and a document opened again starts afresh.
 */
const recordsTold = new WeakSet<OpenDoc>();
export function keepRecords(doc: OpenDoc, update: () => void, after: "save" | "other" = "other", ends = false): boolean {
  try {
    update();
    if (ends) recordsTold.delete(doc);
    return true;
  } catch (err) {
    console.error(`Couldn't update Corillo's records of ${doc.filePath}.`, err);
    if (recordsTold.has(doc)) return false;
    recordsTold.add(doc);
    const name = shownName(path.basename(doc.filePath));
    if (after === "save") notice(`${name} is saved, but Corillo couldn't update what it keeps beside it.`, `${recordsProblem(err)}. Corillo will try again at the next save.`, doc.id);
    else notice(`Corillo couldn't update what it keeps beside ${name}.`, `${recordsProblem(err)}. The document itself isn't affected.`, doc.id);
    return false;
  }
}

function recordsProblem(err: unknown): string {
  if (err instanceof RecordsUnreadable) return "Corillo's data folder can't be read right now";
  switch ((err as NodeJS.ErrnoException | null)?.code) {
    case "ENOSPC":
    case "EDQUOT":
      return "The disk is full";
    case "EACCES":
    case "EPERM":
    case "EROFS":
      return "Corillo isn't allowed to change its data folder";
    default:
      return "Something went wrong in Corillo's data folder";
  }
}

/** The tab closed (or the window): its file's watcher stops, and so does any wait to find where the file went. */
export function letGo(doc: OpenDoc): void {
  doc.watcher?.close();
  if (doc.looking && doc.looking !== true) clearTimeout(doc.looking);
}

export function watchFile(doc: OpenDoc): void {
  doc.watcher?.close();
  doc.watcher = undefined;
  // A symlinked document changes where its real file is.
  const target = realTarget(doc.filePath);
  let timer: NodeJS.Timeout | null = null;
  try {
    doc.watcher = fs.watch(path.dirname(target), (_event, changed) => {
      if (changed && changed !== path.basename(target)) return;
      if (timer) clearTimeout(timer);
      timer = setTimeout(() => {
        if (!docs.has(doc.id)) return;
        const disk = readDisk(doc.filePath);
        if (disk.kind === "unreadable") return; // mid-write, or not ours to judge yet
        if (disk.kind === "missing") {
          lookFor(doc); // renamed, moved, in the Trash, or deleted? Never re-created unasked.
          return;
        }
        noteIdentity(doc); // another app may have saved it as a new file
        if (doc.missing) {
          doc.missing = false;
          send("doc:found", doc.id);
        }
        if (disk.text !== doc.diskText) send("doc:changed-on-disk", doc.id, disk.text);
      }, 150);
    });
    doc.watcher.on("error", () => {
      // The folder itself went away. Saving notices and says so.
      doc.watcher?.close();
      doc.watcher = undefined;
    });
  } catch {
    // Watching is a convenience; saving still refuses to overwrite outside changes.
  }
}

/** Note the file's identity on disk now, to find it again if it's renamed or moved. */
export function noteIdentity(doc: OpenDoc): void {
  try {
    const s = fs.statSync(doc.filePath);
    doc.identity = { ino: s.ino, dev: s.dev };
  } catch {
    // not there right now; what Corillo knew stays
  }
}

// When a document's file isn't where it was ------------------------------------------
// Another app may be saving it (deleting it, or moving it aside, then writing
// it again), so Corillo waits a moment before deciding. Then: renamed or
// moved, the tab follows it; in the Trash, the tab closes (or says so, when
// that would lose words); deleted, the tab keeps the text and says so.

const LOOK_AFTER_MS = 1500;

function lookFor(doc: OpenDoc): void {
  if (doc.looking || doc.missing) return;
  doc.looking = setTimeout(() => void whereDidItGo(doc), LOOK_AFTER_MS);
}

async function whereDidItGo(doc: OpenDoc): Promise<void> {
  doc.looking = true;
  try {
    const there = thereNow(doc.filePath);
    if (!docs.has(doc.id) || there) return; // back: any change shows the usual way
    if (there === null) {
      // Corillo isn't allowed to look (a folder locked, a disk that didn't answer): out of reach, as on a drive that's away. Its days don't run.
      doc.missing = true;
      send("doc:missing", doc.id, "away" satisfies MissingKind);
      return;
    }
    const id = doc.identity;
    const onDisk = id ? stillOnDisk(id, doc.filePath) : null;
    const went = onDisk && id ? (await whereNow([id]))[0] : null;
    if (!docs.has(doc.id) || fs.existsSync(doc.filePath)) return;
    const reached = went && asReached(went, doc.filePath);
    if (reached && !inTrash(went) && !putAway(reached, doc.filePath)) {
      follow(doc, reached);
      return;
    }
    doc.missing = true;
    if (reached && !inTrash(went)) {
      // Put away by a program (a sync tool's cache, a temporary folder): deleted, as far as the person can see.
      keepRecords(doc, () => store.noticedMissing(doc.storeId));
      send("doc:missing", doc.id, "deleted" satisfies MissingKind);
      return;
    }
    if (went) {
      keepRecords(doc, () => store.noticedMissing(doc.storeId)); // its 30 days start now
      send("doc:trashed", doc.id);
      return;
    }
    const away = !placeAvailable(doc.filePath, changingPlaces());
    if (onDisk === false && !away) keepRecords(doc, () => store.noticedMissing(doc.storeId));
    send("doc:missing", doc.id, (away ? "away" : onDisk === false ? "deleted" : "unknown") satisfies MissingKind);
  } finally {
    doc.looking = undefined;
  }
}

/**
 * The Mac names where a file went by its real folders. Through a linked
 * folder the person reached it by (a vault linked in, say), keep their way.
 */
function asReached(found: string, was: string): string {
  for (let dir = path.dirname(was); dir !== path.dirname(dir); dir = path.dirname(dir)) {
    const real = realTarget(dir);
    if (found.startsWith(real + path.sep)) return dir + found.slice(real.length);
  }
  return found;
}

/** The document has moved from `from`: an agent using that path still reaches it (while nothing else is there) and is told the new one. */
function noteFormer(doc: OpenDoc, from: string, to: string): void {
  if (from === to) return;
  const former = (doc.formerPaths ??= new Set());
  former.delete(to);
  former.add(from);
  if (former.size > 8) former.delete(former.values().next().value!);
}

/**
 * The document lives at `to` from now on: moved outside Corillo (`follow`),
 * renamed or moved by the person, or saved somewhere else with `text`. Its
 * former path (when `former`), its path, the text on disk (when saved), its
 * comments and history, its identity on disk, its watcher and the recent list
 * all follow, in this one order (S21-47). `found` clears `missing`. Returns
 * whether the records were kept, as keepRecords does.
 */
export function nowAt(doc: OpenDoc, to: string, how: { former: boolean; found: boolean; text?: string }): boolean {
  const from = doc.filePath;
  if (how.former) noteFormer(doc, from, to);
  doc.filePath = to;
  if (how.text !== undefined) doc.diskText = how.text;
  if (how.found) doc.missing = false;
  const text = how.text;
  const kept =
    text === undefined ? keepRecords(doc, () => store.moved(doc.storeId, to)) : keepRecords(doc, () => store.saved(doc.storeId, to, text), "save");
  noteIdentity(doc);
  watchFile(doc);
  replaceRecent(from, to);
  return kept;
}

/** The document's file was renamed or moved outside Corillo: the tab, its comments and history follow it. */
export function follow(doc: OpenDoc, to: string): void {
  const wasMissing = doc.missing;
  nowAt(doc, to, { former: true, found: true });
  send("doc:moved", doc.id, { name: path.basename(to), filePath: to, dirUrl: pathToFileURL(path.dirname(to)).href } satisfies NewPlace);
  if (wasMissing) send("doc:found", doc.id);
  const disk = readDisk(to);
  if (disk.kind === "text" && disk.text !== doc.diskText) send("doc:changed-on-disk", doc.id, disk.text); // moved and changed
}

/** Coming back to Corillo: check, cheaply, that each open document is still where it was (a folder renamed in Finder, a drive back). */
export function recheckOpen(): void {
  for (const doc of docs.values()) {
    if (!fs.existsSync(doc.filePath)) lookFor(doc);
    else if (doc.missing) {
      doc.missing = false;
      noteIdentity(doc);
      watchFile(doc);
      send("doc:found", doc.id);
      const disk = readDisk(doc.filePath);
      if (disk.kind === "text" && disk.text !== doc.diskText) send("doc:changed-on-disk", doc.id, disk.text);
    }
  }
}

// Saving -----------------------------------------------------------------------

/**
 * Saved (changedAfter: the file changed again in the moment after, to that
 * text, see files.ts's writeDocument); or not, because the file changed
 * outside Corillo (diskText), is gone (missing), or couldn't be written
 * (problem, in plain words). The window gets it as it is (the bridge's SaveResult).
 */
export type SaveOutcome = { ok: true; changedAfter?: string } | { ok: false; diskText: string } | { ok: false; missing: true } | { ok: false; problem: string };

/**
 * Save, unless the file changed on disk since Corillo last saw it, or is
 * gone, or can't be read: then the tab is told, and nobody's change is
 * silently overwritten and nothing is re-created unasked. A forced save (the
 * person chose) writes regardless.
 */
export function saveDoc(doc: OpenDoc, text: string, force: boolean, tries = 3): SaveOutcome {
  // Looked at again just before the swap: another app's save landing meanwhile is never written over (A16-1).
  let stillAs: StillAs | undefined;
  if (!force) {
    const stamp = fileStamp(doc.filePath);
    if (stamp) stillAs = { stamp };
    const disk = readDisk(doc.filePath);
    if (disk.kind === "missing") {
      if (doc.missing) return { ok: false, missing: true };
      lookFor(doc); // renamed or moved? Then the tab follows it and saves there.
      return { ok: false, problem: "the file isn't where it was" };
    }
    if (disk.kind === "unreadable") return { ok: false, problem: disk.problem };
    if (disk.text !== doc.diskText) return { ok: false, diskText: disk.text };
  }
  if (force) historyHooks.overwriting(doc.filePath, doc.diskText); // the other text stays in the history
  let changedAfter: string | null;
  try {
    changedAfter = writeDocument(doc.filePath, text, stillAs);
  } catch (err) {
    // Changed meanwhile: looked at again, so the tab is told as for any outside change.
    if (err instanceof ChangedMeanwhile && tries > 1) return saveDoc(doc, text, false, tries - 1);
    return { ok: false, problem: problemText(err) };
  }
  doc.diskText = text;
  doc.missing = false;
  noteIdentity(doc);
  const kept = keepRecords(doc, () => store.saved(doc.storeId, doc.filePath, text), "save");
  historyHooks.saved(doc.storeId, text);
  keepRecords(doc, () => recovery.clear(doc.storeId), "save", kept);
  // Changed again straight after (a cloud folder, another app): the window takes it in as any outside change.
  return changedAfter === null ? { ok: true } : { ok: true, changedAfter };
}

/** The window took in an outside change (its doc:accept-disk, in main.ts). */
export function acceptDisk(doc: OpenDoc, text: string): void {
  // The window took in an outside change. If the file has changed again since
  // (an agent saved a moment later, say), this answer is out of date: keep
  // what Corillo knows is on disk now, and keep the history in order.
  const disk = readDisk(doc.filePath);
  if (disk.kind === "text" && disk.text !== text) return;
  doc.diskText = text;
  noteIdentity(doc);
  keepRecords(doc, () => store.saved(doc.storeId, doc.filePath, text), "other", true); // another app may have saved it as a new file: Corillo still knows it
  historyHooks.outside(doc.filePath, text);
}

/** An agent wrote this text into the document at this path: the web pictures it added wait. */
function agentWrote(filePath: string, text: string, before?: string): void {
  const doc = [...docs.values()].find((d) => d.filePath === filePath);
  const storeId = doc?.storeId ?? store.idFor(filePath, text);
  const wait = addedWebPictures(before ?? doc?.diskText ?? "", text);
  if (wait.length) picturesWait(storeId, { wait });
}

/**
 * Noting the web pictures an agent's change added failed: every web picture
 * in the text it wrote waits instead (the review of Batch 19, R19-6), kept
 * in the app's own list and the document's records (so the request guard
 * knows them at once, and what the records can't keep is held while the app
 * runs: the review of Batch 20, R20-4) and told to every tab open on it,
 * before the change itself is sent. Only if that fails too does the write stand as
 * it is, with a line in the log. The agent is told what it would be anyway.
 */
function everyPictureWaits(filePath: string, text: string, err: unknown): void {
  console.error("Couldn't note the web pictures an agent's change added, so every web picture in it waits.", err);
  try {
    const wait = [...webPicturesOfText(text)];
    if (!wait.length) return;
    const open = [...docs.values()].filter((d) => d.filePath === filePath);
    try {
      keepWaiting(open[0]?.storeId ?? store.idFor(filePath, text), wait);
    } finally {
      for (const d of open) send("pictures:waiting", d.id, { wait, shown: [] });
    }
  } catch (again) {
    console.error("Couldn't keep every web picture in an agent's change waiting either: the change stands as it is.", again);
  }
}

/**
 * A document an agent made whose records or text couldn't be read (the
 * review of Batch 20, R20-3): every web picture in it waits, marked in its
 * records, with no need of the text. Only if Corillo's records can't be
 * reached or written either does the document stand as it is, with a line in
 * the log: its pictures then load when it opens.
 */
function everyWebPictureWaitsIn(filePath: string, err: unknown): void {
  console.error("Couldn't note the web pictures in a document an agent made, so every web picture in it waits.", err);
  try {
    store.markEveryWebPictureWaits(store.idFor(filePath), []);
  } catch (again) {
    console.error("Couldn't keep every web picture in a document an agent made waiting either: it stands as it is.", again);
  }
}

/** How an agent's change reaches the document on disk: lent to the agents with the rest of main.ts's parts (agents/host.ts). */
export const forAgents = {
  writeFileAtomic: (filePath, text, stillAs) => {
    const changedAfter = writeDocument(filePath, text, stillAs);
    try {
      agentWrote(filePath, text); // before the window is sent the change
    } catch (err) {
      // The file holds the agent's text now: the agent is told so, not that nothing changed (the review's R18-9).
      everyPictureWaits(filePath, text, err);
    }
    return changedAfter;
  },
  created: (filePath) => {
    let text: string | null = null;
    try {
      store.created(filePath);
      text = readText(filePath);
      agentWrote(filePath, text, ""); // every web picture in a document an agent made is its
    } catch (err) {
      if (text === null) everyWebPictureWaitsIn(filePath, err);
      else everyPictureWaits(filePath, text, err);
    } finally {
      forgetReadTexts();
    }
  },
  lookFor: (doc) => lookFor(doc),
  saved: (doc) => {
    noteIdentity(doc);
    if (doc.missing) {
      // Corillo has just written it: the file is back (its watcher may have gone with its folder), as recheckOpen finds.
      doc.missing = false;
      watchFile(doc);
      send("doc:found", doc.id);
    }
    keepRecords(doc, () => store.saved(doc.storeId, doc.filePath, doc.diskText), "save", true);
    historyHooks.saved(doc.storeId, doc.diskText); // counted as the agent's, inside its pass
  },
  // As the window's doc:accept-disk does, for a change the window hasn't taken in yet.
  outside: (doc, text) => {
    doc.diskText = text;
    noteIdentity(doc);
    keepRecords(doc, () => store.saved(doc.storeId, doc.filePath, text), "other", true);
    historyHooks.outside(doc.filePath, text);
  },
} satisfies Pick<MainParts, "writeFileAtomic" | "created" | "lookFor" | "saved" | "outside">;
