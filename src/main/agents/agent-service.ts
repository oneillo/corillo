// What agents can do in Corillo, one session per connected agent: open and
// create documents, read the latest text cheaply, take a document for an
// editing pass, edit it, answer the comments addressed to them, hand the
// document back, look back through its versions and export it. It keeps the
// turn-taking rules: one editor at a time, the person can take a document
// back, and a session that ends gives back what it held. No window or
// Electron code here; the app supplies an AgentHost and the history.
import * as path from "node:path";
import { randomUUID } from "node:crypto";
import type { Anchor } from "../../core/anchors";
import { CommentError, newId, type Author, type Message, type Thread } from "../../core/comments";
import { applyOption, checkOptions, choicesOf, optionsOf, standing, type ReplyOption } from "../../core/options";
import { webPicturesOfText } from "../../core/web-pictures";
import { MARKDOWN_NAMED, OPENS_AS_MARKDOWN } from "../../core/doc-names";
import {
  Roster,
  Turns,
  answeredBy,
  cleanName,
  mayReply,
  nameForClient,
  nameProblem,
  pickedUpBy,
  picksUpUnnamed,
  startedBy,
  waitingFor,
  type Member,
  type Pass,
} from "../../core/agents";
import { applyEdits, asItReads, catchUp, diffLines, formatHunks, type Edit } from "../../core/text-changes";
import { spliceLoss } from "../../core/write-check";
import {
  OffsetMap,
  PassLinks,
  forgetWords,
  plainText,
  reading,
  syncsFor,
  updateChanges,
  type ChangeSpan,
} from "../../core/change-links";
import { summaryText } from "../../core/change-summary";
import { formatDate, inSentence, relativeTime, type Version } from "../../core/versions";
import type { CommentService } from "../comment-service";
import { wordForAgent } from "../word-copy";
import { Listeners } from "./listening";
import {
  AgentError,
  Cancelled,
  Held,
  Later,
  noHooks,
  type AgentDoc,
  type AgentHooks,
  type AgentHost,
  type AgentInfo,
  type Call,
  type CatchUp,
  type Ended,
  type FlushResult,
  type Freed,
  type Looked,
  type PassEnd,
  type PassSummary,
  type Session,
  type ToolOutcome,
} from "./shapes";
import {
  CATCH_UP_DIFF,
  CATCH_UP_VERSIONS,
  ENDED_KEPT,
  GRACE_MS,
  NOTES_FILES,
  NO_ANSWER,
  QUOTE,
  ROUNDS_KEPT,
  ROUND_COMMENTS,
  TAKE,
  TAKE_CATCH_UP,
  TAKE_TEXT,
  WAIT_MS,
  clip,
  plural,
  spliceRefused,
  waitClosed,
  waitStopped,
} from "./limits-and-words";
import { checkNotLong } from "./file-checks";
import { LONG, characterArg, count, lineArg, outlineAndStart, paragraphsAt, sendsChanges, someLines } from "./long-documents";
import { copyLinks, followEdit, groupEdits, inFileForm, linesChanged, type EditGroup } from "./follow-edits";

import { anchorForQuote, commentLines, namedIn, type LineOf } from "./finding-words";
import * as lookingBack from "./looking-back";
import * as exportTool from "./export-tool";
import * as waiting from "./waiting-for-review";

export { anchorForQuote, commentLines, type LineOf } from "./finding-words";

export { noHooks } from "./shapes";
export type { AgentDoc, AgentHooks, AgentHost, AgentInfo, ExportKind, FlushResult, PassEnd, PassSummary, ToolOutcome } from "./shapes";

export class AgentService {
  // Members without "private" are also reached, as this, by the parts of the service kept in their own files (looking-back.ts and the like).
  sessions = new Map<string, Session>();
  roster = new Roster();
  turns = new Turns();
  private announced = new Map<string, string>();
  /** For each pass in progress, by document: which comments its edits answer. */
  private links = new Map<string, PassLinks>();
  /** For each pass in progress, by document: the words each comment was on as it began. */
  private passAnchors = new Map<string, Map<string, Anchor>>();
  /** Passes whose agent has been reminded to say which comment its edits answer. */
  private reminded = new WeakSet<PassLinks>();
  private queue: Promise<unknown> = Promise.resolve();
  /** Agents waiting in take_document for a document to be free, by document. */
  private waiting = new Map<string, Set<(how: Freed) => void>>();
  private waitMs: number;
  /** A fault a test plants in an edit's splice, for the safety net to catch. Never set outside tests. */
  private spliceFault: ((text: string) => string) | null;
  /** Agents waiting for the person's review (wait_for_review), by session. */
  listeners: Listeners;

  constructor(
    public host: AgentHost,
    public comments: CommentService,
    public hooks: AgentHooks = noHooks,
    options: { waitMs?: number; graceMs?: number; spliceFault?: (text: string) => string } = {},
  ) {
    this.waitMs = options.waitMs ?? WAIT_MS;
    this.spliceFault = options.spliceFault ?? null;
    this.listeners = new Listeners(options.graceMs ?? GRACE_MS, (sessionId) => this.stopListening(sessionId, ""));
  }

  /** One job at a time, so two agents (or an agent and the person) never act at the same moment. */
  enqueue<T>(job: () => Promise<T>): Promise<T> {
    const run = this.queue.then(job, job);
    this.queue = run.catch(() => undefined);
    return run;
  }

  // Sessions -----------------------------------------------------------------------

  /** An agent connected. Its name comes from its tool, or the role it introduced itself with. */
  connect(client: { name?: string } = {}, introduced?: string, options: { canWait?: boolean } = {}): { sessionId: string; name: string } {
    const asked = introduced ? cleanName(introduced) : "";
    const role = !!asked && !nameProblem(asked);
    const baseName = role ? asked : nameForClient(client.name);
    const session: Session = {
      id: randomUUID(),
      baseName,
      client: client.name ?? "",
      settled: false,
      lastRead: new Map(),
      seen: new Map(),
      started: new Map(),
      ended: new Map(),
      pointed: new Set(),
      canWait: options.canWait === true,
      role,
      rounds: new Map(),
    };
    this.sessions.set(session.id, session);
    this.tellConnected();
    return { sessionId: session.id, name: baseName };
  }

  /** Tell the host who is connected now, for the @ list in the person's comments. */
  private tellConnected(left?: string): void {
    const now = [...this.sessions.values()].reverse();
    this.host.connected?.(
      now.map((s) => s.baseName),
      left,
      now.map((s) => s.client),
    );
  }

  /** The agent's session ended: it gives back any document it held and leaves every document. */
  disconnect(sessionId: string): Promise<void> {
    return this.enqueue(async () => {
      if (!this.sessions.has(sessionId)) return;
      this.sessions.get(sessionId)!.forgetTake?.();
      this.stopListening(sessionId, waitStopped("your documents"));
      try {
        for (const key of this.turns.heldBy(sessionId)) {
          const pass = this.endTurn(key, "free")!;
          try {
            await this.endPass(key, pass, "session-ended");
          } finally {
            this.host.backToYou(key);
          }
        }
      } finally {
        // Whatever went wrong above, the session goes and the window is told.
        const left = this.sessions.get(sessionId)!.baseName;
        this.sessions.delete(sessionId);
        for (const key of this.roster.leave(sessionId)) this.announce(key);
        this.tellConnected(left);
      }
    });
  }

  /** The person pressed Take over: the agent's pass ends, and it's told on its next call. */
  takeOver(storeId: string): Promise<void> {
    return this.enqueue(async () => {
      const pass = this.endTurn(storeId, "person");
      try {
        if (!pass) return;
        const doc = this.host.byStoreId(storeId);
        this.endedBy(pass, storeId, "took", doc ? doc.filePath : "");
        await this.endPass(storeId, pass, "person");
      } finally {
        // Always, pass or no pass: a tab that shows an agent editing is put right.
        this.announced.delete(storeId);
        this.announce(storeId);
      }
    });
  }

  /**
   * The person closed the document's tab. An agent editing it stops there (a
   * closed tab never comes back by itself), and is told on its next call.
   */
  closed(storeId: string, filePath: string): Promise<void> {
    return this.enqueue(async () => {
      this.announced.delete(storeId); // a tab that opens it again is told afresh
      const dropped = this.host.byStoreId(storeId) ? [] : this.roster.closed(storeId);
      forgetWords(storeId); // its words, read to tie agents' edits to comments
      // What each agent keeps for reading it cheaply goes with the tab: read again, it's read whole.
      for (const session of this.sessions.values()) {
        session.lastRead.delete(storeId);
        session.seen.delete(storeId);
        session.pointed.delete(storeId);
        // Which comments it started stays for as long as it's kept on the document (B6-R07).
        for (const key of dropped) session.started.delete(key);
      }
      // An agent waiting for its review listens on its other documents; with none left, it stops.
      for (const l of this.listeners.on(storeId)) {
        l.docs.delete(storeId);
        l.queued = l.queued.filter((k) => k !== storeId);
        if (!l.docs.size) this.listeners.stop(l.sessionId, waitClosed(path.basename(filePath)));
      }
      const pass = this.endTurn(storeId, "closed");
      try {
        if (!pass) return;
        this.endedBy(pass, storeId, "closed", path.resolve(filePath));
        await this.endPass(storeId, pass, "person");
      } finally {
        // The person may have opened it again while this waited its turn: tell that tab who's on it now.
        if (this.host.byStoreId(storeId)) this.announce(storeId);
      }
    });
  }

  /** The person ended an agent's pass: remember it for that agent, to tell it on its next call. */
  private endedBy(pass: Pass, storeId: string, how: Ended["how"], filePath: string): void {
    const session = this.sessions.get(pass.sessionId);
    if (!session) return;
    session.ended.delete(storeId);
    session.ended.set(storeId, { how, name: filePath ? path.basename(filePath) : "the document", filePath, untold: true });
    for (const key of session.ended.keys()) {
      if (session.ended.size <= ENDED_KEPT) break;
      session.ended.delete(key);
    }
  }

  /** Tell the agent, once, that the person ended its pass on this document. */
  private tellEnded(call: Call, ended: Ended | undefined): void {
    if (!ended?.untold) return;
    ended.untold = false;
    call.toldEnded = true;
    call.notes.push(
      ended.how === "took"
        ? `The person took ${ended.name} back while you were editing, so your editing pass ended. The changes you'd made are kept. Don't edit it again unless they ask; you can still reply on comments.`
        : `The person closed ${ended.name} in Corillo while you were editing, so your editing pass ended. The changes you'd made are kept. Don't edit it again unless they ask; then call take_document, which opens it again.`,
    );
  }

  /**
   * Why an edit is refused when the agent doesn't hold the document. After the
   * person ended its pass, never "take it": that's for the person to ask.
   */
  private notEditing(call: Call, key: string | undefined, label: string): string {
    const ended = key ? call.session.ended.get(key) : undefined;
    if (ended && call.toldEnded) return "So this change wasn't made.";
    if (ended) return `You're not editing ${label}: the person ${ended.how === "took" ? "took it back" : "closed it"}. Don't take it again unless they ask.`;
    return `You're not editing ${label}. Call take_document first.`;
  }

  /**
   * Corillo is quitting: every pass ends now, while there's still time, so
   * the history keeps each one with the comments it answered.
   */
  endAllPasses(): void {
    for (const session of this.sessions.values()) {
      for (const key of this.turns.heldBy(session.id)) void this.endPass(key, this.endTurn(key, "person")!, "person");
    }
  }

