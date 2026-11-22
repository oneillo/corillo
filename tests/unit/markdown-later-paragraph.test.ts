// Batch 21, S21-2: the Markdown family's finding on what starts a later paragraph in a
// quote or list item (review/batch-21/seams.md). When such a block is written
// afresh, the writers choose a sign or a link's form from what has been
// written "so far" (FaithfulState.out and .size in markdown-inline.ts, read by
// surroundings(), by emphasis().open's joins() and by the link writer in
// markdown-blocks.ts) before the library has ended the paragraph above and
// started the new line. So they see the end of the paragraph above, not a
// line's start, and write "<strong>" or "__" where "**" reads back, and
// "[site][site]" where the file had "[site]".
//
// Each asserts the right text.
import { describe, expect, it } from "vitest";
import { EditorState } from "prosemirror-state";
import { schema } from "../../src/core/schema";
import { parseMarkdown, serializeMarkdown } from "../../src/core/markdown";

/**
 * Open the text and add a paragraph "New." at the end of its first block (a
 * quote or a list item), as the person pressing Return there and typing: the
 * block has one more part, so it is written afresh.
 */
function withParagraphAdded(text: string): string {
  const { doc, source } = parseMarkdown(text);
  const first = doc.child(0);
  let at = first.nodeSize - 1;
  let node = first;
  while (node.lastChild && !node.lastChild.isTextblock) {
    node = node.lastChild;
    at -= 1;
  }
  const state = EditorState.create({ doc });
  const next = state.apply(state.tr.insert(at, schema.node("paragraph", null, [schema.text("New.")])));
  return serializeMarkdown(next.doc, source);
}

const DEFINED = "\n\n[site]: https://example.com\n";

describe("what starts a later paragraph of a quote or list item, when the block is written afresh", () => {
  it("control: a link by label that starts the quote's first paragraph stays as written", () => {
    expect(withParagraphAdded("> [site] is here" + DEFINED)).toBe("> [site] is here\n>\n> New." + DEFINED);
  });

  it("a link by label that starts the quote's second paragraph stays as written", () => {
    expect(withParagraphAdded("> First.\n>\n> [site] is here" + DEFINED)).toBe("> First.\n>\n> [site] is here\n>\n> New." + DEFINED);
  });

  it("a link by label that starts a list item's second paragraph stays as written", () => {
    expect(withParagraphAdded("- First.\n\n  [site] is here" + DEFINED)).toBe("- First.\n\n  [site] is here\n\n  New." + DEFINED);
  });

  it("control: bold on a bracket that starts the quote's first paragraph keeps its stars", () => {
    expect(withParagraphAdded("> **(bold)** x\n")).toBe("> **(bold)** x\n>\n> New.\n");
  });

  it("bold on a bracket that starts the second paragraph keeps its stars when the paragraph above ends in a letter", () => {
    expect(withParagraphAdded("> First\n>\n> **(bold)** x\n")).toBe("> First\n>\n> **(bold)** x\n>\n> New.\n");
  });

  it("bold that starts the second paragraph keeps its stars when the paragraph above ends in bold", () => {
    expect(withParagraphAdded("> **First**\n>\n> **bold** x\n")).toBe("> **First**\n>\n> **bold** x\n>\n> New.\n");
  });

  it("italic that starts a list item's second paragraph keeps its star when the paragraph above ends in a letter", () => {
    expect(withParagraphAdded("- First\n\n  *(it)* x\n")).toBe("- First\n\n  *(it)* x\n\n  New.\n");
  });
});
