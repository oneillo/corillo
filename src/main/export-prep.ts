// Getting a document ready for export, without touching the document itself.
// Pandoc (the program that makes the Word file) gets a temporary copy of the
// Markdown in which each diagram is replaced by a picture of it. Also here:
// finding the pictures a document uses, the paper size for the person's
// region, the export settings remembered for each document, and Pandoc's
// instructions, with the column widths for the tables and the size of the
// page's text, which Corillo's Lua filter uses to lay out tables and pictures.
import { execFileSync } from "node:child_process";
import * as fs from "node:fs";
import * as path from "node:path";
import type { Paper } from "./reference-docx";
import type { Node } from "prosemirror-model";
import { frontMatterEnd } from "../core/front-matter";
import { exportReader, obsidianForExport } from "../core/obsidian-export";
import { isEmptyLine, markdownLayout, markdownTokens, parseMarkdown, type MarkdownToken } from "../core/markdown";
import { innerBlankLines } from "../core/line-numbers";
import { columnWidths, SEARCH_BUDGET, WORD_TABLE, type SearchBudget, type TableText } from "../core/column-widths";
import { LETTER_TEXT, TALLEST, type Size } from "../core/picture-size";
import { readZipEntry } from "./zip";
import { endSentence, readyPictures, type PicturePlan } from "./export-pictures";

// Read the Markdown the way the editor does.
const md = exportReader;

const lf = (text: string) => text.replace(/\r\n?/g, "\n");

// Diagrams --------------------------------------------------------------------

export interface Diagram {
  /** The diagram's text, as the diagram engine reads it. */
  code: string;
  /** Lines of the document the code block takes up: from, and up to (not including). */
  from: number;
  to: number;
  /** What comes before the code fence on its first line (a quote's "> ", a list's indent). */
  prefix: string;
}

export const isDiagramInfo = (info: string) => /^mermaid\b/.test(info.trim());

