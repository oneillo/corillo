// Empty lines in Word (Orlando, 2026-11-09): "An empty line in markdown doc
// should show up as an empty line in word", "multiple blank lines are just
// ignored when it exports to word. I don't like that", and "I don't love space
// before or after plain text in Word, except as needed for separating headers
// and other elements like tables". What the page shows is what Word gets: each
// blank line of the file the page shows as a line of space is an empty
// paragraph in Word, and plain text has no space of its own around it.
import { describe, expect, it } from "vitest";
import { execFileSync } from "node:child_process";
import { blankLinesForWord, bodyTextStyle, withoutFrontMatter } from "../../src/main/export-prep";
import { markdownTokens } from "../../src/core/markdown";
import { buildReferenceDocx } from "../../src/main/reference-docx";
import { makeZip, readZipEntry } from "../../src/main/zip";
import { paragraphsOf, PANDOC, toWord } from "./word";

/** Word's paragraphs, in order: their words, an empty one as "". */
const wordLines = (markdown: string, template?: Buffer) =>
  paragraphsOf(toWord(markdown, {}, undefined, template).xml).map((p) => p.words);

const MARK = "<!--corillo blank-->";

describe("each blank line is an empty line in Word, as on the page", () => {
  it("one blank line between two paragraphs is one empty line; two are two; written close, none", () => {
    const text = ["# Title", "Right under the title.", "", "One blank line above.", "", "", "Two above.", "", "", "", "Three above.", "- a", "- b", ""].join("\n");
    expect(wordLines(text)).toEqual(["Title", "Right under the title.", "", "One blank line above.", "", "", "Two above.", "", "", "", "Three above.", "a", "b"]);
  });

  it("around headings, quotes, code, tables, rules and lists too", () => {
    const text = "# One\n\nText.\n\n> Quoted.\n\n```\ncode\n```\n\n| a |\n|---|\n| 1 |\n\n- item\n\nEnd.\n";
    expect(wordLines(text)).toEqual(["One", "", "Text.", "", "Quoted.", "", "code", "", "a", "1", "", "item", "", "End."]);
  });

  it("inside a list or quote: one empty line where the file has a blank line, as the page draws it", () => {
    expect(wordLines("- a\n\n- b\n\n  More of b.\n- c\n")).toEqual(["a", "", "b", "", "More of b.", "c"]);
    expect(wordLines("- a\n\n\n\n- b\n")).toEqual(["a", "", "b"]);
    expect(wordLines("> a\n>\n> b\n> c\n")).toEqual(["a", "", "b\nc"]);
    expect(wordLines("1. a\n\n   > q\n   >\n   > r\n2. b\n")).toEqual(["a", "", "q", "", "r", "b"]);
  });

  it("the list keeps its items, numbers and nesting, and a quote its style", () => {
    const { xml } = toWord("3. a\n\n4. b\n   - x\n\n   - y\n\n> q\n>\n> r\n");
    const items = paragraphsOf(xml).filter((p) => /<w:numId /.test(p.xml)).map((p) => p.words);
    expect(items).toEqual(["a", "b", "x", "y"]);
    expect(paragraphsOf(xml).filter((p) => p.style === "BlockText").map((p) => p.words)).toEqual(["q", "", "r"]);
  });

  it("at the start, blank lines are empty lines; at the end, none are kept", () => {
    expect(wordLines("\n\nText.\n\n\n\n")).toEqual(["", "", "Text."]);
    // Front matter and the blank line under it are left out; more are empty lines, as the page shows them.
    expect(wordLines("---\ntitle: x\n---\n\n\nText.\n")).toEqual(["", "Text."]);
    expect(wordLines("---\ntitle: x\n---\n\nText.\n")).toEqual(["Text."]);
  });

  it("what Word leaves out leaves no empty line of its own: link definitions, notes and comments", () => {
    expect(wordLines("A [link][l].\n\n[l]: https://example.com\n\nB.\n")).toEqual(["A link.", "", "B."]);
    expect(wordLines("A.\n\n<!-- a note to self -->\n\nB.\n")).toEqual(["A.", "", "B."]);
    expect(wordLines("A.\n\n<!-- a note to self -->\n\n\nB.\n")).toEqual(["A.", "", "", "B."]);
    expect(wordLines("A.\n\n%%a note to self%%\n\nB.\n")).toEqual(["A.", "", "B."]);
    expect(wordLines("A.\n\n%%\nA block comment.\n%%\n\nB.\n")).toEqual(["A.", "", "B."]);
    expect(wordLines("- a\n- b\n\n^list-id\n\nB.\n")).toEqual(["a", "b", "", "B."]);
    expect(wordLines("A note.[^1]\n\n\n[^1]: The note.\n")).toEqual(["A note."]);
  });

  it("an empty line in Word is an empty paragraph: no marks, no words", () => {
    const { xml } = toWord("A.\n\n\nB.\n");
    const empty = paragraphsOf(xml).filter((p) => p.words === "");
    expect(empty).toHaveLength(2);
    expect(xml).not.toContain("corillo");
  });

  it("with a person's own Word template, blank lines are still empty lines", () => {
    const stock = execFileSync(PANDOC, ["--print-default-data-file", "reference.docx"], { maxBuffer: 16 * 1024 * 1024 });
    expect(wordLines("A.\n\nB.\n\n\nC.\n", stock)).toEqual(["A.", "", "B.", "", "", "C."]);
  });
});

