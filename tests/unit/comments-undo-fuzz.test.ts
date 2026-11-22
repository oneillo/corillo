// Undo and Redo of the person's own typing beside or inside a comment leave
// the comment on its words (review of Batch 6, B6-R01). Before the fix,
// Corillo re-placed every comment near an Undo or Redo the way it does after
// an agent's rewrite, comparing whole words, and over-ruled the editor, which
// had it right: Command-Z after typing "s" just after "three people" left the
// comment on "three ". Random documents, comments and small edits (a letter
// or a few typed, deleted or typed over, just before, just after or inside a
// comment's words), with fixed seeds, so a failure always comes back the same.
// Each edit is taken back with Undo and put in again with Redo, as the window
// does it: the editor's steps, then what Corillo does after a history step
// (the panel's own rule, carryThroughHistory, called as it is: S21-29).
import { describe, expect, it } from "vitest";
import { EditorState, type Transaction } from "prosemirror-state";
import { history, redo, undo } from "prosemirror-history";
import type { Node } from "prosemirror-model";
import type { EditorView } from "prosemirror-view";
import { parseMarkdown } from "../../src/core/markdown";
import type { KeptPlaces } from "../../src/core/options";
import { commentPlugin, commentRanges, withRanges } from "../../src/renderer/comments";
import { carryThroughHistory } from "../../src/renderer/comments-panel-places";

function random(seed: number) {
  let s = seed;
  const rnd = () => (s = (s * 1103515245 + 12345) & 0x7fffffff) / 0x7fffffff;
  const below = (n: number) => Math.floor(rnd() * n);
  const pick = <T>(a: readonly T[]) => a[below(a.length)];
  return { rnd, below, pick };
}

const WORDS = ["we", "should", "hire", "three", "people", "this", "quarter", "the", "budget", "is", "tight", "plan", "team", "next", "year", "board", "report"];
const LETTERS = "abcdefghijklmnopqrstuvwxyz";

/** Where each comment is, as [id, from, to]. */
const places = (state: EditorState) => [...commentRanges(state).ranges].map(([id, r]) => [id, r.from, r.to]).sort();

/** A view that only holds a state and applies each change sent to it. */
function viewOn(state: EditorState): EditorView {
  const view = {
    state,
    dispatch(tr: Transaction) {
      view.state = view.state.apply(tr);
    },
  };
  return view as unknown as EditorView;
}

/**
 * Run a history command (Undo or Redo) as the window does: the editor's step,
 * then the panel's rule after it (comments-panel.ts's afterTransaction calls
 * carryThroughHistory): comments put back where a choice's text had them, if
 * it's that text again. `kept` stands in for the last few choices'.
 */
function step(state: EditorState, command: typeof undo, kept: KeptPlaces<Node>[]): EditorState {
  let tr: Transaction | null = null;
  command(state, (t) => (tr = t));
  if (!tr) throw new Error("nothing to undo or redo");
  const view = viewOn(state.apply(tr));
  carryThroughHistory(view, tr, { doc: state.doc, value: commentRanges(state) }, kept);
  return view.state;
}

/** A paragraph or two of words, with up to three comments on runs of words that don't overlap. */
function setUp(r: ReturnType<typeof random>): EditorState {
  const paragraphs = Array.from({ length: 1 + r.below(2) }, () => Array.from({ length: 8 + r.below(10) }, () => r.pick(WORDS)).join(" ") + ".");
  const doc = parseMarkdown(paragraphs.join("\n\n") + "\n").doc;
  let state = EditorState.create({ doc, plugins: [history(), commentPlugin()] });
  // Word boundaries in the first paragraph's text.
  const text = doc.firstChild!.textContent;
  const starts: number[] = [];
  for (let i = 0; i < text.length; i++) if (text[i] !== " " && (i === 0 || text[i - 1] === " ")) starts.push(i);
  const used = new Set<number>();
  for (let c = 0; c < 1 + r.below(3); c++) {
    const w = r.below(starts.length - 2);
    const length = 1 + r.below(3);
    if ([...Array(length + 2).keys()].some((k) => used.has(w - 1 + k))) continue;
    for (let k = 0; k < length; k++) used.add(w + k);
    const from = 1 + starts[w];
    const endWord = starts[w + length] ?? text.length + 1;
    const to = 1 + endWord - 1; // up to the space after its last word
    state = state.apply(withRanges(state.tr, { type: "add", id: `c${c}`, range: { from, to }, shown: true }));
  }
  return state;
}

