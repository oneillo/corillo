// Show changes, since the person handed the document over (roadmap Batch 3,
// item 1): every agent's pass and any change from another app since then,
// marked on the text as it is now, and the person's own edits since left
// unmarked. Plain logic, no window code.
//
// How the person's own edits are left out: a turn of theirs is put into the
// text they handed over too, when every edit in it can be placed there for
// certain (the words it changed are there, unchanged by anyone else).
// Comparing that text with the text now then shows only what others did.
// Otherwise the turn stays in the comparison, so the places the person
// changed, carried to the text now, are taken out of the marks afterwards;
// a mark of words taken out next to them isn't drawn, and in that passage
// only words new since, compared word by word, are marked as put in. Marking
// nothing beats marking the wrong words: tests/unit/since-hand-over.test.ts
// checks it on random rounds.
import type { Node } from "prosemirror-model";
import { diffText } from "./diff";
import { sharedEnds } from "./change-links";
import { PICTURE_STAND_IN, type Change } from "./doc-diff";
import { posAt, type TextIndex } from "./anchors";

/**
 * A stretch of a text, by its offsets. `removed`: a place where words were
 * only taken out, from start to end inclusive: every spot they could have
 * gone from (taking "the " out of "the the cat" could be either one).
 */
export interface Span {
  start: number;
  end: number;
  removed?: boolean;
}

/** A run of versions since the hand-over: the person's own, or everyone else's, and the text it left. */
export interface Step {
  yours: boolean;
  text: string;
}

export interface Rebased {
  /** The text handed over, with the person's own edits since put in where they can be placed for certain. */
  before: string;
  /** The text now. */
  after: string;
  /** Where the person changed the text since, as offsets in the words of the text now (`words`): left unmarked. */
  yours: Span[];
}

/**
 * Put the person's own edits since the hand-over into the text handed over,
 * so that comparing it with the text now shows only what others changed.
 * `words` gives a text's words as Corillo shows them (anchors.ts's
 * textIndex), the same ones `yours` is measured in.
 */
export function rebase(base: string, steps: readonly Step[], words: (markdown: string) => string): Rebased {
  let before = base;
  let prev = base;
  let prevWords: string | null = null;
  let yours: Span[] = [];
  for (const step of steps) {
    if (step.text === prev) continue;
    if (step.yours) before = putIn(before, prev, step.text);
    if (step.yours || yours.length) {
      const was = (prevWords ??= words(prev));
      const now = words(step.text);
      if (yours.length) yours = carried(yours, was, now);
      if (step.yours) yours.push(...placesChanged(was, now));
      prevWords = now;
    } else prevWords = null;
    prev = step.text;
  }
  return { before, after: prev, yours };
}

/** The edits that turn a into b, each a stretch of a and what goes in its place. */
function edits(a: string, b: string): { from: number; to: number; insert: string }[] {
  const { head, tail } = sharedEnds(a, b);
  const out: { from: number; to: number; insert: string }[] = [];
  let at = head;
  let current: { from: number; to: number; insert: string } | null = null;
  for (const p of diffText(a.slice(head, a.length - tail), b.slice(head, b.length - tail))) {
    if (p.type === "same") {
      at += p.text.length;
      current = null;
      continue;
    }
    if (!current) out.push((current = { from: at, to: at, insert: "" }));
    if (p.type === "removed") current.to = at += p.text.length;
    else current.insert += p.text;
  }
  return out;
}

/** What two texts share, as runs: where each starts in the older (a) and the newer (b), and how long. */
function sameRuns(older: string, newer: string): { a: number; b: number; length: number }[] {
  const { head, tail } = sharedEnds(older, newer);
  const runs: { a: number; b: number; length: number }[] = [];
  const push = (a: number, b: number, length: number) => {
    if (!length) return;
    const last = runs[runs.length - 1];
    if (last && last.a + last.length === a && last.b + last.length === b) last.length += length;
    else runs.push({ a, b, length });
  };
  push(0, 0, head);
  let a = head;
  let b = head;
  for (const p of diffText(older.slice(head, older.length - tail), newer.slice(head, newer.length - tail))) {
    const n = p.text.length;
    if (p.type === "same") push(a, b, n);
    if (p.type !== "added") a += n;
    if (p.type !== "removed") b += n;
  }
  push(older.length - tail, newer.length - tail, tail);
  return runs;
}

