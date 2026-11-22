// Obsidian's syntax on its way to Word and PDF: links read as their words,
// comments and block ids are left out, embedded pictures become pictures,
// and (for Word) callouts become titled quotes and highlights Word's own.
import { describe, it, expect } from "vitest";
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { obsidianForExport, picturesEmbedded } from "../../src/core/obsidian-export";
import { paragraphsOf, toWord as exportToWord } from "./word";
import { makePng } from "../fixtures/make-png";

const pictures: Record<string, string> = { "chart.png": "Q3 planning images/chart.png" };
const forWord = (md: string) => obsidianForExport(md, { word: true, picture: (name) => pictures[name] ?? null });
const forPdf = (md: string) => obsidianForExport(md, { word: false, picture: (name) => pictures[name] ?? null });

describe("links and embeds", () => {
  it("a link becomes the words it shows", () => {
    expect(forWord("See [[Ana López]] and [[Team/Marcus|Marcus]].\n")).toBe("See Ana López and Marcus.\n");
    expect(forWord("See [[Q2 review#Lessons]] and [[Q2 review#^key|the numbers]].\n")).toBe("See Q2 review \\> Lessons and the numbers.\n");
    expect(forWord("Back to [[#Tasks]] or [[Plan#^abc]].\n")).toBe("Back to Tasks or Plan.\n");
    expect(forPdf("See [[Plan.md|*the* plan]].\n")).toBe("See \\*the\\* plan.\n");
  });

  it("a link's words stay plain words, even when they look like Markdown", () => {
    expect(forWord("[[Notes_2024|a *draft* <now>]]\n")).toBe("a \\*draft\\* \\<now\\>\n");
  });

  it("a link in a table keeps the table's columns", () => {
    expect(forWord("| Owner | Link |\n| - | - |\n| Ana | [[Ana López\\|Ana]] |\n")).toBe("| Owner | Link |\n| - | - |\n| Ana | Ana |\n");
  });

  it("an embedded picture becomes a picture, found where Obsidian keeps it; Word gets its size", () => {
    expect(forWord("![[chart.png]]\n")).toBe("![chart](<Q3 planning images/chart.png>)\n");
    expect(forWord("![[chart.png|300]]\n")).toBe("![chart](<Q3 planning images/chart.png>){width=300px}\n");
    expect(forPdf("![[chart.png|300]]\n")).toBe("![chart](<Q3 planning images/chart.png>)\n");
    expect(forWord("![[chart.png|The chart]]\n")).toBe("![The chart](<Q3 planning images/chart.png>)\n");
  });

  it("a picture that can't be found stays a picture, so the export says it's missing", () => {
    expect(forWord("![[gone.png]]\n")).toBe("![gone](<gone.png>)\n");
  });

  it("an embedded note becomes its name", () => {
    expect(forWord("![[Q2 review]]\n")).toBe("Q2 review\n");
  });
});

describe("what's left out", () => {
  it("a comment is left out, and a line that held only a comment goes with it", () => {
    expect(forWord("Budget is tight. %%Ask finance.%% Really.\n")).toBe("Budget is tight.  Really.\n");
    expect(forWord("One\n%%a note to self%%\nTwo\n")).toBe("One\nTwo\n");
    expect(forWord("Before\n\n%%\nA block comment.\n\nWith [[a link]].\n%%\n\nAfter\n")).toBe("Before\n\nAfter\n");
  });

  it("lines of their own left out between blank lines take one blank line with them: one line of space, as the page shows it", () => {
    for (const both of [forWord, forPdf]) {
      expect(both("A.\n\n%%note%%\n\nB.\n")).toBe("A.\n\nB.\n");
      expect(both("A.\n\n%%note%%\n\n\nB.\n")).toBe("A.\n\n\nB.\n");
      expect(both("%%note%%\n\nA.\n")).toBe("A.\n");
      expect(both("> a\n>\n> %%note%%\n>\n> b\n")).toBe("> a\n>\n> b\n");
      expect(both("A.\n\n^block-id\n\nB.\n")).toBe("A.\n\nB.\n");
      // Written close to the text, they leave its lines as they were.
      expect(both("A.\n%%note%%\n\nB.\n")).toBe("A.\n\nB.\n");
    }
  });

  it("a block id is left out, on its own line or at the end of one", () => {
    expect(forWord("- First idea ^idea-one\n- Second\n\n^idea-list\n\nEnd. ^last\n")).toBe("- First idea\n- Second\n\nEnd.\n");
  });
});

