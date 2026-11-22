// Corillo never quietly changes a file. A document opened and saved without
// edits comes back byte for byte; an edit changes only the edited block, and
// the file reads back as what the person sees in the editor.
import { describe, expect, it } from "vitest";
import { EditorState } from "prosemirror-state";
import type { Node } from "prosemirror-model";
import { isEmptyLine, parseMarkdown, serializeMarkdown } from "../../src/core/markdown";
import { schema } from "../../src/core/schema";
import { meaningOf } from "../../src/core/write-check";

const BOM = "\uFEFF";
const EM_DASH = String.fromCharCode(0x2014);

// Documents of every kind the brief lists, each kept exactly.
const tricky: Record<string, string> = {
  "Windows line endings": "# Title\r\n\r\nLine one\r\nline two\r\n\r\n| a | b |\r\n|---|---|\r\n| 1 | 2 |\r\n",
  "old Mac line endings": "# Title\r\rText\rmore\r",
  "mixed line endings": "a\r\nb\nc\rd\n\ne\n",
  "a byte-order mark with Windows line endings": `${BOM}# T\r\n\r\nText\r\n`,
  "no newline at the end": "# T\n\nThe last line",
  "trailing spaces and hard breaks": "Two spaces  \nbackslash\\\nend   \n\nTrailing   \n",
  tabs: "-\ttab bullet\n\n\tcode with a tab\n\nText\twith\ttabs\n",
  "a very long line": "word ".repeat(40000) + "\n",
  "non-Latin scripts and emoji": "Привет мир\n\n日本語のテキスト、한국어\n\n🐸 coquí 👨‍👩‍👧 👍🏽\n",
  "right-to-left text": "שלום עולם\n\nمرحبا بالعالم\n\n- עברית ו-English\n",
  "setext headings": "Title\n=====\n\nSub\n---\n\nText\n",
  "indented code": "Para\n\n    code line\n      more\n\nAfter\n",
  "nested lists with mixed markers": "- a\n  * b\n    + c\n- d\n\n1. x\n   - y\n2) z\n",
  "loose and tight lists": "- a\n\n- b\n\n  more b\n\n- c\n\n* t1\n* t2\n",
  "HTML blocks and comments": "<!-- note -->\n\n<div align=\"center\">\n<img src=\"x.png\">\n</div>\n\n<details>\n<summary>S</summary>\n\nInner *md*\n\n</details>\n",
  "front matter": "---\ntitle: x\ntags: [a, b]\n---\n\n# H\n\nBody\n",
  "front matter only": "---\ntitle: x\n---\n",
  "reference links and definitions": "See [the site][site], [other] and ![logo][img].\n\n[site]: https://example.com \"Title\"\n[other]: <https://o.example/a b>\n[img]: logo.png\n",
  "footnotes with several paragraphs": "Text[^n] and[^m].\n\n[^n]: First para.\n\n    Second para.\n\n    ```\n    code\n    ```\n[^m]: Simple.\n",
  "tables with escaped pipes and code with pipes": "| a | b |\n|:--|--:|\n| x \\| y | `a\\|b` |\n| `c|d` | e |\n",
  "Mermaid diagrams": "```mermaid\ngraph TD\n  A-->B\n```\n\nText\n",
  "dollar signs": "Price $5 and $10, math $x^2$ and $$\\int$$\n\n$$\na = b\n$$\n",
  "smart quotes and dashes": `\u201cQuoted\u201d and \u2018single\u2019 ${EM_DASH} dash\u2026\n`,
  entities: "&amp; &copy; &#35; &nbsp;x\n",
  "an empty file": "",
  "only blank lines": "\n\n  \n",
  // Empty lines (2026-11-09): each blank line beyond the one between two blocks is an empty line.
  "empty lines": "\n\n# Title\n\n\n\nText\n \n\t\n  \nMore\n\n\n- a\n\n\n\n> q\n\n\n",
  "empty lines with Windows line endings": "A\r\n\r\n\r\n\r\nB\r\n \r\n\r\nC",
  // (Found by the fuzz past its old count: a list whose only item is empty ends at the blank lines after it.)
  "an empty list item, empty lines, then a list": "-\n\n\n- a\n\n1.\n\n \n1. b\n",
  // (Review R-EL-6: a paragraph of a space written as a character reference is a paragraph, not an empty line.)
  "paragraphs of a space written as a character reference": "A\n\n&#32;\n\nB\n\n&#9;\n\n&#x20;\n\n\n&#32;\n",
};

