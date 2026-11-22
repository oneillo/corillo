// Line numbers: each part of the document shows the line of the Markdown file
// it starts on, as an agent reading the file counts them. Checked against the
// file itself, for every kind of block, odd line endings, and after edits.
import { describe, expect, it } from "vitest";
import { EditorState, TextSelection, type Transaction } from "prosemirror-state";
import { history, undo, redo } from "prosemirror-history";
import type { Node } from "prosemirror-model";
import { isEmptyLine, parseMarkdown, serializeMarkdown, type Source } from "../../src/core/markdown";
import { blockStarts, lineMarks, textAreaLineNumbers, type LineMark } from "../../src/core/line-numbers";
import { schema } from "../../src/core/schema";
import { bigDocument } from "../fixtures/big-document";

/** What the numbers say: each one with the words it's beside. */
function shown(doc: Node, source: Source): string[] {
  return lineMarks(doc, source).map((m) => `${m.line} ${what(doc, m)}`);
}

/** The words a number is beside, briefly. */
function what(doc: Node, m: LineMark): string {
  if (m.kind === "line") {
    const $pos = doc.resolve(m.from);
    // The words from here to the end of the line (a break counts as the end).
    const text = doc.textBetween(m.from, $pos.end(), "\n", "\n");
    return `${$pos.parent.type.name}: ${text.split("\n")[0]}`;
  }
  const node = doc.nodeAt(m.from)!;
  const words =
    node.type.name === "table_row"
      ? node.firstChild!.textContent
      : node.isTextblock
        ? node.textBetween(0, node.content.size, "\n", "\n").split("\n")[0] // to the first break of any kind
        : node.textContent.split("\n")[0];
  return `${node.type.name}: ${words}`;
}

const numbersFor = (text: string) => {
  const { doc, source } = parseMarkdown(text);
  return shown(doc, source);
};

/**
 * Every number agrees with the file: the line it names holds the start of
 * what it's beside. The file is what Corillo would write for the document now.
 */
