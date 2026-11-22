// Writing a block as Markdown: lists, code, pictures, tables, and links by reference while their label is defined.
import { MarkdownSerializerState, defaultMarkdownSerializer } from "prosemirror-markdown";
import { Mark, type Attrs, type Node } from "prosemirror-model";
import { TableMap } from "prosemirror-tables";
import { schema } from "./schema";
import { md } from "./markdown-tokens";
import { altText } from "./markdown-alt";
import { CELL_TEXT, CODE_PIPE, FaithfulSerializer, FaithfulState, backticks, emphasis, optionsOf, planFor, planWithin, quotedTitle, restore, type SerializeOptions } from "./markdown-inline";
import { FOOTNOTE_START, isEmptyLine } from "./markdown-read";

const base = defaultMarkdownSerializer;

/** Write a text node: escaped, except where it is Obsidian's syntax. */
function writeText(state: MarkdownSerializerState, node: Node, parent: Node, index: number): void {
  const s = state as unknown as { inAutolink?: boolean; atBlockStart: boolean };
  const text = node.text!;
  const lines = restore;
  if (s.inAutolink) {
    state.text(lines(text), false);
    return;
  }
  const plan = planFor(parent);
  // The library may have trimmed spaces off the node's ends (to put them
  // outside bold or italic); the rest is the same text.
  const whole = parent.maybeChild(index)?.text ?? text;
  const at = plan.starts[index] + Math.max(0, whole.indexOf(text));
  const end = at + text.length;
  const cuts: { from: number; to: number; raw: string }[] = [];
  const within = planWithin(plan, at, end);
  for (const k of within.kept) cuts.push({ ...k, raw: text.slice(k.from - at, k.to - at) });
  for (const e of within.escape) cuts.push({ from: e, to: e + 1, raw: "\\" + text[e - at] });
  if (text === whole && bracketedLinkWords(node, parent, index)) cuts.push({ from: at, to: at + 1, raw: "[" }, { from: end - 1, to: end, raw: "]" });
  if (!cuts.length) {
    state.text(lines(text));
    return;
  }
  cuts.sort((a, b) => a.from - b.from);
  let pos = at;
  const put = (t: string, escape: boolean) => {
    if (!t) return;
    state.text(lines(t), escape);
    s.atBlockStart = false;
  };
  for (const cut of cuts) {
    put(text.slice(pos - at, cut.from - at), true);
    put(cut.raw, false);
    pos = cut.to;
  }
  put(text.slice(pos - at), true);
}

/**
 * Whether a link's words are all in brackets, as AI tools write their sources
 * ("[1]", in [[1]](https://...)), and read back the same with the brackets
 * written as they are: then they're kept so, with no backslashes the person
 * never typed. Not when the words in them would read as a link of their own
 * (a label the document defines, a note marker) or as anything but words.
 */