function roundTrip(text: string): string {
  const { doc, source } = parseMarkdown(text);
  return serializeMarkdown(doc, source);
}

describe("opening and saving without edits", () => {
  for (const [name, text] of Object.entries(tricky)) {
    it(`keeps ${name} byte for byte`, () => {
      expect(roundTrip(text)).toBe(text);
    });
  }
});

// Generated documents ------------------------------------------------------------

const BLOCKS = [
  "# Heading one",
  "## Heading *two* with `code`",
  "Title\n=====",
  "Sub\n---",
  "A paragraph with **bold**, _em_, ~~gone~~, `code` and a [link](https://x.com \"t\").",
  "Line one\nline two\nline three",
  "Trailing spaces  \nhard break\\\nend",
  "Price $5 and $10; math $x^2$.",
  `\u201cSmart\u201d \u2018quotes\u2019 ${EM_DASH} dashes\u2026`,
  "Привет мир, 日本語, 한국어, 🐸 coquí",
  "שלום עולם and مرحبا",
  "Text\twith\ttabs",
  "- a\n- b\n- c",
  "* star\n* star two\n  - nested dash\n    + deeper plus",
  "1. one\n2. two\n   - mixed\n3. three",
  "3) three\n4) four",
  "- loose a\n\n- loose b\n\n  second para",
  "> quoted\n> more",
  "> - quoted list\n> - two",
  "```js\nconst a = 1;\n\nconst b = 2;\n```",
  "~~~\ntilde fence\n~~~",
  "```mermaid\ngraph TD\n  A-->B\n```",
  "    indented code\n    more",
  "<!-- a comment -->",
  "<div align=\"center\">\n  <b>hi</b>\n</div>",
  "Inline <span>html</span> here",
  "| a | b |\n|:--|--:|\n| 1 | 2 |",
  "| pipe | code |\n|---|---|\n| x \\| y | `a\\|b` |",
  "Note[^1] and other[^long].",
  "[^1]: The note.",
  "[^long]: First para.\n\n    Second para.",
  "See [the site][site].",
  "[site]: https://example.com \"Title\"",
  "> [quoted]: https://q.example\n> uses [quoted]",
  "- [ ] task\n- [x] done",
  "***",
  "- - -",
  "x ".repeat(2000).trim(),
  "&amp; &copy; entities",
  "\\*not em\\* and \\# not heading",
  "![alt *x*](pic.png 'single') picture",
  "Visit <https://auto.link> now",
  // Obsidian's syntax
  "See [[Ana López]], [[Team/Marcus|Marcus]] and [[Q2#^key|numbers]].",
  "![[chart.png|300]] and ![[Q2 review]]",
  "Budget is ==tight== and **==firm==**, #planning #team/x_y",
  "An %%inline [x] *comment*%% and $r = \\frac{a_1}{b}$ and $$\\int x$$.",
  "> [!note] Title\n> Body line\n> more body",
  "> [!tip]- Folded\n> > [!todo] Nested",
  "%%\nBlock comment\n\nover paragraphs\n%%",
  "$$\n\\begin{x}a\\\\\nb\\end{x}\n$$",
  "A paragraph with a block id ^abc-123",
];

// Text typed into a block: plain words, and things that look like Markdown.
const TYPED = [
  "Z", " ", "a b", "🐸", "שלום", "*", "_", "`", "[", "]", "#", "\\", "|", "~~", "$", "<b>", "![", "&amp;", "&copy;",
  "1. ", "1) ", "- ", "+ ", "> ", "---", "===", "# x", " #", "```", "~~~", "[x]: y", "[^1]: n", "<!-- c -->",
  "| a | b |", "--|--", "+", "1.", "-", "    code", "\t", "**", "__x__", "x_", "_x", "*x*", "](x)", "[a](b)",
  "[[x]]", "![[y.png]]", "[[", "]]", "==", "==h==", "%%", "%%c%%", "$x$", "$$", "#tag", "^id", "[!note] ", "\\$",
];

/** A repeatable stream of random numbers, so a failure can be replayed. */
function random(seed: number) {
  let s = seed >>> 0;
  return () => {
    s = (s * 1664525 + 1013904223) >>> 0;
    return s / 2 ** 32;
  };
}

