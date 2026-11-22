// The page is a preview of the Word document (Orlando, 2026-11-09). Every
// kind of Markdown Corillo shows or keeps is in one sample document
// (tests/fixtures/word-preview.md). It goes through Corillo's real Word
// export (the bundled Pandoc, Corillo's style and Lua filter), and for each
// kind, what Word gets is checked against what the page shows: the document
// Corillo reads from the same file. How it looks on the page is checked in
// tests/e2e/word-preview.spec.ts.
import { describe, expect, it } from "vitest";
import { copyFileSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { execFileSync } from "node:child_process";
import { EditorState } from "prosemirror-state";
import type { Node } from "prosemirror-model";
import { parseMarkdown, serializeMarkdown } from "../../src/core/markdown";
import { paragraphsOf, toWord, wordsOf } from "./word";

const FIXTURES = join(import.meta.dirname, "..", "fixtures");
const sample = readFileSync(join(FIXTURES, "word-preview.md"), "utf8");
const word = toWord(sample, { "chart.png": "chart.png" }, (dir) => copyFileSync(join(FIXTURES, "chart.png"), join(dir, "chart.png")));
const paragraphs = paragraphsOf(word.xml);
const page = parseMarkdown(sample).doc;
const DASH = String.fromCharCode(0x2014);
const OPEN_BOX = String.fromCharCode(0x2610);
const TICKED_BOX = String.fromCharCode(0x2612);

// The page's side ---------------------------------------------------------------

/** A textblock's words as the page shows them: a line break as "\n", no footnote numbers or pictures. */
function shownText(node: Node): string {
  let out = "";
  node.forEach((child) => {
    if (child.isText) out += child.text;
    else if (child.type.name === "hard_break") out += "\n";
  });
  return out;
}

function blocksOf(type: string, doc: Node = page): Node[] {
  const found: Node[] = [];
  doc.descendants((node) => {
    if (node.type.name === type) found.push(node);
  });
  return found;
}

/** The page's paragraph holding these words. */
function pageParagraph(words: string): Node {
  const found = blocksOf("paragraph").find((p) => shownText(p).includes(words));
  if (!found) throw new Error(`No paragraph on the page holds "${words}"`);
  return found;
}

// Word's side -------------------------------------------------------------------

function wordParagraph(words: string) {
  const found = paragraphs.find((p) => p.words.includes(words));
  if (!found) throw new Error(`No paragraph in Word holds "${words}"`);
  return found;
}

const numbering = execFileSync("unzip", ["-p", word.file, "word/numbering.xml"], { encoding: "utf8" });

/** What a list level shows in Word: "bullet", "decimal", or the box of a task, and where it counts from. */
function levelOf(numId: string, level: number): { kind: string; start: number } {
  const abstract = new RegExp(`<w:num w:numId="${numId}">\\s*<w:abstractNumId w:val="(\\d+)"`).exec(numbering)![1];
  const def = new RegExp(`<w:abstractNum w:abstractNumId="${abstract}"[^>]*>([\\s\\S]*?)</w:abstractNum>`).exec(numbering)![1];
  const lvl = new RegExp(`<w:lvl w:ilvl="${level}"[^>]*>([\\s\\S]*?)</w:lvl>`).exec(def)![1];
  const format = /<w:numFmt w:val="([^"]+)"/.exec(lvl)![1];
  const text = /<w:lvlText w:val="([^"]*)"/.exec(lvl)?.[1] ?? "";
  const start = Number(/<w:start w:val="(\d+)"/.exec(lvl)?.[1] ?? 1);
  const box = text.includes(OPEN_BOX) ? OPEN_BOX : text.includes(TICKED_BOX) ? TICKED_BOX : "bullet";
  return { kind: format === "bullet" ? box : format, start };
}

