// Opening a Word document (roadmap Batch 5, item 1). Every document in
// Corillo is a Markdown file, so a Word document opens as a Markdown copy
// made beside it ("Offsite notes.docx" gives "Offsite notes.md"), once the
// person says yes, by the Pandoc that comes with Corillo for export. The Word
// file is only ever read. The copy has Word's tracked changes accepted,
// leaves Word's own comments out (the notice says how many stay in the Word
// file), and puts the pictures in "<name> images" beside it, the folder every
// document's pictures go in. The Word file's look is kept in the copy's
// records (wordStyles, and export.ts's rememberWordCopy), so exporting to Word
// gives it back, with nothing else of the Word file in it.
//
// The work happens in a folder of its own in the temporary folder, removed
// when the copy is made or fails, and when Corillo quits mid-copy. The
// person's folder only gets the finished pictures folder and copy, never half
// of one, and never in place of a file or folder already there.
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { FileProblem, imagesFolder, MAX_DOCUMENT_BYTES, megabytes, problemText, readsBackAs, writeSeams } from "./files";
import { makeZip, readZipFileEntries, type ZipEntry } from "./zip";

/**
 * The biggest Word document Corillo makes a copy of. A Word document's own
 * text is rarely more than a few MB; the rest is pictures, which Pandoc reads
 * into memory. Bigger is a scan or a picture book, not a document to write in.
 */
export const MAX_WORD_BYTES = 200 * 1024 * 1024;

/**
 * The most a Word document's text (word/document.xml, and its comments) may
 * unpack to. Pandoc needs about 90 bytes of memory for each byte of it: 24 MB,
 * well over a thousand pages, takes it close to the 2 GB it may use (see
 * PANDOC_MEMORY). A few kilobytes on disk can unpack to gigabytes, so this is
 * checked from inside the zip, before Pandoc sees it (B5-06).
 */
export const MAX_WORD_TEXT_BYTES = 24 * 1024 * 1024;

/**
 * The most memory Pandoc may use reading a Word document, whatever the
 * document makes it unpack: past it, Pandoc stops and the person is told the
 * document is too long. Measured on the bundled Pandoc 3.13: 15 MB of text
 * needs about 1.3 GB, 30 MB still fits in 2 GB, 60 MB doesn't (B5-06).
 */
const PANDOC_MEMORY = "-M2g";

/** How long Pandoc may take to read a Word document, as for an export. */
const PANDOC_TIMEOUT_MS = 120_000;

/** Why a copy can't be made, in words for the person. */
export class WordCopyProblem extends Error {}

/** A Word document: it opens as a Markdown copy beside it. */
export const isWordDocument = (file: string) => /\.docx$/i.test(file);
/** A document in Word's older format, which Pandoc can't read. */
export const isOldWordDocument = (file: string) => /\.doc$/i.test(file);

export const OLD_WORD_FORMAT =
  "It's in Word's older format (.doc), which Corillo can't read. Open it in Word, save it as a Word document (.docx), then open that in Corillo.";

const nameOf = (file: string) => path.basename(file);
const stemOf = (file: string) => nameOf(file).replace(/\.[^.]+$/, "");

/**
 * What an agent is told when it asks Corillo to open a Word document: the person opens it in Corillo, which
 * makes the Markdown copy, and the agent can open that (review of Batch 11, B11R-6). Null for other files.
 */
export function wordForAgent(file: string): string | null {
  const name = nameOf(file);
  if (isWordDocument(file)) {
    return `${name} is a Word document. Corillo works on a Markdown copy of it: ask the person to open it in Corillo (File > Open), which saves the copy next to it. Then you can open the copy.`;
  }
  if (isOldWordDocument(file)) {
    return `${name} is in Word's older format (.doc), which Corillo can't read. Ask the person to open it in Word and save it as a Word document (.docx), then to open that in Corillo.`;
  }
  return null;
}

/** What a Word document holds that its copy leaves out or changes, for the notice after. */
export interface WordContents {
  /** Word's own comments (they stay in the Word file). */
  comments: number;
  /** Whether it has tracked changes (the copy has them accepted). */
  trackedChanges: boolean;
}

/**
 * Look at a Word document before asking about it: what it holds, or why
 * Corillo can't make a copy (throws a WordCopyProblem). Reads only its first
 * bytes, and from inside it only the text and the comments, never the
 * pictures.
 */
