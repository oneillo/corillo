// Carrying a comment's words through an agent's edit: where they are in the new text, or where they were taken out.
import { CONTEXT, locate, sharedEnd, sharedStart, type Anchor } from "./anchors";
import { similarity } from "./diff";
import type { OffsetMap } from "./change-links-follow";

/** Where words of the older text are in the newer one. */
export type Carried =
  /** On these words now: the same words, the words they were changed to in place, or the passage that rewrote them. */
  | { kind: "words"; start: number; end: number }
  /** All of them taken out, here. */
  | { kind: "deleted"; at: number }
  /** Rewritten along with other paragraphs: which of the new words are theirs would be a guess. */
  | { kind: "lost" };

/** A word with something other than a letter either side of it. */
const WHOLE_WORD = /[^\p{L}\p{N}][\p{L}\p{N}]+[^\p{L}\p{N}]/u;

const lowerWords = (text: string) => text.toLowerCase().match(/[\p{L}\p{N}]+/gu) ?? [];
/** How alike (see similarity) the words in a paragraph's place must be to it to read as it rewritten: as alike as Show changes needs to show one block changed. */
const REWRITE = 0.4;
const lineBreaks = (text: string) => text.split("\n").length - 1;

/**
 * Where the words before[start, end) are in `after`, by what the edit did
 * (`map` maps between the two), never by looking for the same words
 * somewhere else. A word put in at their edge stays outside them, one put in
 * among them joins them, and words changed in place are the new words there.
 * Where the word-by-word comparison can't say which new words are theirs
 * (it matched a "the" or a space in a rewritten sentence, say), they're the
 * passage that rewrote them, as a person reads it: a comment on "board" in
 * "The report goes to the board today" rewritten as "The report is sent to
 * directors this week" is on "is sent to directors this week". Lost when
 * that passage runs into other paragraphs. Deleted when all of them were
 * taken out, or all but a mark that closed them (a full stop, a bracket),
 * unless the edit moved them whole elsewhere: their paragraphs moved
 * unchanged, or the words found (by `anchor`, with what was around them)
 * among the words the edit put in.
 */
