// Comments' words in the Markdown view's text, as the person types: each mark
// stays on its words, as a comment's highlight does in the formatted view, and
// each line is cut into marked and unmarked pieces for drawing.
import { describe, expect, it } from "vitest";
import { mapMark, markAt, pieces, textEdit, type SourceMark } from "../../src/core/source-marks";

const typing = (before: string, after: string) => textEdit(before, after)!;
const mark = (from: number, to: number, kind: SourceMark["kind"] = "comment", id = "c1"): SourceMark => ({ id, from, to, kind });

describe("What typing changed", () => {
  it("finds the one stretch typed, deleted or replaced", () => {
    expect(textEdit("same", "same")).toBeNull();
    expect(typing("a word here", "a big word here")).toEqual({ from: 2, oldTo: 2, newTo: 6 });
    expect(typing("a big word", "a word")).toEqual({ from: 2, oldTo: 6, newTo: 2 });
    expect(typing("one two three", "one 2 three")).toEqual({ from: 4, oldTo: 7, newTo: 5 });
  });
});

describe("A comment's words in the Markdown text", () => {
  // The comment is on "bold word", written "bold** word" in the text: 6 to 17.
  const text = "the **bold** word and more";
  const onWords = mark(6, 17);

  it("stays on its words when typing comes before them", () => {
    const after = "so the **bold** word and more";
    expect(mapMark(onWords, typing(text, after))).toEqual(mark(9, 20));
  });

  it("doesn't grow with typing just before or just after its words", () => {
    expect(mapMark(onWords, typing(text, "the **Xbold** word and more"))).toEqual(mark(7, 18));
    expect(mapMark(onWords, typing(text, "the **bold** wordX and more"))).toEqual(mark(6, 17));
  });

  it("takes in typing among its words", () => {
    expect(mapMark(onWords, typing(text, "the **bold** big word and more"))).toEqual(mark(6, 21));
  });

  it("shrinks when some of its words are deleted, and goes when all of them are", () => {
    expect(mapMark(onWords, typing(text, "the **bold** and more"))).toEqual(mark(6, 13));
    expect(mapMark(onWords, typing(text, "the  and more"))).toBeNull();
  });

  it("keeps the same mark when nothing about it changed", () => {
    expect(mapMark(onWords, typing(text, "the **bold** word and more!"))).toBe(onWords);
  });
});

describe("Drawing a line's marks", () => {
  it("leaves a line without marks as one piece", () => {
    expect(pieces(0, 10, [])).toEqual([{ from: 0, to: 10, kind: null, id: null }]);
  });

  it("cuts a line where marks start and end, the strongest showing where they overlap", () => {
    const marks = [mark(2, 8, "comment", "a"), mark(5, 12, "active", "b"), mark(6, 7, "change", "b")];
    expect(pieces(0, 14, marks)).toEqual([
      { from: 0, to: 2, kind: null, id: null },
      { from: 2, to: 5, kind: "comment", id: "a" },
      { from: 5, to: 6, kind: "active", id: "b" },
      { from: 6, to: 7, kind: "change", id: "b" },
      { from: 7, to: 12, kind: "active", id: "b" },
      { from: 12, to: 14, kind: null, id: null },
    ]);
  });

  it("draws only the part of a mark on this line", () => {
    expect(pieces(10, 20, [mark(4, 14)])).toEqual([
      { from: 10, to: 14, kind: "comment", id: "c1" },
      { from: 14, to: 20, kind: null, id: null },
    ]);
  });
});

describe("Clicking in the text", () => {
  it("finds the comment whose words are there (the smallest, if they nest), not an agent's change", () => {
    const marks = [mark(0, 20, "comment", "outer"), mark(5, 9, "comment", "inner"), mark(12, 15, "change", "outer")];
    expect(markAt(marks, 6)).toBe("inner");
    expect(markAt(marks, 2)).toBe("outer");
    expect(markAt(marks, 13)).toBe("outer");
    expect(markAt(marks, 25)).toBeNull();
  });
});
