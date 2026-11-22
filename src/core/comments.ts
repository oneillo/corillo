// Comments and their rules. The person is the hub: agents reply and add
// comments, but never edit, delete or resolve; only the person resolves.
import type { Anchor } from "./anchors";
import type { ChangeSpan, ThreadChange } from "./change-links";
import { choicesOf, type Choice, type OptionEdit, type ReplyOption } from "./options";

export type Author = { kind: "person" } | { kind: "agent"; name: string };

export interface Message {
  id: string;
  author: Author;
  body: string;
  created: string;
  edited?: string;
  /**
   * The agent the person named with @ in this message (its first tag), which
   * directed the comment at that agent. Only the person's messages have one.
   */
  mention?: string;
  /**
   * Versions an agent offered with its reply, for the person to apply with a
   * click (roadmap Batch 3, item 2): checked and capped in options.ts. Only
   * agents' messages have them; an older record has none.
   */
  options?: ReplyOption[];
  /** The options the person applied, one record each, the latest (see options.ts). */
  choices?: Choice[];
}

export interface Thread {
  id: string;
  /** Null for a comment on the whole document. */
  anchor: Anchor | null;
  /** The text could no longer be found after the document changed. */
  detached?: boolean;
  /**
   * Where the comment's text was, when it was deleted entirely: an anchor with
   * an empty quote (its words before and after). The editor keeps an empty line
   * there, on screen only, until the comment is resolved.
   */
  gap?: Anchor;
  /**
   * Who should answer. For the person's comments: an agent's name, or null
   * for the document's default agent. Agents' comments are always to the person.
   */
  to: string | null;
  status: "open" | "resolved";
  resolved?: string;
  messages: Message[];
  /** The text an agent's latest round changed for this comment (see change-links.ts). */
  change?: ThreadChange;
}

/**
 * A note an agent left when it handed the document back (roadmap Batch 2,
 * item 3): what the person should know or decide about its pass that doesn't
 * belong on one comment. It waits at the top of the Comments panel until the
 * person marks it done; History keeps it with the pass's version.
 */
export interface PassNote {
  id: string;
  agent: string;
  text: string;
  /** When the pass ended (ISO date). */
  at: string;
}

export class CommentError extends Error {}

const now = () => new Date().toISOString();

export function newId(): string {
  return globalThis.crypto.randomUUID();
}

function find(threads: Thread[], threadId: string): Thread {
  const t = threads.find((x) => x.id === threadId);
  if (!t) throw new CommentError("That comment no longer exists.");
  return t;
}

const isPerson = (a: Author) => a.kind === "person";

/** A message's @ tag, kept only for the person's messages that have one. */
function tagged(message: Message, author: Author, mention: string | null | undefined): Message {
  const name = isPerson(author) ? mention?.trim() : undefined;
  if (name) return { ...message, mention: name };
  const { mention: _gone, ...rest } = message;
  return rest;
}

/**
 * Whom a comment is for, from the @ tags in it: the agent named in the
 * person's latest message that names one. Without any, the agent that started
 * it answers its own comment ("person": it's addressed to the person), and the
 * person's comments go to the document's default agent (null).
 */
export function directionOf(thread: Pick<Thread, "messages">): string | null {
  for (let i = thread.messages.length - 1; i >= 0; i--) {
    const m = thread.messages[i];
    if (isPerson(m.author) && m.mention) return m.mention;
  }
  return thread.messages[0]?.author.kind === "agent" ? "person" : null;
}

const hasTags = (messages: Message[]) => messages.some((m) => m.mention);

/**
 * A comment whose messages changed: where a tag was added, changed or taken
 * away, it's for whomever the tags now say. A comment with no tag before or
 * after keeps whom it was for.
 */
function redirected(before: Thread, messages: Message[]): Thread {
  if (!hasTags(before.messages) && !hasTags(messages)) return { ...before, messages };
  return { ...before, messages, to: directionOf({ messages }) };
}

/**
 * A new comment. The person's comment is for `to`, or for the agent `mention`
 * names when they tagged one with @. An agent's comment is always for the person.
 */
export function addThread(
  threads: Thread[],
  author: Author,
  body: string,
  anchor: Anchor | null,
  to: string | null,
  mention?: string | null,
): { threads: Thread[]; thread: Thread } {
  if (!body.trim()) throw new CommentError("A comment needs some text.");
  const message = tagged({ id: newId(), author, body: body.trim(), created: now() }, author, mention);
  const thread: Thread = {
    id: newId(),
    anchor,
    to: isPerson(author) ? (message.mention ?? to) : "person",
    status: "open",
    messages: [message],
  };
  return { threads: [...threads, thread], thread };
}

/**
 * A reply. The person naming an agent with @ hands the comment to that agent.
 * An agent's reply may offer options (already checked: see options.ts).
 */
export function reply(
  threads: Thread[],
  threadId: string,
  author: Author,
  body: string,
  mention?: string | null,
  options?: ReplyOption[],
): Thread[] {
  if (!body.trim()) throw new CommentError("A reply needs some text.");
  if (options?.length && isPerson(author)) throw new CommentError("Only an agent's reply has options.");
  const t = find(threads, threadId);
  let message = tagged({ id: newId(), author, body: body.trim(), created: now() }, author, mention);
  if (options?.length) message = { ...message, options };
  const next = message.mention ? redirected(t, [...t.messages, message]) : { ...t, messages: [...t.messages, message] };
  return threads.map((x) => (x === t ? next : x));
}

