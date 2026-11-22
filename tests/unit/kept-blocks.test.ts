// A block the person didn't touch is saved as the file had it. Some blocks
// mean something else once what's around them changes: a link by label whose
// address line is gone, code whose fence the file never closed, a paragraph
// the file indents under a list. Those are written afresh, so the file still
// reads back as the page.
import { describe, expect, it } from "vitest";
import { EditorState } from "prosemirror-state";
import { Node } from "prosemirror-model";
import { parseMarkdown } from "../../src/core/markdown";
import { schema } from "../../src/core/schema";
import { checkSave, meaningOf } from "../../src/core/write-check";

const shape = (doc: Node) => {
  const out: string[] = [];
  doc.forEach((n) => out.push(meaningOf(n)));
  return out;
};

const addresses = (doc: Node) => {
  const out: string[] = [];
  doc.descendants((n) => {
    if (n.type.name === "image") out.push(n.attrs.src);
    for (const m of n.marks) if (m.attrs.href) out.push(m.attrs.href);
  });
  return out;
};

/** Save the page through the safety net, and read the file again. */
function saved(page: Node, source: ReturnType<typeof parseMarkdown>["source"]) {
  const net = checkSave(page, source);
  if (!net.ok) throw new Error("the save was refused");
  return { text: net.text, read: parseMarkdown(net.text).doc };
}

/** The page with block `index` deleted. */
function withoutBlock(text: string, index: number) {
  const { doc, source } = parseMarkdown(text);
  let from = 0;
  for (let k = 0; k < index; k++) from += doc.child(k).nodeSize;
  const state = EditorState.create({ doc });
  const page = state.apply(state.tr.delete(from, from + doc.child(index).nodeSize)).doc;
  return { page, ...saved(page, source) };
}

describe("a link or picture by label, in a block kept as the file had it", () => {
  it("keeps its address when the line that gave it is deleted", () => {
    const { page, text, read } = withoutBlock("See [the site][site] for more.\n\n[site]: https://example.com/pricing\n", 1);
    expect(text).toBe("See [the site](https://example.com/pricing) for more.\n");
    expect(addresses(read)).toEqual(["https://example.com/pricing"]);
    expect(shape(read)).toEqual(shape(page));
  });

  it("a picture keeps its file the same way", () => {
    const { page, text, read } = withoutBlock("![The chart][c]\n\n[c]: charts/q3.png\n\nLast words.\n", 1);
    expect(text).toContain("charts/q3.png");
    expect(addresses(read)).toEqual(["charts/q3.png"]);
    expect(shape(read)).toEqual(shape(page));
  });

  it("in a list, the item keeps its address and the rest of the list stays as it was", () => {
    const { page, text, read } = withoutBlock("- one [a][x]\n\n- two\n\n[x]: https://example.com/a\n", 1);
    expect(addresses(read)).toEqual(["https://example.com/a"]);
    expect(text).not.toContain("[x]");
    expect(shape(read)).toEqual(shape(page));
  });

  it("goes back to its label once the line is put back (Undo)", () => {
    const { doc, source } = parseMarkdown("See [the site][site] for more.\n\n[site]: https://example.com/pricing\n");
    const state = EditorState.create({ doc });
    const page = state.apply(state.tr.delete(doc.child(0).nodeSize, doc.content.size)).doc;
    expect(saved(page, source).text).toBe("See [the site](https://example.com/pricing) for more.\n");
    // The same paragraph, with its line back, written where the file has neither (as for another file).
    const back = schema.node("doc", null, [page.child(0), doc.child(1)]);
    expect(saved(back, parseMarkdown("").source).text).toBe("See [the site][site] for more.\n\n[site]: https://example.com/pricing\n");
  });

  it("stays written by label while its line is there", () => {
    const { text } = withoutBlock("See [the site][site].\n\nGone.\n\n[site]: https://example.com/pricing\n", 1);
    expect(text).toBe("See [the site][site].\n\n[site]: https://example.com/pricing\n");
  });

  // Code review of Batch 16's fixes, B16R-2: a line indented under a note gives an address as Markdown reads it.
  const IN_NOTE = "Note.[^1]\n\n[^1]: The note.\n\n    [foo]: https://a.example/\n\nSee [x][foo] here.\n\nLast para.\n";
  it("whose line is indented under a note, stays by label: the file saves as it was", () => {
    const { doc, source } = parseMarkdown(IN_NOTE);
    expect(saved(doc, source).text).toBe(IN_NOTE);
  });

  it("whose line is indented under a note, stays by label when a word is typed elsewhere: only that line changes", () => {
    const { doc, source } = parseMarkdown(IN_NOTE);
    const state = EditorState.create({ doc });
    const page = state.apply(state.tr.insertText(" More", doc.content.size - 1)).doc;
    expect(page.lastChild!.textContent).toBe("Last para. More");
    expect(saved(page, source).text).toBe(IN_NOTE.replace("Last para.", "Last para. More"));
  });
});

