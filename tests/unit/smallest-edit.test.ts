// An agent's change, or another app's, arrives on an open document as an edit
// (roadmap Batch 7, item 1): only the blocks that changed are replaced, the
// others are the very same blocks the page already shows, and the file is
// still written back byte for byte. When that can't be done exactly, there's
// no edit, and the page is read again as before.
import { describe, expect, it } from "vitest";
import { Transform } from "prosemirror-transform";
import type { Node } from "prosemirror-model";
import { parseMarkdown, serializeMarkdown, type Loaded } from "../../src/core/markdown";
import { applyTextChanges, changedRuns, editTo, textChanges } from "../../src/core/smallest-edit";
import { bigDocument } from "../fixtures/big-document";

const children = (doc: Node) => Array.from({ length: doc.childCount }, (_, i) => doc.child(i));

/** The edit from one text to another, as the page would make it: the document read from `before`, brought to `after`. */
function edit(before: string, after: string) {
  const was = parseMarkdown(before);
  const tr = new Transform(was.doc);
  const next = parseMarkdown(after);
  const result = editTo(tr, next, after);
  return { was, tr, next, result };
}

/** The edit was made exactly: the page reads as the new text does, and writes it back byte for byte. */
function exact(r: ReturnType<typeof edit>, after: string) {
  expect(r.result).not.toBeNull();
  expect(r.tr.doc.eq(r.next.doc)).toBe(true);
  expect(serializeMarkdown(r.tr.doc, r.result!.source)).toBe(after);
}

const PLAN = ["# Plan", "We should hire two people this quarter.", "## Budget", "The budget is tight.", "## Risks", "Hiring takes long."].join("\n\n") + "\n";

