import { describe, expect, it } from "vitest";
import { applyDelta, diffSequence, diffText, diffWords, makeDelta, readable, tokenize } from "../../src/core/diff";
import { diffDocs, type Change } from "../../src/core/doc-diff";
import { describeChanges } from "../../src/core/describe-changes";
import { parseMarkdown } from "../../src/core/markdown";
import { formatDate, inSentence, relativeTime } from "../../src/core/versions";
import { OffsetMap, changedPieces } from "../../src/core/change-links";

const doc = (md: string) => parseMarkdown(md).doc;

/** The changes, as words: what came in and what went, in the newer document. */
function summary(before: string, after: string): string[] {
  const b = doc(after);
  return diffDocs(doc(before), b).map((c: Change) => {
    switch (c.kind) {
      case "added-text":
        return `+${b.textBetween(c.from, c.to)}`;
      case "removed-text":
        return `-${c.text}`;
      case "added-block":
        return `+block ${b.nodeAt(c.from)?.type.name}: ${b.nodeAt(c.from)?.textContent}`;
      case "removed-block":
        return `-block ${c.node.type.name}: ${c.node.textContent}`;
      case "changed-block":
        return `~block ${b.nodeAt(c.from)?.type.name}`;
    }
  });
}

describe("comparing sequences", () => {
  it("finds the fewest steps between two lists", () => {
    const ops = diffSequence("abcabba".split(""), "cbabac".split(""));
    const removed = ops.filter((o) => o.type === "removed").length;
    const added = ops.filter((o) => o.type === "added").length;
    expect(removed + added).toBe(5);
    // Taking the same items in order rebuilds both lists.
    expect(ops.filter((o) => o.type !== "added").map((o) => (o as { a: string }).a).join("")).toBe("abcabba");
    expect(ops.filter((o) => o.type !== "removed").map((o) => (o as { b: string }).b).join("")).toBe("cbabac");
  });

  it("handles empty lists and identical lists", () => {
    expect(diffSequence([], ["x"])).toEqual([{ type: "added", b: "x" }]);
    expect(diffSequence(["x"], [])).toEqual([{ type: "removed", a: "x" }]);
    expect(diffSequence(["x", "y"], ["x", "y"]).every((o) => o.type === "same")).toBe(true);
  });

  it("splits text into words and spaces that join back into the same text", () => {
    const text = "Don't stop: it's 3.5 times faster, über-quick!\n\nNext.";
    expect(tokenize(text).join("")).toBe(text);
    expect(tokenize("don't go")).toEqual(["don't", " ", "go"]);
  });

  it("keeps a number whole, with its commas, point or colon, but not a comma or full stop after it", () => {
    expect(tokenize("1,840 at 10:30, 3.5 times in 2026.")).toEqual(["1,840", " ", "at", " ", "10:30", ",", " ", "3.5", " ", "times", " ", "in", " ", "2026", "."]);
    expect(tokenize("one,two")).toEqual(["one", ",", "two"]);
  });
});

describe("word-by-word changes", () => {
  it("shows a replaced word as taken out then put in", () => {
    expect(diffWords("The quick brown fox.", "The slow brown fox.")).toEqual([
      { type: "same", text: "The " },
      { type: "removed", text: "quick" },
      { type: "added", text: "slow" },
      { type: "same", text: " brown fox." },
    ]);
  });

  it("marks a changed number as one change, not in pieces around its comma (review of Batch 11, F-15)", () => {
    expect(diffWords("We expect 1,840 visitors.", "We expect About 1,800 visitors.")).toEqual([
      { type: "same", text: "We expect " },
      { type: "removed", text: "1,840" },
      { type: "added", text: "About 1,800" },
      { type: "same", text: " visitors." },
    ]);
  });

  it("joins neighbouring changed words into one change", () => {
    const pieces = diffWords("the quick brown fox", "a slow red fox");
    expect(pieces).toEqual([
      { type: "removed", text: "the quick brown" },
      { type: "added", text: "a slow red" },
      { type: "same", text: " fox" },
    ]);
  });
});

