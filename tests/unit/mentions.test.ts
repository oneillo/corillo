// @ to tag an agent in a comment (Orlando, 2026-11-09: "I want to be able to @
// tag agents in the comments"). The rules behind the list and the tags, and
// whom a tagged comment is for.
import { describe, expect, it } from "vitest";
import {
  FORGET_AFTER_DAYS,
  REMEMBERED,
  baseName,
  filterChoices,
  findTags,
  knownAgents,
  mentionChoices,
  namedAgents,
  remember,
  typingAt,
} from "../../src/core/mentions";
import { addThread, deleteMessage, directionOf, editMessage, reply, type Author } from "../../src/core/comments";
import { mayReply, waitingFor } from "../../src/core/agents";

const AGENTS = ["Claude", "Claude 2", "Writer", "Copy Editor"];
const names = (text: string) => findTags(text, AGENTS).map((t) => t.name);

describe("tags in a comment's words", () => {
  it("finds @Name, where it starts and ends", () => {
    expect(findTags("@Writer tighten this.", AGENTS)).toEqual([{ start: 0, end: 7, name: "Writer" }]);
    expect(findTags("Please, @Claude: shorter.", AGENTS)).toEqual([{ start: 8, end: 15, name: "Claude" }]);
  });

  it("a name typed by hand counts, in any capitals", () => {
    expect(names("@claude make it shorter")).toEqual(["Claude"]);
    expect(names("@WRITER")).toEqual(["Writer"]);
  });

  it("an @ inside a word, such as an email address, isn't a tag", () => {
    expect(names("Write to ana@claude.com about it")).toEqual([]);
    expect(names("ana@Writer")).toEqual([]);
    expect(names("Send it to @claude.com")).toEqual([]);
    expect(names("@claude-code")).toEqual([]);
  });

  it("only a whole name counts: @Claudette isn't Claude, and an unknown name is just words", () => {
    expect(names("@Claudette")).toEqual([]);
    expect(names("@Bob can you look?")).toEqual([]);
  });

  it("finds a tag after letters that change length in small capitals", () => {
    // "İ" in small capitals is two characters: the tag after it was missed.
    expect(findTags("İstanbul office: @Writer please", ["Writer"])).toEqual([{ start: 17, end: 24, name: "Writer" }]);
    expect(findTags("İİİ @writer and @Claude 2", ["Writer", "Claude", "Claude 2"]).map((t) => t.name)).toEqual(["Writer", "Claude 2"]);
  });

  it("the longest name wins: @Claude 2 is Claude 2, not Claude", () => {
    expect(names("@Claude 2 please")).toEqual(["Claude 2"]);
    expect(names("@Copy Editor and @Claude")).toEqual(["Copy Editor", "Claude"]);
  });

  it("punctuation and brackets can sit around a tag", () => {
    expect(names("(@Writer) and @Claude.")).toEqual(["Writer", "Claude"]);
    expect(names("@Writer,@Claude")).toEqual(["Writer", "Claude"]);
  });

  it("lists the different agents named, first named first", () => {
    expect(namedAgents(findTags("@Writer, then @Claude, and @writer again", AGENTS))).toEqual(["Writer", "Claude"]);
  });
});

describe("the name being typed after @", () => {
  it("is what's between the @ and the cursor", () => {
    expect(typingAt("Hi @", 4)).toEqual({ start: 3, query: "" });
    expect(typingAt("Hi @Wri", 7)).toEqual({ start: 3, query: "Wri" });
    expect(typingAt("@Claude 2", 9)).toEqual({ start: 0, query: "Claude 2" });
  });

  it("isn't there for an email address, or an @ on an earlier line", () => {
    expect(typingAt("ana@exa", 7)).toBeNull();
    expect(typingAt("@Writer\nnext", 12)).toBeNull();
    expect(typingAt("No at sign", 10)).toBeNull();
  });
});