/**
 * The person's edits from `prev` to `next`, made to `before` too (which
 * differs from `prev` by what others changed), when each has a certain place
 * there: its words the same in both, with words the same either side of it
 * too (or the start or end of the text). If any doesn't (it touches what
 * someone else changed, or sits next to it), none is made: the comparison
 * that found the edits may have paired a line with another that only looks
 * alike, and some of them alone could leave a passage half the person's.
 * Then `before` stays as it is, and the person's places are taken out of the
 * marks instead.
 */
function putIn(before: string, prev: string, next: string): string {
  if (before === prev) return next;
  const runs = sameRuns(before, prev);
  const words = /\S/;
  let text = "";
  let last = 0;
  let r = 0;
  for (const e of edits(prev, next)) {
    while (r < runs.length && runs[r].b + runs[r].length < e.from) r++;
    const run = runs[r];
    if (!run || run.b > e.from || e.to > run.b + run.length) return before;
    const startsText = run.a === 0 && run.b === 0;
    const endsText = run.a + run.length === before.length && run.b + run.length === prev.length;
    if (!startsText && !words.test(prev.slice(run.b, e.from))) return before;
    if (!endsText && !words.test(prev.slice(e.to, run.b + run.length))) return before;
    const at = run.a + (e.from - run.b);
    text += before.slice(last, at) + e.insert;
    last = at + (e.to - e.from);
  }
  return text + before.slice(last);
}

/**
 * The places that changed from a to b, in b: one per passage changed (see
 * passages). Where words were put in, the words; where words were taken out
 * too, the same stretch marked `removed`; where they were only taken out,
 * every spot they could have gone from.
 */
function placesChanged(a: string, b: string): Span[] {
  const turns = passages(a, b);
  const out: Span[] = [];
  turns.forEach((t, i) => {
    if (t.same) return;
    if (t.lb) out.push({ start: t.b, end: t.b + t.lb });
    if (!t.la) return;
    if (t.lb) {
      if (!a.slice(t.a, t.a + t.la).includes("\n")) out.push({ start: t.b, end: t.b + t.lb, removed: true });
      else {
        // A line break went too (a paragraph went), so what went may have been at either end of the line it's in now.
        const lineEnd = b.indexOf("\n", t.b + t.lb);
        out.push({ start: t.b && b.lastIndexOf("\n", t.b - 1) + 1, end: lineEnd < 0 ? b.length : lineEnd, removed: true });
      }
      return;
    }
    // Only taken out: the same letters either side could have gone instead, so the place covers them.
    const after = i > 0 ? turns[i - 1].a : 0; // the passages either side bound it
    const before = i + 1 < turns.length ? turns[i + 1].a + turns[i + 1].la : a.length;
    let s = t.a;
    let e = t.a + t.la;
    while (s > after && a[s - 1] === a[e - 1]) s--, e--;
    const left = t.a - s;
    s = t.a;
    e = t.a + t.la;
    while (e < before && a[s] === a[e]) s++, e++;
    out.push({ start: t.b - left, end: t.b + (s - t.a), removed: true });
  });
  return out;
}

/**
 * How text b differs from a, in turns: stretches both share, and passages
 * changed (changes with only spaces between them make one passage). Each
 * gives where it starts in a and in b, and how long it is in each.
 */
function passages(a: string, b: string): { a: number; b: number; la: number; lb: number; same: boolean }[] {
  const out: { a: number; b: number; la: number; lb: number; same: boolean }[] = [];
  const push = (same: boolean, la: number, lb: number) => {
    const last = out[out.length - 1];
    if (last && last.same === same) {
      last.la += la;
      last.lb += lb;
    } else out.push({ a: last ? last.a + last.la : 0, b: last ? last.b + last.lb : 0, la, lb, same });
  };
  const { head, tail } = sharedEnds(a, b);
  if (head) push(true, head, head);
  const parts = diffText(a.slice(head, a.length - tail), b.slice(head, b.length - tail));
  parts.forEach((p, i) => {
    const n = p.text.length;
    if (p.type !== "same") push(false, p.type === "removed" ? n : 0, p.type === "added" ? n : 0);
    else push(!(i > 0 && i < parts.length - 1 && !/\S/.test(p.text)), n, n);
  });
  if (tail) push(true, tail, tail);
  return out;
}

