import { describe, expect, it } from "vitest";
import { EditorState, TextSelection, type Transaction } from "prosemirror-state";
import type { Node } from "prosemirror-model";
import { parseMarkdown } from "../../src/core/markdown";
import { anchorFor, findAnchor, textIndex } from "../../src/core/anchors";
import { commentPlugin, commentRanges, withRanges, DRAFT, type Range } from "../../src/renderer/comments";

function stateOf(md: string): EditorState {
  return EditorState.create({ doc: parseMarkdown(md).doc, plugins: [commentPlugin()] });
}

function rangeOf(doc: Node, find: string, nth = 0): Range {
  const hits: number[] = [];
  doc.descendants((node, pos) => {
    if (node.isText) for (let i = node.text!.indexOf(find); i >= 0; i = node.text!.indexOf(find, i + 1)) hits.push(pos + i);
  });
  return { from: hits[nth], to: hits[nth] + find.length };
}

const apply = (state: EditorState, tr: Transaction) => state.apply(tr);
const textOf = (state: EditorState, id: string) => {
  const r = commentRanges(state).ranges.get(id);
  return r ? state.doc.textBetween(r.from, r.to, "\n") : null;
};
/** The highlights drawn, as [comment, class]. */
const drawn = (state: EditorState) =>
  commentRanges(state)
    .decorations.find()
    .map((d) => [d.spec.id, (d as unknown as { type: { attrs: { class: string } } }).type.attrs.class]);

function withComment(state: EditorState, id: string, text: string, shown = true): EditorState {
  return apply(state, withRanges(state.tr, { type: "add", id, range: rangeOf(state.doc, text), shown }));
}

describe("keeping comments on their text while the document is open", () => {
  it("a comment moves with text typed before it", () => {
    let state = withComment(stateOf("We should hire two people.\n"), "c1", "hire");
    state = apply(state, state.tr.insertText("Next year, ", 1));
    expect(textOf(state, "c1")).toBe("hire");
    expect(commentRanges(state).ranges.get("c1")!.from).toBe(rangeOf(state.doc, "hire").from);
  });

  it("text typed right before or right after the commented words stays outside the comment", () => {
    let state = withComment(stateOf("We should hire two people.\n"), "c1", "hire");
    const { from, to } = commentRanges(state).ranges.get("c1")!;
    state = apply(state, state.tr.insertText("X", to));
    state = apply(state, state.tr.insertText("Y", from));
    expect(textOf(state, "c1")).toBe("hire");
  });

  it("text typed inside the commented words joins the comment", () => {
    let state = withComment(stateOf("We should hire two people.\n"), "c1", "two people");
    const { from } = commentRanges(state).ranges.get("c1")!;
    state = apply(state, state.tr.insertText(" more", from + 3));
    expect(textOf(state, "c1")).toBe("two more people");
  });

  it("deleting the commented words loses the comment's place, and says which", () => {
    let state = withComment(stateOf("Keep this. Remove me. Keep that.\n"), "c1", "Remove me.");
    const { from, to } = commentRanges(state).ranges.get("c1")!;
    state = apply(state, state.tr.delete(from, to));
    expect(commentRanges(state).ranges.has("c1")).toBe(false);
    expect(commentRanges(state).lost).toEqual(["c1"]);
    expect(drawn(state)).toEqual([]);
    // The next change doesn't report it again.
    state = apply(state, state.tr.insertText("!", 1));
    expect(commentRanges(state).lost).toEqual([]);
  });

  it("typing over the commented words keeps the comment on the new words", () => {
    let state = withComment(stateOf("Launch in March.\n"), "c1", "March");
    const { from, to } = commentRanges(state).ranges.get("c1")!;
    state = apply(state, state.tr.insertText("April", from, to));
    expect(textOf(state, "c1")).toBe("April");
  });

  /** Type as a person does: the first key replaces the selection, the rest go in one by one at the cursor. */
  function typeOver(state: EditorState, from: number, to: number, text: string): EditorState {
    state = apply(state, state.tr.setSelection(TextSelection.create(state.doc, from, to)));
    for (const ch of text) state = apply(state, state.tr.insertText(ch));
    return state;
  }

  it("typing over the commented words key by key keeps the comment on every new word, not just the first letter", () => {
    let state = withComment(stateOf("Launch in March this year.\n"), "c1", "March");
    const { from, to } = commentRanges(state).ranges.get("c1")!;
    state = typeOver(state, from, to, "early April");
    expect(textOf(state, "c1")).toBe("early April");
    // Backspace while still typing there takes letters off the comment's words, as expected.
    state = apply(state, state.tr.delete(state.selection.from - 1, state.selection.from));
    expect(textOf(state, "c1")).toBe("early Apri");
  });

  it("typing over the end of the commented words keeps typing inside the comment", () => {
    let state = withComment(stateOf("We should hire two people.\n"), "c1", "two people");
    const r = rangeOf(state.doc, "people");
    state = typeOver(state, r.from, r.to, "engineers");
    expect(textOf(state, "c1")).toBe("two engineers");
  });

  it("once the cursor moves away, typing at the comment's edge stays outside it again", () => {
    let state = withComment(stateOf("Launch in March this year.\n"), "c1", "March");
    const { from, to } = commentRanges(state).ranges.get("c1")!;
    state = typeOver(state, from, to, "April");
    const end = commentRanges(state).ranges.get("c1")!.to;
    state = apply(state, state.tr.setSelection(TextSelection.create(state.doc, 1)));
    state = apply(state, state.tr.setSelection(TextSelection.create(state.doc, end)));
    state = apply(state, state.tr.insertText("!"));
    expect(textOf(state, "c1")).toBe("April");
  });
});

