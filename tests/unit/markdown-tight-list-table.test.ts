// Batch 24, item 5 (row 62 of review/make-better-3.md): a list without blank
// lines between its items, whose item holds words with a table or a rule right
// under them. Markdown can hold that table there for the editor, but Pandoc
// (Word and PDF) reads a table only after a blank line, and a rule ("---")
// under words would underline them as a heading: so the item is written with a
// blank line inside it. Read again, that blank line spaces out the whole list,
// so a second save used to add a blank line between the items too: the file
// changed at a save with nothing new in it.
//
// Now the list is written spaced out from the first save, so the second save
// adds nothing. Each case is made up: edited (a letter typed in the table, or
// after the words, either of which writes the list afresh) and saved, read
// back, edited again and saved: the two saves differ only by the letter typed,
// the safety net lets both through as written, and nothing is lost. Written
// afresh twice (as an agent's whole new text is), the same.
import { describe, expect, it } from "vitest";
import { EditorState } from "prosemirror-state";
import type { Node } from "prosemirror-model";
import { parseMarkdown, serializeMarkdown, type Source } from "../../src/core/markdown";
import { checkSave, meaningOf } from "../../src/core/write-check";

/** The end of the paragraph or table cell whose words end with `words`. */
function endOf(doc: Node, words: string): number {
  let at = -1;
  doc.descendants((n, pos) => {
    if (n.isTextblock && n.textContent.endsWith(words)) at = pos + n.nodeSize - 1;
    return at < 0;
  });
  if (at < 0) throw new Error(`nothing ending ${words}`);
  return at;
}

/** Type `letter` after `words`, then save through the safety net: the text written. */
function typeAndSave(doc: Node, source: Source, words: string, letter: string): string {
  const state = EditorState.create({ doc });
  const page = state.apply(state.tr.insertText(letter, endOf(doc, words))).doc;
  const out = serializeMarkdown(page, source);
  const net = checkSave(page, source);
  if (!net.ok) throw new Error(`the safety net refused ${JSON.stringify(out)}`);
  expect(net.repaired, `the safety net repaired ${JSON.stringify(out)}`).toBeFalsy();
  expect(net.text).toBe(out);
  // Read back, every block is what the page showed.
  const back: string[] = [];
  parseMarkdown(out).doc.forEach((n) => back.push(meaningOf(n)));
  const shown: string[] = [];
  page.forEach((n) => shown.push(meaningOf(n)));
  expect(back).toEqual(shown);
  return out;
}

/**
 * "ZY" typed and saved at once, and "Z" typed and saved, read again, "Y"
 * typed and saved: the second save should have changed nothing but the
 * letter, so the two texts are the same.
 */
function twoSaves(text: string, words: string): [string, string] {
  const first = parseMarkdown(text);
  const atOnce = typeAndSave(first.doc, first.source, words, "ZY");
  const once = typeAndSave(first.doc, first.source, words, "Z");
  const again = parseMarkdown(once);
  return [atOnce, typeAndSave(again.doc, again.source, `${words}Z`, "Y")];
}

/** A file written afresh: no blocks of the original to keep. */
const fresh = (s: Source): Source => ({ bom: s.bom, eol: s.eol, prefix: "", trailing: "", blocks: [], gaps: [], original: "" });

/** Written afresh, read back and written afresh again: the same text. */
function afreshTwice(text: string): [string, string] {
  const { doc, source } = parseMarkdown(text);
  const once = serializeMarkdown(doc, fresh(source));
  const again = parseMarkdown(once);
  return [once, serializeMarkdown(again.doc, fresh(again.source))];
}

const TABLE = "| a | b |\n| - | - |\n| 1 | 2 |";

const CASES: Record<string, { text: string; last: string }> = {
  "row 62's example: a table under an item's words": { text: `- Words over a table\n${TABLE.replace(/^/gm, "  ")}\n- next item\n`, last: "2" },
  "a table under a numbered item's words": { text: `1. Words over a table\n${TABLE.replace(/^/gm, "   ")}\n2. next item\n`, last: "2" },
  "a table under an item's words, in a quote": { text: `> - Words over a table\n${TABLE.replace(/^/gm, ">   ")}\n> - next item\n`, last: "2" },
  "a table under an item's words, in a list in a list": { text: `- outer\n  - Words over a table\n${TABLE.replace(/^/gm, "    ")}\n  - next item\n- back out\n`, last: "2" },
  "a rule under an item's words, with words under it": { text: "- Words\n  ***\n  More words\n- next item\n", last: "next item" },
  "a rule under a numbered item's words, in a quote in a quote": { text: "> > 1. Words\n> >    ***\n> > 2. next item\n", last: "next item" },
};

describe("a short list holding a table or rule under an item's words (row 62)", () => {
  for (const [name, { text, last }] of Object.entries(CASES)) {
    it(`${name}: edited and saved twice, the same text both times`, () => {
      const [once, twice] = twoSaves(text, last);
      expect(twice).toBe(once);
    });

    it(`${name}: written afresh twice, the same text both times`, () => {
      const [once, twice] = afreshTwice(text);
      expect(twice).toBe(once);
    });
  }

  it("row 62's example is written spaced out from the first save, the table keeping its blank line for Word", () => {
    const { doc, source } = parseMarkdown(CASES["row 62's example: a table under an item's words"].text);
    expect(serializeMarkdown(doc, fresh(source))).toBe("- Words over a table\n\n  | a   | b   |\n  | --- | --- |\n  | 1   | 2   |\n\n- next item\n");
  });

  it("a short list that needs no blank line inside stays tight", () => {
    for (const text of ["- one\n- two\n", "- Words\n  ```\n  code\n  ```\n- next\n", "- Words\n  > quoted\n- next\n", "- Words\n  - inner\n- next\n"]) {
      const { doc, source } = parseMarkdown(text);
      expect(serializeMarkdown(doc, fresh(source)), text).toBe(text);
    }
  });
});