export function lookInWord(file: string): WordContents {
  let size: number;
  try {
    const stat = fs.statSync(file);
    if (!stat.isFile()) throw new WordCopyProblem("It's a folder, not a Word document.");
    size = stat.size;
  } catch (err) {
    if (err instanceof WordCopyProblem) throw err;
    const code = (err as NodeJS.ErrnoException).code;
    if (code === "ENOENT" || code === "ENOTDIR") throw new WordCopyProblem("It may have been moved or deleted.");
    throw new WordCopyProblem("Corillo isn't allowed to read it, or it can't be read right now.");
  }
  if (size > MAX_WORD_BYTES) throw new WordCopyProblem(`It's over ${megabytes(MAX_WORD_BYTES)}, too big for Corillo to make a copy of.`);
  const head = Buffer.alloc(8);
  try {
    const fd = fs.openSync(file, "r");
    try {
      fs.readSync(fd, head, 0, 8, 0);
    } finally {
      fs.closeSync(fd);
    }
  } catch {
    throw new WordCopyProblem("Corillo isn't allowed to read it, or it can't be read right now.");
  }
  // A Word document is a zip. One protected with a password, or a .doc renamed, is an older kind of file.
  if (head.readUInt32BE(0) === 0xd0cf11e0) {
    if (isLocked(file)) throw new WordCopyProblem(PASSWORD);
    throw new WordCopyProblem("It's in Word's older format, which Corillo can't read. Open it in Word, save it as a Word document (.docx), then open that in Corillo.");
  }
  if (head.readUInt32LE(0) !== 0x04034b50) throw new WordCopyProblem(DAMAGED);
  const tooBig: string[] = [];
  const inside = readZipFileEntries(file, ["word/document.xml", "word/comments.xml"], MAX_WORD_TEXT_BYTES, { tooBig });
  if (tooBig.length) throw new WordCopyProblem(TOO_LONG);
  const text = inside.get("word/document.xml")?.toString("utf8") ?? "";
  const comments = inside.get("word/comments.xml")?.toString("utf8") ?? "";
  return {
    comments: (comments.match(/<w:comment\b/g) ?? []).length,
    trackedChanges: /<w:(ins|del|moveFrom|moveTo)\b/.test(text),
  };
}

const PASSWORD = "It's protected with a password, so Corillo can't read it. Open it in Word, save a copy without the password, then open that in Corillo.";
const DAMAGED = "It may be damaged, or not really a Word document. If Word opens it, save it again from Word and try once more.";
const TOO_LONG = "It's too long for Corillo to make a copy of.";

/** Whether a file of Word's older kind is a Word document locked with a password (its parts are then one encrypted package). */
function isLocked(file: string): boolean {
  const marker = Buffer.from("EncryptedPackage", "utf16le");
  try {
    const fd = fs.openSync(file, "r");
    try {
      // The names of its parts are listed near its start, or near its end in a big one: look through the first and last 4 MB.
      const size = fs.fstatSync(fd).size;
      const part = Math.min(size, 4 * 1024 * 1024);
      const buf = Buffer.alloc(part);
      for (const at of size > part ? [0, size - part] : [0]) {
        fs.readSync(fd, buf, 0, part, at);
        if (buf.includes(marker)) return true;
      }
      return false;
    } finally {
      fs.closeSync(fd);
    }
  } catch {
    return false;
  }
}

// Where the copy goes ---------------------------------------------------------------

export interface CopyPlace {
  /** The copy: "Offsite notes.md", or "Offsite notes 2.md" and on when that's taken. */
  markdown: string;
  /** Its pictures folder, which isn't there yet. */
  pictures: string;
  /** "Offsite notes.md", when it's already there: the person may want that one. */
  existing: string | null;
}

/**
 * Where the copy of a Word document goes, beside it, never over anything:
 * the first of "Offsite notes.md", "Offsite notes 2.md" and on, as Word and
 * Finder number a name that's taken, for which neither the file nor its
 * pictures folder is there yet.
 */
export function copyPlace(word: string, there: (file: string) => boolean = fs.existsSync): CopyPlace {
  const folder = path.dirname(word);
  const stem = stemOf(word);
  const first = path.join(folder, `${stem}.md`);
  for (let n = 1; ; n++) {
    const markdown = path.join(folder, n === 1 ? `${stem}.md` : `${stem} ${n}.md`);
    const pictures = imagesFolder(markdown);
    if (!there(markdown) && !there(pictures)) return { markdown, pictures, existing: there(first) ? first : null };
  }
}

/** Whether Corillo may make files in a folder. */
export function canWriteIn(folder: string): boolean {
  try {
    fs.accessSync(folder, fs.constants.W_OK);
    return true;
  } catch {
    return false;
  }
}

