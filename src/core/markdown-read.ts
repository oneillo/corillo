// Reading a Markdown file into a page, each top-level block kept with its exact text.
import MarkdownIt from "markdown-it";
import { MarkdownParser, type ParseSpec } from "prosemirror-markdown";
import { type Node } from "prosemirror-model";
import { schema } from "./schema";
import { frontMatterEnd as frontMatterEndOf } from "./front-matter";
import { md, TokenClass, type MarkdownToken as Token } from "./markdown-tokens";
import { unescapedAlt } from "./markdown-alt";

// Token types the rich editor understands. A top-level block containing
// anything else is kept as raw source.
const SUPPORTED_BLOCK = new Set([
  "paragraph_open", "paragraph_close", "heading_open", "heading_close",
  "blockquote_open", "blockquote_close", "bullet_list_open", "bullet_list_close",
  "ordered_list_open", "ordered_list_close", "list_item_open", "list_item_close",
  "code_block", "fence", "hr", "inline",
  "table_open", "table_close", "thead_open", "thead_close", "tbody_open", "tbody_close",
  "tr_open", "tr_close", "th_open", "th_close", "td_open", "td_close",
]);
const SUPPORTED_INLINE = new Set([
  "text", "softbreak", "hardbreak", "code_inline", "em_open", "em_close",
  "strong_open", "strong_close", "s_open", "s_close", "link_open", "link_close", "image",
  "footnote_ref",
]);
// Footnotes have no line breaks, and table cells only the "<br>" kind (see readInlineHtml).
const NO_BREAKS = new Set(["softbreak", "hardbreak"]);
const FOOTNOTE_START = /^ {0,3}\[\^([^\]\s]+)\]:/;
const DEFINITION_START = /^ {0,3}\[[^\]]+\]:/;
// A line inside a quote or list that might hold a link or footnote
// definition ("> [site]: https://..." or "- [^1]: note").
const NESTED_DEFINITION = /^(?:[ \t>]+|[-+*][ \t]|\d{1,9}[.)][ \t])*\[[^\]]+\]:/;
const CONTAINERS = new Set(["blockquote_open", "bullet_list_open", "ordered_list_open"]);
// "[ ] item" and "[x] item" start a task list item. In a bulleted list the
// box is shown, as Word shows it (see readTasks); a numbered list has none in
// Word, and re-writing its text would escape the brackets, so it stays raw.
const TASK_ITEM = /^\[([ xX])\](\s|$)/;

function alignOf(tok: Token): string | null {
  const m = /text-align:\s*(left|right|center)/.exec(tok.attrGet("style") ?? "");
  return m ? m[1] : null;
}

/**
 * Whether the list opened at tokens[i] is tight. Markdown hides the
 * paragraphs of a tight list's items, so the first one says; an item may
 * start with something else (code, a quote) or be empty. With no paragraph
 * at all, it's tight: nothing in it is spaced out.
 */
function listIsTight(tokens: Token[], i: number): boolean {
  const level = tokens[i].level;
  for (let j = i + 1; j < tokens.length && tokens[j].level > level; j++) {
    if (tokens[j].type === "paragraph_open" && tokens[j].level === level + 2) return tokens[j].hidden;
  }
  return true;
}

