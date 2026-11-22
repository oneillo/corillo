// Where a closed document stands, under its start-screen card (roadmap Batch
// 4, item 3; P-6). Read from what Corillo keeps on disk, and said in the words
// the document's own comment cards use once it's open, so the two never
// disagree: what waits for the person, and comments for an agent not sent yet.
// A document no agent has been on says nothing.
import { describe, expect, it } from "vitest";
import { waitingForPerson, type Message, type PassNote, type Thread } from "../../src/core/comments";
import { standingOf, type Standing } from "../../src/main/doc-standing";
import { turnLabel } from "../../src/renderer/comment-format";
import { standingWords, waitingFirst } from "../../src/renderer/start-screen";

const person = (body: string, created = "2026-11-10T09:00:00.000Z"): Message => ({ id: body, author: { kind: "person" }, body, created });
const agent = (name: string, body: string, created = "2026-11-10T10:00:00.000Z"): Message => ({ id: body, author: { kind: "agent", name }, body, created });

function thread(messages: Message[], extra: Partial<Thread> = {}): Thread {
  return { id: messages[0].id, anchor: null, to: null, status: "open", messages, ...extra };
}

const note = (agentName: string): PassNote => ({ id: `note-${agentName}`, agent: agentName, text: "Read the summary first.", at: "2026-11-10T10:00:00.000Z" });

describe("where a closed document stands", () => {
  // A chat request or changes tied to no comment have no card any more (roadmap Batch 9, item 5), so they aren't counted.
  it("counts the comments an agent answered and its notes: what waits for the person", () => {
    const answered = thread([person("Shorter?"), agent("Claude", "Done.")]);
    const changedSince = thread([person("Fix the date.")], { change: { round: 1, agent: "Claude", at: "2026-11-10T11:00:00.000Z", spans: [{ anchor: { quote: "x", before: "", after: "" }, removed: "y" }] } as unknown as Thread["change"] });
    const resolved = thread([person("Old."), agent("Claude", "Fixed.")], { status: "resolved" });
    const s = standingOf([answered, changedSince, resolved], [note("Claude")]);
    expect(s?.waiting).toEqual({ comments: 2, notes: 1 });
    // The same comments the panel marks "Waiting for you".
    expect([answered, changedSince, resolved].filter(waitingForPerson)).toHaveLength(2);
  });

  it("counts the person's comments for an agent that haven't gone to it, by agent", () => {
    const forClaude = thread([person("@Claude shorter?")], { to: "Claude" });
    const forWriter = thread([person("Tone?")], { to: "Writer" });
    // An agent started it, the person answered last: it's that agent's.
    const startedByCodex = thread([agent("Codex", "Which date?"), person("Friday.")], { to: "person" });
    const s = standingOf([forClaude, forWriter, startedByCodex], []);
    expect(s?.notSent).toEqual({ Claude: 1, Writer: 1, Codex: 1 });
    expect(s?.waiting).toEqual({ comments: 0, notes: 0 });
  });

  it("says nothing for a document no agent has been on, however many of the person's own comments it has", () => {
    expect(standingOf([thread([person("A note to self.")]), thread([person("Another.")])], [])).toBeNull();
    expect(standingOf([], [])).toBeNull();
    // Once an agent has written in its comments, a comment named for no one is counted too.
    const s = standingOf([thread([person("A note to self.")]), thread([person("Old."), agent("Claude", "Done.")], { status: "resolved" })], []);
    expect(s?.notSent).toEqual({ "": 1 });
  });

  it("says nothing when an agent has been on it and nothing waits for anyone", () => {
    expect(standingOf([thread([person("Old."), agent("Claude", "Done.")], { status: "resolved" })], [])).toBeNull();
  });

  it("with an agent still on the document since its tab closed, a comment with no @ is for that agent, as its card says inside", () => {
    const unnamed = thread([person("Shorter?")]);
    const claude = { name: "Claude", isDefault: true, editing: false };
    const s = standingOf([unnamed], [], [claude]);
    expect(s?.notSent).toEqual({ Claude: 1 });
    expect(standingWords(s!)?.text).toBe("1 comment for Claude, not sent yet");
    expect(turnLabel(unnamed, [claude], false)).toBe("For Claude, not sent yet");
  });
});

