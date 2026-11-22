// Keeping comments on their words (src/renderer/comments-panel-places.ts),
// now plain functions over the editor's document and the comments: tried
// here on an editor state with no window, through a stand-in for the view
// that applies what it's sent.
import { describe, expect, it } from "vitest";
import { EditorState, type Transaction } from "prosemirror-state";
import { history, undo } from "prosemirror-history";
import type { Node } from "prosemirror-model";
import type { EditorView } from "prosemirror-view";
import { anchorFor } from "../../src/core/anchors";
import type { Thread } from "../../src/core/comments";
import { parseMarkdown } from "../../src/core/markdown";
import type { KeptPlaces } from "../../src/core/options";
import { changeMarks, changePlugin, withChanges } from "../../src/renderer/change-marks";
import { commentPlugin, commentRanges, DRAFT, withRanges } from "../../src/renderer/comments";
import { carryThroughHistory, findEvery, placeGaps, placesToTell, putBack, refindLost, sameAnchor } from "../../src/renderer/comments-panel-places";

/** A view that only holds a state and applies each change sent to it. */
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

/** Where some words are in the view's document (their first time). */
function placeOf(view: EditorView, words: string): { from: number; to: number } {
  let found: { from: number; to: number } | null = null;
  view.state.doc.descendants((node, pos) => {
    if (found || !node.isText) return !found;
    const at = node.text!.indexOf(words);
    if (at >= 0) found = { from: pos + at, to: pos + at + words.length };
    return false;
  });
  if (!found) throw new Error(`no "${words}"`);
  return found;
}

function thread(id: string, view: EditorView, words: string): Thread {
  const { from, to } = placeOf(view, words);
  return { id, anchor: anchorFor(view.state.doc, from, to), to: null, status: "open", messages: [] };
}

const TEXT = "We should hire three people this quarter, as the plan for the whole of next year says.\n\nThe budget is tight next year.\n";

describe("keeping comments on their words, without a window", () => {
  it("finds every comment again, and says which it couldn't", () => {
    const view = viewOf(TEXT);
    const a = thread("a", view, "three people");
    const b = thread("b", view, "budget");
    const gone: Thread = { ...thread("c", view, "tight"), anchor: { quote: "nowhere to be seen", prefix: "", suffix: "", offset: 0 } };
    const notFound = new Set<string>(["stale"]);
    const regained = new Set<string>();
    findEvery(view, [a, b, gone], null, null, regained, notFound);
    const ranges = commentRanges(view.state).ranges;
    expect(view.state.doc.textBetween(ranges.get("a")!.from, ranges.get("a")!.to)).toBe("three people");
    expect(view.state.doc.textBetween(ranges.get("b")!.from, ranges.get("b")!.to)).toBe("budget");
    expect(ranges.has("c")).toBe(false);
    expect([...notFound]).toEqual(["c"]);
    expect(regained.size).toBe(0);
  });

  it("finds the comment being written too, and keeps it in focus", () => {
    const view = viewOf(TEXT);
    const { from, to } = placeOf(view, "next year");
    findEvery(view, [], { anchored: true, anchor: anchorFor(view.state.doc, from, to) }, { active: DRAFT, selected: null }, new Set(), new Set());
    const value = commentRanges(view.state);
    expect(value.ranges.get(DRAFT)).toEqual({ from, to });
    expect(value.active).toBe(DRAFT);
  });

  it("tells only the comments whose place moved, and one that lost its words", () => {
    const view = viewOf(TEXT);
    const a = thread("a", view, "three people");
    const b = thread("b", view, "budget");
    findEvery(view, [a, b], null, null, new Set(), new Set());
    // Typing at the start of the second paragraph, out of reach of the words either side of "three people", moves only "budget".
    view.dispatch(view.state.tr.insertText("So ", placeOf(view, "The budget").from));
    let told = placesToTell(view, [a, b], new Set());
    expect(Object.keys(told.changes)).toEqual(["b"]);
    expect(told.any).toBe(true);
    expect(told.requote).toBe(false);
    expect(sameAnchor(told.threads[0].anchor, a.anchor)).toBe(true);
    expect(told.threads[1].anchor?.quote).toBe("budget");
    // "three people" deleted: the comment is told where they were, for its empty line.
    const { from, to } = placeOf(view, "three people");
    view.dispatch(view.state.tr.delete(from, to));
    told = placesToTell(view, told.threads, new Set());
    expect(told.changes.a).toMatchObject({ gap: { quote: "", prefix: "We should hire " } });
    expect(told.threads[0].detached).toBe(true);
    expect(told.threads[0].gap?.prefix).toBe("We should hire ");
  });

  it("finds a comment that lost its words once a change puts them back", () => {
    const view = viewOf(TEXT);
    const a = thread("a", view, "budget");
    // Its words are taken out; the editor no longer has it.
    const was = placeOf(view, "budget");
    view.dispatch(withRanges(view.state.tr.delete(was.from, was.to), { type: "remove", id: "a" }));
    const notFound = new Set(["a"]);
    // Text put in elsewhere, without its words: not found.
    view.dispatch(view.state.tr.insertText("plan ", was.from));
    expect(refindLost(view, [a], [{ from: was.from, to: was.from + 5 }], new Set(), notFound)).toBe(false);
    // Its words put back: found on them.
    view.dispatch(view.state.tr.insertText("budget ", was.from));
    expect(refindLost(view, [a], [{ from: was.from, to: was.from + 7 }], new Set(), notFound)).toBe(true);
    const range = commentRanges(view.state).ranges.get("a")!;
    expect(view.state.doc.textBetween(range.from, range.to)).toBe("budget");
    expect(notFound.has("a")).toBe(false);
  });
});

