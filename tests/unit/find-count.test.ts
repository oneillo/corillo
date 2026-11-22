// What the find bar says once it also counts the matches in the comments
// (roadmap Batch 4, item 2, L-9).
import { describe, expect, it } from "vitest";
import { countLabel, countWithComments, stepThrough } from "../../src/core/search";

describe("the find bar's count", () => {
  it("is as before with no match in the comments", () => {
    expect(countWithComments(12, 2, 0, -1)).toBe(countLabel(12, 2));
    expect(countWithComments(0, -1, 0, -1)).toBe("No matches");
    expect(countWithComments(3, -1, 0, -1)).toBe("3 matches");
  });

  it("adds the comments' matches after the text's", () => {
    expect(countWithComments(12, 2, 2, -1)).toBe("3 of 12 · 2 in comments");
    expect(countWithComments(12, -1, 1, -1)).toBe("12 matches · 1 in comments");
    expect(countWithComments(1, -1, 1, -1)).toBe("1 match · 1 in comments");
  });

  it("on a match in a comment, counts that one", () => {
    expect(countWithComments(12, -1, 2, 1)).toBe("12 in the text · 2 of 2 in comments");
    expect(countWithComments(1_200, -1, 3, 0)).toBe("1,200 in the text · 1 of 3 in comments");
  });

  it("says when the text has none", () => {
    expect(countWithComments(0, -1, 1, -1)).toBe("No matches in the text · 1 in comments");
    expect(countWithComments(0, -1, 4, 3)).toBe("No matches in the text · 4 of 4 in comments");
  });
});

describe("going from match to match, the text first and then the comments", () => {
  const text = [
    { from: 2, to: 5 },
    { from: 10, to: 13 },
  ];
  it("in the text, as before, while there's a match ahead", () => {
    expect(stepThrough(text, 3, { from: 0, to: 0 }, 1, -1)).toEqual({ text: 0 });
    expect(stepThrough(text, 3, { from: 2, to: 5 }, 1, -1)).toEqual({ text: 1 });
    expect(stepThrough(text, 3, { from: 10, to: 13 }, -1, -1)).toEqual({ text: 0 });
  });

  it("past the last match in the text, into the comments; before the first, to the last comment", () => {
    expect(stepThrough(text, 3, { from: 10, to: 13 }, 1, -1)).toEqual({ comment: 0 });
    expect(stepThrough(text, 3, { from: 14, to: 14 }, 1, -1)).toEqual({ comment: 0 });
    expect(stepThrough(text, 3, { from: 2, to: 5 }, -1, -1)).toEqual({ comment: 2 });
  });

  it("through the comments, then round to the text", () => {
    expect(stepThrough(text, 3, { from: 10, to: 13 }, 1, 0)).toEqual({ comment: 1 });
    expect(stepThrough(text, 3, { from: 10, to: 13 }, 1, 2)).toEqual({ text: 0 });
    expect(stepThrough(text, 3, { from: 10, to: 13 }, -1, 0)).toEqual({ text: 1 });
  });

  it("with no comments' matches, round the text as before; with none in the text, round the comments", () => {
    expect(stepThrough(text, 0, { from: 10, to: 13 }, 1, -1)).toEqual({ text: 0 });
    expect(stepThrough([], 2, { from: 0, to: 0 }, 1, -1)).toEqual({ comment: 0 });
    expect(stepThrough([], 2, { from: 0, to: 0 }, 1, 1)).toEqual({ comment: 0 });
    expect(stepThrough([], 2, { from: 0, to: 0 }, -1, 0)).toEqual({ comment: 1 });
    expect(stepThrough([], 0, { from: 0, to: 0 }, 1, -1)).toBeNull();
  });
});
