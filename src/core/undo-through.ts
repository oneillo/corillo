// The person's own Undo, through a change someone else made to the open
// document: an agent's, or another app's (roadmap Batch 7, item 2). As in
// Word, Undo never undoes someone else's change, and the person's own history
// survives it: each of their earlier steps is carried through the change and
// takes back just what it did, where its words are now. A step whose words
// the change touched can't be taken back cleanly (it would take the change's
// own words out again, or put old words back among them), so Undo stops
// there: that step, and every one before it, is dropped, never forced. Redo
// the same.
//
// ProseMirror's history keeps each step and carries the steps through changes
// that aren't for Undo ("addToHistory" false), but it would undo a step the
// change touched as best it could, over the change's words. So the history is
// read here and cut where one of its steps meets the change. How the history
// is kept isn't part of ProseMirror's published interface: if it isn't as
// expected, the history is emptied, as before this (Undo starts afresh after
// the change), never guessed at.
import { history } from "prosemirror-history";
import type { Node as DocNode } from "prosemirror-model";
import type { EditorState, Transaction } from "prosemirror-state";
import { ReplaceStep, type Step, type StepMap } from "prosemirror-transform";

/** A stretch of the document, from..to (the same for a place). */
export interface Stretch {
  from: number;
  to: number;
}

/** A stretch the change replaced; `gone`: with nothing (words only taken out). */
export interface Replaced extends Stretch {
  gone?: boolean;
}

// The history as prosemirror-history 1.5 keeps it: for Undo and for Redo, a
// list of items, oldest first. Each has the map of a step, and, unless it
// only says where a change that isn't for Undo moved things, the step that
// takes it back; the first item of each event (one press of Undo) also has
// the selection from before it.
interface Item {
  map: StepMap;
  step?: Step;
  selection?: unknown;
}
interface Items {
  readonly length: number;
  get(i: number): Item;
  slice(from: number, to?: number): Items;
}
interface Branch {
  readonly items: Items;
  readonly eventCount: number;
  addMaps(maps: readonly StepMap[]): Branch;
  /** How many of its items only say where a change moved things. */
  emptyItemCount(): number;
  /** The branch with those items folded into the steps under them. */
  compress(): Branch;
}
interface HistoryState {
  readonly done: Branch;
  readonly undone: Branch;
}

/** The history plugin's key and its first state, as every editor's history has them. */
const HISTORY = history();
const KEY = HISTORY.spec.key!;

/** Past this many places in one step (a Replace All), they count as one stretch from the first to the last. */
const MAX_REACHES = 50;

/**
 * Past this many items that only say where a change moved things, a branch is
 * compressed: they're folded into the person's steps under them. Each change
 * adds one per stretch it replaced, and the history library folds them only
 * when changes come from collaborators, so without this a tab taking change
 * after change kept them all, and each Undo went through every one (review
 * of Batch 7, B7-R03). The library's own limit for the same.
 */
const MAX_EMPTY_ITEMS = 500;

const isBranch = (b: unknown): b is Branch => {
  const branch = b as Partial<Branch> | null;
  const items = branch?.items as Partial<Items> | undefined;
  return (
    !!branch &&
    typeof branch.eventCount === "number" &&
    typeof branch.addMaps === "function" &&
    typeof branch.emptyItemCount === "function" &&
    typeof branch.compress === "function" &&
    !!items &&
    typeof items.length === "number" &&
    typeof items.get === "function" &&
    typeof items.slice === "function"
  );
};

/**
 * Whether a step's stretch meets one the change replaced: they overlap, or
 * one is a place inside the other, or both are the same place, or the step's
 * place is at the edge of words the change only took out (after the change,
 * the very place where they were).
 */
export function meets(step: Stretch, change: Replaced): boolean {
  if (step.from < change.to && step.to > change.from) return true;
  if (step.from !== step.to) return false;
  if (change.from === change.to) return step.from === change.from;
  return !!change.gone && step.from >= change.from && step.from <= change.to;
}

/** Where a step reaches in the document it applies to. A step of no known reach (the document's own attributes) reaches everywhere. */
function reachOf(step: Step): Stretch[] {
  const out: Stretch[] = [];
  const s = step as unknown as { from?: unknown; to?: unknown; pos?: unknown };
  if (typeof s.from === "number" && typeof s.to === "number") out.push({ from: s.from, to: s.to });
  else if (typeof s.pos === "number") out.push({ from: s.pos, to: s.pos + 1 });
  step.getMap().forEach((from, to) => {
    out.push({ from, to });
  });
  if (!out.length) return [{ from: 0, to: Infinity }];
  if (out.length <= MAX_REACHES) return out;
  let from = Infinity;
  let to = -Infinity;
  for (const r of out) {
    from = Math.min(from, r.from);
    to = Math.max(to, r.to);
  }
  return [{ from, to }];
}

/**
 * A branch of the history (Undo's or Redo's) with the events from the newest
 * one that meets the change back to the oldest taken out. `changed`: the
 * stretches the change replaced, in the document as it is before it (after
 * the newest item). Each is taken back item by item, widened where it's
 * unclear, so a step is never taken for clear of the change when it isn't.
 */
function cut(branch: Branch, changed: readonly Replaced[]): Branch {
  const items = branch.items;
  if (!branch.eventCount || !changed.length) return branch;
  let stretches = changed.map((c) => ({ ...c }));
  /** Where the event after the one being looked at starts. */
  let newer = items.length;
  for (let i = items.length - 1; i >= 0; i--) {
    const item = items.get(i);
    if (typeof item?.map?.invert !== "function") throw new Error("not a history item");
    if (item.step) {
      for (const reach of reachOf(item.step)) {
        if (stretches.some((c) => meets(reach, c))) return keepFrom(branch, newer);
      }
    }
    if (item.selection) newer = i;
    const back = item.map.invert();
    stretches = stretches.map((c) => {
      const from = back.map(c.from, -1);
      return { from, to: Math.max(from, back.map(c.to, 1)), gone: c.gone };
    });
  }
  return branch;
}

