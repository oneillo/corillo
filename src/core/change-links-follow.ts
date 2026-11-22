// Following an agent's edit by the Markdown's lines, and where a place in one text is in the next (OffsetMap).
import { readable, tidy } from "./diff";
import type { Reading } from "./change-links-readings";
import { pairLines, type LineStep } from "./change-links-lines";
import { comparison, type Sync } from "./change-links-changed";

/**
 * Places in the words that an agent's edit keeps together, from the
 * Markdown's own lines. A line the edit left as it was is the same line
 * after it, wherever the words around it now repeat its words (a row put in
 * above one that starts with the same date); within what an edit changed,
 * lines are matched as pairLines does, its lines kept and its lines
 * rewritten in their place. `edits` are where the agent's exact edits went
 * in the older Markdown, when it made them that way: each is then followed
 * on its own, however close the others are. Without them (a whole new text)
 * the lines of the two texts are matched.
 */
export function syncsFor(before: Reading, after: Reading, edits?: readonly { at: number; end: number; replace: string }[]): Sync[] {
  const bl = before.markdown.split("\n");
  const al = after.markdown.split("\n");
  const steps: Edited[] = (edits?.length ? editedLines(before.markdown, after.markdown, bl, al, edits) : null) ?? pairLines(bl, al);
  const syncs: Sync[] = [];
  const add = (x: number, y: number) => {
    const last = syncs[syncs.length - 1];
    if (!last || (x >= last[0] && y >= last[1] && (x > last[0] || y > last[1]))) syncs.push([x, y]);
  };
  // Where a line's words end: where the next line's words start, less the line break between them.
  const endOf = (r: Reading, line: number) => {
    for (let k = line + 1; k < r.starts.length; k++) if (r.starts[k] >= 0) return Math.max(r.starts[line], r.starts[k] - 1);
    return r.words.length;
  };
  // Lines kept, in a run: synced where the run starts, and where its last line's words end if they read the same.
  let last: [number, number] | null = null;
  const endRun = () => {
    if (!last) return;
    const [i, j] = last;
    const eb = endOf(before, i);
    const ea = endOf(after, j);
    if (before.words.slice(before.starts[i], eb) === after.words.slice(after.starts[j], ea)) add(eb, ea);
    last = null;
  };
  let inRun = false;
  for (const s of steps) {
    if (s.edge && before.starts[s.edge[0]] >= 0 && after.starts[s.edge[1]] >= 0) {
      endRun();
      inRun = false;
      add(before.starts[s.edge[0]], after.starts[s.edge[1]]);
    }
    if (s.kind !== "same") {
      endRun();
      inRun = false;
      if (s.kind === "pair" && before.starts[s.a] >= 0 && after.starts[s.b] >= 0) add(before.starts[s.a], after.starts[s.b]);
      continue;
    }
    if (s.a >= before.starts.length || s.b >= after.starts.length || before.starts[s.a] < 0 || after.starts[s.b] < 0) continue;
    if (!inRun) add(before.starts[s.a], after.starts[s.b]);
    inRun = true;
    last = [s.a, s.b];
  }
  endRun();
  return syncs;
}

/** A step of lines matched, and where it starts an edit's lines right after another edit's: the line it starts on in each text. */
type Edited = LineStep & { edge?: readonly [number, number] };

/**
 * The lines of two Markdown texts matched by where the agent's exact edits
 * went: lines outside every edit are kept as they were, and only the lines
 * an edit touched are matched (pairLines). Null if the edits don't account
 * for the two texts.
 */
