// Where each comment sits in the open document. Every comment on some text is
// a range, carried along through every edit (never searched for again while
// the document is open) and drawn as a soft coral highlight. The comment in
// focus is drawn stronger. Clicking highlighted text, or moving the cursor into
// it, puts its comment in focus.
import { Plugin, PluginKey, type EditorState, type Transaction } from "prosemirror-state";
import { Decoration, DecorationSet } from "prosemirror-view";
import type { Node } from "prosemirror-model";
import { offsetAt, type TextIndex } from "../core/anchors";
import { PICTURE_STAND_IN } from "../core/doc-diff";

export interface Range {
  from: number;
  to: number;
}

/**
 * What a deletion took away with a comment's words in it (cut, dragged off,
 * deleted), as text, and where the comment's words were in it: put back as
 * it was taken (pasted, dropped), the comment goes with it. Blank space at
 * either end left off, as pasting may add or drop it.
 */
export interface Cut {
  text: string;
  from: number;
  to: number;
}

/**
 * The text from `from` to `to` (a line break between blocks, one place for
 * each picture, footnote marker or line break, as textBetween gives it), and
 * where each run of it is in the document.
 */
export function textRuns(doc: Node, from: number, to: number): TextIndex {
  let text = "";
  let first = true;
  const runs: TextIndex["runs"] = [];
  doc.nodesBetween(from, to, (node, pos) => {
    const leaf = node.isLeaf && !node.isText;
    const value = node.isText ? node.text!.slice(Math.max(from, pos) - pos, to - pos) : leaf ? PICTURE_STAND_IN : "";
    if (node.isBlock && (leaf || node.isTextblock)) {
      if (first) first = false;
      else text += "\n";
    }
    if (value) {
      runs.push({ offset: text.length, pos: node.isText ? Math.max(from, pos) : pos, length: value.length });
      text += value;
    }
  });
  return { text, runs };
}

/** `text` with blank space at its ends left off, and the comment's place in it (null: the comment was only blank space). */
function trimmedCut(text: string, from: number, to: number): Cut | null {
  const lead = text.length - text.trimStart().length;
  const trimmed = text.trim();
  const start = Math.max(0, from - lead);
  const end = Math.min(trimmed.length, to - lead);
  return end > start ? { text: trimmed, from: start, to: end } : null;
}

/** Above this many steps (a Replace All), only a comment's own words bring it back. */
const CUT_STEPS = 400;

/**
 * For each comment whose words this change deleted, what was taken with
 * them: the stretch one step deleted, holding the whole of the comment's
 * words. When no one step took them all, the comment's words alone.
 */
function whatWasCut(tr: Transaction, old: ReadonlyMap<string, Range>, lost: readonly string[]): Map<string, Cut> {
  const cuts = new Map<string, Cut>();
  const places = lost.map((id) => ({ id, ...old.get(id)! }));
  const taken = new Map<string, TextIndex>(); // by step and stretch, read once for every comment in it
  if (tr.steps.length <= CUT_STEPS) {
    tr.mapping.maps.forEach((map, i) => {
      for (const p of places) {
        if (cuts.has(p.id) || p.to <= p.from) continue;
        map.forEach((oldStart, oldEnd) => {
          if (cuts.has(p.id) || oldStart > p.from || p.to > oldEnd) return;
          const key = `${i}:${oldStart}`;
          let runs = taken.get(key);
          if (!runs) taken.set(key, (runs = textRuns(tr.docs[i], oldStart, oldEnd)));
          const cut = trimmedCut(runs.text, offsetAt(runs, p.from), offsetAt(runs, p.to));
          if (cut) cuts.set(p.id, cut);
        });
        p.from = map.map(p.from, 1);
        p.to = map.map(p.to, -1);
      }
    });
  }
  for (const id of lost) {
    if (cuts.has(id)) continue;
    const r = old.get(id)!;
    const words = textRuns(tr.before, r.from, r.to).text;
    const cut = trimmedCut(words, 0, words.length);
    if (cut) cuts.set(id, cut);
  }
  return cuts;
}

/** The comment being written, before it's posted. */
export const DRAFT = "draft";

export interface CommentRanges {
  /** Every comment the editor found in the text (resolved ones too), and the draft. */
  ranges: ReadonlyMap<string, Range>;
  /** The ones highlighted: open comments and the draft. */
  shown: ReadonlySet<string>;
  /** The comment in focus. */
  active: string | null;
  decorations: DecorationSet;
  /** Comments whose text went away in the last change. */
  lost: readonly string[];
  /** For those, what the change took away with their words. */
  cut: ReadonlyMap<string, Cut>;
  /** The focus moved because of the text (a click, or the cursor), so the panel should follow. */
  revealed: boolean;
  /**
   * Comments whose words are being typed over: the person replaced their end
   * and the cursor is still there, so what they type next joins the comment,
   * as it does in Word.
   */
  typing: ReadonlySet<string>;
}

