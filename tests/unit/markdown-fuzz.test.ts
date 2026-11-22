// Random documents and random formatting, with fixed seeds so a failure can
// be replayed (about thirty seconds in all; the time limits are for a busy
// machine): files built from awkward lines open and save byte for byte and
// show every word they hold; formatted text written by Corillo reads back
// with the same formatting. (From the review of 2026-11-09, where these found
// the problems fixed that night. The second review found failures just past
// counts cut to save time, so the counts are back up.)
import { describe, expect, it } from "vitest";
import { EditorState } from "prosemirror-state";
import { Fragment, type Mark, type Node } from "prosemirror-model";
import { isEmptyLine, parseMarkdown, serializeMarkdown, type Source } from "../../src/core/markdown";
import { schema } from "../../src/core/schema";
import { checkSave } from "../../src/core/write-check";

/** The safety net (roadmap Batch 14, item 1) lets the save through as written: a refusal or a repair here is a serializer bug. */
function netPasses(doc: Node, source: Source, out: string, what: string): void {
  expect(checkSave(doc, source), what).toEqual({ ok: true, text: out, repaired: 0 });
}

/** A repeatable stream of random numbers. */
function random(seed: number) {
  let s = seed >>> 0;
  return () => {
    s = (s * 1664525 + 1013904223) >>> 0;
    return s / 2 ** 32;
  };
}
const pick = <T>(r: () => number, xs: readonly T[]): T => xs[Math.floor(r() * xs.length)];

/** A file written afresh: no original blocks to keep. */
const fresh = (s?: Source): Source => ({ bom: s?.bom ?? false, eol: s?.eol ?? "\n", prefix: "", trailing: "", blocks: [], gaps: [], original: "" });

// Awkward lines: every kind of block, half-made blocks and Obsidian's syntax.
// Words are distinct animals, so a word missing from the page can be spotted.
const LINES = [
  "", "", "", "alpha", "bravo charlie", "- delta", "  - echo", "    - foxtrot", "1. golf", "2) hotel", "   india",
  "> juliet", "> > kilo", ">", "```", "```js", "~~~", "    lima", "\tmike", "# november", "## oscar ##", "===", "---",
  "***", "| papa | quebec |", "|---|---|", "| romeo | sierra |", "| tango | uniform | victor |", "whiskey | xray",
  "<div>", "</div>", "<!-- yankee -->", "<br>", "[^1]: zulu", "[^1]: aardvark", "    badger", "[ref]: https://example.com",
  "[ref]: <u> \"cheetah\"", "dingo[^1] eagle[ref] ferret", "- [ ] gibbon", "- [x] heron", "1. [ ] ibis", "%%",
  "%% jackal %%", "$$", "$$ koala $$", "[[Lemur]]", "![[marmot.png]]", "> [!note] Narwhal", "> - ocelot", "> ```",
  "- ```", "  ```", "- > puffin", "-", "1.", "+ quokka", "* rabbit", "  salmon", " ", "\\", "tapir\\", "urchin  ",
  "**viper**", "_walrus_ `xerus`", "![yak](zebu.png)", "<b>antelope</b> bison", "^[coyote]", "- [^1]: donkey",
  "> [ref]: /elk", "Falcon", ": gecko", "title: hippo", "...", "&#32;", "&#9;", "&#x20;",
];

function document(r: () => number, eols: boolean): string {
  const n = 1 + Math.floor(r() * 12);
  const lines: string[] = [];
  for (let i = 0; i < n; i++) lines.push(pick(r, LINES));
  if (!eols) return lines.join("\n") + "\n";
  const eol = r() < 0.2 ? "\r\n" : r() < 0.05 ? "\r" : "\n";
  return (r() < 0.05 ? "\uFEFF" : "") + lines.join(eol) + (r() < 0.7 ? eol : "");
}

