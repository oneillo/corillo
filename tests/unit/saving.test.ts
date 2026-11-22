// Saving documents to disk, and keeping edits that couldn't be saved.
// Everything here happens in throwaway folders.
import { afterEach, describe, expect, it } from "vitest";
import * as fs from "node:fs";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";
import { execFileSync } from "node:child_process";
import {
  FileProblem, MAX_DOCUMENT_BYTES, problemText, readDisk, readText, realTarget, removeLeftover, sameFile, savingPathFor,
  writeDocument,
} from "../../src/main/files";
import { RecoveryStore } from "../../src/main/recovery";
import { countFlushes } from "./flushes";

const mac = process.platform === "darwin";
const folders: string[] = [];

function folder(): string {
  const dir = fs.realpathSync(fs.mkdtempSync(join(tmpdir(), "corillo-saving-")));
  folders.push(dir);
  return dir;
}

function file(dir: string, name: string, text: string): string {
  const p = join(dir, name);
  fs.writeFileSync(p, text);
  return p;
}

/** What went wrong, as the person would read it. */
function failure(fn: () => void): string {
  try {
    fn();
  } catch (err) {
    return problemText(err);
  }
  throw new Error("expected it to fail");
}

afterEach(() => {
  for (const dir of folders.splice(0)) {
    if (mac) execFileSync("/usr/bin/chflags", ["-R", "nouchg", dir]);
    execFileSync("/bin/chmod", ["-R", "u+rwx", dir]);
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

describe("saving a document", () => {
  it("writes the new text and leaves nothing else in the folder", () => {
    const dir = folder();
    const doc = file(dir, "notes.md", "old\n");
    writeDocument(doc, "new\r\n");
    expect(fs.readFileSync(doc, "utf8")).toBe("new\r\n");
    expect(fs.readdirSync(dir)).toEqual(["notes.md"]);
  });

  it("keeps the file's permissions", () => {
    const doc = file(folder(), "private.md", "old\n");
    fs.chmodSync(doc, 0o640);
    writeDocument(doc, "new\n");
    expect(fs.statSync(doc).mode & 0o777).toBe(0o640);
  });

  it.runIf(mac)("keeps Finder tags and other extended attributes", () => {
    const doc = file(folder(), "tagged.md", "old\n");
    execFileSync("/usr/bin/xattr", ["-w", "com.example.corillo-test", "kept", doc]);
    writeDocument(doc, "new\n");
    expect(execFileSync("/usr/bin/xattr", ["-p", "com.example.corillo-test", doc], { encoding: "utf8" }).trim()).toBe("kept");
    expect(fs.readFileSync(doc, "utf8")).toBe("new\n");
  });

  it.runIf(mac)("keeps the file's Date Created (Finder, Spotlight and Obsidian sort by it) across saves", () => {
    const doc = file(folder(), "plan.md", "one\n");
    const created = new Date("2025-01-02T03:04:05Z");
    fs.utimesSync(doc, created, created); // on a Mac's disk, an earlier date also moves Date Created back
    const edited = new Date("2026-11-08T10:00:00Z");
    fs.utimesSync(doc, edited, edited);
    execFileSync("/usr/bin/xattr", ["-w", "com.example.corillo-test", "kept", doc]);
    expect(fs.statSync(doc).birthtime.toISOString()).toBe(created.toISOString());
    writeDocument(doc, "two\n");
    writeDocument(doc, "three\n");
    const after = fs.statSync(doc);
    expect(after.birthtime.toISOString()).toBe(created.toISOString());
    expect(after.mtimeMs).toBeGreaterThan(edited.getTime());
    expect(fs.readFileSync(doc, "utf8")).toBe("three\n");
    expect(execFileSync("/usr/bin/xattr", ["-p", "com.example.corillo-test", doc], { encoding: "utf8" }).trim()).toBe("kept");
  });

  // Writing no bytes doesn't move a file's modified date: the date it was given has to be put right (R-MAIN-5).
  it.runIf(mac)("emptying a document keeps its Date Created and makes it modified now", () => {
    const doc = file(folder(), "plan.md", "one\n");
    const created = new Date("2020-01-02T03:04:05Z");
    fs.utimesSync(doc, created, created);
    const before = Date.now();
    writeDocument(doc, "");
    const after = fs.statSync(doc);
    expect(after.birthtime.toISOString()).toBe(created.toISOString());
    expect(after.mtimeMs).toBeGreaterThanOrEqual(before - 1000);
    expect(fs.readFileSync(doc, "utf8")).toBe("");
  });

  it("refuses to change a read-only file, and says why in plain words", () => {
    const dir = folder();
    const doc = file(dir, "final.md", "signed off\n");
    fs.chmodSync(doc, 0o444);
    const why = failure(() => writeDocument(doc, "changed\n"));
    expect(why).toBe("the file is read-only or locked");
    expect(fs.readFileSync(doc, "utf8")).toBe("signed off\n");
    expect(fs.readdirSync(dir)).toEqual(["final.md"]);
  });

  it.runIf(mac)("refuses to change a file locked in Finder, and says why in plain words", () => {
    const dir = folder();
    const doc = file(dir, "locked.md", "keep me\n");
    execFileSync("/usr/bin/chflags", ["uchg", doc]);
    const why = failure(() => writeDocument(doc, "changed\n"));
    expect(why).toMatch(/read-only or locked|isn't allowed/);
    expect(fs.readFileSync(doc, "utf8")).toBe("keep me\n");
    expect(fs.readdirSync(dir)).toEqual(["locked.md"]);
  });

  it("in a folder Corillo can't write to, leaves the file as it was with no temporary file", () => {
    const dir = folder();
    const doc = file(dir, "shared.md", "theirs\n");
    fs.chmodSync(dir, 0o555);
    const why = failure(() => writeDocument(doc, "mine\n"));
    expect(why).toBe("Corillo isn't allowed to change this file or its folder");
    expect(fs.readFileSync(doc, "utf8")).toBe("theirs\n");
    expect(fs.readdirSync(dir)).toEqual(["shared.md"]);
  });

  it("a save that fails at the last step leaves no temporary file behind", () => {
    const dir = folder();
    const inTheWay = join(dir, "report.md");
    fs.mkdirSync(inTheWay); // a folder where the document should be
    const why = failure(() => writeDocument(inTheWay, "text\n"));
    expect(why).toBe("there's a folder with the document's name");
    expect(fs.readdirSync(dir)).toEqual(["report.md"]);
    expect(fs.statSync(inTheWay).isDirectory()).toBe(true);
  });

  it("writes through a symlink to the real file, and the symlink stays", () => {
    const real = folder();
    const elsewhere = folder();
    const target = file(real, "real.md", "old\n");
    const link = join(elsewhere, "link.md");
    fs.symlinkSync(target, link);
    writeDocument(link, "new\n");
    expect(fs.readFileSync(target, "utf8")).toBe("new\n");
    expect(fs.lstatSync(link).isSymbolicLink()).toBe(true);
    expect(fs.readdirSync(real)).toEqual(["real.md"]);
    expect(fs.readdirSync(elsewhere)).toEqual(["link.md"]);
    expect(realTarget(link)).toBe(target);
  });

  it("a symlink whose file was deleted saves to where it points", () => {
    const dir = folder();
    const target = join(dir, "gone.md");
    const link = join(dir, "link.md");
    fs.symlinkSync(target, link);
    expect(realTarget(link)).toBe(target);
    writeDocument(link, "back\n");
    expect(fs.readFileSync(target, "utf8")).toBe("back\n");
    expect(fs.lstatSync(link).isSymbolicLink()).toBe(true);
  });

  it("creates the file when asked to save it where it was after it was deleted", () => {
    const dir = folder();
    const doc = join(dir, "deleted.md");
    writeDocument(doc, "saved again\n");
    expect(fs.readFileSync(doc, "utf8")).toBe("saved again\n");
    expect(fs.readdirSync(dir)).toEqual(["deleted.md"]);
  });

  it("clears away a temporary file left by a save that was cut off", () => {
    const dir = folder();
    const doc = file(dir, "notes.md", "the real text\n");
    fs.writeFileSync(savingPathFor(doc), "half a fi");
    removeLeftover(doc);
    expect(fs.readdirSync(dir)).toEqual(["notes.md"]);
    expect(fs.readFileSync(doc, "utf8")).toBe("the real text\n");
  });

  it("doesn't remove a folder that happens to have the temporary file's name", () => {
    const dir = folder();
    const doc = file(dir, "notes.md", "text\n");
    const temp = savingPathFor(doc);
    fs.mkdirSync(temp);
    removeLeftover(doc);
    expect(fs.readdirSync(dir).sort()).toEqual([basename(temp), "notes.md"]);
  });

  // Since roadmap Batch 22 (R21-2) the temporary name has a random part, new at each save: a link waiting under a
  // name of that form is never the one a save uses, so the save goes through, and still never writes through it.
  it("never writes through a link waiting under the save's temporary name (Batch 21, E21-T1)", () => {
    const dir = folder();
    const doc = file(dir, "plan.md", "Old text.\n");
    const other = file(dir, "budget.txt", "The budget.\n");
    const waiting = savingPathFor(doc);
    fs.symlinkSync(other, waiting);
    writeDocument(doc, "New text.\n");
    expect(fs.readFileSync(other, "utf8")).toBe("The budget.\n");
    expect(fs.lstatSync(doc).isSymbolicLink()).toBe(false);
    expect(fs.readFileSync(doc, "utf8")).toBe("New text.\n");
    // A link that points nowhere isn't followed either: nothing is made where it points.
    fs.unlinkSync(waiting);
    fs.symlinkSync(join(dir, "made.txt"), waiting);
    writeDocument(doc, "Newer text.\n");
    expect(fs.existsSync(join(dir, "made.txt"))).toBe(false);
    expect(fs.readFileSync(doc, "utf8")).toBe("Newer text.\n");
  });
});

describe("what went wrong, in plain words", () => {
  const err = (code: string) => Object.assign(new Error(code), { code });

  it("names a full disk, a refused permission and a missing folder", () => {
    expect(problemText(err("ENOSPC"))).toBe("the disk is full");
    expect(problemText(err("EDQUOT"))).toBe("the disk is full");
    expect(problemText(err("EACCES"))).toBe("Corillo isn't allowed to change this file or its folder");
    expect(problemText(err("EROFS"))).toBe("the disk can only be read, not changed");
    expect(problemText(err("ENOENT"))).toBe("the folder it was in is gone");
    expect(problemText(err("ETIMEDOUT"))).toBe("the disk didn't respond");
  });

  it("anything else still gets a sentence, not a code", () => {
    expect(problemText(err("EWHATEVER"))).toBe("something went wrong writing the file");
    expect(problemText(new FileProblem("the file is read-only or locked"))).toBe("the file is read-only or locked");
  });
});

describe("opening a document", () => {
  it("an empty file opens as an empty document", () => {
    expect(readText(file(folder(), "empty.md", ""))).toBe("");
  });

  it("keeps a byte-order mark and Windows line endings as they are", () => {
    expect(readText(file(folder(), "bom.md", "﻿# Title\r\n"))).toBe("﻿# Title\r\n");
  });

  it("a file that isn't UTF-8 text is refused with a plain message", () => {
    const doc = join(folder(), "latin1.md");
    fs.writeFileSync(doc, Buffer.from([0x63, 0x61, 0x66, 0xe9, 0x0a])); // "café" in an old encoding
    expect(() => readText(doc)).toThrow("Corillo can only open text files saved as UTF-8.");
  });

  it("a file over 25 MB, more than the window can work with, is refused with a plain message", () => {
    expect(MAX_DOCUMENT_BYTES).toBe(25 * 1024 * 1024);
    const doc = join(folder(), "huge.md");
    const fd = fs.openSync(doc, "w");
    fs.ftruncateSync(fd, MAX_DOCUMENT_BYTES + 1); // takes no real space
    fs.closeSync(fd);
    expect(() => readText(doc)).toThrow("The file is over 25 MB, too big for Corillo to open.");
  });

  it("tells a file that's gone from one Corillo can't read", () => {
    const dir = folder();
    expect(readDisk(join(dir, "nothing.md"))).toEqual({ kind: "missing" });
    const binary = join(dir, "binary.md");
    fs.writeFileSync(binary, Buffer.from([0xff, 0xfe, 0x00]));
    expect(readDisk(binary)).toEqual({ kind: "unreadable", problem: "the file was changed into something Corillo can't read" });
    expect(readDisk(file(dir, "ok.md", "fine\n"))).toEqual({ kind: "text", text: "fine\n" });
  });

  // Review of Batch 11, B11R-1: a document that mentions "%PDF-" near its top was taken for a PDF, so every
  // save after the first was refused and it wouldn't open again. Only a file that starts with it is a PDF,
  // and only when it's opened: the look at the disk before a save asks only whether it's text.
  it("a document that mentions %PDF- near its top is a document; only a file that starts with it is a PDF, and only when opening", () => {
    const dir = folder();
    const text = "# Notes\n\nA PDF file starts with %PDF-1.7 on its first line.\n";
    const note = file(dir, "note.md", text);
    expect(readText(note)).toBe(text);
    expect(readDisk(note)).toEqual({ kind: "text", text });
    const pdf = file(dir, "scan.pdf", "﻿\n  %PDF-1.4\n1 0 obj << >> endobj\n%%EOF\n");
    expect(() => readText(pdf)).toThrow("Corillo opens Markdown and Word documents, and this is a PDF.");
    expect(readDisk(pdf).kind).toBe("text");
  });
});

describe("the same document reached two ways", () => {
  it("through a symlink, a hard link or another letter case counts as one file", () => {
    const dir = folder();
    const doc = file(dir, "Plan.md", "x\n");
    const link = join(dir, "shortcut.md");
    fs.symlinkSync(doc, link);
    const hard = join(dir, "hard.md");
    fs.linkSync(doc, hard);
    expect(sameFile(doc, link)).toBe(true);
    expect(sameFile(doc, hard)).toBe(true);
    const otherCase = join(dir, "plan.MD");
    // Mac disks usually ignore letter case; then it's the same file.
    expect(sameFile(doc, otherCase)).toBe(fs.existsSync(otherCase));
  });

  it("two different files are not the same", () => {
    const dir = folder();
    expect(sameFile(file(dir, "a.md", "same\n"), file(dir, "b.md", "same\n"))).toBe(false);
    expect(sameFile(join(dir, "a.md"), join(dir, "missing.md"))).toBe(false);
  });
});

describe("keeping edits that couldn't be saved", () => {
  it("edits kept in the data folder are there after a restart, oldest first", () => {
    const data = folder();
    const before = new RecoveryStore(data);
    expect(before.keep("one", { filePath: "/docs/a.md", base: "a\n", text: "a edited\n" })).toBe(true);
    const later = new Date(Date.now() + 5000);
    expect(before.keep("two", { filePath: "/docs/b.md", base: "b\n", text: "b edited\n" })).toBe(true);
    fs.utimesSync(join(data, "recovery", "two.json"), later, later);
    const after = new RecoveryStore(data);
    expect(after.all()).toEqual([
      { id: "one", entry: { filePath: "/docs/a.md", base: "a\n", text: "a edited\n" } },
      { id: "two", entry: { filePath: "/docs/b.md", base: "b\n", text: "b edited\n" } },
    ]);
  });

  it("keeping again replaces the earlier copy, and clearing removes it", () => {
    const data = folder();
    const store = new RecoveryStore(data);
    store.keep("one", { filePath: "/docs/a.md", base: "a\n", text: "first\n" });
    store.keep("one", { filePath: "/docs/a.md", base: "a\n", text: "second\n" });
    expect(store.all().map((r) => r.entry.text)).toEqual(["second\n"]);
    store.clear("one");
    expect(store.all()).toEqual([]);
    expect(fs.readdirSync(join(data, "recovery"))).toEqual([]);
  });

  it("a damaged copy is skipped instead of stopping Corillo from starting", () => {
    const data = folder();
    const store = new RecoveryStore(data);
    store.keep("good", { filePath: "/docs/a.md", base: "", text: "kept\n" });
    fs.writeFileSync(join(data, "recovery", "bad.json"), "{ not finished");
    expect(store.all().map((r) => r.id)).toEqual(["good"]);
  });

  it("kept edits are on the disk before they take the earlier copy's place, since they're kept for a crash", () => {
    const data = folder();
    const store = new RecoveryStore(data);
    const flushes = countFlushes(join(data, "recovery", "one.json"));
    try {
      expect(store.keep("one", { filePath: "/docs/a.md", base: "a\n", text: "a edited\n" })).toBe(true);
    } finally {
      flushes.stop();
    }
    expect(flushes.count).toBe(1);
    expect(fs.readdirSync(join(data, "recovery"))).toEqual(["one.json"]);
  });

  it("says so, without failing, when the data folder can't be written", () => {
    const data = folder();
    fs.chmodSync(data, 0o555);
    const store = new RecoveryStore(data);
    expect(store.keep("one", { filePath: "/docs/a.md", base: "", text: "x" })).toBe(false);
    expect(store.all()).toEqual([]);
  });
});
