// Getting a document ready for Word and PDF export: diagrams swapped for
// pictures, picture paths, paper size, settings, Pandoc's instructions, and
// the pieces of a Word file Corillo writes itself.
import { describe, it, expect } from "vitest";
import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  exportSettingsFrom,
  findDiagrams,
  firstProblem,
  pandocArgs,
  pandocJsonArgs,
  pandocProblem,
  pandocLocation,
  paperFor,
  replaceDiagrams,
  settingsAllowed,
  templateStyles,
  warningNotes,
  withoutFrontMatter,
  macTooOldForWord,
  PANDOC_MIN_MACOS,
  WORD_NEEDS_NEWER_MAC,
} from "../../src/main/export-prep";
import { buildReferenceDocx, stylesXml } from "../../src/main/reference-docx";
import { makeZip } from "../../src/main/zip";
import { crc32, pngInfo, withResolution } from "../../src/core/png";
import { endSentence, htmlPictures, pageImageSources, pictureKind, pictureNotes } from "../../src/main/export-pictures";
import { paragraphsOf, PANDOC, toWord as exportToWord } from "./word";
import { wordFileProblems } from "../word-check";

describe("diagrams become pictures in the copy Pandoc gets", () => {
  const doc = "# Plan\n\n```mermaid\ngraph LR\n  A --> B\n```\n\n```js\nlet x = 1;\n```\n\nEnd.\n";

  it("finds only diagram code blocks, with their text and where they are", () => {
    expect(findDiagrams(doc)).toEqual([{ code: "graph LR\n  A --> B\n", from: 2, to: 6, prefix: "" }]);
  });

  it("replaces a diagram with its picture, centred in a paragraph of its own, and leaves everything else as written", () => {
    expect(replaceDiagrams(doc, ["/tmp/work/diagram-1.png"])).toBe(
      '# Plan\n\n::: {custom-style="Diagram"}\n![Diagram](</tmp/work/diagram-1.png>)\n:::\n\n```js\nlet x = 1;\n```\n\nEnd.\n',
    );
  });

  it("keeps a diagram that couldn't be drawn as its code", () => {
    expect(replaceDiagrams(doc, [null])).toBe(doc);
  });

  it("replaces each of several diagrams with its own picture", () => {
    const two = "```mermaid\ngraph LR\n  A --> B\n```\n\nThen:\n\n```mermaid\npie\n  \"a\" : 1\n```\n";
    const out = replaceDiagrams(two, ["/w/one.png", "/w/two.png"]);
    expect(out).toContain("![Diagram](</w/one.png>)");
    expect(out).toContain("![Diagram](</w/two.png>)");
    expect(out).toContain("Then:");
    expect(out).not.toContain("mermaid");
  });

  it("separates the picture from text that touches the diagram, so it stays a paragraph of its own", () => {
    const tight = "Flow:\n```mermaid\ngraph LR\n  A --> B\n```\nEnd.\n";
    expect(replaceDiagrams(tight, ["/w/d.png"])).toBe(
      'Flow:\n\n::: {custom-style="Diagram"}\n![Diagram](</w/d.png>)\n:::\n\nEnd.\n',
    );
  });

  it("keeps a diagram inside a quote inside the quote", () => {
    const quoted = "> Look:\n>\n> ```mermaid\n> graph LR\n>   A --> B\n> ```\n";
    expect(findDiagrams(quoted)[0]).toMatchObject({ code: "graph LR\n  A --> B\n", prefix: "> " });
    expect(replaceDiagrams(quoted, ["/w/d.png"])).toBe(
      '> Look:\n>\n> ::: {custom-style="Diagram"}\n> ![Diagram](</w/d.png>)\n> :::\n',
    );
  });

  it("reads files with Windows line endings", () => {
    const crlf = "Intro\r\n\r\n```mermaid\r\ngraph LR\r\n  A --> B\r\n```\r\n";
    expect(findDiagrams(crlf)).toHaveLength(1);
    expect(replaceDiagrams(crlf, ["/w/d.png"])).toContain("![Diagram](</w/d.png>)");
  });
});

describe("paper size", () => {
  it("is US Letter in the United States and the other places that use it", () => {
    for (const locale of ["en-US", "en_US", "es-US", "es-PR", "en-CA", "fr-CA", "es-MX", "en-PH", "en"]) {
      expect(paperFor(locale), locale).toBe("Letter");
    }
  });

  it("is A4 everywhere else, and when the region can't be told", () => {
    for (const locale of ["en-GB", "de-DE", "es-ES", "fr", "ja-JP", "", "not a locale"]) {
      expect(paperFor(locale), locale).toBe("A4");
    }
  });
});

