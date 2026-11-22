// The plain parts of an open document's tab, now in modules of their own
// (Batch 18 item 6): bringing the document to new text so only what differs
// changes (doc-tab-edits.ts), and keeping the person's place through a change
// (doc-tab-place.ts). Each is checked here without a window.
import { describe, expect, it } from "vitest";
import { EditorState, TextSelection } from "prosemirror-state";
import type { Node } from "prosemirror-model";
import { parseMarkdown, serializeMarkdown } from "../../src/core/markdown";
import { schema } from "../../src/core/schema";
import { fromTheText, markAsFromTheText, readAs, replaceBlocks, replaceChanged, replaceMatches, throughTexts } from "../../src/renderer/doc-tab-edits";
import { draftMoves, emptyLineIn, followText, mapOffset, selectionPlace, sameFrom, shifted, touches } from "../../src/renderer/doc-tab-place";
import { textIndex } from "../../src/core/anchors";

const stateOf = (text: string) => EditorState.create({ schema, doc: parseMarkdown(text).doc });
const docOf = (text: string) => parseMarkdown(text).doc;
const written = (doc: Node) => serializeMarkdown(doc, parseMarkdown("").source);

/** Where the words first appear in the document, as a place in it. */
function posOf(doc: Node, words: string): number {
  let found = -1;
  doc.descendants((node, pos) => {
    if (found >= 0) return false;
    const at = node.isText ? node.text!.indexOf(words) : -1;
    if (at >= 0) found = pos + at;
    return found < 0;
  });
  if (found < 0) throw new Error(`no "${words}"`);
  return found;
}

describe("bringing the document to new text", () => {
  it("changes only the words that differ, in one small step", () => {
    const state = stateOf("First paragraph here.\n\nSecond one stays.\n");
    const { tr, exact } = replaceChanged(state, docOf("First paragraph there.\n\nSecond one stays.\n"));
    expect(exact).toBe(true);
    expect(tr.steps).toHaveLength(1);
    expect(written(tr.doc)).toBe("First paragraph there.\n\nSecond one stays.\n");
    // Words before and after the change keep their places.
    expect(tr.mapping.map(posOf(state.doc, "Second"))).toBe(posOf(tr.doc, "Second"));
  });

  it("replaces whole blocks only between the first and last that differ", () => {
    const state = stateOf("A\n\nB\n\nC\n");
    const tr = replaceBlocks(state, docOf("A\n\nB2\n\nC\n"));
    expect(written(tr.doc)).toBe("A\n\nB2\n\nC\n");
    expect(tr.mapping.map(posOf(state.doc, "C"))).toBe(posOf(tr.doc, "C"));
  });

  it("changes each block that differs on its own, so what's between keeps its place", () => {
    const state = stateOf("One two.\n\nMiddle words.\n\nThree four.\n");
    const tr = readAs(state, docOf("One 2.\n\nMiddle words.\n\nThree 4.\n"));
    expect(tr.steps).toHaveLength(2);
    expect(written(tr.doc)).toBe("One 2.\n\nMiddle words.\n\nThree 4.\n");
    expect(tr.mapping.map(posOf(state.doc, "Middle"))).toBe(posOf(tr.doc, "Middle"));
  });

  it("goes through each text on the way, and says when one can't be reached", () => {
    const state = stateOf("Alpha beta.\n");
    const tr = throughTexts(state.tr, ["Alpha gamma.\n", "Delta gamma.\n"]);
    expect(tr && written(tr.doc)).toBe("Delta gamma.\n");
    expect(tr?.steps).toHaveLength(2);
  });

  it("replaces matches one by one, and gives up when the result isn't the text wanted", () => {
    const state = stateOf("cat and cat\n");
    const places = [
      { from: posOf(state.doc, "cat"), to: posOf(state.doc, "cat") + 3 },
      { from: posOf(state.doc, "and") + 4, to: posOf(state.doc, "and") + 7 },
    ];
    const tr = replaceMatches(state.tr, places, "dog", docOf("dog and dog\n"));
    expect(tr && written(tr.doc)).toBe("dog and dog\n");
    expect(replaceMatches(state.tr, places, "dog", docOf("something else\n"))).toBeNull();
  });
});