export function findDiagrams(text: string): Diagram[] {
  const normal = lf(text);
  const lines = normal.split("\n");
  const found: Diagram[] = [];
  for (const tok of md.parse(normal, {})) {
    if (tok.type !== "fence" || !tok.map || !isDiagramInfo(tok.info)) continue;
    const first = lines[tok.map[0]];
    const at = first.search(/(`{3,}|~{3,})/);
    found.push({ code: tok.content, from: tok.map[0], to: tok.map[1], prefix: at > 0 ? first.slice(0, at) : "" });
  }
  return found;
}

/** The prefix for the lines after the first: a list marker becomes spaces, quote marks stay. */
function continuation(prefix: string): string {
  return prefix.replace(/(\d{1,9}[.)]|[-+*])(?=\s)/g, (m) => " ".repeat(m.length));
}

const isBlank = (line: string | undefined, prefix: string) =>
  line === undefined || line.slice(0, prefix.length).replace(/[>\s]/g, "") === "" && !line.slice(prefix.length).trim();

/**
 * The Markdown with each diagram replaced by its picture (a PNG file), in a
 * paragraph of its own with the "Diagram" style (centred). A diagram with no
 * picture (one that couldn't be drawn) stays as it is: its code.
 */
export function replaceDiagrams(text: string, pictures: (string | null)[]): string {
  const lines = lf(text).split("\n");
  const diagrams = findDiagrams(text);
  for (let i = diagrams.length - 1; i >= 0; i--) {
    const file = pictures[i];
    if (!file) continue;
    const { from, to, prefix } = diagrams[i];
    const rest = continuation(prefix);
    const blank = rest.trimEnd();
    const block = [
      `${prefix}::: {custom-style="Diagram"}`,
      `${rest}![Diagram](<${file}>)`,
      `${rest}:::`,
    ];
    if (!isBlank(lines[from - 1], rest)) block.unshift(blank);
    if (!isBlank(lines[to], rest)) block.push(blank);
    lines.splice(from, to - from, ...block);
  }
  return lines.join("\n");
}

// Paper size --------------------------------------------------------------------

// Regions that use US Letter paper; everywhere else uses A4.
const LETTER_REGIONS = new Set(["US", "PR", "CA", "MX", "PH"]);

export function paperFor(locale: string): Paper {
  try {
    const l = new Intl.Locale(locale.replace(/_/g, "-").split(/[.@]/)[0]);
    const region = l.region ?? l.maximize().region;
    return region && LETTER_REGIONS.has(region) ? "Letter" : "A4";
  } catch {
    return "A4";
  }
}

// Settings -----------------------------------------------------------------------

export interface ExportSettings {
  /** "corillo": Corillo's clean style. "word": the styles of the Word document or template in referenceDoc. */
  style: "corillo" | "word";
  referenceDoc?: string;
  /** Advanced: a Pandoc Lua filter that changes the document on its way to Word. */
  luaFilter?: string;
  /** Advanced: a program or script run on the finished Word document. */
  script?: string;
}

export const DEFAULT_SETTINGS: ExportSettings = { style: "corillo" };

const isPath = (v: unknown): v is string => typeof v === "string" && path.isAbsolute(v);

/** Export settings from what was stored, ignoring anything that doesn't make sense. */
export function exportSettingsFrom(raw: unknown): ExportSettings {
  const r = (raw && typeof raw === "object" ? raw : {}) as Record<string, unknown>;
  const settings: ExportSettings = { style: "corillo" };
  if (r.style === "word" && isPath(r.referenceDoc)) {
    settings.style = "word";
    settings.referenceDoc = r.referenceDoc;
  }
  if (isPath(r.luaFilter)) settings.luaFilter = r.luaFilter;
  if (isPath(r.script)) settings.script = r.script;
  return settings;
}

/** The settings that name a file. */
export type FileSetting = "referenceDoc" | "luaFilter" | "script";

/** Files the person chose in Export Settings' dialogs for one document, by the setting each was chosen for. */
export type ChosenFiles = Partial<Record<FileSetting, ReadonlySet<string>>>;

/**
 * Whether settings the window sends may be stored: each file in them (the
 * Word document for styles, the Lua filter, the script) must be one the
 * person chose in a dialog this session, for this document and this setting,
 * or the one already stored. The script and filter run at every export, the
 * person's or an agent's, so nothing in the window (a document or a paste
 * that tricked it) can set one, or move one chosen for another document or
 * setting (a filter made the script, say).
 */
export function settingsAllowed(next: ExportSettings, stored: ExportSettings, chosen: ChosenFiles): boolean {
  return (["referenceDoc", "luaFilter", "script"] as const).every((key) => {
    const file = next[key];
    return !file || file === stored[key] || (chosen[key]?.has(file) ?? false);
  });
}

// Scripts run on the finished Word document -----------------------------------------

// Python (.py) is found separately (see python below).
const INTERPRETERS: Record<string, string> = {
  ".sh": "/bin/sh",
  ".bash": "/bin/bash",
  ".zsh": "/bin/zsh",
  ".rb": "ruby",
  ".pl": "perl",
  ".applescript": "/usr/bin/osascript",
  ".scpt": "/usr/bin/osascript",
  ".lua": "lua",
};

function isExecutable(file: string): boolean {
  try {
    fs.accessSync(file, fs.constants.X_OK);
    return fs.statSync(file).isFile();
  } catch {
    return false;
  }
}

/** Where to look for programs, and Apple's developer tools (null when they aren't installed). */
export interface ProgramPlaces {
  pathDirs: string[];
  developerDir: () => string | null;
}

const MAC_PLACES: ProgramPlaces = {
  pathDirs: [...(process.env.PATH ?? "").split(":"), "/opt/homebrew/bin", "/usr/local/bin", "/usr/bin", "/bin"].filter(Boolean),
  developerDir: () => {
    try {
      return execFileSync("/usr/bin/xcode-select", ["-p"], { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"], timeout: 5_000 }).trim() || null;
    } catch {
      return null;
    }
  },
};

/**
 * Python, if this Mac has it. Apple's /usr/bin/python3 is only a stand-in
 * until its developer tools are installed: run without them, it asks macOS
 * to install them, so it counts only when they're there.
 */
function python(places: ProgramPlaces): string | null {
  for (const dir of places.pathDirs) {
    const file = path.join(dir, "python3");
    if (dir === "/usr/bin") {
      const tools = places.developerDir();
      if (tools && fs.existsSync(path.join(tools, "usr", "bin", "python3"))) return file;
      continue;
    }
    if (isExecutable(file)) return file;
  }
  return null;
}

export type ScriptCommand = { file: string; args: string[]; node?: true } | { problem: string };

/**
 * How to run the person's script on the finished Word document: an app
 * opens the document; JavaScript runs on Corillo's own engine (`node`), so
 * nothing needs installing, and Python on an installed Python, even when
 * made executable (its first line would reach for macOS's stand-in, which
 * offers to install developer tools); any other executable runs itself; a
 * script that isn't executable runs by its kind.
 */
export function scriptCommand(script: string, docxPath: string, places: ProgramPlaces = MAC_PLACES): ScriptCommand {
  const name = path.basename(script);
  const ext = path.extname(script).toLowerCase();
  let isDir = false;
  try {
    isDir = fs.statSync(script).isDirectory();
  } catch {
    // run as named
  }
  if (ext === ".app" && isDir) return { file: "/usr/bin/open", args: ["-a", script, docxPath] };
  if (ext === ".js" || ext === ".mjs" || ext === ".cjs") return { file: process.execPath, args: [script, docxPath], node: true };
  if (ext === ".py") {
    const found = python(places);
    if (!found) return { problem: `The script ${name} needs Python, which isn't installed on this Mac, so it wasn't run.` };
    return { file: found, args: [script, docxPath] };
  }
  if (isExecutable(script)) return { file: script, args: [docxPath] };
  if (INTERPRETERS[ext]) return { file: INTERPRETERS[ext], args: [script, docxPath] };
  return { problem: `Corillo doesn't know how to run ${name}, so it wasn't run. Choose an app, or a script ending in .py, .sh, .js or .rb.` };
}

// Pandoc ---------------------------------------------------------------------------

/** A problem with an export, explained in plain words for the person. */
export class ExportError extends Error {}

export interface PandocPlace {
  packaged: boolean;
  resourcesPath: string;
  appPath: string;
  arch: string;
}

/** Where Pandoc is: in the packaged app's resources, or in vendor/ while developing. */
export function pandocLocation(place: PandocPlace): string {
  const base = place.packaged ? path.join(place.resourcesPath, "pandoc") : path.join(place.appPath, "vendor", "pandoc");
  return path.join(base, place.arch, "pandoc");
}

export const PANDOC_MISSING =
  "Word export isn't available because part of Corillo is missing (Pandoc, the program that makes Word documents). Reinstalling Corillo should fix it.";

/** The first macOS the Pandoc inside Corillo runs on. Corillo itself opens from macOS 13. */
export const PANDOC_MIN_MACOS = 15;

export const WORD_NEEDS_NEWER_MAC = `Opening Word documents and exporting to Word need macOS ${PANDOC_MIN_MACOS} or later. Everything else in Corillo works on this Mac.`;

/**
 * Whether this Mac is too old for the Pandoc inside Corillo, from Darwin's
 * release number as the Mac reports it (os.release(): macOS 13 is Darwin 22,
 * 14 is 23, 15 is 24). A number it can't read never stops Word.
 */
export function macTooOldForWord(darwinRelease: string): boolean {
  const darwin = Number.parseInt(darwinRelease, 10);
  return Number.isFinite(darwin) && darwin - 9 < PANDOC_MIN_MACOS;
}

const nameOf = (file: string) => path.basename(file);

/** What went wrong making a Word document, in plain words: Pandoc's own errors, or the Mac's. */
export function pandocProblem(
  err: Error & { stderr?: string; code?: string | number; killed?: boolean; path?: string; syscall?: string },
  settings: ExportSettings,
): ExportError {
  if (err.killed) return new ExportError("Making the Word document took too long and was stopped.");
  // The Mac's own errors (a file that can't be read, a program that can't start), not Pandoc's.
  if (typeof err.code === "string" && /^E[A-Z]+$/.test(err.code)) {
    const theirs = settings.style === "word" && settings.referenceDoc && err.path === settings.referenceDoc;
    if (theirs && (err.code === "EACCES" || err.code === "EPERM")) {
      return new ExportError(
        `Corillo isn't allowed to read ${nameOf(settings.referenceDoc!)}, the Word document whose styles you chose. Choose another in Export Settings, or check its sharing and permissions in Finder.`,
      );
    }
    if (theirs) return new ExportError(`${nameOf(settings.referenceDoc!)}, the Word document whose styles you chose, can't be read. Choose it again in Export Settings.`);
    if (err.syscall?.startsWith("spawn")) {
      return new ExportError("Pandoc, the program inside Corillo that makes Word documents, couldn't be started. Reinstalling Corillo should fix it.");
    }
    if (err.code === "ENOSPC") return new ExportError("The Word document couldn't be made: the disk is full.");
    return new ExportError("The Word document couldn't be made: Corillo couldn't use its temporary folder. Try again, or restart the Mac if it keeps happening.");
  }
  const detail = firstProblem(err.stderr) || err.message;
  // Pandoc meeting the Mac's own errors (Batch 21, E21-7): a full disk, or a file in its work folder it can't write.
  if (/No space left on device|Disk quota exceeded/i.test(err.stderr ?? "")) return new ExportError("The Word document couldn't be made: the disk is full.");
  if (settings.luaFilter && detail.includes(nameOf(settings.luaFilter))) {
    return new ExportError(`The Lua filter ${nameOf(settings.luaFilter)} stopped with an error: ${detail}`);
  }
  // Only Pandoc's own words for a styles document it can't read: its output, export.docx, is named in other errors too.
  if (settings.style === "word" && settings.referenceDoc && /reference[- ]?doc/i.test(detail)) {
    return new ExportError(
      `The styles couldn't be read from ${nameOf(settings.referenceDoc)}. Choose a Word document (.docx) or template (.dotx) in Export Settings.`,
    );
  }
  if (/\b(?:with|open)BinaryFile\b|\bopenFile\b/.test(detail)) {
    return new ExportError("The Word document couldn't be made: Corillo couldn't use its temporary folder. Try again, or restart the Mac if it keeps happening.");
  }
  return new ExportError(`The Word document couldn't be made: ${detail}`);
}

/** The useful part of a program's error output, for showing to a person. */
export function firstProblem(stderr: string | undefined): string {
  // Pandoc's backtrace is for its makers, never for the person.
  const lines = (stderr ?? "")
    .split(/^\s*HasCallStack backtrace:/m)[0]
    .split("\n")
    .map((l) => l.trim())
    .filter((l) => l && !/^\[WARNING\]/.test(l));
  return lines.slice(0, 3).join(" ").slice(0, 300);
}

/** Pandoc's warnings that something was left out, as notes (Corillo's own pictures step should leave none). */
export function warningNotes(stderr: string): string[] {
  return stderr
    .split("\n")
    .map((l) => /^\[WARNING\]\s*(Could not .*)$/.exec(l.trim())?.[1])
    .filter((l): l is string => !!l)
    .map((l) => endSentence(`Part of the document was left out of the Word document: ${l.slice(0, 200)}`));
}

/**
 * The document without the YAML front matter at its very top (the same block
 * the editor shows as "Document details"): it's information for tools, not
 * part of what's shared, so Word and PDF leave it out (Orlando). The blank
 * line under it goes too; any more are empty lines, as the page shows them.
 */