// What the person is asked, and told -------------------------------------------------

export type CopyChoice = "copy" | "open" | "elsewhere" | "cancel";

export interface CopyQuestion {
  message: string;
  detail: string;
  buttons: string[];
  /** What each button does, in order. Cancel is last. */
  choices: CopyChoice[];
}

/**
 * The one question before a copy is made. Both files are named with their
 * extensions, since it tells the two apart. When the copy's name is taken,
 * the person may open that file or make a new copy beside it; when the Word
 * document's folder can't be written to, they choose where the copy goes.
 */
export function copyQuestion(word: string, place: CopyPlace, writable: boolean): CopyQuestion {
  const name = nameOf(word);
  if (!writable) {
    return {
      message: `Corillo works on a copy of ${name}, but it isn't allowed to save one in that folder.`,
      detail: "Choose where to save the copy. The Word file isn't changed.",
      buttons: ["Choose Where to Save…", "Cancel"],
      choices: ["elsewhere", "cancel"],
    };
  }
  if (place.existing) {
    const existing = nameOf(place.existing);
    return {
      message: `${existing} is already next to ${name}.`,
      detail: `Open it to carry on with it, or make a new copy of the Word file as it is now, saved as ${nameOf(place.markdown)}. The Word file isn't changed.`,
      buttons: [`Open ${existing}`, "Make a New Copy", "Cancel"],
      choices: ["open", "copy", "cancel"],
    };
  }
  return {
    message: `Corillo works on a copy of ${name}, saved next to it as ${nameOf(place.markdown)}.`,
    detail: "The Word file isn't changed.",
    buttons: ["Make a Copy", "Cancel"],
    choices: ["copy", "cancel"],
  };
}

/** What a copy came out as, for the notice. */
export interface CopyMade {
  /** The copy's text, as saved. */
  text: string;
  /** Pictures put in its pictures folder. */
  pictures: number;
  /** Kinds of picture the page can't show ("EMF"), linked rather than shown. */
  notShown: string[];
  /** How many pictures are of those kinds. */
  linked: number;
}

/**
 * The notice on the copy's tab once it opens. It doesn't name the copy (the
 * tab does): only the Word file it was made from, and what changed on the way;
 * with `styles`, that its export to Word takes that file's look.
 */
export function copyNotice(word: string, contents: WordContents, made: CopyMade, styles = true): { text: string; detail: string } {
  const parts: string[] = [];
  if (contents.trackedChanges) parts.push("Its tracked changes are accepted.");
  if (contents.comments === 1) parts.push("Its Word comment isn't in this copy; it's still in the Word file.");
  else if (contents.comments > 1) parts.push(`Its ${contents.comments} Word comments aren't in this copy; they're still in the Word file.`);
  if (made.linked) {
    const kinds = made.notShown.join(" and ");
    parts.push(
      made.linked === 1
        ? `Corillo can't show one of its pictures (${kinds}), so it's a link to the picture's file.`
        : `Corillo can't show ${made.linked} of its pictures (${kinds}), so they're links to the pictures' files.`,
    );
  }
  if (styles) parts.push("Export to Word uses the Word file's styles.");
  return { text: `Made from ${nameOf(word)}.`, detail: parts.join(" ") };
}

// Making the copy ---------------------------------------------------------------------

/** Kinds of picture the page shows; Word's others (EMF and WMF drawings, TIFF) become links to the file. */
const SHOWN = ["png", "jpg", "jpeg", "gif", "webp", "avif", "svg", "bmp"];

/**
 * Corillo's Lua filter for the copy, run as Pandoc reads the Word document.
 * Pictures: each written to the work folder under its name in the Word
 * document ("image1.png"), taken names numbered as the pictures folder does,
 * and addressed in the copy by relative path with spaces as %20; one of a
 * kind the page can't show becomes a link to it. Word's sizes are left out,
 * so a picture shows at its own size, as Corillo's pictures do. Lists are
 * tight (no empty line between items, which Corillo would show and export as
 * an empty line). Tables become Markdown tables: the first row is the header
 * when Word marks none; merged cells are split, with the words in the first;
 * a cell's paragraphs and lists become lines in one cell. The title, subtitle,
 * author, date and abstract Word keeps apart go back at the top, the title as
 * a heading.
 */
