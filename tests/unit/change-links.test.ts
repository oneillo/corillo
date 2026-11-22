// Which text an agent changed for each comment (src/core/change-links.ts).
import { describe, expect, it } from "vitest";
import {
  OTHER,
  OffsetMap,
  PassLinks,
  changedPieces,
  gapAfter,
  placeEdits,
  applyPlaced,
  carry,
  plainText,
  remapSpans,
  updateChanges,
} from "../../src/core/change-links";
import { anchorIn, locate } from "../../src/core/anchors";
import { waitingForPerson, type Thread } from "../../src/core/comments";
import { bigDocument } from "../fixtures/big-document";

const WORDS = ["Alpha", "Bravo", "Charlie", "Delta", "Echo", "Foxtrot", "Golf"];
const SPELLING = WORDS.map((w) => `${w} is one of the words we spell with.`).join("\n");

function thread(id: string, quote: string | null, text: string, extra: Partial<Thread> = {}): Thread {
  const at = quote === null ? -1 : text.indexOf(quote);
  return {
    id,
    anchor: quote === null ? null : anchorIn(text, at, at + quote.length),
    to: null,
    status: "open",
    messages: [{ id: `${id}-1`, author: { kind: "person" }, body: "Please change this.", created: "2026-11-09T10:00:00.000Z" }],
    ...extra,
  };
}

/** The words of each span, as they read now. */
const quotes = (spans: { anchor: { quote: string } }[] | undefined) => (spans ?? []).map((s) => s.anchor.quote);

describe("what changed between two texts", () => {
  it("finds the changed words, placed in the newer text, with what was there before", () => {
    expect(changedPieces("We hire two people.", "We hire three people.")).toEqual([{ start: 8, end: 13, removed: "two" }]);
    expect(changedPieces("Keep this.", "Keep this.")).toEqual([]);
  });

  it("finds an edit where it was made, even in a document that repeats itself", () => {
    const after = SPELLING.replace("Foxtrot is one of the words we spell with.\n", "");
    const pieces = changedPieces(SPELLING, after);
    expect(pieces).toHaveLength(1);
    expect(pieces[0].removed).toBe("Foxtrot is one of the words we spell with.\n");
    const map = new OffsetMap(SPELLING, after);
    const start = SPELLING.indexOf("Foxtrot");
    expect(map.map(start, 1)).toBe(map.map(start + "Foxtrot is one of the words we spell with.".length, -1));
  });

  it("maps places like an editor: at the edge of a change a place keeps to its side", () => {
    const map = new OffsetMap("one two three", "one 2 three");
    expect(map.map(0)).toBe(0);
    expect(map.map(4, 1)).toBe(4); // the start of the changed word stays before it
    expect(map.map(7, -1)).toBe(5); // its end stays after the new word
    expect(map.map(13)).toBe(11);
  });

  it("finds spans again by their words, or by the words around them", () => {
    const text = "We hire three people this quarter.";
    expect(locate(text, anchorIn(text, 8, 13))).toEqual({ start: 8, end: 13 });
    const moved = "Next year, " + text;
    expect(locate(moved, anchorIn(text, 8, 13))).toEqual({ start: 19, end: 24 });
    // A place where words were only taken out: between the words around it.
    expect(locate(moved, anchorIn(text, 8, 8))).toEqual({ start: 19, end: 19 });
  });

  it("finds a span on its own words, not on the same words elsewhere, after they changed", () => {
    const text = "Our customers in the north asked first.\nThere, customers care about price.\nFinally, customers want invoices.";
    const span = anchorIn(text, 4, 13);
    const changed = text.replace("Our customers in", "Our clients in");
    expect(locate(changed, span)).toEqual({ start: 4, end: 11 });
    const deleted = text.replace("Our customers in", "Our in");
    expect(locate(deleted, span)).toBeNull();
  });

  it("keeps spans on their words through later changes, and drops those whose words are gone", () => {
    const before = "We hire three people this quarter.";
    const spans = [{ anchor: anchorIn(before, 8, 13), removed: "two" }];
    expect(quotes(remapSpans(spans, before, "Next year, we hire three people this quarter."))).toEqual(["three"]);
    expect(remapSpans(spans, before, "We hire people this quarter.")).toEqual([]);
  });

  it("places exact edits as applyEdits does, including every match with all", () => {
    const text = "a cat and a cat";
    const placed = placeEdits(text, [{ find: "cat", replace: "dog", all: true }, { find: "and", replace: "or" }]);
    expect(placed.map((p) => [p.at, p.index])).toEqual([[2, 0], [6, 1], [12, 0]]);
    expect(applyPlaced(text, placed)).toBe("a dog or a dog");
  });

  it("measures text as the editor shows it, without Markdown signs", () => {
    expect(plainText("# Plan\n\nWe **hire** two.\n")).toBe("Plan\nWe hire two.");
  });

  it("reads a long document's words once for edits that follow each other, and a changed text afresh", () => {
    const before = bigDocument();
    const after = before.replace("### 2.2 ", "### 2.2 Rewritten ");
    const timed = (markdown: string) => {
      const start = performance.now();
      const words = plainText(markdown);
      return { words, ms: performance.now() - start };
    };
    const first = timed(before);
    const changed = timed(after);
    expect(changed.words).toContain("2.2 Rewritten ");
    expect(first.words).not.toContain("Rewritten");
    // The next edit starts from the text the last one left: read already.
    const again = timed(after);
    expect(again.words).toBe(changed.words);
    expect(again.ms).toBeLessThan(changed.ms / 5);
    expect(plainText(before)).toBe(first.words);
  });
});

