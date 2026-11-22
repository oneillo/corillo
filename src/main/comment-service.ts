// Comments on documents: the rules in src/core/comments.ts, kept in Corillo's
// data folder (store.ts), and announced whenever they change so the window and
// connected agents see the same threads. Keyed by the document's store id.
import * as rules from "../core/comments";
import type { Anchor } from "../core/anchors";
import type { AnchorUpdate, Author, PassNote, Thread } from "../core/comments";
import { sameSpans, type ChangeSpan } from "../core/change-links";
import type { OptionEdit, ReplyOption } from "../core/options";
import type { DocumentStore } from "./store";

export type CommentResult<T> = { ok: true; value: T } | { ok: false; error: string };

/**
 * The most notes a document keeps waiting for the person: the newest. An
 * older one not yet marked done is still in History, with its version.
 */
export const NOTES_KEPT = 10;

/**
 * Where the editor now finds each comment's change, after the person's own
 * edits moved them. One entry per span, in order: null where the editor
 * didn't find it (kept as it was), false where the person deleted its words
 * (dropped). A report about an older round is ignored.
 */
export interface ChangeAnchorReport {
  threads: Record<string, { round: number; anchors: (Anchor | null | false)[] }>;
}

function withAnchors(spans: ChangeSpan[], anchors: (Anchor | null | false)[]): ChangeSpan[] {
  if (!Array.isArray(anchors) || anchors.length !== spans.length) return spans;
  const out: ChangeSpan[] = [];
  spans.forEach((s, i) => {
    const a = anchors[i];
    if (a === false) return;
    out.push(a ? { ...s, anchor: a } : s);
  });
  return out;
}

/**
 * The message the person deleted last, for Undo straight after (roadmap
 * Batch 9, item 4): the comment as it was, and where it was in the list.
 */
interface Deleted {
  storeId: string;
  thread: Thread;
  at: number;
  messageId: string;
}

export class CommentService {
  private cache = new Map<string, Thread[]>();
  private notesCache = new Map<string, PassNote[]>();
  /** Only the last delete, in any document: Undo can bring back nothing older. */
  private deleted: Deleted | null = null;

  constructor(
    private store: DocumentStore,
    private changed: (storeId: string, threads: Thread[]) => void,
    /** Agents' notes waiting for the person changed. */
    private notesChanged: (storeId: string, notes: PassNote[]) => void = () => {},
  ) {}

  threads(storeId: string): Thread[] {
    let threads = this.cache.get(storeId);
    if (!threads) {
      threads = this.store.readComments(storeId);
      this.cache.set(storeId, threads);
    }
    return threads;
  }

  /** The document closed: let go of its comments here (they're in the data folder, read again if it opens). */
  forget(storeId: string): void {
    this.cache.delete(storeId);
    this.notesCache.delete(storeId);
    if (this.deleted?.storeId === storeId) this.deleted = null;
  }

  /** How many documents' records are held in memory, for the leak checks. */
  sizes(): { threads: number; notes: number; deleted: number } {
    return { threads: this.cache.size, notes: this.notesCache.size, deleted: this.deleted ? 1 : 0 };
  }

  /** `announce` is false only when comments moved with the person's typing. */
  private commit(storeId: string, threads: Thread[], announce = true): void {
    this.cache.set(storeId, threads);
    this.store.writeComments(storeId, threads);
    if (announce) this.changed(storeId, threads);
  }

  /** A new comment; `mention` is the agent the person named with @, which directs it there. */
  add(storeId: string, author: Author, body: string, anchor: Anchor | null, to: string | null, mention?: string | null): Thread {
    const { threads, thread } = rules.addThread(this.threads(storeId), author, body, anchor, to, mention);
    this.commit(storeId, threads);
    return thread;
  }

  /** A reply; the person naming an agent with @ (`mention`) hands the comment to it. */
  reply(storeId: string, threadId: string, author: Author, body: string, mention?: string | null, options?: ReplyOption[]): Thread {
    const threads = rules.reply(this.threads(storeId), threadId, author, body, mention, options);
    this.commit(storeId, threads);
    return threads.find((t) => t.id === threadId)!;
  }

  edit(storeId: string, threadId: string, messageId: string, author: Author, body: string, mention?: string | null): void {
    this.commit(storeId, rules.editMessage(this.threads(storeId), threadId, messageId, author, body, mention));
  }

  /** Delete one of the person's messages; the first takes its comment with it. Kept until the next delete, for Undo. */
  remove(storeId: string, threadId: string, messageId: string, author: Author): void {
    const before = this.threads(storeId);
    const after = rules.deleteMessage(before, threadId, messageId, author);
    const at = before.findIndex((t) => t.id === threadId);
    this.deleted = { storeId, thread: before[at], at, messageId };
    this.commit(storeId, after);
  }

