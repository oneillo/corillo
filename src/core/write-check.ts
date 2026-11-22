// The safety net (roadmap Batch 14, item 1): nothing Corillo writes may lose
// words the page holds.
//
// In the window, before a save: every block that isn't kept byte for byte
// from the file (an edited block, as serializeMarkdown lays it out) is read
// back with parseMarkdown and must come back as the block the page holds: its
// kind, the attributes that change what it shows, its words and formatting.
// Kept blocks are the file's own text for the very same block, so their words
// are there by construction, and every other block is read back, so the text
// holds every word on the page. A block that reads back differently is
// written the careful way and read back again; only a careful version that
// reads back exactly is written. Otherwise the save is refused.
//
// For an agent's edit (a find and replace on the file's text, in the main
// process), spliceLoss checks that the text outside what it found is as it
// was. The bytes themselves are read back in files.ts's writeDocument.
import { Fragment, type Mark, type Node } from "prosemirror-model";
import { isEmptyLine, markdownLayout, parseMarkdown, serializeMarkdown, setSerializerFault, type Eol, type Layout, type Source } from "./markdown";
import { schema } from "./schema";

/**
 * A serializer fault a test plants, to see the net catch it. Never set
 * outside tests. "drop-word": the first edited block loses its last word;
 * "other-kind": it's written so it reads back as a heading; "drop-word-always":
 * the careful way loses it too, so nothing can be repaired; "lose-block": a
 * kept block with words isn't written at all.
 */
export type PlantedFault = "drop-word" | "other-kind" | "drop-word-always" | "lose-block";

export type SaveCheck =
  /** The text to write; repaired: how many blocks were written the careful way. */
  | { ok: true; text: string; repaired: number }
  /**
   * Refused. lost: words on the page the text would have lost (may be empty
   * when only a block's kind or formatting would change). keep: a text for
   * the edits kept for recovery, holding every word on the page (a block that
   * couldn't be written keeps its words as plain paragraphs).
   */
  | { ok: false; lost: string[]; keep: string };

// Kept blocks ----------------------------------------------------------------------

interface Lookup {
  byNode: Map<Node, number>;
  byText: Map<string, number[]> | null;
}
const lookups = new WeakMap<Source, Lookup>();

function lookupOf(source: Source): Lookup {
  let lookup = lookups.get(source);
  if (!lookup) {
    lookup = { byNode: new Map(source.blocks.map((b, i) => [b.node, i])), byText: null };
    lookups.set(source, lookup);
  }
  return lookup;
}

/** Whether this is the file's own text for this very block (or one equal to it), kept byte for byte. */
function isKept(source: Source, node: Node, text: string): boolean {
  const lookup = lookupOf(source);
  const i = lookup.byNode.get(node);
  if (i !== undefined && source.blocks[i].text === text) return true;
  if (!lookup.byText) {
    lookup.byText = new Map();
    source.blocks.forEach((b, j) => {
      const list = lookup!.byText!.get(b.text);
      if (list) list.push(j);
      else lookup!.byText!.set(b.text, [j]);
    });
  }
  return (lookup.byText.get(text) ?? []).some((j) => source.blocks[j].node.eq(node));
}

// What a block says ------------------------------------------------------------------

const SPACE = /\s/u;
const EDGE_MARK = "\u0000";

function marksOf(marks: readonly Mark[]): string {
  if (!marks.length) return "";
  return `{${marks
    .map((m) => (m.type.name === "link" ? `link(${m.attrs.href})` : m.type.name))
    .sort()
    .join("+")}}`;
}

function attrsOf(n: Node): string {
  switch (n.type.name) {
    case "heading":
      return String(n.attrs.level);
    case "ordered_list":
      return String(n.attrs.order ?? 1);
    case "list_item":
      return String(n.attrs.checked);
    case "code_block":
      return String(n.attrs.params ?? "").trim();
    case "raw_block":
      return String(n.attrs.kind);
    case "footnote_def":
      return String(n.attrs.label);
    case "table_cell":
    case "table_header":
      return String(n.attrs.align ?? "");
    default:
      return "";
  }
}

