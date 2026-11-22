// Random texts and random edits, with fixed seeds so a failure always comes
// back the same: every way of comparing two texts must give back both texts
// exactly, however odd the text (emoji, Windows line ends, wholly different
// versions, long documents past the word-by-word limit).
import { describe, expect, it } from "vitest";
import { applyDelta, diffText, diffWords, makeDelta } from "../../src/core/diff";
import { diffLines } from "../../src/core/text-changes";
import { OffsetMap, changedPieces } from "../../src/core/change-links";

function random(seed: number) {
  let s = seed;
  const rnd = () => (s = (s * 1103515245 + 12345) & 0x7fffffff) / 0x7fffffff;
  const pick = <T>(a: readonly T[]) => a[Math.floor(rnd() * a.length)];
  return { rnd, pick };
}

const WORDS = ["the", "quick", "brown", "fox", "über", "naïve", "café", "😀", "👨‍👩‍👧", "it's", "don’t", "a", "1,234", "x", "and", "\t", "**bold**", "| cell |", "---", "\r\n", "\n", "\n\n", " ", "  ", ".", ",", "línea", "日本語", "é"];

function texts(seed: number) {
  const { rnd, pick } = random(seed);
  const text = (n: number) => {
    let s = "";
    for (let i = 0; i < n; i++) s += pick(WORDS) + (rnd() < 0.7 ? " " : "");
    return s;
  };
  const mutate = (s: string) => {
    let out = s;
    const k = 1 + Math.floor(rnd() * 6);
    for (let i = 0; i < k; i++) {
      const at = Math.floor(rnd() * (out.length + 1));
      const del = Math.floor(rnd() * 20);
      out = out.slice(0, at) + (rnd() < 0.7 ? text(Math.floor(rnd() * 8)) : "") + out.slice(at + del);
    }
    return out;
  };
  return { rnd, text, mutate };
}

/** Lines of a document with many paragraphs, some changed: long enough to pass the word-by-word limit. */
function longPair(seed: number): [string, string] {
  const { rnd, text, mutate } = texts(seed);
  const paras = Array.from({ length: 120 + Math.floor(rnd() * 200) }, () => text(20 + Math.floor(rnd() * 30)).replace(/\n/g, " "));
  // Sometimes every paragraph changed: one long run of changed lines, too many changes to compare word by word at once.
  const share = rnd() < 0.4 ? 1 : 0.5;
  const changed = paras.map((p) => (rnd() < share ? mutate(p).replace(/\n/g, " ") : p));
  if (rnd() < 0.3) changed.splice(Math.floor(rnd() * changed.length), 0, ...paras.slice(0, 40));
  return [paras.join("\n"), changed.join("\n")];
}

function patchLines(a: string, b: string): string | null {
  const hunks = diffLines(a, b);
  if (!hunks) return null;
  const al = a.split("\n");
  const out: string[] = [];
  let i = 0;
  for (const h of hunks) {
    while (i < h.oldStart - 1) out.push(al[i++]);
    for (const r of h.removed) {
      expect(al[i]).toBe(r);
      i++;
    }
    out.push(...h.added);
  }
  while (i < al.length) out.push(al[i++]);
  return out.join("\n");
}

function check(a: string, b: string): void {
  // Old versions are kept as edits: they must give the text back exactly.
  expect(applyDelta(a, makeDelta(a, b))).toBe(b);
  // Changes shown word by word: the unchanged and removed words are the old text, the rest the new.
  for (const pieces of [diffText(a, b), diffWords(a, b)]) {
    expect(pieces.filter((p) => p.type !== "added").map((p) => p.text).join("")).toBe(a);
    expect(pieces.filter((p) => p.type !== "removed").map((p) => p.text).join("")).toBe(b);
  }
  // What an agent is sent since its last read rebuilds the new text.
  const patched = patchLines(a, b);
  if (patched !== null) expect(patched).toBe(b);
  // Places in the old text map in order, ends to ends.
  const map = new OffsetMap(a, b);
  expect(map.map(0, -1)).toBe(0);
  expect(map.map(a.length, 1)).toBe(b.length);
  let last = 0;
  for (let p = 0; p <= a.length; p += 1 + Math.floor(a.length / 40)) {
    const to = map.map(p, 1);
    expect(to).toBeGreaterThanOrEqual(last);
    expect(to).toBeLessThanOrEqual(b.length);
    last = to;
  }
  // Changed passages lie inside the new text, in order, apart.
  let end = 0;
  for (const piece of changedPieces(a, b)) {
    expect(piece.start).toBeGreaterThanOrEqual(end);
    expect(piece.end).toBeGreaterThanOrEqual(piece.start);
    end = piece.end;
  }
  expect(end).toBeLessThanOrEqual(b.length);
}

describe("comparing random texts", () => {
  it("short texts with a few random edits, or wholly different ones, always come back exactly", () => {
    const { rnd, text, mutate } = texts(12345);
    for (let i = 0; i < 2000; i++) {
      const a = text(Math.floor(rnd() * 120));
      const b = rnd() < 0.1 ? text(Math.floor(rnd() * 120)) : mutate(a);
      check(a, b);
    }
    // About a second; more room when the Mac is busy.
  }, 30_000);

  it("long documents, many paragraphs changed, come back exactly too", () => {
    for (let seed = 1; seed <= 12; seed++) {
      const [a, b] = longPair(seed);
      check(a, b);
    }
  }, 30_000);
});