  /**
   * Undo straight after a delete: the message just deleted is back where it
   * was. A whole comment comes back as it was, in its place in the list; a
   * reply goes back among the messages, after the one it followed, keeping
   * anything added since, and the comment goes back to whom it was for if the
   * reply had handed it over. Only the very last delete, and only once.
   */
  restore(storeId: string, threadId: string, messageId: string, author: Author): void {
    if (author.kind !== "person") throw new rules.CommentError("Only you can bring back a comment you deleted.");
    const kept = this.deleted;
    if (!kept || kept.storeId !== storeId || kept.thread.id !== threadId || kept.messageId !== messageId) {
      throw new rules.CommentError("That comment can't be brought back now.");
    }
    this.deleted = null;
    const threads = this.threads(storeId);
    const now = threads.find((t) => t.id === threadId);
    if (!now) {
      const next = [...threads];
      next.splice(Math.min(kept.at, next.length), 0, kept.thread);
      this.commit(storeId, next);
      return;
    }
    if (now.messages.some((m) => m.id === messageId)) return;
    const index = kept.thread.messages.findIndex((m) => m.id === messageId);
    const message = kept.thread.messages[index];
    if (!message) return;
    const before = kept.thread.messages[index - 1]?.id;
    const messages = [...now.messages];
    const after = before ? messages.findIndex((m) => m.id === before) + 1 : 0;
    messages.splice(after > 0 || !before ? after : messages.length, 0, message);
    const restored = { ...now, messages, ...(message.mention ? { to: kept.thread.to } : {}) };
    this.commit(storeId, threads.map((t) => (t === now ? restored : t)));
  }

  /** The person applied an option on an agent's reply (roadmap Batch 3, item 2): recorded, with the text it changed. */
  choose(storeId: string, threadId: string, messageId: string, author: Author, option: number, spans: ChangeSpan[], undo: OptionEdit[]): void {
    this.commit(storeId, rules.chooseOption(this.threads(storeId), threadId, messageId, author, option, spans, undo));
  }

  resolve(storeId: string, threadId: string, author: Author, resolved: boolean): void {
    this.commit(storeId, rules.setResolved(this.threads(storeId), threadId, author, resolved));
  }

  // Agents' changes for comments (see core/change-links.ts). Changes tied to no
  // comment aren't kept here: they're the pass's, in History (roadmap Batch 9,
  // item 5). What an older Corillo kept of them (other-changes.json) is left
  // as it was, and nothing reads it.

  /** After an agent's edit: each comment's change, saved and announced if it moved. */
  updateChanges(storeId: string, update: (threads: Thread[]) => Thread[]): void {
    const before = this.threads(storeId);
    const next = update(before);
    if (next.length !== before.length || next.some((t, i) => t !== before[i])) this.commit(storeId, next);
  }

  // Agents' notes, left as they hand the document back (roadmap Batch 2, item 3) ----------

  /** The notes waiting for the person, oldest first. */
  notes(storeId: string): PassNote[] {
    if (!this.notesCache.has(storeId)) this.notesCache.set(storeId, this.store.readNotes(storeId));
    return this.notesCache.get(storeId)!;
  }

  private commitNotes(storeId: string, notes: PassNote[]): void {
    this.notesCache.set(storeId, notes);
    this.store.writeNotes(storeId, notes);
    this.notesChanged(storeId, notes);
  }

  /** An agent's note, waiting for the person; only the newest few are kept. */
  addNote(storeId: string, note: PassNote): void {
    this.commitNotes(storeId, [...this.notes(storeId), note].slice(-NOTES_KEPT));
  }

  /** The person marked a note done: it leaves the panel (History keeps it). */
  doneNote(storeId: string, id: string): void {
    const notes = this.notes(storeId);
    if (notes.some((n) => n.id === id)) this.commitNotes(storeId, notes.filter((n) => n.id !== id));
  }

  /** Where the editor now finds each change, after the person's edits. Not announced: the editor already knows. */
  setChangeAnchors(storeId: string, report: ChangeAnchorReport): void {
    const before = this.threads(storeId);
    const after = before.map((t) => {
      const r = report.threads?.[t.id];
      if (!r || !t.change || t.change.round !== r.round) return t;
      const spans = withAnchors(t.change.spans, r.anchors);
      return sameSpans(spans, t.change.spans) ? t : { ...t, change: { ...t.change, spans } };
    });
    if (after.some((t, i) => t !== before[i])) this.commit(storeId, after, false);
  }

  /** Where the editor now finds each comment. Not announced: the editor already knows. */
  setAnchors(storeId: string, anchors: Record<string, AnchorUpdate>): void {
    const before = this.threads(storeId);
    const after = rules.setAnchors(before, anchors);
    if (after.some((t, i) => t !== before[i])) this.commit(storeId, after, false);
  }
}

/** Run a comment action for the window, turning rule errors into plain messages. */
export function attempt<T>(action: () => T): CommentResult<T> {
  try {
    return { ok: true, value: action() };
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : String(err) };
  }
}
