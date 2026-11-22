// Batch 25, item 3: two lists of one kind that touch inside a list item, kept
// two lists only by their other bullet ("-" then "*") or numbering ("1." then
// "1)"). Written afresh (an item added to the list around them, say, or an
// agent's whole new text), the library put two blank lines between them. Read
// back, that blank line inside the item spaces out the whole list around
// them, so the next save wrote a blank line between every item there: Show
// changes marked lines he never touched.
//
// Now the second list starts on the line under the first, as Markdown reads
// two lists there, so a list without blank lines stays that way. Each case is
// made up: an item added to the list around them, a letter typed in it, saved,
// read back, another letter typed and saved: the same text as both letters at
// once, the safety net letting both through as written, nothing lost. Written
// afresh twice (as an agent's whole new text is), the same.
import { describe, expect, it } from "vitest";
import { EditorState } from "prosemirror-state";
import type { Node } from "prosemirror-model";
import { parseMarkdown, serializeMarkdown, type Source } from "../../src/core/markdown";
import { checkSave, meaningOf } from "../../src/core/write-check";

/** The end of the paragraph whose words end with `words`. */
function endOf(doc: Node, words: string): number {
  let at = -1;
  doc.descendants((n, pos) => {
    if (n.isTextblock && n.textContent.endsWith(words)) at = pos + n.nodeSize - 1;
    return at < 0;
  });
  if (at < 0) throw new Error(`nothing ending ${words}`);
  return at;
}

/** Where a new item goes at the end of the outermost list (the first one met, top level or in a quote). */
function outerListEnd(doc: Node): { at: number; list: Node } {
  let found: { at: number; list: Node } | null = null;
  doc.descendants((n, pos) => {
    if (!found && (n.type.name === "bullet_list" || n.type.name === "ordered_list")) found = { at: pos + n.nodeSize - 1, list: n };
    return !found;
  });
  if (!found) throw new Error("no list");
  return found;
}

/** Save through the safety net: the text written, checked to read back as the page shows, every word kept. */
function save(page: Node, source: Source): string {
  const out = serializeMarkdown(page, source);
  const net = checkSave(page, source);
  if (!net.ok) throw new Error(`the safety net refused ${JSON.stringify(out)}`);
  expect(net.repaired, `the safety net repaired ${JSON.stringify(out)}`).toBeFalsy();
  expect(net.text).toBe(out);
  const back: string[] = [];
  parseMarkdown(out).doc.forEach((n) => back.push(meaningOf(n)));
  const shown: string[] = [];
  page.forEach((n) => shown.push(meaningOf(n)));
  expect(back).toEqual(shown);
  return out;
}

/** New items, one with each of `words`, added at the end of the outer list, then saved. */
function addItemsAndSave(text: string, ...words: string[]): string {
  const { doc, source } = parseMarkdown(text);
  let state = EditorState.create({ doc });
  for (const w of words) {
    const { at, list } = outerListEnd(state.doc);
    const item = list.lastChild!.type.create(null, doc.type.schema.node("paragraph", null, doc.type.schema.text(w)));
    state = state.apply(state.tr.insert(at, item));
  }
  return save(state.doc, source);
}

/** `letter` typed after `words`, then saved. */
function typeAndSave(text: string, words: string, letter: string): string {
  const { doc, source } = parseMarkdown(text);
  const state = EditorState.create({ doc });
  return save(state.apply(state.tr.insertText(letter, endOf(doc, words))).doc, source);
}

/** A file written afresh: no blocks of the original to keep. */
const fresh = (s: Source): Source => ({ bom: s.bom, eol: s.eol, prefix: "", trailing: "", blocks: [], gaps: [], original: "" });

/** Written afresh, read back and written afresh again. */
function afreshTwice(text: string): [string, string] {
  const { doc, source } = parseMarkdown(text);
  const once = serializeMarkdown(doc, fresh(source));
  const again = parseMarkdown(once);
  return [once, serializeMarkdown(again.doc, fresh(again.source))];
}

/** Every word of the text, in order. */
const wordsOf = (text: string) => parseMarkdown(text).doc.textContent;

const CASES: Record<string, string> = {
  "two bullet lists, - then *, under an item's words": "- x\n  - a\n  - b\n  * c\n  * d\n- y\n",
  "two bullet lists, the first spaced out": "- x\n  - a\n\n  - b\n  * c\n  * d\n- y\n",
  "two bullet lists, the second spaced out": "- x\n  - a\n  - b\n  * c\n\n  * d\n- y\n",
  "two bullet lists, * then -": "* x\n  * a\n  * b\n  - c\n  - d\n* y\n",
  "two numbered lists, 1. then 1), under a numbered item's words": "1. x\n   1. a\n   2. b\n   1) c\n   2) d\n2. y\n",
  "two numbered lists, the first spaced out": "1. x\n   1. a\n\n   2. b\n   1) c\n   2) d\n2. y\n",
  "two numbered lists, the second spaced out": "1. x\n   1. a\n   2. b\n   1) c\n\n   2) d\n2. y\n",
  // ("3)" can't start a list right under words, so it keeps a blank line, which spaces out the list around it.)
  "two numbered lists, the second starting at 3": "- x\n  1. a\n  2. b\n\n  3) c\n  4) d\n- y\n",
  "two bullet lists three deep": "- x\n  - w\n    - a\n    - b\n    * c\n    * d\n  - v\n- y\n",
  "two bullet lists in a list in a quote": "> - x\n>   - a\n>   - b\n>   * c\n>   * d\n> - y\n",
  "two bullet lists under a task": "- [ ] x\n  - a\n  - b\n  * c\n  * d\n- [ ] y\n",
  "three bullet lists, - * -": "- x\n  - a\n  * b\n  - c\n- y\n",
};

/** Cases whose list around them the file already has spaced out, as Markdown must: written afresh, it is spaced throughout. */
const SPACED = new Set(["two numbered lists, the second starting at 3"]);

describe("two lists of one kind touching inside a list item (Batch 25, item 3)", () => {
  for (const [name, text] of Object.entries(CASES)) {
    it(`${name}: an item added, saved, another added and saved, the same text as both at once`, () => {
      const atOnce = addItemsAndSave(text, "one", "two");
      const twice = addItemsAndSave(addItemsAndSave(text, "one"), "two");
      expect(twice).toBe(atOnce);
      expect(wordsOf(twice)).toBe(wordsOf(text) + "onetwo");
    });

    it(`${name}: an item added and saved, a letter typed in it and saved, the same text as both at once`, () => {
      const atOnce = addItemsAndSave(text, "newZY");
      const twice = typeAndSave(addItemsAndSave(text, "newZ"), "newZ", "Y");
      expect(twice).toBe(atOnce);
      expect(wordsOf(twice)).toBe(wordsOf(text) + "newZY");
    });

    it(`${name}: written afresh twice, the same text both times`, () => {
      const [once, twice] = afreshTwice(text);
      expect(twice).toBe(once);
      expect(wordsOf(once)).toBe(wordsOf(text));
    });

    if (!SPACED.has(name)) {
      it(`${name}: written afresh, the file's text as it was`, () => {
        expect(afreshTwice(text)[0]).toBe(text);
      });
    }
  }

  it("the made-up example: an item added under two touching lists leaves the lines above as they were", () => {
    const text = "- Groceries\n  - milk\n  - eggs\n  * soap\n  * sponges\n- Chores\n";
    expect(addItemsAndSave(text, "Garden")).toBe(text + "- Garden\n");
  });
});
