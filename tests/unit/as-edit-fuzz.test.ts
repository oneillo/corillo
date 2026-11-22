// Proof that an agent's change shown as an edit (roadmap Batch 7, items 1 and
// 3) gives the same document as reading the new text afresh. Random documents
// of every kind (headings, lists tight and loose, tables, code, footnotes,
// front matter, empty lines, CRLF, odd Unicode, Obsidian's syntax), changed at
// random, change after change, with fixed seeds so a failure can be replayed.
// After each change made as an edit: the page is the new text's blocks, it
// writes back the new text byte for byte, unchanged blocks included, and
// writes the same as a page read afresh once the person types in it; the
// blocks the change didn't touch are the very ones the page already showed,
// so they aren't drawn again; and the Markdown view's text becomes the new
// text. Where the edit can't be made exactly it isn't made at all (no edit
// comes back, and the page is read afresh as before): never a page that
// differs from the file.
import { describe, expect, it } from "vitest";
import { Transform } from "prosemirror-transform";
import type { Node } from "prosemirror-model";
import { parseMarkdown, serializeMarkdown, type Source } from "../../src/core/markdown";
import { applyTextChanges, editTo, textChanges } from "../../src/core/smallest-edit";
import { forTextArea } from "../../src/core/text-area";
import { bigDocument } from "../fixtures/big-document";

/** A repeatable stream of random numbers. */
function random(seed: number) {
  let s = seed >>> 0;
  const rnd = () => {
    s = (s * 1664525 + 1013904223) >>> 0;
    return s / 2 ** 32;
  };
  const below = (n: number) => Math.floor(rnd() * n);
  const pick = <T>(xs: readonly T[]): T => xs[below(xs.length)];
  return { rnd, below, pick };
}
type Random = ReturnType<typeof random>;

// Documents -----------------------------------------------------------------------------------

// Words as people write them, and some that aren't plain letters: accents
// made of two characters, emoji (one of four people joined), right-to-left
// script, a no-break space, a zero-width space, letters outside the common
// range, a tab.
const WORDS = [
  "budget", "plan", "team", "review", "board", "the", "and", "quarter", "hire", "two", "people", "risk", "office", "June",
  "café", "naïve", "été", "中文", "日本語", "🙂", "👩‍👩‍👧‍👦", "עברית", "a b", "zero​width", "𝔘𝔫𝔦", "ﬁne", "tab\there",
];
const word = (r: Random) => r.pick(WORDS);

/** Words with some formatting and Markdown's and Obsidian's inline syntax among them. */
function sentence(r: Random, max = 10): string {
  const n = 2 + r.below(max);
  const parts: string[] = [];
  for (let i = 0; i < n; i++) {
    const roll = r.rnd();
    if (roll < 0.62) parts.push(word(r));
    else
      parts.push(
        r.pick([
          `**${word(r)}**`, `*${word(r)}*`, `_${word(r)}_`, `\`${word(r)}\``, `~~${word(r)}~~`, `[${word(r)}](https://example.com/${r.below(9)})`,
          `[^${1 + r.below(3)}]`, `==${word(r)}==`, `[[${word(r)}]]`, `[[Note|${word(r)}]]`, `%%${word(r)}%%`, `#tag${r.below(5)}`,
          `<b>${word(r)}</b>`, `$x^${r.below(9)}$`, `^[${word(r)}]`, "\\*", "&amp;", "a_b", "50%", `[${word(r)}][ref]`,
        ]),
      );
  }
  return parts.join(" ") + r.pick([".", "", "!", "?", ":"]);
}