/**
 * Places in one text, where they are after it changed to the next: words put
 * in at the edges of words stay outside, and inside a place where words were
 * taken out (where a mark is in doubt). A place in a passage someone else
 * changed may have gone anywhere in it (the comparison can pair the person's
 * words with others'), so it then covers the whole passage as it is now.
 */
function carried(spans: Span[], was: string, now: string): Span[] {
  if (was === now) return spans;
  const turns = passages(was, now);
  const map = (pos: number, assoc: -1 | 1): number => {
    for (let i = 0; i < turns.length; i++) {
      const t = turns[i];
      if (pos > t.a + t.la || (pos === t.a + t.la && i < turns.length - 1 && t.same)) continue;
      if (t.same) return t.b + (pos - t.a);
      return assoc < 0 ? t.b : t.b + t.lb;
    }
    return now.length;
  };
  return spans.map(({ start, end, removed }) => {
    let s = map(start, removed ? -1 : 1);
    let e = map(end, removed ? 1 : -1);
    for (const t of turns) {
      if (t.same) continue;
      const touches = removed ? t.a <= end && start <= t.a + t.la : t.a < end && start < t.a + t.la;
      if (!touches) continue;
      s = Math.min(s, t.b);
      e = Math.max(e, t.b + t.lb);
      if (removed && was.slice(t.a, t.a + t.la).includes("\n")) {
        const lineEnd = now.indexOf("\n", t.b + t.lb);
        s = Math.min(s, t.b && now.lastIndexOf("\n", t.b - 1) + 1);
        e = Math.max(e, lineEnd < 0 ? now.length : lineEnd);
      }
    }
    return removed ? { start: s, end: Math.max(s, e), removed } : { start: s, end: Math.max(s, e) };
  });
}

/** One of the person's places, as document positions; `removed` as for Span. */
export interface YourPlace {
  from: number;
  to: number;
  removed?: boolean;
}

/**
 * The person's places, as document positions in the document `index` was
 * read from (`size` is its content's size). A place where words were taken
 * out takes in the spaces either side, and if it then starts or ends at the
 * edge of a block, reaches across to the next block's words: a mark of what
 * went could sit anywhere between.
 */
export function positionsOf(index: TextIndex, spans: readonly Span[], size: number): YourPlace[] {
  const text = index.text;
  return spans.map(({ start, end, removed }) => {
    if (!removed) return { from: posAt(index, start, "start"), to: posAt(index, end, "end") };
    // The space either side too: comparing whole documents can put what went before a space or after it.
    while (start > 0 && text[start - 1] === " ") start--;
    while (end < text.length && text[end] === " ") end++;
    let from = posAt(index, start, "end");
    if (start <= 0) from = 0;
    else if (text[start - 1] === "\n") from = Math.min(from, posAt(index, start - 1, "end"));
    let to = posAt(index, end, "start");
    if (end >= text.length) to = size;
    else if (text[end] === "\n") to = Math.max(to, posAt(index, end + 1, "start"));
    return { from: Math.min(from, to), to: Math.max(from, to), removed };
  });
}

export interface Marks {
  /** What to mark, in the order compared. */
  changes: Change[];
  /** For each, which change it's part of, counting from 0 in the order of the document. */
  groups: number[];
  /** How many changes, as a person counts them. */
  count: number;
}

/** Where a change is in the document, from start to end (the same place for words taken out). */
export function extentOf(c: Change): { start: number; end: number } {
  return c.kind === "removed-text" || c.kind === "removed-block" ? { start: c.at, end: c.at } : { start: c.from, end: c.to };
}

/** Whether a change has something to see: words or a picture, not only a line break or a space. */
function visible(c: Change): boolean {
  if (c.kind !== "removed-text") return true;
  if (/\S/.test(c.text.split(PICTURE_STAND_IN).join(""))) return true;
  let found = false;
  c.content.forEach((node) => {
    if (node.type.name === "image" || node.type.name === "footnote_ref") found = true;
  });
  return found;
}