describe("what the list offers", () => {
  const onDoc = [
    { name: "Writer", isDefault: false },
    { name: "Claude", isDefault: true },
  ];

  // Orlando (2026-11-09): "distinguish between ones that are currently active right now versus not active".
  it("connected agents first (the document's own first, its default at the top), then the rest, most recently seen first", () => {
    const known = [
      { name: "Reviewer", connected: true },
      { name: "Claude", connected: true },
      { name: "Codex", connected: false },
      { name: "writer", connected: false },
      { name: "Gemini", connected: false },
    ];
    expect(mentionChoices(onDoc, known, ["Copy Editor", "Codex"])).toEqual([
      { name: "Claude", connected: true, isDefault: true },
      { name: "Writer", connected: true, isDefault: false },
      { name: "Reviewer", connected: true, isDefault: false },
      { name: "Codex", connected: false, isDefault: false },
      { name: "Gemini", connected: false, isDefault: false },
      // Named in this document's comments, though Corillo no longer remembers it.
      { name: "Copy Editor", connected: false, isDefault: false },
    ]);
  });

  it("knows nobody when Corillo has met no agents", () => {
    expect(mentionChoices([], [])).toEqual([]);
  });

  it("typing filters it, by the start of the name or of any word in it, in any capitals", () => {
    const all = mentionChoices(onDoc, [
      { name: "Copy Editor", connected: false },
      { name: "Codex", connected: false },
    ]);
    expect(filterChoices(all, "").map((c) => c.name)).toEqual(["Claude", "Writer", "Copy Editor", "Codex"]);
    expect(filterChoices(all, "c").map((c) => c.name)).toEqual(["Claude", "Copy Editor", "Codex"]);
    expect(filterChoices(all, "COD").map((c) => c.name)).toEqual(["Codex"]);
    expect(filterChoices(all, "edi").map((c) => c.name)).toEqual(["Copy Editor"]);
    expect(filterChoices(all, "zz")).toEqual([]);
  });
});

describe("remembered between launches", () => {
  const DAY = 24 * 60 * 60 * 1000;
  const now = Date.UTC(2026, 10, 9, 12);
  const names = (seen: { name: string }[]) => seen.map((s) => s.name);

  it("most recently seen first, each once, without the number a document gave it", () => {
    const known = [
      { name: "Writer", at: now - DAY },
      { name: "Codex", at: now - 2 * DAY },
      { name: "Claude", at: now - 3 * DAY },
    ];
    const after = remember(known, ["Claude 2", "Codex"], now);
    expect(names(after)).toEqual(["Claude", "Codex", "Writer"]);
    expect(after[1].at).toBe(now);
    expect(names(remember([], ["Claude", "Claude 2"], now))).toEqual(["Claude"]);
    expect(baseName("Claude 3")).toBe("Claude");
    expect(baseName("Writer")).toBe("Writer");
    expect(names(remember([], ["Agent 1"], now))).toEqual(["Agent 1"]);
  });

  it("keeps a number that's part of an agent's own name: Reviewer 2 isn't a second Reviewer", () => {
    expect(names(remember([], ["Reviewer 2"], now))).toEqual(["Reviewer 2"]);
    expect(names(remember([{ name: "Writer", at: now - DAY }], ["Reviewer 2"], now))).toEqual(["Reviewer 2", "Writer"]);
    expect(knownAgents([], ["Reviewer 2"])).toEqual([{ name: "Reviewer 2", connected: true }]);
    expect(baseName("Reviewer 2", ["Writer", "Claude"])).toBe("Reviewer 2");
    expect(baseName("Claude 2", ["Writer", "claude"])).toBe("Claude");
  });

  it("keeps a short list: the 12 most recently seen, none not seen for 30 days", () => {
    expect(REMEMBERED).toBe(12);
    expect(FORGET_AFTER_DAYS).toBe(30);
    const many = Array.from({ length: 20 }, (_, i) => ({ name: `Agent ${String.fromCharCode(65 + i)}`, at: now - i * DAY }));
    const after = remember(many, ["New"], now);
    expect(after).toHaveLength(REMEMBERED);
    expect(names(after).slice(0, 3)).toEqual(["New", "Agent A", "Agent B"]);
    const old = [
      { name: "Lately", at: now - 29 * DAY },
      { name: "Long ago", at: now - 31 * DAY },
    ];
    expect(names(remember(old, [], now))).toEqual(["Lately"]);
  });

  it("reads what it wrote, and ignores anything else in the file", () => {
    const file = [{ name: "Writer", at: now - DAY }, "Claude", { name: 3, at: now }, { name: "Codex" }, null] as never[];
    expect(remember(file, [], now)).toEqual([{ name: "Writer", at: now - DAY }]);
  });

  it("the list: agents connected now first, newest connection first, then the remembered ones that aren't", () => {
    const seen = [
      { name: "Writer", at: now - DAY },
      { name: "Claude", at: now - 2 * DAY },
      { name: "Codex", at: now - 3 * DAY },
    ];
    expect(knownAgents(seen, ["Codex", "Claude 2", "Claude", "Reviewer"])).toEqual([
      { name: "Codex", connected: true },
      { name: "Claude", connected: true },
      { name: "Reviewer", connected: true },
      { name: "Writer", connected: false },
    ]);
    expect(knownAgents(seen, [])).toEqual(seen.map((s) => ({ name: s.name, connected: false })));
  });
});