describe("keeping the person's place through a change", () => {
  it("moves a place in a text along by what changed before it, and leaves it where nothing did", () => {
    expect(mapOffset("hello world", "hello brave world", 2)).toBe(2);
    expect(mapOffset("hello world", "hello brave world", 8)).toBe(14);
  });

  it("keeps a place in a rewritten paragraph in that paragraph, not in one added beside it", () => {
    const before = "Intro.\nThe quarterly numbers improved slowly.\nEnd.";
    const after = "Intro.\nA brand new paragraph here.\nThe quarterly numbers improved quickly overall.\nEnd.";
    const at = before.indexOf("numbers");
    const now = mapOffset(before, after, at);
    const line = after.slice(after.lastIndexOf("\n", now - 1) + 1, after.indexOf("\n", now));
    expect(line).toContain("quarterly");
  });

  it("finds the lines that are the same from the last change on", () => {
    expect(sameFrom("a\nb\nc\n", "a\nB!\nc\n")).toEqual({ before: 4, after: 5 });
    expect(sameFrom("same", "same")).toBeNull();
    expect(sameFrom("a\nb", "a\nc")).toBeNull();
  });

  it("carries a place through changes that didn't touch it, and tells which did", () => {
    const changes = [{ from: 2, to: 4, insert: "xyz" }];
    expect(shifted(changes, 10)).toBe(11);
    expect(shifted(changes, 1)).toBe(1);
    expect(touches([{ from: 2, to: 4 }], 4, 6)).toBe(true);
    expect(touches([{ from: 2, to: 4 }], 5, 6)).toBe(false);
  });

  it("keeps the cursor on an empty line between two paragraphs, found again after a paragraph is put in above", () => {
    const state = stateOf("Top words.\n\n\n\nBottom words.\n");
    let empty = -1;
    state.doc.forEach((node, offset) => {
      if (empty < 0 && node.type === schema.nodes.paragraph && node.childCount === 0) empty = offset + 1;
    });
    expect(empty).toBeGreaterThan(0);
    const kept = selectionPlace(state.apply(state.tr.setSelection(TextSelection.create(state.doc, empty))));
    expect(kept?.emptyLine).toBeTruthy();
    const after = docOf("New first.\n\nTop words.\n\n\n\nBottom words.\n");
    const at = emptyLineIn(after, kept!.emptyLine!, textIndex(after));
    expect(at).not.toBeNull();
    const $at = after.resolve(at!);
    expect($at.parent.type).toBe(schema.nodes.paragraph);
    expect($at.parent.childCount).toBe(0);
    expect(after.child($at.index(0) - 1).textContent).toBe("Top words.");
  });
});

describe("a change read from the Markdown text or the file (S21-37)", () => {
  const state = EditorState.create({ doc: parseMarkdown("Words.\n").doc });

  it("is marked so, as one Undo step with the rest of its group, or with none from the file", () => {
    const typed = markAsFromTheText(state.tr.insertText("x", 1), 3);
    expect(fromTheText(typed)).toBe(true);
    expect(typed.getMeta("composition")).toBe("markdown-3"); // the history joins changes that share it
    const read = markAsFromTheText(state.tr.insertText("y", 1));
    expect(fromTheText(read)).toBe(true);
    expect(read.getMeta("composition")).toBe("markdown-file");
  });

  it("and any other change isn't", () => {
    expect(fromTheText(state.tr.insertText("z", 1))).toBe(false);
    expect(fromTheText(state.tr.insertText("z", 1).setMeta("composition", 7))).toBe(false); // an input method's own
  });
});

// S21-43: the tab's arithmetic, tested without a window.
describe("a comment being written, carried through an agent's change (draftMoves)", () => {
  const before = "One two three. Four five six.";
  const words = { from: before.indexOf("Four"), to: before.indexOf("Four") + "Four five".length };

  it("stays where it is when the change was all after its words", () => {
    expect(draftMoves(before, before + " Seven.", words.from, words.to)).toBe(0);
    expect(draftMoves(before, "One two three. Four five ten.", words.from, words.to)).toBe(0);
  });

  it("moves by what was put in or taken out when the change was all before its words", () => {
    expect(draftMoves(before, "Zero. " + before, words.from, words.to)).toBe("Zero. ".length);
    expect(draftMoves(before, before.replace("two ", ""), words.from, words.to)).toBe(-"two ".length);
  });

  it("a word added at its edge stays outside it", () => {
    expect(draftMoves(before, before.replace("Four", "And Four"), words.from, words.to)).toBe("And ".length);
    expect(draftMoves(before, before.replace("five", "five more"), words.from, words.to)).toBe(0);
  });

  it("is null when the change touched its words, or nothing changed", () => {
    expect(draftMoves(before, before.replace("Four five", "Four 5"), words.from, words.to)).toBeNull();
    expect(draftMoves(before, before, words.from, words.to)).toBeNull();
  });
});

describe("the Markdown view's text following a change made in the preview or by a command (followText)", () => {
  const was = "# Title\n\nFirst line.\n\nSecond line.\n";
  const shown = was.replace("Second", "**Second**");

  it("is the change to make, when nothing was typed", () => {
    const change = followText(was, shown, was);
    expect(change).toEqual({ from: was.indexOf("Second"), oldTo: was.indexOf("Second") + "Second".length, newTo: was.indexOf("Second") + "**Second**".length, insert: "**Second**" });
    if (!change || change === "typed there") throw new Error("no change");
    expect(was.slice(0, change.from) + change.insert + was.slice(change.oldTo)).toBe(shown);
  });

  it("is moved past what was typed before it, so the typing stays", () => {
    const typed = was.replace("First", "My first");
    const change = followText(was, shown, typed);
    if (!change || change === "typed there") throw new Error("no change");
    expect(typed.slice(0, change.from) + change.insert + typed.slice(change.oldTo)).toBe(shown.replace("First", "My first"));
  });

  it("leaves typing after it where it is", () => {
    const typed = was + "More.\n";
    const change = followText(was, shown, typed);
    if (!change || change === "typed there") throw new Error("no change");
    expect(typed.slice(0, change.from) + change.insert + typed.slice(change.oldTo)).toBe(shown + "More.\n");
  });

  it("gives way to typing in the very place that changed: the text wins", () => {
    expect(followText(was, shown, was.replace("Second", "Secund"))).toBe("typed there");
  });

  it("is null when nothing changed", () => {
    expect(followText(was, was, was.replace("First", "My first"))).toBeNull();
  });
});
