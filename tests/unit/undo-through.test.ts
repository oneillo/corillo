// The person's Undo after a change someone else made (an agent's, or another
// app's), arriving as an edit (roadmap Batch 7, item 2). As in Word: Undo
// never undoes the other's change, and the person's own steps from before it
// can still be undone, each taking back just what it did. A step whose words
// the change touched isn't forced: Undo stops there. The change is made the
// way the window makes it (editTo, as an edit that isn't for Undo), and Undo
// and Redo are ProseMirror's own. Random documents, edits and changes with
// fixed seeds check that no Undo or Redo ever reaches into what the change
// wrote, or where it took words out.
import { describe, expect, it } from "vitest";
import { EditorState, TextSelection, type Transaction } from "prosemirror-state";
import { history, redo, redoDepth, undo, undoDepth } from "prosemirror-history";
import type { Node } from "prosemirror-model";
import { parseMarkdown, serializeMarkdown } from "../../src/core/markdown";
import { editTo } from "../../src/core/smallest-edit";
import { keptThrough, meets, undoThrough, type Kept, type Stretch } from "../../src/core/undo-through";
import { schema } from "../../src/core/schema";

const PLAN = ["# Plan", "We should hire two people this quarter.", "## Budget", "The budget is tight.", "## Risks", "Hiring takes long."].join("\n\n") + "\n";

let clock = 0;

/** A document in an editor with Undo, as the page has it. */
function open(text: string): EditorState {
  return EditorState.create({ doc: parseMarkdown(text).doc, plugins: [history()] });
}

/** The person's own edit, an Undo step of its own (a moment after the last). */
function person(state: EditorState, build: (tr: Transaction) => Transaction): EditorState {
  clock += 1000;
  return state.apply(build(state.tr).setTime(clock));
}

/** Where words are in the document (the first time they appear), from..to. */
function find(doc: Node, words: string): Stretch {
  let found: Stretch | null = null;
  doc.descendants((node, pos) => {
    if (found || !node.isText) return !found;
    const at = node.text!.indexOf(words);
    if (at >= 0) found = { from: pos + at, to: pos + at + words.length };
    return false;
  });
  if (!found) throw new Error(`"${words}" isn't in the document`);
  return found;
}

const typeAfter = (words: string, typed: string) => (state: EditorState) => person(state, (tr) => tr.insertText(typed, find(state.doc, words).to));
const deleteWords = (words: string) => (state: EditorState) => person(state, (tr) => tr.delete(find(state.doc, words).from, find(state.doc, words).to));

/** Someone else's change: the document brought to this text as the window does it, not for Undo. Also where its words are now. */
function change(state: EditorState, text: string): { state: EditorState; wrote: Stretch[] } {
  const tr = state.tr;
  const edit = editTo(tr, parseMarkdown(text), text);
  if (!edit) throw new Error("the change couldn't be made as an edit");
  tr.setMeta("addToHistory", false);
  undoThrough(tr, state, edit.changed);
  // Where each stretch it replaced is now: what it wrote there.
  const wrote = edit.changed.map((c) => ({ from: tr.mapping.map(c.from, -1), to: tr.mapping.map(c.to, 1) }));
  return { state: state.apply(tr), wrote };
}

/** Undo (or Redo), as the person presses it; null when there's nothing to take back. */
function press(state: EditorState, command: typeof undo): { state: EditorState; tr: Transaction } | null {
  let tr: Transaction | null = null;
  if (!command(state, (t) => (tr = t)) || !tr) return null;
  return { state: state.apply(tr), tr };
}

const text = (state: EditorState) => serializeMarkdown(state.doc, parseMarkdown("").source);

