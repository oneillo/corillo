// What a version changed, worked out on the formatted document so it can be
// marked on the page: blocks are matched first (paragraphs, list items, table
// rows), then words inside the blocks that changed. Positions are in the newer
// document; what was taken out is carried along to be shown where it was.
import type { Fragment, Node, NodeType } from "prosemirror-model";
import { diffSequence, diffWords, pairAlike, similarityCache } from "./diff";

export type Change =
  | { kind: "added-text"; from: number; to: number }
  /** `content` is what went, as it was (pictures, footnote markers and formatting included). */
  | { kind: "removed-text"; at: number; text: string; content: Fragment }
  | { kind: "added-block"; from: number; to: number }
  | { kind: "removed-block"; at: number; node: Node }
  /** The same words, but the formatting or kind of block changed (made bold, turned into a heading). */
  | { kind: "changed-block"; from: number; to: number };

/**
 * U+FFFC, which most editors and diffs show as nothing. Pictures, footnote
 * markers and line breaks take one place in a block's text, as in the
 * document, and this is the character in that place (code hidden from a
 * search is hidden with it too). Written here only: a unit test fails on it
 * anywhere else in src/ (picture-stand-in.test.ts).
 */
export const PICTURE_STAND_IN = "\uFFFC";

export function inlineText(node: Node): string {
  let s = "";
  node.forEach((child) => {
    s += child.isText ? child.text! : PICTURE_STAND_IN;
  });
  return s;
}

const isTableRow = (node: Node) => node.type.name === "table_row";
/**
 * An empty line (a blank line of the file). One added or taken away isn't
 * marked: the space it makes or leaves shows by itself, and marking an empty
 * line would only be a coloured band (2026-11-09).
 */
const isEmptyLine = (node: Node) => node.type.name === "paragraph" && node.childCount === 0;
const isDiagram = (node: Node) =>
  node.type.name === "code_block" && /^mermaid\b/.test(String(node.attrs.params ?? "").trim());

/** A block's words, with a space between its paragraphs (or cells) so they don't run together. */
const wordsIn = (node: Node) => node.textBetween(0, node.content.size, " ", " ");

/** One comparison of two documents: each block's words are read and counted once, however many blocks it's held against. */
interface Comparison {
  out: Change[];
  similar: (a: string, b: string) => number;
  texts: Map<Node, string>;
}

function textOf(node: Node, c: Comparison): string {
  let text = c.texts.get(node);
  if (text === undefined) c.texts.set(node, (text = node.isTextblock ? inlineText(node) : wordsIn(node)));
  return text;
}

/** How alike two blocks are, from 0 to 1, when they're alike enough to show as one block changed; null when not. */
function likeness(a: Node, b: Node, c: Comparison): number | null {
  if (isEmptyLine(a) || isEmptyLine(b)) return null;
  if (a.isTextblock && b.isTextblock && !!a.type.spec.code !== !!b.type.spec.code) return null;
  if (!(a.isTextblock && b.isTextblock) && (a.type !== b.type || a.isLeaf)) return null;
  const like = c.similar(textOf(a, c), textOf(b, c));
  // Table rows as wide as each other always can: a table keeps its shape on the page.
  if (isTableRow(a)) return a.childCount === b.childCount ? like : null;
  return like >= 0.4 ? like : null;
}

const pairable = (a: Node, b: Node, c: Comparison) => likeness(a, b, c) !== null;

const isList = (node: Node) => node.type.name === "bullet_list" || node.type.name === "ordered_list";

/**
 * The kind of list a run of changed blocks cut in two or made one, if any:
 * lists of one kind on both sides, two or more of them on one side.
 */
function cutList(removed: readonly Node[], added: readonly Node[]): NodeType | null {
  for (const list of new Set(removed.filter(isList).map((n) => n.type))) {
    const before = removed.filter((n) => n.type === list).length;
    const after = added.filter((n) => n.type === list).length;
    if (after && (before > 1 || after > 1)) return list;
  }
  return null;
}

