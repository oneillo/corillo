// What a Word document's content comes out as in its Markdown copy (Batch 21,
// E21-1, E21-2, E21-9, E21-10): pictures in a table's first row, what a cell
// holds besides paragraphs and lists, Word's raised letters, and a bracket in
// the document's name. The Word documents are made by the bundled Pandoc from
// a few lines of HTML, in the run folder.
import { describe, it, expect } from "vitest";
import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { copyPlace, makeWordCopy, type CopyTools } from "../../src/main/word-copy";
import { pandocLocation } from "../../src/main/export-prep";
import { parseMarkdown } from "../../src/core/markdown";
import { run } from "../../src/main/pandoc";
import { makePng } from "../fixtures/make-png";

const ROOT = join(import.meta.dirname, "..", "..");
const PANDOC = pandocLocation({ packaged: false, resourcesPath: "", appPath: ROOT, arch: process.arch });
const tools: CopyTools = { pandoc: () => PANDOC, run };

/** A Word document with this content, in a folder of its own. */
function wordFrom(html: string, pictures: Record<string, [number, number]> = {}, name = "Notes.docx"): string {
  const from = mkdtempSync(join(tmpdir(), "corillo-copy-from-"));
  const to = mkdtempSync(join(tmpdir(), "corillo-copy-"));
  for (const [p, [w, h]] of Object.entries(pictures)) writeFileSync(join(from, p), makePng(w, h));
  writeFileSync(join(from, "in.html"), html);
  execFileSync(PANDOC, ["in.html", "--from=html", "--to=docx", `--output=${join(to, name)}`], { cwd: from, stdio: "pipe" });
  return join(to, name);
}

/** The Markdown copy Corillo makes of it. */
async function copyOf(word: string): Promise<string> {
  const place = copyPlace(word);
  await makeWordCopy(word, place, tools);
  return readFileSync(place.markdown, "utf8");
}

/** How many pictures the page reads in it. */
const pictures = (markdown: string) => {
  let n = 0;
  parseMarkdown(markdown).doc.descendants((node) => {
    if (node.type.name === "image") n++;
  });
  return n;
};

const cells = (rows: string) => `<table><thead><tr><th>What</th><th>Detail</th></tr></thead><tbody>${rows}</tbody></table>`;

