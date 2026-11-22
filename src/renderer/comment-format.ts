// How comments read in the panel: their order, who wrote them, when, and who
// they're for. Plain logic, no screen, so it can be tested on its own.
import type { Author, Thread } from "../core/comments";
import type { AgentInfo as AppAgentInfo, PassSummary } from "../preload/preload";

/**
 * An agent on the document, as the app reports it (AgentInfo in agents/shapes.ts, taken from there, never copied:
 * Batch 18, A16-10). The comments' logic doesn't need its colour or whether it's editing.
 */
export type AgentInfo = Omit<AppAgentInfo, "colour" | "editing"> & Partial<Pick<AppAgentInfo, "colour" | "editing">>;

// When, said the same way on the cards as in History.
export { fullTime, relativeTime } from "../core/versions";

export function authorName(author: Author): string {
  return author.kind === "person" ? "You" : author.name || "Agent";
}

const NAMED_QUOTE = 60;

/**
 * A card as a screen reader names it: who wrote it, what it's on, whose turn
 * it is ("Comment by You on “two people”, waiting for Claude"). `turn` is the
 * card's own line ("Waiting for Claude"), if it has one.
 */
export function cardName(thread: Thread, turn: string | null): string {
  const first = thread.messages[0];
  const by = first ? ` by ${authorName(first.author)}` : "";
  let on = " on the whole document";
  if (thread.anchor) {
    let quote = thread.anchor.quote.replace(/\s+/g, " ").trim();
    if (quote.length > NAMED_QUOTE) {
      const cut = quote.slice(0, NAMED_QUOTE);
      const space = cut.lastIndexOf(" ");
      quote = `${(space > NAMED_QUOTE / 2 ? cut.slice(0, space) : cut).trimEnd()}…`;
    }
    on = quote ? ` on “${quote}”` : "";
  }
  const state = thread.status === "resolved" ? "resolved" : turn ? turn.charAt(0).toLowerCase() + turn.slice(1) : "";
  return `Comment${by}${on}${state ? `, ${state}` : ""}`;
}

/** "To Writer" on the person's comments meant for a particular agent; nothing for the default agent. */
export function toLabel(thread: Thread): string | null {
  const first = thread.messages[0];
  if (!first || first.author.kind !== "person") return null;
  if (!thread.to || thread.to === "person") return null;
  return `To ${thread.to}`;
}

/**
 * "To Writer" beside each of the person's messages that named an agent with @
 * (the first directed the comment, a later one handed it over). A comment
 * directed without a tag shows it beside its first message, as before.
 */
export function recipientLabel(thread: Thread, index: number): string | null {
  const m = thread.messages[index];
  if (!m || m.author.kind !== "person") return null;
  if (m.mention) return `To ${m.mention}`;
  if (index !== 0 || thread.messages.some((x) => x.mention)) return null;
  return toLabel(thread);
}

/** The agents a document's comments name: who wrote in them, and whom they were for. */
export function agentsNamedIn(threads: Thread[]): string[] {
  const names = new Set<string>();
  for (const t of threads) {
    if (t.to && t.to !== "person") names.add(t.to);
    for (const m of t.messages) {
      if (m.author.kind === "agent" && m.author.name) names.add(m.author.name);
      if (m.mention) names.add(m.mention);
    }
  }
  return [...names];
}

export type Place = "document" | "text" | "detached";

/** Where a comment belongs: on the whole document, on text the editor found, or on text that has changed. */
function placeOf(thread: Thread, found: boolean): Place {
  if (!thread.anchor) return "document";
  return found ? "text" : "detached";
}

/**
 * The panel's order (spec.md, Comments): comments on the whole document
 * first, then comments whose text can't be found, then comments on text in
 * the order their text appears. The panel and Find take it as it comes.
 * `positionOf` gives where the editor found a comment's text, or null.
 */
export function orderThreads(threads: Thread[], positionOf: (id: string) => number | null): Thread[] {
  const created = (t: Thread) => t.messages[0]?.created ?? "";
  const rank = { document: 0, detached: 1, text: 2 } as const;
  const keyed = threads.map((t, i) => {
    const pos = positionOf(t.id);
    return { t, i, place: placeOf(t, pos !== null), pos: pos ?? 0 };
  });
  keyed.sort(
    (a, b) =>
      rank[a.place] - rank[b.place] ||
      (a.place === "text" ? a.pos - b.pos : 0) ||
      created(a.t).localeCompare(created(b.t)) ||
      a.i - b.i,
  );
  return keyed.map((k) => k.t);
}

