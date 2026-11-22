// Batch 21, S21-1: the Markdown family's finding on a heading's last "#"
// (review/batch-21/seams.md): the heading writer in markdown-blocks.ts looks
// for hashes at the end of the heading's words in `state.out`, but
// markdown-inline.ts keeps only the last few hundred characters there. Once
// enough has been written before the heading in the same block (a quote or a
// list item), the place it remembered is past the end of what `out` holds,
// the check sees nothing, and the "#" is written bare: read back, it is the
// heading's closing mark and the word is gone.
//
// Each asserts the right behaviour.
import { describe, expect, it } from "vitest";
import { EditorState } from "prosemirror-state";
import { schema } from "../../src/core/schema";
import { parseMarkdown, serializeMarkdown } from "../../src/core/markdown";

const para = (text: string) => schema.node("paragraph", null, [schema.text(text)]);
const heading = (text: string) => schema.node("heading", { level: 2 }, [schema.text(text)]);
const fresh = () => parseMarkdown("").source;

/** A quote holding one paragraph of `length` letters, then the heading "Issue #". */
function written(length: number): string {
  const quote = schema.node("blockquote", null, [para("a".repeat(length)), heading("Issue #")]);
  return serializeMarkdown(schema.node("doc", null, [quote]), fresh());
}

/** The words of the heading inside the quote, as the file reads back. */
function headingReadBack(text: string): string {
  const quote = parseMarkdown(text).doc.child(0);
  let words = "";
  quote.forEach((child) => {
    if (child.type.name === "heading") words = child.textContent;
  });
  return words;
}

describe("a heading ending in a hash, inside a quote", () => {
  it("keeps its hash after a short paragraph", () => {
    const text = written(20);
    expect(text).toContain("## Issue \\#");
    expect(headingReadBack(text)).toBe("Issue #");
  });

  it("keeps its hash after a paragraph of 500 letters", () => {
    const text = written(500);
    expect(headingReadBack(text)).toBe("Issue #");
  });

  it("keeps its hash whatever the length of the paragraph before it", () => {
    const lost: number[] = [];
    for (let length = 1; length <= 1200; length++) {
      if (headingReadBack(written(length)) !== "Issue #") lost.push(length);
    }
    expect(lost, `paragraph lengths that lose the hash: ${lost.length} of 1200, first ${lost.slice(0, 5).join(", ")}`).toEqual([]);
  });

  it("keeps its hash in a list item too", () => {
    const item = schema.node("list_item", null, [para("a".repeat(500)), heading("Issue #")]);
    const list = schema.node("bullet_list", null, [item]);
    const text = serializeMarkdown(schema.node("doc", null, [list]), fresh());
    let words = "";
    parseMarkdown(text).doc.descendants((child) => {
      if (child.type.name === "heading") words = child.textContent;
    });
    expect(words).toBe("Issue #");
  });

  it("keeps a hash the person types at the end of a heading in a quote they opened", () => {
    // The file as it was, then " #" typed at the heading's end: the quote is written afresh.
    const before = "> " + "a".repeat(497) + "\n>\n> ## Issue\n";
    const { doc, source } = parseMarkdown(before);
    const quote = doc.child(0);
    const state = EditorState.create({ doc });
    const typed = state.apply(state.tr.insertText(" #", quote.nodeSize - 2));
    expect(typed.doc.child(0).lastChild!.textContent).toBe("Issue #");
    const saved = serializeMarkdown(typed.doc, source);
    expect(headingReadBack(saved)).toBe("Issue #");
  });
});