/** Every list item in Word, in order: its level, its marker ("•", "3.", a task box) and its words. */
function wordListItems(): string[] {
  const counts = new Map<string, number>();
  const items: string[] = [];
  for (const p of paragraphs) {
    const num = /<w:ilvl w:val="(\d+)" \/>\s*<w:numId w:val="(\d+)" \/>/.exec(p.xml);
    if (!num) continue;
    const level = Number(num[1]);
    const { kind, start } = levelOf(num[2], level);
    const key = `${num[2]}/${level}`;
    const n = counts.get(key) ?? 0;
    counts.set(key, n + 1);
    const marker = kind === "decimal" ? `${start + n}.` : kind === "bullet" ? "•" : kind;
    items.push(`${"  ".repeat(level)}${marker} ${p.words}`);
  }
  return items;
}

/** Every list item on the page, in the same form. */
function pageListItems(): string[] {
  const items: string[] = [];
  const visit = (list: Node, level: number) => {
    list.forEach((item, _o, i) => {
      const first = item.firstChild;
      const task = item.attrs.checked === null ? null : item.attrs.checked ? TICKED_BOX : OPEN_BOX;
      const marker = task ?? (list.type.name === "ordered_list" ? `${list.attrs.order + i}.` : "•");
      if (first?.type.name === "paragraph" && first.content.size) items.push(`${"  ".repeat(level)}${marker} ${shownText(first)}`);
      item.forEach((child) => {
        if (child.type.name.endsWith("_list")) visit(child, level + 1);
      });
    });
  };
  page.forEach((block) => {
    if (block.type.name.endsWith("_list")) visit(block, 0);
  });
  return items;
}

// The comparison --------------------------------------------------------------------

