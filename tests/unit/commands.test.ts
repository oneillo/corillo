// The toolbar's commands, on the document itself.
import { describe, expect, it } from "vitest";
import { EditorState, TextSelection, type Transaction } from "prosemirror-state";
import type { Node } from "prosemirror-model";
import { parseMarkdown, serializeMarkdown } from "../../src/core/markdown";
import { normaliseHref, setStyle, toggleCodeBlock, toggleQuote } from "../../src/renderer/commands";
import { footnotePlugin } from "../../src/renderer/footnotes";

/** Where some text starts in the document. */
function place(doc: Node, text: string): number {
  let at = -1;
  doc.descendants((node, pos) => {
    if (at >= 0) return false;
    const i = node.isText ? node.text!.indexOf(text) : -1;
    if (i >= 0) at = pos + i;
    return at < 0;
  });
  if (at < 0) throw new Error(`no "${text}" in the document`);
  return at;
}

/** Selected from where `from` starts to where `to` ends (or the cursor at `from`), with the editor's footnote plugin, which takes a note away with its last marker. */
function stateOf(markdown: string, from: string, to?: string): EditorState {
  const { doc } = parseMarkdown(markdown);
  const start = place(doc, from);
  const end = to === undefined ? start : place(doc, to) + to.length;
  const state = EditorState.create({ doc, plugins: [footnotePlugin()] });
  return state.apply(state.tr.setSelection(TextSelection.create(doc, start, end)));
}

/** Press Code block: the state after, and whether the button could do anything. */
function press(state: EditorState): { state: EditorState; done: boolean } {
  let next = state;
  const done = toggleCodeBlock(state, (tr) => (next = state.apply(tr)));
  return { state: next, done };
}

const markdownOf = (state: EditorState) => serializeMarkdown(state.doc, parseMarkdown("").source);