describe("Undo after someone else's change", () => {
  it("takes back the person's own edits from before it, one by one, and leaves the change; Redo puts them back", () => {
    let state = open(PLAN);
    state = typeAfter("tight.", " Mine.")(state);
    state = typeAfter("takes long.", " More.")(state);
    const agents = PLAN.replace("two people", "three people").replace("tight.", "tight. Mine.").replace("long.", "long. More.");
    state = change(state, agents).state;
    expect(text(state)).toBe(agents);
    expect(undoDepth(state)).toBe(2);
    state = press(state, undo)!.state;
    expect(text(state)).toBe(agents.replace(" More.", ""));
    state = press(state, undo)!.state;
    expect(text(state)).toBe(PLAN.replace("two people", "three people"));
    expect(press(state, undo)).toBeNull();
    state = press(state, redo)!.state;
    state = press(state, redo)!.state;
    expect(text(state)).toBe(agents);
  });

  it("stops at an edit whose words the change rewrote: never puts the old words back, nor takes the change's out", () => {
    let state = open(PLAN);
    state = typeAfter("tight.", " Mine.")(state);
    state = typeAfter("takes long.", " More.")(state);
    // The change rewrites the person's older edit: the newer one can still be undone, then Undo stops.
    const agents = PLAN.replace("The budget is tight.", "The budget is set, so we wait.").replace("long.", "long. More.");
    state = change(state, agents).state;
    expect(undoDepth(state)).toBe(1);
    state = press(state, undo)!.state;
    expect(text(state)).toBe(agents.replace(" More.", ""));
    expect(press(state, undo)).toBeNull();
    expect(text(state)).toContain("The budget is set, so we wait.");
  });

  it("stops straight away when the change rewrote the person's last edit, even with earlier ones clear of it", () => {
    let state = open(PLAN);
    state = typeAfter("tight.", " Mine.")(state);
    state = typeAfter("takes long.", " More.")(state);
    const agents = PLAN.replace("tight.", "tight. Mine.").replace("Hiring takes long.", "Hiring takes three months.");
    state = change(state, agents).state;
    expect(undoDepth(state)).toBe(0);
    expect(press(state, undo)).toBeNull();
    expect(text(state)).toBe(agents);
  });

  it("words the person deleted come back, beside the change's words, never in place of them", () => {
    let state = open(PLAN);
    state = deleteWords(" this quarter")(state);
    // The change rewrites the words just before where the person deleted.
    const agents = PLAN.replace("two people this quarter.", "three people.");
    state = change(state, agents).state;
    expect(undoDepth(state)).toBe(1);
    state = press(state, undo)!.state;
    expect(text(state)).toContain("We should hire three people this quarter.");
    // But where the change took out words around the place, they don't come back.
    let other = open(PLAN);
    other = deleteWords(" this")(other);
    other = change(other, PLAN.replace("two people this quarter.", "three.")).state;
    expect(undoDepth(other)).toBe(0);
  });

  it("the person's next edit after the change is an Undo step of its own", () => {
    let state = open(PLAN);
    state = typeAfter("tight.", " Mine.")(state);
    state = change(state, PLAN.replace("tight.", "tight. Mine.").replace("two", "three")).state;
    // Straight after, within the moment that would join it to the edit before.
    state = state.apply(state.tr.insertText("!", find(state.doc, "Mine.").to).setTime(clock + 10));
    state = press(state, undo)!.state;
    expect(text(state)).toContain("tight. Mine.\n");
    state = press(state, undo)!.state;
    expect(text(state)).toContain("tight.\n");
  });

  it("many changes after one edit of the person's don't grow the history without end, and Undo still takes the edit back", () => {
    // Each change leaves a note in the history of where it moved things, so the person's steps from before it can
    // be carried through; a tab that takes change after change (a long agent session, a file another app rewrites
    // every few seconds) once kept them all, for good, and each Undo went through every one (review of Batch 7, B7-R03).
    const items = (state: EditorState) => {
      const kept = history().spec.key!.getState(state) as { done: { items: { length: number } }; undone: { items: { length: number } } };
      return { done: kept.done.items.length, undone: kept.undone.items.length };
    };
    let state = open(PLAN);
    state = typeAfter("takes long.", " More.")(state);
    const mine = PLAN.replace("long.", "long. More.");
    const other = (i: number) => mine.replace("two people", `${i} people`);
    let most = 0;
    for (let i = 0; i < 2000; i++) {
      state = change(state, other(i + 3)).state;
      most = Math.max(most, items(state).done);
    }
    expect(most).toBeLessThan(600);
    expect(undoDepth(state)).toBe(1);
    state = press(state, undo)!.state;
    expect(text(state)).toBe(other(2002).replace(" More.", ""));
    // And Redo's side, with a step in it, the same.
    for (let i = 0; i < 2000; i++) {
      state = change(state, other(i + 3).replace(" More.", "")).state;
      most = Math.max(most, items(state).undone);
    }
    expect(most).toBeLessThan(600);
    expect(redoDepth(state)).toBe(1);
    state = press(state, redo)!.state;
    expect(text(state)).toBe(other(2002));
  });

  it("a step that reaches no place in particular counts as touching every change", () => {
    expect(meets({ from: 0, to: Infinity }, { from: 40, to: 41 })).toBe(true);
    expect(meets({ from: 5, to: 9 }, { from: 9, to: 12 })).toBe(false); // side by side
    expect(meets({ from: 9, to: 9 }, { from: 5, to: 12 })).toBe(true); // a place inside
    expect(meets({ from: 9, to: 9 }, { from: 9, to: 9 })).toBe(true); // the same place
    expect(meets({ from: 9, to: 9 }, { from: 9, to: 12 })).toBe(false); // at its start
    expect(meets({ from: 9, to: 9 }, { from: 9, to: 12, gone: true })).toBe(true); // where words were only taken out
  });
});