describe("random files", () => {
  it("open and save byte for byte, whatever their line endings", () => {
    const r = random(7);
    for (let i = 0; i < 40000; i++) {
      const text = document(r, true);
      const { doc, source } = parseMarkdown(text);
      expect(serializeMarkdown(doc, source), JSON.stringify(text)).toBe(text);
      netPasses(doc, source, text, JSON.stringify(text));
    }
  }, 30_000);

  it("show every word they hold, and never turn whole into Markdown text", () => {
    const r = random(11);
    for (let i = 0; i < 30000; i++) {
      const text = document(r, false);
      const { doc, source } = parseMarkdown(text);
      const what = JSON.stringify(text);
      // The whole file as one block of text (with its final line break inside it) is the last-resort fallback.
      expect(source.blocks.length === 1 && source.blocks[0].text === text, what).toBe(false);
      const shown = doc.textBetween(0, doc.content.size, "\n", (leaf) => (leaf.type.name === "image" ? `${leaf.attrs.alt} ${leaf.attrs.src}` : " "));
      const missing = (text.match(/[a-z]{4,}/gi) ?? []).filter((w) => !shown.includes(w) && !["https", "example", "title"].includes(w));
      expect(missing, what).toEqual([]);
    }
  }, 30_000);
});

// Formatted text ----------------------------------------------------------------------

/** What a block says: each visible character with its formatting (and a link's address). */
function meaning(node: Node): string {
  let out = "";
  node.descendants((n) => {
    if (n.isText) {
      const sig = n.marks.map((m) => m.type.name + (m.attrs.href ? `(${m.attrs.href})` : "")).sort().join("+");
      for (const ch of n.text!) if (!/\s/.test(ch)) out += `${ch}{${sig}}`;
      else if (!out.endsWith(" ")) out += " ";
    } else if (n.isLeaf) out += `<${n.type.name}>`;
    else if (n.isBlock) out += `|${n.type.name}|`;
    return true;
  });
  return out.replace(/ +(\|)/g, "$1").replace(/(\|) +/g, "$1").trim();
}

const WORDS = ["a", "b", "word", "X", "é", "中", "1", "42"];
const PUNCT = ["(", ")", ",", ".", "!", "?", ":", ";", '"', "'", "-", "/"];
const SPECIAL = ["*", "_", "$", "[", "]", "<", ">", "&", "#", "~", "`", "|", "\\", "=", "%", "^", "+", "!", "{", "}", "@", "://", "www.", "&amp;", "<b>", "</b>", "<br>", "1.", "-", "--", "---", "==", "$$", "%%", "[[", "]]", "](", "![", "[^1]", ":", "  ", "\n", "\t"];
const MARK_SETS: (() => Mark[])[] = [
  () => [schema.marks.strong.create()],
  () => [schema.marks.em.create()],
  () => [schema.marks.em.create({ markup: "_" })],
  () => [schema.marks.strong.create({ markup: "__" })],
  () => [schema.marks.strike.create()],
  () => [schema.marks.code.create()],
  () => [schema.marks.link.create({ href: "https://x.com/a" })],
  () => [schema.marks.em.create(), schema.marks.strong.create()],
];

type Mode = "plain" | "marks" | "spaced";

/** A run of text pieces: words, punctuation and Markdown's signs, some formatted. */
function inline(r: () => number, mode: Mode): Node[] {
  const kids: Node[] = [];
  const n = 1 + Math.floor(r() * 6);
  for (let i = 0; i < n; i++) {
    let text = "";
    const len = 1 + Math.floor(r() * 4);
    for (let k = 0; k < len; k++) {
      const roll = r();
      if (mode === "marks") text += roll < 0.5 ? pick(r, WORDS) : roll < 0.75 ? " " : pick(r, PUNCT);
      else if (mode === "plain") text += roll < 0.35 ? pick(r, WORDS) : roll < 0.55 ? " " : roll < 0.65 ? pick(r, PUNCT) : pick(r, SPECIAL);
      else text += roll < 0.4 ? pick(r, WORDS) : roll < 0.5 ? pick(r, PUNCT) : pick(r, SPECIAL);
    }
    const marked = mode !== "plain" && r() < 0.5;
    if (mode === "spaced") {
      if (marked) {
        kids.push(schema.text(" "), schema.text(text.replace(/^\s+|\s+$/g, "") || "w", pick(r, MARK_SETS)()), schema.text(" "));
      } else kids.push(schema.text(text));
    } else kids.push(schema.text(text, marked ? pick(r, MARK_SETS)() : []));
  }
  return kids;
}