describe("the Code block button", () => {
  it("keeps a paragraph's pictures, note marks and links as their Markdown text", () => {
    const text = "Some **bold** text ![Chart](chart.png) and a note[^1] with [a link](https://example.com).\n\n[^1]: The note.\n";
    const { state } = press(stateOf(text, "Some"));
    expect(markdownOf(state)).toBe(
      "```\nSome bold text ![Chart](chart.png) and a note[^1] with [a link](https://example.com).\n```\n\n[^1]: The note.\n",
    );
  });

  it("keeps the note of a marker it turns into text, with others in the paragraph and elsewhere", () => {
    const text = "First point here.[^1] And more.[^2]\n\nSecond point here.\n\n[^1]: Source: the survey.\n\n[^2]: Another.\n";
    const { state } = press(stateOf(text, "First"));
    expect(markdownOf(state)).toBe(
      "```\nFirst point here.[^1] And more.[^2]\n```\n\nSecond point here.\n\n[^1]: Source: the survey.\n\n[^2]: Another.\n",
    );
  });

  it("makes the selected paragraphs one code block, a line each", () => {
    const text = "Before.\n\nFirst line.\n\nSecond line.\n\nThird line.\n\nAfter.\n";
    const { state } = press(stateOf(text, "First", "Third line."));
    expect(markdownOf(state)).toBe("Before.\n\n```\nFirst line.\nSecond line.\nThird line.\n```\n\nAfter.\n");
    expect(state.doc.childCount).toBe(3);
    expect(state.doc.textBetween(state.selection.from, state.selection.to)).toBe("First line.\nSecond line.\nThird line.");
  });

  it("writes a line break in a paragraph as a new line of code", () => {
    const { state } = press(stateOf("One\\\ntwo.\n", "One"));
    expect(markdownOf(state)).toBe("```\nOne\ntwo.\n```\n");
  });

  it("turned off, gives a paragraph per line of code, with the text as it was", () => {
    const { state } = press(stateOf("```\nfirst *line*\nsecond line\n```\n", "first"));
    expect(markdownOf(state)).toBe("first \\*line\\*\n\nsecond line\n");
    expect(state.doc.childCount).toBe(2);
  });

  // Changed 2026-11-09 night (R-SH-6): blank lines inside used to be left out; since empty lines are
  // real (each blank line of the file an empty line on the page), each one becomes an empty line.
  it("turned off, makes each blank line inside an empty line, leaving out only those at its start and end", () => {
    const { state } = press(stateOf("```\n\none\n\n\ntwo\n\n```\n", "one"));
    expect(markdownOf(state)).toBe("one\n\n\n\ntwo\n");
    expect(state.doc.childCount).toBe(4);
  });

  it("on then off gives back paragraphs with empty lines between them, empty lines and all", () => {
    for (const text of ["Para one\n\n\n\nPara two\n", "Para one\n\n\nPara two\n\nPara three\n", "Alpha.\n\nBeta.\n"]) {
      const { doc } = parseMarkdown(text);
      const all = EditorState.create({ doc }).apply(EditorState.create({ doc }).tr.setSelection(TextSelection.create(doc, 1, doc.content.size - 1)));
      const on = press(all);
      expect(on.state.doc.childCount).toBe(1);
      const off = press(on.state);
      expect(markdownOf(off.state)).toBe(text);
      expect(off.state.doc.eq(doc)).toBe(true);
    }
  });

  it("pressed twice gives the same paragraphs back, still selected", () => {
    const once = press(stateOf("Alpha.\n\nBeta.\n", "Alpha", "Beta."));
    const twice = press(once.state);
    expect(markdownOf(twice.state)).toBe("Alpha.\n\nBeta.\n");
    expect(twice.state.doc.textBetween(twice.state.selection.from, twice.state.selection.to, "\n")).toBe("Alpha.\nBeta.");
  });

  it("keeps the cursor where it was in the text", () => {
    const on = press(stateOf("Alpha beta.\n", "beta"));
    expect(on.state.doc.textBetween(on.state.selection.from, on.state.doc.content.size - 1)).toBe("beta.");
    const off = press(stateOf("```\none\ntwo three\n```\n", "three"));
    expect(off.state.doc.textBetween(off.state.selection.from, off.state.doc.content.size - 1)).toBe("three");
  });

  it("works on a heading, keeping its text", () => {
    expect(markdownOf(press(stateOf("# Title\n", "Title")).state)).toBe("```\nTitle\n```\n");
  });

  it("leaves paragraphs in separate list items a block each, in their own items", () => {
    const { state } = press(stateOf("- one\n- two\n", "one", "two"));
    const list = state.doc.firstChild!;
    expect(list.childCount).toBe(2);
    list.forEach((item) => expect(item.firstChild!.type.name).toBe("code_block"));
  });

  it("is unavailable in a table cell, as before", () => {
    expect(press(stateOf("| a | b |\n| - | - |\n| one | two |\n", "one")).done).toBe(false);
  });
});

describe("addresses typed into the link editor", () => {
  it("adds https:// to a web address, with or without a port", () => {
    expect(normaliseHref("example.com")).toBe("https://example.com");
    expect(normaliseHref("localhost:3000")).toBe("https://localhost:3000");
    expect(normaliseHref("localhost:3000/docs")).toBe("https://localhost:3000/docs");
    expect(normaliseHref("example.com:8080/x")).toBe("https://example.com:8080/x");
    expect(normaliseHref("127.0.0.1:8000")).toBe("https://127.0.0.1:8000");
    expect(normaliseHref("www.example.com/a?b=c")).toBe("https://www.example.com/a?b=c");
  });

  it("leaves addresses with a scheme, mail addresses and places in the document as they are", () => {
    expect(normaliseHref("https://example.com:8080/x")).toBe("https://example.com:8080/x");
    expect(normaliseHref("mailto:ana@example.com")).toBe("mailto:ana@example.com");
    expect(normaliseHref("tel:5551234")).toBe("tel:5551234");
    expect(normaliseHref("ana@example.com")).toBe("mailto:ana@example.com");
    expect(normaliseHref("#plan")).toBe("#plan");
    expect(normaliseHref("./notes.md")).toBe("./notes.md");
  });

  it("leaves a document's or file's name a link to it, not a website: only plain web addresses get https://", () => {
    for (const name of ["budget.md", "notes.txt", "Café.md", "plan.markdown", "chart.png", "report.pdf", "deck.pptx", "run.sh", "budget.md#risks"]) {
      expect(normaliseHref(name), name).toBe(name);
    }
    expect(normaliseHref("notes/Q3 plan.md")).toBe("notes/Q3 plan.md");
    expect(normaliseHref("../plan.md")).toBe("../plan.md");
    expect(normaliseHref("#risks")).toBe("#risks");
    expect(normaliseHref("  budget.md ")).toBe("budget.md");
    // Web addresses, with or without www., a path or a port, still do.
    expect(normaliseHref("nytimes.com")).toBe("https://nytimes.com");
    expect(normaliseHref("bbc.co.uk/news")).toBe("https://bbc.co.uk/news");
    expect(normaliseHref("example.org/plan.md")).toBe("https://example.org/plan.md");
    expect(normaliseHref("www.budget.md")).toBe("https://www.budget.md");
    expect(normaliseHref("anthropic.ai")).toBe("https://anthropic.ai");
    expect(normaliseHref("localhost:3000")).toBe("https://localhost:3000");
    expect(normaliseHref("example.com:8080/x")).toBe("https://example.com:8080/x");
  });
});

