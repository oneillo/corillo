// The outline (roadmap Batch 4, item 1): a document's headings to three
// levels, as the outline pane and History list them, and which section a
// place in the text is in. A section runs from its heading to
// the next heading listed, so a fourth-level heading is inside its section.
// Headings are read from the document as Corillo reads it (parseMarkdown, or
// the page's own document), never by a pattern on the text, so a # in code or
// front matter is never one. Plain logic, no window code.
import type { Node } from "prosemirror-model";
import { textIndex, type TextIndex } from "./anchors";
import { diffDocs } from "./doc-diff";
import { extentOf, freshWords, marksSince, positionsOf, rebase } from "./since-hand-over";
import type { SinceHandOver } from "./versions";

/** Headings to this level are listed; deeper ones are inside their section. */
export const OUTLINE_LEVELS = 3;

export interface Section {
  /** 1 to 3. */
  level: number;
  /** The heading's words as shown, spaces tidied. */
  text: string;
  /**
   * Tells the heading apart from the document's others as they are now: its
   * words, and for a second or later heading with the same words, which one
   * it is ("Notes", "Notes\n2"). For the dots and drawing; never kept.
   */
  key: string;
  /** Where the heading starts in the document, and where its section ends: the next heading listed, or the document's end. */
  from: number;
  to: number;
}

/** A heading's words as shown, its spaces tidied. */
const headingText = (heading: Node) => heading.textContent.replace(/\s+/g, " ").trim();

/** The document's headings to three levels, top-level ones only, in order; empty headings aren't listed. */
export function sectionsOf(doc: Node): Section[] {
  const out: Section[] = [];
  const seen = new Map<string, number>();
  doc.forEach((node, offset) => {
    if (node.type.name !== "heading") return;
    const level = node.attrs.level as number;
    if (level > OUTLINE_LEVELS) return;
    const text = headingText(node);
    if (!text) return;
    const n = (seen.get(text) ?? 0) + 1;
    seen.set(text, n);
    const last = out[out.length - 1];
    if (last) last.to = offset;
    out.push({ level, text, key: n === 1 ? text : `${text}\n${n}`, from: offset, to: doc.content.size });
  });
  return out;
}

/** The section a place is in, by its index in `sections`; -1 before the first heading. */
export function sectionAt(sections: readonly Section[], pos: number): number {
  let lo = 0;
  let hi = sections.length;
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    if (sections[mid].from <= pos) lo = mid + 1;
    else hi = mid;
  }
  return lo - 1;
}

/** How many of these places are in each section. */
export function countIn(sections: readonly Section[], places: readonly number[]): number[] {
  const counts = sections.map(() => 0);
  for (const pos of places) {
    const i = sectionAt(sections, pos);
    if (i >= 0) counts[i]++;
  }
  return counts;
}

/**
 * The sections these stretches of the text are in, by index. A stretch with
 * nothing in it (words taken out) right at a heading is in the section before
 * it: what went was at the end of that one.
 */
export function sectionsTouched(sections: readonly Section[], stretches: readonly { start: number; end: number }[]): Set<number> {
  const out = new Set<number>();
  for (const { start, end } of stretches) {
    if (end <= start) {
      const at = sectionAt(sections, start - 1);
      if (at >= 0) out.add(at);
      continue;
    }
    const last = sectionAt(sections, end - 1);
    for (let i = Math.max(sectionAt(sections, start), 0); i <= last; i++) out.add(i);
  }
  return out;
}

/**
 * The sections others changed since the person handed the document over, by
 * key: the places Show changes marks (since-hand-over.ts), worked out the
 * same way from the same facts, so the outline's dots and Show changes always
 * agree. The person's own edits since don't count. `parse` reads a text as
 * Corillo does.
 */
export function changedSince(facts: SinceHandOver, parse: (markdown: string) => { doc: Node }): Set<string> {
  const out = new Set<string>();
  if (!facts.at || facts.base === null || (!facts.agents.length && !facts.outside)) return out;
  const doc = parse(facts.text).doc;
  let words: TextIndex | null = null;
  const wordsIn = (markdown: string) => (markdown === facts.text ? (words ??= textIndex(doc)).text : textIndex(parse(markdown).doc).text);
  const { before, yours } = rebase(facts.base, facts.steps, wordsIn);
  if (before === facts.text) return out;
  const was = parse(before).doc;
  const changes = diffDocs(was, doc);
  if (!changes.length) return out;
  const index = (words ??= textIndex(doc));
  const marks = marksSince(doc, changes, positionsOf(index, yours, doc.content.size), () => freshWords(index, textIndex(was).text));
  const sections = sectionsOf(doc);
  for (const i of sectionsTouched(sections, marks.changes.map(extentOf))) out.add(sections[i].key);
  return out;
}