const collapsed = (s: string) => s.replace(/\s+/gu, " ").trim();

function leafOf(n: Node): string {
  if (n.type.name === "image") return `image(${n.attrs.src})(${collapsed(String(n.attrs.alt ?? ""))})`;
  if (n.type.name === "footnote_ref") return `note(${n.attrs.label})`;
  return n.type.name;
}

/**
 * What a block says, as a string to compare: its kind and attributes, each
 * character with its formatting, pictures and notes. Spacing is evened out
 * (Markdown drops spaces at a line's ends, and they aren't words), and a line
 * break counts only between words: one with nothing after it isn't written.
 */
export function meaningOf(node: Node): string {
  const out: string[] = [];
  let space = false;
  let brk = false;
  const put = (s: string) => {
    if (out.length && !out[out.length - 1].startsWith(EDGE_MARK)) {
      if (brk) out.push("<br>");
      else if (space) out.push(" ");
    }
    space = brk = false;
    out.push(s);
  };
  const edge = (s: string) => {
    space = brk = false;
    out.push(EDGE_MARK + s);
  };
  const walk = (n: Node) => {
    if (n.isText) {
      const sig = marksOf(n.marks);
      for (const ch of n.text!) {
        if (SPACE.test(ch)) space = true;
        else put(ch + sig);
      }
      return;
    }
    if (n.type.name === "hard_break") {
      brk = true;
      return;
    }
    if (n.isLeaf) {
      put(`<${leafOf(n)}>`);
      return;
    }
    edge(`${n.type.name}(${attrsOf(n)})`);
    n.forEach(walk);
    edge(`end(${n.type.name})`);
  };
  walk(node);
  // Two lists of a kind side by side are one list to Markdown (as to Word): the page may hold them apart.
  return out.join("").replace(LISTS_TOGETHER, "");
}

const LISTS_TOGETHER = new RegExp(`${EDGE_MARK}end\\((bullet_list|ordered_list)\\)${EDGE_MARK}\\1\\([^)]*\\)`, "g");

// The words on the page ------------------------------------------------------------

const WORD = /[\p{L}\p{N}\p{M}]+/gu;

/** The words a block shows: its text, pictures' descriptions, a raw block's lines. */
export function wordsOf(node: Node): string[] {
  const words: string[] = [];
  node.descendants((n) => {
    if (n.isText) words.push(...(n.text!.match(WORD) ?? []));
    else if (n.type.name === "image") words.push(...(String(n.attrs.alt ?? "").match(WORD) ?? []));
    return true;
  });
  return words;
}

/** The words of `words` that `text` doesn't hold (as many times as they're missing). */
export function missingWords(words: readonly string[], text: string): string[] {
  const have = new Map<string, number>();
  for (const w of text.match(WORD) ?? []) have.set(w, (have.get(w) ?? 0) + 1);
  const missing: string[] = [];
  for (const w of words) {
    const n = have.get(w) ?? 0;
    if (n > 0) have.set(w, n - 1);
    else missing.push(w);
  }
  return missing;
}

// Reading a block back -------------------------------------------------------------

const unix = (s: string) => s.replace(/\r\n?/g, "\n").replace(/\n+$/, "");

/**
 * What a block needs around it to read back alone as it does in the document:
 * a note's definition is only a note when something refers to it, and a
 * note or a link by label only when its definition is there.
 */
function contextOf(node: Node): { before: string; after: string; blocks: number } {
  const own = node.type.name === "footnote_def" ? String(node.attrs.label) : null;
  const notes = new Set<string>();
  const links = new Map<string, string>();
  node.descendants((n) => {
    if (n.type.name === "footnote_ref" && n.attrs.label !== own) notes.add(String(n.attrs.label));
    if (n.type.name === "image" && n.attrs.ref) links.set(String(n.attrs.ref), String(n.attrs.src ?? ""));
    for (const m of n.marks) if (m.type.name === "link" && m.attrs.ref) links.set(String(m.attrs.ref), String(m.attrs.href ?? ""));
    return true;
  });
  let after = "";
  for (const label of notes) after += `\n\n[^${label}]: .`;
  if (links.size) {
    after += "\n";
    for (const [label, href] of links) after += `\n[${label}]: <${href.replace(/[<>\\]/g, "\\$&")}>`;
  }
  return { before: own !== null ? `[^${own}]\n\n` : "", after, blocks: (own !== null ? 2 : 1) + notes.size + (links.size ? 1 : 0) };
}