  /** End the pass on a document, and wake any agent waiting to take it. */
  private endTurn(storeId: string, how: "free" | "person" | "closed"): Pass | undefined {
    const pass = this.turns.end(storeId);
    for (const wake of [...(this.waiting.get(storeId) ?? [])]) wake(how);
    if (pass) {
      this.leftWaiting(pass, storeId);
      this.free(pass.sessionId);
    }
    return pass;
  }

  /**
   * A pass ended with comments still waiting for its agent (left for its next
   * pass, or the person took the document back): they count as not sent
   * again, so the person can send them (B2-06). Shown again, they count again.
   */
  private leftWaiting(pass: Pass, storeId: string): void {
    const seen = this.sessions.get(pass.sessionId)?.seen.get(storeId);
    const member = this.roster.member(storeId, pass.sessionId);
    if (!seen?.size || !member) return;
    const unnamed = this.unnamedFor(storeId, pass.sessionId);
    const left = this.comments.threads(storeId).filter((t) => seen.has(t.id) && waitingFor(t, member.name, unnamed));
    for (const t of left) seen.delete(t.id);
  }

  // Which comments with no @ go to whom (roadmap Batch 3, item 3; D3) ------------------

  /**
   * Which comments with no @ on a document are this session's: those it was
   * the first to be shown since the person last wrote on them; and those
   * nobody has yet, unless it has a role name and an agent without one is on
   * the document. Works for a session not on the document yet, too, given
   * the `name` it would have there. Also which comments agents started are
   * its (see starterOf).
   */
  unnamedFor(key: string, sessionId: string, name?: string): (t: Thread) => boolean {
    const others = this.roster.members(key).filter((m) => m.sessionId !== sessionId);
    const free = picksUpUnnamed(this.sessions.get(sessionId)?.role ?? false, others);
    const ids = [sessionId, ...others.map((m) => m.sessionId)];
    return (t) => {
      if (t.to === "person") {
        const starter = this.starterOf(key, t.id);
        return starter ? starter === sessionId : startedBy(t, name ?? this.roster.member(key, sessionId)?.name ?? "");
      }
      const by = pickedUpBy(t, ids, (id) => this.sessions.get(id)?.seen.get(key)?.get(t.id) ?? 0);
      return by === null ? free : by === sessionId;
    };
  }

  /**
   * The session that started a comment, while it's on the document: the
   * person's answers there are for it, as a reply in a Word comment is for
   * whoever started it, even once a new chat has taken its name (roadmap
   * Batch 6, B3-R10). Once it has gone, null: the comment is for the agent
   * with the name it was started under (a chat started again).
   */
  private starterOf(key: string, threadId: string): string | null {
    for (const m of this.roster.members(key)) if (this.sessions.get(m.sessionId)?.started.get(key)?.has(threadId)) return m.sessionId;
    return null;
  }

  /**
   * In a round on the document: editing it, waiting for the review of it (or
   * sent it), or given comments on it it hasn't answered yet. Such a session
   * keeps its name when a new chat of the same tool arrives.
   */
  private inRound(key: string, sessionId: string): boolean {
    if (this.turns.holds(key, sessionId) || this.listeners.get(sessionId)?.docs.has(key)) return true;
    const seen = this.sessions.get(sessionId)?.seen.get(key);
    if (!seen?.size) return false;
    return this.comments.threads(key).some((t) => {
      const shown = seen.get(t.id);
      return t.status === "open" && shown !== undefined && shown >= t.messages.length && t.messages[t.messages.length - 1]?.author.kind === "person";
    });
  }

  /**
   * The agent a comment with no @ that nobody has yet is shown as for: of
   * those who may pick it up, the one editing, else one waiting for the
   * review, else the one that joined or took the document last.
   */
  private nextFor(key: string): string | null {
    const members = this.roster.members(key);
    const rank = (m: Member) => (this.turns.holds(key, m.sessionId) ? 0 : this.listeners.get(m.sessionId)?.docs.has(key) ? 1 : 2);
    let best: Member | null = null;
    for (const m of members) {
      if (!picksUpUnnamed(m.role, members.filter((o) => o !== m))) continue;
      if (!best || rank(m) < rank(best) || (rank(m) === rank(best) && m.active > best.active)) best = m;
    }
    return best?.sessionId ?? null;
  }

  /**
   * The comments with no @ waiting for another agent than this session, and
   * whom for: one that picked them up first, or (for an agent with a role
   * name) the agent they're for. So this agent can tell the person, rather
   * than say there's nothing.
   */
  private elsewhere(key: string, sessionId: string): { count: number; holder: string; picked: boolean } | null {
    const mine = this.unnamedFor(key, sessionId);
    const others = this.roster.members(key).map((m) => m.sessionId).filter((id) => id !== sessionId);
    const next = this.nextFor(key);
    const counts = new Map<string, { count: number; picked: boolean }>();
    for (const t of this.comments.threads(key)) {
      if (t.to !== null || t.status !== "open" || t.messages[t.messages.length - 1]?.author.kind !== "person" || mine(t)) continue;
      const by = pickedUpBy(t, others, (id) => this.sessions.get(id)?.seen.get(key)?.get(t.id) ?? 0);
      const name = this.roster.member(key, by ?? next ?? "")?.name;
      if (!name || (!by && next === sessionId)) continue;
      const c = counts.get(name) ?? { count: 0, picked: true };
      c.count++;
      c.picked &&= by !== null;
      counts.set(name, c);
    }
    const [holder, c] = [...counts].sort((a, b) => b[1].count - a[1].count)[0] ?? [];
    return holder ? { holder, ...c } : null;
  }

  /** What an agent is told when comments with no @ wait for another agent (see elsewhere). */
  private elsewhereNote(looked: Looked, sessionId: string): string {
    const other = this.elsewhere(looked.doc.storeId, sessionId);
    if (!other) return "";
    const one = other.count === 1;
    const name = looked.member.name;
    if (other.picked) {
      return ` ${plural(other.count, "comment")} on ${looked.label} ${one ? "has" : "have"} no @ and went to ${other.holder}, another session that picked ${one ? "it" : "them"} up first. If the person meant ${one ? "it" : "them"} for you, tell them they can hand ${one ? "it" : "each one"} to you by replying on it with @${name}.`;
    }
    return ` ${plural(other.count, "comment")} on ${looked.label} ${one ? "has" : "have"} no @, so ${one ? "it's" : "they're"} for ${other.holder}, also on it: you take only comments that name you (@${name}). If the person meant ${one ? "it" : "them"} for you, they can hand ${one ? "it" : "each one"} to you by replying on it with @${name}.`;
  }

  /** Wait until the pass on this document ends, the time runs out, or the agent's tool cancels. */
  private whenFree(storeId: string, ms: number, signal?: AbortSignal): Promise<Freed> {
    if (signal?.aborted) return Promise.resolve("cancelled");
    if (!this.turns.holder(storeId)) return Promise.resolve("free"); // it ended while the refusal was on its way
    return new Promise((resolve) => {
      const waiters = this.waiting.get(storeId) ?? new Set();
      this.waiting.set(storeId, waiters);
      const cancel = () => wake("cancelled");
      const wake = (how: Freed) => {
        clearTimeout(timer);
        signal?.removeEventListener("abort", cancel);
        waiters.delete(wake);
        if (!waiters.size) this.waiting.delete(storeId);
        resolve(how);
      };
      const timer = setTimeout(() => wake("timeout"), ms);
      signal?.addEventListener("abort", cancel, { once: true });
      waiters.add(wake);
    });
  }

  /**
   * A take the agent's tool cancelled after it was done: nobody is going to
   * edit, so the document goes straight back, with no version and no notice.
   */
  private async giveBack(storeId: string, pass: Pass): Promise<void> {
    const links = this.links.get(storeId);
    // Only a take nothing has been done with since (a call sent alongside it may have).
    if (this.turns.holder(storeId) !== pass || pass.replied.size || links?.threads.length || links?.hasOther) return;
    this.endTurn(storeId, "free");
    this.links.delete(storeId);
    this.passAnchors.delete(storeId);
    try {
      await this.hooks.endPass(storeId, { agentName: pass.name, addressed: [], endedBy: "agent" });
    } catch {
      // History is a record; a problem keeping it never traps the document.
    }
    this.announced.delete(storeId);
    this.announce(storeId);
  }

  /** The agents on a document, for the window. */
  agentsOn(storeId: string): AgentInfo[] {
    let threads: Thread[] | null = null;
    const next = this.nextFor(storeId);
    return this.roster.members(storeId).map((m) => {
      // "Default": the one a comment with no @ that nobody has yet is shown as for (D3).
      const isDefault = m.sessionId === next;
      const info: AgentInfo = { name: m.name, isDefault, editing: this.turns.holds(storeId, m.sessionId), colour: m.colour };
      const l = this.listeners.get(m.sessionId);
      if (l?.docs.has(storeId)) {
        // Sent to it: kept for its next wait, or being handed over now (B2-04: from the moment Send is pressed).
        const sent = l.queued.includes(storeId) || l.waking === storeId;
        // Only while it waits, or works and will wait again: never in the little while after a pass before it waits again, which it may not (B2-01).
        if (sent || l.held || l.waking || this.turns.heldBy(m.sessionId).length) info.listening = true;
        if (sent) info.sent = { after: l.waking === storeId ? null : this.busyWith(m.sessionId) };
      }
      const started = this.sessions.get(m.sessionId)?.started.get(storeId);
      if (started?.size) {
        threads ??= this.comments.threads(storeId);
        const renamed = threads.filter((t) => t.status === "open" && t.to === "person" && started.has(t.id) && !startedBy(t, m.name)).map((t) => t.id);
        if (renamed.length) info.started = renamed;
      }
      const seen = this.sessions.get(m.sessionId)?.seen.get(storeId);
      if (seen?.size) {
        threads ??= this.comments.threads(storeId);
        const has: Record<string, number> = {};
        const unnamed = this.unnamedFor(storeId, m.sessionId);
        for (const t of threads) if (seen.has(t.id) && waitingFor(t, m.name, unnamed)) has[t.id] = seen.get(t.id)!;
        if (Object.keys(has).length) info.has = has;
      }
      return info;
    });
  }

  /** A tab opened (or opened again): it needs to know who's on its document. */
  opened(storeId: string): void {
    this.roster.opened(storeId);
    this.announced.delete(storeId);
    this.announce(storeId);
  }

  /** The agent holding this document, if one is (the person can't edit it meanwhile). */
  editingAgent(storeId: string): string | null {
    return this.turns.holder(storeId)?.name ?? null;
  }

  announce(storeId: string): void {
    const agents = this.agentsOn(storeId);
    const key = JSON.stringify(agents);
    if (this.announced.get(storeId) === key) return;
    // Remembered only while a tab shows it, so a closed document leaves nothing here.
    if (this.host.byStoreId(storeId)) this.announced.set(storeId, key);
    else this.announced.delete(storeId);
    this.host.announce(storeId, agents);
  }

