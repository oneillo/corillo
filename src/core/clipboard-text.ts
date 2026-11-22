// The clipboard. Copying from Corillo puts the selection on the clipboard as
// Markdown text (for an agent's chat or a plain text app) and as formatted
// text that looks the way the page does (for Outlook, Gmail and Word), and
// pasting text that is Markdown (from an agent's chat, say) brings it in
// formatted.
import { Fragment, Slice, type DOMOutputSpec, type Mark, type Node } from "prosemirror-model";
import { Transform, type Mapping } from "prosemirror-transform";
import { isEmptyLine, parseMarkdown, serializeMarkdown, type Source } from "./markdown";
import { findObsidian, isPicture, linkText } from "./obsidian";
import { schema } from "./schema";
import { PICTURE_STAND_IN } from "./doc-diff";

const BLOCK_SIGNS = [
  /^#{1,6}[ \t]+\S/, // heading
  /^[ \t]{0,3}[-*+][ \t]+\S/, // bullet
  /^[ \t]{0,3}\d{1,3}[.)][ \t]+\S/, // numbered item
  /^[ \t]{0,3}>[ \t]?\S/, // quote
  /^[ \t]{0,3}(```|~~~)/, // code fence
  /^[ \t]*\|?[ \t]*:?-{3,}:?[ \t]*(\|[ \t]*:?-{3,}:?[ \t]*)+\|?[ \t]*$/, // table rule
];
const INLINE_SIGNS = [
  /(\*\*|__)\S(?:[^\n]*?\S)?\1/, // bold
  /\[[^\]\n]+\]\([^)\s]+\)/, // link
  /`[^`\n]+`/, // code
  /~~\S(?:[^\n]*?\S)?~~/, // strikethrough
  /(?:^|[^\w*])\*[^\s*](?:[^*\n]*[^\s*])?\*(?![\w*])/, // italic
];

/** Whether plain text is written in Markdown: a heading, list, quote, table, code, bold, link and so on. */
export function looksLikeMarkdown(text: string): boolean {
  if (INLINE_SIGNS.some((re) => re.test(text))) return true;
  return text.split(/\r\n?|\n/).some((line) => BLOCK_SIGNS.some((re) => re.test(line)));
}

const fresh = (): Source => ({ bom: false, eol: "\n", prefix: "", trailing: "", blocks: [], gaps: [], original: "" });

function toMarkdown(content: Fragment): string {
  return serializeMarkdown(schema.topNodeType.create(null, content), fresh()).replace(/\n+$/, "");
}

/** The text of one paragraph, heading or cell, with its formatting, but no heading marks. */
function inlineMarkdown(block: Node, content: Fragment): string {
  if (block.type.spec.code) return content.textBetween(0, content.size);
  return toMarkdown(Fragment.from(schema.nodes.paragraph.create(null, content)));
}

/**
 * Copied content as Markdown. (A selection's content comes with the blocks
 * around it, such as its list, so a few list items copy as a list of the
 * right kind.) A selection inside one paragraph copies as just its text and
 * formatting.
 */
export function sliceMarkdown(slice: Slice): string {
  let node: Node | null | undefined = slice.content.childCount === 1 ? slice.content.firstChild : null;
  for (let depth = 0; node && depth < Math.min(slice.openStart, slice.openEnd); depth++) {
    if (node.isTextblock) return inlineMarkdown(node, node.content);
    node = node.childCount === 1 ? node.firstChild : null;
  }
  let content = slice.content;
  const first = content.firstChild;
  if (!first) return "";
  if (first.isInline) {
    content = Fragment.from(schema.nodes.paragraph.create(null, content));
  } else if (!schema.topNodeType.contentMatch.matchType(first.type)) {
    // Table rows or cells, say: wrap them in what they belong in.
    const wrapping = schema.topNodeType.contentMatch.findWrapping(first.type) ?? [];
    for (let i = wrapping.length - 1; i >= 0; i--) content = Fragment.from(wrapping[i].create(null, content));
  }
  return toMarkdown(content);
}

// Formatted text, the way the page shows it (roadmap L-3) ----------------------------------
//
// Outlook, Gmail and Word each have their own idea of the space around a
// paragraph, and none of them has Corillo's styles. So the copy says it all
// in its HTML, as Word and Google Docs write their own copies: no block has
// space of its own (margin 0), and each line of space the page shows is a
// line of its own:
//   - the blank line between two blocks: an empty line written as a plain
//     div, which Corillo doesn't read back, so pasting the copy into Corillo
//     gives the same document;
//   - an empty line of the file: an empty paragraph;
//   - a paragraph's own line break: a line break, marked so Corillo reads it
//     back as the file's line break (linesFromClipboard).
// Blocks the file writes close together (a list right under its paragraph)
// stay close, as on the page; a tight list's items hold their words with no
// paragraph, which mail apps would space out; tables have the page's Word
// look (a rule under the header, hairlines between rows), not a grid. A
// task's box is written as a character before its words, the page's ☐ or ☒,
// since mail apps draw no box of their own (Corillo leaves it out when it
// reads its own copy back: see paste.ts).

/** The page's spacing marks (blank-lines.ts): "joined" and "part" where the file writes a block straight under the one before. */
export interface SpacingMarks {
  find(from?: number, to?: number): readonly { from: number; spec: { kind?: string } }[];
}

export interface ClipboardOptions {
  /** The page's spacing marks; without them, every block is a line apart. */
  spacing?: SpacingMarks;
  /** The number the page shows for a footnote, by its label. */
  number(label: string): string;
  /** Attributes for the first element, such as Corillo's mark on its own copies. */
  mark?: Record<string, string>;
}

const FLAT = "margin:0";
/** The blank line between two blocks: an empty line in every app, and nothing to Corillo, which reads no plain div. */
const GAP = `<div style="${FLAT}"><br></div>`;
/** A paragraph's own line break, as the text holds it, and as the copy writes it so Corillo reads it back as one. */
const LINE = "\n";
const LINE_BREAK = '<br data-markup="&#10;">';
/** A little room above and below a heading, as in Word (reference-docx.ts). */
const HEADING = "margin:6pt 0 3pt";
const QUOTE = "margin:0;padding-left:1em;border-left:3px solid #C3D3DA";
// Tables as Word gets them (reference-docx.ts): no lines down, a rule under the header, hairlines between rows.
// Header cells, bold anyway, take the table's left alignment instead of centring. Written on the cell,
// either would come back into Corillo as bold words or a left-aligned column.
const TABLE = "border-collapse:collapse;margin:0;text-align:left";
const CELL = "padding:5px 10px;vertical-align:top";
const HEADER_CELL = `${CELL};border-bottom:1px solid #A9B2B8`;
const ROW_LINE = "border-bottom:1px solid #E3E7E6";
const LAST_LINE = "border-bottom:1px solid #D2D8D7";
const VOID = new Set(["br", "img", "hr", "col", "wbr"]);
/**
 * A task's box, as the page draws it (style.css), and the list marker it takes
 * the place of. The box comes from a symbols font, whose taller line would
 * push the next line down a little; line-height keeps it to the text's.
 */
const taskBox = (item: Node) => `<span class="task-box" style="line-height:1">${item.attrs.checked ? "☒" : "☐"} </span>`;
const TASK = "list-style-type:none";
/** What ProseMirror wraps a copy in when it starts inside a table (as prosemirror-view does), so it reads back the same. */
const WRAP: Record<string, string[]> = {
  thead: ["table"],
  tbody: ["table"],
  tfoot: ["table"],
  caption: ["table"],
  colgroup: ["table"],
  col: ["table", "colgroup"],
  tr: ["table", "tbody"],
  td: ["table", "tbody", "tr"],
  th: ["table", "tbody", "tr"],
};

const escapeText = (s: string) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/\u00A0/g, "&nbsp;");
const escapeAttr = (s: string) => escapeText(s).replace(/"/g, "&quot;");

function attrsHTML(attrs: Record<string, unknown>): string {
  let out = "";
  for (const [name, value] of Object.entries(attrs)) if (value != null) out += ` ${name}="${escapeAttr(String(value))}"`;
  return out;
}

/**
 * HTML for one of the schema's descriptions of its HTML (toDOM), with `inner`
 * in its hole (inside the element itself if it has none, as for a mark).
 * `style` goes first in the outer element's style, so the schema's own (a
 * column's alignment) still wins.
 */
function fromSpec(spec: DOMOutputSpec, inner = "", style?: string): string {
  const found = { hole: false };
  return specHTML(spec, inner, style, found, true);
}

function specHTML(spec: DOMOutputSpec, inner: string, style: string | undefined, found: { hole: boolean }, outer: boolean): string {
  if (typeof spec === "string") return escapeText(spec);
  if (!Array.isArray(spec)) throw new Error("Corillo's schema describes its HTML as arrays");
  const [tag, ...rest] = spec as readonly unknown[];
  let attrs: Record<string, unknown> = {};
  if (rest.length && rest[0] && typeof rest[0] === "object" && !Array.isArray(rest[0])) attrs = rest.shift() as Record<string, unknown>;
  if (style) attrs = { ...attrs, style: attrs.style ? `${style};${String(attrs.style)}` : style };
  const name = String(tag);
  if (VOID.has(name)) return `<${name}${attrsHTML(attrs)}>`;
  let content = "";
  for (const child of rest) {
    if (child === 0) {
      content += inner;
      found.hole = true;
    } else content += specHTML(child as DOMOutputSpec, inner, undefined, found, false);
  }
  if (outer && !found.hole) content += inner;
  return `<${name}${attrsHTML(attrs)}>${content}</${name}>`;
}

interface Writer {
  options: ClipboardOptions;
  /** Whether the file writes the block at this position straight under the one before. */
  close(pos: number): boolean;
}

/** A mark's opening and closing tags. */
function markTags(mark: Mark): [string, string] {
  const [open, close] = fromSpec(mark.type.spec.toDOM!(mark, true), "\u0000").split("\u0000");
  return [open, close];
}

/** The words of a paragraph, heading or cell, with their formatting. */
function inlineHTML(block: Node, w: Writer, inCell = false): string {
  if (block.type.spec.code) return escapeText(block.textContent);
  let out = "";
  const open: Mark[] = [];
  const closing: string[] = [];
  block.forEach((child) => {
    let keep = 0;
    while (keep < open.length && keep < child.marks.length && open[keep].eq(child.marks[keep])) keep++;
    while (open.length > keep) {
      open.pop();
      out += closing.pop();
    }
    for (const mark of child.marks.slice(keep)) {
      const [start, end] = markTags(mark);
      out += start;
      open.push(mark);
      closing.push(end);
    }
    if (child.isText) out += escapeText(child.text!).split(LINE).join(inCell ? "<br>" : LINE_BREAK);
    else if (child.type === schema.nodes.footnote_ref) {
      out += `<sup${attrsHTML({ class: "footnote-ref", "data-label": child.attrs.label })}>${escapeText(w.options.number(child.attrs.label))}</sup>`;
    } else out += fromSpec(child.type.spec.toDOM!(child));
  });
  while (closing.length) out += closing.pop();
  return out;
}

/** How blocks side by side are spaced: as the page's top level, as in a quote or a list spaced with blank lines, or close. */
type Rule = "top" | "spaced" | "close";

/** Blocks side by side, with an empty line before each one the page shows a line of space above. */
function blocksHTML(content: Fragment, start: number, rule: Rule, w: Writer): string {
  let out = "";
  let before: Node | null = null;
  content.forEach((child, offset, i) => {
    const pos = start + offset;
    // At the top, what follows an empty line sits right under it, as on the page.
    if (i > 0 && rule !== "close" && !w.close(pos) && !(rule === "top" && isEmptyLine(before!))) out += GAP;
    out += blockHTML(child, pos, w);
    before = child;
  });
  return out;
}

/** A list's items. Where the page shows a line between two, the item above ends with an empty line, as Word gets it. */
function itemsHTML(list: Node, content: Fragment, start: number, w: Writer): string {
  const tight = !!list.attrs.tight;
  const inner: string[] = [];
  const items: Node[] = [];
  content.forEach((item, offset, i) => {
    const pos = start + offset;
    if (i > 0 && !tight && !w.close(pos)) inner[i - 1] += GAP;
    inner.push(itemContentHTML(item.content, pos + 1, tight, w, item.attrs.checked === null ? "" : taskBox(item)));
    items.push(item);
  });
  return items.map((item, i) => fromSpec(item.type.spec.toDOM!(item), inner[i], item.attrs.checked === null ? undefined : TASK)).join("");
}

/** What a list item holds. In a tight list, its first paragraph's words go straight in the item. `box`: a task's, before them. */
function itemContentHTML(content: Fragment, start: number, tight: boolean, w: Writer, box = ""): string {
  let out = "";
  content.forEach((child, offset, i) => {
    const pos = start + offset;
    if (i > 0 && !tight && !w.close(pos)) out += GAP;
    const first = i === 0 && child.type === schema.nodes.paragraph;
    if (first && tight) out += box + inlineHTML(child, w);
    else if (first && box) out += fromSpec(child.type.spec.toDOM!(child), box + inlineHTML(child, w), FLAT);
    else out += blockHTML(child, pos, w);
  });
  return out;
}

function rowsHTML(rows: Fragment, w: Writer): string {
  let out = "";
  rows.forEach((row, _offset, i) => {
    out += fromSpec(row.type.spec.toDOM!(row), cellsHTML(row.content, i === rows.childCount - 1, w));
  });
  return out;
}

function cellsHTML(cells: Fragment, lastRow: boolean, w: Writer): string {
  let out = "";
  cells.forEach((cell) => {
    const style = cell.type === schema.nodes.table_header ? HEADER_CELL : `${CELL};${lastRow ? LAST_LINE : ROW_LINE}`;
    out += fromSpec(cell.type.spec.toDOM!(cell), inlineHTML(cell, w, true), style);
  });
  return out;
}

function blockHTML(node: Node, pos: number, w: Writer): string {
  const n = schema.nodes;
  const type = node.type;
  const spec = () => type.spec.toDOM!(node);
  if (type === n.paragraph) return fromSpec(spec(), isEmptyLine(node) ? "<br>" : inlineHTML(node, w), FLAT);
  if (type === n.heading) return fromSpec(spec(), inlineHTML(node, w), HEADING);
  if (type === n.bullet_list || type === n.ordered_list) return fromSpec(spec(), itemsHTML(node, node.content, pos + 1, w), FLAT);
  if (type === n.blockquote) return fromSpec(spec(), blocksHTML(node.content, pos + 1, "spaced", w), QUOTE);
  if (type === n.table) return fromSpec(["table", ["tbody", 0]], rowsHTML(node.content, w), TABLE);
  if (type === n.footnote_def) {
    const label = node.attrs.label as string;
    const number = `<span class="footnote-number">${escapeText(w.options.number(label))}. </span>`;
    return `<div${attrsHTML({ class: "footnote-def", "data-label": label, style: FLAT })}>${number}<span>${inlineHTML(node, w)}</span></div>`;
  }
  if (node.isTextblock) return fromSpec(spec(), inlineHTML(node, w), FLAT); // code and blocks shown as written
  if (node.isLeaf) return fromSpec(spec());
  return fromSpec(spec(), blocksHTML(node.content, pos + 1, "spaced", w), FLAT);
}

/** The blocks marked close in a stretch of the document. */
function closeIn(spacing: SpacingMarks | undefined, from: number, to: number): (pos: number) => boolean {
  if (!spacing) return () => false;
  const close = new Set<number>();
  for (const mark of spacing.find(from, to)) if (mark.spec.kind === "joined" || mark.spec.kind === "part") close.add(mark.from);
  return (pos) => close.has(pos);
}

/**
 * The clipboard's formatted text for copied content, a selection's `slice`
 * starting at `from` in the document. It carries ProseMirror's own note of
 * where the copy came from (written as prosemirror-view writes it), so
 * pasting it back into Corillo gives the same document.
 */
export function clipboardHTML(slice: Slice, from: number, options: ClipboardOptions): string {
  let { content, openStart, openEnd } = slice;
  let start = from - openStart; // where the content starts in the document
  const w: Writer = { options, close: closeIn(options.spacing, start, from + slice.size + openEnd) };
  // Single blocks around the words (the list and item a few words are in)
  // aren't written but noted, as ProseMirror does.
  const context: unknown[] = [];
  const around: Node[] = [];
  while (openStart > 1 && openEnd > 1 && content.childCount === 1 && content.firstChild!.childCount === 1) {
    openStart--;
    openEnd--;
    const node = content.firstChild!;
    const defaults = (node.type as unknown as { defaultAttrs: unknown }).defaultAttrs; // not in ProseMirror's types
    context.push(node.type.name, node.attrs !== defaults ? node.attrs : null);
    around.push(node);
    content = node.content;
    start += 1;
  }
  const n = schema.nodes;
  const parent = around[around.length - 1];
  const first = content.firstChild;
  let html: string;
  if (!parent) {
    // Rows of a table (some of its cells selected) aren't blocks of the page.
    if (first?.type === n.table_row) html = rowsHTML(content, w);
    else html = blocksHTML(content, start, first && !schema.topNodeType.contentMatch.matchType(first.type) ? "close" : "top", w);
  } else if (parent.type === n.bullet_list || parent.type === n.ordered_list) html = itemsHTML(parent, content, start, w);
  else if (parent.type === n.list_item) html = itemContentHTML(content, start, !!around[around.length - 2]?.attrs.tight, w);
  else if (parent.type === n.table) html = rowsHTML(content, w);
  else if (parent.type === n.table_row) html = cellsHTML(content, false, w);
  else html = blocksHTML(content, start, "spaced", w);

  const tag = /^<([a-z][a-z0-9]*)/.exec(html)?.[1];
  const wraps = (tag && WRAP[tag]) || [];
  html = wraps.map((t) => `<${t}>`).join("") + html + [...wraps].reverse().map((t) => `</${t}>`).join("");
  const note = `${openStart} ${openEnd}${wraps.length ? ` -${wraps.length}` : ""} ${JSON.stringify(context)}`;
  return html.replace(/^<[a-z][a-z0-9]*/, (opening) => opening + attrsHTML({ ...options.mark, "data-pm-slice": note }));
}

/**
 * Corillo's own copy, read back: a paragraph's own line breaks (written as
 * line breaks for other apps) are line breaks in its text again, as the file
 * has them.
 */
export function linesFromClipboard(slice: Slice): Slice {
  const content = linesIn(slice.content);
  return content === slice.content ? slice : new Slice(content, slice.openStart, slice.openEnd);
}

function linesIn(fragment: Fragment): Fragment {
  let changed = false;
  const nodes: Node[] = [];
  fragment.forEach((node) => {
    let next = node;
    if (node.type === schema.nodes.hard_break && node.attrs.markup === LINE) next = schema.text(LINE, node.marks);
    else if (!node.isLeaf && !node.isText) {
      const inner = linesIn(node.content);
      if (inner !== node.content) next = node.copy(inner);
    }
    if (next !== node) changed = true;
    nodes.push(next);
  });
  return changed ? Fragment.fromArray(nodes) : fragment;
}

// Copy for Email ------------------------------------------------------------------------

/** The words up to a paragraph's first line break, and where its next line starts (null: it has one line). */
function firstLine(block: Node): { text: string; next: number | null } {
  let text = "";
  let next: number | null = null;
  block.forEach((child, offset) => {
    if (next !== null) return;
    if (child.type === schema.nodes.hard_break) next = offset + child.nodeSize;
    else if (child.isText) {
      const at = child.text!.indexOf(LINE);
      text += at < 0 ? child.text : child.text!.slice(0, at);
      if (at >= 0) next = offset + at + 1;
    }
  });
  return { text, next };
}

const SUBJECT = /^\s*subject:\s*/i;

/**
 * What Copy for Email copies: the whole document from its first words to its
 * last, without the document details at the top (front matter) or a first
 * line that starts "Subject:", whose words are given back as the subject.
 * Null when the document has no words.
 */
export function emailBody(doc: Node): { subject: string | null; from: number; to: number } | null {
  const n = schema.nodes;
  const starts: number[] = [];
  const words: number[] = [];
  doc.forEach((node, pos, i) => {
    starts.push(pos);
    if (!isEmptyLine(node) && !(node.type === n.raw_block && node.attrs.kind === "front-matter")) words.push(i);
  });
  if (!words.length) return null;
  const last = words[words.length - 1];
  const to = starts[last] + doc.child(last).nodeSize;
  const lead = doc.child(words[0]);
  if (lead.type !== n.paragraph && lead.type !== n.heading) return { subject: null, from: starts[words[0]], to };
  const line = firstLine(lead);
  const said = SUBJECT.exec(line.text);
  if (!said) return { subject: null, from: starts[words[0]], to };
  const subject = line.text.slice(said[0].length).trim();
  // The email starts on the subject's next line, or at the next block with words.
  if (line.next !== null) return { subject, from: starts[words[0]] + 1 + line.next, to };
  return words.length > 1 ? { subject, from: starts[words[1]], to } : { subject, from: to, to };
}

// What an email leaves out (review of Batch 1, B1-01) ------------------------------------
//
// Copy for Email copies the whole document, unseen, for someone else to read.
// So it reads the way the page reads in the preview and the Word export: what
// the page marks as hidden in Word (comments, %% and <!-- -->) or left out of
// it (link definitions) isn't in it, nor are Obsidian's block ids, and a link
// to a note is the words it shows, since the reader can't follow it. A
// picture embedded the Obsidian way is left out: pictures don't travel in a
// pasted email.

const HTML_COMMENT = /<!--[\s\S]*?-->/g;

/** A paragraph's text as findObsidian reads it: code and anything that isn't text hidden, a line break as one. */
function shownText(block: Node): string {
  let text = "";
  block.forEach((child) => {
    if (child.isText) text += child.marks.some((m) => m.type === schema.marks.code) ? PICTURE_STAND_IN.repeat(child.text!.length) : child.text;
    else text += child.type === schema.nodes.hard_break ? "\n" : PICTURE_STAND_IN.repeat(child.nodeSize);
  });
  return text;
}

/** A raw block's text with its comments taken out (null: none in it). */
function withoutComments(text: string): string | null {
  let out = text.replace(HTML_COMMENT, "");
  for (const f of findObsidian(out).reverse()) if (f.kind === "comment") out = out.slice(0, f.from) + out.slice(f.to);
  return out === text ? null : out;
}

/**
 * The document as an email gets it (see above), and the page's spacing marks
 * moved to match. Where something left out was all a paragraph held, the
 * paragraph goes too, so one line apart stays one. `mapping` takes a place in
 * the document to its place in what an email gets (none: they're the same),
 * so Read Aloud can mark on the page the words it reads from it.
 */
export function forEmail(doc: Node, spacing?: SpacingMarks): { doc: Node; spacing?: SpacingMarks; mapping?: Mapping } {
  const tr = new Transform(doc);
  const n = schema.nodes;
  const whole = (pos: number, node: Node) => ({ from: pos, to: pos + node.nodeSize });

  // First the blocks. A paragraph Corillo keeps as written because of a <!-- -->
  // comment in it is read again without the comment, with the document's link
  // definitions, so its links and formatting come out as on the page.
  const definitions: string[] = [];
  doc.forEach((node) => {
    if (node.type === n.raw_block && node.attrs.kind === "links") definitions.push(node.textContent);
  });
  const blocks: { from: number; to: number; left?: string }[] = [];
  doc.descendants((node, pos) => {
    if (node.type !== n.raw_block) return node.isTextblock ? false : true;
    const kind = node.attrs.kind as string;
    if (kind === "comment" || kind === "links") blocks.push(whole(pos, node));
    else if (kind === "markdown" || kind === "html") {
      const left = withoutComments(node.textContent);
      if (left !== null) blocks.push({ ...whole(pos, node), left: left.trim() ? left : undefined });
    }
    return false;
  });
  for (const b of blocks) {
    const from = tr.mapping.map(b.from, 1);
    const to = tr.mapping.map(b.to, -1);
    if (b.left === undefined) {
      tr.deleteRange(from, to);
      continue;
    }
    const read = parseMarkdown([b.left, ...definitions].join("\n\n")).doc;
    const content: Node[] = [];
    read.forEach((block) => {
      if (!(block.type === n.raw_block && block.attrs.kind === "links") && !isEmptyLine(block)) content.push(block);
    });
    if (content.length === 1 && content[0].isTextblock) {
      // The block stays where it was, so its spacing mark stays with it.
      tr.setNodeMarkup(from, content[0].type, content[0].attrs);
      tr.replaceWith(from + 1, to - 1, content[0].content);
    } else tr.replaceWith(from, to, content);
  }

  // Then the words.
  type WordChange = { from: number; to: number; text?: string; marks?: readonly Mark[]; block?: true };
  const changes: WordChange[] = [];
  const unref: { from: number; to: number; mark: Mark }[] = [];
  tr.doc.descendants((node, pos) => {
    if (!node.isTextblock) return true;
    if (node.type.spec.code || node.type === n.raw_block) return false;
    // A link written by reference is written out, its definitions being left out.
    node.forEach((child, offset) => {
      const link = child.marks.find((m) => m.type === schema.marks.link && m.attrs.ref);
      if (link) unref.push({ from: pos + 1 + offset, to: pos + 1 + offset + child.nodeSize, mark: link });
    });
    const text = shownText(node);
    const found = findObsidian(text).filter((f) => f.kind === "comment" || f.kind === "blockid" || f.kind === "link" || f.kind === "embed");
    if (!found.length) return false;
    let words = text;
    for (const f of [...found].reverse()) {
      const shown = f.link && !(f.kind === "embed" && isPicture(f.link.path)) ? linkText(f.link) : "";
      words = words.slice(0, f.from) + shown + words.slice(f.to);
    }
    if (!words.replace(new RegExp(PICTURE_STAND_IN, "g"), "x").trim()) {
      changes.push({ ...whole(pos, node), block: true });
      return false;
    }
    for (const f of found) {
      const from = pos + 1 + f.from;
      const shown = f.link && !(f.kind === "embed" && isPicture(f.link.path)) ? linkText(f.link) : "";
      // A block id goes with the space before it.
      const start = f.kind === "blockid" && /[ \t]/.test(text[f.from - 1] ?? "") ? from - 1 : from;
      changes.push({ from: start, to: pos + 1 + f.to, text: shown, marks: node.childAfter(f.from).node?.marks ?? [] });
    }
    return false;
  });
  if (!tr.steps.length && !changes.length && !unref.length) return { doc, spacing };
  for (const u of unref) tr.addMark(u.from, u.to, schema.marks.link.create({ ...u.mark.attrs, ref: null, refForm: null }));
  const done = tr.steps.length;
  for (const c of changes) {
    const since = tr.mapping.slice(done);
    const from = since.mapResult(c.from, 1);
    const to = since.mapResult(c.to, -1);
    if (from.deleted && to.deleted) continue; // inside something already left out
    if (c.block) tr.deleteRange(from.pos, to.pos);
    else if (c.text) tr.replaceWith(from.pos, to.pos, schema.text(c.text, c.marks));
    else tr.delete(from.pos, to.pos);
  }
  if (!spacing) return { doc: tr.doc, spacing, mapping: tr.mapping };
  const marks = spacing.find().flatMap((m) => {
    const mapped = tr.mapping.mapResult(m.from, 1);
    return mapped.deleted ? [] : [{ from: mapped.pos, spec: m.spec }];
  });
  return { doc: tr.doc, spacing: { find: (from = 0, to = Infinity) => marks.filter((m) => m.from >= from && m.from <= to) }, mapping: tr.mapping };
}
