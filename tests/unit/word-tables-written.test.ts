// Tables in Word as the page shows them (Batch 22, from Batch 21's E21-3 and
// E21-5). Pandoc reads tables a little more strictly than the page does: a
// table written right under a line of text, and code holding a | in a table
// the page keeps as Markdown, are written so Pandoc reads them as the page does.
import { describe, expect, it } from "vitest";
import { blankLinesForWord, BLANK_MARK } from "../../src/main/export-prep";
import { parseMarkdown } from "../../src/core/markdown";
import { paragraphsOf, toWord, wordsOf } from "./word";

/** The page's top-level blocks, a block kept as Markdown by its kind. */
const blocksOf = (markdown: string) => {
  const out: string[] = [];
  parseMarkdown(markdown).doc.forEach((n) => out.push(n.type.name === "raw_block" ? `raw_block(${n.attrs.kind})` : n.type.name));
  return out;
};

/** Each table's cells, row by row, as Word holds them. */
const tablesOf = (xml: string) =>
  [...xml.matchAll(/<w:tbl>([\s\S]*?)<\/w:tbl>/g)].map(([, tbl]) =>
    [...tbl.matchAll(/<w:tr\b[\s\S]*?<\/w:tr>/g)].map(([tr]) => [...tr.matchAll(/<w:tc>([\s\S]*?)<\/w:tc>/g)].map(([, tc]) => wordsOf(tc))),
  );

/** Word's paragraphs outside its tables, in order: their words, an empty one as "". */
const linesOutside = (xml: string) => paragraphsOf(xml.replace(/<w:tbl>[\s\S]*?<\/w:tbl>/g, "<w:p><w:r><w:t>[table]</w:t></w:r></w:p>")).map((p) => p.words);

describe("a table written right under a line of text is a table in Word (E21-3)", () => {
  it("under a paragraph: a table, with no empty line added above it", () => {
    const markdown = "Totals:\n| Item | Cost |\n|------|------|\n| Desks | $900 |\n\nAfter.\n";
    expect(blocksOf(markdown)).toEqual(["paragraph", "table", "paragraph"]); // the page: a table
    const { xml } = toWord(markdown);
    expect(tablesOf(xml)).toEqual([[["Item", "Cost"], ["Desks", "$900"]]]);
    expect(linesOutside(xml)).toEqual(["Totals:", "[table]", "", "After."]);
  });

  it("under a list item's words, and under a quote's", () => {
    const item = toWord("- Costs so far\n  | Item | Cost |\n  |------|------|\n  | Desks | $900 |\n- Next item\n\nAfter.\n").xml;
    expect(tablesOf(item)).toEqual([[["Item", "Cost"], ["Desks", "$900"]]]);
    expect(linesOutside(item)).toEqual(["Costs so far", "[table]", "Next item", "", "After."]);
    const quote = toWord("> Costs so far\n> | Item | Cost |\n> |------|------|\n> | Desks | $900 |\n").xml;
    expect(tablesOf(quote)).toEqual([[["Item", "Cost"], ["Desks", "$900"]]]);
    expect(linesOutside(quote)).toEqual(["Costs so far", "[table]"]);
  });

  it("a table already apart, or written in code, is left as written", () => {
    for (const text of ["Totals:\n\n| a | b |\n|---|---|\n| 1 | 2 |\n", "```\nTotals:\n| a | b |\n|---|---|\n```\n", "Totals: a | b\nand more words\n"]) {
      expect(blankLinesForWord(text).replaceAll(`\n\n${BLANK_MARK}`, ""), text).toBe(text);
    }
  });
});

describe("code holding a | in a table the page keeps as Markdown keeps its words in Word (E21-5)", () => {
  it("the code stays whole in its cell", () => {
    const markdown = "| A | B |\n|---|---|\n| one | `left|right` |\n";
    expect(blocksOf(markdown)).toEqual(["raw_block(table)"]); // the page shows it whole, as Markdown
    expect(tablesOf(toWord(markdown).xml)).toEqual([[["A", "B"], ["one", "left|right"]]]);
  });

  it("code longer than one backtick, and a | already written \\|, too", () => {
    const markdown = "| A | B |\n|---|---|\n| ``a|`b`|c`` | `x\\|y` and `p|q` |\n";
    expect(blocksOf(markdown)).toEqual(["raw_block(table)"]);
    expect(tablesOf(toWord(markdown).xml)).toEqual([[["A", "B"], ["a|`b`|c", "x|y and p|q"]]]);
  });

  it("a table the page shows as a table is left as written", () => {
    const markdown = "| A | B | C |\n|---|---|---|\n| `x|y` | z |\n";
    expect(blocksOf(markdown)).toEqual(["table"]);
    expect(blankLinesForWord(markdown)).toBe(markdown);
  });
});

describe("a row longer than its header widens the header in Word, so no cell is lost (E21-5, his call)", () => {
  it("the header gets an empty cell for each one more", () => {
    const markdown = "| A | B |\n|---|---|\n| one | two | three is extra |\n| short |\n";
    expect(blocksOf(markdown)).toEqual(["raw_block(table)"]); // the page shows it whole, as Markdown
    expect(tablesOf(toWord(markdown).xml)).toEqual([
      [
        ["A", "B", ""],
        ["one", "two", "three is extra"],
        ["short", "", ""],
      ],
    ]);
  });

  it("written without the outer |, in a list item, or with code holding a |", () => {
    expect(tablesOf(toWord("A | B\n---|:---:\none | two | three | four\n").xml)).toEqual([
      [
        ["A", "B", "", ""],
        ["one", "two", "three", "four"],
      ],
    ]);
    expect(tablesOf(toWord("- Costs\n\n  | A | B |\n  |---|---|\n  | one | two | three |\n").xml)).toEqual([
      [
        ["A", "B", ""],
        ["one", "two", "three"],
      ],
    ]);
    expect(tablesOf(toWord("| A |\n|---|\n| `x|y` | z |\n").xml)).toEqual([
      [
        ["A", ""],
        ["x|y", "z"],
      ],
    ]);
  });
});
