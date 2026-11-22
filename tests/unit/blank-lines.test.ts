// The page's spacing (src/renderer/blank-lines.ts): each empty line marked,
// blocks written close set close, and while typing, the whole document looked
// at again only when its blocks change, never for each letter typed.
import { describe, expect, it } from "vitest";
import { EditorState, TextSelection, type Command } from "prosemirror-state";
import { baseKeymap, chainCommands } from "prosemirror-commands";
import type { Node } from "prosemirror-model";
import { isEmptyLine, parseMarkdown, serializeMarkdown } from "../../src/core/markdown";
import { blankLinesKey, blankLinesPlugin, emptyLineOutOfQuote, joinOverBlankLine, joinOverBlankLineForward, spacingOf } from "../../src/renderer/blank-lines";
import { splitItem } from "../../src/renderer/tasks";

const kinds = (doc: Node, text: string) => {
  const { source } = parseMarkdown(text);
  return spacingOf(doc, source)
    .find()
    .map((d) => `${d.spec.kind} ${doc.nodeAt(d.from)!.textContent || "(empty)"}`);
};

describe("the spacing marks", () => {
  it("mark empty lines, what follows each, blocks written close, and a quote's parts written close", () => {
    const text = "# Title\nRight under.\n\nOne blank.\n\n\nTwo blank.\n\n> a\n> - b\n";
    const { doc } = parseMarkdown(text);
    expect(kinds(doc, text)).toEqual(["joined Right under.", "empty (empty)", "after Two blank.", "part b"]);
  });

  it("don't take a paragraph of a space written as a character reference for an empty line (R-EL-6)", () => {
    const text = "A\n\n&#32;\n\nB\n\n\nC\n";
    const { doc } = parseMarkdown(text);
    expect(kinds(doc, text)).toEqual(["empty (empty)", "after C"]);
  });
});

function stateAfter(text: string, find: string, typed: string): EditorState {
  const { doc, source } = parseMarkdown(text);
  let state = EditorState.create({ doc, plugins: [blankLinesPlugin(() => source, false)] });
  let at = -1;
  state.doc.descendants((node, pos) => {
    if (at < 0 && node.isText && node.text!.includes(find)) at = pos + node.text!.indexOf(find) + find.length;
  });
  state = state.apply(state.tr.setSelection(TextSelection.create(state.doc, at)));
  for (const ch of typed) {
    state = state.apply(ch === "\n" ? state.tr.split(state.selection.from) : state.tr.insertText(ch));
  }
  return state;
}

describe("while typing", () => {
  it("letters typed in a paragraph only carry the marks along", () => {
    const state = stateAfter("One.\n\n\nTwo.\n", "One", " more words");
    expect(blankLinesKey.getState(state)).toMatchObject({ stale: false, later: false });
  });

  it("letters typed in a quote with parts written close look again at it only once typing pauses, not for each letter", () => {
    const state = stateAfter("> a\n> - b\n\nAfter.\n", "a", "bc");
    expect(blankLinesKey.getState(state)).toMatchObject({ stale: false, later: true });
  });

  it("a new block looks at the whole document again in the next frame", () => {
    const state = stateAfter("One.\n\nTwo.\n", "One.", "\n");
    expect(blankLinesKey.getState(state)).toMatchObject({ stale: true });
  });
});