export function diffDocs(before: Node, after: Node): Change[] {
  const c: Comparison = { out: [], similar: similarityCache(), texts: new Map() };
  diffChildren(before, after, 0, c);
  return c.out;
}

/** Compare what's inside two matching nodes; `start` is where b's content begins. */
function diffChildren(a: Node, b: Node, start: number, c: Comparison): void {
  const { out } = c;
  if (isTableRow(b) && a.childCount === b.childCount) {
    // Cells are compared by place: a table keeps its shape on the page, so
    // the third cell before is the third cell now, whatever the others hold.
    let pos = start;
    for (let i = 0; i < b.childCount; i++) {
      if (!a.child(i).eq(b.child(i))) diffPair(a.child(i), b.child(i), pos, c);
      pos += b.child(i).nodeSize;
    }
    return;
  }
  const oldKids: Node[] = [];
  const newKids: Node[] = [];
  a.forEach((k) => oldKids.push(k));
  b.forEach((k) => newKids.push(k));
  const ops = diffSequence(oldKids, newKids, (x, y) => x.eq(y));
  let pos = start;
  for (let i = 0; i < ops.length; ) {
    const op = ops[i];
    if (op.type === "same") {
      pos += op.b.nodeSize;
      i++;
      continue;
    }
    const removed: Node[] = [];
    const added: Node[] = [];
    for (; i < ops.length; i++) {
      const o = ops[i];
      if (o.type === "same") break;
      if (o.type === "removed") removed.push(o.a);
      else added.push(o.b);
    }
    const list = cutList(removed, added);
    if (list) {
      const end = pos + added.reduce((n, k) => n + k.nodeSize, 0);
      diffItems(unitsOf(removed, list, 0), unitsOf(added, list, pos), pos, end, c);
      pos = end;
      continue;
    }
    // Rows of the same width in a run are paired by place: a table keeps its shape on the page.
    const byPlace = b.type.name === "table" && removed.length === added.length && removed.every((r, k) => pairable(r, added[k], c));
    const pairs = byPlace ? removed.map((r, k) => ({ old: r, new: added[k] })) : pairAlike(removed, added, (x, y) => likeness(x, y, c));
    for (const p of pairs) {
      if (p.old && p.new) {
        diffPair(p.old, p.new, pos, c);
        pos += p.new.nodeSize;
      } else if (p.old) {
        if (!isEmptyLine(p.old)) out.push({ kind: "removed-block", at: pos, node: p.old });
      } else if (p.new) {
        if (!isEmptyLine(p.new)) out.push({ kind: "added-block", from: pos, to: pos + p.new.nodeSize });
        pos += p.new.nodeSize;
      }
    }
  }
}

/** A block of a run, or an item of one of its lists; `from` is where it starts in the newer document. */
interface Unit {
  node: Node;
  from: number;
  item: boolean;
}

function unitsOf(blocks: readonly Node[], list: NodeType, from: number): Unit[] {
  const out: Unit[] = [];
  for (const block of blocks) {
    if (block.type === list) block.forEach((item, offset) => out.push({ node: item, from: from + 1 + offset, item: true }));
    else out.push({ node: block, from, item: false });
    from += block.nodeSize;
  }
  return out;
}

/**
 * A run of blocks where a list was cut in two or two were made one, compared
 * as one sequence of the lists' items and the blocks between: an item in
 * both, unchanged, is left unmarked wherever its list now ends. `start` and
 * `end` bound the run in the newer document. Something that went is shown
 * where something of its kind (an item, or a block) came in its place, or
 * else beside its kind: an item in a list, a block between blocks.
 */
