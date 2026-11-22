// A document's words as Corillo shows them, and where each of its Markdown lines starts in them, the last few kept.
import { textIndex, type TextIndex } from "./anchors";
import { parseMarkdown, type Source } from "./markdown";
import { lineMarks } from "./line-numbers";
import type { Node } from "prosemirror-model";

/** A Markdown text read as words, and where each of its lines starts in them. */
export interface Reading {
  markdown: string;
  /** The document's words as Corillo shows them, the same text comment anchors are measured in. */
  words: string;
  /** For each line of the Markdown, where its words start (-1 for a line with none: a blank line, a table's dashes, a closing fence). */
  starts: Int32Array;
}

/**
 * The last few texts read as words. Each agent edit needs the document's
 * words before and after, and one edit's after is the next one's before:
 * reading a long document takes a while, and the window waits for it. Each
 * is kept for the document it was read for, until that document closes.
 */
const recentWords: (Reading & { doc?: string })[] = [];

/** The document's words, and where its lines start in them. `doc` is the document they're read for. */
export function reading(markdown: string, doc?: string): Reading {
  const known = recentWords.find((r) => r.markdown === markdown);
  if (known) {
    if (doc !== undefined) known.doc = doc;
    return known;
  }
  const { doc: node, source } = parseMarkdown(markdown);
  const index = textIndex(node);
  const read = { markdown, words: index.text, starts: lineStarts(markdown, node, source, index), doc };
  recentWords.unshift(read);
  recentWords.length = Math.min(recentWords.length, 3);
  return read;
}

/** The document's words as Corillo shows them, the same text comment anchors are measured in. `doc` is the document they're read for. */
export function plainText(markdown: string, doc?: string): string {
  return reading(markdown, doc).words;
}

/** Where each line of the Markdown starts in the words: the line View > Line Numbers gives a block, or a line in one. */
function lineStarts(markdown: string, node: Node, source: Source, index: TextIndex): Int32Array {
  let lines = 1;
  for (let i = markdown.indexOf("\n"); i >= 0; i = markdown.indexOf("\n", i + 1)) lines++;
  const starts = new Int32Array(lines).fill(-1);
  let marks;
  try {
    marks = lineMarks(node, source);
    if (marks.some((m, i) => i > 0 && m.from < marks![i - 1].from)) marks.sort((x, y) => x.from - y.from);
  } catch {
    return starts; // no lines known: comments are followed by the words alone
  }
  // offsetAt (anchors.ts) for each mark in turn, walking the runs once.
  const { runs, text } = index;
  let r = 0;
  for (const m of marks) {
    while (r < runs.length && m.from > runs[r].pos + runs[r].length) r++;
    let at: number;
    if (r === runs.length) at = text.length;
    else if (m.from <= runs[r].pos) at = r > 0 ? Math.min(runs[r - 1].offset + runs[r - 1].length + 1, runs[r].offset) : runs[r].offset;
    else at = runs[r].offset + (m.from - runs[r].pos);
    const line = m.line - 1;
    if (line >= 0 && line < lines && starts[line] < 0) starts[line] = at;
  }
  return starts;
}

/** The document closed: let go of the texts read for it. */
export function forgetWords(doc: string): void {
  for (let i = recentWords.length - 1; i >= 0; i--) if (recentWords[i].doc === doc) recentWords.splice(i, 1);
}

/** How many texts are kept read for this document, for the leak checks. */
export function wordsKept(doc: string): number {
  return recentWords.filter((r) => r.doc === doc).length;
}
