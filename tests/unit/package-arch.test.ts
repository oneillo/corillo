// Packaging for the other kind of Mac (scripts/package-mac.mjs --arch=...):
// what it refuses before anything is copied. Nothing here fetches anything:
// a made-up Electron zip is planted where the script keeps the real one, and
// fetching is turned off in case a mistake would have it look elsewhere.
import { describe, expect, it } from "vitest";
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const ROOT = join(import.meta.dirname, "..", "..");
const SCRIPT = join(ROOT, "scripts", "package-mac.mjs");
const ELECTRON = JSON.parse(readFileSync(join(ROOT, "node_modules", "electron", "package.json"), "utf8")).version;
/** The kind of Mac this one isn't: packing for it needs Electron's own zip. */
const OTHER = process.arch === "arm64" ? "x64" : "arm64";

/** A folder to package in, with its own temp folder, and nothing else of Corillo's. */
function folder() {
  const dir = mkdtempSync(join(tmpdir(), "corillo-package-arch-"));
  writeFileSync(join(dir, "package.json"), JSON.stringify({ productName: "Corillo", version: "0.0.0" }));
  mkdirSync(join(dir, "temp"));
  return dir;
}

function packageIn(dir: string, args: string[]) {
  return spawnSync(process.execPath, [SCRIPT, ...args], {
    cwd: dir,
    env: { ...process.env, TMPDIR: join(dir, "temp"), CORILLO_NO_FETCH: "1" },
    encoding: "utf8",
    timeout: 30_000,
  });
}

describe("packaging for a kind of Mac", () => {
  it("refuses a kind of Mac it doesn't know, before copying anything", () => {
    const dir = folder();
    for (const args of [["--arch=ppc"], ["--arch=universal"], ["--arch", "x64"]]) {
      const result = packageIn(dir, [...args, "--without-pandoc"]);
      expect(result.status, args.join(" ")).not.toBe(0);
      expect(result.stderr).toContain("--arch=arm64 (Apple silicon) or --arch=x64 (Intel)");
    }
    expect(existsSync(join(dir, "release"))).toBe(false);
  });

  it("refuses Electron's zip for the other kind of Mac when its SHA-256 isn't the one Electron published, and removes it", () => {
    const dir = folder();
    const cache = join(dir, "temp", "electron-downloads");
    mkdirSync(cache);
    const zip = join(cache, `electron-v${ELECTRON}-darwin-${OTHER}.zip`);
    writeFileSync(zip, "not Electron");
    const result = packageIn(dir, [`--arch=${OTHER}`, "--without-pandoc"]);
    expect(result.status).not.toBe(0);
    expect(result.stderr).toContain(`electron-v${ELECTRON}-darwin-${OTHER}.zip doesn't match the SHA-256 Electron published for it`);
    expect(existsSync(zip)).toBe(false);
    expect(existsSync(join(dir, "release"))).toBe(false);
  });

  it("keeps only this Electron version's zips, removing older ones left from before an upgrade (review B15-06)", () => {
    const dir = folder();
    const cache = join(dir, "temp", "electron-downloads");
    mkdirSync(cache);
    const older = ["electron-v1.2.3-darwin-x64.zip", "electron-v1.2.3-darwin-arm64.zip", "electron-v1.2.3-darwin-x64.zip.part"];
    for (const f of older) writeFileSync(join(cache, f), "an older Electron");
    const other = join(cache, `electron-v${ELECTRON}-darwin-${process.arch}.zip`);
    writeFileSync(other, "this version, for this Mac");
    writeFileSync(join(cache, "notes.txt"), "not Electron's");
    writeFileSync(join(cache, `electron-v${ELECTRON}-darwin-${OTHER}.zip`), "not Electron");
    packageIn(dir, [`--arch=${OTHER}`, "--without-pandoc"]);
    for (const f of older) expect(existsSync(join(cache, f)), f).toBe(false);
    expect(existsSync(other)).toBe(true);
    expect(existsSync(join(cache, "notes.txt"))).toBe(true);
  });

  it("wants Pandoc for the kind of Mac it packs for", () => {
    const dir = folder();
    mkdirSync(join(dir, "vendor", "pandoc", process.arch), { recursive: true });
    writeFileSync(join(dir, "vendor", "pandoc", process.arch, "pandoc"), "");
    const result = packageIn(dir, [`--arch=${OTHER}`]);
    expect(result.status).not.toBe(0);
    expect(result.stderr).toContain(`No Pandoc at vendor/pandoc/${OTHER}/pandoc`);
  });

  it("does nothing when imported rather than run, whatever the arguments (C21-16)", () => {
    const dir = folder();
    const importer = join(dir, "importer.mjs");
    writeFileSync(importer, `await import(${JSON.stringify(SCRIPT)});\nconsole.log("imported");\n`);
    const result = spawnSync(process.execPath, [importer, "--arch", "x64"], {
      cwd: dir,
      env: { ...process.env, TMPDIR: join(dir, "temp"), CORILLO_NO_FETCH: "1" },
      encoding: "utf8",
      timeout: 30_000,
    });
    expect(result.stderr).toBe("");
    expect(result.stdout).toBe("imported\n");
    expect(result.status).toBe(0);
    expect(existsSync(join(dir, "release"))).toBe(false);
  });

  it("refuses a build stamp that isn't a commit", () => {
    const result = packageIn(folder(), ["--commit=main+changes", "--without-pandoc"]);
    expect(result.status).not.toBe(0);
    expect(result.stderr).toContain("Not a commit");
  });
});