describe("The texts kept for Undo and Redo of an option chosen, after someone else's change", () => {
  /** The change as the window makes it, and the texts kept, carried through it. */
  function changeKeeping(state: EditorState, text: string, kept: Kept[], now: Map<string, Stretch>) {
    const tr = state.tr;
    const edit = editTo(tr, parseMarkdown(text), text)!;
    tr.setMeta("addToHistory", false);
    undoThrough(tr, state, edit.changed);
    return { state: state.apply(tr), kept: keptThrough(kept, tr, edit.changed, now) };
  }
  const words = (doc: Node, r: Stretch) => doc.textBetween(r.from, r.to);

  it("are the texts Undo and Redo bring back, with the comment on the words it had in each", () => {
    let state = open(PLAN);
    const before = { doc: state.doc, ranges: new Map([["c", find(state.doc, "two people")]]) };
    // The option: one sentence rewritten, one Undo step. The comment's words end in a letter the versions share, outside where they differ.
    const was = find(state.doc, "We should hire two people this quarter.");
    state = person(state, (tr) => tr.insertText("Hire some this quarter.", was.from, was.to));
    const after = { doc: state.doc, ranges: new Map([["c", find(state.doc, "some")]]) };
    const changed = changeKeeping(state, PLAN.replace("We should hire two people this quarter.", "Hire some this quarter.").replace("tight", "set"), [before, after], after.ranges);
    state = changed.state;
    expect(changed.kept).toHaveLength(2);
    expect(changed.kept[1].doc).toBe(state.doc);
    const undone = press(state, undo)!.state;
    expect(text(undone)).toBe(PLAN.replace("tight", "set"));
    expect(undone.doc.eq(changed.kept[0].doc)).toBe(true);
    expect(words(undone.doc, changed.kept[0].ranges.get("c")!)).toBe("two people");
    const redone = press(undone, redo)!.state;
    expect(redone.doc.eq(changed.kept[1].doc)).toBe(true);
    expect(words(redone.doc, changed.kept[1].ranges.get("c")!)).toBe("some");
  });

  // Review of Batch 7 (B7-R07): a change right up against the option's words, not into them, left the option's Undo
  // step (it doesn't touch the step's words) but dropped the texts kept for it (edges counted as touching there), so
  // Undo took the choice back with no saved places, and a comment could end on one letter. Both now go by one rule.
  it("are kept through a change that ends where the option's words start, as Undo is: Undo puts the comment back on its words", () => {
    let state = open(PLAN);
    const before = { doc: state.doc, ranges: new Map([["c", find(state.doc, "two people")]]) };
    const was = find(state.doc, "two");
    state = person(state, (tr) => tr.insertText("four", was.from, was.to));
    const after = { doc: state.doc, ranges: new Map([["c", find(state.doc, "four people")]]) };
    // Words put in straight before the option's, touching them. (The comment is on its words after the change.)
    const agents = PLAN.replace("hire two people", "hire about four people");
    const now = new Map([["c", find(parseMarkdown(agents).doc, "four people")]]);
    const changed = changeKeeping(state, agents, [before, after], now);
    state = changed.state;
    expect(undoDepth(state)).toBe(1);
    expect(changed.kept).toHaveLength(2);
    const undone = press(state, undo)!.state;
    expect(text(undone)).toBe(PLAN.replace("hire two people", "hire about two people"));
    expect(undone.doc.eq(changed.kept[0].doc)).toBe(true);
    expect(words(undone.doc, changed.kept[0].ranges.get("c")!)).toBe("two people");
    const redone = press(undone, redo)!.state;
    expect(redone.doc.eq(changed.kept[1].doc)).toBe(true);
    expect(words(redone.doc, changed.kept[1].ranges.get("c")!)).toBe("four people");
  });

  it("are kept through a change that starts where the option's words end, as Undo is", () => {
    let state = open(PLAN);
    const before = { doc: state.doc, ranges: new Map([["c", find(state.doc, "two people")]]) };
    const was = find(state.doc, "two");
    state = person(state, (tr) => tr.insertText("four", was.from, was.to));
    const after = { doc: state.doc, ranges: new Map([["c", find(state.doc, "four people")]]) };
    const agents = PLAN.replace("two people", "fourfold people");
    const changed = changeKeeping(state, agents, [before, after], new Map([["c", find(parseMarkdown(agents).doc, "fourfold people")]]));
    state = changed.state;
    expect(undoDepth(state)).toBe(1);
    expect(changed.kept).toHaveLength(2);
    const undone = press(state, undo)!.state;
    expect(text(undone)).toBe(PLAN.replace("two people", "twofold people"));
    expect(undone.doc.eq(changed.kept[0].doc)).toBe(true);
    expect(words(undone.doc, changed.kept[0].ranges.get("c")!)).toBe("twofold people");
  });

  it("drop a text whose differing words the change touched, as no Undo goes back to it", () => {
    let state = open(PLAN);
    const before = { doc: state.doc, ranges: new Map([["c", find(state.doc, "two people")]]) };
    const was = find(state.doc, "We should hire two people this quarter.");
    state = person(state, (tr) => tr.insertText("Hire two this quarter.", was.from, was.to));
    const after = { doc: state.doc, ranges: new Map([["c", find(state.doc, "two")]]) };
    const changed = changeKeeping(state, PLAN.replace("We should hire two people this quarter.", "Hire three this quarter."), [before, after], after.ranges);
    expect(changed.kept).toHaveLength(1);
    expect(changed.kept[0].doc).toBe(changed.state.doc);
  });
});

