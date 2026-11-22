// The stranger tests look for whoever runs them in what Corillo shows
// (tests/e2e/runner-names.ts). A contributor whose name is an everyday word
// mustn't turn them red (review B13R-5).
import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { ownWords, runnerPatterns, type Runner } from "../e2e/runner-names";

const ROOT = join(import.meta.dirname, "..", "..");
const own = ownWords(ROOT);
/** Help's words, every page, without its markup. */
const help = readFileSync(join(ROOT, "src/renderer/help.html"), "utf8")
  .replace(/<(script|style)[\s\S]*?<\/\1>/g, " ")
  .replace(/<[^>]+>/g, " ");

const everyday: Runner = { username: "will", host: "Mays-Mac.local", computer: "June", gitName: "Will Page", email: "will.page@example.com", home: "/Users/will" };

describe("whoever runs the stranger tests", () => {
  it("named with everyday words (Will Page, on a Mac called June): nothing in Help counts as them", () => {
    for (const re of runnerPatterns(everyday, own)) expect(help, String(re)).not.toMatch(re);
    expect(runnerPatterns({ ...everyday, username: "ana", gitName: "Ana May" }, own).some((re) => re.test(help))).toBe(false);
  });

  it("is still found by their whole name, email, home folder and any name part Corillo doesn't use", () => {
    const found = (text: string, runner: Runner = everyday) => runnerPatterns(runner, own).some((re) => re.test(text));
    expect(found("Signed in as Will Page")).toBe(true);
    expect(found("Write to will.page@example.com")).toBe(true);
    expect(found("Saved in /Users/will/Documents")).toBe(true);
    const rare: Runner = { username: "qzxwen", host: "Qzxwens-Mac.local", computer: "Qzxwen's iMac", gitName: "Brannoc Qzxwen", email: "b@example.com", home: "/Users/qzxwen" };
    expect(found("Hello qzxwen", rare)).toBe(true);
    expect(found("Brannoc wrote this", rare)).toBe(true);
    expect(found("Qzxwen's iMac", rare)).toBe(true);
  });
});