describe("an agent's pass", () => {
  const start = "Plan\nWe should hire two people this quarter.\nThe budget is tight.";

  it("ties each edit's change to the comments it answers, and the rest to other changes", () => {
    const links = new PassLinks("Claude", start);
    const one = start.replace("two", "three");
    const two = one.replace("tight", "tight: 10% under");
    const three = two.replace("Plan", "Hiring plan");
    links.edited(start, [{ text: one, owners: ["a"] }, { text: two, owners: ["b"] }, { text: three, owners: [] }]);
    const spans = links.spans();
    expect(quotes(spans.get("a"))).toEqual(["three"]);
    expect(spans.get("a")![0].removed).toBe("two");
    expect(quotes(spans.get("b"))).toEqual([": 10% under"]);
    expect(quotes(spans.get(OTHER))).toEqual(["Hiring plan"]);
    expect(links.threads.sort()).toEqual(["a", "b"]);
  });

  it("shows a comment's change as it stands at the end of the pass, however many edits it took", () => {
    const links = new PassLinks("Claude", start);
    const one = start.replace("two", "three");
    const two = one.replace("three", "four");
    links.edited(start, [{ text: one, owners: ["a"] }]);
    links.edited(one, [{ text: two, owners: ["a"] }]);
    const a = links.spans().get("a")!;
    expect(quotes(a)).toEqual(["four"]);
    expect(a[0].removed).toBe("two");
  });

  it("an inserted clause is one change for its comment, however the rest of the pass went", () => {
    const text = "Requests reach us through four inboxes and two group chats.\nNobody can see what's already being handled.";
    const one = text.replace("four inboxes and two", "four inboxes (help, info, volunteers and events) and two");
    const two = one.replace("what's already being", "what's being");
    const links = new PassLinks("Claude", text);
    links.edited(text, [{ text: one, owners: ["c"] }, { text: two, owners: [] }]);
    const spans = links.spans();
    expect(quotes(spans.get("c"))).toEqual(["(help, info, volunteers and events)"]);
    expect(spans.get(OTHER)!.map((s) => s.removed)).toEqual([" already"]);
  });

  it("gives side-by-side changes for different comments each its own part", () => {
    const links = new PassLinks("Claude", "The budget is tight.");
    const one = "The budget is tight: 10% under.";
    const two = "The budget is tight: 10% under. Thanks.";
    links.edited("The budget is tight.", [{ text: one, owners: ["b"] }, { text: two, owners: ["c"] }]);
    const spans = links.spans();
    expect(quotes(spans.get("b")).join("")).toContain("10% under");
    expect(quotes(spans.get("c")).join("")).toContain("Thanks");
    expect(quotes(spans.get("c")).join("")).not.toContain("10%");
  });

  it("two comments' rewrites with a short word between keep their own words and what each said before", () => {
    const text = "We know the plan is running late and over the budget we set.";
    const one = text.replace("the plan is running late", "our timeline slipped badly");
    const two = one.replace("over the budget we set", "costs rose past the cap");
    const links = new PassLinks("Claude", text);
    links.edited(text, [{ text: one, owners: ["a"] }, { text: two, owners: ["b"] }]);
    const spans = links.spans();
    expect(spans.get("a")!.map((s) => [s.anchor.quote, s.removed])).toEqual([["our timeline slipped badly", "the plan is running late"]]);
    expect(spans.get("b")!.map((s) => [s.anchor.quote, s.removed])).toEqual([["costs rose past the cap", "over the budget we set"]]);
    // One comment that asked for both sees one change.
    const both = new PassLinks("Claude", text);
    both.edited(text, [{ text: two, owners: ["a"] }]);
    expect(quotes(both.spans().get("a"))).toEqual(["our timeline slipped badly and costs rose past the cap"]);
  });

  it("changes on two lines next to each other, for two comments, each keep what their own line said (R-8)", () => {
    const text = "Launch plan\nEmail the members\nPrint the posters\nBook the hall";
    const one = text.replace("Email the members", "Write to every volunteer");
    const two = one.replace("Print the posters", "Order two hundred flyers");
    const links = new PassLinks("Claude", text);
    links.edited(text, [{ text: one, owners: ["a"] }, { text: two, owners: ["b"] }]);
    const spans = links.spans();
    expect(spans.get("a")!.map((s) => [s.anchor.quote, s.removed])).toEqual([["Write to every volunteer", "Email the members"]]);
    expect(spans.get("b")!.map((s) => [s.anchor.quote, s.removed])).toEqual([["Order two hundred flyers", "Print the posters"]]);
  });

  it("with a request from the chat, edits tied to no comment are for the request, even those made before it was given", () => {
    const links = new PassLinks("Claude", start);
    const one = start.replace("tight", "very tight");
    links.edited(start, [{ text: one, owners: [] }]);
    links.setRequest("request-1", "Make the budget line stronger.");
    const two = one.replace("Plan", "Hiring plan");
    links.edited(one, [{ text: two, owners: [] }]);
    const spans = links.spans();
    expect(quotes(spans.get("request-1"))).toEqual(["Hiring plan", "very"]);
    expect(spans.get(OTHER) ?? []).toEqual([]);
    expect(links.untied).toBe("request-1");
  });

  it("keeps each comment's latest round, counts rounds, and moves earlier changes with the text", () => {
    const threads = [thread("a", "two people", start), thread("b", "tight", start)];
    const first = new PassLinks("Claude", start);
    const one = start.replace("two", "three");
    first.edited(start, [{ text: one, owners: ["a"] }]);
    let next = updateChanges(threads, first, start, one, "2026-11-09T10:01:00.000Z");
    expect(next[0].change).toMatchObject({ round: 1, agent: "Claude" });
    expect(quotes(next[0].change!.spans)).toEqual(["three"]);
    expect(next[1].change).toBeUndefined();

    // A second round for the same comment: only its new change is kept.
    const second = new PassLinks("Claude", one);
    const two = one.replace("this quarter", "by March");
    second.edited(one, [{ text: two, owners: ["a"] }]);
    next = updateChanges(next, second, one, two, "2026-11-09T11:00:00.000Z");
    expect(next[0].change!.round).toBe(2);
    expect(quotes(next[0].change!.spans)).toEqual(["by March"]);
  });

  it("leaves changes tied to no comment with the pass alone: no comment gets them, and nothing else is kept with the comments", () => {
    const threads = [thread("a", "two people", start)];
    const links = new PassLinks("Claude", start);
    const one = start.replace("Plan", "Hiring plan");
    links.edited(start, [{ text: one, owners: [] }]);
    const next = updateChanges(threads, links, start, one, "2026-11-09T10:01:00.000Z");
    expect(next).toEqual(threads);
    expect(quotes(links.spans().get(OTHER))).toEqual(["Hiring plan"]);
  });
});