describe("a heading stays with its text in Word, through the empty lines under it (R-EL-4, R-EL-11)", () => {
  // Pandoc's own stock template stands in for a person's: Body Text and First Paragraph, no keep of Corillo's.
  const stock = execFileSync(PANDOC, ["--print-default-data-file", "reference.docx"], { maxBuffer: 16 * 1024 * 1024 });
  const kept = (p: { xml: string }) => /<w:keepNext ?\/>/.test(p.xml);
  /** The paragraphs after a heading: the empty ones, then the first with words. */
  const under = (xml: string, heading: string) => {
    const all = paragraphsOf(xml);
    const at = all.findIndex((p) => p.words === heading && /^Heading\d$/.test(p.style));
    let next = at + 1;
    while (all[next]?.words === "") next++;
    return { empty: all.slice(at + 1, next), text: all[next] };
  };

  for (const [template, docx] of [
    ["Corillo's style", undefined],
    ["a person's own template", stock],
  ] as const) {
    it(`each empty line under a heading is kept with the next, so Word can't end a page with the heading alone: ${template}`, () => {
      for (const [text, empties] of [
        ["# Lunch on Friday\n\nHi Ana,\n", 1],
        ["## Plan\n\n\n\nFirst step.\n", 3],
        ["### Figures\n\n\n| a |\n|---|\n| 1 |\n", 2],
        // An empty list item or quote is nothing in Word: the empty lines around it are all under the heading.
        ["## Odd cases\n\n-\n\n1.\n\n>\n\nThe last paragraph.\n", 4],
      ] as const) {
        const { xml } = toWord(text, {}, undefined, docx);
        const { empty } = under(xml, text.slice(text.indexOf(" ") + 1, text.indexOf("\n")));
        expect(empty, text).toHaveLength(empties);
        expect(empty.map(kept), text).toEqual(empty.map(() => true));
      }
    });

    it(`the first words under a heading, table or list are its first paragraph, as with no empty line between: ${template}`, () => {
      const { xml } = toWord("# H\n\nText.\n\nMore.\n\n| a |\n|---|\n| 1 |\n\nAfter the table.\n\n- item\n\n\nAfter the list.\n", {}, undefined, docx);
      const styleOf = (words: string) => paragraphsOf(xml).find((p) => p.words === words)?.style;
      expect(under(xml, "H").text.words).toBe("Text.");
      expect([styleOf("Text."), styleOf("More."), styleOf("After the table."), styleOf("After the list.")]).toEqual(["FirstParagraph", "BodyText", "FirstParagraph", "FirstParagraph"]);
      // The empty lines themselves are plain text, with nothing in them.
      const empty = paragraphsOf(xml).filter((p) => p.words === "");
      expect(empty).toHaveLength(7);
      expect(new Set(empty.map((p) => p.style))).toEqual(new Set(["BodyText"]));
    });
  }

  it("other empty lines aren't kept with anything: only a heading's", () => {
    const { xml } = toWord("A.\n\n\nB.\n\n| a |\n|---|\n| 1 |\n\n\nC.\n");
    const empty = paragraphsOf(xml).filter((p) => p.words === "");
    expect(empty).toHaveLength(5);
    expect(empty.some(kept)).toBe(false);
  });

  it("an empty line takes the template's own Body Text, found by its name as Pandoc finds it", () => {
    expect(bodyTextStyle(buildReferenceDocx("Letter"))).toBe("BodyText");
    expect(bodyTextStyle(stock)).toBe("BodyText");
    const styles = (inner: string) => makeZip([{ name: "word/styles.xml", data: `<w:styles>${inner}</w:styles>` }]);
    expect(bodyTextStyle(styles('<w:style w:type="paragraph" w:styleId="Textkrper"><w:name w:val="body text"/></w:style>'))).toBe("Textkrper");
    expect(bodyTextStyle(styles('<w:style w:type="character" w:styleId="BodyTextChar"><w:name w:val="Body Text"/></w:style>'))).toBe("BodyText");
    expect(bodyTextStyle(styles('<w:style w:type="paragraph" w:styleId="a&quot;b"><w:name w:val="Body Text"/></w:style>'))).toBe("BodyText");
    expect(bodyTextStyle(Buffer.from("not a Word file"))).toBe("BodyText");
  });
});

