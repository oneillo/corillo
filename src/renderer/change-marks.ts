// The text an agent changed for each comment, in the open document. Every
// change is a range (or, where words were only taken out, a place), carried
// along through the person's edits like a comment's own range. Only the
// selected comment's change is drawn, as a light highlight of its own colour:
// that keeps typing fast however many comments a document has. "What it said
// before" draws the old words struck through beside the new ones; the first
// edit puts the page back, since the old words would no longer match.
//
// A comment whose words were all deleted keeps their place: an empty line on
// screen (a small marked gap inside a paragraph) with the comment beside it,
// until it's resolved. It's drawn, never part of the document, so the file,
// agents, exports and word counts never see it.
import { Plugin, PluginKey, type EditorState, type Transaction } from "prosemirror-state";
import { Decoration, DecorationSet } from "prosemirror-view";
import type { Node } from "prosemirror-model";
import { anchorIn, locate, offsetAt, posAt, textIndex, type TextIndex } from "../core/anchors";
import type { ChangeSpan } from "../core/change-links";
import { commentsKey, DRAFT } from "./comments";
import { PICTURE_STAND_IN } from "../core/doc-diff";

/** A change span where it is now. */
export interface MarkedSpan {
  from: number;
  to: number;
  /** Words were only taken out, here. */
  point: boolean;
  /** What it said before. */
  removed: string;
  /** Its place in the stored list, so where it moved can be reported back. */
  index: number;
  /** The person deleted its words since it was found. */
  gone?: boolean;
}

/** Spans that are still in the text. */
export const present = (spans: readonly MarkedSpan[] | undefined): MarkedSpan[] => (spans ?? []).filter((s) => !s.gone);

/** Where a comment's deleted words were, and what they said. */
export interface Gap {
  pos: number;
  text: string;
}

export interface ChangeMarks {
  /** Every change span found in the text, by owner: a comment's id, or OTHER. */
  spans: ReadonlyMap<string, MarkedSpan[]>;
  /** The owner whose change is drawn. */
  selected: string | null;
  /** Show what the selected change's text said before. */
  before: boolean;
  decorations: DecorationSet;
  /** The comment in focus when this was last worked out, to follow it. */
  commentActive: string | null;
  /** Comments whose words were deleted, by id: where they were. */
  gaps: ReadonlyMap<string, Gap>;
}

export type ChangeAction =
  | { type: "reset"; spans: Record<string, MarkedSpan[]> }
  | { type: "set"; owner: string; spans: MarkedSpan[] }
  | { type: "remove"; owner: string }
  | { type: "select"; owner: string | null }
  | { type: "before"; on: boolean }
  | { type: "gap"; id: string; gap: Gap | null };

export const changesKey = new PluginKey<ChangeMarks>("change-marks");

const EMPTY: ChangeMarks = {
  spans: new Map(),
  selected: null,
  before: false,
  decorations: DecorationSet.empty,
  commentActive: null,
  gaps: new Map(),
};

export function changeMarks(state: EditorState): ChangeMarks {
  return changesKey.getState(state) ?? EMPTY;
}

export function withChanges(tr: Transaction, ...actions: ChangeAction[]): Transaction {
  const before: ChangeAction[] = tr.getMeta(changesKey) ?? [];
  return tr.setMeta(changesKey, [...before, ...actions]);
}

// Finding spans in the document ---------------------------------------------------

/** Where stored spans are in this document; those that can't be found are left out. */
export function placeSpans(doc: Node, spans: ChangeSpan[], index: TextIndex = textIndex(doc)): MarkedSpan[] {
  const out: MarkedSpan[] = [];
  spans.forEach((span, i) => {
    const at = locate(index.text, span.anchor);
    if (!at) return;
    const point = !span.anchor.quote;
    const from = posAt(index, at.start, "start");
    const to = point ? from : posAt(index, at.end, "end");
    if (!point && to <= from) return;
    out.push({ from, to, point, removed: span.removed, index: i });
  });
  return out;
}

/**
 * The anchors of spans where they are now, in stored order: null where one
 * wasn't found, false where the person deleted its words.
 */
export function anchorsOf(doc: Node, marked: MarkedSpan[], count: number, index: TextIndex = textIndex(doc)) {
  const anchors: (ReturnType<typeof anchorIn> | null | false)[] = new Array(count).fill(null);
  for (const m of marked) {
    if (m.index >= count) continue;
    if (m.gone) {
      anchors[m.index] = false;
      continue;
    }
    const start = offsetAt(index, m.from);
    const end = m.point ? start : Math.max(start, offsetAt(index, m.to));
    anchors[m.index] = anchorIn(index.text, start, end);
  }
  return anchors;
}

// Drawing -----------------------------------------------------------------------------

