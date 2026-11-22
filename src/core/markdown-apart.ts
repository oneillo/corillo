// Whether two blocks written one under the other still read as the same two blocks.
import { type Node } from "prosemirror-model";
import { md, type MarkdownToken as Token } from "./markdown-tokens";

// Two blocks with no blank line between ---------------------------------------------------

// The first token each kind of block is read from.
const FIRST_TOKEN: Record<string, string[]> = {
  paragraph: ["paragraph_open"],
  heading: ["heading_open"],
  blockquote: ["blockquote_open"],
  bullet_list: ["bullet_list_open"],
  ordered_list: ["ordered_list_open"],
  code_block: ["fence", "code_block"],
  horizontal_rule: ["hr"],
  table: ["table_open"],
};
// Blocks that are lines Corillo finds itself (definitions, notes): the reader
// makes no block of them, so they're checked line by line (see sameLines).
const LINE_KINDS = new Set(["links", "definitions"]);
const LINE_BREAK = /\r\n|\r|\n/g;
const FENCE_LINE = /^ {0,3}(`{3,}|~{3,})/;
const LIST_MARKER = /^( {0,3})(?:[-+*]|\d{1,9}[.)])(?:[ \t]|$)/;

const apart = new WeakMap<Node, { before: Node; beforeText: string; gap: string; text: string; ok: boolean }>();

/**
 * Whether two blocks written one under the other with this spacing, which
 * has no blank line in it, still read as the same two blocks. They may not:
 * a heading set to normal text joins the paragraph under it, a list whose
 * first item is empty turns the line above into a heading, a paragraph under
 * a table becomes a row.
 */
function keepsApart(before: Node, beforeText: string, gap: string, node: Node, text: string): boolean {
  if ((gap.match(LINE_BREAK)?.length ?? 0) > 1) return true; // a blank line
  const known = apart.get(node);
  if (known && known.before === before && known.beforeText === beforeText && known.gap === gap && known.text === text) return known.ok;
  const ok = readsApart(before, beforeText, gap, node, text);
  apart.set(node, { before, beforeText, gap, text, ok });
  return ok;
}

function readsApart(before: Node, beforeText: string, gap: string, node: Node, text: string): boolean {
  // Front matter is read apart from the rest whatever follows it.
  const frontMatter = (n: Node) => n.type.name === "raw_block" && n.attrs.kind === "front-matter";
  if (frontMatter(before) || frontMatter(node)) return true;
  const a = boundary(before, beforeText, "end");
  const b = boundary(node, text, "start");
  const lineKind = (n: Node) => n.type.name === "footnote_def" || (n.type.name === "raw_block" && LINE_KINDS.has(n.attrs.kind));
  if (lineKind(before) || lineKind(node)) return sameLines(a, gap, b);
  const second = (a.match(LINE_BREAK)?.length ?? 0) + (gap.match(LINE_BREAK)?.length ?? 0);
  // The blocks read: each starts with a token at the top level.
  const starts = md.parse(a + gap + b, {}).filter((tok) => tok.level === 0 && tok.nesting >= 0 && tok.map);
  if (starts.length !== 2 || starts[0].map![0] !== 0 || starts[1].map![0] !== second) return false;
  const expect = (n: Node) => FIRST_TOKEN[n.type.name] ?? (n.type.name === "raw_block" && n.attrs.kind === "table" ? ["table_open"] : null);
  const fits = (n: Node, tok: Token) => expect(n)?.includes(tok.type) ?? true;
  return fits(before, starts[0]) && fits(node, starts[1]);
}

/**
 * For link definitions and notes, which Markdown reads without making a block
 * of them: whether two texts written one under the other read line for line
 * as each does alone, defining the same labels. A definition can't break into
 * a paragraph ("Sources" over "[1]: https://..." makes it words of the
 * paragraph, and every link to it plain text), and a line of words straight
 * after a note is more of the note.
 */
function sameLines(a: string, gap: string, b: string): boolean {
  const second = (a.match(LINE_BREAK)?.length ?? 0) + (gap.match(LINE_BREAK)?.length ?? 0);
  const first = linesRead(a, 0);
  const then = linesRead(b, second);
  const both = linesRead(a + gap + b, 0);
  const labels = new Set([...first.labels, ...then.labels]);
  return both.blocks === first.blocks + then.blocks && both.labels.size === labels.size && [...labels].every((l) => both.labels.has(l));
}

/** How Markdown reads some text block by block (each part's kind, depth and lines, counted from line `shift`), and the labels it defines. */
function linesRead(text: string, shift: number): { blocks: string; labels: Set<string> } {
  const env: { references?: Record<string, unknown>; footnotes?: { refs?: Record<string, unknown> } } = {};
  const tokens: Token[] = [];
  // (Only the block rules, so the notes' tokens stay where they were read.)
  md.block.parse(text.replace(/\r\n?/g, "\n"), md, env, tokens);
  let blocks = "";
  for (const t of tokens) if (t.nesting >= 0) blocks += `${t.type} ${t.level} ${t.map ? `${t.map[0] + shift}-${t.map[1] + shift}` : ""}\n`;
  return { blocks, labels: new Set([...Object.keys(env.references ?? {}), ...Object.keys(env.footnotes?.refs ?? {})]) };
}

/**
 * The part of a block's text that decides how it meets its neighbour, so a
 * long table or code block isn't read whole on every keystroke: a table's
 * first two lines (and last row, at its end), a fenced code block's fences,
 * a long list's first or last item.
 */
function boundary(node: Node, text: string, side: "start" | "end"): string {
  if (text.length < 2000) return text;
  const lines = text.split(/\r\n|\r|\n/);
  const name = node.type.name === "raw_block" && node.attrs.kind === "table" ? "table" : node.type.name;
  if (name === "table" && lines.length > 3) return [lines[0], lines[1], ...(side === "end" ? [lines[lines.length - 1]] : [])].join("\n");
  if (name === "code_block" && FENCE_LINE.test(lines[0]) && lines.length > 2) return `${lines[0]}\n${lines[lines.length - 1]}`;
  // (A definition takes three lines at most: label, address, title.)
  if (node.type.name === "raw_block" && LINE_KINDS.has(node.attrs.kind)) return (side === "start" ? lines.slice(0, 3) : lines.slice(-3)).join("\n");
  if (name === "bullet_list" || name === "ordered_list") {
    const indent = LIST_MARKER.exec(lines[0])?.[1];
    if (indent === undefined) return text;
    const item = (l: string) => LIST_MARKER.exec(l)?.[1] === indent;
    if (side === "start") {
      let end = 1;
      while (end < lines.length && !item(lines[end])) end++;
      return lines.slice(0, end).join("\n");
    }
    let start = lines.length - 1;
    while (start > 0 && !item(lines[start])) start--;
    return lines.slice(start).join("\n");
  }
  return text;
}

export { LINE_BREAK, keepsApart, readsApart };