function expectNumbersMatchFile(doc: Node, source: Source): void {
  const file = serializeMarkdown(doc, source).replace(/^﻿/, "").split("\n").map((l) => l.replace(/\r$/, ""));
  const marks = lineMarks(doc, source, true);
  for (const m of marks) {
    const line = file[m.line - 1];
    expect(line, `line ${m.line} is in the file`).toBeDefined();
    const label = `line ${m.line} ("${line}") for ${m.kind} ${what(doc, m)}`;
    // Lines with no words (2026-11-09): a blank line, a closing fence, a table's dashes.
    if (m.kind === "blank") {
      expect(line, label).toMatch(/^[ \t>]*$/);
      continue;
    }
    if (m.kind === "end") {
      expect(line, label).toMatch(/^[ \t>]*(```|~~~)/);
      continue;
    }
    if (m.kind === "dash") {
      expect(line, label).toMatch(/^[ \t>]*\|?[ \t]*:?-+/);
      continue;
    }
    if (m.kind === "block" && isEmptyLine(doc.nodeAt(m.from)!)) {
      expect(line, label).toMatch(/^[ \t]*$/);
      continue;
    }
    if (m.kind === "line") {
      const $pos = doc.resolve(m.from);
      const parent = $pos.parent;
      if (parent.type.name === "footnote_def") expect(line, label).toMatch(new RegExp(`^ {0,3}\\[\\^${parent.attrs.label}\\]:`));
      else if (parent.type.name === "paragraph") {
        // A line of a paragraph written on several lines: the file line holds its first word.
        const rest = doc.textBetween(m.from, $pos.end(), "\n", "\n").split("\n")[0];
        const firstWord = /[A-Za-z0-9]+/.exec(rest)?.[0];
        if (firstWord) expect(line, label).toContain(firstWord);
      } else {
        const codeLine = parent.textContent.slice($pos.parentOffset).split("\n")[0].replace(/\r$/, "");
        expect(line.endsWith(codeLine), label).toBe(true);
      }
      continue;
    }
    const node = doc.nodeAt(m.from)!;
    if (node.type.name === "horizontal_rule") expect(line, label).toMatch(/(?:[-*_][ \t]*){3,}$/);
    else if (node.type.name === "code_block") expect(line.trim() === "" || /```|~~~/.test(line) || line.startsWith("    "), label).toBe(true);
    else {
      const source = node.type.name === "table_row" ? node.firstChild! : node;
      const firstWord = /[A-Za-z0-9]+/.exec(source.textContent)?.[0];
      if (firstWord) expect(line, label).toContain(firstWord);
    }
  }
  // Numbers go down the page in order.
  const lines = marks.map((m) => m.line);
  expect([...lines].sort((a, b) => a - b)).toEqual(lines);
}

/** The numbers worked out for the edited document are the ones its own file gives when read afresh. */
function expectSameAsFresh(doc: Node, source: Source): boolean {
  const text = serializeMarkdown(doc, source);
  const fresh = parseMarkdown(text);
  if (!fresh.doc.eq(doc)) return false; // read back differently (rare): nothing to compare position by position
  expect(lineMarks(doc, source)).toEqual(lineMarks(fresh.doc, fresh.source));
  return true;
}

describe("Line numbers", () => {
  // Changed 2026-11-09 (empty lines): blank lines beyond the one between two blocks are empty lines, numbered.
  it("number paragraphs and headings by the file line they start on", () => {
    expect(numbersFor("# Title\n\nFirst paragraph.\n\n\n\nAfter blank lines.\n\n## Part two\nRight under it.\n")).toEqual([
      "1 heading: Title",
      "3 paragraph: First paragraph.",
      "5 paragraph: ",
      "6 paragraph: ",
      "7 paragraph: After blank lines.",
      "9 heading: Part two",
      "10 paragraph: Right under it.",
    ]);
  });

  // Changed 2026-11-09 (empty lines): blank lines at the top are empty lines, numbered.
  it("count blank lines at the top of the file", () => {
    expect(numbersFor("\n\n\nText.\n")).toEqual(["1 paragraph: ", "2 paragraph: ", "3 paragraph: ", "4 paragraph: Text."]);
  });

  // Orlando, 2026-11-09: "when I'm working in Markdown, it's weird to see
  // missing line numbers, even if I know that means there's a blank line
  // between them. It makes it seem like the line number is broken."
  it("number every line of the file, blank lines too, with no gaps", () => {
    const text = [
      "# Title", "", "Para one.", "", "", "Para two.", "- a", "- b", "", "1. x", "", "2. y", "", "> q1", ">", "> q2", "",
      "```js", "code", "```", "", "| h | i |", "|---|---|", "| 1 | 2 |", "", "---", "", "Last.[^1]", "", "[^1]: Note.", "",
    ].join("\n");
    const { doc, source } = parseMarkdown(text);
    const lines = lineMarks(doc, source, true).map((m) => m.line);
    expect([...new Set(lines)].sort((a, b) => a - b)).toEqual(Array.from({ length: 30 }, (_, i) => i + 1));
    expectNumbersMatchFile(doc, source);
    // Blank lines in loose lists, between a list item's parts, and in quotes.
    const inner = parseMarkdown("- a\n\n- b\n\n  more b\n\n> one\n>\n> - two\n");
    expect(lineMarks(inner.doc, inner.source, true).map((m) => `${m.line} ${m.kind}`)).toEqual([
      "1 block", "2 blank", "3 block", "4 blank", "5 block", "6 blank", "7 block", "8 blank", "9 block",
    ]);
  });

  // Orlando, 2026-11-09
  it("give each line of a paragraph written over several lines its own number, as Corillo shows each on a line of its own", () => {
    expect(numbersFor("First line\nsecond line\nthird line.\n\nNext.\n")).toEqual([
      "1 paragraph: First line",
      "2 paragraph: second line",
      "3 paragraph: third line.",
      "5 paragraph: Next.",
    ]);
    // A poem: every line numbered, stanza by stanza.
    const poem = "# November\n\nThe maples gave up\nNow the yard is a ledger\npaid out in rust\n\nDark comes early\nAt half past four\n";
    expect(numbersFor(poem)).toEqual([
      "1 heading: November",
      "3 paragraph: The maples gave up",
      "4 paragraph: Now the yard is a ledger",
      "5 paragraph: paid out in rust",
      "7 paragraph: Dark comes early",
      "8 paragraph: At half past four",
    ]);
    // Breaks written as two spaces or a backslash end a line of the file too; one written as <br> doesn't.
    expect(numbersFor("One  \ntwo\\\nthree<br>still three\n")).toEqual([
      "1 paragraph: One",
      "2 paragraph: two",
      "3 paragraph: three",
    ]);
    // In a list item and a quote, the lines after the first are numbered too.
    expect(numbersFor("- item\n  carries on\n\n> quoted\n> and more\n")).toEqual([
      "1 paragraph: item",
      "2 paragraph: carries on",
      "4 paragraph: quoted",
      "5 paragraph: and more",
    ]);
    // A line ended by an old Mac line break is the same line of the file: no second number.
    expect(numbersFor("One\rstill one\nTwo\n")).toEqual(["1 paragraph: One", "2 paragraph: Two"]);
  });

  it("keep to the file's lines after code or a link's title that runs over a line break (shown on one line)", () => {
    expect(numbersFor("one `code\nspan` two\nthree\nfour\n\nNext.\n")).toEqual([
      "1 paragraph: one code span two",
      "3 paragraph: three",
      "4 paragraph: four",
      "6 paragraph: Next.",
    ]);
    expect(numbersFor('See [the site](https://x.com "a long\ntitle") now\nthen more\n')).toEqual([
      "1 paragraph: See the site now",
      "3 paragraph: then more",
    ]);
    expect(numbersFor("- one `code\n  span` two\n  three\n- four\n")).toEqual([
      "1 paragraph: one code span two",
      "3 paragraph: three",
      "4 paragraph: four",
    ]);
    // (Second review, R-MD-9: the code's second line has the same letters as the line after it.)
    expect(numbersFor("Plan `x\nnext` steps\nnext steps\n")).toEqual(["1 paragraph: Plan x next steps", "3 paragraph: next steps"]);
    expect(numbersFor("A `b\nc d` e\nc d\nf\n")).toEqual(["1 paragraph: A b c d e", "3 paragraph: c d", "4 paragraph: f"]);
  });

  it("are the same for Windows line endings and with a byte-order mark", () => {
    const text = "# Title\n\nOne\ntwo\n\n- a\n- b\n\n| x | y |\n|---|---|\n| 1 | 2 |\n\n```\ncode\nmore\n```\n";
    const expected = numbersFor(text);
    expect(numbersFor(text.replace(/\n/g, "\r\n"))).toEqual(expected);
    expect(numbersFor("﻿" + text)).toEqual(expected);
    expect(numbersFor("﻿" + text.replace(/\n/g, "\r\n"))).toEqual(expected);
  });

  it("count a lone carriage return (an old Mac line ending) as no new line, as an agent splitting at line feeds does", () => {
    expect(numbersFor("One\r\rTwo\n\nThree\n")).toEqual(["1 paragraph: One", "1 paragraph: Two", "3 paragraph: Three"]);
  });

  it("number each line of front matter, and the document after it", () => {
    expect(numbersFor("---\ntitle: Plan\nowner: Ana\n---\n\n# Plan\n")).toEqual([
      "1 raw_block: ---",
      "2 raw_block: title: Plan",
      "3 raw_block: owner: Ana",
      "4 raw_block: ---",
      "6 heading: Plan",
    ]);
  });

  it("number each list item, nested ones too, tight or loose", () => {
    expect(numbersFor("- one\n- two\n  - two a\n    - deeper\n  - two b\n- three\n\n1. first\n\n2. second\n\n   more of second\n")).toEqual([
      "1 paragraph: one",
      "2 paragraph: two",
      "3 paragraph: two a",
      "4 paragraph: deeper",
      "5 paragraph: two b",
      "6 paragraph: three",
      "8 paragraph: first",
      "10 paragraph: second",
      "12 paragraph: more of second",
    ]);
  });

  it("number each table row, skipping the line under the header", () => {
    expect(numbersFor("Intro.\n\n| Item | Cost |\n|:-----|-----:|\n| Tool | 5 |\n| Room | 10 |\n")).toEqual([
      "1 paragraph: Intro.",
      "3 table_row: Item",
      "5 table_row: Tool",
      "6 table_row: Room",
    ]);
  });

  it("number a table with line breaks in its cells by file line: each row is one line, however many lines it shows", () => {
    const text = "| Tool | Notes |\n|---|---|\n| **Atlas** | Fast<br>Cheap<br/>Small |\n| Cove | One<br />Two |\n\nAfter.\n";
    const { doc, source } = parseMarkdown(text);
    expect(doc.child(0).type.name).toBe("table"); // a grid, not Markdown text
    expect(shown(doc, source)).toEqual(["1 table_row: Tool", "3 table_row: Atlas", "4 table_row: Cove", "6 paragraph: After."]);
    expectNumbersMatchFile(doc, source);
    // A new line typed in a cell keeps every row on its own file line.
    let at = -1;
    doc.descendants((node, pos) => {
      if (node.type.name === "table_cell" && node.textContent.startsWith("Fast")) at = pos + node.nodeSize - 1;
      return at < 0;
    });
    let state = EditorState.create({ doc });
    state = state.apply(state.tr.insert(at, schema.nodes.hard_break.create()).insertText("More", at + 1));
    expect(shown(state.doc, source)).toEqual(["1 table_row: Tool", "3 table_row: Atlas", "4 table_row: Cove", "6 paragraph: After."]);
    expectNumbersMatchFile(state.doc, source);
  });

  it("number each line of a code block (after its fence), and a diagram where it starts", () => {
    expect(numbersFor("Code:\n\n```js\nconst a = 1;\n\nconsole.log(a);\n```\n\n    indented\n    code\n")).toEqual([
      "1 paragraph: Code:",
      "3 code_block: const a = 1;",
      "4 code_block: const a = 1;",
      "5 code_block: ",
      "6 code_block: console.log(a);",
      "9 code_block: indented",
      "9 code_block: indented",
      "10 code_block: code",
    ]);
    expect(numbersFor("```mermaid\ngraph LR\n  A --> B\n```\n")).toEqual([
      "1 code_block: graph LR",
      "2 code_block: graph LR",
      "3 code_block:   A --> B",
    ]);
  });

  it("number quotes, their paragraphs and quotes inside them", () => {
    expect(numbersFor("> First\n> still first\n>\n> Second\n>\n> > Inner\n\nAfter.\n")).toEqual([
      "1 paragraph: First",
      "2 paragraph: still first",
      "4 paragraph: Second",
      "6 paragraph: Inner",
      "8 paragraph: After.",
    ]);
  });

  it("number code inside a list item, and quotes in lists", () => {
    expect(numbersFor("- item\n\n  ```\n  inside\n  ```\n- > quoted item\n")).toEqual([
      "1 paragraph: item",
      "3 code_block: inside",
      "4 code_block: inside",
      "6 paragraph: quoted item",
    ]);
  });

  it("number footnotes, horizontal rules, and Markdown shown as it is", () => {
    expect(numbersFor("Text.[^1]\n\n---\n\n<div>\nhtml\n</div>\n\n[^1]: The note.\n[^2]: Another\n    with more.\n")).toEqual([
      "1 paragraph: Text.",
      "3 horizontal_rule: ",
      "5 raw_block: <div>",
      "6 raw_block: html",
      "7 raw_block: </div>",
      "9 footnote_def: The note.",
      "10 raw_block: [^2]: Another",
      "11 raw_block:     with more.",
    ]);
  });

  // Changed 2026-11-09 (empty lines): an empty line is a blank line of the
  // file, numbered; after the last words it isn't written, so it has none.
  it("number an empty line as the blank line it writes, except after the last words", () => {
    const { doc, source } = parseMarkdown("One.\n\nTwo.\n");
    const empty = schema.nodes.paragraph.create();
    const withEmpty = doc.copy(doc.content.addToEnd(empty).addToStart(empty));
    expect(shown(withEmpty, source)).toEqual(["1 paragraph: ", "2 paragraph: One.", "4 paragraph: Two."]);
    expectNumbersMatchFile(withEmpty, source);
  });

  it("are right for a new document that had no text", () => {
    const { source } = parseMarkdown("");
    const doc = schema.node("doc", null, [
      schema.node("heading", { level: 1 }, [schema.text("New")]),
      schema.node("paragraph", null, [schema.text("Words.")]),
    ]);
    expect(shown(doc, source)).toEqual(["1 heading: New", "3 paragraph: Words."]);
    expectNumbersMatchFile(doc, source);
  });

  it("match the file for every document of the round-trip collection", () => {
    const docs = [
      "# Title\r\n\r\nLine one\r\nline two\r\n\r\n- a\r\n- b\r\n",
      "Title\n=====\n\nSub\n---\n\nText\n",
      "* star\n* star two\n\n+ plus\n\n- dash\n  - nested\n    - deeper\n",
      "1. one\n2. two\n\n3) three\n4) four\n\n7. seven\n",
      "Two spaces  \nthen backslash\\\nend\n",
      "| a | b |\n|:--|--:|\n| 1 | 2 |\n|  spaced  |   x |\n\nAfter table.\n",
      "Text with a note[^1] and another[^long].\n\n[^1]: The note.\n[^long]: A longer note\n    with a second line.\n\nMore text.\n",
      "<!-- a comment -->\n\n<div align=\"center\">\n  <b>hi</b>\n</div>\n\nText with <br> inline html.\n",
      "- [ ] todo\n- [x] done\n",
      "> quoted\nlazy line\n\n> > nested\n",
      "a\n\n***\n\nb\n\n___\n\nc\n",
      "-\ttab bullet\n\n\tindented with tab\n",
      "\n\n  \n",
      "A [link](http://x.com \"t\").\n\n[ref]: http://ref.example\n\nSee [ref].\n",
      "\n\nA\n\n\n\nB\n \n\t\n- c\n\n\n> d\n>\n> e\n\n\n",
      "A\r\n\r\n\r\nB\r\n",
      bigDocument(2),
    ];
    for (const text of docs) {
      const { doc, source } = parseMarkdown(text);
      expectNumbersMatchFile(doc, source);
    }
  });
});

// Edits ---------------------------------------------------------------------------

/** Position just inside the end of the k-th top-level block. */
function endOfBlock(doc: Node, k: number): number {
  let pos = 0;
  for (let i = 0; i < k; i++) pos += doc.child(i).nodeSize;
  return pos + doc.child(k).nodeSize - 1;
}

describe("Line numbers after edits", () => {
  const TEXT = "# Plan\n\nWe should hire\ntwo people.\n\n- one\n- two\n\nLast.\n";

  it("follow typing, a new paragraph, undo and redo", () => {
    const { doc, source } = parseMarkdown(TEXT);
    let state = EditorState.create({ doc, plugins: [history()] });
    const at = (k: number) => endOfBlock(state.doc, k);
    // Typing in the hard-wrapped paragraph keeps its lines: nothing after it moves.
    state = state.apply(state.tr.insertText(" Soon.", at(1)));
    expect(shown(state.doc, source)).toEqual([
      "1 heading: Plan",
      "3 paragraph: We should hire",
      "4 paragraph: two people. Soon.",
      "6 paragraph: one",
      "7 paragraph: two",
      "9 paragraph: Last.",
    ]);
    expectNumbersMatchFile(state.doc, source);
    // A new paragraph after the heading pushes the rest down.
    state = state.apply(state.tr.insert(at(0) + 1, schema.nodes.paragraph.create(null, schema.text("Inserted."))));
    expect(shown(state.doc, source)).toEqual([
      "1 heading: Plan",
      "3 paragraph: Inserted.",
      "5 paragraph: We should hire",
      "6 paragraph: two people. Soon.",
      "8 paragraph: one",
      "9 paragraph: two",
      "11 paragraph: Last.",
    ]);
    expectNumbersMatchFile(state.doc, source);
    undo(state, (tr) => (state = state.apply(tr)));
    undo(state, (tr) => (state = state.apply(tr)));
    expect(shown(state.doc, source)).toEqual(numbersFor(TEXT)); // the file is as it was
    expect(serializeMarkdown(state.doc, source)).toBe(TEXT);
    redo(state, (tr) => (state = state.apply(tr)));
    expectNumbersMatchFile(state.doc, source);
  });

  it("follow a new list item and a list item split in two", () => {
    const { doc, source } = parseMarkdown(TEXT);
    let state = EditorState.create({ doc, plugins: [history()] });
    // Return at the end of "one" adds an item: the items after it move down.
    let listItemEnd = 0;
    state.doc.descendants((node, pos) => {
      if (node.isTextblock && node.textContent === "one") listItemEnd = pos + node.nodeSize - 1;
    });
    state = state.apply(state.tr.setSelection(TextSelection.create(state.doc, listItemEnd)));
    state = state.apply(state.tr.split(listItemEnd, 2).insertText("one and a half"));
    expectNumbersMatchFile(state.doc, source);
    expect(shown(state.doc, source).slice(3)).toEqual(["6 paragraph: one", "7 paragraph: one and a half", "8 paragraph: two", "10 paragraph: Last."]);
  });

  it("follow deleting a block and replacing the whole text, as an agent's change does", () => {
    const { doc, source } = parseMarkdown(TEXT);
    let state = EditorState.create({ doc });
    const listStart = endOfBlock(state.doc, 1) + 1;
    state = state.apply(state.tr.delete(listStart, listStart + state.doc.child(2).nodeSize));
    expect(shown(state.doc, source)).toEqual(["1 heading: Plan", "3 paragraph: We should hire", "4 paragraph: two people.", "6 paragraph: Last."]);
    expectNumbersMatchFile(state.doc, source);
    // An agent's change arrives as a new text: read afresh.
    const agentText = TEXT.replace("Last.", "Added by the agent.\n\nLast.");
    const fresh = parseMarkdown(agentText);
    expect(shown(fresh.doc, fresh.source).slice(-2)).toEqual(["9 paragraph: Added by the agent.", "11 paragraph: Last."]);
  });

  it("stay right through many random edits to a long document, and match a fresh reading of its file", () => {
    let { doc, source } = parseMarkdown(bigDocument(3));
    let state = EditorState.create({ doc, plugins: [history()] });
    let seed = 20261109;
    const rnd = () => {
      seed = (seed * 1103515245 + 12345) % 2147483648;
      return seed / 2147483648;
    };
    const textPositions = (d: Node) => {
      const out: number[] = [];
      d.descendants((node, pos) => {
        if (node.isTextblock) for (let i = 0; i <= node.content.size; i++) out.push(pos + 1 + i);
        return !node.isTextblock;
      });
      return out;
    };
    const pick = <T>(list: T[]) => list[Math.floor(rnd() * list.length)];
    const edits: ((s: EditorState) => Transaction | null)[] = [
      (s) => s.tr.insertText(pick(["x", " word"]), pick(textPositions(s.doc))),
      // A new line in a code block.
      (s) => {
        const at = pick(textPositions(s.doc));
        return s.doc.resolve(at).parent.type.name === "code_block" ? s.tr.insertText("\n", at) : null;
      },
      (s) => {
        const at = pick(textPositions(s.doc));
        return s.tr.delete(at, Math.min(s.doc.content.size, at + 1 + Math.floor(rnd() * 30)));
      },
      (s) => {
        const at = pick(textPositions(s.doc));
        const $at = s.doc.resolve(at);
        return $at.parent.type.name === "paragraph" && $at.depth === 1 ? s.tr.split(at) : null;
      },
      (s) => {
        const k = Math.floor(rnd() * s.doc.childCount);
        let from = 0;
        for (let i = 0; i < k; i++) from += s.doc.child(i).nodeSize;
        return s.tr.delete(from, from + s.doc.child(k).nodeSize);
      },
      (s) => s.tr.insert(0, schema.nodes.paragraph.create(null, schema.text("A new first paragraph."))),
    ];
    let compared = 0;
    for (let i = 0; i < 120; i++) {
      const which = Math.floor(rnd() * (edits.length + 1));
      if (which === edits.length) {
        undo(state, (tr) => (state = state.apply(tr)));
      } else {
        let tr: Transaction | null = null;
        try {
          tr = edits[which](state);
        } catch {
          tr = null; // not a place this edit can go
        }
        if (tr && tr.docChanged) state = state.apply(tr);
      }
      expectNumbersMatchFile(state.doc, source);
      if (expectSameAsFresh(state.doc, source)) compared++;
      else {
        // Some edits leave a document the file reads back a little differently
        // (a list's spacing, say): carry on from the file, as on reopening it.
        ({ doc, source } = parseMarkdown(serializeMarkdown(state.doc, source)));
        state = EditorState.create({ doc, plugins: [history()] });
      }
    }
    expect(compared).toBeGreaterThan(80);
  });
});

describe("Line numbers in a long document", () => {
  it("are worked out again in well under a millisecond or two after typing, reusing what didn't change", () => {
    const { doc, source } = parseMarkdown(bigDocument(30));
    let state = EditorState.create({ doc });
    blockStarts(state.doc, source); // the first time counts every block's lines
    let middle = 0;
    for (let k = 0, pos = 0; k < state.doc.childCount; pos += state.doc.child(k).nodeSize, k++) {
      if (k >= state.doc.childCount / 2 && state.doc.child(k).type.name === "paragraph") {
        middle = pos + state.doc.child(k).nodeSize - 1;
        break;
      }
    }
    const times: number[] = [];
    for (const ch of "typing in the middle") {
      state = state.apply(state.tr.insertText(ch, middle));
      middle++;
      const start = performance.now();
      lineMarks(state.doc, source);
      times.push(performance.now() - start);
    }
    times.sort((a, b) => a - b);
    expect(times[Math.floor(times.length / 2)]).toBeLessThan(5);
  });
});

describe("The Markdown view's numbers", () => {
  it("are one per line, unless the text has an old Mac line ending", () => {
    expect(textAreaLineNumbers("a\nb\r\nc")).toBeNull();
    expect(textAreaLineNumbers("a\rb\nc\r\rd")).toEqual([1, null, 2, null, null]);
  });
});
