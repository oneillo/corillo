// Line numbers: the line of the Markdown file each part of the document starts
// on, counted the way an agent reading the file counts them, so "line 42"
// means the same to the person and the agent. The first line is 1, and a line
// ends at "\n" (a Windows "\r\n" counts once; a byte-order mark doesn't
// count). The file is the text Corillo writes for the document as it is now,
// unsaved edits included: what an agent reading it gets.
//
// Worked out from what markdown.ts already knows: unedited blocks keep their
// original text, so a block's lines are counted once and reused for as long
// as it stays unedited, and only edited blocks are looked at again.
import type { Node } from "prosemirror-model";
import { lineBreakLines, markdownLayout, markdownTokens, type MarkdownToken, type Source } from "./markdown";

/**
 * A number to show. On a block (a paragraph, heading, table row, rule or
 * diagram), from its start to its end; or at the place in a block's text where
 * a line starts (each line of code, a footnote's first line).
 *
 * Lines that have no words on the page (Orlando, 2026-11-09: "it's weird to
 * see missing line numbers"): a blank line between two blocks ("blank", at
 * the place between them, from = to); a code block's closing fence ("end", on
 * the code block); a table's row of dashes ("dash", on the row under the
 * header). Only the window shows these (lineMarks with all).
 */
export interface LineMark {
  kind: "block" | "line" | "blank" | "end" | "dash";
  from: number;
  /** The block's end; for a line or a blank line, the same as from. */
  to: number;
  line: number;
  /** A code block written between fences: its number is its opening fence's. */
  fenced?: boolean;
}

/** The same, inside one top-level block: positions from the block's start, lines from the block's first line (0). */
export type BlockMark = LineMark;

/** How many lines a piece of the file moves on: one for each "\n". */
export function lineBreaks(text: string): number {
  let count = 0;
  for (let i = text.indexOf("\n"); i >= 0; i = text.indexOf("\n", i + 1)) count++;
  return count;
}

/**
 * For each line of the document as Markdown splits it (at "\r\n", "\r" or
 * "\n"), its file line counted from 0; null when there's no difference,
 * which is unless the text has a "\r" on its own (an old Mac line ending).
 */
function fileLinesOf(text: string): number[] | null {
  if (!/\r(?!\n)/.test(text)) return null;
  const out = [0];
  let line = 0;
  for (const m of text.matchAll(/\r\n|\r|\n/g)) {
    if (m[0] !== "\r") line++;
    out.push(line);
  }
  return out;
}

/**
 * The Markdown view's text area shows a "\r" on its own as a line break too.
 * Its file line for each of the text area's lines (from 1), or null for a
 * line that is part of the file line before it; null overall when every line
 * is its own file line, as it is unless the text has such a "\r".
 */
export function textAreaLineNumbers(text: string): (number | null)[] | null {
  const lines = fileLinesOf(text);
  if (!lines) return null;
  return lines.map((line, i) => (i > 0 && lines[i - 1] === line ? null : line + 1));
}

// Block tokens as a tree, the way the editor's blocks nest. A table's head and
// body groups are left out, so its rows are its children, as in the editor.
interface TokenNode {
  token: MarkdownToken;
  children: TokenNode[];
  /** A paragraph's text, as read. */
  inline?: MarkdownToken;
}

function tokenTree(tokens: MarkdownToken[]): TokenNode[] {
  const top: TokenNode[] = [];
  const stack: TokenNode[][] = [top];
  const open: (TokenNode | null)[] = [];
  for (const token of tokens) {
    const here = stack[stack.length - 1];
    if (token.type === "thead_open" || token.type === "tbody_open") {
      stack.push(here);
      open.push(null);
    } else if (token.nesting === 1) {
      const node: TokenNode = { token, children: [] };
      here.push(node);
      stack.push(node.children);
      open.push(node);
    } else if (token.nesting === -1) {
      if (stack.length > 1) stack.pop();
      open.pop();
    } else if (token.type === "inline") {
      const parent = open[open.length - 1];
      if (parent) parent.inline = token;
    } else here.push({ token, children: [] });
  }
  return top;
}

// Which token each kind of block comes from.
const TOKENS: Record<string, string[]> = {
  paragraph: ["paragraph_open"],
  heading: ["heading_open"],
  blockquote: ["blockquote_open"],
  bullet_list: ["bullet_list_open"],
  ordered_list: ["ordered_list_open"],
  list_item: ["list_item_open"],
  code_block: ["fence", "code_block"],
  horizontal_rule: ["hr"],
  table: ["table_open"],
  table_row: ["tr_open"],
};