  /** How much the service keeps, for the leak checks. */
  sizes(): Record<string, number> {
    const out = { sessions: this.sessions.size, lastRead: 0, seen: 0, started: 0, pointed: 0, ended: 0, rounds: 0 };
    for (const s of this.sessions.values()) {
      out.rounds += s.rounds.size;
      out.lastRead += s.lastRead.size;
      out.seen += s.seen.size;
      out.started += s.started.size;
      out.pointed += s.pointed.size;
      out.ended += s.ended.size;
    }
    return {
      ...out,
      roster: this.roster.size,
      announced: this.announced.size,
      waiting: this.waiting.size,
      links: this.links.size,
      passAnchors: this.passAnchors.size,
      listening: this.listeners.size,
    };
  }

  private async endPass(storeId: string, pass: Pass, endedBy: PassEnd["endedBy"]): Promise<void> {
    const threads = this.comments.threads(storeId);
    const links = this.links.get(storeId);
    this.links.delete(storeId);
    const changed = new Set(links?.threads ?? []);
    const began = this.passAnchors.get(storeId);
    this.passAnchors.delete(storeId);
    // Each comment as it is now, on the words it was on when the pass began (the
    // words the person asked about, which the agent may have rewritten since); a
    // change from an earlier pass isn't this pass's.
    const addressed = threads
      .filter((t) => pass.replied.has(t.id) || changed.has(t.id) || pass.started.has(t.id))
      .map((t) => {
        let out = t.change && !changed.has(t.id) ? { ...t, change: undefined } : t;
        const anchor = began?.get(t.id);
        if (anchor && out.anchor) out = { ...out, anchor };
        return out;
      });
    let other: ChangeSpan[] = [];
    try {
      other = (links && links.spans().get(links.untied)) ?? [];
    } catch {
      // The links are a record; a problem with them never traps the document.
    }
    const request = links?.request?.text;
    const note = pass.note;
    try {
      const version = await this.hooks.endPass(storeId, { agentName: pass.name, addressed, other, ...(request ? { request } : {}), ...(note ? { note } : {}), endedBy });
      // null: the pass made no version. A hook that doesn't say (undefined) made the latest, if any.
      this.ownRound(storeId, pass, version === undefined ? this.hooks.versions(storeId).at(-1) : version);
    } catch {
      // History is a record; a problem keeping it never traps the document.
    }
    if (note) {
      try {
        // Told before the pass's end, so the line saying the agent is done can count it.
        this.comments.addNote(storeId, { id: `note-${newId()}`, agent: pass.name, text: note, at: new Date().toISOString() });
      } catch (err) {
        console.error("Corillo couldn't keep an agent's note.", err);
      }
    }
    if (addressed.length || other.length || request || note) {
      const started = addressed.filter((t) => pass.started.has(t.id) && !pass.replied.has(t.id) && !changed.has(t.id)).length;
      try {
        this.host.passEnded?.(storeId, {
          agent: pass.name,
          answered: addressed.length - started,
          other: other.length > 0,
          ...(request ? { request } : {}),
          endedBy,
        });
      } catch (err) {
        // The notice is a courtesy; a problem showing it never traps the document.
        console.error("Corillo couldn't tell the person an agent's pass ended.", err);
      }
    } else if (endedBy === "agent" && pass.found === 0) {
      // A round that found nothing addressed to it says why, when comments wait for another agent (roadmap Batch 3, item 3).
      const nothingFor = this.waitingElsewhere(storeId, pass);
      if (nothingFor) {
        try {
          this.host.passEnded?.(storeId, { agent: pass.name, answered: 0, other: false, endedBy, nothingFor });
        } catch (err) {
          console.error("Corillo couldn't tell the person an agent's pass ended.", err);
        }
      }
    }
  }

  /** The version a session's own pass made, remembered so its catch-up can tell it from another session's of the same name. */
  private ownRound(storeId: string, pass: Pass, version: Version | null | undefined): void {
    const session = this.sessions.get(pass.sessionId);
    if (!session || version?.kind !== "agent" || version.agent !== pass.name) return;
    const kept = [...(session.rounds.get(storeId) ?? []).filter((n) => n !== version.n), version.n].slice(-ROUNDS_KEPT);
    session.rounds.delete(storeId);
    session.rounds.set(storeId, kept);
    // Kept for the documents it worked on last, so nothing here grows for good.
    for (const key of session.rounds.keys()) if (session.rounds.size > ROUNDS_KEPT) session.rounds.delete(key);
  }

  /**
   * The person's comments waiting for agents other than the pass's: how
   * many, for whom (most first), and whether those agents have them. Null
   * when there are none.
   */
  private waitingElsewhere(key: string, pass: Pass): NonNullable<PassSummary["nothingFor"]> | null {
    const mine = this.unnamedFor(key, pass.sessionId);
    const others = this.roster.members(key).filter((m) => m.sessionId !== pass.sessionId);
    const next = this.nextFor(key);
    const shown = (id: string, t: Thread) => this.sessions.get(id)?.seen.get(key)?.get(t.id) ?? 0;
    const counts = new Map<string, number>();
    let given = true;
    for (const t of this.comments.threads(key)) {
      if (t.status !== "open" || t.messages[t.messages.length - 1]?.author.kind !== "person" || waitingFor(t, pass.name, mine)) continue;
      let name: string | null;
      let has: boolean;
      if (t.to === null) {
        const by = pickedUpBy(t, others.map((m) => m.sessionId), (id) => shown(id, t));
        name = this.roster.member(key, by ?? next ?? "")?.name ?? null;
        has = by !== null;
      } else {
        // A comment an agent started waits for that chat while it's here, by the name it has now (B3-R10).
        const first = t.messages[0]?.author;
        const starter = t.to === "person" ? this.starterOf(key, t.id) : null;
        if (t.to !== "person") name = t.to;
        else name = starter ? (this.roster.member(key, starter)?.name ?? null) : first?.kind === "agent" ? first.name : null;
        has = others.some((m) => m.name === name && shown(m.sessionId, t) >= t.messages.length);
      }
      if (!name || name === pass.name) continue;
      counts.set(name, (counts.get(name) ?? 0) + 1);
      given &&= has;
    }
    if (!counts.size) return null;
    const agents = [...counts].sort((a, b) => b[1] - a[1]).map(([name]) => name);
    return { comments: [...counts.values()].reduce((a, b) => a + b, 0), agents, given };
  }

  // Waiting for the person's review (Send to Claude, roadmap Batch 2 item 1; waiting-for-review.ts) ---

  ready = waiting.ready;
  busyWith = waiting.busyWith;
  namesOf = waiting.namesOf;
  announceAll = waiting.announceAll;
  stopListening = waiting.stopListening;
  free = waiting.free;
  quitting = waiting.quitting;
  send = waiting.send;
  hasFor = waiting.hasFor;
  sentForNothing = waiting.sentForNothing;
  letGoEmptySends = waiting.letGoEmptySends;
  commentsChanged = waiting.commentsChanged;
  nextSent = waiting.nextSent;
  waitForReview = waiting.waitForReview;
  handOver = waiting.handOver;
  docsToWaitFor = waiting.docsToWaitFor;

  // Tool calls ------------------------------------------------------------------------

  /**
   * Run an agent's tool call. `signal` is the agent's tool cancelling it: a
   * take_document that's waiting, or saving the person's edits, stops and
   * takes nothing; one cancelled just after it was done gives the document
   * back, unless the agent has made another call since.
   */
  async call(sessionId: string, tool: string, args: Record<string, unknown>, signal?: AbortSignal): Promise<ToolOutcome> {
    if (tool === "wait_for_review") return this.waitForReview(sessionId, args ?? {}, signal);
    const forget = this.sessions.get(sessionId)?.forgetTake;
    if (forget) forget();
    const notes: string[] = [];
    // A take that waited looks at the document twice: each note is told once.
    const withNotes = (text: string) => [...new Set(notes), text].join("\n\n");
    const failed = (err: unknown): ToolOutcome => {
      if (err instanceof AgentError || err instanceof CommentError) return { text: withNotes(err.message), isError: true };
      return { text: withNotes(`Something went wrong in Corillo: ${err instanceof Error ? err.message : String(err)}`), isError: true };
    };
    const takes = tool === "take_document" ? signal : undefined;
    let took: Call["took"];
    const attempt = () =>
      this.enqueue(async (): Promise<ToolOutcome | Later | Held> => {
        const session = this.sessions.get(sessionId);
        if (!session) return { text: "This session has ended. Start a new one.", isError: true };
        if (takes?.aborted) return { text: "Cancelled.", isError: true };
        try {
          const call: Call = { session, notes, signal: takes };
          const result = await this.run(call, tool, args ?? {});
          took = call.took;
          return result instanceof Later ? result : { text: withNotes(result), isError: false };
        } catch (err) {
          return err instanceof Held ? err : failed(err);
        }
      });
    let first = await attempt();
    // Another agent is editing: wait here for it to finish, rather than have the agent ask again and again.
    const started = Date.now();
    while (first instanceof Held) {
      const held = first;
      const left = this.waitMs - (Date.now() - started);
      const how = left > 0 ? await this.whenFree(held.storeId, left, takes) : "timeout";
      if (how === "cancelled") return { text: "Cancelled.", isError: true };
      const waited = Math.round((Date.now() - started) / 1000);
      if (how === "timeout") {
        const text = waited
          ? `${held.holder} is still editing ${held.label} after ${waited} seconds. You can read it and comment meanwhile; call take_document again to keep waiting.`
          : `${held.holder} is editing ${held.label} right now. You can read it and comment meanwhile; call take_document again to wait for it.`;
        return { text: withNotes(text), isError: true };
      }
      if (how === "person" || how === "closed") {
        const what =
          how === "person"
            ? `The person took ${held.label} over from ${held.holder} to edit it themselves.`
            : `The person closed ${held.label} while ${held.holder} was editing it.`;
        return { text: withNotes(`${what} Don't take it until they ask you to.`), isError: true };
      }
      if (waited) notes.push(`${held.holder} was editing ${held.label}; you waited ${waited} seconds for it to finish.`);
      first = await attempt();
    }
    if (!(first instanceof Later)) {
      if (takes && took) this.heedLateCancel(sessionId, takes, took);
      return first;
    }
    try {
      return { text: withNotes(await first.work()), isError: false };
    } catch (err) {
      return failed(err);
    }
  }

  /**
   * The answer to a take may cross the agent's cancel on its way: until the
   * agent's next call, a cancel gives the document it just took straight back.
   */
  private heedLateCancel(sessionId: string, signal: AbortSignal, took: { key: string; pass: Pass }): void {
    const session = this.sessions.get(sessionId);
    if (!session) return;
    const onCancel = () => {
      session.forgetTake = undefined;
      void this.enqueue(() => this.giveBack(took.key, took.pass));
    };
    signal.addEventListener("abort", onCancel, { once: true });
    session.forgetTake = () => {
      signal.removeEventListener("abort", onCancel);
      session.forgetTake = undefined;
    };
  }

  private run(call: Call, tool: string, args: Record<string, unknown>): Promise<string | Later> | string {
    switch (tool) {
      case "introduce":
        return this.introduce(call, args);
      case "list_documents":
        return this.listDocuments(call);
      case "open_document":
        return this.openDocument(call, args);
      case "create_document":
        return this.createDocument(call, args);
      case "read_document":
        return this.readDocument(call, args);
      case "list_comments":
        return this.listComments(call, args);
      case "take_document":
        return this.takeDocument(call, args);
      case "edit_document":
        return this.editDocument(call, args);
      case "replace_document":
        return this.replaceDocument(call, args);
      case "reply_to_comment":
        return this.replyToComment(call, args);
      case "add_comment":
        return this.addComment(call, args);
      case "finish_editing":
        return this.finishEditing(call, args);
      case "list_versions":
        return this.listVersions(call, args);
      case "read_version":
        return this.readVersion(call, args);
      case "show_changes":
        return this.showChanges(call, args);
      case "export_document":
        return this.exportDocument(call, args);
      default:
        throw new AgentError(`Corillo has no tool called ${tool}.`);
    }
  }

