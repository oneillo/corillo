// What the toolbar buttons and shortcuts do to the document.
import { Plugin, TextSelection, type Command, type EditorState, type Transaction } from "prosemirror-state";
import { ReplaceAroundStep, ReplaceStep } from "prosemirror-transform";
import { Fragment, Slice, type MarkType, type Node, type NodeType } from "prosemirror-model";
import { setBlockType, toggleMark, wrapIn, lift } from "prosemirror-commands";
import { wrapInList, liftListItem } from "prosemirror-schema-list";
import { isInTable } from "prosemirror-tables";
import { sliceMarkdown } from "../core/clipboard-text";
import { schema } from "../core/schema";
import { changedRangesAcross } from "./changed-ranges";
import { fromTheText } from "./doc-tab-edits";
import { linkAddress } from "./link-labels";

const n = schema.nodes;

export function markActive(state: EditorState, type: MarkType): boolean {
  const { from, $from, to, empty } = state.selection;
  if (empty) return !!type.isInSet(state.storedMarks || $from.marks());
  return state.doc.rangeHasMark(from, to, type);
}

export const toggleBold = toggleMark(schema.marks.strong);
export const toggleItalic = toggleMark(schema.marks.em);
export const toggleStrike = toggleMark(schema.marks.strike);
export const toggleCode = toggleMark(schema.marks.code);

/**
 * Whether the selection touches a block Corillo keeps as Markdown source (the
 * document's details at the top, HTML, a table shown as Markdown). Styling or
 * wrapping one would turn its source into ordinary text and change the file.
 */
export function touchesSource(state: EditorState): boolean {
  const { from, to, $from } = state.selection;
  if ($from.parent.type === n.raw_block) return true;
  let found = false;
  state.doc.nodesBetween(from, to, (node) => {
    if (node.type === n.raw_block) found = true;
    return !found;
  });
  return found;
}

/** The document's details (its front matter), when it starts with them. */
function detailsOf(doc: Node): Node | null {
  const first = doc.firstChild;
  return first?.type === n.raw_block && first.attrs.kind === "front-matter" ? first : null;
}

/**
 * A drop (words dragged in the page, or from another app) never lands inside
 * a block kept as Markdown source: in the details at the top it would break
 * the file's front matter. It's refused, and the page and file stay as they were.
 * Nor does it move the details, or land above them (spec: "nothing is written
 * above front matter"): dragging the details is refused, and a block dropped
 * at the very top lands just under them (code review of Batch 16, W16-1).
 */
export function dropsOutsideSource(): Plugin {
  return new Plugin({
    filterTransaction(tr) {
      if (tr.getMeta("uiEvent") !== "drop") return true;
      // The details' words taken out, from their first to their last: the details dragged.
      const details = detailsOf(tr.before);
      if (details && tr.mapping.mapResult(1, 1).deleted && tr.mapping.mapResult(details.nodeSize - 1, -1).deleted) return false;
      return !tr.steps.some((step, i) => {
        if (!(step instanceof ReplaceStep || step instanceof ReplaceAroundStep) || !step.slice.size) return false;
        const $at = tr.docs[i].resolve(step.from);
        for (let d = $at.depth; d > 0; d--) if ($at.node(d).type === n.raw_block) return true;
        return false;
      });
    },
    appendTransaction(trs, before, state) {
      // Dropped above the details: they go back to the top, so what was dropped is just under them (one step for Undo with the drop).
      if (!trs.some((tr) => tr.getMeta("uiEvent") === "drop")) return null;
      const details = detailsOf(before.doc);
      if (!details || state.doc.firstChild === details) return null;
      let at = -1;
      state.doc.forEach((node, offset) => {
        if (at < 0 && node === details) at = offset;
      });
      if (at <= 0) return null;
      return state.tr.delete(at, at + details.nodeSize).insert(0, details);
    },
  });
}

/** The kind of source block at the cursor ("front-matter", "html", "table", ...), or null. */
export function sourceKindAt(state: EditorState): string | null {
  const parent = state.selection.$from.parent;
  return parent.type === n.raw_block ? parent.attrs.kind : null;
}

/** The paragraph style at the cursor: "paragraph", "h1" to "h6", or "" for anything else. */
export function currentStyle(state: EditorState): string {
  const parent = state.selection.$from.parent;
  if (parent.type === n.heading) return `h${parent.attrs.level}`;
  if (parent.type === n.paragraph) return "paragraph";
  return "";
}

