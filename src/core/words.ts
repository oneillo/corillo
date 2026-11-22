// The word count in the status bar. Counted block by block: a block nobody
// edited is the same object as before and keeps its count, so typing in a
// long document doesn't re-read all of it.
//
// It counts what Word would count in the exported file (decided 2026-11-09
// night): document details, link definitions, hidden comments (%% and
// <!-- -->) and Markdown's own signs don't count; code does. A footnote's
// number or a picture inside a word doesn't split it.
import type { Node } from "prosemirror-model";

const counts = new WeakMap<Node, number>();

// Blocks Word leaves out.
const HIDDEN = new Set(["front-matter", "links", "comment"]);
const COMMENTS = /%%[^\n]*?%%|<!--[\s\S]*?-->/g;

const words = (text: string) => text.match(/\S+/g) ?? [];

const TAGS = /<\/?[A-Za-z][^>]*>/g;
const LABELS = /^[ \t>]*\[\^?[^\]\n]*\]:/gm;
const leafText = (leaf: Node) => (leaf.type.name === "hard_break" ? " " : "");

function countBlock(block: Node): number {
  if (block.type.name === "raw_block") {
    if (HIDDEN.has(block.attrs.kind)) return 0;
    // Shown as Markdown text: only words with a letter or digit in them, after
    // the comments, HTML tags and a note's or definition's label at a line's start.
    const text = block.textContent.replace(COMMENTS, " ").replace(TAGS, " ").replace(LABELS, " ");
    return words(text).filter((w) => /[\p{L}\p{N}]/u.test(w)).length;
  }
  const text = block.textBetween(0, block.content.size, " ", leafText);
  return words(block.type.name === "code_block" ? text : text.replace(COMMENTS, " ")).length;
}

/**
 * Part of a block's words. What's hidden is found in the whole block first, so a
 * selection that cuts into a comment or a tag doesn't count what's left of it:
 * the whole block's text is built with where each character comes from, the
 * hidden parts blanked out, and then only the selected characters are kept.
 */
function countPart(block: Node, from: number, to: number): number {
  if (block.type.name === "raw_block" && HIDDEN.has(block.attrs.kind)) return 0;
  const parts: string[] = [];
  const at: number[] = [];
  let first = true;
  const add = (text: string, pos: number, step: number) => {
    parts.push(text);
    for (let i = 0; i < text.length; i++) at.push(pos + i * step);
  };
  // As textBetween writes it: a space between text blocks, a line break as a space.
  block.descendants((node, pos) => {
    if (node.isText) add(node.text!, pos, 1);
    else if (node.isTextblock) {
      if (!first) add(" ", pos, 0);
      first = false;
    } else if (node.isLeaf && node.isInline) add(leafText(node), pos, 0);
    return true;
  });
  const blank = (s: string) => " ".repeat(s.length);
  let text = parts.join("");
  if (block.type.name === "raw_block") text = text.replace(COMMENTS, blank).replace(TAGS, blank).replace(LABELS, blank);
  else if (block.type.name !== "code_block") text = text.replace(COMMENTS, blank);
  let start = 0;
  while (start < at.length && at[start] < from) start++;
  let end = start;
  while (end < at.length && at[end] < to) end++;
  const found = words(text.slice(start, end));
  return block.type.name === "raw_block" ? found.filter((w) => /[\p{L}\p{N}]/u.test(w)).length : found.length;
}

/** A block's count, kept while the block is unchanged. */
function cached(block: Node): number {
  let count = counts.get(block);
  if (count === undefined) {
    count = countBlock(block);
    counts.set(block, count);
  }
  return count;
}

/** How many words the document has, as Word would count them in the exported file. */
export function wordCount(doc: Node): number {
  let total = 0;
  doc.forEach((block) => (total += cached(block)));
  return total;
}

/** How many words are between two places in the document (a selection), counted the same way. */
export function wordsBetween(doc: Node, from: number, to: number): number {
  let total = 0;
  doc.forEach((block, offset) => {
    const start = offset + 1;
    if (offset + block.nodeSize <= from || offset >= to) return;
    const whole = from <= offset && to >= offset + block.nodeSize;
    total += whole ? cached(block) : countPart(block, Math.max(0, from - start), Math.min(block.content.size, Math.max(0, to - start)));
  });
  return total;
}
