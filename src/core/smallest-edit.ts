// An agent's change (or another app's) to an open document, as an edit
// (roadmap Batch 7, item 1): the document the page shows is changed only
// where the new text differs, so everything else stays as it is, the very
// same blocks, which the page doesn't draw again, and the person's place can
// be carried through. Unchanged blocks keep the text the file has for them, so
// they're still written back byte for byte. Where the edit can't bring the
// page exactly to what the new text reads as, there's no edit: the page is
// read again from the text, as before.
//
// The Markdown view's text gets the same: only the lines that changed are
// replaced.
import { Fragment, Slice, type Node } from "prosemirror-model";
import { Transform } from "prosemirror-transform";
import { diffWithin } from "./diff";
import { serializeMarkdown, type Loaded, type Source } from "./markdown";

/** A stretch of the document as it was, replaced by the edit. */
export interface Changed {
  from: number;
  to: number;
}

export interface PageEdit {
  /** What the new document is written back with: the new text's, its blocks the nodes now on the page. */
  source: Source;
  /** What the edit replaced, in the document as it was, from first to last (none when only the file's bytes changed, not what it reads as). */
  changed: Changed[];
}

/** Runs of top-level blocks that differ: [fromA, toA) of the first document became [fromB, toB) of the second. */
export interface Run {
  fromA: number;
  toA: number;
  fromB: number;
  toB: number;
}

/** Past this many blocks added and taken out between the first and last change, the blocks between are replaced as one stretch. */
const MAX_BLOCK_CHANGES = 500;

/**
 * Which top-level blocks differ between two documents: the same blocks
 * before, between and after the places that changed are matched up, so two
 * changes far apart (an agent's edits near the top and the bottom) are two
 * runs, not one stretch with everything between.
 */
export function changedRuns(a: Node, b: Node): Run[] {
  const n = a.childCount;
  const m = b.childCount;
  let start = 0;
  while (start < n && start < m && a.child(start).eq(b.child(start))) start++;
  let endA = n;
  let endB = m;
  while (endA > start && endB > start && a.child(endA - 1).eq(b.child(endB - 1))) {
    endA--;
    endB--;
  }
  if (start === endA && start === endB) return [];
  // Between them, blocks are matched by their kind and words (quick to
  // compare), then checked to be the very same (formatting, attributes).
  // Blocks with no words (an empty line, a picture, a rule) by all they hold,
  // or every one would match every other, and a picture moved past empty
  // lines would take the place of one, which would then be drawn again.
  const ids = new Map<string, number>();
  const idOf = (node: Node) => {
    const key = `${node.type.name}\u0000${node.textContent || JSON.stringify(node.toJSON())}`;
    let id = ids.get(key);
    if (id === undefined) ids.set(key, (id = ids.size));
    return id;
  };
  const xs: number[] = [];
  const ys: number[] = [];
  for (let i = start; i < endA; i++) xs.push(idOf(a.child(i)));
  for (let j = start; j < endB; j++) ys.push(idOf(b.child(j)));
  const ops = diffWithin(xs, ys, (x, y) => x === y, MAX_BLOCK_CHANGES);
  if (!ops) return [{ fromA: start, toA: endA, fromB: start, toB: endB }];
  const runs: Run[] = [];
  let run: Run | null = null;
  let i = start;
  let j = start;
  for (const op of ops) {
    if (op.type === "same" && a.child(i).eq(b.child(j))) {
      run = null;
      i++;
      j++;
      continue;
    }
    if (!run) runs.push((run = { fromA: i, toA: i, fromB: j, toB: j }));
    // (Blocks with the same words that aren't the same, bold added say, are one taken out and one put in.)
    if (op.type !== "added") run.toA = ++i;
    if (op.type !== "removed") run.toB = ++j;
  }
  return runs;
}

/** Where each top-level block starts, and at the end, the document's size. */
function starts(doc: Node): number[] {
  const out: number[] = [];
  let pos = 0;
  doc.forEach((child) => {
    out.push(pos);
    pos += child.nodeSize;
  });
  out.push(pos);
  return out;
}

/**
 * Inside one block replaced by one block: the stretch where they differ, from
 * `from` to `toA` in the first (which starts at `posA`), `fromB` to `toB` in
 * the second (at `posB`). The whole block when its kind or attributes changed.
 */
function stretchIn(a: Node, b: Node, posA: number, posB: number): { from: number; toA: number; fromB: number; toB: number } {
  const one = Fragment.from(a);
  const other = Fragment.from(b);
  const from = one.findDiffStart(other, posA) ?? posA;
  const fromB = from - posA + posB;
  const end = one.findDiffEnd(other, posA + a.nodeSize, posB + b.nodeSize);
  let toA = end?.a ?? posA + a.nodeSize;
  let toB = end?.b ?? posB + b.nodeSize;
  // Where the same words repeat, the two ends can cross: the change goes after
  // the start, as long as one block is longer than the other. (Each end is
  // counted from its own block's start: the blocks needn't be at the same place.)
  const grew = b.nodeSize - a.nodeSize;
  if (toA < from && grew > 0) {
    toB = fromB + grew;
    toA = from;
  } else if (toB < fromB) {
    toA = from - grew;
    toB = fromB;
  }
  // Never a stretch backwards (the editor library never finishes putting one in): the whole block.
  if (toA < from || toB < fromB) return { from: posA, toA: posA + a.nodeSize, fromB: posB, toB: posB + b.nodeSize };
  return { from, toA, fromB, toB };
}