function beforeWidget(removed: string): HTMLElement {
  const del = document.createElement("del");
  del.className = "change-before";
  del.contentEditable = "false";
  const lines = removed.replaceAll(PICTURE_STAND_IN, "").split("\n");
  lines.forEach((line, i) => {
    if (i > 0) del.append(document.createElement("br"));
    if (line) del.append(line);
  });
  return del;
}

function gapWidget(): HTMLElement {
  const gap = document.createElement("span");
  gap.className = "change-gap";
  gap.contentEditable = "false";
  gap.title = "Words were taken out here";
  return gap;
}

/**
 * A gap at the start or end of a paragraph (or between blocks) shows as an
 * empty line; inside one, as a small mark. At the start of a paragraph that
 * follows another, the line goes at the end of the one before, so the
 * paragraph's own first line (and its line number) stays at its top.
 */
function onItsOwnLine(doc: Node, pos: number): { at: number; line: boolean; side: number } {
  const $pos = doc.resolve(Math.max(0, Math.min(pos, doc.content.size)));
  if (!$pos.parent.isTextblock) return { at: pos, line: true, side: -1 };
  if ($pos.parentOffset === $pos.parent.content.size) return { at: pos, line: true, side: 1 };
  if ($pos.parentOffset === 0) {
    const index = $pos.index($pos.depth - 1);
    const prev = index > 0 ? $pos.node($pos.depth - 1).child(index - 1) : null;
    if (prev?.isTextblock) return { at: $pos.before() - 1, line: true, side: 1 };
    return { at: pos, line: true, side: -1 };
  }
  return { at: pos, line: false, side: -1 };
}

function gapPlaceholder(id: string, gap: Gap, line: boolean, active: boolean, before: boolean, clicked?: (id: string) => void): HTMLElement {
  const place = document.createElement("span");
  place.className = `comment-gap${line ? " line" : ""}${active ? " active" : ""}`;
  place.contentEditable = "false";
  place.dataset.threadId = id;
  place.title = "The text this comment was on was deleted";
  if (active && before && gap.text.replaceAll(PICTURE_STAND_IN, "").trim()) place.append(beforeWidget(gap.text));
  place.addEventListener("mousedown", (e) => {
    e.preventDefault();
    clicked?.(id);
  });
  return place;
}

interface DrawOptions {
  spans: MarkedSpan[] | undefined;
  selected: string | null;
  before: boolean;
  gaps: ReadonlyMap<string, Gap>;
  commentActive: string | null;
  clicked?: (id: string) => void;
}

function draw(doc: Node, o: DrawOptions): DecorationSet {
  const decorations: Decoration[] = [];
  // Where the selected comment's words were deleted, its empty line shows the place (and what they said).
  const hasGap = !!o.selected && o.gaps.has(o.selected);
  for (const s of o.spans ?? []) {
    if (s.gone || (hasGap && s.point)) continue;
    const removed = s.removed.replaceAll(PICTURE_STAND_IN, "");
    if (o.before && removed.trim()) {
      decorations.push(Decoration.widget(s.from, () => beforeWidget(s.removed), { side: -1, ignoreSelection: true, key: `before-${s.index}-${removed}` }));
    } else if (s.point) {
      decorations.push(Decoration.widget(s.from, gapWidget, { side: -1, ignoreSelection: true, key: "gap" }));
    }
    if (!s.point) decorations.push(Decoration.inline(s.from, s.to, { class: o.before ? "change-mark change-after" : "change-mark" }));
  }
  for (const [id, gap] of o.gaps) {
    if (gap.pos < 0 || gap.pos > doc.content.size) continue;
    const { at, line, side } = onItsOwnLine(doc, gap.pos);
    const active = id === o.selected || id === o.commentActive;
    const before = active && o.before && id === o.selected;
    decorations.push(
      Decoration.widget(at, () => gapPlaceholder(id, gap, line, active, before, o.clicked), {
        side,
        ignoreSelection: true,
        key: `comment-gap-${id}-${line}-${active}-${before}`,
      }),
    );
  }
  return decorations.length ? DecorationSet.create(doc, decorations) : DecorationSet.empty;
}

function mapSpans(spans: ReadonlyMap<string, MarkedSpan[]>, mapping: Transaction["mapping"]): Map<string, MarkedSpan[]> {
  const next = new Map<string, MarkedSpan[]>();
  for (const [owner, list] of spans) {
    const moved: MarkedSpan[] = [];
    for (const s of list) {
      if (s.gone) {
        moved.push(s);
        continue;
      }
      if (s.point) {
        const at = mapping.map(s.from, -1);
        moved.push({ ...s, from: at, to: at });
        continue;
      }
      // Typing at the edge of a change stays outside it, as with comments.
      const from = mapping.map(s.from, 1);
      const to = mapping.map(s.to, -1);
      moved.push(to > from ? { ...s, from, to } : { ...s, from, to: from, gone: true });
    }
    next.set(owner, moved);
  }
  return next;
}