describe("the sample document in Word reads as the page shows it", () => {
  it("headings 1 to 6, in order, at the same levels", () => {
    const onPage = blocksOf("heading").map((h) => `${h.attrs.level} ${h.textContent}`);
    const inWord = paragraphs.filter((p) => /^Heading\d$/.test(p.style)).map((p) => `${p.style.slice(7)} ${p.words}`);
    expect(inWord).toEqual(onPage);
    expect(onPage.slice(0, 7)).toEqual([
      "1 Heading one",
      "2 Heading two",
      "3 Heading three",
      "4 Heading four",
      "5 Heading five",
      "6 Heading six",
      "2 Underlined heading",
    ]);
  });

  it("Word's text has no colour of its own; headings are set apart by size alone (their colour is the page's only)", () => {
    const styles = execFileSync("unzip", ["-p", word.file, "word/styles.xml"], { encoding: "utf8" });
    expect(styles).not.toContain("<w:color ");
    expect(word.xml).not.toContain("<w:color ");
    const sizes = [1, 2, 3, 4, 5, 6].map((level) => {
      const style = new RegExp(`<w:style [^>]*w:styleId="Heading${level}">[\\s\\S]*?</w:style>`).exec(styles)![0];
      return Number(/<w:sz w:val="(\d+)"/.exec(style)![1]) / 2;
    });
    expect(sizes).toEqual([18, 14, 12, 11, 11, 10]);
  });

  it("every kind of line break is a line break in both, and a blank line a new paragraph", () => {
    const lines = [
      "A single line break here",
      "then the next line.",
      "A backslash next",
      "then its line.",
      "Two spaces next",
      "then their line.",
      "A br tag next",
      "then its line.",
    ];
    expect(shownText(pageParagraph("A single line break")).split("\n")).toEqual(lines);
    expect(wordParagraph("A single line break").words.split("\n")).toEqual(lines);
    expect(wordParagraph("A paragraph after a blank line.").words).toBe("A paragraph after a blank line.");
  });

  it("emphasis, its edge cases and strikethrough are the same words, formatted the same way", () => {
    const p = pageParagraph("Edge cases");
    const italic: string[] = [];
    const bold: string[] = [];
    p.forEach((child) => {
      if (child.marks.some((m) => m.type.name === "em")) italic.push(child.text!);
      if (child.marks.some((m) => m.type.name === "strong")) bold.push(child.text!);
    });
    const runs = [...wordParagraph("Edge cases").xml.matchAll(/<w:r>([\s\S]*?)<\/w:r>/g)].map((m) => m[1]);
    // Word may split a stretch of formatting into several runs: compare the words.
    expect(runs.filter((r) => r.includes("<w:i />")).map(wordsOf).join("")).toBe(italic.join(""));
    expect(runs.filter((r) => r.includes("<w:b />")).map(wordsOf).join("")).toBe(bold.join(""));
    expect(wordParagraph("Edge cases").words).toBe(shownText(p));
    expect(shownText(p)).toContain("X**(firm)** and *escaped stars*");
    expect(wordParagraph("Body text with").xml).toMatch(/<w:strike \/>[\s\S]*?struck/);
  });

  it("quotes, dashes and dots stay the characters typed, and [Lists] stays in its brackets", () => {
    const typed = shownText(pageParagraph("Punctuation as typed"));
    expect(typed).toContain('"straight quotes", it\'s, two ' + "-".repeat(2) + " hyphens, three " + "-".repeat(3) + " hyphens and three... dots");
    expect(wordParagraph("Punctuation as typed").words).toBe(typed);
    expect(wordParagraph("Punctuation as typed").xml).not.toContain("<w:hyperlink");
  });

  it("links read as their words and go to the same addresses; a bare address stays text", () => {
    const p = pageParagraph("An inline link");
    expect(wordParagraph("An inline link").words).toBe(shownText(p));
    const pageLinks: string[] = [];
    p.forEach((child) => {
      const link = child.marks.find((m) => m.type.name === "link");
      if (link) pageLinks.push(link.attrs.href);
    });
    const rels = execFileSync("unzip", ["-p", word.file, "word/_rels/document.xml.rels"], { encoding: "utf8" });
    const target = (id: string) =>
      [...rels.matchAll(/<Relationship [^>]*>/g)]
        .map((m) => m[0])
        .find((r) => r.includes(`Id="${id}"`))
        ?.match(/Target="([^"]+)"/)?.[1];
    const ids = [...wordParagraph("An inline link").xml.matchAll(/<w:hyperlink r:id="([^"]+)"/g)].map((m) => m[1]);
    expect(ids.map(target)).toEqual(pageLinks);
    expect(pageLinks).not.toContain("https://example.net/bare");
  });

  it("lists: the same items, nesting, numbers (from 3) and task boxes, and loose lists spaced like paragraphs", () => {
    expect(wordListItems()).toEqual(pageListItems());
    expect(pageListItems()).toEqual(
      expect.arrayContaining(["3. Starts at three", "  1. Nested numbered", `${OPEN_BOX} Task open`, `${TICKED_BOX} Task done`, `  ${OPEN_BOX} Nested task`]),
    );
    // Tight items sit close together (Compact); loose ones are spaced like paragraphs.
    expect(blocksOf("bullet_list")[0].attrs.tight).toBe(true);
    expect(wordParagraph("Tight one").style).toBe("Compact");
    const loose = page.content.content.find((b) => b.type.name === "bullet_list" && b.textContent.startsWith("Loose"))!;
    expect(loose.attrs.tight).toBe(false);
    expect(wordParagraph("Loose one").style).not.toBe("Compact");
  });

  it("a quote inside a quote is set further in, in Word as on the page", () => {
    const outer = page.content.content.find((b) => b.type.name === "blockquote" && b.textContent.startsWith("A quote."))!;
    expect(outer.lastChild!.type.name).toBe("blockquote");
    expect(wordParagraph("A quote.").style).toBe("BlockText");
    expect(wordParagraph("A quote.").words).toBe("A quote.\nIts second line.");
    expect(wordParagraph("A nested quote.").style).toBe("BlockText2");
  });

  it("code blocks keep their lines and spaces, with or without a language", () => {
    const codes = blocksOf("code_block").filter((c) => c.attrs.params !== "mermaid");
    expect(codes).toHaveLength(3);
    for (const code of codes) {
      const p = wordParagraph(code.textContent.split("\n")[0]);
      expect(p.style).toBe("SourceCode");
      expect(p.words).toBe(code.textContent);
    }
  });

  it("tables: the same cells, line breaks and bold in cells, and each column's alignment", () => {
    const tables = [...word.xml.matchAll(/<w:tbl>([\s\S]*?)<\/w:tbl>/g)].map((m) => m[1]);
    const pageTables = blocksOf("table");
    expect(tables).toHaveLength(3);
    expect(pageTables).toHaveLength(2);
    pageTables.forEach((table, t) => {
      const cells = [...tables[t].matchAll(/<w:tc>([\s\S]*?)<\/w:tc>/g)].map((m) => m[1]);
      const pageCells: Node[] = [];
      table.descendants((n) => {
        if (n.type.name === "table_cell" || n.type.name === "table_header") pageCells.push(n);
        return true;
      });
      expect(cells.map(wordsOf)).toEqual(pageCells.map(shownText));
      const headers = table.firstChild!.childCount;
      pageCells.forEach((cell, i) => {
        const align = /<w:jc w:val="(\w+)"/.exec(cells[i])?.[1] ?? null;
        expect(align, `cell ${i}`).toBe(cell.attrs.align);
        if (i < headers) return;
        let bold = false;
        cell.descendants((c) => {
          if (c.marks.some((m) => m.type.name === "strong")) bold = true;
        });
        expect(cells[i].includes("<w:b />"), `cell ${i}`).toBe(bold);
      });
    });
    // The table the page keeps as Markdown text (it has <sup>) is a real table in Word, with its 2 raised.
    expect(blocksOf("raw_block").some((b) => b.attrs.kind === "table" && b.textContent.includes("<sup>2</sup>"))).toBe(true);
    expect(tables[2]).toMatch(/<w:vertAlign w:val="superscript" \/>[\s\S]*?>2</);
  });

  it("pictures are pictures in both, and a sized Obsidian embed keeps its width", () => {
    expect(blocksOf("image")).toHaveLength(1);
    const drawings = [...word.xml.matchAll(/<wp:extent cx="(\d+)"/g)].map((m) => Number(m[1]));
    expect(drawings).toHaveLength(2);
    expect(drawings[1]).toBe(120 * 9525); // 120 pixels, as on the page
  });

  it("footnotes: the same words in reading order, a longer note whole, and a note written in the text too", () => {
    expect(word.xml.match(/<w:footnoteReference /g)).toHaveLength(3);
    const notes = [...word.notes.matchAll(/<w:footnote w:id="\d+">([\s\S]*?)<\/w:footnote>/g)].map((m) =>
      paragraphsOf(m[1]).map((p) => p.words.trim()),
    );
    expect(notes).toHaveLength(3);
    const simple = blocksOf("footnote_def").find((d) => d.attrs.label === "simple");
    expect(notes[0]).toEqual([simple?.textContent]);
    expect(notes[1]).toEqual(["The complex note's first paragraph.", "Its second paragraph."]);
    expect(notes[2]).toEqual(["Written right here."]);
    expect(wordParagraph("A simple footnote").words).toBe("A simple footnote, a complex one and an inline one.");
  });

  it("two horizontal rules are two rules in Word", () => {
    expect(blocksOf("horizontal_rule")).toHaveLength(2);
    expect(word.xml.match(/o:hr="t"/g)).toHaveLength(2);
  });

  it("HTML: a block's words reach Word, inline HTML is formatting, a hidden note stays hidden", () => {
    expect(wordParagraph("An HTML block.").words).toBe("An HTML block.");
    const inline = wordParagraph("Inline Cmd and underlined HTML.");
    expect(inline.xml).toMatch(/VerbatimChar[\s\S]*?Cmd/);
    expect(inline.xml).toMatch(/<w:u w:val="single" \/>[\s\S]*?underlined/);
    expect(word.xml).not.toContain("an HTML comment");
    expect(blocksOf("raw_block").find((b) => b.textContent.includes("an HTML comment"))?.attrs.kind).toBe("comment");
  });

  it("entities and escaped characters are the same characters", () => {
    const shown = shownText(pageParagraph("Entities:"));
    expect(shown).toBe(`Entities: © & <tag> ${DASH} dash. Escaped: # * _ [ ] <.`);
    expect(wordParagraph("Entities:").words).toBe(shown);
  });

  it("front matter and link definitions are left out of Word; the page shows them only as editing marks", () => {
    expect(word.xml).not.toContain("How the page matches Word");
    expect(word.xml).not.toContain("[ref]:");
    const kinds = blocksOf("raw_block").map((b) => b.attrs.kind);
    expect(kinds).toEqual(expect.arrayContaining(["front-matter", "links"]));
  });

  it("Obsidian: links as their words, highlights highlighted, tags as words, comments and block ids left out", () => {
    const p = wordParagraph("Links Plan");
    expect(p.words).toMatch(/^Links Plan and the goals, highlighted, #tag and #area\/topic, +and a block id$/);
    expect(p.xml).toMatch(/<w:highlight w:val="yellow" \/>[\s\S]*?highlighted/);
  });

  it("callouts are the same coloured boxes, titled, with untitled ones named by their kind", () => {
    expect(wordParagraph("Callout title").style).toBe("CalloutSky");
    expect(wordParagraph("Callout title").xml).toContain("<w:b />");
    expect(wordParagraph("Callout body.").style).toBe("CalloutSky");
    expect(wordParagraph("Warning").style).toBe("CalloutOchre");
    expect(wordParagraph("Untitled callout.").style).toBe("CalloutOchre");
    expect(word.xml).not.toContain("A block comment.");
  });

  it("math stays as written in both", () => {
    expect(wordParagraph("Inline $x^2$").words).toBe(shownText(pageParagraph("Inline $x^2$")));
    expect(wordParagraph("a^2 + b^2").words).toBe("$$\na^2 + b^2 = c^2\n$$");
  });

  it("an empty list item or quote shows nothing in Word (the page keeps its bullet, to type in)", () => {
    const i = paragraphs.findIndex((p) => p.words === "Odd cases");
    // Between the heading and the last paragraph, only the four blank lines of the file, each an empty line.
    const next = paragraphs.findIndex((p, k) => k > i && p.words !== "");
    expect(paragraphs[next].words).toBe("The last paragraph.");
    expect(next - i - 1).toBe(4);
  });
});