/** The file's blocks put in another order, as a drag leaves them (the very same blocks), or replaced. */
function reordered(text: string, order: (blocks: Node[]) => Node[]) {
  const { doc, source } = parseMarkdown(text);
  const all: Node[] = [];
  doc.forEach((n) => all.push(n));
  const page = schema.node("doc", null, order(all));
  return { page, ...saved(page, source) };
}
/** The same block as a new object, as an Undo or a paste back can leave it. */
const copyOf = (n: Node) => Node.fromJSON(schema, n.toJSON());

const UNCLOSED = "Intro.\n\nMiddle words.\n\n```\nunclosed code\n";
const INDENTED = "   An indented paragraph.\n\nMiddle.\n\n- item\n";

describe("blocks that weren't neighbours in the file still read as two", () => {
  it("a paragraph typed under code whose fence the file never closed stays a paragraph", () => {
    const { doc, source } = parseMarkdown("Intro.\n\n```\ncode\n");
    const state = EditorState.create({ doc });
    const page = state.apply(state.tr.insert(doc.content.size, schema.node("paragraph", null, [schema.text("Typed after.")]))).doc;
    const { text, read } = saved(page, source);
    expect(text).toBe("Intro.\n\n```\ncode\n```\n\nTyped after.\n");
    expect(shape(read)).toEqual(shape(page));
  });

  it("a paragraph the file indents stays out of the list above once what was between them is deleted", () => {
    const { page, text, read } = withoutBlock("- item\n\nMiddle.\n\n   An indented paragraph.\n", 1);
    expect(text).toBe("- item\n\nAn indented paragraph.\n");
    expect(shape(read)).toEqual(shape(page));
    const quote = withoutBlock("* star item\n\nMiddle.\n\n  > indented quote\n", 1);
    expect(shape(quote.read)).toEqual(shape(quote.page));
  });

  it("the same when only the words between them are deleted (the paragraph stays, as an empty line)", () => {
    const { doc, source } = parseMarkdown("- item\n\nMiddle.\n\n   An indented paragraph.\n");
    const from = doc.child(0).nodeSize;
    const state = EditorState.create({ doc });
    const page = state.apply(state.tr.delete(from + 1, from + doc.child(1).nodeSize - 1)).doc;
    const { read } = saved(page, source);
    expect(shape(read)).toEqual(shape(page));
  });

  it("a list the file indents joins the list above as its next items, not inside its last one", () => {
    const { text, read } = withoutBlock("- item\n\nMiddle.\n\n   - indented list\n", 1);
    expect(text).toBe("- item\n- indented list\n");
    expect(read.childCount).toBe(1);
    expect(read.child(0).childCount).toBe(2);
  });

  it("indented code made a neighbour of other indented code stays two code blocks", () => {
    const { page, read } = withoutBlock("    first code\n\nMiddle.\n\n    second code\n", 1);
    expect(shape(read)).toEqual(shape(page));
  });

  it("blocks the file had side by side are still kept exactly as they were", () => {
    const { text } = withoutBlock("Intro.\n\nMiddle.\n\n```\nunclosed code\n", 0);
    expect(text).toBe("Middle.\n\n```\nunclosed code\n");
  });
});

describe("a block dragged whole reads back as the page", () => {
  it("code the file never closed, dragged to the top, gets its closing fence and takes nothing below into it", () => {
    const { page, text, read } = reordered(UNCLOSED, (b) => [b[2], b[0], b[1]]);
    expect(text).toBe("```\nunclosed code\n```\n\nIntro.\n\nMiddle words.\n");
    expect(shape(read)).toEqual(shape(page));
  });

  it("a block dragged to just under code the file never closed stays out of it", () => {
    const { page, read } = reordered(UNCLOSED, (b) => [b[1], b[2], b[0]]);
    expect(shape(read)).toEqual(shape(page));
    const copied = reordered(UNCLOSED, (b) => [b[1], b[2], copyOf(b[0])]);
    expect(shape(copied.read)).toEqual(shape(copied.page));
  });

  it("a paragraph the file indents, dragged to just under a list, stays a paragraph of its own", () => {
    const { page, text, read } = reordered(INDENTED, (b) => [b[1], b[2], b[0]]);
    expect(text).toBe("Middle.\n\n- item\n\nAn indented paragraph.\n");
    expect(shape(read)).toEqual(shape(page));
  });

  it("an equal block left where its original was, under a list now, stays out of the list", () => {
    const { page, read } = reordered("- item\n\nMiddle.\n\n   An indented paragraph.\n", (b) => [b[0], copyOf(b[2])]);
    expect(shape(read)).toEqual(shape(page));
  });

  // Whether such a drag should be refused instead is a decision for Orlando.
  it("an HTML comment the file never closed can't be closed for the person: it stays as the file had it", () => {
    const { text } = reordered("Intro.\n\n<!-- unclosed comment\n", (b) => [b[1], b[0]]);
    expect(text).toBe("<!-- unclosed comment\n\nIntro.\n");
  });
});