function bracketedLinkWords(node: Node, parent: Node, index: number): boolean {
  const link = node.marks.find((m) => m.type.name === "link");
  if (!link || link.isInSet(parent.maybeChild(index - 1)?.marks ?? []) || link.isInSet(parent.maybeChild(index + 1)?.marks ?? [])) return false;
  const m = /^\[([^[\]\\`^\n\uE000-\uE004]+)\]$/.exec(node.text!);
  if (!m || writing?.defined(m[1])) return false;
  const toks = md.parseInline(`[${node.text}](x)`, {})[0]?.children ?? [];
  return toks.length === 3 && toks[0].type === "link_open" && toks[1].type === "text" && toks[1].content === node.text;
}

/**
 * A list inside a tight list, right under a paragraph line, that couldn't
 * start there: an empty first item ("-" would underline the line above as a
 * heading) or a numbered list not starting at 1. It gets a blank line
 * before it (which spaces out the list around it, the only way Markdown can
 * hold it).
 */
function separateNestedList(state: MarkdownSerializerState, node: Node): void {
  const s = state as unknown as { closed: Node | null; inTightList: boolean; flushClose(size: number): void };
  if (!s.inTightList || s.closed?.type.name !== "paragraph") return;
  if (separates(node)) s.flushClose(2);
}

/** Whether a list can't start right under a line of words (separateNestedList). */
function separates(list: Node): boolean {
  const first = list.firstChild;
  const empty = !!first && first.attrs.checked === null && first.childCount > 0 && (first.child(0).content.size === 0 || markerLineBlank(first, list));
  return empty || (list.type.name === "ordered_list" && (list.attrs.order ?? 1) !== 1);
}

/**
 * How many of a list item's or quote's first paragraphs hold nothing (empty,
 * or only spaces) before a block that holds something. Markdown can't hold
 * them there: a list item that starts with a blank line ends at the next
 * one, so a heading under it would leave the list (row 61, R22-14). They
 * aren't written, as a quote's empty lines never were: what follows starts
 * the item or quote, and reads back as it is on the page.
 */
function blankFirstLines(node: Node): number {
  if (node.attrs.checked != null) return 0; // (a task's box is on its first line)
  let k = 0;
  while (k < node.childCount - 1 && writesNothing(node.child(k))) k++;
  return k;
}

/**
 * A list item's or quote's blocks, as written: after its first, a paragraph
 * that holds nothing isn't written either, wherever it is (Markdown keeps no
 * empty paragraph there: one of spaces would leave a line of only the
 * quote's sign or the item's indent, gone at the next save).
 */
function renderInside(state: MarkdownSerializerState, node: Node): void {
  const s = state as unknown as { closed: Node | null; flushClose(size: number): void };
  const written = writtenBlocks(node);
  const tight = staysTight(state, node, written);
  written.forEach((i, k) => {
    let child = node.child(i);
    if (tight && s.closed) {
      const kind = child.type.name;
      if (underBox(node, written, k)) {
        if (kind === "horizontal_rule" || kind === "heading") s.flushClose(1);
        // ("---" right under the box would underline it as a heading.)
        if (kind === "horizontal_rule" && /^-+$/.test(child.attrs.markup)) child = child.type.create({ ...child.attrs, markup: "***" });
      } else if (FULL_LINE.includes(s.closed.type.name)) s.flushClose(1);
    }
    state.render(child, node, i);
  });
}

/**
 * A task's box line when the task starts with something other than words
 * (a rule put at the start of its words, say): the box is a line of its own,
 * as a task with no words reads from a file, and what follows comes under it
 * as under a line of words.
 */
const BOX_LINE = schema.node("paragraph");
const startsWithBox = (item: Node) => item.attrs.checked != null && item.child(0).type.name !== "paragraph";

/** Whether the item's written block `k` comes right under a task's box line that holds nothing else. */
function underBox(item: Node, written: number[], k: number): boolean {
  if (item.attrs.checked == null) return false;
  if (startsWithBox(item)) return k === 0;
  return k === 1 && writesNothing(item.child(written[0]));
}

/** Blocks that end with a line of their own, so any block but a table can start on the next line. */
const FULL_LINE = ["horizontal_rule", "heading", "code_block"];

/**
 * Whether a list item in a list without blank lines can be written with none
 * between its blocks either (a blank line there would space out the whole
 * list when it's read back, so a second save would differ). Under a task's
 * box line with no words, a rule or heading follows on the next line, as
 * code, a quote or a list follow a line of words; after a rule, a heading or
 * code, any block but a table does. When one gap needs a blank line anyway,
 * the item is written as before, with blank lines.
 */
function staysTight(state: MarkdownSerializerState, item: Node, written: number[]): boolean {
  return item.type.name === "list_item" && (state as unknown as { inTightList: boolean }).inTightList && linesAdded(item, written);
}

/** Whether staysTight's rules write each of a list item's blocks with no blank line before it, at least one on a line they add. */
function linesAdded(item: Node, written: number[]): boolean {
  let added = false;
  for (let k = startsWithBox(item) ? 0 : 1; k < written.length; k++) {
    const next = item.child(written[k]);
    const kind = next.type.name;
    const box = underBox(item, written, k);
    const prev = k > 0 ? item.child(written[k - 1]).type.name : "paragraph";
    if (box && (kind === "horizontal_rule" || kind === "heading")) added = true;
    else if (FULL_LINE.includes(prev) && kind !== "table") added = true;
    else if (prev !== "paragraph" || !(kind === "code_block" || kind === "blockquote" || ((kind === "bullet_list" || kind === "ordered_list") && !separates(next)))) return false;
  }
  return added;
}

/** A paragraph of only spaces and line breaks, none of them code or a link (a space in code or a link is written). */
function writesNothing(node: Node): boolean {
  if (!isEmptyLine(node)) return false;
  let plain = true;
  node.forEach((child) => {
    if (child.marks.some((m) => m.type.name === "code" || m.type.name === "link")) plain = false;
  });
  return plain;
}

/** The indexes of a list item's or quote's blocks that are written (renderInside). */
function writtenBlocks(node: Node): number[] {
  const first = blankFirstLines(node);
  const written: number[] = [];
  for (let i = first; i < node.childCount; i++) if (i === first || !writesNothing(node.child(i))) written.push(i);
  return written;
}

/**
 * Whether an item of a list without blank lines is still written with a
 * blank line between two of its blocks: a table, a rule, a heading or more
 * words under its words, say. (Pandoc reads a table under words only after
 * a blank line, and "---" under words would underline them.) When staysTight
 * can't keep the item close, each block is written as the library writes it
 * in a list without blank lines: code, a quote or a list under words follow
 * on the next line, anything else after a blank line.
 */
function blankInside(item: Node): boolean {
  const written = writtenBlocks(item);
  if (linesAdded(item, written)) return false;
  for (let k = startsWithBox(item) ? 0 : 1; k < written.length; k++) {
    const prev = k > 0 ? item.child(written[k - 1]) : BOX_LINE;
    const next = item.child(written[k]);
    const kind = next.type.name;
    if (kind === "bullet_list" || kind === "ordered_list") {
      if (prev.type.name === "paragraph" ? separates(next) : joinsList(prev, next) ? !(prev.attrs.tight && next.attrs.tight) : prev.type === next.type && separates(next)) return true;
    } else if (prev.type.name !== "paragraph" || !(kind === "code_block" || kind === "blockquote")) return true;
  }
  return false;
}

/**
 * A list without blank lines between its items whose item is written with
 * one inside it anyway (blankInside): read back, Markdown takes that blank
 * line to space out the whole list, so a second save would add one between
 * the items too. Written spaced out from the first save instead, the second
 * save adds nothing (row 62).
 */
function spacedOut(list: Node): Node {
  if (!list.attrs.tight) return list;
  let blank = false;
  list.forEach((item) => {
    if (!blank && item.type.name === "list_item" && blankInside(item)) blank = true;
  });
  return blank ? list.type.create({ ...list.attrs, tight: false }, list.content, list.marks) : list;
}

/**
 * A rule first in a list item, written with the bullet's own sign, can't
 * start the item's marker line ("- ---" and "* ***" are a rule across the
 * page): it goes on the line under it. Any other ("1. ---", "* ---") stays.
 */
function ruleFirst(item: Node, list: Node): boolean {
  const lead = item.maybeChild(blankFirstLines(item));
  return lead?.type.name === "horizontal_rule" && signOf(list) === (lead.attrs.markup || "---")[0];
}

/** Whether a list item's marker line will hold nothing: only blank lines in the item, or a rule first that goes under it. */
const markerLineBlank = (item: Node, list: Node) => item.attrs.checked === null && (writesNothing(item.child(blankFirstLines(item))) || ruleFirst(item, list));

/**
 * Whether a list starting on its parent's bullet line would make that line
 * three or more of the same sign ("- - - " or "* * * ", items holding nothing
 * before the next list), which Markdown reads as a rule: then it goes on the
 * line under the bullet ("- - " then "    - "), as a rule first in an item does.
 */
function makesRule(state: MarkdownSerializerState, list: Node): boolean {
  const sign = signOf(list);
  if (sign !== "-" && sign !== "*") return false;
  const out = (state as unknown as { out: string }).out;
  const line = out.slice(out.lastIndexOf("\n") + 1);
  const before = /(?:^|[^-*+ ]) *((?:[-*+] +)*)$/.exec(line)?.[1].trim().split(/ +/) ?? [];
  let same = 0;
  while (same < before.length && before[before.length - 1 - same] === sign) same++;
  return same >= 2 && onlySigns(list, sign);
}

const signOf = (list: Node) => (list.type.name === "bullet_list" ? list.attrs.bullet || "*" : "");

/** Whether a list's first line holds only its own bullets of `sign`, down through lists starting on it, and nothing after. */
function onlySigns(list: Node, sign: string): boolean {
  const item = list.firstChild;
  if (signOf(list) !== sign || !item || item.attrs.checked != null) return false;
  const lead = item.child(blankFirstLines(item));
  return writesNothing(lead) || ruleFirst(item, list) || (lead.type.name === "bullet_list" && onlySigns(lead, sign));
}

/**
 * Two lists of the same kind next to each other (left so when what was
 * between them was deleted) are one list to Markdown, so they're written as
 * one, as Word joins them: without blank lines if neither had any. (Other
 * bullets or numbering keep two lists apart, so those stay two.)
 */
function joinsList(a: Node | null | undefined, b: Node): boolean {
  if (!a || a.type !== b.type) return false;
  if (b.type.name === "bullet_list") return a.attrs.bullet === b.attrs.bullet;
  return b.type.name === "ordered_list" && a.attrs.delim === b.attrs.delim;
}
const listGap = (a: Node, b: Node, eol: string) => (a.attrs.tight && b.attrs.tight ? eol : eol + eol);

function joinList(state: MarkdownSerializerState, node: Node): void {
  const s = state as unknown as { closed: Node | null; flushClose(size: number): void };
  if (s.closed && joinsList(s.closed, node)) s.flushClose(listGap(s.closed, node, "\n").length);
}

/**
 * Two lists of one kind side by side in a list without blank lines, kept two
 * by their other bullet or numbering ("-" then "*", "1." then "1)"): the
 * library writes two blank lines between them, which read back would space
 * out the list around them, so the next save would add blank lines between
 * its items. The second starts on the next line instead, as Markdown reads a
 * new list there; one that can't start under a line of words (separates)
 * keeps one blank line, and the list around it is written spaced out
 * (blankInside).
 */
function nextList(state: MarkdownSerializerState, node: Node): void {
  const s = state as unknown as { closed: Node | null; inTightList: boolean; flushClose(size: number): void };
  if (s.inTightList && s.closed?.type === node.type) s.flushClose(separates(node) ? 2 : 1);
}

/**
 * In a list without blank lines, code or a quote straight after a paragraph
 * in the same item follows it on the next line: a blank line would space the
 * whole list out. (Each of them can start right under a paragraph. A table
 * can for the editor but not for Pandoc, which would show its pipes in Word
 * and PDF: it keeps its blank line, and the list is spaced out.)
 */
function keepTight(state: MarkdownSerializerState): void {
  const s = state as unknown as { closed: Node | null; inTightList: boolean; flushClose(size: number): void };
  if (s.inTightList && s.closed?.type.name === "paragraph") s.flushClose(1);
}

const serializer = new FaithfulSerializer(
  {
    ...base.nodes,
    blockquote(state, node) {
      keepTight(state);
      state.wrapBlock("> ", null, node, () => renderInside(state, node));
    },
    bullet_list(state, list, parent, index) {
      const node = spacedOut(list);
      separateNestedList(state, node);
      joinList(state, node);
      nextList(state, node);
      if (makesRule(state, node)) state.ensureNewLine();
      base.nodes.bullet_list(state, node, parent, index);
    },
    ordered_list(state, list) {
      const node = spacedOut(list);
      separateNestedList(state, node);
      joinList(state, node);
      nextList(state, node);
      const start: number = node.attrs.order ?? 1;
      const delim: string = node.attrs.delim || ".";
      const maxW = String(start + node.childCount - 1).length;
      const space = state.repeat(" ", maxW + 2);
      state.renderList(node, space, (i) => {
        const n = String(start + i);
        return state.repeat(" ", maxW - n.length) + n + delim + " ";
      });
    },
    code_block(state, node) {
      keepTight(state);
      let fence: string = node.attrs.fence || "```";
      const ch = fence[0];
      const runs = node.textContent.match(new RegExp(`\\${ch}{3,}`, "g"));
      if (runs) {
        const longest = runs.reduce((m, r) => Math.max(m, r.length), 0);
        if (longest >= fence.length) fence = ch.repeat(longest + 1);
      }
      state.write(fence + (node.attrs.params || "") + "\n");
      state.text(node.textContent, false);
      state.write("\n");
      state.write(fence);
      state.closeBlock(node);
    },
    raw_block(state, node) {
      state.text(node.textContent, false);
      state.closeBlock(node);
    },
    image(state, node, parent, index) {
      const alt = altText(node.attrs.alt || "");
      const ref = referenceTail(node.attrs, alt, parent.maybeChild(index + 1));
      state.write(ref !== null ? `![${alt}]${ref}` : `![${alt}](${destination(node.attrs.src)}${quotedTitle(node.attrs.title)})`);
    },
    table(state, node) {
      for (const line of tableLines(node)) {
        state.write(line);
        state.ensureNewLine();
      }
      state.closeBlock(node);
    },
    footnote_ref(state, node) {
      state.write(`[^${node.attrs.label}]`);
    },
    heading(state, node) {
      state.write(state.repeat("#", node.attrs.level) + " ");
      const s = state as unknown as FaithfulState;
      // From the space after the heading's own marks: those, and a list's or quote's, aren't its words.
      const words = s.size - 1;
      state.renderInline(node, false);
      s.escapeClosingHashes(words);
      state.closeBlock(node);
    },
    // A line break only counts before more text: with nothing but spaces
    // after it, its backslash would be left in the text.
    hard_break(state, node, parent, index) {
      // In a table cell: "<br>", as the table wrote it (a row is one line).
      const options = optionsOf(state);
      if (options.inCell) {
        state.write(node.attrs.markup ?? options.br ?? "<br>");
        return;
      }
      // In a paragraph, a "<br>" the file wrote stays one.
      if (node.attrs.markup) {
        state.write(node.attrs.markup);
        return;
      }
      for (let i = index + 1; i < parent.childCount; i++) {
        const next = parent.child(i);
        if (next.type === node.type || (next.isText && !/\S/.test(next.text ?? ""))) continue;
        state.write("\\\n");
        return;
      }
    },
    // A task list item's box, before its text.
    list_item(state, node, parent) {
      if (node.attrs.checked !== null) {
        state.write(node.attrs.checked ? "[x] " : "[ ] ");
        if (startsWithBox(node)) (state as unknown as { closed: Node | null }).closed = BOX_LINE;
      } else if (ruleFirst(node, parent)) state.ensureNewLine();
      renderInside(state, node);
    },
    // A note's lines after the first are indented, so they stay in the note.
    footnote_def(state, node) {
      state.wrapBlock("    ", `[^${node.attrs.label}]: `, node, () => state.renderInline(node));
    },
    text: writeText,
  },
  {
    ...base.marks,
    em: emphasis("*", "em"),
    strong: emphasis("**", "strong"),
    strike: emphasis("~~", "s"),
    // Code with a space at each end keeps them: Markdown takes one off each
    // side when both are there, so they are written doubled.
    code: {
      open: (_state, _mark, parent, index) => backticks(parent.child(index), "open"),
      close: (_state, _mark, parent, index) => backticks(parent.child(index - 1), "close"),
      escape: false,
    },
    link: {
      open(state, mark, parent, index) {
        const s = state as unknown as FaithfulState;
        const auto = !(mark.attrs.ref && writing?.defined(mark.attrs.ref)) && isAutolink(mark, parent, index);
        s.inAutolink = auto;
        return auto ? "<" : "[";
      },
      close(state, mark, parent, index) {
        const s = state as unknown as FaithfulState;
        const auto = s.inAutolink;
        s.inAutolink = undefined;
        if (auto) return ">";
        const ref = mark.attrs.ref ? referenceTail(mark.attrs, s.since(s.linkFrom ?? s.size), parent.maybeChild(index)) : null;
        if (ref !== null) return "]" + ref;
        return `](${destination(mark.attrs.href)}${quotedTitle(mark.attrs.title)})`;
      },
      mixable: true,
    },
  },
  // (Escaping is done by FaithfulState.esc.)
  {},
);

/**
 * A link or picture address as Markdown. Addresses are kept URL-encoded in the
 * editor; in the file they are written readably, with %20 for each space
 * (such as a "Proposal%20images/chart.png" picture).
 */
function destination(url: string): string {
  // Only what Markdown's reader would encode again in the very same way is
  // decoded: letters from other alphabets, and a few signs ("{", "[", "|").
  // A "%25" stays as it is (decoded, "%2520" would become "%20", another
  // address), and so do spaces (%20, the form Obsidian's help gives) and
  // anything that would end the address.
  const readable = url
    .replace(/(?:%[C-F][0-9A-F](?:%[89AB][0-9A-F])+)+/g, (run) => {
      let text: string;
      try {
        text = decodeURIComponent(run);
      } catch {
        return run;
      }
      return encodeURIComponent(text) === run && !/[\s\p{C}]/u.test(text) ? text : run;
    })
    .replace(/%([2-7][0-9A-F])/g, (m, hex: string) => {
      const c = String.fromCharCode(parseInt(hex, 16));
      return READABLE_SIGNS.includes(c) ? c : m;
    });
  // Spaces and other characters that would end the address, written by
  // hand in the link box, are encoded; a backslash before punctuation would
  // be read as an escape: doubled.
  return readable
    .replace(/[\s\p{Cc}<>]/gu, (c) => encodeURIComponent(c))
    .replace(/\\(?=[!-/:-@[-`{-~])/g, "\\\\")
    .replace(/[()]/g, "\\$&");
}
const READABLE_SIGNS = '"[]^`{|}';

/** A bare web address written as <https://...>, as markdown-it read it. */
function isAutolink(mark: Mark, parent: Node, index: number): boolean {
  if (mark.attrs.title || !/^\w+:/.test(mark.attrs.href)) return false;
  const content = parent.child(index);
  if (!content.isText || content.text !== mark.attrs.href || content.marks[content.marks.length - 1] !== mark) {
    return false;
  }
  return index === parent.childCount - 1 || !mark.isInSet(parent.child(index + 1).marks);
}

// Each cell's text, once written, so typing in a big table writes one cell
// again, not all of them. (Like blocks, a cell is never changed in place.)
const cells = new WeakMap<Node, { br: string; text: string; labels: Used[] }>();

/** Text of one table cell, with pipes escaped so they stay inside the cell. */
function cellText(cell: Node, br: string): string {
  const known = cells.get(cell);
  if (known && known.br === br && (!known.labels.length || (writing && known.labels.every(asBefore(writing.defined))))) {
    writing?.labels.push(...known.labels);
    return known.text;
  }
  const outer = writing;
  writing = outer && { defined: outer.defined, labels: [] };
  try {
    const text = writeCell(cell, br);
    cells.set(cell, { br, text, labels: writing?.labels ?? [] });
    outer?.labels.push(...(writing?.labels ?? []));
    return text;
  } finally {
    writing = outer;
  }
}

function writeCell(cell: Node, br: string): string {
  const para = schema.node("paragraph", null, cell.content);
  CELL_TEXT.add(para);
  // Every pipe is escaped, so it stays inside the cell; one that already is
  // (in a [[Note\|alias]] link) as it is. In code each gets a backslash of its
  // own, which the table takes off again before the code is read: code
  // ending in "\|" keeps its backslash. (Not if the cell holds the very
  // character that marks them.)
  const codePipes = !cell.textContent.includes(CODE_PIPE);
  const options: SerializeOptions = { inCell: true, br, codePipes };
  const out = serializer.serialize(schema.node("doc", null, [para]), options as Record<string, unknown>).replace(/\n+$/, "");
  const escaped = out
    .replace(/\n/g, " ")
    .replace(/(\\*)\|/g, (m, slashes: string) => (slashes.length % 2 === 0 ? `${slashes}\\|` : m));
  return codePipes ? escaped.replaceAll(CODE_PIPE, "\\|") : escaped;
}

/** How wide a table's rows may be, lined up, before its columns aren't. */
const TABLE_WIDTH = 100;

/** A table as Markdown lines, columns padded so it reads well as text too. */
function tableLines(table: Node): string[] {
  // Markdown tables are a plain grid: a merged cell (pasted from elsewhere)
  // keeps its text in its first square and leaves the others empty.
  const map = TableMap.get(table);
  const rows: string[][] = [];
  const aligns: (string | null)[] = [];
  // Line breaks in cells are written the way this table already writes them.
  let br = "<br>";
  let found = false;
  table.descendants((node) => {
    if (found) return false;
    if (node.type.name === "hard_break" && node.attrs.markup) {
      br = node.attrs.markup;
      found = true;
    }
    return true;
  });
  for (let r = 0; r < map.height; r++) {
    const cells: string[] = [];
    for (let c = 0; c < map.width; c++) {
      // A row with fewer cells than the others (pasted from elsewhere, say)
      // has gaps in the map: those squares are left empty.
      const offset = map.map[r * map.width + c];
      const cell = table.nodeAt(offset);
      if (!cell || !/^table_(cell|header)$/.test(cell.type.name)) {
        cells.push("");
        continue;
      }
      const rect = map.findCell(offset);
      cells.push(rect.left === c && rect.top === r ? cellText(cell, br) : "");
      if (r === 0) aligns[c] = cell.attrs.align;
    }
    rows.push(cells);
  }
  const cols = map.width;
  let widths = Array.from({ length: cols }, (_, c) => rows.reduce((m, r) => Math.max(m, (r[c] ?? "").length), 3));
  // Columns are lined up only while the widest row stays short: one long cell
  // would pad every row to its width (and agents read every space). Past
  // that, each cell has one space either side.
  const lined = widths.reduce((sum, w) => sum + w + 3, 1) <= TABLE_WIDTH;
  if (!lined) widths = widths.map(() => 3);
  const line = (cells: string[]) => `| ${widths.map((w, c) => (cells[c] ?? "").padEnd(lined ? w : 0)).join(" | ")} |`;
  const rule = widths.map((w, c) => {
    const a = aligns[c];
    if (a === "left") return ":" + "-".repeat(w - 1);
    if (a === "right") return "-".repeat(w - 1) + ":";
    if (a === "center") return ":" + "-".repeat(w - 2) + ":";
    return "-".repeat(w);
  });
  return [line(rows[0] ?? []), `| ${rule.join(" | ")} |`, ...rows.slice(1).map(line)];
}

// Each block's Markdown, once written: a block is never changed in place, so
// its text can be reused for as long as it stays in the document.
const written = new WeakMap<Node, { eol: string; text: string; labels: Used[] }>();

function serializeBlock(node: Node, eol: string, defined: Defined): string {
  const known = written.get(node);
  if (known && known.eol === eol && known.labels.every(asBefore(defined))) return known.text;
  const outer = writing;
  writing = { defined, labels: [] };
  try {
    const text = writeBlock(node, eol);
    written.set(node, { eol, text, labels: writing.labels });
    return text;
  } finally {
    writing = outer;
  }
}

// Reference links ------------------------------------------------------------------
// A link or picture read as "[words][label]" is written that way again while
// the document still defines the label (in its "[label]: address" lines);
// otherwise, or when copied, with its address.
type Defined = (label: string) => boolean;
/** A label a block's link or picture is by, and whether the document defined it when the block was written. */
type Used = { label: string; defined: boolean };
/** Whether text written with these labels still holds: each one defined, or not, as it was then. */
const asBefore = (defined: Defined) => (used: Used) => defined(used.label) === used.defined;
/** While a block is being written: the labels the document defines, and those the block used. */
let writing: { defined: Defined; labels: Used[] } | null = null;
const labelsIn = new WeakMap<Node, Set<string>>();

/** Which labels a document defines, worked out only if a block asks. */
function definitionsOf(doc: Node): Defined {
  let labels: Set<string> | null = null;
  return (label) => {
    if (!labels) {
      labels = new Set();
      for (let k = 0; k < doc.childCount; k++) {
        const child = doc.child(k);
        if (child.type.name !== "raw_block") continue;
        let found = labelsIn.get(child);
        if (!found) {
          const env: { references?: Record<string, unknown> } = {};
          const text = child.textContent;
          // The rest of a longer note, read as the note reads it: its lines one level (four columns) in.
          const rest = child.attrs.kind === "definitions" && !FOOTNOTE_START.test(text);
          if (text.includes("]:")) md.parse(rest ? text.replace(/^(?: {0,3}\t| {4}| {0,3}(?! ))/gm, "") : text, env);
          found = new Set(Object.keys(env.references ?? {}));
          labelsIn.set(child, found);
        }
        for (const l of found) labels.add(l);
      }
    }
    return labels.has(md.utils.normalizeReference(label));
  };
}

const usedIn = new WeakMap<Node, string[]>();

/** The labels a block's links and pictures by reference use. */
function labelsUsed(node: Node): string[] {
  let found = usedIn.get(node);
  if (!found) {
    const labels = new Set<string>();
    node.descendants((child) => {
      if (child.type.name === "image" && child.attrs.ref) labels.add(child.attrs.ref);
      for (const mark of child.marks) if (mark.type.name === "link" && mark.attrs.ref) labels.add(mark.attrs.ref);
      return true;
    });
    found = [...labels];
    usedIn.set(node, found);
  }
  return found;
}

/**
 * How a link or picture by reference ends after its words: "[label]", "[]"
 * or nothing; null to write its address instead. The short forms need the
 * words to still be the label, and "[words]" needs nothing after it that
 * would make it a different link.
 */
function referenceTail(attrs: Attrs, words: string, next: Node | null): string | null {
  const label: string | null = attrs.ref;
  if (!label || !writing) return null;
  const defined = writing.defined(label);
  writing.labels.push({ label, defined });
  if (!defined) return null;
  const norm = md.utils.normalizeReference;
  if (attrs.refForm === "full" || norm(words) !== norm(label)) return `[${label}]`;
  // ("[" in text is escaped, except where it starts kept syntax such as "[[Note]]".)
  const after = !next ? "" : next.isText ? next.text!.slice(0, 2) : next.type.name === "footnote_ref" ? "[^" : "";
  if (attrs.refForm === "shortcut" && !/^(\(|\[\[)/.test(after) && after !== "[^") return "";
  return "[]";
}

function writeBlock(node: Node, eol: string): string {
  let out: string;
  try {
    out = serializer.serialize(schema.node("doc", null, [node]), { tightLists: true });
  } catch {
    // Should not happen. If a block can't be written as Markdown, keep its
    // words as plain paragraphs rather than lose them or fail to save.
    const paras: string[] = [];
    node.descendants((child) => {
      if (!child.isTextblock) return true;
      const text = child.textContent.replace(/[\\`*_~[\]#<>|&-]/g, "\\$&").replace(/^[ \t]+/gm, "");
      if (text) paras.push(text);
      return false;
    });
    out = paras.join("\n\n");
  }
  const trimmed = out.replace(/\n+$/, "");
  return eol === "\n" ? trimmed : trimmed.replace(/\n/g, eol);
}

export { definitionsOf, joinsList, labelsUsed, listGap, serializeBlock, type Defined };