describe("highlights", () => {
  it("only open comments are highlighted, and the one in focus is drawn stronger", () => {
    let state = stateOf("Alpha beta gamma.\n");
    state = withComment(state, "open", "beta");
    state = withComment(state, "resolved", "gamma", false);
    expect(drawn(state)).toEqual([["open", "comment-range"]]);
    state = apply(state, withRanges(state.tr, { type: "active", id: "open" }));
    expect(drawn(state)).toEqual([["open", "comment-range active"]]);
    // Reopening a resolved comment highlights it again, in its place.
    state = apply(state, withRanges(state.tr, { type: "shown", id: "resolved", on: true }));
    expect(drawn(state).map(([id]) => id)).toEqual(["open", "resolved"]);
    state = apply(state, withRanges(state.tr, { type: "shown", id: "open", on: false }));
    expect(commentRanges(state).active).toBeNull();
    expect(drawn(state)).toEqual([["resolved", "comment-range"]]);
  });

  it("moving the cursor into highlighted text puts its comment in focus, and out of it takes focus away", () => {
    let state = withComment(stateOf("Alpha beta gamma.\n"), "c1", "beta");
    const { from } = commentRanges(state).ranges.get("c1")!;
    state = apply(state, state.tr.setSelection(TextSelection.create(state.doc, from + 2)));
    expect(commentRanges(state).active).toBe("c1");
    expect(commentRanges(state).revealed).toBe(true);
    state = apply(state, state.tr.setSelection(TextSelection.create(state.doc, 1)));
    expect(commentRanges(state).active).toBeNull();
  });

  it("the draft is drawn as a draft, and becomes the posted comment in the same place", () => {
    let state = stateOf("Some words to comment on.\n");
    state = apply(
      state,
      withRanges(state.tr, { type: "add", id: DRAFT, range: rangeOf(state.doc, "words"), shown: true }, { type: "active", id: DRAFT }),
    );
    expect(drawn(state)).toEqual([[DRAFT, "comment-range draft"]]);
    state = apply(state, withRanges(state.tr, { type: "rename", from: DRAFT, to: "posted" }));
    expect(textOf(state, "posted")).toBe("words");
    expect(commentRanges(state).active).toBe("posted");
    expect(drawn(state)).toEqual([["posted", "comment-range active"]]);
  });

  it("starting again from saved places replaces every range", () => {
    let state = withComment(stateOf("One two three.\n"), "old", "One");
    state = apply(state, withRanges(state.tr, { type: "reset", ranges: { a: rangeOf(state.doc, "two") }, shown: ["a"] }));
    expect([...commentRanges(state).ranges.keys()]).toEqual(["a"]);
    expect(drawn(state)).toEqual([["a", "comment-range"]]);
  });
});

describe("many comments in a long document", () => {
  const paragraphs = Array.from({ length: 3000 }, (_, i) => `Paragraph ${i} says something worth reading about topic ${i}.`);
  const md = paragraphs.join("\n\n") + "\n";

  it("anchoring them with one read of the text gives the same result as one at a time", () => {
    const doc = parseMarkdown(md).doc;
    const index = textIndex(doc);
    for (const i of [0, 7, 1500, 2999]) {
      const r = rangeOf(doc, `topic ${i}.`);
      const shared = anchorFor(doc, r.from, r.to, index);
      expect(shared).toEqual(anchorFor(doc, r.from, r.to));
      expect(findAnchor(doc, shared, index)).toEqual(findAnchor(doc, shared));
    }
  });

  it("typing stays quick with hundreds of comments: their places are carried along, not searched for", () => {
    let state = stateOf(md);
    const ranges: Record<string, Range> = {};
    for (let i = 0; i < 3000; i += 10) ranges[`c${i}`] = rangeOf(state.doc, `topic ${i}.`);
    state = apply(state, withRanges(state.tr, { type: "reset", ranges, shown: Object.keys(ranges) }));
    const start = performance.now();
    for (let k = 0; k < 200; k++) state = apply(state, state.tr.insertText("x", 1));
    const elapsed = performance.now() - start;
    expect(textOf(state, "c2990")).toBe("topic 2990.");
    expect(commentRanges(state).ranges.size).toBe(300);
    expect(elapsed).toBeLessThan(2000);
  });
});
