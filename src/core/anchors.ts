// Where a comment sits in the text. While a document is open the editor tracks
// each comment's exact range as the text changes. To find it again later (the
// next time the document opens, or after an agent rewrote the file), a comment
// remembers the text it was on and a little of the text either side.
import type { Node } from "prosemirror-model";
import { PICTURE_STAND_IN } from "./doc-diff";

export interface Anchor {
  /** The commented text. */
  quote: string;
  /** Text just before and just after it, to tell repeats apart. */
  prefix: string;
  suffix: string;
  /** Roughly where it was, as a character offset in the document's text. */
  offset: number;
}

/** How much text either side of a comment's words it remembers. */
export const CONTEXT = 32;

/** The document's text, with a line break between blocks, and how to map back to positions. */
export interface TextIndex {
  text: string;
  /** Text offsets of each run of text, and the document position where it starts. */
  runs: { offset: number; pos: number; length: number }[];
}

export function textIndex(doc: Node): TextIndex {
  let text = "";
  const runs: TextIndex["runs"] = [];
  let first = true;
  doc.descendants((node, pos, parent) => {
    if (node.isTextblock) {
      // An empty line (a blank line of the file) holds no words: left out, so
      // empty lines added or taken away never move a comment's place.
      if (parent === doc && node.childCount === 0 && node.type.name === "paragraph") return false;
      if (!first) text += "\n";
      first = false;
      node.forEach((child, offset) => {
        // Pictures, footnote markers and line breaks take one place, in the text and in the document.
        const value = child.isText ? child.text! : PICTURE_STAND_IN;
        runs.push({ offset: text.length, pos: pos + 1 + offset, length: value.length });
        text += value;
      });
      return false;
    }
    return true;
  });
  return { text, runs };
}

/** The text offset of a document position (positions between runs snap forward). */
export function offsetAt(index: TextIndex, pos: number): number {
  let best = index.text.length;
  for (const run of index.runs) {
    if (pos <= run.pos) return Math.min(best, run.offset);
    if (pos <= run.pos + run.length) return run.offset + (pos - run.pos);
    best = run.offset + run.length + 1;
  }
  return index.text.length;
}

/** The document position of a text offset. */
export function posAt(index: TextIndex, offset: number, side: "start" | "end"): number {
  let found: number | null = null;
  for (const run of index.runs) {
    if (offset >= run.offset && offset <= run.offset + run.length) {
      found = run.pos + (offset - run.offset);
      // At a boundary between two runs, the start of a range belongs to the
      // later run and the end to the earlier one.
      if (side === "end" || offset < run.offset + run.length) return found;
    } else if (offset < run.offset) {
      return found ?? run.pos;
    }
  }
  const last = index.runs[index.runs.length - 1];
  return found ?? (last ? last.pos + last.length : 0);
}

/** An anchor for text[start, end): the words, a little of the text either side, and where they are. */
export function anchorIn(text: string, start: number, end: number): Anchor {
  return {
    quote: text.slice(start, end),
    prefix: text.slice(Math.max(0, start - CONTEXT), start),
    suffix: text.slice(end, end + CONTEXT),
    offset: start,
  };
}

/** Pass `index` (from textIndex) to anchor many ranges in one document without re-reading its text. */
export function anchorFor(doc: Node, from: number, to: number, index: TextIndex = textIndex(doc)): Anchor {
  const start = offsetAt(index, from);
  return anchorIn(index.text, start, Math.max(start, offsetAt(index, to)));
}

/** How many characters two strings share at their ends (b's start after a's end, etc.). */
export function sharedEnd(a: string, b: string): number {
  let n = 0;
  while (n < a.length && n < b.length && a[a.length - 1 - n] === b[b.length - 1 - n]) n++;
  return n;
}
export function sharedStart(a: string, b: string): number {
  let n = 0;
  while (n < a.length && n < b.length && a[n] === b[n]) n++;
  return n;
}

function allIndexes(text: string, find: string): number[] {
  const out: number[] = [];
  if (!find) return out;
  for (let i = text.indexOf(find); i >= 0; i = text.indexOf(find, i + 1)) out.push(i);
  return out;
}