/** The steps from `a` to `b`, on a scratch copy; null when they don't reach `b`. */
function stepsTo(a: Node, b: Node, runs: Run[], inBlocks: boolean): { tr: Transform; changed: Changed[] } | null {
  const tr = new Transform(a);
  const at = starts(a);
  const bt = starts(b);
  const changed: Changed[] = [];
  try {
    // From the last to the first, so the runs still to do keep their places.
    for (let r = runs.length - 1; r >= 0; r--) {
      const { fromA, toA, fromB, toB } = runs[r];
      if (inBlocks && toA - fromA === 1 && toB - fromB === 1) {
        // One block changed: only where it changed, so the rest of it (the
        // words around, the cursor in them) stays as it is.
        const s = stretchIn(a.child(fromA), b.child(fromB), at[fromA], bt[fromB]);
        tr.replace(s.from, s.toA, b.slice(s.fromB, s.toB));
        changed.push({ from: s.from, to: s.toA });
      } else {
        tr.replace(at[fromA], at[toA], new Slice(b.content.cut(bt[fromB], bt[toB]), 0, 0));
        changed.push({ from: at[fromA], to: at[toA] });
      }
    }
  } catch {
    return null;
  }
  return tr.doc.eq(b) ? { tr, changed: changed.reverse() } : null;
}

/**
 * Bring `tr`'s document to what `text` reads as (`next`, read from it),
 * changing only the blocks that differ. Null when that can't be done exactly
 * (the page would show something else than the file holds, or write it back
 * differently): then `tr` is to be dropped, and the text read afresh.
 */
export function editTo(tr: Transform, next: Loaded, text: string): PageEdit | null {
  try {
    const before = tr.doc;
    const after = next.doc;
    const runs = changedRuns(before, after);
    const found = stepsTo(before, after, runs, true) ?? stepsTo(before, after, runs, false);
    if (!found) return null;
    for (const step of found.tr.steps) if (tr.maybeStep(step).failed) return null;
    if (!tr.doc.eq(after)) return null;
    // The new text's blocks, each the node now in the document: unchanged
    // blocks are the ones the page already shows, and are written back as the file has them.
    const blocks = next.source.blocks;
    let source: Source;
    if (blocks.length === tr.doc.childCount) {
      source = { ...next.source, blocks: blocks.map((block, i) => ({ node: tr.doc.child(i), text: block.text })) };
    } else if (!blocks.length) source = next.source;
    else return null;
    if (serializeMarkdown(tr.doc, source) !== text) return null;
    return { source, changed: found.changed };
  } catch {
    return null;
  }
}

/** A stretch of a text replaced: [from, to) of the text as it was became `insert`. */
export interface TextChange {
  from: number;
  to: number;
  insert: string;
}

/** Past this many lines added and taken out, the text changes in one stretch. */
const MAX_LINE_CHANGES = 2000;

/**
 * What changed between two versions of a text, as few small stretches: the
 * lines that changed, each run of them cut down to where it differs. In
 * order, none overlapping; apply from the last back. Empty when nothing changed.
 */
export function textChanges(before: string, after: string): TextChange[] {
  if (before === after) return [];
  // Each line with the line break after it, the last one's too, so lines
  // are counted alike in both (taken off again at the end).
  const a = before + "\n";
  const b = after + "\n";
  const ops = diffWithin(before.split("\n"), after.split("\n"), (x, y) => x === y, MAX_LINE_CHANGES);
  if (!ops) return [inBefore(a, b, 0, a.length, 0, b.length)];
  const out: TextChange[] = [];
  // Where the next line starts in each.
  let atA = 0;
  let atB = 0;
  let run: { fromA: number; fromB: number } | null = null;
  const close = () => {
    if (run) out.push(inBefore(a, b, run.fromA, atA, run.fromB, atB));
    run = null;
  };
  for (const op of ops) {
    if (op.type === "same") {
      close();
      atA += op.a.length + 1;
      atB += op.b.length + 1;
      continue;
    }
    run ??= { fromA: atA, fromB: atB };
    if (op.type === "removed") atA += op.a.length + 1;
    else atB += op.b.length + 1;
  }
  close();
  return out;
}

/**
 * [fromA, toA) of `a` became [fromB, toB) of `b` (whole lines of the two
 * texts, each with a line break added at its end): cut down to where they
 * differ, as a change to the text without that added line break.
 */
function inBefore(a: string, b: string, fromA: number, toA: number, fromB: number, toB: number): TextChange {
  while (fromA < toA && fromB < toB && a.charCodeAt(fromA) === b.charCodeAt(fromB)) {
    fromA++;
    fromB++;
  }
  while (toA > fromA && toB > fromB && a.charCodeAt(toA - 1) === b.charCodeAt(toB - 1)) {
    toA--;
    toB--;
  }
  // Lines taken out or put in at the very end take the line break before
  // them, not the one added after: the same change, one place earlier.
  if (toA === a.length) {
    fromA--;
    toA--;
    fromB--;
    toB--;
  }
  return { from: fromA, to: toA, insert: b.slice(fromB, toB) };
}

/** A text with these changes made. */
export function applyTextChanges(text: string, changes: readonly TextChange[]): string {
  let out = text;
  for (let i = changes.length - 1; i >= 0; i--) out = out.slice(0, changes[i].from) + changes[i].insert + out.slice(changes[i].to);
  return out;
}
