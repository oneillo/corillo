// Tables you edit like tables. The rules that keep them from breaking:
// - The first row is always the header row, as in a Markdown table.
// - Every cell in a column shows the column's alignment, the one that's saved.
// - Enter moves to the cell below, adding a row at the bottom. Shift-Enter
//   starts a new line in the cell (saved as "<br>", since a Markdown table row
//   is one line). Tab moves to the next cell and selects its text, as in
//   Word, adding a row after the last cell. The arrow keys go from cell to
//   cell, never into the gap between two cells.
// - Pasting several paragraphs into a cell puts each on its own line in that
//   cell instead of splitting the table.
import { Plugin, Selection, TextSelection, type Command, type EditorState, type Transaction } from "prosemirror-state";
import { Fragment, Slice, type Node, type ResolvedPos } from "prosemirror-model";
import { GapCursor } from "prosemirror-gapcursor";

/** Whether the gap cursor can stand here (the library's own test, left out of its types; a unit test watches it: prosemirror-private-parts.test.ts). */
export const gapAllowed = ($pos: ResolvedPos): boolean => (GapCursor as unknown as { valid($pos: ResolvedPos): boolean }).valid($pos);
import type { EditorView } from "prosemirror-view";
import { keymap } from "prosemirror-keymap";
import {
  tableEditing,
  goToNextCell,
  addRowAfter,
  addRowBefore,
  addColumnAfter,
  addColumnBefore,
  deleteRow,
  deleteColumn,
  deleteTable,
  isInTable,
  selectedRect,
  TableMap,
  CellSelection,
  cellAround,
  nextCell,
} from "prosemirror-tables";
import { schema } from "../core/schema";
import { changedRangesAcross, type Range } from "./changed-ranges";

const n = schema.nodes;

/**
 * Make the header row and column alignment match what will be saved, in the
 * tables an edit touched (every table if `ranges` is null).
 */
function normalise(state: EditorState, ranges: Range[] | null): Transaction | null {
  let tr: Transaction | null = null;
  const done = new Set<number>();
  const visit = (node: Node, pos: number): boolean => {
    if (node.type !== n.table) return !node.isTextblock;
    if (done.has(pos)) return false;
    done.add(pos);
    const map = TableMap.get(node);
    if (map.problems) return false; // the table plugin repairs it first
    const start = pos + 1;
    const header: (string | null)[] = [];
    for (let c = 0; c < map.width; c++) header[c] = node.nodeAt(map.map[c])?.attrs.align ?? null;
    const seen = new Set<number>();
    for (let r = 0; r < map.height; r++) {
      for (let c = 0; c < map.width; c++) {
        const offset = map.map[r * map.width + c];
        if (seen.has(offset)) continue;
        seen.add(offset);
        const cell = node.nodeAt(offset)!;
        const type = r === 0 ? n.table_header : n.table_cell;
        const align = header[c];
        if (cell.type !== type || cell.attrs.align !== align) {
          tr ??= state.tr;
          tr.setNodeMarkup(tr.mapping.map(start + offset), type, { ...cell.attrs, align });
        }
      }
    }
    return false;
  };
  if (!ranges) state.doc.descendants(visit);
  else {
    // One position either side, so a table that ends where the change starts counts too.
    const size = state.doc.content.size;
    for (const [from, to] of ranges) state.doc.nodesBetween(Math.max(0, from - 1), Math.min(size, to + 1), visit);
  }
  return tr;
}

/** Enter in a cell: go to the cell below, adding a row at the bottom. */
export const enterInCell: Command = (state, dispatch) => {
  if (!isInTable(state)) return false;
  if (!dispatch) return true;
  let tr = state.tr;
  if (selectedRect(state).bottom >= selectedRect(state).map.height) addRowAfter(state, (t) => (tr = t));
  const next = state.apply(tr);
  const rect = selectedRect(next);
  if (rect.bottom >= rect.map.height) return false;
  const cellPos = rect.tableStart + rect.map.map[rect.bottom * rect.map.width + rect.left];
  const cell = next.doc.nodeAt(cellPos)!;
  tr.setSelection(TextSelection.create(tr.doc, cellPos + cell.nodeSize - 1));
  dispatch(tr.scrollIntoView());
  return true;
};

/** Tab: next cell, or a new row after the last cell. */
const tabInCell: Command = (state, dispatch) => {
  if (!isInTable(state)) return false;
  if (goToNextCell(1)(state, dispatch)) return true;
  if (!dispatch) return true;
  let tr = state.tr;
  addRowAfter(state, (t) => (tr = t));
  const rect = selectedRect(state.apply(tr));
  const cellPos = rect.tableStart + rect.map.map[rect.bottom * rect.map.width];
  tr.setSelection(TextSelection.create(tr.doc, cellPos + 1));
  dispatch(tr.scrollIntoView());
  return true;
};