export function setStyle(style: string): Command {
  const change = style === "paragraph" ? setBlockType(n.paragraph) : setBlockType(n.heading, { level: Number(style.slice(1)) });
  return (state, dispatch) => !touchesSource(state) && change(state, dispatch && ((tr) => dispatch(tasksPlainFirst(tr, state))));
}

/**
 * A task whose first line is no longer a plain line (made a heading or code)
 * loses its box, and stays in its list as an ordinary item, as any item made
 * a heading does. The same for a task's first line made a quote. Markdown has a task's box only at the start of a plain line:
 * "- [ ] # Title" reads back as the words "# Title" (roadmap Batch 18, R16-3
 * case 2). Only the items the selection was in are looked at; Undo brings the
 * box back with the line.
 */
function tasksPlainFirst(tr: Transaction, before: EditorState): Transaction {
  const from = tr.mapping.map(before.selection.from, -1);
  const to = tr.mapping.map(before.selection.to, 1);
  tr.doc.nodesBetween(from, to, (node, pos) => {
    if (node.type === n.list_item && node.attrs.checked !== null && node.firstChild && node.firstChild.type !== n.paragraph) {
      tr.setNodeMarkup(pos, undefined, { ...node.attrs, checked: null });
    }
    return !node.isTextblock;
  });
  return tr;
}

function ancestor(state: EditorState, test: (node: Node) => boolean): { node: Node; depth: number } | null {
  const { $from } = state.selection;
  for (let d = $from.depth; d > 0; d--) {
    const node = $from.node(d);
    if (test(node)) return { node, depth: d };
  }
  return null;
}

const isList = (node: Node) => node.type === n.bullet_list || node.type === n.ordered_list;

export function listActive(state: EditorState, type: NodeType): boolean {
  return ancestor(state, isList)?.node.type === type;
}

/** Bulleted or numbered list: on, off, or switch from the other kind. */
export function toggleList(type: NodeType): Command {
  return (state, dispatch) => {
    const found = ancestor(state, isList);
    if (!found) return !touchesSource(state) && wrapInList(type)(state, dispatch);
    if (found.node.type === type) return liftListItem(n.list_item)(state, dispatch);
    if (dispatch) {
      const attrs =
        type === n.ordered_list
          ? { order: 1, delim: ".", tight: found.node.attrs.tight }
          : { bullet: "-", tight: found.node.attrs.tight };
      dispatch(state.tr.setNodeMarkup(state.selection.$from.before(found.depth), type, attrs));
    }
    return true;
  };
}

/** Lists the file has as one: the same kind, with the same bullet or the same sign after the number (see joinsList in markdown-blocks.ts). */
function oneList(a: Node | null | undefined, b: Node | null | undefined): boolean {
  if (!a || !b || a.type !== b.type) return false;
  if (a.type === n.bullet_list) return a.attrs.bullet === b.attrs.bullet;
  return a.type === n.ordered_list && a.attrs.delim === b.attrs.delim;
}

/**
 * Lists of the same kind that come to touch (the paragraph between two made
 * an item, say) are one list on the page at once, as Word joins them and as
 * the file saves them. Spaced out if either was. Only where an edit changed
 * the blocks is looked at, never while typing inside a paragraph; the
 * Markdown view's text joins them itself. Added to the edit that made them
 * touch, so one Undo takes back both, and the cursor stays on its words.
 */
export function joinTouchingLists(trs: readonly Transaction[], _before: EditorState, state: EditorState): Transaction | null {
  if (!trs.some((t) => t.docChanged) || trs.some(fromTheText)) return null;
  const doc = state.doc;
  const ranges = changedRangesAcross(trs) ?? [[0, doc.content.size]];
  const joins = new Set<number>();
  /** The places between two children of a block, in or next to [from, to], where two such lists meet. */
  const between = (parent: Node, start: number, from: number, to: number) => {
    let prev: Node | null = null;
    parent.forEach((child, offset) => {
      const at = start + offset;
      if (at >= from && at <= to && oneList(prev, child)) joins.add(at);
      prev = child;
    });
  };
  for (const [rawFrom, rawTo] of ranges) {
    const from = Math.max(0, rawFrom - 1);
    const to = Math.min(doc.content.size, rawTo + 1);
    const $from = doc.resolve(rawFrom);
    if ($from.parent.isTextblock && rawTo <= $from.end()) continue; // typing in a paragraph: no blocks changed
    between(doc, 0, from, to);
    doc.nodesBetween(from, to, (node, pos) => {
      if (node.isTextblock || node.isLeaf) return false;
      between(node, pos + 1, from, to);
      return true;
    });
  }
  if (!joins.size) return null;
  const tr = state.tr;
  for (const at of [...joins].sort((x, y) => y - x)) {
    const $at = tr.doc.resolve(at);
    const a = $at.nodeBefore;
    const b = $at.nodeAfter;
    if (!a || !b || !oneList(a, b)) continue;
    const tight = a.attrs.tight && b.attrs.tight;
    try {
      tr.join(at);
    } catch {
      continue;
    }
    if (a.attrs.tight !== tight) tr.setNodeMarkup(at - a.nodeSize, null, { ...a.attrs, tight });
  }
  return tr.docChanged ? tr : null;
}