/** How each of markdown-it's tokens becomes a node (the reading itself is buildDoc's). */
const TOKENS: Record<string, ParseSpec> = {
  blockquote: { block: "blockquote" },
  paragraph: { block: "paragraph" },
  list_item: { block: "list_item", getAttrs: (tok) => ({ checked: tok.meta?.checked ?? null }) },
  bullet_list: {
    block: "bullet_list",
    getAttrs: (tok, toks, i) => ({ tight: listIsTight(toks, i), bullet: tok.markup || "-" }),
  },
  ordered_list: {
    block: "ordered_list",
    getAttrs: (tok, toks, i) => ({
      order: Number(tok.attrGet("start") ?? 1),
      tight: listIsTight(toks, i),
      delim: tok.markup || ".",
    }),
  },
  heading: { block: "heading", getAttrs: (tok) => ({ level: Number(tok.tag.slice(1)) }) },
  code_block: { block: "code_block", noCloseToken: true, getAttrs: () => ({ params: "", fence: "```" }) },
  fence: {
    block: "code_block",
    noCloseToken: true,
    getAttrs: (tok) => ({ params: tok.info || "", fence: tok.markup || "```" }),
  },
  hr: { node: "horizontal_rule", getAttrs: (tok) => ({ markup: tok.markup || "---" }) },
  image: {
    node: "image",
    // The alt text is kept as written between the brackets, so writing it
    // back gives the same text; only a backslash that keeps a lone bracket
    // from counting is taken out, so "Q3 \[draft" is "Q3 [draft" (see altText in markdown-alt.ts).
    getAttrs: (tok) => ({
      src: tok.attrGet("src"),
      title: tok.attrGet("title") || null,
      alt: unescapedAlt(tok.content) || null,
      ref: tok.meta?.ref ?? null,
      refForm: tok.meta?.refForm ?? null,
    }),
  },
  hardbreak: { node: "hard_break", getAttrs: (tok) => ({ markup: /^</.test(tok.markup) ? tok.markup : null }) },
  em: { mark: "em", getAttrs: (tok) => ({ markup: tok.markup || "*" }) },
  strong: { mark: "strong", getAttrs: (tok) => ({ markup: tok.markup || "**" }) },
  s: { mark: "strike", getAttrs: (tok) => ({ markup: tok.markup || "~~" }) },
  link: {
    mark: "link",
    getAttrs: (tok) => ({ href: tok.attrGet("href"), title: tok.attrGet("title") || null, ref: tok.meta?.ref ?? null, refForm: tok.meta?.refForm ?? null }),
  },
  code_inline: { mark: "code", noCloseToken: true },
  table: { block: "table" },
  thead: { ignore: true },
  tbody: { ignore: true },
  tr: { block: "table_row" },
  th: { block: "table_header", getAttrs: (tok) => ({ align: alignOf(tok) }) },
  td: { block: "table_cell", getAttrs: (tok) => ({ align: alignOf(tok) }) },
  footnote_ref: { node: "footnote_ref", getAttrs: (tok) => ({ label: tok.meta.label }) },
  footnote_def: { block: "footnote_def", getAttrs: (tok) => ({ label: tok.meta.label }) },
  raw_block: { block: "raw_block", noCloseToken: true, getAttrs: (tok) => ({ kind: tok.info || "markdown" }) },
};

// A single line break inside a paragraph stays a line break, as Obsidian
// shows it and as the file has it, so editing never joins the lines (a
// callout's title stays on its own line). A heading has only one line: a
// line break in it (a heading written over two lines, "Ana López  " above
// "Product lead" and "---") is a space.
type ParseState = { top(): { type: { name: string } }; addText(text: string): void };
type Handler = (state: ParseState, ...rest: unknown[]) => void;
const handlersOf = (p: MarkdownParser) => (p as unknown as { tokenHandlers: Record<string, Handler> }).tokenHandlers;
function keepLineBreaks(p: MarkdownParser): MarkdownParser {
  const handlers = handlersOf(p);
  handlers.softbreak = (state) => state.addText(state.top().type.name === "heading" ? " " : "\n");
  const hard = handlers.hardbreak;
  handlers.hardbreak = (state, ...rest) => (state.top().type.name === "heading" ? state.addText(" ") : hard(state, ...rest));
  return p;
}

export type Eol = "\n" | "\r\n" | "\r";

/** What we remember about the file as it was read, to write it back faithfully. */
export interface Source {
  bom: boolean;
  eol: Eol;
  /** Whitespace before the first block. */
  prefix: string;
  /** Whitespace after the last block. */
  trailing: string;
  /** Each top-level block: the node it became and its exact original text. */
  blocks: { node: Node; text: string }[];
  /** gaps[i] is the exact whitespace between blocks[i] and blocks[i + 1]. */
  gaps: string[];
  /** The whole original text, used when the document had no blocks. */
  original: string;
}

export interface Loaded {
  doc: Node;
  source: Source;
}

interface Item {
  startLine: number;
  endLine: number; // exclusive
  tokens?: Token[];
  rawKind?: string;
}

const BLANK = /^[ \t]*$/;