const shiftTabInCell: Command = (state, dispatch) => {
  if (!isInTable(state)) return false;
  goToNextCell(-1)(state, dispatch);
  return true; // never lift a list or leave the table
};

/**
 * Shift and an arrow key at the edge of a cell's text starts selecting whole
 * cells. (The table library does this only for cells that hold paragraphs;
 * Corillo's cells hold a single line of text, so it's done here.)
 */
function startCellSelection(axis: "horiz" | "vert", dir: 1 | -1): Command {
  return (state, dispatch, view) => {
    if (!view || !(state.selection instanceof TextSelection) || !isInTable(state)) return false;
    const $cell = cellAround(state.selection.$head);
    if (!$cell) return false;
    const side = axis === "vert" ? (dir > 0 ? "down" : "up") : dir > 0 ? "right" : "left";
    if (!view.endOfTextblock(side)) return false;
    const $next = nextCell($cell, axis, dir);
    if (!$next) return false;
    dispatch?.(state.tr.setSelection(new CellSelection($cell, $next)));
    return true;
  };
}

/**
 * An arrow key at the edge of a cell's text goes to the next cell that way
 * (again, the table library only does this for cells that hold paragraphs).
 * Up and down keep the cursor's place across, as between lines; left and
 * right follow the text, from the end of a row to the start of the next.
 */
function arrowOutOfCell(axis: "horiz" | "vert", dir: 1 | -1): Command {
  return (state, dispatch, view) => {
    const sel = state.selection;
    if (!view || !(sel instanceof TextSelection) || !sel.empty || !isInTable(state)) return false;
    const $cell = cellAround(sel.$head);
    if (!$cell) return false;
    const side = axis === "vert" ? (dir > 0 ? "down" : "up") : dir > 0 ? "right" : "left";
    if (!view.endOfTextblock(side)) return false;
    const cell = $cell.nodeAfter!;
    let target: Selection | null;
    if (axis === "horiz") {
      target = Selection.findFrom(state.doc.resolve(dir > 0 ? $cell.pos + cell.nodeSize : $cell.pos), dir) ?? outOfTable(state, $cell, dir);
    } else {
      const $next = nextCell($cell, "vert", dir);
      if ($next) target = TextSelection.create(state.doc, sameColumnSpot(view, sel.head, $next.pos, $next.nodeAfter!, dir));
      else target = outOfTable(state, $cell, dir); // past the top or bottom row
    }
    if (!target) return false;
    dispatch?.(state.tr.setSelection(target).scrollIntoView());
    return true;
  };
}

/**
 * Out of the table that way: the next place to type past it or, when the
 * table ends (or starts) the document, the gap just past it, where typing
 * starts a new paragraph.
 */
function outOfTable(state: EditorState, $cell: ResolvedPos, dir: 1 | -1): Selection | null {
  const table = $cell.depth - 1;
  const $edge = state.doc.resolve(dir > 0 ? $cell.after(table) : $cell.before(table));
  return Selection.findFrom($edge, dir) ?? (gapAllowed($edge) ? new GapCursor($edge) : null);
}

/**
 * A click on the page below the document's end, when it ends with a table
 * (or anything else with no line to type on): the gap after it, where typing
 * starts a new paragraph, rather than the table's last cell. Null otherwise.
 */
export function gapBelowEnd(view: EditorView, clientY: number): Selection | null {
  const doc = view.state.doc;
  const $end = doc.resolve(doc.content.size);
  if (!doc.lastChild || !gapAllowed($end)) return null;
  const last = view.nodeDOM(doc.content.size - doc.lastChild.nodeSize);
  if (!(last instanceof HTMLElement) || clientY <= last.getBoundingClientRect().bottom) return null;
  return new GapCursor($end);
}

/** Where in a cell the cursor lands coming from above or below: as far across as it was. */
function sameColumnSpot(view: EditorView, head: number, cellPos: number, cell: Node, dir: 1 | -1): number {
  const from = cellPos + 1;
  const to = cellPos + cell.nodeSize - 1;
  try {
    const dom = view.nodeDOM(cellPos);
    if (dom instanceof HTMLElement) {
      const x = view.coordsAtPos(head).left;
      const box = dom.getBoundingClientRect();
      const line = view.coordsAtPos(dir > 0 ? from : to); // its first line going down, its last going up
      const found = view.posAtCoords({ left: Math.min(Math.max(x, box.left + 1), box.right - 1), top: (line.top + line.bottom) / 2 });
      if (found && found.pos >= from && found.pos <= to) return found.pos;
    }
  } catch {
    // not laid out yet: the start (or end) of the cell will do
  }
  return dir > 0 ? from : to;
}

