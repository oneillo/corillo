// Which parts of a document an edit touched: quick even for an edit of
// thousands of steps (Replace All of a common word in a long document).
import { describe, expect, it } from "vitest";
import { EditorState } from "prosemirror-state";
import { schema } from "../../src/core/schema";
import { changedRanges } from "../../src/renderer/changed-ranges";

/** "cat" replaced in each "the cat sat " of so many paragraphs, each said so many times. */
function replaceAllIn(paragraphs: number, times = 1) {
  const line = "the cat sat ".repeat(times).trimEnd();
  const doc = schema.node("doc", null, Array.from({ length: paragraphs }, () => schema.node("paragraph", null, schema.text(line))));
  const state = EditorState.create({ doc });
  const tr = state.tr;
  // As Find's Replace All does: one step per match, from the last back to the first.
  for (let i = paragraphs - 1; i >= 0; i--) {
    for (let j = times - 1; j >= 0; j--) {
      const at = i * (line.length + 2) + 1 + j * 12 + 4;
      tr.insertText("dog", at, at + 3);
    }
  }
  return tr;
}

describe("changedRanges", () => {
  it("places each step of a small edit", () => {
    const tr = replaceAllIn(3);
    expect(changedRanges(tr)).toEqual([
      [31, 34],
      [18, 21],
      [5, 8],
    ]);
  });

  it("answers a 20,000-step edit within a few milliseconds", () => {
    const tr = replaceAllIn(200, 100);
    expect(tr.steps).toHaveLength(20_000);
    const start = performance.now();
    const ranges = changedRanges(tr);
    const took = performance.now() - start;
    console.log(`changedRanges on 20,000 steps: ${took.toFixed(1)} ms`);
    expect(took).toBeLessThan(20);
    // Either every change placed, or "look at everything", which every caller handles.
    if (ranges) expect(ranges).toHaveLength(20_000);
  });

  it("places every step of the largest edit it places (400 steps) within a few milliseconds", () => {
    const tr = replaceAllIn(20, 20);
    expect(tr.steps).toHaveLength(400);
    let took = Infinity;
    for (let i = 0; i < 3; i++) {
      const start = performance.now();
      const ranges = changedRanges(tr);
      took = Math.min(took, performance.now() - start);
      expect(ranges).toHaveLength(400);
    }
    console.log(`changedRanges on 400 steps: ${took.toFixed(1)} ms (best of 3)`);
    expect(took).toBeLessThan(20);
  });
});
