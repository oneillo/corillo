// Batch 23, item 1: the longer Markdown fuzz found that "<1@a>" in a
// paragraph was written as it is, and read back as a link to the email
// address 1@a. Markdown reads "<" then an address and ">" as an email link
// whatever the address starts with, and the writer only escaped "<" before a
// letter (as a web address or HTML would need). Now it also escapes "<"
// where an email link would start. A made-up document each time.
import { describe, expect, it } from "vitest";
import type { Node } from "prosemirror-model";
import { schema } from "../../src/core/schema";
import { parseMarkdown, serializeMarkdown } from "../../src/core/markdown";
import { checkSave } from "../../src/core/write-check";

const fresh = () => parseMarkdown("").source;
const p = (text: string) => schema.node("paragraph", null, [schema.text(text)]);
const item = (...kids: Node[]) => schema.node("list_item", null, kids);

/** What the read-back page holds: each paragraph's words and their formatting. */
function said(doc: Node): string[] {
  const out: string[] = [];
  doc.descendants((n) => {
    if (n.isText) out.push(`${n.marks.map((m) => m.type.name).join("+")}:${n.text}`);
    return true;
  });
  return out;
}

describe("text like <1@a>, written afresh", () => {
  const TEXTS = ["<1@a>$", "Mail <1@a> now.", "<.x@example.com>", "<_me@site.org> or <me@site.org>", "a<1@a>", "<#tag@b.c>"];
  const PLACES: [string, (para: Node) => Node][] = [
    ["a paragraph", (x) => x],
    ["a quote", (x) => schema.node("blockquote", null, [x])],
    ["a list item", (x) => schema.node("bullet_list", null, [item(x)])],
    ["a quote's second paragraph", (x) => schema.node("blockquote", null, [p("First."), x])],
  ];
  for (const text of TEXTS) {
    for (const [place, wrap] of PLACES) {
      it(`${JSON.stringify(text)} in ${place} reads back as the same text, not a link`, () => {
        const doc = schema.node("doc", null, [wrap(p(text))]);
        const first = serializeMarkdown(doc, fresh());
        const back = parseMarkdown(first).doc;
        expect(said(back), first).toEqual(said(doc));
        expect(serializeMarkdown(back, fresh()), first).toBe(first);
        const net = checkSave(doc, fresh());
        expect(net.ok && net.text, first).toBe(first);
      });
    }
  }
});

// Batch 23 review, R23-4: math, an Obsidian comment or bold inside such an
// address ("<1$x$@a>") cut the text where the writer looked, so the "<"
// wasn't escaped and the text read back as an email link. (The safety net
// caught it in a paragraph and wrote it with a backslash on every sign; in a
// quote it didn't.) Now the writer looks at the paragraph as written.
describe("an address with math, a comment or formatting inside, written afresh", () => {
  const bold = (text: string) => schema.text(text, [schema.marks.strong.create()]);
  const CASES: [string, () => Node, string][] = [
    ["math", () => p("Mail <1$x$@a> now."), "Mail \\<1$x$@a> now."],
    ["a comment", () => p("Mail <1%%c%%@a> now."), "Mail \\<1%%c%%@a> now."],
    ["bold", () => schema.node("paragraph", null, [schema.text("Mail <1"), bold("b"), schema.text("@a> now.")]), "Mail \\<1**b**@a> now."],
  ];
  const PLACES: [string, (para: Node) => Node, (line: string) => string][] = [
    ["a paragraph", (x) => x, (l) => l],
    ["a quote", (x) => schema.node("blockquote", null, [x]), (l) => `> ${l}`],
    ["a list item", (x) => schema.node("bullet_list", null, [item(x)]), (l) => `- ${l}`],
  ];
  for (const [what, para, line] of CASES) {
    for (const [place, wrap, as] of PLACES) {
      it(`${what} in ${place}: only the "<" gets a backslash, and it reads back as text`, () => {
        const doc = schema.node("doc", null, [wrap(para())]);
        const first = serializeMarkdown(doc, fresh());
        expect(first).toBe(as(line) + "\n");
        expect(checkSave(doc, fresh())).toEqual({ ok: true, text: first, repaired: 0 });
        const back = parseMarkdown(first).doc;
        expect(said(back), first).toEqual(said(doc));
        expect(serializeMarkdown(back, fresh())).toBe(first);
      });
    }
  }
});
