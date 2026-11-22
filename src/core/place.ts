// Finding your place in Markdown text. Two uses:
// - In a table shown as Markdown text (in the formatted view, or in the
//   Markdown view), which cell and row the cursor is in, so they can be
//   highlighted. A big table as text is hard to read otherwise.
// - Switching between the formatted and Markdown views keeps the cursor on
//   the same words: in a table, in the same cell.
// All offsets here are in the text as the Markdown view shows it (lines end
// with "\n" only, no byte-order mark).
import type { Node } from "prosemirror-model";
import { TableMap } from "prosemirror-tables";
import { offsetAt, posAt, textIndex } from "./anchors";
import { serializeMarkdown, type Source } from "./markdown";
import { inlineText, PICTURE_STAND_IN } from "./doc-diff";

/** Where the cursor is in a table written as Markdown text. */
export interface TableSpot {
  /** The row's whole line. */
  lineFrom: number;
  lineTo: number;
  /** The cell around the cursor, between its pipes (its spaces included). */
  cellFrom: number;
  cellTo: number;
  /** Which line of the table (0 is the header row, 1 the row of dashes) and which cell in it. */
  line: number;
  cell: number;
}

const DELIMITER_ROW = /^[ \t>]*\|?[ \t]*:?-+:?[ \t]*(?:\|[ \t]*:?-+:?[ \t]*)*\|?[ \t]*$/;
// Quote and list markers (and indentation) before a table row.
const ROW_PREFIX = /^(?:[ \t]*(?:>|[-+*](?=[ \t])|\d{1,9}[.)](?=[ \t])))*[ \t]*/;
// How far up to look for a table's first line.
const MAX_LINES = 20000;

/**
 * The places that separate one line's cells: its pipes (not "\|"), and the
 * line's ends where it has no pipe. Cell i is between bounds[i] and bounds[i + 1].
 */
export function cellBounds(line: string): number[] {
  const start = ROW_PREFIX.exec(line)![0].length;
  let end = line.length;
  while (end > start && /[ \t]/.test(line[end - 1])) end--;
  const bounds: number[] = [];
  for (let i = start; i < end; i++) if (line[i] === "|" && line[i - 1] !== "\\") bounds.push(i);
  if (bounds[0] !== start) bounds.unshift(start - 1);
  if (bounds[bounds.length - 1] !== end - 1 || bounds.length === 1) bounds.push(end);
  return bounds;
}

/** A cell's words in a line: between its pipes, without the spaces around them. */
export function cellContent(line: string, cell: number): { from: number; to: number } | null {
  const bounds = cellBounds(line);
  if (cell < 0 || cell >= bounds.length - 1) return null;
  let from = bounds[cell] + 1;
  let to = bounds[cell + 1];
  while (from < to && /[ \t]/.test(line[from])) from++;
  while (to > from && /[ \t]/.test(line[to - 1])) to--;
  return { from, to };
}

const lineAt = (text: string, start: number) => {
  const end = text.indexOf("\n", start);
  return text.slice(start, end < 0 ? text.length : end);
};

/** The table cell the offset is in, if it's in a table written as Markdown text. */
export function tableSpotAt(text: string, offset: number): TableSpot | null {
  const lineFrom = text.lastIndexOf("\n", offset - 1) + 1;
  let lineTo = text.indexOf("\n", offset);
  if (lineTo < 0) lineTo = text.length;
  const line = text.slice(lineFrom, lineTo);
  if (!line.includes("|")) return null;

  // The lines above that hold pipes, from the top down to this one.
  const run = [lineFrom];
  for (let start = lineFrom; start > 0 && run.length < MAX_LINES; ) {
    const before = text.lastIndexOf("\n", start - 2) + 1;
    const above = text.slice(before, start - 1);
    if (!above.includes("|") || !above.trim()) break;
    run.unshift(before);
    start = before;
  }
  // The table starts at the line before its first row of dashes; a line
  // holding a pipe just above the table is a paragraph's.
  let line0 = -1;
  for (let k = 1; k < run.length; k++) {
    if (DELIMITER_ROW.test(lineAt(text, run[k]))) {
      line0 = k - 1;
      break;
    }
  }
  let index: number;
  if (line0 >= 0) index = run.length - 1 - line0;
  else if (lineTo < text.length && DELIMITER_ROW.test(lineAt(text, lineTo + 1)) && !DELIMITER_ROW.test(line)) index = 0;
  else return null;

  const bounds = cellBounds(line);
  if (bounds.length < 2) return null;
  const at = offset - lineFrom;
  let cell = 0;
  while (cell < bounds.length - 2 && at > bounds[cell + 1]) cell++;
  return {
    lineFrom,
    lineTo,
    cellFrom: lineFrom + bounds[cell] + 1,
    cellTo: lineFrom + bounds[cell + 1],
    line: index,
    cell,
  };
}

