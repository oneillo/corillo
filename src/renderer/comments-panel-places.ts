// Keeping comments on their words through each change: plain functions over the editor's document and the comments, with no cards.
import type { Transaction } from "prosemirror-state";
import type { Node as DocNode, Slice } from "prosemirror-model";
import type { EditorView } from "prosemirror-view";
import { anchorFor, anchorIn, CONTEXT, findAnchor, locate, looseText, offsetAt, posAt, textIndex, type Anchor, type TextIndex } from "../core/anchors";
import { changedRanges } from "./changed-ranges";
import type { AnchorUpdate, Thread } from "../core/comments";
import { commentRanges, textRuns, withRanges, DRAFT, type CommentRanges, type Cut, type Range, type RangeAction } from "./comments";
import { placesThroughHistory, type KeptPlaces } from "../core/options";
import { changeMarks, withChanges, type ChangeAction } from "./change-marks";
import { PICTURE_STAND_IN } from "../core/doc-diff";

export const sameAnchor = (a: Anchor | null, b: Anchor | null) =>
  a === b ||
  (!!a && !!b && a.quote === b.quote && a.prefix === b.prefix && a.suffix === b.suffix && a.offset === b.offset);

/**
 * Where a comment's words are in the document. Once its words were deleted
 * (it has a gap), only the words themselves count, not text that merely sits
 * where they were: the empty line shows that place. And only the words put
 * back where they were (spec: "Words deleted keep their empty line even when
 * the same words are elsewhere"): between the text either side of its empty
 * line, and, when a change just put text in (`putIn`: an Undo's or Redo's),
 * in that text, put in where its empty line is (`line`, as drawn now).
 */
export function findText(
  doc: EditorView["state"]["doc"],
  t: Thread,
  index: TextIndex,
  gapped = !!t.gap,
  putIn?: readonly Range[],
  line?: { pos: number },
): Range | null {
  const range = t.anchor ? findAnchor(doc, t.anchor, index) : null;
  if (!range || !gapped || !t.anchor) return range;
  if (doc.textBetween(range.from, range.to, "\n", PICTURE_STAND_IN) !== t.anchor.quote) return null;
  if (putIn) {
    const into = putIn.filter((r) => overlaps(range, r));
    if (!into.length || (line && !into.some((r) => r.from <= line.pos && line.pos <= r.to))) return null;
  }
  return !t.gap || atGap(index.text, t.gap, offsetAt(index, range.from), offsetAt(index, range.to)) ? range : null;
}

/** Whether some text was put in within a range (an Undo can put back only part of a comment's words; taking text out next to them puts none in). */
const overlaps = (range: Range, r: Range) => r.to > r.from && range.from < r.to && range.to > r.from;

/**
 * Whether words at text[start, end) sit where a comment's deleted words were:
 * after the text that was just before its empty line, and before the text
 * that was just after it, with whatever else was put back between. The same
 * words anywhere else are on the far side of one of the two.
 */
function atGap(text: string, gap: Anchor, start: number, end: number): boolean {
  const { prefix, suffix } = gap;
  // Less than a full stretch remembered: the empty line was that near the document's start (or end).
  const before = prefix.length < CONTEXT ? text.startsWith(prefix) && prefix.length <= start : text.lastIndexOf(prefix, start - prefix.length) >= 0;
  const after =
    suffix.length < CONTEXT ? text.endsWith(suffix) && text.length - suffix.length >= end : text.indexOf(suffix, end) >= 0;
  return before && after;
}

/** The stretches a change put in, in the document shown after it (`doc`); null when it can't say (then the whole document is looked at). */
export function putInBy(tr: Transaction, doc: DocNode): Range[] | null {
  if (doc !== tr.doc) return null; // something tidied it after, moving what it put in
  return changedRanges(tr)?.map(([from, to]) => ({ from, to })) ?? null;
}

/**
 * Whether a comment's words could be in text just put in: a quick look at
 * those stretches (and as much again either side), so an Undo doesn't search
 * the whole document for each comment that lost its words.
 */
function couldBeIn(doc: EditorView["state"]["doc"], quote: string, putIn: readonly Range[]): boolean {
  const want = looseText(quote).text;
  const reach = 2 * quote.length + 2;
  return putIn.some((r) => {
    const from = Math.max(0, r.from - reach);
    const to = Math.min(doc.content.size, r.to + reach);
    return looseText(doc.textBetween(from, to, "\n", PICTURE_STAND_IN)).text.includes(want);
  });
}

/**
 * Undo and Redo of a choice put its words back letter by letter, which can
 * leave a comment on a letter the two versions share (roadmap Batch 6).
 * Back to the text as it was just before or after a choice, the comments go
 * back to where they were then. Any other step is left to the editor,
 * which follows the person's own typing exactly (B6-R01). Whether one moved.
 */
