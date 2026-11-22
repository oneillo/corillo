// What Read Aloud reads (roadmap Batch 14, item 4): the words as the page
// shows them, sentence by sentence. It reads what an email gets from Copy for
// Email (forEmail in clipboard-text.ts: comments of both kinds and link
// definitions left out, a note link read as its words), so the two can't
// drift apart; then, as the page shows it, a link is its words, a picture its
// description, and Markdown's marks aren't words at all. Blocks shown as
// written (code, diagrams, the document details, Markdown Corillo keeps as
// typed) aren't sentences and are passed over.
//
// Each sentence keeps where each of its letters is on the page, so the
// sentence being read, and the word where the voice says which, can be marked
// there.
import type { Node } from "prosemirror-model";
import { forEmail } from "./clipboard-text";
import { calloutMarkerLength, findObsidian } from "./obsidian";
import { schema } from "./schema";
import { PICTURE_STAND_IN } from "./doc-diff";

export interface Sentence {
  /** What is said. */
  text: string;
  /** Where it starts and ends on the page. */
  from: number;
  to: number;
  /** Where each of its letters is on the page, and (last) where it ends: text.length + 1 places. */
  places: number[];
}

/** Read from the sentence the cursor is in, or only the words selected. */
export type ReadFrom = { cursor: number } | { from: number; to: number };

const WORDS = /[\p{L}\p{N}]/u;
const SPACE = /\s/;

let segmenter: Intl.Segmenter | null = null;
const sentencesOf = (text: string) => (segmenter ??= new Intl.Segmenter(undefined, { granularity: "sentence" })).segment(text);

/**
 * Whether there's anything to read, worked out cheaply for greying Read Aloud
 * out (B14-10): a block of words (not code, a diagram or one shown as
 * written) with a letter or number in it, among the words selected if
 * `range` is given. It stops at the first.
 */
export function hasSpokenWords(doc: Node, range?: { from: number; to: number }): boolean {
  let found = false;
  doc.descendants((node, pos) => {
    if (found || node.type === schema.nodes.raw_block || node.type.spec.code) return false;
    if (range && (pos + node.nodeSize <= range.from || pos >= range.to)) return false;
    if (!node.isTextblock) return true;
    // Obsidian's comments ("%%a note%%") aren't read, so their words don't count (only looked for where a "%%" is).
    const unread = node.textContent.includes("%%") ? commentsIn(node) : null;
    node.forEach((child, offset) => {
      if (found) return;
      const p = pos + 1 + offset;
      let text = child.isText ? child.text! : child.type === schema.nodes.image ? String(child.attrs.alt ?? "") : "";
      if (unread && child.isText) text = text.split("").map((c, i) => (unread.some((f) => f.from <= offset + i && offset + i < f.to) ? " " : c)).join("");
      else if (unread?.some((f) => f.from <= offset && offset < f.to)) text = "";
      if (range && child.isText) text = text.slice(Math.max(0, range.from - p), Math.max(0, range.to - p));
      else if (range && (p < range.from || p >= range.to)) text = "";
      if (WORDS.test(text)) found = true;
    });
    return false;
  });
  return found;
}

/** Obsidian's comments in a block, by place in it, found as the page finds them (not in code, a picture or a note's number). */
function commentsIn(block: Node): { from: number; to: number }[] {
  let scan = "";
  block.forEach((child) => {
    if (child.isText) scan += child.marks.some((m) => m.type === schema.marks.code) ? PICTURE_STAND_IN.repeat(child.text!.length) : child.text!;
    else scan += child.type === schema.nodes.hard_break ? "\n" : PICTURE_STAND_IN.repeat(child.nodeSize);
  });
  return findObsidian(scan).filter((f) => f.kind === "comment");
}

/**
 * The sentences to read, in order, and which to start with. With a cursor:
 * every sentence, starting at the one it's in (or the next, just after one;
 * the first, after the last words). With words selected: only those words.
 */
