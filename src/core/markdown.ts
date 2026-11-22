// Reading and writing Markdown without disturbing what the person (or agent)
// wrote. The rule: a block nobody edited is written back exactly as it was,
// byte for byte. Only blocks that changed are re-written from the editor's
// model. Anything the editor can't show richly yet becomes a raw block that is
// kept verbatim.
import { type Attrs, type Node } from "prosemirror-model";
import { frontMatterEnd as frontMatterEndOf, NOT_YET } from "./front-matter";
import { md, type MarkdownToken as Token } from "./markdown-tokens";
import { BLANK, TASK_ITEM, isEmptyLine, type Source } from "./markdown-read";
import { definitionsOf, joinsList, labelsUsed, listGap, serializeBlock, type Defined } from "./markdown-blocks";
import { LINE_BREAK, keepsApart, readsApart } from "./markdown-apart";

export { lineBreakLines, markdownTokens, type MarkdownToken } from "./markdown-tokens";
export { isEmptyLine, parseMarkdown, type Eol, type Loaded, type Source } from "./markdown-read";

/**
 * Write the document back as Markdown. Blocks that are unchanged since the
 * file was read keep their exact original text; so does the spacing between
 * neighbouring original blocks. Pass `spans` to learn where each top-level
 * block's text is in the result (to keep the person's place when the view
 * changes).
 */
export function serializeMarkdown(doc: Node, source: Source, spans?: { from: number; to: number }[]): string {
  const layout = markdownLayout(doc, source);
  let out = (source.bom ? "\uFEFF" : "") + layout.prefix;
  for (const block of layout.blocks) {
    if (block) out += block.gap;
    spans?.push({ from: out.length, to: out.length + (block?.text.length ?? 0) });
    if (block) out += block.text;
  }
  return out + layout.trailing;
}

/**
 * How the document is written to the file: what comes before the first block,
 * then for each top-level block the spacing written before it and its text
 * (null when nothing is written for it: an empty line after the last block
 * with words, or before front matter, which must stay on the first line),
 * then what comes after the last. The file is these pieces joined, after any
 * byte-order mark; line numbers count them. An empty line's text is the
 * spaces the file had on that line ("" for a new one); the spacing around it
 * makes it a blank line.
 */
export interface Layout {
  prefix: string;
  blocks: ({ gap: string; text: string } | null)[];
  trailing: string;
}

// Looking up a document's original blocks, by node and by content. Made once
// for each file read, since its blocks never change.
interface OriginalBlocks {
  byNode: Map<Node, number>;
  byKey: Map<string, number[]> | null;
}
const lookups = new WeakMap<Source, OriginalBlocks>();
const keyOf = (node: Node) => `${node.type.name}\u0000${node.textContent}`;

function lookupFor(source: Source): OriginalBlocks {
  let found = lookups.get(source);
  if (!found) {
    const byNode = new Map<Node, number>();
    source.blocks.forEach((b, i) => byNode.set(b.node, i));
    found = { byNode, byKey: null };
    lookups.set(source, found);
  }
  return found;
}

function originalsByKey(source: Source, lookup: OriginalBlocks): Map<string, number[]> {
  if (!lookup.byKey) {
    const byKey = new Map<string, number[]>();
    source.blocks.forEach((b, i) => {
      const key = keyOf(b.node);
      const list = byKey.get(key);
      if (list) list.push(i);
      else byKey.set(key, [i]);
    });
    lookup.byKey = byKey;
  }
  return lookup.byKey;
}

// The layout of the document last written (the file, its line numbers and the
// page's spacing all ask for the same one): worked out once for each document.
const layouts = new WeakMap<Node, { source: Source; layout: Layout }>();

/**
 * A fault a test plants in the serializer itself, to stand in for a bug in it
 * that everything writing the page passes through (see write-check.ts's
 * plantInSerializer). Never set outside tests; while it's set, nothing is
 * remembered, so no faulty layout outlives it.
 */
