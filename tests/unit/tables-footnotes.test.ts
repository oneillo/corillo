import { describe, expect, it } from "vitest";
import { EditorState, type Transaction } from "prosemirror-state";
import { history, redo, undo } from "prosemirror-history";
import type { Node } from "prosemirror-model";
import { parseMarkdown, serializeMarkdown } from "../../src/core/markdown";
import { schema } from "../../src/core/schema";
import { footnotePlugin } from "../../src/renderer/footnotes";

function load(text: string) {
  const { doc, source } = parseMarkdown(text);
  return { state: EditorState.create({ doc }), source };
}

/** Position of the start of the text inside table cell (row, col) of the first table. */
function cellStart(doc: Node, row: number, col: number): number {
  let found = -1;
  doc.descendants((node, pos) => {
    if (found >= 0) return false;
    if (node.type.name === "table") {
      let p = pos + 1;
      for (let r = 0; r < row; r++) p += node.child(r).nodeSize;
      p += 1; // into the row
      const rowNode = node.child(row);
      for (let c = 0; c < col; c++) p += rowNode.child(c).nodeSize;
      found = p + 1; // into the cell
      return false;
    }
    return true;
  });
  return found;
}

function cellTexts(doc: Node): string[][] {
  const rows: string[][] = [];
  doc.descendants((node) => {
    if (node.type.name === "table_row") {
      const r: string[] = [];
      node.forEach((c) => r.push(c.textContent));
      rows.push(r);
      return false;
    }
    return true;
  });
  return rows;
}

const TABLE = "Intro.\n\n| Name | Cost |\n|:-----|-----:|\n| Tool A | Free |\n| Tool B | $5 |\n\nOutro.\n";