export function carryThroughHistory(
  view: EditorView,
  tr: Transaction,
  placesWere: { doc: DocNode; value: CommentRanges } | null,
  choicePlaces: readonly KeptPlaces<DocNode>[],
): boolean {
  const was = placesWere;
  if (!choicePlaces.length || was?.doc !== tr.before || view.state.doc !== tr.doc || !was.value.ranges.size) return false;
  const same = (a: DocNode, b: DocNode) => a.content.size === b.content.size && a.eq(b);
  const moved = [...placesThroughHistory(choicePlaces, tr.doc, same, was.value.ranges, commentRanges(view.state).ranges)];
  if (!moved.length) return false;
  view.dispatch(withRanges(view.state.tr, ...moved.map(([id, range]) => ({ type: "add" as const, id, range, shown: was.value.shown.has(id) }))));
  return true;
}

/**
 * Put a comment whose words were deleted back on them when a change puts
 * back what was taken with them, as it was (pasted, dropped, or put back in
 * the Markdown text): only that, never other words that hold them. Cheap
 * enough for every keystroke and for a Replace All of thousands: nothing is
 * read unless a comment has lost its words, and then only what each step
 * put in that is at least as long as what was taken; the document is read
 * only where that matches. Whether one was put back.
 */
export function putBack(
  view: EditorView,
  tr: Transaction,
  threads: readonly Thread[],
  cuts: Map<string, Cut>,
  regained: Set<string>,
  notFound: Set<string>,
): boolean {
  const gaps = changeMarks(view.state).gaps;
  for (const id of cuts.keys()) if (!gaps.has(id)) cuts.delete(id);
  if (!gaps.size) return false;
  let shortest = Infinity;
  for (const [id, g] of gaps) shortest = Math.min(shortest, cuts.get(id)?.text.length ?? g.text.trim().length);
  const ranges = commentRanges(view.state).ranges;
  const found = new Map<string, Range>();
  tr.steps.forEach((step, i) => {
    // What a step put in: only a plain replacement's content is read (a list wrapped or lifted puts no words in).
    const { from, slice, gapFrom } = step as unknown as { from?: number; slice?: Slice; gapFrom?: number };
    if (typeof from !== "number" || !slice || gapFrom !== undefined || slice.size < shortest) return;
    const text = slice.content.textBetween(0, slice.size, "\n", PICTURE_STAND_IN).trim();
    if (text.length < shortest) return;
    for (const [id, g] of gaps) {
      if (found.has(id) || ranges.has(id)) continue;
      const cut = cuts.get(id) ?? { text: g.text.trim(), from: 0, to: g.text.trim().length };
      if (cut.text !== text) continue;
      // Where its words are in what was put in, then through the steps after.
      const doc = i + 1 < tr.docs.length ? tr.docs[i + 1] : tr.doc;
      const runs = textRuns(doc, from, from + slice.size);
      const lead = runs.text.length - runs.text.trimStart().length;
      let start = posAt(runs, lead + cut.from, "start");
      let end = posAt(runs, lead + cut.to, "end");
      for (let j = i + 1; j < tr.steps.length && end > start; j++) {
        start = tr.mapping.maps[j].map(start, 1);
        end = tr.mapping.maps[j].map(end, -1);
      }
      if (end > start && textRuns(tr.doc, start, end).text === cut.text.slice(cut.from, cut.to)) found.set(id, { from: start, to: end });
    }
  });
  if (!found.size) return false;
  const byId = new Map(threads.map((t) => [t.id, t]));
  const actions: RangeAction[] = [];
  for (const [id, range] of found) {
    const t = byId.get(id);
    if (!t) continue;
    if (t.gap) regained.add(id);
    notFound.delete(id);
    cuts.delete(id);
    actions.push({ type: "add", id, range, shown: t.status === "open" });
  }
  if (actions.length) view.dispatch(withRanges(view.state.tr, ...actions));
  return actions.length > 0;
}

/**
 * Keep an empty line where each open comment's deleted words were (as
 * Corillo last knew it), and none for comments that are resolved, deleted or
 * have their words back. With `all`, the text was replaced: place them anew.
 */
export function placeGaps(view: EditorView, threads: readonly Thread[], all = false): void {
  if (!view) return;
  const state = view.state;
  const gaps = changeMarks(state).gaps;
  const ranges = commentRanges(state).ranges;
  const actions: ChangeAction[] = [];
  let index: TextIndex | null = null;
  const byId = new Map(threads.map((t) => [t.id, t]));
  for (const id of gaps.keys()) {
    const t = byId.get(id);
    if (!t || t.status !== "open" || ranges.has(id)) actions.push({ type: "gap", id, gap: null });
  }
  for (const t of threads) {
    if (!t.gap || !t.anchor || t.status !== "open" || ranges.has(t.id)) continue;
    if (gaps.has(t.id) && !all) continue;
    index ??= textIndex(state.doc);
    const at = locate(index.text, t.gap);
    if (!at) {
      if (gaps.has(t.id)) actions.push({ type: "gap", id: t.id, gap: null });
      continue;
    }
    actions.push({ type: "gap", id: t.id, gap: { pos: posAt(index, at.start, "start"), text: t.anchor.quote } });
  }
  if (actions.length) {
    view.dispatch(withChanges(view.state.tr, ...actions));
  }
}