let testFault: ((doc: Node, source: Source, layout: Layout) => Layout) | null = null;
export function setSerializerFault(fault: typeof testFault): void {
  testFault = fault;
}

export function markdownLayout(doc: Node, source: Source): Layout {
  if (testFault) return testFault(doc, source, layOut(doc, source));
  const known = layouts.get(doc);
  if (known?.source === source) return known.layout;
  const layout = layOut(doc, source);
  layouts.set(doc, { source, layout });
  return layout;
}

function layOut(doc: Node, source: Source): Layout {
  const { blocks, eol } = source;
  const defined = definitionsOf(doc);
  const n = doc.childCount;
  const children: Node[] = [];
  for (let k = 0; k < n; k++) children.push(doc.child(k));

  // 1. Which new blocks are the very same as an original one? The most of
  //    them that still come in the file's order; one met out of that order
  //    (dragged up the page, say) keeps its own text all the same.
  const same: (number | null)[] = new Array(n).fill(null);
  let moved: (number | null)[] | null = null;
  const lookup = lookupFor(source);
  const byNode = lookup.byNode;
  let last = -1;
  let rising = true;
  for (let k = 0; k < n; k++) {
    const id = byNode.get(children[k]);
    if (id === undefined) continue;
    if (id > last) {
      same[k] = id;
      last = id;
    } else rising = false;
  }
  if (!rising) {
    const ids: number[] = [];
    const at: number[] = [];
    for (let k = 0; k < n; k++) {
      const id = byNode.get(children[k]);
      if (id === undefined) continue;
      ids.push(id);
      at.push(k);
    }
    same.fill(null);
    moved = new Array(n).fill(null);
    for (const j of longestRising(ids)) same[at[j]] = ids[j];
    for (let j = 0; j < ids.length; j++) if (same[at[j]] === null) moved[at[j]] = ids[j];
  }
  // 2. Unmatched blocks that are equal in content to an unused original
  //    between their matched neighbours (for example after an undo).
  //    Originals are looked up by their text, so this stays quick even when
  //    a long document's blocks were all replaced.
  const used = new Set<number>();
  for (const s of same) if (s !== null) used.add(s);
  for (const m of moved ?? []) if (m !== null) used.add(m);
  const nextVal: number[] = new Array(n);
  for (let k = n - 1, next = blocks.length; k >= 0; k--) {
    nextVal[k] = next;
    if (same[k] !== null) next = same[k] as number;
  }
  // Originals by key, in order, and how far each key's list has been used up.
  const usedUpTo = new Map<string, number>();
  for (let k = 0, lo = -1; k < n; k++) {
    if (same[k] === null) {
      const key = keyOf(children[k]);
      const list = originalsByKey(source, lookup).get(key);
      if (list) {
        let from = usedUpTo.get(key) ?? 0;
        while (from < list.length && (list[from] <= lo || used.has(list[from]))) from++;
        usedUpTo.set(key, from);
        for (let q = from; q < list.length && list[q] < nextVal[k]; q++) {
          const i = list[q];
          if (!used.has(i) && blocks[i].node.eq(children[k])) {
            same[k] = i;
            used.add(i);
            break;
          }
        }
      }
    }
    if (same[k] !== null) lo = same[k] as number;
  }
  // 3. Blocks edited in place: between two matched anchors, if as many new
  //    blocks as original ones remain, pair them up so the spacing around
  //    them is kept.
  const pos: (number | null)[] = [...same];
  for (let k = 0; k < n; ) {
    if (same[k] !== null) {
      k++;
      continue;
    }
    let end = k;
    while (end < n && same[end] === null) end++;
    const lo = prevMatched(same, k);
    const hi = nextMatched(same, end - 1, blocks.length);
    if (end - k === hi - lo - 1) for (let x = 0; x < end - k; x++) pos[k + x] = lo + 1 + x;
    k = end;
  }

  // Empty lines after the last block with words aren't written, so a document
  // doesn't grow blank lines at its end while the cursor rests below it; nor
  // are any before front matter, which must start the file.
  // (An original block is an empty line if the file has a blank line there:
  // a paragraph of "&#32;" holds a space, but is written as words.)
  const empty = children.map((child, k) => (same[k] !== null ? BLANK.test(blocks[same[k] as number].text) : isEmptyLine(child)));
  let lastWords = n - 1;
  while (lastWords >= 0 && empty[lastWords]) lastWords--;
  let firstWords = 0;
  while (firstWords < n && empty[firstWords]) firstWords++;
  const frontMatterFirst = firstWords < n && children[firstWords].type.name === "raw_block" && children[firstWords].attrs.kind === "front-matter";

  const laid: Layout["blocks"] = [];
  let wrote = 0;
  let prevPos: number | null = null;
  let prevK = -1;
  let prevText = "";
  // The last block with words as it was written (a list's bullets may differ from its node's), and whether empty lines came after it.
  let lastBlock: Node | null = null;
  let lastNode: Node | null = null;
  let emptySince = false;
  // That block's text as written, and what's written after it since: the empty lines and the spacing around them.
  let lastText = "";
  let since = "";
  // Where that block is in the layout.
  let lastAt = -1;
  // Whether the blocks since the last one with words, it included, are the file's own, as it had them.
  let filed = false;
  for (let k = 0; k < n; k++) {
    if (empty[k] && (k > lastWords || (k < firstWords && frontMatterFirst))) {
      laid.push(null);
      continue;
    }
    let node = children[k];
    let text =
      same[k] !== null
        ? blocks[same[k] as number].text
        : empty[k]
          ? ""
          : moved && moved[k] !== null
            ? blocks[moved[k] as number].text
            : ((pos[k] !== null ? typedIn(node, blocks[pos[k] as number], eol, defined) : null) ?? serializeBlock(node, eol, defined));
    // A link or picture by label, kept as the file wrote it, whose label the document no longer
    // gives an address: written afresh, with its address.
    if (!empty[k] && labelsUsed(node).some((label) => !defined(label))) text = serializeBlock(node, eol, defined);
    // Two lists of the same kind with an empty line between them would be one
    // list to Markdown (blank lines don't end a list): the second is written
    // with the other bullet or numbering ("*" for "-", "1)" for "1."), which
    // keeps it a list of its own, as Markdown has two kinds of each for this.
    // (So is a list after one written that way, if the two were apart. Not
    // when the file had them so, unedited: Markdown read them as two lists
    // there, a list whose only item is empty ending at the blank lines.)
    const follows = same[k] !== null && prevK >= 0 && same[prevK] !== null && same[k] === (same[prevK] as number) + 1;
    if (lastBlock && joinsList(lastBlock, node) && (emptySince || !joinsList(lastNode, node)) && !(filed && follows)) {
      node = otherMarker(node, lastBlock);
      text = serializeBlock(node, eol, defined);
    }
    let gap = "";
    if (wrote > 0) {
      const p = pos[k];
      const kept = prevPos !== null && p !== null && p === prevPos + 1 ? source.gaps[prevPos] : null;
      const breaks = kept === null ? 0 : (kept.match(LINE_BREAK)?.length ?? 0);
      if (empty[prevK]) {
        // After an empty line, the next line is the next block (or empty line).
        gap = kept !== null && breaks === 1 ? kept : eol;
      } else if (empty[k]) {
        // An empty line after a block with words: the blank line between them, then the empty line.
        gap = kept !== null && breaks === 2 ? kept : eol + eol;
      } else {
        // (The line after an empty line was just the next line: once words are
        // typed on the empty line, Markdown needs a blank line under them.)
        const afterEmpty = prevPos !== null && BLANK.test(blocks[prevPos].text);
        gap = kept !== null && breaks <= 2 && !afterEmpty ? kept : eol + eol;
        // The file's spacing, kept for a block edited in place, is only kept
        // when the two blocks still read as these two blocks with it.
        if (gap !== eol + eol && (same[k] === null || same[prevK] === null) && !keepsApart(children[prevK], prevText, gap, node, text)) {
          gap = eol + eol;
        }
        // (Lists that were neighbours in the file were kept apart there by their spacing.)
        // A list the file indents would be read inside the other's last item: written afresh, without it.
        if (kept === null && joinsList(lastBlock, node)) {
          gap = listGap(lastBlock!, node, eol);
          if (/^[ \t]/.test(text)) text = serializeBlock(node, eol, defined);
        }
      }
      // A code block written with an indent, kept as the file had it, reads as part of a list or a
      // note above it, blank lines or not: unless the two still read apart, with the empty lines
      // between them, it's written afresh, fenced.
      if (node.type.name === "code_block" && INDENTED.test(text) && lastBlock && UNDER.has(lastBlock.type.name) && !readsApart(lastBlock, lastText, since + gap, node, text)) {
        text = serializeBlock(node, eol, defined);
      }
      // Two blocks that weren't neighbours in the file (one dragged, or what was between them
      // deleted) can read as one even across a blank line, when one of them is as the file wrote
      // it: code whose fence the file never closed takes in what comes after it, and a line the
      // file indents joins a list, a note or indented code above it. Then the one kept as the file
      // had it is written afresh: a closed fence, no indent. (An HTML block or comment the file
      // never closed can't be closed for the person: it stays as it is.)
      if (!empty[k] && lastBlock && !(filed && follows) && (/^[ \t]/.test(text) || openEnded(lastBlock)) && !readsApart(lastBlock, lastText, since + gap, node, text)) {
        const before = serializeBlock(lastBlock, eol, defined);
        const after = serializeBlock(node, eol, defined);
        const tries: [string, string][] = [
          [lastText, after],
          [before, text],
          [before, after],
        ];
        const apart = tries.find(([a, b]) => (a !== lastText || b !== text) && readsApart(lastBlock!, a, since + gap, node, b));
        if (apart) {
          if (apart[0] !== lastText) laid[lastAt] = { gap: laid[lastAt]!.gap, text: apart[0] };
          text = apart[1];
        }
      }
    }
    laid.push({ gap, text });
    prevPos = pos[k];
    prevK = k;
    prevText = text;
    wrote++;
    if (empty[k]) {
      emptySince = true;
      filed &&= follows;
      since += gap + text;
    } else {
      filed = same[k] !== null && node === children[k];
      lastText = text;
      lastAt = laid.length - 1;
      since = "";
      lastBlock = node;
      lastNode = children[k];
      emptySince = false;
    }
  }
  const layout =
    blocks.length === 0
      ? wrote === 0
        ? { prefix: source.original, blocks: laid, trailing: "" }
        : { prefix: "", blocks: laid, trailing: eol }
      : { prefix: source.prefix, blocks: laid, trailing: source.trailing };
  // A "---" rule that now starts the file, once the empty lines above it are
  // taken away, could read as front matter with a rule further down: it's
  // written "***", which is the same rule.
  const first = laid.findIndex((b) => b !== null);
  if (first >= 0 && !layout.prefix && children[first].type.name === "horizontal_rule" && /^---[ \t]*$/.test(laid[first]!.text) && pos[first] !== 0) {
    // (Only as many blocks as it takes to tell: rarely more than the first few.)
    let written = "";
    for (let b = 0, end = NOT_YET; b < laid.length && end === NOT_YET; b++) {
      if (!laid[b]) continue;
      written += laid[b]!.gap + laid[b]!.text;
      end = frontMatterEndOf(written.split(/\r\n|\r|\n/), b === laid.length - 1);
      if (end >= 0) laid[first] = { gap: "", text: "***" };
    }
  }
  // A block that now starts the file with an invisible byte-order mark (a
  // paragraph "\uFEFF> words", pasted from somewhere) would lose it to the
  // reader, which takes a mark there as the file's own, and could then read
  // as a quote, a heading or a list: the file gets a mark of its own first,
  // so the block's is read as its text, as it is further down.
  if (first >= 0 && !source.bom && !layout.prefix && laid[first]!.gap === "" && laid[first]!.text.startsWith("\uFEFF")) layout.prefix = "\uFEFF";
  return layout;
}