describe("callouts and highlights", () => {
  // Changed 2026-11-09: each title now carries a hidden mark of its colour, so
  // Word shows the callout as the same coloured box as the page.
  const sky = "<!--corillo callout sky-->";
  const mint = "<!--corillo callout mint-->";
  const ochre = "<!--corillo callout ochre-->";
  it("for Word, a callout becomes a quote with its title in bold, on a line of its own, marked with its colour", () => {
    expect(forWord("> [!note] Why this matters\n> Launch dates moved.\n")).toBe(`> **Why this matters**${sky}\n>\n> Launch dates moved.\n`);
    expect(forWord("> [!tip]- Folded\n> Keep it short.\n")).toBe(`> **Folded**${mint}\n>\n> Keep it short.\n`);
    expect(forWord("> [!warning]\n> No title.\n")).toBe(`> **Warning**${ochre}\n>\n> No title.\n`);
    expect(forWord("> [!faq] Only a title\n")).toBe(`> **Only a title**${ochre}\n`);
    expect(forWord("> [!question] Nested?\n> > [!todo] Yes.\n> > Like this.\n")).toBe(
      `> **Nested?**${ochre}\n>\n> > **Yes.**${sky}\n> >\n> > Like this.\n`,
    );
    expect(forWord("- > [!note] In a list\n  > Body\n")).toBe(`- > **In a list**${sky}\n  >\n  > Body\n`);
  });

  it("for Word, a highlight is marked for the filter that makes it Word's highlight", () => {
    expect(forWord("Budget is ==tight== and **==firm==**.\n")).toBe("Budget is <mark>tight</mark> and **<mark>firm</mark>**.\n");
  });

  it("for PDF, callouts and highlights stay: the page draws them as the editor does", () => {
    const text = "> [!note] Title\n> Body ==here==.\n";
    expect(forPdf(text)).toBe(text);
  });
});

describe("what isn't touched", () => {
  it("code, escaped brackets, math, tags and everything else", () => {
    const text = [
      "Code: `[[not a link]]` and ``%%kept%%`` and \\[\\[escaped]].",
      "",
      "```",
      "[[in a fence]] %%too%% ==and this==",
      "```",
      "",
      "    [[indented code]]",
      "",
      "Math $[[x]]$ and #tag and [a link](https://example.com).",
      "",
    ].join("\n");
    expect(forPdf(text)).toBe(text);
    // (For Word, math's marks get backslashes, so they stay as written: see "math in Word".)
    expect(forWord(text)).toBe(text.replace("$[[x]]$", "\\$\\[\\[x\\]\\]\\$"));
  });

  it("Windows line endings are fine", () => {
    expect(forWord("See [[Plan]].\r\nNext %%x%%\r\n")).toBe("See Plan.\nNext \n");
  });
});