describe("whom a tagged comment is for", () => {
  const me: Author = { kind: "person" };
  const claude: Author = { kind: "agent", name: "Claude" };

  it("a comment that names an agent with @ is for that agent", () => {
    const { thread } = addThread([], me, "@Writer tighten this.", null, null, "Writer");
    expect(thread.to).toBe("Writer");
    expect(thread.messages[0].mention).toBe("Writer");
  });

  it("only the person's words direct a comment: an agent naming another agent changes nothing", () => {
    const { thread } = addThread([], claude, "Should @Writer look?", null, null, "Writer");
    expect(thread.to).toBe("person");
    expect(thread.messages[0].mention).toBeUndefined();
    const threads = reply([thread], thread.id, claude, "@Writer over to you", "Writer");
    expect(threads[0].to).toBe("person");
  });

  it("@ in a reply hands the comment to that agent; a reply without one leaves it where it is", () => {
    let { threads, thread } = addThread([], me, "@Claude tighten this.", null, null, "Claude");
    threads = reply(threads, thread.id, claude, "Done.");
    threads = reply(threads, thread.id, me, "@Writer can you check the tone?", "Writer");
    expect(threads[0].to).toBe("Writer");
    threads = reply(threads, thread.id, me, "And keep it short.");
    expect(threads[0].to).toBe("Writer");
  });

  it("handing over an agent's own question takes it away from that agent", () => {
    let { threads, thread } = addThread([], claude, "Should this section stay?", null, null);
    expect(mayReply(threads[0], "Claude", true)).toBe(true);
    threads = reply(threads, thread.id, me, "@Writer what do you think?", "Writer");
    expect(threads[0].to).toBe("Writer");
    expect(waitingFor(threads[0], "Writer", false)).toBe(true);
    expect(waitingFor(threads[0], "Claude", true)).toBe(false);
    expect(mayReply(threads[0], "Claude", true)).toBe(false);
  });

  it("deleting the tag in an edit takes the direction away again; adding one directs it", () => {
    let { threads, thread } = addThread([], me, "@Writer tighten this.", null, null, "Writer");
    const first = thread.messages[0].id;
    threads = editMessage(threads, thread.id, first, me, "Tighten this.", null);
    expect(threads[0].to).toBeNull();
    expect(threads[0].messages[0].mention).toBeUndefined();
    threads = editMessage(threads, thread.id, first, me, "@Claude tighten this.", "Claude");
    expect(threads[0].to).toBe("Claude");
  });

  it("taking the tag out of the reply that handed it over goes back to the one before", () => {
    let { threads, thread } = addThread([], me, "@Claude tighten this.", null, null, "Claude");
    threads = reply(threads, thread.id, me, "@Writer actually, you.", "Writer");
    const handOver = threads[0].messages[1].id;
    threads = editMessage(threads, thread.id, handOver, me, "Actually, never mind.", null);
    expect(threads[0].to).toBe("Claude");
    threads = editMessage(threads, thread.id, handOver, me, "@Writer actually, you.", "Writer");
    threads = deleteMessage(threads, thread.id, handOver, me);
    expect(threads[0].to).toBe("Claude");
  });

  it("an edit that leaves a comment without tags as it was keeps whom it was for", () => {
    let { threads, thread } = addThread([], me, "Check the numbers.", null, "Writer");
    threads = editMessage(threads, thread.id, thread.messages[0].id, me, "Check the numbers again.", null);
    expect(threads[0].to).toBe("Writer");
  });

  it("with no tags, an agent's own comment is for the person and the person's for the default agent", () => {
    expect(directionOf({ messages: [{ id: "1", author: claude, body: "Q?", created: "" }] })).toBe("person");
    expect(directionOf({ messages: [{ id: "1", author: me, body: "Fix.", created: "" }] })).toBeNull();
  });
});
