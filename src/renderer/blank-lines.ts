// Empty lines on the page (Orlando, 2026-11-09: "An empty line in markdown doc
// should show up as an empty line in word"). What the page shows is what the
// file holds and what Word gets: each blank line of the file is one empty line
// of the text's own height, and blocks the file writes with no blank line
// between them sit close.
//
// The style sheet sets every block a line below the one before it (the blank
// line between them). This marks the exceptions, from the file's layout
// (markdown.ts): an empty line (the next block starts on the line after it), a
// block the file writes straight under the one before ("joined"), and the
// parts of a quote written so. In the editor they're worked out again only when
// the document's blocks change, at most once a frame: typing in a block just
// carries the marks along. Typing in a quote or list with parts set close may
// change how it's written, so that's looked at again once typing pauses.
import { Plugin, PluginKey, TextSelection, type Command, type EditorState, type Transaction } from "prosemirror-state";
import { Decoration, DecorationSet, type EditorView } from "prosemirror-view";
import type { Node, ResolvedPos } from "prosemirror-model";
import { isEmptyLine, markdownLayout, type Source } from "../core/markdown";
import { blockJoins } from "../core/line-numbers";

interface Spacing {
  set: DecorationSet;
  /** The blocks changed in a way that may change their spacing: worked out again next frame. */
  stale: boolean;
  /** Words changed in a quote or list with parts set close: worked out again once typing pauses. */
  later: boolean;
}

type Kind = "empty" | "joined" | "part" | "after";

const key = new PluginKey<Spacing>("blank-lines");
/** For tests: what the spacing knows. */
export const blankLinesKey = key;
/** How long typing pauses before a quote's or list's parts are looked at again. */
const PAUSE_MS = 400;
const LINE_BREAK = /\r\n|\r|\n/g;

/**
 * "after": the block straight after an empty line, which sits close under it. A
 * class of its own, not a style rule for "whatever follows an empty line", which
 * made the browser restyle the whole page each time a line became empty or not
 * (code review of Batch 16, W16-5).
 */
const CLASSES: Record<Kind, string> = { empty: "empty-line", joined: "joined", part: "joined", after: "after-empty" };

const mark = (from: number, node: Node, kind: Kind) => Decoration.node(from, from + node.nodeSize, { class: CLASSES[kind] }, { kind });

/** The spacing marks for the whole document. */
export function spacingOf(doc: Node, source: Source): DecorationSet {
  const layout = markdownLayout(doc, source);
  const out: Decoration[] = [];
  let before: "none" | "empty" | "words" = "none";
  doc.forEach((node, pos, k) => {
    const block = layout.blocks[k];
    if (before === "empty") out.push(mark(pos, node, "after"));
    // (As the file has it: a paragraph of "&#32;" is a space, written as words.)
    if (isEmptyLine(node) && (!block || /^[ \t]*$/.test(block.text))) {
      out.push(mark(pos, node, "empty"));
      before = "empty";
      return;
    }
    if (block) {
      if (before === "words" && (block.gap.match(LINE_BREAK)?.length ?? 0) < 2) out.push(mark(pos, node, "joined"));
      for (const at of blockJoins(node, block.text)) {
        const part = doc.nodeAt(pos + at);
        if (part) out.push(mark(pos + at, part, "part"));
      }
    }
    before = "words";
  });
  return DecorationSet.create(doc, out);
}

/**
 * The page's spacing. In the editor (live), kept up to date as the document
 * changes; in a view that only shows a document, worked out once.
 */
export function blankLinesPlugin(source: () => Source, live = true): Plugin<Spacing> {
  return new Plugin<Spacing>({
    key,
    state: {
      init: (_config, state) => ({ set: spacingOf(state.doc, source()), stale: false, later: false }),
      apply: (tr, value, before) => {
        const fresh = tr.getMeta(key) as DecorationSet | undefined;
        if (fresh) return { set: fresh, stale: false, later: false };
        return tr.docChanged ? changed(tr, value, before.doc) : value;
      },
    },
    props: { decorations: (state) => key.getState(state)!.set },
    appendTransaction: live ? strayEmptyLines : undefined,
    view: live ? (view) => new Keeper(view, source) : undefined,
  });
}

/**
 * Backspace at the start of a paragraph right under another (review R-EL-1).
 * The blank line between them is numbered and drawn like an empty line, so
 * it goes like one: the two then sit on consecutive lines, one paragraph over
 * two lines, as the file then reads ("A\nB"). A second Backspace joins the
 * lines, as ever. Under an empty line, or under anything but a paragraph,
 * Backspace does what it did.
 */