const oneLine = (kids: Node[]) => kids.map((n) => (n.isText ? schema.text(n.text!.replace(/\n/g, " "), n.marks) : n));
const WRAPPERS: [string, (kids: Node[]) => Node][] = [
  ["paragraph", (k) => schema.node("paragraph", null, k)],
  ["heading", (k) => schema.node("heading", { level: 2 }, oneLine(k))],
  ["list item", (k) => schema.node("bullet_list", null, [schema.node("list_item", null, [schema.node("paragraph", null, k)])])],
  ["quote", (k) => schema.node("blockquote", null, [schema.node("paragraph", null, k)])],
  [
    "table cell",
    (k) =>
      schema.node("table", null, [
        schema.node("table_row", null, [schema.node("table_header", null, [schema.text("h")]), schema.node("table_header", null, [schema.text("i")])]),
        schema.node("table_row", null, [schema.node("table_cell", null, oneLine(k)), schema.node("table_cell", null, [schema.text("z")])]),
      ]),
  ],
];

/**
 * Longer wrappers (review/make-better-3.md, row 25): a quote or a list item of
 * two or three paragraphs, one of them 300 to 600 characters (runs of text
 * added until it is that long, cut at about 700), so the writer works past
 * the last few hundred characters it keeps at hand and starts later
 * paragraphs on lines of their own.
 */
function longParagraphs(r: () => number, first: Node[], more: () => Node[]): Node[] {
  const target = 300 + Math.floor(r() * 300);
  const long: Node[] = [...first];
  let size = first.reduce((n, k) => n + k.nodeSize, 0);
  for (let added = true; size < target && added; ) {
    added = false;
    for (const k of more()) {
      if (size + k.nodeSize > 700) break;
      long.push(k);
      size += k.nodeSize;
      added = true;
    }
  }
  const paragraphs = [schema.node("paragraph", null, long), schema.node("paragraph", null, more())];
  if (r() < 0.4) paragraphs.push(schema.node("paragraph", null, more()));
  // The long one first, last or between.
  const at = Math.floor(r() * paragraphs.length);
  [paragraphs[0], paragraphs[at]] = [paragraphs[at], paragraphs[0]];
  return paragraphs;
}
const LONG_WRAPPERS: [string, (ps: Node[]) => Node][] = [
  ["quote of several paragraphs", (ps) => schema.node("blockquote", null, ps)],
  ["list item of several paragraphs", (ps) => schema.node("bullet_list", null, [schema.node("list_item", null, ps)])],
];

// Sentences as people write them, with formatting laid over random stretches
// of letters, so marks overlap, start and end inside words, and fall on part
// of some code or a link's words.
const SENTENCE = [
  "See", "Acme", "Corp.", "the", "plan", "for", "Q3", "is", "$5", "now", "or", "later", "50%", "npm", "test", "run", "it's", "(firm)",
  '"quoted"', "x_y", "a*b", "café", "中文", "—", "#tag", "[[Plan]]", "==hi==", "%%c%%", "$x$", "1.", "-", "end.", "!", "?",
  "https://x.com", "<b>", "a&b", "5$", "#", "~", "`", "a\\|b", "[1]",
];
const OVER: (() => Mark)[] = [
  () => schema.marks.em.create(),
  () => schema.marks.em.create({ markup: "_" }),
  () => schema.marks.strong.create(),
  () => schema.marks.strong.create({ markup: "__" }),
  () => schema.marks.strike.create(),
  () => schema.marks.code.create(),
  () => schema.marks.link.create({ href: "https://x.com/a" }),
  () => schema.marks.link.create({ href: "https://y.com/b" }),
];

function sentence(r: () => number): Node[] {
  let text = "";
  for (let i = 0, n = 2 + Math.floor(r() * 8); i < n; i++) text += (i && r() < 0.85 ? " " : "") + pick(r, SENTENCE);
  const marks: (readonly Mark[])[] = Array.from({ length: text.length }, () => []);
  for (let j = 0, k = 1 + Math.floor(r() * 4); j < k; j++) {
    const from = Math.floor(r() * text.length);
    const to = Math.min(text.length, from + 1 + Math.floor(r() * 12));
    const mark = pick(r, OVER)();
    for (let c = from; c < to; c++) marks[c] = mark.addToSet(marks[c]);
  }
  const kids: Node[] = [];
  for (let c = 0; c < text.length; ) {
    let e = c + 1;
    while (e < text.length && marks[e].length === marks[c].length && marks[e].every((m, i) => m.eq(marks[c][i]))) e++;
    kids.push(schema.text(text.slice(c, e), marks[c]));
    c = e;
  }
  return kids;
}

/**
 * Set aside by name: an empty or blank paragraph inside a quote or list item
 * (beside other blocks there) isn't written, since Markdown keeps no empty
 * paragraph there; it is spacing, which the safety net doesn't count. The
 * page as Markdown can hold it is the page without them.
 */