/** One block of a document, as its lines. */
const BLOCKS: ((r: Random) => string[])[] = [
  (r) => [`${"#".repeat(1 + r.below(4))} ${sentence(r, 4)}`],
  (r) => [sentence(r, 5), r.pick(["===", "---"])], // a heading underlined
  (r) => [sentence(r)],
  (r) => [sentence(r), sentence(r)], // two lines, one paragraph
  (r) => [`${sentence(r)}  `, sentence(r)], // a line break
  (r) => {
    // A tight list, sometimes with a list inside it.
    const marker = r.pick(["-", "*", "+"]);
    const out: string[] = [];
    for (let i = 0, n = 1 + r.below(4); i < n; i++) {
      out.push(`${marker} ${sentence(r, 5)}`);
      if (r.rnd() < 0.25) out.push(`  ${r.pick(["-", "*"])} ${sentence(r, 3)}`);
    }
    return out;
  },
  (r) => {
    // A loose list: a blank line between its items.
    const out: string[] = [];
    for (let i = 0, n = 2 + r.below(3); i < n; i++) {
      if (i) out.push("");
      out.push(`- ${sentence(r, 5)}`);
    }
    return out;
  },
  (r) => {
    const delim = r.pick([".", ")"]);
    const start = r.pick([1, 1, 3, 10]);
    const loose = r.rnd() < 0.3;
    const out: string[] = [];
    for (let i = 0, n = 1 + r.below(4); i < n; i++) {
      if (i && loose) out.push("");
      out.push(`${start + i}${delim} ${sentence(r, 5)}`);
    }
    return out;
  },
  (r) => Array.from({ length: 1 + r.below(3) }, () => `- [${r.pick([" ", "x"])}] ${sentence(r, 4)}`),
  (r) => {
    const cols = 2 + r.below(2);
    const cell = () => (r.rnd() < 0.15 ? `${word(r)} \\| ${word(r)}` : r.rnd() < 0.1 ? "" : sentence(r, 2));
    const row = () => `| ${Array.from({ length: cols }, cell).join(" | ")} |`;
    const rule = `|${Array.from({ length: cols }, () => r.pick(["---", ":--", "--:", ":-:"])).join("|")}|`;
    return [row(), rule, ...Array.from({ length: 1 + r.below(3) }, row)];
  },
  (r) => {
    const fence = r.pick(["```", "~~~"]);
    return [`${fence}${r.pick(["", "js", "mermaid", "python"])}`, ...Array.from({ length: 1 + r.below(3) }, () => r.pick([sentence(r, 3), "# not a heading", "- not a list", "", "  indented"])), fence];
  },
  (r) => Array.from({ length: 1 + r.below(2) }, () => `    ${sentence(r, 3)}`), // code by indent
  (r) => Array.from({ length: 1 + r.below(3) }, () => r.pick([`> ${sentence(r, 4)}`, `> > ${sentence(r, 3)}`, ">"])),
  (r) => [`> [!${r.pick(["note", "warning", "tip"])}] ${sentence(r, 3)}`, `> ${sentence(r, 4)}`],
  (r) => Array.from({ length: 1 + r.below(2) }, (_, i) => `[^${1 + i + r.below(2)}]: ${sentence(r, 5)}`),
  (r) => [`[ref]: https://example.com/${r.below(9)}${r.rnd() < 0.5 ? ` "${word(r)}"` : ""}`],
  (r) => [r.pick(["---", "***", "___"])],
  (r) => ["<div>", sentence(r, 3), "</div>"],
  (r) => ["$$", `x = ${r.below(99)}`, "$$"],
  (r) => [r.pick([`![[picture ${r.below(4)}.png]]`, `![${word(r)}](pictures/chart.png)`, `![[${word(r)}]]`])],
  (r) => ["%%", sentence(r, 3), "%%"],
  (r) => [`<!-- ${sentence(r, 3)} -->`],
];

/** A document as its parts, so changes can be made to its blocks. */
interface Doc {
  bom: boolean;
  eol: "\n" | "\r\n" | "\r";
  front: string[] | null;
  /** Blank lines before the first block. */
  lead: number;
  blocks: string[][];
  /** Line breaks between block i and i + 1: 2 is one blank line; 1 has the blocks touch. */
  seps: number[];
  /** Line breaks after the last block. */
  trail: number;
}

function block(r: Random): string[] {
  return r.pick(BLOCKS)(r);
}

function sep(r: Random): number {
  const roll = r.rnd();
  return roll < 0.78 ? 2 : roll < 0.9 ? 3 : roll < 0.95 ? 4 : 1;
}

function newDoc(r: Random): Doc {
  const n = 1 + r.below(14);
  const blocks = Array.from({ length: n }, () => block(r));
  return {
    bom: r.rnd() < 0.05,
    eol: r.rnd() < 0.2 ? "\r\n" : r.rnd() < 0.03 ? "\r" : "\n",
    front: r.rnd() < 0.15 ? ["---", `title: ${word(r)}`, `tags: [${word(r)}, plan]`, "---"] : null,
    lead: r.rnd() < 0.1 ? 1 + r.below(2) : 0,
    blocks,
    seps: blocks.slice(1).map(() => sep(r)),
    trail: r.pick([0, 1, 1, 1, 1, 2, 3]),
  };
}

