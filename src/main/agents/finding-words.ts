// Finding what an agent means: the file line a comment's words are on, the place of a quote it gives, and the open documents a name fits.
import * as path from "node:path";
import type { Node } from "prosemirror-model";
import { anchorFor, findAnchor, posAt, textIndex, type Anchor, type TextIndex } from "../../core/anchors";
import { lineMarks, type LineMark } from "../../core/line-numbers";
import { OPENS_AS_MARKDOWN } from "../../core/doc-names";
import { parseMarkdown } from "../../core/markdown";
import { linesOf } from "./long-documents";
import { AgentError, type AgentDoc } from "./shapes";

/** The file line a comment's words start on, or null if they aren't there; `markdown` is the text it reads. */
export type LineOf = ((anchor: Anchor) => number | null) & {
  markdown?: string;
  /** The first and last lines the words are on. */
  range: (anchor: Anchor) => { first: number; last: number } | null;
};

/**
 * Line numbers for comments in one text, read once however many are asked
 * for. A comment's words are found the way the window finds them, and their
 * line is the one View > Line Numbers shows there, so "line 42" is the same
 * line for the agent and the person, also in a table, a list or bold words.
 */
export function commentLines(markdown: string): LineOf {
  let read: { doc: Node; index: TextIndex; marks: LineMark[] } | null | undefined;
  const parsed = () => {
    if (read === undefined) {
      try {
        const { doc, source } = parseMarkdown(markdown);
        read = { doc, index: textIndex(doc), marks: lineMarks(doc, source) };
      } catch {
        read = null;
      }
    }
    return read;
  };
  // The mark that starts last at or before a place: its block, or its line in it.
  const lineAt = (marks: LineMark[], pos: number): number | null => {
    let line: number | null = null;
    let from = -1;
    for (const m of marks) {
      if (m.from <= pos && m.from >= from) {
        from = m.from;
        line = m.line;
      }
    }
    return line;
  };
  const range = (anchor: Anchor): { first: number; last: number } | null => {
    const r = parsed();
    const found = r ? findAnchor(r.doc, anchor, r.index) : null;
    if (r && found) {
      const first = lineAt(r.marks, found.from);
      if (first !== null) return { first, last: Math.max(first, lineAt(r.marks, Math.max(found.from, found.to - 1)) ?? first) };
    }
    const first = searchLine(markdown, anchor);
    if (first === null) return null;
    // Not placed: where the words' last line is written, after their first.
    const lastLine = anchor.quote.trimEnd().split("\n").pop()!.trim();
    if (!anchor.quote.trim().includes("\n") || !lastLine) return { first, last: first };
    const lines = linesOf(markdown);
    const at = lines.findIndex((l, i) => i >= first - 1 && l.includes(lastLine));
    return { first, last: at >= 0 ? at + 1 : first };
  };
  const lineOf = ((anchor: Anchor) => range(anchor)?.first ?? null) as LineOf;
  lineOf.range = range;
  lineOf.markdown = markdown;
  return lineOf;
}

/**
 * If the words can't be placed in the document: the line of the Markdown
 * where they're written. When they appear more than once, it's the place whose
 * surrounding words match the comment's best.
 */
function searchLine(markdown: string, anchor: Anchor): number | null {
  const firstLine = anchor.quote.split("\n")[0].slice(0, 60);
  if (!firstLine) return null;
  const whole = firstLine === anchor.quote; // then the comment's following words come straight after
  let best = -1;
  let bestScore = -1;
  for (let i = markdown.indexOf(firstLine); i >= 0; i = markdown.indexOf(firstLine, i + 1)) {
    const before = markdown.slice(0, i);
    const after = markdown.slice(i + firstLine.length);
    let score = 0;
    while (score < before.length && score < anchor.prefix.length && before[before.length - 1 - score] === anchor.prefix[anchor.prefix.length - 1 - score]) score++;
    if (whole) for (let n = 0; n < after.length && n < anchor.suffix.length && after[n] === anchor.suffix[n]; n++) score++;
    if (score > bestScore) {
      bestScore = score;
      best = i;
    }
  }
  return best < 0 ? null : markdown.slice(0, best).split("\n").length;
}

/**
 * Where an agent's quote is in the document, as a comment anchor. The quote is
 * matched against the text as it reads; if it has Markdown marks in it (like
 * **), it's matched without them.
 */
export function anchorForQuote(markdown: string, quote: string): Anchor {
  const doc = parseMarkdown(markdown).doc;
  const index = textIndex(doc);
  const hitsOf = (q: string) => {
    const out: number[] = [];
    if (!q) return out;
    for (let i = index.text.indexOf(q); i >= 0; i = index.text.indexOf(q, i + 1)) out.push(i);
    return out;
  };
  let q = quote;
  let hits = hitsOf(q);
  if (!hits.length) {
    const plain = textIndex(parseMarkdown(quote).doc).text;
    if (plain && plain !== q) {
      q = plain;
      hits = hitsOf(q);
    }
  }
  if (!hits.length) {
    throw new AgentError("That quote isn't in the document. Use words exactly as they read in it, in one stretch. Nothing was added.");
  }
  if (hits.length > 1) {
    throw new AgentError(`That quote appears ${hits.length} times. Add a few words around it so it appears only once. Nothing was added.`);
  }
  return anchorFor(doc, posAt(index, hits[0], "start"), posAt(index, hits[0] + q.length, "end"));
}

/** Words that say nothing about which document is meant: "the", "doc" and the like. */
const FILLER = new Set(["the", "a", "an", "my", "our", "this", "that", "doc", "document", "file", "in", "on", "corillo"]);
const wordsOf = (name: string) =>
  name
    .toLowerCase()
    .replace(OPENS_AS_MARKDOWN, "")
    .split(/[^\p{L}\p{N}]+/u)
    .filter(Boolean);

/** The open documents a name fits: those with exactly that name, else those whose name has every word of it. */
export function namedIn(docs: AgentDoc[], name: string): AgentDoc[] {
  const wanted = wordsOf(name);
  const own = (d: AgentDoc) => wordsOf(path.basename(d.filePath));
  const exact = docs.filter((d) => own(d).join(" ") === wanted.join(" "));
  if (exact.length) return exact;
  const key = wanted.filter((w) => !FILLER.has(w));
  if (!key.length) return [];
  return docs.filter((d) => {
    const words = new Set(own(d));
    return key.every((w) => words.has(w));
  });
}
