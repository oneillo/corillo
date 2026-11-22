// A task whose first line stops being a plain line loses its box, however that
// happens: typed Markdown ("# ", "> ", three backticks), a paste, a drop, as
// well as the style menu (the review of Batch 18, R18-4). Markdown has a
// task's box only at the start of a plain line: "- [ ] # Title" reads back as
// the words "# Title".
import { describe, expect, it } from "vitest";
import { EditorState, TextSelection, type Transaction } from "prosemirror-state";
import { history, undo } from "prosemirror-history";
import { parseMarkdown, serializeMarkdown } from "../../src/core/markdown";
import { schema } from "../../src/core/schema";
import { tasksPlugin } from "../../src/renderer/tasks";

const n = schema.nodes;

function stateOf(markdown: string): EditorState {
  const { doc } = parseMarkdown(markdown);
  const state = EditorState.create({ doc, plugins: [tasksPlugin(), history()] });
  // The cursor at the start of the first task's words.
  return state.apply(state.tr.setSelection(TextSelection.create(doc, 3)));
}

/** A transaction applied as the editor applies it: with what plugins append. */
const apply = (state: EditorState, tr: Transaction) => state.applyTransaction(tr).state;
const markdownOf = (state: EditorState) => serializeMarkdown(state.doc, parseMarkdown("").source);
const firstItem = (state: EditorState) => state.doc.firstChild!.firstChild!;

describe("a task's first line made something other than a plain line, by any way", () => {
  it("typed '# ' (the line made a heading as the typing rule does): an ordinary item with a heading, read back the same", () => {
    const state = stateOf("- [ ] Title here\n- [x] Book the room\n");
    const after = apply(state, state.tr.setBlockType(3, 3, n.heading, { level: 1 }));
    expect(firstItem(after).attrs.checked).toBeNull();
    expect(after.doc.firstChild!.child(1).attrs.checked).toBe(true); // the task not touched keeps its box
    expect(markdownOf(after)).toBe("- # Title here\n- [x] Book the room\n");
    expect(parseMarkdown(markdownOf(after)).doc.toJSON()).toEqual(after.doc.toJSON());
  });

  it("typed three backticks, or '> ': code or a quote, and the box goes", () => {
    const state = stateOf("- [ ] x = 1\n");
    expect(firstItem(apply(state, state.tr.setBlockType(3, 3, n.code_block))).attrs.checked).toBeNull();
    const $at = state.doc.resolve(3);
    const range = $at.blockRange()!;
    const quoted = apply(state, state.tr.wrap(range, [{ type: n.blockquote }]));
    expect(firstItem(quoted).attrs.checked).toBeNull();
    expect(markdownOf(quoted)).toBe("- > x = 1\n");
  });

  it("a heading pasted over a task's words: the box goes", () => {
    const state = stateOf("- [ ] Old words\n");
    const item = firstItem(state);
    const heading = n.heading.create({ level: 2 }, schema.text("Pasted title"));
    const after = apply(state, state.tr.replaceWith(2, 2 + item.firstChild!.nodeSize, heading));
    expect(firstItem(after).attrs.checked).toBeNull();
    expect(markdownOf(after)).toBe("- ## Pasted title\n");
  });

  it("one Undo brings the box back with the plain line", () => {
    const state = stateOf("- [ ] Title here\n");
    const after = apply(state, state.tr.setBlockType(3, 3, n.heading, { level: 1 }));
    let back = after;
    undo(after, (tr) => (back = apply(after, tr)));
    expect(markdownOf(back)).toBe("- [ ] Title here\n");
  });

  it("typing in a task, or a task's second paragraph made a heading, leaves its box alone", () => {
    const state = stateOf("- [ ] First line\n\n  Second part\n");
    const typed = apply(state, state.tr.insertText("New "));
    expect(firstItem(typed).attrs.checked).toBe(false);
    const second = firstItem(state).firstChild!.nodeSize + 3;
    const after = apply(state, state.tr.setBlockType(second, second, n.heading, { level: 3 }));
    expect(firstItem(after).attrs.checked).toBe(false);
  });
});
