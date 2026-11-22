// Long documents: Corillo must stay quick on a long formal document, and the
// shortcuts that keep it quick (looking only at what an edit touched) must
// give exactly the same results as looking at everything.
import { describe, expect, it } from "vitest";
import { EditorState, TextSelection, type Transaction } from "prosemirror-state";
import { history, undo, redo } from "prosemirror-history";
import { TableMap } from "prosemirror-tables";
import type { Node } from "prosemirror-model";
import { parseMarkdown, serializeMarkdown } from "../../src/core/markdown";
import { schema } from "../../src/core/schema";
import { wordCount } from "../../src/core/words";
import { footnotePlugin, footnoteNumbering } from "../../src/renderer/footnotes";
import { tableBehaviour } from "../../src/renderer/tables";
import { bigDocument } from "../fixtures/big-document";

const BIG = bigDocument();

/** How long a piece of work takes, in milliseconds: the middle of several tries. */
function timed(work: () => void, tries = 5): number {
  const times: number[] = [];
  for (let i = 0; i < tries; i++) {
    const start = performance.now();
    work();
    times.push(performance.now() - start);
  }
  return times.sort((a, b) => a - b)[Math.floor(tries / 2)];
}

/** The editor's document rules: undo, footnote numbers, table rules. */
const editorPlugins = () => [history(), footnotePlugin(), ...tableBehaviour()];

/** Position at the end of the top-level block nearest the middle that is a paragraph. */
function middleParagraphEnd(doc: Node): number {
  let pos = 0;
  let k = 0;
  for (; k < doc.childCount / 2 || doc.child(k).type.name !== "paragraph"; k++) pos += doc.child(k).nodeSize;
  return pos + doc.child(k).nodeSize - 1;
}

/** The old way of counting: the whole text at once. */
function countAllAtOnce(doc: Node): number {
  return doc.textBetween(0, doc.content.size, " ", " ").match(/\S+/g)?.length ?? 0;
}

describe("a long document", () => {
  const { doc, source } = parseMarkdown(BIG);

  it("is as long as a long formal document: about 30,000 words, 300 headings, 60 tables, 150 footnotes, 30 pictures, 20 diagrams", () => {
    const count: Record<string, number> = {};
    doc.descendants((node) => {
      const name = node.type.name === "code_block" && node.attrs.params === "mermaid" ? "diagram" : node.type.name;
      count[name] = (count[name] ?? 0) + 1;
    });
    expect(wordCount(doc)).toBeGreaterThan(30_000);
    expect(wordCount(doc)).toBeLessThan(35_000);
    expect(count.heading).toBe(301);
    expect(count.table).toBe(60);
    expect(count.footnote_ref).toBe(150);
    expect(count.footnote_def).toBe(150);
    expect(count.image).toBe(30);
    expect(count.diagram).toBe(20);
    expect(count.list_item).toBeGreaterThan(500);
    expect(count.raw_block ?? 0).toBe(0); // everything in it is shown formatted
  });

  it("comes back byte for byte when nothing was edited", () => {
    expect(serializeMarkdown(doc, source)).toBe(BIG);
  });

  it("is read in well under a second", () => {
    expect(timed(() => parseMarkdown(BIG))).toBeLessThan(1000);
  });

  it("typing in the middle changes only that paragraph in the file", () => {
    const state = EditorState.create({ doc, plugins: editorPlugins() });
    const at = middleParagraphEnd(doc);
    const paragraph = state.doc.resolve(at).parent;
    const after = state.apply(state.tr.insertText(" Added.", at));
    const out = serializeMarkdown(after.doc, source);
    const original = serializeMarkdown(schema.node("doc", null, [paragraph]), parseMarkdown("").source).trimEnd();
    expect(BIG).toContain(original);
    expect(out).toBe(BIG.replace(original, original + " Added."));
  });

  it("saving after an edit takes a few milliseconds, because the unedited parts are reused", () => {
    const { doc: longer, source: longerSource } = parseMarkdown(bigDocument(120)); // four times as long
    const state = EditorState.create({ doc: longer });
    const edited = state.apply(state.tr.insertText("x", middleParagraphEnd(longer))).doc;
    const median = (run: () => unknown) => {
      const times = Array.from({ length: 7 }, () => timed(run)).sort((a, b) => a - b);
      return times[3];
    };
    const reused = median(() => serializeMarkdown(edited, longerSource));
    // A block's Markdown is kept once written, so writing every block from
    // scratch needs a fresh copy of the document each time.
    const copies = Array.from({ length: 5 }, () => schema.nodeFromJSON(edited.toJSON()));
    const fromScratch = timed(() => serializeMarkdown(copies.pop()!, parseMarkdown("").source));
    expect(reused).toBeLessThan(10);
    expect(reused).toBeLessThan(fromScratch / 3); // writing every block again would be several times slower
  });

  it("typing in the middle of one four times as long (about 128,000 words) takes under 5 ms a keystroke", () => {
    const { doc: longer } = parseMarkdown(bigDocument(120));
    let state = EditorState.create({ doc: longer, plugins: editorPlugins() });
    state = state.apply(state.tr.setSelection(TextSelection.create(state.doc, middleParagraphEnd(longer))));
    const keystrokes: number[] = [];
    for (const ch of "the quick brown fox jumps over the lazy dog again") {
      const start = performance.now();
      state = state.apply(state.tr.insertText(ch));
      keystrokes.push(performance.now() - start);
    }
    keystrokes.sort((a, b) => a - b);
    expect(keystrokes[Math.floor(keystrokes.length / 2)]).toBeLessThan(5);
    // The second slowest: one pause to tidy memory, which can land on any key on a busy Mac, doesn't decide.
    expect(keystrokes[keystrokes.length - 2]).toBeLessThan(100);
  });

  it("the word count is the same as counting the whole text, while typing too", () => {
    let state = EditorState.create({ doc, plugins: editorPlugins() });
    expect(wordCount(state.doc)).toBe(countAllAtOnce(state.doc));
    const at = middleParagraphEnd(doc);
    for (const typed of [" one", " two", "three", " ", "  four five"]) {
      state = state.apply(state.tr.insertText(typed, at));
      expect(wordCount(state.doc)).toBe(countAllAtOnce(state.doc));
    }
    state = state.apply(state.tr.delete(at - 30, at + 5));
    expect(wordCount(state.doc)).toBe(countAllAtOnce(state.doc));
  });
});