/** Shift-Enter in a cell: a new line in the same cell. */
export const lineBreakInCell: Command = (state, dispatch) => {
  if (!isInTable(state)) return false;
  // With whole cells selected there's no one place for the line: do nothing.
  if (!(state.selection instanceof TextSelection) || !state.selection.$from.parent.type.spec.tableRole) return true;
  dispatch?.(state.tr.replaceSelectionWith(n.hard_break.create()).scrollIntoView());
  return true;
};

/** Put pasted paragraphs on lines of their own when pasting inside a cell. */
function flattenForCell(slice: Slice): Slice | null {
  let hasBlocks = false;
  slice.content.forEach((node) => {
    if (node.isBlock) hasBlocks = true;
  });
  if (!hasBlocks) return null;
  const inline: Node[] = [];
  slice.content.descendants((node) => {
    if (node.isTextblock) {
      if (node.content.size === 0) return false; // an empty paragraph adds no empty line
      if (inline.length) inline.push(n.hard_break.create());
      node.forEach((child) => {
        if (!n.table_cell.contentMatch.matchType(child.type)) return;
        // Code's lines become lines in the cell, as paragraphs do (a cell has no line breaks of its own).
        if (!child.isText || !child.text!.includes("\n")) return void inline.push(child);
        child.text!.split("\n").forEach((line, i) => {
          if (i) inline.push(n.hard_break.create());
          if (line) inline.push(child.type.schema.text(line, child.marks));
        });
      });
      return false;
    }
    return true;
  });
  return new Slice(Fragment.from(inline), 0, 0);
}

/** Keys inside tables. Goes before the other keymaps so it wins in a cell. */
export function tableKeys(): Plugin {
  return keymap({
    Enter: enterInCell,
    "Shift-Enter": lineBreakInCell,
    Tab: tabInCell,
    "Shift-Tab": shiftTabInCell,
    "Shift-ArrowDown": startCellSelection("vert", 1),
    "Shift-ArrowUp": startCellSelection("vert", -1),
    "Shift-ArrowRight": startCellSelection("horiz", 1),
    "Shift-ArrowLeft": startCellSelection("horiz", -1),
    ArrowDown: arrowOutOfCell("vert", 1),
    ArrowUp: arrowOutOfCell("vert", -1),
    ArrowRight: arrowOutOfCell("horiz", 1),
    ArrowLeft: arrowOutOfCell("horiz", -1),
  });
}

/** Cell selection and table repair, then Corillo's table rules. Goes near the end. */
export function tableBehaviour(): Plugin[] {
  return [
    tableEditing(),
    new Plugin({
      appendTransaction: (trs, _old, state) =>
        trs.some((t) => t.docChanged) ? normalise(state, changedRangesAcross(trs)) : null,
      props: {
        handlePaste(view, _event, slice) {
          if (!isInTable(view.state) || !(view.state.selection instanceof TextSelection)) return false;
          const flat = flattenForCell(slice);
          if (!flat) return false;
          view.dispatch(view.state.tr.replaceSelection(flat).scrollIntoView());
          return true;
        },
      },
    }),
  ];
}

// The Table menu ----------------------------------------------------------

export function setColumnAlign(align: "left" | "center" | "right" | null): Command {
  return (state, dispatch) => {
    if (!isInTable(state)) return false;
    if (!dispatch) return true;
    const rect = selectedRect(state);
    const tr = state.tr;
    const done = new Set<number>();
    for (let r = 0; r < rect.map.height; r++) {
      for (let c = rect.left; c < rect.right; c++) {
        const offset = rect.map.map[r * rect.map.width + c];
        if (done.has(offset)) continue;
        done.add(offset);
        const pos = rect.tableStart + offset;
        const cell = tr.doc.nodeAt(pos)!;
        tr.setNodeMarkup(pos, null, { ...cell.attrs, align });
      }
    }
    dispatch(tr);
    return true;
  };
}

/**
 * Add row above. Above the header row, the new row becomes the header (the
 * first row always is), taking on each column's alignment, which a Markdown
 * table keeps in its header.
 */
const addRowAbove: Command = (state, dispatch) => {
  if (!isInTable(state)) return false;
  if (!dispatch) return addRowBefore(state);
  const rect = selectedRect(state);
  return addRowBefore(state, (tr) => {
    if (rect.top === 0) {
      const table = tr.doc.nodeAt(rect.tableStart - 1)!;
      const map = TableMap.get(table);
      for (let c = 0; c < map.width && c < rect.map.width; c++) {
        const align = rect.table.nodeAt(rect.map.map[c])?.attrs.align ?? null;
        const cell = table.nodeAt(map.map[c])!;
        if (cell.attrs.align !== align) tr.setNodeMarkup(rect.tableStart + map.map[c], null, { ...cell.attrs, align });
      }
    }
    dispatch(tr);
  });
};

export const tableCommands = {
  addRowAbove,
  addRowBelow: addRowAfter,
  addColumnLeft: addColumnBefore,
  addColumnRight: addColumnAfter,
  deleteRow,
  deleteColumn,
  deleteTable,
};