// Matching what's shown with its Markdown ---------------------------------------------

// How far ahead a shown character may be in the Markdown (past a link's address, say).
const REACH = 400;

/**
 * For each character shown, where it is in the Markdown, or -1. Shown text
 * comes in the same order as its Markdown, which only adds signs (**, [, a
 * link's address, list markers), so each character is looked for a little
 * further on. Pictures and footnote markers (shown as one place) aren't matched.
 */
export function align(shown: string, markdown: string): Int32Array {
  const map = new Int32Array(shown.length).fill(-1);
  let s = 0;
  for (let v = 0; v < shown.length; v++) {
    const ch = shown[v];
    if (ch === PICTURE_STAND_IN) continue;
    const found = markdown.indexOf(ch === " " ? " " : ch, s);
    if (found < 0 || found - s > REACH) continue;
    map[v] = found;
    s = found + 1;
  }
  return map;
}

/** Where a cursor after `at` shown characters goes in the Markdown. */
export function markdownOffset(shown: string, markdown: string, at: number): number {
  const map = align(shown, markdown);
  for (let k = Math.min(at, shown.length) - 1; k >= 0; k--) if (map[k] >= 0) return map[k] + 1;
  // At the very start: just before the first word (after a heading's "# ", say).
  for (let k = 0; k < map.length; k++) if (map[k] >= 0) return map[k];
  return 0;
}

/** How many shown characters come before a place in the Markdown. */
export function shownOffset(shown: string, markdown: string, at: number): number {
  const map = align(shown, markdown);
  let best = 0;
  for (let k = 0; k < map.length; k++) {
    if (map[k] < 0) continue;
    if (map[k] < at) best = k + 1;
    else break;
  }
  return best;
}

// Between the formatted document and its Markdown text ---------------------------------

export interface Span {
  from: number;
  to: number;
}

/** Where each top-level block starts in the document. */
function blockStart(doc: Node, k: number): number {
  let pos = 0;
  for (let i = 0; i < k; i++) pos += doc.child(i).nodeSize;
  return pos;
}