export function quoteActive(state: EditorState): boolean {
  return !!ancestor(state, (node) => node.type === n.blockquote);
}

export const toggleQuote: Command = (state, dispatch) =>
  quoteActive(state)
    ? lift(state, dispatch)
    : !touchesSource(state) && wrapIn(n.blockquote)(state, dispatch && ((tr) => dispatch(tasksPlainFirst(tr, state))));

export function codeBlockActive(state: EditorState): boolean {
  return state.selection.$from.parent.type === n.code_block;
}

/** The blocks of a type the selection touches, in document order. */
function blocksTouched(state: EditorState, test: (node: Node, parent: Node, index: number) => boolean) {
  const found: { pos: number; node: Node }[] = [];
  const { from, to } = state.selection;
  state.doc.nodesBetween(from, to, (node, pos, parent, index) => {
    if (node.isTextblock && parent && test(node, parent, index)) found.push({ pos, node });
    return !node.isTextblock;
  });
  return found;
}

/** What a picture, note mark or link is written as in Markdown. */
const markdownText = (nodes: Node[]) => sliceMarkdown(new Slice(Fragment.from(nodes), 0, 0));

/**
 * Turn the paragraph or heading at pos into a code block of the same lines:
 * pictures, note marks and links become their Markdown text, a line break a
 * new line, and the rest of the formatting goes. The block keeps its size
 * until the last step, so every step maps the selection along.
 */
function paragraphToCode(tr: Transaction, pos: number, block: Node): void {
  const link = schema.marks.link;
  const pieces: { from: number; to: number; text: string }[] = [];
  let at = pos + 1;
  for (let i = 0; i < block.childCount; ) {
    const child = block.child(i);
    const linked = link.isInSet(child.marks);
    if (linked) {
      const run: Node[] = [];
      const from = at;
      for (; i < block.childCount && linked.isInSet(block.child(i).marks); i++) {
        const part = block.child(i);
        run.push(part.mark([linked]));
        at += part.nodeSize;
      }
      pieces.push({ from, to: at, text: markdownText(run) });
      continue;
    }
    if (child.type === n.hard_break) pieces.push({ from: at, to: at + 1, text: "\n" });
    else if (!child.isText) pieces.push({ from: at, to: at + child.nodeSize, text: markdownText([child.mark([])]) });
    at += child.nodeSize;
    i++;
  }
  for (const piece of pieces.reverse()) tr.replaceWith(piece.from, piece.to, schema.text(piece.text));
  tr.setBlockType(pos, pos + 1, n.code_block);
}

/**
 * Turn the code block at pos into a paragraph per line, each blank line an
 * empty line (as empty lines are, since 2026-11-09), leaving out only blank
 * lines at its start and end.
 */
function codeToParagraphs(tr: Transaction, pos: number, block: Node): void {
  const text = block.textContent;
  for (const breaks of [...text.matchAll(/\n+/g)].reverse()) {
    const from = pos + 1 + breaks.index;
    tr.delete(from, from + breaks[0].length);
    const atEdge = breaks.index === 0 || breaks.index + breaks[0].length === text.length;
    // The first line break ends the line; each one more is an empty line between.
    if (!atEdge) for (let i = 0; i < breaks[0].length; i++) tr.split(from);
  }
  tr.setBlockType(pos, tr.mapping.map(pos + block.nodeSize - 1, -1), n.paragraph);
}

/**
 * Code block on: the paragraphs selected become one code block, a line each
 * (paragraphs in separate list items or quotes, a block each). Off: a
 * paragraph per line of code.
 */
