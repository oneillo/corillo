// Batch 23, item 1 (review/make-better-3.md row 61, R22-14): the longer
// Markdown fuzz found that a paragraph holding "$" signs next to code or a
// link could be saved as text that reads back differently. The writer
// escapes a "$" that, with the code's or link's signs between the words,
// would start math ("$$ `fee` $$"); but escaping it could leave the "$"
// before it free to pair with the "$" after it ("$5 or \$$" reads as math
// from "$5" to the last "$", backslash included). The writer now looks again
// with those escapes in place, as it already did for the ones it finds itself.
//
// Each case is a made-up document: opened, typed in (so the block is written
// afresh, as on any edit), saved through the safety net, read back, and
// written afresh once more.
import { describe, expect, it } from "vitest";
import { EditorState } from "prosemirror-state";
import type { Node } from "prosemirror-model";
import { schema } from "../../src/core/schema";
import { parseMarkdown, serializeMarkdown } from "../../src/core/markdown";
import { checkSave } from "../../src/core/write-check";

const fresh = () => parseMarkdown("").source;

/** Each paragraph or heading with its words and formatting, in order (not the spaces at a line's ends, which Markdown drops). */
function said(doc: Node): string[] {
  const out: string[] = [];
  doc.descendants((n) => {
    if (!n.isTextblock) return true;
    const parts: string[] = [];
    n.forEach((c, _, i) => {
      if (!c.isText) return parts.push(c.type.name);
      let text = c.text!.replace(/[ \t]*\n[ \t]*/g, "\n");
      if (i === 0) text = text.replace(/^[ \t]+/, "");
      if (i === n.childCount - 1) text = text.replace(/[ \t]+$/, "");
      parts.push(`${c.marks.map((m) => m.type.name).join("+")}:${text}`);
    });
    out.push(`${n.type.name}[${parts.join("|")}]`);
    return false;
  });
  return out;
}

/** Open the file, type "!" at the end of its first paragraph, save through the safety net. */
function typedAndSaved(file: string) {
  const { doc, source } = parseMarkdown(file);
  let end = -1;
  doc.descendants((n, pos) => {
    if (end < 0 && n.isTextblock) end = pos + n.nodeSize - 1;
    return end < 0;
  });
  const state = EditorState.create({ doc });
  const page = state.apply(state.tr.insertText("!", end)).doc;
  const net = checkSave(page, source);
  if (!net.ok) throw new Error(`the safety net refused the save, losing ${JSON.stringify(net.lost)}`);
  const back = parseMarkdown(net.text);
  return { page, saved: net.text, back: back.doc };
}

/** Write a block afresh, read it back, write that afresh again. */
function writtenTwice(block: Node) {
  const doc = schema.node("doc", null, [block]);
  const first = serializeMarkdown(doc, fresh());
  const back = parseMarkdown(first).doc;
  return { doc, first, back, second: serializeMarkdown(back, fresh()) };
}

