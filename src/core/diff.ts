// Comparing texts: what stayed, what was taken out, what was put in. Used to
// show what a version changed (blocks first, then word by word inside a
// block), to describe changes to agents, and to keep old versions compactly as
// the edits that turn the next version back into them.

export type Op<T> = { type: "same"; a: T; b: T } | { type: "removed"; a: T } | { type: "added"; b: T };

/** Past this many differences in one comparison, stop looking for the smallest set. */
const MAX_DIFFERENCES = 2000;
/** How far ahead a block that went looks for one that came to pair with: a pair is only ever shown nearby. */
const PAIR_LOOK_AHEAD = 50;

/**
 * The shortest list of steps that turns sequence a into sequence b (Myers'
 * method: follow matching runs, and count the fewest insertions and deletions).
 * Past MAX_DIFFERENCES differences the rest is called replaced: compare long texts
 * with diffText, which compares lines first so this never happens to a whole
 * document.
 */
export function diffSequence<T>(a: readonly T[], b: readonly T[], eq: (x: T, y: T) => boolean = Object.is): Op<T>[] {
  return steps(a, b, eq, MAX_DIFFERENCES, true)!;
}

/** The same steps, or null when they take more than `maxEdits` insertions and deletions. */
export function diffWithin<T>(a: readonly T[], b: readonly T[], eq: (x: T, y: T) => boolean, maxEdits: number): Op<T>[] | null {
  return steps(a, b, eq, maxEdits, false);
}

function steps<T>(a: readonly T[], b: readonly T[], eq: (x: T, y: T) => boolean, maxEdits: number, orReplace: boolean): Op<T>[] | null {
  let start = 0;
  while (start < a.length && start < b.length && eq(a[start], b[start])) start++;
  let endA = a.length;
  let endB = b.length;
  while (endA > start && endB > start && eq(a[endA - 1], b[endB - 1])) {
    endA--;
    endB--;
  }
  const inner = middle(a.slice(start, endA), b.slice(start, endB), eq, maxEdits, orReplace);
  if (!inner) return null;
  const ops: Op<T>[] = [];
  for (let i = 0; i < start; i++) ops.push({ type: "same", a: a[i], b: b[i] });
  for (const op of inner) ops.push(op);
  for (let i = endA, j = endB; i < a.length; i++, j++) ops.push({ type: "same", a: a[i], b: b[j] });
  return ops;
}

function middle<T>(a: T[], b: T[], eq: (x: T, y: T) => boolean, maxEdits: number, orReplace: boolean): Op<T>[] | null {
  const n = a.length;
  const m = b.length;
  const replaced = (): Op<T>[] => [
    ...a.map((x): Op<T> => ({ type: "removed", a: x })),
    ...b.map((y): Op<T> => ({ type: "added", b: y })),
  ];
  // Only taken out, or only put in: as many steps as items, and past the limit that's too many.
  if (n === 0 || m === 0) return !orReplace && n + m > maxEdits ? null : replaced();
  const max = Math.min(n + m, maxEdits);
  const off = max + 1;
  // v[off + k]: how far along a the furthest path on diagonal k (x - y = k) has got.
  const v = new Int32Array(2 * max + 3);
  // trace[d] holds v for diagonals -d..d as it was before step d.
  const trace: Int32Array[] = [];
  for (let d = 0; d <= max; d++) {
    trace.push(v.slice(off - d, off + d + 1));
    for (let k = -d; k <= d; k += 2) {
      let x = k === -d || (k !== d && v[off + k - 1] < v[off + k + 1]) ? v[off + k + 1] : v[off + k - 1] + 1;
      let y = x - k;
      while (x < n && y < m && eq(a[x], b[y])) {
        x++;
        y++;
      }
      v[off + k] = x;
      if (x >= n && y >= m) return backtrack(trace, a, b, d);
    }
  }
  return orReplace ? replaced() : null;
}