export function spokenSentences(doc: Node, from?: ReadFrom): { sentences: Sentence[]; start: number } {
  const shown = forEmail(doc);
  const back = shown.mapping?.invert();
  const onPage = (pos: number, side: 1 | -1) => (back ? back.map(pos, side) : pos);
  const range = from && "from" in from ? { from: shown.mapping?.map(from.from, 1) ?? from.from, to: shown.mapping?.map(from.to, -1) ?? from.to } : null;

  const sentences: Sentence[] = [];
  shown.doc.descendants((node, pos, parent, index) => {
    if (node.type === schema.nodes.raw_block || node.type.spec.code) return false;
    if (!node.isTextblock) return true;
    if (range && (pos + node.nodeSize <= range.from || pos >= range.to)) return false;
    // The block's letters as the page has them, each with its place in what an email gets; and the same text with
    // code and pictures' descriptions hidden, to find Obsidian's marks in, as the page finds them.
    const chars: string[] = [];
    const at: number[] = [];
    let scan = "";
    const put = (char: string, place: number, hidden = false) => {
      chars.push(char);
      at.push(place);
      scan += hidden ? PICTURE_STAND_IN : char;
    };
    node.forEach((child, offset) => {
      const p = pos + 1 + offset;
      if (child.isText) {
        const code = child.marks.some((m) => m.type === schema.marks.code);
        for (let i = 0; i < child.text!.length; i++) put(child.text![i], p + i, code);
      } else if (child.type === schema.nodes.image) {
        const alt = String(child.attrs.alt ?? "").trim();
        if (alt) {
          put(" ", p, true);
          for (let i = 0; i < alt.length; i++) put(alt[i], p, true); // a UTF-16 unit at a time, as the text's (B14-06)
          put(" ", p, true);
        }
      } else if (child.type === schema.nodes.hard_break) put("\n", p, true);
      else put(PICTURE_STAND_IN, p, true); // a footnote's number: not read
    });
    // Obsidian's marks, faint on the page, aren't said: a highlight's "==", a tag's "#", a callout's "[!note]".
    const skip = new Set<number>();
    const drop = (from: number, to: number) => {
      for (let i = from; i < to; i++) skip.add(i);
    };
    if (parent?.type === schema.nodes.blockquote && index === 0) drop(0, calloutMarkerLength(scan));
    for (const f of findObsidian(scan)) {
      if (f.kind === "highlight") {
        drop(f.from, f.from + 2);
        drop(f.to - 2, f.to);
      } else if (f.kind === "tag") drop(f.from, f.from + 1);
    }
    // The words to say, a run of spaces as one; a line broken on the page ends a sentence (a callout's title,
    // "Best," over a name), so it is kept apart.
    let text = "";
    const places: number[] = [];
    chars.forEach((char, i) => {
      if (skip.has(i) || char === PICTURE_STAND_IN || (range && (at[i] < range.from || at[i] >= range.to))) return;
      const kind = char === "\n" ? "\n" : SPACE.test(char) ? " " : char;
      if (kind === " " && (text === "" || text.endsWith(" ") || text.endsWith("\n"))) return;
      if (kind === "\n" && text.endsWith(" ")) {
        text = text.slice(0, -1);
        places.pop();
      }
      text += kind;
      places.push(at[i]);
    });
    const parts: { index: number; segment: string }[] = [];
    let line = 0;
    for (const words of text.split("\n")) {
      for (const part of sentencesOf(words)) parts.push({ index: line + part.index, segment: part.segment });
      line += words.length + 1;
    }
    for (const part of parts) {
      let a = part.index;
      let b = part.index + part.segment.length;
      while (a < b && text[a] === " ") a++;
      while (b > a && text[b - 1] === " ") b--;
      const said = text.slice(a, b);
      if (!WORDS.test(said)) continue;
      const letters = places.slice(a, b).map((p) => onPage(p, 1));
      for (let i = 1; i < letters.length; i++) letters[i] = Math.max(letters[i], letters[i - 1]);
      // Just after its last letter (a picture's description ends after the picture).
      const stop = Math.max(onPage(places[b - 1] + 1, -1), letters[letters.length - 1]);
      sentences.push({ text: said, from: letters[0], to: stop, places: [...letters, stop] });
    }
    return false;
  });

  let start = 0;
  if (from && "cursor" in from) {
    const i = sentences.findIndex((s) => s.to > from.cursor);
    start = i < 0 ? 0 : i;
  }
  return { sentences, start };
}