/**
 * Where the words of the text now (read into `index`) that weren't in the
 * text `before` (its words, as textIndex reads them) are, as document
 * positions, in order. Compared word by word; and a word put in where the
 * same word was taken out (a passage rewritten around it) was there before
 * too, so a word that was there and still is is never among them.
 */
export function freshWords(index: TextIndex, before: string): { from: number; to: number }[] {
  const out: { from: number; to: number }[] = [];
  const { head, tail } = sharedEnds(before, index.text);
  const parts = diffText(before.slice(head, before.length - tail), index.text.slice(head, index.text.length - tail));
  let at = head;
  let lastEnd = -1; // where the last fresh word ends, in the text now
  for (let i = 0; i < parts.length; ) {
    if (parts[i].type === "same") {
      if (/\S/.test(parts[i].text)) lastEnd = -1;
      at += parts[i++].text.length;
      continue;
    }
    // One passage changed: up to the next words both share.
    let j = i;
    while (j < parts.length && (parts[j].type !== "same" || !/\S/.test(parts[j].text))) j++;
    const gone = new Map<string, number>();
    for (let k = i; k < j; k++) {
      if (parts[k].type !== "removed") continue;
      for (const w of parts[k].text.match(/\S+/g) ?? []) gone.set(w, (gone.get(w) ?? 0) + 1);
    }
    for (; i < j; i++) {
      const p = parts[i];
      if (p.type === "removed") continue;
      if (p.type === "added") {
        for (const m of p.text.matchAll(/\S+/g)) {
          const left = gone.get(m[0]) ?? 0;
          if (left) {
            gone.set(m[0], left - 1);
            continue;
          }
          const start = at + m.index;
          const to = posAt(index, start + m[0].length, "end");
          // Joined to the word before when only spaces are between.
          if (out.length && lastEnd >= 0 && !/\S/.test(index.text.slice(lastEnd, start))) out[out.length - 1].to = to;
          else out.push({ from: posAt(index, start, "start"), to });
          lastEnd = start + m[0].length;
        }
      }
      at += p.text.length;
    }
  }
  return out;
}

/**
 * What Show changes marks: the changes found between the rebased text and
 * the text now (`doc`), less the places the person changed (`yours`, in
 * document positions), each given the change it's part of. Where what was
 * taken out isn't marked, being in doubt, only words new since are marked
 * as put in (`freshWords`, asked for only then): a rewritten passage shown
 * whole could otherwise mark words that were there as new, with nothing
 * struck through to say so. A person counts as one change marks with
 * nothing but spaces and empty lines between them, as in "A long new
 * section and a one-word fix elsewhere are two changes".
 */