describe("changes that read as one", () => {
  // With another change later in the paragraph, a word-by-word comparison
  // matched the old "and" to the first new one: "{+(help, info, volunteers +}and {+events) and +}".
  const before = "Requests reach us through four inboxes and two group chats. Nobody can see what's already being handled.";
  const after = "Requests reach us through four inboxes (help, info, volunteers and events) and two group chats. Nobody can see what's being handled.";

  it("an inserted clause that repeats a word next to it is one change, not two patches with the word between", () => {
    expect(diffWords(before, after)).toEqual([
      { type: "same", text: "Requests reach us through four inboxes " },
      { type: "added", text: "(help, info, volunteers and events) " },
      { type: "same", text: "and two group chats. Nobody can see what's" },
      { type: "removed", text: " already" },
      { type: "same", text: " being handled." },
    ]);
  });

  it("a rewritten sentence that kept a short word is one change", () => {
    const changed = diffWords("The plan is late and over budget.", "Our timeline slipped and costs rose.").filter((p) => p.type !== "same");
    expect(changed).toEqual([
      { type: "removed", text: "The plan is late and over budget" },
      { type: "added", text: "Our timeline slipped and costs rose" },
    ]);
  });

  it("two words changed with real words between are still two changes", () => {
    const twice = (a: string, b: string) => diffWords(a, b).filter((p) => p.type === "added").map((p) => p.text);
    expect(twice("Paint it red and blue.", "Paint it green and yellow.")).toEqual(["green", "yellow"]);
    expect(twice("We hire two people this quarter.", "We hire three people next quarter.")).toEqual(["three", "next"]);
    expect(twice("The quick brown fox jumps over the lazy dog.", "The slow brown fox jumps over the sleepy dog.")).toEqual(["slow", "sleepy"]);
  });

  // R-AG-7: each join read the whole change so far again, so a long paragraph rewritten word by word took a time growing with its square.
  it("joining many changes in a long paragraph takes less time than comparing it", () => {
    const words = (n: number, word: string) => Array.from({ length: n }, (_, i) => `${word}${i}`).join(" a ");
    const [a, b] = [words(900, "longword"), words(900, "otherone")];
    const steps = diffText(a, b);
    const quickest = (f: () => unknown) => {
      let best = Infinity;
      for (let i = 0; i < 3; i++) {
        const start = performance.now();
        f();
        best = Math.min(best, performance.now() - start);
      }
      return best;
    };
    // The comparison itself, for scale on this Mac at this moment: the joins took five times as long as it, and now a tenth.
    expect(quickest(() => readable(steps, true))).toBeLessThan(quickest(() => diffText(a, b)));
    expect(readable(steps, true).filter((p) => p.type === "added")).toEqual([{ type: "added", text: b }]);
  });

  it("the comments around it follow the words they were on", () => {
    const map = new OffsetMap(before, after);
    const at = before.indexOf("and two");
    expect(map.map(at, 1)).toBe(after.indexOf("and two"));
    const [clause] = changedPieces(before, after);
    expect(after.slice(clause.start, clause.end)).toBe("(help, info, volunteers and events)");
    expect(clause.removed).toBe("");
  });
});

describe("long texts, compared in levels", () => {
  const para = (i: number) => `Paragraph ${i} talks about the plan for the quarter and what the team will do next.`;
  const text = Array.from({ length: 60 }, (_, i) => para(i)).join("\n");
  const section = Array.from({ length: 130 }, (_, i) => `New sentence ${i} has exactly ten words in it, give or take.`).join(" ");

  it("a one-word fix and a long new section far apart are two small changes, not everything between them", () => {
    const after = text.replace("Paragraph 2 talks", "Paragraph 2 speaks").replace(para(55), `${para(55)}\n${section}`);
    const changed = diffWords(text, after).filter((p) => p.type !== "same");
    expect(changed).toEqual([
      { type: "removed", text: "talks" },
      { type: "added", text: "speaks" },
      { type: "added", text: `${section}\n` },
    ]);
  });

  it("a last line is the same line when lines are put in after it", () => {
    const a = "Intro stays here.\nOld notes go.\nReview prices today.";
    const b = "Intro stays here.\nReview prices today.\nBudget agreed.\nReview prices again later.";
    expect(diffText(a, b)).toEqual([
      { type: "same", text: "Intro stays here.\n" },
      { type: "removed", text: "Old notes go.\n" },
      { type: "same", text: "Review prices today." },
      { type: "added", text: "\nBudget agreed.\nReview prices again later." },
    ]);
    expect(diffText(b, a)).toEqual([
      { type: "same", text: "Intro stays here.\n" },
      { type: "added", text: "Old notes go.\n" },
      { type: "same", text: "Review prices today." },
      { type: "removed", text: "\nBudget agreed.\nReview prices again later." },
    ]);
  });

  it("a rewrite touching every paragraph still shows each paragraph's own changes", () => {
    const long = Array.from({ length: 300 }, (_, i) => para(i)).join("\n");
    const after = Array.from({ length: 300 }, (_, i) => para(i).replace("the plan", `plan ${i}`).replace("next", "after that")).join("\n");
    const changed = diffWords(long, after).filter((p) => p.type !== "same");
    // Two places in each of the 300 paragraphs, each a word or two.
    expect(changed.filter((p) => p.type === "added")).toHaveLength(600);
    expect(Math.max(...changed.map((p) => p.text.length))).toBeLessThan(12);
  });
});

