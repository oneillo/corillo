// Comments go to the agent you told (roadmap Batch 3, item 3; A-2; decision
// D3). A comment with no @ goes to the first agent that picks comments up
// after the person wrote it, not to whichever session looked at the document
// first; an agent with a role name (Writer) still takes only its @ comments
// while another agent is on the document. A new chat shows as plain "Claude"
// when no other Claude is in a round, and a round that finds nothing says why.
import { beforeEach, describe, expect, it } from "vitest";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import * as path from "node:path";
import { AgentService, anchorForQuote, type AgentDoc, type AgentHooks, type AgentHost, type AgentInfo, type PassSummary } from "../../src/main/agents/agent-service";
import { AgentError } from "../../src/main/agents/shapes";
import { CommentService } from "../../src/main/comment-service";
import { DocumentStore } from "../../src/main/store";
import { VersionHistory } from "../../src/main/version-store";
import { waitingForPerson, type Thread } from "../../src/core/comments";
import { pickedUpBy, picksUpUnnamed, Roster } from "../../src/core/agents";
import { doneWords, handBackFor, turnLabel } from "../../src/renderer/comment-format";

const PLAN = "/docs/plan.md";
const PLAN_TEXT = "# Plan\n\nWe should hire two people this quarter.\n\n## Budget\n\nThe budget is tight.\n";

/** Stands in for Corillo's window and the files on disk. */
class FakeCorillo implements AgentHost {
  files = new Map<string, string>([[PLAN, PLAN_TEXT]]);
  docs: AgentDoc[] = [];
  picturesWait(): void {}
  agents = new Map<string, AgentInfo[]>();
  summaries: PassSummary[] = [];
  constructor(readonly history: VersionHistory) {}
  find(p: string) {
    return this.docs.find((d) => d.filePath === p) ?? null;
  }
  open(p: string) {
    if (!this.files.has(p)) throw new AgentError(`There's no file at ${p}.`);
    const doc = { id: `tab-${this.docs.length + 1}`, storeId: path.basename(p, ".md"), filePath: p };
    this.docs.push(doc);
    this.history.seen(doc.storeId, this.files.get(p)!);
    return doc;
  }
  openDocs() {
    return this.docs;
  }
  byStoreId(storeId: string) {
    return this.docs.find((d) => d.storeId === storeId) ?? null;
  }
  read(doc: AgentDoc) {
    return this.files.get(doc.filePath)!;
  }
  write(doc: AgentDoc, text: string) {
    this.files.set(doc.filePath, text);
    this.history.edited(doc.storeId, text);
  }
  create(p: string, text: string) {
    this.files.set(p, text);
  }
  async flush() {
    return "saved" as const;
  }
  announce(storeId: string, agents: AgentInfo[]) {
    this.agents.set(storeId, agents);
  }
  backToYou() {}
  kindOf(p: string) {
    return this.files.has(p) ? ("file" as const) : p === "/docs" ? ("folder" as const) : null;
  }
  async exportDocument(): Promise<{ outputPath: string; notes: string[] }> {
    throw new AgentError("Not here.");
  }
  passEnded(_storeId: string, summary: PassSummary) {
    this.summaries.push(summary);
  }
}

let corillo: FakeCorillo;
let comments: CommentService;
let service: AgentService;

const hooks: AgentHooks = {
  beginPass: (storeId, name) => corillo.history.beginPass(storeId, name),
  endPass: (storeId, info) => void corillo.history.endPass(storeId, { addressed: info.addressed, other: info.other, request: info.request, note: info.note }),
  versions: (storeId) => corillo.history.list(storeId),
  versionText: (storeId, n) => corillo.history.text(storeId, n),
};

beforeEach(() => {
  const data = mkdtempSync(path.join(tmpdir(), "corillo-told-"));
  corillo = new FakeCorillo(new VersionHistory(data));
  comments = new CommentService(new DocumentStore(data), () => {});
  service = new AgentService(corillo, comments, hooks, { waitMs: 0 });
});