describe("an agent's change as an edit", () => {
  it("changes only the words that changed: every other block is the very same", () => {
    const after = PLAN.replace("two people", "three people");
    const r = edit(PLAN, after);
    exact(r, after);
    const was = children(r.was.doc);
    const now = children(r.tr.doc);
    expect(now).toHaveLength(was.length);
    now.forEach((node, i) => {
      if (i === 1) expect(node).not.toBe(was[i]);
      else expect(node).toBe(was[i]);
    });
    // Only "two" became "three" ("wo" "hree", as it happens): the words around it, and the cursor in them, stay put.
    expect(r.result!.changed).toHaveLength(1);
    const { from, to } = r.result!.changed[0];
    expect(r.was.doc.textBetween(from, to)).toBe("wo");
  });

  it("keeps the blocks between two changes far apart, and says where each change was", () => {
    const paras = Array.from({ length: 40 }, (_, i) => `Paragraph ${i + 1} says something of its own.`);
    const before = paras.join("\n\n") + "\n";
    const after = paras.map((p, i) => (i === 2 ? "A new third paragraph." : i === 37 ? p.replace("own", "own, and more") : p)).join("\n\n") + "\n";
    const r = edit(before, after);
    exact(r, after);
    expect(r.result!.changed).toHaveLength(2);
    const was = children(r.was.doc);
    const now = children(r.tr.doc);
    for (let i = 0; i < now.length; i++) if (i !== 2 && i !== 37) expect(now[i]).toBe(was[i]);
    expect(r.result!.changed[0].from).toBeLessThan(r.result!.changed[1].from);
  });

  it("replaces whole blocks when a paragraph is rewritten and another added beside it", () => {
    const before = "One.\n\nTwo is here.\n\nThree.\n";
    const after = "One.\n\nAn added paragraph.\n\nTwo, said again.\n\nThree.\n";
    const r = edit(before, after);
    exact(r, after);
    const [change] = r.result!.changed;
    // The rewritten paragraph, whole: from just before it to just after it.
    expect(r.was.doc.resolve(change.from).depth).toBe(0);
    expect(r.was.doc.slice(change.from, change.to).content.textBetween(0, change.to - change.from)).toBe("Two is here.");
    expect(r.tr.doc.child(0)).toBe(r.was.doc.child(0));
    expect(r.tr.doc.lastChild).toBe(r.was.doc.lastChild);
  });

  it("puts in and takes out blocks, at the start, the end and in between", () => {
    const cases: [string, string][] = [
      [PLAN, "# A title above\n\n" + PLAN],
      [PLAN, PLAN + "\nA last paragraph.\n"],
      [PLAN, PLAN.replace("## Budget\n\nThe budget is tight.\n\n", "")],
      [PLAN, PLAN.replace("## Risks\n\nHiring takes long.\n", "")],
      [PLAN, "Everything else went.\n"],
      [PLAN, ""],
      ["", PLAN],
      ["\n\n\nText\n", "Text\n"],
      ["Text\n", "\n\n\nText\n"],
    ];
    for (const [before, after] of cases) exact(edit(before, after), after);
  });

  it("writes unedited blocks back as the file had them, byte for byte, through the edit and the person's typing after it", () => {
    const before =
      "Title\r\n=====\r\n\r\n*Emphasis* and __strong__ here.\r\n\r\n+ one\r\n+ two\r\n\r\n\r\n\r\nA paragraph to change.\r\n\r\n| a | b |\r\n|:--|--:|\r\n| x \\| y | 2 |\r\n";
    const after = before.replace("to change", "that changed");
    const r = edit(before, after);
    exact(r, after);
    // The person then types in the changed paragraph: everything else is still as the file had it.
    const at = r.tr.doc.textContent.indexOf("that changed");
    let pos = -1;
    r.tr.doc.descendants((node, p) => {
      if (pos < 0 && node.isText && node.text!.includes("that changed")) pos = p + node.text!.indexOf("that changed");
    });
    expect(at).toBeGreaterThan(0);
    const typed = new Transform(r.tr.doc).insert(pos, r.tr.doc.type.schema.text("X"));
    expect(serializeMarkdown(typed.doc, r.result!.source)).toBe(after.replace("that changed", "Xthat changed"));
  });

  it("changes nothing on the page when only how the file writes it changed, and writes it the new way", () => {
    const before = "Some words here.  \n\n- a\n- b\n";
    const after = "Some words here.\r\n\r\n\r\n- a\r\n- b\r\n".replace("\r\n\r\n\r\n", "\r\n\r\n");
    const r = edit(before, after);
    exact(r, after);
    expect(r.tr.steps).toHaveLength(0);
    expect(r.result!.changed).toEqual([]);
  });

  it("treats a block with the same words but new formatting as changed", () => {
    const before = "Plain words here.\n\nMore.\n";
    const after = "Plain **words** here.\n\nMore.\n";
    const r = edit(before, after);
    exact(r, after);
    expect(r.result!.changed).toHaveLength(1);
    expect(r.tr.doc.child(1)).toBe(r.was.doc.child(1));
  });

  it("is exact on documents of every kind, changed in every block", () => {
    const docs = [
      "---\ntitle: x\n---\n\n# H\n\nBody text here.\n",
      "Text[^n] and more[^m].\n\n[^n]: First note.\n[^m]: Second note.\n",
      "See [the site][site] and [other].\n\n[site]: https://example.com\n[other]: https://o.example\n",
      "```mermaid\ngraph TD\n  A-->B\n```\n\nText after.\n",
      "- [ ] task one\n- [x] task two\n\n1. first\n2. second\n",
      "> A quote\n> over lines\n\n> [!note] Callout\n> inside it\n",
      "| a | b |\n|---|---|\n| 1 | 2 |\n| 3 | 4 |\n\nAfter the table.\n",
      "Line one\nline two\n\n\n\nAfter empty lines.\n\n    indented code\n",
      "<div>\nraw html\n</div>\n\nText ==highlight== and [[Note]] and %%hidden%%.\n",
      "# T\r\rText\rmore\r",
      "﻿# With a mark\r\n\r\nText\r\n",
    ];
    for (const doc of docs) {
      // Each word changed in turn, wherever it is: in a note, a cell, a task, the front matter.
      const words = [...new Set(doc.match(/[A-Za-z]{3,}/g) ?? [])];
      for (const word of words) {
        const after = doc.replace(word, `${word}X`);
        exact(edit(doc, after), after);
      }
      // And from each to the next.
      const r = edit(doc, PLAN);
      exact(r, PLAN);
    }
  });

  it("is quick on a long document: a word changed in a 30,000-word document", () => {
    const long = bigDocument();
    const after = long.replace("### 20.2 ", "### 20.2 Agent ");
    const was = parseMarkdown(long);
    const next = parseMarkdown(after);
    let best = Infinity;
    for (let i = 0; i < 5; i++) {
      const tr = new Transform(was.doc);
      const start = performance.now();
      const result = editTo(tr, next, after);
      best = Math.min(best, performance.now() - start);
      expect(result).not.toBeNull();
      expect(result!.changed).toHaveLength(1);
    }
    console.log(`An edit to the 30,000-word document: ${best.toFixed(1)} ms`);
    expect(best).toBeLessThan(50);
  });
});