/** Every agent's name on a document: authors in the order they first appear, then the agents connected. */
export function agentNames(threads: Thread[], agents: AgentInfo[]): string[] {
  const names: string[] = [];
  for (const t of threads) {
    for (const m of t.messages) if (m.author.kind === "agent" && !names.includes(m.author.name)) names.push(m.author.name);
  }
  for (const a of agents) if (!names.includes(a.name)) names.push(a.name);
  return names;
}

/** The status bar's button: "3 comments", or "2 resolved" when none are open, or nothing. */
export function countLabel(open: number, resolved: number): string {
  if (open > 0) return `${open} ${open === 1 ? "comment" : "comments"}`;
  if (resolved > 0) return `${resolved} resolved`;
  return "";
}

/**
 * Whose turn an open comment is: "Waiting for you" once an agent has answered
 * (or changed its text since you last wrote). Otherwise whether it has reached
 * the agent it's for (roadmap Batch 2, item 1: never "Waiting for Claude"
 * before Claude knows): "For Claude, not sent yet", then "Sent to Claude", or,
 * sent while Claude was busy, when it will start. Nothing for a resolved comment.
 */
export function turnLabel(thread: Thread, agents: AgentInfo[], yours: boolean): string | null {
  if (thread.status !== "open" || !thread.messages.length) return null;
  if (yours) return "Waiting for you";
  const name = agentFor(thread, agents);
  if (!name) return notSentWords(null);
  const agent = agents.find((a) => a.name === name);
  if (agent && given(thread, agent)) return `Sent to ${name}`;
  if (agent?.sent) return agent.sent.after ? `Sent to ${name}: it will start when it has finished ${agent.sent.after}` : `Sent to ${name}`;
  if (agent?.editing) return `${name} will see it in this pass`;
  return notSentWords(name);
}

/** A comment for an agent that hasn't reached it: "For Claude, not sent yet", or "Not sent to an agent yet" when it's for none known (the start screen says the same). */
export function notSentWords(name: string | null): string {
  return name ? `For ${name}, not sent yet` : "Not sent to an agent yet";
}

/** The agent has been given everything on this comment so far. */
const given = (thread: Thread, agent: AgentInfo) => (agent.has?.[thread.id] ?? 0) >= thread.messages.length;

/**
 * The Comments panel's one button for handing the document back (roadmap
 * Batch 2, item 1): Send to an agent waiting for the review, when something
 * waits for it ("listening": it waits, but there's nothing to send yet;
 * "sent": sent while it was busy); else Copy for the agent the comments are
 * for, to paste in its chat. Nothing while an agent edits, or when nothing
 * waits for an agent and none is listening. `yours`: the comment waits for
 * the person.
 */
export type HandBack =
  | { kind: "send"; agent: string; comments: number }
  | { kind: "listening"; agent: string }
  | { kind: "sent"; agent: string; after: string | null }
  | { kind: "copy"; agent: string; comments: number }
  | null;

export function handBackFor(threads: Thread[], agents: AgentInfo[], yours: (thread: Thread) => boolean): HandBack {
  if (agents.some((a) => a.editing)) return null;
  // Comments for each agent that it hasn't been given yet ("" for no agent known).
  const notSent = new Map<string, number>();
  for (const t of threads) {
    if (t.status !== "open" || !t.messages.length || yours(t)) continue;
    const name = agentFor(t, agents) ?? "";
    const agent = agents.find((a) => a.name === name);
    if (agent && (given(t, agent) || agent.sent)) continue;
    notSent.set(name, (notSent.get(name) ?? 0) + 1);
  }
  const listening = agents.filter((a) => a.listening);
  const ready = listening.filter((a) => notSent.has(a.name));
  const to = ready.find((a) => a.isDefault) ?? ready[0];
  if (to) return { kind: "send", agent: to.name, comments: notSent.get(to.name)! };
  const sent = listening.find((a) => a.sent);
  if (sent) return { kind: "sent", agent: sent.name, after: sent.sent!.after };
  const [name, comments] = [...notSent].sort((a, b) => b[1] - a[1])[0] ?? [];
  if (name !== undefined) return { kind: "copy", agent: name || "Claude", comments };
  return listening.length ? { kind: "listening", agent: listening[0].name } : null;
}

/**
 * The agent a comment is for: the one named, the one that started it, the
 * one that picked it up (a comment with no @ goes to the first agent to pick
 * it up since the person wrote on it: roadmap Batch 3, item 3), or the agent
 * it would go to next.
 */
