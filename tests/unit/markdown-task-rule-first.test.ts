// Batch 23 review, R23-1: Insert Horizontal Line at the start of a task's
// words, or in an empty task, gave a task that starts with a rule. It was
// written as the box, then the rule on the line under it ("- [ ] \n  ---"),
// which Markdown reads as "[ ]" underlined as a heading: the whole list
// reopened as raw Markdown text, no longer a task list.
//
// Now a task that starts with anything but words has its box on a line of its
// own, as a task with no words reads from a file, and what follows comes on
// the next line where Markdown allows it, so the list stays as tight as it
// was. A rule there is written "***" ("---" would underline the box). Each
// case is a made-up document: saved through the safety net, read back (still
// a list, everything in place), and saved again to the same text.
import { describe, expect, it } from "vitest";
import { EditorState, TextSelection } from "prosemirror-state";
import type { Node } from "prosemirror-model";
import { schema } from "../../src/core/schema";
import { parseMarkdown, serializeMarkdown } from "../../src/core/markdown";
import { checkSave } from "../../src/core/write-check";
import { insertHorizontalLine } from "../../src/renderer/commands";

const fresh = () => parseMarkdown("").source;

/** The blocks inside blocks, with a task's tick and a heading's level: what the page shows, not how it is spaced. */
function outline(n: Node): string {
  if (n.isText) return JSON.stringify(n.text);
  const attrs = n.type.name === "heading" ? `#${n.attrs.level}` : n.type.name === "list_item" && n.attrs.checked !== null ? `[${n.attrs.checked ? "x" : " "}]` : "";
  const kids: string[] = [];
  n.forEach((c) => kids.push(outline(c)));
  return `${n.type.name}${attrs}(${kids.join(",")})`;
}

const t = (text: string) => schema.text(text);
const p = (...kids: Node[]) => schema.node("paragraph", null, kids);
const rule = () => schema.node("horizontal_rule");
const h = (text: string) => schema.node("heading", { level: 2 }, [t(text)]);
const code = () => schema.node("code_block", null, [t("x = 1")]);
const quote = (...kids: Node[]) => schema.node("blockquote", null, kids);
const task = (...kids: Node[]) => schema.node("list_item", { checked: false }, kids);
const done = () => schema.node("list_item", { checked: true }, [p(t("Done."))]);
const item = (...kids: Node[]) => schema.node("list_item", null, kids);
const bullets = (...kids: Node[]) => schema.node("bullet_list", null, kids);
const numbers = (...kids: Node[]) => schema.node("ordered_list", null, kids);

/** Save the page afresh through the safety net, read it back, save that afresh again. */
function savedTwice(page: Node) {
  const written = serializeMarkdown(page, fresh());
  const net = checkSave(page, fresh());
  const back = parseMarkdown(written).doc;
  return { written, net, back, second: serializeMarkdown(back, fresh()) };
}

/** Where a list sits: alone, nested two and three deep, numbered, in a quote. */
const PLACES: [string, (list: Node) => Node][] = [
  ["a list", (l) => l],
  ["a list in a list item", (l) => bullets(item(p(t("Outer.")), l))],
  ["a list three deep", (l) => bullets(item(p(t("Outer.")), bullets(item(p(t("Middle.")), l))))],
  ["a list in a quote", (l) => quote(l)],
  ["a list in a numbered list", (l) => numbers(item(p(t("Outer.")), l))],
];
const LISTS: [string, (...items: Node[]) => Node][] = [
  ["bullets", bullets],
  ["numbers", numbers],
];