describe("a $ beside code or a link, in a paragraph written afresh", () => {
  it("the smallest made-up document: a quote of four $, some code, then two $", () => {
    // The file holds the signs escaped, so they read as text, not math.
    const { page, saved, back } = typedAndSaved("> \\$\\$\\$\\$`d` \\$\\$\n");
    expect(said(page)).toEqual(["paragraph[:$$$$|code:d|: $$!]"]);
    expect(said(back), saved).toEqual(said(page));
    expect(back.eq(page), saved).toBe(true);
    expect(serializeMarkdown(back, fresh()), saved).toBe(serializeMarkdown(page, fresh()));
  });

  it("in plain words: a price, then a $$ around some code, in a quote of two paragraphs", () => {
    const file = "> Costs  $5 or \\$\\$ with `tax` \\$\\$ more.\n>\n> Second  paragraph.\n";
    const { page, saved, back } = typedAndSaved(file);
    expect(said(page)[0]).toBe("paragraph[:Costs  $5 or $$ with |code:tax|: $$ more.!]");
    expect(said(back), saved).toEqual(said(page));
    expect(serializeMarkdown(back, fresh()), saved).toBe(serializeMarkdown(page, fresh()));
  });

  const p = (...kids: Node[]) => schema.node("paragraph", null, kids);
  const t = (text: string, ...marks: string[]) => schema.text(text, marks.map((m) => (m === "link" ? schema.marks.link.create({ href: "https://x.com/a" }) : schema.marks[m].create())));
  // (Runs marked "lines" hold a line break: only places that hold one.)
  const RUNS: [string, () => Node[], "lines"?][] = [
    ["$$$$, code, $$", () => [t("$$$$"), t("d", "code"), t(" $$")]],
    ["a price, $$, code, $$", () => [t("Costs $5 or $$ with "), t("tax", "code"), t(" $$ more.")]],
    ["$ in italics, $$, code, $$", () => [t("$", "em"), t(" $$ "), t(")", "code"), t("$$")]],
    ["$, $$, a link, $$", () => [t("$/ $$ "), t("|", "link"), t("$$")]],
    ["$, a link holding $$, $$", () => [t("$"), t(" $$X", "link"), t(" $$")]],
    ["%%%%, code, %%", () => [t("%%%%"), t("d", "code"), t(" %%")]],
    // An escaped "$" before another still ends "$$" math: "a$$ \\$$" reads as math.
    ["a$$, $$, code, $$", () => [t("a$$ $$"), t("X", "code"), t(" $$")]],
    ["a backslash, $$, $$, a link, $$", () => [t("\\$$ $$ "), t("é", "link"), t("$$")]],
    ["$$, a tab, $$, a link, $$", () => [t("é$$\t$$ "), t("/", "link"), t("$$")]],
    ["%%, %%, code, %%", () => [t("a%% %%"), t("X", "code"), t(" %%")]],
    // "$$" starting a line opens math over several lines, even when "$w$" in it is kept as math.
    ["$$w$, a line break, $$", () => [t("$$w$\n$$")], "lines"],
    ["$$w$, a line break, $$ (as a line break of its own)", () => [t("$$w$"), schema.node("hard_break"), t("$$")], "lines"],
    ["text, a line break, $$w$, a line break, $$", () => [t("Total:\n$$w$\n$$")], "lines"],
    ["a space, $$w$, a line break, $$", () => [t(" $$w$\n$$")], "lines"],
    ["text, a line break, spaces, $$w$, a line break, $$", () => [t("Total:\n \t$$w$\n$$")], "lines"],
    ["%%w%%, a line break, %%", () => [t("%%%w%%\n%%")], "lines"],
  ];
  const item = (...kids: Node[]) => schema.node("list_item", null, kids);
  const bullets = (...kids: Node[]) => schema.node("bullet_list", null, kids);
  const quote = (...kids: Node[]) => schema.node("blockquote", null, kids);
  const PLACES: [string, (run: Node[]) => Node][] = [
    ["a paragraph", (r) => p(...r)],
    ["a heading", (r) => schema.node("heading", { level: 2 }, r)],
    ["a quote", (r) => quote(p(...r))],
    ["a quote's second paragraph", (r) => quote(p(t("First.")), p(...r))],
    ["a list item", (r) => bullets(item(p(...r)))],
    ["a numbered item's second paragraph", (r) => schema.node("ordered_list", null, [item(p(t("First.")), p(...r))])],
    ["a task", (r) => bullets(schema.node("list_item", { checked: false }, [p(...r)]))],
    ["a quote in a list item", (r) => bullets(item(p(t("First.")), quote(p(...r))))],
    ["a list in a list in a quote", (r) => quote(bullets(item(p(t("a")), bullets(item(p(...r))))))],
    [
      "a table cell",
      (r) =>
        schema.node("table", null, [
          schema.node("table_row", null, [schema.node("table_header", null, [t("h")]), schema.node("table_header", null, [t("i")])]),
          schema.node("table_row", null, [schema.node("table_cell", null, r), schema.node("table_cell", null, [t("z")])]),
        ]),
    ],
  ];
  for (const [run, make, lines] of RUNS) {
    for (const [place, wrap] of PLACES) {
      if (lines && (place === "a heading" || place === "a table cell")) continue;
      it(`${run}, in ${place}: reads back as written, and writes the same again`, () => {
        const { doc, first, back, second } = writtenTwice(wrap(make()));
        expect(said(back), first).toEqual(said(doc));
        expect(second, first).toBe(first);
        const net = checkSave(doc, fresh());
        expect(net.ok && net.text, first).toBe(first);
      });
    }
  }
});