function editedLines(bm: string, am: string, bl: string[], al: string[], edits: readonly { at: number; end: number; replace: string }[]): Edited[] | null {
  const lineAt = lineFinder(bm);
  const lineAfter = lineFinder(am);
  const spans: { b0: number; b1: number; a0: number; a1: number }[] = [];
  let shift = 0;
  for (const e of [...edits].sort((x, y) => x.at - y.at)) {
    const at = e.at + shift;
    // An edit that ends where a line starts, before and after it (whole lines put in or taken out, line breaks
    // and all), leaves that line as it was: it isn't one of the edit's, so a line it puts in beside a twin stays apart from it.
    const end = at + e.replace.length;
    const whole = (e.end === 0 || bm[e.end - 1] === "\n") && (end === 0 || am[end - 1] === "\n") ? 1 : 0;
    const span = { b0: lineAt(e.at), b1: lineAt(e.end) - whole, a0: lineAfter(at), a1: lineAfter(end) - whole };
    shift += e.replace.length - (e.end - e.at);
    const prev = spans[spans.length - 1];
    if (prev && (span.b0 <= prev.b1 || span.a0 <= prev.a1)) {
      prev.b1 = Math.max(prev.b1, span.b1);
      prev.a1 = Math.max(prev.a1, span.a1);
    } else spans.push(span);
  }
  const out: Edited[] = [];
  let i = 0;
  let j = 0;
  const unchanged = (toI: number, toJ: number) => {
    if (toI - i !== toJ - j) return false;
    for (; i < toI; i++, j++) {
      if (bl[i] !== al[j]) return false;
      out.push({ kind: "same", a: i, b: j });
    }
    return true;
  };
  for (const s of spans) {
    if (!unchanged(s.b0, s.a0)) return null;
    // Right after another edit's changed lines: where this one starts is a place the two keep apart.
    const first = out.length;
    const touches = first > 0 && out[first - 1].kind !== "same";
    for (const step of pairLines(bl.slice(s.b0, s.b1 + 1), al.slice(s.a0, s.a1 + 1))) {
      if (step.kind === "added") out.push({ kind: "added", b: step.b + s.a0 });
      else if (step.kind === "removed") out.push({ kind: "removed", a: step.a + s.b0 });
      else out.push({ kind: step.kind, a: step.a + s.b0, b: step.b + s.a0 });
    }
    if (touches && out.length > first && out[first].kind !== "same") out[first].edge = [s.b0, s.a0];
    i = s.b1 + 1;
    j = s.a1 + 1;
  }
  return unchanged(bl.length, al.length) ? out : null;
}

/** Where each line of a text starts. */
export function lineStartsIn(text: string): number[] {
  const starts = [0];
  for (let i = text.indexOf("\n"); i >= 0; i = text.indexOf("\n", i + 1)) starts.push(i + 1);
  return starts;
}

/** The line (from 0) a place in the text is on. */
function lineFinder(text: string): (at: number) => number {
  const starts = lineStartsIn(text);
  return (at) => {
    let lo = 0;
    let hi = starts.length - 1;
    while (lo < hi) {
      const mid = (lo + hi + 1) >> 1;
      if (starts[mid] <= at) lo = mid;
      else hi = mid - 1;
    }
    return lo;
  };
}

interface Run {
  /** Where it starts in the older and the newer text, and how long it is in each. */
  a: number;
  b: number;
  la: number;
  lb: number;
  same: boolean;
}

/**
 * Where a place in one text is in the next, after words were changed. Like an
 * editor's position mapping: at the edge of a changed passage a place stays on
 * its side; where words were only put in, `assoc` says which side it goes.
 */
export class OffsetMap {
  private runs: Run[] = [];
  private length: number;
  private readonly texts: [string, string];
  private readonly syncs: readonly Sync[];