describe("two long versions with nothing alike", () => {
  // A translation, a full rewrite, or another file saved over this one: every
  // paragraph that went used to be compared with every one that came.
  const version = (tag: string) =>
    Array.from({ length: 800 }, (_, i) => Array.from({ length: 70 }, (_, j) => `${tag}${i}w${j}`).join(" ")).join("\n\n") + "\n";
  const a = version("alpha");
  const b = version("beta");

  it("are compared for Show changes in well under a second", () => {
    const before = doc(a);
    const after = doc(b);
    const start = performance.now();
    const changes = diffDocs(before, after);
    // About 100 ms; every block against every other took 8 to 10 seconds. Room for a busy Mac.
    expect(performance.now() - start).toBeLessThan(1000);
    expect(changes.filter((c) => c.kind === "removed-block")).toHaveLength(800);
    expect(changes.filter((c) => c.kind === "added-block")).toHaveLength(800);
  });

  it("are described for agents in well under a second", () => {
    parseMarkdown(a);
    const start = performance.now();
    const text = describeChanges(a, b);
    const ms = performance.now() - start;
    // Reading the two versions' Markdown is part of it.
    const parse = performance.now();
    parseMarkdown(a);
    parseMarkdown(b);
    expect(ms - (performance.now() - parse)).toBeLessThan(1000);
    expect(text.match(/^Removed /gm)).toHaveLength(800);
  });
});

