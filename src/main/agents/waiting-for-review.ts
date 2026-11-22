// Waiting for the person's review (Send to Claude, roadmap Batch 2 item 1): wait_for_review held until the person sends a document back, Send, and the hand-over.
import * as path from "node:path";
import { waitingFor } from "../../core/agents";
import type { AgentService } from "./agent-service";
import { OPENS_AS_MARKDOWN } from "../../core/doc-names";
import { READY, READY_WAIT, WAIT_CANT, waitClosed, waitStopped } from "./limits-and-words";
import { WAIT_QUIT } from "../../core/waiting-words";
import type { Listener, Woken } from "./listening";
import { namedIn } from "./finding-words";
import { AgentError, type AgentDoc, type Call, type ToolOutcome } from "./shapes";

/** What open and create tell the agent: how the person hands the document back. */
export function ready(this: AgentService, call: Call): string {
  return call.session.canWait ? READY_WAIT : READY;
}

/** The name of the document a session is busy with (editing it, or being handed it), if any. */
export function busyWith(this: AgentService, sessionId: string): string | null {
  const key = this.turns.heldBy(sessionId)[0] ?? this.listeners.get(sessionId)?.waking;
  const doc = key ? this.host.byStoreId(key) : null;
  return doc ? path.basename(doc.filePath) : null;
}

/** "plan.md", "plan.md and notes.md". */
export function namesOf(this: AgentService, keys: Iterable<string>): string {
  const names = [...keys].flatMap((k) => {
    const doc = this.host.byStoreId(k);
    return doc ? [path.basename(doc.filePath)] : [];
  });
  if (names.length <= 1) return names[0] ?? "your documents";
  return `${names.slice(0, -1).join(", ")} and ${names[names.length - 1]}`;
}

/** Tell the window about each of these documents that's open. */
export function announceAll(this: AgentService, keys: Iterable<string>): void {
  for (const key of [...keys]) if (this.host.byStoreId(key)) this.announce(key);
}

/** The session stops listening; a wait it holds is answered with `why`. A Send it never got is told to the window. */
export function stopListening(this: AgentService, sessionId: string, why: string): void {
  const name = (key: string) => this.roster.member(key, sessionId)?.name ?? this.sessions.get(sessionId)?.baseName ?? "Claude";
  const { docs, lost } = this.listeners.stop(sessionId, why);
  // The window first hears who's on each document (the button becomes Copy), then why.
  this.announceAll(docs);
  for (const key of lost) if (this.host.byStoreId(key)) this.host.sendLost?.(key, name(key), "stopped");
}

/**
 * A listening session is free (a pass ended, or a document was handed
 * over): a wait it holds gets the next document sent meanwhile; with no
 * wait, it has a little while to wait again.
 */
export function free(this: AgentService, sessionId: string): void {
  const l = this.listeners.get(sessionId);
  if (!l || l.waking || this.turns.heldBy(sessionId).length) return;
  if (!l.held) this.listeners.startGrace(l);
  else {
    const next = this.nextSent(l);
    if (next) this.listeners.wake(l, next);
  }
  this.announceAll(l.docs);
}

/** Corillo is quitting: every wait ends, with words that say so. */
export function quitting(this: AgentService): void {
  for (const sessionId of this.listeners.sessions()) this.listeners.stop(sessionId, WAIT_QUIT);
}

/**
 * The person pressed Send to Claude: the agent listening on the document
 * (the one named, else the first) gets it, now if it's waiting, or at its
 * next wait if it's busy.
 */