// Random rounds ------------------------------------------------------------------------------------

function random(seed: number) {
  let s = seed;
  const rnd = () => (s = (s * 1103515245 + 12345) & 0x7fffffff) / 0x7fffffff;
  const below = (n: number) => Math.floor(rnd() * n);
  const pick = <T>(a: readonly T[]) => a[below(a.length)];
  return { rnd, below, pick };
}
type Random = ReturnType<typeof random>;

const WORDS = ["we", "should", "hire", "three", "people", "this", "quarter", "the", "budget", "is", "tight", "plan", "team", "next", "year", "board", "report", "agreed"];
const sentence = (r: Random) => {
  const words = Array.from({ length: 3 + r.below(8) }, () => r.pick(WORDS));
  words[0] = words[0][0].toUpperCase() + words[0].slice(1);
  return words.join(" ") + ".";
};

/** Somewhere inside a block of text, from..to (to may equal from). */
function placeIn(doc: Node, r: Random, wide: boolean): Stretch | null {
  const blocks: { from: number; to: number }[] = [];
  doc.descendants((node, pos) => {
    if (node.isTextblock) blocks.push({ from: pos + 1, to: pos + 1 + node.content.size });
    return !node.isTextblock;
  });
  if (!blocks.length) return null;
  const b = r.pick(blocks);
  const from = b.from + r.below(b.to - b.from + 1);
  const to = wide ? Math.min(b.to, from + r.below(12)) : from;
  return { from, to };
}