function inlineSupported(tok: Token, breaks: "all" | "soft" | "none" | "cell"): boolean {
  for (const child of tok.children ?? []) {
    if (!SUPPORTED_INLINE.has(child.type)) return false;
    if (breaks === "none" && NO_BREAKS.has(child.type)) return false;
    if (breaks === "cell" && NO_BREAKS.has(child.type) && !/^</.test(child.markup)) return false;
    if (breaks === "soft" && child.type === "hardbreak") return false;
    if (child.type === "footnote_ref" && !child.meta?.label) return false; // inline ^[notes]
  }
  return true;
}

function isSupported(group: Token[]): boolean {
  let inCell = 0;
  for (const tok of group) {
    if (!SUPPORTED_BLOCK.has(tok.type)) return false;
    if (tok.type === "th_open" || tok.type === "td_open") inCell++;
    if (tok.type === "th_close" || tok.type === "td_close") inCell--;
    if (tok.type === "inline" && !inlineSupported(tok, inCell === 0 ? "all" : "cell")) return false;
  }
  // Task-list items: a list item whose first text starts with "[ ]" or "[x]".
  for (let i = 0; i < group.length; i++) {
    if (group[i].type !== "list_item_open") continue;
    let j = i + 1;
    while (j < group.length && group[j].type !== "inline") j++;
    const first = group[j]?.children?.[0];
    if (first && first.type === "text" && TASK_ITEM.test(first.content) && TASK_ITEM.test(group[j].content)) return false;
  }
  return true;
}

// HTML that agents often write inside table cells, because a Markdown table
// row has to stay on one line: "<br>" for a line break, and sometimes <b>,
// <i> or <s> for formatting. A cell with only these shows in the grid; any
// other HTML keeps the table as Markdown text.
const BR_TAG = /^<br\s*\/?>$/i;
const MARK_TAGS: Record<string, "strong" | "em" | "s"> = {
  b: "strong", strong: "strong", i: "em", em: "em", s: "s", del: "s", strike: "s",
};
const OPEN_TAG = /^<([a-z]+)>$/i;
const CLOSE_TAG = /^<\/([a-z]+)>$/i;

/**
 * Task list items in bulleted lists: the box goes on the item (checked), and
 * its "[ ] " comes off the text, as Pandoc reads it for Word.
 */
function readTasks(tokens: Token[]): void {
  const lists: string[] = [];
  tokens.forEach((tok, i) => {
    if (tok.type === "bullet_list_open" || tok.type === "ordered_list_open") lists.push(tok.type);
    else if (tok.type === "bullet_list_close" || tok.type === "ordered_list_close") lists.pop();
    else if (tok.type === "list_item_open" && lists[lists.length - 1] === "bullet_list_open") {
      const inline = tokens[i + 1]?.type === "paragraph_open" ? tokens[i + 2] : undefined;
      const first = inline?.type === "inline" ? inline.children?.[0] : undefined;
      // (`\[ \]`, with its brackets escaped, is the words "[ ]", not a box.)
      const m = first?.type === "text" && TASK_ITEM.test(inline!.content) ? TASK_ITEM.exec(first.content) : null;
      if (!first || !m) return;
      tok.meta = { ...tok.meta, checked: m[1] !== " " };
      first.content = first.content.slice(m[0].length);
    }
  });
}

/**
 * Turn the HTML in table cells and paragraphs that the page can show into
 * line breaks and formatting, as Word shows it (see wordFilter in export-prep.ts). A heading
 * reads HTML formatting too (Corillo writes it where Markdown's marks
 * wouldn't read back), but a "<br>" keeps it as Markdown text: it has one
 * line and no room for a break.
 */
function readInlineHtml(tokens: Token[]): void {
  let inCell = false;
  tokens.forEach((tok, i) => {
    if (tok.type === "th_open" || tok.type === "td_open") inCell = true;
    else if (tok.type === "th_close" || tok.type === "td_close") inCell = false;
    else if (tok.type === "inline" && tok.children?.some((c) => c.type === "html_inline")) {
      const before = tokens[i - 1]?.type;
      if (inCell || before === "paragraph_open" || before === "heading_open") cellHtml(tok, before === "heading_open");
    }
  });
}