// Review R-EL-1: Backspace at the start of a paragraph right under another takes
// the blank line between them away; what's left is what the file reads back.
describe("Backspace over the blank line between two paragraphs", () => {
  const backspace = (text: string, find: string, command = joinOverBlankLine, after = false) => {
    const { doc, source } = parseMarkdown(text);
    let at = -1;
    doc.descendants((node, pos) => {
      if (at < 0 && node.isText && node.text!.includes(find)) at = pos + node.text!.indexOf(find) + (after ? find.length : 0);
    });
    let state = EditorState.create({ doc, selection: TextSelection.create(doc, at), plugins: [blankLinesPlugin(() => source, false)] });
    const done = command(state, (tr) => (state = state.apply(tr)));
    const written = serializeMarkdown(state.doc, source);
    // What the page holds is what the file reads back.
    if (done) expect(parseMarkdown(written).doc.eq(state.doc)).toBe(true);
    return { done, written, cursor: state.doc.textBetween(state.selection.from, Math.min(state.selection.from + 3, state.doc.content.size - 1)) };
  };

  it("puts the two on consecutive lines, the cursor where it was", () => {
    expect(backspace("A\n\nB\n", "B")).toEqual({ done: true, written: "A\nB\n", cursor: "B" });
    expect(backspace("A\n\nB\n", "A", joinOverBlankLineForward, true)).toEqual({ done: true, written: "A\nB\n", cursor: "\nB" });
  });

  it("drops spaces either side of the new line break, which Markdown wouldn't keep", () => {
    const { doc, source } = parseMarkdown("x\n");
    const p = (text: string) => doc.type.schema.nodes.paragraph.create(null, doc.type.schema.text(text));
    const spaced = doc.type.create(null, [p("A  "), p(" B")]);
    let state = EditorState.create({ doc: spaced, selection: TextSelection.create(spaced, 6) });
    expect(joinOverBlankLine(state, (tr) => (state = state.apply(tr)))).toBe(true);
    expect(state.doc.textContent).toBe("A\nB");
    expect(serializeMarkdown(state.doc, source)).toBe("A\nB\n");

    const s = doc.type.schema;
    const broken = doc.type.create(null, [s.nodes.paragraph.create(null, [s.text("A"), s.nodes.hard_break.create()]), p("B")]);
    state = EditorState.create({ doc: broken, selection: TextSelection.create(broken, 5) });
    expect(joinOverBlankLine(state, (tr) => (state = state.apply(tr)))).toBe(true);
    expect(serializeMarkdown(state.doc, source)).toBe("A\\\nB\n");
  });

  it("keeps formatting either side, and a typed line break at the join is the line between", () => {
    expect(backspace("**A**\n\n*B*\n", "B").written).toBe("**A**\n*B*\n");
    expect(backspace("A\\\n\nB\n", "B").written).toBe("A\\\\\nB\n");
    expect(backspace("> A\n>\n> B\n", "B").written).toBe("> A\n> B\n");
    expect(backspace("- A\n\n  B\n", "B").written).toBe("- A\n  B\n");
  });

  it("in a list, leaves it spaced where it still has blank lines, and close all through where that was its only one", () => {
    expect(backspace("- A\n\n  B\n- C\n", "B").written).toBe("- A\n  B\n- C\n");
    expect(backspace("- x\n- A\n\n  B\n- C\n", "B").written).toBe("- x\n- A\n  B\n- C\n");
    expect(backspace("- A\n\n  B\n\n- C\n", "B").written).toBe("- A\n  B\n\n- C\n");
    expect(backspace("1. A\n\n   B\n2. C\n", "A", joinOverBlankLineForward, true).written).toBe("1. A\n   B\n2. C\n");
    expect(backspace("> - A\n>\n>   B\n", "B").written).toBe("> - A\n>   B\n");
    expect(backspace("- A\n\n  B\n  - sub\n", "B").written).toBe("- A\n  B\n  - sub\n");
  });

  it("leaves Backspace as it was under an empty line, a heading, a list or a table, and in the middle of words", () => {
    for (const [text, find] of [["A\n\n\nB\n", "B"], ["# A\n\nB\n", "B"], ["- A\n\nB\n", "B"], ["- A\n- B\n", "B"], ["A\n\nBC\n", "C"], ["| a |\n| - |\n| b |\n\nB\n", "B"]]) {
      expect(backspace(text, find).done, text).toBe(false);
    }
  });
});