function render(d: Doc): string {
  let text = "";
  if (d.front) text += d.front.join("\n") + (d.blocks.length ? "\n\n" : "\n");
  text += "\n".repeat(d.lead);
  d.blocks.forEach((b, i) => {
    if (i) text += "\n".repeat(d.seps[i - 1]);
    text += b.join("\n");
  });
  text += "\n".repeat(d.trail);
  return (d.bom ? "﻿" : "") + (d.eol === "\n" ? text : text.replace(/\n/g, d.eol));
}

const copy = (d: Doc): Doc => ({ ...d, front: d.front && [...d.front], blocks: d.blocks.map((b) => [...b]), seps: [...d.seps] });

// Changes -------------------------------------------------------------------------------------

/** A word's place in a block: line, start and end. */
function words(lines: string[]): [number, number, number][] {
  const out: [number, number, number][] = [];
  lines.forEach((line, l) => {
    for (const m of line.matchAll(/[\p{L}\p{N}]+/gu)) out.push([l, m.index!, m.index! + m[0].length]);
  });
  return out;
}

function putBlock(d: Doc, at: number, lines: string[], r: Random): void {
  d.blocks.splice(at, 0, lines);
  if (d.blocks.length > 1) d.seps.splice(Math.min(at, d.seps.length), 0, sep(r));
}

function takeBlock(d: Doc, at: number): string[] {
  const [taken] = d.blocks.splice(at, 1);
  if (d.seps.length) d.seps.splice(Math.min(at, d.seps.length - 1), 1);
  return taken;
}

/** The kinds of change an agent (or another app) makes, each on a copy of the document. */
const CHANGES: Record<string, (d: Doc, r: Random) => void> = {
  "one word": (d, r) => {
    if (!d.blocks.length) return;
    const b = r.below(d.blocks.length);
    const found = words(d.blocks[b]);
    if (!found.length) return;
    const [l, from, to] = r.pick(found);
    const line = d.blocks[b][l];
    d.blocks[b][l] = line.slice(0, from) + r.pick([word(r), `**${word(r)}**`, ""]) + line.slice(to);
  },
  "words put in": (d, r) => {
    if (!d.blocks.length) return;
    const b = r.below(d.blocks.length);
    const l = r.below(d.blocks[b].length);
    const line = d.blocks[b][l];
    const at = r.below(line.length + 1);
    d.blocks[b][l] = line.slice(0, at) + ` ${sentence(r, 3)} ` + line.slice(at);
  },
  "a block added": (d, r) => putBlock(d, r.below(d.blocks.length + 1), block(r), r),
  "a block taken out": (d, r) => {
    if (d.blocks.length) takeBlock(d, r.below(d.blocks.length));
  },
  "a block moved": (d, r) => {
    if (d.blocks.length < 2) return;
    const moved = takeBlock(d, r.below(d.blocks.length));
    putBlock(d, r.below(d.blocks.length + 1), moved, r);
  },
  "blocks moved together": (d, r) => {
    if (d.blocks.length < 4) return;
    const from = r.below(d.blocks.length - 2);
    const n = 2 + r.below(Math.min(3, d.blocks.length - from - 1));
    const moved: string[][] = [];
    for (let i = 0; i < n; i++) moved.push(takeBlock(d, from));
    const to = r.below(d.blocks.length + 1);
    moved.reverse().forEach((m) => putBlock(d, to, m, r));
  },
  "two blocks swapped": (d, r) => {
    if (d.blocks.length < 2) return;
    const i = r.below(d.blocks.length - 1);
    [d.blocks[i], d.blocks[i + 1]] = [d.blocks[i + 1], d.blocks[i]];
  },
  "a block written twice": (d, r) => {
    if (!d.blocks.length) return;
    const i = r.below(d.blocks.length);
    putBlock(d, r.below(d.blocks.length + 1), [...d.blocks[i]], r);
  },
  "a block rewritten": (d, r) => {
    if (d.blocks.length) d.blocks[r.below(d.blocks.length)] = block(r);
  },
  "everything rewritten": (d, r) => {
    const fresh = newDoc(r);
    Object.assign(d, { ...fresh, eol: r.rnd() < 0.8 ? d.eol : fresh.eol });
  },
  "at the very start": (d, r) => {
    const roll = r.rnd();
    if (roll < 0.3) putBlock(d, 0, block(r), r);
    else if (roll < 0.5 && d.blocks.length) d.blocks[0] = [`${word(r)} ${d.blocks[0][0]}`, ...d.blocks[0].slice(1)];
    else if (roll < 0.65) d.lead = d.lead ? 0 : 1 + r.below(2);
    else if (roll < 0.85) d.front = d.front ? null : ["---", `title: ${word(r)}`, "---"];
    else d.bom = !d.bom;
  },
  "at the very end": (d, r) => {
    const roll = r.rnd();
    if (roll < 0.35) putBlock(d, d.blocks.length, block(r), r);
    else if (roll < 0.6 && d.blocks.length) {
      const last = d.blocks[d.blocks.length - 1];
      last[last.length - 1] += ` ${word(r)}`;
    } else d.trail = r.pick([0, 1, 2, 4]);
  },
  "empty lines between blocks": (d, r) => {
    if (d.seps.length) d.seps[r.below(d.seps.length)] = r.pick([1, 2, 3, 5]);
  },
  "line endings": (d, r) => {
    d.eol = r.pick(["\n", "\r\n", "\r"] as const);
  },
  "a sign typed anywhere": (d, r) => {
    // A character of Markdown's syntax at any place in a block: lists, tables, code and quotes can begin or end.
    if (!d.blocks.length) return;
    const b = r.below(d.blocks.length);
    const l = r.below(d.blocks[b].length);
    const line = d.blocks[b][l];
    const at = r.below(line.length + 1);
    const sign = r.pick(["*", "_", "`", "```", "|", ">", "- ", "1. ", "#", "[", "]", "~", "$", "%%", "=", "\\", "<", "[^1]", "  ", "\t", "\n", "\n\n", "\n---", "\n|---|"]);
    const lines = (line.slice(0, at) + sign + line.slice(at)).split("\n");
    d.blocks[b].splice(l, 1, ...lines);
  },
};
const KINDS = Object.keys(CHANGES);