function cellHtml(inline: Token, heading = false): void {
  const out: Token[] = [];
  const tags: string[] = []; // open HTML tags, innermost last
  const open = new Map<string, number>(); // how many of each kind of formatting are open
  const opened = (kind: string, by: number) => open.set(kind, (open.get(kind) ?? 0) + by);
  for (const child of inline.children ?? []) {
    const kind = /^(strong|em|s)_(open|close)$/.exec(child.type);
    if (kind) {
      // Bold inside bold can't be shown (the editor's bold is on or off).
      if (kind[2] === "open" && open.get(kind[1]) && tags.length) return;
      opened(kind[1], kind[2] === "open" ? 1 : -1);
    }
    if (child.type !== "html_inline") {
      out.push(child);
      continue;
    }
    const html = child.content;
    if (BR_TAG.test(html)) {
      if (heading) return;
      const br = new TokenClass("hardbreak", "br", 0);
      br.markup = html;
      out.push(br);
      continue;
    }
    const start = OPEN_TAG.exec(html);
    const end = CLOSE_TAG.exec(html);
    const name = (start ?? end)?.[1].toLowerCase() ?? "";
    const mark = MARK_TAGS[name];
    if (!mark) return; // other HTML: the table stays as Markdown text
    if (start) {
      if (open.get(mark)) return;
      tags.push(name);
      opened(mark, 1);
    } else {
      if (tags.pop() !== name) return;
      opened(mark, -1);
    }
    const tok = new TokenClass(`${mark}_${start ? "open" : "close"}`, mark, start ? 1 : -1);
    tok.markup = html;
    out.push(tok);
  }
  if (tags.length) return; // a tag left open
  inline.children = out;
}

/**
 * The cells of one table row, split the way markdown-it splits them (a pipe
 * after a backslash is part of the text). Quote and list markers before the
 * row are left out.
 */
function rowCells(line: string): string[] {
  const text = line.replace(/^(?:[ \t]*(?:>|[-+*](?=[ \t])|\d{1,9}[.)](?=[ \t])))*/, "").trim();
  const cells: string[] = [];
  let from = 0;
  for (let i = 0; i < text.length; i++) {
    if (text[i] === "|" && text[i - 1] !== "\\") {
      cells.push(text.slice(from, i));
      from = i + 1;
    }
  }
  cells.push(text.slice(from));
  if (cells.length && cells[0] === "") cells.shift();
  if (cells.length && cells[cells.length - 1] === "") cells.pop();
  return cells;
}

/**
 * A row with more cells than the header row: Markdown ignores the extra
 * ones, so the grid can't show them, and an edit would lose them. Such a
 * table stays as Markdown text.
 */
function hasHiddenCells(group: Token[], lines: string[]): boolean {
  let columns = 0;
  for (const tok of group) {
    if (tok.type === "table_open") columns = 0;
    else if (tok.type === "th_open") columns++;
    else if (tok.type === "tr_open" && tok.map) {
      const cells = rowCells(lines[tok.map[0]] ?? "");
      if (columns && cells.slice(columns).some((c) => c.trim() !== "")) return true;
    }
  }
  return false;
}

/**
 * Link and footnote definitions inside a quote or list leave no trace in the
 * editor, so writing the block back would drop them. Which labels does this
 * block define, if any?
 */
function nestedDefinitions(group: Token[], lines: string[], start: number, end: number): string[] | null {
  if (!CONTAINERS.has(group[0].type)) return null;
  let candidate = false;
  for (let l = start; l < end && !candidate; l++) candidate = NESTED_DEFINITION.test(lines[l]);
  if (!candidate) return null;
  const env: { references?: Record<string, unknown>; footnotes?: { refs?: Record<string, unknown> } } = {};
  md.parse(lines.slice(start, end).join("\n"), env);
  const labels = Object.keys(env.footnotes?.refs ?? {}).map((k) => k.slice(1));
  return labels.length || Object.keys(env.references ?? {}).length ? labels : null;
}

/** Which way the file ends its lines: the most common of CRLF, LF and CR. */
function lineEnding(text: string): Eol {
  let crlf = 0;
  let lf = 0;
  let cr = 0;
  for (const m of text.matchAll(/\r\n|\n|\r/g)) {
    if (m[0] === "\r\n") crlf++;
    else if (m[0] === "\n") lf++;
    else cr++;
  }
  if (crlf > lf && crlf >= cr) return "\r\n";
  if (cr > lf && cr > crlf) return "\r";
  return "\n";
}