export type RangeAction =
  | { type: "reset"; ranges: Record<string, Range>; shown: string[] }
  | { type: "add"; id: string; range: Range; shown: boolean }
  | { type: "remove"; id: string }
  | { type: "rename"; from: string; to: string }
  | { type: "shown"; id: string; on: boolean }
  | { type: "active"; id: string | null; revealed?: boolean };

export const commentsKey = new PluginKey<CommentRanges>("comments");

const NO_CUTS: ReadonlyMap<string, Cut> = new Map();

const EMPTY: CommentRanges = {
  ranges: new Map(),
  shown: new Set(),
  active: null,
  decorations: DecorationSet.empty,
  lost: [],
  cut: NO_CUTS,
  revealed: false,
  typing: new Set(),
};

export function commentRanges(state: EditorState): CommentRanges {
  return commentsKey.getState(state) ?? EMPTY;
}

/** Apply changes to the comment ranges, in one transaction. */
export function withRanges(tr: Transaction, ...actions: RangeAction[]): Transaction {
  const before: RangeAction[] = tr.getMeta(commentsKey) ?? [];
  return tr.setMeta(commentsKey, [...before, ...actions]);
}

function className(id: string, active: string | null): string {
  if (id === DRAFT) return "comment-range draft";
  return id === active ? "comment-range active" : "comment-range";
}

/**
 * A comment's words, for screen readers too: a highlight said to be commented (roadmap Batch 12, N-2). Attributes on
 * the span the page draws anyway, not a <mark> element, so the look and what's copied stay as they were.
 */
function decorationFor(id: string, range: Range, active: string | null): Decoration {
  const said = id === DRAFT ? "Comment being written" : "Commented";
  return Decoration.inline(range.from, range.to, { class: className(id, active), "data-comment": id, role: "mark", "aria-description": said }, { id });
}

/** A comment's mark on another page showing the same words: Show changes' (roadmap Batch 25, item 1). */
export const markFor = decorationFor;

function withoutDecoration(set: DecorationSet, id: string): DecorationSet {
  const found = set.find(undefined, undefined, (spec) => spec.id === id);
  return found.length ? set.remove(found) : set;
}

/**
 * Where a comment's end goes through an edit, step by step. Typing right
 * after a comment's text stays outside it. But when the edit replaced the
 * comment's last words (the person selected them and typed), its end moves to
 * the end of what was typed, and while the person carries on typing there
 * (`typing`), the new words join the comment too.
 */
function mapEnd(end: number, mapping: Transaction["mapping"], typing: boolean): { to: number; typedOver: boolean } {
  let to = end;
  let typedOver = typing;
  for (const map of mapping.maps) {
    let moved: number | null = null;
    map.forEach((oldStart, oldEnd, _newStart, newEnd) => {
      if (moved !== null || newEnd <= _newStart) return; // nothing put in here
      const replacedEnd = oldStart < to && to <= oldEnd;
      const typedAtEnd = typedOver && oldStart === to && oldEnd === to;
      if (replacedEnd || typedAtEnd) moved = newEnd;
    });
    if (moved !== null) {
      to = moved;
      typedOver = true;
    } else to = map.map(to, -1);
  }
  return { to, typedOver };
}

/** Map every range through an edit. A range whose text was deleted is lost. */
function mapRanges(
  ranges: ReadonlyMap<string, Range>,
  tr: Transaction,
  typing: ReadonlySet<string>,
): { ranges: Map<string, Range>; lost: string[]; typing: Set<string> } {
  const next = new Map<string, Range>();
  const lost: string[] = [];
  const stillTyping = new Set<string>();
  const { mapping } = tr;
  for (const [id, r] of ranges) {
    // Typing just before or just after a comment's text stays outside it.
    const from = mapping.map(r.from, 1);
    const { to, typedOver } = mapEnd(r.to, mapping, typing.has(id));
    if (to > from) {
      next.set(id, { from, to });
      if (typedOver) stillTyping.add(id);
    } else lost.push(id);
  }
  return { ranges: next, lost, typing: stillTyping };
}

/** The smallest highlighted range around a position. */
export function rangeAt(value: CommentRanges, pos: number): string | null {
  let best: string | null = null;
  let size = Infinity;
  for (const id of value.shown) {
    const r = value.ranges.get(id);
    if (r && r.from <= pos && pos <= r.to && r.to - r.from < size) {
      best = id;
      size = r.to - r.from;
    }
  }
  return best;
}