export const COPY_FILTER = String.raw`
local dir = os.getenv("CORILLO_PICTURES_DIR")
local address = os.getenv("CORILLO_PICTURES_ADDRESS")
local shown = {}
for kind in (os.getenv("CORILLO_PICTURES_SHOWN") or ""):gmatch("[^,]+") do shown[kind] = true end
local named, taken, last = {}, {}, {}

local function encode(s)
  return (s:gsub("[^%w%-%._~]", function(c) return string.format("%%%02X", string.byte(c)) end))
end

local function free_name(key)
  local base = key:match("([^/\\]+)$") or "picture"
  base = base:gsub('[#?%%<>:*|"]', "-")
  local stem, ext = base:match("^(.+)(%.[^.]+)$")
  if not stem then stem, ext = base, "" end
  -- Numbering goes on from the last number this name was given, so many pictures of one name don't each count up from 2.
  local name, n = stem .. ext, last[base:lower()] or 1
  while taken[name:lower()] do
    n = n + 1
    name = stem .. " " .. n .. ext
  end
  last[base:lower()] = n
  taken[name:lower()] = true
  return name
end

function Image(img)
  local key = img.src
  local name = named[key]
  if not name then
    local _, contents = pandoc.mediabag.lookup(key)
    if not contents then return nil end -- a picture on the web: left as it is
    name = free_name(key)
    local f = assert(io.open(dir .. "/" .. name, "wb"))
    f:write(contents)
    f:close()
    named[key] = name
  end
  local src = address .. "/" .. encode(name)
  local kind = (name:match("%.([^.]+)$") or ""):lower()
  if not shown[kind] then
    local words = #img.caption > 0 and img.caption or pandoc.Inlines(name)
    return pandoc.Link(words, src)
  end
  img.src = src
  img.attr = pandoc.Attr()
  img.title = ""
  return img
end

local function tighten(list)
  for _, item in ipairs(list.content) do
    local second = item[2] and item[2].t
    if item[1] and item[1].t == "Para" and (#item == 1 or (#item == 2 and (second == "BulletList" or second == "OrderedList"))) then
      item[1] = pandoc.Plain(item[1].content)
    end
  end
  return list
end
BulletList = tighten
OrderedList = tighten

local function br() return pandoc.RawInline("gfm", "<br>") end

local function lines(blocks)
  local out = pandoc.Inlines({})
  local function next_line() if #out > 0 then out:insert(br()) end end
  for _, b in ipairs(blocks) do
    if b.t == "Para" or b.t == "Plain" then
      next_line()
      out:extend(b.content)
    elseif b.t == "BulletList" or b.t == "OrderedList" then
      local n = b.t == "OrderedList" and (b.start or 1) or nil
      for i, item in ipairs(b.content) do
        next_line()
        out:insert(pandoc.Str(n and ((n + i - 1) .. ".") or "•"))
        out:insert(pandoc.Space())
        out:extend(lines(item))
      end
    elseif b.t == "Header" then
      next_line()
      out:insert(pandoc.Strong(b.content))
    elseif b.t == "BlockQuote" or b.t == "Div" then
      -- Word's Increase Indent reads as a quote: its paragraphs keep their links, bold and pictures.
      local inner = lines(b.content)
      if #inner > 0 then
        next_line()
        out:extend(inner)
      end
    elseif b.t == "CodeBlock" then
      for line in b.text:gmatch("[^\n]+") do
        next_line()
        out:insert(pandoc.Code(line))
      end
    elseif b.t == "Table" then
      -- A table inside a cell: a line for each row, its cells apart.
      local s = pandoc.utils.to_simple_table(b)
      local rows = { s.headers }
      for _, r in ipairs(s.rows) do table.insert(rows, r) end
      for _, r in ipairs(rows) do
        local words = pandoc.Inlines({})
        for _, c in ipairs(r) do
          local inner = lines(c)
          if #inner > 0 then
            if #words > 0 then words:insert(pandoc.Str(" · ")) end
            words:extend(inner)
          end
        end
        if #words > 0 then
          next_line()
          out:extend(words)
        end
      end
    else
      local s = pandoc.utils.stringify(b)
      if s ~= "" then
        next_line()
        out:insert(pandoc.Str(s))
      end
    end
  end
  return out:walk({ LineBreak = br, SoftBreak = function() return pandoc.Space() end })
end

local function blank(cells)
  for _, c in ipairs(cells) do
    if pandoc.utils.stringify(c) ~= "" then return false end
    -- A picture has no words, but a row of pictures isn't empty.
    local picture = false
    pandoc.Blocks(c):walk({ Image = function() picture = true end })
    if picture then return false end
  end
  return true
end

-- Word raises the "st" of "1st" by itself. Written out, Pandoc would give 1^(st): what has no raised or lowered
-- form of its own (anything but digits and signs) comes out as plain words.
local function plain_unless_figures(el)
  if pandoc.utils.stringify(el):match("^[%d%+%-=%(%)]+$") then return nil end
  return el.content
end
Superscript = plain_unless_figures
Subscript = plain_unless_figures

function Table(t)
  local s = pandoc.utils.to_simple_table(t)
  if (#s.headers == 0 or blank(s.headers)) and #s.rows > 0 then s.headers = table.remove(s.rows, 1) end
  local columns = #s.headers
  for _, r in ipairs(s.rows) do
    if #r > columns then columns = #r end
  end
  if columns == 0 then return {} end
  local function row(cells)
    local out = {}
    for i = 1, columns do out[i] = { pandoc.Plain(lines(cells[i] or {})) } end
    return out
  end
  s.headers = row(s.headers)
  for i, r in ipairs(s.rows) do s.rows[i] = row(r) end
  local aligns, widths = {}, {}
  for i = 1, columns do
    aligns[i] = s.aligns[i] or pandoc.AlignDefault
    widths[i] = 0
  end
  s.aligns, s.widths = aligns, widths
  local caption = s.caption
  s.caption = pandoc.Inlines({})
  local out = { pandoc.utils.from_simple_table(s) }
  if #caption > 0 then table.insert(out, pandoc.Para(caption)) end
  return out
end

function Pandoc(doc)
  local m, front = doc.meta, {}
  local function words(v)
    if type(v) == "string" then return pandoc.Inlines(v) end
    if pandoc.utils.type(v) == "Inlines" then return v end
    return pandoc.Inlines(pandoc.utils.stringify(v))
  end
  if m.title then table.insert(front, pandoc.Header(1, words(m.title))) end
  if m.subtitle then table.insert(front, pandoc.Para(words(m.subtitle))) end
  if m.author then
    local authors = pandoc.utils.type(m.author) == "List" and m.author or { m.author }
    for _, a in ipairs(authors) do table.insert(front, pandoc.Para(words(a))) end
  end
  if m.date then table.insert(front, pandoc.Para(words(m.date))) end
  if m.abstract then
    if pandoc.utils.type(m.abstract) == "Blocks" then
      for _, b in ipairs(m.abstract) do table.insert(front, b) end
    else
      table.insert(front, pandoc.Para(words(m.abstract)))
    end
  end
  for i = #front, 1, -1 do doc.blocks:insert(1, front[i]) end
  doc.meta = pandoc.Meta({})
  return doc
end
`;