/** Whether the text written for a block reads back as the block the page holds. */
export function readsBack(node: Node, text: string): boolean {
  if (isEmptyLine(node)) return !/\S/.test(text);
  // A block kept as Markdown text is written as its lines: what it reads as is the person's own Markdown.
  if (node.type.name === "raw_block") return unix(text) === unix(node.textContent);
  const context = contextOf(node);
  const read = readAlone(context.before + text + context.after);
  if (read.childCount !== context.blocks) return false;
  return meaningOf(read.child(context.before ? 1 : 0)) === meaningOf(node);
}

/** The block's words that the text written for it wouldn't show once read back. */
function lostIn(node: Node, text: string): string[] {
  if (node.type.name === "raw_block") return missingWords(wordsOf(node), text);
  const context = contextOf(node);
  return missingWords(wordsOf(node), wordsOf(readAlone(context.before + text + context.after)).join(" "));
}

/**
 * A block's text read on its own, as it reads in the file: a byte-order mark
 * starting it is its own text there, not the file's mark (the serializer
 * gives the file a mark of its own when such a block starts it).
 */
const readAlone = (text: string) => parseMarkdown(text.startsWith("\uFEFF") ? "\uFEFF" + text : text).doc;

// Writing a block the careful way ----------------------------------------------------

const HTML_MARKS: Record<string, string> = { em: "<em>", strong: "<strong>", strike: "<s>" };

/** The block with its bold, italic and strikethrough written as HTML, which Corillo reads back without ambiguity. */
function withHtmlMarks(node: Node): Node {
  if (node.isText) {
    const marks = node.marks.map((m) => (HTML_MARKS[m.type.name] ? m.type.create({ ...m.attrs, markup: HTML_MARKS[m.type.name] }) : m));
    return schema.text(node.text!, marks);
  }
  if (node.isLeaf) return node;
  const kids: Node[] = [];
  node.forEach((c) => kids.push(withHtmlMarks(c)));
  return node.copy(Fragment.from(kids));
}

/** Sources made to write one block alone, the careful way: a fault planted in the serializer leaves them be. */
const alone = new WeakSet<Source>();
const fresh = (eol: Eol): Source => {
  const source: Source = { bom: false, eol, prefix: "", trailing: "", blocks: [], gaps: [], original: "" };
  alone.add(source);
  return source;
};

/** The serializer's own writing of the block, alone, with formatting as HTML. */
function htmlForm(node: Node, eol: Eol): string {
  const out = serializeMarkdown(schema.node("doc", null, [withHtmlMarks(node)]), fresh(eol));
  return out.endsWith(eol) ? out.slice(0, -eol.length) : out;
}