  // Finding documents --------------------------------------------------------------------

  private pathArg(args: Record<string, unknown>): string {
    const p = typeof args.path === "string" ? args.path.trim() : "";
    if (!p) throw new AgentError("Give the document's full path.");
    if (!path.isAbsolute(p)) throw new AgentError(`Give the document's full path, not ${p}.`);
    return path.normalize(p);
  }

  /**
   * The agent looks at a document: it's opened if need be, and the agent joins
   * it. A tab the person closed during this agent's pass stays closed (it
   * never comes back by itself) unless the agent opens or takes it.
   */
  look(call: Call, args: Record<string, unknown>, reopen = false): Looked {
    const filePath = this.pathArg(args);
    // A Word document: how it opens (the person opens it, and Corillo makes the copy; review of Batch 11, B11R-6).
    if (!OPENS_AS_MARKDOWN.test(filePath)) throw new AgentError(wordForAgent(filePath) ?? "Corillo works on Markdown files (ending in .md).");
    const found = this.host.find(filePath);
    const closed = found || reopen ? undefined : this.closedHere(call.session, filePath);
    if (closed) {
      const label = path.basename(filePath);
      this.tellEnded(call, call.session.ended.get(closed));
      throw new AgentError(
        call.toldEnded
          ? `So ${label} stays closed, and nothing was done.`
          : `${label} is closed: the person closed it during your pass, so it stays closed until they ask for more. Nothing was done.`,
      );
    }
    const doc = found ?? this.host.open(filePath);
    if (doc.formerPaths?.has(path.resolve(filePath)) && doc.filePath !== path.resolve(filePath)) {
      call.notes.push(`${path.basename(filePath)} was renamed or moved. It's now ${doc.filePath}: use that path from now on.`);
    }
    return this.join(call, doc);
  }

  /**
   * For edits and finishing, which need a document the agent holds: one that
   * isn't open can't be held, so it isn't opened for a call that would fail.
   */
  private lookHeld(call: Call, args: Record<string, unknown>, refusal: (label: string, key?: string) => string): Looked {
    const filePath = this.pathArg(args);
    const doc = this.host.find(filePath);
    if (doc) return this.look(call, args);
    const key = this.closedHere(call.session, filePath);
    this.tellEnded(call, key ? call.session.ended.get(key) : undefined);
    throw new AgentError(refusal(path.basename(filePath), key));
  }

  /** The document at this path, if the person closed it during this agent's pass. */
  private closedHere(session: Session, filePath: string): string | undefined {
    const resolved = path.resolve(filePath);
    for (const [key, e] of session.ended) if (e.how === "closed" && e.filePath === resolved) return key;
    return undefined;
  }

  join(call: Call, doc: AgentDoc): Looked {
    const { session } = call;
    const key = doc.storeId;
    // A new chat is plain "Claude" when the Claude already there isn't in a round (roadmap Batch 3, item 3).
    const member = this.roster.look(key, session.id, session.baseName, session.role, (id) => this.inRound(key, id));
    this.announce(key);
    this.tellEnded(call, session.ended.get(key));
    return { doc, member, unnamed: this.unnamedFor(key, session.id), label: path.basename(doc.filePath) };
  }

  /** The latest text, with the person's pending edits saved first (unless an agent holds it: then there are none). */
  async latest(doc: AgentDoc): Promise<{ text: string; note: string; flushed: FlushResult }> {
    let note = "";
    let flushed: FlushResult = "saved";
    if (!this.turns.holder(doc.storeId)) {
      flushed = await this.host.flush(doc, false);
      if (flushed === "conflict") {
        note =
          "\n\nNote: the person has edits in Corillo that clash with a change made to the file outside it, and hasn't chosen which to keep. This is the text in the file.";
      } else if (flushed === "unsaved") {
        note =
          "\n\nNote: Corillo can't save this document right now (the file may have been moved, deleted or locked, or the disk is full), so the person may have edits that aren't in it yet. This is the text in the file.";
      } else if (flushed === "no-answer") {
        note = `\n\nNote: ${NO_ANSWER} This is the text in the file.`;
      }
    }
    return { text: this.host.read(doc), note, flushed };
  }

  private requireHolder(call: Call, looked: Looked): void {
    const pass = this.turns.holder(looked.doc.storeId);
    if (pass?.sessionId === call.session.id) return;
    if (pass) throw new AgentError(`${pass.name} is editing ${looked.label}, so you can't edit it now. You can read it and comment meanwhile.`);
    throw new AgentError(this.notEditing(call, looked.doc.storeId, looked.label));
  }

  // Comments, as an agent sees them ----------------------------------------------------------

  private seenOf(session: Session, storeId: string): Map<string, number> {
    let seen = session.seen.get(storeId);
    if (!seen) {
      seen = new Map();
      session.seen.set(storeId, seen);
    }
    return seen;
  }

  private markSeen(session: Session, storeId: string, threads: Thread[]): void {
    const seen = this.seenOf(session, storeId);
    for (const t of threads) seen.set(t.id, t.messages.length);
    // Comments with no @ this session picked up may be all a Send kept for another agent was for: it's let go (B3-R05).
    if (threads.length) this.letGoEmptySends(storeId, session.id);
    this.announce(storeId); // the cards say what the agent has been given
  }

  /** A comment's id as agents see it: the start of its full id, long enough to be unique. */
  private shortId(thread: Thread, all: Thread[]): string {
    for (let n = 8; n < thread.id.length; n++) {
      const prefix = thread.id.slice(0, n);
      if (all.filter((t) => t.id.startsWith(prefix)).length === 1) return prefix;
    }
    return thread.id;
  }

  private findThread(threads: Thread[], ref: unknown, label: string): Thread {
    const id = (typeof ref === "string" ? ref : "").trim().replace(/^\[|\]$/g, "").toLowerCase();
    if (!id) throw new AgentError("Give the comment's id, as list_comments shows it.");
    const exact = threads.find((t) => t.id === id);
    if (exact) return exact;
    const matches = id.length >= 4 ? threads.filter((t) => t.id.startsWith(id)) : [];
    if (matches.length === 1) return matches[0];
    throw new AgentError(`There's no comment with the id ${id} on ${label}. list_comments shows the ids.`);
  }

  private formatThread(thread: Thread, all: Thread[], me: string, lineOf: LineOf, cut = Infinity): string {
    let where: string;
    if (!thread.anchor) where = "on the whole document";
    else {
      const quote = thread.anchor.quote;
      const at = thread.detached ? null : lineOf.range(thread.anchor);
      // Every line the words are on, so a comment on several paragraphs or items isn't read as one on the first.
      const lines = at ? (at.last > at.first ? `lines ${at.first} to ${at.last}` : `line ${at.first}`) : "";
      const cut = quote.length > QUOTE ? `only the start of its ${count(quote.length)} characters is shown here` : "";
      const notes = [lines, cut].filter(Boolean).join("; ");
      where = thread.detached
        ? `on "${clip(quote, QUOTE)}" (that text is no longer in the document${cut ? `; ${cut}` : ""})`
        : `on "${clip(quote, QUOTE)}"${notes ? ` (${notes})` : ""}`;
    }
    // The person may name an agent with @ ("@Writer, tighten this"): say whom that message was for.
    const who = (m: Message) =>
      m.author.kind === "person"
        ? m.mention
          ? `Person (to ${m.mention === me ? "you" : m.mention})`
          : "Person"
        : m.author.name === me
          ? `${m.author.name} (you)`
          : m.author.name;
    const lines = thread.messages.map((m) => `  ${who(m)}: ${clip(m.body, cut).replace(/\n/g, "\n    ")}${offeredIn(m, lineOf.markdown)}`);
    return [`[${this.shortId(thread, all)}] ${where}`, ...lines].join("\n");
  }

  /** The text is read once for all the threads' line numbers; pass a LineOf to share it with another list. */
  private formatThreads(threads: Thread[], all: Thread[], me: string, markdown: string | LineOf, cut = Infinity): string {
    const lineOf = typeof markdown === "string" ? commentLines(markdown) : markdown;
    return threads.map((t) => this.formatThread(t, all, me, lineOf, cut)).join("\n\n");
  }

  /**
   * Comments waiting for this agent, as text, marked as shown. Longer than
   * `room`, each message is cut short, as far as it takes: every comment is
   * still listed, with its id, and the agent is told where to read them whole.
   */
  private waitingList(call: Call, looked: Looked, markdown: string | LineOf, room = Infinity): { text: string; count: number } {
    const all = this.comments.threads(looked.doc.storeId);
    const waiting = all.filter((t) => waitingFor(t, looked.member.name, looked.unnamed));
    this.markSeen(call.session, looked.doc.storeId, waiting);
    const elsewhere = this.elsewhereNote(looked, call.session.id);
    if (!waiting.length) return { text: `No comments on ${looked.label} are waiting for you.${elsewhere}`, count: 0 };
    const lineOf = typeof markdown === "string" ? commentLines(markdown) : markdown;
    const head = `${plural(waiting.length, "comment")} on ${looked.label} waiting for you`;
    const tail = elsewhere ? `\n\n${elsewhere.trim()}` : "";
    let text = "";
    for (const cut of [Infinity, 1_000, 400, 160, 60]) {
      const list = this.formatThreads(waiting, all, looked.member.name, lineOf, cut);
      const shortened = cut === Infinity ? "" : " (messages cut short to keep this answer short: list_comments gives them in full)";
      text = `${head}${shortened}:\n\n${list}${tail}`;
      if (text.length <= room) break;
    }
    return { text, count: waiting.length };
  }

  /**
   * The text, only to give comments their line numbers: a file Corillo can't
   * read gives them none, so an action that went through is never reported
   * as failed, nor a list of comments held back (the review of Batch 22, R22-3).
   */
  private forLines(doc: AgentDoc): string {
    try {
      return this.host.read(doc);
    } catch {
      return "";
    }
  }

  /** During a pass: comments the person added or answered since the agent last looked. */
  private news(call: Call, looked: Looked): string {
    if (!this.turns.holds(looked.doc.storeId, call.session.id)) return "";
    const all = this.comments.threads(looked.doc.storeId);
    const seen = this.seenOf(call.session, looked.doc.storeId);
    const fresh = all.filter(
      (t) => waitingFor(t, looked.member.name, looked.unnamed) && (seen.get(t.id) ?? 0) < t.messages.length,
    );
    if (!fresh.length) return "";
    const markdown = this.forLines(looked.doc);
    this.markSeen(call.session, looked.doc.storeId, fresh);
    return `\n\nNew from the person since you last looked; address it in this pass if you can:\n\n${this.formatThreads(fresh, all, looked.member.name, markdown)}`;
  }

  /**
   * The text for an agent: whole the first time (or when asked), otherwise what
   * changed. A long document comes as its outline and its start instead: agent
   * tools set aside a result much longer than this (Claude Code: over 50,000
   * characters), and the agent reads the rest by lines.
   */
  private textFor(call: Call, looked: Looked, text: string, whole: boolean): string {
    return this.bodyFor(call, looked, text, whole).text;
  }