// A small, predictable stream of numbers for the random edits below.
function numbers(seed: number) {
  let s = seed;
  return () => {
    s = (s * 1103515245 + 12345) % 2147483648;
    return s / 2147483648;
  };
}

/** Every inline position in the document where text can go. */
function textPositions(doc: Node): number[] {
  const out: number[] = [];
  doc.descendants((node, pos) => {
    if (node.isTextblock && !node.type.spec.code) for (let i = 0; i <= node.content.size; i++) out.push(pos + 1 + i);
    return !node.isTextblock;
  });
  return out;
}

const NOTES_DOC = [
  "# Title[^t]",
  "Intro with a note.[^1] And another.[^2]",
  "- a list item with a note[^3]\n- and one without",
  "> A quote with a note.[^4]",
  "| Name | Cost |\n|:-----|-----:|\n| Tool[^5] | Free |\n| Other | $5 |",
  "A paragraph repeating a note.[^1]",
  "More text, no notes.",
  "[^t]: About the title.",
  "[^1]: First.",
  "[^2]: Second.",
  "[^3]: Third.",
  "[^4]: Fourth.",
  "[^5]: Fifth.",
  "[^unused]: Nobody points here.",
].join("\n\n");

/** Each footnote number shown, by position, from the plugin's state. */
function shownNumbers(state: EditorState): string[] {
  return footnoteNumbering
    .getState(state)!
    .decorations.find()
    .map((d) => `${d.from}-${d.to}:${d.spec.number}`)
    .sort();
}

/** The same, worked out from scratch for the same document. */
function freshNumbers(doc: Node): string[] {
  return shownNumbers(EditorState.create({ doc, plugins: [footnotePlugin()] }));
}

type Edit = (state: EditorState, rnd: () => number) => Transaction | null;

const pick = <T>(list: T[], rnd: () => number) => list[Math.floor(rnd() * list.length)];

