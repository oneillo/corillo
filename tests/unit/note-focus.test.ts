// The card in focus through a page made afresh (Batch 22, item 5b, S21-30, his
// call). When the page is made again from text (a version restored, the file
// read again), findEvery (src/renderer/comments-panel-places.ts) is told which
// card was in focus: a comment (`active`) or an agent's note (`selected`, with
// no comment active). Both stay in focus, as a comment card always has.
import { describe, expect, it } from "vitest";
import { EditorState, type Transaction } from "prosemirror-state";
import type { EditorView } from "prosemirror-view";
import { anchorFor } from "../../src/core/anchors";
import type { Thread } from "../../src/core/comments";
import { parseMarkdown } from "../../src/core/markdown";
import { changeMarks, changePlugin } from "../../src/renderer/change-marks";
import { commentPlugin, commentRanges } from "../../src/renderer/comments";
import { findEvery } from "../../src/renderer/comments-panel-places";

const TEXT = "We should hire three people this quarter.\n\nThe budget is tight next year.\n";

/** A fresh editor state, as the page made afresh has, in a stand-in view that applies what it's sent. */
function viewOf(markdown: string): EditorView {
  const doc = parseMarkdown(markdown).doc;
  const view = {
    state: EditorState.create({ doc, plugins: [commentPlugin(), changePlugin()] }),
    dispatch(tr: Transaction) {
      view.state = view.state.apply(tr);
    },
  };
  return view as unknown as EditorView;
}

function thread(id: string, view: EditorView, words: string): Thread {
  let found: { from: number; to: number } | null = null;
  view.state.doc.descendants((node, pos) => {
    if (found || !node.isText) return !found;
    const at = node.text!.indexOf(words);
    if (at >= 0) found = { from: pos + at, to: pos + at + words.length };
    return false;
  });
  if (!found) throw new Error(`no "${words}"`);
  const { from, to } = found;
  return { id, anchor: anchorFor(view.state.doc, from, to), to: null, status: "open", messages: [] };
}

const focusOf = (view: EditorView) => ({ active: commentRanges(view.state).active, selected: changeMarks(view.state).selected });

describe("the card in focus, through a page made afresh", () => {
  it("an agent's note in focus before is in focus after", () => {
    const view = viewOf(TEXT);
    expect(focusOf(view)).toEqual({ active: null, selected: null }); // a fresh state: nothing in focus yet
    findEvery(view, [], null, { active: null, selected: "note-1" }, new Set(), new Set());
    expect(focusOf(view)).toEqual({ active: null, selected: "note-1" });
  });

  it("an agent's note stays in focus beside comments that are found again", () => {
    const view = viewOf(TEXT);
    const a = thread("a", view, "three people");
    findEvery(view, [a], null, { active: null, selected: "note-1" }, new Set(), new Set());
    expect(focusOf(view)).toEqual({ active: null, selected: "note-1" });
    expect(commentRanges(view.state).ranges.has("a")).toBe(true);
  });

  it("a comment in focus still is, as before", () => {
    const view = viewOf(TEXT);
    const a = thread("a", view, "three people");
    findEvery(view, [a], null, { active: "a", selected: "a" }, new Set(), new Set());
    expect(focusOf(view)).toEqual({ active: "a", selected: "a" });
  });

  it("a comment in focus that is gone leaves nothing in focus, not a stale card", () => {
    const view = viewOf(TEXT);
    findEvery(view, [], null, { active: "gone", selected: "gone" }, new Set(), new Set());
    expect(focusOf(view)).toEqual({ active: null, selected: null });
  });

  it("nothing in focus stays so", () => {
    const view = viewOf(TEXT);
    findEvery(view, [thread("a", view, "budget")], null, { active: null, selected: null }, new Set(), new Set());
    expect(focusOf(view)).toEqual({ active: null, selected: null });
    findEvery(view, [], null, null, new Set(), new Set());
    expect(focusOf(view)).toEqual({ active: null, selected: null });
  });
});