/** What a change replaced, each stretch marked when the change only took words out of it. */
function replacedBy(tr: Transaction, changed: readonly Stretch[]): Replaced[] {
  return changed.map((c) => ({ ...c, gone: c.to > c.from && tr.mapping.map(c.from, -1) === tr.mapping.map(c.to, 1) }));
}

/** The branch, compressed once its items that only map pass the limit. */
function compact(branch: Branch): Branch {
  if (!branch.eventCount || branch.items.length <= MAX_EMPTY_ITEMS || branch.emptyItemCount() <= MAX_EMPTY_ITEMS) return branch;
  const compressed = branch.compress();
  if (!isBranch(compressed)) throw new Error("not a history");
  return compressed;
}

/** The branch from its item `from` on: the events that start there and after. */
function keepFrom(branch: Branch, from: number): Branch {
  const items = branch.items.slice(from);
  let events = 0;
  for (let i = 0; i < items.length; i++) if (items.get(i).selection) events++;
  const Made = branch.constructor as new (items: Items, eventCount: number) => Branch;
  return new Made(items, events);
}

/**
 * Give `tr`, a change someone else made to the document in `state` (not a
 * step for Undo), the person's history carried through it: their Undo and
 * Redo go on as before, and stop at a step whose words the change touched.
 * `changed`: what the change replaced, in `state`'s document, in order. The
 * person's next edit after it is an Undo step of its own.
 */
export function undoThrough(tr: Transaction, state: EditorState, changed: readonly Stretch[]): Transaction {
  const was = KEY.getState(state) as HistoryState | undefined;
  if (!was) return tr;
  let next: unknown;
  try {
    if (!isBranch(was.done) || !isBranch(was.undone)) throw new Error("not a history");
    const maps = tr.mapping.maps;
    const replaced = replacedBy(tr, changed);
    const done = compact(cut(was.done, replaced).addMaps(maps));
    const undone = compact(cut(was.undone, replaced).addMaps(maps));
    const Made = was.constructor as new (done: Branch, undone: Branch, prevRanges: null, prevTime: number, prevComposition: number) => HistoryState;
    next = new Made(done, undone, null, 0, -1);
  } catch {
    next = HISTORY.spec.state!.init({}, state); // an empty history, as a new editor has
  }
  return tr.setMeta(KEY, { historyState: next, redo: false });
}

/** A comment's places kept with a text it had (just before or after an option was chosen), for Undo and Redo back to that text. */
export interface Kept {
  doc: DocNode;
  ranges: ReadonlyMap<string, Stretch>;
}

/**
 * The kept texts and comment places, carried through `tr`, a change someone
 * else made: each text as it now would be, which Undo or Redo can bring back,
 * and the places of the comments on the part where it differs from the
 * document (Undo and Redo don't move the others: the editor keeps them). The
 * text the change was made to is now the document after it, with the
 * comments where they are now (`now`). Another text is carried only when the
 * change didn't touch where it differs; one it did is dropped, as nothing
 * can come back to it as it was. Touching is as for the person's Undo steps
 * (`meets`), so a text is kept just when Undo can still go back to it: words
 * the change put in or rewrote right up against the differing part, not into
 * it, don't touch it, and stay beside it (review of Batch 7, B7-R07).
 */
export function keptThrough(kept: readonly Kept[], tr: Transaction, changed: readonly Stretch[], now: ReadonlyMap<string, Stretch>): Kept[] {
  const out: Kept[] = [];
  const before = tr.before;
  const replaced = replacedBy(tr, changed);
  for (const k of kept) {
    try {
      const start = before.content.findDiffStart(k.doc.content);
      if (start == null) {
        out.push({ doc: tr.doc, ranges: new Map(now) });
        continue;
      }
      const end = before.content.findDiffEnd(k.doc.content);
      if (!end) continue;
      // Where the two share words at both ends of what differs, the end is taken after the start.
      const shift = Math.max(0, start - Math.min(end.a, end.b));
      const endBefore = end.a + shift;
      const endKept = end.b + shift;
      if (replaced.some((c) => meets({ from: start, to: endBefore }, c))) continue;
      const slice = k.doc.slice(start, endKept);
      const back = new ReplaceStep(start, endBefore, slice).apply(before).doc;
      if (!back?.eq(k.doc)) continue;
      // Where the differing part is now: what the change put in at its edges stays outside it, as Undo's step leaves it.
      const from = tr.mapping.map(start, 1);
      const to = tr.mapping.map(endBefore, -1);
      if (to - from !== endBefore - start) continue;
      const doc = new ReplaceStep(from, to, slice).apply(tr.doc).doc;
      if (!doc) continue;
      // A place in the kept text, in it as it now would be: before what differs and after it, where the change moved it.
      const grown = endKept - start - (to - from);
      const place = (pos: number, assoc: number) =>
        pos < start ? tr.mapping.map(pos, assoc) : pos <= endKept ? from + pos - start : tr.mapping.map(pos - endKept + endBefore, assoc) + grown;
      const ranges = new Map<string, Stretch>();
      for (const [id, r] of k.ranges) {
        if (r.to < start || r.from > endKept) continue;
        const a = place(r.from, 1);
        ranges.set(id, { from: a, to: Math.max(a, place(r.to, -1)) });
      }
      out.push({ doc, ranges });
    } catch {
      // Not carried: Undo or Redo back to it leaves the comments to the editor.
    }
  }
  return out;
}