function generate(r: () => number): string {
  const parts: string[] = [];
  if (r() < 0.15) parts.push("---\ntitle: Generated\ntags: [a, b]\n---");
  const n = 1 + Math.floor(r() * 8);
  for (let i = 0; i < n; i++) parts.push(BLOCKS[Math.floor(r() * BLOCKS.length)]);
  let text = parts[0];
  for (let i = 1; i < parts.length; i++) {
    const g = r();
    text += (g < 0.55 ? "\n\n" : g < 0.7 ? "\n" : g < 0.85 ? "\n\n\n" : g < 0.9 ? "\n\n\n\n\n" : g < 0.95 ? "\n \n" : "\n\t\n  \n") + parts[i];
  }
  const t = r();
  text += t < 0.6 ? "\n" : t < 0.8 ? "" : "\n\n";
  if (r() < 0.3) text = text.replace(/\n/g, "\r\n");
  if (r() < 0.1) text = BOM + text;
  if (r() < 0.1) text = "\n" + text;
  return text;
}

/** Every place the cursor can be inside the k-th block. */
function cursorPlaces(doc: Node, k: number): number[] {
  let start = 0;
  for (let i = 0; i < k; i++) start += doc.child(i).nodeSize;
  const block = doc.child(k);
  const places: number[] = [];
  if (block.isTextblock) {
    for (let p = 0; p <= block.content.size; p++) places.push(start + 1 + p);
    return places;
  }
  block.descendants((node, pos) => {
    if (node.isTextblock) for (let p = 0; p <= node.content.size; p++) places.push(start + 1 + pos + 1 + p);
    return true;
  });
  return places;
}

/**
 * What the document means, leaving out what Markdown can't hold or that
 * Corillo chooses when writing: spaces at the ends of lines, a line break
 * with nothing after it, the length of a code fence, "*" in place of "_", "[words][]" for "[words]".
 */
function meaning(json: any): any {
  if (json.attrs) {
    // (toJSON hands back the node's own attributes, which nodes can share: copy before changing.)
    json.attrs = { ...json.attrs };
    delete json.attrs.fence;
    // (A line break in a table cell reads back knowing it was written "<br>".)
    if (json.type === "em" || json.type === "strong" || json.type === "hard_break") delete json.attrs.markup;
    // (A link by reference may be written "[words][]" for "[words]" where what follows would change it.)
    if (json.type === "link" || json.type === "image") delete json.attrs.refForm;
  }
  for (const mark of json.marks ?? []) meaning(mark);
  if (!Array.isArray(json.content)) return json;
  json.content = json.content.map(meaning);
  const inline = json.content.every((c: any) => ["text", "image", "hard_break", "footnote_ref"].includes(c.type));
  if (!inline) return json;
  // Spaces at the edges of bold or italic text are written just outside it.
  const parts: any[] = [];
  for (const c of json.content) {
    const styled = c.type === "text" && c.marks?.length && !c.marks.some((m: any) => m.type === "code");
    const m = styled ? /^(\s*)([\s\S]*?)(\s*)$/.exec(c.text) : null;
    if (!m) {
      parts.push(c);
      continue;
    }
    if (m[1]) parts.push({ type: "text", text: m[1] });
    if (m[2]) parts.push({ ...c, text: m[2] });
    if (m[3]) parts.push({ type: "text", text: m[3] });
  }
  for (let i = 0; i < parts.length; i++) {
    const c = parts[i];
    if (c.type !== "text") continue;
    const lineStart = i === 0 || parts[i - 1].type === "hard_break";
    const lineEnd = i === parts.length - 1 || parts[i + 1].type === "hard_break";
    if (lineStart) c.text = c.text.replace(/^\s+/, "");
    if (lineEnd) c.text = c.text.replace(/\s+$/, "");
  }
  let kept = parts.filter((c: any) => c.type !== "text" || c.text !== "");
  while (kept.length && kept[kept.length - 1].type === "hard_break") kept.pop();
  const join = (list: any[]) => {
    const out: any[] = [];
    for (const c of list) {
      const prev = out[out.length - 1];
      if (prev?.type === "text" && c.type === "text" && JSON.stringify(prev.marks ?? []) === JSON.stringify(c.marks ?? [])) {
        prev.text += c.text;
      } else out.push(c);
    }
    return out;
  };
  let merged = join(kept);
  // A line break inside a paragraph: spaces around it aren't kept, nor is an
  // empty line, nor one at the paragraph's start or end or next to a hard break.
  for (const c of merged) if (c.type === "text") c.text = c.text.replace(/[ \t]*\n[ \t\n]*/g, "\n");
  for (let i = 0; i < merged.length; i++) {
    const c = merged[i];
    if (c.type !== "text") continue;
    const prev = merged[i - 1];
    const next = merged[i + 1];
    if (!prev || prev.type === "hard_break" || (prev.type === "text" && prev.text.endsWith("\n"))) c.text = c.text.replace(/^\n+/, "");
    if (!next || next.type === "hard_break") c.text = c.text.replace(/\n+$/, "");
    if (next?.type === "text" && next.text.startsWith("\n")) c.text = c.text.replace(/[ \t]+$/, "");
  }
  merged = join(merged.filter((c: any) => c.type !== "text" || c.text !== ""));
  json.content = merged;
  if (!merged.length) delete json.content;
  return json;
}