export function send(this: AgentService, storeId: string, agentName?: string): Promise<{ sent: boolean; problem?: string }> {
  return this.enqueue(async () => {
    const doc = this.host.byStoreId(storeId);
    if (!doc) return { sent: false, problem: "That document isn't open." };
    const label = path.basename(doc.filePath);
    const pass = this.turns.holder(storeId);
    if (pass) return { sent: false, problem: `${pass.name} is editing ${label}.` };
    const on = this.listeners.on(storeId);
    const l = agentName ? on.find((x) => this.roster.member(storeId, x.sessionId)?.name === agentName) : on[0];
    if (!l) return { sent: false, problem: `${agentName && on.length ? `${agentName} isn't` : "No agent is"} waiting for your review of ${label}.` };
    if (l.waking !== storeId && !l.queued.includes(storeId)) {
      if (l.held && !l.waking && !this.turns.heldBy(l.sessionId).length) this.listeners.wake(l, storeId);
      else {
        l.queued.push(storeId);
        if (this.hasFor(storeId, l.sessionId)) l.forComments.add(storeId);
        else l.forComments.delete(storeId);
      }
    }
    this.announceAll(l.docs);
    return { sent: true };
  });
}

/** Whether a comment on the document waits for this session: its turn, by the rules for comments with no @ (D3). */
export function hasFor(this: AgentService, key: string, sessionId: string): boolean {
  const member = this.roster.member(key, sessionId);
  if (!member) return false;
  const unnamed = this.unnamedFor(key, sessionId);
  return this.comments.threads(key).some((t) => waitingFor(t, member.name, unnamed));
}

/**
 * A Send kept for a busy agent that was for comments none of which waits
 * for it now: another chat picked them up, or the person resolved them.
 * Handing it over would take the document for an empty round (B3-R05).
 */
export function sentForNothing(this: AgentService, l: Listener, key: string): boolean {
  return l.forComments.has(key) && !this.hasFor(key, l.sessionId);
}

/**
 * Let go of Sends kept for busy agents on a document that were for comments
 * none of which waits for them now (see sentForNothing), except `keep`'s.
 * Whether one was let go: the window is to hear of it.
 */
export function letGoEmptySends(this: AgentService, key: string, keep?: string): boolean {
  let any = false;
  for (const l of this.listeners.on(key)) {
    if (l.sessionId === keep || !l.queued.includes(key) || !this.sentForNothing(l, key)) continue;
    l.queued = l.queued.filter((k) => k !== key);
    l.forComments.delete(key);
    any = true;
  }
  return any;
}

/**
 * The comments on a document changed (the person resolved one, say). A Send
 * kept for a busy agent that was for comments none of which waits for it
 * now is let go, so the button and the cards stop saying it was sent
 * (roadmap Batch 6). Costs nothing unless such a Send is kept.
 */
export function commentsChanged(this: AgentService, storeId: string): void {
  if (!this.listeners.on(storeId).some((l) => l.forComments.has(storeId))) return;
  void this.enqueue(async () => {
    if (this.letGoEmptySends(storeId)) this.announce(storeId);
  });
}

/** The next document kept for a listener, passing over any sent for comments no longer its. */
export function nextSent(this: AgentService, l: Listener): string | undefined {
  for (let key = l.queued.shift(); key; key = l.queued.shift()) {
    const empty = this.sentForNothing(l, key);
    l.forComments.delete(key);
    if (!empty) return key;
  }
  return undefined;
}

/**
 * wait_for_review: held, at no cost, until the person sends one of the
 * agent's documents back, then answered as take_document would, with the
 * document taken for the agent's pass. A document sent while the agent was
 * busy is answered at once. An agent tool that can't keep a call open (its
 * connector says, in canHold) is answered at once.
 */
export async function waitForReview(this: AgentService, sessionId: string, args: Record<string, unknown>, signal?: AbortSignal): Promise<ToolOutcome> {
  const start = await this.enqueue(async (): Promise<ToolOutcome | { held: Promise<Woken> } | { now: string }> => {
    const session = this.sessions.get(sessionId);
    if (!session) return { text: "This session has ended. Start a new one.", isError: true };
    if (!session.canWait || args.canHold !== true) return { text: WAIT_CANT, isError: false };
    if (signal?.aborted) return { text: "Cancelled.", isError: true };
    // Held while it holds a document, the document would stay locked and nothing could wake it (B2-02).
    const editing = this.turns.heldBy(sessionId);
    if (editing.length) {
      const one = editing.length === 1;
      return {
        text: `You're still editing ${this.namesOf(editing)}, so the person can't edit ${one ? "it" : "them"} or send ${one ? "it" : "them"} back. Reply on each comment you've addressed, call finish_editing, then call wait_for_review.`,
        isError: true,
      };
    }
    let keys: string[];
    try {
      keys = this.docsToWaitFor({ session, notes: [] }, args);
    } catch (err) {
      return { text: err instanceof Error ? err.message : String(err), isError: true };
    }
    if (this.listeners.get(sessionId)?.held) {
      // An earlier wait is still open (in the background): it's the one that wakes, now for these too.
      const l = this.listeners.listen(sessionId, keys, true);
      this.announceAll(l.docs);
      return {
        text: `You're already waiting for the person's review of ${this.namesOf(l.docs)}: an earlier wait_for_review is still open. End your turn now; you're woken when they send one back.`,
        isError: false,
      };
    }
    const l = this.listeners.listen(sessionId, keys);
    const next = this.turns.heldBy(sessionId).length ? undefined : this.nextSent(l);
    if (next) {
      l.waking = next;
      this.announceAll(l.docs);
      return { now: next };
    }
    const held = new Promise<Woken>((resolve) => (l.held = resolve));
    this.announceAll(l.docs);
    return { held };
  });
  if ("text" in start) return start;
  let storeId: string;
  if ("now" in start) storeId = start.now;
  else {
    // Cancelled (the person pressed Esc, or the connector's own time limit ran out): it stops listening.
    const cancel = () => {
      const l = this.listeners.get(sessionId);
      this.stopListening(sessionId, waitStopped(this.namesOf(l?.docs ?? [])));
    };
    signal?.addEventListener("abort", cancel, { once: true });
    if (signal?.aborted) cancel();
    const woken = await start.held;
    signal?.removeEventListener("abort", cancel);
    if ("ended" in woken) return { text: woken.ended, isError: false };
    storeId = woken.sent;
  }
  return this.handOver(sessionId, storeId, signal);
}

/** Hand a document the person sent to the agent: taken for its pass, answered as take_document answers. */
export async function handOver(this: AgentService, sessionId: string, storeId: string, signal?: AbortSignal): Promise<ToolOutcome> {
  const doc = this.host.byStoreId(storeId);
  let outcome: ToolOutcome = { text: waitClosed("the document"), isError: false };
  if (doc) {
    const label = path.basename(doc.filePath);
    const taken = await this.call(sessionId, "take_document", { path: doc.filePath }, signal);
    outcome = {
      text: `The person sent ${label} back to you from Corillo${taken.isError ? ", but it couldn't be taken for you:" : "."}\n\n${taken.text}`,
      isError: taken.isError,
    };
  }
  const l = this.listeners.get(sessionId);
  if (l?.waking === storeId) {
    l.waking = null;
    this.free(sessionId);
    this.announceAll(l.docs);
  }
  // The window said "Sent to Claude": it hears that the agent couldn't start (B2-04).
  if (outcome.isError && this.host.byStoreId(storeId)) {
    this.host.sendLost?.(storeId, this.roster.member(storeId, sessionId)?.name ?? this.sessions.get(sessionId)?.baseName ?? "Claude", "failed");
  }
  return outcome;
}

/**
 * The documents a wait is for: those it names, or every open one this agent
 * is on. It joins each. A name is, as for take_document, the file of that
 * name in the agent's folder when there is one (the connector gives it as
 * `here`, beside each name), else the open document it fits (B2-05).
 */
export function docsToWaitFor(this: AgentService, call: Call, args: Record<string, unknown>): string[] {
  const paths = Array.isArray(args.paths) ? args.paths : [];
  const heres = Array.isArray(args.here) ? args.here : [];
  const named = paths.flatMap((p, i) => {
    if (typeof p !== "string" || !p.trim()) return [];
    const here = heres[i];
    return [{ name: p.trim(), here: typeof here === "string" && path.isAbsolute(here) ? path.normalize(here) : "" }];
  });
  const open = this.host.openDocs();
  let docs: AgentDoc[];
  if (named.length) {
    docs = named.map(({ name, here }) => {
      const notOpen = new AgentError(`${path.basename(name)} isn't open in Corillo. Open it with open_document first, then wait.`);
      // A full path; or the agent's own README.md, never another open README.md elsewhere.
      const own = path.isAbsolute(name) ? path.normalize(name) : here && OPENS_AS_MARKDOWN.test(here) && this.host.kindOf(here) === "file" ? here : "";
      const fits = own ? [] : namedIn(open, name);
      if (fits.length > 1) {
        const all = fits.map((d) => d.filePath);
        throw new AgentError(`${fits.length} open documents fit "${name}": ${all.slice(0, -1).join(", ")} and ${all.at(-1)}. Give the full path of the one to wait for.`);
      }
      const found = own ? this.host.find(own) : (fits[0] ?? null);
      if (!found) throw notOpen;
      return found;
    });
  } else {
    const mine = new Set(this.roster.docsOf(call.session.id));
    docs = open.filter((d) => mine.has(d.storeId));
    if (!open.length) {
      throw new AgentError("No documents are open in Corillo to wait for. Open one for the person's review first (open_document or create_document), then wait.");
    }
    if (!docs.length) {
      throw new AgentError(`Say which documents to wait for: give their names or full paths as paths.\n\nOpen in Corillo:\n${this.openList(call).map((d) => d.line).join("\n")}`);
    }
  }
  for (const d of docs) this.join(call, d);
  return [...new Set(docs.map((d) => d.storeId))];
}