export function marksSince(doc: Node, changes: readonly Change[], yours: readonly YourPlace[], freshWords: () => readonly { from: number; to: number }[]): Marks {
  const shows = (from: number, to: number) => from < to && /\S/.test(doc.textBetween(from, to, " ", PICTURE_STAND_IN));
  /** The words the person put in, left unmarked, in order, those that overlap joined; a place where they only took words out has none. */
  const stretches: { from: number; to: number }[] = [];
  for (const r of yours.filter((y) => !y.removed && y.to > y.from).sort((x, y) => x.from - y.from)) {
    const last = stretches[stretches.length - 1];
    if (last && r.from <= last.to) last.to = Math.max(last.to, r.to);
    else stretches.push({ from: r.from, to: r.to });
  }
  /** The first of `ranges` (in order) that ends after `at`. */
  const firstAfter = (ranges: readonly { from: number; to: number }[], at: number) => {
    let lo = 0;
    let hi = ranges.length;
    while (lo < hi) {
      const mid = (lo + hi) >> 1;
      if (ranges[mid].to <= at) lo = mid + 1;
      else hi = mid;
    }
    return lo;
  };
  let fresh: readonly { from: number; to: number }[] | null = null;
  /** from to to (`strict`: only where words are new), less the person's stretches, in pieces that show something. */
  const pieces = (from: number, to: number, strict: boolean): [number, number][] => {
    const out: [number, number][] = [];
    const within = strict ? (fresh ??= freshWords()) : [{ from, to }];
    for (let i = firstAfter(within, from); i < within.length && within[i].from < to; i++) {
      const range = within[i];
      let at = Math.max(from, range.from);
      const end = Math.min(to, range.to);
      for (let j = firstAfter(stretches, at); j < stretches.length && stretches[j].from < end; j++) {
        if (stretches[j].from > at) out.push([at, stretches[j].from]);
        at = Math.max(at, stretches[j].to);
      }
      if (at < end) out.push([at, end]);
    }
    return out.filter(([a, b]) => shows(a, b));
  };
  /**
   * The passage rewritten where words were taken out (change i): it and the
   * changes either side that touch it, one after another, or have nothing to
   * see between (only the edge of a list, say).
   */
  const replaced = (i: number) => {
    let { start: from, end: to } = extentOf(changes[i]);
    for (const step of [-1, 1]) {
      for (let j = i + step; j >= 0 && j < changes.length; j += step) {
        const e = extentOf(changes[j]);
        if (e.start > to ? shows(to, e.start) : e.end < from && shows(e.end, from)) break;
        from = Math.min(from, e.start);
        to = Math.max(to, e.end);
      }
    }
    return { from, to };
  };
  // Words taken out where the person changed the text, or in a passage rewritten where they did: whose doing it
  // was is in doubt, so they aren't marked, and in that passage only words that are new since are marked as put in.
  const doubt: { from: number; to: number }[] = [];
  const doubtful = new Set<number>();
  changes.forEach((c, i) => {
    if (c.kind !== "removed-text" && c.kind !== "removed-block") return;
    const { from, to } = replaced(i);
    if (!yours.some((r) => r.from <= to && from <= r.to)) return;
    doubtful.add(i);
    doubt.push({ from, to });
  });
  const inDoubt = (from: number, to: number) => doubt.some((d) => d.from <= to && from <= d.to);
  const kept: { change: Change; origin: number }[] = [];
  changes.forEach((c, origin) => {
    if (!visible(c)) return;
    switch (c.kind) {
      case "added-text":
        for (const [from, to] of pieces(c.from, c.to, inDoubt(c.from, c.to))) kept.push({ change: { kind: "added-text", from, to }, origin });
        break;
      case "removed-text":
      case "removed-block":
        if (!doubtful.has(origin)) kept.push({ change: c, origin });
        break;
      case "changed-block":
        if (!yours.some((r) => r.from < c.to && c.from < r.to)) kept.push({ change: c, origin });
        break;
      case "added-block": {
        // Marked whole unless some of its words are the person's, or, in doubt, were there before; then only the rest.
        const strict = inDoubt(c.from, c.to);
        const inside: [number, number][] = [];
        let whole = true;
        doc.nodesBetween(c.from, c.to, (node, pos) => {
          if (!node.isTextblock) return true;
          const from = pos + 1;
          const to = from + node.content.size;
          const found = pieces(from, to, strict);
          inside.push(...found);
          if (shows(from, to) && !(found.length === 1 && !shows(from, found[0][0]) && !shows(found[0][1], to))) whole = false;
          return false;
        });
        if (whole) kept.push({ change: c, origin });
        else for (const [from, to] of inside) kept.push({ change: { kind: "added-text", from, to }, origin });
        break;
      }
    }
  });
  // Changes as a person counts them, in the order of the document.
  const extents = new Map<number, { start: number; end: number }>();
  for (const { origin } of kept) if (!extents.has(origin)) extents.set(origin, extentOf(changes[origin]));
  const groupOf = new Map<number, number>();
  let group = -1;
  let end = -1;
  for (const [origin, e] of [...extents].sort((x, y) => x[1].start - y[1].start || x[0] - y[0])) {
    if (group < 0 || (e.start > end && shows(end, e.start))) group++;
    groupOf.set(origin, group);
    end = Math.max(end, e.end);
  }
  return { changes: kept.map((k) => k.change), groups: kept.map((k) => groupOf.get(k.origin)!), count: group + 1 };
}
