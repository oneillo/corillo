// Tables as agents write them: which show as a grid, which stay as Markdown
// text, and how a table is written back. An unedited table is always kept
// byte for byte; an edited one is rewritten neatly, keeping what it means and,
// where it can, how the file wrote it (line breaks in cells as "<br>").
import { describe, expect, it } from "vitest";
import { EditorState } from "prosemirror-state";
import type { Node } from "prosemirror-model";
import { parseMarkdown, serializeMarkdown } from "../../src/core/markdown";
import { schema } from "../../src/core/schema";

function load(text: string) {
  const { doc, source } = parseMarkdown(text);
  return { doc, source, state: EditorState.create({ doc }) };
}

/** The first table in a document. */
function firstTable(doc: Node): { node: Node; pos: number } | null {
  let found: { node: Node; pos: number } | null = null;
  doc.descendants((node, pos) => {
    if (found) return false;
    if (node.type.name === "table") {
      found = { node, pos };
      return false;
    }
    return true;
  });
  return found;
}

/** Position just inside cell (row, col) of the first table. */
function cellStart(doc: Node, row: number, col: number): number {
  const t = firstTable(doc)!;
  let p = t.pos + 1;
  for (let r = 0; r < row; r++) p += t.node.child(r).nodeSize;
  p += 1;
  const rowNode = t.node.child(row);
  for (let c = 0; c < col; c++) p += rowNode.child(c).nodeSize;
  return p + 1;
}

/** Each cell's text, with a line break shown as "\n". */
function cells(doc: Node): string[][] {
  const t = firstTable(doc);
  if (!t) return [];
  const rows: string[][] = [];
  t.node.forEach((row) => {
    const r: string[] = [];
    row.forEach((cell) => {
      let s = "";
      cell.forEach((child) => {
        s += child.isText ? child.text : child.type.name === "hard_break" ? "\n" : "￼";
      });
      r.push(s);
    });
    rows.push(r);
  });
  return rows;
}

const kinds = (doc: Node) => {
  const out: string[] = [];
  doc.forEach((n) => out.push(n.type.name));
  return out;
};

/** Type into a cell and save. */
function typeInCell(text: string, row: number, col: number, typed: string, at: "start" | "end" = "end") {
  const { state, source } = load(text);
  const start = cellStart(state.doc, row, col);
  const cellNode = state.doc.resolve(start).parent;
  const pos = at === "start" ? start : start + cellNode.content.size;
  const after = state.apply(state.tr.insertText(typed, pos));
  return { out: serializeMarkdown(after.doc, source), doc: after.doc };
}

/** Put a line break in a cell (Shift-Return) and save. */
function breakInCell(text: string, row: number, col: number, offset: number) {
  const { state, source } = load(text);
  const pos = cellStart(state.doc, row, col) + offset;
  const after = state.apply(state.tr.insert(pos, schema.nodes.hard_break.create()));
  return serializeMarkdown(after.doc, source);
}

// The many ways agents write tables ------------------------------------------------

