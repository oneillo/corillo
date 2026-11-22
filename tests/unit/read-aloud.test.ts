// Read Aloud (roadmap Batch 14, item 4): what it reads. The words as the page
// shows them, sentence by sentence, from the cursor to the end or only the
// words selected: no Markdown marks, comments left out, a link read as its
// words, a picture by its description. The speech itself is checked end to
// end (tests/e2e/read-aloud.spec.ts), through a recorder, never aloud.
import { describe, expect, it } from "vitest";
import { parseMarkdown } from "../../src/core/markdown";
import { hasSpokenWords, spokenSentences } from "../../src/core/spoken-text";
import { bigDocument } from "../fixtures/big-document";

const doc = (text: string) => parseMarkdown(text).doc;
const said = (text: string, from?: { cursor: number } | { from: number; to: number }) => spokenSentences(doc(text), from).sentences.map((s) => s.text);

/** The document position just before these words. */
function at(text: string, words: string): number {
  const d = doc(text);
  let found = -1;
  d.descendants((node, pos) => {
    if (found >= 0 || !node.isText) return found < 0;
    const i = node.text!.indexOf(words);
    if (i >= 0) found = pos + i;
    return false;
  });
  if (found < 0) throw new Error(`no "${words}"`);
  return found;
}

describe("Read Aloud: what it reads", () => {
  it("reads the document sentence by sentence, in order, a heading as one", () => {
    expect(said("# The plan\n\nWe hire two people. They start in June! Is that soon?\n\nThe budget holds.\n")).toEqual([
      "The plan",
      "We hire two people.",
      "They start in June!",
      "Is that soon?",
      "The budget holds.",
    ]);
  });

  it("reads the words, not the Markdown marks", () => {
    const text = "Some **bold** and _slanted_ words, `code` and ~~struck~~ ones.\n\n- a list item\n- [ ] a task\n\n> A quote.\n\n| Who | When |\n| --- | --- |\n| Ana | May |\n";
    const out = said(text);
    expect(out).toEqual(["Some bold and slanted words, code and struck ones.", "a list item", "a task", "A quote.", "Who", "When", "Ana", "May"]);
    for (const s of out) expect(s).not.toMatch(/[*_`~|>#[\]]/);
  });

  it("reads a link as its words and a picture by its description, and passes over a picture with none", () => {
    expect(said("See [the budget](https://example.com/b) and [[Team notes|the notes]].\n\n![A chart of costs](chart.png)\n\n![](plain.png)\n\nThe end.\n")).toEqual([
      "See the budget and the notes.",
      "A chart of costs",
      "The end.",
    ]);
  });

  it("leaves out comments of both kinds, link definitions and the document details", () => {
    const text = "---\ntitle: Plan\n---\n\nFirst part. %%a note to self%% Second part.\n\n<!-- hidden from readers -->\n\nThird <!-- inline --> part.\n\n%%\nA whole hidden paragraph.\n%%\n\nSee [the site][s].\n\n[s]: https://example.com\n";
    const out = said(text);
    expect(out.join(" ")).not.toMatch(/note to self|hidden|title|example\.com|%%|<!--/);
    expect(out).toEqual(["First part.", "Second part.", "Third part.", "See the site."]);
  });

  it("leaves out Obsidian's faint marks: a highlight's ==, a tag's #, a callout's [!note]; a callout's title is a sentence of its own", () => {
    expect(said("A ==key point== for #team today.\n\n> [!note] What we ask\n> Approval to run a trial.\n")).toEqual([
      "A key point for team today.",
      "What we ask",
      "Approval to run a trial.",
    ]);
  });

  it("ends a sentence where the page breaks a line", () => {
    expect(said("Best,  \nAna\n")).toEqual(["Best,", "Ana"]);
  });

  it("leaves out code blocks and diagrams, which aren't read as sentences", () => {
    expect(said("Before.\n\n```js\nconst a = 1;\n```\n\n```mermaid\ngraph TD; A-->B\n```\n\nAfter.\n")).toEqual(["Before.", "After."]);
  });

  it("starts at the sentence the cursor is in, and reads to the end", () => {
    const text = "One here. Two here.\n\nThree here. Four here.\n";
    const { sentences, start } = spokenSentences(doc(text), { cursor: at(text, "here. Four") });
    expect(sentences.slice(start).map((s) => s.text)).toEqual(["Three here.", "Four here."]);
  });

  it("with the cursor just after a sentence, starts at the next", () => {
    const text = "One here. Two here.\n";
    const { sentences, start } = spokenSentences(doc(text), { cursor: at(text, " Two") });
    expect(sentences[start].text).toBe("Two here.");
  });

  it("with the cursor after the last words, reads from the top", () => {
    const text = "One here. Two here.\n";
    const d = doc(text);
    const { start } = spokenSentences(d, { cursor: d.content.size - 1 });
    expect(start).toBe(0);
  });

  it("with words selected, reads only those words", () => {
    const text = "One here. Two here. Three here.\n\nFour here.\n";
    const from = at(text, "here. Two");
    const to = at(text, " Three");
    expect(said(text, { from, to })).toEqual(["here.", "Two here."]);
    // Across paragraphs, each its own sentence.
    expect(said(text, { from: at(text, "Three"), to: at(text, "Four") + 4 })).toEqual(["Three here.", "Four"]);
  });

  it("knows where on the page each sentence and each of its letters is", () => {
    const text = "Plain **bold** end. Next one.\n";
    const d = doc(text);
    const [first, second] = spokenSentences(d).sentences;
    expect(d.textBetween(first.from, first.to)).toBe("Plain bold end.");
    expect(d.textBetween(second.from, second.to)).toBe("Next one.");
    // The letter "b" of "bold", for marking the word being said.
    const b = first.text.indexOf("bold");
    expect(d.textBetween(first.places[b], first.places[b + 4])).toBe("bold");
  });

  it("maps a sentence round a comment left out back to the page's words", () => {
    const text = "Start %%skip this%% finish.\n";
    const d = doc(text);
    const [only] = spokenSentences(d).sentences;
    expect(only.text).toBe("Start finish.");
    const f = only.text.indexOf("finish");
    expect(d.textBetween(only.places[f], only.places[f + 6])).toBe("finish");
  });

  it("keeps its place past an emoji in a picture's description: the word being said is the one marked (B14-06)", () => {
    const d = doc("Look ![A 😀 chart](x.png) here. Then more words.\n");
    const { sentences } = spokenSentences(d);
    expect(sentences.map((s) => s.text)).toEqual(["Look A 😀 chart here.", "Then more words."]);
    for (const s of sentences) {
      expect(s.places).toHaveLength(s.text.length + 1);
      expect(s.places.every((p) => Number.isInteger(p))).toBe(true);
    }
    const last = sentences[1];
    const m = last.text.indexOf("more");
    expect(d.textBetween(last.places[m], last.places[m + 4])).toBe("more");
  });

  it("tells cheaply whether there's anything to read, as the sentences would: code and diagrams aren't (B14-10)", () => {
    for (const text of ["", "```\nlet total = 1\n```\n", "```mermaid\ngraph TD; A-->B\n```\n", "---\ntitle: x\n---\n", "<div>html</div>\n"]) {
      expect(hasSpokenWords(doc(text)), text).toBe(false);
      expect(said(text), text).toEqual([]);
    }
    expect(hasSpokenWords(doc("```\nlet total = 1\n```\n\nThe end.\n"))).toBe(true);
    expect(hasSpokenWords(doc("![A chart](x.png)\n"))).toBe(true);
    const text = "```\nlet total = 1\n```\n\nThe end.\n";
    const end = at(text, "The end");
    expect(hasSpokenWords(doc(text), { from: 2, to: 6 })).toBe(false); // inside the code
    expect(hasSpokenWords(doc(text), { from: end, to: end + 3 })).toBe(true);
    expect(hasSpokenWords(doc(text), { from: end + 3, to: end + 4 })).toBe(false); // only a space
  });

  it("passes over a paragraph that is only an Obsidian %%comment%%, as it does other comments (roadmap Batch 15, item 4)", () => {
    for (const text of ["%%just a note to self%%\n", "%% one %% %% two %%\n", "**%%bold note%%**\n", "<!-- a note -->\n\n%%and another%%\n"]) {
      expect(hasSpokenWords(doc(text)), text).toBe(false);
      expect(said(text), text).toEqual([]);
    }
    // Words beside a comment, or in code that only looks like one, are still read.
    for (const [text, words] of [["%%a note%% The plan.\n", "The plan."], ["See `%%` here.\n", "See %% here."], ["%%open but never closed\n", "%%open but never closed"]]) {
      expect(hasSpokenWords(doc(text)), text).toBe(true);
      expect(said(text), text).toEqual([words]);
    }
    // With words selected: only a comment among them is nothing to read.
    const text = "%%a note%% The plan.\n";
    const plan = at(text, " The plan");
    expect(hasSpokenWords(doc(text), { from: 1, to: plan })).toBe(false);
    expect(hasSpokenWords(doc(text), { from: 1, to: plan + 4 })).toBe(true);
  });

  it("says nothing for a document with no words", () => {
    expect(said("")).toEqual([]);
    expect(said("---\ntitle: x\n---\n")).toEqual([]);
  });

  it("works out a long document's sentences quickly", () => {
    const text = bigDocument();
    const d = doc(text);
    const started = performance.now();
    const { sentences } = spokenSentences(d);
    const took = performance.now() - started;
    expect(sentences.length).toBeGreaterThan(100);
    expect(took).toBeLessThan(1000);
  });
});