export function withoutFrontMatter(text: string): string {
  const bom = text.startsWith("\uFEFF") ? "\uFEFF" : "";
  const lines = text.slice(bom.length).split(/(?<=\n)/);
  // The same block the editor finds (see front-matter.ts).
  const end = frontMatterEnd(lines.map((l) => l.replace(/\r?\n$/, "")));
  if (end < 0) return text;
  let rest = end + 1;
  if (rest < lines.length && /^[ \t]*\r?\n$/.test(lines[rest])) rest++;
  const left = lines.slice(rest);
  // What's left, read afresh, mustn't read as details itself: "---", "Owner: Ana", "---" is a line and a
  // heading in the editor, so its first line is written as the same line in another way (Batch 21, E21-4).
  if (frontMatterEnd(left.map((l) => l.replace(/\r?\n$/, ""))) >= 0) left[0] = left[0].replace(/^---/, "***");
  return bom + left.join("");
}

// Empty lines in Word ---------------------------------------------------------------

/** Where the page shows a blank line as a line of space, Word gets this: Corillo's Lua filter makes it an empty paragraph. */
export const BLANK_MARK = "<!--corillo blank-->";

/**
 * The document with each blank line the page shows as a line of space
 * marked for Word (Orlando, 2026-11-09: "An empty line in markdown doc should
 * show up as an empty line in word"). Pandoc would join them all into the
 * space between paragraphs; Word has none of its own, so each becomes an
 * empty paragraph: the blank line between two blocks, each one more, and
 * inside a list or quote, one where the file has a blank line, as the page
 * draws it. Blocks written close get none. What Word leaves out (link
 * definitions, notes, comments) leaves no empty line of its own, and blank
 * lines after the last words go. Nothing else changes: if a mark would change
 * how the rest reads, it isn't made.
 *
 * Tables are written so Pandoc reads them as the page does (Batch 22): one
 * right under a line of text gets a blank line above it (E21-3), and in a
 * table the page keeps as Markdown, a | inside code is written \| (E21-5).
 */
export function blankLinesForWord(markdown: string): string {
  const text = lf(markdown);
  const { doc, source } = parseMarkdown(text);
  const layout = markdownLayout(doc, source);
  const tokens = markdownTokens(text);
  const original = shapeOf(tokens);
  const pieces: { kind: "words" | "left" | "empty"; gap: string; text: string; word?: string }[] = [];
  doc.forEach((node, _pos, k) => {
    const block = layout.blocks[k];
    if (!block) return;
    if (isEmptyLine(node)) pieces.push({ kind: "empty", gap: block.gap, text: BLANK_MARK });
    else if (leftOutOfWord(node, block.text)) pieces.push({ kind: "left", gap: block.gap, text: block.text });
    else if (node.type.name === "raw_block" && node.attrs.kind === "table") pieces.push({ kind: "words", gap: block.gap, text: block.text, word: tableForWord(block.text) });
    else pieces.push({ kind: "words", gap: block.gap, text: withInnerBlanks(node, block.text) });
  });
  let lastWords = pieces.length - 1;
  while (lastWords >= 0 && pieces[lastWords].kind !== "words") lastWords--;
  if (lastWords < 0) return markdown;

  /**
   * The text with the marks `use` allows (counted from the top); the others'
   * places are left as written. Only the pieces from `from` to `to` are
   * written; `owner` is the piece each mark is written with.
   */
  const assemble = (use: (mark: number) => boolean, from = 0, to = pieces.length, forWord = false) => {
    const whole = from === 0 && to === pieces.length;
    let out = whole ? (source.bom ? "\uFEFF" : "") + layout.prefix : "";
    let wrote = false;
    let apart = false; // the next block needs a blank line before it
    let marks = from === 0 ? 0 : firstMark[from];
    const owner: number[] = [];
    const mark = (i: number) => {
      owner.push(i);
      return use(marks++);
    };
    const put = (gap: string, words: string) => {
      if (wrote) out += apart ? "\n\n" : gap;
      out += words;
      wrote = true;
      apart = words === BLANK_MARK;
    };
    for (let i = from; i < to; i++) {
      const piece = pieces[i];
      if (piece.kind === "empty" && i > lastWords) {
        apart = true;
        continue;
      }
      const before = pieces[i - 1];
      // The blank line between two blocks with words: decided by the gap after the first.
      if (before?.kind === "words" && i - 1 < lastWords && lineBreaks(piece.gap) >= 2 && mark(i)) put(piece.gap, BLANK_MARK);
      if (piece.kind === "empty" && !mark(i)) {
        put(piece.gap, "");
        continue;
      }
      if (piece.kind === "empty") apart = true;
      put(piece.gap, forWord ? (piece.word ?? piece.text) : piece.text);
    }
    return { out: whole ? out + layout.trailing : out, marks, owner };
  };
  const firstMark: number[] = []; // how many marks come before each piece
  const all = assemble(() => true);
  for (let i = 0, m = 0; i <= pieces.length; i++) {
    while (m < all.owner.length && all.owner[m] < i) m++;
    firstMark[i] = m;
  }
  const on = new Array<boolean>(all.marks).fill(true);
  // A last check that the marks changed nothing else.
  if (!readsAs(all.out, original)) {
    // One odd passage: leave out only the marks at fault, so the rest of the document keeps its empty lines (Batch 21, E21-6).
    // First a few pieces at a time, each read with the blocks around it: cheap, and almost always right.
    on.fill(false);
    const STRETCH = 16;
    for (let start = 0; start < pieces.length; start += STRETCH) {
      const end = Math.min(start + STRETCH, pieces.length);
      const ids = Array.from({ length: firstMark[end] - firstMark[start] }, (_, k) => firstMark[start] + k);
      if (!ids.length) continue;
      // With the nearest block with words (or one Word leaves out) on each side.
      let from = start - 1;
      while (from > 0 && pieces[from].kind === "empty") from--;
      let to = end;
      while (to < pieces.length - 1 && pieces[to].kind === "empty") to++;
      const around = (use: (mark: number) => boolean) => assemble(use, Math.max(from, 0), Math.min(to + 1, pieces.length)).out;
      const shape = shapeOf(markdownTokens(around(() => false)));
      byHalves(ids, on, () => readsAs(around((m) => on[m] && all.owner[m] >= start && all.owner[m] < end), shape));
    }
    // Then the whole document read once; if that still reads otherwise, by halves through it.
    if (!readsAs(assemble((m) => on[m]).out, original)) {
      const ids = on.flatMap((kept, m) => (kept ? [m] : []));
      on.fill(false);
      byHalves(ids, on, () => readsAs(assemble((m) => on[m]).out, original));
    }
  }
  // If even that reads otherwise, no marks; the tables are still written for Word (R22-1).
  let use = (m: number) => on[m];
  if (!readsAs(assemble(use).out, original)) use = () => false;
  if (!readsAs(assemble(use).out, original)) return markdown;
  const forWord = assemble(use, 0, pieces.length, true).out;
  return tokens.some(tableUnderText) ? tablesApart(forWord) : forWord;
}

/** Whether a text reads as the shape given. */
const readsAs = (text: string, shape: string): boolean => shapeOf(markdownTokens(text)) === shape;

/**
 * The marks of `ids` that keep `check` true, found by halves: a stretch that
 * passes is kept whole, one that doesn't is split. Each pass is checked with
 * the marks kept before it, so what's kept always passed together. Where
 * halving would cost more checks than one mark at a time, the rest are tried
 * one at a time: what's kept never depends on how many checks it took (R22-1).
 */
