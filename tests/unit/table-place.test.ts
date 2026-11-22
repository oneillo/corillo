// Finding the cell the cursor is in when a table is Markdown text, keeping the
// person's place between the formatted and Markdown views, and keeping
// comments on their words when a table switches between a grid and Markdown
// text.
import { describe, expect, it } from "vitest";
import type { Node } from "prosemirror-model";
import { EditorState } from "prosemirror-state";
import { parseMarkdown, serializeMarkdown } from "../../src/core/markdown";
import { anchorFor, findAnchor, looseText, posAt, textIndex } from "../../src/core/anchors";
import { cellContent, docPlace, docRange, markdownPlace, tableSpotAt, viewText, type Span } from "../../src/core/place";
import { forTextArea } from "../../src/core/text-area";

const TABLE = "Intro.\n\n| Option | Notes |\n|---|---|\n| Tool A | Fast<br>Cheap |\n| Tool B | **Slow** and costly |\n\nAfter.\n";

/** What's highlighted for a cursor just before `marker` in the text (marker removed). */
function spotAt(withMarker: string) {
  const offset = withMarker.indexOf("^");
  const text = withMarker.replace("^", "");
  const spot = tableSpotAt(text, offset);
  return spot && { cell: text.slice(spot.cellFrom, spot.cellTo), row: text.slice(spot.lineFrom, spot.lineTo), line: spot.line, index: spot.cell };
}

describe("the cell the cursor is in, in a table written as Markdown", () => {
  it("is the text between the pipes around the cursor, in its row", () => {
    expect(spotAt("| A | B |\n|---|---|\n| one | tw^o |\n")).toEqual({ cell: " two ", row: "| one | two |", line: 2, index: 1 });
    expect(spotAt("| A | B |\n|---|---|\n| ^one | two |\n")).toEqual({ cell: " one ", row: "| one | two |", line: 2, index: 0 });
  });

  it("just before a pipe is the cell on the left, just after it the one on the right", () => {
    expect(spotAt("| A | B |\n|---|---|\n| one ^| two |\n")!.cell).toBe(" one ");
    expect(spotAt("| A | B |\n|---|---|\n| one |^ two |\n")!.cell).toBe(" two ");
  });

  it("before the first pipe or after the last is the first or last cell", () => {
    expect(spotAt("| A | B |\n|---|---|\n^| one | two |\n")!.cell).toBe(" one ");
    expect(spotAt("| A | B |\n|---|---|\n| one | two |^\n")!.cell).toBe(" two ");
  });

  it("works in the header row and the row of dashes", () => {
    expect(spotAt("| A^ | B |\n|---|---|\n| 1 | 2 |\n")).toMatchObject({ cell: " A ", line: 0 });
    expect(spotAt("| A | B |\n|---|-^--|\n| 1 | 2 |\n")).toMatchObject({ cell: "---", line: 1, index: 1 });
  });

  it("works without pipes at the ends of rows", () => {
    expect(spotAt("A | B\n--- | ---\n1 | ^2\n")).toMatchObject({ cell: " 2", index: 1, line: 2 });
    expect(spotAt("A | B\n--- | ---\n^1 | 2\n")).toMatchObject({ cell: "1 ", index: 0 });
  });

  it("keeps an escaped pipe inside its cell", () => {
    expect(spotAt("| A | B |\n|---|---|\n| a \\| ^b | c |\n")!.cell).toBe(" a \\| b ");
  });

  it("works in a quote or a list", () => {
    expect(spotAt("> | A | B |\n> |---|---|\n> | 1 | ^2 |\n")!.cell).toBe(" 2 ");
    expect(spotAt("- Options:\n\n  | A | B |\n  |---|---|\n  | ^1 | 2 |\n")!.cell).toBe(" 1 ");
  });

  it("is nothing outside a table: a paragraph with a pipe, or a paragraph just above a table", () => {
    expect(spotAt("Use a ^| b here.\n")).toBeNull();
    expect(spotAt("Choose a ^| b:\n| A | B |\n|---|---|\n| 1 | 2 |\n")).toBeNull();
    expect(spotAt("Choose a | b:\n| A^ | B |\n|---|---|\n| 1 | 2 |\n")).toMatchObject({ cell: " A ", line: 0 });
    expect(spotAt("| A | B |\n|---|---|\n| 1 | 2 |\n\nAfter^.\n")).toBeNull();
  });

  it("finds a cell in row 500 of a big table quickly", () => {
    const rows = Array.from({ length: 500 }, (_, i) => `| Item ${i + 1} | Note ${i + 1} |`).join("\n");
    const text = `| Item | Note |\n|---|---|\n${rows}\n`;
    const offset = text.indexOf("Note 499 ") + 2;
    const start = performance.now();
    for (let i = 0; i < 100; i++) tableSpotAt(text, offset);
    expect((performance.now() - start) / 100).toBeLessThan(5);
    expect(text.slice(tableSpotAt(text, offset)!.cellFrom, tableSpotAt(text, offset)!.cellTo)).toBe(" Note 499 ");
  });

  it("gives a cell's words without its spaces", () => {
    const line = "|  one two  | x |";
    const c = cellContent(line, 0)!;
    expect(line.slice(c.from, c.to)).toBe("one two");
    expect(cellContent(line, 2)).toBeNull();
  });
});