const EDITS: Record<string, Edit> = {
  type: (s, rnd) => s.tr.insertText(pick(["x", " word", "ab "], rnd), pick(textPositions(s.doc), rnd)),
  deleteSome: (s, rnd) => {
    const at = pick(textPositions(s.doc), rnd);
    return s.tr.delete(at, Math.min(s.doc.content.size, at + 1 + Math.floor(rnd() * 12)));
  },
  addMarker: (s, rnd) => {
    const label = pick(["1", "2", "5", "new", "t", "unused"], rnd);
    return s.tr.insert(pick(textPositions(s.doc), rnd), schema.nodes.footnote_ref.create({ label }));
  },
  relabelMarker: (s, rnd) => {
    const refs: number[] = [];
    s.doc.descendants((n, pos) => {
      if (n.type.name === "footnote_ref") refs.push(pos);
    });
    return refs.length ? s.tr.setNodeAttribute(pick(refs, rnd), "label", pick(["1", "4", "zzz"], rnd)) : null;
  },
  relabelNote: (s, rnd) => {
    const defs: number[] = [];
    s.doc.forEach((n, pos) => {
      if (n.type.name === "footnote_def") defs.push(pos);
    });
    return defs.length ? s.tr.setNodeMarkup(pick(defs, rnd), null, { label: pick(["1", "3", "new"], rnd) }) : null;
  },
  moveBlock: (s, rnd) => {
    const k = Math.floor(rnd() * s.doc.childCount);
    let from = 0;
    for (let i = 0; i < k; i++) from += s.doc.child(i).nodeSize;
    const block = s.doc.child(k);
    const tr = s.tr.delete(from, from + block.nodeSize);
    const targets: number[] = [];
    tr.doc.forEach((_n, pos) => targets.push(pos));
    targets.push(tr.doc.content.size);
    return tr.insert(pick(targets, rnd), block);
  },
  replaceWithSame: (s, rnd) => {
    const k = Math.floor(rnd() * s.doc.childCount);
    let from = 0;
    for (let i = 0; i < k; i++) from += s.doc.child(i).nodeSize;
    return s.tr.replaceWith(from, from + s.doc.child(k).nodeSize, s.doc.child(k));
  },
  bold: (s, rnd) => {
    const at = pick(textPositions(s.doc), rnd);
    return s.tr.addMark(at, Math.min(s.doc.content.size, at + 10), schema.marks.strong.create());
  },
  quote: (s, rnd) => {
    const k = Math.floor(rnd() * s.doc.childCount);
    let from = 0;
    for (let i = 0; i < k; i++) from += s.doc.child(i).nodeSize;
    const $from = s.doc.resolve(from + 1);
    const range = $from.blockRange(s.doc.resolve(from + s.doc.child(k).nodeSize - 1));
    return range ? s.tr.wrap(range, [{ type: schema.nodes.blockquote }]) : null;
  },
  retypeCell: (s, rnd) => {
    const cells: number[] = [];
    s.doc.descendants((n, pos) => {
      if (n.type.name === "table_cell" || n.type.name === "table_header") cells.push(pos);
    });
    if (!cells.length) return null;
    const align = pick([null, "left", "center", "right"], rnd);
    if (rnd() < 0.5) return s.tr.setNodeAttribute(pick(cells, rnd), "align", align);
    const type = rnd() < 0.5 ? schema.nodes.table_cell : schema.nodes.table_header;
    return s.tr.setNodeMarkup(pick(cells, rnd), type, { align });
  },
  addRow: (s, rnd) => {
    const rows: { pos: number; cells: number }[] = [];
    s.doc.descendants((n, pos) => {
      if (n.type.name === "table_row") rows.push({ pos, cells: n.childCount });
    });
    if (!rows.length) return null;
    const row = pick(rows, rnd);
    const cells = Array.from({ length: row.cells }, () => schema.nodes.table_cell.create(null, schema.text("new")));
    return s.tr.insert(row.pos, schema.nodes.table_row.create(null, cells));
  },
  undo: (s) => {
    let out: Transaction | null = null;
    undo(s, (tr) => (out = tr));
    return out;
  },
  redo: (s) => {
    let out: Transaction | null = null;
    redo(s, (tr) => (out = tr));
    return out;
  },
};