describe("Corillo's Word style spaces text only with empty lines", () => {
  const xml = readZipEntry(buildReferenceDocx("Letter"), "word/styles.xml")!.toString("utf8");
  const spacingOf = (id: string): { before: number; after: number } => {
    const style = new RegExp(`<w:style\\b[^>]*w:styleId="${id}"[^>]*>([\\s\\S]*?)</w:style>`).exec(xml)?.[1] ?? "";
    const own = /<w:spacing ([^>]*)\/>/.exec(style)?.[1];
    const based = /<w:basedOn w:val="([^"]+)"/.exec(style)?.[1];
    const defaults = /<w:pPrDefault><w:pPr><w:spacing ([^>]*)\/>/.exec(xml)![1];
    const from = (attrs: string, name: string) => Number(new RegExp(`w:${name}="(\\d+)"`).exec(attrs)?.[1] ?? NaN) / 20;
    if (own) return { before: from(own, "before"), after: from(own, "after") };
    if (based) return spacingOf(based);
    return { before: from(defaults, "before"), after: from(defaults, "after") };
  };

  it("plain text, list items, quotes, callouts, code and pictures have no space before or after", () => {
    for (const id of ["Normal", "BodyText", "FirstParagraph", "Compact", "BlockText", "BlockText2", "CalloutSky", "SourceCode", "Figure", "Diagram"]) {
      expect(spacingOf(id), id).toEqual({ before: 0, after: 0 });
    }
  });

  it("headings keep a small separation, the same at every level", () => {
    for (let level = 1; level <= 6; level++) expect(spacingOf(`Heading${level}`), `Heading${level}`).toEqual({ before: 6, after: 3 });
  });

  it("tables keep theirs: room above and below the words in each cell", () => {
    const table = /<w:style\b[^>]*w:styleId="Table"[^>]*>([\s\S]*?)<\/w:style>/.exec(xml)![1];
    expect(table).toMatch(/<w:tblCellMar><w:top w:w="80"[^>]*\/>.*<w:bottom w:w="80"/);
  });
});

