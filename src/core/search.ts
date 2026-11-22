// Finding text, for Find and Replace. Works on the formatted document (where
// a match stays inside one paragraph, heading or table cell, and pictures and
// footnote markers never match) and on plain text (the Markdown view).
import type { Node } from "prosemirror-model";
import { PICTURE_STAND_IN } from "./doc-diff";

export interface Match {
  from: number;
  to: number;
}

// Characters with a special meaning in a pattern, escaped so they're found as typed.
const SPECIAL = /[\^$\\.*+?()[\]{}|/]/g;

/**
 * The pattern for what the person typed. As in Word, straight and curly
 * quotes find each other, so "don't" finds "don’t".
 */
export function searchPattern(query: string, matchCase: boolean): RegExp | null {
  if (!query) return null;
  const source = [...query]
    .map((ch) => {
      if (ch === "'" || ch === "‘" || ch === "’") return "['‘’]";
      if (ch === '"' || ch === "“" || ch === "”") return '["“”]';
      return ch.replace(SPECIAL, "\\$&");
    })
    .join("");
  return new RegExp(source, matchCase ? "gu" : "giu");
}

function collect(text: string, re: RegExp, offset: number, out: Match[]): void {
  re.lastIndex = 0;
  for (let m: RegExpExecArray | null; (m = re.exec(text)); ) {
    if (m[0].length === 0) {
      re.lastIndex++;
      continue;
    }
    out.push({ from: offset + m.index, to: offset + m.index + m[0].length });
  }
}

/** Every match in plain text, in order. */
export function findInText(text: string, query: string, matchCase: boolean): Match[] {
  const re = searchPattern(query, matchCase);
  const out: Match[] = [];
  if (re) collect(text, re, 0, out);
  return out;
}

/** Every match in the document, in order, as document positions. */
export function findInDoc(doc: Node, query: string, matchCase: boolean): Match[] {
  const re = searchPattern(query, matchCase);
  const out: Match[] = [];
  if (!re) return out;
  doc.descendants((node, pos) => {
    if (!node.isTextblock) return true;
    let text = "";
    node.forEach((child) => {
      // A picture or footnote marker takes its place, so positions line up and it never matches.
      text += child.isText ? child.text! : PICTURE_STAND_IN.repeat(child.nodeSize);
    });
    collect(text, re, pos + 1, out);
    return false;
  });
  return out;
}

/**
 * Which match comes next from a selection, wrapping round at the end. With
 * a selection (often the current match), the next match starts after its
 * start; with just a cursor, a match right at the cursor counts.
 */
export function nextMatch(matches: Match[], from: number, to: number, direction: 1 | -1): number {
  if (!matches.length) return -1;
  if (direction === 1) {
    const i = matches.findIndex((m) => (from === to ? m.from >= from : m.from > from));
    return i < 0 ? 0 : i;
  }
  for (let i = matches.length - 1; i >= 0; i--) if (matches[i].from < from) return i;
  return matches.length - 1;
}

/** The first match at or after a position, wrapping round to the first. */
export function matchFrom(matches: Match[], pos: number): number {
  if (!matches.length) return -1;
  const i = matches.findIndex((m) => m.from >= pos);
  return i < 0 ? 0 : i;
}

/** What the find bar says: "3 of 12", "12 matches", or "No matches". */
export function countLabel(total: number, current: number): string {
  if (total === 0) return "No matches";
  if (current < 0) return `${total.toLocaleString()} ${total === 1 ? "match" : "matches"}`;
  return `${(current + 1).toLocaleString()} of ${total.toLocaleString()}`;
}

// Find goes on into the comments (roadmap Batch 4, item 2): their matches
// come after the text's, in the order the panel lists the cards.

/**
 * The count with the matches in the comments: "3 of 12 · 2 in comments", on a
 * comment's match "12 in the text · 1 of 2 in comments", and with none in the
 * text "No matches in the text · 1 in comments". As countLabel with none in
 * the comments.
 */
export function countWithComments(total: number, current: number, inComments: number, currentInComments: number): string {
  if (!inComments) return countLabel(total, current);
  const comments =
    currentInComments >= 0 ? `${(currentInComments + 1).toLocaleString()} of ${inComments.toLocaleString()} in comments` : `${inComments.toLocaleString()} in comments`;
  const text = !total ? "No matches in the text" : currentInComments >= 0 ? `${total.toLocaleString()} in the text` : countLabel(total, current);
  return `${text} · ${comments}`;
}

/**
 * The next match or the one before, going through the text's matches and
 * then the comments' (`inComments` of them), round to the text. `selection`
 * is where the text's selection is; `onComment`, the comment's match Find is
 * on, or -1 when it's in the text. Null with no match anywhere.
 */
export function stepThrough(
  matches: Match[],
  inComments: number,
  selection: Match,
  direction: 1 | -1,
  onComment: number,
): { text: number } | { comment: number } | null {
  const total = matches.length;
  if (!total && !inComments) return null;
  if (!total) {
    const k = onComment < 0 ? (direction === 1 ? 0 : inComments - 1) : (onComment + direction + inComments) % inComments;
    return { comment: k };
  }
  if (onComment >= 0 && inComments) {
    const k = onComment + direction;
    if (k >= inComments) return { text: 0 };
    if (k < 0) return { text: total - 1 };
    return { comment: k };
  }
  const { from, to } = selection;
  const ahead = direction === 1 ? matches.some((m) => (from === to ? m.from >= from : m.from > from)) : matches.some((m) => m.from < from);
  if (!ahead && inComments) return { comment: direction === 1 ? 0 : inComments - 1 };
  return { text: nextMatch(matches, from, to, direction) };
}