export const joinOverBlankLine: Command = (state, dispatch) => {
  const $cursor = (state.selection as TextSelection).$cursor;
  if (!$cursor || $cursor.parentOffset > 0 || $cursor.depth < 1) return false;
  const index = $cursor.index($cursor.depth - 1);
  const above = index > 0 ? $cursor.node($cursor.depth - 1).child(index - 1) : null;
  if (!above || !wordsOnLines($cursor.parent) || !wordsOnLines(above)) return false;
  if (dispatch) dispatch(keepListSpacing(state, $cursor, $cursor.before(), joinLines(state.tr, $cursor.before())).scrollIntoView());
  return true;
};

/** Delete at the end of a paragraph right over another: the same as Backspace at the start of the one below. */
export const joinOverBlankLineForward: Command = (state, dispatch) => {
  const $cursor = (state.selection as TextSelection).$cursor;
  if (!$cursor || $cursor.parentOffset < $cursor.parent.content.size || $cursor.depth < 1) return false;
  const index = $cursor.index($cursor.depth - 1);
  const below = $cursor.node($cursor.depth - 1).maybeChild(index + 1);
  if (!below || !wordsOnLines($cursor.parent) || !wordsOnLines(below)) return false;
  if (dispatch) {
    const tr = keepListSpacing(state, $cursor, $cursor.after(), joinLines(state.tr, $cursor.after()));
    dispatch(tr.setSelection(TextSelection.create(tr.doc, tr.mapping.map($cursor.pos, -1))).scrollIntoView());
  }
  return true;
};

/**
 * In a list item, the blank line that goes may be the list's only one: then
 * the list is written close all through, as the page shows it (from the
 * spacing marks: each part written close is marked). `gone` is where the
 * lower paragraph starts.
 */
function keepListSpacing(state: EditorState, $in: ResolvedPos, gone: number, tr: Transaction): Transaction {
  const spacing = key.getState(state);
  const depth = $in.depth - 2;
  if (!spacing || depth < 0 || $in.node(depth + 1).type.name !== "list_item") return tr;
  const list = $in.node(depth);
  if (list.attrs.tight) return tr;
  const start = $in.start(depth);
  const close = new Set(spacing.set.find(start, $in.end(depth)).filter((d) => d.spec.kind === "part").map((d) => d.from));
  let spaced = false;
  list.forEach((item, offset, i) => {
    if (i > 0 && !close.has(start + offset)) spaced = true;
    item.forEach((_child, at, j) => {
      const pos = start + offset + 1 + at;
      if (j > 0 && pos !== gone && !close.has(pos)) spaced = true;
    });
  });
  return spaced ? tr : tr.setNodeMarkup($in.before(depth), null, { ...list.attrs, tight: true });
}

/** A paragraph of words, in a quote, a list item or the document: not an empty line, not in a table. */
function wordsOnLines(node: Node): boolean {
  return node.type.name === "paragraph" && !isEmptyLine(node);
}

/**
 * Joins the paragraphs either side of `at` with a line break in the text.
 * Spaces either side of it go, as Markdown keeps none there; a line break
 * the person typed (Shift-Return) at the join is already the line between.
 * The cursor ends at the start of the lower paragraph's words.
 */
function joinLines(tr: Transaction, at: number): Transaction {
  const $at = tr.doc.resolve(at);
  const above = $at.nodeBefore!;
  const below = $at.nodeAfter!;
  tr.join(at);
  let join = at - 1;
  const broken = above.lastChild?.type.name === "hard_break" || below.firstChild?.type.name === "hard_break";
  if (!broken) {
    const lead = below.firstChild?.isText ? /^[ \t]*/.exec(below.firstChild.text!)![0].length : 0;
    const trail = above.lastChild?.isText ? /[ \t]*$/.exec(above.lastChild.text!)![0].length : 0;
    tr.delete(join, join + lead).delete(join - trail, join);
    join -= trail;
    tr.insert(join, tr.doc.type.schema.text("\n"));
    join += 1;
  }
  return tr.setSelection(TextSelection.create(tr.doc, join));
}