// Typing in a list or quote (review R-EL-5) ---------------------------------------------
// A list or quote can have blank lines between some of its parts and not
// others, which a list written afresh can't: it has blank lines between all
// of its items or none. So when only the words of its paragraphs changed,
// just those paragraphs' lines are written again, after the same bullets,
// ">" and indents as before, and every other line stays as the file had it:
// no blank line comes or goes, on the page or in the file.

const CONTAINER_BLOCKS = new Set(["bullet_list", "ordered_list", "blockquote"]);

/** Each paragraph in a block's text, in order: its lines, and what comes before its words on each (bullets, ">", indents, a task's box). */
interface ParagraphLines {
  from: number;
  to: number;
  prefixes: string[];
  /** What comes before a line added to it. */
  more: string;
}
// Kept by the block and the text it's written as: an agent's change shown as
// an edit can keep a block and pair it with a new text (other spacing between
// a list's items), and the places in the old one would be the wrong lines.
const paragraphsIn = new WeakMap<Node, { text: string; found: ParagraphLines[] | null }>();

function paragraphLinesOf(node: Node, text: string): ParagraphLines[] | null {
  const known = paragraphsIn.get(node);
  if (known?.text === text) return known.found;
  const found = findParagraphLines(node, text);
  paragraphsIn.set(node, { text, found });
  return found;
}