const sameMeaning = (a: Node, b: Node) => JSON.stringify(meaning(a.toJSON())) === JSON.stringify(meaning(b.toJSON()));

describe("many generated documents", () => {
  it("open and save byte for byte", () => {
    const r = random(1);
    for (let i = 0; i < 1500; i++) {
      const text = generate(r);
      expect(roundTrip(text), JSON.stringify(text)).toBe(text);
    }
  });

  it("an edit in one block leaves every other byte alone and reads back as typed", () => {
    const r = random(2);
    let edits = 0;
    for (let i = 0; i < 1500; i++) {
      const text = generate(r);
      const { doc, source } = parseMarkdown(text);
      const k = Math.floor(r() * doc.childCount);
      const places = cursorPlaces(doc, k);
      if (!places.length) continue;
      const pos = places[Math.floor(r() * places.length)];
      const typed = TYPED[Math.floor(r() * TYPED.length)];
      const state = EditorState.create({ doc });
      const $pos = state.doc.resolve(pos);
      const tr = state.tr;
      if (r() < 0.3 && $pos.parent.canReplaceWith($pos.index(), $pos.index(), schema.nodes.hard_break)) {
        tr.insert(pos, schema.nodes.hard_break.create()).insertText(typed, pos + 1);
      } else tr.insertText(typed, pos);
      const edited = tr.doc;
      const out = serializeMarkdown(edited, source);
      const what = `typing ${JSON.stringify(typed)} into block ${k} of ${JSON.stringify(text)}`;

      // Every byte outside the edited block is as it was.
      const before =
        (source.bom ? BOM : "") + source.prefix + source.blocks.slice(0, k).map((b, j) => b.text + source.gaps[j]).join("");
      // (Words typed on an empty line make it a paragraph, which Markdown keeps
      // apart from the block under it with a blank line: that one line is
      // added. Changed 2026-11-09 with empty lines.)
      const typedOnEmptyLine = isEmptyLine(doc.child(k)) && !isEmptyLine(edited.child(k));
      const after =
        source.blocks
          .slice(k + 1)
          .map((b, j) => (j === 0 && typedOnEmptyLine ? source.eol + source.eol : source.gaps[k + j]) + b.text)
          .join("") + source.trailing;
      expect(out.startsWith(before), what).toBe(true);
      expect(out.endsWith(after), what).toBe(true);

      // The edited block keeps the file's line endings.
      const block = out.slice(before.length, out.length - after.length);
      if (source.eol === "\r\n") expect(/(^|[^\r])\n/.test(block), what).toBe(false);

      // Reading the file again gives what the editor showed.
      if (doc.child(k).type.name !== "raw_block") {
        expect(sameMeaning(parseMarkdown(out).doc, edited), `${what}\nwrote ${JSON.stringify(block)}`).toBe(true);
      }
      edits++;
    }
    expect(edits).toBeGreaterThan(1000);
  });
});

// Empty lines (Orlando, 2026-11-09: "An empty line in markdown doc should show up
// as an empty line in word") ---------------------------------------------------------

/** The top-level blocks as the file holds them: kind and words, or "empty" for an empty line (none after the last words). */
function blocksOf(doc: Node): string[] {
  const out: string[] = [];
  doc.forEach((n) => out.push(isEmptyLine(n) ? "empty" : `${n.type.name === "raw_block" ? `raw:${n.attrs.kind}` : n.type.name}:${n.textContent}`));
  while (out.length && out[out.length - 1] === "empty") out.pop();
  const first = out.findIndex((s) => s !== "empty");
  if (first > 0 && out[first].startsWith("raw:front-matter")) out.splice(0, first);
  return out;
}