// The same words can read differently as a grid and as Markdown text: a table
// shown as Markdown has pipes between its cells, a row of dashes under the
// header, "**" around bold words and "<br>" for line breaks, where the grid
// has none of these. To find a comment's text when its table switched form,
// both are compared "loosely": without Markdown's signs, with any run of
// spaces, line ends, pipes or line breaks as one space.
const DELIMITER_ROW = /^[ \t>]*\|?[ \t]*:?-+:?[ \t]*(?:\|[ \t]*:?-+:?[ \t]*)*\|?[ \t]*$/gm;
const LINE_BREAK_TAG = /<br\s*\/?>/gi;
const FORMAT_TAG = /<\/?(?:b|strong|i|em|s|del|strike)>/gi;
const LINK_ADDRESS = /\]\([^)\s]*(?:\s+"[^"]*")?\)/g;
const SIGN = /[*_~`\\[\]<>]/;
const GAP = new RegExp(`[\\s|${PICTURE_STAND_IN}]`);

/** The loose form of some text, and where each of its characters came from. */
export function looseText(text: string): { text: string; at: number[] } {
  const DROP = 1;
  const SPACE = 2;
  const kind = new Uint8Array(text.length);
  const mark = (re: RegExp, k: number) => {
    for (const m of text.matchAll(re)) kind.fill(k, m.index, m.index + m[0].length);
  };
  if (text.includes("-")) mark(DELIMITER_ROW, SPACE);
  if (text.includes("<")) {
    mark(LINE_BREAK_TAG, SPACE);
    mark(FORMAT_TAG, DROP);
  }
  if (text.includes("](")) mark(LINK_ADDRESS, DROP);
  let out = "";
  const at: number[] = [];
  let gap = false;
  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    const k = kind[i] || (SIGN.test(ch) ? DROP : GAP.test(ch) ? SPACE : 0);
    if (k === DROP) continue;
    if (k === SPACE) {
      gap = out.length > 0;
      continue;
    }
    if (gap) {
      out += " ";
      at.push(i);
      gap = false;
    }
    out += ch;
    at.push(i);
  }
  return { text: out, at };
}


const loose = (text: string) => looseText(text).text;

/**
 * A document's loose form, worked out once per index: finding many comments
 * in one go (every comment, after each agent edit) reads the document loosely
 * once, not once per comment whose words aren't there as they were. Kept only
 * as long as the index is.
 */
const looseForms = new WeakMap<TextIndex, { text: string; at: number[] }>();
function looseOf(index: TextIndex): { text: string; at: number[] } {
  let form = looseForms.get(index);
  if (!form) looseForms.set(index, (form = looseText(index.text)));
  return form;
}

/** Where some words were found, and how many characters of the text around them agree with what was around them. */
interface Found {
  start: number;
  end: number;
  context: number;
  /** How much of that agreement chance doesn't give: see solidIn. */
  solid: number;
  /** The text agrees on both sides past the line break next to the words, into the next block (a table's rows, short paragraphs). */
  blocks: boolean;
  /** The text agrees on both sides as far as the line break next to the words (or the document's edge): their whole paragraph reads as it did. */
  lines: boolean;
  /** The words are written only here. */
  once: boolean;
}

/** Less text than this around a comment's words is too little to agree with (a tiny document). */
const MIN_CONTEXT = 6;
/** How much of the text either side is looked for, to find a place whose words changed. */
const EDGE = 16;
/**
 * The same words away from where they were count only with this many letters
 * of agreement around them, in whole words of four or more: the words of the
 * same sentence, not " the " and a space, or "will" and "in", which chance
 * gives. Less when there weren't that many around them to begin with.
 */
const SOLID = 12;
/** Past this many places the words are written, only the best by the text right around them is weighed further. */
const WEIGHED = 200;

/** The character just outside a stretch of text: null where the document ends, undefined when it isn't known. */
type Edge = string | null | undefined;
const LETTER = /[\p{L}\p{N}]/u;
/** A word can't go on past this edge, in the old text or the new: the same character outside both, or no letter outside either. */
function wordEnds(old: Edge, now: Edge): boolean {
  if (old === undefined || now === undefined) return false;
  const gap = (c: string | null) => c === null || !LETTER.test(c);
  return old === now || (gap(old) && gap(now));
}
const charAt = (s: string, i: number, outside: Edge): Edge => (i >= 0 && i < s.length ? s[i] : outside);

/** Letters and digits of the whole words of four or more in some agreeing text; a word at an edge counts only when it ends there. */
function solidIn(agreeing: string, startEnds: boolean, endEnds: boolean): number {
  let n = 0;
  for (const m of agreeing.matchAll(/[\p{L}\p{N}]+/gu)) {
    if (m[0].length < 4) continue;
    if (!startEnds && m.index === 0) continue;
    if (!endEnds && m.index + m[0].length === agreeing.length) continue;
    n += m[0].length;
  }
  return n;
}

/**
 * The comment's prefix or suffix as remembered: what's just outside it is
 * the start or end of the document when it's shorter than CONTEXT, and the
 * comment's words on the other side.
 */
function sides(anchor: Anchor): { prefix: [Edge, Edge]; suffix: [Edge, Edge] } {
  return {
    prefix: [anchor.prefix.length < CONTEXT ? null : undefined, anchor.quote[0] ?? null],
    suffix: [anchor.quote[anchor.quote.length - 1] ?? null, anchor.suffix.length < CONTEXT ? null : undefined],
  };
}

/**
 * How solid the agreement is where old[os, oe) (the comment's prefix or
 * suffix) reads the same as text[ns, ne). `near` is the end that touches the
 * comment's words in both, where no word is cut.
 */
function agreed(old: string, outside: [Edge, Edge], os: number, oe: number, text: string, ns: number, ne: number, near: "start" | "end" | null): number {
  if (oe <= os) return 0;
  const startEnds = near === "start" || wordEnds(charAt(old, os - 1, outside[0]), charAt(text, ns - 1, null));
  const endEnds = near === "end" || wordEnds(charAt(old, oe, outside[1]), charAt(text, ne, null));
  return solidIn(old.slice(os, oe), startEnds, endEnds);
}

/** Old text agreeing on both sides goes past the line break next to the words, with words of the next block in it. */
const intoBlocks = (before: string, after: string) => /[\p{L}\p{N}][^\n]*\n[^\n]*$/u.test(before) && /^[^\n]*\n[^\n]*[\p{L}\p{N}]/u.test(after);

/** The agreement right next to words found at text[start, end): `b` characters of the prefix (raw), `a` of the suffix. */
function around(text: string, start: number, end: number, anchor: Anchor, b: number, a: number): { solid: number; blocks: boolean; lines: boolean } {
  const { prefix, suffix } = anchor;
  const out = sides(anchor);
  const before = prefix.slice(prefix.length - b);
  const after = suffix.slice(0, a);
  // A line starts (or ends) where the agreement stops, in the old text and the new, or within it.
  const lineAt = (c: Edge) => c === null || c === "\n";
  const fromLineStart = before.includes("\n") || (lineAt(charAt(prefix, prefix.length - b - 1, out.prefix[0])) && lineAt(charAt(text, start - b - 1, null)));
  const toLineEnd = after.includes("\n") || (lineAt(charAt(suffix, a, out.suffix[1])) && lineAt(charAt(text, end + a, null)));
  return {
    solid: agreed(prefix, out.prefix, prefix.length - b, prefix.length, text, start - b, start, "end") + agreed(suffix, out.suffix, 0, a, text, end, end + a, "start"),
    blocks: intoBlocks(before, after),
    lines: fromLineStart && toLineEnd,
  };
}

/** The longest stretch two short texts have in common: where it starts in each, and how long it is. */
function longestCommon(a: string, b: string): { a: number; b: number; length: number } {
  let best = { a: 0, b: 0, length: 0 };
  let prev = new Uint16Array(b.length + 1);
  let row = new Uint16Array(b.length + 1);
  for (let i = 1; i <= a.length; i++) {
    for (let j = 1; j <= b.length; j++) {
      row[j] = a[i - 1] === b[j - 1] ? prev[j - 1] + 1 : 0;
      if (row[j] > best.length) best = { a: i - row[j], b: j - row[j], length: row[j] };
    }
    [prev, row] = [row, prev];
  }
  return best;
}

/**
 * How solid the agreement around words found at text[start, end) is,
 * allowing for a word or two changed right next to them: the longest stretch
 * the text just before them has in common with what was before the words,
 * ending within EDGE characters of them, and the same after.
 */
function solidNear(text: string, start: number, end: number, anchor: Anchor): number {
  const { prefix, suffix } = anchor;
  const out = sides(anchor);
  const from = Math.max(0, start - prefix.length - EDGE);
  const b = longestCommon(prefix, text.slice(from, start));
  const a = longestCommon(suffix, text.slice(end, end + suffix.length + EDGE));
  let solid = 0;
  if (from + b.b + b.length >= start - EDGE) solid += agreed(prefix, out.prefix, b.a, b.a + b.length, text, from + b.b, from + b.b + b.length, null);
  if (a.b <= EDGE) solid += agreed(suffix, out.suffix, a.a, a.a + a.length, text, end + a.b, end + a.b + a.length, null);
  return solid;
}

/** What could agree around a comment's words: the solid words in what was around them. */
function solidRoom(anchor: Anchor): number {
  const { prefix, suffix } = anchor;
  const out = sides(anchor);
  const whole = (old: string, o: [Edge, Edge], near: "start" | "end") =>
    solidIn(old, near === "start" || (o[0] !== undefined), near === "end" || (o[1] !== undefined));
  return whole(prefix, out.prefix, "end") + whole(suffix, out.suffix, "start");
}

/** At least four words and twenty characters: written only once, they're the comment's words wherever they went. */
const longQuote = (quote: string) => quote.trim().length >= 20 && (quote.match(/[\p{L}\p{N}]+/gu)?.length ?? 0) >= 4;

/**
 * Find a comment's words in the text, both compared loosely. Where they are
 * written more than once, the text around them decides, then where they were.
 * Offsets are in the text as given.
 */
function looseMatch(text: string, whole: { text: string; at: number[] }, anchor: Anchor): Found | null {
  const quote = loose(anchor.quote);
  // A word or two in common isn't enough to be sure it's the same text.
  if (quote.replace(/\s/g, "").length < 2) return null;
  const found = allIndexes(whole.text, quote);
  if (!found.length) return null;
  const prefix = looseText(anchor.prefix);
  const suffix = looseText(anchor.suffix);
  let best: Found | null = null;
  let bestScore = -Infinity;
  for (const i of found) {
    const j = i + quote.length;
    // The space between the words and what's around them, if any, isn't compared.
    const gapBefore = whole.text[i - 1] === " " ? 1 : 0;
    const gapAfter = whole.text[j] === " " ? 1 : 0;
    const before = whole.text.slice(Math.max(0, i - gapBefore - prefix.text.length), i - gapBefore);
    const after = whole.text.slice(j + gapAfter, j + gapAfter + suffix.text.length);
    const start = whole.at[i];
    const end = whole.at[j - 1] + 1;
    const b = sharedEnd(before, prefix.text);
    const a = sharedStart(after, suffix.text);
    const score = b + a - Math.abs(start - anchor.offset) / 1000;
    if (score > bestScore) {
      bestScore = score;
      // Back to the text as written: how much of the prefix and suffix agree, and where that is now.
      const rawB = b ? anchor.prefix.length - prefix.at[prefix.text.length - b] : 0;
      const rawA = a ? suffix.at[a - 1] + 1 : 0;
      const newBefore = b ? whole.at[i - gapBefore - b] : start;
      const newAfter = a ? whole.at[j + gapAfter + a - 1] + 1 : end;
      const near = aroundLoosely(text, start, end, anchor, rawB, rawA, newBefore, newAfter);
      best = { start, end, context: b + a, solid: near.solid, blocks: near.blocks, lines: false, once: found.length === 1 };
    }
  }
  return best;
}

/**
 * The agreement around words found loosely at text[start, end): the last
 * `b` characters of the prefix as written read loosely the same as
 * text[newBefore, start), and the first `a` of the suffix as text[end, newAfter).
 */
function aroundLoosely(text: string, start: number, end: number, anchor: Anchor, b: number, a: number, newBefore: number, newAfter: number): { solid: number; blocks: boolean } {
  const { prefix, suffix } = anchor;
  const out = sides(anchor);
  return {
    solid: agreed(prefix, out.prefix, prefix.length - b, prefix.length, text, newBefore, start, "end") + agreed(suffix, out.suffix, 0, a, text, end, newAfter, "start"),
    blocks: intoBlocks(prefix.slice(prefix.length - b), suffix.slice(0, a)),
  };
}

/** A comment's remembered text either side of its words, read loosely: once per search, not once per place. */
type LooseSides = { prefix: { text: string; at: number[] }; suffix: { text: string; at: number[] } };

/** How well the text around a place matches a comment's remembered context, compared loosely. */
function looseContext(text: string, start: number, end: number, reachBefore: number, reachAfter: number, anchor: Anchor, { prefix, suffix }: LooseSides): { context: number; solid: number; blocks: boolean } {
  const from = Math.max(0, start - reachBefore);
  const before = looseText(text.slice(from, start));
  const after = looseText(text.slice(end, end + reachAfter));
  const b = sharedEnd(before.text, prefix.text);
  const a = sharedStart(after.text, suffix.text);
  const rawB = b ? anchor.prefix.length - prefix.at[prefix.text.length - b] : 0;
  const rawA = a ? suffix.at[a - 1] + 1 : 0;
  const newBefore = b ? from + before.at[before.text.length - b] : start;
  const newAfter = a ? end + after.at[a - 1] + 1 : end;
  return { context: b + a, ...aroundLoosely(text, start, end, anchor, rawB, rawA, newBefore, newAfter) };
}

/**
 * Of the places the words are written exactly, the one whose surroundings
 * agree best, then the nearest (of equals, the first in the text). Comparing
 * loosely costs far more than exactly, and a short common word is written
 * hundreds of times: so the places are weighed best exact agreement first,
 * and loosely only while one still could win, since loose agreement can add
 * no more than the remembered text's own loose length (R16-4).
 */
function bestExact(text: string, starts: number[], anchor: Anchor, looseToo: boolean): Found {
  const { quote, prefix, suffix, offset } = anchor;
  const reach = Math.min(prefix.length, EDGE) + Math.min(suffix.length, EDGE);
  // How far to look around a place for its context, compared loosely (Markdown text is longer).
  const reachBefore = prefix.length * 3 + 16;
  const reachAfter = suffix.length * 3 + 16;
  const places = starts.map((start, order) => {
    const end = start + quote.length;
    const b = sharedEnd(text.slice(Math.max(0, start - prefix.length), start), prefix);
    const a = sharedStart(text.slice(end, end + suffix.length), suffix);
    return { start, end, order, b, a, exact: b + a, near: b + a - Math.abs(start - offset) / 1000 };
  });
  // A table that switched between grid and Markdown text has the same words around it.
  const looseAt = (exact: number) => looseToo && (starts.length > 1 || exact < reach);
  let sides: LooseSides | null = null;
  let most = 0; // the most loose agreement could add
  if (places.some((p) => looseAt(p.exact))) {
    sides = { prefix: looseText(prefix), suffix: looseText(suffix) };
    most = sides.prefix.text.length + sides.suffix.text.length;
    places.sort((x, y) => y.near - x.near || x.order - y.order);
  }
  let best: Found = { start: -1, end: -1, context: -1, solid: 0, blocks: false, lines: false, once: starts.length === 1 };
  let bestScore = -Infinity;
  let bestOrder = Infinity;
  for (const { start, end, order, b, a, exact, near } of places) {
    // Sorted: no place from here on can reach the best, even agreeing loosely all the way.
    if (sides && near + most + 1e-9 < bestScore) break;
    const loosely = sides && looseAt(exact) ? looseContext(text, start, end, reachBefore, reachAfter, anchor, sides) : null;
    const score = exact + (loosely?.context ?? 0) - Math.abs(start - offset) / 1000;
    if (score > bestScore || (score === bestScore && order < bestOrder)) {
      bestScore = score;
      bestOrder = order;
      const next = around(text, start, end, anchor, b, a);
      best = {
        start,
        end,
        context: Math.max(exact, loosely?.context ?? 0),
        solid: Math.max(next.solid, loosely?.solid ?? 0),
        blocks: next.blocks || !!loosely?.blocks,
        lines: next.lines,
        once: starts.length === 1,
      };
    }
  }
  return best;
}

/**
 * Whether words found away from where they were are the comment's words, not
 * the same words somewhere else: the text around them agrees with what was
 * around them more than chance would (allowing for a word or two changed
 * right next to them), or into the blocks either side; or they're long and
 * written only there, or their whole paragraph is, as it was. Words not
 * written as they were anywhere, but loosely (another table form, other
 * Markdown signs) only there, count too. With no real words around them to
 * go by, most of what was around them must agree.
 */
function trusted(text: string, best: Found, anchor: Anchor, exact: boolean): boolean {
  const { quote, prefix, suffix } = anchor;
  if (best.once && (longQuote(quote) || (!exact && (loose(quote).match(/[\p{L}\p{N}]+/gu)?.length ?? 0) >= 2))) return true;
  if (best.blocks) return true;
  if (best.lines) {
    const from = text.lastIndexOf("\n", best.start - 1) + 1;
    const to = text.indexOf("\n", best.end);
    const paragraph = text.slice(from, to < 0 ? text.length : to);
    if (longQuote(paragraph) && allIndexes(text, paragraph).length === 1) return true;
  }
  const room = solidRoom(anchor);
  if (room === 0) return prefix.length + suffix.length < MIN_CONTEXT || best.context * 2 >= prefix.length + suffix.length;
  const needed = Math.min(SOLID, room);
  return best.solid >= needed || (exact && solidNear(text, best.start, best.end, anchor) >= needed);
}

/** How many line breaks start to end of a text holds. */
function lineCount(text: string, start: number, end: number): number {
  let n = 0;
  for (let i = text.indexOf("\n", start); i >= 0 && i < end; i = text.indexOf("\n", i + 1)) n++;
  return n;
}

/**
 * The place between the text that was just before the words and the text
 * just after them, nearest where they were: where the words were, if they
 * changed. Empty when they were taken out.
 */
function betweenWords(text: string, anchor: Anchor): Found | null {
  const before = anchor.prefix.slice(-EDGE);
  const after = anchor.suffix.slice(0, EDGE);
  const starts = before ? allIndexes(text, before).map((i) => i + before.length) : [0];
  let found: Found | null = null;
  let bestDistance = Infinity;
  for (const start of starts) {
    let end: number;
    if (!after) end = text.indexOf("\n", start) < 0 ? text.length : text.indexOf("\n", start);
    // Taken out with one of the spaces either side: the space is shared.
    else if (text.startsWith(after, start) || (/\s/.test(after[0]) && text[start - 1] === after[0] && text.startsWith(after, start - 1))) end = start;
    else end = text.indexOf(after, start);
    if (end < start) continue;
    // A replacement much longer than what was there, or running into other paragraphs, is probably the wrong spot.
    if (end - start > Math.max(200, anchor.quote.length * 4)) continue;
    if (lineCount(text, start, end) > lineCount(anchor.quote, 0, anchor.quote.length)) continue;
    const distance = Math.abs(start - anchor.offset);
    if (distance < bestDistance) {
      bestDistance = distance;
      found = { start, end, context: before.length + after.length, solid: 0, blocks: false, lines: false, once: false };
    }
  }
  return found;
}

/** A place where words were only taken out (an anchor with no words): between the words that were around it. */
function placeOf(text: string, anchor: Anchor): { start: number; end: number } | null {
  const { prefix, suffix, offset } = anchor;
  const before = prefix.slice(-EDGE);
  const after = suffix.slice(0, EDGE);
  const closest = (places: number[]) => places.reduce((best, p) => (best < 0 || Math.abs(p - offset) < Math.abs(best - offset) ? p : best), -1);
  let at = closest(allIndexes(text, before + after).map((i) => i + before.length));
  if (at < 0 && before.length >= 8) at = closest(allIndexes(text, before).map((i) => i + before.length));
  if (at < 0 && after.length >= 8) at = closest(allIndexes(text, after));
  if (at < 0 && !prefix && !suffix) at = Math.min(offset, text.length);
  return at < 0 ? null : { start: at, end: at };
}

/**
 * Where an anchor's words are in a text: comments, an agent's change spans,
 * and the places of deleted words are all found this way. Where the words
 * are written more than once, the text around them decides, then where they
 * were. If the words themselves changed, the place between the text that was
 * around them. The same words somewhere else count only when the text around
 * them agrees with what was around them more than chance would, or when
 * they're long and written only there (see trusted): a comment on "customers"
 * whose word an agent changed doesn't jump to the next "customers", nor a
 * comment on "board" to "the board" in the next sentence. Null when it can't
 * be found, or when its words were taken out where they were.
 *
 * `whole` gives the text's loose form (see looseText), to also find words
 * written differently in a document's text.
 */
function find(text: string, anchor: Anchor, whole: (() => { text: string; at: number[] }) | null): { start: number; end: number } | null {
  const { quote, prefix, suffix, offset } = anchor;
  // Where it says, with all the text that was around it: there, as weighing every place would decide.
  // So it is after an agent's edit, which carries every place (agents/follow-edits.ts).
  if (whereItSays(text, anchor)) return { start: offset, end: offset + quote.length };
  if (!quote) return placeOf(text, anchor);
  const starts = allIndexes(text, quote);
  // The words are there, or there but written differently: "**bold** text"
  // for bold text, or across cells with pipes between them.
  const best = starts.length ? bestExact(text, starts, anchor, !!whole) : whole ? looseMatch(text, whole(), anchor) : null;
  // Agreeing as much as the place between could: no need to look further.
  if (best && best.context >= Math.min(prefix.length, EDGE) + Math.min(suffix.length, EDGE)) return best;
  const between = prefix.length >= 8 || suffix.length >= 8 ? betweenWords(text, anchor) : null;
  if (between && (!best || between.context > best.context)) return between.end > between.start ? between : null;
  if (!best) return null;
  if (trusted(text, best, anchor, starts.length > 0)) return best;
  // Written more than once: another of them may agree once a word changed next to it is allowed for.
  const needed = Math.min(SOLID, solidRoom(anchor));
  if (starts.length < 2 || starts.length > WEIGHED || !needed) return null;
  let other: Found | null = null;
  let otherSolid = -1;
  for (const start of starts) {
    if (start === best.start) continue;
    const solid = solidNear(text, start, start + quote.length, anchor);
    if (solid > otherSolid || (solid === otherSolid && other && Math.abs(start - offset) < Math.abs(other.start - offset))) {
      otherSolid = solid;
      other = { start, end: start + quote.length, context: 0, solid, blocks: false, lines: false, once: false };
    }
  }
  return other && otherSolid >= needed ? other : null;
}

/** Whether the anchor's words, and all the text it had around them, are written at its offset. */
function whereItSays(text: string, { quote, prefix, suffix, offset }: Anchor): boolean {
  if (!quote && !prefix && !suffix) return false;
  const end = offset + quote.length;
  return offset >= prefix.length && text.startsWith(prefix, offset - prefix.length) && text.startsWith(quote, offset) && text.startsWith(suffix, end);
}

/** Where an anchor (a change span, or the place of deleted words) is in a text; see find. */
export function locate(text: string, anchor: Anchor): { start: number; end: number } | null {
  const found = find(text, anchor, null);
  return found && { start: found.start, end: found.end };
}

/**
 * Find a comment's range in a document. Looks for the quoted text, choosing
 * between repeats by the text around it and where it was. If the quoted text
 * itself was changed, finds it by the text that was around it. Null when it
 * can't be found.
 *
 * `putIn` gives stretches of the document just put in (pasted, dropped,
 * typed in the Markdown view): where the comment's words can't be found
 * otherwise, its words written in one of them are its words, cut and put
 * back there, however little of the text around them came along.
 */
export function findAnchor(
  doc: Node,
  anchor: Anchor,
  index: TextIndex = textIndex(doc),
  putIn: readonly { from: number; to: number }[] = [],
): { from: number; to: number } | null {
  const found = find(index.text, anchor, () => looseOf(index));
  if (found && found.end > found.start) return { from: posAt(index, found.start, "start"), to: posAt(index, found.end, "end") };
  const back = anchor.quote ? putBack(index, anchor, putIn) : null;
  return back && { from: posAt(index, back.start, "start"), to: posAt(index, back.end, "end") };
}

/** A comment's words written in text just put in: of several, the one whose surroundings agree best, then the nearest where they were. */
function putBack(index: TextIndex, anchor: Anchor, putIn: readonly { from: number; to: number }[]): Found | null {
  const stretches = putIn.map((r) => ({ start: offsetAt(index, r.from), end: offsetAt(index, r.to) }));
  const starts = allIndexes(index.text, anchor.quote).filter((s) => stretches.some((r) => r.start <= s && s + anchor.quote.length <= r.end));
  return starts.length ? bestExact(index.text, starts, anchor, false) : null;
}