function byHalves(ids: number[], on: boolean[], check: () => boolean): void {
  let left = ids.length;
  const later: number[] = [];
  const tryOn = (from: number, to: number): void => {
    if (left <= 0) {
      for (let k = from; k < to; k++) later.push(k);
      return;
    }
    left--;
    for (let k = from; k < to; k++) on[ids[k]] = true;
    if (check()) return;
    for (let k = from; k < to; k++) on[ids[k]] = false;
    if (to - from === 1) return;
    const middle = Math.floor((from + to) / 2);
    tryOn(from, middle);
    tryOn(middle, to);
  };
  if (ids.length) tryOn(0, ids.length);
  for (const k of later) {
    on[ids[k]] = true;
    if (!check()) on[ids[k]] = false;
  }
}

const lineBreaks = (s: string) => s.split("\n").length - 1;

/** A block Word doesn't show where it's written: link definitions, notes (they go to the foot of the page) and comments. */
function leftOutOfWord(node: Node, text: string): boolean {
  if (node.type.name === "footnote_def") return true;
  if (node.type.name === "raw_block") return ["links", "definitions", "comment", "front-matter"].includes(node.attrs.kind);
  // A paragraph of Obsidian comments only, or a block id on its own line.
  return node.type.name === "paragraph" && (/^(?:\s*%%[\s\S]*?%%)+\s*$/.test(text) || /^\s*\^[A-Za-z0-9-]+\s*$/.test(text));
}

/** A list or quote with a mark at each blank line between its parts that the page shows as a line of space. */
function withInnerBlanks(node: Node, text: string): string {
  if (node.type.name === "raw_block" || node.isTextblock || node.isLeaf) return text;
  // From the last, so the lines before keep their places.
  const blanks = [...new Map(innerBlankLines(node, text).map((b) => [b.line, b])).values()].sort((a, b) => b.line - a.line);
  if (!blanks.length) return text;
  const lines = text.split("\n");
  // The mark goes at the end of the part before the blank line, indented as
  // the line before it, or the part's first line, or the next part's; the first that changes nothing else.
  const places = blanks.map((b) => [...new Set([lines[b.line - 1], lines[b.before], lines[b.after]].filter((l) => l !== undefined).map(continuationOf))]);
  const choice: (number | null)[] = blanks.map(() => null);
  /** Lines `from` to `to` with the chosen marks among blanks `last` (exclusive) down to `first`, built in one pass (R22-2). */
  const written = (from = 0, to = lines.length, first = 0, last = blanks.length) => {
    const out: string[] = [];
    let i = last - 1;
    for (let l = from; l < to; l++) {
      for (; i >= first && blanks[i].line <= l; i--) if (choice[i] !== null) out.push(places[i][choice[i]!] + BLANK_MARK);
      out.push(lines[l]);
    }
    for (; i >= first; i--) if (choice[i] !== null) out.push(places[i][choice[i]!] + BLANK_MARK);
    return out.join("\n");
  };
  const keys = withoutMarks(markdownTokens(text)).map((t) => keyOf(t));
  const shape = keys.join(SHAPE_JOIN);
  const whole = () => readsAs(written(), shape);
  // Almost always, each mark indented as the line before it changes nothing else: one check for them all.
  // Else every mark at its next place at once (a line wrapped by hand: usually the one at fault has a
  // second place that works). Else the mark where the reading first differs moves to its next place, a
  // few times (an empty item, code under an item). Else the marks are tried by halves, each stretch
  // all at one place, then the next (Batch 22, E21-23); where that would take more checks than one
  // blank at a time, the rest go one at a time, so what's kept never depends on the checks (R22-1).
  const together = (from: number, to: number, check: () => boolean): boolean => {
    const most = places.slice(from, to).reduce((m, p) => Math.max(m, p.length), 0);
    for (let k = 0; k < most; k++) {
      for (let i = from; i < to; i++) choice[i] = Math.min(k, places[i].length - 1);
      if (check()) return true;
    }
    for (let i = from; i < to; i++) choice[i] = null;
    return false;
  };
  const repaired = (): boolean => {
    choice.fill(0);
    for (let round = 0; round < REPAIRS; round++) {
      const read = withoutMarks(markdownTokens(written()));
      let d = 0;
      while (d < read.length && d < keys.length && keyOf(read[d]) === keys[d]) d++;
      if (d === read.length && d === keys.length) return true;
      // The line where the reading first differs, and the first mark at or after it (from the top).
      let j = Math.min(d, read.length - 1);
      while (j > 0 && !read[j].map) j--;
      const line = read[j]?.map?.[0] ?? 0;
      let above = 0;
      let at = -1;
      for (let i = blanks.length - 1; i >= 0 && at < 0; i--) {
        if (choice[i] === null) continue;
        if (blanks[i].line + above >= line) at = i;
        above++;
      }
      if (at < 0) break;
      choice[at] = choice[at]! + 1 < places[at].length ? choice[at]! + 1 : null;
    }
    choice.fill(null);
    return false;
  };
  const byStretches = (from: number, to: number, check: () => boolean): void => {
    let left = to - from;
    const later: number[] = [];
    const tryOn = (a: number, b: number): void => {
      if (left <= 0) {
        for (let i = a; i < b; i++) later.push(i);
        return;
      }
      left--;
      if (together(a, b, check) || b - a === 1) return;
      const middle = Math.floor((a + b) / 2);
      tryOn(a, middle);
      tryOn(middle, b);
    };
    tryOn(from, to);
    for (const i of later) together(i, i + 1, check);
  };
  if (together(0, blanks.length, whole)) return written();
  // A long list is searched a few items at a time, each read on its own: an item that starts a line
  // after a blank line reads the same with or without the items before it. One check of the whole
  // list then confirms it (R22-2).
  const windows = itemWindows(lines, blanks);
  if (windows.length > 1) {
    for (const w of windows) {
      // With the next item's first line, so a mark that would end the list before it is seen.
      const to = Math.min(w.to + 1, lines.length);
      const local = shapeOf(markdownTokens(lines.slice(w.from, to).join("\n")));
      byStretches(w.first, w.last, () => readsAs(written(w.from, to, w.first, w.last), local));
    }
    if (whole()) return written();
    choice.fill(null);
  } else if (repaired()) return written();
  byStretches(0, blanks.length, whole);
  return written();
}

/**
 * A list's lines cut into stretches of a few blank lines each, at the lines
 * that start a top-level item after a blank line: each with its lines (`from`
 * to `to`) and its blanks (`first` to `last`, as `blanks` counts them, from the bottom).
 */
function itemWindows(lines: string[], blanks: { line: number }[]): { from: number; to: number; first: number; last: number }[] {
  const out: { from: number; to: number; first: number; last: number }[] = [];
  let from = 0;
  let last = blanks.length; // the window's blanks run from `last` - 1 down
  let i = blanks.length - 1;
  for (let l = 1; l <= lines.length; l++) {
    if (l < lines.length && !(lines[l - 1].trim() === "" && /^\S/.test(lines[l]))) continue;
    let k = i;
    while (k >= 0 && blanks[k].line < l) k--;
    if (l < lines.length && i - k < WINDOW) continue;
    out.push({ from, to: l, first: k + 1, last: i + 1 });
    from = l;
    i = k;
  }
  return out.filter((w) => w.first < w.last);
}

/** About how many blank lines a long list's stretches hold. */
const WINDOW = 8;

/** How many times a mark at fault is moved on before the marks are tried by halves. */
const REPAIRS = 8;

/** What starts a line, as the next line of the same part would start: quote marks, and spaces for list markers. */
function continuationOf(line: string): string {
  const start = /^(?:[ \t]*(?:>|(?:[-+*]|\d{1,9}[.)])(?=[ \t]|$)))*[ \t]*/.exec(line)![0];
  return start.replace(/[-+*]|\d{1,9}[.)]/g, (m) => " ".repeat(m.length));
}