/** Read a Markdown file into an editable document, remembering its exact text. */
export function parseMarkdown(text: string): Loaded {
  try {
    return readBlocks(text);
  } catch {
    // Should not happen. If it does, show the whole file as one raw block
    // rather than fail to open it or risk changing anything.
    const bom = text.startsWith("\uFEFF");
    const body = bom ? text.slice(1) : text;
    const raw = schema.node("raw_block", { kind: "markdown" }, body ? [schema.text(body.replace(/\r\n?/g, "\n"))] : []);
    const blocks = body ? [{ node: raw, text: body }] : [];
    return {
      doc: schema.node("doc", null, [raw]),
      source: { bom, eol: lineEnding(body), prefix: "", trailing: "", blocks, gaps: [], original: body },
    };
  }
}

function readBlocks(text: string): Loaded {
  const bom = text.startsWith("\uFEFF");
  const body = bom ? text.slice(1) : text;
  const eol = lineEnding(body);

  // Line boundaries in the original text (any of \r\n, \r, \n ends a line).
  const lineStarts = [0];
  const lineEnds: number[] = [];
  const nl = /\r\n?|\n/g;
  for (let m; (m = nl.exec(body)); ) {
    lineEnds.push(m.index);
    lineStarts.push(m.index + m[0].length);
  }
  lineEnds.push(body.length);
  const lines = lineStarts.map((s, i) => body.slice(s, lineEnds[i]));

  // YAML front matter at the very top (see front-matter.ts): hide it from the
  // Markdown parser (it would read it as a rule and a heading) and keep it as a raw block.
  const frontMatterEnd = frontMatterEndOf(lines);
  const masked = lines.map((l, i) => (i <= frontMatterEnd ? "" : l)).join("\n");
  const tokens = md.parse(masked, {});
  readInlineHtml(tokens);
  readTasks(tokens);

  // Footnote definitions: markdown-it gathers them at the end without source
  // positions. Keep the content of each simple (one-paragraph) note by label.
  const footnoteDefs = new Map<string, Token>();
  // Where each note's text ends: Markdown reads a "[word]:" line straight
  // after a note as more of it (a definition can't break into a paragraph).
  const footnoteEnds = new Map<string, number>();
  for (let i = 0; i < tokens.length; i++) {
    if (tokens[i].type !== "footnote_open") continue;
    const label: string | undefined = tokens[i].meta?.label;
    const body: Token[] = [];
    let j = i + 1;
    for (; j < tokens.length && tokens[j].type !== "footnote_close"; j++) {
      if (tokens[j].type !== "footnote_anchor") body.push(tokens[j]);
    }
    const reach = Math.max(-1, ...body.map((t) => t.map?.[1] ?? -1));
    if (label && reach >= 0) footnoteEnds.set(label, reach);
    const simple =
      body.length === 3 &&
      body[0].type === "paragraph_open" &&
      body[1].type === "inline" &&
      body[2].type === "paragraph_close" &&
      inlineSupported(body[1], "soft");
    if (label && simple) footnoteDefs.set(label, body[1]);
    i = j;
  }

  // Group tokens into top-level blocks with their line ranges.
  const items: Item[] = [];
  // Footnote labels defined inside a quote or list.
  const nestedLabels = new Set<string>();
  for (let i = 0; i < tokens.length; ) {
    let j = i;
    if (tokens[i].nesting === 1) {
      for (let depth = 0; j < tokens.length; j++) {
        depth += tokens[j].nesting;
        if (depth === 0) break;
      }
    }
    const first = tokens[i];
    if (first.map) {
      let end = first.map[1];
      while (end - 1 > first.map[0] && BLANK.test(lines[end - 1])) end--;
      const group = tokens.slice(i, j + 1);
      const nested = nestedDefinitions(group, lines, first.map[0], end);
      for (const label of nested ?? []) nestedLabels.add(label);
      items.push(
        !nested && isSupported(group) && !hasHiddenCells(group, lines)
          ? { startLine: first.map[0], endLine: end, tokens: group }
          : { startLine: first.map[0], endLine: end, rawKind: rawKindOf(group) },
      );
    }
    // Groups without a source position (the footnote list markdown-it builds
    // at the end) are dropped: their source lines are kept as raw blocks below.
    i = j + 1;
  }

  // Lines no block covers but that hold text: front matter, footnotes and
  // link definitions. Simple footnotes become editable notes; the rest are
  // raw blocks, so nothing is ever lost.
  const covered = new Array<boolean>(lines.length).fill(false);
  for (const it of items) for (let l = it.startLine; l < it.endLine; l++) covered[l] = true;
  // A note defined twice is ambiguous: keep every definition of it raw, so
  // the editor never shows one note's text in place of another's.
  const timesDefined = new Map<string, number>();
  lines.forEach((line, l) => {
    const m = covered[l] ? null : FOOTNOTE_START.exec(line);
    if (m) timesDefined.set(m[1], (timesDefined.get(m[1]) ?? 0) + 1);
  });
  for (let l = 0; l < lines.length; ) {
    if (covered[l] || BLANK.test(lines[l])) {
      l++;
      continue;
    }
    if (l === 0 && frontMatterEnd >= 0) {
      items.push({ startLine: 0, endLine: frontMatterEnd + 1, rawKind: "front-matter" });
      l = frontMatterEnd + 1;
      continue;
    }
    let end = l;
    while (end < lines.length && !covered[end] && !BLANK.test(lines[end])) end++;
    for (let k = l; k < end; ) {
      const m = FOOTNOTE_START.exec(lines[k]);
      let next = k + 1;
      if (m) {
        while (next < end && !DEFINITION_START.test(lines[next])) next++;
        const reach = timesDefined.get(m[1]) === 1 ? (footnoteEnds.get(m[1]) ?? -1) : -1;
        if (reach > next && reach <= end && !lines.slice(next, reach).some((line) => FOOTNOTE_START.test(line))) next = reach;
        const once = timesDefined.get(m[1]) === 1 && !nestedLabels.has(m[1]);
        const inline = once ? footnoteDefs.get(m[1]) : undefined;
        if (inline) {
          const open = new TokenClass("footnote_def_open", "", 1);
          open.meta = { label: m[1] };
          items.push({ startLine: k, endLine: next, tokens: [open, inline, new TokenClass("footnote_def_close", "", -1)] });
        } else {
          items.push({ startLine: k, endLine: next, rawKind: "definitions" });
        }
      } else {
        while (next < end && !FOOTNOTE_START.test(lines[next])) next++;
        // Link definitions, or the rest of a longer footnote.
        items.push({ startLine: k, endLine: next, rawKind: DEFINITION_START.test(lines[k]) ? "links" : "definitions" });
      }
      k = next;
    }
    l = end;
  }
  items.sort((a, b) => a.startLine - b.startLine);
  if (items.length) emptyLines(items);

  const textOf = (it: Item) => body.slice(lineStarts[it.startLine], lineEnds[it.endLine - 1]);

  // A block whose Markdown the editor can't hold (some part of it would be
  // dropped) is shown as Markdown text instead, on its own: the rest of the
  // document stays formatted.
  let built = buildDoc(items, lines);
  if (built.refused.length) {
    for (const i of built.refused) items[i] = { startLine: items[i].startLine, endLine: items[i].endLine, rawKind: rawKindOf(items[i].tokens ?? []) };
    built = buildDoc(items, lines);
  }
  const doc = built.doc;

  const source: Source = { bom, eol, prefix: "", trailing: "", blocks: [], gaps: [], original: body };
  if (items.length === 0) return { doc, source };

  if (built.refused.length || doc.childCount !== items.length) throw new Error("Blocks and source lines don't match.");

  source.prefix = body.slice(0, lineStarts[items[0].startLine]);
  source.trailing = body.slice(lineEnds[items[items.length - 1].endLine - 1]);
  items.forEach((it, i) => {
    source.blocks.push({ node: doc.child(i), text: textOf(it) });
    if (i > 0) {
      const prev = items[i - 1];
      source.gaps.push(body.slice(lineEnds[prev.endLine - 1], lineStarts[it.startLine]));
    }
  });
  return { doc, source };
}