describe("many generated documents with empty lines added and taken away", () => {
  it("read back as the same blocks and empty lines, every block's text unchanged", () => {
    const r = random(3);
    const startOf = (doc: Node, k: number) => {
      let at = 0;
      for (let i = 0; i < k; i++) at += doc.child(i).nodeSize;
      return at;
    };
    for (let i = 0; i < 1500; i++) {
      const text = generate(r);
      // (Skipped: a byte-order mark after a blank line, which the generator
      // sometimes makes, would start the file once that line goes.)
      if (text.indexOf(BOM) > 0) continue;
      const { doc, source } = parseMarkdown(text);
      const tr = EditorState.create({ doc }).tr;
      const steps = 1 + Math.floor(r() * 3);
      for (let s = 0; s < steps; s++) {
        const d = tr.doc;
        const empties: number[] = [];
        d.forEach((n, _, k) => {
          if (isEmptyLine(n)) empties.push(k);
        });
        if (empties.length && d.childCount > 1 && r() < 0.45) {
          const k = empties[Math.floor(r() * empties.length)];
          tr.delete(startOf(d, k), startOf(d, k) + d.child(k).nodeSize);
        } else {
          const k = Math.floor(r() * (d.childCount + 1));
          tr.insert(startOf(d, k), Array.from({ length: 1 + Math.floor(r() * 2) }, () => schema.node("paragraph")));
        }
      }
      const out = serializeMarkdown(tr.doc, source);
      const what = `${JSON.stringify(text)} became ${JSON.stringify(out)}`;
      const again = parseMarkdown(out);
      expect(blocksOf(again.doc), what).toEqual(blocksOf(tr.doc));
      expect(serializeMarkdown(again.doc, again.source), what).toBe(out);
      for (const b of source.blocks) if (!isEmptyLine(b.node)) expect(out.includes(b.text), what).toBe(true);
    }
  });
});

// Problems found and fixed ----------------------------------------------------------

function load(text: string) {
  const { doc, source } = parseMarkdown(text);
  return { state: EditorState.create({ doc }), source };
}

/** Type at the end of the first text in block k, and return the file text. */
function typeInBlock(text: string, k: number, typed: string): string {
  const { state, source } = load(text);
  let start = 0;
  for (let i = 0; i < k; i++) start += state.doc.child(i).nodeSize;
  let at = -1;
  state.doc.child(k).descendants((node, pos) => {
    if (at < 0 && node.isTextblock) at = start + 1 + pos + 1 + node.content.size;
    return at < 0;
  });
  if (at < 0) at = start + state.doc.child(k).nodeSize - 1;
  return serializeMarkdown(state.apply(state.tr.insertText(typed, at)).doc, source);
}

const textOf = (markdown: string) => parseMarkdown(markdown).doc.textContent;

describe("definitions inside quotes and lists", () => {
  it("keeps a link definition inside a quote when the quote is edited", () => {
    const text = "> [site]: https://example.com\n> See [site].\n\nElsewhere [site].\n";
    expect(parseMarkdown(text).doc.child(0).type.name).toBe("raw_block");
    const out = typeInBlock(text, 0, "!");
    expect(out).toContain("[site]: https://example.com");
  });

  it("keeps a footnote defined inside a list when the list is edited", () => {
    const text = "Text[^a].\n\n- item\n\n  [^a]: The note.\n";
    const out = typeInBlock(text, 1, "!");
    expect(out).toContain("[^a]: The note.");
  });

  it("keeps a list item that only looks like a definition editable", () => {
    expect(parseMarkdown("- [Note]: remember this one\n").doc.child(0).type.name).toBe("bullet_list");
  });
});

describe("footnotes", () => {
  it("never shows one note's text in place of another with the same label", () => {
    const text = "A[^1].\n\n[^1]: First note.\n\n[^1]: Second note.\n";
    const { doc } = parseMarkdown(text);
    expect(doc.child(1).type.name).toBe("raw_block");
    expect(doc.child(1).textContent).toBe("[^1]: First note.");
    const out = typeInBlock(text, 1, " Edited.");
    expect(out).toBe("A[^1].\n\n[^1]: First note. Edited.\n\n[^1]: Second note.\n");
  });
});

