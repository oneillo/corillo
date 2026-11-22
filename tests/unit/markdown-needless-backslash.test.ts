// Batch 23 review, R23-5: two of Batch 23's escapes put backslashes in his
// files where Markdown didn't need them:
// - "<" before text Markdown wouldn't read as an email link: the writer took
//   any "<name@domain>" as one, but Markdown's addresses have no "_" in the
//   domain and don't end in "." or "-" ("<1@a_b>", "<1@a.>");
// - "$" starting a heading or a table cell before math ("## $$w$"): only a
//   paragraph can start math over several lines with "$$"; a heading or a
//   cell is one line.
// Now both are written plain, as before Batch 23, and still read back as
// written. Each case is made up: written afresh, read back, written again.
import { describe, expect, it } from "vitest";
import type { Node } from "prosemirror-model";
import { parseMarkdown, serializeMarkdown } from "../../src/core/markdown";
import { checkSave } from "../../src/core/write-check";

const fresh = () => parseMarkdown("").source;

/** Each piece of text on the page with its formatting, and kept syntax, in order. */
function said(doc: Node): string[] {
  const out: string[] = [];
  doc.descendants((n) => {
    if (n.isText) out.push(`${n.marks.map((m) => m.type.name).join("+")}:${n.text}`);
    else out.push(n.type.name);
    return true;
  });
  return out;
}

describe("no backslash Markdown doesn't need", () => {
  for (const [file, what] of [
    ["Write to <1@a_b> now.\n", "an address with _ in its domain"],
    ["Write to <1@a.> now.\n", "an address ending in ."],
    ["Write to <1@a-> now.\n", "an address ending in -"],
    ["## $$w$ in a heading\n", "a heading starting $ then math"],
    ["| a    |\n| ---- |\n| $$w$ |\n", "a table cell starting $ then math"],
  ]) {
    it(`${what}: written as it was, reads back the same`, () => {
      const { doc } = parseMarkdown(file);
      const written = serializeMarkdown(doc, fresh());
      expect(written).toBe(file);
      expect(said(parseMarkdown(written).doc)).toEqual(said(doc));
      const net = checkSave(doc, fresh());
      expect(net).toEqual({ ok: true, text: written, repaired: 0 });
    });
  }

  for (const [file, saved] of [
    ["Write to \\<1@a.b> now.\n", "Write to \\<1@a.b> now.\n"],
    ["Write to \\<1@a-b.c> now.\n", "Write to \\<1@a-b.c> now.\n"],
    ["\\$$w$ in a paragraph\n", "\\$$w$ in a paragraph\n"],
  ]) {
    it(`where Markdown needs it, it stays: ${JSON.stringify(file)}`, () => {
      const { doc } = parseMarkdown(file);
      const written = serializeMarkdown(doc, fresh());
      expect(written).toBe(saved);
      expect(said(parseMarkdown(written).doc)).toEqual(said(doc));
    });
  }
});