function findParagraphLines(node: Node, text: string): ParagraphLines[] | null {
  const boxed: boolean[] = [];
  node.descendants((child, _pos, parent, index) => {
    if (child.type.name === "paragraph") boxed.push(index === 0 && parent?.type.name === "list_item" && parent.attrs.checked != null);
    return !child.isTextblock;
  });
  const tokens: Token[] = [];
  md.block.parse(text.replace(/\r\n?/g, "\n"), md, {}, tokens);
  const lines = text.split(/\r\n|\r|\n/);
  const out: ParagraphLines[] = [];
  for (let i = 1; i < tokens.length; i++) {
    const t = tokens[i];
    // A table straight under a paragraph's words, in a list or quote: written
    // afresh, with the blank line before it that Word and PDF need (Pandoc
    // reads no table there otherwise).
    if (t.type === "table_open" && tokens[i - 1].type === "paragraph_close" && t.map && tokens[i - 3]?.map?.[1] === t.map[0]) return null;
    if (t.type !== "inline" || tokens[i - 1].type !== "paragraph_open" || !t.map) continue;
    const words = t.content.split("\n");
    if (words.length !== t.map[1] - t.map[0]) return null;
    const prefixes: string[] = [];
    for (let l = 0; l < words.length; l++) {
      const line = l === words.length - 1 ? lines[t.map[0] + l].replace(/[ \t]+$/, "") : lines[t.map[0] + l];
      const own = words[l].replace(/^[ \t]+/, "");
      if (!line.endsWith(own)) return null;
      prefixes.push(line.slice(0, line.length - own.length));
    }
    const more = prefixes[0].replace(/[-+*]|\d{1,9}[.)]/g, (m) => " ".repeat(m.length));
    if (boxed[out.length]) {
      const box = TASK_ITEM.exec(t.content);
      if (!box) return null;
      // (A task with no words ends at its box: the words typed go after a space.)
      prefixes[0] += box[2] ? box[0] : `${box[0]} `;
    }
    if (/[^ \t>]/.test(more)) return null;
    out.push({ from: t.map[0], to: t.map[1], prefixes, more });
  }
  return out.length === boxed.length ? out : null;
}