function diffItems(olds: Unit[], news: Unit[], start: number, end: number, c: Comparison): void {
  const { out } = c;
  /** A place between two units of the newer document, and whether it's beside an item there. */
  type Side = { at: number; item: boolean };
  const after = (u: Unit): Side => ({ at: u.from + u.node.nodeSize, item: u.item });
  const before = (u: Unit): Side => ({ at: u.from, item: u.item });
  let last: Side = { at: start, item: false };
  type Went = Extract<Change, { kind: "removed-block" }>;
  const went = (u: Unit, next: Side): Went[] =>
    isEmptyLine(u.node) ? [] : [{ kind: "removed-block", at: next.item === u.item || last.item !== u.item ? next.at : last.at, node: u.node }];
  const ops = diffSequence(olds, news, (x, y) => x.item === y.item && x.node.eq(y.node));
  for (let i = 0; i < ops.length; ) {
    const op = ops[i];
    if (op.type === "same") {
      last = after(op.b);
      i++;
      continue;
    }
    const removed: Unit[] = [];
    const added: Unit[] = [];
    for (; i < ops.length; i++) {
      const o = ops[i];
      if (o.type === "same") break;
      if (o.type === "removed") removed.push(o.a);
      else added.push(o.b);
    }
    const following = i < ops.length && ops[i].type === "same" ? before((ops[i] as { b: Unit }).b) : { at: end, item: false };
    const pairs = pairAlike(removed, added, (x, y) => likeness(x.node, y.node, c));
    for (let p = 0; p < pairs.length; ) {
      // Up to the next pair: what went, then what came.
      const gone: Unit[] = [];
      const came: Unit[] = [];
      for (; p < pairs.length && !(pairs[p].old && pairs[p].new); p++) {
        if (pairs[p].old) gone.push(pairs[p].old!);
        else came.push(pairs[p].new!);
      }
      const pair = p < pairs.length ? pairs[p++] : null;
      const slots = came.map((): Unit[] => []);
      const next = came.length ? before(came[0]) : pair ? before(pair.new!) : following;
      const first: Went[] = [];
      for (const u of gone) {
        const k = came.findIndex((n) => n.item === u.item);
        if (k >= 0) slots[k].push(u);
        else first.push(...went(u, next));
      }
      out.push(...first.sort((x, y) => x.at - y.at));
      came.forEach((u, k) => {
        for (const g of slots[k]) out.push(...went(g, before(u)));
        if (!isEmptyLine(u.node)) out.push({ kind: "added-block", from: u.from, to: u.from + u.node.nodeSize });
        last = after(u);
      });
      if (pair) {
        diffPair(pair.old!.node, pair.new!.node, pair.new!.from, c);
        last = after(pair.new!);
      }
    }
  }
}

function diffPair(a: Node, b: Node, pos: number, c: Comparison): void {
  const { out } = c;
  const whole = { from: pos, to: pos + b.nodeSize };
  if (isDiagram(a) || isDiagram(b)) {
    // A diagram shows as a drawing, so mark the whole diagram as changed.
    out.push({ kind: "changed-block", ...whole });
    return;
  }
  if (a.isTextblock && b.isTextblock) {
    // Each character of inlineText is one place in the block, so offsets in the
    // text are offsets in the block's content too.
    let at = pos + 1;
    let was = 0;
    let textChanged = false;
    for (const piece of diffWords(inlineText(a), inlineText(b))) {
      const length = piece.text.length;
      if (piece.type === "same") {
        at += length;
        was += length;
      } else if (piece.type === "added") {
        out.push({ kind: "added-text", from: at, to: at + length });
        at += length;
        textChanged = true;
      } else {
        out.push({ kind: "removed-text", at, text: piece.text, content: a.content.cut(was, was + length) });
        was += length;
        textChanged = true;
      }
    }
    if (!textChanged || !a.sameMarkup(b)) out.push({ kind: "changed-block", ...whole });
    return;
  }
  diffChildren(a, b, pos + 1, c);
  if (!a.sameMarkup(b)) out.push({ kind: "changed-block", ...whole });
}
