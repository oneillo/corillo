// What a document comes out as in Word, and what the person is told when
// Pandoc fails (Batch 21: E21-4, E21-6, E21-7, E21-8, E21-11). toWord runs a
// document through Corillo's Word export as exportDocument does, without the window.
import { describe, it, expect } from "vitest";
import { spawnSync } from "node:child_process";
import { chmodSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { makePng } from "../fixtures/make-png";
import { markdownTokens, parseMarkdown } from "../../src/core/markdown";
import { BLANK_MARK, blankLinesForWord, DEFAULT_SETTINGS, pandocProblem, withoutFrontMatter } from "../../src/main/export-prep";
import { PANDOC, toWord } from "./word";

describe("a link written as HTML (E21-11)", () => {
  it("keeps its address in Word", () => {
    const made = toWord('See <a href="https://example.com/plan?a=1&amp;b=2">the plan</a> now.\n');
    expect(made.html).toContain('<a href="https://example.com/plan?a=1&amp;b=2">the plan</a>');
    expect(made.html).toContain("See ");
    expect(made.html).toContain(" now.");
  });

  it("an address that isn't a web or email address stays words, as before", () => {
    const made = toWord('Run <a href="javascript:alert(1)">this</a> now. Mail <a href="mailto:ana@example.com">Ana</a>.\n');
    expect(made.html).not.toContain("javascript:");
    expect(made.html).toContain("Run this now.");
    expect(made.html).toContain('<a href="mailto:ana@example.com">Ana</a>');
  });
});

describe("lines after the document details that look like details (E21-4)", () => {
  const blocksOf = (markdown: string) => {
    const out: string[] = [];
    parseMarkdown(markdown).doc.forEach((n) => out.push(n.type.name === "raw_block" ? `raw_block(${n.attrs.kind})` : n.type.name));
    return out;
  };
  const markdown = "---\ntitle: Plan\n---\n---\nOwner: Ana\n---\n\nBody.\n";

  it("are a line and a heading in what the PDF's page reads, as in the editor, not details it hides", () => {
    expect(blocksOf(markdown)).toEqual(["raw_block(front-matter)", "horizontal_rule", "heading", "paragraph"]);
    const left = withoutFrontMatter(markdown);
    expect(blocksOf(left)).toEqual(["horizontal_rule", "heading", "paragraph"]);
    expect(left).toBe("***\nOwner: Ana\n---\n\nBody.\n");
  });

  it("and in Word", () => {
    const made = toWord(markdown);
    expect(made.html).toMatch(/<hr \/>\s*<h2[^>]*>Owner: Ana<\/h2>/);
  });

  it("text after the details that doesn't look like them is left as it is", () => {
    expect(withoutFrontMatter("---\ntitle: Plan\n---\n---\n\nBody.\n")).toBe("---\n\nBody.\n");
    expect(withoutFrontMatter("---\ntitle: Plan\n---\n\nBody.\n")).toBe("Body.\n");
  });
});

describe("empty lines in Word around one odd passage (E21-6)", () => {
  const start = "First words.\n\nSecond words.\n\n";
  // A note followed by two blank lines and indented text; an unclosed code fence in a list item.
  for (const odd of ["[^n]: note\n\n\n    indented\n\nLast words.\n", "- ```\n  code\n\n  text\n\n\nLast words.\n"]) {
    it(`only the marks at fault are left out: ${JSON.stringify(odd)}`, () => {
      const marked = blankLinesForWord(start + odd);
      expect(marked.startsWith(`First words.\n\n${BLANK_MARK}\n\nSecond words.`)).toBe(true);
      // Still the same blocks as the page reads.
      const shape = (s: string) => markdownTokens(s).filter((t) => !(t.type === "html_block" && t.content.trim() === BLANK_MARK)).map((t) => `${t.type}:${t.content}`);
      expect(shape(marked)).toEqual(shape(start + odd));
    });
  }

  it("in Word, First and Second keep their empty line", () => {
    const made = toWord(`${start}[^n]: note\n\n\n    indented\n\nLast words.\n`);
    const paragraphs = [...made.xml.matchAll(/<w:p[ >][\s\S]*?<\/w:p>/g)].map((p) => [...p[0].matchAll(/<w:t[^>]*>([^<]*)<\/w:t>/g)].map((t) => t[1]).join(""));
    expect(paragraphs.slice(0, 3)).toEqual(["First words.", "", "Second words."]);
  });
});

describe("a picture given a width and a height, ![[tall.png|300x200]] (E21-8)", () => {
  const points = (xml: string) => {
    const [, cx, cy] = /<wp:extent cx="(\d+)" cy="(\d+)"/.exec(xml)!;
    return `${Math.round(Number(cx) / 12700)}x${Math.round(Number(cy) / 12700)}`;
  };
  const tall = (dir: string) => writeFileSync(join(dir, "tall.png"), makePng(300, 900));

  it("is the size in Word that the page shows: 225 by 150 points", () => {
    expect(points(toWord("![[tall.png|300x200]]\n", { "tall.png": "tall.png" }, tall).xml)).toBe("225x150");
  });

  it("given only a width, keeps its own shape, as before", () => {
    expect(points(toWord("![[tall.png|100]]\n", { "tall.png": "tall.png" }, tall).xml)).toBe("75x225");
  });
});

describe("what the person is told when Pandoc can't write the Word document (E21-7)", () => {
  // Pandoc's own words when it can't write its output (here a folder it may not write in).
  const dir = mkdtempSync(join(tmpdir(), "corillo-pandoc-"));
  const locked = mkdtempSync(join(tmpdir(), "corillo-pandoc-locked-"));
  writeFileSync(join(dir, "document.md"), "Hello\n");
  chmodSync(locked, 0o555);
  const ran = spawnSync(PANDOC, ["document.md", "--to=docx", `--output=${join(locked, "export.docx")}`], { cwd: dir, encoding: "utf8" });
  chmodSync(locked, 0o755);
  const failed = (stderr: string) => Object.assign(new Error("Command failed"), { stderr, code: ran.status ?? 1 });
  const theirs = { ...DEFAULT_SETTINGS, style: "word" as const, referenceDoc: "/Users/ana/Brand.docx" };

  it("isn't blamed on the Word document whose styles he chose, and is said in plain words", () => {
    expect(ran.stderr).toContain("withBinaryFile");
    for (const settings of [theirs, DEFAULT_SETTINGS]) {
      expect(pandocProblem(failed(ran.stderr), settings).message).toBe(
        "The Word document couldn't be made: Corillo couldn't use its temporary folder. Try again, or restart the Mac if it keeps happening.",
      );
    }
  });

  it("a full disk is said as such", () => {
    const full = ran.stderr.replace(/permission denied \(Permission denied\)/, "resource exhausted (No space left on device)");
    expect(full).toContain("No space left on device");
    for (const settings of [theirs, DEFAULT_SETTINGS]) expect(pandocProblem(failed(full), settings).message).toBe("The Word document couldn't be made: the disk is full.");
  });

  it("a styles document Pandoc can't read is still named", () => {
    const bad = join(dir, "Brand.docx");
    writeFileSync(bad, "not a Word document");
    const read = spawnSync(PANDOC, ["document.md", "--to=docx", `--reference-doc=${bad}`, "--output=out.docx"], { cwd: dir, encoding: "utf8" });
    expect(pandocProblem(failed(read.stderr), theirs).message).toBe(
      "The styles couldn't be read from Brand.docx. Choose a Word document (.docx) or template (.dotx) in Export Settings.",
    );
  });

  it("anything else never shows Pandoc's backtrace", () => {
    const odd = ran.stderr.replace(/withBinaryFile: permission denied \(Permission denied\)/, "something odd happened");
    const told = pandocProblem(failed(odd), DEFAULT_SETTINGS).message;
    expect(told).toContain("something odd happened");
    expect(told).not.toContain("HasCallStack");
    expect(told).not.toContain("collectBacktraces");
  });
});
