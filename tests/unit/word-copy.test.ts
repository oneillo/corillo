// Opening a Word document as a Markdown copy beside it (roadmap Batch 5,
// item 1): where the copy goes, never over anything; what the person is asked
// and told; what Corillo reads of the Word document first; and the copy
// itself, made by the bundled Pandoc, with nothing left behind.
import { describe, it, expect, beforeAll } from "vitest";
import { execFileSync } from "node:child_process";
import { chmodSync, closeSync, existsSync, ftruncateSync, mkdirSync, mkdtempSync, openSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { canWriteIn, copyArgs, copyNotice, copyPlace, copyQuestion, lookInWord, makeWordCopy, wordStyles, COPY_FILTER, MAX_WORD_BYTES, MAX_WORD_TEXT_BYTES, WordCopyProblem, type CopyTools } from "../../src/main/word-copy";
import { pandocLocation } from "../../src/main/export-prep";
import { run } from "../../src/main/pandoc";
import { readZipEntry, readZipFileEntries, makeZip } from "../../src/main/zip";
import { LOGO, makeDocx } from "../fixtures/make-docx";
import { VersionHistory } from "../../src/main/version-store";
import { versionLabel } from "../../src/core/versions";
import { suggestedOutputPath } from "../../src/main/export";
import { writeSeams } from "../../src/main/files";

const ROOT = join(import.meta.dirname, "..", "..");
const PANDOC = pandocLocation({ packaged: false, resourcesPath: "", appPath: ROOT, arch: process.arch });
const tools: CopyTools = { pandoc: () => PANDOC, run };

const folder = () => mkdtempSync(join(tmpdir(), "corillo-word-"));
/** A Word document in a folder of its own. */
function wordFile(options: Parameters<typeof makeDocx>[0] = {}, name = "Offsite notes.docx"): string {
  const file = join(folder(), name);
  writeFileSync(file, makeDocx(options));
  return file;
}
/** Copies being made now, or left behind: their work folders in the temporary folder. */
const copyWork = () => readdirSync(tmpdir()).filter((f) => f.startsWith(`corillo-word-copy-${process.pid}-`));

const COPY = `# Offsite notes

# Plan

The offsite is in **March**, at the lake house. Budget is set.

- Book the venue
- Send the agenda

## Who

| Name | Role  |
|------|-------|
| Ana  | Host  |
| Ben  | Notes |

![Venue map](Offsite%20notes%20images/image1.png)

Questions to the team.
`;

beforeAll(() => {
  // Pandoc comes with Corillo; a fresh checkout fetches it first, as the export tests do.
  if (!existsSync(PANDOC)) execFileSync(process.execPath, [join(ROOT, "scripts", "fetch-pandoc.mjs"), `--arch=${process.arch}`], { stdio: "inherit" });
});

describe("where the copy of a Word document goes", () => {
  it("next to it, with its name: Offsite notes.md, its pictures in Offsite notes images", () => {
    expect(copyPlace("/Docs/Offsite notes.docx", () => false)).toEqual({
      markdown: "/Docs/Offsite notes.md",
      pictures: "/Docs/Offsite notes images",
      existing: null,
    });
  });

  it("never over a file or folder already there: numbered as Word and Finder number a name that's taken", () => {
    const there = new Set(["/Docs/Offsite notes.md", "/Docs/Offsite notes 2 images"]);
    expect(copyPlace("/Docs/Offsite notes.docx", (p) => there.has(p))).toEqual({
      markdown: "/Docs/Offsite notes 3.md",
      pictures: "/Docs/Offsite notes 3 images",
      existing: "/Docs/Offsite notes.md",
    });
    // A pictures folder left from an earlier copy takes the name too, though its copy is gone.
    expect(copyPlace("/Docs/Plan.DOCX", (p) => p === "/Docs/Plan images")).toEqual({ markdown: "/Docs/Plan 2.md", pictures: "/Docs/Plan 2 images", existing: null });
  });

  it("knows a folder it can't write to", () => {
    const locked = folder();
    chmodSync(locked, 0o555);
    try {
      expect(canWriteIn(locked)).toBe(false);
      expect(canWriteIn(folder())).toBe(true);
    } finally {
      chmodSync(locked, 0o755);
    }
  });
});

describe("what the person is asked, once, and told after", () => {
  const place = { markdown: "/Docs/Offsite notes.md", pictures: "/Docs/Offsite notes images", existing: null };

  it("asks once, naming both files, with Make a Copy and Cancel", () => {
    expect(copyQuestion("/Docs/Offsite notes.docx", place, true)).toEqual({
      message: "Corillo works on a copy of Offsite notes.docx, saved next to it as Offsite notes.md.",
      detail: "The Word file isn't changed.",
      buttons: ["Make a Copy", "Cancel"],
      choices: ["copy", "cancel"],
    });
  });

  it("with the copy's name taken, offers to open that file or make a new copy beside it", () => {
    const taken = { markdown: "/Docs/Offsite notes 2.md", pictures: "/Docs/Offsite notes 2 images", existing: "/Docs/Offsite notes.md" };
    expect(copyQuestion("/Docs/Offsite notes.docx", taken, true)).toEqual({
      message: "Offsite notes.md is already next to Offsite notes.docx.",
      detail: "Open it to carry on with it, or make a new copy of the Word file as it is now, saved as Offsite notes 2.md. The Word file isn't changed.",
      buttons: ["Open Offsite notes.md", "Make a New Copy", "Cancel"],
      choices: ["open", "copy", "cancel"],
    });
  });

  it("in a folder Corillo can't save in, asks where to save the copy", () => {
    expect(copyQuestion("/Volumes/Shared/Offsite notes.docx", place, false)).toEqual({
      message: "Corillo works on a copy of Offsite notes.docx, but it isn't allowed to save one in that folder.",
      detail: "Choose where to save the copy. The Word file isn't changed.",
      buttons: ["Choose Where to Save…", "Cancel"],
      choices: ["elsewhere", "cancel"],
    });
  });

  it("tells what the copy left out or changed, without naming the copy (its tab does)", () => {
    const made = { text: "", pictures: 1, linked: 0, notShown: [] };
    expect(copyNotice("/Docs/Offsite notes.docx", { comments: 3, trackedChanges: true }, made)).toEqual({
      text: "Made from Offsite notes.docx.",
      detail: "Its tracked changes are accepted. Its 3 Word comments aren't in this copy; they're still in the Word file. Export to Word uses the Word file's styles.",
    });
    expect(copyNotice("/Docs/Plan.docx", { comments: 1, trackedChanges: false }, { ...made, linked: 2, notShown: ["EMF"] }).detail).toBe(
      "Its Word comment isn't in this copy; it's still in the Word file. Corillo can't show 2 of its pictures (EMF), so they're links to the pictures' files. Export to Word uses the Word file's styles.",
    );
    expect(copyNotice("/Docs/Plan.docx", { comments: 0, trackedChanges: false }, { ...made, linked: 1, notShown: ["EMF"] }).detail).toBe(
      "Corillo can't show one of its pictures (EMF), so it's a link to the picture's file. Export to Word uses the Word file's styles.",
    );
    // No styles kept from it (a Word document with none): the export is in Corillo's own style, so the notice doesn't promise the Word file's.
    expect(copyNotice("/Docs/Plan.docx", { comments: 0, trackedChanges: true }, made, false).detail).toBe("Its tracked changes are accepted.");
  });
});

describe("what Corillo reads of a Word document before asking", () => {
  it("counts Word's comments and sees tracked changes, from inside it, without reading the pictures", () => {
    expect(lookInWord(wordFile({ comments: 2 }))).toEqual({ comments: 2, trackedChanges: true });
    expect(lookInWord(wordFile({ comments: 0, noChanges: true }))).toEqual({ comments: 0, trackedChanges: false });
  });

  it("says why it can't make a copy, in plain words: a password, Word's older format, a damaged file, too big, gone", () => {
    const why = (file: string) => {
      try {
        lookInWord(file);
        return null;
      } catch (err) {
        expect(err).toBeInstanceOf(WordCopyProblem);
        return (err as Error).message;
      }
    };
    const dir = folder();
    // Word saves a document with a password, and wrote its older format, as one kind of file (it starts D0 CF 11 E0).
    const older = Buffer.concat([Buffer.from([0xd0, 0xcf, 0x11, 0xe0, 0xa1, 0xb1, 0x1a, 0xe1]), Buffer.alloc(600)]);
    writeFileSync(join(dir, "locked.docx"), Buffer.concat([older, Buffer.from("EncryptedPackage", "utf16le"), Buffer.alloc(100)]));
    expect(why(join(dir, "locked.docx"))).toBe(
      "It's protected with a password, so Corillo can't read it. Open it in Word, save a copy without the password, then open that in Corillo.",
    );
    writeFileSync(join(dir, "renamed.docx"), older);
    expect(why(join(dir, "renamed.docx"))).toMatch(/^It's in Word's older format, which Corillo can't read\./);
    writeFileSync(join(dir, "damaged.docx"), "not a zip at all");
    expect(why(join(dir, "damaged.docx"))).toBe("It may be damaged, or not really a Word document. If Word opens it, save it again from Word and try once more.");
    // Too big: a file that only says it's big (nothing is written to the disk).
    const big = join(dir, "huge.docx");
    const fd = openSync(big, "w");
    ftruncateSync(fd, MAX_WORD_BYTES + 1);
    closeSync(fd);
    expect(why(big)).toBe("It's over 200 MB, too big for Corillo to make a copy of.");
    expect(why(join(dir, "gone.docx"))).toBe("It may have been moved or deleted.");
    expect(why(dir)).toBe("It's a folder, not a Word document.");
  });

  it("refuses a Word document whose text unpacks to more than Pandoc can read, before Pandoc sees it (B5-06)", () => {
    // A few kilobytes on disk that unpack to over 24 MB of text: too long, said plainly, never read whole.
    const body = "<w:p><w:r><w:t>Words.</w:t></w:r></w:p>".repeat(Math.ceil((MAX_WORD_TEXT_BYTES + 1) / 38));
    const file = join(folder(), "Endless.docx");
    writeFileSync(file, makeZip([{ name: "word/document.xml", data: `<w:document><w:body>${body}</w:body></w:document>` }]));
    expect(() => lookInWord(file)).toThrow(new WordCopyProblem("It's too long for Corillo to make a copy of."));
    // Just under, it's looked at as usual.
    writeFileSync(file, makeZip([{ name: "word/document.xml", data: "<w:document><w:body><w:p/></w:body></w:document>" }]));
    expect(lookInWord(file)).toEqual({ comments: 0, trackedChanges: false });
  });

  it("reads only the files it asks for from a zip on disk", () => {
    const file = join(folder(), "a.zip");
    writeFileSync(file, makeZip([{ name: "a.txt", data: "one" }, { name: "b/c.xml", data: "<c/>" }, { name: "d.bin", data: new Uint8Array(5000) }]));
    const found = readZipFileEntries(file, ["b/c.xml", "missing.xml"]);
    expect([...found.keys()]).toEqual(["b/c.xml"]);
    expect(found.get("b/c.xml")!.toString()).toBe("<c/>");
    writeFileSync(file, "nothing like a zip");
    expect(readZipFileEntries(file, ["a.txt"]).size).toBe(0);
  });
});

describe("making the copy with the bundled Pandoc", () => {
  it("reads Word as GitHub's Markdown, tracked changes accepted, one line per paragraph, no HTML, without reaching other files", () => {
    expect(copyArgs("/Docs/a.docx", "/w/copy.md", "/w/copy.lua")).toEqual([
      // Pandoc may use at most 2 GB of memory, whatever the Word document makes it unpack (B5-06).
      "+RTS",
      "-M2g",
      "-RTS",
      "/Docs/a.docx",
      "--from=docx",
      "--to=gfm-raw_html",
      "--track-changes=accept",
      "--wrap=none",
      "--sandbox",
      "--lua-filter=/w/copy.lua",
      "--output=/w/copy.md",
    ]);
  });

  it("makes the copy beside the Word document: title, headings, bold, a tight list, a table and its picture, the tracked change accepted and the comment left out; the Word file is unchanged", async () => {
    const word = wordFile();
    const before = readFileSync(word);
    const place = copyPlace(word);
    const made = await makeWordCopy(word, place, tools);
    expect(made).toEqual({ text: COPY, pictures: 1, linked: 0, notShown: [] });
    expect(readFileSync(place.markdown, "utf8")).toBe(COPY);
    expect(readdirSync(place.pictures)).toEqual(["image1.png"]);
    expect(readFileSync(join(place.pictures, "image1.png")).subarray(1, 4).toString()).toBe("PNG");
    expect(readFileSync(word).equals(before)).toBe(true);
    expect(COPY).not.toContain("downtown");
    expect(COPY).not.toContain("final budget");
    expect(copyWork()).toEqual([]);
  });

  it("a picture-heavy document: every picture in the pictures folder; a drawing the page can't show becomes a link to its file; merged table cells split", async () => {
    const word = wordFile({ morePictures: 12, drawing: true, merged: true, comments: 0 });
    const place = copyPlace(word);
    const made = await makeWordCopy(word, place, tools);
    expect(made.pictures).toBe(14);
    expect(made.linked).toBe(1);
    expect(made.notShown).toEqual(["EMF"]);
    expect(readdirSync(place.pictures).sort()).toEqual(["chart.emf", ...Array.from({ length: 13 }, (_, i) => `image${i + 1}.png`)].sort());
    expect(made.text).toContain("![Photo 13](Offsite%20notes%20images/image13.png)\n");
    expect(made.text).toContain("\n[Sales chart](Offsite%20notes%20images/chart.emf)\n");
    expect(made.text).toContain("| Budget |                  |\n|--------|------------------|\n| Travel | Flights<br>Hotel |\n");
    expect(copyWork()).toEqual([]);
  });

  it("a document with no pictures makes no pictures folder", async () => {
    const word = wordFile({ noPicture: true });
    const place = copyPlace(word);
    const made = await makeWordCopy(word, place, tools);
    expect(made.pictures).toBe(0);
    expect(existsSync(place.pictures)).toBe(false);
    expect(readdirSync(join(word, "..")).sort()).toEqual(["Offsite notes.docx", "Offsite notes.md"]);
  });

  it("never writes over a file that appeared meanwhile, and leaves nothing of the copy behind", async () => {
    const word = wordFile();
    const place = copyPlace(word);
    writeFileSync(place.markdown, "Mine.\n"); // made after the place was chosen (by another app, say)
    await expect(makeWordCopy(word, place, tools)).rejects.toThrow("There's already a file called Offsite notes.md there.");
    expect(readFileSync(place.markdown, "utf8")).toBe("Mine.\n");
    expect(existsSync(place.pictures)).toBe(false);
    mkdirSync(place.pictures);
    writeFileSync(join(place.pictures, "image1.png"), "theirs");
    const other = { markdown: join(word, "..", "Other.md"), pictures: place.pictures };
    await expect(makeWordCopy(word, other, tools)).rejects.toThrow("There's already a folder called Offsite notes images there.");
    expect(readFileSync(join(place.pictures, "image1.png"), "utf8")).toBe("theirs");
    expect(existsSync(other.markdown)).toBe(false);
    expect(copyWork()).toEqual([]);
  });

  it("a copy the disk didn't keep as written is taken away with its pictures, and he's told nothing was made (B14-08)", async () => {
    const word = wordFile();
    const place = copyPlace(word);
    writeSeams.afterTemp = (file) => {
      writeSeams.afterTemp = null;
      writeFileSync(file, "wrong bytes");
    };
    try {
      await expect(makeWordCopy(word, place, tools)).rejects.toThrow(
        "Corillo couldn't save Offsite notes.md: the disk didn't keep what Corillo wrote, so nothing was made.",
      );
    } finally {
      writeSeams.afterTemp = null;
    }
    expect(readdirSync(join(word, "..")).sort()).toEqual(["Offsite notes.docx"]);
    expect(copyWork()).toEqual([]);
    // So the next try makes it.
    await makeWordCopy(word, place, tools);
    expect(existsSync(place.markdown)).toBe(true);
  });

  it("a folder it can't save in, a damaged document, Pandoc missing or too slow: said plainly, and nothing left behind", async () => {
    const word = wordFile();
    const locked = folder();
    chmodSync(locked, 0o555);
    try {
      await expect(makeWordCopy(word, copyPlace(join(locked, "Offsite notes.docx")), tools)).rejects.toThrow(
        "Corillo couldn't save Offsite notes.md: Corillo isn't allowed to change this file or its folder.",
      );
      expect(readdirSync(locked)).toEqual([]);
    } finally {
      chmodSync(locked, 0o755);
    }
    const damaged = join(folder(), "Damaged.docx");
    writeFileSync(damaged, makeZip([{ name: "word/document.xml", data: "<not word" }]));
    await expect(makeWordCopy(damaged, copyPlace(damaged), tools)).rejects.toThrow("It may be damaged, or not really a Word document.");
    expect(readdirSync(join(damaged, ".."))).toEqual(["Damaged.docx"]);
    await expect(makeWordCopy(word, copyPlace(word), { ...tools, pandoc: () => { throw new Error("gone"); } })).rejects.toThrow(
      "Corillo can't make a copy of a Word document because part of it is missing (Pandoc, the program that reads Word documents). Reinstalling Corillo should fix it.",
    );
    const slow: CopyTools = { pandoc: () => PANDOC, run: async () => Promise.reject(Object.assign(new Error("pandoc took too long and was stopped."), { killed: true })) };
    await expect(makeWordCopy(word, copyPlace(word), slow)).rejects.toThrow("Reading it took too long and was stopped. It may be very long, or damaged.");
    expect(readdirSync(join(word, ".."))).toEqual(["Offsite notes.docx"]);
    expect(copyWork()).toEqual([]);
  });

  it("a copy Pandoc made far too long is refused by its size, never read into memory (B5-06)", async () => {
    const word = wordFile();
    const huge: CopyTools = {
      pandoc: () => PANDOC,
      run: async (_file, args) => {
        // Over 2 GB, as a hostile Word document could make it (it only says so: nothing is written to the disk).
        const fd = openSync(args.find((a) => a.startsWith("--output="))!.slice("--output=".length), "w");
        ftruncateSync(fd, 3 * 1024 * 1024 * 1024);
        closeSync(fd);
        return { stdout: "", stderr: "" };
      },
    };
    await expect(makeWordCopy(word, copyPlace(word), huge)).rejects.toThrow("Its copy would be over 25 MB, too long for Corillo to open.");
    expect(readdirSync(join(word, ".."))).toEqual(["Offsite notes.docx"]);
    expect(copyWork()).toEqual([]);
  });

  it("Pandoc running out of its memory is told as too long, not as damaged (B5-06)", async () => {
    const word = wordFile();
    const full: CopyTools = {
      pandoc: () => PANDOC,
      run: async () => Promise.reject(Object.assign(new Error("Command failed"), { code: 251, stderr: "pandoc: Heap exhausted;\npandoc: Current maximum heap size is 2147483648 bytes (2048 MB).\n" })),
    };
    await expect(makeWordCopy(word, copyPlace(word), full)).rejects.toThrow(new WordCopyProblem("It's too long for Corillo to make a copy of."));
    expect(copyWork()).toEqual([]);
  });

  it("numbers many pictures of one name in one pass each, not by counting up from the start every time (B5-06)", () => {
    // The filter's own numbering, run by the bundled Pandoc, counting how often it looks up a taken name.
    const dir = folder();
    writeFileSync(join(dir, "copy.lua"), COPY_FILTER);
    writeFileSync(
      join(dir, "count.lua"),
      `local free_name, taken = assert(load(io.open(arg[1]):read("a") .. "\\nreturn free_name, taken"))()
local store, looks = {}, 0
setmetatable(taken, { __index = function(_, k) looks = looks + 1; return store[k] end, __newindex = function(_, k, v) store[k] = v end })
local names = {}
for i = 1, 2000 do names[i] = free_name("folder" .. i .. "/photo.png") end
names[2001] = free_name("photo 7.png")
names[2002] = free_name("Photo.PNG")
print(table.concat({ names[1], names[2], names[3], names[2000], names[2001], names[2002], looks }, "|"))`,
    );
    const [first, second, third, last, own, capitals, looks] = execFileSync(PANDOC, ["lua", join(dir, "count.lua"), join(dir, "copy.lua")], { encoding: "utf8" }).trim().split("|");
    expect([first, second, third, last]).toEqual(["photo.png", "photo 2.png", "photo 3.png", "photo 2000.png"]);
    // A name already given by numbering gets the next free one; capitals don't make another name.
    expect(own).toBe("photo 7 2.png");
    expect(capitals).toBe("Photo 2001.PNG");
    expect(Number(looks)).toBeLessThan(10 * 2000);
  });

  it("a copy too long for Corillo to open isn't kept", async () => {
    const word = wordFile();
    const tooLong: CopyTools = {
      pandoc: () => PANDOC,
      run: async (_file, args) => {
        const output = args.find((a) => a.startsWith("--output="))!.slice("--output=".length);
        writeFileSync(output, "x".repeat(25 * 1024 * 1024 + 1));
        return { stdout: "", stderr: "" };
      },
    };
    await expect(makeWordCopy(word, copyPlace(word), tooLong)).rejects.toThrow("Its copy would be over 25 MB, too long for Corillo to open.");
    expect(readdirSync(join(word, ".."))).toEqual(["Offsite notes.docx"]);
    expect(copyWork()).toEqual([]);
  });
});

// E21-21: the copy's table code, with cases made from a line of HTML by the
// bundled Pandoc (cheaper than hand-written Word XML; the hand-made fixture
// stays for what Pandoc can't write).
describe("a table's cells in the copy, from Word documents Pandoc makes", () => {
  /** A Word document Pandoc makes from this HTML, in a folder of its own. */
  function fromHtml(html: string): string {
    const dir = folder();
    writeFileSync(join(dir, "page.html"), `<!doctype html><html><body>${html}</body></html>`);
    const file = join(dir, "Offsite notes.docx");
    execFileSync(PANDOC, [join(dir, "page.html"), "--from=html", "--to=docx", `--output=${file}`], { stdio: "pipe" });
    return file;
  }
  const table = (cell: string) => `<table><tr><th>Item</th><th>Notes</th></tr><tr><td>Venue</td><td>${cell}</td></tr></table>`;
  async function copied(cell: string): Promise<string> {
    const word = fromHtml(table(cell));
    const made = await makeWordCopy(word, copyPlace(word), tools);
    return made.text;
  }

  it("a quote in a cell: its words, still in the cell", async () => {
    expect(await copied("<blockquote><p>Lake house, <b>booked</b>.</p></blockquote>")).toMatch(/^\| Venue +\| Lake house, \*\*booked\*\*\. +\|$/m);
  });

  it("code in a cell: each line as code, on lines of its own", async () => {
    expect(await copied("<pre><code>npm run trip\nnpm run home</code></pre>")).toMatch(/^\| Venue +\| `npm run trip`<br>`npm run home` +\|$/m);
  });

  it("a list in a cell: one line per item, with its bullet", async () => {
    expect(await copied("<ul><li>Chairs</li><li>Tables</li></ul>")).toMatch(/^\| Venue +\| • Chairs<br>• Tables +\|$/m);
  });

  it("a table in a cell: a line for each row, its cells apart", async () => {
    expect(await copied("<table><tr><th>Day</th><th>Room</th></tr><tr><td>Mon</td><td>Oak</td></tr></table>")).toMatch(/^\| Venue +\| Day · Room<br>Mon · Oak +\|$/m);
  });
});

describe("the copy's History and its export to Word", () => {
  it("History's first version says what the copy was made from, to the person and to agents", () => {
    const data = folder();
    const history = new VersionHistory(data);
    const doc = join(folder(), "Offsite notes.md");
    writeFileSync(doc, COPY);
    const id = history.idFor(doc, COPY);
    history.seen(id, COPY, "Offsite notes.docx");
    const [first] = history.rows(id).versions;
    expect(first).toMatchObject({ n: 1, kind: "first", madeFrom: "Offsite notes.docx" });
    expect(versionLabel(first)).toBe("Made from Offsite notes.docx");
    expect(versionLabel(first, "agent")).toBe("Made from Offsite notes.docx");
    // Opened again, nothing changes; any other document's first version is as before.
    history.seen(id, COPY);
    expect(history.rows(id).versions).toHaveLength(1);
    const other = join(folder(), "notes.md");
    writeFileSync(other, "Notes.\n");
    const otherId = history.idFor(other, "Notes.\n");
    history.seen(otherId, "Notes.\n");
    expect(versionLabel(history.rows(otherId).versions[0])).toBe("First version");
  });

  it("Export suggests a new name rather than the Word file whose styles it uses: Offsite notes 2.docx", () => {
    const word = wordFile();
    const doc = join(word, "..", "Offsite notes.md");
    expect(suggestedOutputPath(doc, "docx", word)).toBe(join(word, "..", "Offsite notes 2.docx"));
    writeFileSync(join(word, "..", "Offsite notes 2.docx"), "an earlier export");
    expect(suggestedOutputPath(doc, "docx", word)).toBe(join(word, "..", "Offsite notes 3.docx"));
    // Any other document, a PDF, or other styles: next to the document, with its name, as before.
    expect(suggestedOutputPath(doc, "pdf", word)).toBe(join(word, "..", "Offsite notes.pdf"));
    expect(suggestedOutputPath(doc, "docx", "/Templates/Company.dotx")).toBe(join(word, "..", "Offsite notes.docx"));
    expect(suggestedOutputPath(doc, "docx")).toBe(join(word, "..", "Offsite notes.docx"));
  });
});

describe("the Word document's look, kept for the copy's export (B5-02, B5-04)", () => {
  /** What's in a zip: each file's name, and its text. */
  const inside = (zip: Buffer) => {
    const file = join(folder(), "styles.docx");
    writeFileSync(file, zip);
    const names = [...readZipFileEntries(file, () => true).keys()];
    const text = (name: string) => readZipEntry(zip, name)?.toString("utf8") ?? null;
    return { names, text };
  };

  it("keeps its styles, lists, page and header with its logo; leaves out its text, pictures, comments, Track Changes, editing lock and the rest", () => {
    const word = wordFile({ morePictures: 2, comments: 2, locked: true, header: true });
    const { names, text } = inside(wordStyles(word)!);
    expect(names.sort()).toEqual(
      [
        "[Content_Types].xml",
        "_rels/.rels",
        "word/_rels/document.xml.rels",
        "word/_rels/header1.xml.rels",
        "word/document.xml",
        "word/header1.xml",
        "word/media/logo.png",
        "word/numbering.xml",
        "word/settings.xml",
        "word/styles.xml",
      ].sort(),
    );
    // The look: the heading colour, the bullets, the page size and margins, the header and its logo.
    expect(text("word/styles.xml")).toContain('<w:color w:val="8A2BE2"/>');
    expect(text("word/numbering.xml")).toContain('<w:lvlText w:val="•"/>');
    expect(text("word/header1.xml")).toContain("Offsite notes, draft");
    expect(readZipEntry(wordStyles(word)!, "word/media/logo.png")!.equals(Buffer.from(LOGO))).toBe(true);
    // No words of the document: its body is the page's settings and nothing else.
    expect(text("word/document.xml")).toMatch(/<w:body><w:sectPr><w:headerReference w:type="default" r:id="rIdHeader"\/><w:pgSz [^>]*\/><w:pgMar [^>]*\/><\/w:sectPr><\/w:body><\/w:document>$/);
    expect(text("word/_rels/document.xml.rels")).not.toMatch(/image|comments/);
    expect(text("[Content_Types].xml")).not.toContain("comments");
    // Track Changes, the editing lock, "open as read only" and the document's own data are left out; the rest of its settings stay.
    const settings = text("word/settings.xml")!;
    for (const gone of ["trackRevisions", "documentProtection", "writeProtection", "docVars", "Lakeside"]) expect(settings).not.toContain(gone);
    expect(settings).toContain('<w:defaultTabStop w:val="720"/>');
  });

  it("a section's own tracked change, and the sections before the last, are left out too", () => {
    const W = 'xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"';
    const document =
      `<?xml version="1.0"?><w:document ${W}><w:body><w:p><w:pPr><w:sectPr><w:pgSz w:w="11906" w:h="16838"/></w:sectPr></w:pPr><w:r><w:t>Part one</w:t></w:r></w:p>` +
      `<w:sectPr w:rsidR="00A1"><w:pgSz w:w="12240" w:h="15840"/><w:sectPrChange w:id="7" w:author="Ana"><w:sectPr><w:pgSz w:w="11906" w:h="16838"/></w:sectPr></w:sectPrChange></w:sectPr></w:body></w:document>`;
    const file = join(folder(), "Sections.docx");
    writeFileSync(file, makeZip([
      { name: "word/document.xml", data: document },
      { name: "word/styles.xml", data: `<w:styles ${W}/>` },
    ]));
    const { text } = inside(wordStyles(file)!);
    expect(text("word/document.xml")).toBe(`<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n<w:document ${W}><w:body><w:sectPr w:rsidR="00A1"><w:pgSz w:w="12240" w:h="15840"/></w:sectPr></w:body></w:document>`);
  });

  it("nothing to keep, or a file that isn't a Word document: none (the copy then exports in Corillo's own style)", () => {
    const bare = join(folder(), "Bare.docx");
    writeFileSync(bare, makeZip([{ name: "word/document.xml", data: "<w:document><w:body/></w:document>" }]));
    expect(wordStyles(bare)).toBeNull();
    const damaged = join(folder(), "Damaged.docx");
    writeFileSync(damaged, "not a zip");
    expect(wordStyles(damaged)).toBeNull();
    expect(wordStyles(join(folder(), "gone.docx"))).toBeNull();
  });

  it("exported with it, a Word document holds only its own pictures and the logo, and neither Track Changes nor the lock", async () => {
    const word = wordFile({ morePictures: 2, comments: 1, locked: true, header: true });
    const dir = folder();
    const reference = join(dir, "styles.docx");
    writeFileSync(reference, wordStyles(word)!);
    writeFileSync(join(dir, "in.md"), "# Plan\n\nWords and no pictures.\n");
    await run(PANDOC, [join(dir, "in.md"), "--to=docx", `--reference-doc=${reference}`, `--output=${join(dir, "out.docx")}`], { cwd: dir, timeoutMs: 60_000 });
    const out = readFileSync(join(dir, "out.docx"));
    const { names, text } = inside(out);
    expect(names.filter((n) => n.startsWith("word/media/"))).toEqual(["word/media/logo.png"]);
    expect(text("word/settings.xml")).not.toMatch(/trackRevisions|documentProtection|writeProtection|docVars/);
    expect(text("word/styles.xml")).toContain('w:val="8A2BE2"');
    expect(text("word/document.xml")).toContain("Words and no pictures.");
    expect(text("word/document.xml")).not.toContain("lake house");
  });
});