function withoutBlankLinesInside(node: Node): Node {
  if (node.isTextblock || node.isLeaf) return node;
  const kids: Node[] = [];
  node.forEach((c) => kids.push(withoutBlankLinesInside(c)));
  let keep = kids;
  if (node.type.name === "blockquote" || node.type.name === "list_item") {
    const written = (c: Node) => c.content.content.some((t) => t.marks.some((m) => m.type.name === "code" || m.type.name === "link"));
    const blank = (c: Node) => isEmptyLine(c) && !written(c);
    keep = kids.filter((c, k) => !blank(c) || (k === 0 && node.attrs.checked != null));
    if (!keep.length) keep = [kids[0]];
  }
  return node.copy(Fragment.fromArray(keep));
}

/** Write random formatted blocks afresh, read them back, write and read again: the same each time. */
function formattedRoundTrips(mode: Mode | "sentences", seeds: number, long = false): string[] {
  const failures: string[] = [];
  const kinds = (d: Node) => {
    const k: string[] = [];
    d.forEach((c) => k.push(c.type.name));
    return k.join(",");
  };
  for (let seed = 1; seed <= seeds; seed++) {
    const r = random(seed);
    let name: string;
    let block: Node;
    try {
      if (long) {
        const run = () => (mode === "sentences" ? sentence(r) : inline(r, mode));
        const [called, wrap] = pick(r, LONG_WRAPPERS);
        name = called;
        block = wrap(longParagraphs(r, run(), run));
      } else if (mode === "sentences") {
        const kids = sentence(r);
        const [called, wrap] = pick(r, WRAPPERS);
        name = called;
        block = wrap(kids);
      } else {
        const [called, wrap] = pick(r, WRAPPERS);
        name = called;
        block = wrap(inline(r, mode));
      }
      block.check();
    } catch {
      continue; // (formatting a heading can't hold)
    }
    const doc0 = schema.node("doc", null, [block]);
    const out0 = serializeMarkdown(doc0, fresh());
    const doc1 = parseMarkdown(out0).doc;
    const out1 = serializeMarkdown(doc1, fresh());
    const doc2 = parseMarkdown(out1).doc;
    const net = checkSave(doc0, fresh());
    let why = "";
    if (!net.ok) why = `the safety net refused it, losing ${JSON.stringify(net.lost)}`;
    else if (net.repaired || net.text !== out0) why = "the safety net repaired it";
    if (why) {
      // (said above)
    } else if (kinds(doc0) !== kinds(doc1)) why = `blocks ${kinds(doc0)} became ${kinds(doc1)}`;
    else if (meaning(withoutBlankLinesInside(doc0)) !== meaning(doc1)) why = "reads back differently";
    else if (meaning(doc1) !== meaning(doc2)) why = "changes when written again";
    if (why) failures.push(`seed ${seed}, ${name}: ${why}; wrote ${JSON.stringify(out0)}`);
  }
  return failures;
}

describe("random formatted text, written and read back", () => {
  it("keeps plain text full of Markdown's signs as text", () => {
    const failed = formattedRoundTrips("plain", 40000);
    expect(failed.length, failed.slice(0, 12).join("\n")).toBe(0);
  }, 30_000);

  it("keeps bold, italic and struck text touching letters and punctuation", () => {
    const failed = formattedRoundTrips("marks", 30000);
    expect(failed.length, failed.slice(0, 12).join("\n")).toBe(0);
  }, 30_000);

  it("keeps formatting beside $, %% and Markdown's other signs", () => {
    const failed = formattedRoundTrips("spaced", 60000);
    expect(failed.length, failed.slice(0, 12).join("\n")).toBe(0);
  }, 30_000);

  it("keeps formatting laid over any stretch of a sentence, code and links included", () => {
    const failed = formattedRoundTrips("sentences", 30000);
    expect(failed.length, failed.slice(0, 12).join("\n")).toBe(0);
  }, 30_000);
});