  /**
   * textFor, in at most `room` characters (a take's, after its comments): the
   * changes or the whole text only if they fit, otherwise the outline and
   * start, with `more` after the start. `changes`: what it gave is the
   * changes since the agent's last read.
   */
  private bodyFor(
    call: Call,
    looked: Looked,
    text: string,
    whole: boolean,
    more?: (shown: number, room: number) => string,
    room = Infinity,
  ): { text: string; changes: boolean } {
    const last = call.session.lastRead.get(looked.doc.storeId);
    call.session.lastRead.set(looked.doc.storeId, text);
    if (!whole && last !== undefined) {
      const c = catchUp(last, text);
      // The agent may be in a new chat since (the same connector serves them all): it's told how to get it all.
      // A long document's whole text isn't sent in one answer: it's read again by lines.
      const long = text.length > LONG;
      const byLines = "If you no longer have its text, read it again by lines with from_line and to_line (whole set to true gives its outline and start).";
      if (c.kind === "same") {
        return {
          text: `${looked.label} hasn't changed since your last read. ${long ? byLines : "If you no longer have its text, call read_document with whole set to true."}`,
          changes: false,
        };
      }
      if (sendsChanges(c)) {
        const again = long ? byLines : "If you no longer have the text, call read_document with whole set to true.";
        const changes = `Changes to ${looked.label} since your last read, as a unified diff of the Markdown (no context lines). ${again}\n\n${c.diff}`;
        if (changes.length <= room) return { text: changes, changes: true };
      }
    }
    const all = `The whole text of ${looked.label} follows.\n\n${text}`;
    if (text.length <= LONG && all.length <= room) return { text: all, changes: false };
    return { text: outlineAndStart(looked.label, text, "read_document", "", more, room), changes: false };
  }

  // The tools ---------------------------------------------------------------------------------

  private introduce(call: Call, args: Record<string, unknown>): string {
    const { session } = call;
    const name = cleanName(typeof args.name === "string" ? args.name : "");
    const problem = nameProblem(name);
    if (problem) throw new AgentError(problem);
    if (name === session.baseName) return `You're ${name} in Corillo.`;
    if (session.settled) {
      throw new AgentError(
        `You've already worked on a document as ${session.baseName}, and a session keeps its name. To work as ${name}, start a new session and introduce yourself first.`,
      );
    }
    session.baseName = name;
    session.role = true;
    for (const key of this.roster.rename(session.id, name)) this.announce(key);
    this.tellConnected();
    return `You're ${name} in Corillo from now on.`;
  }

  private listDocuments(call: Call): string {
    if (!this.host.openDocs().length) return "No documents are open in Corillo.";
    return `Open in Corillo:\n${this.openList(call).map((d) => d.line).join("\n")}`;
  }

  /** Each open document as list_documents gives it, with how many comments wait there for this agent. */
  openList(call: Call): { doc: AgentDoc; waiting: number; line: string }[] {
    const front = this.host.front?.() ?? null;
    return this.host.openDocs().map((doc) => {
      const key = doc.storeId;
      const { name } = this.roster.prospect(key, call.session.id, call.session.baseName, (id) => this.inRound(key, id));
      const unnamed = this.unnamedFor(key, call.session.id, name);
      const waiting = this.comments.threads(key).filter((t) => waitingFor(t, name, unnamed)).length;
      const pass = this.turns.holder(key);
      const inFront = doc === front ? "in front; " : "";
      const editing = pass ? (pass.sessionId === call.session.id ? "you're editing it; " : `${pass.name} is editing it; `) : "";
      const comments = waiting ? `${plural(waiting, "comment")} waiting for you` : "no comments waiting for you";
      const other = this.elsewhere(key, call.session.id);
      const elsewhere = other
        ? `; ${other.count} with no @ ${other.picked ? `went to ${other.holder}, another session` : `${other.count === 1 ? "is" : "are"} for ${other.holder}`}`
        : "";
      return { doc, waiting, line: `- ${doc.filePath} (${inFront}${editing}${comments}${elsewhere})` };
    });
  }

  /**
   * The document take_document is to take, as a full path: the path it was
   * given; else, from the agent's connector, that name as a file in the
   * agent's folder, when there is one, as the other tools take a name; else
   * the open document with that name (said the way the person says it: "the
   * onboarding proposal"). With no path, the one open document with comments
   * waiting for this agent. Otherwise it's refused, with the documents that
   * are open, so the agent can say which.
   */
  private whichToTake(call: Call, args: Record<string, unknown>): string {
    const given = typeof args.path === "string" ? args.path.trim() : "";
    if (path.isAbsolute(given)) return path.normalize(given);
    const here = given && typeof args.here === "string" && path.isAbsolute(args.here) && this.host.kindOf(args.here) === "file" ? path.normalize(args.here) : "";
    // The agent's own plan.md, never an open "Q3 plan.md" elsewhere: read_document would read that file too.
    if (here && OPENS_AS_MARKDOWN.test(here)) return here;
    const list = this.openList(call);
    if (!list.length) {
      if (here) return here;
      throw new AgentError("No documents are open in Corillo. Give the document's full path as path.");
    }
    const open = `Open in Corillo:\n${list.map((d) => d.line).join("\n")}`;
    if (!given) {
      const waiting = list.filter((d) => d.waiting > 0);
      if (waiting.length === 1) return waiting[0].doc.filePath;
      const which = waiting.length ? `Comments are waiting for you on ${waiting.length} documents` : "No document open in Corillo has comments waiting for you";
      throw new AgentError(`${which}, so say which to take: give its name or full path as path.\n\n${open}`);
    }
    const fits = namedIn(list.map((d) => d.doc), given);
    if (fits.length === 1) return fits[0].filePath;
    if (fits.length > 1) {
      const names = fits.map((d) => path.basename(d.filePath));
      throw new AgentError(`${fits.length} open documents fit "${given}": ${names.slice(0, -1).join(", ")} and ${names.at(-1)}. Give its full path.\n\n${open}`);
    }
    if (here) return here;
    throw new AgentError(`No document called "${given}" is open in Corillo. Give its full path to open and take it.\n\n${open}`);
  }

  private nameNote(looked: Looked, session: Session): string {
    return looked.member.name !== session.baseName ? ` Your comments there show as ${looked.member.name}.` : "";
  }

  /**
   * The first time this agent opens or reads a document, point it to any notes
   * file in the same folder, where the person may keep the document's context.
   */
  private pointToNotes(call: Call, looked: Looked): boolean {
    if (call.session.pointed.has(looked.doc.storeId)) return false;
    call.session.pointed.add(looked.doc.storeId);
    const folder = path.dirname(looked.doc.filePath);
    const own = path.basename(looked.doc.filePath).toLowerCase();
    const found = NOTES_FILES.filter((f) => f.toLowerCase() !== own)
      .map((f) => path.join(folder, f))
      .filter((p) => this.host.kindOf(p) === "file");
    if (found.length) call.notes.push(`Notes in the same folder as ${looked.label}, worth reading for context: ${found.join(", ")}`);
    return true;
  }

  /**
   * Told the first time an agent opens, creates or reads a document, with the
   * result: not every agent tool passes on the connect-time instructions.
   */
  private throughCorillo(label: string): string {
    return `Change ${label} only through Corillo (take_document, then edit_document or replace_document), never with your own file tools.`;
  }

  private openDocument(call: Call, args: Record<string, unknown>): string {
    const already = this.host.find(this.pathArg(args));
    const looked = this.look(call, args, true);
    // Opened again, as the person asked: closing it later is an ordinary close, not one during a pass.
    if (call.session.ended.get(looked.doc.storeId)?.how === "closed") call.session.ended.delete(looked.doc.storeId);
    const first = this.pointToNotes(call, looked);
    this.host.forYou?.(looked.doc.storeId, looked.member.name);
    const where = already ? "is already open in Corillo." : "is open in Corillo, in a background tab.";
    const rule = first ? ` ${this.throughCorillo(looked.label)}` : "";
    return `${looked.label} ${where} ${this.ready(call)}${this.nameNote(looked, call.session)}${rule}`;
  }

  private createDocument(call: Call, args: Record<string, unknown>): string {
    let filePath = this.pathArg(args);
    if (!path.extname(filePath)) filePath += ".md";
    if (!MARKDOWN_NAMED.test(filePath)) throw new AgentError("A new document's name must end in .md.");
    if (typeof args.text !== "string") throw new AgentError("Give the new document's text.");
    if (this.host.find(filePath)) throw new AgentError(`${path.basename(filePath)} is already open in Corillo. Edit it instead.`);
    // Refused before the file is made, as opening it would be.
    checkNotLong(filePath, Buffer.byteLength(args.text, "utf8"), false);
    this.host.create(filePath, args.text);
    const looked = this.join(call, this.host.open(filePath));
    this.host.forYou?.(looked.doc.storeId, looked.member.name);
    const rule = this.pointToNotes(call, looked) ? ` ${this.throughCorillo(looked.label)}` : "";
    call.session.lastRead.set(looked.doc.storeId, args.text);
    return `Created ${filePath} and opened it in Corillo, in a background tab. ${this.ready(call)}${this.nameNote(looked, call.session)}${rule}`;
  }

  private async readDocument(call: Call, args: Record<string, unknown>): Promise<string> {
    const looked = this.look(call, args);
    if (this.pointToNotes(call, looked)) call.notes.push(this.throughCorillo(looked.label));
    const pass = this.turns.holder(looked.doc.storeId);
    if (pass?.sessionId === call.session.id) pass.editFailed = false; // it sees the text as it is, and decides from there
    const from = lineArg(args.from_line, "from_line");
    const to = lineArg(args.to_line, "to_line");
    const at = characterArg(args);
    const { text, note } = await this.latest(looked.doc);
    // Part of it, by lines: it leaves the last read as it was, so the next read still says what changed since.
    const body =
      from !== undefined || to !== undefined ? someLines(looked.label, text, from ?? 1, to, looked.label, at) : this.textFor(call, looked, text, args.whole === true);
    return body + note + this.news(call, looked);
  }

  private listComments(call: Call, args: Record<string, unknown>): string {
    const looked = this.look(call, args);
    const markdown = commentLines(this.forLines(looked.doc));
    const all = this.comments.threads(looked.doc.storeId);
    const answered = all.filter((t) => answeredBy(t, looked.member.name, looked.unnamed));
    let text = this.waitingList(call, looked, markdown).text;
    if (answered.length && args.include_answered === true) {
      text += `\n\nAlready answered, waiting for the person (only they resolve comments):\n\n${this.formatThreads(answered, all, looked.member.name, markdown)}`;
    } else if (answered.length) {
      text += `\n\n${plural(answered.length, "comment")} you've already answered ${answered.length === 1 ? "is" : "are"} waiting for the person; include_answered shows ${answered.length === 1 ? "it" : "them"}.`;
    }
    return text;
  }