function connect(client = "claude-code", introduced?: string, options: { canWait?: boolean } = {}) {
  const { sessionId } = service.connect({ name: client }, introduced, options);
  const call = (tool: string, args: Record<string, unknown> = {}) => service.call(sessionId, tool, args);
  const ok = async (tool: string, args: Record<string, unknown> = {}) => {
    const r = await call(tool, args);
    if (r.isError) throw new Error(`${tool} failed: ${r.text}`);
    return r.text;
  };
  return { sessionId, call, ok, end: () => service.disconnect(sessionId) };
}

const person = { kind: "person" } as const;
function personComments(body: string, quote: string | null, to: string | null = null): Thread {
  const anchor = quote ? anchorForQuote(corillo.files.get(PLAN)!, quote) : null;
  return comments.add("plan", person, body, anchor, to);
}
const idOf = (t: Thread) => t.id.slice(0, 8);
const names = () => (corillo.agents.get("plan") ?? []).map((a) => a.name);
/** What each card says now, as the window works it out from what it's told. */
const cards = () => {
  const agents = corillo.agents.get("plan") ?? [];
  return comments.threads("plan").map((t) => turnLabel(t, agents, waitingForPerson(t)));
};

describe("a comment with no @ goes to the agent you told", () => {
  it("an old session opened the document; a new session takes it and gets both comments; the old one gets none", async () => {
    const yesterday = connect(); // left open from an earlier chat: the first to look
    await yesterday.ok("open_document", { path: PLAN });
    const hire = personComments("Make this three people.", "two people");
    const budget = personComments("And say by how much.", "tight");
    // Nobody has them yet: they're for Claude, not sent.
    expect(cards()).toEqual(["For Claude, not sent yet", "For Claude, not sent yet"]);
    const today = connect(); // the chat the person told
    const taken = await today.ok("take_document", { path: PLAN });
    expect(taken).toContain("2 comments on plan.md waiting for you");
    expect(taken).toContain(`[${idOf(hire)}]`);
    expect(taken).toContain(`[${idOf(budget)}]`);
    expect(taken).not.toContain("another session");
    // The old session gets none of them, and is told where they went.
    const old = await yesterday.ok("list_comments", { path: PLAN });
    expect(old).toContain("No comments on plan.md are waiting for you.");
    expect(old).toContain("2 comments on plan.md have no @ and went to Claude, another session that picked them up first.");
    // The window says who has them: the session the person told, shown as plain Claude.
    expect(cards()).toEqual(["Sent to Claude", "Sent to Claude"]);
    await today.ok("reply_to_comment", { path: PLAN, comment_id: idOf(hire), text: "Done." });
    expect((await yesterday.call("reply_to_comment", { path: PLAN, comment_id: idOf(budget), text: "Mine?" })).text).toContain("isn't addressed to you");
  });

  it("a new chat shows as plain Claude when no other Claude is in a round; the old one is numbered", async () => {
    const yesterday = connect();
    await yesterday.ok("open_document", { path: PLAN });
    expect(names()).toEqual(["Claude"]);
    const today = connect();
    const opened = await today.ok("open_document", { path: PLAN });
    expect(opened).not.toContain("Your comments there show as");
    expect(new Set(names())).toEqual(new Set(["Claude", "Claude 2"]));
    const byName = new Map((corillo.agents.get("plan") ?? []).map((a) => [a.name, a]));
    // Each name keeps its colour: plain Claude is still peach.
    expect(byName.get("Claude")!.colour).toBe("peach");
    // The old session, looking again, hears its new name.
    expect(await yesterday.ok("read_document", { path: PLAN })).toBeTruthy();
    expect(await yesterday.ok("open_document", { path: PLAN })).toContain("Your comments there show as Claude 2.");
  });

  it("a new chat is Claude 2 while the other Claude is in a round (editing, or waiting for the review)", async () => {
    const working = connect();
    await working.ok("take_document", { path: PLAN });
    const second = connect();
    expect(await second.ok("open_document", { path: PLAN })).toContain("Your comments there show as Claude 2.");
    await working.ok("finish_editing", { path: PLAN });

    // Waiting for the review counts too.
    const data = mkdtempSync(path.join(tmpdir(), "corillo-told-"));
    corillo = new FakeCorillo(new VersionHistory(data));
    comments = new CommentService(new DocumentStore(data), () => {});
    service = new AgentService(corillo, comments, hooks, { waitMs: 0 });
    const waiting = connect("claude-code", undefined, { canWait: true });
    await waiting.ok("open_document", { path: PLAN });
    const wait = waiting.call("wait_for_review", { canHold: true });
    await new Promise((r) => setTimeout(r, 0));
    const another = connect();
    expect(await another.ok("open_document", { path: PLAN })).toContain("Your comments there show as Claude 2.");
    await waiting.end();
    await wait;
  });

  it("names move only when a new chat arrives, never at a take: a comment the person addressed to Claude 2 stays with that session", async () => {
    const working = connect();
    await working.ok("take_document", { path: PLAN });
    const second = connect();
    await second.ok("open_document", { path: PLAN }); // Claude 2: the first is editing
    await working.ok("finish_editing", { path: PLAN });
    const t = personComments("Check the budget.", "tight", "Claude 2");
    const taken = await second.ok("take_document", { path: PLAN });
    expect(taken).toContain(`[${idOf(t)}]`);
    expect(corillo.agents.get("plan")!.find((x) => x.editing)!.name).toBe("Claude 2");
    expect(await working.ok("list_comments", { path: PLAN })).not.toContain(`[${idOf(t)}]`);
    await second.ok("finish_editing", { path: PLAN }).catch(() => "");
  });

  it("the person's reply on a comment an old session answered goes to the agent told next", async () => {
    const yesterday = connect();
    const hire = personComments("Make this three people.", "two people");
    await yesterday.ok("take_document", { path: PLAN });
    await yesterday.ok("reply_to_comment", { path: PLAN, comment_id: idOf(hire), text: "Done: three." });
    await yesterday.ok("finish_editing", { path: PLAN });
    comments.reply("plan", hire.id, person, "Make it four.");
    const today = connect();
    const taken = await today.ok("take_document", { path: PLAN });
    expect(taken).toContain(`[${idOf(hire)}]`);
    expect(taken).toContain("Person: Make it four.");
    expect(await yesterday.ok("list_comments", { path: PLAN })).toContain("No comments on plan.md are waiting for you.");
  });

  it("a comment one agent picked up isn't given to another agent; the next comment goes to whoever looks first", async () => {
    const a = connect();
    const b = connect("codex-mcp-client");
    const first = personComments("Tighten this.", "two people");
    expect(await a.ok("list_comments", { path: PLAN })).toContain(`[${idOf(first)}]`);
    const second = personComments("And this.", "tight");
    const codex = await b.ok("list_comments", { path: PLAN });
    expect(codex).not.toContain(`[${idOf(first)}]`);
    expect(codex).toContain(`[${idOf(second)}]`);
    expect(await a.ok("list_comments", { path: PLAN })).not.toContain(`[${idOf(second)}]`);
    // The cards name who has each.
    expect(cards()).toEqual(["Sent to Claude", "Sent to Codex"]);
  });

  it("a comment left for the next pass goes to whoever picks comments up first", async () => {
    const a = connect();
    const t = personComments("Tighten this.", "two people");
    await a.ok("take_document", { path: PLAN });
    await a.call("finish_editing", { path: PLAN }); // pointed out
    await a.ok("finish_editing", { path: PLAN }); // left for the next pass
    expect(cards()).toEqual(["For Claude, not sent yet"]);
    const b = connect("codex-mcp-client");
    expect(await b.ok("list_comments", { path: PLAN })).toContain(`[${idOf(t)}]`);
  });

  it("a session remembers its own rounds (to tell them from another session's) on at most 20 documents, and nothing once it ends", async () => {
    const claude = connect();
    for (let i = 0; i < 25; i++) {
      const p = `/docs/d${i}.md`;
      corillo.files.set(p, "# D\n\nText.\n");
      await claude.ok("take_document", { path: p });
      await claude.ok("edit_document", { path: p, edits: [{ find: "Text.", replace: "Text, edited." }] });
      await claude.ok("finish_editing", { path: p });
    }
    expect(service.sizes().rounds).toBe(20);
    await claude.end();
    expect(service.sizes().rounds).toBe(0);
  }, 20_000); // heavy: almost 3 seconds beside a full run (Batch 6)

  it("a session that ends lets go of what it picked up", async () => {
    const a = connect();
    const t = personComments("Tighten this.", "two people");
    await a.ok("list_comments", { path: PLAN });
    await a.end();
    const b = connect("codex-mcp-client");
    expect(await b.ok("list_comments", { path: PLAN })).toContain(`[${idOf(t)}]`);
  });
});