describe("a comment carried through an edit stays on its own line, whatever other lines now read (R-1)", () => {
  /** Where the words a comment is on are after the edit, and on which line of the words. */
  function carried(beforeMarkdown: string, afterMarkdown: string, quote: string): { words: string; line: number } | string {
    const [before, after] = [plainText(beforeMarkdown), plainText(afterMarkdown)];
    const start = before.indexOf(quote);
    expect(before.indexOf(quote, start + 1)).toBe(-1);
    const c = carry(before, after, start, start + quote.length, new OffsetMap(before, after), anchorIn(before, start, start + quote.length));
    return c.kind === "words" ? { words: after.slice(c.start, c.end), line: after.slice(0, c.start).split("\n").length } : c.kind;
  }

  const plan = (first: string, last: string) => `# Plan\n\n${first}\n\nSome other paragraph in between.\n\n${last}\n`;
  const headings = (first: string, second: string) => `# Plan\n\n## ${first}\n\nText one.\n\n## ${second}\n\nText two.\n`;
  const status = (a: string, b: string, c: string) => `| Status |\n| --- |\n| ${a} |\n| ${b} |\n| ${c} |\n`;
  const owners = (a: string, b: string, c: string) => `# Owners\n\n- ${a}\n- ${b}\n- ${c}\n`;
  const row = (start: string, end: string) => `# Schedule\n\n| Milestone | Start | End |\n| --- | --- | --- |\n| Design | 1 May | 20 May |\n| Build | ${start} | ${end} |\n`;
  for (const [what, before, after, quote, now] of [
    ["a paragraph rewritten, when another now reads as it did", plan("We ship in May.", "We test in April."), plan("We ship in June.", "We ship in May."), "We ship in May.", { words: "We ship in June.", line: 2 }],
    ["a heading renamed, when another takes its old name", headings("Risks", "Costs"), headings("Open questions", "Risks"), "Risks", { words: "Open questions", line: 2 }],
    ["a status nobody changed, when the row above gets the same", status("Open", "Done", "Open"), status("Done", "Done", "Blocked"), "Done", { words: "Done", line: 3 }],
    ["a list item nobody changed, when the item above reads the same", owners("Ana", "Ben", "Cleo"), owners("Ben", "Ben", "Dev"), "Ben", { words: "Ben", line: 3 }],
    ["a cell rewritten, when the cell beside it gets words like its old ones", row("Not started", "29 June"), row("15 June", "Done"), "29 June", { words: "Done", line: 10 }],
  ] as const) {
    it(what, () => expect(carried(before, after, quote)).toEqual(now));
  }
});