describe("what a version changed, on the formatted page", () => {
  it("marks added and removed words inside a paragraph", () => {
    expect(summary("Hello there world.\n", "Hello big world.\n")).toEqual(["-there", "+big"]);
  });

  it("marks a new paragraph and a removed one as whole blocks", () => {
    expect(summary("One.\n\nTwo.\n", "One.\n\nThree is new.\n\nTwo.\n")).toEqual(["+block paragraph: Three is new."]);
    expect(summary("One.\n\nGone now.\n\nTwo.\n", "One.\n\nTwo.\n")).toEqual(["-block paragraph: Gone now."]);
  });

  it("marks a list item that changed, not the whole list", () => {
    expect(summary("- apples\n- pears\n- plums\n", "- apples\n- ripe pears\n- plums\n")).toEqual(["+ripe "]);
    expect(summary("- apples\n- plums\n", "- apples\n- grapes from Spain\n- plums\n")).toEqual([
      "+block list_item: grapes from Spain",
    ]);
  });

  it("marks table cells that changed, and keeps the table's shape", () => {
    const before = "| Name | Cost |\n| --- | --- |\n| Tool A | 12 |\n| Tool B | 30 |\n";
    const after = "| Name | Cost |\n| --- | --- |\n| Tool A | 15 |\n| Tool B | 30 |\n| Tool C | 9 |\n";
    expect(summary(before, after)).toEqual(["-12", "+15", "+block table_row: Tool C9"]);
  });

  it("marks the right cells in a row that repeats its values", () => {
    const table = (row: string) => `| A | B | C | D |\n|---|---|---|---|\n${row}\n`;
    expect(summary(table("| x | y | y | tail one |"), table("| y | y | z | tail two |"))).toEqual(["-x", "+y", "-y", "+z", "-one", "+two"]);
    expect(summary(table("| Ana |  |  | old words here |"), table("|  | Ana |  | new words here |"))).toEqual(["-Ana", "+Ana", "-old", "+new"]);
  });

  it("in tables with repeated values, marks every changed cell, each mark inside its cell", () => {
    let seed = 4242;
    const rnd = () => (seed = (seed * 1103515245 + 12345) & 0x7fffffff) / 0x7fffffff;
    const pick = <T>(a: T[]) => a[Math.floor(rnd() * a.length)];
    const values = ["Yes", "No", "", "TBD", "10", "20", "Ana", "Done", "In progress", "High"];
    const table = (rows: string[][]) =>
      `| ${rows[0].map((_, i) => `H${i}`).join(" | ")} |\n|${rows[0].map(() => "---").join("|")}|\n` + rows.map((r) => `| ${r.join(" | ")} |`).join("\n") + "\n";
    for (let t = 0; t < 600; t++) {
      const cols = 3 + Math.floor(rnd() * 3);
      const rows = Array.from({ length: 4 }, () => Array.from({ length: cols }, () => pick(values)));
      const next = rows.map((r) => [...r]);
      const row = Math.floor(rnd() * 4);
      for (let i = 0, k = 1 + Math.floor(rnd() * 2); i < k; i++) next[row][Math.floor(rnd() * cols)] = pick(values);
      const b = doc(table(next));
      const changes = diffDocs(doc(table(rows)), b);
      // Which cells (row and column) each mark is in: inside one cell, and only cells that changed.
      const marked = new Set<string>();
      const removed = new Set<string>();
      for (const c of changes) {
        expect(c.kind === "added-text" || c.kind === "removed-text").toBe(true);
        const at = c.kind === "added-text" ? c.from : c.kind === "removed-text" ? c.at : -1;
        const $at = b.resolve(at);
        if (c.kind === "added-text") expect(b.resolve(c.to).parent).toBe($at.parent);
        // doc > table > row > cell: the row (after the header) and the cell.
        const place = `${$at.index(1) - 1},${$at.index(2)}`;
        (c.kind === "added-text" ? marked : removed).add(place);
      }
      next[row].forEach((value, col) => {
        const was = rows[row][col];
        if (value === was) {
          expect(marked.has(`${row},${col}`) || removed.has(`${row},${col}`)).toBe(false);
          return;
        }
        if (value && !(was && value.includes(was))) expect(marked.has(`${row},${col}`)).toBe(true);
        if (was && !(value && was.includes(value))) expect(removed.has(`${row},${col}`)).toBe(true);
      });
    }
  });

  it("marks a row, item or paragraph taken out or put in right above a changed one whole, and the changed one where it changed", () => {
    const table = (rows: string) => `| Phase | Date |\n| --- | --- |\n${rows}| Test | 29 June |\n`;
    expect(summary(table("| Design | 1 June |\n| Build | 15 June |\n"), table("| Build | 22 June |\n"))).toEqual(["-block table_row: Design1 June", "-15", "+22"]);
    expect(summary(table("| Build | 15 June |\n"), table("| Design | 1 June |\n| Build | 22 June |\n"))).toEqual(["+block table_row: Design1 June", "-15", "+22"]);
    expect(
      summary("- Email the members about the launch\n- Print the posters\n- Email the sponsors about the party\n", "- Print the flyers\n- Email the sponsors about the dinner\n"),
    ).toEqual(["-block list_item: Email the members about the launch", "-posters", "+flyers", "-party", "+dinner"]);
    expect(
      summary("We ask the board for more money this year.\n\nThe team is small.\n\nWe ask the city for more room this year.\n", "The team is tiny.\n\nWe ask the city for more room next year.\n"),
    ).toEqual(["-block paragraph: We ask the board for more money this year.", "-small", "+tiny", "-this", "+next"]);
  });

  it("marks only what came or went where a list is cut in two, grouped under headings, or two lists made one", () => {
    const list = "- Email the members\n- Print the posters\n- Book the hall\n";
    expect(summary(list, "- Email the members\n\nThe rest can wait until May.\n\n- Print the posters\n- Book the hall\n")).toEqual(["+block paragraph: The rest can wait until May."]);
    expect(
      summary(
        "# Plan\n\n- Email the members\n- Print the posters\n- Book the hall\n- Order the food\n",
        "# Plan\n\n## This week\n\n- Email the members\n- Print the posters\n\n## Next week\n\n- Book the hall\n- Order the food\n",
      ),
    ).toEqual(["+block heading: This week", "+block heading: Next week"]);
    expect(summary("- Email the members\n\nThen:\n\n- Print the posters\n- Book the hall\n", list)).toEqual(["-block paragraph: Then:"]);
    // An item changed or taken out there is marked as in any list, and one taken out is shown in a list, in the page's order.
    const after = "- Email the members\n\nThe rest can wait.\n\n- Print the flyers\n";
    expect(summary(list, after)).toEqual(["+block paragraph: The rest can wait.", "-posters", "+flyers", "-block list_item: Book the hall"]);
    const changes = diffDocs(doc(list), doc(after));
    const gone = changes.find((c) => c.kind === "removed-block");
    expect(gone?.kind === "removed-block" && doc(after).resolve(gone.at).parent.type.name).toBe("bullet_list");
    const at = changes.map((c) => (c.kind === "removed-block" || c.kind === "removed-text" ? c.at : c.from));
    expect(at).toEqual([...at].sort((x, y) => x - y));
  });

  it("marks a change of style (a paragraph made a heading) on the block", () => {
    expect(summary("Plan\n\nText.\n", "# Plan\n\nText.\n")).toEqual(["~block heading"]);
    expect(summary("Make it bold.\n", "Make it **bold**.\n")).toEqual(["~block paragraph"]);
  });

  it("shows a rewritten paragraph as one removed and one added", () => {
    expect(summary("Entirely different words here.\n", "Nothing alike at all now.\n")).toEqual([
      "-block paragraph: Entirely different words here.",
      "+block paragraph: Nothing alike at all now.",
    ]);
  });

  it("finds nothing when nothing changed", () => {
    expect(summary("# Same\n\nText.\n", "# Same\n\nText.\n")).toEqual([]);
  });
});