export const toggleCodeBlock: Command = (state, dispatch) => {
  if (touchesSource(state)) return false;
  const on = !codeBlockActive(state);
  const blocks = on
    ? blocksTouched(
        state,
        (node, parent, index) =>
          (node.type === n.paragraph || node.type === n.heading) && parent.canReplaceWith(index, index + 1, n.code_block),
      )
    : blocksTouched(state, (node) => node.type === n.code_block);
  if (!blocks.length) return false;
  if (!dispatch) return true;
  const tr = state.tr;
  // From the end, so the places of the blocks before stay as they were.
  for (let i = blocks.length - 1; i >= 0; i--) {
    const { pos, node } = blocks[i];
    if (!on) {
      codeToParagraphs(tr, pos, node);
      continue;
    }
    paragraphToCode(tr, pos, node);
    const next = blocks[i + 1];
    if (next && next.pos === pos + node.nodeSize) {
      // The next one was a sibling, now code too: one block, a new line between.
      const end = pos + tr.doc.nodeAt(pos)!.nodeSize;
      tr.insertText("\n", end - 1);
      tr.join(end + 1);
    }
  }
  if (on) tasksPlainFirst(tr, state);
  dispatch(tr.scrollIntoView());
  return true;
};

/**
 * Where each line the selection touches starts, inside the code block it's in;
 * null outside one. A selection ending at the very start of a line leaves that
 * line out, as code editors do.
 */
function codeLines(state: EditorState): { base: number; text: string; starts: number[] } | null {
  const { $from, $to } = state.selection;
  if ($from.parent.type !== n.code_block || !$from.sameParent($to)) return null;
  const text = $from.parent.textContent;
  const starts = [text.lastIndexOf("\n", $from.parentOffset - 1) + 1];
  for (let i = text.indexOf("\n", $from.parentOffset); i !== -1 && i + 1 < $to.parentOffset; i = text.indexOf("\n", i + 1)) {
    starts.push(i + 1);
  }
  return { base: $from.start(), text, starts };
}

/** In a code block, Tab puts in a tab, as in a code editor; with lines selected, it indents each one. */
export const indentCode: Command = (state, dispatch) => {
  const code = codeLines(state);
  if (!code) return false;
  if (dispatch) {
    const tr = state.tr;
    if (state.selection.empty) tr.insertText("\t");
    else for (const start of [...code.starts].reverse()) tr.insertText("\t", code.base + start);
    dispatch(tr.scrollIntoView());
  }
  return true;
};

/** In a code block, Shift-Tab takes one tab (or up to four spaces) off the start of each line touched. */
export const outdentCode: Command = (state, dispatch) => {
  const code = codeLines(state);
  if (!code) return false;
  if (dispatch) {
    const tr = state.tr;
    for (const start of [...code.starts].reverse()) {
      const spaces = /^(\t| {1,4})/.exec(code.text.slice(start))?.[0].length ?? 0;
      if (spaces) tr.delete(code.base + start, code.base + start + spaces);
    }
    if (tr.docChanged) dispatch(tr.scrollIntoView());
  }
  return true;
};

/** Put a block where the cursor is, with a paragraph after it to keep typing in. */
function insertBlock(block: Node, cursorInside: boolean): Command {
  return (state, dispatch) => {
    const { $from } = state.selection;
    if (!$from.parent.isTextblock || isInTable(state) || $from.parent.type.spec.code) return false;
    if (!dispatch) return true;
    let tr = state.tr.replaceSelectionWith(block);
    // Find the new block inside the range the insertion touched.
    let start = 0;
    let end = tr.doc.content.size;
    tr.mapping.maps[tr.mapping.maps.length - 1].forEach((_a, _b, s, e) => {
      start = s;
      end = e;
    });
    let blockPos = -1;
    tr.doc.nodesBetween(start, end, (node, pos) => {
      if (blockPos >= 0) return false;
      if (node.type === block.type) {
        blockPos = pos;
        return false;
      }
      return true;
    });
    if (blockPos < 0) return false;
    const after = blockPos + tr.doc.nodeAt(blockPos)!.nodeSize;
    if (!tr.doc.resolve(after).nodeAfter?.isTextblock) tr = tr.insert(after, n.paragraph.create());
    const target = cursorInside ? blockPos + 3 : after + 1; // the first cell, or the next paragraph
    tr.setSelection(TextSelection.near(tr.doc.resolve(target)));
    dispatch(tr.scrollIntoView());
    return true;
  };
}

