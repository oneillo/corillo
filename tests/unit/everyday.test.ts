// Find, the word count, and Markdown on the clipboard.
import { describe, expect, it } from "vitest";
import { EditorState, TextSelection, AllSelection } from "prosemirror-state";
import { parseMarkdown } from "../../src/core/markdown";
import { countLabel, findInDoc, findInText, matchFrom, nextMatch } from "../../src/core/search";
import { wordCountLabel } from "../../src/core/word-count";
import { wordCount, wordsBetween } from "../../src/core/words";
import { looksLikeMarkdown, sliceMarkdown } from "../../src/core/clipboard-text";

const doc = (markdown: string) => parseMarkdown(markdown).doc;
const found = (markdown: string, query: string, matchCase = false) => {
  const d = doc(markdown);
  return findInDoc(d, query, matchCase).map((m) => d.textBetween(m.from, m.to));
};

describe("finding text", () => {
  it("finds every match, ignoring capitals unless asked", () => {
    expect(findInText("Cat cat CAT", "cat", false)).toHaveLength(3);
    expect(findInText("Cat cat CAT", "cat", true)).toEqual([{ from: 4, to: 7 }]);
  });

  it("finds what was typed, even characters that mean something in a search pattern", () => {
    expect(findInText("Costs (in $) are 1.5*2", "(in $)", false)).toEqual([{ from: 6, to: 12 }]);
    expect(findInText("Costs (in $) are 1.5*2", "1.5*2", false)).toHaveLength(1);
    expect(findInText("a.b axb", "a.b", false)).toHaveLength(1);
  });

  it("treats straight and curly quotes as the same, as Word does", () => {
    const curly = String.fromCharCode(0x2019);
    expect(findInText(`don${curly}t and don't`, "don't", false)).toHaveLength(2);
    expect(findInText(`don${curly}t and don't`, `don${curly}t`, false)).toHaveLength(2);
  });

  it("finds nothing for an empty search", () => {
    expect(findInText("anything", "", false)).toEqual([]);
  });

  it("finds words in the document, across bold and links, but not across paragraphs", () => {
    expect(found("A **big** [red](https://x.com) door.\n", "big red")).toEqual(["big red"]);
    expect(found("Ends with red\n\ndoor starts this\n", "red door")).toEqual([]);
  });

  it("finds text in headings, lists and table cells", () => {
    expect(found("# Plan\n\n- the plan\n\n| plan | b |\n|---|---|\n| 1 | plan |\n", "plan")).toHaveLength(4);
  });

  it("never matches the Markdown signs, only the words", () => {
    expect(found("Some **bold** text\n", "**")).toEqual([]);
    expect(found("A [link](https://example.com)\n", "example")).toEqual([]);
  });

  it("keeps positions right after a picture or footnote marker", () => {
    expect(found("A ![chart](a.png) cat and a note[^1] cat.\n\n[^1]: The cat note.\n", "cat")).toEqual(["cat", "cat", "cat"]);
  });
});

describe("stepping through matches", () => {
  const matches = [
    { from: 2, to: 5 },
    { from: 10, to: 13 },
    { from: 20, to: 23 },
  ];

  it("goes to the next match after the cursor, and wraps round at the end", () => {
    expect(nextMatch(matches, 0, 0, 1)).toBe(0);
    expect(nextMatch(matches, 2, 2, 1)).toBe(0); // a match right at the cursor counts
    expect(nextMatch(matches, 2, 5, 1)).toBe(1); // with the match selected, go past it
    expect(nextMatch(matches, 20, 23, 1)).toBe(0);
  });

  it("goes back to the previous match, and wraps round at the start", () => {
    expect(nextMatch(matches, 10, 13, -1)).toBe(0);
    expect(nextMatch(matches, 2, 5, -1)).toBe(2);
    expect(nextMatch(matches, 30, 30, -1)).toBe(2);
  });

  it("starts from the first match at or after the cursor", () => {
    expect(matchFrom(matches, 6)).toBe(1);
    expect(matchFrom(matches, 25)).toBe(0);
    expect(matchFrom([], 0)).toBe(-1);
  });

  it("says how many matches there are, and which one is current", () => {
    expect(countLabel(0, -1)).toBe("No matches");
    expect(countLabel(1, -1)).toBe("1 match");
    expect(countLabel(12, -1)).toBe("12 matches");
    expect(countLabel(12, 2)).toBe("3 of 12");
    expect(countLabel(3000, 0)).toBe("1 of 3,000");
  });
});