// Switching views ---------------------------------------------------------------------

/** The formatted document, and its text as the Markdown view shows it, with each block's place. */
function views(text: string) {
  const { doc, source } = parseMarkdown(text);
  const { text: out, spans } = viewText(doc, source);
  return { doc, source, view: forTextArea(out), spans };
}

/** The document position just before some text in the document (inside one text node). */
function posOf(doc: Node, wanted: string): number {
  let found = -1;
  doc.descendants((node, pos) => {
    if (found >= 0) return false;
    if (node.isText && node.text!.includes(wanted)) found = pos + node.text!.indexOf(wanted);
    return true;
  });
  if (found < 0) throw new Error(`"${wanted}" isn't in the document`);
  return found;
}

describe("switching views keeps the person's place", () => {
  it("a cursor in a grid cell lands in the same cell of the Markdown text, and back", () => {
    const { doc, view, spans } = views(TABLE);
    const pos = posOf(doc, "Cheap") + 2;
    const offset = markdownPlace(doc, pos, view, spans);
    expect(view.slice(offset - 6, offset)).toBe("<br>Ch");
    const spot = tableSpotAt(view, offset)!;
    expect(view.slice(spot.cellFrom, spot.cellTo)).toBe(" Fast<br>Cheap ");
    const back = parseMarkdown(view);
    expect(docPlace(back.doc, view, viewText(back.doc, back.source).spans, offset)).toBe(posOf(back.doc, "Cheap") + 2);
  });

  it("past bold signs, in a cell and in a paragraph", () => {
    const { doc, view, spans } = views(TABLE + "\nSome **bold** words.\n");
    const inCell = markdownPlace(doc, posOf(doc, " and costly"), view, spans);
    expect(view.slice(inCell - 6, inCell + 2)).toBe("**Slow**"); // just after the word, inside the bold
    const inPara = markdownPlace(doc, posOf(doc, "old"), view, spans);
    expect(view.slice(inPara - 3, inPara + 3)).toBe("**bold");
    const back = parseMarkdown(view);
    expect(docPlace(back.doc, view, viewText(back.doc, back.source).spans, inCell)).toBe(posOf(back.doc, " and costly"));
  });

  it("in the header row, an empty cell and the first cell", () => {
    const text = "| Name | Notes |\n|---|---|\n|  | x |\n";
    const { doc, view, spans } = views(text);
    const header = markdownPlace(doc, posOf(doc, "Notes") + 3, view, spans);
    expect(view.slice(header - 3, header)).toBe("Not");
    // The empty cell: the cursor right inside it.
    const table = doc.child(0);
    const emptyCell = 1 + table.child(0).nodeSize + 1 + 1;
    const offset = markdownPlace(doc, emptyCell, view, spans);
    expect(tableSpotAt(view, offset)).toMatchObject({ line: 2, cell: 0 });
    const back = parseMarkdown(view);
    expect(docPlace(back.doc, view, viewText(back.doc, back.source).spans, offset)).toBe(emptyCell);
  });

  it("from the row of dashes, lands in the header row", () => {
    const { doc, view } = views("| A | B |\n|---|---|\n| 1 | 2 |\n");
    const back = parseMarkdown(view);
    const pos = docPlace(back.doc, view, viewText(back.doc, back.source).spans, view.indexOf("|---|---|") + 6);
    expect(back.doc.resolve(pos).parent.textContent).toBe("B");
    expect(doc.eq(back.doc)).toBe(true);
  });

  it("words selected for a comment: a table's row of dashes holds none, so a selection of only that row is empty", () => {
    const { doc, view, spans } = views("Intro.\n\n| A | B |\n|---|---|\n| one | two |\n");
    const range = (from: string, to: string) => {
      const r = docRange(doc, view, spans, view.indexOf(from), view.indexOf(to) + to.length);
      return doc.textBetween(r.from, r.to, "/");
    };
    expect(range("|---|---|", "|---|---|")).toBe("");
    expect(range("|---|---|", "one")).toBe("one");
    expect(range("B", "|---|---|")).toBe("B");
    expect(range("A", "two")).toBe("A/B/one/two");
    expect(range("Intro", "Intro")).toBe("Intro");
  });

  it("in a table shown as Markdown text, and in headings, lists and code", () => {
    const text = "# Title here\n\n- one\n- two items\n\n```js\nlet x = 1;\n```\n\n| A |\n|---|\n| <u>x</u> |\n";
    const { doc, view, spans } = views(text);
    const heading = markdownPlace(doc, posOf(doc, "here"), view, spans);
    expect(view.slice(heading, heading + 4)).toBe("here");
    const item = markdownPlace(doc, posOf(doc, "items"), view, spans);
    expect(view.slice(item, item + 5)).toBe("items");
    const code = markdownPlace(doc, posOf(doc, "x = 1"), view, spans);
    expect(view.slice(code, code + 5)).toBe("x = 1");
    const raw = markdownPlace(doc, posOf(doc, "<u>x"), view, spans);
    expect(view.slice(raw, raw + 4)).toBe("<u>x");
    const back = parseMarkdown(view);
    const spansBack = viewText(back.doc, back.source).spans;
    for (const [offset, words] of [[heading, "here"], [item, "items"], [code, "x = 1"], [raw, "<u>x"]] as const) {
      expect(docPlace(back.doc, view, spansBack, offset)).toBe(posOf(back.doc, words));
    }
  });

  it("with Windows line endings and a byte-order mark", () => {
    const text = "\uFEFFIntro.\r\n\r\n| A | B |\r\n|---|---|\r\n| one | two |\r\n";
    const { doc, view, spans } = views(text);
    const offset = markdownPlace(doc, posOf(doc, "two") + 1, view, spans);
    expect(view.slice(offset - 1, offset + 2)).toBe("two");
    const back = parseMarkdown(text);
    expect(docPlace(back.doc, view, viewText(back.doc, back.source).spans, offset)).toBe(posOf(back.doc, "two") + 1);
  });

  it("in an edited table, which is written afresh", () => {
    const { doc, source } = parseMarkdown("Intro.\n\n| A | B |\n|---|---|\n| one | two |\n");
    const state = EditorState.create({ doc });
    const pos = posOf(doc, "one") + 3;
    const after = state.apply(state.tr.insertText(" more", pos)).doc;
    const spans: Span[] = [];
    const out = serializeMarkdown(after, source, spans);
    expect(out).toContain("| one more | two |");
    const offset = markdownPlace(after, posOf(after, "two") + 2, out, spans);
    expect(out.slice(offset - 2, offset)).toBe("tw");
  });

  it("coming back unchanged after edits in the formatted view (the document wasn't read again)", () => {
    const { doc, source } = parseMarkdown("Intro.\n\n| A | B |\n|---|---|\n| one | two |\n");
    const state = EditorState.create({ doc });
    // A new paragraph before the table: the blocks no longer match the file as it was read.
    const edited = state.apply(state.tr.insert(0, doc.type.schema.node("paragraph", null, doc.type.schema.text("New first.")))).doc;
    const { text, spans } = viewText(edited, source);
    const offset = text.indexOf("two") + 1;
    expect(docPlace(edited, text, spans, offset)).toBe(posOf(edited, "two") + 1);
  });
});