export function newTable(columns = 3, bodyRows = 2): Node {
  const row = (cellType: NodeType) =>
    n.table_row.create(null, Array.from({ length: columns }, () => cellType.create()));
  return n.table.create(null, [row(n.table_header), ...Array.from({ length: bodyRows }, () => row(n.table_cell))]);
}

export const insertTable: Command = (state, dispatch) => insertBlock(newTable(), true)(state, dispatch);

export const insertHorizontalLine: Command = (state, dispatch) =>
  insertBlock(n.horizontal_rule.create(), false)(state, dispatch);

// Links ---------------------------------------------------------------------

export interface LinkAtCursor {
  from: number;
  to: number;
  href: string;
}

/** The link the cursor or selection is in, if any, with its full extent. */
export function linkAt(state: EditorState): LinkAtCursor | null {
  const { $from } = state.selection;
  const parent = $from.parent;
  if (!parent.inlineContent) return null;
  const type = schema.marks.link;
  let index = $from.index();
  let mark = type.isInSet(parent.maybeChild(index)?.marks ?? []);
  if (!mark && index > 0 && $from.textOffset === 0) {
    index--;
    mark = type.isInSet(parent.child(index).marks);
  }
  if (!mark) return null;
  let first = index;
  let last = index;
  while (first > 0 && mark.isInSet(parent.child(first - 1).marks)) first--;
  while (last + 1 < parent.childCount && mark.isInSet(parent.child(last + 1).marks)) last++;
  let from = $from.start();
  for (let i = 0; i < first; i++) from += parent.child(i).nodeSize;
  let to = from;
  for (let i = first; i <= last; i++) to += parent.child(i).nodeSize;
  return { from, to, href: linkAddress(state.doc, mark.attrs as { href: string; ref: string | null }) };
}

/**
 * The endings of web addresses people type without https:// in front. Only
 * these (or a "www." start) make a name a website: "budget.md", "notes.txt"
 * or "run.sh" is a file next to the document, though .md and .sh are
 * countries' endings too.
 */
const WEB_ENDINGS = new Set(
  (
    "com org net edu gov mil int io co ai app dev info biz me tv us uk ca au nz ie de fr es it nl be ch at se no dk fi " +
    "pl pt pr br mx ar cl jp cn kr in sg hk tw eu ly gg xyz site online tech blog news shop store cloud page"
  ).split(" "),
);

/** Turn what someone typed into an address a browser can open, or a link to a file or heading as typed. */
export function normaliseHref(input: string): string {
  const href = input.trim();
  if (!href) return "";
  // A web address with a port ("localhost:3000", "example.com:8080/x") isn't a scheme.
  if (/^(localhost|[^\s/:@]+\.[^\s/:@]+):\d+([/?#]|$)/i.test(href)) return `https://${href}`;
  if (/^[a-z][a-z0-9+.-]*:/i.test(href) || /^[#/.]/.test(href)) return href;
  if (/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(href)) return `mailto:${href}`;
  const host = /^[^\s/]+\.([a-z]{2,})(\/|$)/i.exec(href);
  if (host && (/^www\./i.test(href) || WEB_ENDINGS.has(host[1].toLowerCase()))) return `https://${href}`;
  return href;
}

/** Link the selection, or the link at the cursor, or insert linked text. */
export function applyLink(input: string, text?: string): Command {
  return (state, dispatch) => {
    const href = normaliseHref(input);
    if (!href) return false;
    const type = schema.marks.link;
    const mark = type.create({ href });
    const { from, to, empty } = state.selection;
    if (!dispatch) return true;
    const tr = state.tr;
    const existing = empty ? linkAt(state) : null;
    if (existing) {
      tr.removeMark(existing.from, existing.to, type).addMark(existing.from, existing.to, mark);
    } else if (!empty) {
      tr.removeMark(from, to, type).addMark(from, to, mark);
    } else {
      const label = text?.trim() || input.trim();
      tr.insert(from, schema.text(label, [mark]));
      tr.setSelection(TextSelection.create(tr.doc, from + label.length));
    }
    dispatch(tr.scrollIntoView());
    return true;
  };
}

export const removeLink: Command = (state, dispatch) => {
  const type = schema.marks.link;
  const { from, to, empty } = state.selection;
  const range = empty ? linkAt(state) : { from, to };
  if (!range) return false;
  dispatch?.(state.tr.removeMark(range.from, range.to, type));
  return true;
};

export function canLink(state: EditorState): boolean {
  const parent = state.selection.$from.parent;
  return parent.inlineContent && !parent.type.spec.code && parent.type.allowsMarkType(schema.marks.link);
}
