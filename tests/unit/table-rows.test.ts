// The Table menu's row items keep each column's alignment, whichever row they act on.
import { describe, expect, it } from "vitest";
import { EditorState, TextSelection, type Command } from "prosemirror-state";
import { parseMarkdown, serializeMarkdown } from "../../src/core/markdown";
import { tableBehaviour, tableCommands } from "../../src/renderer/tables";

const TABLE = "| A | B | C |\n|:--|--:|:-:|\n| 1 | 2 | 3 |\n";

/** Run a Table menu item with the cursor in the cell holding `text`; the file it saves. */
function run(text: string, command: Command): string {
  const { doc, source } = parseMarkdown(TABLE);
  let state = EditorState.create({ doc, plugins: tableBehaviour() });
  let at = -1;
  state.doc.descendants((node, pos) => {
    if (at < 0 && node.isText && node.text === text) at = pos;
  });
  state = state.apply(state.tr.setSelection(TextSelection.create(state.doc, at)));
  let changed = false;
  command(state, (tr) => {
    state = state.applyTransaction(tr).state;
    changed = true;
  });
  expect(changed).toBe(true);
  return serializeMarkdown(state.doc, source);
}

const alignmentRow = (file: string) => file.split("\n")[1];

describe("Table rows", () => {
  it("Add row above the header row keeps every column's alignment (the new row becomes the header)", () => {
    const out = run("A", tableCommands.addRowAbove);
    expect(alignmentRow(out)).toMatch(/^\| :-+ \| -+: \| :-+: \|$/);
    expect(out.split("\n")).toHaveLength(5); // the new header, the alignment, A B C, 1 2 3, and the end
  });

  it("Add row below and Add row above a body row keep it too", () => {
    expect(alignmentRow(run("A", tableCommands.addRowBelow))).toMatch(/^\| :-+ \| -+: \| :-+: \|$/);
    expect(alignmentRow(run("1", tableCommands.addRowAbove))).toMatch(/^\| :-+ \| -+: \| :-+: \|$/);
  });

  it("deleting the header row keeps the alignment for the row that becomes the header", () => {
    const out = run("A", tableCommands.deleteRow);
    expect(out.split("\n")[0]).toMatch(/^\| 1 +\| 2 +\| 3 +\|$/);
    expect(alignmentRow(out)).toMatch(/^\| :-+ \| -+: \| :-+: \|$/);
  });
});