/** A change of one kind, or now and then several at once. */
function change(d: Doc, r: Random): { doc: Doc; kind: string } {
  const out = copy(d);
  if (r.rnd() < 0.12) {
    const kinds = Array.from({ length: 2 + r.below(3) }, () => r.pick(KINDS.filter((k) => k !== "everything rewritten")));
    for (const k of kinds) CHANGES[k](out, r);
    return { doc: out, kind: "several at once" };
  }
  const kind = r.pick(KINDS);
  CHANGES[kind](out, r);
  return { doc: out, kind };
}

// The checks ------------------------------------------------------------------------------------

/** The page as the window holds it: its blocks, what they were read from, and the file's text. */
interface Page {
  doc: Node;
  source: Source;
  text: string;
}

interface Tally {
  edits: number;
  /** Changes that couldn't be made exactly, so the page was read afresh: by kind. */
  reloads: Record<string, number>;
  /** Texts that don't read back as themselves when read afresh (the reading's own limit, checked in markdown-fuzz). */
  unreadable: number;
  /** Top-level blocks the edits kept, and of how many the change left as they were. */
  kept: number;
  same: number;
  /** Times the person typed in the page after a change, checked against a page read afresh. */
  typed: number;
}

/** The document with words typed at a place, or null where words can't go. */
function typedAt(doc: Node, at: number, words: string): Node | null {
  try {
    return new Transform(doc).insert(at, doc.type.schema.text(words)).doc;
  } catch {
    return null;
  }
}

/** Every textblock's start and end in a document (where the person could type). */
function typingPlaces(doc: Node): number[] {
  const out: number[] = [];
  doc.descendants((node, pos) => {
    if (node.isTextblock) {
      out.push(pos + 1, pos + 1 + node.content.size);
      return false;
    }
    return true;
  });
  return out;
}

/**
 * The change from the page as it is to `after`, as the window makes it.
 * Returns the page after it: the edit's, or one read afresh when no edit came back.
 */