describe("export settings remembered for a document", () => {
  it("default to Corillo's clean style", () => {
    expect(exportSettingsFrom(undefined)).toEqual({ style: "corillo" });
    expect(exportSettingsFrom({})).toEqual({ style: "corillo" });
  });

  it("keep a Word document's styles, a Lua filter and a script", () => {
    const s = { style: "word", referenceDoc: "/a/Company.dotx", luaFilter: "/a/f.lua", script: "/a/touch.py" };
    expect(exportSettingsFrom(s)).toEqual(s);
  });

  it("fall back to Corillo's style when the Word document is missing, and ignore anything that isn't a full path", () => {
    expect(exportSettingsFrom({ style: "word" })).toEqual({ style: "corillo" });
    expect(exportSettingsFrom({ style: "word", referenceDoc: "Company.docx", luaFilter: 3, script: "" })).toEqual({ style: "corillo" });
  });
});

describe("export settings the window sends (EX-5)", () => {
  const stored = { style: "word" as const, referenceDoc: "/a/Company.dotx", script: "/a/touch.py" };

  it("take a file only if the person chose it in a dialog this session, or it's already the stored one", () => {
    const chosen = { luaFilter: new Set(["/a/new-filter.lua"]) };
    expect(settingsAllowed({ ...stored, luaFilter: "/a/new-filter.lua" }, stored, chosen)).toBe(true);
    expect(settingsAllowed(stored, stored, {})).toBe(true);
    expect(settingsAllowed({ style: "corillo" }, stored, {})).toBe(true); // removing is always fine
    expect(settingsAllowed({ ...stored, script: "/bin/evil.sh" }, stored, chosen)).toBe(false);
    expect(settingsAllowed({ ...stored, referenceDoc: "/tmp/other.docx" }, stored, chosen)).toBe(false);
    expect(settingsAllowed({ style: "corillo", luaFilter: "/a/sneaky.lua" }, { style: "corillo" }, chosen)).toBe(false);
  });

  it("take a file only for the setting it was chosen for: a Lua filter can't become the script, nor a script the filter (R-EX-7)", () => {
    const chosen = { luaFilter: new Set(["/a/filter.lua"]), script: new Set(["/a/touch.sh"]) };
    expect(settingsAllowed({ style: "corillo", script: "/a/filter.lua" }, { style: "corillo" }, chosen)).toBe(false);
    expect(settingsAllowed({ style: "corillo", luaFilter: "/a/touch.sh" }, { style: "corillo" }, chosen)).toBe(false);
    expect(settingsAllowed({ style: "word", referenceDoc: "/a/touch.sh" }, { style: "corillo" }, chosen)).toBe(false);
    expect(settingsAllowed({ style: "corillo", luaFilter: "/a/filter.lua", script: "/a/touch.sh" }, { style: "corillo" }, chosen)).toBe(true);
  });
});