  private async takeDocument(call: Call, args: Record<string, unknown>): Promise<string> {
    const looked = this.look(call, { ...args, path: this.whichToTake(call, args) }, true);
    const key = looked.doc.storeId;
    const request = requestArg(args.request);
    if (!this.turns.holder(key)) this.roster.touch(key, call.session.id); // the latest to take it, for nextFor
    const taken = this.turns.take(key, call.session.id, looked.member.name);
    if (!taken.ok) throw new Held(key, taken.heldBy, looked.label);
    let header: string;
    let since: CatchUp | null = null;
    // The text the take works from, read once, so the file turning unreadable later in the take can't leave it held (R22-5).
    let current: string | undefined;
    if (taken.already) {
      header = `You're already editing ${looked.label}.`;
    } else {
      // The person's edits so far are saved first, and the tab stops taking more.
      const flushed = await this.host.flush(looked.doc, true);
      if (call.signal?.aborted) {
        this.endTurn(key, "free");
        this.announced.delete(key);
        this.announce(key);
        throw new Cancelled(looked.label);
      }
      if (flushed !== "saved") {
        this.endTurn(key, "free");
        this.announced.delete(key);
        this.announce(key);
        throw new AgentError(
          flushed === "conflict"
            ? `${looked.label} was changed outside Corillo while the person had edits that weren't saved, and they haven't chosen which version to keep. Ask them to choose in Corillo, then try again.`
            : flushed === "unsaved"
              ? `Corillo can't save ${looked.label} right now (the file may have been moved, deleted or locked; Corillo shows why in its window), so it isn't safe to edit yet. Ask the person to sort it out in Corillo, then try again.`
              : "Corillo's window didn't answer in time. Try again in a moment.",
        );
      }
      // A file that can't be read as text: the agent is told why, and the turn goes back (the review of Batch 21, G21-5).
      try {
        current = this.host.read(looked.doc);
      } catch (err) {
        this.endTurn(key, "free");
        this.announced.delete(key);
        this.announce(key);
        throw err;
      }
      call.session.settled = true;
      this.announce(key);
      // Said here too, the first time: some agent tools don't pass the instructions on, and this may be their first call.
      if (this.pointToNotes(call, looked)) call.notes.push(`Change ${looked.label} only through Corillo (edit_document or replace_document), never with your own file tools.`);
      try {
        since = this.sinceLastRound(call, looked, current!);
      } catch {
        // The history is a record: a problem making sense of it never holds up the take, which is under way.
      }
      try {
        await this.hooks.beginPass(key, looked.member.name);
      } catch {
        // History is a record; a problem keeping it never blocks the pass.
      }
      this.startLinks(key, looked.member.name, current!);
      call.took = { key, pass: taken.pass };
      call.session.ended.delete(key);
      // Taken from a chat request in the little while after a round: working now, it stays a listener through the
      // pass, and its other documents say so again (roadmap Batch 6).
      const l = this.listeners.get(call.session.id);
      if (l) {
        this.listeners.stopGrace(l);
        this.announceAll(l.docs);
      }
      header = `You're editing ${looked.label} now. The person and other agents can read and comment, but not edit, until you call finish_editing.`;
    }
    // Taken by its name, or with no path: the other tools need its path.
    const where = typeof args.path === "string" && path.isAbsolute(args.path.trim()) ? "" : ` Use its full path with the other tools: ${looked.doc.filePath}.`;
    if (request) this.setRequest(looked, request);
    const text = current ?? this.host.read(looked.doc);
    const lineOf = commentLines(text);
    const head = `${header}${this.nameNote(looked, call.session)}${where}`;
    // What it was asked is all it changes (roadmap Batch 9, item 11). A request given earlier in the pass counts too.
    const asked = !!(request || this.links.get(key)?.request);
    const keepTo = (what: string, where: string) =>
      `Change only the passages ${what} about, and leave the rest of the document as it is. If a change elsewhere seems needed, suggest it in ${where}; don't make it.`;
    const reviewed = "kept with the request you gave, and the person reviews them in History.";
    const address =
      `\n\nAddress all of them in this pass: make your changes, then reply on each, then call finish_editing.\n${keepTo(asked ? "these comments and the request are" : "these comments are", "a reply or your note")}\n` +
      `With each edit, give comment_ids: the ids of the comments it answers. The person reviews every change with its comment.${asked ? ` Edits you don't tie to a comment are ${reviewed}` : ""}`;
    const nothing = asked
      ? ` ${keepTo("the request is", "your note")} Your edits are ${reviewed}`
      : " If the person asked for changes in the chat, give their request with finish_editing, and change only the passages it's about.";
    // One budget for the whole answer (B1-04): the comments first, every one; then the text; then the catch-up.
    let room = TAKE - head.length - Math.max(address.length, nothing.length) - (since ? TAKE_CATCH_UP : 0) - 6;
    const comments = this.waitingList(call, looked, lineOf, room - TAKE_TEXT);
    if (!taken.already) taken.pass.found = comments.count;
    const intro = `${comments.text}${comments.count ? address : nothing}`;
    room -= comments.text.length;
    // A long document comes as its outline and start: with it, the paragraphs its comments are on.
    const lines = () =>
      this.comments
        .threads(key)
        .filter((t) => t.anchor && !t.detached && waitingFor(t, looked.member.name, looked.unnamed))
        // Every line a comment is on, so each paragraph it spans is given, not just its first.
        .flatMap((t) => {
          const at = lineOf.range(t.anchor!);
          return at ? Array.from({ length: Math.min(at.last - at.first, 200) + 1 }, (_, i) => at.first + i) : [];
        });
    const body = this.bodyFor(call, looked, text, false, (shown, left) => paragraphsAt(text, lines(), shown, left), room);
    let caught = "";
    if (since) {
      try {
        caught = since(body.changes, TAKE - head.length - intro.length - body.text.length - 6);
      } catch {
        // As above: the take goes ahead without it.
      }
    }
    return `${head}${caught ? `\n\n${caught}` : ""}\n\n${intro}\n\n${body.text}`;
  }

  /**
   * What happened since this agent's last round on the document, for the
   * take to open with (A-8): which of the comments it answered the person has
   * resolved or replied on, who changed the text since (the person, another
   * agent, a change outside Corillo) and how, and what that round did, so a
   * new chat can say what it changed last time without looking it up. A round
   * by another session of the same tool that is still open (Claude, for this
   * Claude 2) is named as that session's, and this session's own answers
   * before it still count. Null when this tool has had no round on it.
   * Capped: a long history since isn't walked, and a big change isn't sent.
   *
   * Gathered before the take reads the text for the agent, and written once
   * the take knows what it gives (see CatchUp).
   */
  private sinceLastRound(call: Call, looked: Looked, current: string): CatchUp | null {
    const key = looked.doc.storeId;
    let versions: Version[];
    try {
      versions = this.hooks.versions(key);
    } catch {
      return null;
    }
    // Rounds by the same tool under any number: a new chat may be Claude 2 while an old one lingers.
    const done = (v: Version) => v.kind === "agent" && !v.open;
    const mine = (v: Version) => done(v) && (v.agent ?? "").replace(/ \d+$/, "") === call.session.baseName;
    let i = versions.length - 1;
    while (i >= 0 && !mine(versions[i])) i--;
    if (i < 0) return null;
    const round = versions[i];
    const since = versions.slice(i + 1);
    // Another session's round, while that session is still open, is named as its own, never "yours": by the name it has
    // now, which is never this session's. Names move between sessions of one tool (a new chat is plain Claude), so whose
    // round it was is told by session.
    const ownRounds = call.session.rounds.get(key) ?? [];
    const by = [...this.sessions.values()].find((s) => s !== call.session && s.rounds.get(key)?.includes(round.n));
    const who = by ? this.roster.member(key, by.id)?.name || round.agent || "Agent" : null;
    const you = who ?? "you";
    // This session's own last round, when another session's came after it: its answers still count.
    const own = who ? versions.slice(0, i).reverse().find((v) => done(v) && ownRounds.includes(v.n)) : undefined;
    const all = this.comments.threads(key);
    // The comments answered then: resolved since, or replied on by the person since.
    const then = new Map((round.addressed ?? []).map((t) => [t.id, new Set(t.messages.map((m) => m.id))]));
    const answered = new Map([...(own?.addressed ?? []).map((t) => [t.id, new Set(t.messages.map((m) => m.id))] as const), ...then]);
    const resolved = all.filter((t) => then.has(t.id) && t.status === "resolved").length;
    const replied = all.filter(
      (t) =>
        answered.has(t.id) &&
        waitingFor(t, looked.member.name, looked.unnamed) &&
        t.messages.some((m) => m.author.kind === "person" && !answered.get(t.id)!.has(m.id)),
    );
    const said: string[] = [];
    if (resolved) said.push(`resolved ${resolved} of the comments ${you} answered`);
    if (replied.length) {
      const ids = replied.slice(0, 10).map((t) => `[${this.shortId(t, all)}]`);
      said.push(`replied on ${ids.join(", ")}${replied.length > 10 ? ` and ${replied.length - 10} more` : ""}`);
    }
    const clauses = said.length ? [`the person ${said.join(" and ")}`] : [];
    // Who changed the text since, each named as what it was.
    const numbers = (ns: number[]) => (ns.length === 1 ? `version ${ns[0]}` : `versions ${ns.slice(0, -1).join(", ")} and ${ns.at(-1)}`);
    if (since.length > CATCH_UP_VERSIONS) {
      clauses.push(`there have been ${since.length} versions, too many to go through here: list_versions and show_changes give them`);
    } else {
      const by = new Map<string, number[]>();
      for (const v of since) {
        const who = v.kind === "agent" ? `agent ${v.agent ?? "Agent"}` : v.kind;
        by.set(who, [...(by.get(who) ?? []), v.n]);
      }
      let person = said.length > 0; // "they", right after the person's own clause
      for (const [who, ns] of by) {
        const they = person ? "they" : "the person";
        if (who === "person") clauses.push(`${they} edited the text (${numbers(ns)})`);
        else if (who === "restored") clauses.push(`${they} brought back an earlier version (${numbers(ns)})`);
        else if (who === "outside") clauses.push(`it was changed outside Corillo (${numbers(ns)})`);
        else if (who.startsWith("agent ")) clauses.push(`${who.slice(6)} made a pass (${numbers(ns)})`);
        person = who === "person" || who === "restored";
      }
      if (!since.length) clauses.push(`the text is as ${you} left it`);
    }
    const when = inSentence(relativeTime(round.saved)) || formatDate(round.saved);
    const opening = `Since ${who ? `${who}'s` : "your"} last round on ${looked.label} (version ${round.n}, ${when}), ${clauses.join("; ")}.`;
    // How the text changed: once, in the changes to the text below when that's where it is already.
    let before: string | null = null;
    if (since.length && since.length <= CATCH_UP_VERSIONS) {
      try {
        before = this.hooks.versionText(key, round.n);
      } catch {
        // History is a record; a problem reading it never holds up the take.
      }
    }
    const changed = before !== null && before !== current ? before : null;
    const what = since.every((v) => v.kind === "person") ? "What they changed" : "What changed in the text since";
    // The agent read the text as that round left it: the take's own changes since its last read say it, if it gives them.
    const readThen = changed !== null && call.session.lastRead.get(key) === changed;
    const pointer = ` That's too much to show here: show_changes with version ${versions[versions.length - 1].n} and compared_with ${round.n} gives it.`;
    // What that round did, briefly: enough to say what changed last time.
    const lines: string[] = [];
    const addressed = round.addressed ?? [];
    if (addressed.length) {
      lines.push(`In that round ${you} addressed ${plural(addressed.length, "comment")}:`);
      for (const t of addressed.slice(0, ROUND_COMMENTS)) {
        const changed = summaryText(t.change?.spans ?? [], 2);
        lines.push(`- "${clip((t.messages[0]?.body ?? "").replace(/\s+/g, " "), 80)}": ${changed ? clip(changed, 200) : "replied, no change to the text"}`);
      }
      if (addressed.length > ROUND_COMMENTS) lines.push(`(and ${addressed.length - ROUND_COMMENTS} more: list_versions gives them all)`);
    }
    const other = summaryText(round.other ?? [], 2);
    if (round.request) lines.push(`Asked in chat: "${clip(round.request.replace(/\s+/g, " "), 200)}"${other ? `. Changed: ${clip(other, 200)}` : ""}`);
    else if (other) lines.push(`Changes not tied to a comment: ${clip(other, 200)}`);
    return (given, room) => {
      const below = changed !== null && readThen && given;
      let how = below ? ` ${what} is in the changes to the text below.` : "";
      if (changed !== null && !below) {
        const diff = formatHunks(diffLines(changed, current) ?? []);
        how = diff && diff.length <= CATCH_UP_DIFF ? ` ${what}, as a unified diff of the Markdown:\n\n${diff}` : pointer;
      }
      const full = lines.length ? `${opening}${how}\n\n${lines.join("\n")}` : `${opening}${how}`;
      if (full.length <= room) return full;
      // Short of room: the change and what that round did are pointed to, not given.
      const short = `${opening}${below ? how : changed !== null ? pointer : ""}${lines.length ? " list_versions gives what that round did." : ""}`;
      return short.length <= room ? short : "";
    };
  }