describe("a table in a Word document, in its copy", () => {
  it("a first row of pictures with no description keeps its pictures (E21-1)", async () => {
    const copy = await copyOf(
      wordFrom(
        `<table><thead><tr><th><img src="a.png"></th><th><img src="b.png"></th></tr></thead>` +
          `<tbody><tr><td>Ana</td><td>Ben</td></tr><tr><td>Host</td><td>Notes</td></tr></tbody></table>`,
        { "a.png": [40, 20], "b.png": [30, 10] },
      ),
    );
    expect(pictures(copy)).toBe(2);
    expect(copy).toContain("| Ana");
    expect(copy).toContain("| Host");
  });

  it("an empty first row still gives way to the first row with words (E21-1)", async () => {
    const copy = await copyOf(wordFrom(`<table><thead><tr><th></th><th></th></tr></thead><tbody><tr><td>Ana</td><td>Ben</td></tr><tr><td>Host</td><td>Notes</td></tr></tbody></table>`));
    expect(copy.split("\n")[0]).toMatch(/^\| Ana +\| Ben +\|$/);
  });

  it("a quote in a cell keeps its link, and its paragraphs stay apart (E21-2)", async () => {
    const copy = await copyOf(
      wordFrom(cells(`<tr><td>Quote</td><td><blockquote><p>See <a href="https://example.com/plan">the plan</a> and act.</p><p>Second thought.</p></blockquote></td></tr>`)),
    );
    expect(copy).toContain("[the plan](https://example.com/plan) and act.<br>Second thought.");
  });

  it("an indented paragraph in a cell (Word's Increase Indent) keeps its link, its bold and its picture (E21-2)", async () => {
    // Made as a plain cell, then its paragraphs indented the way Word writes it: <w:ind w:left="720"/>.
    const plain = wordFrom(
      cells(`<tr><td>Plan</td><td><p>See <a href="https://example.com/plan">the plan</a> and <strong>act</strong> <img src="a.png" alt="Map"> now.</p><p>Second.</p></td></tr>`),
      { "a.png": [40, 20] },
    );
    const parts = mkdtempSync(join(tmpdir(), "corillo-copy-parts-"));
    execFileSync("unzip", ["-q", plain, "-d", parts]);
    const file = join(parts, "word", "document.xml");
    const xml = readFileSync(file, "utf8");
    const from = xml.indexOf(">the plan<");
    const cell = xml.lastIndexOf("<w:tc>", from);
    const end = xml.indexOf("</w:tc>", from);
    const indented = xml.slice(cell, end).replace(/<w:pStyle w:val="[^"]*" \/>/g, '<w:ind w:left="720" />');
    expect(indented).toContain("w:ind");
    writeFileSync(file, xml.slice(0, cell) + indented + xml.slice(end));
    const word = join(mkdtempSync(join(tmpdir(), "corillo-copy-")), "Notes.docx");
    execFileSync("zip", ["-q", "-X", "-r", word, "[Content_Types].xml", "_rels", "word", "docProps"], { cwd: parts });
    const copy = await copyOf(word);
    expect(copy).toContain("[the plan](https://example.com/plan)");
    expect(copy).toContain("**act**");
    expect(pictures(copy)).toBe(1);
    expect(copy).toMatch(/now\.<br>Second\./);
  });

  it("code in a cell keeps its text, a line each (E21-2)", async () => {
    const copy = await copyOf(wordFrom(cells(`<tr><td>Code</td><td><pre><code>x = 1\ny = 2</code></pre></td></tr>`)));
    expect(copy).toContain("`x = 1`<br>`y = 2`");
  });

  it("a table inside a cell becomes a line a row, its cells apart (E21-2)", async () => {
    const copy = await copyOf(wordFrom(cells(`<tr><td>Nested</td><td><table><tr><td>Name</td><td>Role</td></tr><tr><td>Ana</td><td>Host</td></tr></table></td></tr>`)));
    expect(copy).toContain("Name · Role<br>Ana · Host");
  });

  it("a picture in a quote in a cell is kept (E21-2)", async () => {
    const copy = await copyOf(wordFrom(cells(`<tr><td>Picture</td><td><blockquote><p><img src="a.png"></p></blockquote></td></tr>`), { "a.png": [40, 20] }));
    expect(pictures(copy)).toBe(1);
  });
});

describe("words in a Word document, in its copy", () => {
  it("Word's raised letters (1st, 2nd, TM) come out as the words, without ^( ) (E21-9)", async () => {
    const copy = await copyOf(wordFrom(`<p>The 1<sup>st</sup> and 2<sup>nd</sup> quarter, Acme<sup>TM</sup>, x<sub>max</sub>, m<sup>2</sup> and H<sub>2</sub>O.</p>`));
    expect(copy).toContain("The 1st and 2nd quarter, AcmeTM, xmax, m² and H₂O.");
  });
});

describe("a Word document whose name has one bracket, in its copy", () => {
  const html = `<p>Before</p><p><img src="a.png" alt="Map"></p><p>After</p>`;

  it("Notes (draft.docx: its picture still reads as a picture (E21-10)", async () => {
    expect(pictures(await copyOf(wordFrom(html, { "a.png": [40, 20] }, "Notes (draft.docx")))).toBe(1);
  });

  it("Plan a).docx: its picture's address isn't cut at the bracket (E21-10)", async () => {
    const copy = await copyOf(wordFrom(html, { "a.png": [40, 20] }, "Plan a).docx"));
    expect(pictures(copy)).toBe(1);
    expect(copy).toContain("](Plan%20a%29%20images/");
  });
});