// The review of Batch 21, S21-29: the place functions the panel calls after a
// change, each called as it is.
describe("putting comments back after a change, without a window", () => {
  it("after Undo, puts a comment back where a choice's text had it, but not with places from another document", () => {
    const doc = parseMarkdown("We should hire three people this quarter.\n").doc;
    let state = EditorState.create({ doc, plugins: [history(), commentPlugin(), changePlugin()] });
    const at = doc.textContent.indexOf("three people") + 1;
    state = state.apply(withRanges(state.tr, { type: "add", id: "c", range: { from: at, to: at + 12 }, shown: true }));
    const kept: KeptPlaces<Node>[] = [{ doc, ranges: commentRanges(state).ranges }];
    // A choice rewrote the words; the editor's own steps leave the comment on one letter, and its Undo loses it.
    const edited = state.apply(state.tr.insertText("Hire three", 1, at + 12));
    const odd = edited.apply(withRanges(edited.tr, { type: "add", id: "c", range: { from: 6, to: 7 }, shown: true }));
    const undoOf = (s: EditorState) => {
      let tr: Transaction | null = null;
      undo(s, (t) => (tr = t));
      return tr as unknown as Transaction;
    };
    const place = (view: EditorView) => {
      const r = commentRanges(view.state).ranges.get("c");
      return r ? [r.from, r.to] : null;
    };
    for (const fromThisDoc of [false, true]) {
      const view = { state: odd, dispatch: (tr: Transaction) => (view.state = view.state.apply(tr)) };
      const tr = undoOf(odd);
      view.dispatch(tr);
      expect(place(view as unknown as EditorView)).toBe(null);
      const were = fromThisDoc ? odd.doc : parseMarkdown("Something else.\n").doc;
      expect(carryThroughHistory(view as unknown as EditorView, tr, { doc: were, value: commentRanges(odd) }, kept)).toBe(fromThisDoc);
      expect(place(view as unknown as EditorView)).toEqual(fromThisDoc ? [at, at + 12] : null);
    }
  });

  it("puts a comment whose words were deleted back on them when the same words are put back, not when others are", () => {
    const view = viewOf(TEXT);
    const a = thread("a", view, "budget");
    const was = placeOf(view, "budget");
    // Its words are taken out: the editor no longer has it, and an empty line keeps their place.
    view.dispatch(withChanges(withRanges(view.state.tr.delete(was.from, was.to), { type: "remove", id: "a" }), { type: "gap", id: "a", gap: { pos: was.from, text: "budget" } }));
    const notFound = new Set(["a"]);
    const typed = view.state.tr.insertText("plan", was.from);
    view.dispatch(typed);
    expect(putBack(view, typed, [a], new Map(), new Set(), notFound)).toBe(false);
    const pasted = view.state.tr.insertText("budget", was.from);
    view.dispatch(pasted);
    expect(putBack(view, pasted, [a], new Map(), new Set(), notFound)).toBe(true);
    const range = commentRanges(view.state).ranges.get("a")!;
    expect(view.state.doc.textBetween(range.from, range.to)).toBe("budget");
    expect(notFound.has("a")).toBe(false);
  });

  it("keeps an empty line where an open comment's words were, and none once it's resolved", () => {
    const view = viewOf(TEXT);
    const a = thread("a", view, "budget");
    const was = placeOf(view, "budget");
    view.dispatch(view.state.tr.delete(was.from, was.to));
    const gone: Thread = { ...a, gap: anchorFor(view.state.doc, was.from, was.from) };
    placeGaps(view, [gone]);
    expect(changeMarks(view.state).gaps.get("a")).toEqual({ pos: was.from, text: "budget" });
    placeGaps(view, [{ ...gone, status: "resolved" }]);
    expect(changeMarks(view.state).gaps.has("a")).toBe(false);
  });
});