describe("Pandoc's instructions", () => {
  // Changed 2026-11-09 night (EX-1): Pandoc used to find pictures itself from
  // the document's folder; now Corillo hands it the pictures it checked, and
  // Pandoc can read nothing else (its sandbox), unless the person's own Lua
  // filter may need to add pictures of its own.
  it("use the chosen styles, read only what Corillo names, and add a Lua filter only when there is one", () => {
    const args = pandocArgs({ input: "/w/document.md", output: "/w/export.docx", referenceDoc: "/w/style.docx" });
    expect(args).toContain("/w/document.md");
    expect(args).toContain("--to=docx");
    expect(args).toContain("--output=/w/export.docx");
    expect(args).toContain("--reference-doc=/w/style.docx");
    expect(args).toContain("--sandbox");
    expect(args).not.toContain("--resource-path=.");
    expect(args.some((a) => a.startsWith("--lua-filter"))).toBe(false);
    const theirs = pandocArgs({ input: "i", output: "o", referenceDoc: "r", luaFilter: "/f.lua" });
    expect(theirs).toContain("--lua-filter=/f.lua");
    expect(theirs).toContain("--resource-path=.");
    expect(theirs).not.toContain("--sandbox");
    expect(pandocJsonArgs("i", "o")).toContain("--sandbox");
  });

  it("read Markdown as Corillo shows it: dollar amounts stay text, and no extras Corillo doesn't show", () => {
    const from = pandocArgs({ input: "i", output: "o", referenceDoc: "r" }).find((a) => a.startsWith("--from="))!;
    expect(from).toMatch(/^--from=commonmark_x/);
    for (const off of ["tex_math_dollars", "emoji", "subscript", "superscript", "fancy_lists", "definition_lists"]) {
      expect(from).toContain(`-${off}`);
    }
  });

  it("find Pandoc inside the packaged app, or in vendor/ while developing", () => {
    expect(pandocLocation({ packaged: true, resourcesPath: "/Applications/Corillo.app/Contents/Resources", appPath: "x", arch: "arm64" })).toBe(
      "/Applications/Corillo.app/Contents/Resources/pandoc/arm64/pandoc",
    );
    expect(pandocLocation({ packaged: false, resourcesPath: "x", appPath: "/src/corillo", arch: "x64" })).toBe("/src/corillo/vendor/pandoc/x64/pandoc");
  });

  it("warnings that something couldn't be put in become notes for the person; other warnings don't", () => {
    expect(warningNotes("[WARNING] Could not fetch resource logo.png: not found\n[WARNING] Duplicate note reference '1'\n")).toEqual([
      "Part of the document was left out of the Word document: Could not fetch resource logo.png: not found.",
    ]);
    expect(warningNotes("")).toEqual([]);
  });

  it("each note is a sentence of its own, so several in the notice don't run together (R-EX-9)", () => {
    const notes = pictureNotes([
      { name: "chart.png", why: "missing" },
      { name: "http://example.com/a.png", why: "insecure" },
      { name: "http://example.com/b.png", why: "insecure" },
    ]);
    expect(notes.join(" ")).toBe(
      "A picture couldn't be found and was left out: chart.png. " +
        "2 pictures were left out because their web addresses aren't secure (they start with http:, and Corillo shows only https: pictures): http://example.com/a.png, http://example.com/b.png.",
    );
    expect(warningNotes("[WARNING] Could not convert a thing.\n")).toEqual(["Part of the document was left out of the Word document: Could not convert a thing."]);
    expect(endSentence("stopped with an error: no printer found")).toBe("stopped with an error: no printer found.");
    expect(endSentence("Is it there?")).toBe("Is it there?");
    expect(endSentence("(see above.)")).toBe("(see above.)");
    expect(endSentence("data:image/bmp;base64,Qk0…")).toBe("data:image/bmp;base64,Qk0…");
  });

  it("a problem in the Word step is explained in plain words, not the system's (EX-12)", () => {
    const corillo = { style: "corillo" as const };
    const theirs = { style: "word" as const, referenceDoc: "/Users/me/Company.dotx" };
    const errno = (code: string, more: object) => Object.assign(new Error(`${code}: something, open '/x'`), { code, ...more });
    expect(pandocProblem(errno("EACCES", { path: "/Users/me/Company.dotx", syscall: "open" }), theirs).message).toBe(
      "Corillo isn't allowed to read Company.dotx, the Word document whose styles you chose. Choose another in Export Settings, or check its sharing and permissions in Finder.",
    );
    expect(pandocProblem(errno("EACCES", { path: "/app/pandoc", syscall: "spawn /app/pandoc" }), corillo).message).toBe(
      "Pandoc, the program inside Corillo that makes Word documents, couldn't be started. Reinstalling Corillo should fix it.",
    );
    expect(pandocProblem(errno("ENOSPC", { syscall: "write" }), corillo).message).toBe("The Word document couldn't be made: the disk is full.");
    expect(pandocProblem(Object.assign(new Error("x"), { stderr: "Error: bad things\n", code: 1 }), corillo).message).toBe(
      "The Word document couldn't be made: Error: bad things",
    );
    for (const e of [errno("EPERM", { syscall: "open", path: "/w/x" }), errno("EIO", { syscall: "read" })]) {
      expect(pandocProblem(e, corillo).message).not.toMatch(/E[A-Z]{2,}|open '/);
    }
  });

  it("on macOS 13 or 14, Word says plainly that it needs macOS 15 (review B13R-7)", () => {
    // Darwin's number for each macOS, as the Mac reports it: 22 is macOS 13, 23 is 14, 24 is 15.
    for (const older of ["22.6.0", "23.0.0", "23.6.0"]) expect(macTooOldForWord(older), older).toBe(true);
    for (const newer of ["24.0.0", "24.6.0", "25.1.0", "27.2.0"]) expect(macTooOldForWord(newer), newer).toBe(false);
    // Anything it can't read never stops Word on a Mac that may run it.
    for (const unknown of ["", "unknown"]) expect(macTooOldForWord(unknown), unknown).toBe(false);
    expect(PANDOC_MIN_MACOS).toBe(15);
    expect(WORD_NEEDS_NEWER_MAC).toBe("Opening Word documents and exporting to Word need macOS 15 or later. Everything else in Corillo works on this Mac.");
    // Help says it on both Word pages.
    const help = readFileSync(join(import.meta.dirname, "..", "..", "src/renderer/help.html"), "utf8");
    for (const page of ["start-word", "sharing-export"]) {
      const at = help.indexOf(`id="${page}"`);
      expect(help.slice(at, help.indexOf("<h2", at + 1)), page).toContain(`macOS ${PANDOC_MIN_MACOS} or later`);
    }
  });

  it("errors are shortened to what matters, without warnings", () => {
    expect(firstProblem("[WARNING] Could not fetch resource a.png\nError running filter shout.lua:\nshout.lua:2: oops\n")).toBe(
      "Error running filter shout.lua: shout.lua:2: oops",
    );
  });
});

// A tiny 2 by 1 PNG.
const TINY = Uint8Array.from(
  Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAIAAAABCAYAAAD0In+KAAAAEUlEQVR4nGNgYGD4z8DAwMAAAA0BAf8Sg6gAAAAASUVORK5CYII=", "base64"),
);

describe("diagram pictures", () => {
  it("are stamped with their print resolution, so Word shows them at the right size", () => {
    expect(pngInfo(TINY)).toEqual({ width: 2, height: 1, dpi: null });
    const stamped = withResolution(TINY, 288);
    expect(pngInfo(stamped)).toEqual({ width: 2, height: 1, dpi: 288 });
    expect(pngInfo(withResolution(stamped, 96)).dpi).toBe(96); // replaced, not added twice
  });

  it("stay valid pictures (macOS can read the stamped file)", () => {
    const dir = mkdtempSync(join(tmpdir(), "corillo-png-"));
    const file = join(dir, "d.png");
    writeFileSync(file, withResolution(TINY, 288));
    const out = execFileSync("sips", ["-g", "dpiWidth", "-g", "pixelWidth", file], { encoding: "utf8" });
    expect(out).toMatch(/pixelWidth: 2/);
    expect(out).toMatch(/dpiWidth: 288/);
  });

  it("use the standard checksum", () => {
    expect(crc32(new TextEncoder().encode("123456789"))).toBe(0xcbf43926);
  });
});

describe("Corillo's own Word style", () => {
  it("is a zip that standard tools read back exactly", () => {
    const dir = mkdtempSync(join(tmpdir(), "corillo-zip-"));
    const file = join(dir, "t.zip");
    writeFileSync(file, makeZip([{ name: "a.txt", data: "hello" }, { name: "word/styles.xml", data: "<x/>".repeat(50) }]));
    expect(execFileSync("unzip", ["-Z1", file], { encoding: "utf8" }).trim().split("\n")).toEqual(["a.txt", "word/styles.xml"]);
    expect(execFileSync("unzip", ["-p", file, "word/styles.xml"], { encoding: "utf8" })).toBe("<x/>".repeat(50));
  });

  it("comes out the same every time", () => {
    expect(buildReferenceDocx("A4").equals(buildReferenceDocx("A4"))).toBe(true);
  });

  it("sets the page to Letter or A4 with one-inch margins", () => {
    const dir = mkdtempSync(join(tmpdir(), "corillo-ref-"));
    for (const [paper, size] of [["Letter", 'w:w="12240" w:h="15840"'], ["A4", 'w:w="11906" w:h="16838"']] as const) {
      const file = join(dir, `${paper}.docx`);
      writeFileSync(file, buildReferenceDocx(paper));
      const xml = execFileSync("unzip", ["-p", file, "word/document.xml"], { encoding: "utf8" });
      expect(xml).toContain(size);
      expect(xml).toContain('w:left="1440"');
    }
  });

  it("defines every style Pandoc uses, in one sans-serif font, with a light rule under table headers", () => {
    const xml = stylesXml();
    for (const id of [
      "Normal", "BodyText", "FirstParagraph", "Compact", "Title", "Subtitle", "Heading1", "Heading2", "Heading3",
      "BlockText", "SourceCode", "VerbatimChar", "Hyperlink", "FootnoteText", "FootnoteReference", "Table", "Diagram",
      "ImageCaption", "TableCaption", "Figure",
    ]) {
      expect(xml, id).toContain(`w:styleId="${id}"`);
    }
    expect(xml).toContain('w:ascii="Aptos"');
    expect(xml).toMatch(/<w:tblStylePr w:type="firstRow">.*<w:bottom w:val="single" w:sz="8"/);
    // Every element opened is closed.
    expect(xml.match(/<w:style /g)?.length).toBe(xml.match(/<\/w:style>/g)?.length);
  });
});

describe("front matter is left out of exports", () => {
  it("drops the block at the very top and the blank line under it (more are empty lines, as the page shows them)", () => {
    expect(withoutFrontMatter("---\ntitle: Plan\ntags: [a, b]\n---\n\n# Plan\n\nBody.\n")).toBe("# Plan\n\nBody.\n");
  });
  it("accepts ... as the closing line, Windows line endings and a BOM", () => {
    expect(withoutFrontMatter("---\r\ntitle: Plan\r\n...\r\n\r\nBody.\r\n")).toBe("Body.\r\n");
    expect(withoutFrontMatter("\uFEFF---\ntitle: Plan\n---\nBody.\n")).toBe("\uFEFFBody.\n");
  });
  it("handles an empty block and a document that is only front matter", () => {
    expect(withoutFrontMatter("---\n---\nBody.\n")).toBe("Body.\n");
    expect(withoutFrontMatter("---\ntitle: Plan\n---")).toBe("");
  });
  it("leaves everything else alone: no block at the top, an unclosed block, rules further down", () => {
    for (const text of ["# Plan\n\n---\n\nkey: value\n\n---\n", "---\nNot closed.\n", "Intro.\n\n---\ntitle: x\n---\n", " ---\nx\n---\n"]) {
      expect(withoutFrontMatter(text)).toBe(text);
    }
  });
  it("tells Pandoc that nothing in the document is metadata", () => {
    expect(pandocArgs({ input: "in.md", output: "out.docx", referenceDoc: "ref.docx" }).join(" ")).toContain("-yaml_metadata_block");
  });
});

describe("only real pictures go into a Word document (EX-1)", () => {
  const SECRET = "TOP-SECRET-MARKER-12345";

  it("a file that isn't a picture never gets in, whether linked as a picture, by its full path, as hidden HTML or in a frame", () => {
    const outside = mkdtempSync(join(tmpdir(), "corillo-secret-"));
    const secret = join(outside, "secret-notes.txt");
    writeFileSync(secret, `${SECRET}\n`);
    const markdown = [
      "# Review this",
      "",
      "![notes](notes.txt)",
      "",
      `![key](<${secret}>)`,
      "",
      "![hosts](/etc/hosts)",
      "",
      `<div><img src="${secret}" width="1" height="1"></div>`,
      "",
      `<iframe src="file://${secret}"></iframe>`,
      "",
      "![chart](chart.png)",
      "",
      "End.",
      "",
    ].join("\n");
    const word = exportToWord(markdown, {}, (dir) => {
      writeFileSync(join(dir, "notes.txt"), `${SECRET}\n`);
      writeFileSync(join(dir, "chart.png"), TINY);
    });
    const media = execFileSync("unzip", ["-Z1", word.file], { encoding: "utf8" }).split("\n").filter((e) => e.startsWith("word/media/"));
    expect(media).toHaveLength(1); // the chart, and nothing else
    expect(execFileSync("unzip", ["-p", word.file, media[0]]).equals(Buffer.from(TINY))).toBe(true);
    // Nowhere in the Word file, not even as text.
    const everything = execFileSync("unzip", ["-p", word.file], { maxBuffer: 64 * 1024 * 1024 }).toString("latin1");
    expect(everything).not.toContain(SECRET);
    expect(everything).not.toContain("localhost"); // /etc/hosts
    // The words around the pictures stay.
    expect(word.html).toContain("Review this");
    expect(word.html).toContain("End.");
    // The person is told what was left out.
    expect(word.left).toEqual([
      `3 files used as pictures aren't pictures, so they were left out: notes.txt, ${secret}, /etc/hosts.`,
      `A picture written in HTML was left out (Corillo shows HTML as its text): ${secret}.`,
    ]);
  });

  it("tells a picture by its first bytes, not its name, whatever its kind", () => {
    const kinds: [string, number[] | string][] = [
      ["png", [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0]],
      ["jpeg", [0xff, 0xd8, 0xff, 0xe0, 0, 0x10]],
      ["gif", "GIF89a...."],
      ["webp", "RIFF\0\0\0\0WEBPVP8 "],
      ["bmp", [0x42, 0x4d, 0, 0, 0, 0, 0, 0, 0, 0, 54, 0, 0, 0, 40, 0, 0, 0, 1, 0]],
      ["tiff", [0x49, 0x49, 0x2a, 0, 8, 0, 0, 0]],
      ["heic", "\0\0\0\x18ftypheic\0\0\0\0mif1heic"],
      ["avif", "\0\0\0\x1cftypavif\0\0\0\0avifmif1miaf"],
      ["svg", '<?xml version="1.0"?>\n<!-- logo -->\n<svg xmlns="http://www.w3.org/2000/svg" width="10" height="10"/>'],
    ];
    for (const [kind, bytes] of kinds) {
      const b = typeof bytes === "string" ? Uint8Array.from(bytes, (c) => c.charCodeAt(0)) : Uint8Array.from(bytes);
      expect(pictureKind(b), kind).toBe(kind);
    }
    for (const text of ["TOP SECRET", "BMW service notes", "<!doctype html><html><body><svg></svg></body></html>", "%PDF-1.7", ""]) {
      expect(pictureKind(new TextEncoder().encode(text)), text).toBeNull();
    }
  });
});

describe("Word, the PDF and the page agree on what is a picture (R-EX-4)", () => {
  const svg = '<svg xmlns="http://www.w3.org/2000/svg" width="10" height="10"/>';
  const svgData = `data:image/svg+xml;base64,${Buffer.from(svg).toString("base64")}`;
  const bmpData = `data:image/bmp;base64,${Buffer.from([0x42, 0x4d, 0, 0, 0, 0, 0, 0, 0, 0, 54, 0, 0, 0, 40, 0, 0, 0, 1, 0]).toString("base64")}`;
  const pngData = `data:image/png;base64,${Buffer.from(TINY).toString("base64")}`;

  it("a picture the page shows as its text (a file: address, a data: address of a kind it doesn't show) is left out of Word, and the notice says so", () => {
    const outside = mkdtempSync(join(tmpdir(), "corillo-file-"));
    const chart = join(outside, "chart.png");
    writeFileSync(chart, TINY);
    const markdown = `![by file](file://${chart})\n\n![drawing](${svgData})\n\n![bitmap](${bmpData})\n\n![inline](${pngData})\n\n![near](near.png)\n`;
    // The page shows these two as pictures, and only these.
    expect(pageImageSources(markdown)).toEqual([pngData, "near.png"]);
    const word = exportToWord(markdown, {}, (dir) => writeFileSync(join(dir, "near.png"), TINY));
    expect(Object.keys(word.layout.pictures).sort()).toEqual([pngData, "near.png"].sort());
    const media = execFileSync("unzip", ["-Z1", word.file], { encoding: "utf8" }).split("\n").filter((e) => e.startsWith("word/media/"));
    expect(media).toHaveLength(2); // the two the page shows
    expect(word.left).toEqual([
      `3 pictures were left out because Corillo shows their addresses as text rather than as pictures: file://${chart}, ${svgData.slice(0, 30)}…, ${bmpData.slice(0, 30)}…`, // a name cut short ends the sentence as it is
    ]);
    // Their words stay, as the alt text.
    expect(word.html).toContain("by file");
    expect(word.html).toContain("drawing");
  });

  // The page reads math as its characters, so a picture written in a $$ block is text there.
  it("a picture written in math isn't one: Word shows it as text, and the PDF's pictures step neither takes it nor names it", () => {
    const markdown = "Before.\n\n$$\n![x](missing.png)\n$$\n\nAfter.\n";
    expect(pageImageSources(markdown)).toEqual([]);
    const word = exportToWord(markdown, {}, (dir) => writeFileSync(join(dir, "missing.png"), TINY));
    expect(word.xml).not.toContain("<w:drawing>");
    expect(paragraphsOf(word.xml).map((p) => p.words)).toContain("$$\n![x](missing.png)\n$$");
    expect(word.left).toEqual([]);
  });

  it("a picture inside an HTML comment isn't one, so nothing is said about it", () => {
    expect(htmlPictures('<!-- <img src="old.png"> -->\n\nText.\n')).toEqual([]);
    expect(htmlPictures('<div>\n<!-- <img src="old.png"> -->\n<img src="new.png">\n</div>\n')).toEqual(["new.png"]);
    expect(htmlPictures('Text <!-- <img src="old.png"> --> more.\n')).toEqual([]);
  });

  it("a picture written in HTML inside a paragraph is named in the notice too, not left out without a word", () => {
    expect(htmlPictures('A paragraph with <img src="inline.png" alt="x"> in it.\n')).toEqual(["inline.png"]);
    const word = exportToWord('A paragraph with <img src="inline.png" alt="x"> in it.\n', {}, (dir) => writeFileSync(join(dir, "inline.png"), TINY));
    expect(word.left).toEqual(["A picture written in HTML was left out (Corillo shows HTML as its text): inline.png."]);
  });
});

describe("a person's own Lua filter (R-EX-6)", () => {
  it("sees each picture's address as the document writes it, so a filter that picks pictures by name still works", () => {
    const theirs = 'function Image(img)\n  if img.src == "chart.png" then\n    img.attributes.width = "1in"\n    img.attributes.height = "0.5in"\n  end\n  return img\nend\n';
    const outside = mkdtempSync(join(tmpdir(), "corillo-where-"));
    writeFileSync(join(outside, "far.png"), TINY);
    const word = exportToWord(`![chart](chart.png)\n\n![other](other.png)\n\n![far](<${join(outside, "far.png")}>)\n`, {}, (dir) => {
      writeFileSync(join(dir, "chart.png"), TINY);
      writeFileSync(join(dir, "other.png"), TINY);
    }, undefined, theirs);
    const extents = [...word.xml.matchAll(/<wp:extent cx="(\d+)" cy="(\d+)"/g)].map((m) => [Number(m[1]) / 914400, Number(m[2]) / 914400]);
    expect(extents[0]).toEqual([1, 0.5]); // their filter's size, in inches
    expect(extents[1][0]).toBeLessThan(0.1); // the other one as it was: 2 points wide
    // Where the pictures are on this Mac doesn't end up in the Word file.
    const everything = execFileSync("unzip", ["-p", word.file], { maxBuffer: 64 * 1024 * 1024 }).toString("latin1");
    expect(everything).not.toContain(outside);
  });
});

describe("picture kinds Corillo can't show (R-EX-3)", () => {
  it("a HEIC or TIFF picture is left out of Word with a note saying why, never silently swapped for its words", () => {
    const heic = Uint8Array.from("\0\0\0\x18ftypheic\0\0\0\0mif1heic", (c) => c.charCodeAt(0));
    const tiff = Uint8Array.from([0x49, 0x49, 0x2a, 0, 8, 0, 0, 0]);
    const word = exportToWord("![photo](photo.heic)\n\n![scan](scan.tif)\n\n![chart](chart.png)\n", {}, (dir) => {
      writeFileSync(join(dir, "photo.heic"), heic);
      writeFileSync(join(dir, "scan.tif"), tiff);
      writeFileSync(join(dir, "chart.png"), TINY);
    });
    expect(Object.keys(word.layout.pictures)).toEqual(["chart.png"]);
    expect(word.left).toEqual([
      "2 pictures were left out because Corillo can't show their kind of file (HEIC or TIFF; save them as JPEG or PNG): photo.heic, scan.tif.",
    ]);
  });
});

describe("with the person's own Word template (EX-4)", () => {
  // Pandoc's own stock template stands in for a person's: it has none of Corillo's styles.
  const stock = execFileSync(PANDOC, ["--print-default-data-file", "reference.docx"], { maxBuffer: 16 * 1024 * 1024 });
  const markdown = "Intro.\n\n> A quote.\n>\n> > A quote inside it.\n\n> [!warning] Careful\n> The body of the callout.\n\nEnd.\n";

  it("callouts and quotes inside quotes are never given a style the template doesn't have", () => {
    const word = exportToWord(markdown, {}, undefined, stock);
    expect(wordFileProblems(word.file)).toEqual([]);
  });

  it("they come out as the template's own quotes, the callout's title in bold, as plain Pandoc would make them", () => {
    const { xml } = exportToWord(markdown, {}, undefined, stock);
    const styleOf = (words: string) => paragraphsOf(xml).find((p) => p.words.includes(words))?.style;
    expect(styleOf("A quote.")).toBe("BlockText");
    expect(styleOf("A quote inside it.")).toBe("BlockText");
    expect(styleOf("Careful")).toBe("BlockText");
    expect(styleOf("The body of the callout.")).toBe("BlockText");
    expect(xml).toMatch(/<w:b \/>[\s\S]{0,120}Careful/);
  });

  it("Corillo's own style still makes them coloured boxes and quotes set further in", () => {
    const { xml } = exportToWord(markdown);
    const styleOf = (words: string) => paragraphsOf(xml).find((p) => p.words.includes(words))?.style;
    expect(styleOf("A quote inside it.")).toBe("BlockText2");
    expect(styleOf("The body of the callout.")).toBe("CalloutOchre");
  });

  it("knows which of Corillo's styles a template has", () => {
    expect(templateStyles(buildReferenceDocx("Letter"))).toEqual(expect.arrayContaining(["Callout Sky", "Block Text 2", "Block Text 3", "Diagram"]));
    expect(templateStyles(stock)).toEqual([]);
  });
});

describe("the Word-file check the tests run on every Word export", () => {
  it("finds a picture that isn't one, a file no picture uses, and Corillo's styles made up empty", () => {
    const dir = mkdtempSync(join(tmpdir(), "corillo-check-"));
    const file = join(dir, "bad.docx");
    const rels = (target: string) =>
      `<Relationship Id="rId9" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/image" Target="${target}"/>`;
    writeFileSync(
      file,
      makeZip([
        { name: "word/document.xml", data: '<w:document><w:p><w:pPr><w:pStyle w:val="CalloutSky"/></w:pPr></w:p></w:document>' },
        { name: "word/styles.xml", data: '<w:styles><w:style w:type="paragraph" w:styleId="CalloutSky"><w:name w:val="Callout Sky"/><w:basedOn w:val="BodyText"/></w:style></w:styles>' },
        { name: "word/_rels/document.xml.rels", data: `<Relationships>${rels("media/rId9.txt")}</Relationships>` },
        { name: "word/media/rId9.txt", data: "TOP SECRET" },
        { name: "word/media/stray.png", data: TINY },
      ]),
    );
    expect(wordFileProblems(file)).toEqual([
      "style Callout Sky is used but has no formatting",
      "picture media/rId9.txt isn't a picture",
      "word/media/stray.png is in the Word file but no picture uses it",
    ]);
  });

  it("finds space around plain text in Corillo's style, and an empty line's mark left in the words", () => {
    const dir = mkdtempSync(join(tmpdir(), "corillo-check-"));
    const file = join(dir, "spaced.docx");
    const style = (id: string, name: string, body = "") => `<w:style w:type="paragraph" w:styleId="${id}"><w:name w:val="${name}"/>${body}</w:style>`;
    writeFileSync(
      file,
      makeZip([
        { name: "word/document.xml", data: "<w:document><w:p><w:r><w:t>&lt;!--corillo blank--&gt;</w:t></w:r></w:p></w:document>" },
        {
          name: "word/styles.xml",
          data:
            '<w:styles><w:docDefaults><w:pPrDefault><w:pPr><w:spacing w:before="0" w:after="180"/></w:pPr></w:pPrDefault></w:docDefaults>' +
            style("CalloutSky", "Callout Sky", '<w:pPr><w:spacing w:before="0" w:after="0"/></w:pPr>') +
            style("BodyText", "Body Text") +
            style("FirstParagraph", "First Paragraph", '<w:basedOn w:val="BodyText"/>') +
            style("Compact", "Compact", '<w:basedOn w:val="BodyText"/><w:pPr><w:spacing w:before="40" w:after="0"/></w:pPr>') +
            "</w:styles>",
        },
      ]),
    );
    expect(wordFileProblems(file)).toEqual([
      "Body Text has space after it",
      "First Paragraph has space after it",
      "Compact has space before it",
      "an empty line's mark is left in the words",
    ]);
  });

  it("finds a heading that Word could leave alone at the bottom of a page: an empty line under it not kept with the text", () => {
    const dir = mkdtempSync(join(tmpdir(), "corillo-check-"));
    const file = join(dir, "headings.docx");
    const p = (style: string, words = "", keep = "") => `<w:p><w:pPr><w:pStyle w:val="${style}"/>${keep}</w:pPr>${words && `<w:r><w:t>${words}</w:t></w:r>`}</w:p>`;
    const body = [
      // Kept: directly, and through the style.
      p("Heading1", "Kept"), p("BodyText", "", "<w:keepNext/>"), p("Kept"), p("BodyText", "Text."),
      // Not kept: the second empty line, and an empty line whose keep is turned off.
      p("Heading2", "Second"), p("BodyText", "", "<w:keepNext/>"), p("BodyText"), p("BodyText", "Text."),
      p("Heading2", "Off"), p("Kept", "", '<w:keepNext w:val="0"/>'), p("BodyText", "Text."),
      // No empty line: nothing to keep.
      p("Heading3", "Close"), p("BodyText", "Text."),
    ].join("");
    const style = (id: string, name: string, inner = "") => `<w:style w:type="paragraph" w:styleId="${id}"><w:name w:val="${name}"/>${inner}</w:style>`;
    writeFileSync(
      file,
      makeZip([
        { name: "word/document.xml", data: `<w:document><w:body>${body}</w:body></w:document>` },
        {
          name: "word/styles.xml",
          data:
            "<w:styles>" +
            style("BodyText", "Body Text") +
            style("Kept", "Kept", '<w:basedOn w:val="BodyText"/><w:pPr><w:keepNext/></w:pPr>') +
            ["Heading1", "Heading2", "Heading3"].map((id) => style(id, `heading ${id.slice(-1)}`, "<w:pPr><w:keepNext/></w:pPr>")).join("") +
            "</w:styles>",
        },
      ]),
    );
    expect(wordFileProblems(file)).toEqual([
      'the empty line under the heading "Second" isn\'t kept with the text after it',
      'the empty line under the heading "Off" isn\'t kept with the text after it',
    ]);
  });
});

describe("HTML in table cells reaches Word", () => {
  const toWord = (markdown: string) => exportToWord(markdown).xml;

  /** The text of each table cell: a line break as "\n", bold as **, italic as _, struck as ~~. */
  function cells(xml: string): string[] {
    return [...xml.matchAll(/<w:tc>([\s\S]*?)<\/w:tc>/g)].map(([, tc]) =>
      [...tc.matchAll(/<w:r>([\s\S]*?)<\/w:r>/g)]
        .map(([, run]) => {
          if (run.includes("<w:br />")) return "\n";
          const text = [...run.matchAll(/<w:t[^>]*>([^<]*)<\/w:t>/g)].map((m) => m[1]).join("");
          if (run.includes("<w:b />")) return `**${text}**`;
          if (run.includes("<w:i />")) return `_${text}_`;
          if (run.includes("<w:strike />")) return `~~${text}~~`;
          return text;
        })
        .join(""),
    );
  }

  it("runs Corillo's filter before the person's own", () => {
    const args = pandocArgs({ input: "i", output: "o", referenceDoc: "r", corilloFilter: "/w/corillo.lua", luaFilter: "/f.lua" });
    expect(args.filter((a) => a.startsWith("--lua-filter"))).toEqual(["--lua-filter=/w/corillo.lua", "--lua-filter=/f.lua"]);
  });

  it("turns <br> in every form into a line break, and simple HTML formatting into Word's", () => {
    const xml = toWord("| A | B |\n|---|---|\n| one<br>two<br/>three<BR />four | <b>bold</b> <i>it</i> <s>gone</s> <strong>x</strong> |\n");
    const all = cells(xml);
    expect(all[2]).toBe("one\ntwo\nthree\nfour");
    expect(all[3]).toBe("**bold** _it_ ~~gone~~ **x**");
    expect(xml).not.toContain("&lt;br");
  });

  // Changed 2026-11-09: HTML outside tables used to be left alone (and so left
  // out of Word); now a paragraph's <b> is bold in Word, as the page shows it.
  it("leaves out tags it can't pair up, and makes HTML in a paragraph formatting too", () => {
    const xml = toWord("| A |\n|---|\n| <b>open only |\n\nA <b>paragraph</b>.\n");
    expect(cells(xml)[1]).toBe("open only");
    expect(xml).toMatch(/<w:b \/>[\s\S]{0,80}paragraph/);
    expect(xml.match(/<w:b \/>/g)?.length).toBe(1);
  });
});