/**
 * Only the person edits, and only their own words. `mention` is the agent the
 * new words name with @ (null for none); left out, the message's tag stays.
 */
export function editMessage(
  threads: Thread[],
  threadId: string,
  messageId: string,
  author: Author,
  body: string,
  mention?: string | null,
): Thread[] {
  if (!isPerson(author)) throw new CommentError("Agents can't edit comments.");
  if (!body.trim()) throw new CommentError("A comment needs some text.");
  const t = find(threads, threadId);
  const m = t.messages.find((x) => x.id === messageId);
  if (!m) throw new CommentError("That comment no longer exists.");
  if (!isPerson(m.author)) throw new CommentError("You can only edit your own comments.");
  let edited: Message = { ...m, body: body.trim(), edited: now() };
  if (mention !== undefined) edited = tagged(edited, author, mention);
  const messages = t.messages.map((y) => (y === m ? edited : y));
  const next = (m.mention ?? null) === (edited.mention ?? null) ? { ...t, messages } : redirected(t, messages);
  return threads.map((x) => (x === t ? next : x));
}

/** Deleting the first message deletes the whole comment; otherwise just that reply (and whom it handed the comment to). */
export function deleteMessage(threads: Thread[], threadId: string, messageId: string, author: Author): Thread[] {
  if (!isPerson(author)) throw new CommentError("Agents can't delete comments.");
  const t = find(threads, threadId);
  const index = t.messages.findIndex((x) => x.id === messageId);
  if (index < 0) throw new CommentError("That comment no longer exists.");
  if (!isPerson(t.messages[index].author)) throw new CommentError("You can only delete your own comments.");
  if (index === 0) return threads.filter((x) => x !== t);
  const messages = t.messages.filter((_, i) => i !== index);
  const next = t.messages[index].mention ? redirected(t, messages) : { ...t, messages };
  return threads.map((x) => (x === t ? next : x));
}

/**
 * The person applied one of the options on an agent's reply: the reply
 * records it, with how to take it back out (`undo`, see options.ts) and the
 * text it changed (`spans`). It's kept beside the agent's own change for the
 * comment, not in its place, since Undo can take the choice back out (review
 * of Batch 3, B3-R04); whether it's in the text is worked out from the text
 * (`standing`). Whose turn it is stays a matter of the messages. The comment
 * stays open until the person resolves it.
 */
export function chooseOption(
  threads: Thread[],
  threadId: string,
  messageId: string,
  author: Author,
  option: number,
  spans: ChangeSpan[],
  undo: OptionEdit[] = [],
): Thread[] {
  if (!isPerson(author)) throw new CommentError("Only you choose between an agent's options.");
  const t = find(threads, threadId);
  const m = t.messages.find((x) => x.id === messageId);
  if (!m || m.author.kind !== "agent" || !Number.isInteger(option) || option < 0 || option >= (m.options?.length ?? 0)) {
    throw new CommentError("That option is no longer offered.");
  }
  if (t.status !== "open") throw new CommentError("That comment is resolved. Reopen it to choose.");
  const at = now();
  const choice: Choice = { option, at, undo, spans };
  const messages = t.messages.map((x) => (x === m ? { ...x, choices: [...choicesOf(x).filter((c) => c.option !== option), choice] } : x));
  return threads.map((x) => (x === t ? { ...t, messages } : x));
}

export function setResolved(threads: Thread[], threadId: string, author: Author, resolved: boolean): Thread[] {
  if (!isPerson(author)) throw new CommentError("Only you can resolve a comment.");
  const t = find(threads, threadId);
  const next: Thread = resolved
    ? { ...t, status: "resolved", resolved: now() }
    : { ...t, status: "open", resolved: undefined };
  return threads.map((x) => (x === t ? next : x));
}

/** Where a comment is now: its text, "detached" when it can't be found, or the place its deleted text was. */
export type AnchorUpdate = Anchor | "detached" | { gap: Anchor };

/** The editor's latest idea of where each comment is. */
export function setAnchors(threads: Thread[], anchors: Record<string, AnchorUpdate>): Thread[] {
  return threads.map((t) => {
    const a = anchors[t.id];
    if (a === undefined || a === null || t.anchor === null) return t;
    if (a === "detached") return t.detached ? t : { ...t, detached: true };
    if ("gap" in a) return { ...t, detached: true, gap: a.gap };
    return { ...t, anchor: a, detached: undefined, gap: undefined };
  });
}

// The person's turn, and Review ----------------------------------------------------------

/**
 * Open, and waiting for the person: an agent spoke last, or an agent changed
 * text for it after the person's last word.
 */
export function waitingForPerson(thread: Thread): boolean {
  if (thread.status !== "open") return false;
  const last = thread.messages[thread.messages.length - 1];
  if (!last) return false;
  if (last.author.kind === "agent") return true;
  return !!thread.change?.spans.length && thread.change.at > last.created;
}