describe("changes described for agents", () => {
  it("lists only what changed, with where it is and the words that changed", () => {
    const text = describeChanges("# Plan\n\nWe answer slowly.\n\nKeep this.\n", "# Plan\n\nWe answer quickly.\n\nKeep this.\n\nA new ending.\n");
    expect(text).toBe(
      'Changed (after "# Plan"):\nWe answer [-slowly-]{+quickly+}.\n\nAdded (after "Keep this."):\nA new ending.',
    );
  });

  it("tells a paragraph taken out right above changed ones as removed, and each changed one as changed", () => {
    const text = describeChanges(
      "We ask the board for more money this year.\n\nThe team is small.\n\nWe ask the city for more room this year.\n",
      "The team is tiny.\n\nWe ask the city for more room next year.\n",
    );
    expect(text).toBe(
      "Removed (at the start):\nWe ask the board for more money this year.\n\n" +
        "Changed (at the start):\nThe team is [-small-]{+tiny+}.\n\n" +
        "Changed (at the start):\nWe ask the city for more room [-this-]{+next+} year.",
    );
  });

  it("says when nothing changed", () => {
    expect(describeChanges("Same.\n", "Same.\n")).toBe("No changes.");
  });

  it("says when only empty lines changed, how many and where, never that nothing did (R-EL-7)", () => {
    expect(describeChanges("A\n\nB\n", "A\n\n\n\nB\n")).toBe('Only empty lines changed: 2 added after "A".');
    expect(describeChanges("A\n\n\nB\n\nC\n", "A\n\nB\n\n\nC\n")).toBe(
      'Only empty lines changed: 1 removed after "A", 1 added after "B".',
    );
    expect(describeChanges("Top\n", "\n\nTop\n")).toBe("Only empty lines changed: 2 added at the start.");
    expect(describeChanges("A\n\n  \n\nB\n", "A\n\nB\n")).toBe('Only empty lines changed: 2 removed after "A".');
    const many = Array.from({ length: 6 }, (_, i) => `P${i}`);
    expect(describeChanges(many.join("\n\n") + "\n", many.join("\n\n\n") + "\n")).toBe(
      'Only empty lines changed: 5 added in 5 places, the first after "P0".',
    );
  });

  it("never says nothing changed when the texts differ", () => {
    for (const [a, b] of [
      ["A\n\nB\n", "A\n\nB"],
      ["A\n\nB\n", "A\r\n\r\nB\r\n"],
    ]) {
      expect(describeChanges(a, b)).toBe("The words and empty lines are the same; only line endings or spaces the page doesn't show changed.");
    }
  });
});

