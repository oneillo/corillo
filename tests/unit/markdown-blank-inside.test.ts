// Batch 23, item 2 (the wider round-trip tests found it): a paragraph of only
// spaces in the middle or at the end of a quote or list item (a "&#32;" the
// file held there, or a space typed on the new line Return gives in a quote)
// was written as a line of its own holding only the quote's sign or the
// item's indent and a space ("> a\n>\n> \n>\n> b"). Markdown keeps no such
// paragraph there, so it read back without it, and the next save wrote the
// text again without that line: the file changed at a save with nothing
// edited. An empty paragraph there was already left out, and so was a blank
// one before the item's or quote's first words; now one anywhere in it is.
//
// Each case is a made-up document.
import { describe, expect, it } from "vitest";
import type { Node } from "prosemirror-model";
import { schema } from "../../src/core/schema";
import { parseMarkdown, serializeMarkdown } from "../../src/core/markdown";
import { checkSave } from "../../src/core/write-check";

const fresh = () => parseMarkdown("").source;
const p = (t?: string) => schema.node("paragraph", null, t ? [schema.text(t)] : []);
const quote = (...kids: Node[]) => schema.node("blockquote", null, kids);
const item = (...kids: Node[]) => schema.node("list_item", null, kids);
const list = (...items: Node[]) => schema.node("bullet_list", { tight: false }, items);

/** Written afresh through the safety net, read back, written again: the text both times. */
function savedTwice(block: Node): { first: string; second: string } {
  const doc = schema.node("doc", null, [block]);
  const net = checkSave(doc, fresh());
  if (!net.ok) throw new Error(`the safety net refused the save, losing ${JSON.stringify(net.lost)}`);
  expect(net.text).toBe(serializeMarkdown(doc, fresh()));
  return { first: net.text, second: serializeMarkdown(parseMarkdown(net.text).doc, fresh()) };
}

describe("a paragraph of only spaces inside a quote or list item", () => {
  it("between two paragraphs of a quote, isn't written: the quote's two paragraphs, saved the same twice", () => {
    const { first, second } = savedTwice(quote(p("Before"), p(" "), p("After")));
    expect(first).toBe("> Before\n>\n> After\n");
    expect(second).toBe(first);
  });

  it("at the end of a quote, isn't written", () => {
    const { first, second } = savedTwice(quote(p("Before"), p("  ")));
    expect(first).toBe("> Before\n");
    expect(second).toBe(first);
  });

  it("between two paragraphs of a list item, isn't written", () => {
    const { first, second } = savedTwice(list(item(p("one"), p(" "), p("more of one")), item(p("two"))));
    expect(second).toBe(first);
    expect(first).not.toMatch(/\n {2,}\n/);
  });

  it("a file's quote holding \"&#32;\" between its paragraphs, written afresh, reads back the same and saves the same again", () => {
    const file = "> Before\n>\n> &#32;\n>\n> After\n";
    const { doc } = parseMarkdown(file);
    const { first, second } = savedTwice(doc.child(0));
    expect(first).toBe("> Before\n>\n> After\n");
    expect(second).toBe(first);
  });

  it("the same three deep, in a list in a quote in a list", () => {
    const file = "- > - Before\n>   \n>   &#32;\n>   \n>   After\n".replace(/^>/gm, "  >");
    const { doc } = parseMarkdown(file);
    const { first, second } = savedTwice(doc.child(0));
    expect(second).toBe(first);
  });

  it("a list item of only a blank paragraph is still written, as the item it is", () => {
    const { first, second } = savedTwice(list(item(p("one")), item(p(" ")), item(p("three"))));
    expect(parseMarkdown(first).doc.child(0).childCount).toBe(3);
    expect(second).toBe(first);
  });
});