describe("a task's first line given a heading or made code (roadmap Batch 18, R16-3 case 2)", () => {
  // Markdown has a task's box only at the start of a plain line: "- [ ] # Title" reads back as the words "# Title".
  // So the box goes and the item stays in its list, an ordinary one, as an item given a heading is.
  const run = (state: EditorState, command: (s: EditorState, d?: (tr: Transaction) => void) => boolean) => {
    let next = state;
    expect(command(state, (tr) => (next = state.apply(tr)))).toBe(true);
    return next;
  };
  /** Saved, then opened again: the same page, with no Markdown signs in its words. */
  const roundTrip = (state: EditorState) => {
    const md = markdownOf(state);
    const again = parseMarkdown(md).doc;
    expect(again.toJSON(), md).toEqual(state.doc.toJSON());
    return md;
  };
  const words = (doc: Node) => doc.textContent;

  it("Heading 1 on a task: a heading in an ordinary item, and it comes back as one", () => {
    const after = run(stateOf("- [ ] Title here\n\nAfter.\n", "Title"), setStyle("h1"));
    expect(after.doc.firstChild!.firstChild!.attrs.checked).toBeNull();
    expect(after.doc.firstChild!.firstChild!.firstChild!.type.name).toBe("heading");
    expect(roundTrip(after)).toBe("- # Title here\n\nAfter.\n");
    expect(words(parseMarkdown(markdownOf(after)).doc)).not.toContain("#");
  });

  it("Code block on a ticked task: code in an ordinary item, and it comes back as code", () => {
    const after = press(stateOf("- [x] x = 1\n\nAfter.\n", "x = 1")).state;
    expect(after.doc.firstChild!.firstChild!.attrs.checked).toBeNull();
    expect(after.doc.firstChild!.firstChild!.firstChild!.type.name).toBe("code_block");
    const md = roundTrip(after);
    expect(words(parseMarkdown(md).doc)).not.toContain("`");
  });

  it("Quote on a task: a quote in an ordinary item, and it comes back as one", () => {
    const after = run(stateOf("- [ ] Title here\n\nAfter.\n", "Title"), toggleQuote);
    expect(after.doc.firstChild!.firstChild!.attrs.checked).toBeNull();
    expect(roundTrip(after)).toBe("- > Title here\n\nAfter.\n");
  });

  it("several tasks selected: each loses its box, the ones not touched keep theirs", () => {
    const after = run(stateOf("- [ ] One\n- [x] Two\n- [ ] Three\n", "One", "Two"), setStyle("h2"));
    expect(after.doc.firstChild!.content.content.map((item) => item.attrs.checked)).toEqual([null, null, false]);
    expect(roundTrip(after)).toBe("- ## One\n- ## Two\n- [ ] Three\n");
  });

  it("a task's second paragraph given a heading: the task keeps its box", () => {
    const after = run(stateOf("- [ ] First line\n\n  Second part\n", "Second"), setStyle("h3"));
    expect(after.doc.firstChild!.firstChild!.attrs.checked).toBe(false);
    roundTrip(after);
  });

  it("Normal on a task's first line: nothing to do, the box stays; on a heading in an ordinary item, a plain line again", () => {
    const task = stateOf("- [x] Done thing\n", "Done");
    expect(setStyle("paragraph")(task, () => undefined)).toBe(false);
    const after = run(stateOf("- # Title here\n", "Title"), setStyle("paragraph"));
    expect(roundTrip(after)).toBe("- Title here\n");
  });
});