// Roadmap Batch 6 (B3-R10): when a new chat takes the name Claude, the person's answer on a comment the old
// chat started goes to the old chat, as a reply in a Word comment is for whoever started it, while that chat
// is still on the document; once it has gone, to the chat that has the name now.
describe("the person's answer on a comment an agent started goes to the chat that started it", () => {
  /** Yesterday's chat asks the person something in a comment, and its round ends. */
  async function asked() {
    const yesterday = connect();
    await yesterday.ok("take_document", { path: PLAN });
    const added = await yesterday.ok("add_comment", { path: PLAN, text: "Should this be four?", quote: "two people" });
    await yesterday.ok("finish_editing", { path: PLAN });
    const id = /\[([0-9a-f]+)\]/.exec(added)![1];
    return { yesterday, id };
  }
  const answer = (id: string) => comments.reply("plan", comments.threads("plan").find((t) => t.id.startsWith(id))!.id, person, "Yes, four.");

  async function goesToYesterday(yesterday: ReturnType<typeof connect>, today: ReturnType<typeof connect>, id: string) {
    expect(new Set(names())).toEqual(new Set(["Claude", "Claude 2"])); // the new chat took the plain name
    const theirs = await yesterday.ok("list_comments", { path: PLAN });
    expect(theirs).toContain(`[${id}]`);
    expect(theirs).toContain("Person: Yes, four.");
    expect(await today.ok("take_document", { path: PLAN })).not.toContain(`[${id}]`);
    expect((await today.call("reply_to_comment", { path: PLAN, comment_id: id, text: "Four it is." })).text).toContain("isn't addressed to you");
    await today.ok("finish_editing", { path: PLAN });
    // Its round found nothing for it, and the window says whom the answer waits for.
    expect(corillo.summaries.at(-1)?.nothingFor).toMatchObject({ comments: 1, agents: ["Claude 2"] });
    // The card names the chat that has it now: the old one, numbered.
    expect(cards()).toEqual(["Sent to Claude 2"]);
    await yesterday.ok("reply_to_comment", { path: PLAN, comment_id: id, text: "Four it is." });
  }

  it("answered before the new chat arrived", async () => {
    const { yesterday, id } = await asked();
    answer(id);
    expect(cards()).toEqual(["For Claude, not sent yet"]);
    const today = connect();
    await today.ok("open_document", { path: PLAN });
    expect(cards()).toEqual(["For Claude 2, not sent yet"]);
    await goesToYesterday(yesterday, today, id);
  });

  it("answered after the new chat arrived", async () => {
    const { yesterday, id } = await asked();
    const today = connect();
    await today.ok("open_document", { path: PLAN });
    answer(id);
    expect(cards()).toEqual(["For Claude 2, not sent yet"]);
    await goesToYesterday(yesterday, today, id);
  });

  // Review of Batch 6, B6-R07: closing the tab doesn't forget which comments the old chat started while it's still on
  // the document. (Before, once the tab closed and opened again, the answer went to the new chat.)
  it("answered after the tab was closed and opened again", async () => {
    const { yesterday, id } = await asked();
    const today = connect();
    await today.ok("open_document", { path: PLAN });
    corillo.docs = [];
    await service.closed("plan", PLAN);
    corillo.open(PLAN);
    answer(id);
    await goesToYesterday(yesterday, today, id);
  });

  it("the person can hand it to the new chat by replying with @Claude", async () => {
    const { yesterday, id } = await asked();
    const today = connect();
    await today.ok("open_document", { path: PLAN });
    const t = comments.threads("plan").find((x) => x.id.startsWith(id))!;
    comments.reply("plan", t.id, person, "@Claude, you do it.", "Claude");
    expect(cards()).toEqual(["For Claude, not sent yet"]);
    expect(await today.ok("take_document", { path: PLAN })).toContain(`[${id}]`);
    expect(await yesterday.ok("list_comments", { path: PLAN })).not.toContain(`[${id}]`);
  });

  it("once the chat that started it has gone, it goes to the chat that has its name now, as before", async () => {
    const { yesterday, id } = await asked();
    const today = connect();
    await today.ok("open_document", { path: PLAN });
    answer(id);
    await yesterday.end();
    expect(cards()).toEqual(["For Claude, not sent yet"]);
    expect(await today.ok("take_document", { path: PLAN })).toContain(`[${id}]`);
    await today.ok("reply_to_comment", { path: PLAN, comment_id: id, text: "Four it is." });
  });
});

