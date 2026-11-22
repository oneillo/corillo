// The hidden file a save writes before it takes the document's place (the
// review of Batch 21, R21-2; roadmap Batch 22, item 2). Its name was always
// the same (".plan.md.corillo-saving"), so a program in the folder could put a
// link there in the moment between Corillo's look and the copy that carries
// the file's attributes over (`cp -p`), and the copy wrote the document's text
// through it, into whatever the link pointed at. Now the name has a random
// part no other program can know beforehand; leftovers of cut-off saves are
// cleared by their pattern; and something in the way is named in plain words.
// Everything here happens in throwaway folders.
import { afterEach, describe, expect, it } from "vitest";
import * as fs from "node:fs";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";
import { FileProblem, nothingAt, problemText, removeLeftover, savingPathFor, writeDocument, writeSeams } from "../../src/main/files";

const folders: string[] = [];
afterEach(() => {
  writeSeams.beforeCopy = null;
  writeSeams.afterCopy = null;
  writeSeams.afterTemp = null;
  for (const dir of folders.splice(0)) fs.rmSync(dir, { recursive: true, force: true });
});

function folder(): string {
  const dir = fs.realpathSync(fs.mkdtempSync(join(tmpdir(), "corillo-temp-name-")));
  folders.push(dir);
  return dir;
}

function file(dir: string, name: string, text: string): string {
  const p = join(dir, name);
  fs.writeFileSync(p, text);
  return p;
}

/** The temporary file's name in each save, as the save made it. */
function tempNames(): string[] {
  const names: string[] = [];
  writeSeams.afterTemp = (temp) => void names.push(basename(temp));
  return names;
}

const RANDOM = /^\.plan\.md\.corillo-saving-[0-9a-f]{16}$/;

describe("the hidden file a save writes first", () => {
  it("has a name with a random part, different at each save", () => {
    const dir = folder();
    const doc = file(dir, "plan.md", "Old text.\n");
    const names = tempNames();
    writeDocument(doc, "One.\n");
    writeDocument(doc, "Two.\n");
    writeDocument(doc, "Three.\n");
    expect(names).toHaveLength(3);
    for (const name of names) expect(name).toMatch(RANDOM);
    expect(new Set(names).size).toBe(3);
    expect(fs.readdirSync(dir)).toEqual(["plan.md"]);
  });

  it("is never written through a link another program plants, at any name it could know, while the save is under way", () => {
    const dir = folder();
    const doc = file(dir, "plan.md", "Old text.\n");
    const budget = file(dir, "budget.txt", "The budget.\n");
    const names = tempNames();
    writeDocument(doc, "First.\n"); // a name the planter saw in the folder before
    let planted = 0;
    writeSeams.beforeCopy = () => {
      // The moment between Corillo's look and the copy: links at the old fixed name and at the name the last save used.
      for (const name of new Set([".plan.md.corillo-saving", names[0]])) {
        fs.symlinkSync(budget, join(dir, name));
        planted++;
      }
    };
    try {
      writeDocument(doc, "The offer is 41,500 dollars.\n");
    } catch {
      // judged below, by what the files hold
    }
    expect(planted).toBeGreaterThan(0);
    expect(fs.readFileSync(budget, "utf8")).toBe("The budget.\n");
    expect(fs.lstatSync(doc).isSymbolicLink()).toBe(false);
    expect(fs.readFileSync(doc, "utf8")).toBe("The offer is 41,500 dollars.\n");
  });

  it("is never written through a hard link put in its place after the copy (R22-7)", () => {
    const dir = folder();
    const doc = file(dir, "plan.md", "Old text.\n");
    const budget = file(dir, "budget.txt", "The budget.\n");
    let swapped = 0;
    writeSeams.afterCopy = (temp) => {
      // Another program that saw the copy appear puts a second name for budget.txt in its place.
      fs.rmSync(temp, { force: true });
      fs.linkSync(budget, temp);
      swapped++;
    };
    expect(() => writeDocument(doc, "The offer is 41,500 dollars.\n")).toThrow(FileProblem);
    // Named for him, not by the random name (R22-13).
    expect(() => writeDocument(doc, "The offer is 41,500 dollars.\n")).toThrow("something else changed Corillo's hidden copy of plan.md while Corillo was saving");
    expect(swapped).toBe(2);
    expect(fs.readFileSync(budget, "utf8")).toBe("The budget.\n");
    expect(fs.readFileSync(doc, "utf8")).toBe("Old text.\n");
    expect(fs.statSync(budget).nlink).toBe(1); // the second name is gone too
  });

  it("with something in the way under its very name, the save stops and says so in plain words; nothing is written through", () => {
    const dir = folder();
    const doc = file(dir, "plan.md", "Old text.\n");
    const budget = file(dir, "budget.txt", "The budget.\n");
    const temp = savingPathFor(doc);
    expect(basename(temp)).toMatch(RANDOM);
    fs.symlinkSync(budget, temp); // as if another program had guessed it
    let thrown: unknown;
    try {
      nothingAt(temp); // the look writeDocument makes before the copy
    } catch (err) {
      thrown = err;
    }
    expect(thrown).toBeInstanceOf(FileProblem);
    expect(problemText(thrown)).toBe("something is in the way of Corillo's hidden copy of plan.md");
    expect(fs.readFileSync(budget, "utf8")).toBe("The budget.\n");
    // A folder there is said the same way.
    fs.unlinkSync(temp);
    fs.mkdirSync(temp);
    expect(() => nothingAt(temp)).toThrow("something is in the way of Corillo's hidden copy of plan.md");
    expect(fs.readFileSync(doc, "utf8")).toBe("Old text.\n");
  });
});