function arrive(page: Page, after: string, kind: string, tally: Tally, what: () => string): Page {
  const next = parseMarkdown(after);
  const reread = { doc: next.doc, source: next.source, text: after };
  if (serializeMarkdown(next.doc, next.source) !== after) {
    tally.unreadable++;
    return reread;
  }
  const tr = new Transform(page.doc);
  // Nothing but an edit or none comes out of it: never an error.
  let edit: ReturnType<typeof editTo> = null;
  try {
    edit = editTo(tr, next, after);
  } catch (error) {
    throw new Error(`${what()}\nthe edit failed: ${String(error)}`);
  }
  if (!edit) {
    tally.reloads[kind] = (tally.reloads[kind] ?? 0) + 1;
    return reread;
  }
  tally.edits++;
  // The page is what the new text reads as, and writes it back byte for byte.
  expect(tr.doc.eq(next.doc), what()).toBe(true);
  expect(serializeMarkdown(tr.doc, edit.source), what()).toBe(after);

  // Where it says it changed: in order, within the page as it was.
  let end = 0;
  for (const c of edit.changed) {
    expect(c.from, what()).toBeGreaterThanOrEqual(end);
    expect(c.to, what()).toBeGreaterThanOrEqual(c.from);
    end = c.to;
  }
  expect(end, what()).toBeLessThanOrEqual(page.doc.content.size);

  // Every block it didn't touch is the very block the page showed (not drawn again), where it now is.
  const kept = new Set<Node>();
  page.doc.forEach((child, from) => {
    const to = from + child.nodeSize;
    if (edit.changed.some((c) => (c.from < to && c.to > from) || (c.from === c.to && c.from > from && c.from < to))) return;
    const at = tr.mapping.mapResult(from, 1);
    expect(at.deleted, what()).toBe(false);
    const $at = tr.doc.resolve(at.pos);
    expect($at.depth, what()).toBe(0);
    expect(tr.doc.child($at.index()) === child, `${what()}: a block the change didn't touch was drawn again`).toBe(true);
    kept.add(child);
  });
  // Never fewer kept than the blocks the change left as they were at the start and the end.
  let lead = 0;
  while (lead < page.doc.childCount && lead < next.doc.childCount && page.doc.child(lead).eq(next.doc.child(lead))) lead++;
  let tail = 0;
  while (tail < page.doc.childCount - lead && tail < next.doc.childCount - lead && page.doc.child(page.doc.childCount - 1 - tail).eq(next.doc.child(next.doc.childCount - 1 - tail))) tail++;
  let reused = 0;
  tr.doc.forEach((child) => {
    if (kept.has(child)) reused++;
  });
  expect(reused, what()).toBeGreaterThanOrEqual(lead + tail);
  // With as many blocks as before, never fewer kept than the blocks left as they were in their places.
  if (page.doc.childCount === next.doc.childCount) {
    let inPlace = 0;
    page.doc.forEach((child, _, i) => {
      if (child.eq(next.doc.child(i))) inPlace++;
    });
    expect(reused, what()).toBeGreaterThanOrEqual(inPlace);
  }
  tally.kept += reused;
  tally.same += lead + tail;

  // The Markdown view's text: only the lines that changed are replaced, and it then reads as the new text.
  const shown = forTextArea(page.text);
  expect(applyTextChanges(shown, textChanges(shown, forTextArea(after))), what()).toBe(forTextArea(after));
  return { doc: tr.doc, source: edit.source, text: after };
}

/**
 * The person types a few letters at a random place in the page, after a
 * change came: the file written is the one a page read afresh from the same
 * text would write, typed in at the same place. The page goes on from there,
 * as in the window, even where what was typed reads otherwise once written
 * (the reading's own limit, checked in markdown-fuzz): the next change then
 * starts from a page that isn't quite what the file says, as it would.
 */
function typeIn(page: Page, r: Random, tally: Tally, what: () => string): Page {
  const places = typingPlaces(page.doc);
  if (!places.length) return page;
  const at = r.pick(places);
  const words = r.pick(["Zq", "x", "y z", word(r)]);
  const mine = typedAt(page.doc, at, words);
  if (!mine) return page;
  const saved = serializeMarkdown(mine, page.source);
  const afresh = parseMarkdown(page.text);
  if (afresh.doc.eq(page.doc)) {
    const fresh = typedAt(afresh.doc, at, words);
    expect(!!fresh, what()).toBe(true);
    expect(saved, `${what()}\ntyped ${JSON.stringify(words)} at ${at}`).toBe(serializeMarkdown(fresh!, afresh.source));
    tally.typed++;
  }
  return { doc: mine, source: page.source, text: saved };
}