/**
 * A list or quote edited in place whose parts are all as they were, but for
 * the words of some paragraphs: the file's text with just those paragraphs'
 * lines written again. Null when more than words changed.
 */
function typedIn(node: Node, original: { node: Node; text: string }, eol: string, defined: Defined): string | null {
  if (!CONTAINER_BLOCKS.has(node.type.name)) return null;
  const changed: { node: Node; index: number }[] = [];
  let count = 0;
  const alike = (a: Node, b: Node): boolean => {
    if (a === b) {
      if (a.type.name === "paragraph") count++;
      a.descendants((child) => {
        if (child.type.name === "paragraph") count++;
        return !child.isTextblock;
      });
      return true;
    }
    if (!a.sameMarkup(b)) return false;
    if (a.type.name === "paragraph") {
      const index = count++;
      if (a.eq(b)) return true;
      if (isEmptyLine(a)) return false;
      changed.push({ node: a, index });
      return true;
    }
    if (a.isTextblock || a.isLeaf || a.type.name === "table" || a.childCount !== b.childCount) return a.eq(b);
    for (let i = 0; i < a.childCount; i++) if (!alike(a.child(i), b.child(i))) return false;
    return true;
  };
  if (!alike(node, original.node) || !changed.length) return null;
  const places = paragraphLinesOf(original.node, original.text);
  if (!places) return null;
  // Lines and the line breaks between them, as the file has them.
  const pieces = original.text.split(/(\r\n|\r|\n)/);
  for (const { node: paragraph, index } of changed.reverse()) {
    const at = places[index];
    const words = serializeBlock(paragraph, "\n", defined).split("\n");
    if (words.some((l) => BLANK.test(l) || /^[ \t]/.test(l))) return null;
    const lines = words.map((l, j) => (j < at.prefixes.length ? at.prefixes[j] : at.more) + l);
    pieces.splice(2 * at.from, 2 * (at.to - at.from) - 1, lines.join(eol));
  }
  return pieces.join("");
}