describe("the blank lines marked for Word", () => {
  /** A document's shape as Pandoc and Corillo read it, without the marks. */
  const shape = (text: string) =>
    markdownTokens(text)
      .filter((t) => !(t.type === "html_block" && t.content.trim() === MARK))
      .map((t) => `${t.type}${t.hidden ? " hidden" : ""} ${t.markup} ${t.type === "inline" || t.type.endsWith("_block") || t.type === "fence" ? t.content : ""}`);

  const AWKWARD = [
    "- a\nlazy line\n\n- b\n",
    "- a\n\n      indented code\n\n- b\n",
    "- - a\n\n  - b\n\n- c\n",
    "> - a\n>\n> - b\n",
    "1. a\n\n10. b\n\n    More.\n",
    "-\n  a\n\n- b\n",
    "- a\n\t\n- b\n",
    "> a\n>\n>     code\n",
    "- ```\n  code\n\n  more\n  ```\n\n- b\n",
    "> [!note] Title\n>\n> Body.\n",
    "* a\n\n\n* b\n",
    "<div>\n\nhtml\n\n</div>\n\nText.\n",
    "Text.\n\n\n    code\n\n\nText.\n",
  ];

  it("never change what anything else is: the same lists, quotes, code and words", () => {
    for (const text of AWKWARD) expect(shape(blankLinesForWord(text)), text).toEqual(shape(text));
  });

  it("mark nothing in a document with no blank lines to show", () => {
    for (const text of ["", "One line.\n", "# Title\nText.\n- a\n- b\n", "> a\n> b\n"]) expect(blankLinesForWord(text), text).not.toContain(MARK);
  });

  // Generated documents: blocks of every kind, each with the blank lines inside
  // it the page shows (one per gap), apart by one to four blank lines.
  const PARTS: { text: string; inside: number; kind: string }[] = [
    { text: "# Heading", inside: 0, kind: "h" },
    { text: "A paragraph with **bold** and a [link](https://x.com).", inside: 0, kind: "p" },
    { text: "Line one\nline two", inside: 0, kind: "p" },
    { text: "- a\n- b", inside: 0, kind: "-" },
    { text: "- loose a\n\n- loose b\n\n  second para", inside: 2, kind: "-" },
    { text: "- a\n  - nested\n\n  - nested two\n- b", inside: 1, kind: "-" },
    { text: "* star\n\n\n* star two", inside: 1, kind: "*" },
    { text: "1. one\n\n2. two", inside: 1, kind: "1." },
    { text: "1) a\n\n   > q\n   >\n   > r\n2) b", inside: 2, kind: "1)" },
    { text: "> quoted\n>\n> more", inside: 1, kind: ">" },
    { text: "> - in a quote\n>\n> - two", inside: 1, kind: ">" },
    { text: "> [!note] Title\n>\n> Body", inside: 1, kind: ">" },
    { text: "```js\nconst a = 1;\n\nconst b = 2;\n```", inside: 0, kind: "f" },
    { text: "    indented code", inside: 0, kind: "c" },
    { text: "| a | b |\n|---|---|\n| 1 | 2 |", inside: 0, kind: "t" },
    { text: "***", inside: 0, kind: "r" },
  ];
  const BLANKS = ["\n", "\n", "\n\n", "\n \n", "\n\t\n\n\n"];

  it("are made wherever the page shows a blank line, in generated documents, and change nothing else", () => {
    let seed = 7;
    const r = () => ((seed = (seed * 1664525 + 1013904223) >>> 0) / 2 ** 32);
    for (let run = 0; run < 3000; run++) {
      let text = "";
      let expected = 0;
      if (r() < 0.2) {
        text += "\n\n";
        expected += 2;
      }
      let last = "";
      const n = 1 + Math.floor(r() * 6);
      for (let i = 0; i < n; i++) {
        let part = PARTS[Math.floor(r() * PARTS.length)];
        // Two lists of one kind, or two indented code blocks, apart only by blank lines are one; and code indented under a list is the list's.
        const lists = ["-", "*", "1.", "1)"];
        while ((part.kind === last && [...lists, "c"].includes(part.kind)) || (part.kind === "c" && lists.includes(last))) part = PARTS[Math.floor(r() * PARTS.length)];
        if (i > 0) {
          const blanks = BLANKS[Math.floor(r() * BLANKS.length)];
          text += "\n" + blanks;
          expected += blanks.split("\n").length - 1;
        }
        text += part.text;
        expected += part.inside;
        last = part.kind;
      }
      text += r() < 0.5 ? "\n" : "\n\n\n";
      const marked = blankLinesForWord(text);
      expect(shape(marked), JSON.stringify(text)).toEqual(shape(text));
      expect(marked.split(MARK).length - 1, JSON.stringify(text)).toBe(expected);
    }
  });

  it("are quick in a long list: 3,000 items with blank lines between them", () => {
    const text = Array.from({ length: 3000 }, (_, i) => `- Item ${i + 1}`).join("\n\n") + "\n";
    const started = performance.now();
    const marked = blankLinesForWord(text);
    expect(performance.now() - started).toBeLessThan(1500);
    expect(marked.split(MARK).length - 1).toBe(2999);
  });

  it("read the document after its front matter as the page does", () => {
    expect(withoutFrontMatter("---\nt: x\n---\n\n\n\nText.\n")).toBe("\n\nText.\n");
  });
});