/** Random documents, each changed `steps` times in a row, as one agent's pass after another. */
function run(seed: number, documents: number, steps: number): Tally {
  const r = random(seed);
  const tally: Tally = { edits: 0, reloads: {}, unreadable: 0, kept: 0, same: 0, typed: 0 };
  for (let n = 0; n < documents; n++) {
    let doc = newDoc(r);
    const text = render(doc);
    const first = parseMarkdown(text);
    let page: Page = { doc: first.doc, source: first.source, text };
    const history: string[] = [JSON.stringify(text)];
    for (let s = 0; s < steps; s++) {
      const next = change(doc, r);
      doc = next.doc;
      const after = render(doc);
      history.push(`${next.kind}: ${JSON.stringify(after)}`);
      const what = () => `seed ${seed}, document ${n}, change ${s + 1}\n${history.join("\n")}`;
      page = arrive(page, after, next.kind, tally, what);
      // Mostly, the person then types in it, anywhere, and it's saved: it writes back as a page read afresh would.
      if (r.rnd() < 0.7) {
        page = typeIn(page, r, tally, what);
        history.push(`the person typed: ${JSON.stringify(page.text)}`);
      }
    }
  }
  return tally;
}

const total = (t: Tally) => Object.values(t.reloads).reduce((a, b) => a + b, 0);

/** The 3,000-word report of the long-document tests as a document of parts, to be changed the same way. */
function longDoc(): Doc {
  const blocks = bigDocument(3).trimEnd().split("\n\n").map((b) => b.split("\n"));
  return { bom: false, eol: "\n", front: null, lead: 0, blocks, seps: blocks.slice(1).map(() => 2), trail: 1 };
}

describe("an agent's change shown as an edit, against the page read afresh", () => {
  it("is the same page, written back byte for byte, with only the blocks it touched drawn again: documents of every kind, changed five times in a row", () => {
    const tally = run(20261111, 1500, 5);
    const reloads = total(tally);
    console.log(
      `As an edit: ${tally.edits} changes; read afresh: ${reloads} (${JSON.stringify(tally.reloads)}); texts that don't read back as themselves: ${tally.unreadable}. Blocks kept: ${tally.kept} (${tally.same} left as they were at the start and the end). Typed in afterwards: ${tally.typed} times.`,
    );
    expect(tally.edits).toBeGreaterThan(6000);
    expect(tally.typed).toBeGreaterThan(4000);
    // Reading afresh is the way out, not the way it usually goes: under one change in a hundred.
    expect(reloads / (tally.edits + reloads)).toBeLessThan(0.01);
  }, 60_000);

  it("holds for other seeds, with longer runs of changes on fewer documents", () => {
    for (const seed of [1, 7, 42]) {
      const tally = run(seed, 150, 20);
      expect(tally.edits).toBeGreaterThan(2000);
      expect(total(tally) / (tally.edits + total(tally))).toBeLessThan(0.01);
    }
  }, 60_000);

  it("holds on a long report (3,000 words, tables, lists, notes, diagrams), changed forty times in a row", () => {
    const r = random(9000);
    const tally: Tally = { edits: 0, reloads: {}, unreadable: 0, kept: 0, same: 0, typed: 0 };
    let doc = longDoc();
    const first = parseMarkdown(render(doc));
    let page: Page = { doc: first.doc, source: first.source, text: render(doc) };
    for (let s = 0; s < 40; s++) {
      const next = change(doc, r);
      doc = next.doc;
      const after = render(doc);
      const what = () => `long report, change ${s + 1} (${next.kind})`;
      page = arrive(page, after, next.kind, tally, what);
      page = typeIn(page, r, tally, what);
    }
    expect(tally.unreadable).toBe(0);
    expect(tally.edits).toBeGreaterThanOrEqual(39);
  }, 60_000);
});


