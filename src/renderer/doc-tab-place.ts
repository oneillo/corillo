// Keeping the person's place through a change: the selection, an empty line and what they're reading, found again by their words.
import type { EditorState } from "prosemirror-state";
import type { EditorView } from "prosemirror-view";
import type { Node } from "prosemirror-model";
import { schema } from "../core/schema";
import { anchorFor, anchorIn, findAnchor, offsetAt, posAt, textIndex, type Anchor } from "../core/anchors";
import type { Changed, TextChange } from "../core/smallest-edit";
import { textEdit } from "../core/source-marks";
import { commentRanges, DRAFT } from "./comments";

const n = schema.nodes;

/** Scroll a page so a place in its text is in sight (in a table wider than the page, sideways too). */
export function revealIn(view: EditorView, scroller: HTMLElement, pos: number): void {
  let coords: { top: number; bottom: number; left: number; right: number };
  let at: globalThis.Node;
  try {
    coords = view.coordsAtPos(pos);
    at = view.domAtPos(pos).node;
  } catch {
    return;
  }
  const table = (at instanceof Element ? at : at.parentElement)?.closest("table");
  if (table && table.scrollWidth > table.clientWidth) {
    const box = table.getBoundingClientRect();
    if (coords.left < box.left + 24 || coords.right > box.right - 24) {
      table.scrollLeft += coords.left - box.left - box.width / 3;
      coords = view.coordsAtPos(pos);
    }
  }
  const seen = scroller.getBoundingClientRect();
  if (coords.top < seen.top + 24 || coords.bottom > seen.bottom - 24) {
    scroller.scrollTop += coords.top - seen.top - seen.height / 3;
  }
}

/**
 * Where the selection is, as words that can be found again (a cursor is kept
 * by the words just before it), and where it starts in the document's text
 * (`at`, in `text`), for when those words are gone.
 */
export function selectionPlace(state: EditorState): { anchor: Anchor; cursor: boolean; at: number; text: string; emptyLine?: EmptyLine } | null {
  const { from, to, empty } = state.selection;
  const index = textIndex(state.doc);
  const at = offsetAt(index, from);
  if (!empty) return { anchor: anchorFor(state.doc, from, to, index), cursor: false, at, text: index.text };
  const emptyLine = emptyLineAt(state, index);
  if (at === 0 && !emptyLine) return null;
  return { anchor: anchorFor(state.doc, posAt(index, Math.max(0, at - 24), "start"), from, index), cursor: true, at, text: index.text, emptyLine };
}

/**
 * An empty line (an empty paragraph of the document) has no words to be found
 * again by. It's kept by the blocks either side of the empty lines it's among:
 * the words of the block just before them and how many lines down from it it
 * is, and the same from the block just after them, going up; at the start of
 * the document, how many lines down from the top it is. Each block's own
 * words only, from line break to line break of the document's text: words
 * of the blocks beyond would make a change there (a paragraph put in above)
 * look like a change to the block itself, and a place is never found
 * stretched over more paragraphs than it had (see anchors.ts).
 */
interface EmptyLine {
  top: number | null;
  above: { words: Anchor; lines: number } | null;
  below: { words: Anchor; lines: number } | null;
}

const isEmptyParagraph = (node: Node | null | undefined) => !!node && node.type === n.paragraph && node.childCount === 0;

/** The words of the block in a document's text that ends at offset `at` ("ending") or starts there ("starting"). */
function blockWords(index: ReturnType<typeof textIndex>, at: number, side: "ending" | "starting"): Anchor {
  const { text } = index;
  if (side === "ending") return anchorIn(text, text.lastIndexOf("\n", at - 1) + 1, at);
  const end = text.indexOf("\n", at);
  return anchorIn(text, at, end < 0 ? text.length : end);
}

/** The empty line the cursor is on, if it is. */
function emptyLineAt(state: EditorState, index: ReturnType<typeof textIndex>): EmptyLine | undefined {
  const { $from } = state.selection;
  if ($from.depth !== 1 || !isEmptyParagraph($from.parent)) return undefined;
  const doc = state.doc;
  const line = $from.index(0);
  let first = line;
  while (first > 0 && isEmptyParagraph(doc.child(first - 1))) first--;
  let last = line;
  while (last + 1 < doc.childCount && isEmptyParagraph(doc.child(last + 1))) last++;
  // Where the empty lines start and end in the document (each takes two places), and the words either side.
  const start = $from.before(1) - 2 * (line - first);
  const end = $from.after(1) + 2 * (last - line);
  let before = -1;
  let after = -1;
  for (const run of index.runs) {
    if (run.pos + run.length <= start) before = run.offset + run.length;
    else if (run.pos >= end) {
      after = run.offset;
      break;
    }
  }
  // (If those words aren't in the block right next to the empty lines, a rule say, they're not found again from that side.)
  return {
    top: first === 0 ? line + 1 : null,
    above: first > 0 && before > 0 ? { words: blockWords(index, before, "ending"), lines: line - first + 1 } : null,
    below: after >= 0 ? { words: blockWords(index, after, "starting"), lines: last - line + 1 } : null,
  };
}

