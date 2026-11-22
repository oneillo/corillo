// Reading the same Markdown again (switching back to Formatted, Show changes,
// restoring a version) reuses the last reading instead of doing it again.
import { describe, expect, it } from "vitest";
import { parseMarkdown, serializeMarkdown } from "../../src/core/markdown";
import { forgetParsed, parseCached } from "../../src/renderer/parse-cache";
import { bigDocument } from "../fixtures/big-document";

const BIG = bigDocument();

/** The middle of several tries, in milliseconds. */
function timed(work: () => void, tries = 5): number {
  const times: number[] = [];
  for (let i = 0; i < tries; i++) {
    const start = performance.now();
    work();
    times.push(performance.now() - start);
  }
  return times.sort((a, b) => a - b)[Math.floor(tries / 2)];
}

describe("reading Markdown again", () => {
  it("gives the same result as reading it fresh, and writes back the same text", () => {
    forgetParsed();
    const kept = parseCached(BIG);
    expect(kept.doc.eq(parseMarkdown(BIG).doc)).toBe(true);
    expect(parseCached(BIG)).toBe(kept);
    expect(serializeMarkdown(kept.doc, kept.source)).toBe(BIG);
  });

  it("reads different text afresh, and keeps the last few", () => {
    forgetParsed();
    const texts = ["One.\n", "Two.\n", "Three.\n", "Four.\n"];
    const first = texts.map((t) => parseCached(t));
    texts.forEach((t, i) => expect(parseCached(t)).toBe(first[i]));
    expect(parseCached("Five.\n").doc.textContent).toBe("Five.");
    expect(parseCached("One.\n")).not.toBe(first[0]); // the oldest was let go
  });

  it("lets go of everything when a document closes", () => {
    const kept = parseCached("Kept.\n");
    forgetParsed();
    expect(parseCached("Kept.\n")).not.toBe(kept);
  });

  it("reads a long document again in a small fraction of the time it took the first time", () => {
    const fresh = timed(() => {
      forgetParsed();
      parseCached(BIG);
    });
    const again = timed(() => parseCached(BIG));
    expect(again).toBeLessThan(fresh / 10);
  });
});
