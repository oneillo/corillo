// The licence check (scripts/check-licences.mjs): what Corillo ships may carry
// only the licences CONTRIBUTING.md allows without asking.
import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
// @ts-expect-error: a plain JavaScript script, with no types of its own
import { ok } from "../../scripts/check-licences.mjs";

describe("which licences the check allows", () => {
  it("one allowed licence, or a choice with an allowed option", () => {
    expect(ok("MIT")).toBe(true);
    expect(ok("MPL-2.0 OR Apache-2.0")).toBe(true);
    expect(ok("(MIT OR Apache-2.0)")).toBe(true);
    expect(ok("GPL-3.0")).toBe(false);
    expect(ok("NONE")).toBe(false);
  });

  it("terms joined by AND only when every one is allowed, whatever choice sits beside them", () => {
    expect(ok("MIT AND Zlib")).toBe(true);
    expect(ok("(MIT OR Apache-2.0) AND BSD-3-Clause")).toBe(true);
    expect(ok("MIT AND GPL-3.0")).toBe(false);
    expect(ok("(MIT OR GPL-3.0) AND LGPL-2.1")).toBe(false);
    expect(ok("LGPL-2.1 AND (MIT OR Apache-2.0)")).toBe(false);
  });
});

describe("his approval of Chromium's parts, where it is written", () => {
  const ROOT = join(import.meta.dirname, "..", "..");
  // Who approved it is a first name, as the files write it; this public file doesn't name him.
  const APPROVAL = /"Chromium as Electron ships it, with its notices" \([A-Z][a-z]+, 2026-11-17, widening his approval of 2026-11-08 of Chromium's LGPL and MPL parts\)/;

  it("says what he approved and when, in dependencies.md's Electron row and beside the check that lets Electron through", () => {
    const row = readFileSync(join(ROOT, "dependencies.md"), "utf8").split("\n").find((l) => l.startsWith("| electron |"));
    expect(row).toMatch(APPROVAL);
    // The public copy lets his name through on this line only as a licence approval.
    expect(row).toMatch(/approved/i);
    const check = readFileSync(join(ROOT, "scripts", "check-licences.mjs"), "utf8").replace(/\n\s*\/\/ ?/g, " ");
    expect(check).toMatch(APPROVAL);
  });
});