function backtrack<T>(trace: Int32Array[], a: T[], b: T[], steps: number): Op<T>[] {
  const ops: Op<T>[] = [];
  let x = a.length;
  let y = b.length;
  for (let d = steps; d > 0; d--) {
    const at = (k: number) => trace[d][k + d];
    const k = x - y;
    const down = k === -d || (k !== d && at(k - 1) < at(k + 1));
    const prevK = down ? k + 1 : k - 1;
    const prevX = at(prevK);
    const prevY = prevX - prevK;
    const startX = down ? prevX : prevX + 1;
    while (x > startX) {
      ops.push({ type: "same", a: a[x - 1], b: b[y - 1] });
      x--;
      y--;
    }
    ops.push(down ? { type: "added", b: b[prevY] } : { type: "removed", a: a[prevX] });
    x = prevX;
    y = prevY;
  }
  while (x > 0) {
    ops.push({ type: "same", a: a[x - 1], b: b[y - 1] });
    x--;
    y--;
  }
  return ops.reverse();
}

// Words ----------------------------------------------------------------------

// A word (letters and digits, with inner apostrophes), a run of spaces, or any
// other single character. Joined back together, the pieces are the text. A
// number keeps its inner commas, points and colons ("1,840", "3.5", "10:30"),
// so a changed number is one change, not "1," left between two (review of
// Batch 11, F-15); a point or comma with no digit after it ends the word.
const TOKEN = /[\p{L}\p{N}]+(?:['’][\p{L}\p{N}]+|(?<=\p{N})[.,:]\p{N}+)*|\s+|[^\p{L}\p{N}\s]/gu;
const WORDLIKE = /[\p{L}\p{N}]/u;

export function tokenize(text: string): string[] {
  return text.match(TOKEN) ?? [];
}

export interface Piece {
  type: "same" | "removed" | "added";
  text: string;
}

/** Word-by-word changes from a to b, ready to show. */
export function diffWords(a: string, b: string): Piece[] {
  return forReading(diffText(a, b), true);
}

/** Pieces from diffText, tidied for reading (see readable; `loose` joins across a short word too). */
export function forReading(pieces: Piece[], loose: boolean): Piece[] {
  return tidy(readable(pieces, loose));
}

function lines(text: string): string[] {
  return text.match(/[^\n]*\n|[^\n]+$/g) ?? [];
}

/**
 * The changes from a to b, word by word, worked out in levels so that a long
 * text never costs more than its changes: lines (blocks, in a document's
 * text) are matched first, then the words inside each run of lines that
 * changed. A run too changed to compare word by word as a whole (a rewrite
 * of many paragraphs) has its lines paired with the ones they most look like,
 * and each pair compared on its own. Joined back together, the pieces that
 * aren't added are a, and those that aren't removed are b. Not tidied for
 * reading (see readable).
 */
export function diffText(a: string, b: string): Piece[] {
  const out: Piece[] = [];
  const push = (type: Piece["type"], text: string) => {
    if (!text) return;
    const last = out[out.length - 1];
    if (last && last.type === type) last.text += text;
    else out.push({ type, text });
  };
  const words = (x: string, y: string, orReplace: boolean): boolean => {
    const ops = orReplace ? diffSequence(tokenize(x), tokenize(y)) : diffWithin(tokenize(x), tokenize(y), Object.is, MAX_DIFFERENCES);
    if (!ops) return false;
    for (const op of ops) push(op.type, op.type === "added" ? op.b : op.a);
    return true;
  };
  if (lines(a).length <= 1 && lines(b).length <= 1) {
    words(a, b, true);
    return out;
  }
  // Each line with the line break after it, the last one's too, so a last
  // line reads as the same line whether lines come after it or not (taken
  // off again at the end).
  const ops = diffSequence(lines(a + "\n"), lines(b + "\n"));
  const similar = similarityCache();
  for (let i = 0; i < ops.length; ) {
    const op = ops[i];
    if (op.type === "same") {
      push("same", op.a);
      i++;
      continue;
    }
    const removed: string[] = [];
    const added: string[] = [];
    for (; i < ops.length; i++) {
      const o = ops[i];
      if (o.type === "same") break;
      if (o.type === "removed") removed.push(o.a);
      else added.push(o.b);
    }
    if (words(removed.join(""), added.join(""), false)) continue;
    for (const p of pairUp(removed, added, (x, y) => similar(x, y) >= 0.4)) {
      if (p.old !== undefined && p.new !== undefined) words(p.old, p.new, true);
      else if (p.old !== undefined) push("removed", p.old);
      else if (p.new !== undefined) push("added", p.new);
    }
  }
  return withoutLastBreak(out);
}

/** Pieces of a + "\n" against b + "\n", made pieces of a against b. */
function withoutLastBreak(pieces: Piece[]): Piece[] {
  let s = pieces.length - 1;
  while (s >= 0 && pieces[s].type !== "same") s--;
  const tail = pieces.slice(s + 1);
  const cut = (p: Piece) => (p.text = p.text.slice(0, -1));
  const lastOf = (type: Piece["type"]) => tail.filter((p) => p.type === type).pop();
  const removed = lastOf("removed");
  const added = lastOf("added");
  if (!tail.length) cut(pieces[s]);
  else if (removed && added) {
    cut(removed);
    cut(added);
  } else if (s >= 0) {
    // Only put in (or only taken out) after the last text both share, which ends in the break
    // both had: that break goes before what's put in, and the one after it goes.
    cut(pieces[s]);
    tail[0].text = "\n" + tail[0].text;
    cut(tail[tail.length - 1]);
  }
  const out: Piece[] = [];
  for (const p of pieces) {
    if (!p.text) continue;
    const last = out[out.length - 1];
    if (last && last.type === p.type) last.text += p.text;
    else out.push(p);
  }
  return out;
}

interface Replacement {
  removed: string;
  added: string;
}

/**
 * Changes tidied for a person to read. Two changes with a little unchanged
 * text between them become one when that reads as one change: when the text
 * between can slide to the edge (an inserted clause that repeats a word next
 * to it, "four inboxes (help, info, volunteers and events) and two", where a
 * word-by-word comparison matches the old "and" to the first new one and
 * leaves it plain between two patches), or, with `loose`, when it's a word or
 * two between two much longer changes (a rewritten sentence that kept its
 * "and"). Within each change, what was taken out comes before what was put in.
 */
export function readable(pieces: Piece[], loose: boolean): Piece[] {
  // Alternating unchanged text and changes.
  const items: (string | Replacement)[] = [];
  for (const p of pieces) {
    const last = items[items.length - 1];
    if (p.type === "same") {
      if (typeof last === "string") items[items.length - 1] = last + p.text;
      else items.push(p.text);
      continue;
    }
    const change = last !== undefined && typeof last !== "string" ? last : { removed: "", added: "" };
    if (change !== last) items.push(change);
    if (p.type === "removed") change.removed += p.text;
    else change.added += p.text;
  }
  const out: (string | Replacement)[] = [];
  for (let k = 0; k < items.length; k++) {
    let item = items[k];
    if (typeof item === "string") {
      out.push(item);
      continue;
    }
    // Join with the change before while the text between reads better as part of them.
    while (out.length >= 2 && typeof out[out.length - 1] === "string" && typeof out[out.length - 2] !== "string") {
      const between = out[out.length - 1] as string;
      const before = out[out.length - 2] as Replacement;
      const joined = factor({ removed: before.removed + between + item.removed, added: before.added + between + item.added });
      const apart = before.removed.length + before.added.length + item.removed.length + item.added.length;
      const slides = joined.change.removed.length + joined.change.added.length <= apart;
      if (!slides && !(loose && shortBetween(between, before, item))) break;
      out.length -= 2;
      if (joined.head) {
        if (typeof out[out.length - 1] === "string") out[out.length - 1] += joined.head;
        else out.push(joined.head);
      }
      item = joined.change;
      if (joined.tail) {
        // The shared end goes back into the unchanged text after.
        const next = items[k + 1];
        if (typeof next === "string") items[k + 1] = joined.tail + next;
        else items.splice(k + 1, 0, joined.tail);
      }
    }
    if (item.removed || item.added) out.push(item);
    else if (typeof out[out.length - 1] === "string" && typeof items[k + 1] === "string") {
      out[out.length - 1] += items[k + 1] as string;
      k++;
    }
  }
  const result: Piece[] = [];
  for (const item of out) {
    if (typeof item === "string") {
      if (item) result.push({ type: "same", text: item });
      continue;
    }
    if (item.removed) result.push({ type: "removed", text: item.removed });
    if (item.added) result.push({ type: "added", text: item.added });
  }
  return result;
}

/** One or two words, on one line, between two changes each at least twice as long. */
function shortBetween(between: string, before: Replacement, after: Replacement): boolean {
  if (between.includes("\n")) return false;
  if (tokenize(between).filter((t) => WORDLIKE.test(t)).length > 2) return false;
  const size = (c: Replacement) => Math.max(c.removed.length, c.added.length);
  return between.length * 2 <= size(before) && between.length * 2 <= size(after);
}

/**
 * A change with the words its old and new text start and end with in common
 * taken out, as unchanged text either side. Only what they share is read, so
 * joining change after change costs what's joined, not the change so far.
 */
function factor(change: Replacement): { head: string; change: Replacement; tail: string } {
  const { removed, added } = change;
  const head = headLength(removed, added);
  const tail = tailLength(removed, added, head);
  if (!head && !tail) return { head: "", change, tail: "" };
  return {
    head: removed.slice(0, head),
    change: { removed: removed.slice(head, removed.length - tail), added: added.slice(head, added.length - tail) },
    tail: removed.slice(removed.length - tail),
  };
}

const STEP = new RegExp(TOKEN.source, "uy");
const SPACE = /\s/u;

/** How long the words a and b start with in common are, read a word at a time and only as far as they agree. */
function headLength(a: string, b: string): number {
  let at = 0;
  for (;;) {
    STEP.lastIndex = at;
    const word = STEP.exec(a)?.[0];
    STEP.lastIndex = at;
    if (!word || STEP.exec(b)?.[0] !== word) return at;
    at += word.length;
  }
}

/** A place at or before i where a word (or space) of s starts: a space is never part of a word, nor a word of a space. */
function wordStart(s: string, i: number): number {
  while (i > 0 && i < s.length && SPACE.test(s[i - 1]) === SPACE.test(s[i])) i--;
  return i;
}

/** How long the words a and b end with in common are, not reaching into their first `head` characters (words they share). */
function tailLength(a: string, b: string, head: number): number {
  const most = Math.min(a.length, b.length) - head;
  let same = 0;
  while (same < most && a[a.length - 1 - same] === b[b.length - 1 - same]) same++;
  if (!same) return 0;
  const wa = tokenize(a.slice(Math.max(head, wordStart(a, a.length - same))));
  const wb = tokenize(b.slice(Math.max(head, wordStart(b, b.length - same))));
  let length = 0;
  for (let n = 1; n <= wa.length && n <= wb.length && wa[wa.length - n] === wb[wb.length - n]; n++) length += wa[wa.length - n].length;
  return length;
}

// "[-the quick-]{+a slow+}" reads better than "[-the-]{+a+} [-quick-]{+slow+}":
// a space left between two changes joins them, and within each change what
// was taken out comes before what was put in. `apartAtLines`: a line break
// left between two changes keeps them apart, so changes on lines next to
// each other stay two (each line is a paragraph, a list item or a table cell).
export function tidy(pieces: Piece[], apartAtLines = false): Piece[] {
  const space = apartAtLines ? /^[^\S\n]+$/ : /^\s+$/;
  const out: Piece[] = [];
  let removed = "";
  let added = "";
  const flush = () => {
    if (removed) out.push({ type: "removed", text: removed });
    if (added) out.push({ type: "added", text: added });
    removed = added = "";
  };
  for (let i = 0; i < pieces.length; i++) {
    const p = pieces[i];
    if (p.type !== "same") {
      if (p.type === "removed") removed += p.text;
      else added += p.text;
      continue;
    }
    const next = pieces[i + 1];
    const joins =
      next !== undefined &&
      space.test(p.text) &&
      ((removed && added) || (removed && next.type === "added") || (added && next.type === "removed"));
    if (joins) {
      removed += p.text;
      added += p.text;
      continue;
    }
    flush();
    out.push(p);
  }
  flush();
  return out;
}

function words(text: string): string[] {
  return tokenize(text)
    .filter((t) => WORDLIKE.test(t))
    .map((t) => t.toLowerCase());
}

/** A passage's words, each with how many times it's there. */
interface Bag {
  counts: Map<string, number>;
  size: number;
}

function bagOf(text: string): Bag {
  const counts = new Map<string, number>();
  let size = 0;
  for (const w of words(text)) {
    counts.set(w, (counts.get(w) ?? 0) + 1);
    size++;
  }
  return { counts, size };
}

function bagSimilarity(a: Bag, b: Bag): number {
  if (!a.size && !b.size) return 1;
  const [small, large] = a.counts.size <= b.counts.size ? [a, b] : [b, a];
  let common = 0;
  for (const [w, n] of small.counts) {
    const m = large.counts.get(w);
    if (m) common += Math.min(n, m);
  }
  return (2 * common) / (a.size + b.size);
}

/** How alike two passages are, from 0 (no words in common) to 1 (the same words). */
export function similarity(a: string, b: string): number {
  return bagSimilarity(bagOf(a), bagOf(b));
}

/**
 * similarity, for comparing the same passages many times over in one
 * comparison: each passage's words are counted once.
 */
export function similarityCache(): (a: string, b: string) => number {
  const bags = new Map<string, Bag>();
  const bag = (text: string) => {
    let found = bags.get(text);
    if (!found) bags.set(text, (found = bagOf(text)));
    return found;
  };
  return (a, b) => bagSimilarity(bag(a), bag(b));
}

/**
 * Between two unchanged neighbours, some blocks went and some came. Pair each
 * one that went with a later one that came if they're alike enough to show as
 * one block changed; the rest are plain removals and additions. In order. A
 * block that went looks at most `lookAhead` blocks ahead, so two long versions
 * with nothing alike take a moment, not every block against every other.
 */
export function pairUp<T>(
  removed: T[],
  added: T[],
  pairable: (a: T, b: T) => boolean,
  lookAhead = PAIR_LOOK_AHEAD,
): { old?: T; new?: T }[] {
  const out: { old?: T; new?: T }[] = [];
  let j = 0;
  for (const r of removed) {
    let match = -1;
    for (let k = j; k < added.length && k < j + lookAhead; k++) {
      if (pairable(r, added[k])) {
        match = k;
        break;
      }
    }
    if (match < 0) {
      out.push({ old: r });
      continue;
    }
    for (; j < match; j++) out.push({ new: added[j] });
    out.push({ old: r, new: added[match] });
    j = match + 1;
  }
  for (; j < added.length; j++) out.push({ new: added[j] });
  return out;
}

/** What each pair adds to a pairing besides its likeness: blocks that can pair but have nothing in common still pair, in order. */
const PAIR_WEIGHT = 0.01;

/**
 * pairUp, but each block that went is paired with the one most like it: of
 * the pairings in order, the one whose pairs are most alike in all
 * (`likeness` from 0 to 1, or null for two that can't pair). So a block taken
 * out right above a changed one isn't shown changed into it. A pair is held
 * only `lookAhead` blocks off the run's start or its end, as in pairUp; a run
 * too long to hold every block against every other is paired as pairUp does.
 * The result is in pairUp's order.
 */
export function pairAlike<T>(
  removed: T[],
  added: T[],
  likeness: (a: T, b: T) => number | null,
  lookAhead = PAIR_LOOK_AHEAD,
): { old?: T; new?: T }[] {
  const n = removed.length;
  const m = added.length;
  if (n * m > lookAhead * lookAhead) return pairUp(removed, added, (a, b) => likeness(a, b) !== null, lookAhead);
  const near = (i: number, k: number) => Math.abs(k - i) < lookAhead || Math.abs(m - k - (n - i)) < lookAhead;
  // best[i][k]: the most a pairing of removed[i..] with added[k..] can have in all.
  const weight: (number | null)[][] = [];
  const best: Float64Array[] = Array.from({ length: n + 1 }, () => new Float64Array(m + 1));
  for (let i = n - 1; i >= 0; i--) {
    weight[i] = [];
    for (let k = m - 1; k >= 0; k--) {
      const like = near(i, k) ? likeness(removed[i], added[k]) : null;
      weight[i][k] = like === null ? null : like + PAIR_WEIGHT;
      best[i][k] = Math.max(best[i + 1][k], best[i][k + 1], like === null ? 0 : like + PAIR_WEIGHT + best[i + 1][k + 1]);
    }
  }
  // Follow the best, pairing as early as it allows (as pairUp would, given the choice).
  const pairs: [number, number][] = [];
  for (let i = 0, k = 0; i < n && k < m; ) {
    const w = weight[i][k];
    if (w !== null && w + best[i + 1][k + 1] === best[i][k]) pairs.push([i++, k++]);
    else if (best[i][k + 1] === best[i][k]) k++;
    else i++;
  }
  const out: { old?: T; new?: T }[] = [];
  let i = 0;
  let k = 0;
  for (const [pi, pk] of pairs) {
    for (; i < pi; i++) out.push({ old: removed[i] });
    for (; k < pk; k++) out.push({ new: added[k] });
    out.push({ old: removed[i++], new: added[k++] });
  }
  for (; i < n; i++) out.push({ old: removed[i] });
  for (; k < m; k++) out.push({ new: added[k] });
  return out;
}

// Deltas -------------------------------------------------------------------------
// An old version is kept as the edits that turn the next version back into it:
// [skip, delete, insert, skip, delete, insert, ...], where skip counts the
// characters kept since the last edit. Changing one sentence costs about that
// sentence, not the whole document.

export type Delta = (number | string)[];

/** The edits that turn `from` into `to`: lines first, then words inside the lines that changed (see diffText). */
export function makeDelta(from: string, to: string): Delta {
  const edits: { at: number; del: number; ins: string }[] = [];
  const edit = (at: number, del: number, ins: string) => {
    const last = edits[edits.length - 1];
    if (last && last.at + last.del === at) {
      last.del += del;
      last.ins += ins;
    } else edits.push({ at, del, ins });
  };
  let at = 0;
  for (const p of diffText(from, to)) {
    if (p.type === "same") at += p.text.length;
    else if (p.type === "removed") {
      edit(at, p.text.length, "");
      at += p.text.length;
    } else edit(at, 0, p.text);
  }
  // Edits only a few characters apart are cheaper as one: a rewritten sentence
  // is one edit, not one per word with the spaces between kept.
  const merged: typeof edits = [];
  for (const e of edits) {
    const last = merged[merged.length - 1];
    const gap = last ? e.at - (last.at + last.del) : Infinity;
    if (last && gap <= 8) {
      last.ins += from.slice(last.at + last.del, e.at) + e.ins;
      last.del += gap + e.del;
    } else merged.push({ ...e });
  }
  const delta: Delta = [];
  let cursor = 0;
  for (const e of merged) {
    delta.push(e.at - cursor, e.del, e.ins);
    cursor = e.at + e.del;
  }
  return delta;
}

/** Apply edits made by makeDelta. Throws if they don't fit the text (a damaged delta). */
export function applyDelta(from: string, delta: Delta): string {
  if (!Array.isArray(delta) || delta.length % 3 !== 0) throw new Error("That change record is damaged.");
  let out = "";
  let cursor = 0;
  for (let i = 0; i < delta.length; i += 3) {
    const [skip, del, ins] = delta.slice(i, i + 3);
    if (
      !Number.isInteger(skip) ||
      !Number.isInteger(del) ||
      typeof ins !== "string" ||
      (skip as number) < 0 ||
      (del as number) < 0 ||
      cursor + (skip as number) + (del as number) > from.length
    ) {
      throw new Error("That change record is damaged.");
    }
    out += from.slice(cursor, cursor + (skip as number)) + ins;
    cursor += (skip as number) + (del as number);
  }
  return out + from.slice(cursor);
}