/** A small edit next to or inside one comment's words, never across its edge: a letter or a few typed, deleted, or typed over. */
function edit(state: EditorState, r: ReturnType<typeof random>): Transaction | null {
  const ranges = [...commentRanges(state).ranges.values()];
  if (!ranges.length) return null;
  const c = r.pick(ranges);
  const typed = Array.from({ length: 1 + r.below(3) }, () => LETTERS[r.below(LETTERS.length)]).join("");
  const where = r.pick(["before", "after", "inside"] as const);
  const kind = r.pick(["type", "delete", "over"] as const);
  const size = 1 + r.below(2);
  const paragraph = state.doc.resolve(c.from);
  const [lo, hi] = [paragraph.start(), paragraph.end()];
  let from: number;
  let to: number;
  if (kind === "type") {
    from = to = where === "before" ? c.from : where === "after" ? c.to : c.from + 1 + r.below(Math.max(1, c.to - c.from - 1));
    if (from <= c.from && where === "inside") return null;
  } else if (where === "before") {
    [from, to] = [c.from - size, c.from];
  } else if (where === "after") {
    [from, to] = [c.to, c.to + size];
  } else {
    // Inside, leaving at least a letter of the comment's words.
    if (c.to - c.from <= size + 1) return null;
    from = c.from + 1 + r.below(c.to - c.from - size - 1);
    to = from + size;
  }
  if (from < lo || to > hi) return null;
  // Not into another comment's words.
  if (ranges.some((o) => o !== c && from < o.to && to > o.from)) return null;
  const tr = state.tr;
  if (kind === "delete" && from < to) tr.delete(from, to);
  else tr.insertText(typed, from, to);
  return tr;
}

describe("Undo and Redo of the person's typing beside or inside a comment (B6-R01)", () => {
  it("a letter typed just after or just before a comment's words, then Command-Z: the comment is on its words", () => {
    const doc = parseMarkdown("We should hire three people this quarter.\n").doc;
    let state = EditorState.create({ doc, plugins: [history(), commentPlugin()] });
    const at = doc.textContent.indexOf("three people") + 1;
    state = state.apply(withRanges(state.tr, { type: "add", id: "c", range: { from: at, to: at + "three people".length }, shown: true }));
    const words = (s: EditorState) => {
      const r = commentRanges(s).ranges.get("c")!;
      return s.doc.textBetween(r.from, r.to);
    };
    for (const pos of [at + "three people".length, at]) {
      let s = state.apply(state.tr.insertText(pos === at ? "x" : "s", pos));
      expect(words(s)).toBe("three people");
      s = step(s, undo, []);
      expect(s.doc.eq(doc)).toBe(true);
      expect(words(s)).toBe("three people");
      s = step(s, redo, []);
      expect(words(s)).toBe("three people");
    }
  });

  it("random small edits beside and inside comments, then Undo, leave every comment where it started; Redo, where the edit left it", () => {
    let tried = 0;
    for (let seed = 1; seed <= 1500; seed++) {
      const r = random(seed);
      const state = setUp(r);
      const tr = edit(state, r);
      if (!tr) continue;
      tried++;
      const edited = state.apply(tr);
      const undone = step(edited, undo, []);
      expect(undone.doc.eq(state.doc), `seed ${seed}`).toBe(true);
      expect(places(undone), `seed ${seed}: after Undo`).toEqual(places(state));
      const redone = step(undone, redo, []);
      expect(redone.doc.eq(edited.doc), `seed ${seed}`).toBe(true);
      expect(places(redone), `seed ${seed}: after Redo`).toEqual(places(edited));
    }
    expect(tried).toBeGreaterThan(800);
  });

  it("a step back to a choice's text still puts its comments back where they were then", () => {
    const doc = parseMarkdown("We should hire three people this quarter.\n").doc;
    let state = EditorState.create({ doc, plugins: [history(), commentPlugin()] });
    const at = doc.textContent.indexOf("three people") + 1;
    state = state.apply(withRanges(state.tr, { type: "add", id: "c", range: { from: at, to: at + 12 }, shown: true }));
    const kept: KeptPlaces<Node>[] = [{ doc, ranges: commentRanges(state).ranges }];
    // The editor's own steps leave the comment on one letter; the choice's text says where it was.
    const edited = state.apply(state.tr.insertText("Hire three", 1, at + 12));
    const odd = edited.apply(withRanges(edited.tr, { type: "add", id: "c", range: { from: 6, to: 7 }, shown: true }));
    const undone = step(odd, undo, kept);
    expect(places(undone)).toEqual([["c", at, at + 12]]);
  });
});
