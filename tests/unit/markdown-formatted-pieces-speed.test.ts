// Batch 24, item 7 (row 65 of review/make-better-3.md, B23-F2): a paragraph
// of thousands of formatted pieces took more than twice as long to save when
// doubled (6,400 pairs, about 124 ms). For each bold or italic piece the
// writer looked through the whole paragraph's written order for where it
// opens; for each piece of text, through every kept range (a [[link]],
// math) and every escaped sign in the paragraph; and for each kept range,
// through every piece for the one holding it. Now each is found by place,
// indexed once per paragraph (this test's 6,400 pairs: about 330 ms before,
// about 40 ms after, on a quiet Mac).
//
// Measured by ratio within one run, never against the clock (as R23-3's
// test): twice the paragraph must take about twice the time to save, not
// four times (best of five each, so a busy Mac doesn't decide it). Made-up
// text only.
import { describe, expect, it } from "vitest";
import type { Node } from "prosemirror-model";
import { schema } from "../../src/core/schema";
import { parseMarkdown, serializeMarkdown } from "../../src/core/markdown";

const fresh = () => parseMarkdown("").source;

/**
 * A document of one paragraph: `pairs` times a bold or italic piece, then
 * plain words with a kept [[link]] and a sign to escape; then "The end.".
 * (Built new each time: the writer keeps its plan per paragraph.)
 */
function document(pairs: number): Node {
  const bold = schema.marks.strong.create();
  const em = schema.marks.em.create();
  const kids: Node[] = [];
  for (let k = 0; k < pairs; k++) kids.push(schema.text(`word${k % 10}`, [k % 2 ? em : bold]), schema.text(` see [[Note]] and 5$ `));
  kids.push(schema.text("The end."));
  return schema.node("doc", null, [schema.node("paragraph", null, kids)]);
}

/** The quickest of five saves of a fresh document of `pairs` pairs, in milliseconds. */
function quickest(pairs: number): number {
  let best = Infinity;
  for (let k = 0; k < 5; k++) {
    const doc = document(pairs);
    const t0 = performance.now();
    serializeMarkdown(doc, fresh());
    best = Math.min(best, performance.now() - t0);
  }
  return best;
}

describe("a paragraph of thousands of formatted pieces", () => {
  it("reads back as written", () => {
    const doc = document(300);
    const written = serializeMarkdown(doc, fresh());
    expect(written.startsWith("**word0** see [[Note]] and 5$ *word1* see [[Note]] and 5$ ")).toBe(true);
    expect(parseMarkdown(written).doc.eq(doc)).toBe(true);
  });

  it("twice as long takes about twice as long to save, not four times", () => {
    // 6,400 against 12,800 pairs: big enough that the old writer's slow part decides it (its ratio heads to 4)
    // and the new saves run long enough to be steady (review of Batch 24, R24-10).
    quickest(800); // (warm up)
    const small = quickest(6400);
    const large = quickest(12800);
    expect(large / small, `${small.toFixed(1)} ms, then ${large.toFixed(1)} ms`).toBeLessThan(3);
  }, 120_000);
});