const AGENT_TABLES: Record<string, string> = {
  "line breaks with <br>": "| Option | Notes |\n|---|---|\n| A | Fast<br>Cheap |\n| B | Slow<br>Costly<br>Rare |\n",
  "line breaks with <br/>": "| Option | Notes |\n|---|---|\n| A | Fast<br/>Cheap |\n",
  "line breaks with <br />": "| Option | Notes |\n|---|---|\n| A | Fast<br />Cheap |\n",
  "line breaks in capitals": "| Option | Notes |\n|---|---|\n| A | Fast<BR>Cheap |\n",
  "a line break alone": "| A | B |\n|---|---|\n| <br> | x |\n",
  "bold and italic as HTML": "| A | B |\n|---|---|\n| <b>Yes</b> | <i>maybe</i> |\n| <strong>No</strong> | <em>never</em> <s>old</s> <del>gone</del> |\n",
  "no pipes at the ends": "Option | Cost\n--- | ---\nA | Free\nB | $5\n",
  "alignment": "| Left | Centre | Right |\n|:-----|:------:|------:|\n| a | b | c |\n",
  "escaped pipes": "| Expression | Meaning |\n|---|---|\n| a \\| b | a or b |\n",
  "a pipe in code": "| Code | Note |\n|---|---|\n| `x \\|\\| y` | or |\n",
  "links and web addresses": "| Site | Address |\n|---|---|\n| [Docs](https://example.com/docs) | <https://example.com> |\n",
  "footnote references": "| Claim | Source |\n|---|---|\n| Growth[^1] | Survey |\n\n[^1]: From the 2025 survey.\n",
  "pictures": "| Logo | Name |\n|---|---|\n| ![logo](logo.png) | Acme |\n",
  "emoji and entities": "| Status | Note |\n|:-:|---|\n| ✅ | 5&nbsp;days &amp; counting |\n| ❌ | **12%** |\n",
  "empty cells": "| A | B | C |\n|---|---|---|\n|  |  |  |\n| x |  | z |\n",
  "one by one": "| Only |\n|---|\n| cell |\n",
  "a header row only": "| A | B |\n|---|---|\n",
  "rows with fewer cells": "| A | B | C |\n|---|---|---|\n| 1 |\n| 1 | 2 |\n",
  "padded and aligned by the agent": "| Name   | Cost |\n| ------ | ---: |\n| Tool A |   $5 |\n",
  "tight dashes": "|A|B|\n|-|-|\n|1|2|\n",
  "after a paragraph with no blank line": "Here are the options:\n| A | B |\n|---|---|\n| 1 | 2 |\n",
  "in a list": "- Options:\n\n  | A | B |\n  |---|---|\n  | 1 | 2 |\n",
  "in a quote": "> | A | B |\n> |---|---|\n> | 1 | 2 |\n",
  "CRLF line endings": "| A | B |\r\n|---|---|\r\n| 1<br>2 | 3 |\r\n",
  "no last newline": "| A | B |\n|---|---|\n| 1 | 2 |",
  "trailing spaces": "| A | B |  \n|---|---|\n| 1 | 2 |   \n",
  "very wide": `| ${Array.from({ length: 20 }, (_, i) => `Column ${i + 1}`).join(" | ")} |\n|${"---|".repeat(20)}\n| ${Array.from({ length: 20 }, (_, i) => `value ${i + 1}`).join(" | ")} |\n`,
};

// HTML the grid can't show, and rows with more cells than the header.
const STAYS_MARKDOWN: Record<string, string> = {
  "a list in a cell": "| A |\n|---|\n| <ul><li>x</li></ul> |\n",
  "coloured text": '| A |\n|---|\n| <span style="color:red">x</span> |\n',
  "superscript": "| A |\n|---|\n| x<sup>2</sup> |\n",
  "underline": "| A |\n|---|\n| <u>x</u> |\n",
  "an HTML comment": "| A |\n|---|\n| x <!-- note --> y |\n",
  "a bold tag left open": "| A |\n|---|\n| <b>x |\n",
  "tags closed in the wrong order": "| A |\n|---|\n| <b><i>x</b></i> |\n",
  "bold inside bold": "| A |\n|---|\n| <b>**x**</b> |\n",
  "a row with more cells than the header": "| A | B |\n|---|---|\n| 1 | 2 | 3 |\n",
  "code as HTML": "| A |\n|---|\n| <code>x</code> |\n",
};

describe("tables as agents write them", () => {
  for (const [what, text] of Object.entries(AGENT_TABLES)) {
    it(`show as a grid: ${what}`, () => {
      const { doc } = load(text);
      expect(firstTable(doc), kinds(doc).join(" ")).not.toBeNull();
      let raw = 0;
      doc.descendants((n) => {
        if (n.type.name === "raw_block") raw++;
      });
      expect(raw).toBe(0);
    });

    it(`are written back byte for byte when not edited: ${what}`, () => {
      const { doc, source } = load(text);
      expect(serializeMarkdown(doc, source)).toBe(text);
    });

    it(`read back as what the grid showed after an edit: ${what}`, () => {
      const { state, source } = load(text);
      const pos = cellStart(state.doc, 0, 0);
      const edited = state.apply(state.tr.insertText("New ", pos)).doc;
      const out = serializeMarkdown(edited, source);
      expect(cells(parseMarkdown(out).doc)).toEqual(cells(edited));
    });
  }

  for (const [what, text] of Object.entries(STAYS_MARKDOWN)) {
    it(`stay as Markdown text, kept exactly: ${what}`, () => {
      const { doc, source } = load(text);
      expect(firstTable(doc)).toBeNull();
      expect(doc.child(0).type.name).toBe("raw_block");
      expect(doc.child(0).attrs.kind).toBe("table");
      expect(serializeMarkdown(doc, source)).toBe(text);
    });
  }

  it("a row with an extra empty cell (a stray pipe) still shows as a grid", () => {
    expect(firstTable(load("| A | B |\n|---|---|\n| 1 | 2 | |\n").doc)).not.toBeNull();
  });

  it("show a line break where the cell has <br>", () => {
    const { doc } = load(AGENT_TABLES["line breaks with <br>"]);
    expect(cells(doc)).toEqual([["Option", "Notes"], ["A", "Fast\nCheap"], ["B", "Slow\nCostly\nRare"]]);
  });

  it("show <b>, <i>, <s> as bold, italic and struck-through words", () => {
    const { doc } = load(AGENT_TABLES["bold and italic as HTML"]);
    const marks: string[] = [];
    doc.descendants((n) => {
      if (n.isText) marks.push(`${n.text}:${n.marks.map((m) => m.type.name).join("+")}`);
    });
    expect(marks).toEqual(["A:", "B:", "Yes:strong", "maybe:em", "No:strong", "never:em", " :", "old:strike", " :", "gone:strike"]);
  });
});