describe("an agent with a role name", () => {
  it("Writer takes only its @ comments while another agent is on the document; on its own, it takes those with no @ too", async () => {
    const claude = connect();
    await claude.ok("open_document", { path: PLAN });
    const general = personComments("Tighten this.", "two people");
    const forWriter = personComments("Warmer, please.", "tight", "Writer");
    const writer = connect("claude-code", "Writer");
    const mine = await writer.ok("list_comments", { path: PLAN });
    expect(mine).toContain(`[${idOf(forWriter)}]`);
    expect(mine).not.toContain(`[${idOf(general)}]`);
    expect(mine).toContain("1 comment on plan.md has no @, so it's for Claude, also on it: you take only comments that name you (@Writer).");
    expect(await claude.ok("list_comments", { path: PLAN })).toContain(`[${idOf(general)}]`);
    await claude.end();
    const later = personComments("And this.", "We should");
    expect(await writer.ok("list_comments", { path: PLAN })).toContain(`[${idOf(later)}]`);
  });

  it("is never left without anyone to take a comment with no @: two role agents on their own both may", () => {
    expect(picksUpUnnamed(true, [{ role: false }])).toBe(false);
    expect(picksUpUnnamed(true, [{ role: true }])).toBe(true);
    expect(picksUpUnnamed(true, [])).toBe(true);
    expect(picksUpUnnamed(false, [{ role: false }])).toBe(true);
  });
});

