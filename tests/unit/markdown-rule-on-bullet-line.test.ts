// Batch 23 review, R23-6: a rule first in a list item was always moved to the
// line under the bullet ("1. " then "   ---"), a longer file than needed. Only
// a rule written with the bullet's own sign reads as one rule across the
// whole line ("- ---", "* ***"): that one still goes on the line under. Any
// other ("1. ---", "* ---", "- ***") stays on the bullet's line, as it was
// written before Batch 23. Each case is made up: saved, read back the same,
// saved again to the same text.
import { describe, expect, it } from "vitest";
import type { Node } from "prosemirror-model";
import { schema } from "../../src/core/schema";
import { parseMarkdown, serializeMarkdown } from "../../src/core/markdown";
import { checkSave } from "../../src/core/write-check";

const fresh = () => parseMarkdown("").source;

/** The blocks inside blocks: what the page shows, not how it is spaced. */
function outline(n: Node): string {
  if (n.isText) return JSON.stringify(n.text);
  const kids: string[] = [];
  n.forEach((c) => kids.push(outline(c)));
  return `${n.type.name}(${kids.join(",")})`;
}

const t = (text: string) => schema.text(text);
const p = (...kids: Node[]) => schema.node("paragraph", null, kids);
const rule = (markup: string) => schema.node("horizontal_rule", { markup });
const item = (...kids: Node[]) => schema.node("list_item", null, kids);
const bullets = (bullet: string) => (...kids: Node[]) => schema.node("bullet_list", { bullet }, kids);
const numbers = (...kids: Node[]) => schema.node("ordered_list", null, kids);

function savedTwice(page: Node) {
  const written = serializeMarkdown(page, fresh());
  const net = checkSave(page, fresh());
  const back = parseMarkdown(written).doc;
  return { written, net, back, second: serializeMarkdown(back, fresh()) };
}

const CASES: [string, (...kids: Node[]) => Node, string, string][] = [
  ["a numbered item", numbers, "---", "1. ---\n2. Next.\n"],
  ['a "*" item', bullets("*"), "---", "* ---\n* Next.\n"],
  ['a "-" item', bullets("-"), "***", "- ***\n- Next.\n"],
  ['a "+" item', bullets("+"), "---", "+ ---\n+ Next.\n"],
  ['a "-" item, its own sign', bullets("-"), "---", "- \n  ---\n- Next.\n"],
  ['a "*" item, its own sign', bullets("*"), "***", "* \n  ***\n* Next.\n"],
];

describe("a rule first in a list item", () => {
  for (const [what, list, markup, file] of CASES) {
    it(`"${markup}" in ${what} is written ${JSON.stringify(file)}, and reads back the same`, () => {
      const page = schema.node("doc", null, [list(item(rule(markup)), item(p(t("Next."))))]);
      const { written, net, back, second } = savedTwice(page);
      expect(written).toBe(file);
      expect(net).toEqual({ ok: true, text: written, repaired: 0 });
      expect(outline(back)).toBe(outline(page));
      expect(second).toBe(written);
    });
  }

  for (const [what, list, markup] of CASES) {
    it(`"${markup}" in ${what}, then words, in a list under a line of words: reads back the same, saved the same twice`, () => {
      const page = schema.node("doc", null, [bullets("-")(item(p(t("Outer.")), list(item(rule(markup), p(t("Words."))), item(p(t("Next."))))))]);
      const { written, net, back, second } = savedTwice(page);
      expect(net, written).toEqual({ ok: true, text: written, repaired: 0 });
      expect(outline(back), written).toBe(outline(page));
      expect(second, written).toBe(written);
    });
  }
});