/**
 * How a text read as tokens reads as blocks, apart from the blank-line marks:
 * two texts with the same shape are the same blocks. `tight` false leaves out
 * whether a list is tight, which a blank line inside an item changes.
 */
function shapeOf(tokens: MarkdownToken[], tight = true): string {
  return withoutMarks(tokens)
    .map((t) => keyOf(t, tight))
    .join(SHAPE_JOIN);
}

const SHAPE_JOIN = "\u0001";
const withoutMarks = (tokens: MarkdownToken[]) => tokens.filter((t) => !(t.type === "html_block" && t.content.trim() === BLANK_MARK));
const keyOf = (t: MarkdownToken, tight = true) =>
  `${t.type}\u0000${tight && t.hidden}\u0000${t.markup}\u0000${t.info}\u0000${t.children ? t.content : t.block && t.nesting === 0 ? t.content : ""}`;

// Tables Pandoc reads as the page does ------------------------------------------------

/** A table that starts right under a paragraph's last line: the page reads a table, Pandoc more of the paragraph. */
const tableUnderText = (t: MarkdownToken, k: number, tokens: MarkdownToken[]) =>
  t.type === "table_open" && !!t.map && tokens[k - 1]?.type === "paragraph_close" && tokens[k - 3]?.type === "paragraph_open" && tokens[k - 3].map?.[1] === t.map[0];

/**
 * The text with a blank line above each table written right under a line of
 * text, in a list item or quote as in the document, so Word gets a table and
 * not the table's lines as words (Batch 22, E21-3). The blank line adds no
 * empty line in Word: only the marks do. If it would change anything else, it
 * isn't made.
 */
function tablesApart(text: string): string {
  const tokens = markdownTokens(text);
  const lines = text.split("\n");
  const starts = tokens.flatMap((t, k) => (tableUnderText(t, k, tokens) ? [t.map![0]] : [])).sort((a, b) => b - a);
  if (!starts.length) return text;
  for (const line of starts) lines.splice(line, 0, continuationOf(lines[line]).trimEnd());
  const apart = lines.join("\n");
  return shapeOf(markdownTokens(apart), false) === shapeOf(tokens, false) ? apart : text;
}

/**
 * A table the page keeps as Markdown, with each | inside code written \|, so
 * Pandoc doesn't cut the code into two cells (Batch 22, E21-5): the person
 * sees the code whole on the page. A row with more cells than the header
 * widens the header with empty cells, so Word keeps every cell (Orlando's
 * call, E21-5): Pandoc would drop the extra ones.
 */
function tableForWord(text: string): string {
  const lines = text.split("\n");
  for (const t of markdownTokens(text)) {
    if (t.type !== "table_open" || !t.map) continue;
    const [header, end] = t.map;
    for (let l = header; l < end; l++) lines[l] = codePipesEscaped(lines[l]);
    let widest = 0;
    for (let l = header + 2; l < end; l++) widest = Math.max(widest, cellsIn(lines[l]));
    const more = widest - cellsIn(lines[header]);
    if (more > 0) {
      lines[header] = withCells(lines[header], "  |", more);
      lines[header + 1] = withCells(lines[header + 1], "---|", more);
    }
  }
  return lines.join("\n");
}

/** What starts a table's line in a list item or quote: quote marks, a list marker, spaces. */
const ROW_START = /^(?:[ \t]*(?:>|(?:[-+*]|\d{1,9}[.)])(?=[ \t]|$)))*[ \t]*/;
const ENDS_IN_PIPE = /(?<!\\)\|[ \t]*$/;

/** How many cells a table's row has, as Pandoc counts them: its | not written \|, less the outer ones. */
function cellsIn(row: string): number {
  const cells = row.slice(ROW_START.exec(row)![0].length).replace(ENDS_IN_PIPE, "").replace(/^\|/, "");
  return cells.trim() ? cells.split(/(?<!\\)\|/).length : 0;
}

/** A header or dividing row with `more` cells at its end. */
function withCells(row: string, cell: string, more: number): string {
  const ended = ENDS_IN_PIPE.test(row) ? row.trimEnd() : `${row.trimEnd()} |`;
  return ended + cell.repeat(more);
}

/** A table row with each | inside code written \| (one already written so is left). */
function codePipesEscaped(row: string): string {
  let out = "";
  let i = 0;
  while (i < row.length) {
    if (row[i] === "\\") {
      out += row.slice(i, i + 2);
      i += 2;
      continue;
    }
    if (row[i] !== "`") {
      out += row[i++];
      continue;
    }
    // Code runs from a run of backticks to the next run of the same length.
    const run = /^`+/.exec(row.slice(i))![0];
    const closing = new RegExp(`(?<!\`)\`{${run.length}}(?!\`)`, "g");
    closing.lastIndex = i + run.length;
    const end = closing.exec(row)?.index;
    if (end === undefined) {
      out += run;
      i += run.length;
      continue;
    }
    out += run + row.slice(i + run.length, end).replace(/(?<!\\)\|/g, "\\|") + run;
    i = end + run.length;
  }
  return out;
}

// Pandoc reads Markdown much as the editor does (CommonMark, tables,
// footnotes, strikethrough). Its extras that Corillo doesn't show are turned
// off, so the Word document reads as the page does: "$5 and $10" stays text,
// "[Plan]" stays in its brackets rather than linking to a heading called
// Plan, and quotes, dashes and dots stay the characters typed (Pandoc would
// curl quotes and turn -- into a dash). A single line break inside a
// paragraph is a line break, as Corillo and Obsidian show it.
export const PANDOC_FROM = [
  "commonmark_x",
  "+hard_line_breaks",
  "-tex_math_dollars",
  "-emoji",
  "-subscript",
  "-superscript",
  "-definition_lists",
  "-fancy_lists",
  "-alerts",
  "-bracketed_spans",
  "-smart",
  "-implicit_header_references",
  "-raw_attribute",
  // Front matter is left out before Pandoc sees the document; nothing else is metadata.
  "-yaml_metadata_block",
].join("");

// Laying out tables and pictures ----------------------------------------------------

/** The width and height of the text on a Word document's page (between its margins), in points. */
export function textArea(docx: Uint8Array): Size {
  const xml = readZipEntry(docx, "word/document.xml")?.toString("utf8") ?? "";
  const sections = xml.match(/<w:sectPr\b[\s\S]*?<\/w:sectPr>/g);
  const last = sections?.[sections.length - 1] ?? "";
  const twips = (tag: string, name: string) => {
    const el = new RegExp(`<w:${tag}\\b[^>]*>`).exec(last)?.[0] ?? "";
    const value = new RegExp(`w:${name}="(-?\\d+)"`).exec(el)?.[1];
    return value === undefined ? NaN : Number(value) / 20;
  };
  const width = twips("pgSz", "w") - twips("pgMar", "left") - twips("pgMar", "right");
  const height = twips("pgSz", "h") - Math.abs(twips("pgMar", "top")) - Math.abs(twips("pgMar", "bottom"));
  return width > 72 && height > 72 ? { width, height } : LETTER_TEXT;
}

type PandocNode = { t?: string; c?: unknown };

/** A cell's words from Pandoc's reading of it (its JSON), a line break as "\n". */
function plainText(node: unknown): string {
  if (Array.isArray(node)) return node.map(plainText).join("");
  const el = node as PandocNode;
  if (!el || typeof el !== "object" || !el.t) return "";
  const c = el.c as unknown[];
  switch (el.t) {
    case "Str":
      return el.c as string;
    case "Space":
    case "SoftBreak":
      return " ";
    case "LineBreak":
      return "\n";
    case "Code":
    case "Math":
      return c[1] as string;
    case "RawInline":
      return c[0] === "html" && /^<br\s*\/?>$/i.test(c[1] as string) ? "\n" : "";
    case "Note":
    case "Image":
      return "";
    case "Link":
    case "Span":
      return plainText(c[1]);
    case "Quoted":
      return `"${plainText(c[1])}"`;
    case "Cite":
      return plainText(c[1]);
    case "Plain":
    case "Para":
      return plainText(el.c);
    default:
      return Array.isArray(el.c) ? el.c.map(plainText).join(el.t === "Div" || el.t === "BlockQuote" ? "\n" : "") : "";
  }
}

