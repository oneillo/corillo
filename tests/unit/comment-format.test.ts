import { describe, expect, it } from "vitest";
import type { Thread } from "../../src/core/comments";
import {
  agentNames,
  agentsNamedIn,
  cardName,
  changedBeyondComments,
  countLabel,
  doneWords,
  namesList,
  orderThreads,
  type PassDone,
  recipientLabel,
  relativeTime,
  toLabel,
} from "../../src/renderer/comment-format";

const at = (y: number, mo: number, d: number, h = 12, mi = 0) => new Date(y, mo - 1, d, h, mi);

describe("when a comment was written", () => {
  const now = at(2026, 11, 8, 15, 0);
  const said = (when: Date) => relativeTime(when.toISOString(), now);

  it("says Just now for the last minute, then minutes, then hours", () => {
    expect(said(at(2026, 11, 8, 14, 59))).toBe("1 min ago");
    expect(said(new Date(now.getTime() - 20_000))).toBe("Just now");
    expect(said(at(2026, 11, 8, 14, 55))).toBe("5 min ago");
    expect(said(at(2026, 11, 8, 14, 1))).toBe("59 min ago");
    expect(said(at(2026, 11, 8, 14, 0))).toBe("1 hour ago");
    expect(said(at(2026, 11, 8, 9, 30))).toBe("5 hours ago");
  });

  it("says Yesterday for the day before, even late at night, with the time", () => {
    expect(relativeTime(at(2026, 11, 7, 23, 0).toISOString(), now, "en-US")).toBe("Yesterday, 11:00 PM");
    expect(relativeTime(at(2026, 11, 7, 6, 0).toISOString(), now, "en-US")).toBe("Yesterday, 6:00 AM");
  });

  it("just after midnight, a comment from a few minutes ago is still minutes ago", () => {
    expect(relativeTime(at(2026, 11, 7, 23, 58).toISOString(), at(2026, 11, 8, 0, 3))).toBe("5 min ago");
  });

  it("names the weekday within the last week, then the date, each with the time", () => {
    const inUS = (when: Date) => relativeTime(when.toISOString(), now, "en-US");
    expect(inUS(at(2026, 11, 4, 9, 5))).toBe("Wednesday, 9:05 AM");
    expect(inUS(at(2026, 10, 20))).toBe("Oct 20, 12:00 PM");
    expect(inUS(at(2025, 3, 2))).toBe("Mar 2, 2025, 12:00 PM");
  });

  it("shows nothing for a date it can't read", () => {
    expect(relativeTime("not a date", now)).toBe("");
  });
});

let n = 0;
function thread(body: string, options: Partial<Thread> & { quote?: string } = {}): Thread {
  n++;
  const { quote, ...rest } = options;
  return {
    id: `t${n}`,
    anchor: quote === undefined ? null : { quote, prefix: "", suffix: "", offset: 0 },
    to: null,
    status: "open",
    messages: [{ id: `m${n}`, author: { kind: "person" }, body, created: `2026-11-08T10:00:0${n % 10}Z` }],
    ...rest,
  };
}

describe("the order of comments in the panel (spec.md, Comments; S21-26)", () => {
  it("puts whole-document comments first, then ones whose text can't be found, then comments on text in reading order", () => {
    const late = thread("on the last line", { quote: "end" });
    const whole = thread("about everything");
    const early = thread("on the first line", { quote: "start" });
    const lost = thread("text gone", { quote: "gone" });
    const whole2 = thread("another overall note");
    const positions: Record<string, number> = { [late.id]: 900, [early.id]: 12 };
    const order = orderThreads([late, whole, early, lost, whole2], (id) => positions[id] ?? null);
    expect(order.map((t) => t.messages[0].body)).toEqual([
      "about everything",
      "another overall note",
      "text gone",
      "on the first line",
      "on the last line",
    ]);
  });
});