describe("the sample document, read and written back", () => {
  it("is the same file, byte for byte", () => {
    const { doc, source } = parseMarkdown(sample);
    expect(serializeMarkdown(doc, source)).toBe(sample);
  });

  // Two spaces at a line end are invisible and easily lost, so an edited paragraph
  // writes that break as a backslash: a line break in both, as before.
  it("an edited paragraph keeps its line breaks (a <br> as typed), and a ticked box is written [x]", () => {
    const { doc, source } = parseMarkdown(sample);
    let tr = EditorState.create({ doc }).tr;
    let breaks = -1;
    let task = -1;
    doc.descendants((node, pos) => {
      if (breaks < 0 && node.type.name === "paragraph" && node.textContent.startsWith("A single line break")) breaks = pos + 1;
      if (task < 0 && node.type.name === "list_item" && node.attrs.checked === false) task = pos;
    });
    tr = tr.setNodeMarkup(task, undefined, { ...doc.nodeAt(task)!.attrs, checked: true });
    tr = tr.insertText("Edited. ", breaks);
    const out = serializeMarkdown(tr.doc, source);
    expect(out).toContain(
      "Edited. A single line break here\nthen the next line.\nA backslash next\\\nthen its line.\nTwo spaces next\\\nthen their line.\nA br tag next<br>then its line.\n",
    );
    expect(out).toContain("- [x] Task open\n- [x] Task done\n  - [ ] Nested task\n");
    expect(out.replace("Edited. ", "").replace("next\\\nthen their", "next  \nthen their").replace("- [x] Task open", "- [ ] Task open")).toBe(sample);
  });
});