/**
 * Find every comment in the text again, and the comment being written
 * (`draft`), as reanchor does: `focus`'s comment stays in focus if it's still
 * there, and so does an agent's note (a note that's gone is cleared by the
 * panel's setNotes).
 */
export function findEvery(
  view: EditorView,
  threads: readonly Thread[],
  draft: { anchored: boolean; anchor: Anchor | null } | null,
  focus: { active: string | null; selected: string | null } | null,
  regained: Set<string>,
  notFound: Set<string>,
): void {
  const doc = view.state.doc;
  const index = textIndex(doc);
  const ranges: Record<string, Range> = {};
  const shown: string[] = [];
  notFound.clear();
  for (const t of threads) {
    if (!t.anchor) continue;
    const range = findText(doc, t, index);
    if (range) {
      if (t.gap) regained.add(t.id);
      ranges[t.id] = range;
      if (t.status === "open") shown.push(t.id);
    } else notFound.add(t.id);
  }
  if (draft?.anchored && draft.anchor) {
    const range = findAnchor(doc, draft.anchor, index);
    if (range) {
      ranges[DRAFT] = range;
      shown.push(DRAFT);
    }
  }
  const tr = withRanges(view.state.tr, { type: "reset", ranges, shown });
  const active = focus?.active;
  if (active && (active === DRAFT ? !!ranges[DRAFT] : threads.some((t) => t.id === active))) withRanges(tr, { type: "active", id: active });
  // An agent's note in focus (selected with no comment active) stays so too.
  else if (!active && focus?.selected) withChanges(tr, { type: "select", owner: focus.selected });
  view.dispatch(tr);
}

/**
 * Comments that lost their words, found again on them where `putIn` (the
 * stretches a change just put in) holds them; null when the change can't
 * say where it put text in.
 */
export function refindLost(
  view: EditorView,
  threads: readonly Thread[],
  putIn: readonly Range[] | null,
  regained: Set<string>,
  notFound: Set<string>,
): boolean {
  const doc = view.state.doc;
  const value = commentRanges(view.state);
  // Words deleted just now have their empty line before Corillo is told: only the words themselves bring them back.
  const gaps = changeMarks(view.state).gaps;
  const actions: RangeAction[] = [];
  let index: TextIndex | null = null;
  for (const t of threads) {
    if (!t.anchor || value.ranges.has(t.id)) continue;
    if (putIn && !couldBeIn(doc, t.anchor.quote, putIn)) continue;
    index ??= textIndex(doc);
    const found = findText(doc, t, index, !!t.gap || gaps.has(t.id), putIn ?? undefined, gaps.get(t.id));
    const range = found && (!putIn || putIn.some((r) => overlaps(found, r))) ? found : null;
    if (range) {
      if (t.gap) regained.add(t.id);
      actions.push({ type: "add", id: t.id, range, shown: t.status === "open" });
      notFound.delete(t.id);
    }
  }
  if (actions.length) view.dispatch(withRanges(view.state.tr, ...actions));
  return actions.length > 0;
}

/**
 * Where each comment's text is now, for telling the app (saveAnchors): the
 * comments with their places brought up to date, what changed, and whether a
 * comment now quotes other words (`requote`).
 */
export function placesToTell(
  view: EditorView,
  threads: readonly Thread[],
  regained: Set<string>,
): {
  threads: Thread[];
  changes: Record<string, AnchorUpdate>;
  any: boolean;
  requote: boolean;
  value: CommentRanges;
  doc: DocNode;
  index: TextIndex | null;
} {
  const value = commentRanges(view.state);
  const doc = view.state.doc;
  let index: TextIndex | null = null;
  const changes: Record<string, AnchorUpdate> = {};
  let any = false;
  let requote = false;
  const gaps = changeMarks(view.state).gaps;
  const next = threads.map((t) => {
    if (!t.anchor) return t;
    const range = value.ranges.get(t.id);
    const gap = range ? undefined : gaps.get(t.id);
    if (gap) {
      // Its words were deleted: where they were, so the empty line comes back next time.
      index ??= textIndex(doc);
      const at = offsetAt(index, gap.pos);
      const place = anchorIn(index.text, at, at);
      if (t.gap && sameAnchor(place, t.gap)) return t;
      changes[t.id] = { gap: place };
      any = true;
      return { ...t, gap: place, detached: true };
    }
    // Corillo knows its words were deleted; only their coming back here (Undo, say) says otherwise.
    if (t.gap && !regained.has(t.id)) return t;
    regained.delete(t.id);
    if (!range) {
      if (t.detached) return t;
      changes[t.id] = "detached";
      any = true;
      return { ...t, detached: true };
    }
    index ??= textIndex(doc);
    const anchor = anchorFor(doc, range.from, range.to, index);
    if (!t.detached && !t.gap && sameAnchor(anchor, t.anchor)) return t;
    changes[t.id] = anchor;
    any = true;
    if (anchor.quote !== t.anchor.quote) requote = true;
    return { ...t, anchor, detached: undefined, gap: undefined };
  });
  return { threads: next, changes, any, requote, value, doc, index };
}