/** Tasks that start with something other than words; and the task as it reads back (the box line first, empty). */
const STARTS: [string, () => Node[], () => Node[]][] = [
  ["a rule, then words (Insert Horizontal Line at the start of its words)", () => [rule(), p(t("Words."))], () => [p(), rule(), p(t("Words."))]],
  ["a rule, then an empty line (Insert Horizontal Line in an empty task)", () => [rule(), p()], () => [p(), rule()]],
  ["a rule alone", () => [rule()], () => [p(), rule()]],
  ["no words, then a rule (as such a task reads from a file)", () => [p(), rule(), p(t("Words."))], () => [p(), rule(), p(t("Words."))]],
  ["no words, then a heading", () => [p(), h("Plan")], () => [p(), h("Plan")]],
  ["no words, then a code block", () => [p(), code()], () => [p(), code()]],
  ["a heading, then words", () => [h("Plan"), p(t("Words."))], () => [p(), h("Plan"), p(t("Words."))]],
  ["a code block, then words", () => [code(), p(t("Words."))], () => [p(), code(), p(t("Words."))]],
  ["a quote", () => [quote(p(t("Quoted.")))], () => [p(), quote(p(t("Quoted.")))]],
  ["a list", () => [bullets(item(p(t("Inner."))))], () => [p(), bullets(item(p(t("Inner."))))]],
];

describe("a task that starts with a rule or another block, among other tasks", () => {
  // (A numbered task, "1. [ ] Call Ana", shows as written, as text: the page
  // has tasks only in bulleted lists. A task list inside a numbered list is
  // covered below.)
  for (const [start, kids, asRead] of STARTS) {
    for (const [place, wrap] of PLACES) {
      it(`${start}, in ${place}: still a task list, saved the same twice`, () => {
        const page = schema.node("doc", null, [wrap(bullets(task(...kids()), done()))]);
        const { written, net, back, second } = savedTwice(page);
        expect(net, written).toEqual({ ok: true, text: written, repaired: 0 });
        expect(outline(back), written).toBe(outline(schema.node("doc", null, [wrap(bullets(task(...asRead()), done()))])));
        expect(second, written).toBe(written);
      });
    }
  }

  it("the made-up file of the review: Insert Horizontal Line at the start of a task's words", () => {
    const { doc } = parseMarkdown("- [ ] Words\n- [x] Done\n");
    let state = EditorState.create({ doc });
    state = state.apply(state.tr.setSelection(TextSelection.create(state.doc, 3)));
    insertHorizontalLine(state, (tr) => (state = state.apply(tr)));
    expect(outline(state.doc)).toBe('doc(bullet_list(list_item[ ](horizontal_rule(),paragraph("Words")),list_item[x](paragraph("Done"))))');
    const { written, back, second } = savedTwice(state.doc);
    expect(written).toBe("- [ ] \n  ***\n  Words\n- [x] Done\n");
    expect(outline(back)).toBe('doc(bullet_list(list_item[ ](paragraph(),horizontal_rule(),paragraph("Words")),list_item[x](paragraph("Done"))))');
    expect(second).toBe(written);
  });

  it("and in an empty task", () => {
    const { doc } = parseMarkdown("- [ ] \n- [x] Done\n");
    let state = EditorState.create({ doc });
    state = state.apply(state.tr.setSelection(TextSelection.create(state.doc, 3)));
    insertHorizontalLine(state, (tr) => (state = state.apply(tr)));
    const { written, back, second } = savedTwice(state.doc);
    expect(written).toBe("- [ ] \n  ***\n- [x] Done\n");
    expect(outline(back)).toBe("doc(bullet_list(list_item[ ](paragraph(),horizontal_rule()),list_item[x](paragraph(\"Done\"))))");
    expect(second).toBe(written);
  });
});

describe("a plain list item that starts with a rule, then words, among other items", () => {
  for (const [kind, list] of LISTS) {
    for (const [place, wrap] of PLACES) {
      it(`in ${kind}, in ${place}: the list keeps its spacing, saved the same twice`, () => {
        const page = schema.node("doc", null, [wrap(list(item(rule(), p(t("Words."))), item(p(t("Next.")))))]);
        const { written, net, back, second } = savedTwice(page);
        expect(net, written).toEqual({ ok: true, text: written, repaired: 0 });
        expect(outline(back), written).toBe(outline(page));
        expect(second, written).toBe(written);
      });
    }
  }
});