describe("pictures", () => {
  it("writes alt text back unchanged, however many times its paragraph is edited", () => {
    let text = "![alt *x* [y]](pic.png 'Title') here\n";
    for (let i = 0; i < 3; i++) text = typeInBlock(text, 0, "!");
    expect(text).toBe('![alt *x* [y]](pic.png "Title") here!!!\n');
  });

  it("escapes brackets in alt text only when they would end it early", () => {
    const { state, source } = load("Text\n");
    const pic = schema.nodes.image.create({ src: "a.png", alt: "Q3 [draft" });
    const out = serializeMarkdown(state.apply(state.tr.insert(1, pic)).doc, source);
    expect(out).toBe("![Q3 \\[draft](a.png)Text\n");
    expect(parseMarkdown(out).doc.child(0).child(0).type.name).toBe("image");
  });

  it("keeps a title with a backslash or quote", () => {
    const { state, source } = load("Text\n");
    const pic = schema.nodes.image.create({ src: "a.png", alt: "a", title: 'say "hi" \\' });
    const out = serializeMarkdown(state.apply(state.tr.insert(1, pic)).doc, source);
    expect(parseMarkdown(out).doc.child(0).child(0).attrs.title).toBe('say "hi" \\');
  });
});

describe("typed text that looks like Markdown reads back as typed", () => {
  const cases: [string, string][] = [
    ["an entity", "&copy; and &amp;"],
    ["double underscores", "__x__"],
    ["a number and bracket", "1) not a list"],
    ["a plus sign alone", "+"],
    ["a number and full stop alone", "1."],
  ];
  for (const [name, typed] of cases) {
    it(`keeps ${name} as text`, () => {
      const { state, source } = load("x\n");
      const out = serializeMarkdown(state.apply(state.tr.insertText(typed, 1, 2)).doc, source);
      const again = parseMarkdown(out).doc;
      expect(again.child(0).type.name).toBe("paragraph");
      expect(again.textContent).toBe(typed);
    });
  }

  const afterBreak: [string, string][] = [
    ["a rule", "---"],
    ["a heading", "# Heading"],
    ["a list", "- item"],
    ["a numbered list", "2) item"],
    ["a heading underline", "==="],
    ["a quote", "> quote"],
  ];
  for (const [name, typed] of afterBreak) {
    it(`keeps text that looks like ${name} after a line break as text`, () => {
      const { state, source } = load("First line\n");
      const tr = state.tr.insert(11, schema.nodes.hard_break.create()).insertText(typed, 12);
      const out = serializeMarkdown(state.apply(tr).doc, source);
      const again = parseMarkdown(out).doc;
      expect(again.childCount).toBe(1);
      expect(again.child(0).type.name).toBe("paragraph");
      expect(again.textContent).toBe("First line" + typed);
    });
  }

  it("keeps a heading that ends in a hash sign", () => {
    const out = typeInBlock("# Issue\n", 0, " #");
    expect(textOf(out)).toBe("Issue #");
  });

  // A new list item or quote given a heading style, before any words are typed.
  it("keeps an empty heading in a list item or a quote a heading", () => {
    const p = (t: string) => schema.node("paragraph", null, t ? [schema.text(t)] : []);
    const h = (level: number) => schema.node("heading", { level });
    const li = (kids: Node[]) => schema.node("list_item", null, kids);
    const pages = [
      [schema.node("bullet_list", null, [li([p("item one")]), li([h(2)])])],
      [schema.node("blockquote", null, [h(1)])],
      [schema.node("bullet_list", null, [li([p("words"), h(3)])])],
      [h(2)],
    ];
    for (const blocks of pages) {
      const page = schema.node("doc", null, blocks);
      const out = serializeMarkdown(page, parseMarkdown("").source);
      expect(out).not.toContain("\\#");
      const back = parseMarkdown(out).doc;
      expect(back.childCount).toBe(page.childCount);
      back.forEach((block, _, i) => expect(meaningOf(block)).toBe(meaningOf(page.child(i))));
    }
  });

  it("doesn't turn a pasted indented paragraph into a code block", () => {
    const { state, source } = load("x\n");
    const out = serializeMarkdown(state.apply(state.tr.insertText("\tIndented with a tab", 1, 2)).doc, source);
    expect(parseMarkdown(out).doc.child(0).type.name).toBe("paragraph");
    expect(textOf(out)).toBe("Indented with a tab");
  });

  it("leaves no stray backslash after a line break followed only by spaces", () => {
    const { state, source } = load("- one\n- two\n");
    // list > item > paragraph, then past "one"
    const tr = state.tr.insert(6, schema.nodes.hard_break.create()).insertText("  ", 7);
    const out = serializeMarkdown(state.apply(tr).doc, source);
    expect(out).toBe("- one  \n- two\n");
    expect(out).not.toContain("\\");
  });

  it("keeps underscore italics when a letter is typed right next to them", () => {
    const { state, source } = load("The _cat_\n");
    const end = 1 + "The cat".length;
    const out = serializeMarkdown(state.apply(state.tr.insert(end, schema.text("s"))).doc, source);
    expect(out).toBe("The *cat*s\n");
    const em = parseMarkdown(out).doc.child(0).child(1);
    expect(em.text).toBe("cat");
    expect(em.marks.map((m) => m.type.name)).toEqual(["em"]);
  });
});