/**
 * A list written with the other bullet ("-" and "*") or numbering ("1." and
 * "1)") from the list before it. The same node each time for the same list,
 * so its text, once written, is reused while typing elsewhere (R-EL-13).
 */
const remarked = new WeakMap<Node, Node>();
function otherMarker(list: Node, before: Node): Node {
  const attrs: Attrs =
    list.type.name === "bullet_list"
      ? { ...list.attrs, bullet: before.attrs.bullet === "-" ? "*" : "-" }
      : { ...list.attrs, delim: before.attrs.delim === ")" ? "." : ")" };
  const known = remarked.get(list);
  if (known && known.attrs.bullet === attrs.bullet && known.attrs.delim === attrs.delim) return known;
  const node = list.type.create(attrs, list.content, list.marks);
  remarked.set(list, node);
  return node;
}

// Blocks an indented line under them can be read as part of.
const UNDER = new Set(["bullet_list", "ordered_list", "footnote_def"]);
// Blocks the file may never have closed, which then take in what comes after them (not a table).
const openEnded = (n: Node) => n.type.name === "code_block" || (n.type.name === "raw_block" && n.attrs.kind !== "table");
const INDENTED = /^(?: {4}| {0,3}\t)/;

/** The places of a longest run of the values that only rises (not always side by side), first to last. */
function longestRising(values: readonly number[]): number[] {
  // ends[l]: the place of the lowest value a rising run of l + 1 values can end on.
  const ends: number[] = [];
  const before: number[] = new Array(values.length);
  for (let i = 0; i < values.length; i++) {
    let lo = 0;
    let hi = ends.length;
    while (lo < hi) {
      const mid = (lo + hi) >> 1;
      if (values[ends[mid]] < values[i]) lo = mid + 1;
      else hi = mid;
    }
    before[i] = lo ? ends[lo - 1] : -1;
    ends[lo] = i;
  }
  const out: number[] = [];
  for (let i = ends.length ? ends[ends.length - 1] : -1; i >= 0; i = before[i]) out.push(i);
  return out.reverse();
}

function prevMatched(same: (number | null)[], k: number): number {
  for (let i = k - 1; i >= 0; i--) if (same[i] !== null) return same[i] as number;
  return -1;
}

function nextMatched(same: (number | null)[], k: number, fallback: number): number {
  for (let i = k + 1; i < same.length; i++) if (same[i] !== null) return same[i] as number;
  return fallback;
}