const PUNCT = /[!-/:-@[-`{-~]/g;
const TAGS: Record<string, [string, string]> = { em: ["<em>", "</em>"], strong: ["<strong>", "</strong>"], strike: ["<s>", "</s>"] };

/**
 * A paragraph or heading with every Markdown character escaped and its
 * formatting as HTML, a piece of text at a time. Null for blocks it can't
 * write so (code, pictures, notes, anything else).
 */
function escapedForm(node: Node, eol: Eol): string | null {
  if (node.type.name !== "paragraph" && node.type.name !== "heading") return null;
  let out = node.type.name === "heading" ? "#".repeat(node.attrs.level) + " " : "";
  let ok = true;
  node.forEach((child, _offset, index) => {
    if (!ok) return;
    if (child.type.name === "hard_break") {
      if (index < node.childCount - 1) out += "\\" + eol;
      return;
    }
    if (!child.isText || child.marks.some((m) => m.type.name === "code")) {
      ok = false;
      return;
    }
    let text = child.text!.replace(/\r\n?|\n/g, " ").replace(PUNCT, "\\$&");
    for (const m of [...child.marks].reverse()) {
      if (m.type.name === "link") text = `[${text}](<${String(m.attrs.href).replace(/[<>\\]/g, "\\$&")}>)`;
      else if (TAGS[m.type.name]) text = TAGS[m.type.name][0] + text + TAGS[m.type.name][1];
      else ok = false;
    }
    out += text;
  });
  if (!ok) return null;
  return out.replace(/^(#* ?)[ \t]+/, "$1").replace(/[ \t]+$/, "");
}

/** The block written the careful way, if one reads back as the page holds it; else null. */
function carefulWrite(node: Node, eol: Eol, fault: PlantedFault | null): string | null {
  for (const write of [htmlForm, escapedForm]) {
    let text: string | null;
    try {
      text = write(node, eol);
    } catch {
      text = null;
    }
    if (text === null) continue;
    if (fault === "drop-word-always") text = planted(text, fault);
    if (readsBack(node, text)) return text;
  }
  return null;
}

/** A line of plain words as Markdown: as the serializer writes it when that reads back, else every Markdown character escaped. */
function plainLine(words: string, eol: Eol): string {
  const para = schema.node("paragraph", null, [schema.text(words)]);
  try {
    const out = htmlForm(para, eol);
    if (readsBack(para, out)) return out;
  } catch {
    // escaped below
  }
  return words.replace(PUNCT, "\\$&");
}

/** A block's words as plain paragraphs: losing its formatting, never a word. */
function plainWords(node: Node, eol: Eol): string {
  const paras: string[] = [];
  const add = (text: string) => {
    for (const line of text.split(/\r\n?|\n/)) {
      const words = line.trim();
      if (words) paras.push(plainLine(words, eol));
    }
  };
  const walk = (child: Node) => {
    if (child.type.name === "image") {
      add(String(child.attrs.alt ?? ""));
      return false;
    }
    if (!child.isTextblock) return true;
    add(child.textBetween(0, child.content.size, "\n", (leaf) => (leaf.type.name === "image" ? ` ${leaf.attrs.alt ?? ""} ` : " ")));
    return false;
  };
  if (walk(node)) node.descendants(walk);
  return paras.join(eol + eol);
}

// A fault planted in the serializer itself (B14-01): it reaches everything that
// writes the page, the Markdown view's text included, as a real bug would.
let inSerializer: PlantedFault | null = null;

/** Plant a fault in serializeMarkdown's own output (null takes it away). Never outside tests. */
export function plantInSerializer(fault: PlantedFault | null): void {
  inSerializer = fault;
  setSerializerFault(fault ? (doc, source, layout) => faultyLayout(doc, source, layout, fault) : null);
}

export function serializerFault(): PlantedFault | null {
  return inSerializer;
}

/** The layout with the fault planted in its first edited block with words (for "lose-block", its first kept one). */
function faultyLayout(doc: Node, source: Source, layout: Layout, fault: PlantedFault): Layout {
  if (alone.has(source)) return layout;
  const blocks = [...layout.blocks];
  for (let k = 0; k < doc.childCount; k++) {
    const node = doc.child(k);
    const piece = blocks[k];
    if (!piece || !wordsOf(node).length) continue;
    const kept = isKept(source, node, piece.text);
    if (fault === "lose-block" ? !kept : kept) continue;
    blocks[k] = fault === "lose-block" ? null : { ...piece, text: planted(piece.text, fault) };
    break;
  }
  return { ...layout, blocks };
}

function planted(text: string, fault: PlantedFault): string {
  if (fault === "other-kind") return `# ${text}`;
  const words = [...text.matchAll(WORD)];
  const last = words[words.length - 1];
  return last ? text.slice(0, last.index) + text.slice(last.index! + last[0].length) : text;
}

// The check ------------------------------------------------------------------------

// What earlier saves found, so each save reads back only the blocks changed since
// the last one (B14-02): a block is a node that never changes, and whether a text
// reads back as it depends on nothing else. passed: the text let through as
// written for the block; repairs: the careful text written for a text that wasn't.
const passed = new WeakMap<Node, string>();
const repairs = new WeakMap<Node, { from: string; eol: Eol; to: string }>();

/**
 * Check the text a save would write for the page (`doc`, read from `source`),
 * repairing what can be repaired. The text is the same as serializeMarkdown's,
 * unless a block was repaired. `spans`, if given, gets where each of the
 * document's blocks is in the text, as serializeMarkdown's does.
 */
export function checkSave(doc: Node, source: Source, fault: PlantedFault | null = null, spans?: { from: number; to: number }[]): SaveCheck {
  const layout = markdownLayout(doc, source);
  const eol = source.eol;
  const start = (source.bom ? "\uFEFF" : "") + layout.prefix;
  let text = start;
  let keep = start;
  let repaired = 0;
  let lost: string[] | null = null;
  let plant = fault;
  for (let k = 0; k < doc.childCount; k++) {
    const node = doc.child(k);
    let piece = layout.blocks[k];
    if (plant === "lose-block" && piece && wordsOf(node).length && isKept(source, node, piece.text)) {
      piece = null;
      plant = null;
    }
    if (!piece) {
      spans?.push({ from: text.length, to: text.length });
      // Nothing written for it: only an empty line may be left out.
      if (isEmptyLine(node)) continue;
      lost = [...(lost ?? []), ...wordsOf(node)];
      keep += (keep === start ? "" : eol + eol) + plainWords(node, eol);
      continue;
    }
    let written = piece.text;
    if (!isKept(source, node, written)) {
      const fault = plant && plant !== "lose-block" && wordsOf(node).length ? plant : null;
      if (fault) {
        written = planted(written, fault);
        plant = null;
      }
      const faulty = fault ?? inSerializer; // (a test's: nothing found then is remembered)
      const repair = faulty ? null : repairs.get(node);
      if (repair && repair.from === written && repair.eol === eol) {
        written = repair.to;
        repaired++;
      } else if (passed.get(node) !== written) {
        if (readsBack(node, written)) passed.set(node, written);
        else {
          const careful = carefulWrite(node, eol, faulty);
          if (careful !== null) {
            if (!faulty) repairs.set(node, { from: written, eol, to: careful });
            written = careful;
            repaired++;
          } else {
            // No careful way reads back either: refused when words would go; when they'd all
            // come back (a list or table Markdown reads its own way), written as the serializer had it.
            const gone = lostIn(node, written);
            if (gone.length) {
              lost = [...(lost ?? []), ...gone];
              keep += piece.gap + plainWords(node, eol);
              continue;
            }
            if (!faulty) passed.set(node, written);
          }
        }
      }
    }
    spans?.push({ from: text.length + piece.gap.length, to: text.length + piece.gap.length + written.length });
    text += piece.gap + written;
    keep += piece.gap + written;
  }
  if (lost) return { ok: false, lost, keep: keep + layout.trailing };
  return { ok: true, text: text + layout.trailing, repaired };
}

// An agent's edit ------------------------------------------------------------------

/** Where an edit's replacement went: in the text before (from, to) and after (start, end). */
export interface Splice {
  from: number;
  to: number;
  start: number;
  end: number;
}

/**
 * An agent's find and replace must leave the text outside what it found as it
 * was. Null when it did; otherwise the words that would go (empty when only
 * spacing or signs would change).
 */
export function spliceLoss(before: string, after: string, splices: readonly Splice[]): string[] | null {
  const sorted = [...splices].sort((a, b) => a.from - b.from);
  const was: string[] = [];
  const now: string[] = [];
  let b = 0;
  let a = 0;
  for (const s of sorted) {
    was.push(before.slice(b, s.from));
    now.push(after.slice(a, s.start));
    b = s.to;
    a = s.end;
  }
  was.push(before.slice(b));
  now.push(after.slice(a));
  if (was.every((w, i) => w === now[i])) return null;
  return missingWords(was.join(" ").match(WORD) ?? [], now.join(" "));
}
