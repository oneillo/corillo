// Batch 23 review, R23-3: the writer found the "$" signs to escape one at a
// time, writing the whole paragraph out again and reading it from its start
// for each, so a long paragraph with many of them took time growing with
// their count times the paragraph's length (one paragraph of 1,600
// "**12$** and 20$" pairs, 35,000 characters: 4.7 s to save, 42 ms before
// Batch 23). Now each look at the paragraph finds every such sign at once.
//
// Measured by ratio within one run, never against the clock: twice the
// paragraph must take about twice the time to plan, not four times (best of
// five each, so a busy Mac doesn't decide it). The plan (planFor) is where
// the writer decides which signs to escape; the rest of the save isn't timed
// here. Made-up text only.
import { describe, expect, it } from "vitest";
import type { Node } from "prosemirror-model";
import { schema } from "../../src/core/schema";
import { parseMarkdown, serializeMarkdown } from "../../src/core/markdown";
import { planFor } from "../../src/core/markdown-inline";

const fresh = () => parseMarkdown("").source;

/** A paragraph: `pairs` times bold "12$", then " and 20$ "; then "The end.". (Built new each time: the writer keeps its plan per paragraph.) */
function paragraph(pairs: number): Node {
  const bold = schema.marks.strong.create();
  const kids: Node[] = [];
  for (let k = 0; k < pairs; k++) kids.push(schema.text("12$", [bold]), schema.text(" and 20$ "));
  kids.push(schema.text("The end."));
  return schema.node("paragraph", null, kids);
}

/** The quickest of five plans of a fresh paragraph of `pairs` pairs, in milliseconds. */
function quickest(pairs: number): number {
  let best = Infinity;
  for (let k = 0; k < 5; k++) {
    const p = paragraph(pairs);
    const t0 = performance.now();
    planFor(p);
    best = Math.min(best, performance.now() - t0);
  }
  return best;
}

describe("a long paragraph with many escaped $ signs", () => {
  it("reads back as written, each bold $ escaped", () => {
    const doc = schema.node("doc", null, [paragraph(300)]);
    const written = serializeMarkdown(doc, fresh());
    expect(written.startsWith("**12\\$** and 20$ **12\\$** and 20$ ")).toBe(true);
    expect(parseMarkdown(written).doc.eq(doc)).toBe(true);
  });

  it("twice as long takes about twice as long to plan, not four times", () => {
    quickest(200); // (warm up)
    const small = quickest(800);
    const large = quickest(1600);
    expect(large / small, `${small.toFixed(1)} ms, then ${large.toFixed(1)} ms`).toBeLessThan(3);
  }, 120_000);
});