describe("a comment whose words were deleted", () => {
  it("keeps the place they were, found where the edit was made", () => {
    const t = thread("f", "Foxtrot is one of the words we spell with.", SPELLING);
    const after = SPELLING.replace("Foxtrot is one of the words we spell with.\n", "");
    const gap = gapAfter(t, SPELLING, after, new OffsetMap(SPELLING, after))!;
    expect(gap.quote).toBe("");
    expect(after.slice(0, gap.offset)).toMatch(/Echo is one of the words we spell with\.\n$/);
  });

  it("has none while the words are still there, or when they were changed rather than deleted", () => {
    const t = thread("a", "two people", "We hire two people.");
    const kept = "Next year, we hire two people.";
    expect(gapAfter(t, "We hire two people.", kept, new OffsetMap("We hire two people.", kept))).toBeUndefined();
    const changed = "We hire three people.";
    expect(gapAfter(thread("b", "two", "We hire two people."), "We hire two people.", changed, new OffsetMap("We hire two people.", changed))).toBeUndefined();
  });

  it("keeps the place of deleted words even when the same words are elsewhere in the document", () => {
    const text = "Our customers in the north asked first.\nThere, customers care about price.";
    const t = thread("c", "customers", text);
    const after = text.replace("Our customers in", "Our in");
    const gap = gapAfter(t, text, after, new OffsetMap(text, after))!;
    expect(gap.quote).toBe("");
    expect(after.slice(0, gap.offset)).toBe("Our ");
    // Words moved elsewhere whole, with what was around them, aren't gone.
    const moved = "There, customers care about price.\nOur customers in the north asked first.";
    expect(gapAfter(t, text, moved, new OffsetMap(text, moved))).toBeUndefined();
  });

  it("moves with later edits, and is kept with the comment", () => {
    const t = thread("f", "Foxtrot is one of the words we spell with.", SPELLING);
    const after = SPELLING.replace("Foxtrot is one of the words we spell with.\n", "");
    const links = new PassLinks("Claude", SPELLING);
    links.edited(SPELLING, [{ text: after, owners: ["f"] }]);
    const next = updateChanges([t], links, SPELLING, after, "2026-11-09T10:00:00.000Z");
    expect(next[0].gap?.quote).toBe("");
    expect(next[0].detached).toBe(true);
    const later = "A new first line.\n" + after;
    const moved = gapAfter(next[0], after, later, new OffsetMap(after, later))!;
    expect(later.slice(0, moved.offset)).toMatch(/Echo is one of the words we spell with\.\n$/);
  });
});