// Review R-EL-2: Markdown has no empty paragraph in a quote, a callout or a
// list item beside other parts, so the page never keeps one: Return takes the
// empty line out of the quote, where the file holds it, and one left to type
// into goes once the cursor leaves it.
describe("empty lines in quotes and list items", () => {
  const enter = chainCommands(splitItem, emptyLineOutOfQuote, baseKeymap.Enter);
  // Inside words, the browser deletes a letter itself; here, the same.
  const letter = (dir: -1 | 1): Command => (state, dispatch) => {
    const $c = (state.selection as TextSelection).$cursor;
    if (!$c || (dir < 0 ? $c.parentOffset === 0 : $c.parentOffset === $c.parent.content.size)) return false;
    dispatch?.(dir < 0 ? state.tr.delete($c.pos - 1, $c.pos) : state.tr.delete($c.pos, $c.pos + 1));
    return true;
  };
  const backspace = chainCommands(joinOverBlankLine, baseKeymap.Backspace, letter(-1));
  const del = chainCommands(joinOverBlankLineForward, baseKeymap.Delete, letter(1));

  function editor(text: string) {
    const { doc, source } = parseMarkdown(text);
    let state = EditorState.create({ doc, plugins: [blankLinesPlugin(() => source, true)] });
    const run = (command: Command) => command(state, (tr) => (state = state.applyTransaction(tr).state));
    const at = (find: string, after = false) => {
      let pos = -1;
      state.doc.descendants((node, p) => {
        if (pos < 0 && node.isText && node.text!.includes(find)) pos = p + node.text!.indexOf(find) + (after ? find.length : 0);
      });
      state = state.applyTransaction(state.tr.setSelection(TextSelection.create(state.doc, pos))).state;
    };
    const file = () => serializeMarkdown(state.doc, source);
    return { run, at, file, get state() { return state; } };
  }

  it("Return twice in the middle of a quote's paragraph: two paragraphs, then the empty line out of the quote, the cursor with the words", () => {
    const e = editor("> We met on Friday. We agreed.\n\nAfter.\n");
    e.at("We agreed.");
    e.run(enter);
    expect(e.file()).toBe("> We met on Friday. \n>\n> We agreed.\n\nAfter.\n");
    e.run(enter);
    expect(e.file()).toBe("> We met on Friday. \n\n\n> We agreed.\n\nAfter.\n");
    e.run((state, dispatch) => (dispatch!(state.tr.insertText("Then ")), true));
    expect(e.file()).toBe("> We met on Friday. \n\n\n> Then We agreed.\n\nAfter.\n");
  });

  it("Return on an empty line in a quote takes it out, at the end, the start or the middle of the quote", () => {
    const end = editor("> [!note] Plan\n> First line.\n\nAfter.\n");
    end.at("First line.", true);
    end.run(enter);
    expect(end.state.doc.child(0).childCount).toBe(2); // to type into
    end.run(enter);
    expect(end.file()).toBe("> [!note] Plan\n> First line.\n\n\nAfter.\n");
    expect(end.state.selection.$head.parent.childCount).toBe(0); // on the empty line

    const start = editor("Before.\n\n> A\n>\n> B\n");
    start.at("A");
    start.run(enter);
    expect(start.file()).toBe("Before.\n\n\n> A\n>\n> B\n");

    const nested = editor("> > A\n> >\n> > B\n");
    nested.at("B");
    nested.run(enter);
    expect(nested.file()).toBe("> > A\n>\n> > B\n");
  });

  it("an empty paragraph left in a quote or list item goes when the cursor leaves; an empty quote, an empty item and a task's box stay", () => {
    const e = editor("> A\n\n- b\n\n  c\n- [ ] \n  - sub\n\n>\n\nEnd.\n");
    e.at("A", true);
    e.run(enter);
    expect(e.state.doc.child(0).childCount).toBe(2);
    e.at("End.");
    expect(e.state.doc.child(0).childCount).toBe(1);
    // The words of an item's second paragraph deleted: it goes once the cursor leaves.
    e.at("c", true);
    e.run(backspace);
    expect(e.state.doc.child(1).child(0).childCount).toBe(2);
    e.at("End.");
    expect(e.state.doc.child(1).child(0).childCount).toBe(1);
    // The rest stays: an empty quote, a task with no words, and the page reads back as it is.
    expect(parseMarkdown(e.file()).doc.eq(e.state.doc)).toBe(true);
    expect(e.file()).toContain("- [ ] \n");
    expect(e.file()).toContain(">\n\nEnd.");
  });

  it("no keys pressed anywhere leave an empty line the file doesn't hold", () => {
    const docs = [
      "> One two.\n>\n> Three four.\n\n> [!note] Plan\n> Five six.\n\nSeven.\n",
      "- a b\n\n  c d\n- e f\n  - g h\n\n> i j\n> - k l\n\nm n\n",
      "Intro.\n\n> > deep one\n> >\n> > deep two\n>\n> outer\n\n1. x y\n2. z\n\n- [ ] task\n  - sub\n",
    ];
    let seed = 7;
    const random = () => ((seed = (seed * 1103515245 + 12345) % 2147483648) / 2147483648);
    let checked = 0;
    for (const text of docs) {
      for (let round = 0; round < 60; round++) {
        const e = editor(text);
        for (let step = 0; step < 12; step++) {
          const texts: number[] = [];
          e.state.doc.descendants((node, pos) => {
            if (node.isTextblock) for (let i = 0; i <= node.content.size; i++) texts.push(pos + 1 + i);
          });
          const r = random();
          if (r < 0.3) e.run((state, dispatch) => (dispatch!(state.tr.setSelection(TextSelection.create(state.doc, texts[Math.floor(random() * texts.length)]))), true));
          else if (r < 0.55) e.run(enter);
          else if (r < 0.75) e.run(backspace);
          else if (r < 0.85) e.run(del);
          else e.run((state, dispatch) => (dispatch!(state.tr.insertText("w")), true));
          // Every empty paragraph in a quote or list item is all it holds, a task's box, or where the cursor is.
          const head = e.state.selection.head;
          e.state.doc.descendants((node, pos, parent, index) => {
            if (!node.isTextblock) return true;
            if (parent && ["blockquote", "list_item"].includes(parent.type.name) && isEmptyLine(node) && parent.childCount > 1) {
              const ok = (head > pos && head < pos + node.nodeSize) || (index === 0 && parent.attrs.checked != null);
              expect(ok, `${text} round ${round}: ${JSON.stringify(e.state.doc.toJSON())}`).toBe(true);
              checked++;
            }
            return false;
          });
        }
        // With the cursor at the top, every empty line the page shows is one the file reads back.
        e.run((state, dispatch) => (dispatch!(state.tr.setSelection(TextSelection.create(state.doc, 1))), true));
        // (Empty lines after the last words aren't saved, by design: the spec's "tidy files".)
        const empties = (doc: Node) => {
          let n = 0;
          let last = doc.childCount;
          while (last > 0 && isEmptyLine(doc.child(last - 1))) last--;
          doc.descendants((node, _pos, parent, index) => {
            if (node.type.name === "paragraph" && isEmptyLine(node) && !(parent === doc && index >= last)) n++;
            return !node.isTextblock;
          });
          return n;
        };
        const back = parseMarkdown(e.file()).doc;
        // (A task list joined to a numbered one is shown as Markdown text on reading: another matter.)
        if (back.textContent !== e.state.doc.textContent || back.childCount !== e.state.doc.childCount) {
          let raw = false;
          back.descendants((node) => void (raw ||= node.type.name === "raw_block"));
          if (raw) continue;
        }
        if (e.state.selection.$head.parent.type.name === "paragraph" && isEmptyLine(e.state.selection.$head.parent) && e.state.selection.$head.depth > 1) continue;
        expect(empties(back), `${JSON.stringify(text)} round ${round}: ${JSON.stringify(e.file())} ${JSON.stringify(e.state.doc.toJSON())}`).toBe(empties(e.state.doc));
      }
    }
    expect(checked).toBeGreaterThan(0);
  });
});

