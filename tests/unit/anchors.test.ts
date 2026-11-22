import { describe, expect, it } from "vitest";
import type { Node } from "prosemirror-model";
import { parseMarkdown } from "../../src/core/markdown";
import { anchorFor, anchorIn, findAnchor, looseText, offsetAt, textIndex } from "../../src/core/anchors";
import { bigDocument } from "../fixtures/big-document";

const docOf = (md: string) => parseMarkdown(md).doc;

/** The range of the n-th occurrence of some text. */
function rangeOf(doc: Node, find: string, nth = 0): { from: number; to: number } {
  const hits: number[] = [];
  doc.descendants((node, pos) => {
    if (node.isText) {
      let i = node.text!.indexOf(find);
      while (i >= 0) {
        hits.push(pos + i);
        i = node.text!.indexOf(find, i + 1);
      }
    }
  });
  return { from: hits[nth], to: hits[nth] + find.length };
}

const textIn = (doc: Node, r: { from: number; to: number } | null) => (r ? doc.textBetween(r.from, r.to, "\n") : null);

describe("finding a comment's text again", () => {
  const md = "# Plan\n\nWe should *hire* two people.\n\n- Budget is tight\n- We should hire later\n";

  it("remembers the quoted text and the text around it", () => {
    const doc = docOf(md);
    const r = rangeOf(doc, "hire");
    const a = anchorFor(doc, r.from, r.to);
    expect(a.quote).toBe("hire");
    expect(a.prefix.endsWith("We should ")).toBe(true);
    expect(a.suffix.startsWith(" two people.")).toBe(true);
    expect(textIndex(doc).text).toBe("Plan\nWe should hire two people.\nBudget is tight\nWe should hire later");
  });

  it("finds the same place in an unchanged document, even when the words repeat", () => {
    const doc = docOf(md);
    for (const nth of [0, 1]) {
      const r = rangeOf(doc, "hire", nth);
      expect(findAnchor(doc, anchorFor(doc, r.from, r.to))).toEqual(r);
    }
  });

  it("follows the text when other text is added before it", () => {
    const doc = docOf(md);
    const r = rangeOf(doc, "Budget is tight");
    const anchor = anchorFor(doc, r.from, r.to);
    const changed = docOf("# Plan\n\nIntro added by an agent.\n\n" + md.slice(8));
    expect(textIn(changed, findAnchor(changed, anchor))).toBe("Budget is tight");
  });

  it("finds a comment across formatting and across paragraphs", () => {
    const doc = docOf(md);
    const from = rangeOf(doc, "should").from;
    const to = rangeOf(doc, "Budget").to;
    const anchor = anchorFor(doc, from, to);
    expect(anchor.quote).toBe("should hire two people.\nBudget");
    expect(findAnchor(doc, anchor)).toEqual({ from, to });
  });

  it("when the commented words were rewritten, finds where they were by the words around them", () => {
    const doc = docOf("Intro.\n\nThe launch date is March 3 for everyone involved.\n");
    const r = rangeOf(doc, "March 3");
    const anchor = anchorFor(doc, r.from, r.to);
    const changed = docOf("Intro.\n\nThe launch date is April 14 for everyone involved.\n");
    expect(textIn(changed, findAnchor(changed, anchor))).toBe("April 14");
  });

  it("gives up when the text and everything around it is gone", () => {
    const doc = docOf("Intro.\n\nA sentence that will be removed entirely.\n");
    const r = rangeOf(doc, "will be removed");
    const anchor = anchorFor(doc, r.from, r.to);
    expect(findAnchor(docOf("Something completely different.\n"), anchor)).toBeNull();
  });

  describe("when an agent changed the commented words and the same words are elsewhere", () => {
    const plan = [
      "# Plan",
      "Our customers in the north region asked for faster delivery this year.",
      "The south region is different. There, customers care most about price, and we should say so.",
      "Finally, customers everywhere want clearer invoices.",
    ].join("\n\n") + "\n";
    const anchorOn = (md: string, find: string, nth = 0) => {
      const doc = docOf(md);
      const r = rangeOf(doc, find, nth);
      return anchorFor(doc, r.from, r.to);
    };
    /** The paragraph a range is in, by its first words. */
    const paragraphOf = (doc: Node, r: { from: number; to: number } | null) => (r ? doc.resolve(r.from).parent.textContent.slice(0, 12) : null);

    it("stays on the new words, not on the next place the old words appear", () => {
      const anchor = anchorOn(plan, "customers");
      const changed = docOf(plan.replace("Our customers in the north", "Our clients in the north"));
      expect(textIn(changed, findAnchor(changed, anchor))).toBe("clients");
    });

    it("with the whole sentence rewritten, is on the new sentence or lets go, never on another paragraph", () => {
      const anchor = anchorOn(plan, "customers");
      const changed = docOf(plan.replace("Our customers in the north region asked for faster delivery this year.", "People in the north told us delivery is too slow."));
      const found = findAnchor(changed, anchor);
      expect(found === null || paragraphOf(changed, found) === "People in th").toBe(true);
    });

    it("a phrase changed where it's repeated later stays where it was", () => {
      const md = "We will ship in Q3.\n\nRisks: the vendor may slip.\n\nBudget: see table.\n\nWe will ship in Q3 if the vendor delivers.\n";
      const anchor = anchorOn(md, "ship in Q3");
      const changed = docOf(md.replace("We will ship in Q3.", "We will ship in early Q4."));
      const found = findAnchor(changed, anchor);
      expect(found === null || paragraphOf(changed, found) === "We will ship").toBe(true);
      expect(textIn(changed, found)).not.toBe("ship in Q3");
    });

    it("with its words deleted, lets go rather than move to the same words elsewhere", () => {
      const anchor = anchorOn(plan, "customers");
      const changed = docOf(plan.replace("Our customers in the north", "Our in the north"));
      expect(findAnchor(changed, anchor)).toBeNull();
    });

    // Found by the comment-following fuzzer: the words that were before it are in one paragraph now, those after it in the next.
    it("with its paragraph deleted, never stretches across other paragraphs to where the words around it are now", () => {
      const paragraphs = ["Intro.", "Money is short, so next quarter we review the report every month as it goes out.", "Next, next quarter we review the plan.", "The figures every month as it goes out are late."];
      const anchor = anchorOn(paragraphs.join("\n\n") + "\n", "the report");
      const changed = docOf([paragraphs[0], paragraphs[2], paragraphs[3]].join("\n\n") + "\n");
      expect(findAnchor(changed, anchor)).toBeNull();
    });

    it("keeps to its words when only the words around them changed", () => {
      const anchor = anchorOn(plan, "customers");
      const changed = docOf(plan.replace("Our customers in the north", "All of our customers, across the north"));
      const found = findAnchor(changed, anchor);
      expect(textIn(changed, found)).toBe("customers");
      expect(paragraphOf(changed, found)).toBe("All of our c");
    });

    it("on the second of three, follows that one's change", () => {
      const anchor = anchorOn(plan, "customers", 1);
      const changed = docOf(plan.replace("There, customers care", "There, buyers care"));
      expect(textIn(changed, findAnchor(changed, anchor))).toBe("buyers");
    });

    // R-AG-1: a few common words agreeing around the same words elsewhere (" the ", "will ... in") is what chance gives.
    it("with its sentence rewritten, never moves to the same words in another sentence that share only common words around them", () => {
      const cases: [string, string, string, string][] = [
        ["Intro.\n\nThe report goes to the board today for review.\n\nNext, the board meets in May.\n", "board", "The report goes to the board today for review.", "The report is sent to directors this week."],
        ["Summary first.\n\nWe will hire two people in spring if the budget allows.\n\nLater we will hire two people in autumn.\n", "hire two people", "We will hire two people in spring if the budget allows.", "Hiring waits until the budget is final."],
        ["Plan.\n\nNow we will hire two people in spring.\n\nLater we will hire two people in autumn.\n", "hire two people", "Now we will hire two people in spring.", "Hiring waits for now."],
        ["Notes.\n\nThe members of the board in the room agreed.\n\nThe head of the board in the end said no.\n", "board", "The members of the board in the room agreed.", "Everyone present agreed."],
      ];
      for (const [md, quote, sentence, rewritten] of cases) {
        const anchor = anchorOn(md, quote);
        const changed = docOf(md.replace(sentence, rewritten));
        const found = findAnchor(changed, anchor);
        expect(found === null || paragraphOf(changed, found) === rewritten.slice(0, 12), `${quote}: ${textIn(changed, found)} in "${paragraphOf(changed, found)}"`).toBe(true);
      }
    });
  });

  // The window knows which text was just put in (pasted, dropped, typed in the Markdown view): a comment's
  // words cut and put back somewhere else are found there, however little of the text around them came along.
  describe("when its words were cut and put back somewhere else", () => {
    const md = "# Plan\n\nWe need two people this spring.\n\nThe budget is tight.\n\nWe start in May.\n";
    const cut = (doc: Node) => anchorFor(doc, rangeOf(doc, "two people").from, rangeOf(doc, "two people").to);
    /** The document with "two people this" moved, and the stretch that came in. */
    const moved = (to: string) => {
      const doc = docOf(to);
      const r = rangeOf(doc, "two people this");
      return { doc, putIn: [r] };
    };

    it("finds them in the text put in: pasted after other words, or dropped against another word", () => {
      const anchor = cut(docOf(md));
      for (const to of [
        "# Plan\n\nWe need  spring.\n\nThe budget is tight.\n\nWe start in May. Then two people this\n",
        "# Plan\n\nWe need  spring.\n\nThe two people thisbudget is tight.\n\nWe start in May.\n",
      ]) {
        const { doc, putIn } = moved(to);
        expect(findAnchor(doc, anchor), to).toBeNull();
        const found = findAnchor(doc, anchor, textIndex(doc), putIn);
        expect(found, to).toEqual({ from: putIn[0].from, to: putIn[0].from + "two people".length });
      }
    });

    it("keeps to its words where they still are, and never takes text put in that doesn't hold them", () => {
      const doc = docOf(md);
      const anchor = cut(doc);
      // The same words pasted again elsewhere: the comment stays on its own.
      const copied = docOf(md.replace("We start in May.", "We start in May. Then two people this"));
      const pasted = rangeOf(copied, "two people this", 1);
      expect(findAnchor(copied, anchor, textIndex(copied), [pasted])).toEqual(rangeOf(copied, "two people"));
      // Text put in that holds only part of the words.
      const part = docOf("# Plan\n\nWe need  spring.\n\nThe budget is tight.\n\nWe start in May. Then two people\n");
      const r = rangeOf(part, "Then two");
      expect(findAnchor(part, anchor, textIndex(part), [r])).toBeNull();
    });
  });

  describe("when the words around a comment changed but its words are still there", () => {
    const paragraphOf = (doc: Node, r: { from: number; to: number } | null) => (r ? doc.resolve(r.from).parent.textContent.slice(0, 12) : null);
    // R-AG-2: found before tonight; the agreement bar must not drop words written exactly once.
    it("finds a whole paragraph written once, after the paragraphs either side were rewritten and text was added above", () => {
      const quote = "This whole paragraph is what the comment is on, a long sentence.";
      const md = "Old first paragraph ends here.\n\n" + quote + "\n\nOld third paragraph starts here.\n";
      const doc = docOf(md);
      const anchor = anchorFor(doc, rangeOf(doc, quote).from, rangeOf(doc, quote).to);
      const changed = docOf(
        "# A new heading\n\nSome inserted text that pushes things along by a good number of characters.\n\nFirst paragraph rewritten totally!\n\n" +
          quote +
          "\n\nThird paragraph rewritten as well.\n",
      );
      expect(textIn(changed, findAnchor(changed, anchor))).toBe(quote);
    });

    it("finds a phrase of several words written once, moved down, with the words either side changed", () => {
      const doc = docOf("Intro paragraph about things.\n\nThe quick brown fox jumps over the lazy dog.\n\nClosing words here.\n");
      const r = rangeOf(doc, "quick brown fox jumps");
      const anchor = anchorFor(doc, r.from, r.to);
      const changed = docOf(
        "A brand new opening paragraph that the agent wrote, long enough to move everything down a fair bit.\n\nIntro paragraph about stuff.\n\nA quick brown fox jumps beneath the lazy dog.\n\nClosing words here.\n",
      );
      expect(textIn(changed, findAnchor(changed, anchor))).toBe("quick brown fox jumps");
    });

    it("follows a short comment in a paragraph moved far down whole, at the paragraph's start, middle and end", () => {
      const para = "Budget owners review the forecast every month before the board meeting.";
      const md = `Opening words.\n\n${para}\n\nClosing words.\n`;
      const moved = docOf(`Opening words, rewritten.\n\n${"A new paragraph added above it, long enough to move it well down. ".repeat(3)}\n\n${para}\n\nClosing words, rewritten.\n`);
      for (const quote of ["Budget", "forecast", "meeting"]) {
        const doc = docOf(md);
        const r = rangeOf(doc, quote);
        const found = findAnchor(moved, anchorFor(doc, r.from, r.to));
        expect(textIn(moved, found), quote).toBe(quote);
        expect(paragraphOf(moved, found), quote).toBe(para.slice(0, 12));
      }
    });
  });

  it("looks for many comments whose words are gone quickly, in a long document", () => {
    // Each one used to read the whole document again loosely: 5 ms apiece on 30,000 words.
    const doc = docOf(bigDocument());
    const index = textIndex(doc);
    const gone = Array.from({ length: 100 }, (_, i) => ({
      quote: `words that were rewritten number ${i}`,
      prefix: `some old text before number ${i} `,
      suffix: ` and old text after number ${i}`,
      offset: i * 1000,
    }));
    findAnchor(doc, gone[0], index);
    // Compared with reading the document loosely once, so a busy Mac doesn't decide; each the best of three,
    // so a pause that hits one and not the other doesn't either.
    const best = (work: () => void) => {
      let fastest = Infinity;
      for (let i = 0; i < 3; i++) {
        const start = performance.now();
        work();
        fastest = Math.min(fastest, performance.now() - start);
      }
      return fastest;
    };
    const once = best(() => looseText(index.text));
    const all = best(() => {
      for (const a of gone) expect(findAnchor(doc, a, index)).toBeNull();
    });
    expect(all).toBeLessThan(Math.max(5 * once, 20));
    // Without an index given, it still works.
    const texts: number[] = [];
    doc.descendants((node, pos) => {
      if (node.isText && node.text!.length > 20) texts.push(pos);
    });
    const r = { from: texts[500] + 3, to: texts[500] + 15 };
    expect(findAnchor(doc, anchorFor(doc, r.from, r.to))).toEqual(r);
  });

  it("finds many comments whose words are where they say quickly, in a long document, each on its own words", () => {
    // As after an agent's edit, which carries every comment's place: the words written many times over
    // (a few common words) used to be weighed one by one, 125 ms for 150 comments on 30,000 words.
    const doc = docOf(bigDocument());
    const index = textIndex(doc);
    const ranges = Array.from({ length: 150 }, (_, i) => {
      let at = Math.floor((doc.content.size * i) / 151) + 1;
      while (!doc.resolve(at).parent.isTextblock || doc.resolve(at).end() - at < 4) at++;
      return { from: at, to: Math.min(at + 12, doc.resolve(at).end()) };
    });
    const anchors = ranges.map((r) => anchorFor(doc, r.from, r.to, index));
    const best = (work: () => void) => {
      let fastest = Infinity;
      for (let i = 0; i < 3; i++) {
        const start = performance.now();
        work();
        fastest = Math.min(fastest, performance.now() - start);
      }
      return fastest;
    };
    const once = best(() => textIndex(doc));
    const all = best(() => anchors.forEach((a, i) => expect(findAnchor(doc, a, index)).toEqual(ranges[i])));
    expect(all).toBeLessThan(Math.max(2 * once, 10));
  });

  it("finds many comments on a short common word quickly after the text above them moved, each on its own words", () => {
    // Roadmap Batch 18, R16-4: each place "the" is written was weighed loosely, reading the comment's own remembered
    // text loosely again every time: 50 comments took about 400 ms on 30,000 words, and grew with the document.
    const md = bigDocument();
    const index0 = textIndex(docOf(md));
    const all = [...index0.text.matchAll(/\bthe\b/g)];
    const step = Math.max(1, Math.floor(all.length / 50));
    const anchors = all.filter((_, i) => i % step === 0).slice(0, 50).map((m) => anchorIn(index0.text, m.index, m.index + 3));
    const moved = docOf("A new opening paragraph, put in by another app.\n\n" + md);
    const index = textIndex(moved);
    const shift = index.text.indexOf(index0.text.slice(0, 40));
    const best = (work: () => void) => {
      let fastest = Infinity;
      for (let i = 0; i < 3; i++) {
        const start = performance.now();
        work();
        fastest = Math.min(fastest, performance.now() - start);
      }
      return fastest;
    };
    const once = best(() => looseText(index.text));
    const found = best(() =>
      anchors.forEach((a) => {
        const r = findAnchor(moved, a, index);
        expect(r && offsetAt(index, r.from)).toBe(a.offset + shift);
      }),
    );
    expect(found).toBeLessThan(Math.max(5 * once, 40));
  });

  it("finds a comment that ends on a picture or footnote marker in the same place, at the end of a paragraph or of the document", () => {
    const placeOf = (doc: Node, type: string) => {
      let at = -1;
      doc.descendants((node, pos) => {
        if (node.type.name === type) at = pos;
      });
      return at;
    };
    const cases: [string, string, number][] = [
      // A picture alone in its paragraph, then more text.
      ["First paragraph.\n\n![chart](chart.png)\n\nLast paragraph.\n", "image", 0],
      // Words that end on a picture at the end of their paragraph.
      ["Some words and a picture ![c](c.png)\n\nNext paragraph.\n", "image", 10],
      // A picture that ends the document.
      ["First paragraph.\n\n![chart](chart.png)\n", "image", 0],
      // Words ending on a footnote marker at the end of their paragraph.
      ["A claim that needs a source.[^1]\n\nNext paragraph.\n\n[^1]: The source.\n", "footnote_ref", 8],
    ];
    for (const [md, type, back] of cases) {
      const doc = docOf(md);
      const at = placeOf(doc, type);
      const range = { from: at - back, to: at + 1 };
      const anchor = anchorFor(doc, range.from, range.to);
      expect(anchor.quote.endsWith("￼")).toBe(true);
      expect(findAnchor(doc, anchor)).toEqual(range);
    }
  });

  it("works inside tables and next to footnote markers", () => {
    const doc = docOf("| Option | Cost |\n|---|---|\n| Tool A | Free |\n\nClaim.[^1] More text.\n\n[^1]: Note.\n");
    for (const find of ["Free", "More text"]) {
      const r = rangeOf(doc, find);
      expect(findAnchor(doc, anchorFor(doc, r.from, r.to))).toEqual(r);
    }
  });
});
