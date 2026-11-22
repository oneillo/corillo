// Pandoc in the app (scripts/pandoc-files.mjs, used by packaging and the
// fetch): only the files named ship, and the fetch clears what a stopped run
// left half-written (C21-14). Everything here is made up, in throwaway folders.
import { afterEach, describe, expect, it } from "vitest";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
// @ts-expect-error: a plain JavaScript script, with no types of its own
import { copyPandoc, LEFTOVER_AGE_MS, PANDOC_NOTICES, removeOldParts } from "../../scripts/pandoc-files.mjs";

const SCRIPTS = join(import.meta.dirname, "..", "..", "scripts");

let made: string[] = [];
afterEach(() => {
  for (const dir of made) rmSync(dir, { recursive: true, force: true });
  made = [];
});

/** A vendor/pandoc as the fetch leaves it, with whatever else `extra` names (path: text). */
function vendorWith(extra: Record<string, string> = {}): string {
  const dir = mkdtempSync(join(tmpdir(), "corillo-pandoc-files-"));
  made.push(dir);
  const files: Record<string, string> = { COPYING: "GPL\n", COPYRIGHT: "Pandoc's authors\n", VERSION: "3.13\n", "arm64/pandoc": "arm program", "x64/pandoc": "intel program", ...extra };
  for (const [file, text] of Object.entries(files)) {
    mkdirSync(join(dir, file, ".."), { recursive: true });
    writeFileSync(join(dir, file), text, { mode: file.endsWith("/pandoc") ? 0o755 : 0o644 });
  }
  return dir;
}

/** Every file under a folder, by its path inside it. */
const filesUnder = (dir: string): string[] => (readdirSync(dir, { recursive: true }) as string[]).filter((f) => statSync(join(dir, f)).isFile()).sort();

describe("what of Pandoc goes into the app", () => {
  it("only its licence, copyright notice, version and the program for this kind of Mac: not a half-fetched download, a note or a Finder file", () => {
    const source = vendorWith({
      "COPYING.1a2b.part": "half a licence",
      "arm64/pandoc.3c4d.part": "half a program",
      "arm64/notes.txt": "a note",
      "arm64/.DS_Store": "Finder's",
      ".DS_Store": "Finder's",
      "README.md": "what this folder is",
    });
    const target = join(mkdtempSync(join(tmpdir(), "corillo-pandoc-files-")), "pandoc");
    made.push(join(target, ".."));
    copyPandoc(source, target, "arm64");
    expect(filesUnder(target)).toEqual(["COPYING", "COPYRIGHT", "VERSION", "arm64/pandoc"]);
    expect(readFileSync(join(target, "arm64", "pandoc"), "utf8")).toBe("arm program");
    expect(statSync(join(target, "arm64", "pandoc")).mode & 0o111).not.toBe(0);
    expect(PANDOC_NOTICES).toEqual(["COPYING", "COPYRIGHT", "VERSION"]);
  });

  it("goes without a notice that isn't there, which packaging then warns about", () => {
    const source = vendorWith();
    rmSync(join(source, "COPYRIGHT"));
    const target = join(mkdtempSync(join(tmpdir(), "corillo-pandoc-files-")), "pandoc");
    made.push(join(target, ".."));
    copyPandoc(source, target, "x64");
    expect(filesUnder(target)).toEqual(["COPYING", "VERSION", "x64/pandoc"]);
  });

  it("is what packaging uses, and the fetch clears leftovers before it starts", () => {
    const packaging = readFileSync(join(SCRIPTS, "package-mac.mjs"), "utf8");
    const addPandoc = packaging.slice(packaging.indexOf("function addPandoc()"), packaging.indexOf("function sign()"));
    expect(addPandoc).toContain("copyPandoc(source, target, ARCH)");
    expect(addPandoc).not.toMatch(/readdirSync|cpSync/);
    const fetch = readFileSync(join(SCRIPTS, "fetch-pandoc.mjs"), "utf8");
    expect(fetch.indexOf("removeOldParts(vendor)")).toBeGreaterThan(0);
    expect(fetch.indexOf("removeOldParts(vendor)")).toBeLessThan(fetch.indexOf("await fetchNotices()"));
  });
});

describe("what a stopped fetch leaves behind", () => {
  it("removes old .part files, in the folder and each kind of Mac's, and nothing else", () => {
    const vendor = vendorWith({ "COPYING.1a2b.part": "half", "arm64/pandoc.3c4d.part": "half", "x64/pandoc.5e6f.part": "half", "arm64/keep.txt": "not the fetch's" });
    const old = (Date.now() - LEFTOVER_AGE_MS - 60_000) / 1000;
    for (const f of ["COPYING.1a2b.part", "arm64/pandoc.3c4d.part", "x64/pandoc.5e6f.part", "arm64/keep.txt"]) utimesSync(join(vendor, f), old, old);
    const removed = removeOldParts(vendor);
    expect(removed.map((f: string) => f.slice(vendor.length + 1)).sort()).toEqual(["COPYING.1a2b.part", "arm64/pandoc.3c4d.part", "x64/pandoc.5e6f.part"]);
    expect(filesUnder(vendor)).toEqual(["COPYING", "COPYRIGHT", "VERSION", "arm64/keep.txt", "arm64/pandoc", "x64/pandoc"]);
  });

  it("leaves a .part file another fetch is writing now", () => {
    const vendor = vendorWith({ "arm64/pandoc.7a8b.part": "being written" });
    expect(removeOldParts(vendor)).toEqual([]);
    expect(existsSync(join(vendor, "arm64", "pandoc.7a8b.part"))).toBe(true);
  });

  it("does nothing when there is no vendor folder yet", () => {
    expect(removeOldParts(join(tmpdir(), "corillo-no-such-vendor"))).toEqual([]);
  });
});