/** A mark at the start of each line of a code or raw block's text, the first being this file line. */
function textLines(node: Node, at: number, firstLine: (i: number) => number, out: BlockMark[]): void {
  const text = node.textContent;
  for (let i = 0, offset = 0; ; i++) {
    out.push({ kind: "line", from: at + 1 + offset, to: at + 1 + offset, line: firstLine(i) });
    const next = text.indexOf("\n", offset);
    if (next < 0) break;
    offset = next + 1;
  }
}

/**
 * A paragraph written on several lines of the file shows each as a line of
 * its own (Corillo keeps single line breaks as breaks), so each line after
 * the first gets its own number (Orlando, 2026-11-09): a mark after each line
 * break in its text, and after each break written as two spaces or a
 * backslash. A break written as <br> keeps to its line of the file.
 */
function paragraphLines(node: Node, at: number, out: BlockMark[], fileText: readonly string[], inline: () => string | undefined): void {
  let line = 0;
  const end = node.content.size;
  const marks: BlockMark[] = [];
  node.forEach((child, offset) => {
    if (child.isText) {
      const text = child.text!;
      for (let i = text.indexOf("\n"); i >= 0; i = text.indexOf("\n", i + 1)) {
        line++;
        const from = offset + i + 1;
        if (from < end) marks.push({ kind: "line", from: at + 1 + from, to: at + 1 + from, line });
      }
    } else if (child.type.name === "hard_break" && !child.attrs.markup) {
      line++;
      const from = offset + child.nodeSize;
      if (from < end) marks.push({ kind: "line", from: at + 1 + from, to: at + 1 + from, line });
    }
  });
  if (line === fileText.length - 1) {
    out.push(...marks);
    return;
  }
  // Code or a link's title that runs over a line break shows on one line, so
  // the page has fewer lines than the file: each line break the reader finds
  // in the paragraph's text says which line of the file the next line of
  // the page starts on.
  const content = inline();
  const breaks = content === undefined ? null : lineBreakLines(content);
  if (breaks?.length === line) {
    for (const m of marks) out.push({ ...m, line: breaks[m.line - 1] + 1 });
    return;
  }
  // (Should the two disagree: find each line's words in the file's lines
  // instead. A line whose words can't be found has no number.)
  const words = (t: string) => t.replace(/[^\p{L}\p{N}]/gu, "");
  let after = 0;
  for (const m of marks) {
    const shown = words(node.textBetween(m.from - at - 1, node.content.size, "\n", "\n").split("\n")[0]).slice(0, 12);
    if (!shown) continue;
    const found = fileText.findIndex((t, j) => j > after && words(t).includes(shown));
    if (found < 0) continue;
    out.push({ ...m, line: found });
    after = found;
  }
}

/** A blank line inside a list or quote, between two of its parts: lines counted in the block's text. */
export interface InnerBlank {
  line: number;
  /** Between a list's items, a list item's parts, or a quote's parts. */
  within: "list" | "item" | "quote";
  /** Where the parts before and after it start. */
  before: number;
  after: number;
}

/** What a walk through a block gathers, besides its marks. */
interface Gather {
  /** The places of the parts of a quote, or of a list spaced with blank lines, written with no blank line before them (the page sets those close). */
  joins?: number[];
  /** The blank lines between parts. */
  blanks?: InnerBlank[];
}

const LISTS = new Set(["bullet_list", "ordered_list"]);

/**
 * Marks for a block and what's in it, from the token it was read from.
 * loose: the block is an item of a list spaced with blank lines.
 */
