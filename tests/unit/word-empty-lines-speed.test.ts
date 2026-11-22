// Marking the empty lines for Word stays quick when a passage reads oddly
// (Batch 22, from Batch 21's E21-23 and R21-3). The marking runs in the main
// process on every Word export, so every window, menu and agent waits on it.
// Times are compared with the same document without the odd passage, each the
// best of three, so a busy Mac doesn't decide.
import { describe, expect, it } from "vitest";
import { blankLinesForWord, BLANK_MARK } from "../../src/main/export-prep";
import { markdownTokens } from "../../src/core/markdown";

const marksIn = (text: string) => text.split(BLANK_MARK).length - 1;

/** The fastest of three runs, in ms, and what the last made. */
const best = (text: string) => {
  let fastest = Infinity;
  let out = "";
  for (let i = 0; i < 3; i++) {
    const start = performance.now();
    out = blankLinesForWord(text);
    fastest = Math.min(fastest, performance.now() - start);
  }
  return { ms: fastest, out };
};

const WRAPPED = "wrapped by hand\nonto a second line";

/** A list of this many items, a blank line between them, item 3 written as `odd`. */
const list = (items: number, odd?: (i: number) => string | undefined) =>
  Array.from({ length: items }, (_, i) => odd?.(i) ?? `- Item ${i + 1} of the list, with a few words to its name`).join("\n\n") + "\n";

/** A quote of this many paragraphs. */
const quote = (paragraphs: number, odd?: string) =>
  Array.from({ length: paragraphs }, (_, i) => (odd !== undefined && i === 2 ? odd : `> Paragraph ${i + 1} of the letter, with a few words to it`)).join("\n>\n") + "\n";

describe("a long list or quote with one line wrapped by hand (E21-23)", () => {
  // Before: 2.1 s for 1,000 items with one line wrapped by hand, against 9 ms without.
  const cases: [string, string, string][] = [
    ["one line wrapped by hand in a list", list(1000), list(1000, (i) => (i === 2 ? `- ${WRAPPED}` : undefined))],
    ["one empty item", list(1000), list(1000, (i) => (i === 2 ? "-" : undefined))],
    ["indented code under one item", list(1000), list(1000, (i) => (i === 2 ? "- Item\n\n      code here" : undefined))],
    ["one line wrapped by hand in a quote", quote(1000), quote(1000, `> ${WRAPPED}`)],
    ["every item wrapped by hand", list(1000), list(1000, () => `- ${WRAPPED}`)],
  ];
  for (const [what, plain, odd] of cases) {
    it(`takes about as long as without it, and keeps every empty line: ${what}`, () => {
      const a = best(plain);
      const b = best(odd);
      expect(b.ms, `${b.ms.toFixed(0)} ms against ${a.ms.toFixed(0)} ms`).toBeLessThan(Math.max(5 * a.ms, 50));
      // Every blank line between the parts is an empty line: one fewer than the parts, and one more for the code's.
      expect(marksIn(b.out)).toBe(marksIn(a.out) + (what.startsWith("indented code") ? 1 : 0));
    });
  }
});

describe("a long document with many odd passages (R21-3)", () => {
  // A note followed by two blank lines and indented text: the marks around it would change how it reads.
  const doc = (paragraphs: number, every: number) =>
    Array.from({ length: paragraphs }, (_, i) =>
      every && i % every === every - 1 ? `[^n${i}]: note\n\n\n    indented` : `Paragraph ${i + 1}, with a few words to it.`,
    ).join("\n\n") + "\n";

  it("costs a fixed number of checks at most, and keeps the empty lines elsewhere", () => {
    // Before: 2,000 paragraphs with 100 such passages held the app for 5 s.
    const a = best(doc(2000, 0));
    const b = best(doc(2000, 20));
    expect(b.ms, `${b.ms.toFixed(0)} ms against ${a.ms.toFixed(0)} ms`).toBeLessThan(Math.max(40 * a.ms, 400));
    // Between two ordinary paragraphs, the empty line is kept everywhere.
    let between = 0;
    for (let i = 1; i < 2000; i++) if (i % 20 !== 19 && i % 20 !== 0) between++;
    const kept = [...b.out.matchAll(/with a few words to it\.\n\n<!--corillo blank-->\n\nParagraph/g)].length;
    expect(kept).toBe(between);
  });

  it("in generated documents with odd passages, changes nothing else and keeps the empty lines between plain paragraphs", () => {
    const shape = (text: string) =>
      markdownTokens(text)
        .filter((t) => !(t.type === "html_block" && t.content.trim() === BLANK_MARK))
        .map((t) => `${t.type}${t.hidden ? " hidden" : ""} ${t.markup} ${t.type === "inline" || t.type.endsWith("_block") || t.type === "fence" ? t.content : ""}`);
    const ODD = ["[^n{i}]: note\n\n\n    indented", "- ```\n  code\n\n  text", "- a\nlazy line\n\n- b", "-\n\n- b\n\n      code"];
    let seed = 11;
    const r = () => (seed = (seed * 1664525 + 1013904223) >>> 0) / 2 ** 32;
    for (let run = 0; run < 300; run++) {
      const parts: string[] = [];
      const n = 5 + Math.floor(r() * 60);
      for (let i = 0; i < n; i++) parts.push(r() < 0.15 ? ODD[Math.floor(r() * ODD.length)].replace("{i}", String(i)) : `Plain ${i}.`);
      const text = parts.join("\n\n") + "\n";
      const marked = blankLinesForWord(text);
      expect(shape(marked), JSON.stringify(text)).toEqual(shape(text));
      for (let i = 1; i < n; i++) {
        if (parts[i - 1].startsWith("Plain") && parts[i].startsWith("Plain")) {
          expect(marked, JSON.stringify(text)).toContain(`${parts[i - 1]}\n\n${BLANK_MARK}\n\n${parts[i]}`);
        }
      }
    }
  });

  it("one odd passage stays cheap, and only its own marks are left out", () => {
    const a = best(doc(2000, 0));
    const b = best(doc(2000, 2000));
    expect(b.ms, `${b.ms.toFixed(0)} ms against ${a.ms.toFixed(0)} ms`).toBeLessThan(Math.max(5 * a.ms, 50));
    expect(marksIn(b.out)).toBeGreaterThanOrEqual(marksIn(a.out) - 3);
  });
});

