// Which parts of a document an edit touched. Plugins that look after the
// whole document (footnote numbers, table rules) use this to look only at
// what changed, so typing stays fast in a long document.
import type { Transaction } from "prosemirror-state";

export type Range = [from: number, to: number];

/**
 * Beyond this many steps (Replace All of a common word, say), placing each
 * would take longer than looking at everything once: each step's place is
 * carried through every step after it.
 */
const MAX_STEPS = 400;

/**
 * The ranges of the new document that a transaction changed, or null if it
 * made a change this can't place, or too many to place quickly (then look at
 * everything).
 */
export function changedRanges(tr: Transaction): Range[] | null {
  if (tr.steps.length > MAX_STEPS) return null;
  const ranges: Range[] = [];
  for (let i = 0; i < tr.steps.length; i++) {
    const later = tr.mapping.slice(i + 1);
    let placed = false;
    tr.steps[i].getMap().forEach((_oldFrom, _oldTo, from, to) => {
      ranges.push([later.map(from, -1), later.map(to, 1)]);
      placed = true;
    });
    if (ranges.length > MAX_STEPS) return null; // one step of thousands of places (Replace All)
    if (placed) continue;
    // Steps that change marks or attributes move nothing, but say where they apply.
    const step = tr.steps[i] as { from?: unknown; to?: unknown; pos?: unknown };
    if (typeof step.pos === "number") ranges.push([later.map(step.pos, -1), later.map(step.pos + 1, 1)]);
    else if (typeof step.from === "number" && typeof step.to === "number") {
      ranges.push([later.map(step.from, -1), later.map(step.to, 1)]);
    } else return null;
  }
  return ranges;
}

/** The same, across several transactions applied one after another (as appendTransaction gets them). */
export function changedRangesAcross(trs: readonly Transaction[]): Range[] | null {
  let ranges: Range[] = [];
  for (const tr of trs) {
    const own = changedRanges(tr);
    if (!own) return null;
    ranges = ranges.map(([from, to]): Range => [tr.mapping.map(from, -1), tr.mapping.map(to, 1)]);
    ranges.push(...own);
  }
  return ranges;
}