/** Pandoc's arguments for the copy: its memory capped; GitHub's Markdown, which Corillo reads as written, with no HTML and one line per paragraph. */
export function copyArgs(word: string, output: string, filter: string): string[] {
  return ["+RTS", PANDOC_MEMORY, "-RTS", word, "--from=docx", "--to=gfm-raw_html", "--track-changes=accept", "--wrap=none", "--sandbox", `--lua-filter=${filter}`, `--output=${output}`];
}

export type Runner = (
  file: string,
  args: string[],
  options: { cwd: string; timeoutMs: number; env?: NodeJS.ProcessEnv },
) => Promise<{ stdout: string; stderr: string }>;

export interface CopyTools {
  /** The Pandoc program (pandoc.ts's pandocPath); throws if it's missing. */
  pandoc: () => string;
  /** How a program is run and stopped (pandoc.ts's run). */
  run: Runner;
}

/** The work folders of copies being made now, removed when each is done, or when Corillo quits. */
const working = new Set<string>();

/** Remove the work of copies cut off by Corillo quitting (export.ts clears any older ones a crash left). */
export function clearCopyWork(): void {
  for (const work of working) fs.rmSync(work, { recursive: true, force: true });
  working.clear();
}

/** The start of a copy's work folder's name; export.ts's clearing knows it. */
export const COPY_WORK = "corillo-word-copy-";

/** Whether a folder is the work of a copy being made now. */
export const copyWorking = (dir: string) => working.has(dir);

/**
 * Make the copy of a Word document at `place` (from copyPlace, or the place
 * the person chose): its pictures folder first, if it has pictures, then the
 * copy itself, each only where nothing is. Throws a WordCopyProblem in words
 * for the person; nothing of a copy that fails is left anywhere.
 */