// Comments on table text ---------------------------------------------------------------

const GRID = "Notes.\n\n| Option | Verdict | Notes |\n|---|---|---|\n| Tool A | Yes | Fast and **cheap** |\n| Tool B | Yes | Slow |\n| Tool C | No | Rare |\n\nEnd.\n";
// The same table after an agent added something only Markdown text can hold.
const RAW = GRID.replace("| Slow |", '| Slow <span style="color:red">!</span> |');

/** Anchor a comment on some words in one document, find it in another, and say what it covers. */
function moveComment(from: string, to: string, words: string) {
  const a = parseMarkdown(from).doc;
  const index = textIndex(a);
  const at = index.text.indexOf(words);
  if (at < 0) throw new Error(`"${words}" isn't in the document`);
  const anchor = anchorFor(a, posAt(index, at, "start"), posAt(index, at + words.length, "end"), index);
  const b = parseMarkdown(to).doc;
  const range = findAnchor(b, anchor);
  return range && b.textBetween(range.from, range.to, "\n", "\n");
}

describe("comments on words in a table", () => {
  it("stay on their words when the table becomes Markdown text, and when it's a grid again", () => {
    expect(parseMarkdown(RAW).doc.child(1).type.name).toBe("raw_block");
    expect(moveComment(GRID, RAW, "Tool B")).toBe("Tool B");
    expect(moveComment(RAW, GRID, "Tool B")).toBe("Tool B");
  });

  it("keep to the right one of repeated words", () => {
    // "Yes" is in two rows: the second one stays the second one, both ways.
    const rows = (text: string) => {
      const doc = parseMarkdown(text).doc;
      const yes: number[] = [];
      doc.descendants((n, p) => {
        if (n.isText) for (let i = n.text!.indexOf("Yes"); i >= 0; i = n.text!.indexOf("Yes", i + 1)) yes.push(p + i);
        return true;
      });
      return { doc, yes };
    };
    const g = rows(GRID);
    const r = rows(RAW);
    expect(g.yes).toHaveLength(2);
    expect(r.yes).toHaveLength(2);
    const anchor = anchorFor(g.doc, g.yes[1], g.yes[1] + 3);
    expect(findAnchor(r.doc, anchor)!.from).toBe(r.yes[1]);
    const back = anchorFor(r.doc, r.yes[1], r.yes[1] + 3);
    expect(findAnchor(g.doc, back)!.from).toBe(g.yes[1]);
    const first = anchorFor(g.doc, g.yes[0], g.yes[0] + 3);
    expect(findAnchor(r.doc, first)!.from).toBe(r.yes[0]);
  });

  it("on words with bold in them are found again past the bold signs", () => {
    expect(moveComment(GRID, RAW, "Fast and cheap")).toBe("Fast and **cheap");
    expect(moveComment(RAW, GRID, "Fast and **cheap**")).toBe("Fast and cheap");
  });

  it("across two cells are found again across the pipe", () => {
    expect(moveComment(GRID, RAW, "Tool C\nNo")).toBe("Tool C | No");
    expect(moveComment(RAW, GRID, "Tool C | No")).toBe("Tool C\nNo");
  });

  it("with a line break in a cell are found again across the <br>", () => {
    const grid = "| A | B |\n|---|---|\n| x | Fast<br>Cheap |\n";
    const raw = "| A | B |\n|---|---|\n| <u>x</u> | Fast<br>Cheap |\n";
    expect(moveComment(grid, raw, "Fast")).toBe("Fast");
    expect(moveComment(raw, grid, "Fast<br>Cheap")).toBe("Fast\nCheap");
  });

  it("stay put when another row of the table is deleted or changed", () => {
    const changed = GRID.replace("| Tool A | Yes | Fast and **cheap** |\n", "").replace("Rare", "Very rare");
    expect(moveComment(GRID, changed, "Slow")).toBe("Slow");
  });

  it("aren't found loosely on a single letter that happens to be there", () => {
    const a = parseMarkdown("| A |\n|---|\n| **x** |\n").doc;
    const anchor = { quote: "*x*", prefix: "", suffix: "", offset: 0 };
    expect(findAnchor(a, anchor)).toBeNull();
  });

  it("compare loosely without Markdown signs, pipes or line breaks", () => {
    expect(looseText("| Tool A | **Yes** |\n|---|---|\n| [Docs](https://x.com) | a<br/>b |").text).toBe("Tool A Yes Docs a b");
  });
});