describe("tables", () => {
  it("are shown as tables with their cells", () => {
    const { state } = load(TABLE);
    expect(state.doc.child(1).type.name).toBe("table");
    expect(cellTexts(state.doc)).toEqual([["Name", "Cost"], ["Tool A", "Free"], ["Tool B", "$5"]]);
    expect(state.doc.child(1).child(0).child(1).attrs.align).toBe("right");
  });

  it("typing in a cell rewrites only the table, neatly aligned, keeping column alignment", () => {
    const { state, source } = load(TABLE);
    const pos = cellStart(state.doc, 1, 1) + "Free".length;
    const out = serializeMarkdown(state.apply(state.tr.insertText(" for teams", pos)).doc, source);
    expect(out).toBe(
      "Intro.\n\n| Name   | Cost           |\n| :----- | -------------: |\n| Tool A | Free for teams |\n| Tool B | $5             |\n\nOutro.\n",
    );
  });

  const typeInCell = (typed: string) => {
    const { state, source } = load(TABLE);
    const pos = cellStart(state.doc, 1, 0) + "Tool A".length;
    const after = state.apply(state.tr.insertText(typed, pos));
    const out = serializeMarkdown(after.doc, source);
    return { after, out, again: cellTexts(parseMarkdown(out).doc) };
  };

  it("a space typed at the end of a cell is kept while editing and never breaks the table", () => {
    const { after, again } = typeInCell(" ");
    expect(cellTexts(after.doc)[1][0]).toBe("Tool A ");
    expect(again[1]).toEqual(["Tool A", "Free"]);
    expect(again).toHaveLength(3);
  });

  it("words separated by spaces stay separate", () => {
    const { again } = typeInCell(" and more  words");
    expect(again[1][0]).toBe("Tool A and more  words");
  });

  it("a space at the very start of a cell doesn't break the table", () => {
    const { state, source } = load(TABLE);
    const pos = cellStart(state.doc, 2, 1);
    const out = serializeMarkdown(state.apply(state.tr.insertText("  ", pos)).doc, source);
    expect(cellTexts(parseMarkdown(out).doc)).toEqual([["Name", "Cost"], ["Tool A", "Free"], ["Tool B", "$5"]]);
  });

  it("a pipe typed in a cell stays inside the cell", () => {
    const { again } = typeInCell(" | not a column");
    expect(again[1]).toEqual(["Tool A | not a column", "Free"]);
  });

  it("an empty cell stays an empty cell", () => {
    const { state, source } = load(TABLE);
    const from = cellStart(state.doc, 2, 1);
    const out = serializeMarkdown(state.apply(state.tr.delete(from, from + 2)).doc, source);
    expect(cellTexts(parseMarkdown(out).doc)[2]).toEqual(["Tool B", ""]);
  });

  it("bold and code in cells survive, including a pipe in code", () => {
    const text = "| a | b |\n|---|---|\n| **bold** | `x\\|y` |\n";
    const { state, source } = load(text);
    const pos = cellStart(state.doc, 1, 0) + 4;
    const out = serializeMarkdown(state.apply(state.tr.insertText("er", pos)).doc, source);
    expect(out).toBe("| a          | b      |\n| ---------- | ------ |\n| **bolder** | `x\\|y` |\n");
    expect(cellTexts(parseMarkdown(out).doc)[1]).toEqual(["bolder", "x|y"]);
  });

  it("a table with a list inside a cell is kept as Markdown (a line break isn't: see tables-markdown)", () => {
    const { state } = load("| a |\n|---|\n| <ul><li>x</li></ul> |\n");
    expect(state.doc.child(0).type.name).toBe("raw_block");
    expect(load("| a |\n|---|\n| x<br>y |\n").state.doc.child(0).type.name).toBe("table");
  });

  it("a new table written from scratch is valid Markdown", () => {
    const { table, table_row, table_header, table_cell } = schema.nodes;
    const doc = schema.node("doc", null, [
      table.create(null, [
        table_row.create(null, [table_header.create(null, schema.text("H1")), table_header.create(null, schema.text("H2"))]),
        table_row.create(null, [table_cell.create(null, schema.text("a")), table_cell.create()]),
      ]),
    ]);
    const out = serializeMarkdown(doc, parseMarkdown("").source);
    expect(out).toBe("| H1  | H2  |\n| --- | --- |\n| a   |     |\n");
    expect(cellTexts(parseMarkdown(out).doc)).toEqual([["H1", "H2"], ["a", ""]]);
  });
});

const NOTES = "Claim one.[^1] Claim two.[^src]\n\n[^1]: First source.\n[^src]: Second source,\n    on two lines.\n\nEnd.\n";

describe("footnotes", () => {
  it("are shown as markers in the text and notes", () => {
    const { state } = load(NOTES);
    const refs: string[] = [];
    state.doc.descendants((n) => {
      if (n.type.name === "footnote_ref") refs.push(n.attrs.label);
    });
    expect(refs).toEqual(["1", "src"]);
    expect(state.doc.child(1).type.name).toBe("footnote_def");
    expect(state.doc.child(1).textContent).toBe("First source.");
    // A note written over two lines keeps them, like a paragraph.
    expect(state.doc.child(2).textContent).toBe("Second source,\non two lines.");
  });

  it("editing a note rewrites only that note", () => {
    const { state, source } = load(NOTES);
    const pos = state.doc.child(0).nodeSize + 1 + "First source".length;
    const out = serializeMarkdown(state.apply(state.tr.insertText(", page 4", pos)).doc, source);
    expect(out).toBe(NOTES.replace("First source.", "First source, page 4."));
  });

  it("a new footnote is written with its marker and note", () => {
    const { state, source } = load("Text.\n");
    const ref = schema.nodes.footnote_ref.create({ label: "1" });
    const def = schema.nodes.footnote_def.create({ label: "1" }, schema.text("A note."));
    let tr = state.tr.insert(1 + "Text.".length, ref);
    tr = tr.insert(tr.doc.content.size, def);
    const out = serializeMarkdown(state.apply(tr).doc, source);
    expect(out).toBe("Text.[^1]\n\n[^1]: A note.\n");
    const again = parseMarkdown(out).doc;
    expect(again.child(1).type.name).toBe("footnote_def");
  });

  it("a footnote marker in a heading is kept and can be edited around", () => {
    const text = "# Title[^1]\n\nBody.\n\n[^1]: About the title.\n";
    const { state, source } = load(text);
    expect(state.doc.child(0).type.name).toBe("heading");
    expect(state.doc.child(0).lastChild?.type.name).toBe("footnote_ref");
    expect(serializeMarkdown(state.doc, source)).toBe(text);
    const out = serializeMarkdown(state.apply(state.tr.insertText("New ", 1)).doc, source);
    expect(out).toBe(text.replace("# Title", "# New Title"));
  });

  it("a footnote with several paragraphs is kept as Markdown", () => {
    const text = "x[^1]\n\n[^1]: one\n\n    two\n";
    const { state, source } = load(text);
    expect(state.doc.child(1).type.name).toBe("raw_block");
    expect(serializeMarkdown(state.doc, source)).toBe(text);
  });
});