export async function makeWordCopy(word: string, place: { markdown: string; pictures: string }, tools: CopyTools): Promise<CopyMade> {
  let pandoc: string;
  try {
    pandoc = tools.pandoc();
  } catch {
    throw new WordCopyProblem(PANDOC_MISSING);
  }
  const work = fs.mkdtempSync(path.join(os.tmpdir(), `${COPY_WORK}${process.pid}-`));
  working.add(work);
  try {
    const pictures = path.join(work, "pictures");
    fs.mkdirSync(pictures);
    const filter = path.join(work, "copy.lua");
    fs.writeFileSync(filter, COPY_FILTER);
    const output = path.join(work, "copy.md");
    // Brackets as %28 and %29, so one unpaired bracket in the name doesn't end the picture's address (Batch 21, E21-10).
    const address = nameOf(place.pictures).split("/").map((part) => encodeURIComponent(part).replace(/\(/g, "%28").replace(/\)/g, "%29")).join("/");
    try {
      await tools.run(pandoc, copyArgs(word, output, filter), {
        cwd: work,
        timeoutMs: PANDOC_TIMEOUT_MS,
        env: { ...process.env, CORILLO_PICTURES_DIR: pictures, CORILLO_PICTURES_ADDRESS: address, CORILLO_PICTURES_SHOWN: SHOWN.join(",") },
      });
    } catch (err) {
      throw pandocTrouble(err as Error & { stderr?: string; code?: string | number; killed?: boolean; syscall?: string });
    }
    // Its size first: one far too long is never read into memory.
    if (fs.statSync(output).size > MAX_DOCUMENT_BYTES) {
      throw new WordCopyProblem(`Its copy would be over ${megabytes(MAX_DOCUMENT_BYTES)}, too long for Corillo to open.`);
    }
    const text = fs.readFileSync(output, "utf8");
    const files = fs.readdirSync(pictures);
    const kindOf = (f: string) => path.extname(f).slice(1).toLowerCase();
    const unshown = files.filter((f) => !SHOWN.includes(kindOf(f)));
    let madePictures = false;
    try {
      if (files.length) {
        placePictures(pictures, place.pictures);
        madePictures = true;
      }
      writeNew(place.markdown, text);
    } catch (err) {
      if (madePictures) fs.rmSync(place.pictures, { recursive: true, force: true });
      if (err instanceof WordCopyProblem) throw err;
      throw new WordCopyProblem(`Corillo couldn't save ${nameOf(place.markdown)}: ${problemText(err)}.`);
    }
    return { text, pictures: files.length, linked: unshown.length, notShown: [...new Set(unshown.map((f) => kindOf(f).toUpperCase()))] };
  } finally {
    fs.rmSync(work, { recursive: true, force: true });
    working.delete(work);
  }
}

const PANDOC_MISSING =
  "Corillo can't make a copy of a Word document because part of it is missing (Pandoc, the program that reads Word documents). Reinstalling Corillo should fix it.";

/** What went wrong reading the Word document, in plain words. */
function pandocTrouble(err: Error & { stderr?: string; code?: string | number; killed?: boolean; syscall?: string }): WordCopyProblem {
  if (err.killed) return new WordCopyProblem("Reading it took too long and was stopped. It may be very long, or damaged.");
  if (typeof err.code === "string" && /^E[A-Z]+$/.test(err.code)) {
    if (err.syscall?.startsWith("spawn")) return new WordCopyProblem(PANDOC_MISSING);
    if (err.code === "ENOSPC") return new WordCopyProblem("The disk is full.");
  }
  // It needed more memory than Pandoc may use (PANDOC_MEMORY).
  if (/Heap exhausted/i.test(err.stderr ?? "")) return new WordCopyProblem(TOO_LONG);
  console.error("Pandoc couldn't read a Word document.", err.message, err.stderr ?? "");
  return new WordCopyProblem(DAMAGED);
}

/** Put the pictures folder in place, only if nothing is there by that name. */
function placePictures(from: string, to: string): void {
  if (fs.existsSync(to)) throw new WordCopyProblem(`There's already a folder called ${nameOf(to)} there.`);
  try {
    fs.renameSync(from, to);
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== "EXDEV") throw err;
    // The temporary folder is on another disk: copied instead (the work folder goes after).
    try {
      fs.cpSync(from, to, { recursive: true, errorOnExist: true, force: false });
    } catch (copyErr) {
      fs.rmSync(to, { recursive: true, force: true });
      throw copyErr;
    }
  }
}