/**
 * Where that empty line is in a document now: the inside of the empty
 * paragraph, or null if it isn't there. Counted from the top, if it was at the
 * top and still is; else from the block that was just before it; else from
 * the one just after it.
 */
export function emptyLineIn(doc: Node, kept: EmptyLine, index: ReturnType<typeof textIndex>): number | null {
  // The empty line `lines` blocks down (or up) from block `from`, if it and the blocks between are all empty lines.
  const counted = (from: number, lines: number, step: 1 | -1): number | null => {
    const line = from + step * lines;
    if (line < 0 || line >= doc.childCount) return null;
    for (let i = from + step; i !== line + step; i += step) if (!isEmptyParagraph(doc.child(i))) return null;
    let pos = 0;
    for (let i = 0; i < line; i++) pos += doc.child(i).nodeSize;
    return pos + 1;
  };
  // The block of the document holding those words now.
  const block = (words: Anchor, side: "end" | "start"): number | null => {
    const found = findAnchor(doc, words, index);
    if (!found) return null;
    const $at = doc.resolve(side === "end" ? found.to : found.from);
    return $at.depth < 1 ? null : $at.index(0);
  };
  const fromTop = kept.top === null ? null : counted(-1, kept.top, 1);
  if (fromTop !== null) return fromTop;
  const above = kept.above && block(kept.above.words, "end");
  const fromAbove = kept.above && above !== null ? counted(above, kept.above.lines, 1) : null;
  if (fromAbove !== null) return fromAbove;
  const below = kept.below && block(kept.below.words, "start");
  return kept.below && below !== null ? counted(below, kept.below.lines, -1) : null;
}

/** Where the comment being written is, in the document's text (see textIndex), if it's on words. */
export function draftPlace(state: EditorState): { text: string; from: number; to: number } | null {
  const range = commentRanges(state).ranges.get(DRAFT);
  if (!range) return null;
  const index = textIndex(state.doc);
  return { text: index.text, from: offsetAt(index, range.from), to: offsetAt(index, range.to) };
}

/**
 * Where a place in a text is in a new version of it: the same place outside
 * what changed (moved along by what was put in or taken out before it), and
 * inside what changed as near where it was as the new text allows.
 */
export function mapOffset(before: string, after: string, at: number): number {
  const shorter = Math.min(before.length, after.length);
  let start = 0;
  while (start < shorter && before.charCodeAt(start) === after.charCodeAt(start)) start++;
  if (at <= start) return at;
  let end = 0;
  while (end < shorter - start && before.charCodeAt(before.length - 1 - end) === after.charCodeAt(after.length - 1 - end)) end++;
  if (at >= before.length - end) return at + after.length - before.length;
  return inLineReplacing(before, after, at, start, end) ?? Math.max(start, Math.min(at, after.length - end));
}

/** A line's longer words, lower-cased: what a rewritten paragraph usually keeps, and a new one rarely shares. */
const longWords = (line: string) => line.toLowerCase().match(/[\p{L}\p{N}]{5,}/gu) ?? [];

/**
 * Inside what changed (from `start` to `end` from the end of `before`), the
 * place goes into the line that took the place of its own line (a paragraph
 * is a line here): line for line when as many lines changed as there were, or
 * else the line sharing most of its longer words, or, with none shared, the
 * one as far from the end of what changed. So when an agent rewrites the
 * paragraph the cursor is in and adds one beside it, the cursor stays in the
 * rewritten one, never mid-sentence in the new one. Null when only a part of
 * one line changed.
 */
function inLineReplacing(before: string, after: string, at: number, start: number, end: number): number | null {
  // The whole lines that changed: what's before and after them is the same in both texts.
  const from = before.lastIndexOf("\n", start - 1) + 1;
  const lineEnd = before.indexOf("\n", before.length - end);
  const to = lineEnd < 0 ? before.length : lineEnd;
  const old = before.slice(from, to).split("\n");
  const now = after.slice(from, to + after.length - before.length).split("\n");
  if (old.length === 1 && now.length === 1) return null;
  const starts = (lines: string[]) => {
    let next = from;
    return lines.map((line) => (next += line.length + 1) - line.length - 1);
  };
  const oldStarts = starts(old);
  const newStarts = starts(now);
  let k = old.length - 1;
  while (k > 0 && oldStarts[k] > at) k--;
  let line = k;
  if (old.length !== now.length) {
    const own = new Set(longWords(old[k]));
    let best = 0;
    line = Math.max(0, now.length - (old.length - k));
    now.forEach((text, i) => {
      const shared = own.size ? longWords(text).filter((w) => own.has(w)).length : 0;
      if (shared > best) [best, line] = [shared, i];
    });
    // Not an empty line (a blank line of the Markdown text) when there are words nearby.
    for (let step = 1; !now[line] && step < now.length; step++) {
      if (now[line - step]) line -= step;
      else if (now[line + step]) line += step;
    }
  }
  return newStarts[line] + mapOffset(old[k], now[line], at - oldStarts[k]);
}