describe("word count", () => {
  // Decided 2026-11-09 night: what Word would count in the exported file.
  // Document details, link definitions, hidden comments and Markdown's own
  // signs don't count; code does.
  it("counts the words Word would, not document details, definitions, comments or Markdown's signs", () => {
    const count = (text: string) => wordCount(parseMarkdown(text).doc);
    expect(count("---\ntitle: My plan\ntags: [a, b]\n---\n\nThree real words.\n")).toBe(3);
    expect(count("[ref]: https://example.com\n\nTwo words\n")).toBe(2);
    expect(count("Word[^1], next.\n\n[^1]: Note here.\n")).toBe(4);
    expect(count("Before <!-- hidden note --> after.\n\n<!-- a hidden block -->\n")).toBe(2);
    expect(count("Seen %%not seen%% words.\n\n%%\nhidden too\n%%\n")).toBe(2);
    expect(count("| a | b |\n|---|---|\n| <span>x</span> | y |\n")).toBe(4); // a table shown as Markdown text
    expect(count("```js\nconst x = 1;\n```\n\nTwo words\n")).toBe(6);
    expect(count("A picture ![chart](c.png) here.\n")).toBe(3);
  });

  it("counts a selection the same way, so all of it is all the words", () => {
    const text = "---\ntitle: x\n---\n\nWord[^1], next. %%hidden%%\n\n- one\n- two three\n\n[^1]: Note here.\n";
    const d = parseMarkdown(text).doc;
    expect(wordsBetween(d, 0, d.content.size)).toBe(wordCount(d));
    expect(wordCount(d)).toBe(7);
    const start = d.child(0).nodeSize + 1; // "Word[^1], next."
    expect(wordsBetween(d, start, start + 4)).toBe(1); // "Word"
  });

  it("never counts more words in a selection than the whole document has, even one cutting into a hidden comment", () => {
    for (const text of [
      "%%a b c d%% e\n",
      "One <!-- two three four --> five.\n",
      "| a | b |\n|---|---|\n| <span class=\"x y z\">w</span> | %%p q r%% s |\n",
      "- one %%two three%%\n- four <!-- five\n  six --> seven\n",
      "| a | %%b c%% |\n|---|---|\n| d | e |\n",
    ]) {
      const d = parseMarkdown(text).doc;
      const all = wordCount(d);
      expect(wordsBetween(d, 1, d.child(0).nodeSize - 1)).toBe(all); // all of the block's text, counted as a part
      for (let from = 0; from <= d.content.size; from++) {
        for (let to = from; to <= d.content.size; to++) {
          const n = wordsBetween(d, from, to);
          if (n > all) throw new Error(`${JSON.stringify(text)}: ${from}..${to} counts ${n}, the document ${all}`);
        }
      }
    }
  });

  it("says how many words are selected out of the whole document", () => {
    expect(wordCountLabel(2340, null)).toBe("2,340 words");
    expect(wordCountLabel(2340, 120)).toBe("120 of 2,340 words");
    expect(wordCountLabel(1, null)).toBe("1 word");
    expect(wordCountLabel(5, 0)).toBe("5 words");
  });
});

describe("telling whether pasted text is Markdown", () => {
  it.each([
    ["a heading", "# Plan"],
    ["a bulleted list", "Intro\n- one\n- two"],
    ["a numbered list", "1. one\n2. two"],
    ["a quote", "> quoted"],
    ["a code block", "```\ncode\n```"],
    ["a table", "| a | b |\n|---|---|\n| 1 | 2 |"],
    ["bold", "Some **bold** words"],
    ["italic", "Some *italic* words"],
    ["a link", "See [the plan](https://example.com)"],
    ["inline code", "Run `npm test` now"],
    ["strikethrough", "This is ~~gone~~"],
  ])("recognises %s", (_name, text) => {
    expect(looksLikeMarkdown(text)).toBe(true);
  });

  it.each([
    ["an ordinary sentence", "Just a sentence, nothing more."],
    ["sums with stars", "3 * 4 = 12 and 5 * 6 = 30"],
    ["a hashtag", "#launch day is here"],
    ["a dash in a sentence", "Costs - mostly travel - went up"],
    ["an address on its own", "https://example.com/page"],
  ])("leaves %s alone", (_name, text) => {
    expect(looksLikeMarkdown(text)).toBe(false);
  });
});

describe("copying as Markdown", () => {
  const copied = (markdown: string, pick: (state: EditorState) => EditorState) => {
    const state = pick(EditorState.create({ doc: doc(markdown) }));
    return sliceMarkdown(state.selection.content());
  };
  // Select from the start of one piece of text to the end of another.
  const between = (from: string, to: string) => (state: EditorState) => {
    let a = 0;
    let b = 0;
    state.doc.descendants((node, pos) => {
      if (!node.isText) return true;
      const i = node.text!.indexOf(from);
      const j = node.text!.indexOf(to);
      if (i >= 0 && !a) a = pos + i;
      if (j >= 0) b = pos + j + to.length;
      return false;
    });
    return state.apply(state.tr.setSelection(TextSelection.create(state.doc, a, b)));
  };

  it("copies a few words with just their formatting", () => {
    expect(copied("# Title with **bold** words\n", between("Title", "bold"))).toBe("Title with **bold**");
  });

  it("copies whole blocks as Markdown", () => {
    const all = (state: EditorState) => state.apply(state.tr.setSelection(new AllSelection(state.doc)));
    expect(copied("# Title\n\nA [link](https://example.com).\n", all)).toBe("# Title\n\nA [link](https://example.com).");
  });

  it("copies list items as a list of the same kind", () => {
    expect(copied("1. first\n2. second\n3. third\n", between("first", "second"))).toBe("1. first\n2. second");
  });

  it("copies the text of a code block as it is", () => {
    expect(copied("```\nconst a = **b**;\n```\n", between("const", "b**"))).toBe("const a = **b**");
  });
});