/** The document and the change the random changes found editTo stuck on (see below). */
const BEFORE_254 = "~~~\na_b $x^3$ ~~the~~ ^[team]\n~~~\n\nteam quarter budget caf\u00e9 e\u0301te\u0301?\n===\n\n\n- [ ] budget [^1] tab\there\n- [x] two quarter [[Note|the]] June!\n\n<div>\n\ud835\udd18\ud835\udd2b\ud835\udd26 and 50%!\n</div>\n\n- &amp; risk:\n\n- ~~and~~ plan [[Note|\ud83d\ude42]].\n\n#### plan people.\n\n```\nx==June== tab\there budget zero\u200bwidth!\na\u00a0b ~~\u65e5\u672c\u8a9e~~ team \ufb01ne!\n```\n\n<b>plan</b> a_b [quarter](https://example.com/6) June review [[Note|a\u00a0b]] \ufb01ne June!\na_b ^[zero\u200bwidth] #tag0 *\ufb01ne* #tag3 a_b `a\u00a0b` _e\u0301te\u0301_:\n\n> &amp; \u05e2\u05d1\u05e8\u05d9\u05ea e\u0301te\u0301 June!\n\nna\u00efve team \u4e2d\u6587 people tab\there!\n---\n\n> [!warning] \ud835\udd18\ud835\udd2b\ud835\udd26 *two* review <b>zero\u200bwidth</b>\n> tab\there caf\u00e9:\n\n- [ ] budget [^1] tab\there\n- [x] two quarter [[Note|the]] June!\n\n- [ ] budget [^1] tab\there\n- [x] two quarter [[Note|the]] June!\n";
const AFTER_254 = "~~~\na_b $x^3$ ~~the~~ ^[team]\n~~~\n\nteam quarter budget caf\u00e9 e\u0301te\u0301?\n===\n\n\n- [ ] budget [^1] tab\there\n- [x] two quarter [[Note|the]] June!\n\n<div>\n\ud835\udd18\ud835\udd2b\ud835\udd26 and 50%!\n</div>\n\n- &amp; risk:\n\n- ~~and~~ plan [[Note|\ud83d\ude42]].\n\n#### plan people.\n\n<b>plan</b> a_b [quarter](https://example.com/6) June review [[Note|a\u00a0b]] \ufb01ne June!\na_b ^[zero\u200bwidth] #tag0 *\ufb01ne* #tag3 a_b `a\u00a0b` _e\u0301te\u0301_:\n\n> &amp; \u05e2\u05d1\u05e8\u05d9\u05ea e\u0301te\u0301 June!\n\nna\u00efve team \u4e2d\u6587 people tab\there!\n---\n\n> [!warning] \ud835\udd18\ud835\udd2b\ud835\udd26 *two* review <b>zero\u200bwidth</b>\n> tab\there caf\u00e9:\n\n- [ ] budget [^1] tab\there\n- [x] two quarter [[Note|the]] June!\n\n    ==June== tab\there budget zero\u200bwidth!\n    a\u00a0b ~~\u65e5\u672c\u8a9e~~ team \ufb01ne!\n\n- [ ] budget [^1] tab\there\n- [x] two quarter [[Note|the]] June!\n";