export function carry(before: string, after: string, start: number, end: number, map: OffsetMap, anchor: Anchor): Carried {
  // Their paragraphs as they were, written once before and after: they're there, wherever the edit moved them.
  // (A paragraph moved past others can read word by word as words changed all along the way.)
  // Unless other words stand in their place, as many lines of them, and they read as rewritten there: the
  // same words elsewhere are another line's, rewritten to say them ("We ship in May." changed, and another
  // paragraph now says it), or the words in their place share a good part of theirs. Put in as new lines,
  // with other words in their old place, they moved ("move the summary to the end and add an intro").
  const from = before.lastIndexOf("\n", start - 1) + 1;
  const lineEnd = before.indexOf("\n", end);
  const paragraphs = before.slice(from, lineEnd < 0 ? before.length : lineEnd);
  const there = wholeLines(after, paragraphs);
  if (there.length === 1 && wholeLines(before, paragraphs).length === 1) {
    const was = map.widen(from, from + paragraphs.length);
    const ns = map.map(was.start, 1);
    const ne = map.map(was.end, -1);
    const rewritten =
      ne > ns &&
      ns !== there[0] &&
      lineBreaks(after.slice(ns, ne)) === lineBreaks(paragraphs) &&
      (!map.putInNew(there[0], there[0] + paragraphs.length) || similarity(after.slice(ns, ne), paragraphs) >= REWRITE);
    if (!rewritten) return { kind: "words", start: there[0] + start - from, end: there[0] + end - from };
  }

  const quote = before.slice(start, end);
  let s = map.map(start, 1);
  let e = map.map(end, -1);
  // Words put in among them that end with their first words (or start with
  // their last) could as well have gone just before (or after) them, where
  // they stay outside: "the dog and " put in before "the cat sat".
  const put = map.insertionsIn(start, end);
  if (put.length === 1) {
    const { a, b, length } = put[0];
    const words = after.slice(b, b + length);
    if (a - start <= length && words.endsWith(before.slice(start, a)) && after.slice(b + length - (a - start), e) === quote) s = b + length - (a - start);
    else if (end - a <= length && words.startsWith(before.slice(a, end)) && after.slice(s, b + (end - a)) === quote) e = b + (end - a);
  }
  // Moved: found among the words the edit put in. The same words in text that was there before aren't theirs,
  // nor are other words put in where they were (found by what was around them).
  const movedWhole = (): Carried | null => {
    const found = locate(after, anchor);
    return found && found.end > found.start && after.slice(found.start, found.end) === quote && map.putIn(found.start, found.end) ? { kind: "words", ...found } : null;
  };
  if (e > s) {
    const now = after.slice(s, e);
    // The comparison's place is sure when some of their words are still there, or a word right next to it was kept:
    // "review" in "We review it" changed to "checks" in "finance checks it". Only spaces kept either side is chance:
    // a rewritten sentence's "board" matched to "this".
    const kept = new Set(lowerWords(quote));
    const nowWords = lowerWords(now);
    if (now === quote || nowWords.some((w) => kept.has(w))) return { kind: "words", start: s, end: e };
    const prefix = before.slice(Math.max(0, start - CONTEXT), start);
    const suffix = before.slice(end, end + CONTEXT);
    const b = sharedEnd(prefix, after.slice(Math.max(0, s - CONTEXT), s));
    const a = sharedStart(suffix, after.slice(e, e + CONTEXT));
    // The document's start or end bounds a word as a space does.
    const keptBefore = (start - b === 0 && s - b === 0 ? "\n" : "") + prefix.slice(prefix.length - b);
    const keptAfter = suffix.slice(0, a) + (end + a === before.length && e + a === after.length ? "\n" : "");
    // A place that holds no word isn't sure for words that had some: a full stop kept where a sentence was rewritten.
    const wordless = kept.size > 0 && !nowWords.length;
    if (!wordless && ((!prefix && !suffix) || WHOLE_WORD.test(keptBefore) || WHOLE_WORD.test(keptAfter))) return { kind: "words", start: s, end: e };
  } else {
    // Nothing put in where the changes that took them out were: deleted.
    const wide = map.widen(start, end);
    if (map.map(wide.end, -1) <= map.map(wide.start, 1)) return movedWhole() ?? { kind: "deleted", at: s };
  }
  // Rewritten with what was around them: the passage that rewrote them, as a person reads it.
  const read = map.asRead();
  const wide = read.widen(start, end);
  const ns = read.map(wide.start, 1);
  const ne = read.map(wide.end, -1);
  if (ne <= ns) return movedWhole() ?? { kind: "deleted", at: ns };
  // Their words cut, with only a mark left there (the full stop or bracket that closed them): deleted
  // there, as when the mark goes too, never on the mark alone (roadmap Batch 10, item 3, R-9).
  if (lowerWords(quote).length && !lowerWords(after.slice(ns, ne)).length) return movedWhole() ?? { kind: "deleted", at: ns };
  const lines = lineBreaks(quote);
  if (lineBreaks(before.slice(wide.start, wide.end)) === lines && lineBreaks(after.slice(ns, ne)) === lines) return { kind: "words", start: ns, end: ne };
  return movedWhole() ?? { kind: "lost" };
}

/** Where `lines` stands as whole lines in `text`. */
function wholeLines(text: string, lines: string): number[] {
  const out: number[] = [];
  if (!lines) return out;
  for (let i = text.indexOf(lines); i >= 0; i = text.indexOf(lines, i + 1)) {
    if ((i === 0 || text[i - 1] === "\n") && (i + lines.length === text.length || text[i + lines.length] === "\n")) out.push(i);
  }
  return out;
}