// The longer wrappers (row 25), turned on in Batch 23 once the faults they
// found were fixed (row 61, R22-14): a "$" beside code or a link, a list
// item whose first line is blank, "<1@a>". Counts chosen to add about ten
// seconds to the unit suite on a quiet Mac; each mode was run to 20,000
// seeds clean when they were turned on.
describe("random formatted text in a quote or list item of several paragraphs, one long, written and read back", () => {
  for (const [mode, seeds] of [
    ["plain", 6000],
    ["marks", 2000],
    ["spaced", 2000],
    ["sentences", 1500],
  ] as const) {
    it(`keeps ${mode === "sentences" ? "formatted sentences" : `${mode} text`} as written`, () => {
      const failed = formattedRoundTrips(mode, seeds, true);
      expect(failed.length, failed.slice(0, 12).join("\n")).toBe(0);
    }, 60_000);
  }
});

// Empty lines (Orlando, 2026-11-09: "An empty line in markdown doc should show
// up as an empty line in word") ---------------------------------------------------------

/**
 * A document's top-level blocks as the file holds them: each block's kind and
 * words, "empty" for an empty line. Empty lines after the last words, or
 * before front matter, aren't written, so they're left out.
 */
function shape(doc: Node): string[] {
  const out: string[] = [];
  doc.forEach((n) => out.push(isEmptyLine(n) ? "empty" : `${n.type.name === "raw_block" ? `raw:${n.attrs.kind}` : n.type.name}:${n.textContent}`));
  while (out.length && out[out.length - 1] === "empty") out.pop();
  const first = out.findIndex((s) => s !== "empty");
  if (first > 0 && out[first].startsWith("raw:front-matter")) out.splice(0, first);
  return out;
}

const startOf = (doc: Node, k: number) => {
  let at = 0;
  for (let i = 0; i < k; i++) at += doc.child(i).nodeSize;
  return at;
};