type PandocRow = [unknown, [unknown, unknown, number, number, unknown[]][]];

/** Every table in Pandoc's reading of a document (its JSON), in order: each cell's words. */
export function tableTexts(ast: { blocks: unknown[] }): TableText[] {
  const tables: TableText[] = [];
  const cells = (rows: PandocRow[]) => rows.map(([, row]) => row.map((cell) => cell[4].map(plainText).join("\n")));
  const visit = (node: unknown): void => {
    if (Array.isArray(node)) return node.forEach(visit);
    const el = node as PandocNode;
    if (!el || typeof el !== "object") return;
    if (el.t === "Table") {
      const [, , , head, bodies, foot] = el.c as [unknown, unknown, unknown, [unknown, PandocRow[]], [unknown, number, PandocRow[], PandocRow[]][], [unknown, PandocRow[]]];
      const header = cells(head[1]);
      tables.push({
        rows: [...header, ...bodies.flatMap(([, , top, rows]) => [...cells(top), ...cells(rows)]), ...cells(foot[1])],
        headerRows: header.length,
      });
    }
    if (el.t) visit(el.c);
  };
  visit(ast.blocks);
  return tables;
}

/** A picture made ready for Word (see export-pictures.ts): the file to take it from, its kind, and its name in the Word file. */
export interface WordPicture {
  file: string;
  mime: string;
  ext: string;
  name: string;
}

/**
 * How Corillo's Lua filter lays out a document: each table's column widths
 * (or null: Word sizes it), the page's text area, and each picture's address
 * as the document has it with the file it's exported from. A picture not
 * listed is left out (its words, the alt text, stay).
 */
export interface WordLayout {
  tables: (number[] | null)[];
  area: Size;
  pictures: Record<string, WordPicture>;
  /** Which of Corillo's own styles the Word style file has (all of them in Corillo's own; see templateStyles). */
  styles: string[];
  /** The id of the Word style file's "Body Text" style, which empty lines take (see bodyTextStyle). */
  bodyText: string;
}

export function wordLayout(
  ast: { blocks: unknown[] },
  area: Size,
  pictures: Record<string, WordPicture> = {},
  styles: string[] = CORILLO_STYLES,
  bodyText = "BodyText",
): WordLayout {
  return { tables: allColumnWidths(tableTexts(ast), area.width), area, pictures, styles, bodyText };
}

/**
 * Column widths for every table of a document, from one budget of work for
 * them all (SEARCH_BUDGET), so a document of many big tables can't hold up
 * the window or agents, and gets the same widths on a busy Mac as on a quiet
 * one. The smallest tables are worked out first, so ordinary tables always
 * get their best widths; the biggest share what's left.
 */
export function allColumnWidths(tables: TableText[], width: number, budget: SearchBudget = { left: SEARCH_BUDGET }): (number[] | null)[] {
  const size = (t: TableText) => t.rows.reduce((sum, row) => sum + row.reduce((n, cell) => n + cell.length, 0), 0);
  const order = tables.map((t, i) => ({ i, size: size(t) })).sort((a, b) => a.size - b.size || a.i - b.i);
  const widths: (number[] | null)[] = new Array(tables.length).fill(null);
  for (const { i } of order) widths[i] = columnWidths(tables[i], width, WORD_TABLE, budget);
  return widths;
}

/** The styles Corillo's Lua filter gives callouts, quotes inside quotes and diagrams (reference-docx.ts defines them). */
export const CORILLO_STYLES = [
  ...["Sky", "Mint", "Ochre", "Rose", "Lilac", "Stone"].map((c) => `Callout ${c}`),
  "Block Text 2",
  "Block Text 3",
  "Diagram",
];

/**
 * Which of Corillo's own styles a Word document or template defines. A
 * person's own template usually has none, and Pandoc would make each up with
 * no formatting, so a callout or a quote inside a quote would look plainer
 * than Pandoc's own quote; the filter uses only the ones that are there.
 */
export function templateStyles(docx: Uint8Array): string[] {
  const xml = readZipEntry(docx, "word/styles.xml")?.toString("utf8") ?? "";
  const names = new Set<string>();
  for (const m of xml.matchAll(/<w:style\b[^>]*\bw:styleId="([^"]*)"[^>]*>([\s\S]*?)<\/w:style>/g)) {
    names.add(m[1].toLowerCase());
    const name = /<w:name w:val="([^"]*)"/.exec(m[2])?.[1];
    if (name) names.add(name.toLowerCase());
  }
  return CORILLO_STYLES.filter((s) => names.has(s.toLowerCase()) || names.has(s.replace(/ /g, "").toLowerCase()));
}

/**
 * The id of a Word style file's "Body Text" paragraph style, found by its
 * name as Pandoc finds it (a template made in another language can give it
 * another id); Pandoc's own, "BodyText", when the file has none.
 */
export function bodyTextStyle(docx: Uint8Array): string {
  const xml = readZipEntry(docx, "word/styles.xml")?.toString("utf8") ?? "";
  for (const m of xml.matchAll(/<w:style\b([^>]*)>([\s\S]*?)<\/w:style>/g)) {
    const id = /\bw:styleId="([^"]*)"/.exec(m[1])?.[1] ?? "";
    if (/\bw:type="paragraph"/.test(m[1]) && /<w:name w:val="body text"\s*\/>/i.test(m[2]) && /^[\w.-]+$/.test(id)) return id;
  }
  return "BodyText";
}

/** Pandoc's arguments for reading the document into `output`, to measure its tables (the same reading as for Word). */
export function pandocJsonArgs(input: string, output: string): string[] {
  return [input, `--from=${PANDOC_FROM}`, "--to=json", `--output=${output}`, "--sandbox"];
}

/** A Lua long string holding `text` as it is, whatever it holds. */
function luaString(text: string): string {
  let level = 2;
  while (text.includes(`]${"=".repeat(level)}]`)) level++;
  const eq = "=".repeat(level);
  return `[${eq}[${text}]${eq}]`;
}

/**
 * Corillo's own Lua filter, run before any the person chose. Pandoc keeps
 * HTML as HTML, which Word leaves out; and Word has no quote inside a quote
 * or coloured box of its own. So:
 *
 * First, each blank line marked by blankLinesForWord is an empty paragraph:
 *    Word's text has no space of its own, so the space is where the page shows it.
 * 0. Each table gets the column widths that make it shortest (columnWidths,
 *    measured before the filter runs), and each picture its size: its own,
 *    made smaller to fit the page (fitPicture in src/core/picture-size.ts,
 *    the same rule; the page shows pictures at the same size). Only the
 *    pictures Corillo checked (export-pictures.ts) go in, from the files it
 *    named; any other becomes its words (the alt text), so nothing else on
 *    the Mac or the web can get into the Word document as a picture.
 * 1. HTML written in the text or a table cell, as agents often write it (a
 *    line break as <br>, bold as <b>, a highlight as <mark>), becomes a real
 *    line break and real formatting, as the page shows it. Tags it can't pair
 *    up are left out, as Word would. A block of HTML is read as HTML, so its
 *    words reach Word instead of vanishing; a hidden <!-- note --> stays out,
 *    and so do its pictures and frames (the page shows only its words). It's
 *    read with no access to files or the web.
 * 2. A quote inside a quote is set further in ("Block Text 2" and "3"), and a
 *    callout (marked by obsidianForExport) is a coloured box ("Callout Sky"
 *    and the rest), as on the page.
 */