export function agentFor(thread: Thread, agents: AgentInfo[]): string | null {
  if (thread.to && thread.to !== "person") return thread.to;
  if (thread.to === "person") {
    // Started by a chat a new one has taken the name from: still that chat's (roadmap Batch 6, B3-R10).
    const renamed = agents.find((a) => a.started?.includes(thread.id));
    if (renamed) return renamed.name;
    const starter = thread.messages[0]?.author;
    if (starter?.kind === "agent") return starter.name;
  }
  const picked = agents.find((a) => given(thread, a));
  if (picked) return picked.name;
  return (agents.find((a) => a.isDefault) ?? (agents.length === 1 ? agents[0] : undefined))?.name ?? null;
}

/** What an agent's pass did, as the window hears it when the pass ends (PassSummary in agents/shapes.ts, through the preload). */
export type PassDone = PassSummary;

/** "Claude", "Claude and Writer", "Claude, Codex and Writer". */
export function namesList(names: string[]): string {
  if (names.length <= 1) return names[0] ?? "";
  return `${names.slice(0, -1).join(", ")} and ${names[names.length - 1]}`;
}

/**
 * What waits for the person in the Comments panel, by kind of card. The panel
 * holds comments only (roadmap Batch 9, item 5): changes made for a request
 * in an agent's chat, or for no comment, are no card, so nothing counts them.
 */
export interface Waiting {
  /** Comments an agent has answered, or changed text for since the person last wrote. */
  comments: number;
  /** Agents' notes about their passes (roadmap Batch 2, item 3). */
  notes?: number;
}

/**
 * The status line when agents finish (Orlando, 2026-11-09: "a status update
 * at the top saying the agent is done and document is back to you"), kept
 * short: who is done, then what waits in the Comments panel, for example
 * "Claude is done. Back to you." and "3 comments to read." `passes` are the
 * passes it tells of, oldest first, one per agent.
 */
export function doneWords(passes: PassDone[], waiting: Waiting): { lead: string; detail: string } {
  const last = passes[passes.length - 1];
  if (!last) return { lead: "", detail: "" };
  if (last.nothingFor) {
    // An empty round explains itself (roadmap Batch 3, item 3): "Claude 2 found nothing addressed to it. 2 comments are waiting for Claude."
    const nothing = `${last.agent} found nothing addressed to it.`;
    const words = [nothingWords(last.nothingFor), toRead(waiting)];
    // After another agent's pass in the same round, that agent's done still leads (B3-R12).
    const earlier = passes.slice(0, -1).filter((p) => !p.nothingFor);
    if (earlier.length) return { lead: doneLead(earlier), detail: [nothing, ...words].filter(Boolean).join(" ") };
    return { lead: nothing, detail: words.filter(Boolean).join(" ") };
  }
  return { lead: doneLead(passes), detail: toRead(waiting) };
}

/**
 * The passes the line tells of changed text no comment asked for (for a
 * request made in the chat, or nothing): no card shows those, so the line
 * says the document changed, with "Show changes" to show it (roadmap
 * Batch 9, item 5: "Nothing slips past" without a card).
 */
export function changedBeyondComments(passes: PassDone[]): boolean {
  return passes.some((p) => p.other && !p.nothingFor);
}

/** "Claude is done. Back to you.", or who else finished the round and how. */
function doneLead(passes: PassDone[]): string {
  const last = passes[passes.length - 1];
  const names = [...new Set(passes.map((p) => p.agent))];
  let lead: string;
  if (names.length > 1) lead = `${namesList(names)} are done. Back to you.`;
  else if (last.endedBy === "person") lead = `You took over from ${last.agent}.`;
  else if (last.endedBy === "session-ended") lead = `${last.agent}'s session ended. Back to you.`;
  else lead = `${last.agent} is done. Back to you.`;
  return lead;
}

/**
 * Whom the comments a round didn't find are for: "2 comments are waiting for
 * Claude." once that agent has them, "1 comment is for Claude." before.
 */
export function nothingWords({ comments, agents, given }: NonNullable<PassDone["nothingFor"]>): string {
  const count = `${comments} ${comments === 1 ? "comment is" : "comments are"}`;
  return `${count} ${given ? "waiting for" : "for"} ${namesList(agents)}.`;
}

/** "3 comments to read.", "6 comments and a note to read.", or nothing. */
export function toRead(waiting: Waiting): string {
  const parts = waitingParts(waiting);
  if (!parts) return "";
  const words = `${parts} to read.`;
  return words[0].toUpperCase() + words.slice(1);
}

/** What waits for the person, by kind of card: "3 comments and a note", or "" for nothing (the start screen counts the same). */
export function waitingParts({ comments, notes = 0 }: Waiting): string {
  const parts: string[] = [];
  if (comments > 0) parts.push(`${comments} ${comments === 1 ? "comment" : "comments"}`);
  if (notes === 1) parts.push("a note");
  else if (notes > 1) parts.push(`${notes} notes`);
  return namesList(parts);
}