/** One of the person's edits: words typed, deleted or typed over, made bold, or a paragraph split. */
function personEdit(state: EditorState, r: Random): EditorState {
  const kind = r.below(5);
  const at = placeIn(state.doc, r, kind !== 0 && kind !== 4);
  if (!at) return state;
  return person(state, (tr) => {
    if (kind === 0) return tr.insertText(` ${r.pick(WORDS)}`, at.from);
    if (kind === 1) return at.to > at.from ? tr.delete(at.from, at.to) : tr.insertText(r.pick(WORDS), at.from);
    if (kind === 2) return tr.insertText(r.pick(WORDS), at.from, at.to);
    if (kind === 3) return at.to > at.from ? tr.addMark(at.from, at.to, schema.marks.strong.create()) : tr;
    return tr.setSelection(TextSelection.create(tr.doc, at.from)).split(at.from);
  });
}

/** Someone else's change to the Markdown text: a sentence rewritten, a paragraph put in or taken out, a word replaced. */
function otherChange(markdown: string, r: Random): string {
  const blocks = markdown.trimEnd().split("\n\n");
  const k = r.below(blocks.length);
  const kind = r.below(4);
  if (kind === 0) blocks[k] = sentence(r);
  else if (kind === 1) blocks.splice(k, 0, sentence(r));
  else if (kind === 2 && blocks.length > 1) blocks.splice(k, 1);
  else {
    const words = blocks[k].split(" ");
    words[r.below(words.length)] = r.pick(WORDS);
    blocks[k] = words.join(" ");
  }
  return blocks.join("\n\n") + "\n";
}

/** No step of `tr` reaches into what the change wrote (or the place where it took words out): then the stretches, through `tr`. */
function clearOf(tr: Transaction, wrote: Stretch[]): Stretch[] {
  let now = wrote;
  tr.steps.forEach((step, i) => {
    const s = step as unknown as { from?: number; to?: number };
    const reach: Stretch[] = typeof s.from === "number" && typeof s.to === "number" ? [{ from: s.from, to: s.to }] : [];
    step.getMap().forEach((from, to) => {
      reach.push({ from, to });
    });
    for (const r of reach) for (const w of now) expect(meets(r, w), `step ${i} reaches into the change's words`).toBe(false);
    const map = tr.mapping.maps[i];
    now = now.map((w) => ({ from: map.map(w.from, 1), to: Math.max(map.map(w.from, 1), map.map(w.to, -1)) }));
  });
  return now;
}

describe("Undo after someone else's change, in random rounds", () => {
  it("never reaches into the change's words, every Undo and Redo applies, and Redo brings the text back as it was", () => {
    let undone = 0;
    let stopped = 0;
    for (let seed = 1; seed <= 300; seed++) {
      const r = random(seed);
      const start = Array.from({ length: 3 + r.below(5) }, () => sentence(r)).join("\n\n") + "\n";
      let state = open(start);
      for (let k = 0; k < 2 + r.below(6); k++) state = personEdit(state, r);
      const before = undoDepth(state);
      const markdown = serializeMarkdown(state.doc, parseMarkdown("").source);
      const next = otherChange(markdown, r);
      if (next === markdown) continue;
      let made: ReturnType<typeof change>;
      try {
        made = change(state, next);
      } catch {
        continue; // not an edit the window would make: it reads the text again instead
      }
      state = made.state;
      const after = state.doc;
      let wrote = made.wrote;
      if (undoDepth(state) < before) stopped++;
      // Every step the person can still undo, then redo.
      let n = 0;
      for (let pressed = press(state, undo); pressed; pressed = press(state, undo)) {
        wrote = clearOf(pressed.tr, wrote);
        state = pressed.state;
        n++;
      }
      undone += n;
      expect(redoDepth(state)).toBe(n);
      for (let pressed = press(state, redo); pressed; pressed = press(state, redo)) state = pressed.state;
      expect(state.doc.eq(after), `seed ${seed}: Redo brings the text back`).toBe(true);
    }
    // Both happen: steps taken back through the change, and Undo stopping at one it touched.
    expect(undone).toBeGreaterThan(200);
    expect(stopped).toBeGreaterThan(20);
  });
});