describe("found by the random changes", () => {
  it("a list given one more of an item it already holds, below a paragraph taken out, is changed only where it changed", () => {
    // Where the same items repeat, the two ends of the change cross; with the
    // list further up in the new text than in the old, the stretch of the new
    // text to put in came out backwards. Here the editor library refused it,
    // and the whole list was replaced; in the case below, it never finished.
    const before = "This paragraph goes away, and it is long enough to matter.\n\nMiddle.\n\n- a\n- a\n";
    const after = "Middle.\n\n- a\n- a\n- a\n";
    const was = parseMarkdown(before);
    const next = parseMarkdown(after);
    const tr = new Transform(was.doc);
    const edit = editTo(tr, next, after);
    expect(edit).not.toBeNull();
    expect(tr.doc.eq(next.doc)).toBe(true);
    expect(serializeMarkdown(tr.doc, edit!.source)).toBe(after);
    expect(tr.doc.child(0)).toBe(was.doc.child(1));
    // In the list, one item put in, not the whole list replaced: the two items there are kept.
    expect(edit!.changed).toHaveLength(2);
    expect(edit!.changed[1].to).toBe(edit!.changed[1].from);
    expect(tr.doc.child(1).child(0)).toBe(was.doc.child(2).child(0));
  });

  it("the same the other way: an item taken out of a list of alike items, below a paragraph put in", () => {
    const before = "Middle.\n\n- a\n- a\n- a\n";
    const after = "A new paragraph put in at the top, long enough to move the list.\n\nMiddle.\n\n- a\n- a\n";
    const was = parseMarkdown(before);
    const next = parseMarkdown(after);
    const tr = new Transform(was.doc);
    const edit = editTo(tr, next, after);
    expect(edit).not.toBeNull();
    expect(tr.doc.eq(next.doc)).toBe(true);
    expect(serializeMarkdown(tr.doc, edit!.source)).toBe(after);
    expect(tr.doc.child(1)).toBe(was.doc.child(0));
    expect(edit!.changed[1].to - edit!.changed[1].from).toBe(was.doc.child(1).child(0).nodeSize);
  });

  it("the case the random changes found: a code block moved below a list of tasks written twice is made, where the window hung", () => {
    // (Seed 20261111, document 254: the stretch came out backwards, and editTo never came back.)
    const before = BEFORE_254;
    const after = AFTER_254;
    const was = parseMarkdown(before);
    const next = parseMarkdown(after);
    const tr = new Transform(was.doc);
    const edit = editTo(tr, next, after);
    expect(edit).not.toBeNull();
    expect(serializeMarkdown(tr.doc, edit!.source)).toBe(after);
  });

  it("a picture swapped with a quote across an empty line: only those two are drawn again", () => {
    // Blocks with no words (empty lines, a picture alone) were all alike to the
    // matching, so the picture was paired with the empty line between them, and
    // that empty line, unchanged in its place, was drawn again.
    const before = "+ a\n+ b\n\n\n\n> [!warning] Plan\n> risk\n\n\n![Chart](pictures/chart.png)\n\nBoard.\n";
    const after = "+ a\n+ b\n\n\n\n![Chart](pictures/chart.png)\n\n\n> [!warning] Plan\n> risk\n\nBoard.\n";
    const was = parseMarkdown(before);
    const next = parseMarkdown(after);
    const tr = new Transform(was.doc);
    const edit = editTo(tr, next, after);
    expect(edit).not.toBeNull();
    expect(serializeMarkdown(tr.doc, edit!.source)).toBe(after);
    // Seven blocks: the list, two empty lines, the quote, an empty line, the picture, the last paragraph.
    expect(was.doc.childCount).toBe(7);
    const kept = new Set(Array.from({ length: was.doc.childCount }, (_, i) => was.doc.child(i)));
    let same = 0;
    tr.doc.forEach((child) => {
      if (kept.has(child)) same++;
    });
    expect(same).toBe(5);
  });
});

describe("the writer's own records follow the text a block is paired with", () => {
  // The writer keeps where each paragraph of a list or quote sits in the
  // file's text (paragraphsIn in core/markdown.ts). An edit keeps a list the
  // change left as it was, but with the new text's spacing (here one blank
  // line fewer between its items). Kept by the list alone, the places were
  // the old text's, and a list typed in after the change was written from the
  // wrong lines ("- two- Zqtwo"): in the window, through a version restored
  // from History or another app writing the earlier text back, then a change
  // to the spacing between its items (found in the review of Batch 7). They're
  // kept by the list and its text.
  it("a list kept through a change to its spacing, typed in after a write that typed in it before the change, is written as the page reads", () => {
    const before = "Intro.\n\n- one\n\n\n- two\n\nEnd.\n";
    const after = "Intro.\n\n- one\n\n- two\n\nEnd.\n";
    const was = parseMarkdown(before);
    let at = -1;
    was.doc.descendants((node, pos) => {
      if (at < 0 && node.isText && node.text === "two") at = pos;
    });
    // A write with "Zq" typed in the list, from the text before the change.
    expect(serializeMarkdown(typedAt(was.doc, at, "Zq")!, was.source)).toBe("Intro.\n\n- one\n\n\n- Zqtwo\n\nEnd.\n");
    const next = parseMarkdown(after);
    const tr = new Transform(was.doc);
    const edit = editTo(tr, next, after)!;
    expect(tr.doc.child(1)).toBe(was.doc.child(1)); // the list kept
    // Typed in after the change: written from the new text's lines (before the fix, "- one\n\n- two- Zqtwo").
    expect(serializeMarkdown(typedAt(tr.doc, at, "Zq")!, edit.source)).toBe("Intro.\n\n- one\n\n- Zqtwo\n\nEnd.\n");
  });
});