/** Write a new file, never over one that's there. */
function writeNew(file: string, text: string): void {
  let fd: number;
  try {
    fd = fs.openSync(file, "wx");
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "EEXIST") throw new WordCopyProblem(`There's already a file called ${nameOf(file)} there.`);
    throw err;
  }
  try {
    fs.writeFileSync(fd, text, "utf8");
    fs.fsyncSync(fd);
  } catch (err) {
    fs.closeSync(fd);
    fs.rmSync(file, { force: true });
    throw err;
  }
  fs.closeSync(fd);
  writeSeams.afterTemp?.(file);
  // Read back, as every save is (roadmap Batch 14, item 1). Not as written: it's Corillo's own new file, so it goes (B14-08).
  if (!readsBackAs(file, text)) {
    fs.rmSync(file, { force: true });
    throw new FileProblem("the disk didn't keep what Corillo wrote, so nothing was made");
  }
}

// The Word document's look, for exporting the copy (B5-02, B5-04) ---------------------

/** Relationships to the parts that make a Word document's look. */
const LOOK = /\/(styles|stylesWithEffects|numbering|fontTable|webSettings|settings|theme)$/;
/** What a Word document's settings hold that isn't its look: Track Changes, editing restrictions, the template on its author's Mac, its own data. */
const NOT_LOOK = ["trackRevisions", "documentProtection", "writeProtection", "attachedTemplate", "docVars", "mailMerge"];
/** The most a Word document's look may unpack to, its header and footer pictures included. */
const MAX_LOOK_BYTES = 64 * 1024 * 1024;

const XML_START = '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n';
const PACKAGE = "http://schemas.openxmlformats.org/package/2006/relationships";

interface Relationship {
  xml: string;
  id: string;
  type: string;
  /** The part it names, inside the zip ("word/header1.xml"); null for one outside it (a web address). */
  part: string | null;
}

/** A relationships file's entries; targets are inside the zip, seen from `folder` ("word"). */
function relationshipsIn(xml: string, folder: string): Relationship[] {
  const attr = (el: string, name: string) => new RegExp(`\\b${name}=(["'])(.*?)\\1`).exec(el)?.[2] ?? "";
  return [...xml.matchAll(/<Relationship\b[^>]*?(?:\/>|>[\s\S]*?<\/Relationship>)/g)].map(([el]) => {
    const target = attr(el, "Target");
    const outside = /^external$/i.test(attr(el, "TargetMode")) || /^[a-z][a-z0-9+.-]*:/i.test(target);
    const part = outside ? null : path.posix.normalize(target.startsWith("/") ? target.slice(1) : `${folder}/${target}`);
    return { xml: el, id: attr(el, "Id"), type: attr(el, "Type"), part: part && !part.startsWith("..") ? part : null };
  });
}

const relationshipsFile = (rels: Relationship[]) => `${XML_START}<Relationships xmlns="${PACKAGE}">${rels.map((r) => r.xml).join("")}</Relationships>`;
/** A part's name as written in an address ("my%20logo.png"), as the zip has it; as it is if it can't be read that way. */
function decoded(name: string): string {
  try {
    return decodeURIComponent(name);
  } catch {
    return name;
  }
}

const relationshipsOf = (part: string) => `${path.posix.dirname(part)}/_rels/${path.posix.basename(part)}.rels`;

/**
 * The page settings at the end of a Word document's body (size, margins,
 * headers and footers), with its own tracked change taken out; "" if it has
 * none. Settings can sit inside settings (a tracked change keeps the old ones),
 * so the tags are counted rather than matched.
 */
function lastSection(xml: string): string {
  let depth = 0;
  let start = 0;
  let last = "";
  for (const m of xml.matchAll(/<(\/?)w:sectPr(?=[\s>/])[^>]*?(\/?)>/g)) {
    if (m[1]) {
      if (depth > 0 && --depth === 0) last = xml.slice(start, m.index + m[0].length);
    } else if (m[2]) {
      if (depth === 0) last = m[0];
    } else if (depth++ === 0) start = m.index;
  }
  return last.replace(/<w:sectPrChange\b[\s\S]*?<\/w:sectPrChange>/g, "");
}

/**
 * A Word document's look, as a Word document of its own for Pandoc to take
 * styles from when the copy is exported (Pandoc's --reference-doc): its
 * styles, lists, theme, fonts, page size and margins, and the headers and
 * footers of its last section with the pictures they show. None of its text,
 * pictures, comments or document details, and none of its settings that
 * aren't its look (Track Changes, editing restrictions, its template and own
 * data): Pandoc copies all of those from the document it's given into every
 * export. Made when the copy is, and kept with the copy's records, so the
 * export holds only the copy's own pictures and works after the Word document
 * is moved or deleted. Null if the document has no styles to keep, or can't
 * be read: the copy then exports in Corillo's own style.
 */