/** Comments shown in the old state whose words this change deleted entirely: where they were, and what they said. */
function deletedComments(tr: Transaction, old: EditorState, gaps: ReadonlyMap<string, Gap>): Map<string, Gap> | null {
  const comments = commentsKey.getState(old);
  if (!comments) return null;
  let found: Map<string, Gap> | null = null;
  for (const id of comments.shown) {
    if (id === DRAFT || gaps.has(id)) continue;
    const r = comments.ranges.get(id);
    if (!r) continue;
    const from = tr.mapping.map(r.from, 1);
    if (tr.mapping.map(r.to, -1) > from) continue;
    found ??= new Map();
    found.set(id, { pos: tr.mapping.map(r.from, -1), text: old.doc.textBetween(r.from, r.to, "\n", PICTURE_STAND_IN) });
  }
  return found;
}

function apply(tr: Transaction, value: ChangeMarks, old: EditorState, state: EditorState, clicked?: (id: string) => void): ChangeMarks {
  const actions: ChangeAction[] | undefined = tr.getMeta(changesKey);
  const commentActive = commentsKey.getState(state)?.active ?? null;
  const rangesMoved = !!tr.getMeta(commentsKey);
  if (!tr.docChanged && !actions && !rangesMoved && commentActive === value.commentActive) return value;

  let spans = value.spans as Map<string, MarkedSpan[]>;
  let gaps = value.gaps as Map<string, Gap>;
  let { selected, before, decorations } = value;
  let redraw = false;
  if (tr.docChanged) {
    spans = mapSpans(spans, tr.mapping);
    if (gaps.size) gaps = new Map([...gaps].map(([id, g]) => [id, { ...g, pos: tr.mapping.map(g.pos, -1) }]));
    const deleted = deletedComments(tr, old, gaps);
    if (deleted) {
      gaps = new Map([...gaps, ...deleted]);
      redraw = true;
    }
    if (before) {
      before = false; // the old words would no longer match the new ones
      redraw = true;
    } else decorations = decorations.map(tr.mapping, tr.doc);
  }
  // The comment in focus is the one whose change is drawn.
  if (commentActive !== value.commentActive) {
    const next = commentActive === DRAFT ? null : commentActive;
    if (next !== null || selected !== null) {
      if (next !== selected) before = false;
      selected = next;
      redraw = true;
    }
    if (gaps.size) redraw = true;
  }
  for (const action of actions ?? []) {
    switch (action.type) {
      case "reset":
        spans = new Map(Object.entries(action.spans));
        redraw = true;
        break;
      case "set":
        spans = new Map(spans).set(action.owner, action.spans);
        if (action.owner === selected) redraw = true;
        break;
      case "remove":
        spans = new Map(spans);
        spans.delete(action.owner);
        if (action.owner === selected) redraw = true;
        break;
      case "select":
        if (action.owner !== selected) before = false;
        selected = action.owner;
        redraw = true;
        break;
      case "before":
        before = action.on && selected !== null;
        redraw = true;
        break;
      case "gap":
        gaps = new Map(gaps);
        if (action.gap) gaps.set(action.id, action.gap);
        else gaps.delete(action.id);
        redraw = true;
        break;
    }
  }
  // A comment whose words came back (undo, say) needs no gap.
  if (gaps.size && (tr.docChanged || actions || rangesMoved)) {
    const ranges = commentsKey.getState(state)?.ranges;
    const back = [...gaps.keys()].filter((id) => ranges?.has(id));
    if (back.length) {
      gaps = new Map(gaps);
      for (const id of back) gaps.delete(id);
      redraw = true;
    }
  }
  if (redraw) {
    decorations = draw(tr.doc, { spans: selected ? spans.get(selected) : undefined, selected, before, gaps, commentActive, clicked });
  }
  return { spans, selected, before, decorations, commentActive, gaps };
}

export interface ChangePluginOptions {
  /** The empty line where a comment's deleted words were was clicked. */
  clickedGap?: (id: string) => void;
}

export function changePlugin(options: ChangePluginOptions = {}): Plugin<ChangeMarks> {
  return new Plugin<ChangeMarks>({
    key: changesKey,
    state: {
      init: () => EMPTY,
      apply: (tr, value, old, state) => apply(tr, value, old, state, options.clickedGap),
    },
    props: {
      decorations(state) {
        return changeMarks(state).decorations;
      },
      // While a change is drawn, the comment in focus steps back to its
      // underline, so the change's blue isn't patched with coral (style.css).
      attributes(state): Record<string, string> {
        const { selected, decorations } = changeMarks(state);
        return selected && decorations !== DecorationSet.empty ? { class: "showing-change" } : {};
      },
    },
  });
}
