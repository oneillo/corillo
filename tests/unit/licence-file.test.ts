// The licence check (scripts/check-licences.mjs) and About's notices
// (scripts/notices.mjs) find a package's licence file the same way, from one
// shared module, so the check never reads a file About doesn't show, or the
// other way round (roadmap Batch 20, item 2; R16-7).
import { afterEach, describe, expect, it } from "vitest";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
// @ts-expect-error: a plain JavaScript script, with no types of its own
import { LICENCE_FILE, licenceFileIn, NOTICE_FILE, noticeFileIn, packageDirOf } from "../../scripts/licence-file.mjs";

const SCRIPTS = join(import.meta.dirname, "..", "..", "scripts");

let made: string[] = [];
afterEach(() => {
  for (const dir of made) rmSync(dir, { recursive: true, force: true });
  made = [];
});

function packageWith(...files: string[]): string {
  const dir = mkdtempSync(join(tmpdir(), "corillo-licence-"));
  made.push(dir);
  for (const f of files) writeFileSync(join(dir, f), "text\n");
  return dir;
}

describe("a package's NOTICE file (C21-22)", () => {
  it("is NOTICE, in any case, maybe .md or .txt; none when a package has none", () => {
    for (const name of ["NOTICE", "notice", "Notice.md", "NOTICE.txt"]) expect(NOTICE_FILE.test(name), name).toBe(true);
    for (const name of ["NOTICES.js", "notice.js", "LICENSE", "my-NOTICE"]) expect(NOTICE_FILE.test(name), name).toBe(false);
    expect(noticeFileIn(packageWith("LICENSE", "NOTICE", "README.md"))).toBe("NOTICE");
    expect(noticeFileIn(packageWith("LICENSE", "README.md"))).toBeNull();
  });
});

describe("a package's licence file", () => {
  it("is LICENSE, LICENCE or COPYING, in any case, with -MIT and .md, .txt or .markdown allowed", () => {
    for (const name of ["LICENSE", "license", "Licence", "COPYING", "LICENSE.md", "LICENSE.txt", "license.markdown", "LICENSE-MIT", "LICENSE-MIT.txt"]) {
      expect(LICENCE_FILE.test(name), name).toBe(true);
    }
    for (const name of ["LICENSE-APACHE", "LICENSE.html", "README.md", "license.js", "LICENSES", "my-LICENSE"]) {
      expect(LICENCE_FILE.test(name), name).toBe(false);
    }
  });

  it("is the first by name when a package has several, and none when it has none", () => {
    expect(licenceFileIn(packageWith("README.md", "LICENSE-MIT", "LICENSE"))).toBe("LICENSE");
    expect(licenceFileIn(packageWith("license.markdown", "COPYING"))).toBe("COPYING");
    expect(licenceFileIn(packageWith("README.md", "index.js"))).toBeNull();
  });

  it("belongs to the package a bundled file is in, scoped or not; Corillo's own files have none", () => {
    expect(packageDirOf("node_modules/markdown-it/lib/index.mjs")).toBe("node_modules/markdown-it");
    expect(packageDirOf("node_modules/@scope/name/dist/x.js")).toBe("node_modules/@scope/name");
    expect(packageDirOf("node_modules/a/node_modules/b/x.js")).toBe("node_modules/a/node_modules/b");
    expect(packageDirOf("src/core/doc-diff.ts")).toBeNull();
    expect(packageDirOf("package.json")).toBeNull();
  });

  it("is found by the licence check and About's notices through that one module, neither with a pattern of its own", () => {
    for (const script of ["check-licences.mjs", "notices.mjs"]) {
      const code = readFileSync(join(SCRIPTS, script), "utf8");
      expect(code, script).toMatch(/from "\.\/licence-file\.mjs"/);
      expect(code, script).not.toMatch(/licen\[cs\]e/);
      expect(code, script).not.toMatch(/function packageDirOf/);
    }
  });

  it("is what About's notices print for a package", async () => {
    // @ts-expect-error: a plain JavaScript script, with no types of its own
    const { writeNotices } = await import("../../scripts/notices.mjs");
    const root = mkdtempSync(join(tmpdir(), "corillo-notices-"));
    made.push(root);
    const dir = join(root, "node_modules", "made-up");
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, "package.json"), JSON.stringify({ name: "made-up", version: "1.0.0", license: "MIT" }));
    writeFileSync(join(dir, "LICENSE.md"), "Another copy.\n");
    writeFileSync(join(dir, "LICENSE-MIT"), "The first by name.\n");
    const out = join(root, "notices.txt");
    // As the build calls it, from the checkout (it reads Electron's package and the font's licence from there).
    writeNotices([join(dir, "index.js")], out);
    const text = readFileSync(out, "utf8");
    expect(text).toContain("made-up 1.0.0\nLicence: MIT\n\nThe first by name.\n");
  });

  it("prints a package's NOTICE file after its licence, as Apache-2.0 and Lodash's notice ask (C21-22)", async () => {
    // @ts-expect-error: a plain JavaScript script, with no types of its own
    const { writeNotices } = await import("../../scripts/notices.mjs");
    const root = mkdtempSync(join(tmpdir(), "corillo-notices-"));
    made.push(root);
    const withNotice = join(root, "node_modules", "made-up");
    const without = join(root, "node_modules", "plain");
    for (const [dir, name] of [[withNotice, "made-up"], [without, "plain"]]) {
      mkdirSync(dir, { recursive: true });
      writeFileSync(join(dir, "package.json"), JSON.stringify({ name, version: "1.0.0", license: "MIT" }));
      writeFileSync(join(dir, "LICENSE"), `${name}'s licence.\n`);
    }
    writeFileSync(join(withNotice, "NOTICE"), "Parts are derived from another project.\n\nIts copyright notice.\n");
    const out = join(root, "notices.txt");
    writeNotices([join(withNotice, "index.js"), join(without, "index.js")], out);
    const text = readFileSync(out, "utf8");
    expect(text).toContain("made-up 1.0.0\nLicence: MIT\n\nmade-up's licence.\n\nIts NOTICE file:\n\nParts are derived from another project.\n\nIts copyright notice.\n");
    const plain = text.slice(text.indexOf("plain 1.0.0\n"));
    expect(plain.slice(0, plain.indexOf("=".repeat(72)))).not.toContain("NOTICE");
  });
});