  /**
   * `asRead`: changed passages joined as a person reads them (see readable),
   * not word by word, but never across a line break. `syncs`: places known
   * to stay together (see syncsFor); changes are compared between them.
   */
  constructor(before: string, after: string, asRead = false, syncs: readonly Sync[] = []) {
    this.texts = [before, after];
    this.syncs = syncs;
    let a = 0;
    let b = 0;
    // (Changes either side of a sync stay two changes: a row put in by one edit and the row under it changed by another.)
    let apart = false;
    const push = (same: boolean, la: number, lb: number) => {
      if (!la && !lb) return;
      const last = this.runs[this.runs.length - 1];
      if (last && last.same === same && (same || !apart)) {
        last.la += la;
        last.lb += lb;
      } else this.runs.push({ a, b, la, lb, same });
      apart = false;
      a += la;
      b += lb;
    };
    for (const { steps } of comparison(before, after, syncs)) {
      apart = true;
      // Only joins that lose nothing, unless asked: a place in a word kept between two changes stays on that word.
      for (const p of asRead ? tidy(readable(steps, true), true) : readable(steps, false)) {
        push(p.type === "same", p.type === "added" ? 0 : p.text.length, p.type === "removed" ? 0 : p.text.length);
      }
    }
    this.length = b;
  }

  /** The same change, with changed passages joined as a person reads them. */
  asRead(): OffsetMap {
    return new OffsetMap(this.texts[0], this.texts[1], true, this.syncs);
  }

  /** The stretch start to end of the older text, widened to take in whole every change that falls in it or across its ends. */
  widen(start: number, end: number): { start: number; end: number } {
    let s = start;
    let e = end;
    for (const r of this.runs) {
      if (r.same) continue;
      if (r.la === 0 ? start < r.a && r.a < end : r.a < end && start < r.a + r.la) {
        s = Math.min(s, r.a);
        e = Math.max(e, r.a + r.la);
      }
    }
    return { start: s, end: e };
  }

  /**
   * Words only put in, inside start to end of the older text: where (in the
   * older text and the newer) and how long. Such words can often be written
   * just as well a little to one side (see carry).
   */
  insertionsIn(start: number, end: number): { a: number; b: number; length: number }[] {
    return this.runs.filter((r) => !r.same && r.la === 0 && start < r.a && r.a < end).map((r) => ({ a: r.a, b: r.b, length: r.lb }));
  }

  /** Whether start to end of the newer text was all put in by the change, not there before. */
  putIn(start: number, end: number): boolean {
    return this.runs.some((r) => !r.same && r.b <= start && end <= r.b + r.lb);
  }

  /** Whether start to end of the newer text was all put in where no words were taken out: words new to the text, not others rewritten. */
  putInNew(start: number, end: number): boolean {
    return this.runs.some((r) => !r.same && r.b <= start && end <= r.b + r.lb && !/[\p{L}\p{N}]/u.test(this.texts[0].slice(r.a, r.a + r.la)));
  }

  map(pos: number, assoc: -1 | 1 = 1): number {
    return this.mapFrom(0, pos, assoc);
  }

  /** Where line starts are in the newer text (`starts` in order): a line put in above one moves it down, words put in at its start don't. */
  mapLines(starts: ArrayLike<number>): Int32Array {
    const out = new Int32Array(starts.length);
    let i = 0;
    for (let k = 0; k < starts.length; k++) {
      const pos = starts[k];
      while (i < this.runs.length && pos > this.runs[i].a + this.runs[i].la) i++;
      const early = this.mapFrom(i, pos, -1);
      const late = this.mapFrom(i, pos, 1);
      out[k] = late > early && this.texts[1][late - 1] === "\n" ? late : early;
    }
    return out;
  }

  private mapFrom(from: number, pos: number, assoc: -1 | 1): number {
    for (let i = from; i < this.runs.length; i++) {
      const r = this.runs[i];
      if (pos > r.a + r.la) continue;
      if (r.same) {
        if (pos < r.a + r.la || i === this.runs.length - 1) return r.b + (pos - r.a);
        continue; // at its end: the next run starts here and decides
      }
      const side = r.la === 0 ? assoc : pos === r.a ? -1 : pos === r.a + r.la ? 1 : assoc;
      return side < 0 ? r.b : r.b + r.lb;
    }
    return this.length;
  }
}