describe("who a comment is for", () => {
  it("says To and the agent's name on the person's comments for a particular agent", () => {
    expect(toLabel(thread("Polish this.", { to: "Writer" }))).toBe("To Writer");
  });

  it("says nothing when the comment goes to the default agent, or comes from an agent", () => {
    expect(toLabel(thread("Anyone?", { to: null }))).toBeNull();
    const fromAgent = thread("A question for you.", { to: "person" });
    fromAgent.messages[0].author = { kind: "agent", name: "Claude" };
    expect(toLabel(fromAgent)).toBeNull();
  });

  // Orlando, 2026-11-09: @ to tag an agent, which replaced the To menu.
  it("says To beside each of the person's messages that named an agent with @", () => {
    const t = thread("@Claude tighten this.", { to: "Writer" });
    t.messages[0].mention = "Claude";
    t.messages.push(
      { id: "a", author: { kind: "agent", name: "Claude" }, body: "Done.", created: "" },
      { id: "b", author: { kind: "person" }, body: "@Writer can you check the tone?", created: "", mention: "Writer" },
      { id: "c", author: { kind: "person" }, body: "Thanks.", created: "" },
    );
    expect(t.messages.map((_, i) => recipientLabel(t, i))).toEqual(["To Claude", null, "To Writer", null]);
  });

  it("a comment directed without a tag still says To beside its first message; one for the default agent says nothing", () => {
    expect(recipientLabel(thread("Polish this.", { to: "Writer" }), 0)).toBe("To Writer");
    expect(recipientLabel(thread("Anyone?", { to: null }), 0)).toBeNull();
  });

  it("knows every agent a document's comments name, for the @ list", () => {
    const a = thread("@Writer have a look.", { to: "Writer" });
    a.messages[0].mention = "Writer";
    const b = thread("A question for you.", { to: "person" });
    b.messages[0].author = { kind: "agent", name: "Codex" };
    const c = thread("Old comment.", { to: "Claude 2" });
    expect(agentsNamedIn([a, b, c]).sort()).toEqual(["Claude 2", "Codex", "Writer"]);
  });
});

describe("agents on a document", () => {
  it("lists agents who wrote in the comments, then the ones connected", () => {
    const t = thread("Q");
    t.messages.push({ id: "x", author: { kind: "agent", name: "Writer" }, body: "A", created: "" });
    expect(agentNames([t], [{ name: "Claude", isDefault: true }, { name: "Writer", isDefault: false }])).toEqual([
      "Writer",
      "Claude",
    ]);
  });
});

describe("words on the panel", () => {
  it("counts open comments for the status bar, or resolved ones when none are open", () => {
    expect(countLabel(1, 0)).toBe("1 comment");
    expect(countLabel(3, 2)).toBe("3 comments");
    expect(countLabel(0, 2)).toBe("2 resolved");
    expect(countLabel(0, 0)).toBe("");
  });
});