// Pandoc is told not to read math (so its dollar signs stay), which leaves what
// is between them to be read as Markdown: each mark in it gets a backslash.
describe("math in Word stays as written, as on the page (A16-15)", () => {
  const shown = (markdown: string) => paragraphsOf(exportToWord(markdown).xml).map((p) => p.words).filter((w) => w !== "");

  it("stars, backslashes and braces in a line's math", () => {
    expect(shown("Area is $a*b*c$ here.\n")).toEqual(["Area is $a*b*c$ here."]);
    expect(shown("Set $\\{a, b\\}$ and $\\int_0^1 x\\,dx$ here.\n")).toEqual(["Set $\\{a, b\\}$ and $\\int_0^1 x\\,dx$ here."]);
  });

  it("a math block keeps its backslashes, its stars, and lines that start with a plus or a minus", () => {
    expect(shown("$$\n\\begin{x}a\\\\\nb*c*d\\end{x}\n$$\n")).toEqual(["$$\n\\begin{x}a\\\\\nb*c*d\\end{x}\n$$"]);
    expect(shown("$$\nx = a\n+ b\n- c\n$$\n")).toEqual(["$$\nx = a\n+ b\n- c\n$$"]);
  });

  it("in a quote, the quote's marks stay marks", () => {
    expect(forWord("> $$\n> a*b\n> $$\n")).toBe("> \\$\\$\n> a\\*b\n> \\$\\$\n");
  });

  // Code review of Batch 16's fixes, B16R-4: Obsidian indents lists with tabs.
  it("in a list indented with a tab, as with spaces", () => {
    expect(forWord("- item\n\n\t$$\n\ta*b*c\n\t$$\n")).toBe("- item\n\n\t\\$\\$\n\ta\\*b\\*c\n\t\\$\\$\n");
    expect(forWord("- item\n\n  $$\n  a*b*c\n  $$\n")).toBe("- item\n\n  \\$\\$\n  a\\*b\\*c\n  \\$\\$\n");
  });

  it("the PDF page reads math itself, so its text is left as it is", () => {
    expect(forPdf("Area is $a*b*c$.\n\n$$\n+ b\n$$\n")).toBe("Area is $a*b*c$.\n\n$$\n+ b\n$$\n");
  });
});

describe("the last line of a file with no final newline, as Obsidian often saves notes (EX-2)", () => {
  it("is treated like any other line, for Word and PDF", () => {
    for (const both of [forWord, forPdf]) {
      expect(both("Intro.\n\nLast line %%note to self%%")).toBe("Intro.\n\nLast line ");
      expect(both("See [[Plan|the plan]]")).toBe("See the plan");
      expect(both("![[chart.png]]")).toBe("![chart](<Q3 planning images/chart.png>)");
      expect(both("Para ^abc123")).toBe("Para");
      expect(both("A claim^[the note]")).toBe("A claim[^corillo-note-1]\n\n[^corillo-note-1]: the note\n");
      expect(both("| a | b |\n|---|---|\n| x | [[Plan]] |")).toBe("| a | b |\n|---|---|\n| x | Plan |");
    }
    expect(forWord("A ==highlight==")).toBe("A <mark>highlight</mark>");
    expect(forWord("> [!note] Title\n> body %%c%%")).toBe("> **Title**<!--corillo callout sky-->\n>\n> body ");
  });

  it("a comment or block id alone on the last line goes whole", () => {
    expect(forWord("One\n%%a note to self%%")).toBe("One\n");
    expect(forWord("One\n\n^block-id")).toBe("One\n\n");
  });

  it("an embedded picture there is still found for the export", () => {
    expect(picturesEmbedded("![[chart.png]]")).toEqual(["chart.png"]);
    expect(picturesEmbedded("Text\n\n![[chart.png|300]]")).toEqual(["chart.png"]);
  });

  it("reaches Word as Obsidian shows it", () => {
    const words = exportToWord("Intro.\n\nSee [[Plan|the plan]] and ==this== %%private%%").html;
    expect(words).toContain("See the plan and");
    expect(words).not.toContain("private");
    expect(words).not.toContain("[[");
  });
});

