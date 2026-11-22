// Batch 23, item 1 (review/make-better-3.md row 61, R22-14): a list item
// whose first paragraph is only spaces (or empty), with a heading or other
// block under it, was written as the marker, a blank line, then the block.
// Markdown ends a list item that starts with a blank line at the next blank
// line, so the heading came back outside the list. Now the block follows on
// the line under the marker, inside the item.
//
// The blank first line itself can't be held there (Markdown keeps no empty
// paragraph inside a list item or quote, as a quote already drops one): it is
// spacing, which the safety net doesn't count. What reads back is the item
// with everything else in it, and writing that again gives the same text.
import { describe, expect, it } from "vitest";
import { EditorState } from "prosemirror-state";
import { Fragment, type Node } from "prosemirror-model";
import { schema } from "../../src/core/schema";
import { isEmptyLine, parseMarkdown, serializeMarkdown } from "../../src/core/markdown";
import { checkSave } from "../../src/core/write-check";

const fresh = () => parseMarkdown("").source;

/** The blocks inside blocks, with their words and formatting: what the page shows, not how it is spaced. */
function outline(n: Node): string {
  if (n.isText) return JSON.stringify(n.text) + (n.marks.length ? `{${n.marks.map((m) => m.type.name).join("+")}}` : "");
  const attrs = n.type.name === "heading" ? `#${n.attrs.level}` : n.type.name === "list_item" && n.attrs.checked !== null ? `[${n.attrs.checked ? "x" : " "}]` : "";
  const kids: string[] = [];
  // (Unformatted spaces alone are spacing: Markdown drops them.)
  n.forEach((c) => {
    if (!(c.isText && !c.marks.length && /^[ \t]*$/.test(c.text!))) kids.push(outline(c));
  });
  return `${n.type.name}${attrs}(${kids.join(",")})`;
}

/** The page as Markdown can hold it: a list item's blank first lines, before something else in the item, are spacing. */
function withoutBlankFirstLines(n: Node): Node {
  if (n.isText || n.isLeaf) return n;
  const kids: Node[] = [];
  n.forEach((c) => kids.push(withoutBlankFirstLines(c)));
  if (n.type.name === "list_item" && n.attrs.checked === null) {
    let k = 0;
    while (k < kids.length - 1 && isEmptyLine(kids[k])) k++;
    if (k < kids.length) kids.splice(0, k);
  }
  return n.copy(Fragment.fromArray(kids));
}

const t = (text: string) => schema.text(text);
const p = (...kids: Node[]) => schema.node("paragraph", null, kids);
const h = (text: string) => schema.node("heading", { level: 2 }, [t(text)]);
const item = (...kids: Node[]) => schema.node("list_item", null, kids);
const bullets = (...kids: Node[]) => schema.node("bullet_list", null, kids);
const numbers = (...kids: Node[]) => schema.node("ordered_list", null, kids);
const quote = (...kids: Node[]) => schema.node("blockquote", null, kids);

/** Write the page afresh through the safety net, read it back, write that afresh again. */
function savedTwice(page: Node) {
  const net = checkSave(page, fresh());
  if (!net.ok) throw new Error(`the safety net refused the save, losing ${JSON.stringify(net.lost)}`);
  const back = parseMarkdown(net.text).doc;
  return { first: net.text, back, second: serializeMarkdown(back, fresh()) };
}