// Empty lines in a quote, a callout or a list item (review R-EL-2). Markdown
// has no empty paragraph there: the file would drop it, so the page mustn't
// keep one either (the lead's call, 2026-11-09 night: an empty line there is
// either saved and read back or can't be typed; Corillo does the second).
// Return where it would leave one takes the empty line out of the quote,
// where the file holds it; one made to type into goes once the cursor leaves.

/**
 * Return on an empty paragraph in a quote, or at the start of one's words:
 * the empty line goes out of the quote (splitting it, if there's more of it
 * below), as a blank line of the file. The cursor stays where it was: on the
 * empty line, or at the start of the words, now below it.
 */
export const emptyLineOutOfQuote: Command = (state, dispatch) => {
  const $cursor = (state.selection as TextSelection).$cursor;
  if (!$cursor || $cursor.depth < 2 || $cursor.parent.type.name !== "paragraph" || $cursor.node(-1).type.name !== "blockquote") return false;
  const empty = isEmptyLine($cursor.parent);
  if (!empty && $cursor.parentOffset > 0) return false;
  const tr = state.tr;
  if (!empty) tr.split($cursor.pos);
  // Out of the quote, into what holds it (the document, a list item, an outer quote).
  const range = tr.doc.resolve($cursor.before() + 1).blockRange();
  if (!range) return false;
  if (dispatch) {
    tr.lift(range, range.depth - 1);
    const at = tr.mapping.map($cursor.pos, empty ? -1 : 1);
    dispatch(tr.setSelection(TextSelection.create(tr.doc, at)).scrollIntoView());
  }
  return true;
};

/** Where an empty paragraph can't be written: beside other parts of these. */
const CONTAINERS = new Set(["blockquote", "list_item"]);

/**
 * After any change, an empty paragraph in a quote or list item, beside other
 * parts of it, is taken away, unless the cursor is in it: it's there to type
 * into. (A task's first line is no paragraph of words: its box is, and stays.)
 */
function strayEmptyLines(trs: readonly Transaction[], old: EditorState, state: EditorState): Transaction | null {
  if (!trs.some((tr) => tr.docChanged || tr.selectionSet)) return null;
  const doc = state.doc;
  const head = state.selection.head;
  // Where one may be: where the cursor was, and the stretch the changes
  // cover (one stretch, worked out in a single pass: a Replace All makes
  // thousands of changes).
  let from = Infinity;
  let to = -Infinity;
  let was = old.selection.head;
  for (const tr of trs) {
    for (const map of tr.mapping.maps) {
      was = map.map(was, 1);
      if (from <= to) {
        from = map.map(from, -1);
        to = map.map(to, 1);
      }
      map.forEach((_a, _b, start, end) => {
        from = Math.min(from, start);
        to = Math.max(to, end);
      });
    }
  }
  const spots = from <= to ? [from, to, was, was] : [was, was];
  const stray = new Map<number, number>();
  for (let i = 0; i < spots.length; i += 2) {
    doc.nodesBetween(Math.max(0, Math.min(spots[i], spots[i + 1]) - 1), Math.min(doc.content.size, Math.max(spots[i], spots[i + 1]) + 1), (node, pos, parent, index) => {
      if (!node.isTextblock) return !node.isLeaf;
      const inside = head > pos && head < pos + node.nodeSize;
      const task = index === 0 && parent?.attrs.checked != null;
      if (parent && CONTAINERS.has(parent.type.name) && parent.childCount > 1 && !inside && !task && isEmptyLine(node)) stray.set(pos, node.nodeSize);
      return false;
    });
  }
  if (!stray.size) return null;
  const tr = state.tr;
  for (const pos of [...stray.keys()].sort((a, b) => b - a)) {
    const $pos = tr.doc.resolve(pos);
    if ($pos.parent.childCount > 1 && $pos.parent.canReplace($pos.index(), $pos.index() + 1)) tr.delete(pos, pos + stray.get(pos)!);
  }
  return tr.docChanged ? tr : null;
}

/** A transaction that only brings the page's spacing up to date. */
export function onlySpacing(tr: Transaction): boolean {
  return !tr.docChanged && !tr.selectionSet && tr.getMeta(key) !== undefined;
}

/**
 * After an edit the marks move with the text, and the blocks the edit touched
 * are marked empty or not straight away (Return on an empty line, typing on
 * one). What else may have changed is left for the next frame's look at the
 * whole document: blocks added or taken away, a block changed in kind, a
 * list's or quote's parts, or a quote with parts set close.
 */