describe("line endings in edited blocks", () => {
  it("uses old Mac line endings in a file that has them", () => {
    expect(typeInBlock("# T\r\r```\rone\rtwo\r```\r", 1, "!")).toBe("# T\r\r```\rone\rtwo!\r```\r");
  });

  it("uses the file's most common line ending when it has several", () => {
    const out = typeInBlock("- a\n- b\n\nPara\r\n\nEnd\n", 0, "!");
    expect(out).toBe("- a!\n- b\n\nPara\r\n\nEnd\n");
  });

  it("keeps Windows line endings in an edited code block", () => {
    expect(typeInBlock("```\r\none\r\ntwo\r\n```\r\n", 0, "!")).toBe("```\r\none\r\ntwo!\r\n```\r\n");
  });

  it("keeps the byte-order mark and the missing final newline after an edit", () => {
    expect(typeInBlock(`${BOM}Text`, 0, "!")).toBe(`${BOM}Text!`);
  });
});

describe("unusual tables", () => {
  it("saves a table with a short row instead of failing", () => {
    const cell = (t: string) => schema.nodes.table_cell.create(null, t ? schema.text(t) : null);
    const header = (t: string) => schema.nodes.table_header.create(null, schema.text(t));
    const table = schema.nodes.table.create(null, [
      schema.nodes.table_row.create(null, [header("a"), header("b")]),
      schema.nodes.table_row.create(null, [cell("1")]),
    ]);
    const { source } = parseMarkdown("");
    const out = serializeMarkdown(schema.node("doc", null, [table]), source);
    expect(out).toBe("| a   | b   |\n| --- | --- |\n| 1   |     |\n");
  });
});

describe("big documents", () => {
  it("a 5 MB list opens, and saves after an edit, in seconds", () => {
    const text = "- list item with some words in it\n".repeat(150_000);
    const started = Date.now();
    const out = typeInBlock(text, 0, "!");
    expect(Date.now() - started).toBeLessThan(15_000);
    expect(out.length).toBe(text.length + 1);
    expect(out.startsWith("- list item with some words in it!\n- list")).toBe(true);
  });

  it("saving after every block of a long document was replaced takes seconds, not minutes", () => {
    const unit = "## Section\n\nA paragraph with **bold** and a [link](https://x.com).\n\n- one\n- two\n\n";
    // Timed against a quarter of the document, in the same run, so a busy Mac slows both: four times the
    // blocks should take about four times as long, where a save that slows with length took sixteen.
    const saving = (copies: number) => {
      const text = unit.repeat(copies);
      const { doc, source } = parseMarkdown(text);
      let best = Infinity;
      for (let i = 0; i < 3; i++) {
        // The same text, all new blocks, made again for each timing: a second save of the same blocks
        // is answered from what the first worked out, and would time nothing.
        const fresh = schema.nodeFromJSON(doc.toJSON());
        const started = performance.now();
        const written = serializeMarkdown(fresh, source);
        best = Math.min(best, performance.now() - started);
        expect(written).toBe(text);
      }
      return best;
    };
    const quarter = saving(8_750);
    const whole = saving(35_000);
    expect(whole).toBeLessThan(60_000);
    expect(whole / quarter).toBeLessThan(8);
  }, 120_000);
});