describe("a list item whose first line is blank, then a heading or another block", () => {
  it("the smallest made-up document: an item of a space, then a heading", () => {
    const page = schema.node("doc", null, [bullets(item(p(t(" ")), h("Plan")))]);
    const { first, back, second } = savedTwice(page);
    expect(outline(back), first).toBe('doc(bullet_list(list_item(heading#2("Plan"))))');
    expect(second, first).toBe(first);
  });

  it("a file's item holding a space (&#32;), then a heading, typed in: the heading stays in the item", () => {
    const file = "- &#32;\n\n  ## Plan\n- Next\n";
    const { doc, source } = parseMarkdown(file);
    expect(outline(doc)).toBe('doc(bullet_list(list_item(paragraph(),heading#2("Plan")),list_item(paragraph("Next"))))');
    let end = -1;
    doc.descendants((n, pos) => {
      if (end < 0 && n.type.name === "heading") end = pos + n.nodeSize - 1;
      return end < 0;
    });
    const state = EditorState.create({ doc });
    const page = state.apply(state.tr.insertText(" ahead", end)).doc;
    const net = checkSave(page, source);
    expect(net.ok).toBe(true);
    const saved = net.ok ? net.text : "";
    const back = parseMarkdown(saved);
    expect(outline(back.doc), saved).toBe('doc(bullet_list(list_item(heading#2("Plan ahead")),list_item(paragraph("Next"))))');
    expect(serializeMarkdown(back.doc, fresh()), saved).toBe(serializeMarkdown(page, fresh()));
  });

  const BLANKS: [string, () => Node[]][] = [
    ["empty", () => [p()]],
    ["a space", () => [p(t(" "))]],
    ["three spaces", () => [p(t("   "))]],
    ["a tab", () => [p(t("\t"))]],
    ["a line break", () => [p(schema.node("hard_break"))]],
    ["two blank lines", () => [p(t(" ")), p()]],
  ];
  const AFTER: [string, () => Node[]][] = [
    ["a heading", () => [h("Plan")]],
    ["a heading and a paragraph", () => [h("Plan"), p(t("Words."))]],
    ["a paragraph", () => [p(t("Words."))]],
    ["a rule", () => [schema.node("horizontal_rule")]],
    ["a code block", () => [schema.node("code_block", null, [t("x = 1")])]],
    ["a quote", () => [quote(p(t("Quoted.")))]],
    ["a list", () => [bullets(item(p(t("Inner."))))]],
    ["a numbered list", () => [numbers(item(p(t("Inner."))))]],
    [
      "a table",
      () => [
        schema.node("table", null, [
          schema.node("table_row", null, [schema.node("table_header", null, [t("a")]), schema.node("table_header", null, [t("b")])]),
          schema.node("table_row", null, [schema.node("table_cell", null, [t("c")]), schema.node("table_cell", null, [t("d")])]),
        ]),
      ],
    ],
  ];
  const PLACES: [string, (it: Node) => Node][] = [
    ["a list", (it) => bullets(it)],
    // (Spaced out, as Markdown reads a list whose item holds several blocks.)
    ["a list, as its second item", (it) => schema.node("bullet_list", { tight: false }, [item(p(t("First."))), it])],
    ["a numbered list", (it) => numbers(it)],
    ["a list in a quote", (it) => quote(bullets(it))],
    ["a list in a list item", (it) => bullets(item(p(t("Outer.")), bullets(it)))],
    ["a list in a quote in a list item", (it) => bullets(item(p(t("Outer.")), quote(bullets(it))))],
  ];
  for (const [blank, blanks] of BLANKS) {
    for (const [after, rest] of AFTER) {
      for (const [place, wrap] of PLACES) {
        it(`${blank}, then ${after}, in ${place}: all of it stays in the item`, () => {
          const page = schema.node("doc", null, [wrap(item(...blanks(), ...rest()))]);
          const { first, back, second } = savedTwice(page);
          expect(outline(back), first).toBe(outline(withoutBlankFirstLines(page)));
          expect(second, first).toBe(first);
        });
      }
    }
  }

  it("a quote whose first line is blank, then a heading: the heading stays in the quote", () => {
    const page = schema.node("doc", null, [quote(p(t(" ")), h("Plan"))]);
    const { first, back, second } = savedTwice(page);
    expect(outline(back), first).toBe('doc(blockquote(heading#2("Plan")))');
    expect(second, first).toBe(first);
  });

  it("a task whose first line is blank, then a heading: the heading stays in the task", () => {
    const page = schema.node("doc", null, [bullets(schema.node("list_item", { checked: false }, [p(), h("Plan")]))]);
    const { first, back, second } = savedTwice(page);
    expect(outline(back), first).toBe('doc(bullet_list(list_item[ ](paragraph(),heading#2("Plan"))))');
    expect(second, first).toBe(first);
  });

  it("a rule first in a list item: it stays in the item", () => {
    const page = schema.node("doc", null, [bullets(item(schema.node("horizontal_rule")), item(p(t("Next."))))]);
    const { first, back, second } = savedTwice(page);
    expect(outline(back), first).toBe('doc(bullet_list(list_item(horizontal_rule()),list_item(paragraph("Next."))))');
    expect(second, first).toBe(first);
  });

  for (const [what, mark] of [
    ["code", () => schema.marks.code.create()],
    ["a link", () => schema.marks.link.create({ href: "https://x.com/a" })],
  ] as const) {
    it(`a first line holding only a space in ${what}, then a heading: the space is kept, in the item`, () => {
      const page = schema.node("doc", null, [bullets(item(p(schema.text(" ", [mark()])), h("Plan")))]);
      const { first, back, second } = savedTwice(page);
      expect(outline(back), first).toBe(outline(page));
      expect(second, first).toBe(first);
    });
  }

  // A list under a paragraph whose first item's line is blank ("  -" alone)
  // would underline the paragraph as a heading: it gets a blank line above.
  for (const [what, first] of [
    ["only a space", () => [p(t(" "))]],
    ["a space, then a heading", () => [p(t(" ")), h("Plan")]],
    ["a rule", () => [schema.node("horizontal_rule")]],
  ] as const) {
    it(`a list in a list item, under its paragraph, whose first item holds ${what}: the paragraph stays a paragraph`, () => {
      const page = schema.node("doc", null, [bullets(item(p(t("Outer.")), bullets(item(...first()), item(p(t("Inner."))))))]);
      const { first: saved, back, second } = savedTwice(page);
      expect(outline(back), saved).toBe(outline(withoutBlankFirstLines(page)));
      expect(second, saved).toBe(saved);
    });
  }

  it("an item of only a blank line, then another item: both items stay", () => {
    const page = schema.node("doc", null, [bullets(item(p(t(" "))), item(p(t("Next."))))]);
    const { first, back } = savedTwice(page);
    expect(outline(back), first).toBe('doc(bullet_list(list_item(paragraph()),list_item(paragraph("Next."))))');
  });
});