// Orlando, 2026-11-09: no Review button when an agent is done; a status line
// says so and hands the document back. Kept short (the lead's version he
// agreed to): "Claude is done. Back to you. 3 comments to read."
describe("the line at the top when an agent is done", () => {
  const pass = (agent: string, more: Partial<PassDone> = {}): PassDone => ({ agent, answered: 0, other: false, endedBy: "agent", ...more });
  const waiting = (comments: number) => ({ comments });

  it("names the agent, hands the document back, and says how many comments there are to read", () => {
    expect(doneWords([pass("Claude", { answered: 3 })], waiting(3))).toEqual({
      lead: "Claude is done. Back to you.",
      detail: "3 comments to read.",
    });
    expect(doneWords([pass("Claude", { answered: 1 })], waiting(1)).detail).toBe("1 comment to read.");
  });

  // Roadmap Batch 9, item 5: the panel holds comments only, so the line counts no chat request or other changes as cards to read.
  it("counts only comments and notes: a chat request or changes tied to no comment are no card to read", () => {
    expect(doneWords([pass("Claude", { request: "Tighten the intro.", other: true })], waiting(0))).toEqual({
      lead: "Claude is done. Back to you.",
      detail: "",
    });
    expect(doneWords([pass("Claude", { answered: 2, other: true })], waiting(2)).detail).toBe("2 comments to read.");
  });

  it("tells when a pass changed the document beyond the comments, so the line can lead to its changes", () => {
    expect(changedBeyondComments([pass("Claude", { answered: 1 })])).toBe(false);
    expect(changedBeyondComments([pass("Claude", { other: true })])).toBe(true);
    expect(changedBeyondComments([pass("Claude", { request: "Shorter.", other: true })])).toBe(true);
    expect(changedBeyondComments([pass("Writer", { answered: 1 }), pass("Claude", { other: true })])).toBe(true);
    // A round that found nothing changed nothing.
    expect(changedBeyondComments([pass("Claude 2", { other: true, nothingFor: { comments: 1, agents: ["Claude"], given: true } })])).toBe(false);
  });

  it("counts the agent's note last, the way the roadmap words it (Batch 2, item 3): 6 comments and a note", () => {
    expect(doneWords([pass("Claude", { answered: 6 })], { ...waiting(6), notes: 1 }).detail).toBe("6 comments and a note to read.");
    expect(doneWords([pass("Claude")], { ...waiting(0), notes: 1 }).detail).toBe("A note to read.");
    expect(doneWords([pass("Claude")], { ...waiting(1), notes: 2 }).detail).toBe("1 comment and 2 notes to read.");
  });

  it("in a round where one agent did a pass and another then found nothing, the first's done still leads, and the nothing goes in the detail (B3-R12)", () => {
    const nothing = pass("Claude 2", { nothingFor: { comments: 2, agents: ["Claude"], given: true } });
    expect(doneWords([pass("Writer", { answered: 1 }), nothing], waiting(1))).toEqual({
      lead: "Writer is done. Back to you.",
      detail: "Claude 2 found nothing addressed to it. 2 comments are waiting for Claude. 1 comment to read.",
    });
    expect(doneWords([pass("Writer", { answered: 1 }), pass("Codex", { answered: 1 }), nothing], waiting(2)).lead).toBe("Writer and Codex are done. Back to you.");
    // On its own, the empty round explains itself, as before.
    expect(doneWords([nothing], waiting(0))).toEqual({ lead: "Claude 2 found nothing addressed to it.", detail: "2 comments are waiting for Claude." });
  });

  it("two agents finishing one after the other read as one line, counting everything left to read", () => {
    const both = doneWords([pass("Claude", { answered: 1 }), pass("Writer", { answered: 2, other: true })], waiting(3));
    expect(both.lead).toBe("Claude and Writer are done. Back to you.");
    expect(both.detail).toBe("3 comments to read.");
    expect(doneWords([pass("A"), pass("B"), pass("C")], waiting(0)).lead).toBe("A, B and C are done. Back to you.");
  });

  it("with nothing left to read, just hands the document back", () => {
    expect(doneWords([pass("Claude", { answered: 2 })], waiting(0))).toEqual({ lead: "Claude is done. Back to you.", detail: "" });
  });

  it("says when the person took over, or the agent's session ended", () => {
    expect(doneWords([pass("Claude", { endedBy: "person" })], waiting(0)).lead).toBe("You took over from Claude.");
    expect(doneWords([pass("Claude", { endedBy: "person" })], waiting(2)).detail).toBe("2 comments to read.");
    expect(doneWords([pass("Claude", { endedBy: "session-ended" })], waiting(0)).lead).toBe("Claude's session ended. Back to you.");
  });

  it("says nothing when no pass has ended", () => {
    expect(doneWords([], waiting(3))).toEqual({ lead: "", detail: "" });
    expect(namesList(["Claude"])).toBe("Claude");
    expect(namesList(["Claude", "Writer"])).toBe("Claude and Writer");
  });
});

describe("a card as a screen reader names it", () => {
  it("says who wrote it, the words it's on and whose turn it is", () => {
    expect(cardName(thread("Is two enough?", { quote: "two people" }), "Waiting for Claude")).toBe("Comment by You on “two people”, waiting for Claude");
    const fromAgent = thread("Should this say June?", { quote: "in May", to: "person" });
    fromAgent.messages[0].author = { kind: "agent", name: "Writer" };
    expect(cardName(fromAgent, "Waiting for you")).toBe("Comment by Writer on “in May”, waiting for you");
  });

  it("says the whole document for a comment on no words, and resolved once it's done", () => {
    expect(cardName(thread("Tighten it overall."), "Waiting for an agent")).toBe("Comment by You on the whole document, waiting for an agent");
    expect(cardName(thread("Done.", { quote: "the budget", status: "resolved" }), null)).toBe("Comment by You on “the budget”, resolved");
  });

  it("keeps long words short, on one line", () => {
    const long = "We should hire two people this spring,\nand a third once the budget for the autumn is agreed by everyone";
    expect(cardName(thread("Too much?", { quote: long }), null)).toBe(
      "Comment by You on “We should hire two people this spring, and a third once the…”",
    );
  });
});