// Review R-EL-5: typing a letter in a list or quote with blank lines between
// some parts and not others adds no blank line, and the page's spacing,
// worked out again once typing pauses, is the same: nothing jumps.
describe("typing in a list or quote spaced in places", () => {
  const typeAfter = (text: string, find: string) => {
    const { doc, source } = parseMarkdown(text);
    let at = -1;
    doc.descendants((node, pos) => {
      if (at < 0 && node.isText && node.text!.includes(find)) at = pos + node.text!.indexOf(find) + find.length;
    });
    const tr = EditorState.create({ doc }).tr.insertText("x", at);
    const typed = tr.doc;
    const spacing = (d: Node, map: (pos: number) => number) => spacingOf(d, source).find().map((m) => `${m.spec.kind} ${map(m.from)}`);
    expect(spacing(typed, (pos) => pos)).toEqual(spacing(doc, (pos) => tr.mapping.map(pos)));
    return serializeMarkdown(typed, source);
  };

  it("adds no blank line anywhere, and the page keeps its spacing", () => {
    expect(typeAfter("- a\n- b\n\n- c\n", "a")).toBe("- ax\n- b\n\n- c\n");
    expect(typeAfter("- a\n\n- b\n- c\n", "c")).toBe("- a\n\n- b\n- cx\n");
    expect(typeAfter("> a\n> - b\n", "a")).toBe("> ax\n> - b\n");
    expect(typeAfter("- a\n\n  b\n- c\n", "c")).toBe("- a\n\n  b\n- cx\n");
    expect(typeAfter("- a\n  - sub\n\n- b\n", "a")).toBe("- ax\n  - sub\n\n- b\n");
    expect(typeAfter("1. one\n   - two\n\n     three\n   - four\n2. five\n", "three")).toBe("1. one\n   - two\n\n     threex\n   - four\n2. five\n");
  });
});