function walk(
  node: Node,
  at: number,
  token: TokenNode,
  fileLine: (mdLine: number) => number,
  fileText: readonly string[],
  out: BlockMark[],
  gather: Gather = {},
  loose = false,
): void {
  const start = token.token.map?.[0];
  if (start === undefined) return;
  const name = node.type.name;
  if (name === "paragraph" || name === "heading" || name === "horizontal_rule" || name === "table_row") {
    out.push({ kind: "block", from: at, to: at + node.nodeSize, line: fileLine(start) });
    if (name === "paragraph") {
      const lines: BlockMark[] = [];
      paragraphLines(node, at, lines, fileText.slice(start, token.token.map![1]), () => token.inline?.content);
      // A line ended by an old Mac line break (a carriage return on its own) is the same line of the file.
      for (const m of lines) if (fileLine(start + m.line) !== fileLine(start + m.line - 1)) out.push({ ...m, line: fileLine(start + m.line) });
    }
    return;
  }
  if (name === "code_block") {
    // The block's own number is where it starts (its opening fence); its
    // text's lines come after a fence, or start there when it's indented.
    const fenced = token.token.type === "fence";
    out.push({ kind: "block", from: at, to: at + node.nodeSize, line: fileLine(start), ...(fenced ? { fenced } : {}) });
    textLines(node, at, (i) => fileLine(start + (fenced ? 1 : 0) + i), out);
    const last = token.token.map![1] - 1;
    if (fenced && last > start && FENCE.test(fileText[last] ?? "")) out.push({ kind: "end", from: at, to: at + node.nodeSize, line: fileLine(last) });
    return;
  }
  // Lists, list items, quotes and tables: their parts, in order, and a
  // number for a blank line between two of them (just the first, if the
  // file has several there: inside a list or quote the page shows one).
  const children = token.children;
  const list = LISTS.has(name);
  const within = list ? "list" : name === "list_item" ? "item" : name === "blockquote" ? "quote" : null;
  // Parts the page spaces a line apart unless the file writes them close.
  const spaced = name === "blockquote" || (list && !node.attrs.tight) || (name === "list_item" && loose);
  let before: TokenNode | null = null;
  node.forEach((child, offset, i) => {
    const match = children[i];
    if (!match || !TOKENS[child.type.name]?.includes(match.token.type)) {
      before = null;
      return;
    }
    if (before) {
      const blank = blankBetween(before, match, fileText);
      if (blank !== null) {
        out.push({ kind: "blank", from: at + 1 + offset, to: at + 1 + offset, line: fileLine(blank) });
        if (within) gather.blanks?.push({ line: blank, within, before: before.token.map![0], after: match.token.map![0] });
      } else if (spaced) gather.joins?.push(at + 1 + offset);
    }
    walk(child, at + 1 + offset, match, fileLine, fileText, out, gather, list ? !node.attrs.tight : name === "list_item" && loose);
    before = match;
  });
}