export function wordFilter(layout: WordLayout): string {
  return `local LAYOUT = pandoc.json.decode(${luaString(JSON.stringify(layout))})
local TALLEST = ${TALLEST}
${WORD_FILTER_BODY}`;
}

const WORD_FILTER_BODY = `
-- A blank line the page shows as a line of space (marked by blankLinesForWord) is an empty paragraph.
local blanks = {
  RawBlock = function(el)
    if el.format == "html" and el.text:match("^%s*<!%-%-corillo blank%-%->%s*$") then return pandoc.Para({ pandoc.Str("") }) end
  end,
}

-- 0. Column widths, in the order the tables were measured (before anything else changes them).
local table_number = 0
local widths = {
  traverse = "topdown",
  Table = function(tbl)
    table_number = table_number + 1
    local shares = LAYOUT.tables[table_number]
    if type(shares) ~= "table" or #shares ~= #tbl.colspecs then return nil end
    local specs = tbl.colspecs
    for i, spec in ipairs(specs) do specs[i] = { spec[1], shares[i] } end
    tbl.colspecs = specs
    return tbl
  end,
}

-- A width or height written on a picture ("120px", "2in", "50%"), in points.
local function points(value)
  if not value then return nil end
  local n, unit = tostring(value):match("^%s*([%d.]+)%s*(%a*%%?)%s*$")
  n = tonumber(n)
  if not n then return nil end
  if unit == "" or unit == "px" then return n * 0.75 end
  if unit == "pt" then return n end
  if unit == "in" then return n * 72 end
  if unit == "cm" then return n * 72 / 2.54 end
  if unit == "mm" then return n * 72 / 25.4 end
  if unit == "%" then return LAYOUT.area.width * n / 100 end
  return nil
end

-- Each checked picture goes into the Word document from the file Corillo named,
-- once however often it's shown, under its name in the Word file. The picture
-- keeps its address as the document writes it until Corillo's last filter
-- (wordFilterLast), so a person's own filter still finds "chart.png" by name.
local inserted = {}
local function insert(ready)
  local contents = inserted[ready.name]
  if contents then return contents end
  local f = io.open(ready.file, "rb")
  if not f then return nil end
  contents = f:read("a")
  f:close()
  inserted[ready.name] = contents
  pandoc.mediabag.insert(ready.name, ready.mime, contents)
  return contents
end

local pictures = {
  Image = function(img)
    local ready = LAYOUT.pictures[img.src]
    if type(ready) ~= "table" then return img.caption end
    local contents = insert(ready)
    if not contents then return img.caption end
    local ok, size = pcall(pandoc.image.size, contents)
    -- Every picture that gets here is a PNG, JPEG or GIF (export-pictures.ts draws
    -- the other kinds as PNGs, or leaves them out), which Pandoc measures; if it
    -- somehow can't, Pandoc sizes it.
    if not ok or not size or size.width <= 0 or size.height <= 0 then return img end
    local w = size.width * 72 / ((size.dpi_horz or 0) > 0 and size.dpi_horz or 72)
    local h = size.height * 72 / ((size.dpi_vert or 0) > 0 and size.dpi_vert or 72)
    local asked_w, asked_h = points(img.attributes.width), points(img.attributes.height)
    if asked_h and img.attributes.height:match("%%") then asked_h = nil end
    if asked_w and asked_h then w, h = asked_w, asked_h
    elseif asked_w then h, w = h * asked_w / w, asked_w
    elseif asked_h then w, h = w * asked_h / h, asked_h end
    local scale = math.min(1, LAYOUT.area.width / w, LAYOUT.area.height * TALLEST / h)
    img.attributes.width = string.format("%.2fin", w * scale / 72)
    img.attributes.height = string.format("%.2fin", h * scale / 72)
    return img
  end,
}

local function highlight(items) return pandoc.Span(items, pandoc.Attr("", { "mark" })) end
local function code(items) return pandoc.Code(pandoc.utils.stringify(items)) end
local MARKS = {
  b = pandoc.Strong, strong = pandoc.Strong,
  i = pandoc.Emph, em = pandoc.Emph,
  s = pandoc.Strikeout, del = pandoc.Strikeout, strike = pandoc.Strikeout,
  u = pandoc.Underline, ins = pandoc.Underline,
  sup = pandoc.Superscript, sub = pandoc.Subscript,
  mark = highlight, code = code, kbd = code,
}

local function tag(el)
  if el.t ~= "RawInline" or el.format ~= "html" then return nil end
  local close, name = el.text:match("^<(/?)(%a+)[^<>]*>$")
  if not name then return nil end
  return name:lower(), close == "/"
end

-- An <a> tag's address, when it's a web or email address (as a block of HTML keeps); else nil.
local function web_address(text)
  local href = text:match('%shref%s*=%s*"([^"]*)"') or text:match("%shref%s*=%s*'([^']*)'")
  if not href then return nil end
  href = href:gsub("&amp;", "&")
  local scheme = (href:match("^(%a+):") or ""):lower()
  if scheme == "http" or scheme == "https" or scheme == "mailto" then return href end
  return nil
end

local function rebuild(inlines)
  local open = { { items = pandoc.List() } }
  for _, el in ipairs(inlines) do
    local name, closing = tag(el)
    local top = open[#open]
    if name == "br" and not closing then
      top.items:insert(pandoc.LineBreak())
    elseif name and MARKS[name] and not closing then
      open[#open + 1] = { name = name, raw = el, items = pandoc.List() }
    elseif name == "a" and not closing and web_address(el.text) then
      open[#open + 1] = { name = name, raw = el, items = pandoc.List(), href = web_address(el.text) }
    elseif name and closing and top.name == name then
      open[#open] = nil
      open[#open].items:insert(top.href and pandoc.Link(top.items, top.href) or MARKS[name](top.items))
    else
      top.items:insert(el)
    end
  end
  while #open > 1 do
    local top = table.remove(open)
    local into = open[#open].items
    into:insert(top.raw)
    into:extend(top.items)
  end
  return open[1].items
end

-- A frame shows another page; on paper, as on Corillo's page, it's left out.
local function without_frames(text)
  local function ci(word) return (word:gsub("%a", function(c) return "[" .. c:lower() .. c:upper() .. "]" end)) end
  local frame = ci("iframe")
  text = text:gsub("<%s*" .. frame .. "[^>]*>.-<%s*/%s*" .. frame .. "%s*>", "")
  return (text:gsub("<%s*/?%s*" .. frame .. "[^>]*>", ""))
end

local html = {
  Inlines = rebuild,
  RawBlock = function(el)
    if el.format ~= "html" then return nil end
    -- Read with no access to files or the web (the empty list), and keep only words: no pictures.
    local blocks = pandoc.read(without_frames(el.text), "html", nil, {}).blocks
    return blocks:walk({ Image = function() return {} end }):walk({
      Inlines = rebuild,
      Para = function(p) if #p.content == 0 then return {} end end,
      Plain = function(p) if #p.content == 0 then return {} end end,
    })
  end,
}

local CALLOUTS = {
  sky = "Callout Sky", mint = "Callout Mint", ochre = "Callout Ochre",
  rose = "Callout Rose", lilac = "Callout Lilac", stone = "Callout Stone",
}

local function styled(blocks, name)
  return pandoc.Div(blocks, pandoc.Attr("", {}, { ["custom-style"] = name }))
end

-- The style for the colour a callout's title was marked with (<!--corillo callout sky-->), or nil.
local function callout(blocks)
  local first = blocks[1]
  if not first or (first.t ~= "Para" and first.t ~= "Plain") then return nil end
  for i, el in ipairs(first.content) do
    local colour = el.t == "RawInline" and el.format == "html" and el.text:match("^<!%-%-corillo callout (%a+)%-%->$")
    if colour then
      first.content:remove(i)
      return CALLOUTS[colour] or CALLOUTS.sky
    end
  end
  return nil
end

-- Corillo's own styles that the Word style file has. A person's template may
-- have none: then a callout or a quote inside a quote is the template's own
-- quote, as Pandoc would make it, rather than a style Pandoc makes up empty.
local HAS = {}
for _, name in ipairs(LAYOUT.styles) do HAS[name] = true end

local function quotes(depth)
  return {
    traverse = "topdown",
    BlockQuote = function(q)
      local blocks = q.content:walk(quotes(depth + 1))
      local box = callout(blocks)
      if box and HAS[box] then return styled(blocks, box), false end
      local inner = depth == 1 and "Block Text 2" or "Block Text 3"
      if box or depth == 0 or not HAS[inner] then return pandoc.BlockQuote(blocks), false end
      return styled(blocks, inner), false
    end,
  }
end

-- A diagram is centred by the "Diagram" style; without it, it's a picture in a paragraph of its own.
local diagrams = {
  Div = function(div)
    if div.attributes["custom-style"] == "Diagram" and not HAS["Diagram"] then return div.content end
  end,
}

return { blanks, widths, html, quotes(0), diagrams, pictures }
`;