/** Apply random edits; after each, check something about the result. */
function randomEdits(text: string, seed: number, rounds: number, check: (state: EditorState, edit: string) => void) {
  const rnd = numbers(seed);
  let state = EditorState.create({ doc: parseMarkdown(text).doc, plugins: editorPlugins() });
  const names = Object.keys(EDITS);
  for (let i = 0; i < rounds; i++) {
    const name = pick(names, rnd);
    let tr: Transaction | null = null;
    try {
      tr = EDITS[name](state, rnd);
    } catch {
      continue; // that edit doesn't fit here (a footnote marker in a code block, say)
    }
    if (!tr) continue;
    state = state.apply(tr);
    check(state, name);
  }
}

describe("footnote numbers in a long document", () => {
  it("stay right through every kind of edit, as if worked out from scratch each time", () => {
    let checked = 0;
    randomEdits(NOTES_DOC, 7, 400, (state, edit) => {
      expect(shownNumbers(state), `after ${edit}`).toEqual(freshNumbers(state.doc));
      checked++;
    });
    expect(checked).toBeGreaterThan(300);
  });

  it("stay right while typing and editing all over the long document", () => {
    randomEdits(bigDocument(3), 11, 120, (state, edit) => {
      expect(shownNumbers(state), `after ${edit}`).toEqual(freshNumbers(state.doc));
    });
  });
});

/** Whether a table follows the rules: the first row is the header, and each column has one alignment. */
function tableIsTidy(table: Node): boolean {
  const map = TableMap.get(table);
  for (let r = 0; r < map.height; r++) {
    for (let c = 0; c < map.width; c++) {
      const cell = table.nodeAt(map.map[r * map.width + c])!;
      if (cell.type.name !== (r === 0 ? "table_header" : "table_cell")) return false;
      if (cell.attrs.align !== table.nodeAt(map.map[c])!.attrs.align) return false;
    }
  }
  return true;
}

function allTablesTidy(doc: Node): boolean {
  let tidy = true;
  doc.descendants((node) => {
    if (node.type.name === "table" && !tableIsTidy(node)) tidy = false;
    return node.type.name !== "table";
  });
  return tidy;
}

const TABLES_DOC = [
  "Intro.",
  "| a | b |\n|:--|--:|\n| 1 | 2 |\n| 3 | 4 |",
  "Between.",
  "| c | d | e |\n|---|:-:|---|\n| 5 | 6 | 7 |",
  "End.",
].join("\n\n");

describe("tables in a long document", () => {
  it("an edit to one table far down the document still gets the table rules applied", () => {
    const { doc } = parseMarkdown(BIG);
    let state = EditorState.create({ doc, plugins: editorPlugins() });
    let lastTable = -1;
    state.doc.forEach((node, pos) => {
      if (node.type.name === "table") lastTable = pos;
    });
    // Make a body cell a header cell and right-align it: both against the rules.
    const cellPos = lastTable + 1 + state.doc.nodeAt(lastTable)!.child(0).nodeSize + 1;
    state = state.apply(state.tr.setNodeMarkup(cellPos, schema.nodes.table_header, { align: "right" }));
    expect(state.doc.nodeAt(cellPos)!.type.name).toBe("table_cell");
    expect(state.doc.nodeAt(cellPos)!.attrs.align).toBe(state.doc.nodeAt(lastTable + 2)!.attrs.align);
    expect(allTablesTidy(state.doc)).toBe(true);
  });

  it("a table pasted or moved anywhere is put right too", () => {
    const messy = schema.nodes.table.create(null, [
      schema.nodes.table_row.create(null, [schema.nodes.table_cell.create({ align: "center" }, schema.text("a"))]),
      schema.nodes.table_row.create(null, [schema.nodes.table_header.create(null, schema.text("1"))]),
    ]);
    const { doc } = parseMarkdown(BIG);
    let state = EditorState.create({ doc, plugins: editorPlugins() });
    let middle = 0;
    for (let i = 0; i < doc.childCount / 2; i++) middle += doc.child(i).nodeSize;
    state = state.apply(state.tr.insert(middle, messy));
    expect(allTablesTidy(state.doc)).toBe(true);
    randomEdits(TABLES_DOC, 5, 200, (s, edit) => expect(allTablesTidy(s.doc), `after ${edit}`).toBe(true));
  });
});
