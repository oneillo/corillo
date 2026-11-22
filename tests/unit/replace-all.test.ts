// Replace All as one step: the same document, the same places for everything
// that follows the words, and the same Undo as replacing match by match.
import { describe, expect, it } from "vitest";
import { EditorState, type Transaction } from "prosemirror-state";
import { history, redo, undo } from "prosemirror-history";
import { Step } from "prosemirror-transform";
import type { Node } from "prosemirror-model";
import { parseMarkdown } from "../../src/core/markdown";
import { findInDoc, type Match } from "../../src/core/search";
import { replaceAllStep, ReplaceAllStep } from "../../src/renderer/replace-all";
import { changedRanges } from "../../src/renderer/changed-ranges";

const DOC = [
  "# The Cat",
  "",
  "A cat, a **cat**, a c**at**, [a cat](https://example.com/cat) and `cat`, catcat.",
  "",
  "- one cat",
  "- two cats",
  "  - a cat inside",
  "",
  "> a cat quoted",
  "",
  "| cat | dog |",
  "| --- | --- |",
  "| a cat | cat |",
  "",
  "```text",
  "cat",
  "cat cat",
  "```",
  "",
  "Cat",
  "",
].join("\n");

/** As Replace All did before: a step for each match, from the last back to the first. */
function oneByOne(state: EditorState, matches: Match[], text: string): Transaction {
  const tr = state.tr;
  for (let i = matches.length - 1; i >= 0; i--) {
    if (text) tr.insertText(text, matches[i].from, matches[i].to);
    else tr.delete(matches[i].from, matches[i].to);
  }
  return tr;
}

function inOneStep(state: EditorState, matches: Match[], text: string): Transaction {
  const step = replaceAllStep(state.doc, matches, text);
  if (!step) throw new Error("no step");
  return state.tr.step(step);
}

const docOf = (markdown: string): Node => parseMarkdown(markdown).doc;

describe("Replace All in one step", () => {
  for (const text of ["dog", "", "kitty cat"]) {
    it(`replacing with "${text}" makes the same document, and moves every place the same, as one step per match`, () => {
      const doc = docOf(DOC);
      const state = EditorState.create({ doc });
      const matches = findInDoc(doc, "cat", false);
      expect(matches.length).toBeGreaterThan(15);
      const before = oneByOne(state, matches, text);
      const now = inOneStep(state, matches, text);
      expect(now.steps).toHaveLength(1);
      expect(now.doc.eq(before.doc)).toBe(true);
      // Where two matches touch ("catcat"), one map says the words before the
      // place went rather than the words after it; where it goes is the same.
      const touching = new Set(matches.filter((m, i) => i > 0 && matches[i - 1].to === m.from).map((m) => m.from));
      expect(touching.size).toBe(1);
      for (let pos = 0; pos <= doc.content.size; pos++) {
        for (const assoc of [-1, 1]) {
          const a = now.mapping.mapResult(pos, assoc);
          const b = before.mapping.mapResult(pos, assoc);
          expect([pos, assoc, a.pos, a.deletedAcross]).toEqual([pos, assoc, b.pos, b.deletedAcross]);
          if (!touching.has(pos)) expect([pos, assoc, a.deleted]).toEqual([pos, assoc, b.deleted]);
        }
      }
    });
  }

  it("is undone, and redone, as one step that puts back each match's words and formatting", () => {
    const doc = docOf(DOC);
    let state = EditorState.create({ doc, plugins: [history()] });
    const replaced = inOneStep(state, findInDoc(doc, "cat", false), "dog");
    state = state.apply(replaced);
    expect(state.doc.textContent).not.toMatch(/cat/i);
    expect(undo(state, (tr) => (state = state.apply(tr)))).toBe(true);
    expect(state.doc.eq(doc)).toBe(true);
    expect(redo(state, (tr) => (state = state.apply(tr)))).toBe(true);
    expect(state.doc.eq(replaced.doc)).toBe(true);
  });

  it("follows edits made after it, as a step for each match would (Undo after other changes)", () => {
    const doc = docOf("One cat.\n\nTwo cats.\n");
    const state = EditorState.create({ doc });
    const step = replaceAllStep(doc, findInDoc(doc, "cat", false), "dog")!;
    const typed = state.tr.insertText("Now ", 1);
    const mapped = step.map(typed.mapping)!;
    expect(typed.step(mapped).doc.textBetween(0, typed.doc.content.size, "\n")).toBe("Now One dog.\nTwo dogs.");
  });

  it("is kept and read back as JSON", () => {
    const doc = docOf(DOC);
    const step = replaceAllStep(doc, findInDoc(doc, "cat", false), "dog")!;
    const back = Step.fromJSON(doc.type.schema, JSON.parse(JSON.stringify(step.toJSON())));
    expect(back).toBeInstanceOf(ReplaceAllStep);
    expect(back.apply(doc).doc!.eq(step.apply(doc).doc!)).toBe(true);
  });

  it("isn't made for a stretch that runs from one block into another (then it's match by match)", () => {
    const doc = docOf("One cat.\n\nTwo cats.\n");
    const [first, second] = findInDoc(doc, "cat", false);
    expect(replaceAllStep(doc, [{ from: first.from, to: second.to }], "dog")).toBeNull();
    expect(replaceAllStep(doc, [], "dog")).toBeNull();
  });

  it("tells plugins which blocks changed, or to look at everything once there are thousands", () => {
    const few = docOf("One cat.\n\nTwo cats.\n");
    const tr = inOneStep(EditorState.create({ doc: few }), findInDoc(few, "cat", false), "dog");
    expect(changedRanges(tr)).toEqual([
      [5, 8],
      [15, 18],
    ]);
    const many = docOf(Array.from({ length: 300 }, () => "a cat and a cat").join("\n\n") + "\n");
    const all = inOneStep(EditorState.create({ doc: many }), findInDoc(many, "cat", false), "dog");
    expect(changedRanges(all)).toBeNull();
  });
});