const standing = (s: { notSent?: Standing["notSent"]; waiting?: Partial<Standing["waiting"]> }): Standing => ({
  notSent: s.notSent ?? {},
  waiting: { comments: 0, notes: 0, ...s.waiting },
});

describe("the words under a card", () => {
  it("say what waits for the person, as the done line counts it, and the comment cards' Waiting for you", () => {
    expect(standingWords(standing({ waiting: { comments: 3 } }))?.text).toBe("3 comments waiting for you");
    expect(standingWords(standing({ waiting: { comments: 1 } }))?.text).toBe("1 comment waiting for you");
    expect(standingWords(standing({ waiting: { comments: 2, notes: 1 } }))?.text).toBe("2 comments and a note waiting for you");
    expect(standingWords(standing({ waiting: { notes: 1 } }))?.text).toBe("A note waiting for you");
  });

  it("say which agent the person's comments are for and that they aren't sent, as each card does", () => {
    expect(standingWords(standing({ notSent: { Claude: 2 } }))?.text).toBe("2 comments for Claude, not sent yet");
    expect(standingWords(standing({ notSent: { Claude: 1 } }))?.text).toBe("1 comment for Claude, not sent yet");
    expect(standingWords(standing({ notSent: { Claude: 1, Writer: 2 } }))?.text).toBe("3 comments for Claude and Writer, not sent yet");
    expect(standingWords(standing({ notSent: { "": 2 } }))?.text).toBe("2 comments not sent to an agent yet");
    expect(standingWords(standing({ notSent: { Claude: 1, "": 1 } }))?.text).toBe("2 comments not sent yet");
  });

  it("agree with the card each comment shows once the document is open", () => {
    // No agent on it: a comment with no @ isn't for anyone yet.
    const unnamed = thread([person("Shorter?")]);
    const done = thread([person("Old."), agent("Claude", "Done.")], { status: "resolved" });
    const s = standingOf([unnamed, done], [])!;
    const card = turnLabel(unnamed, [], waitingForPerson(unnamed))!; // "Not sent to an agent yet"
    expect(standingWords(s)?.text).toBe(`1 comment ${card[0].toLowerCase()}${card.slice(1)}`);
    const answered = thread([person("Shorter?"), agent("Claude", "Done.")]);
    expect(turnLabel(answered, [], waitingForPerson(answered))).toBe("Waiting for you");
    expect(standingWords(standingOf([answered], [])!)?.text).toBe("1 comment waiting for you");
  });

  it("lead with what waits for the person, and give the rest in the tooltip", () => {
    const words = standingWords(standing({ waiting: { comments: 3 }, notSent: { Claude: 2 } }));
    expect(words).toEqual({ text: "3 comments waiting for you", title: "3 comments waiting for you · 2 comments for Claude, not sent yet", waiting: true });
    expect(standingWords(standing({ notSent: { Claude: 2 } }))?.waiting).toBe(false);
    expect(standingWords(standing({}))).toBeNull();
  });
});

describe("the order of the cards", () => {
  const card = (name: string, s: Standing | null) => ({ name, standing: s });
  it("puts the documents waiting for the person first, each group most recent first, as the list has them", () => {
    const cards = [
      card("a", null),
      card("b", standing({ notSent: { Claude: 1 } })),
      card("c", standing({ waiting: { comments: 1 } })),
      card("d", null),
      card("e", standing({ waiting: { notes: 1 } })),
    ];
    expect(waitingFirst(cards).map((c) => c.name)).toEqual(["c", "e", "a", "b", "d"]);
  });
});