describe("random empty lines", () => {
  it("added and taken away anywhere, are written as blank lines and read back the same", () => {
    const r = random(23);
    let checked = 0;
    for (let i = 0; i < 8000; i++) {
      const text = document(r, true);
      const { doc, source } = parseMarkdown(text);
      let state = EditorState.create({ doc });
      const steps = 1 + Math.floor(r() * 3);
      // Known limits, where a block's lines only read as they do beside the
      // lines around them: a list item that opens a code block and never
      // closes it ("- ```") takes blank lines written under it into its code;
      // lines kept as link or note definitions can read as something else once
      // apart from the definition above them. (Their words still all show.)
      let contextual = /^﻿?(- |  )(```|~~~)/m.test(text);
      doc.forEach((n) => {
        if (n.type.name === "raw_block" && (n.attrs.kind === "links" || n.attrs.kind === "definitions")) contextual = true;
      });
      for (let s = 0; s < steps; s++) {
        const d = state.doc;
        const empties: number[] = [];
        d.forEach((n, _, k) => {
          if (isEmptyLine(n)) empties.push(k);
        });
        if (empties.length && r() < 0.45) {
          const k = pick(r, empties);
          if (d.childCount === 1) continue;
          state = state.apply(state.tr.delete(startOf(d, k), startOf(d, k) + d.child(k).nodeSize));
        } else {
          const k = Math.floor(r() * (d.childCount + 1));
          const n = 1 + Math.floor(r() * 2);
          state = state.apply(state.tr.insert(startOf(d, k), Array.from({ length: n }, () => schema.node("paragraph"))));
        }
      }
      const out = serializeMarkdown(state.doc, source);
      const what = `${JSON.stringify(text)} became ${JSON.stringify(out)}`;
      netPasses(state.doc, source, out, what);
      const again = parseMarkdown(out);
      expect(serializeMarkdown(again.doc, again.source), what).toBe(out);
      const shown = again.doc.textBetween(0, again.doc.content.size, "\n", (leaf) => (leaf.type.name === "image" ? `${leaf.attrs.alt} ${leaf.attrs.src}` : " "));
      const missing = (out.match(/[a-z]{4,}/gi) ?? []).filter((w) => !shown.includes(w) && !["https", "example", "title"].includes(w));
      expect(missing, what).toEqual([]);
      if (contextual) continue;
      expect(shape(again.doc), what).toEqual(shape(state.doc));
      checked++;
    }
    expect(checked).toBeGreaterThan(5000);
  }, 30_000);

  it("in a new document, between blocks of every kind, read back the same", () => {
    const r = random(29);
    const p = (t: string) => schema.node("paragraph", null, [schema.text(t)]);
    const item = (t: string) => schema.node("list_item", null, [p(t)]);
    const MAKERS: (() => Node)[] = [
      () => p("alpha"),
      () => p("bravo charlie"),
      () => schema.node("heading", { level: 2 }, [schema.text("delta")]),
      () => schema.node("bullet_list", { bullet: "-" }, [item("echo"), item("foxtrot")]),
      () => schema.node("bullet_list", { bullet: "*" }, [item("golf")]),
      () => schema.node("ordered_list", { delim: "." }, [item("hotel")]),
      () => schema.node("ordered_list", { delim: ")" }, [item("india"), item("juliet")]),
      () => schema.node("blockquote", null, [p("kilo")]),
      () => schema.node("code_block", null, [schema.text("lima")]),
      () => schema.node("horizontal_rule"),
      () => WRAPPERS[4][1]([schema.text("mike")]),
    ];
    for (let i = 0; i < 6000; i++) {
      const kids: Node[] = [];
      const n = 1 + Math.floor(r() * 9);
      for (let k = 0; k < n; k++) {
        if (r() < 0.4) {
          kids.push(schema.node("paragraph"));
          continue;
        }
        const block = pick(r, MAKERS)();
        const prev = kids[kids.length - 1];
        // (Two lists of the same kind side by side are one list, as Word joins them.)
        if (prev && prev.type === block.type && prev.attrs.bullet === block.attrs.bullet && prev.attrs.delim === block.attrs.delim && /list/.test(block.type.name)) continue;
        kids.push(block);
      }
      const doc = schema.node("doc", null, kids);
      const out = serializeMarkdown(doc, fresh());
      const again = parseMarkdown(out);
      const what = JSON.stringify(out);
      netPasses(doc, fresh(), out, what);
      expect(shape(again.doc), what).toEqual(shape(doc));
      expect(serializeMarkdown(again.doc, again.source), what).toBe(out);
    }
  }, 30_000);
});

// Review R-EL-5: lists and quotes with blank lines between some of their parts
// and not others. Typing in one part rewrites that part's line only: no blank
// line comes or goes anywhere else, so the page doesn't jump either.
function spacedContainer(r: () => number, words: () => string, depth: number): string[] {
  const kind = pick(r, depth === 0 ? ["-", "1.", ">"] : ["-", "1.", ">"]);
  const para = () => (r() < 0.25 ? [words(), words()] : [words()]);
  if (kind === ">") {
    const out: string[] = [];
    const n = 1 + Math.floor(r() * 3);
    for (let i = 0; i < n; i++) {
      const nested = depth < 2 && r() < 0.35;
      const part = nested ? spacedContainer(r, words, depth + 1) : para();
      // Straight under a paragraph only what can start there: a list or a quote.
      if (i > 0 && (!nested || r() < 0.5)) out.push("");
      out.push(...part);
    }
    return out.map((l) => (l ? `> ${l}` : ">"));
  }
  const out: string[] = [];
  const n = 2 + Math.floor(r() * 3);
  for (let i = 0; i < n; i++) {
    const marker = kind === "-" ? "- " : `${i + 1}. `;
    const indent = " ".repeat(marker.length);
    if (i > 0 && r() < 0.5) out.push("");
    const lines = para();
    const more = depth < 2 ? Math.floor(r() * 3) : 0;
    for (let m = 0; m < more; m++) {
      const nested = r() < 0.6;
      if (!nested || r() < 0.5) lines.push("");
      lines.push(...(nested ? spacedContainer(r, words, depth + 1) : para()));
    }
    out.push(...lines.map((l, j) => (j === 0 ? marker + l : l ? indent + l : "")));
  }
  return out;
}

describe("typing in lists and quotes spaced in places", () => {
  it("rewrites only the line typed on: no blank line comes or goes anywhere else, and the file reads back as the page", () => {
    const r = random(41);
    let checked = 0;
    for (let i = 0; i < 1500; i++) {
      let w = 0;
      const lines = spacedContainer(r, () => `w${++w}`, 0);
      const text = `Intro.\n\n${lines.join("\n")}\n\nEnd.\n`;
      const { doc, source } = parseMarkdown(text);
      expect(serializeMarkdown(doc, source)).toBe(text);
      const ends: number[] = [];
      doc.descendants((node, pos) => {
        if (node.type.name === "paragraph" && node.content.size) ends.push(pos + node.nodeSize - 1);
        return !node.isTextblock;
      });
      for (const end of ends) {
        const state = EditorState.create({ doc });
        const typed = state.apply(state.tr.insertText("x", end)).doc;
        const out = serializeMarkdown(typed, source);
        const what = `${JSON.stringify(text)} typed at ${end}: ${JSON.stringify(out)}`;
        netPasses(typed, source, out, what);
        const before = text.split("\n");
        const after = out.split("\n");
        expect(after.length, what).toBe(before.length);
        const changed = after.flatMap((l, k) => (l === before[k] ? [] : [k]));
        expect(changed.length, what).toBe(1);
        expect(after[changed[0]], what).toBe(`${before[changed[0]]}x`);
        expect(parseMarkdown(out).doc.eq(typed), what).toBe(true);
        checked++;
      }
    }
    expect(checked).toBeGreaterThan(6000);
  }, 30_000);
});

// Blocks written as Corillo itself wouldn't write them (a table with no
// padding, a "* * *" rule, a heading underlined with "===", code indented by
// four spaces), one of them moved, taken out or typed in, as the editor does
// it (review R-5). The file read again is the page, and every block nobody
// edited, the moved one too, is in the file as it was written: except code
// indented under a list, which would read as part of the list (R-3).
describe("random documents with a block moved, taken out or typed in", () => {
  const CODE = "    total = a + b\n    # not a heading";
  const BLOCKS = [
    "Status report\n=============",
    "First paragraph, with an R&amp;D note.",
    "| Item | Cost |\n|---|---|\n| Venue | 1,200 |\n| Catering | 800 |",
    "* * *",
    "*   one\n*   two",
    "3) third\n4) fourth",
    "> quoted line\ncontinues here",
    CODE,
    "~~~\nfenced = True\n~~~",
    "Line one  \nline two",
    "## Closing ##",
    "A plain paragraph of words.",
    "Another paragraph, with *emphasis* and __strong__ words.",
  ];
  const shape = (doc: Node): string[] => {
    const out: string[] = [];
    doc.forEach((n) => out.push(`${n.type.name}: ${JSON.stringify(n.textContent)}`));
    return out;
  };

  it("read back as the page, with every block nobody edited as it was written", () => {
    const r = random(5);
    let checked = 0;
    for (let round = 0; round < 600; round++) {
      const blocks = [...BLOCKS].sort(() => r() - 0.5).slice(0, 6 + Math.floor(r() * 5));
      const text = blocks.join("\n\n") + "\n";
      const { doc, source } = parseMarkdown(text);
      // Only documents that read as these blocks, one each (code indented under a list is part of the list).
      if (doc.childCount !== blocks.length) continue;
      const at: number[] = [];
      doc.forEach((_n, pos) => at.push(pos));
      const i = Math.floor(r() * blocks.length);
      const node = doc.child(i);
      const tr = EditorState.create({ doc }).tr;
      let order = blocks.map((_b, k) => k);
      let what: string;
      const kind = Math.floor(r() * 3);
      if (kind === 0) {
        // Moved whole, as a drop does it: taken out, then the very same block put in at another place.
        let j = Math.floor(r() * blocks.length);
        if (j === i) j = (j + 1) % blocks.length;
        tr.delete(at[i], at[i] + node.nodeSize);
        tr.insert(tr.mapping.map(at[j], -1), node);
        order = order.filter((k) => k !== i);
        order.splice(order.indexOf(j), 0, i);
        what = `block ${i + 1} moved above block ${j + 1}`;
      } else if (kind === 1) {
        tr.delete(at[i], at[i] + node.nodeSize);
        order = order.filter((k) => k !== i);
        what = `block ${i + 1} taken out`;
      } else {
        if (node.type.name !== "paragraph") continue;
        tr.insertText("x", at[i] + 1);
        what = `"x" typed in block ${i + 1}`;
      }
      const page = tr.doc;
      const saved = serializeMarkdown(page, source);
      const said = `${what} of ${JSON.stringify(text)}:\n${saved}`;
      netPasses(page, source, saved, said);
      expect(shape(parseMarkdown(saved).doc), said).toEqual(shape(page));
      for (const [n, k] of order.entries()) {
        if (kind === 2 && k === i) continue; // typed in
        if (blocks[k] === CODE && n > 0 && /^(?:\*|\d+\))/.test(blocks[order[n - 1]])) continue;
        expect(`\n${saved}`, said).toContain(`\n${blocks[k]}\n`);
      }
      checked++;
    }
    expect(checked).toBeGreaterThan(300);
  });
});