describe("an edited table", () => {
  const BR = AGENT_TABLES["line breaks with <br>"];

  it("writes its line breaks back as <br>", () => {
    const { out } = typeInCell(BR, 1, 0, "+");
    expect(out).toBe(
      "| Option | Notes                  |\n| ------ | ---------------------- |\n| A+     | Fast<br>Cheap          |\n| B      | Slow<br>Costly<br>Rare |\n",
    );
  });

  it("keeps the file's own way of writing line breaks", () => {
    expect(typeInCell(AGENT_TABLES["line breaks with <br/>"], 1, 0, "+").out).toContain("| Fast<br/>Cheap |");
    expect(typeInCell(AGENT_TABLES["line breaks with <br />"], 1, 0, "+").out).toContain("| Fast<br />Cheap |");
    expect(typeInCell(AGENT_TABLES["line breaks in capitals"], 1, 0, "+").out).toContain("| Fast<BR>Cheap |");
  });

  it("writes a new line break as <br>, or the way the table already writes them", () => {
    const plain = "| A | B |\n|---|---|\n| one two | x |\n";
    expect(breakInCell(plain, 1, 0, 3)).toBe("| A           | B   |\n| ----------- | --- |\n| one<br> two | x   |\n");
    const slashed = "| A | B |\n|---|---|\n| one two | x<br/>y |\n";
    expect(breakInCell(slashed, 1, 0, 3)).toContain("| one<br/> two | x<br/>y |");
    const again = parseMarkdown(breakInCell(plain, 1, 0, 3)).doc;
    expect(cells(again)[1]).toEqual(["one\n two", "x"]);
  });

  it("keeps a line break at the end of a cell", () => {
    const out = breakInCell("| A |\n|---|\n| one |\n", 1, 0, 3);
    expect(out).toContain("| one<br> |");
    expect(cells(parseMarkdown(out).doc)[1]).toEqual(["one\n"]);
  });

  it("keeps HTML bold and italic as HTML, and Markdown bold as Markdown", () => {
    const text = "| A | B |\n|---|---|\n| <b>Yes</b> | **No** <i>maybe</i> |\n";
    const { out, doc } = typeInCell(text, 1, 1, "!"); // typed at the end of the italic words, so italic too
    expect(out).toContain("| <b>Yes</b> | **No** <i>maybe!</i> |");
    expect(cells(parseMarkdown(out).doc)).toEqual(cells(doc));
  });

  // Changed 2026-11-09: a paragraph now reads <b> as bold too (as Word does),
  // so bold words from a cell keep their HTML form there and still read as bold.
  it("bold words from a cell that end up in a paragraph still read as bold", () => {
    const { state, source } = load("| A |\n|---|\n| <b>Yes</b> |\n\nAfter.\n");
    const start = cellStart(state.doc, 1, 0);
    const bold = state.doc.slice(start, start + 3);
    const end = state.doc.content.size - 1;
    const out = serializeMarkdown(state.apply(state.tr.replace(end, end, bold)).doc, source);
    expect(out).toContain("After.<b>Yes</b>");
    const after = parseMarkdown(out).doc.lastChild!;
    expect(after.type.name).toBe("paragraph");
    expect(after.lastChild!.marks.map((m) => m.type.name)).toEqual(["strong"]);
  });

  it("doesn't escape a cell that starts like a list, heading or quote", () => {
    const text = "| A | B |\n|---|---|\n| - one<br>- two | # 1 |\n| > quoted | 1. first |\n";
    const { out, doc } = typeInCell(text, 0, 0, "!");
    expect(out).toContain("| - one<br>- two | # 1      |");
    expect(out).toContain("| > quoted       | 1. first |");
    expect(cells(parseMarkdown(out).doc)).toEqual(cells(doc));
  });

  it("keeps <br> typed as words as words", () => {
    const { out } = typeInCell("| A |\n|---|\n| x |\n", 1, 0, " <br> y");
    expect(out).toContain("| x \\<br> y |");
    expect(cells(parseMarkdown(out).doc)[1]).toEqual(["x <br> y"]);
  });

  it("keeps escaped pipes, a pipe in code, links and footnote references", () => {
    const text =
      "| A | B |\n|---|---|\n| a \\| b | `x \\|\\| y` |\n| [Docs](https://example.com) | Growth[^1] |\n\n[^1]: Note.\n";
    const { out, doc } = typeInCell(text, 0, 0, "!");
    expect(out).toContain("| a \\| b");
    expect(out).toContain("`x \\|\\| y`");
    expect(out).toContain("[Docs](https://example.com)");
    expect(out).toContain("Growth[^1]");
    expect(cells(parseMarkdown(out).doc)).toEqual(cells(doc));
  });

  // (Second review, R-MD-11: code ending in "\|" lost its backslash.)
  it("keeps a backslash before a pipe in code", () => {
    for (const code of ["a1\\|", "a\\\\|b", "x | y", "\\|\\|"]) {
      const table = schema.node("table", null, [
        schema.node("table_row", null, [schema.node("table_header", null, [schema.text("h")])]),
        schema.node("table_row", null, [schema.node("table_cell", null, [schema.text("run "), schema.text(code, [schema.marks.code.create()])])]),
      ]);
      const out = serializeMarkdown(schema.node("doc", null, [table]), parseMarkdown("").source);
      expect(cells(parseMarkdown(out).doc), out).toEqual([["h"], [`run ${code}`]]);
    }
  });

  it("keeps CRLF line endings", () => {
    const { out } = typeInCell(AGENT_TABLES["CRLF line endings"], 1, 1, "!");
    expect(out).toBe("| A      | B   |\r\n| ------ | --- |\r\n| 1<br>2 | 3!  |\r\n");
  });

  it("with rows of fewer cells gets the missing cells, empty", () => {
    const { out } = typeInCell(AGENT_TABLES["rows with fewer cells"], 1, 0, "!");
    expect(out).toBe("| A   | B   | C   |\n| --- | --- | --- |\n| 1!  |     |     |\n| 1   | 2   |     |\n");
  });

  it("written as a one-by-one table stays a valid table", () => {
    const { out } = typeInCell(AGENT_TABLES["one by one"], 1, 0, "s");
    expect(out).toBe("| Only  |\n| ----- |\n| cells |\n");
  });

  it("in a list or a quote stays where it was", () => {
    const listed = typeInCell(AGENT_TABLES["in a list"], 1, 0, "!").out;
    expect(cells(parseMarkdown(listed).doc)).toEqual([["A", "B"], ["1!", "2"]]);
    expect(kinds(parseMarkdown(listed).doc)).toEqual(["bullet_list"]);
    const quoted = typeInCell(AGENT_TABLES["in a quote"], 1, 0, "!").out;
    expect(cells(parseMarkdown(quoted).doc)).toEqual([["A", "B"], ["1!", "2"]]);
    expect(kinds(parseMarkdown(quoted).doc)).toEqual(["blockquote"]);
  });

  it("leaves every other block exactly as it was", () => {
    const text = "Intro  with  spaces.\n\n" + BR + "\n\n\nAfter *this*.\n";
    const { out } = typeInCell(text, 1, 0, "+");
    expect(out.startsWith("Intro  with  spaces.\n\n")).toBe(true);
    expect(out.endsWith("\n\n\nAfter *this*.\n")).toBe(true);
  });

  it("can be put back to the very same text by undoing the edit", () => {
    const { state, source } = load(BR);
    const pos = cellStart(state.doc, 1, 0) + 1;
    const typed = state.apply(state.tr.insertText("+", pos));
    const undone = typed.apply(typed.tr.delete(pos, pos + 1));
    expect(serializeMarkdown(undone.doc, source)).toBe(BR);
  });
});

describe("a 500-row table", () => {
  const rows = Array.from({ length: 500 }, (_, i) => `| Item ${i + 1} | Note ${i + 1}<br>more | ${i * 3} |`);
  const BIG = `| Item | Notes | Count |\n|---|---|---:|\n${rows.join("\n")}\n`;

  it("shows as a grid and is written back byte for byte", () => {
    const { doc, source } = load(BIG);
    expect(firstTable(doc)!.node.childCount).toBe(501);
    expect(serializeMarkdown(doc, source)).toBe(BIG);
  });

  it("is written back quickly after an edit", () => {
    const { state, source } = load(BIG);
    const pos = cellStart(state.doc, 250, 0);
    const edited = state.apply(state.tr.insertText("x", pos)).doc;
    const start = performance.now();
    const out = serializeMarkdown(edited, source);
    expect(performance.now() - start).toBeLessThan(500);
    expect(out).toContain("| xItem 250 |");
    expect(cells(parseMarkdown(out).doc)).toEqual(cells(edited));
  });
});
