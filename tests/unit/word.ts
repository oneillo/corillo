// Shared by the unit tests: a document through Corillo's Word export, as
// exportDocument runs it (front matter left out, blank lines marked to be
// empty lines, Obsidian's syntax as Obsidian shows it, the pictures step,
// Corillo's style and Lua filter, the bundled Pandoc), without the window. Diagrams stay code here, pictures on
// the web are left out and SVG pictures aren't drawn; the end-to-end tests
// do those.
import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pandocJsonArgs, pandocLocation, withoutFrontMatter, wordFiles, wordMaking, wordText, type WordLayout } from "../../src/main/export-prep";
import { htmlPictures, imageSources, pictureNotes, planPictures } from "../../src/main/export-pictures";
import { buildReferenceDocx } from "../../src/main/reference-docx";
import { wordFileProblems } from "../word-check";

export const PANDOC = pandocLocation({ packaged: false, resourcesPath: "", appPath: join(import.meta.dirname, "..", ".."), arch: process.arch });

export interface WordExport {
  /** The Word document's body (word/document.xml). */
  xml: string;
  /** Its footnotes (word/footnotes.xml), or "" when there are none. */
  notes: string;
  /** The Word document read back by Pandoc, as HTML. */
  html: string;
  /** Where the .docx is. */
  file: string;
  /** How Corillo's filter laid out its tables and pictures. */
  layout: WordLayout;
  /** What the person would be told about pictures left out. */
  left: string[];
}

export function toWord(
  markdown: string,
  pictures: Record<string, string> = {},
  setUp?: (dir: string) => void,
  referenceDocx: Buffer = buildReferenceDocx("Letter"),
  /** A Lua filter of the person's own, run after Corillo's. */
  luaFilter?: string,
): WordExport {
  const dir = mkdtempSync(join(tmpdir(), "corillo-word-"));
  setUp?.(dir);
  // The app's own steps (src/main/export-prep.ts, "The Word export's middle"), with Pandoc run here.
  const files = wordFiles(dir);
  const referenceDoc = join(dir, "style.docx");
  const text = wordText(withoutFrontMatter(markdown), (name) => pictures[name] ?? null);
  writeFileSync(files.input, text);
  writeFileSync(referenceDoc, referenceDocx);
  execFileSync(PANDOC, pandocJsonArgs(files.input, files.reading), { cwd: dir, stdio: "pipe" });
  const ast = JSON.parse(readFileSync(files.reading, "utf8"));
  const work = mkdtempSync(join(tmpdir(), "corillo-word-work-"));
  const plan = planPictures(imageSources(ast), dir, work);
  for (const [url, srcs] of plan.web) {
    for (const src of srcs) plan.ready.set(src, null);
    plan.left.push({ name: url, why: "load" });
  }
  for (const src of htmlPictures(text)) plan.left.push({ name: src, why: "html" });
  let theirs: string | undefined;
  if (luaFilter) writeFileSync((theirs = join(dir, "theirs.lua")), luaFilter);
  const { layout, args } = wordMaking({ ast, plan, style: referenceDocx, files, referenceDoc, luaFilter: theirs });
  execFileSync(PANDOC, args, { cwd: dir, stdio: "pipe" });
  const file = files.output;
  const part = (name: string) => {
    try {
      return execFileSync("unzip", ["-p", file, name], { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] });
    } catch {
      return "";
    }
  };
  // Every Word file the tests make gets the same look inside (tests/word-check.ts).
  const problems = wordFileProblems(file);
  if (problems.length) throw new Error(`The Word file has problems: ${problems.join("; ")}`);
  const html = execFileSync(PANDOC, [file, "--from=docx", "--to=html", "--wrap=none"], { encoding: "utf8" });
  return { xml: part("word/document.xml"), notes: part("word/footnotes.xml"), html, file, layout, left: pictureNotes(plan.left) };
}

/** The words of a stretch of Word XML, in order, with entities decoded. */
export function wordsOf(xml: string): string {
  return [...xml.matchAll(/<w:t[^>]*>([^<]*)<\/w:t>|<w:br \/>|<w:tab \/>/g)]
    .map((m) => (m[0] === "<w:br />" ? "\n" : m[0] === "<w:tab />" ? "\t" : (m[1] ?? "")))
    .join("")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&apos;|&#39;/g, "'")
    .replace(/&amp;/g, "&");
}

/** Each paragraph of the body: its style and its words (a line break as "\n"). */
export function paragraphsOf(xml: string): { style: string; words: string; xml: string }[] {
  return [...xml.matchAll(/<w:p>([\s\S]*?)<\/w:p>/g)].map(([, p]) => ({
    style: /<w:pStyle w:val="([^"]*)"/.exec(p)?.[1] ?? "",
    words: wordsOf(p),
    xml: p,
  }));
}