  private editsArg(args: Record<string, unknown>): Edit[] {
    const raw = args.edits;
    if (!Array.isArray(raw) || !raw.length) throw new AgentError("Give at least one edit, each with find and replace.");
    return raw.map((e, i) => {
      const edit = e as Record<string, unknown>;
      if (typeof edit?.find !== "string" || typeof edit?.replace !== "string") {
        throw new AgentError(`Edit ${i + 1} needs both find and replace, as text. Nothing was changed.`);
      }
      return { find: edit.find, replace: edit.replace, all: edit.all === true };
    });
  }

  /**
   * While an agent holds a document only another app can change the file. If
   * one did since the agent last read it, say what changed, so the agent
   * works from the text as it is now without reading it all again.
   */
  private changedOutside(call: Call, looked: Looked, current: string): string {
    const key = looked.doc.storeId;
    const last = call.session.lastRead.get(key);
    if (last === undefined || last === current) return "";
    const c = catchUp(last, current);
    // A change too long for one answer isn't sent with it.
    if (c.kind !== "changes" || c.diff.length > LONG) return `\n\n${looked.label} was changed outside Corillo since your last read. Read it again (read_document).`;
    call.session.lastRead.set(key, current);
    return `\n\n${looked.label} was changed outside Corillo since your last read. What changed, as a unified diff of the Markdown:\n\n${c.diff}`;
  }

  /**
   * Write the agent's new text. A file that can't be written (moved, deleted,
   * locked) isn't the agent's to fix, so that doesn't hold back its replies or finishing.
   */
  private writeFor(pass: Pass, looked: Looked, text: string, from: string): void {
    this.host.write(looked.doc, text, from);
    pass.editFailed = false;
  }

  /**
   * Tie an edit to its comments, then write it. If the file refuses it, the
   * change never happened, so the comments, the other changes and the pass's
   * record go back to how they were: nothing may say it did.
   */
  private linkAndWrite(pass: Pass, looked: Looked, before: string, after: string, groups: EditGroup[]): void {
    const key = looked.doc.storeId;
    const threads = this.comments.threads(key);
    const links = this.links.get(key);
    const kept = links && copyLinks(links);
    this.linkEdits(looked, before, groups);
    try {
      this.writeFor(pass, looked, after, before);
    } catch (err) {
      if (links && kept) {
        this.links.set(key, kept);
        if (this.reminded.has(links)) this.reminded.add(kept);
      } else this.links.delete(key);
      try {
        this.comments.updateChanges(key, () => threads);
      } catch (undo) {
        console.error("Corillo couldn't take back the links of an edit the file refused.", undo);
      }
      throw err;
    }
  }

  private editDocument(call: Call, args: Record<string, unknown>): string {
    const looked = this.lookHeld(call, args, (label, key) => this.notEditing(call, key, label));
    this.requireHolder(call, looked);
    const pass = this.turns.holder(looked.doc.storeId)!;
    const edits = this.editsArg(args);
    // Which comments each edit answers: its own comment_ids, or the call's.
    const forCall = this.commentIdsArg(looked, args.comment_ids);
    const forEdit = (args.edits as Record<string, unknown>[]).map((e) =>
      e && "comment_ids" in e ? this.commentIdsArg(looked, e.comment_ids) : forCall,
    );
    const before = this.host.read(looked.doc);
    const readBefore = call.session.lastRead.get(looked.doc.storeId);
    const outside = this.changedOutside(call, looked, before);
    const result = applyEdits(before, edits);
    if (!result.ok) {
      pass.editFailed = true;
      throw new AgentError(result.error + outside + this.news(call, looked));
    }
    if (result.text === before) return `That didn't change anything in ${looked.label}.${outside}${this.news(call, looked)}`;
    // The safety net (roadmap Batch 14, item 1): outside what the edits found, the text is as it was.
    const after = this.spliceFault ? this.spliceFault(result.text) : result.text;
    const lost = spliceLoss(before, after, result.placed);
    if (lost) {
      pass.editFailed = true;
      throw new AgentError(spliceRefused(lost) + outside + this.news(call, looked));
    }
    // Linked first, so the window knows which comments lost their words before
    // the new text arrives (or it would show them lost for a moment). Linking
    // reads the whole document, and so does the window: it reads it meanwhile.
    this.host.coming?.(looked.doc, after);
    try {
      this.linkAndWrite(pass, looked, before, after, groupEdits(before, edits, forEdit));
    } catch (err) {
      // The refusal doesn't carry the news of another app's change, so the agent hasn't read it.
      if (readBefore !== undefined) call.session.lastRead.set(looked.doc.storeId, readBefore);
      throw err;
    }
    // The agent knows what it just wrote, so its next read needn't repeat it.
    if (call.session.lastRead.get(looked.doc.storeId) === before) call.session.lastRead.set(looked.doc.storeId, after);
    const places = result.placed.length > edits.length ? ` in ${result.placed.length} places` : "";
    const tied = this.linkNote(looked, forEdit.flat());
    return `Done: ${plural(edits.length, "change")} made to ${looked.label}${places}${tied.note}. As it reads now:\n${asItReads(after, result.placed)}${tied.reminder}${outside}${this.news(call, looked)}`;
  }

  /** The comments an edit answers, as their full ids. Refused (nothing changed) if one isn't the agent's to answer. */
  private commentIdsArg(looked: Looked, value: unknown): string[] {
    if (value === undefined || value === null) return [];
    const refs = Array.isArray(value) ? value : [value];
    const threads = this.comments.threads(looked.doc.storeId);
    const ids: string[] = [];
    for (const ref of refs) {
      if (typeof ref !== "string" || !ref.trim()) continue;
      let thread: Thread;
      try {
        thread = this.findThread(threads, ref, looked.label);
      } catch (err) {
        throw new AgentError(`${(err as Error).message} Nothing was changed.`);
      }
      if (thread.status === "resolved") {
        throw new AgentError(`The person has resolved comment [${this.shortId(thread, threads)}], so it's closed; leave it out of comment_ids. Nothing was changed.`);
      }
      if (!mayReply(thread, looked.member.name, looked.unnamed)) {
        throw new AgentError(`Comment [${this.shortId(thread, threads)}] isn't addressed to you, so an edit can't answer it. Nothing was changed.`);
      }
      if (!ids.includes(thread.id)) ids.push(thread.id);
    }
    return ids.sort();
  }

  /** Which comments an edit was tied to, for the agent; or, once a pass, a reminder to say. */
  private linkNote(looked: Looked, ids: string[]): { note: string; reminder: string } {
    const all = this.comments.threads(looked.doc.storeId);
    const unique = [...new Set(ids)];
    if (unique.length) {
      const list = unique.map((id) => `[${this.shortId(all.find((t) => t.id === id)!, all)}]`).join(", ");
      return { note: `, for comment${unique.length === 1 ? "" : "s"} ${list}`, reminder: "" };
    }
    const links = this.links.get(looked.doc.storeId);
    if (links?.request) return { note: ", for the request from the chat", reminder: "" };
    // Only comments waiting for it: one it answered, left open, asked nothing of this pass (review of Batch 9, B9-01).
    const inPlay = all.some((t) => waitingFor(t, looked.member.name, looked.unnamed));
    if (!links || this.reminded.has(links)) return { note: "", reminder: "" };
    this.reminded.add(links);
    return {
      note: "",
      // The chat's route before the revert: the request may come with finish_editing.
      reminder: inPlay
        ? "\n\nThis change isn't tied to a comment. If it answers one, say so with comment_ids next time, so the person can review each change with its comment. If the person asked for it in the chat, give their request with finish_editing. If nobody asked for it, put it back as it was and suggest it in a reply or your note instead."
        : "\n\nIf the person asked for this in the chat, give their request with finish_editing, so it's kept with this version.",
    };
  }


  /** A new pass: remember the text as it began, so each comment's change can be told from the rest. */
  private startLinks(storeId: string, agent: string, markdown: string): PassLinks {
    // And the words each comment was on, which the history keeps: the agent may rewrite them.
    const anchors = new Map<string, Anchor>();
    for (const t of this.comments.threads(storeId)) if (t.anchor) anchors.set(t.id, t.anchor);
    this.passAnchors.set(storeId, anchors);
    let links: PassLinks;
    try {
      links = new PassLinks(agent, plainText(markdown, storeId));
    } catch {
      links = new PassLinks(agent, "");
    }
    this.links.set(storeId, links);
    return links;
  }

  /** What the person asked for in the chat: kept with the pass, and its edits tied to no comment are for it. */
  private setRequest(looked: Looked, text: string): void {
    const key = looked.doc.storeId;
    try {
      const links = this.links.get(key) ?? this.startLinks(key, looked.member.name, this.host.read(looked.doc));
      links.setRequest(`request-${newId()}`, text);
    } catch (err) {
      console.error("Corillo couldn't keep the request from the chat.", err);
    }
  }

  /** After an agent's edit: what it changed, tied to the comments it answers, kept with them. */
  private linkEdits(looked: Looked, before: string, groups: EditGroup[]): void {
    const key = looked.doc.storeId;
    try {
      const was = reading(before, key);
      const links = this.links.get(key) ?? this.startLinks(key, looked.member.name, before);
      const from = was.words;
      const steps = groups.map((g) => ({ text: plainText(g.markdown, key), owners: g.owners }));
      const last = groups[groups.length - 1];
      const is = last ? reading(last.markdown, key) : was;
      const to = is.words;
      // Followed by the Markdown's own lines, and each exact edit on its own, however close the others are.
      const placed = groups.every((g) => g.placed) ? groups.flatMap((g) => g.placed!) : undefined;
      const syncs = from === to ? undefined : syncsFor(was, is, placed);
      links.edited(from, steps, groups.length === 1 ? syncs : undefined);
      const now = new Date().toISOString();
      const map = syncs && new OffsetMap(from, to, false, syncs);
      // Each comment's change, and each comment's words, carried through the edit.
      this.comments.updateChanges(key, (threads) => followEdit(updateChanges(threads, links, from, to, now, map), from, to, map));
    } catch (err) {
      // The links are a record kept alongside; the edit itself is made.
      console.error("Corillo couldn't tie an edit to its comments.", err);
    }
  }