/** What the person is reading on a page: the first few blocks in sight, each with where it is and how far its top is from the top of the window. */
export interface InSight {
  scroll: number;
  blocks: { anchor: Anchor; top: number; from: number; to: number }[];
}

export function whatsInSight(view: EditorView, scroller: HTMLElement): InSight | null {
  const scroll = scroller.scrollTop;
  // At the very top the top stays in sight, whatever comes in above (as the browser's own scroll anchoring does).
  if (scroll <= 0 || !scroller.checkVisibility()) return null;
  const blocks: InSight["blocks"] = [];
  try {
    const box = scroller.getBoundingClientRect();
    const page = view.dom.getBoundingClientRect();
    const found = view.posAtCoords({ left: page.left + Math.min(48, page.width / 2), top: Math.max(box.top, page.top) + 2 });
    if (!found) return { scroll, blocks };
    const doc = view.state.doc;
    const index = textIndex(doc);
    let done = false;
    doc.nodesBetween(found.pos, doc.content.size, (node, pos) => {
      if (done) return false;
      if (!node.isTextblock) return true;
      if (!node.content.size) return false; // an empty line has no words to find it by
      const start = pos + 1;
      const top = view.coordsAtPos(start).top - box.top;
      if (top > box.height) done = true; // past the bottom of the window
      else blocks.push({ anchor: anchorFor(doc, start, Math.min(start + node.content.size, start + 40), index), top, from: pos, to: pos + node.nodeSize });
      done ||= blocks.length >= 3;
      return false;
    });
  } catch {
    // keeping the place is a convenience
  }
  return { scroll, blocks };
}

/**
 * Put the first block of those that were in sight that can still be found back where it was; if none can, the same distance down.
 * `through`: where a block is now, when a change didn't touch it (null when it did: then it's found by its words).
 */
export function returnTo(view: EditorView, scroller: HTMLElement, reading: InSight, through?: (from: number, to: number) => number | null): void {
  const doc = view.state.doc;
  let index: ReturnType<typeof textIndex> | null = null;
  for (const block of reading.blocks) {
    try {
      let from = through?.(block.from, block.to) ?? null;
      if (from === null) {
        index ??= textIndex(doc);
        const range = findAnchor(doc, block.anchor, index);
        if (!range) continue;
        from = range.from;
      } else from += 1; // (its first words, as found by them)
      scroller.scrollTop += view.coordsAtPos(from).top - scroller.getBoundingClientRect().top - block.top;
      return;
    } catch {
      // the next one
    }
  }
  scroller.scrollTop = reading.scroll;
}

/** Whether any of these changes reaches into from..to (its edges included). */
export const touches = (changes: readonly Changed[], from: number, to: number) => changes.some((c) => c.from <= to && c.to >= from);

/** A place in a text, through changes that didn't touch it (in the text as it was). */
export function shifted(changes: readonly TextChange[], at: number): number {
  let by = 0;
  for (const c of changes) if (c.to < at) by += c.insert.length - (c.to - c.from);
  return at + by;
}

/**
 * The start of the first line of a text after its last change, and of the
 * same line in the new text: everything from there on is the same in both.
 * Null if the last line changed, or nothing did.
 */
export function sameFrom(before: string, after: string): { before: number; after: number } | null {
  if (before === after) return null;
  const shorter = Math.min(before.length, after.length);
  let end = 0;
  while (end < shorter && before.charCodeAt(before.length - 1 - end) === after.charCodeAt(after.length - 1 - end)) end++;
  // The first line break in what's the same at the end; the line after it is the same in both.
  const at = before.indexOf("\n", before.length - end);
  if (at < 0) return null;
  return { before: at + 1, after: at + 1 + after.length - before.length };
}

/**
 * How far a comment being written moves when the text goes from `before` to
 * `after`, its words at `from` to `to` in `before`: not at all when the change
 * was all after them, by what was put in or taken out when it was all before
 * them. Null when the change touched its words (they're found again by
 * searching) or nothing changed.
 */
export function draftMoves(before: string, after: string, from: number, to: number): number | null {
  const edit = textEdit(before, after);
  if (!edit) return null;
  if (to <= edit.from) return 0;
  if (from >= edit.oldTo) return after.length - before.length;
  return null;
}

/**
 * The Markdown view's text following a change made other than from the text,
 * from `was` to `shown`, while the text area holds `typed` (typing since `was`
 * not caught up yet): the change to make in the text area, moved past what was
 * typed before it. Null when nothing changed; "typed there" when the typing
 * was in the very place that changed (then the text wins: nothing follows).
 */
export function followText(was: string, shown: string, typed: string): { from: number; oldTo: number; newTo: number; insert: string } | null | "typed there" {
  const edit = textEdit(was, shown);
  const typing = textEdit(was, typed);
  if (edit && typing && typing.oldTo > edit.from && typing.from < edit.oldTo) return "typed there";
  if (!edit) return null;
  const by = typing && typing.oldTo <= edit.from ? typing.newTo - typing.oldTo : 0;
  return { from: edit.from + by, oldTo: edit.oldTo + by, newTo: edit.newTo + by, insert: shown.slice(edit.from, edit.newTo) };
}