// Empty lines (Orlando, 2026-11-09) -------------------------------------------------------
// What the page shows is what the file holds: each blank line of the file is
// an empty line on the page. Markdown needs one blank line between two blocks,
// so that one is the space drawn between them, not a paragraph of its own;
// every blank line beyond it, and every blank line before the first block, is
// an empty paragraph, one line tall. So N blank lines between two blocks are
// N - 1 empty paragraphs, and k empty paragraphs are written as k + 1 blank
// lines. Blank lines after the last block stay part of the file's ending.

const EMPTY_LINE = [new TokenClass("paragraph_open", "p", 1), new TokenClass("paragraph_close", "p", -1)];

/** The empty paragraphs among these blocks (sorted, each covering its lines): one for each blank line that isn't the one between two blocks. */
function emptyLines(items: Item[]): void {
  const out: Item[] = [];
  const empty = (line: number): Item => ({ startLine: line, endLine: line + 1, tokens: EMPTY_LINE });
  for (let l = 0; l < items[0].startLine; l++) out.push(empty(l));
  items.forEach((it, i) => {
    if (i > 0) for (let l = items[i - 1].endLine + 1; l < it.startLine; l++) out.push(empty(l));
    out.push(it);
  });
  items.splice(0, items.length, ...out);
}

/** A paragraph that is an empty line: nothing in it but spaces and line breaks, so it writes nothing. */
export function isEmptyLine(node: Node): boolean {
  if (node.type.name !== "paragraph") return false;
  let blank = true;
  node.forEach((child) => {
    if (blank && !(child.isText ? /^[ \t\r\n]*$/.test(child.text!) : child.type.name === "hard_break" && !child.attrs.markup)) blank = false;
  });
  return blank;
}

