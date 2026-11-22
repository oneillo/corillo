// Batch 23 review, R23-2: a list three deep whose items hold nothing before
// the next list (no words, or only a blank line), with the innermost first
// item empty, was written "- - - " (or "* * * "): Markdown reads a line of
// three same signs as a horizontal rule. The lists came back as a rule, the
// items under them as a separate list, or, four spaces in, as code.
//
// Now the list that would make the third sign goes on the line under its
// bullet ("- - " then "    - "), so the line can't read as a rule. Each case
// is a made-up document: saved through the safety net, read back as the same
// lists, saved again to the same text.
import { describe, expect, it } from "vitest";
import type { Node } from "prosemirror-model";
import { schema } from "../../src/core/schema";
import { parseMarkdown, serializeMarkdown } from "../../src/core/markdown";
import { checkSave } from "../../src/core/write-check";

const fresh = () => parseMarkdown("").source;

/** The blocks inside blocks, with each list's bullet sign: what the page shows, not how it is spaced. Blank lines are left out (spacing). */
function outline(n: Node): string {
  if (n.isText) return /^\s*$/.test(n.text!) ? "" : JSON.stringify(n.text);
  const kids: string[] = [];
  n.forEach((c) => {
    if (!(c.type.name === "paragraph" && /^\s*$/.test(c.textContent) && n.childCount > 1)) kids.push(outline(c));
  });
  const sign = n.type.name === "bullet_list" ? n.attrs.bullet : "";
  return `${n.type.name}${sign}(${kids.filter(Boolean).join(",")})`;
}

const t = (text: string) => schema.text(text);
const p = (...kids: Node[]) => schema.node("paragraph", null, kids);
const item = (...kids: Node[]) => schema.node("list_item", null, kids);

/** Save the page afresh through the safety net, read it back, save that afresh again. */
function savedTwice(page: Node) {
  const written = serializeMarkdown(page, fresh());
  const net = checkSave(page, fresh());
  const back = parseMarkdown(written).doc;
  return { written, net, back, second: serializeMarkdown(back, fresh()) };
}

for (const sign of ["-", "*"]) {
  const list = (...kids: Node[]) => schema.node("bullet_list", { bullet: sign }, kids);
  /** An item that holds nothing before its list: no words, or a blank first line. */
  const SHAPES: [string, (inner: Node) => Node][] = [
    ["no words", (inner) => item(inner)],
    ["a blank first line", (inner) => item(p(t(" ")), inner)],
  ];
  describe(`lists three deep of "${sign}" with nothing before the next list`, () => {
    for (const [shape, holder] of SHAPES) {
      const CASES: [string, () => Node[]][] = [
        ["alone", () => [list(holder(list(holder(list(item(p()))))))]],
        ["with a later item", () => [list(holder(list(holder(list(item(p()))))), item(p(t("Later."))))]],
        ["with a later item one level in", () => [list(holder(list(holder(list(item(p()))), item(p(t("In."))))), item(p(t("Later."))))]],
        ["with a next item in the innermost list", () => [list(holder(list(holder(list(item(p()), item(p(t("Next."))))))))]],
        ["four deep", () => [list(holder(list(holder(list(holder(list(item(p()))))))))]],
        ["in a quote", () => [schema.node("blockquote", null, [list(holder(list(holder(list(item(p()))))))])]],
        ["in a numbered item", () => [schema.node("ordered_list", null, [item(list(holder(list(holder(list(item(p())))))))])]],
        ["under words in an item", () => [list(item(p(t("Words.")), list(holder(list(holder(list(item(p()))))))))]],
      ];
      for (const [where, blocks] of CASES) {
        it(`items with ${shape}, ${where}: read back as the same lists, saved the same twice`, () => {
          const page = schema.node("doc", null, blocks());
          const { written, net, back, second } = savedTwice(page);
          expect(net, written).toEqual({ ok: true, text: written, repaired: 0 });
          expect(outline(back), written).toBe(outline(page));
          expect(second, written).toBe(written);
        });
      }
    }
  });
}

describe("the made-up file of the review", () => {
  it('"- - - x" with the x deleted: three lists, not a rule', () => {
    const { doc } = parseMarkdown("- - - x\n  - b\n- c\n");
    let x = -1;
    doc.descendants((n, pos) => {
      if (n.isText && n.text === "x") x = pos;
    });
    const page = doc.replace(x, x + 1, doc.slice(0, 0));
    expect(outline(page)).toBe('doc(bullet_list-(list_item(bullet_list-(list_item(bullet_list-(list_item(paragraph()))),list_item(paragraph("b")))),list_item(paragraph("c"))))');
    const { written, back, second } = savedTwice(page);
    expect(written).toBe("- - \n    - \n  - b\n- c\n");
    expect(outline(back)).toBe(outline(page));
    expect(second).toBe(written);
  });
});