  private replaceDocument(call: Call, args: Record<string, unknown>): string {
    const looked = this.lookHeld(call, args, (label, key) => this.notEditing(call, key, label));
    this.requireHolder(call, looked);
    const pass = this.turns.holder(looked.doc.storeId)!;
    // from_version brings back an earlier version's text, without sending it all.
    const from = this.versionArg(args.from_version, "from_version");
    let given = args.text;
    if (from !== undefined) {
      if (typeof given === "string") throw new AgentError("Give either text or from_version, not both. Nothing was changed.");
      given = this.versionTextOf(looked, this.findVersion(this.versionsOf(looked), from, looked.label));
    }
    if (typeof given !== "string") {
      throw new AgentError("Give the document's new text, or from_version to bring back an earlier version. Nothing was changed.");
    }
    const owners = this.commentIdsArg(looked, args.comment_ids);
    const current = this.host.read(looked.doc);
    // An earlier version is already in the file's own form; an agent's text comes with plain line breaks.
    const text = from === undefined ? inFileForm(current, given) : given;
    const last = call.session.lastRead.get(looked.doc.storeId);
    if (last === undefined) {
      throw new AgentError(`Read ${looked.label} first (read_document), so you replace the latest version. Nothing was changed.`);
    }
    if (last !== current) {
      pass.editFailed = true;
      const c = catchUp(last, current);
      if (c.kind === "changes" && c.diff.length <= LONG) {
        call.session.lastRead.set(looked.doc.storeId, current);
        throw new AgentError(
          `Nothing was changed: ${looked.label} was changed outside Corillo since your last read, and replacing the whole text would lose that. Put these changes into your text, then call replace_document again:\n\n${c.diff}`,
        );
      }
      throw new AgentError(
        `${looked.label} has changed since you last read it. Read it again (read_document), then replace it, so nobody's changes are lost. Nothing was changed.`,
      );
    }
    if (text === current) {
      const same = from !== undefined ? `Version ${from} is the same as the current text` : "That's the same as the current text";
      return `${same}, so nothing changed.${this.news(call, looked)}`;
    }
    this.host.coming?.(looked.doc, text);
    this.linkAndWrite(pass, looked, current, text, [{ markdown: text, owners }]);
    call.session.lastRead.set(looked.doc.storeId, text);
    const tied = this.linkNote(looked, owners);
    const what = from !== undefined ? `brought back version ${from} of ${looked.label}` : `replaced the whole text of ${looked.label}`;
    return `Done: ${what} (${linesChanged(current, text)})${tied.note}.${tied.reminder}${this.news(call, looked)}`;
  }

  private agentAuthor(looked: Looked): Author {
    return { kind: "agent", name: looked.member.name };
  }

  private async replyToComment(call: Call, args: Record<string, unknown>): Promise<string> {
    const looked = this.look(call, args);
    const key = looked.doc.storeId;
    // Options (roadmap Batch 3, item 2): each must fit the text as it is now, or nothing is posted.
    let options: ReplyOption[] = [];
    const pictures = new Set<string>();
    if (args.options !== undefined && args.options !== null) {
      const text = (await this.latest(looked.doc)).text;
      const checked = checkOptions(args.options, text);
      if (!checked.ok) throw new AgentError(checked.error);
      options = checked.options;
      // A web picture an option would add waits for the person, as one in an edit does: listed before the reply reaches the window.
      // Read once each, not kept: a reply can come outside a pass, whose end lets go of what was read (the review of Batch 19, R19-9).
      const was = webPicturesOfText(text);
      for (const option of options) {
        const applied = applyOption(text, option);
        if (applied.ok) for (const address of webPicturesOfText(applied.text)) if (!was.has(address)) pictures.add(address);
      }
    }
    const thread = this.findThread(this.comments.threads(key), args.comment_id, looked.label);
    if (thread.status === "resolved") {
      throw new AgentError("The person has resolved that comment, so it's closed. If something still matters, start a new comment with add_comment.");
    }
    if (!mayReply(thread, looked.member.name, looked.unnamed)) {
      throw new AgentError("That comment isn't addressed to you. Reply only on comments addressed to you or that you started.");
    }
    const pass = this.turns.holder(key);
    const inPass = pass?.sessionId === call.session.id;
    // A reply sent alongside an edit that failed would say something that isn't so.
    if (inPass && pass.editFailed) {
      throw new AgentError(
        `Not posted: your last change to ${looked.label} didn't go through, so the text hasn't changed yet. Make the change first (or call read_document, if you've decided to leave the text as it is), then reply.`,
      );
    }
    if (pictures.size) this.host.picturesWait(looked.doc, [...pictures]);
    const updated = this.comments.reply(key, thread.id, this.agentAuthor(looked), typeof args.text === "string" ? args.text : "", null, options);
    call.session.settled = true;
    if (inPass) pass.replied.add(thread.id);
    this.markSeen(call.session, key, [updated]);
    const all = this.comments.threads(key);
    const news = this.news(call, looked);
    const lastOne =
      inPass && !news && !all.some((t) => waitingFor(t, looked.member.name, looked.unnamed))
        ? ` That was the last comment waiting for you: call finish_editing to hand ${looked.label} back.`
        : "";
    const offered = options.length ? ` The person can apply one of your ${plural(options.length, "option")} with a click.` : "";
    return `Replied on [${this.shortId(updated, all)}].${offered}${lastOne}${news}`;
  }

  private addComment(call: Call, args: Record<string, unknown>): string {
    const looked = this.look(call, args);
    const key = looked.doc.storeId;
    const quote = typeof args.quote === "string" ? args.quote.trim() : "";
    const anchor = quote ? anchorForQuote(this.host.read(looked.doc), quote) : null;
    const body = typeof args.text === "string" ? args.text : "";
    const thread = this.comments.add(key, this.agentAuthor(looked), body, anchor, "person");
    call.session.settled = true;
    const pass = this.turns.holder(key);
    if (pass?.sessionId === call.session.id) pass.started.add(thread.id);
    const started = call.session.started.get(key) ?? new Set<string>();
    call.session.started.set(key, started.add(thread.id));
    this.markSeen(call.session, key, [thread]);
    const where = anchor ? `on "${clip(anchor.quote, 60)}"` : "on the whole document";
    return `Added a comment for the person ${where} [${this.shortId(thread, this.comments.threads(key))}].${this.news(call, looked)}`;
  }

  private async finishEditing(call: Call, args: Record<string, unknown>): Promise<string> {
    const looked = this.lookHeld(call, args, (label) => `You're not editing ${label}, so there's nothing to finish.`);
    const key = looked.doc.storeId;
    const pass = this.turns.holder(key);
    if (pass?.sessionId !== call.session.id) {
      throw new AgentError(`You're not editing ${looked.label}, so there's nothing to finish.`);
    }
    const request = requestArg(args.request);
    if (request) this.setRequest(looked, request);
    // The note goes with the finish that goes through, even if this one is turned back.
    const note = requestArg(args.note);
    if (note) pass.note = note;
    if (pass.editFailed) {
      throw new AgentError(
        `Not finished: your last change to ${looked.label} didn't go through, so the text hasn't changed. Make it first (or call read_document, if you've decided to leave the text as it is), then call finish_editing.`,
      );
    }
    // Comments still waiting are pointed out once (some may have arrived during the pass), so they can be answered in it.
    const all = this.comments.threads(key);
    const unanswered = all.filter((t) => waitingFor(t, looked.member.name, looked.unnamed));
    const unseen = unanswered.filter((t) => pass.pointedOut.get(t.id) !== t.messages.length);
    if (unseen.length) {
      for (const t of unanswered) pass.pointedOut.set(t.id, t.messages.length);
      this.markSeen(call.session, key, unanswered);
      const n = unanswered.length;
      throw new AgentError(
        `Not finished: ${plural(n, "comment")} on ${looked.label} ${n === 1 ? "is" : "are"} still waiting for you:\n\n${this.formatThreads(unanswered, all, looked.member.name, this.forLines(looked.doc))}\n\nAddress ${n === 1 ? "it" : "them"} and reply, then call finish_editing. To leave ${n === 1 ? "it" : "them"} for your next pass instead, call finish_editing again.`,
      );
    }
    this.endTurn(key, "free");
    await this.endPass(key, pass, "agent");
    this.announce(key);
    this.host.backToYou(key);
    const later = unanswered.length ? ` ${plural(unanswered.length, "comment")} still waiting for you will come back to you in your next pass.` : "";
    // Their replies (and the note, with what to decide) are read in Corillo: the chat needn't repeat them. How to ask for more is said once a session.
    const { finished, canWait } = call.session;
    const read = pass.note ? "your replies and your note" : "your replies";
    const back = pass.note ? "that it's back" : "that it's back, and anything they must decide";
    const chat = canWait
      ? finished
        ? ` They read ${read} in Corillo, so in the chat a line is enough. Then call wait_for_review and end your turn.`
        : ` They read ${read} in Corillo, so in the chat a line is enough: ${back}. Then call wait_for_review and end your turn: they can reply on any comment and send it back to you from Corillo.`
      : finished
        ? ` They read ${read} in Corillo, so in the chat a line is enough.`
        : ` They read ${read} in Corillo, so in the chat a line is enough: ${back}. Tell them too that they can reply on any comment in Corillo and tell you here when there's more.`;
    call.session.finished = true;
    return `Done. ${looked.label} is back with the person.${later}${chat}`;
  }

  // Looking back: the version history (looking-back.ts) ------------------------------------
  // The person's unsaved edits are saved first, so the newest version is up to date.

  historyNote = lookingBack.historyNote;
  versionArg = lookingBack.versionArg;
  versionsOf = lookingBack.versionsOf;
  findVersion = lookingBack.findVersion;
  versionTextOf = lookingBack.versionTextOf;
  whoAndWhen = lookingBack.whoAndWhen;
  addressedLines = lookingBack.addressedLines;
  listVersions = lookingBack.listVersions;
  readVersion = lookingBack.readVersion;
  showChanges = lookingBack.showChanges;

  // Export (export-tool.ts) -----------------------------------------------------------------------

  exportDocument = exportTool.exportDocument;
}

/** What the person asked for in the chat, as an agent gives it: trimmed and kept to a sensible length. */
function requestArg(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const text = value.trim();
  if (!text) return null;
  return text.length > 2000 ? `${text.slice(0, 2000).trimEnd()}…` : text;
}

/**
 * The options an agent offered with a reply, and the one the person chose
 * (roadmap Batch 3, item 2), for agents: said only while that choice is in
 * the text (`markdown`), not once Undo took it back (review of Batch 3, B3-R04).
 */
function offeredIn(m: Message, markdown: string | undefined): string {
  const options = optionsOf(m);
  if (!options.length) return "";
  const choices = choicesOf(m);
  const now = markdown !== undefined && choices.length ? standing(markdown, options, choices) : null;
  const chosen = now ? options[now.choice.option] : undefined;
  return `\n    Options: ${options.map((o) => `"${o.label}"`).join(", ")}.${chosen ? ` The person chose "${chosen.label}".` : ""}`;
}