describe("an empty round explains itself", () => {
  it("Writer finds nothing addressed to it: the window says so, and whom the comments are for", async () => {
    const claude = connect();
    await claude.ok("open_document", { path: PLAN });
    personComments("Tighten this.", "two people");
    personComments("And this.", "tight");
    const writer = connect("claude-code", "Writer");
    await writer.ok("take_document", { path: PLAN });
    await writer.ok("finish_editing", { path: PLAN });
    expect(corillo.summaries).toEqual([
      { agent: "Writer", answered: 0, other: false, endedBy: "agent", nothingFor: { comments: 2, agents: ["Claude"], given: false } },
    ]);
    expect(doneWords(corillo.summaries, { comments: 0 })).toEqual({
      lead: "Writer found nothing addressed to it.",
      detail: "2 comments are for Claude.",
    });
  });

  it("says the comments are waiting for an agent only once that agent has them", () => {
    const pass = (given: boolean, comments = 1): PassSummary => ({ agent: "Claude 2", answered: 0, other: false, endedBy: "agent", nothingFor: { comments, agents: ["Claude"], given } });
    expect(doneWords([pass(true, 2)], { comments: 0 }).detail).toBe("2 comments are waiting for Claude.");
    expect(doneWords([pass(false)], { comments: 1 }).detail).toBe("1 comment is for Claude. 1 comment to read.");
  });

  it("a round with nothing for anyone ends as before, with no line to say so", async () => {
    const claude = connect();
    await claude.ok("take_document", { path: PLAN });
    await claude.ok("finish_editing", { path: PLAN });
    expect(corillo.summaries).toEqual([]);
  });
});