const isFenced = (markdown: string) => /^[ \t]*(`{3,}|~{3,})/.test(markdown);

/** The Markdown text's offset for a position in the formatted document. */
export function markdownPlace(doc: Node, pos: number, text: string, spans: Span[]): number {
  if (!doc.childCount || !spans.length) return 0;
  const $pos = doc.resolve(Math.max(0, Math.min(pos, doc.content.size)));
  const k = Math.min($pos.index(0), doc.childCount - 1, spans.length - 1);
  const span = spans[k];
  if ($pos.depth === 0) return pos >= doc.content.size ? spans[spans.length - 1].to : span.from;
  const block = doc.child(k);
  const start = blockStart(doc, k);
  const markdown = text.slice(span.from, span.to);
  const inside = pos - start - 1;
  const clamp = (n: number) => span.from + Math.max(0, Math.min(n, markdown.length));

  if (block.type.name === "raw_block") return clamp(inside);
  if (block.type.name === "table") {
    if ($pos.depth < 3) return span.from;
    const map = TableMap.get(block);
    const cellPos = $pos.before(3);
    const rect = map.findCell(cellPos - start - 1);
    const line = rect.top === 0 ? 0 : rect.top + 1;
    const lines = markdown.split("\n");
    if (line >= lines.length) return span.from;
    const lineStart = lines.slice(0, line).reduce((n, l) => n + l.length + 1, 0);
    const content = cellContent(lines[line], rect.left);
    if (!content) return clamp(lineStart);
    const cellMarkdown = lines[line].slice(content.from, content.to);
    return clamp(lineStart + content.from + markdownOffset(inlineText($pos.parent), cellMarkdown, $pos.parentOffset));
  }
  if (block.type.spec.code && isFenced(markdown)) {
    const body = markdown.indexOf("\n") + 1;
    return body > 0 ? clamp(body + inside) : span.from;
  }
  if (block.isTextblock) return clamp(markdownOffset(inlineText(block), markdown, inside));
  const index = textIndex(block);
  return clamp(markdownOffset(index.text, markdown, offsetAt(index, inside)));
}

/** The formatted document's position for an offset in its Markdown text. */
export function docPlace(doc: Node, text: string, spans: Span[], offset: number): number {
  if (!doc.childCount || !spans.length) return 0;
  let k = spans.findIndex((s) => offset <= s.to);
  if (k < 0) return doc.content.size;
  k = Math.min(k, doc.childCount - 1);
  const span = spans[k];
  const block = doc.child(k);
  const start = blockStart(doc, k);
  const markdown = text.slice(span.from, span.to);
  const local = Math.max(0, offset - span.from);
  const into = (n: number) => start + 1 + Math.max(0, Math.min(n, block.content.size));

  if (block.type.name === "raw_block") return into(local);
  if (block.type.name === "table") {
    const map = TableMap.get(block);
    const spot = tableSpotAt(markdown, Math.min(local, markdown.length));
    const row = Math.min(spot && spot.line > 1 ? spot.line - 1 : 0, map.height - 1);
    const col = Math.min(spot?.cell ?? 0, map.width - 1);
    const cellPos = start + 1 + map.map[row * map.width + col];
    const cell = doc.nodeAt(cellPos)!;
    if (!spot) return cellPos + 1;
    const line = markdown.slice(spot.lineFrom, spot.lineTo);
    const content = cellContent(line, spot.cell);
    if (!content || spot.line === 1) return cellPos + 1;
    const within = Math.max(0, Math.min(local - spot.lineFrom - content.from, content.to - content.from));
    const at = shownOffset(inlineText(cell), line.slice(content.from, content.to), within);
    return cellPos + 1 + Math.min(at, cell.content.size);
  }
  if (block.type.spec.code && isFenced(markdown)) return into(local - (markdown.indexOf("\n") + 1));
  if (block.isTextblock) return into(shownOffset(inlineText(block), markdown, local));
  const index = textIndex(block);
  return start + 1 + posAt(index, shownOffset(index.text, markdown, local), "start");
}

/**
 * Words selected in the Markdown text, as a range in the formatted document,
 * for a comment. A table's row of dashes holds no words, so an end of the
 * selection there moves to the row next to it, inside the selection: a
 * selection of only that row is then empty.
 */
export function docRange(doc: Node, text: string, spans: Span[], start: number, end: number): { from: number; to: number } {
  const outOfDashes = (offset: number, forward: boolean) => {
    const lineFrom = text.lastIndexOf("\n", offset - 1) + 1;
    let lineTo = text.indexOf("\n", offset);
    if (lineTo < 0) lineTo = text.length;
    if (!DELIMITER_ROW.test(text.slice(lineFrom, lineTo))) return offset;
    const k = spans.findIndex((s) => offset <= s.to);
    if (k < 0 || k >= doc.childCount || doc.child(k).type.name !== "table") return offset;
    return forward ? Math.min(lineTo + 1, text.length) : Math.max(lineFrom - 1, 0);
  };
  const from = docPlace(doc, text, spans, outOfDashes(start, true));
  if (start === end) return { from, to: from };
  return { from, to: Math.max(from, docPlace(doc, text, spans, outOfDashes(end, false))) };
}

// Offsets in the file and in the Markdown view ---------------------------------------

/** Turns offsets in a file's text into offsets in the Markdown view's text (no "\r", no byte-order mark). */
export function viewOffsets(text: string): (offset: number) => number {
  const bom = text.startsWith("\uFEFF") ? 1 : 0;
  const crlf: number[] = [];
  for (let i = text.indexOf("\r\n"); i >= 0; i = text.indexOf("\r\n", i + 2)) crlf.push(i);
  return (offset) => {
    let lo = 0;
    let hi = crlf.length;
    while (lo < hi) {
      const mid = (lo + hi) >> 1;
      if (crlf[mid] + 1 < offset) lo = mid + 1;
      else hi = mid;
    }
    return Math.max(0, offset - lo - bom);
  };
}

/**
 * The document as Markdown, and where each of its blocks is in the Markdown
 * view's text. Works whether or not the document was edited since it was read.
 */
export function viewText(doc: Node, source: Source): { text: string; spans: Span[] } {
  const spans: Span[] = [];
  return inView(serializeMarkdown(doc, source, spans), spans);
}

/** A file's text and where each block is in it (as serializeMarkdown gives them), with the places in the Markdown view's text. */
export function inView(text: string, spans: readonly Span[]): { text: string; spans: Span[] } {
  const toView = viewOffsets(text);
  return { text, spans: spans.map((s) => ({ from: toView(s.from), to: toView(s.to) })) };
}
