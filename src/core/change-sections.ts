// What one version changed, for its row in History (roadmap Batch 4, item 2):
// the sections it touched, named by their headings, and its change line, the
// same line an agent's change gets (see change-summary.ts). A section is what
// the outline lists (sectionsOf in sections.ts: a heading of level 1 to 3 with
// words, and what follows it up to the next one), so History, the outline and
// the status bar always name the same section for the same place. Changes are
// measured in the words as the page shows them, as comments and agents'
// changes are. Plain logic, no app or window code.
import type { Node } from "prosemirror-model";
import { parseMarkdown } from "./markdown";
import { anchorIn, offsetAt, textIndex } from "./anchors";
import { sectionsOf } from "./sections";
import { diffText, forReading, type Piece } from "./diff";
import { sharedEnds, type ChangeSpan } from "./change-links";
import { summarizeChanges, type ChangeSummary } from "./change-summary";

/** What a change before the first heading is said to be in. */
export const START = "Start of the document";

/** A row names at most this many sections (about two lines of them in the panel), and says how many more. */
export const SECTIONS_KEPT = 6;

export interface SectionHeading {
  /** The heading's words, on one line. */
  name: string;
  /** Where its words start in the document's words (see textIndex). */
  at: number;
}

/** A text read for this: its words as the page shows them, and its section headings in order. */
export interface ReadText {
  words: string;
  headings: SectionHeading[];
}

/** What a version changed: the sections, in the order they come (the first SECTIONS_KEPT), how many more it changed, and the change line. */
export interface VersionStory {
  sections: string[];
  moreSections?: number;
  change: ChangeSummary;
}

/** The section headings of a parsed document, as the outline lists them, with where their words start. */
export function sectionHeadings(doc: Node, index = textIndex(doc)): SectionHeading[] {
  return sectionsOf(doc).map((s) => ({ name: s.text, at: offsetAt(index, s.from + 1) }));
}

/** Read a Markdown text for this. */
export function readText(markdown: string): ReadText {
  const { doc } = parseMarkdown(markdown);
  const index = textIndex(doc);
  return { words: index.text, headings: sectionHeadings(doc, index) };
}

/** The section a place in the words is in: the last heading at or before it. */
function sectionAt(headings: SectionHeading[], at: number): string | null {
  if (!headings.length) return null;
  let found: string | null = null;
  for (const h of headings) {
    if (h.at > at) break;
    found = h.name;
  }
  return found ?? START;
}

/** The sections a stretch of the words touches: the one it starts in, and any whose heading is inside it. */
function touched(headings: SectionHeading[], start: number, end: number, from: boolean): string[] {
  const out: string[] = [];
  const first = from ? sectionAt(headings, start) : null;
  if (first) out.push(first);
  for (const h of headings) if (h.at > start && h.at < end) out.push(h.name);
  return out;
}

/** A stretch without the spaces and line breaks at its edges (or as it is, if that's all it holds). */
function trimmed(text: string, start: number, end: number): { start: number; end: number } {
  let s = start;
  let e = end;
  while (s < e && /\s/.test(text[s])) s++;
  while (e > s && /\s/.test(text[e - 1])) e--;
  return s < e ? { start: s, end: e } : { start, end };
}

const hasWords = (s: string) => /\S/.test(s);

/** A character that is neither part of a word nor a space: a full stop, a comma, a bracket. */
const PUNCTUATION = /[^\p{L}\p{N}\s]/u;

/**
 * Words only put in, or only taken out, between two unchanged stretches can
 * often be placed more than one way: ". Ana will bring the slides" before a
 * full stop is the same change as " Ana will bring the slides." after it.
 * Moved on past the punctuation it starts with (and the unchanged text after
 * it starts with too), such a change starts where its words do (Batch 6).
 */
function startAtWords(steps: Piece[]): Piece[] {
  const out = steps.map((p) => ({ ...p }));
  for (let i = 0; i < out.length; i++) {
    const change = out[i];
    const next = out[i + 1];
    if (change.type === "same" || next?.type !== "same" || (i > 0 && out[i - 1].type !== "same")) continue;
    let k = 0;
    while (k < change.text.length && k < next.text.length && change.text[k] === next.text[k] && PUNCTUATION.test(change.text[k])) k++;
    if (!k || k === change.text.length) continue;
    const moved = next.text.slice(0, k);
    if (i === 0) {
      out.unshift({ type: "same", text: "" });
      i++;
    }
    out[i - 1].text += moved;
    change.text = change.text.slice(k) + moved;
    next.text = next.text.slice(k);
  }
  return out;
}

/**
 * What changed from one text to the next: the sections touched, where words
 * came in (in the newer text) or, where words only went, where they were (in
 * the older one), with any section whose heading went with them; and the
 * change line, made from the same passages an agent's change is.
 */
export function whatChanged(before: ReadText, after: ReadText): VersionStory {
  const a = before.words;
  const b = after.words;
  const sections: string[] = [];
  const named = new Set<string>();
  const add = (names: string[]) => {
    for (const name of names) {
      if (named.has(name)) continue;
      named.add(name);
      if (sections.length < SECTIONS_KEPT) sections.push(name);
    }
  };
  const spans: ChangeSpan[] = [];
  if (a !== b) {
    const { head, tail } = sharedEnds(a, b);
    const steps = startAtWords(forReading(diffText(a.slice(head, a.length - tail), b.slice(head, b.length - tail)), true));
    let ai = head;
    let bi = head;
    let current: { aStart: number; aEnd: number; bStart: number; bEnd: number } | null = null;
    const close = () => {
      if (!current) return;
      const { aStart, aEnd, bStart, bEnd } = current;
      current = null;
      const removed = a.slice(aStart, aEnd);
      const added = b.slice(bStart, bEnd);
      if (!hasWords(removed) && !hasWords(added)) return;
      if (hasWords(added)) {
        const t = trimmed(b, bStart, bEnd);
        add(touched(after.headings, t.start, t.end, true));
        if (hasWords(removed)) add(touched(before.headings, aStart, aEnd, false)); // headings that went with the words
      } else {
        const t = trimmed(a, aStart, aEnd);
        add(touched(before.headings, t.start, t.end, true));
      }
      // As an agent's change is kept (change-links.ts): spaces at the edges of new words aren't part of it.
      const lead = added.length - added.trimStart().length;
      const trail = added.length - added.trimEnd().length;
      const edge = lead + trail < added.length ? { start: bStart + lead, end: bEnd - trail } : { start: bStart, end: bEnd };
      spans.push({ anchor: anchorIn(b, edge.start, edge.end), removed });
    };
    for (const step of steps) {
      if (step.type === "same") {
        close();
        ai += step.text.length;
        bi += step.text.length;
        continue;
      }
      current ??= { aStart: ai, aEnd: ai, bStart: bi, bEnd: bi };
      if (step.type === "added") {
        bi += step.text.length;
        current.bEnd = bi;
      } else {
        ai += step.text.length;
        current.aEnd = ai;
      }
    }
    close();
  }
  const more = named.size - sections.length;
  return { sections, ...(more ? { moreSections: more } : {}), change: summarizeChanges(spans) };
}

/** What changed from one Markdown text to the next (see whatChanged). */
export function storyOf(before: string, after: string): VersionStory {
  return whatChanged(readText(before), readText(after));
}