describe("old versions stored as changes", () => {
  it("turns one text into another and back exactly", () => {
    const a = "# Plan\r\n\r\nFirst line.\nSecond line stays.\nThird 🙂 line.\n";
    const b = "# Plan\r\n\r\nFirst line, longer.\nSecond line stays.\n";
    expect(applyDelta(a, makeDelta(a, b))).toBe(b);
    expect(applyDelta(b, makeDelta(b, a))).toBe(a);
    expect(applyDelta("", makeDelta("", a))).toBe(a);
    expect(applyDelta(a, makeDelta(a, ""))).toBe("");
  });

  it("costs about the size of the change, not the document", () => {
    const sentence = (i: number) => `Sentence number ${i} says something about the plan.`;
    const a = Array.from({ length: 500 }, (_, i) => sentence(i)).join(" ") + "\n";
    const b = a.replace(sentence(250), "A brand new sentence.");
    const delta = makeDelta(b, a);
    expect(applyDelta(b, delta)).toBe(a);
    expect(JSON.stringify(delta).length).toBeLessThan(80);
  });

  it("refuses edits that don't fit the text", () => {
    expect(() => applyDelta("short", [10, 1, "x"])).toThrow();
    expect(() => applyDelta("short", [0, 1])).toThrow();
    expect(() => applyDelta("short", ["0", 1, "x"])).toThrow();
  });
});

describe("when, in words", () => {
  const now = new Date(2026, 10, 8, 15, 0).getTime();
  const ago = (minutes: number) => new Date(now - minutes * 60_000).toISOString();
  it("says how long ago the way the comments do, so a card and its version in History agree", () => {
    expect(relativeTime(ago(0.2), now)).toBe("Just now");
    expect(relativeTime(ago(1), now)).toBe("1 min ago");
    expect(relativeTime(ago(5.8), now)).toBe("5 min ago");
    expect(relativeTime(ago(130), now)).toBe("2 hours ago");
    expect(relativeTime(ago(18 * 60), now)).toMatch(/^Yesterday, /);
  });

  it("writes the time as the Mac does: 7:55 PM, not 07:55 PM", () => {
    const evening = new Date(2026, 10, 7, 19, 55).toISOString();
    expect(relativeTime(evening, now, "en-US")).toBe("Yesterday, 7:55 PM");
    expect(formatDate(new Date(2026, 10, 3, 7, 5).toISOString(), now, "en-US")).toBe("Nov 3, 7:05 AM");
    expect(formatDate(new Date(2025, 10, 3, 19, 55).toISOString(), now, "en-US")).toBe("Nov 3, 2025, 7:55 PM");
    // Regions that use 24 hours keep their own form.
    expect(formatDate(new Date(2026, 10, 3, 19, 55).toISOString(), now, "en-GB")).toBe("3 Nov, 19:55");
  });

  it("in the middle of a sentence, only Just now and Yesterday lose their capital", () => {
    expect(inSentence("Just now")).toBe("just now");
    expect(inSentence("Yesterday, 7:55 PM")).toBe("yesterday, 7:55 PM");
    expect(inSentence("5 min ago")).toBe("5 min ago");
    expect(inSentence("Monday, 7:55 PM")).toBe("Monday, 7:55 PM");
    expect(inSentence("Nov 3, 7:55 PM")).toBe("Nov 3, 7:55 PM");
  });
});

describe("pictures and footnote markers in a paragraph", () => {
  it("carries a removed picture and footnote marker along, so they can be shown where they were", () => {
    const before = doc("Sales rose ![chart](chart.png) in May[^1] overall.\n\n[^1]: Before returns.\n");
    const after = doc("Sales rose in May overall.\n\n[^1]: Before returns.\n");
    const removed = diffDocs(before, after).filter((c) => c.kind === "removed-text");
    const names = removed.flatMap((c) => {
      const out: string[] = [];
      if (c.kind === "removed-text") c.content.forEach((n) => out.push(n.isText ? `text:${n.text}` : n.type.name));
      return out;
    });
    expect(names).toContain("image");
    expect(names).toContain("footnote_ref");
  });

  it("keeps the formatting of removed words", () => {
    const removed = diffDocs(doc("Keep **this bold** part.\n"), doc("Keep part.\n")).find((c) => c.kind === "removed-text");
    expect(removed?.kind === "removed-text" && removed.content.textBetween(0, removed.content.size)).toContain("this bold");
    let bold = false;
    if (removed?.kind === "removed-text") removed.content.forEach((n) => (bold ||= n.marks.some((m) => m.type.name === "strong")));
    expect(bold).toBe(true);
  });
});