describe("a list with many odd items keeps every empty line the old way kept (R22-1, R22-2)", () => {
  const paragraphs = (from: number) => Array.from({ length: 3 }, (_, i) => `Paragraph ${from + i}, with a few words to it.`).join("\n\n");
  /** Numbered steps, each with a line of code under it, indented as the step's code. */
  const steps = (n: number, code: boolean) =>
    Array.from({ length: n }, (_, i) => (code ? `${i + 1}. Run step ${i + 1}:\n\n       npm run step-${i}` : `${i + 1}. Run step ${i + 1}:`)).join("\n\n");

  it("3 paragraphs, 12 numbered steps with code under each, 3 paragraphs: all 29 empty lines", () => {
    const out = blankLinesForWord(`${paragraphs(1)}\n\n${steps(12, true)}\n\n${paragraphs(4)}\n`);
    expect(marksIn(out)).toBe(29);
    // The 4 between the plain paragraphs among them.
    expect([...out.matchAll(/to it\.\n\n<!--corillo blank-->\n\nParagraph/g)].length).toBe(4);
  });

  it("40 steps with code: all 85", () => {
    expect(marksIn(blankLinesForWord(`${paragraphs(1)}\n\n${steps(40, true)}\n\n${paragraphs(4)}\n`))).toBe(85);
  });

  it("a 60-item list with every 6th item empty keeps every empty line but those after the empty items", () => {
    const plain = list(60);
    const odd = list(60, (i) => (i % 6 === 5 ? "-" : undefined));
    // The blank line after an empty item can't be marked without filling the item; the other 49 are kept.
    expect(marksIn(blankLinesForWord(odd))).toBeGreaterThanOrEqual(marksIn(blankLinesForWord(plain)) - 10);
  });

  it("a 1,000-item list with 20 empty items between 200 paragraphs keeps the 198 between the paragraphs", () => {
    const items = list(1000, (i) => (i % 50 === 49 ? "-" : undefined)).trimEnd();
    const text = `${Array.from({ length: 100 }, (_, i) => `Before ${i}, with a few words to it.`).join("\n\n")}\n\n${items}\n\nAfter.\n\n${Array.from({ length: 99 }, (_, i) => `After ${i}, with a few words to it.`).join("\n\n")}\n`;
    const out = blankLinesForWord(text);
    expect([...out.matchAll(/to it\.\n\n<!--corillo blank-->\n\n(?:Before|After)/g)].length).toBe(99 + 98);
    expect(marksIn(out)).toBeGreaterThanOrEqual(marksIn(blankLinesForWord(text.replace(/^-$/gm, "- Item"))) - 20);
  });

  it("a 5,000-item list with an empty item every 40 takes a few times the plain list's time, and keeps its marks", () => {
    const a = best(list(5000));
    const b = best(list(5000, (i) => (i % 40 === 39 ? "-" : undefined)));
    expect(b.ms, `${b.ms.toFixed(0)} ms against ${a.ms.toFixed(0)} ms`).toBeLessThan(Math.max(5 * a.ms, 50));
    expect(marksIn(b.out)).toBeGreaterThanOrEqual(marksIn(a.out) - 125);
  });
});