function changed(tr: Transaction, value: Spacing, old: Node): Spacing {
  const doc = tr.doc;
  let set = value.set.map(tr.mapping, doc);
  let stale = value.stale || old.childCount !== doc.childCount;
  let later = value.later;
  // Where the edit was, in the new document.
  let from = Infinity;
  let to = -Infinity;
  tr.mapping.maps.forEach((map, i) => {
    map.forEach((_oldStart, _oldEnd, start, end) => {
      const rest = tr.mapping.slice(i + 1);
      from = Math.min(from, rest.map(start, -1));
      to = Math.max(to, rest.map(end, 1));
    });
  });
  if (from > to) return { set, stale, later };
  const touched: [pos: number, k: number][] = [];
  doc.nodesBetween(Math.max(0, from - 1), Math.min(doc.content.size, to + 1), (node, pos, parent, k) => {
    if (parent !== doc) return false;
    touched.push([pos, k]);
    const was = old.childCount === doc.childCount ? old.child(k) : null;
    if (was === node) return false;
    const empty = isEmptyLine(node);
    if (!was || was.type !== node.type || isEmptyLine(was) !== empty || shapeChanged(was, node)) stale = true;
    const marks = set.find(pos, pos + node.nodeSize).filter((d) => d.from >= pos && d.to <= pos + node.nodeSize);
    if (marks.some((d) => d.spec.kind === "part")) later = true;
    const emptyMarks = marks.filter((d) => d.spec.kind === "empty" && d.from === pos);
    if (empty && !emptyMarks.length) set = set.add(doc, [mark(pos, node, "empty")]);
    else if (!empty && emptyMarks.length) set = set.remove(emptyMarks);
    return false;
  });
  // Each block the edit touched, and the one after each, sits close under an empty line, or not, straight away.
  const has = (pos: number, node: Node, kind: Kind) => set.find(pos, pos + node.nodeSize).filter((d) => d.spec.kind === kind && d.from === pos);
  const follow = (pos: number, k: number) => {
    if (k <= 0 || k >= doc.childCount) return;
    const node = doc.child(k);
    const above = doc.child(k - 1);
    const want = has(pos - above.nodeSize, above, "empty").length > 0;
    const marks = has(pos, node, "after");
    if (want && !marks.length) set = set.add(doc, [mark(pos, node, "after")]);
    else if (!want && marks.length) set = set.remove(marks);
  };
  for (const [pos, k] of touched) {
    follow(pos, k);
    follow(pos + doc.child(k).nodeSize, k + 1);
  }
  return { set, stale, later };
}

/** Whether a list's or quote's parts changed, not just the words in them. */
function shapeChanged(a: Node, b: Node): boolean {
  if (a === b || b.isTextblock || b.isLeaf) return false;
  if (a.childCount !== b.childCount) return true;
  for (let i = 0; i < b.childCount; i++) {
    const x = a.child(i);
    const y = b.child(i);
    if (x.type !== y.type || x.attrs.tight !== y.attrs.tight || shapeChanged(x, y)) return true;
  }
  return false;
}

/**
 * Works the spacing out again, once a frame at most, when an edit may have
 * changed it, or the document was read again; or once typing pauses, when
 * only words in a quote or list with parts set close changed.
 */
class Keeper {
  private frame = 0;
  private pause: ReturnType<typeof setTimeout> | undefined;
  private source: Source;

  constructor(
    private readonly view: EditorView,
    private readonly sourceOf: () => Source,
  ) {
    this.source = sourceOf();
  }

  update(view: EditorView, prev: EditorState): void {
    const spacing = key.getState(view.state)!;
    if (this.sourceOf() !== this.source || (view.state.doc !== prev.doc && spacing.stale)) this.later();
    else if (view.state.doc !== prev.doc && spacing.later) {
      clearTimeout(this.pause);
      this.pause = setTimeout(() => this.later(), PAUSE_MS);
    }
  }

  private later(): void {
    clearTimeout(this.pause);
    this.pause = undefined;
    this.frame ||= requestAnimationFrame(() => {
      this.frame = 0;
      const view = this.view;
      if (view.isDestroyed) return;
      // Not in the middle of typing an accented letter or other composed text.
      if (view.composing) return this.later();
      this.source = this.sourceOf();
      view.dispatch(view.state.tr.setMeta(key, spacingOf(view.state.doc, this.source)));
    });
  }

  destroy(): void {
    cancelAnimationFrame(this.frame);
    clearTimeout(this.pause);
  }
}