describe("the window's words stay true", () => {
  it("with Writer on the document, Send to Claude is offered only to an agent the comments are for", async () => {
    const claude = connect();
    await claude.ok("open_document", { path: PLAN });
    personComments("Tighten this.", null);
    const writer = connect("claude-code", "Writer", { canWait: true });
    await writer.ok("open_document", { path: PLAN });
    const wait = writer.call("wait_for_review", { canHold: true });
    await new Promise((r) => setTimeout(r, 0));
    const agents = corillo.agents.get("plan")!;
    expect(agents.find((a) => a.name === "Claude")!.isDefault).toBe(true);
    expect(handBackFor(comments.threads("plan"), agents, waitingForPerson)).toEqual({ kind: "copy", agent: "Claude", comments: 1 });
    await writer.end();
    await wait;
  });

  it("the agent waiting for the review is the one a comment with no @ is shown for, and Send goes to it", async () => {
    const old = connect();
    await old.ok("open_document", { path: PLAN });
    const listening = connect("claude-code", undefined, { canWait: true });
    await listening.ok("open_document", { path: PLAN });
    const wait = listening.call("wait_for_review", { canHold: true });
    await new Promise((r) => setTimeout(r, 0));
    personComments("Tighten this.", null);
    const agents = corillo.agents.get("plan")!;
    const to = agents.find((a) => a.listening)!;
    expect(to.isDefault).toBe(true);
    expect(cards()).toEqual([`For ${to.name}, not sent yet`]);
    expect(handBackFor(comments.threads("plan"), agents, waitingForPerson)).toEqual({ kind: "send", agent: to.name, comments: 1 });
    expect(await service.send("plan", to.name)).toEqual({ sent: true });
    expect((await wait).text).toContain("Tighten this.");
    expect(cards()).toEqual([`Sent to ${to.name}`]);
    expect(await old.ok("list_comments", { path: PLAN })).toContain("No comments on plan.md are waiting for you.");
    await listening.ok("finish_editing", { path: PLAN }).catch(() => "");
  });
});

describe("the rule, on its own", () => {
  it("a comment goes to the first agent shown it since the person last wrote on it", () => {
    const thread = (lengths: ("person" | "agent")[]): Thread => ({
      id: "t",
      anchor: null,
      to: null,
      status: "open",
      messages: lengths.map((who, i) => ({ id: `m${i}`, author: who === "person" ? person : { kind: "agent", name: "Claude" }, body: "x", created: "" })),
    });
    const shown = (counts: Record<string, number>) => (s: string) => counts[s] ?? 0;
    expect(pickedUpBy(thread(["person"]), ["a", "b"], shown({}))).toBeNull();
    expect(pickedUpBy(thread(["person"]), ["a", "b"], shown({ b: 1 }))).toBe("b");
    // The person wrote again since b saw it: nobody has it now.
    expect(pickedUpBy(thread(["person", "agent", "person"]), ["a", "b"], shown({ b: 2 }))).toBeNull();
    expect(pickedUpBy(thread(["person", "agent", "person"]), ["a", "b"], shown({ b: 2, a: 3 }))).toBe("a");
  });

  it("a new session takes the plain name from a session that isn't in a round, and the colours go with the names", () => {
    const roster = new Roster();
    const nobodyInARound = () => false;
    roster.look("plan", "s1", "Claude", false, nobodyInARound);
    const joined = roster.look("plan", "s2", "Claude", false, nobodyInARound);
    expect(joined.name).toBe("Claude");
    expect(joined.colour).toBe("peach");
    expect(roster.member("plan", "s1")).toMatchObject({ name: "Claude 2" });
    // While s2 is in a round, a third is Claude 3.
    expect(roster.look("plan", "s3", "Claude", false, (s) => s === "s2").name).toBe("Claude 3");
  });
});