describe("leftovers of a save that was cut off", () => {
  it("are cleared by their pattern, the old fixed name included; only files, and only this document's", () => {
    const dir = folder();
    const doc = file(dir, "plan.md", "The real text.\n");
    const other = file(dir, "budget.txt", "The budget.\n");
    file(dir, ".plan.md.corillo-saving", "half a fi"); // an older Corillo's
    file(dir, ".plan.md.corillo-saving-0123456789abcdef", "half a fi");
    file(dir, ".plan.md.corillo-saving-fedcba9876543210", "half a fi");
    const kept = [
      ".notes.md.corillo-saving-0123456789abcdef", // another document's
      ".plan.md.corillo-saving-notes", // not the pattern
      "plan.md.corillo-saving-0123456789abcdef",
    ];
    for (const name of kept) file(dir, name, "not a leftover");
    fs.mkdirSync(join(dir, ".plan.md.corillo-saving-1111111111111111")); // a folder: never removed
    fs.symlinkSync(other, join(dir, ".plan.md.corillo-saving-2222222222222222")); // a link: never removed, never followed
    removeLeftover(doc);
    expect(fs.readdirSync(dir).sort()).toEqual(
      [...kept, "budget.txt", "plan.md", ".plan.md.corillo-saving-1111111111111111", ".plan.md.corillo-saving-2222222222222222"].sort(),
    );
    expect(fs.readFileSync(other, "utf8")).toBe("The budget.\n");
    expect(fs.readFileSync(doc, "utf8")).toBe("The real text.\n");
  });

  it("don't stop a save; a save clears only an older Corillo's, without going through the folder (R22-6)", () => {
    const dir = folder();
    const doc = file(dir, "plan.md", "Old text.\n");
    file(dir, ".plan.md.corillo-saving", "half a fi");
    file(dir, ".plan.md.corillo-saving-0123456789abcdef", "half a fi");
    fs.mkdirSync(join(dir, ".plan.md.corillo-saving-1111111111111111"));
    // A folder of thousands of notes isn't listed at every typing pause: the name an older Corillo used is looked at alone.
    writeDocument(doc, "New text.\n");
    // Ones with the random part are cleared when the document is opened (removeLeftover), or after a save that failed.
    expect(fs.readdirSync(dir).sort()).toEqual([".plan.md.corillo-saving-0123456789abcdef", ".plan.md.corillo-saving-1111111111111111", "plan.md"]);
    expect(fs.readFileSync(doc, "utf8")).toBe("New text.\n");
  });

  it("are cleared by their pattern after a save that failed (R22-6)", () => {
    const dir = folder();
    const doc = file(dir, "plan.md", "Old text.\n");
    file(dir, ".plan.md.corillo-saving-0123456789abcdef", "half a fi");
    writeSeams.afterTemp = () => {
      throw new FileProblem("the disk went away");
    };
    expect(() => writeDocument(doc, "New text.\n")).toThrow("the disk went away");
    expect(fs.readdirSync(dir)).toEqual(["plan.md"]);
    expect(fs.readFileSync(doc, "utf8")).toBe("Old text.\n");
  });
});

describe("the hidden file, swapped for a link after Corillo made it", () => {
  // A program watching the folder sees the random name once the file is there. Swapped for a link (to a file
  // holding the same words, so the read-back can't tell), it never takes the document's place, and nothing is
  // changed through it.
  it("never takes the document's place, and no permission is changed through it", () => {
    const dir = folder();
    const doc = file(dir, "plan.md", "Old text.\n");
    fs.chmodSync(doc, 0o600);
    const decoy = file(dir, "budget.txt", "New text.\n");
    fs.chmodSync(decoy, 0o644);
    writeSeams.afterTemp = (temp) => {
      fs.unlinkSync(temp);
      fs.symlinkSync(decoy, temp);
    };
    expect(() => writeDocument(doc, "New text.\n")).toThrow(FileProblem);
    expect(fs.lstatSync(doc).isSymbolicLink()).toBe(false);
    expect(fs.readFileSync(doc, "utf8")).toBe("Old text.\n");
    expect(fs.statSync(decoy).mode & 0o777).toBe(0o644);
    expect(fs.readdirSync(dir).sort()).toEqual(["budget.txt", "plan.md"]);
  });
});