describe("braces and ::: lines reach Word as the page shows them (EX-9)", () => {
  const words = (markdown: string) => exportToWord(markdown).html.replace(/<[^>]+>/g, "").replace(/&quot;/g, '"').trim();

  it("text in braces stays, whatever it holds", () => {
    const sentence = "Dear {name}, your code is {{code}} and {date=2026} or {TODO} or {.important} or {#1} or {x}.";
    expect(words(sentence)).toBe(sentence);
    expect(words("Budget {=sum(A1:A3)} here and a set {a, b, c}.")).toBe("Budget {=sum(A1:A3)} here and a set {a, b, c}.");
    expect(words("Use the `{.class}` form.")).toBe("Use the {.class} form.");
  });

  it("a heading keeps its braces, and a line of braces or ::: stays a line of text", () => {
    expect(words("# Plan {#custom-id}")).toBe("Plan {#custom-id}");
    expect(words("{.note}\nA paragraph marked.")).toMatch(/^\{\.note\}\s+A paragraph marked\.$/);
    expect(words("::: note\nInside\n:::")).toMatch(/^::: note\s+Inside\s+:::$/);
    expect(words("Before.\n\n:::: {.columns}\n\nAfter.")).toMatch(/^Before\.\s+:::: \{\.columns\}\s+After\.$/);
  });

  it("next to Obsidian's marks too: in a comment (still left out), a link, a note and a table", () => {
    expect(forWord("Keep {.a} %%hide {.b}%% and [[Plan|the {#x} plan]].\n")).toBe("Keep \\{.a}  and the \\{\\#x\\} plan.\n");
    expect(forWord("%%\nBlock {.x}\n%%\nAfter\n")).toBe("After\n");
    expect(words("A claim^[see {date=2026}] here.")).toContain("see {date=2026}");
    expect(words("| a | b |\n|---|---|\n| {.x} | {k=v} |\n")).toMatch(/\{\.x\}\s*\{k=v\}/);
  });

  it("a size written after a picture still sizes it in Word", () => {
    const { layout, xml } = exportToWord("![chart](chart.png){width=50%}\n", {}, (dir) => writeFileSync(join(dir, "chart.png"), makePng(400, 200)));
    expect(Object.keys(layout.pictures)).toEqual(["chart.png"]);
    expect(xml).not.toContain("width=50%");
    expect(xml).toContain("<w:drawing>");
  });
});

describe("the sample Obsidian note in Word", () => {
  const note = readFileSync(join(import.meta.dirname, "..", "fixtures", "obsidian-note.md"), "utf8");
  const toWord = (markdown: string) => exportToWord(markdown, pictures).xml;

  const words = (xml: string) => [...xml.matchAll(/<w:t[^>]*>([^<]*)<\/w:t>/g)].map((m) => m[1]).join("");

  it("reads as Obsidian shows it", () => {
    const xml = toWord(note);
    const text = words(xml);
    expect(text).toContain("Notes from the kickoff with Ana López and Marcus.");
    expect(text).toContain("See Q2 review &gt; Lessons and the key numbers.");
    for (const gone of ["[[", "]]", "%%", "Ask finance", "A block comment", "^idea", "^last-block", "[!note]", "=="]) {
      expect(text, gone).not.toContain(gone);
    }
    // Highlights are Word's own highlight.
    expect(xml.match(/<w:highlight w:val="yellow" \/>/g)?.length).toBeGreaterThanOrEqual(2);
    // Callout titles are there, in bold.
    for (const title of ["Why this matters", "Folded by default", "Warning", "Can callouts be nested?", "Yes, they can."]) {
      expect(text).toContain(title);
    }
    expect(xml).toMatch(/<w:b \/>[\s\S]{0,200}Why this matters/);
    // A single line break is a line break in Word too, as in Obsidian and Corillo.
    expect(xml).toMatch(/not negotiable[\s\S]*?<w:br \/>[\s\S]*?This line follows a single line break/);
    // Tags, math and dollar amounts stay as written.
    expect(text).toContain("#nested/tag/deep");
    expect(text).toContain("$5 and $10");
  });
});
