// What an agent's change came to, in a few words, for the History panel and
// for agents reading the history. A change is a list of places where words
// were taken out and put in (see change-links.ts). A lone comma, "it" or the
// end of a word says nothing on its own, so only places with real words in
// them are shown, as whole words, and every place is counted. Plain logic, no
// window code.
import type { ChangeSpan } from "./change-links";
import { PICTURE_STAND_IN } from "./doc-diff";

/** One place, as whole words. */
export interface Snippet {
  /** What the text said there before ("" when words were only put in). */
  removed: string;
  /** What it says now ("" when words were only taken out). */
  added: string;
}

export interface ChangeSummary {
  /** How many places changed. */
  total: number;
  /** The biggest few places worth reading, in the order they come in the document. */
  shown: Snippet[];
}

const WORD = /[\p{L}\p{N}]+(?:['’][\p{L}\p{N}]+)*/gu;
const IN_WORD = /[\p{L}\p{N}]/u;
/** Letters and digits at the end, or the start, of some text: the rest of a word a change cut into. */
const WORD_END = /[\p{L}\p{N}]+(?:['’][\p{L}\p{N}]+)*$/u;
const WORD_START = /^[\p{L}\p{N}]+(?:['’][\p{L}\p{N}]+)*/u;

/** Words in a snippet are flattened onto one line; pictures and other objects aren't words. */
const flat = (s: string) => s.replaceAll(PICTURE_STAND_IN, "").replace(/\s+/g, " ").trim();

/** Worth reading on its own: two or more words, a word of four or more letters, or a number. */
export function meaningful(text: string): boolean {
  const words = text.match(WORD) ?? [];
  return words.length >= 2 || words.some((w) => w.length >= 4 || /\p{N}/u.test(w));
}

/**
 * The place as whole words: a change that starts or ends inside a word takes
 * in the rest of that word, on both sides ("hunger" to "hungry", not "er" to
 * "ry").
 */
export function wholeWords(span: ChangeSpan): Snippet {
  const { quote, prefix, suffix } = span.anchor;
  const removed = span.removed;
  const startsInWord = IN_WORD.test(removed[0] ?? "") || IN_WORD.test(quote[0] ?? "");
  const endsInWord = IN_WORD.test(removed[removed.length - 1] ?? "") || IN_WORD.test(quote[quote.length - 1] ?? "");
  const lead = startsInWord ? (WORD_END.exec(prefix)?.[0] ?? "") : "";
  const trail = endsInWord ? (WORD_START.exec(suffix)?.[0] ?? "") : "";
  const whole = (s: string) => (s || lead || trail ? lead + s + trail : "");
  return { removed: flat(whole(removed)), added: flat(whole(quote)) };
}

/** Long words cut at a space, with an ellipsis, so a snippet never ends in part of a word. */
export function clipWords(text: string, max = 60): string {
  if (text.length <= max) return text;
  const cut = text.slice(0, max);
  const space = cut.lastIndexOf(" ");
  return `${(space > max * 0.5 ? cut.slice(0, space) : cut).replace(/[\s,;:.]+$/, "")}…`;
}

const letters = (s: Snippet) => (s.removed + s.added).replace(/[^\p{L}\p{N}]/gu, "").length;

/** Every place counted; the `max` biggest places with real words in them shown, in document order. */
export function summarizeChanges(spans: ChangeSpan[], max = 3): ChangeSummary {
  const places = spans.map((span, i) => ({ i, at: span.anchor.offset, snippet: wholeWords(span) }));
  const worth = places.filter((p) => meaningful(p.snippet.removed) || meaningful(p.snippet.added));
  const picked = worth
    .sort((a, b) => letters(b.snippet) - letters(a.snippet) || a.i - b.i)
    .slice(0, max)
    .sort((a, b) => a.at - b.at || a.i - b.i);
  return {
    total: spans.length,
    shown: picked.map(({ snippet }) => ({ removed: clipWords(snippet.removed), added: clipWords(snippet.added) })),
  };
}

const places = (n: number) => `${n} ${n === 1 ? "place" : "places"}`;

/**
 * The count's words, when not every place is shown: "Changed 14 places,
 * including", or "Changed 2 places (punctuation or short words)" when none
 * is worth showing. Null when every place is shown.
 */
export function countText(summary: ChangeSummary): string | null {
  const { total, shown } = summary;
  if (!total || shown.length === total) return null;
  if (shown.length) return `Changed ${places(total)}, including`;
  return `Changed ${places(total)} (punctuation or short words)`;
}

/** The summary as text for an agent: [-old-]{+new+} for each place shown, with the count when some aren't. */
export function summaryText(spans: ChangeSpan[], max = 3): string {
  const summary = summarizeChanges(spans, max);
  if (!summary.total) return "";
  const shown = summary.shown.map((s) => `${s.removed ? `[-${s.removed}-]` : ""}${s.added ? `{+${s.added}+}` : ""}`).join("; ");
  const count = countText(summary);
  if (!count) return shown;
  // "Changed: 14 places, including [-a-]{+b+}" reads on after the label the agent sees.
  const rest = count.replace(/^Changed /, "");
  return summary.shown.length ? `${rest} ${shown}` : rest;
}
