// What changed between two texts: the passages that differ, word by word, placed in the newer text.
import { readable, tidy, type Piece as DiffPiece } from "./diff";
import { compared } from "./change-links-lines";

/** One changed passage: where it is in the newer text, and what the older text had there. */
export interface Passage {
  start: number;
  end: number;
  removed: string;
}

/**
 * How much the two texts share at the start and at the end, in whole words.
 * Only the middle is compared word by word: an edit in one place is then
 * found in that place, even in a document that repeats itself.
 */
export function sharedEnds(before: string, after: string): { head: number; tail: number } {
  const most = Math.min(before.length, after.length);
  let head = 0;
  while (head < most && before[head] === after[head]) head++;
  if (head < before.length || head < after.length) while (head > 0 && !/\s/.test(before[head - 1])) head--;
  let tail = 0;
  while (tail < most - head && before[before.length - 1 - tail] === after[after.length - 1 - tail]) tail++;
  if (head + tail < before.length || head + tail < after.length) {
    while (tail > 0 && !/\s/.test(before[before.length - tail - 1] ?? " ")) tail--;
  }
  return { head, tail };
}

/** The passages that differ, word by word, placed in the newer text. */
export function changedPieces(before: string, after: string): Passage[] {
  return passagesOf(before, after).joined;
}

/**
 * The passages that differ, two ways: `joined` as a person reads them (a
 * rewritten clause that kept its "and" is one passage), and `apart` without
 * the joins across unchanged words, for telling apart the changes of two
 * comments that ended up either side of a short word. Neither joins changes
 * on two lines: each line is a paragraph, a list item or a table cell, and
 * each keeps its own change. `syncs` are places known to stay together.
 */
export function passagesOf(before: string, after: string, syncs: readonly Sync[] = []): { joined: Passage[]; apart: Passage[] } {
  const joined: Passage[] = [];
  const apart: Passage[] = [];
  for (const { steps, b } of comparison(before, after, syncs)) {
    joined.push(...placed(tidy(readable(steps, true), true), b, after));
    apart.push(...placed(tidy(readable(steps, false), true), b, after));
  }
  return { joined, apart };
}

/** A place in an older text and the same place in the newer one: changes are compared between such places, never across them. */
export type Sync = readonly [number, number];

/**
 * The changes from before to after, for following words (sharedEnds, then
 * compared), in pieces that start where given in the older text (a) and the
 * newer (b). Compared whole where that keeps every sync in an unchanged
 * stretch, as it does for most edits; otherwise compared between the syncs.
 */
export function comparison(before: string, after: string, syncs: readonly Sync[]): { steps: DiffPiece[]; a: number; b: number }[] {
  const whole = stepsOf(before, after);
  if (keeps(whole, syncs, before.length, after.length)) return [{ steps: whole, a: 0, b: 0 }];
  const out: { steps: DiffPiece[]; a: number; b: number }[] = [];
  let a = 0;
  let b = 0;
  for (const [x, y] of [...syncs, [before.length, after.length] as const]) {
    if (x < a || y < b || x > before.length || y > after.length) continue;
    out.push({ steps: stepsOf(before.slice(a, x), after.slice(b, y)), a, b });
    a = x;
    b = y;
  }
  return out;
}

/** The changes from x to y: only the middle is compared (see sharedEnds), and the shared ends are unchanged. */
function stepsOf(x: string, y: string): DiffPiece[] {
  if (x === y) return x ? [{ type: "same", text: x }] : [];
  const { head, tail } = sharedEnds(x, y);
  const steps = compared(x.slice(head, x.length - tail), y.slice(head, y.length - tail));
  if (head) steps.unshift({ type: "same", text: x.slice(0, head) });
  if (tail) steps.push({ type: "same", text: x.slice(x.length - tail) });
  return steps;
}

/** Whether every sync falls in an unchanged stretch of these steps, at the same place in both texts (the texts' starts and ends always do). */
function keeps(steps: DiffPiece[], syncs: readonly Sync[], la: number, lb: number): boolean {
  const left = syncs.filter(([x, y]) => (x || y) && (x !== la || y !== lb));
  let k = 0;
  let a = 0;
  let b = 0;
  for (const s of steps) {
    const length = s.type === "added" ? 0 : s.text.length;
    if (s.type === "same") {
      for (; k < left.length && left[k][0] <= a + length; k++) {
        const [x, y] = left[k];
        if (x < a || y - b !== x - a) return false;
      }
    }
    a += length;
    b += s.type === "removed" ? 0 : s.text.length;
  }
  return k === left.length;
}

function placed(steps: DiffPiece[], head: number, after: string): Passage[] {
  const out: Passage[] = [];
  let at = head;
  let current: Passage | null = null;
  for (const p of steps) {
    if (p.type === "same") {
      at += p.text.length;
      current = null;
      continue;
    }
    if (!current) {
      current = { start: at, end: at, removed: "" };
      out.push(current);
    }
    if (p.type === "added") {
      at += p.text.length;
      current.end = at;
    } else current.removed += p.text;
  }
  // Spaces at the edges of new words aren't worth showing as changed.
  for (const piece of out) {
    const words = after.slice(piece.start, piece.end);
    const lead = words.length - words.trimStart().length;
    const trail = words.length - words.trimEnd().length;
    if (lead + trail < words.length) {
      piece.start += lead;
      piece.end -= trail;
    }
  }
  return out;
}