describe("when the edit can't be made exactly", () => {
  it("gives nothing when the text doesn't read as the document it was read into", () => {
    const after = PLAN.replace("two", "three");
    const was = parseMarkdown(PLAN);
    const tr = new Transform(was.doc);
    // Read from one text, asked for another.
    expect(editTo(tr, parseMarkdown(after), after.replace("three", "four"))).toBeNull();
  });

  it("gives nothing when what was read doesn't match its blocks", () => {
    const after = PLAN.replace("two", "three");
    const next = parseMarkdown(after);
    const broken: Loaded = { doc: next.doc, source: { ...next.source, blocks: next.source.blocks.slice(1) } };
    expect(editTo(new Transform(parseMarkdown(PLAN).doc), broken, after)).toBeNull();
  });

  it("gives nothing when the document can't be brought there", () => {
    const after = PLAN.replace("two", "three");
    const next = parseMarkdown(after);
    // A document that isn't one the schema allows (a heading holding a heading).
    const odd = next.doc.type.create(null, [next.doc.type.schema.nodes.paragraph.create(null, next.doc.type.schema.text("x"))]);
    const wrong: Loaded = { doc: odd, source: next.source };
    expect(editTo(new Transform(parseMarkdown(PLAN).doc), wrong, after)).toBeNull();
  });
});

describe("which blocks changed", () => {
  const doc = (text: string) => parseMarkdown(text).doc;

  it("none for the same document", () => {
    expect(changedRuns(doc(PLAN), doc(PLAN))).toEqual([]);
  });

  it("one run for one change, two for two far apart", () => {
    const paras = Array.from({ length: 30 }, (_, i) => `Paragraph ${i}.`);
    const before = doc(paras.join("\n\n"));
    expect(changedRuns(before, doc(paras.map((p, i) => (i === 10 ? "Changed." : p)).join("\n\n")))).toEqual([{ fromA: 10, toA: 11, fromB: 10, toB: 11 }]);
    expect(changedRuns(before, doc(paras.map((p, i) => (i === 1 || i === 28 ? "Changed." : p)).join("\n\n")))).toEqual([
      { fromA: 1, toA: 2, fromB: 1, toB: 2 },
      { fromA: 28, toA: 29, fromB: 28, toB: 29 },
    ]);
  });

  it("a block put in, and one taken out", () => {
    expect(changedRuns(doc("A.\n\nB.\n"), doc("A.\n\nNew.\n\nB.\n"))).toEqual([{ fromA: 1, toA: 1, fromB: 1, toB: 2 }]);
    expect(changedRuns(doc("A.\n\nGone.\n\nB.\n"), doc("A.\n\nB.\n"))).toEqual([{ fromA: 1, toA: 2, fromB: 1, toB: 1 }]);
  });
});

describe("the Markdown text's changes", () => {
  const cases: [string, string][] = [
    ["a\nb\nc", "a\nB\nc"],
    ["a\nb", "a"],
    ["a", "a\nb"],
    ["a\nb\n", "a\nb\nc\n"],
    ["a\nb\nc\n", "a\nc\n"],
    ["", "x"],
    ["x", ""],
    ["\n", ""],
    ["", "\n\n"],
    ["one\n\ntwo\n", "zero\n\none\n\ntwo\n"],
    ["same\nsame\nsame\n", "same\nsame\n"],
    ["ab", "a"],
    ["a\n\nb", "a\n\n\nb"],
  ];

  it("turn the text into the new one", () => {
    for (const [before, after] of cases) expect(applyTextChanges(before, textChanges(before, after))).toBe(after);
  });

  it("are as small as the change: only the words that changed, in each line that did", () => {
    const lines = Array.from({ length: 50 }, (_, i) => `Line ${i} of the text.`);
    const before = lines.join("\n");
    const after = lines.map((l, i) => (i === 3 ? l.replace("text", "page") : i === 45 ? l.replace("Line", "Row") : l)).join("\n");
    const changes = textChanges(before, after);
    expect(changes).toEqual([
      { from: before.indexOf("text", before.indexOf("Line 3 ")), to: before.indexOf("text", before.indexOf("Line 3 ")) + 4, insert: "page" },
      { from: before.indexOf("Line 45"), to: before.indexOf("Line 45") + 4, insert: "Row" },
    ]);
    expect(textChanges(before, before)).toEqual([]);
  });

  it("turn random texts into each other", () => {
    let seed = 7;
    const random = () => (seed = (seed * 1103515245 + 12345) % 2147483648) / 2147483648;
    const text = () => Array.from({ length: Math.floor(random() * 12) }, () => ["a", "b", "\n", "c", "\n\n", "ab"][Math.floor(random() * 6)]).join("");
    for (let i = 0; i < 2000; i++) {
      const before = text();
      const after = text();
      const changes = textChanges(before, after);
      expect(applyTextChanges(before, changes)).toBe(after);
      for (let k = 1; k < changes.length; k++) expect(changes[k].from).toBeGreaterThanOrEqual(changes[k - 1].to);
      for (const c of changes) expect(c.from).toBeLessThanOrEqual(c.to);
    }
  });
});