describe("a pass that writes a long new section and fixes a word elsewhere", () => {
  // Past a couple of thousand word changes in one comparison, the comparison
  // used to give up and call everything between the first and the last change
  // replaced: a one-word fix became most of the document.
  const para = (i: number) => `Paragraph ${i} talks about the plan for the quarter and what the team will do next.`;
  const start = plainText(Array.from({ length: 60 }, (_, i) => para(i)).join("\n\n") + "\n");
  const section = Array.from({ length: 130 }, (_, i) => `New sentence ${i} has exactly ten words in it, give or take.`).join(" ");
  const fixed = start.replace("Paragraph 2 talks", "Paragraph 2 speaks");
  const written = fixed.replace(para(55), `${para(55)}\n${section}`);

  it("keeps the fix as the one word it is, and the section as its own change", () => {
    const links = new PassLinks("Claude", start);
    links.edited(start, [{ text: fixed, owners: ["c1"] }]);
    links.edited(fixed, [{ text: written, owners: [] }]);
    const spans = links.spans();
    expect(spans.get("c1")!.map((s) => [s.anchor.quote, s.removed])).toEqual([["speaks", "talks"]]);
    const other = spans.get(OTHER)!;
    expect(other).toHaveLength(1);
    expect(other[0].anchor.quote).toBe(section);
    expect(other[0].removed).toBe("");
  });

  it("gives one comment that owns both edits two small changes, not one the size of the document", () => {
    const links = new PassLinks("Claude", start);
    links.edited(start, [{ text: written, owners: ["c1"] }]);
    const mine = links.spans().get("c1")!;
    expect(mine.map((s) => s.removed)).toEqual(["talks", ""]);
    // What's kept with the comment is about the size of the change.
    expect(JSON.stringify(mine).length).toBeLessThan(section.length + 400);
  });

  it("maps untouched text exactly, so other comments' changes and gaps stay where they are", () => {
    const after = written.replace("Paragraph 30 talks about the plan", "Paragraph 30 covers the budget");
    const map = new OffsetMap(start, after);
    for (const i of [1, 20, 40, 59]) {
      const at = start.indexOf(`Paragraph ${i} `);
      expect(map.map(at, 1)).toBe(after.indexOf(`Paragraph ${i} `));
    }
    // A comment on words that were rewritten (not deleted) gets no gap.
    const from = start.indexOf("Paragraph 30 ") + "Paragraph 30 ".length;
    const t = thread("t", start.slice(from, from + "talks about the plan".length), start);
    t.anchor = anchorIn(start, from, from + "talks about the plan".length);
    expect(gapAfter(t, start, after, map)).toBeUndefined();
    // Another comment's change, in untouched text, survives the pass.
    const earlier = [{ anchor: anchorIn(start, start.indexOf("Paragraph 20 talks") + 13, start.indexOf("Paragraph 20 talks") + 18), removed: "speaks" }];
    expect(quotes(remapSpans(earlier, start, after, map))).toEqual(["talks"]);
  });

  it("puts a gap for a deleted paragraph where it was, in a long pass", () => {
    const deleted = written.replace(`${para(30)}\n`, "");
    const t = thread("t", para(30), start);
    const gap = gapAfter(t, start, deleted, new OffsetMap(start, deleted))!;
    expect(deleted.slice(0, gap.offset)).toMatch(/Paragraph 29 [^\n]*\n$/);
  });
});

describe("whose turn it is", () => {
  it("is the person's once an agent has answered, or changed the comment's text since they last wrote", () => {
    const t = thread("a", "two", "We hire two people.");
    expect(waitingForPerson(t)).toBe(false);
    const answered = { ...t, messages: [...t.messages, { id: "r", author: { kind: "agent" as const, name: "Claude" }, body: "Done.", created: "2026-11-09T10:05:00.000Z" }] };
    expect(waitingForPerson(answered)).toBe(true);
    expect(waitingForPerson({ ...answered, status: "resolved" })).toBe(false);
    const changed = { ...t, change: { round: 1, agent: "Claude", at: "2026-11-09T10:06:00.000Z", spans: [{ anchor: anchorIn("three", 0, 5), removed: "two" }] } };
    expect(waitingForPerson(changed)).toBe(true);
  });
});