function apply(tr: Transaction, value: CommentRanges, state: EditorState): CommentRanges {
  const actions: RangeAction[] | undefined = tr.getMeta(commentsKey);
  if (!tr.docChanged && !actions && !tr.selectionSet) {
    return value.lost.length || value.revealed ? { ...value, lost: [], cut: NO_CUTS, revealed: false } : value;
  }
  let ranges: Map<string, Range> = new Map(value.ranges);
  let shown = value.shown as Set<string>;
  let decorations = value.decorations;
  let active = value.active;
  let lost: string[] = [];
  let cut = NO_CUTS;
  let revealed = false;
  let typing = new Set(value.typing);
  const doc = tr.doc;

  const redraw = (id: string) => {
    decorations = withoutDecoration(decorations, id);
    const r = ranges.get(id);
    if (r && shown.has(id)) decorations = decorations.add(doc, [decorationFor(id, r, active)]);
  };

  if (tr.docChanged) {
    ({ ranges, lost, typing } = mapRanges(value.ranges, tr, value.typing));
    if (lost.length) cut = whatWasCut(tr, value.ranges, lost);
    decorations = decorations.map(tr.mapping, doc);
    for (const id of lost) decorations = withoutDecoration(decorations, id);
    // A highlight doesn't grow by itself with what's typed at its end.
    for (const id of typing) redraw(id);
  }

  let activeSet = false;

  for (const action of actions ?? []) {
    switch (action.type) {
      case "reset": {
        ranges = new Map(Object.entries(action.ranges));
        typing = new Set();
        shown = new Set(action.shown.filter((id) => ranges.has(id)));
        if (active && !ranges.has(active)) active = null;
        decorations = DecorationSet.create(
          doc,
          [...shown].map((id) => decorationFor(id, ranges.get(id)!, active)),
        );
        break;
      }
      case "add": {
        ranges.set(action.id, action.range);
        if (action.shown) {
          if (!shown.has(action.id)) shown = new Set(shown).add(action.id);
        } else if (shown.has(action.id)) {
          shown = new Set(shown);
          shown.delete(action.id);
        }
        redraw(action.id);
        break;
      }
      case "remove": {
        ranges.delete(action.id);
        typing.delete(action.id);
        if (shown.has(action.id)) {
          shown = new Set(shown);
          shown.delete(action.id);
        }
        decorations = withoutDecoration(decorations, action.id);
        if (active === action.id) active = null;
        break;
      }
      case "rename": {
        const r = ranges.get(action.from);
        const wasShown = shown.has(action.from);
        ranges.delete(action.from);
        decorations = withoutDecoration(decorations, action.from);
        if (wasShown) {
          shown = new Set(shown);
          shown.delete(action.from);
        }
        if (active === action.from) active = action.to;
        if (typing.delete(action.from) && r) typing.add(action.to);
        if (r) {
          ranges.set(action.to, r);
          if (wasShown) shown = new Set(shown).add(action.to);
          redraw(action.to);
        }
        break;
      }
      case "shown": {
        if (action.on === shown.has(action.id)) break;
        shown = new Set(shown);
        if (action.on) shown.add(action.id);
        else shown.delete(action.id);
        if (!action.on && active === action.id) active = null;
        redraw(action.id);
        break;
      }
      case "active": {
        const previous = active;
        active = action.id;
        activeSet = true;
        revealed = !!action.revealed && previous !== active;
        if (previous && previous !== active) redraw(previous);
        if (active && previous !== active) redraw(active);
        break;
      }
    }
  }

  // Moving the cursor puts the comment it's in into focus.
  if (!activeSet && (tr.selectionSet || tr.docChanged)) {
    const next = rangeAt({ ...value, ranges, shown }, state.selection.head);
    if (next !== active) {
      const previous = active;
      active = next;
      revealed = next !== null;
      if (previous) redraw(previous);
      if (next) redraw(next);
    }
  }
  // Typing over a comment's words carries on only while the cursor stays at their end.
  const { empty, head } = state.selection;
  for (const id of typing) if (!empty || ranges.get(id)?.to !== head) typing.delete(id);
  return { ranges, shown, active, decorations, lost, cut, revealed, typing };
}

export interface CommentPluginOptions {
  /** Highlighted text was clicked. */
  clicked?: (id: string) => void;
}

export function commentPlugin(options: CommentPluginOptions = {}): Plugin<CommentRanges> {
  return new Plugin<CommentRanges>({
    key: commentsKey,
    state: {
      init: () => EMPTY,
      apply: (tr, value, _old, state) => apply(tr, value, state),
    },
    props: {
      decorations(state) {
        return commentRanges(state).decorations;
      },
      handleClick(view, pos) {
        const value = commentRanges(view.state);
        const id = rangeAt(value, pos);
        if (id && id !== value.active) {
          view.dispatch(withRanges(view.state.tr, { type: "active", id, revealed: true }));
        }
        if (id) options.clicked?.(id);
        return false;
      },
    },
  });
}