const FENCE = /^[ \t>]*(`{3,}|~{3,})[ \t]*$/;
const BLANK_IN_BLOCK = /^[ \t>]*$/;

/** The blank line of the file between two parts of a block (its line in the block's text), or null if they touch. */
function blankBetween(a: TokenNode, b: TokenNode, fileText: readonly string[]): number | null {
  const from = a.token.map?.[0];
  const next = b.token.map?.[0];
  if (from === undefined || next === undefined) return null;
  let end = Math.min(a.token.map![1], next);
  while (end - 1 > from && BLANK_IN_BLOCK.test(fileText[end - 1] ?? "")) end--;
  return end < next && BLANK_IN_BLOCK.test(fileText[end] ?? "") ? end : null;
}

/** Where to show numbers in one top-level block, written in the file as this text; and what else the walk gathers. */
function marksFor(node: Node, text: string, gather: Gather = {}): BlockMark[] {
  const out: BlockMark[] = [];
  const mdLines = fileLinesOf(text);
  const fileLine = (mdLine: number) => (mdLines ? (mdLines[mdLine] ?? mdLines[mdLines.length - 1]) : mdLine);
  switch (node.type.name) {
    case "paragraph": {
      out.push({ kind: "block", from: 0, to: node.nodeSize, line: 0 });
      const lines: BlockMark[] = [];
      paragraphLines(node, 0, lines, text.split(/\r\n|\r|\n/), () => markdownTokens(text).find((t) => t.type === "inline")?.content);
      for (const m of lines) if (fileLine(m.line) !== fileLine(m.line - 1)) out.push({ ...m, line: fileLine(m.line) });
      break;
    }
    case "heading":
    case "horizontal_rule":
      out.push({ kind: "block", from: 0, to: node.nodeSize, line: 0 });
      break;
    case "footnote_def":
      out.push({ kind: "line", from: 1, to: 1, line: 0 });
      break;
    case "raw_block":
      textLines(node, 0, fileLine, out);
      break;
    case "table":
      // Each row is a line of its own, the header's first, then the line of
      // dashes, whose number sits on the rule under the header.
      node.forEach((row, offset, k) => {
        if (k === 1) out.push({ kind: "dash", from: 1 + offset, to: 1 + offset + row.nodeSize, line: fileLine(1) });
        out.push({ kind: "block", from: 1 + offset, to: 1 + offset + row.nodeSize, line: fileLine(k === 0 ? 0 : k + 1) });
      });
      break;
    default: {
      const top = tokenTree(markdownTokens(text))[0];
      if (top && TOKENS[node.type.name]?.includes(top.token.type)) walk(node, 0, top, fileLine, text.split(/\r\n|\r|\n/), out, gather);
    }
  }
  return out;
}

interface BlockLines {
  text: string;
  /** Lines the block's text moves on. */
  breaks: number;
  marks: BlockMark[] | null;
  joins: number[] | null;
}

// What's known about each block written as some text. Blocks are never
// changed in place, so this stays right for as long as the block is written
// the same way.
const known = new WeakMap<Node, BlockLines>();

function linesOf(node: Node, text: string): BlockLines {
  let found = known.get(node);
  if (!found || found.text !== text) {
    found = { text, breaks: lineBreaks(text), marks: null, joins: null };
    known.set(node, found);
  }
  return found;
}

/** Where to show numbers in one top-level block, written in the file as this text. */
export function blockMarks(node: Node, text: string): readonly BlockMark[] {
  const found = linesOf(node, text);
  if (!found.marks) {
    const gather = { joins: [] as number[] };
    found.marks = marksFor(node, text, gather);
    found.joins = gather.joins;
  }
  return found.marks;
}

/**
 * The places, from the block's start, of the parts of a quote, or of a list
 * spaced with blank lines, that its text writes with no blank line before
 * them: the page sets them close. (Only quotes, such lists and blocks holding
 * them have any.)
 */
export function blockJoins(node: Node, text: string): readonly number[] {
  if (!holdsSpaced(node)) return NONE;
  blockMarks(node, text);
  return linesOf(node, text).joins!;
}
const NONE: readonly number[] = [];

function holdsSpaced(node: Node): boolean {
  if (node.type.name === "blockquote" || (LISTS.has(node.type.name) && !node.attrs.tight)) return true;
  if (node.isTextblock || node.isLeaf || node.type.name === "table") return false;
  let found = false;
  node.forEach((child) => {
    found ||= holdsSpaced(child);
  });
  return found;
}

/** The blank lines between the parts of a list or quote written as this text, in order (for Word: export-prep.ts). */
export function innerBlankLines(node: Node, text: string): InnerBlank[] {
  const blanks: InnerBlank[] = [];
  if (!node.isTextblock && !node.isLeaf) marksFor(node, text, { blanks });
  return blanks;
}

/**
 * The file line each top-level block starts on (null for an empty line that
 * isn't written: after the last words, or before front matter), the text it's
 * written as, and the line of the blank line after it (null if the next block
 * starts on the next line, or nothing follows).
 */
export function blockStarts(doc: Node, source: Source): { line: (number | null)[]; text: (string | null)[]; blank: (number | null)[] } {
  const layout = markdownLayout(doc, source);
  const line: (number | null)[] = [];
  const text: (string | null)[] = [];
  const blank: (number | null)[] = [];
  let at = 1 + lineBreaks(layout.prefix);
  let last = -1;
  layout.blocks.forEach((block, k) => {
    if (!block) {
      line.push(null);
      text.push(null);
      blank.push(null);
      return;
    }
    const breaks = lineBreaks(block.gap);
    // The first blank line between two blocks is the space between them, numbered after the first.
    if (last >= 0 && breaks > 1) blank[last] = at + 1;
    at += breaks;
    line.push(at);
    text.push(block.text);
    blank.push(null);
    at += linesOf(doc.child(k), block.text).breaks;
    last = k;
  });
  return { line, text, blank };
}

/**
 * Every number to show in the document, in order: by default the lines with
 * words on them; with all, the lines without too (blank lines, closing fences,
 * a table's dashes), as the window shows them.
 */
export function lineMarks(doc: Node, source: Source, all = false): LineMark[] {
  const starts = blockStarts(doc, source);
  const out: LineMark[] = [];
  doc.forEach((node, offset, k) => {
    const first = starts.line[k];
    if (first === null) return;
    for (const m of blockMarks(node, starts.text[k]!)) {
      if (!all && m.kind !== "block" && m.kind !== "line") continue;
      out.push({ ...m, from: offset + m.from, to: offset + m.to, line: first + m.line });
    }
    const blank = starts.blank[k];
    if (all && blank !== null) out.push({ kind: "blank", from: offset + node.nodeSize, to: offset + node.nodeSize, line: blank });
  });
  return out;
}