describe("a footnote's note goes only when the person deletes its marker", () => {
  const TEXT = "First point here.[^1]\n\nSecond point here.\n\n[^1]: Source: the survey.\n";
  const start = () => {
    const { doc, source } = parseMarkdown(TEXT);
    return { state: EditorState.create({ doc, plugins: [history(), footnotePlugin()] }), source };
  };
  const markerAt = (doc: Node) => {
    let at = -1;
    doc.descendants((n, pos) => {
      if (n.type.name === "footnote_ref") at = pos;
    });
    return at;
  };
  const endOf = (doc: Node, text: string) => {
    let at = -1;
    doc.descendants((n, pos) => {
      if (n.isText && n.text!.includes(text)) at = pos + n.text!.indexOf(text) + text.length;
    });
    return at;
  };
  const run = (state: EditorState, command: (s: EditorState, d: (tr: Transaction) => void) => boolean) => {
    let next = state;
    expect(command(state, (tr) => (next = state.apply(tr)))).toBe(true);
    return next;
  };

  it("deleted: the note goes with it, and one Undo brings both back", () => {
    const { state, source } = start();
    const at = markerAt(state.doc);
    const deleted = state.apply(state.tr.delete(at, at + 1));
    expect(serializeMarkdown(deleted.doc, source)).toBe("First point here.\n\nSecond point here.\n");
    const back = run(deleted, undo);
    expect(serializeMarkdown(back.doc, source)).toBe(TEXT);
    const again = run(back, redo);
    expect(serializeMarkdown(again.doc, source)).toBe("First point here.\n\nSecond point here.\n");
  });

  it("cut, pasted elsewhere, then both undone: the document is as it was", () => {
    const { state, source } = start();
    const at = markerAt(state.doc);
    const marker = state.doc.nodeAt(at)!;
    const cut = state.apply(state.tr.delete(at, at + 1).setMeta("uiEvent", "cut"));
    const pasted = cut.apply(cut.tr.insert(endOf(cut.doc, "Second point here."), marker).setMeta("uiEvent", "paste"));
    expect(serializeMarkdown(pasted.doc, source)).toBe("First point here.\n\nSecond point here.[^1]\n\n[^1]: Source: the survey.\n");
    const once = run(pasted, undo);
    expect(serializeMarkdown(once.doc, source)).toContain("[^1]: Source: the survey.");
    const twice = run(once, undo);
    expect(serializeMarkdown(twice.doc, source)).toBe(TEXT);
  });

  it("cut, undone and redone: the note stays", () => {
    const { state, source } = start();
    const at = markerAt(state.doc);
    const cut = state.apply(state.tr.delete(at, at + 1).setMeta("uiEvent", "cut"));
    const redone = run(run(cut, undo), redo);
    expect(serializeMarkdown(redone.doc, source)).toBe("First point here.\n\nSecond point here.\n\n[^1]: Source: the survey.\n");
  });
});