export function wordStyles(word: string): Buffer | null {
  let room = MAX_LOOK_BYTES;
  const read = (wanted: string[] | ((name: string) => boolean)) => {
    const tooBig: string[] = [];
    const found = readZipFileEntries(word, wanted, MAX_WORD_TEXT_BYTES, { total: room, tooBig });
    for (const data of found.values()) room -= data.length;
    return { found, tooBig };
  };
  const first = read(
    (name) =>
      name === "[Content_Types].xml" ||
      name === "word/document.xml" ||
      name === "word/_rels/document.xml.rels" ||
      /^word\/(styles|stylesWithEffects|numbering|fontTable|webSettings|settings)\.xml$/.test(name) ||
      /^word\/theme\/[^/]+\.xml$/.test(name),
  );
  if (first.tooBig.length) return null;
  const text = (name: string) => first.found.get(name)?.toString("utf8");
  const documentXml = text("word/document.xml");
  const root = documentXml && /<w:document\b[^>]*>/.exec(documentXml)?.[0];
  if (!root || !first.found.has("word/styles.xml")) return null;
  const section = lastSection(documentXml);

  // The relationships kept: to the parts of the look, and to the headers and footers the last section shows.
  const shown = new Set([...section.matchAll(/<w:(?:header|footer)Reference\b[^>]*\br:id="([^"]*)"/g)].map((m) => m[1]));
  const rels = relationshipsIn(text("word/_rels/document.xml.rels") ?? "", "word").filter(
    (r) => r.part && ((LOOK.test(r.type) && first.found.has(r.part)) || (/\/(header|footer)$/.test(r.type) && shown.has(r.id))),
  );
  const framing = rels.filter((r) => /\/(header|footer)$/.test(r.type)).map((r) => r.part!);
  const second = read([...framing, ...framing.map(relationshipsOf)]);
  if (second.tooBig.length) return null;
  // Each header's and footer's pictures, from inside the zip.
  const pictures = framing.flatMap((part) =>
    relationshipsIn(second.found.get(relationshipsOf(part))?.toString("utf8") ?? "", path.posix.dirname(part))
      .map((r) => r.part)
      .filter((p): p is string => !!p && p.startsWith("word/media/")),
  );
  const third = read([...new Set(pictures)]);
  if (third.tooBig.length) return null;

  const entries: ZipEntry[] = [
    { name: "_rels/.rels", data: `${XML_START}<Relationships xmlns="${PACKAGE}"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="word/document.xml"/></Relationships>` },
    { name: "word/document.xml", data: `${XML_START}${root}<w:body>${section}</w:body></w:document>` },
    { name: "word/_rels/document.xml.rels", data: relationshipsFile(rels.filter((r) => second.found.has(r.part!) || first.found.has(r.part!))) },
  ];
  for (const [name, data] of first.found) {
    if (!/^word\/(?!document\.xml$)[^_]/.test(name)) continue; // the look's parts (the document and its relationships are above)
    if (name === "word/settings.xml") {
      const notLook = new RegExp(`<w:(${NOT_LOOK.join("|")})\\b(?:[^>]*?/>|[^>]*>[\\s\\S]*?</w:\\1>)`, "g");
      entries.push({ name, data: data.toString("utf8").replace(notLook, "") });
    } else if (name === "word/fontTable.xml") {
      // Fonts saved inside the document aren't kept, so nothing points to them.
      entries.push({ name, data: data.toString("utf8").replace(/<w:embed(?:Regular|Bold|Italic|BoldItalic)\b[^>]*\/>/g, "") });
    } else entries.push({ name, data });
  }
  for (const found of [second.found, third.found]) for (const [name, data] of found) entries.push({ name, data });
  // What kind each part is, for the parts kept.
  const kept = new Set(entries.map((e) => e.name));
  const types = text("[Content_Types].xml");
  if (types) {
    entries.unshift({
      name: "[Content_Types].xml",
      data: types.replace(/<Override\b[^>]*?\/>/g, (el) => {
        const part = /\bPartName=(["'])\/?(.*?)\1/.exec(el)?.[2] ?? "";
        return kept.has(part) || kept.has(decoded(part)) ? el : "";
      }),
    });
  }
  return makeZip(entries);
}