interface ParseFrame {
  stack: { content: Node[] }[];
  addNode(type: unknown, attrs: unknown, content: unknown): Node | null;
}

/**
 * The document for these blocks, and which blocks it couldn't hold: each
 * must become exactly one node, with nothing inside it dropped (ProseMirror
 * leaves out a node whose content doesn't fit, such as a line break in a
 * heading, without saying so).
 */
function buildDoc(items: Item[], lines: string[]): { doc: Node; refused: number[] } {
  const stream: Token[] = [new TokenClass("corillo_start", "", 0)];
  for (const it of items) {
    if (it.tokens) for (const tok of it.tokens) stream.push(tok);
    else {
      const tok = new TokenClass("raw_block", "", 0);
      tok.content = lines.slice(it.startLine, it.endLine).join("\n");
      tok.info = it.rawKind ?? "markdown";
      tok.block = true;
      stream.push(tok);
    }
    stream.push(new TokenClass("corillo_block_end", "", 0));
  }
  const wrapped = { parse: () => stream } as unknown as MarkdownIt;
  const p = keepLineBreaks(new MarkdownParser(schema, wrapped, TOKENS));
  const handlers = handlersOf(p) as unknown as Record<string, (state: ParseFrame) => void>;
  const refused: number[] = [];
  let dropped = false;
  let item = 0;
  let count = 0; // nodes in the document so far
  handlers.corillo_start = (state) => {
    const add = state.addNode.bind(state);
    state.addNode = (type, attrs, content) => {
      const node = add(type, attrs, content);
      if (!node) dropped = true;
      return node;
    };
  };
  handlers.corillo_block_end = (state) => {
    // (A block left open would hold the next ones: then all are refused.)
    const now = state.stack.length === 1 ? state.stack[0].content.length : -1;
    if (dropped || now !== count + 1) refused.push(item);
    if (now >= 0) count = now;
    dropped = false;
    item++;
  };
  return { doc: p.parse(""), refused };
}

const HTML_COMMENTS = /^\s*(?:<!--[\s\S]*?-->\s*)+$/;

function rawKindOf(group: Token[]): string {
  if (group[0]?.type === "footnote_def_open") return "definitions";
  const types = new Set(group.map((t) => t.type));
  if (types.has("table_open")) return "table";
  // HTML that is only <!-- comments --> is hidden in Word, as Obsidian's %% comments are.
  if (types.has("html_block")) return group.every((t) => t.type !== "html_block" || HTML_COMMENTS.test(t.content)) ? "comment" : "html";
  if (group[0].type === "obsidian_comment") return "comment";
  if (group[0].type === "math_block") return "math";
  return "markdown";
}

export { BLANK, FOOTNOTE_START, TASK_ITEM };
