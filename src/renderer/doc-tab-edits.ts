// Turning an open document into new text as a transaction that changes only what differs, so comments keep their words.
import type { EditorState, Transaction } from "prosemirror-state";
import type { Fragment, Node } from "prosemirror-model";
import { schema } from "../core/schema";
import { parseMarkdown } from "../core/markdown";
import { parseCached } from "./parse-cache";

/**
 * The blocks that differ between two documents, replaced whole: the first
 * and last blocks the same in both stay as they are.
 */
export function replaceBlocks(state: EditorState, after: Node): Transaction {
  const before = state.doc;
  let first = 0;
  while (first < before.childCount && first < after.childCount && before.child(first).eq(after.child(first))) first++;
  let endBefore = before.childCount;
  let endAfter = after.childCount;
  while (endBefore > first && endAfter > first && before.child(endBefore - 1).eq(after.child(endAfter - 1))) {
    endBefore--;
    endAfter--;
  }
  const offset = (doc: Node, index: number) => {
    let pos = 0;
    for (let i = 0; i < index; i++) pos += doc.child(i).nodeSize;
    return pos;
  };
  return state.tr.replaceWith(offset(before, first), offset(before, endBefore), after.content.cut(offset(after, first), offset(after, endAfter)));
}

/**
 * The one stretch where two contents differ: from `from` to `toA` in the
 * first (which starts at `posA`), from `fromB` to `toB` in the second (at `posB`).
 */
function changedStretch(a: Fragment, b: Fragment, posA = 0, posB = 0): { from: number; toA: number; fromB: number; toB: number } | null {
  const from = a.findDiffStart(b, posA);
  if (from === null) return null;
  const fromB = from - posA + posB;
  let { a: toA, b: toB } = a.findDiffEnd(b, posA + a.size, posB + b.size)!;
  // Where the same words repeat, the two ends can cross: the change goes after the start.
  if (toA < from && a.size < b.size) {
    toB = fromB + (toB - toA);
    toA = from;
  } else if (toB < fromB) {
    toA = from + (toA - toB);
    toB = fromB;
  }
  return { from, toA, fromB, toB };
}

/** The start of the mark on a change read from the Markdown text or the file (markAsFromTheText). */
const FROM_THE_TEXT = "markdown-";

/**
 * Mark a change as read from the Markdown text or the file: nothing tidies it
 * (lists that touch, a note whose number went), and the text needn't follow
 * it. The mark is ProseMirror's `composition`, which its history also reads:
 * changes in one `group` (the Markdown view's typing) are one Undo step; one
 * with no group (from the file) joins none.
 */
export function markAsFromTheText(tr: Transaction, group?: number): Transaction {
  return tr.setMeta("composition", `${FROM_THE_TEXT}${group ?? "file"}`);
}

/** Whether a change was read from the Markdown text or the file (markAsFromTheText). */
export function fromTheText(tr: Transaction): boolean {
  return String(tr.getMeta("composition") ?? "").startsWith(FROM_THE_TEXT);
}

/**
 * The document changed only where it differs from `after`, so what's around
 * (comments' words, the cursor) is carried through, as when typing in it.
 * Not `exact` when that couldn't be done: the blocks that differ were replaced whole.
 * `tr` may already hold steps (see readAs); the change follows them.
 */
export function replaceChanged(state: EditorState, after: Node, tr = state.tr): { tr: Transaction; exact: boolean } {
  const stretch = changedStretch(tr.doc.content, after.content);
  if (!stretch) return { tr, exact: true };
  try {
    tr.replace(stretch.from, stretch.toA, after.slice(stretch.fromB, stretch.toB));
    if (tr.doc.eq(after)) return { tr, exact: true };
  } catch {
    // replaced whole, below
  }
  return { tr: replaceBlocks(state, after), exact: false };
}

/**
 * The document brought to `read`, each block that differs changed on its
 * own, so what's between two changes keeps its comments; a plain
 * transaction when that can't be done.
 */
export function readAs(state: EditorState, read: Node): Transaction {
  const doc = state.doc;
  const tr = state.tr;
  if (doc.childCount !== read.childCount) return tr;
  let endA = doc.content.size;
  let endB = read.content.size;
  try {
    // From the last block to the first, so the blocks still to do keep their places.
    for (let i = doc.childCount - 1; i >= 0; i--) {
      const a = doc.child(i);
      const b = read.child(i);
      const startA = endA - a.nodeSize;
      const startB = endB - b.nodeSize;
      const stretch = a.eq(b) ? null : changedStretch(a.content, b.content, startA + 1, startB + 1);
      if (stretch) tr.replace(stretch.from, stretch.toA, read.slice(stretch.fromB, stretch.toB));
      endA = startA;
      endB = startB;
    }
  } catch {
    return state.tr;
  }
  return tr.doc.eq(read) ? tr : state.tr;
}

/**
 * The document taken through each of these texts in turn, each a step that
 * changes only where it differs from the one before: what's between two
 * places changed keeps its comments and agents' change highlights. Null when
 * a text can't be reached that way.
 */
export function throughTexts(tr: Transaction, texts: readonly string[]): Transaction | null {
  try {
    texts.forEach((text, i) => {
      // The last is read through the cache, as the text the document now holds; the ones on the way aren't kept.
      const after = (i === texts.length - 1 ? parseCached(text) : parseMarkdown(text)).doc;
      const stretch = changedStretch(tr.doc.content, after.content);
      if (stretch) tr.replace(stretch.from, stretch.toA, after.slice(stretch.fromB, stretch.toB));
      if (!tr.doc.eq(after)) throw new Error("not reached");
    });
  } catch {
    return null;
  }
  return tr;
}

/** Replace All with more matches than this changes the Markdown view's document in one stretch (one step per match costs more). */
export const MATCHES_ONE_BY_ONE = 200;

/**
 * Replace All in the Markdown text, as the formatted view does it: each
 * match replaced on its own, so the words around each and between them keep
 * their comments. `places` are the matches in the document before `tr`'s
 * steps. Null when the result isn't `after` (new words that are Markdown's
 * signs, say).
 */
export function replaceMatches(tr: Transaction, places: readonly { from: number; to: number }[], replacement: string, after: Node): Transaction | null {
  try {
    const mapped = places.map((p) => ({ from: tr.mapping.map(p.from, 1), to: tr.mapping.map(p.to, -1) }));
    for (let i = mapped.length - 1; i >= 0; i--) {
      const { from, to } = mapped[i];
      if (!replacement) tr.delete(from, to);
      else tr.replaceWith(from, to, schema.text(replacement, tr.doc.nodeAt(from)?.marks));
    }
    return tr.doc.eq(after) ? tr : null;
  } catch {
    return null;
  }
}