/**
 * Corillo's last filter, run after the person's own:
 *
 * - Each checked picture takes its name in the Word file (where wordFilter
 *   put it), so the Word file holds no address from this Mac. A picture the
 *   person's filter added or pointed elsewhere is theirs, and left as it is.
 * - Each empty line between blocks (an empty paragraph from wordFilter) is
 *   written straight into Word as an empty Body Text paragraph, which Pandoc
 *   doesn't count as a paragraph: so the first words after a heading, table
 *   or list are still "First Paragraph", as with no empty line between. And
 *   the empty lines right under a heading are kept with the next paragraph,
 *   as the heading is, so Word can't end a page with a heading whose text
 *   starts the next. Empty lines inside a quote or list stay Pandoc's, to
 *   keep the quote's style.
 */
export function wordFilterLast(layout: WordLayout): string {
  const names = Object.fromEntries(Object.entries(layout.pictures).map(([src, p]) => [src, p.name]));
  const body = /^[\w.-]+$/.test(layout.bodyText) ? layout.bodyText : "BodyText";
  return `local NAMES = pandoc.json.decode(${luaString(JSON.stringify(names))})
local EMPTY = ${luaString(`<w:p><w:pPr><w:pStyle w:val="${body}"/></w:pPr></w:p>`)}
local KEPT = ${luaString(`<w:p><w:pPr><w:pStyle w:val="${body}"/><w:keepNext/></w:pPr></w:p>`)}
local function empty_line(b)
  return b.t == "Para" and #b.content == 1 and b.content[1].t == "Str" and b.content[1].text == ""
end
-- What Word gets nothing from: a list of empty items, an empty quote, text for other formats.
local writes_nothing
local function all_nothing(blocks)
  for _, b in ipairs(blocks) do if not writes_nothing(b) then return false end end
  return true
end
writes_nothing = function(b)
  if b.t == "RawBlock" then return b.format ~= "openxml" end
  if b.t == "BlockQuote" or b.t == "Div" then return all_nothing(b.content) end
  if b.t == "BulletList" or b.t == "OrderedList" then
    for _, item in ipairs(b.content) do if not all_nothing(item) then return false end end
    return true
  end
  return false
end
return {
  { Image = function(img)
    local name = NAMES[img.src]
    if type(name) == "string" then img.src = name; return img end
  end },
  { Pandoc = function(doc)
    local under_heading = false
    doc.blocks = doc.blocks:map(function(b)
      if empty_line(b) then return pandoc.RawBlock("openxml", under_heading and KEPT or EMPTY) end
      if not writes_nothing(b) then under_heading = b.t == "Header" end
      return b
    end)
    return doc
  end },
}
`;
}

export interface PandocJob {
  input: string;
  output: string;
  referenceDoc: string;
  /** Corillo's own filter (wordFilter, saved to a file), run before the person's. */
  corilloFilter?: string;
  luaFilter?: string;
  /** Corillo's last filter (wordFilterLast, saved to a file), run after the person's. */
  corilloLast?: string;
}

/**
 * Pandoc's arguments. Pandoc can read only what's named here (its sandbox):
 * Corillo's filter hands it the pictures. A Lua filter the person chose may
 * add its own, so with one Pandoc runs in the document's folder, unsandboxed,
 * to find them from there.
 */
export function pandocArgs(job: PandocJob): string[] {
  return [
    job.input,
    `--from=${PANDOC_FROM}`,
    "--to=docx",
    `--output=${job.output}`,
    ...(job.luaFilter ? ["--resource-path=."] : ["--sandbox"]),
    `--reference-doc=${job.referenceDoc}`,
    "--syntax-highlighting=none",
    ...(job.corilloFilter ? [`--lua-filter=${job.corilloFilter}`] : []),
    ...(job.luaFilter ? [`--lua-filter=${job.luaFilter}`] : []),
    ...(job.corilloLast ? [`--lua-filter=${job.corilloLast}`] : []),
  ];
}

// The Word export's middle ------------------------------------------------------------
// The steps exportDocument runs and the tests' toWord (tests/unit/word.ts) runs
// too, so the tests check the app's own steps (E21-20). Around them the app
// draws diagrams and fetches and draws pictures; the tests leave those out.

/**
 * The text a Word document is made from (its front matter already left out):
 * each blank line the page shows marked to be an empty paragraph, and
 * Obsidian's syntax as Obsidian shows it, `picture` giving each embedded
 * picture's address.
 */
export function wordText(text: string, picture: (name: string) => string | null): string {
  return obsidianForExport(blankLinesForWord(text), { word: true, picture });
}

/** The files of a Word export in its work folder: the text, Pandoc's first reading of it, Corillo's two filters, and the .docx made. */
export function wordFiles(work: string): { input: string; reading: string; corilloFilter: string; corilloLast: string; output: string } {
  return {
    input: path.join(work, "document.md"),
    reading: path.join(work, "document.json"),
    corilloFilter: path.join(work, "corillo.lua"),
    corilloLast: path.join(work, "corillo-last.lua"),
    output: path.join(work, "export.docx"),
  };
}

/**
 * After Pandoc's first reading (`ast`) and the pictures step (`plan`):
 * Corillo's layout of the tables and pictures for this style file (`style`,
 * at `referenceDoc`; `area`, its text area, when already measured), its two
 * filters written to their files, and Pandoc's instructions for making the
 * .docx, with the person's own Lua filter between Corillo's two.
 */
export function wordMaking(job: {
  ast: { blocks: unknown[] };
  plan: PicturePlan;
  style: Uint8Array;
  area?: Size;
  files: ReturnType<typeof wordFiles>;
  referenceDoc: string;
  luaFilter?: string;
}): { layout: WordLayout; args: string[] } {
  const { files, style } = job;
  const layout = wordLayout(job.ast, job.area ?? textArea(style), readyPictures(job.plan), templateStyles(style), bodyTextStyle(style));
  fs.writeFileSync(files.corilloFilter, wordFilter(layout));
  fs.writeFileSync(files.corilloLast, wordFilterLast(layout));
  const args = pandocArgs({ input: files.input, output: files.output, referenceDoc: job.referenceDoc, corilloFilter: files.corilloFilter, luaFilter: job.luaFilter, corilloLast: files.corilloLast });
  return { layout, args };
}
