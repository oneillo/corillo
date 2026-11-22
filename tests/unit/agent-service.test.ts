// The agent workflow end to end, with a stand-in for the window and the files.
import { beforeEach, describe, expect, it } from "vitest";
import { existsSync, mkdtempSync, readdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import * as path from "node:path";
import {
  AgentService,
  anchorForQuote,
  commentLines,
  type AgentDoc,
  type AgentHooks,
  type AgentHost,
  type AgentInfo,
  type FlushResult,
  type PassEnd,
  type PassSummary,
} from "../../src/main/agents/agent-service";
import { AgentError } from "../../src/main/agents/shapes";
import { CommentService } from "../../src/main/comment-service";
import { DocumentStore } from "../../src/main/store";
import { VersionHistory } from "../../src/main/version-store";
import type { Thread } from "../../src/core/comments";
import { anchorFor, findAnchor, locate, posAt, textIndex } from "../../src/core/anchors";
import { parseMarkdown } from "../../src/core/markdown";
import { reading, wordsKept } from "../../src/core/change-links";
import { bigDocument } from "../fixtures/big-document";
import { handBackFor, turnLabel } from "../../src/renderer/comment-format";
import { standingOf } from "../../src/main/doc-standing";

const PLAN = "/docs/plan.md";
const PLAN_TEXT = "# Plan\n\nWe should hire two people this quarter.\n\n## Budget\n\nThe budget is tight.\n";

/** Stands in for Corillo's window and the files on disk. */
class FakeCorillo implements AgentHost {
  files = new Map<string, string>([[PLAN, PLAN_TEXT]]);
  docs: AgentDoc[] = [];
  picturesWait(): void {}
  /** Edits the person has typed in a tab but not saved yet. */
  unsaved = new Map<string, string>();
  flushAnswer: FlushResult = "saved";
  locked = new Set<string>();
  agents = new Map<string, AgentInfo[]>();
  dots: string[] = [];
  log: string[] = [];
  folders = new Set(["/docs", "/exports"]);
  /** Each export waits for this, so a test can hold one up. */
  exportGate: Promise<void> = Promise.resolve();

  /** Corillo's version history, which records what the window and agents save, as the app's does. */
  constructor(readonly history: VersionHistory) {}

  find(p: string) {
    return this.docs.find((d) => d.filePath === p) ?? this.docs.find((d) => d.formerPaths?.has(p)) ?? null;
  }
  open(p: string) {
    if (!this.files.has(p)) throw new AgentError(`There's no file at ${p}.`);
    const doc = { id: `tab-${this.docs.length + 1}`, storeId: path.basename(p, ".md"), filePath: p };
    this.docs.push(doc);
    this.log.push(`opened ${path.basename(p)} in the background`);
    this.history.seen(doc.storeId, this.files.get(p)!);
    return doc;
  }
  openDocs() {
    return this.docs;
  }
  /** The tab the person has in front. */
  frontPath: string | null = null;
  front() {
    return this.frontPath ? this.find(this.frontPath) : null;
  }
  byStoreId(storeId: string) {
    return this.docs.find((d) => d.storeId === storeId) ?? null;
  }
  read(doc: AgentDoc) {
    return this.files.get(doc.filePath)!;
  }
  /** The file refuses the next writes with this (locked, read-only, moved). */
  refuseWrite: string | null = null;
  write(doc: AgentDoc, text: string) {
    if (this.refuseWrite) throw new AgentError(this.refuseWrite);
    this.files.set(doc.filePath, text);
    this.history.edited(doc.storeId, text);
    this.log.push(`showed agent text in ${path.basename(doc.filePath)}`);
  }
  /** The last text the window was given to read ahead. */
  ahead = "";
  coming(doc: AgentDoc, text: string) {
    this.ahead = text;
    this.log.push(`window reads ahead in ${path.basename(doc.filePath)}`);
  }
  create(p: string, text: string) {
    if (this.files.has(p)) throw new AgentError(`There's already a file at ${p}.`);
    this.files.set(p, text);
  }
  async flush(doc: AgentDoc, lock: boolean) {
    if (this.flushAnswer !== "saved") return this.flushAnswer;
    const pending = this.unsaved.get(doc.filePath);
    if (pending !== undefined) {
      this.files.set(doc.filePath, pending);
      this.history.edited(doc.storeId, pending);
      this.unsaved.delete(doc.filePath);
    }
    if (lock) this.locked.add(doc.storeId);
    return "saved" as const;
  }
  passEnded?: AgentHost["passEnded"];
  /** How many times the window was told who's on each document. */
  announced = new Map<string, number>();
  announce(storeId: string, agents: AgentInfo[]) {
    this.agents.set(storeId, agents);
    this.announced.set(storeId, (this.announced.get(storeId) ?? 0) + 1);
    if (!agents.some((a) => a.editing)) this.locked.delete(storeId);
  }
  backToYou(storeId: string) {
    this.dots.push(storeId);
  }
  /** Sends the person made that didn't reach the agent, as the window was told of them. */
  lost: string[] = [];
  sendLost(storeId: string, agentName: string, why: "stopped" | "failed") {
    this.lost.push(`${agentName} ${why} on ${storeId}`);
  }
  /** Who was connected, each time that changed, and who had just left. */
  connections: string[] = [];
  connected(names: string[], left?: string) {
    this.connections.push(names.join(", ") + (left ? ` (${left} left)` : ""));
  }
  kindOf(p: string) {
    if (this.folders.has(p)) return "folder" as const;
    return this.files.has(p) ? ("file" as const) : null;
  }
  async exportDocument(doc: AgentDoc, kind: "docx" | "pdf", outputPath: string, agentName: string) {
    await this.exportGate;
    this.files.set(outputPath, `${kind} of: ${this.files.get(doc.filePath)}`);
    this.log.push(`${agentName} exported ${path.basename(doc.filePath)} to ${outputPath}`);
    return { outputPath, notes: [] };
  }
}

let corillo: FakeCorillo;
let comments: CommentService;
let passes: string[];
let ended: PassEnd[];
let service: AgentService;
/** The test's throwaway data folder. */
let dataDir: string;

const hooks: AgentHooks = {
  beginPass: (storeId, name) => {
    passes.push(`${name} began a pass on ${storeId}`);
    corillo.history.beginPass(storeId, name);
  },
  endPass: (storeId, info) => {
    passes.push(`${info.agentName} ended a pass on ${storeId} (${info.endedBy})`);
    ended.push(info);
    corillo.history.endPass(storeId, { addressed: info.addressed, other: info.other, request: info.request, note: info.note });
  },
  versions: (storeId) => corillo.history.list(storeId),
  versionText: (storeId, n) => corillo.history.text(storeId, n),
};

beforeEach(() => {
  const data = mkdtempSync(path.join(tmpdir(), "corillo-agents-"));
  dataDir = data;
  corillo = new FakeCorillo(new VersionHistory(data));
  comments = new CommentService(new DocumentStore(data), () => {});
  passes = [];
  ended = [];
  service = new AgentService(corillo, comments, hooks, { waitMs: 0 });
});

/** A connected agent, with a helper to call its tools. */
function connect(client = "claude-code", introduced?: string, options: { canWait?: boolean } = {}) {
  const { sessionId, name } = service.connect({ name: client }, introduced, options);
  const call = (tool: string, args: Record<string, unknown> = {}) => service.call(sessionId, tool, args);
  const ok = async (tool: string, args: Record<string, unknown> = {}) => {
    const r = await call(tool, args);
    if (r.isError) throw new Error(`${tool} failed: ${r.text}`);
    return r.text;
  };
  const fails = async (tool: string, args: Record<string, unknown> = {}) => {
    const r = await call(tool, args);
    if (!r.isError) throw new Error(`${tool} should have failed: ${r.text}`);
    return r.text;
  };
  return { sessionId, name, call, ok, fails, end: () => service.disconnect(sessionId) };
}

const person = { kind: "person" } as const;
function personComments(storeId: string, body: string, quote: string | null, to: string | null = null): Thread {
  const anchor = quote ? anchorForQuote(corillo.files.get(PLAN)!, quote) : null;
  return comments.add(storeId, person, body, anchor, to);
}
const idOf = (t: Thread) => t.id.slice(0, 8);
/** What the first finish of a session adds: keep the chat to a line, and how the person asks for more. */
const FIRST_FINISH =
  " They read your replies in Corillo, so in the chat a line is enough: that it's back, and anything they must decide. Tell them too that they can reply on any comment in Corillo and tell you here when there's more.";
const UNCHANGED = "plan.md hasn't changed since your last read. If you no longer have its text, call read_document with whole set to true.";

describe("connecting and opening", () => {
  it("an agent opens a document in a background tab and is told to let the person know", async () => {
    const claude = connect();
    expect(claude.name).toBe("Claude");
    const text = await claude.ok("open_document", { path: PLAN });
    expect(text).toContain("plan.md is open in Corillo, in a background tab");
    expect(text).toContain("Tell the person");
    expect(corillo.log).toEqual(["opened plan.md in the background"]);
    expect(corillo.agents.get("plan")).toEqual([{ name: "Claude", isDefault: true, editing: false, colour: "peach" }]);
  });

  it("the first time an agent opens, creates or reads a document, it's told to change it only through Corillo", async () => {
    // Said with the result, not only in the connect-time instructions, which some agent tools don't pass on.
    const rule = (name: string) => `Change ${name} only through Corillo (take_document, then edit_document or replace_document), never with your own file tools.`;
    const claude = connect();
    expect(await claude.ok("open_document", { path: PLAN })).toMatch(new RegExp(`${rule("plan.md").replace(/[().]/g, "\\$&")}$`));
    expect(await claude.ok("open_document", { path: PLAN })).not.toContain(rule("plan.md"));
    expect(await claude.ok("read_document", { path: PLAN })).not.toContain(rule("plan.md"));
    expect(await claude.ok("create_document", { path: "/docs/new.md", text: "# New\n" })).toContain(rule("new.md"));
    expect(await connect().ok("read_document", { path: PLAN })).toBe(`${rule("plan.md")}\n\nThe whole text of plan.md follows.\n\n${PLAN_TEXT}`);
  });

  it("a file that isn't there, or isn't Markdown, gets a clear answer", async () => {
    const claude = connect();
    expect(await claude.fails("open_document", { path: "/docs/missing.md" })).toContain("There's no file");
    expect(await claude.fails("open_document", { path: "/docs/photo.png" })).toContain("Markdown files");
    expect(await claude.fails("open_document", { path: "plan.md" })).toContain("full path");
  });

  // The review of Batch 21, R21-10: an open's words sent the person looking for a file that was never made.
  it("a new document too long for an agent to open is refused before its file is made, saying it wasn't (G21-8, R21-10)", async () => {
    const text = "A line of the long document.\n".repeat(400_000);
    expect(await connect().fails("create_document", { path: "/docs/long.md", text })).toBe(
      "long.md would be 11 MB, so long that opening it would slow Corillo's window down. It wasn't created.",
    );
    expect(corillo.files.has("/docs/long.md")).toBe(false);
  });

  it("an agent can create a new document, which opens in Corillo; it never overwrites a file", async () => {
    const claude = connect();
    const text = await claude.ok("create_document", { path: "/docs/proposal", text: "# Proposal\n" });
    expect(text).toContain("Created /docs/proposal.md");
    expect(corillo.files.get("/docs/proposal.md")).toBe("# Proposal\n");
    expect(corillo.find("/docs/proposal.md")).not.toBeNull();
    expect(await claude.fails("create_document", { path: PLAN, text: "x" })).toContain("already a file");
    expect(corillo.files.get(PLAN)).toBe(PLAN_TEXT);
    // It wrote it, so it has already read it.
    expect(await claude.ok("read_document", { path: "/docs/proposal.md" })).toContain("hasn't changed");
  });

  it("listing documents shows who's editing and how many comments wait for this agent", async () => {
    const claude = connect();
    expect(await claude.ok("list_documents")).toBe("No documents are open in Corillo.");
    await claude.ok("open_document", { path: PLAN });
    personComments("plan", "Tighten this.", "hire two people");
    personComments("plan", "For Writer.", null, "Writer");
    expect(await claude.ok("list_documents")).toBe("Open in Corillo:\n- /docs/plan.md (1 comment waiting for you)");
    const codex = connect("codex-mcp-client");
    // Nobody has picked it up yet: it waits for whichever agent looks first (D3).
    expect(await codex.ok("list_documents")).toContain("1 comment waiting for you");
    await claude.ok("list_comments", { path: PLAN });
    expect(await codex.ok("list_documents")).toContain("no comments waiting for you; 1 with no @ went to Claude, another session");
    await claude.ok("take_document", { path: PLAN });
    expect(await codex.ok("list_documents")).toContain("Claude is editing it");
  });
});

describe("names and the default agent", () => {
  it("a second Claude on the same document while the first is in a round is Claude 2, with its own colour", async () => {
    const first = connect();
    const second = connect();
    await first.ok("take_document", { path: PLAN }); // editing: in a round (roadmap Batch 3, item 3)
    expect(await second.ok("open_document", { path: PLAN })).toContain("Your comments there show as Claude 2.");
    const agents = corillo.agents.get("plan")!;
    expect(agents.map((a) => [a.name, a.isDefault])).toEqual([
      ["Claude", true],
      ["Claude 2", false],
    ]);
    expect(agents[0].colour).not.toBe(agents[1].colour);
  });

  it("a comment with no @ goes to the agent that picks it up first; another agent gets only those directed at it (D3)", async () => {
    const claude = connect();
    const codex = connect("codex-mcp-client");
    await claude.ok("open_document", { path: PLAN });
    await codex.ok("open_document", { path: PLAN });
    const general = personComments("plan", "Tighten this.", "hire two people");
    const forCodex = personComments("plan", "Check the budget.", "budget is tight", "Codex");
    personComments("plan", "Writer, have a look.", null, "Writer");
    const mine = await claude.ok("list_comments", { path: PLAN });
    expect(mine).toContain(`[${idOf(general)}] on "hire two people" (line 3)`);
    expect(mine).toContain("Person: Tighten this.");
    expect(mine).not.toContain("Check the budget.");
    expect(mine).not.toContain("Writer, have a look.");
    const theirs = await codex.ok("list_comments", { path: PLAN });
    expect(theirs).toContain(`[${idOf(forCodex)}]`);
    expect(theirs).not.toContain("Person: Tighten this.");
  });

  it("an agent is told plainly when comments with no @ went to another session, and how the person can hand one over", async () => {
    const yesterday = connect(); // a session left open, which was shown the comments
    await yesterday.ok("open_document", { path: PLAN });
    personComments("plan", "Make this three people.", "two people");
    personComments("plan", "And say by how much.", "tight");
    personComments("plan", "Writer, have a look.", null, "Writer");
    await yesterday.ok("list_comments", { path: PLAN });
    const today = connect(); // the one the person is talking to now
    const told =
      "2 comments on plan.md have no @ and went to Claude, another session that picked them up first. If the person meant them for you, tell them they can hand each one to you by replying on it with @Claude 2.";
    expect(await today.ok("list_documents")).toContain("(no comments waiting for you; 2 with no @ went to Claude, another session)");
    const taken = await today.ok("take_document", { path: PLAN });
    expect(taken).toContain(`No comments on plan.md are waiting for you. ${told}`);
    expect(await today.ok("list_comments", { path: PLAN })).toContain(told);
    // The session that has them, and an agent once there are none, hear nothing of it.
    expect(await yesterday.ok("list_comments", { path: PLAN })).not.toContain("another session");
    personComments("plan", "Done?", null, "Claude 2");
    for (const t of comments.threads("plan")) if (t.to === null) comments.reply("plan", t.id, { kind: "agent", name: "Claude" }, "Done.");
    expect(await today.ok("list_comments", { path: PLAN })).not.toContain("another session");
  });

  it("when the session that picked a comment up ends, the next agent to look gets it", async () => {
    const claude = connect();
    const codex = connect("codex-mcp-client");
    await claude.ok("open_document", { path: PLAN });
    await codex.ok("open_document", { path: PLAN });
    personComments("plan", "Tighten this.", null);
    await claude.ok("list_comments", { path: PLAN });
    expect(await codex.ok("list_comments", { path: PLAN })).toContain("No comments");
    await claude.end();
    expect(corillo.agents.get("plan")).toEqual([{ name: "Codex", isDefault: true, editing: false, colour: "sky" }]);
    expect(await codex.ok("list_comments", { path: PLAN })).toContain("Tighten this.");
  });

  it("a custom agent introduces itself by its role before working, and keeps that name", async () => {
    const writer = connect();
    expect(await writer.ok("introduce", { name: "Writer" })).toBe("You're Writer in Corillo from now on.");
    await writer.ok("open_document", { path: PLAN });
    expect(corillo.agents.get("plan")![0].name).toBe("Writer");
    const t = personComments("plan", "Writer: punchier?", null, "Writer");
    await writer.ok("reply_to_comment", { path: PLAN, comment_id: idOf(t), text: "Done." });
    expect(await writer.fails("introduce", { name: "Editor" })).toContain("a session keeps its name");
    expect(await connect().fails("introduce", { name: "person" })).toContain("kept for the person");
  });

  it("a connector that reconnects says which role it introduced, and is named by it", () => {
    expect(connect("claude-code", "Writer").name).toBe("Writer");
  });

  it("a role name too long to show is cut at a whole word, and the agent is told the name it has", async () => {
    const agent = connect();
    expect(await agent.ok("introduce", { name: "Senior Marketing Copywriter for Brand Launches" })).toBe(
      "You're Senior Marketing Copywriter in Corillo from now on.",
    );
    await agent.ok("open_document", { path: PLAN });
    expect(corillo.agents.get("plan")![0].name).toBe("Senior Marketing Copywriter");
  });
});

describe("taking turns", () => {
  it("taking the document saves the person's pending edits first, locks the tab, and gives the agent its comments and the text", async () => {
    const claude = connect();
    await claude.ok("open_document", { path: PLAN });
    corillo.unsaved.set(PLAN, PLAN_TEXT.replace("tight", "very tight"));
    const t = personComments("plan", "Say how tight.", "hire two people");
    const text = await claude.ok("take_document", { path: PLAN });
    expect(text).toContain("You're editing plan.md now.");
    expect(text).toContain(`1 comment on plan.md waiting for you:\n\n[${idOf(t)}]`);
    expect(text).toContain("Address all of them in this pass");
    expect(text).toContain("The budget is very tight."); // the person's edit, saved first
    expect(corillo.locked.has("plan")).toBe(true);
    expect(corillo.agents.get("plan")![0].editing).toBe(true);
    expect(passes).toEqual(["Claude began a pass on plan"]);
  });

  it("another agent can't take or edit a document while one holds it; it's told who has it", async () => {
    const claude = connect();
    const claude2 = connect();
    await claude.ok("take_document", { path: PLAN });
    expect(await claude2.fails("take_document", { path: PLAN })).toContain("Claude is editing plan.md right now");
    expect(await claude2.fails("edit_document", { path: PLAN, edits: [{ find: "two", replace: "three" }] })).toContain(
      "Claude is editing plan.md",
    );
    // It can still read and comment.
    expect(await claude2.ok("read_document", { path: PLAN })).toContain("The whole text of plan.md");
    expect(await claude2.ok("add_comment", { path: PLAN, text: "A question.", quote: "budget" })).toContain("Added a comment");
    await claude.ok("finish_editing", { path: PLAN });
    expect(await claude2.ok("take_document", { path: PLAN })).toContain("You're editing plan.md now.");
  });

  it("when the person's edits clash with an outside change, the agent waits until they choose", async () => {
    const claude = connect();
    corillo.flushAnswer = "conflict";
    expect(await claude.fails("take_document", { path: PLAN })).toContain("haven't chosen which version to keep");
    expect(corillo.agents.get("plan")![0].editing).toBe(false);
    expect(passes).toEqual([]);
  });

  it("finishing hands the document back: one pass, with the comments the agent replied to, and the tab's dot", async () => {
    const claude = connect();
    await claude.ok("open_document", { path: PLAN });
    const a = personComments("plan", "Three, not two.", "hire two people");
    const b = personComments("plan", "Whole thing: friendlier.", null);
    await claude.ok("take_document", { path: PLAN });
    await claude.ok("edit_document", { path: PLAN, edits: [{ find: "hire two people", replace: "hire three people" }] });
    await claude.ok("reply_to_comment", { path: PLAN, comment_id: idOf(a), text: "Changed to three." });
    // A comment still waiting is pointed out once, so it can be answered in this pass.
    const first = await claude.fails("finish_editing", { path: PLAN });
    expect(first).toContain(`Not finished: 1 comment on plan.md is still waiting for you:\n\n[${idOf(b)}] on the whole document`);
    expect(first).toContain("To leave it for your next pass instead, call finish_editing again.");
    expect(passes).toEqual(["Claude began a pass on plan"]);
    // Calling again leaves it for the next pass.
    const done = await claude.ok("finish_editing", { path: PLAN });
    expect(done).toBe(`Done. plan.md is back with the person. 1 comment still waiting for you will come back to you in your next pass.${FIRST_FINISH}`);
    expect(corillo.dots).toEqual(["plan"]);
    expect(corillo.locked.has("plan")).toBe(false);
    expect(passes).toEqual(["Claude began a pass on plan", "Claude ended a pass on plan (agent)"]);
    expect(ended[0].addressed.map((t) => t.id)).toEqual([a.id]);
    expect(ended[0].addressed[0].messages.map((m) => m.body)).toEqual(["Three, not two.", "Changed to three."]);
    expect(await claude.fails("finish_editing", { path: PLAN })).toContain("nothing to finish");
  });

  it("answering the last comment in a pass reminds the agent to hand the document back", async () => {
    const claude = connect();
    await claude.ok("open_document", { path: PLAN });
    const a = personComments("plan", "One.", null);
    const b = personComments("plan", "Two.", null);
    await claude.ok("take_document", { path: PLAN });
    expect(await claude.ok("reply_to_comment", { path: PLAN, comment_id: idOf(a), text: "Done." })).toBe(`Replied on [${idOf(a)}].`);
    expect(await claude.ok("reply_to_comment", { path: PLAN, comment_id: idOf(b), text: "Done." })).toContain(
      "That was the last comment waiting for you: call finish_editing to hand plan.md back.",
    );
    expect(service.editingAgent("plan")).toBe("Claude");
    await claude.ok("finish_editing", { path: PLAN });
    expect(service.editingAgent("plan")).toBeNull();
  });

  it("Take over ends the agent's pass, and the agent is told on its next call", async () => {
    const claude = connect();
    await claude.ok("take_document", { path: PLAN });
    await service.takeOver("plan");
    expect(corillo.agents.get("plan")![0].editing).toBe(false);
    expect(corillo.dots).toEqual([]); // the person took it, so it's already in their hands
    expect(passes).toEqual(["Claude began a pass on plan", "Claude ended a pass on plan (person)"]);
    const refused = await claude.fails("edit_document", { path: PLAN, edits: [{ find: "two", replace: "three" }] });
    expect(refused).toContain("The person took plan.md back while you were editing");
    expect(refused).toMatch(/So this change wasn't made\.$/);
    expect(refused).not.toContain("Call take_document");
    expect(corillo.files.get(PLAN)).toBe(PLAN_TEXT);
    // Told once, not on every call.
    expect(await claude.ok("read_document", { path: PLAN })).not.toContain("took plan.md back");
  });

  it("after Take over or a closed tab, an agent's refused edits never tell it to take the document back", async () => {
    const claude = connect();
    await claude.ok("take_document", { path: PLAN });
    await service.takeOver("plan");
    const edit = { path: PLAN, edits: [{ find: "two", replace: "three" }] };
    expect(await claude.fails("edit_document", edit)).toMatch(/Don't edit it again unless they ask; you can still reply on comments\.\n\nSo this change wasn't made\.$/);
    for (const tool of ["edit_document", "replace_document"]) {
      expect(await claude.fails(tool, { ...edit, text: "x" })).toBe("You're not editing plan.md: the person took it back. Don't take it again unless they ask.");
    }
    // Once the person asks and it takes the document again, it's an ordinary pass.
    await claude.ok("take_document", { path: PLAN });
    await claude.ok("finish_editing", { path: PLAN });
    expect(await claude.fails("edit_document", edit)).toBe("You're not editing plan.md. Call take_document first.");
    // A closed tab: the same, and the tab doesn't come back.
    await claude.ok("take_document", { path: PLAN });
    corillo.docs = [];
    await service.closed("plan", PLAN);
    const closed = await claude.fails("edit_document", edit);
    expect(closed).toContain("The person closed plan.md in Corillo while you were editing");
    expect(closed).toMatch(/So this change wasn't made\.$/);
    expect(await claude.fails("edit_document", edit)).toBe("You're not editing plan.md: the person closed it. Don't take it again unless they ask.");
    expect(corillo.docs).toEqual([]);
  });

  it("tools that only look leave a tab the person closed mid-pass closed; taking or opening it brings it back", async () => {
    const claude = connect();
    const c = personComments("plan", "Make it three.", "two people");
    await claude.ok("take_document", { path: PLAN });
    corillo.docs = [];
    await service.closed("plan", PLAN);
    const first = await claude.fails("list_comments", { path: PLAN });
    expect(first).toContain("The person closed plan.md in Corillo while you were editing");
    expect(first).toMatch(/So plan.md stays closed, and nothing was done\.$/);
    const later = "plan.md is closed: the person closed it during your pass, so it stays closed until they ask for more. Nothing was done.";
    for (const [tool, args] of [
      ["list_comments", {}],
      ["read_document", {}],
      ["reply_to_comment", { comment_id: idOf(c), text: "Done." }],
      ["add_comment", { text: "A question." }],
      ["list_versions", {}],
      ["read_version", { version: 1 }],
      ["show_changes", {}],
      ["export_document", { format: "pdf" }],
    ] as const) {
      expect({ tool, text: await claude.fails(tool, { path: PLAN, ...args }) }).toEqual({ tool, text: later });
    }
    expect(corillo.docs).toEqual([]);
    expect(comments.threads("plan")[0].messages).toHaveLength(1);
    // When the person asks again, opening or taking it brings the tab back.
    await claude.ok("open_document", { path: PLAN });
    expect(corillo.docs.map((d) => d.filePath)).toEqual([PLAN]);
    await claude.ok("list_comments", { path: PLAN });
    // R-AG-10: once opened again, a later close with no pass is an ordinary close: a look opens it again.
    corillo.docs = [];
    await service.closed("plan", PLAN);
    expect(await claude.ok("read_document", { path: PLAN })).toContain("plan.md");
    expect(corillo.docs.map((d) => d.filePath)).toEqual([PLAN]);
  });

  it("a tab reopened while its close was waiting its turn is told nobody is editing, and Take over always tells the window", async () => {
    corillo.files.set("/docs/other.md", "# Other\n");
    const claude = connect();
    const codex = connect("codex");
    await claude.ok("take_document", { path: PLAN });
    await codex.ok("open_document", { path: "/docs/other.md" });
    // Codex's read waits for the window to save the person's edits in the other tab, holding everyone's turn.
    let release!: () => void;
    const gate = new Promise<void>((r) => (release = r));
    const flush = corillo.flush.bind(corillo);
    corillo.flush = async (doc, lock) => {
      if (doc.storeId === "other") await gate;
      return flush(doc, lock);
    };
    const reading = codex.call("read_document", { path: "/docs/other.md" });
    corillo.docs = corillo.docs.filter((d) => d.storeId !== "plan");
    const closing = service.closed("plan", PLAN); // waits its turn
    corillo.open(PLAN); // the person opens it again meanwhile
    service.opened("plan");
    expect(corillo.agents.get("plan")!.some((a) => a.editing)).toBe(true); // the close hasn't run yet
    release();
    await Promise.all([reading, closing]);
    expect(corillo.agents.get("plan")!.some((a) => a.editing)).toBe(false);
    expect(corillo.locked.has("plan")).toBe(false);
    // Take over with no pass still tells the window, so a tab that thinks an agent is editing is put right.
    const told = corillo.announced.get("plan")!;
    await service.takeOver("plan");
    expect(corillo.announced.get("plan")).toBe(told + 1);
  });

  it("the session still ends cleanly, and the tab is told, if telling the person about the pass fails", async () => {
    const claude = connect();
    await claude.ok("take_document", { path: PLAN, request: "Tighten it." });
    corillo.passEnded = () => {
      throw new Error("the window went away");
    };
    await claude.end();
    expect(service.editingAgent("plan")).toBeNull();
    expect(corillo.agents.get("plan")).toEqual([]);
    expect(corillo.dots).toEqual(["plan"]);
    expect(service.sizes().sessions).toBe(0);
  });

  it("what a session keeps for a document goes when its tab closes, and nothing it keeps grows for good", async () => {
    const claude = connect();
    const paths = Array.from({ length: 25 }, (_, i) => `/docs/d${i}.md`);
    for (const p of paths) {
      corillo.files.set(p, "# D\n\nText.\n");
      await claude.ok("read_document", { path: p });
      personComments(path.basename(p, ".md"), "Shorter?", null);
      await claude.ok("list_comments", { path: p });
      await claude.ok("add_comment", { path: p, text: "A question.", quote: "Text." }); // kept as its own while it is on the document (B3-R10, B6-R07)
      // Each tab closes mid-pass: the agent is told, once, on its next call about it.
      await claude.ok("take_document", { path: p });
      corillo.docs = corillo.docs.filter((d) => d.filePath !== p);
      await service.closed(path.basename(p, ".md"), p);
    }
    // Which comments it started is kept as long as it's on the document, on the 20 closed last (B6-R07).
    expect(service.sizes()).toEqual({ sessions: 1, lastRead: 0, seen: 0, started: 20, pointed: 0, ended: 20, rounds: 0, roster: 20, announced: 0, waiting: 0, links: 0, passAnchors: 0, listening: 0 });
    await claude.end();
    expect(service.sizes()).toEqual({ sessions: 0, lastRead: 0, seen: 0, started: 0, pointed: 0, ended: 0, rounds: 0, roster: 0, announced: 0, waiting: 0, links: 0, passAnchors: 0, listening: 0 });
  });

  // Roadmap Batch 6, second round (the footing agent's long-session check): an agent still connected stays on a
  // document after its tab closes, so the start screen can say whom its comments are for; it was kept on every one.
  it("an agent still connected stays on the 20 documents closed last, never on more, and on every open one; the start screen still says whom their comments are for", async () => {
    const claude = connect();
    await claude.ok("read_document", { path: PLAN }); // open throughout
    for (let i = 0; i < 25; i++) {
      const p = `/docs/d${i}.md`;
      corillo.files.set(p, "# D\n\nText.\n");
      await claude.ok("read_document", { path: p });
      corillo.docs = corillo.docs.filter((d) => d.filePath !== p);
      await service.closed(`d${i}`, p);
    }
    expect(service.sizes().roster).toBe(21);
    expect(service.agentsOn("plan").map((a) => a.name)).toEqual(["Claude"]);
    expect(service.agentsOn("d5").map((a) => a.name)).toEqual(["Claude"]);
    expect(service.agentsOn("d4")).toEqual([]);
    // Where a recent document stands, as the start screen says: its comment with no @ is for Claude, not sent yet.
    const t = comments.add("d24", { kind: "person" }, "Shorter?", null, null);
    expect(standingOf([t], [], service.agentsOn("d24"))?.notSent).toEqual({ Claude: 1 });
    // Opened again, it counts as open: twenty more closed don't let it go.
    service.opened("d5");
    for (let i = 25; i < 45; i++) {
      const p = `/docs/d${i}.md`;
      corillo.files.set(p, "# D\n\nText.\n");
      await claude.ok("read_document", { path: p });
      corillo.docs = corillo.docs.filter((d) => d.filePath !== p);
      await service.closed(`d${i}`, p);
    }
    expect(service.agentsOn("d5").map((a) => a.name)).toEqual(["Claude"]);
    expect(service.sizes().roster).toBe(22);
  });

  it("the words Corillo read to tie an agent's edits to comments go when the document closes (ST-12)", async () => {
    const claude = connect();
    await claude.ok("take_document", { path: PLAN });
    await claude.ok("edit_document", { path: PLAN, edits: [{ find: "two people", replace: "three people" }] });
    await claude.ok("finish_editing", { path: PLAN });
    expect(wordsKept("plan")).toBeGreaterThan(0);
    corillo.docs = [];
    await service.closed("plan", PLAN);
    expect(wordsKept("plan")).toBe(0);
  });

  it("a session that ends mid-pass gives the document back", async () => {
    const claude = connect();
    await claude.ok("take_document", { path: PLAN });
    await claude.end();
    expect(corillo.agents.get("plan")).toEqual([]);
    expect(corillo.locked.has("plan")).toBe(false);
    expect(corillo.dots).toEqual(["plan"]);
    expect(passes.at(-1)).toBe("Claude ended a pass on plan (session-ended)");
    expect(await connect().ok("take_document", { path: PLAN })).toContain("You're editing plan.md now.");
  });

  it("comments the person adds during a pass reach the agent in its next answer", async () => {
    const claude = connect();
    await claude.ok("take_document", { path: PLAN });
    const late = personComments("plan", "Also mention the timeline.", "budget is tight");
    const edited = await claude.ok("edit_document", { path: PLAN, edits: [{ find: "two", replace: "three" }] });
    expect(edited).toContain("New from the person since you last looked");
    expect(edited).toContain(`[${idOf(late)}]`);
    // Only once.
    expect(await claude.ok("edit_document", { path: PLAN, edits: [{ find: "three", replace: "four" }] })).not.toContain("New from");
    // Not for comments directed at someone else.
    personComments("plan", "For Codex.", null, "Codex");
    expect(await claude.ok("read_document", { path: PLAN })).not.toContain("For Codex.");
  });
});

describe("editing through Corillo", () => {
  it("edits need the agent to hold the document", async () => {
    const claude = connect();
    expect(await claude.fails("edit_document", { path: PLAN, edits: [{ find: "two", replace: "three" }] })).toContain(
      "You're not editing plan.md. Call take_document first.",
    );
    expect(corillo.files.get(PLAN)).toBe(PLAN_TEXT);
  });

  it("each find must match exactly once; a failed edit changes nothing", async () => {
    const claude = connect();
    await claude.ok("take_document", { path: PLAN });
    expect(await claude.fails("edit_document", { path: PLAN, edits: [{ find: "e", replace: "x" }] })).toContain("appears");
    expect(await claude.fails("edit_document", { path: PLAN, edits: [{ find: "nope", replace: "x" }] })).toContain("isn't in the document");
    expect(await claude.fails("edit_document", { path: PLAN, edits: [{ find: "two" }] })).toContain("needs both find and replace");
    expect(corillo.files.get(PLAN)).toBe(PLAN_TEXT);
    // The edit that failed held up replies; reading again lets the agent go on.
    await claude.ok("read_document", { path: PLAN });
    // The result shows the change as it now reads, so the agent can check it before replying.
    expect(await claude.ok("edit_document", { path: PLAN, edits: [{ find: "two people", replace: "three people" }] })).toBe(
      'Done: 1 change made to plan.md. As it reads now:\nline 3: "We should hire three people this quarter."' +
        "\n\nIf the person asked for this in the chat, give their request with finish_editing, so it's kept with this version.",
    );
    expect(corillo.files.get(PLAN)).toContain("hire three people");
    expect(corillo.log).toContain("showed agent text in plan.md");
  });

  it("the window starts reading an agent's change while Corillo ties it to its comments, and shows it once it's saved", async () => {
    // The comments' changes are announced to the window as they're made.
    comments = new CommentService(new DocumentStore(mkdtempSync(path.join(tmpdir(), "corillo-agents-"))), () => corillo.log.push("comments updated"));
    service = new AgentService(corillo, comments, hooks, { waitMs: 0 });
    const claude = connect();
    await claude.ok("open_document", { path: PLAN });
    const c = personComments("plan", "Cut this.", "We should hire two people this quarter.");
    await claude.ok("take_document", { path: PLAN });
    for (const edit of [
      () => claude.ok("edit_document", { path: PLAN, edits: [{ find: "We should hire two people this quarter.\n\n", replace: "" }], comment_ids: [idOf(c)] }),
      () => claude.ok("replace_document", { path: PLAN, text: "# Plan\n\n## Budget\n\nThe budget is fixed.\n", comment_ids: [idOf(c)] }),
    ]) {
      corillo.log.length = 0;
      await edit();
      // Read ahead first; the comments that lost their words are updated before the text shows, so none looks lost for a moment.
      expect(corillo.log[0]).toBe("window reads ahead in plan.md");
      expect(corillo.log.at(-1)).toBe("showed agent text in plan.md");
      expect(corillo.log).toContain("comments updated");
      expect(corillo.ahead).toBe(corillo.files.get(PLAN));
    }
    expect(comments.threads("plan")[0].gap).toBeDefined();
    // A change that can't be made sends nothing ahead.
    corillo.log.length = 0;
    await claude.fails("edit_document", { path: PLAN, edits: [{ find: "not there", replace: "x" }] });
    expect(corillo.log).toEqual([]);
  });

  it("all changes every match, such as a name used throughout, and says how many", async () => {
    corillo.files.set(PLAN, "# Plan\n\nThe site supervisor signs off.\n\nAsk the site supervisor first.\n");
    const claude = connect();
    await claude.ok("take_document", { path: PLAN });
    const done = await claude.ok("edit_document", { path: PLAN, edits: [{ find: "site supervisor", replace: "site lead", all: true }] });
    expect(done).toContain("Done: 1 change made to plan.md in 2 places.");
    expect(corillo.files.get(PLAN)).toBe("# Plan\n\nThe site lead signs off.\n\nAsk the site lead first.\n");
  });

  it("an edit that didn't go through holds back the agent's replies and finishing, so they never claim a change that isn't there", async () => {
    const claude = connect();
    await claude.ok("open_document", { path: PLAN });
    const c = personComments("plan", "Three, not two.", "hire two people");
    await claude.ok("take_document", { path: PLAN });
    // Agents often send the edit, the reply and finish_editing together.
    await claude.fails("edit_document", { path: PLAN, edits: [{ find: "hire 2 people", replace: "hire three people" }] });
    expect(await claude.fails("reply_to_comment", { path: PLAN, comment_id: idOf(c), text: "Changed to three." })).toContain(
      "Not posted: your last change to plan.md didn't go through",
    );
    expect(await claude.fails("finish_editing", { path: PLAN })).toContain("Not finished: your last change to plan.md didn't go through");
    expect(comments.threads("plan")[0].messages).toHaveLength(1);
    expect(service.editingAgent("plan")).toBe("Claude");
    // Once the change is made, both go through.
    await claude.ok("edit_document", { path: PLAN, edits: [{ find: "hire two people", replace: "hire three people" }] });
    await claude.ok("reply_to_comment", { path: PLAN, comment_id: idOf(c), text: "Changed to three." });
    expect(await claude.ok("finish_editing", { path: PLAN })).toBe(`Done. plan.md is back with the person.${FIRST_FINISH}`);
  });

  it("a change made outside Corillo during the pass is shown to the agent with its next edit, so it needn't read it all again", async () => {
    const long = PLAN_TEXT + "\nA paragraph that stays the same, as most of a document does.\n".repeat(6);
    corillo.files.set(PLAN, long);
    const claude = connect();
    await claude.ok("take_document", { path: PLAN });
    corillo.files.set(PLAN, long.replace("hire two people", "recruit two people"));
    const refused = await claude.fails("edit_document", { path: PLAN, edits: [{ find: "hire two people", replace: "hire three people" }] });
    expect(refused).toContain("The text to find isn't in the document.");
    expect(refused).toContain("plan.md was changed outside Corillo since your last read. What changed, as a unified diff of the Markdown:");
    expect(refused).toContain("-We should hire two people this quarter.\n+We should recruit two people this quarter.");
    // Its next edit works from the text as it is, and isn't told again.
    const done = await claude.ok("edit_document", { path: PLAN, edits: [{ find: "recruit two people", replace: "recruit three people" }] });
    expect(done).not.toContain("changed outside Corillo");
    // A change that lands elsewhere is told alongside a successful edit too.
    corillo.files.set(PLAN, corillo.files.get(PLAN)!.replace("tight", "fixed"));
    const told = await claude.ok("edit_document", { path: PLAN, edits: [{ find: "# Plan", replace: "# Hiring plan" }] });
    expect(told).toContain("+The budget is fixed.");
    expect(await claude.ok("read_document", { path: PLAN })).toBe(UNCHANGED);
  });

  // R-AG-8: another app adding many lines to a held document put a diff of any size into the edit's answer.
  it("a large change made outside Corillo during the pass is never sent whole with an edit's answer: the agent is told to read it again", async () => {
    const long = PLAN_TEXT + bigDocument();
    corillo.files.set(PLAN, long);
    const claude = connect();
    await claude.ok("take_document", { path: PLAN });
    // About 60,000 characters added on 1,000 lines: under the line diff's limit, over what one answer should carry.
    const added = Array.from({ length: 1000 }, (_, i) => `Line ${i} added by another app, long enough to add up quickly.`).join("\n");
    corillo.files.set(PLAN, `${long}${added}\n`);
    const told = await claude.ok("edit_document", { path: PLAN, edits: [{ find: "# Plan", replace: "# Hiring plan" }] });
    expect(told.length).toBeLessThan(5_000);
    expect(told).toContain("plan.md was changed outside Corillo since your last read. Read it again (read_document).");
    corillo.files.set(PLAN, `${corillo.files.get(PLAN)!}${added}\n`);
    const refused = await claude.fails("replace_document", { path: PLAN, text: "# Mine\n" });
    expect(refused.length).toBeLessThan(5_000);
    expect(refused).toContain("has changed since you last read it. Read it again (read_document)");
  });

  // A16-2: an edit the file refused counted the other app's change as read, so a whole-text replace then wrote over it.
  it("an edit the file refuses doesn't count another app's change as read, so a whole-text replace can't write over it", async () => {
    const claude = connect();
    await claude.ok("take_document", { path: PLAN });
    const theirs = `${PLAN_TEXT}\nA paragraph another app added.\n`;
    corillo.files.set(PLAN, theirs);
    corillo.refuseWrite = "Your change to plan.md couldn't be saved: it's locked. Nothing was changed.";
    const refused = await claude.fails("edit_document", { path: PLAN, edits: [{ find: "two people", replace: "three people" }] });
    expect(refused).toBe("Your change to plan.md couldn't be saved: it's locked. Nothing was changed.");
    corillo.refuseWrite = null;
    // Its whole text, written from what it read at the take, is refused and the other app's change is shown.
    const again = await claude.fails("replace_document", { path: PLAN, text: PLAN_TEXT.replace("two people", "three people") });
    expect(again).toContain("Nothing was changed: plan.md was changed outside Corillo since your last read");
    expect(again).toContain("+A paragraph another app added.");
    expect(corillo.files.get(PLAN)).toBe(theirs);
  });

  it("replacing the whole text needs the agent to have read the latest version", async () => {
    const claude = connect();
    await claude.ok("open_document", { path: PLAN });
    corillo.files.set(PLAN, PLAN_TEXT + "\nThe person added this.\n");
    await claude.ok("take_document", { path: PLAN }); // reads the latest
    expect(await claude.ok("replace_document", { path: PLAN, text: "# New plan\n" })).toContain("replaced the whole text");
    corillo.files.set(PLAN, "# Changed outside Corillo\n");
    expect(await claude.fails("replace_document", { path: PLAN, text: "# Mine\n" })).toContain("has changed since you last read it");
    expect(corillo.files.get(PLAN)).toBe("# Changed outside Corillo\n");
  });

  it("a whole-text replace says how much it changed, and a small outside change comes back with the refusal", async () => {
    const long = PLAN_TEXT + "\nA paragraph that stays the same, as most of a document does.\n".repeat(6);
    corillo.files.set(PLAN, long);
    const claude = connect();
    await claude.ok("take_document", { path: PLAN });
    expect(await claude.ok("replace_document", { path: PLAN, text: long.replace("tight", "fine") })).toContain(
      "replaced the whole text of plan.md (1 of 20 lines new or changed)",
    );
    corillo.files.set(PLAN, long.replace("tight", "fine").replace("# Plan", "# Our plan"));
    const refused = await claude.fails("replace_document", { path: PLAN, text: long });
    expect(refused).toContain("Nothing was changed: plan.md was changed outside Corillo since your last read");
    expect(refused).toContain("-# Plan\n+# Our plan");
    // Told, it can now replace the text, keeping that change.
    await claude.ok("replace_document", { path: PLAN, text: long.replace("# Plan", "# Our plan") });
  });

  // A16-16: a whole text sent back with plain line breaks took off the file's byte order mark and Windows line ends.
  describe("a whole-text replace keeps a file's byte order mark and line ends", () => {
    const MARK = "﻿";
    const LINES = ["# Plan", "", "First paragraph.", "", "Second paragraph.", "", "- one", "- two", ""];
    const plain = LINES.join("\n");

    it("in a file from Windows, the agent's plain text is written with the mark and Windows line ends, and only the line it changed counts", async () => {
      const windows = MARK + LINES.join("\r\n");
      corillo.files.set(PLAN, windows);
      const claude = connect();
      await claude.ok("take_document", { path: PLAN });
      const done = await claude.ok("replace_document", { path: PLAN, text: plain.replace("Second paragraph.", "The second paragraph.") });
      expect(done).toContain("(1 of 9 lines new or changed)");
      expect(corillo.files.get(PLAN)).toBe(windows.replace("Second paragraph.", "The second paragraph."));
      // The same words sent back change nothing.
      const same = await claude.ok("replace_document", { path: PLAN, text: plain.replace("Second paragraph.", "The second paragraph.") });
      expect(same).toContain("That's the same as the current text, so nothing changed.");
    });

    it("in a file with both kinds of line end, each unchanged line keeps its own, and a new line takes the most common", async () => {
      // Windows line ends but for the line after "First paragraph.", which has a Unix one.
      const mixed = "# Plan\r\n\r\nFirst paragraph.\n\r\nSecond paragraph.\r\n\r\n- one\r\n- two\r\n";
      corillo.files.set(PLAN, mixed);
      const claude = connect();
      await claude.ok("take_document", { path: PLAN });
      await claude.ok("replace_document", { path: PLAN, text: plain.replace("- two\n", "- two\n- three\n") });
      expect(corillo.files.get(PLAN)).toBe(mixed.replace("- two\r\n", "- two\r\n- three\r\n"));
    });

    it("a text with its own carriage returns, and an earlier version brought back, are written as they are", async () => {
      corillo.files.set(PLAN, MARK + LINES.join("\r\n"));
      const claude = connect();
      await claude.ok("take_document", { path: PLAN });
      const own = "# Plan\r\n\nOne line.\n";
      await claude.ok("replace_document", { path: PLAN, text: own });
      expect(corillo.files.get(PLAN)).toBe(MARK + own);
      await claude.ok("replace_document", { path: PLAN, from_version: 1 });
      expect(corillo.files.get(PLAN)).toBe(MARK + LINES.join("\r\n"));
    });
  });
});

describe("notes next to the document", () => {
  const NOTES = "Notes in the same folder as plan.md, worth reading for context:";

  it("an agent's first open or read of a document points it to the notes files beside it, once per session", async () => {
    corillo.files.set("/docs/context.md", "Goal: hire well.\n");
    corillo.files.set("/docs/README.md", "Our team's documents.\n");
    const claude = connect();
    expect(await claude.ok("open_document", { path: PLAN })).toContain(`${NOTES} /docs/context.md, /docs/README.md`);
    expect(await claude.ok("read_document", { path: PLAN })).not.toContain(NOTES);
    expect(await claude.ok("take_document", { path: PLAN })).not.toContain(NOTES);
    // A new session is pointed to them again, on its first read.
    expect(await connect().ok("read_document", { path: PLAN })).toContain(`${NOTES} /docs/context.md, /docs/README.md`);
  });

  it("there's no mention when there's no notes file", async () => {
    const claude = connect();
    for (const tool of ["open_document", "read_document", "take_document"]) {
      expect(await claude.ok(tool, { path: PLAN })).not.toContain("Notes in the same folder");
    }
  });

  it("README.md alone is enough, and taking the document counts as reading it", async () => {
    corillo.files.set("/docs/README.md", "Our team's documents.\n");
    expect(await connect().ok("take_document", { path: PLAN })).toContain(`${NOTES} /docs/README.md`);
  });
});

describe("waiting for another agent", () => {
  let patient: AgentService;
  const as = (s: AgentService, client: string) => {
    const { sessionId } = s.connect({ name: client });
    return (tool: string, args: Record<string, unknown> = {}) => s.call(sessionId, tool, args);
  };

  beforeEach(() => {
    patient = new AgentService(corillo, comments, hooks, { waitMs: 2000 });
  });

  it("take_document waits for the agent editing to finish, then takes the document", async () => {
    const claude = as(patient, "claude-code");
    const codex = as(patient, "codex");
    await claude("take_document", { path: PLAN });
    const waiting = codex("take_document", { path: PLAN });
    await new Promise((r) => setTimeout(r, 50));
    await claude("finish_editing", { path: PLAN });
    const r = await waiting;
    expect(r.isError).toBe(false);
    expect(r.text).toContain("You're editing plan.md now.");
  });

  it("if the agent editing doesn't finish in time, the waiting agent is told who has it", async () => {
    const quick = new AgentService(corillo, comments, hooks, { waitMs: 100 });
    const claude = as(quick, "claude-code");
    const codex = as(quick, "codex");
    await claude("take_document", { path: PLAN });
    const r = await codex("take_document", { path: PLAN });
    expect(r.isError).toBe(true);
    expect(r.text).toContain("Claude is editing plan.md right now. You can read it and comment meanwhile; call take_document again to wait for it.");
  });

  it("if the person takes over instead, the waiting agent doesn't snatch the document from them", async () => {
    const claude = as(patient, "claude-code");
    const codex = as(patient, "codex");
    await claude("take_document", { path: PLAN });
    const waiting = codex("take_document", { path: PLAN });
    await new Promise((r) => setTimeout(r, 50));
    await patient.takeOver("plan");
    const r = await waiting;
    expect(r.isError).toBe(true);
    expect(r.text).toContain("The person took plan.md over from Claude to edit it themselves. Don't take it until they ask you to.");
    expect(patient.editingAgent("plan")).toBeNull();
  });
});

describe("a take the agent cancels (the person pressed Esc, or its tool gave up)", () => {
  let patient: AgentService;
  beforeEach(() => {
    patient = new AgentService(corillo, comments, hooks, { waitMs: 2000 });
  });
  const session = (client: string) => {
    const { sessionId } = patient.connect({ name: client });
    return (tool: string, args: Record<string, unknown> = {}, signal?: AbortSignal) => patient.call(sessionId, tool, args, signal);
  };
  const nobodyEditing = () => {
    expect(patient.editingAgent("plan")).toBeNull();
    expect(corillo.agents.get("plan")!.some((a) => a.editing)).toBe(false);
    expect(corillo.locked.has("plan")).toBe(false);
  };

  it("stops waiting, and never takes the document when the agent holding it finishes", async () => {
    const claude = session("claude-code");
    const codex = session("codex");
    await claude("take_document", { path: PLAN });
    const esc = new AbortController();
    const waiting = codex("take_document", { path: PLAN }, esc.signal);
    await new Promise((r) => setTimeout(r, 50));
    const started = Date.now();
    esc.abort();
    expect((await waiting).isError).toBe(true);
    expect(Date.now() - started).toBeLessThan(500);
    await claude("finish_editing", { path: PLAN });
    await claude("list_documents"); // anything queued has run
    nobodyEditing();
  });

  it("cancelled while the person's edits are being saved: the document comes straight back, with no version", async () => {
    const claude = session("claude-code");
    await claude("open_document", { path: PLAN });
    let release!: () => void;
    const flushed = new Promise<void>((r) => (release = r));
    const flush = corillo.flush.bind(corillo);
    corillo.flush = async (doc, lock) => {
      const result = await flush(doc, lock);
      await flushed;
      return result;
    };
    const versions = corillo.history.list("plan").length;
    const esc = new AbortController();
    const taking = claude("take_document", { path: PLAN }, esc.signal);
    await new Promise((r) => setTimeout(r, 20));
    esc.abort();
    release();
    expect((await taking).isError).toBe(true);
    nobodyEditing();
    expect(passes).toEqual([]);
    expect(corillo.history.list("plan")).toHaveLength(versions);
    expect(corillo.dots).toEqual([]);
  });

  it("cancelled just after the take was done: given straight back, unless the agent has carried on", async () => {
    const claude = session("claude-code");
    await claude("open_document", { path: PLAN });
    const versions = corillo.history.list("plan").length;
    const esc = new AbortController();
    expect((await claude("take_document", { path: PLAN }, esc.signal)).isError).toBe(false);
    esc.abort();
    await claude("list_documents");
    nobodyEditing();
    expect(corillo.history.list("plan")).toHaveLength(versions);
    expect(corillo.dots).toEqual([]);
    // Once the agent has made another call, the take is its own: a late cancel changes nothing.
    const late = new AbortController();
    await claude("take_document", { path: PLAN }, late.signal);
    await claude("read_document", { path: PLAN });
    late.abort();
    await claude("list_documents");
    expect(patient.editingAgent("plan")).toBe("Claude");
  });
});

describe("what agents are told when something's off", () => {
  let patient: AgentService;
  beforeEach(() => {
    patient = new AgentService(corillo, comments, hooks, { waitMs: 2000 });
  });
  const session = (client: string) => {
    const { sessionId } = patient.connect({ name: client });
    return (tool: string, args: Record<string, unknown> = {}) => patient.call(sessionId, tool, args);
  };

  it("when the window doesn't answer in time, reads, history and exports say the person may have edits not in them", async () => {
    const claude = connect();
    await claude.ok("open_document", { path: PLAN });
    corillo.flushAnswer = "no-answer";
    const note = "Corillo's window didn't answer in time, so the person may have edits that aren't saved yet";
    expect(await claude.ok("read_document", { path: PLAN })).toContain(note);
    expect(await claude.ok("list_versions", { path: PLAN })).toContain(note);
    expect(await claude.ok("read_version", { path: PLAN, version: 1 })).toContain(note);
    expect(await claude.ok("export_document", { path: PLAN, format: "pdf" })).toContain(note);
  });

  it("a take that waited says once that the document was renamed", async () => {
    const claude = session("claude-code");
    const codex = session("codex");
    await claude("take_document", { path: PLAN });
    corillo.docs[0].formerPaths = new Set(["/docs/old plan.md"]);
    const waiting = codex("take_document", { path: "/docs/old plan.md" });
    await new Promise((r) => setTimeout(r, 50));
    await claude("finish_editing", { path: PLAN });
    const taken = (await waiting).text;
    // True whether it was renamed in Corillo (File > Rename or Move) or outside it.
    expect(taken.split("old plan.md was renamed or moved. It's now /docs/plan.md: use that path from now on.")).toHaveLength(2);
    expect(taken).not.toContain("outside Corillo");
    expect(taken).toContain("You're editing plan.md now.");
  });

  it("an agent waiting for one whose tab the person closed is told it was closed, not taken over", async () => {
    const claude = session("claude-code");
    const codex = session("codex");
    await claude("take_document", { path: PLAN });
    const waiting = codex("take_document", { path: PLAN });
    await new Promise((r) => setTimeout(r, 50));
    corillo.docs = [];
    await patient.closed("plan", PLAN);
    const told = await waiting;
    expect(told.isError).toBe(true);
    expect(told.text).toBe("The person closed plan.md while Claude was editing it. Don't take it until they ask you to.");
  });
});

describe("reading cheaply", () => {
  const long = PLAN_TEXT + "\nA paragraph that stays the same between reads, as most of a document does.\n".repeat(6);

  it("the first read is the whole text; later reads only what changed, including the person's own edits", async () => {
    corillo.files.set(PLAN, long);
    const claude = connect();
    expect(await claude.ok("read_document", { path: PLAN })).toBe(
      `Change plan.md only through Corillo (take_document, then edit_document or replace_document), never with your own file tools.\n\nThe whole text of plan.md follows.\n\n${long}`,
    );
    expect(await claude.ok("read_document", { path: PLAN })).toBe(UNCHANGED);
    corillo.unsaved.set(PLAN, long.replace("tight", "very tight")); // typed, not yet saved
    const changes = await claude.ok("read_document", { path: PLAN });
    expect(changes).toBe(
      "Changes to plan.md since your last read, as a unified diff of the Markdown (no context lines). If you no longer have the text, call read_document with whole set to true.\n\n@@ -7,1 +7,1 @@\n-The budget is tight.\n+The budget is very tight.",
    );
    expect(await claude.ok("read_document", { path: PLAN, whole: true })).toContain("The whole text of plan.md follows.");
  });

  it("a new chat in the same session is told how to get the whole text, each time it's given only changes", async () => {
    // Claude Desktop keeps one connector for all its chats, and Claude Code keeps it after /clear.
    const claude = connect();
    await claude.ok("read_document", { path: PLAN });
    expect(await claude.ok("read_document", { path: PLAN })).toContain("If you no longer have its text, call read_document with whole set to true.");
    expect(await claude.ok("take_document", { path: PLAN })).toContain("If you no longer have its text, call read_document with whole set to true.");
    expect(await claude.ok("read_document", { path: PLAN, whole: true })).toBe(`The whole text of plan.md follows.\n\n${PLAN_TEXT}`);
  });

  it("a long document's first read is its outline and its start, small enough for any agent tool; the rest is read by lines", async () => {
    // About 30,000 words: 204,000 characters, over what agent tools keep in one result (Claude Code: 50,000 characters).
    const big = bigDocument();
    const lines = big.split("\n").slice(0, -1); // it ends with a line break, as files do
    corillo.files.set(PLAN, big);
    const claude = connect();
    const first = await claude.ok("read_document", { path: PLAN });
    expect(first.length).toBeLessThan(30_000);
    expect(first).toContain(`plan.md is long (${lines.length.toLocaleString("en-US")} lines), so this is its outline and its first`);
    expect(first).toContain("Read any part with read_document's from_line and to_line.");
    // Each heading in the outline is on the line it says.
    const outline = first.split("Outline (line: heading):\n")[1].split("\n\n")[0].split("\n");
    expect(outline.length).toBeGreaterThan(20);
    for (const entry of outline) {
      const [, n, heading] = /^(\d+): (.*)$/.exec(entry)!;
      expect(lines[Number(n) - 1]).toBe(heading);
    }
    const shown = Number(/its first (\d+) lines/.exec(first)![1]);
    expect(first.endsWith(`Lines 1 to ${shown}:\n\n${lines.slice(0, shown).join("\n")}`)).toBe(true);
    // Any part, by its lines.
    expect(await claude.ok("read_document", { path: PLAN, from_line: 2000, to_line: 2010 })).toBe(
      `Lines 2000 to 2010 of plan.md (it has ${lines.length.toLocaleString("en-US")} lines):\n\n${lines.slice(1999, 2010).join("\n")}`,
    );
    const rest = await claude.ok("read_document", { path: PLAN, from_line: 10 });
    expect(rest.length).toBeLessThan(45_000);
    const stopped = Number(/\n\nStopped at line (\d+) to keep this answer short: read on from line (\d+)\.$/.exec(rest)![1]);
    expect(rest).toContain(`read on from line ${stopped + 1}.`);
    expect(rest.startsWith(`Lines 10 to ${stopped} of plan.md (it has ${lines.length.toLocaleString("en-US")} lines):\n\n${lines.slice(9, stopped).join("\n")}\n\nStopped`)).toBe(true);
    expect(await claude.fails("read_document", { path: PLAN, from_line: 9000 })).toBe(`plan.md has ${lines.length.toLocaleString("en-US")} lines, so there's no line 9000.`);
    // Later reads are cheap as ever; whole gives the outline again, as does taking it in a new session.
    expect(await claude.ok("read_document", { path: PLAN })).toBe(
      "plan.md hasn't changed since your last read. If you no longer have its text, read it again by lines with from_line and to_line (whole set to true gives its outline and start).",
    );
    expect(await claude.ok("read_document", { path: PLAN, whole: true })).toContain("so this is its outline");
    expect(await connect().ok("take_document", { path: PLAN })).toContain("so this is its outline");
    // A short document is read whole, as before.
    corillo.files.set("/docs/short.md", "# Short\n\nText.\n");
    expect(await claude.ok("read_document", { path: "/docs/short.md" })).toContain("The whole text of short.md follows.\n\n# Short\n\nText.\n");
  });

  // R-AG-9: they were told whole set to true gives the whole text, but for a long document it gives the outline again.
  it("a long document's later reads say how to read it again by lines, never that whole gives all of it", async () => {
    const big = bigDocument();
    corillo.files.set(PLAN, big);
    const claude = connect();
    await claude.ok("read_document", { path: PLAN });
    const byLines = "If you no longer have its text, read it again by lines with from_line and to_line (whole set to true gives its outline and start).";
    expect(await claude.ok("read_document", { path: PLAN })).toBe(`plan.md hasn't changed since your last read. ${byLines}`);
    corillo.files.set(PLAN, big.replace("\n", "\nA new line.\n"));
    const changed = await claude.ok("read_document", { path: PLAN });
    expect(changed).toContain(`Changes to plan.md since your last read, as a unified diff of the Markdown (no context lines). ${byLines}\n\n@@`);
    expect(changed).not.toContain("whole set to true.");
  });

  // R-AG-4: a line can't be read in less than whole, so a long document on one line was sent whole.
  it("a long document on one line is read a part at a time, cut between words, with where to read on", async () => {
    const words = Array.from({ length: 16_000 }, (_, i) => `word${i}`).join(" ");
    corillo.files.set(PLAN, `${words}\n`);
    const claude = connect();
    const count = (n: number) => n.toLocaleString("en-US");
    const first = await claude.ok("read_document", { path: PLAN });
    expect(first.length).toBeLessThan(30_000);
    expect(first).toContain("plan.md is long (1 line), so this is its outline and the first");
    const [, shown, next] = /the first ([\d,]+) characters of line 1, which is too long to read at once\. Read on with read_document's from_line 1 and from_character (\d+), and any other part with from_line and to_line\./
      .exec(first)!
      .map((s) => s.replace(/,/g, ""));
    expect(Number(next)).toBe(Number(shown) + 1);
    expect(first.endsWith(`Line 1, characters 1 to ${count(Number(shown))}:\n\n${words.slice(0, Number(shown))}`)).toBe(true);
    expect(words[Number(shown) - 1]).toBe(" "); // cut after a space, between words
    // Read on: each part under the limit, together the whole line.
    let read = words.slice(0, Number(shown));
    let from = Number(next);
    for (let parts = 0; from <= words.length && parts < 10; parts++) {
      const part = await claude.ok("read_document", { path: PLAN, from_line: 1, from_character: from });
      expect(part.length).toBeLessThan(45_000);
      const head = new RegExp(`^Line 1 of plan\\.md, characters ${count(from)} to ([\\d,]+) of its ${count(words.length)} \\(it has 1 line\\):\\n\\n`).exec(part);
      expect(head).not.toBeNull();
      const to = Number(head![1].replace(/,/g, ""));
      read += part.slice(head![0].length, head![0].length + to - from + 1);
      from = to + 1;
      if (to < words.length) expect(part.endsWith(`\n\nLine 1 is too long to read at once: read on with from_line 1 and from_character ${from}.`)).toBe(true);
      else expect(part.endsWith(words.slice(-20))).toBe(true);
    }
    expect(read).toBe(words);
    expect(await claude.fails("read_document", { path: PLAN, from_line: 1, from_character: words.length + 5 })).toBe(
      `Line 1 of plan.md has ${count(words.length)} characters, so there's no character ${words.length + 5}.`,
    );
    expect(await claude.fails("read_document", { path: PLAN, from_character: 5 })).toBe("Give from_line with from_character: the line to start in.");
  });

  it("an agent's own edits aren't repeated back to it on its next read", async () => {
    corillo.files.set(PLAN, long);
    const claude = connect();
    await claude.ok("take_document", { path: PLAN });
    await claude.ok("edit_document", { path: PLAN, edits: [{ find: "tight.", replace: "fine." }] });
    expect(await claude.ok("read_document", { path: PLAN })).toBe(UNCHANGED);
  });
});

describe("comments, for agents", () => {
  it("agents reply only on comments addressed to them or that they started", async () => {
    const claude = connect();
    const codex = connect("codex");
    await claude.ok("open_document", { path: PLAN });
    await codex.ok("open_document", { path: PLAN });
    const general = personComments("plan", "Tighten.", null);
    await claude.ok("list_comments", { path: PLAN }); // Claude picks it up first, so it's Claude's (D3)
    expect(await codex.fails("reply_to_comment", { path: PLAN, comment_id: idOf(general), text: "I'll do it" })).toContain(
      "isn't addressed to you",
    );
    expect(await claude.ok("reply_to_comment", { path: PLAN, comment_id: idOf(general), text: "Tightened." })).toBe(
      `Replied on [${idOf(general)}].`,
    );
    const asked = await codex.ok("add_comment", { path: PLAN, text: "Is the budget final?", quote: "budget is tight" });
    const id = /\[([0-9a-f]+)\]/.exec(asked)![1];
    expect(await codex.ok("reply_to_comment", { path: PLAN, comment_id: id, text: "Adding a detail." })).toContain("Replied");
    expect(await claude.fails("reply_to_comment", { path: PLAN, comment_id: id, text: "Me too" })).toContain("isn't addressed to you");
    expect(await claude.fails("reply_to_comment", { path: PLAN, comment_id: "nope", text: "x" })).toContain("no comment with the id");
  });

  it("an agent can't reply on a comment the person resolved", async () => {
    const claude = connect();
    await claude.ok("open_document", { path: PLAN });
    const t = personComments("plan", "Tighten.", null);
    comments.resolve("plan", t.id, person, true);
    expect(await claude.fails("reply_to_comment", { path: PLAN, comment_id: idOf(t), text: "x" })).toContain("resolved");
  });

  // Orlando, 2026-11-09
  it("a resolved comment is closed for agents: never listed, counted or handed over, waiting or answered", async () => {
    const claude = connect();
    await claude.ok("open_document", { path: PLAN });
    const waiting = personComments("plan", "Shorten the intro, please.", null);
    const answered = personComments("plan", "Name the owner.", null);
    await claude.ok("reply_to_comment", { path: PLAN, comment_id: idOf(answered), text: "Named Ana." });
    const before = await claude.ok("list_comments", { path: PLAN, include_answered: true });
    expect(before).toContain("Shorten the intro");
    expect(before).toContain("Name the owner");

    comments.resolve("plan", waiting.id, person, true);
    comments.resolve("plan", answered.id, person, true);
    for (const text of [
      await claude.ok("list_comments", { path: PLAN }),
      await claude.ok("list_comments", { path: PLAN, include_answered: true }),
      await claude.ok("take_document", { path: PLAN }),
    ]) {
      expect(text).not.toContain("Shorten the intro");
      expect(text).not.toContain("Name the owner");
      expect(text).not.toContain(idOf(waiting));
      expect(text).not.toContain(idOf(answered));
      expect(text).not.toMatch(/already answered/);
    }
    // Finishing isn't held up by a resolved comment.
    expect(await claude.ok("finish_editing", { path: PLAN })).not.toMatch(/waiting/i);
  });

  it("an agent's new comment goes to the person, on its exact quote or the whole document", async () => {
    const claude = connect();
    expect(await claude.ok("add_comment", { path: PLAN, text: "Should we say which roles?", quote: "two people" })).toContain(
      'Added a comment for the person on "two people"',
    );
    await claude.ok("add_comment", { path: PLAN, text: "Overall: good shape." });
    const [onQuote, whole] = comments.threads("plan");
    expect(onQuote.to).toBe("person");
    expect(onQuote.anchor?.quote).toBe("two people");
    expect(onQuote.messages[0].author).toEqual({ kind: "agent", name: "Claude" });
    expect(whole.anchor).toBeNull();
  });

  it("a quote must be in the document exactly once; Markdown marks in it are ignored", async () => {
    corillo.files.set(PLAN, "We hire **two** people.\n\nTwo is fine. Two is plenty.\n");
    const claude = connect();
    expect(await claude.fails("add_comment", { path: PLAN, text: "x", quote: "not there" })).toContain("isn't in the document");
    expect(await claude.fails("add_comment", { path: PLAN, text: "x", quote: "Two is" })).toContain("appears 2 times");
    await claude.ok("add_comment", { path: PLAN, text: "x", quote: "hire **two** people" });
    expect(comments.threads("plan")[0].anchor?.quote).toBe("hire two people");
  });

  it("a comment's line number points at the words it's on, even when the same words appear earlier", async () => {
    // Found in a trial: the agent had repeated the commented words in a summary at the top.
    const text = "# Plan\n\nWe aim for at least 4.5 out of 5.\n\n## Targets\n\nPartners should rate us at least 4.5 out of 5 by April.\n";
    corillo.files.set(PLAN, text);
    const anchor = { quote: "at least 4.5 out of 5", prefix: "Targets\nPartners should rate us ", suffix: " by April.", offset: 70 };
    expect(commentLines(text)(anchor)).toBe(7);
    expect(commentLines(text)({ ...anchor, prefix: "We aim for ", suffix: "." })).toBe(3);
    const claude = connect();
    await claude.ok("open_document", { path: PLAN });
    comments.add("plan", person, "Is 4.5 realistic?", anchor, null);
    expect(await claude.ok("list_comments", { path: PLAN })).toContain('on "at least 4.5 out of 5" (line 7)');
  });

  it("a comment's line number is the line of the very words it's on, in tables, lists, bold, links and headings too", async () => {
    // The comment is on the second time the words appear; the first is plain prose earlier on.
    const nth = (markdown: string, quote: string, n: number) => {
      const doc = parseMarkdown(markdown).doc;
      const index = textIndex(doc);
      let i = -1;
      for (let k = 0; k <= n; k++) i = index.text.indexOf(quote, i + 1);
      return anchorFor(doc, posAt(index, i, "start"), posAt(index, i + quote.length, "end"));
    };
    const shapes: [string, string, string, number][] = [
      ["a table cell", "# Sites\n\nWe open in Atlanta first, then Denver.\n\n| Site | Partners |\n|---|---|\n| Atlanta | 30 |\n| Denver | 20 |\n", "Atlanta", 7],
      ["a list item's start", "# Notes\n\nBudget is discussed below.\n\n- Budget for Q3\n- Staffing\n", "Budget", 5],
      ["a bold word", "The budget is tight.\n\nThe **budget** needs a second look.\n", "budget", 3],
      ["a heading", "Read the Next steps section.\n\n## Next steps\n\nDo it.\n", "Next steps", 3],
      ["a later paragraph", "We agree. It works.\n\nNot yet. It works.\n", "It works.", 3],
      ["a link's words", "The budget sheet is late.\n\nSee the [budget sheet](https://example.com/b) first.\n", "budget sheet", 3],
      ["a table shown as Markdown text", "Atlanta is first.\n\n| Site | Note |\n|---|---|\n| Atlanta | <span>new</span> |\n", "Atlanta", 5],
      ["a line of a paragraph written on several lines", "Then we ship.\n\nFirst we test,\nthen we ship.\n", "we ship.", 4],
    ];
    for (const [what, markdown, quote, line] of shapes) {
      expect({ what, line: commentLines(markdown)(nth(markdown, quote, 1)) }).toEqual({ what, line });
    }
    // And the agent is told that line.
    corillo.files.set(PLAN, shapes[0][1]);
    const claude = connect();
    await claude.ok("open_document", { path: PLAN });
    comments.add("plan", person, "Are 30 partners realistic?", nth(shapes[0][1], "Atlanta", 1), null);
    expect(await claude.ok("list_comments", { path: PLAN })).toContain('on "Atlanta" (line 7)');
  });

  // Orlando, 2026-11-11: he selected three numbered items and wrote "agreed"; the agent was
  // shown the first 160 characters, read it as a comment on the first item alone, and left the others open.
  it("a comment on several items or paragraphs is given whole, with every line it's on; a very long one says it's cut short", async () => {
    const items = [
      "5. One page per team, in the shared folder, using the usual template: a summary first, then every decision word for word.",
      "6. One page per edition of the handbook, since each edition was read on its own and marked up differently.",
      "7. Team histories go under onboarding, linked from the welcome page and from the teams they're about.",
    ];
    const text = `# Triage\n\nDecisions to make:\n\n${items.join("\n")}\n\nThe rest can wait.\n`;
    corillo.files.set(PLAN, text);
    const doc = parseMarkdown(text).doc;
    const index = textIndex(doc);
    const words = (quote: string) => {
      const i = index.text.indexOf(quote);
      return anchorFor(doc, posAt(index, i, "start"), posAt(index, i + quote.length, "end"));
    };
    const all = words(`${items[0].slice(3)}\n${items[1].slice(3)}\n${items[2].slice(3)}`);
    const claude = connect();
    await claude.ok("open_document", { path: PLAN });
    const agreed = comments.add("plan", person, "Agreed.", all, null);
    const listed = await claude.ok("list_comments", { path: PLAN });
    // Every word of all three, and the lines from the first item to the last.
    expect(listed).toContain(`[${idOf(agreed)}] on "${all.quote}" (lines 5 to 7)`);
    expect(listed).toContain("onboarding, linked from the welcome page and from the teams they're about.");
    // The take gives the same.
    expect(await claude.ok("take_document", { path: PLAN })).toContain(`on "${all.quote}" (lines 5 to 7)`);
    await claude.call("finish_editing", { path: PLAN }); // the one left is pointed out once
    await claude.ok("finish_editing", { path: PLAN });

    // Words longer than the agent is shown whole: their start, every line, and a plain word that there's more.
    const long = Array.from({ length: 12 }, (_, i) => `Paragraph ${i + 1} says something about the plan that runs on for a while.`);
    const longText = `# Plan\n\n${long.join("\n\n")}\n`;
    corillo.files.set(PLAN, longText);
    const longDoc = parseMarkdown(longText).doc;
    const longIndex = textIndex(longDoc);
    const from = longIndex.text.indexOf("Paragraph 1 ");
    const to = longIndex.text.indexOf("for a while.", longIndex.text.indexOf("Paragraph 12 ")) + "for a while.".length;
    const section = anchorFor(longDoc, posAt(longIndex, from, "start"), posAt(longIndex, to, "end"));
    expect(section.quote.length).toBeGreaterThan(600);
    const tighten = comments.add("plan", person, "Tighten all of this.", section, null);
    const shown = await claude.ok("list_comments", { path: PLAN });
    expect(shown).toContain(`[${idOf(tighten)}] on "Paragraph 1 says`);
    expect(shown).toContain(`…" (lines 3 to 25; only the start of its ${section.quote.length.toLocaleString("en-US")} characters is shown here)`);
  });

  it("already-answered comments aren't listed again unless asked for", async () => {
    const claude = connect();
    await claude.ok("open_document", { path: PLAN });
    const t = personComments("plan", "Tighten.", null);
    await claude.ok("reply_to_comment", { path: PLAN, comment_id: idOf(t), text: "Done." });
    const list = await claude.ok("list_comments", { path: PLAN });
    expect(list).toContain("No comments on plan.md are waiting for you.");
    expect(list).toContain("1 comment you've already answered is waiting for the person");
    expect(await claude.ok("list_comments", { path: PLAN, include_answered: true })).toContain("Claude (you): Done.");
  });

  // Orlando, 2026-11-09: @ to tag an agent in a comment.
  it("a comment tagged with @ goes only to that agent, which sees whom each message was for", async () => {
    const claude = connect();
    const writer = connect("writer-tool", "Writer");
    await claude.ok("open_document", { path: PLAN });
    await writer.ok("open_document", { path: PLAN });
    const t = comments.add("plan", person, "@Writer make this warmer, then @Claude can check the numbers.", null, "Writer", "Writer");
    expect(t.to).toBe("Writer");
    const forWriter = await writer.ok("list_comments", { path: PLAN });
    expect(forWriter).toContain("Person (to you): @Writer make this warmer, then @Claude can check the numbers.");
    // Claude is the default agent and is named too, but the comment is Writer's.
    expect(await claude.ok("list_comments", { path: PLAN })).toContain("No comments on plan.md are waiting for you.");
    await writer.ok("reply_to_comment", { path: PLAN, comment_id: idOf(t), text: "Warmer now." });
    // The person hands it to Claude with @ in a reply: now it's Claude's, and Writer's no longer.
    comments.reply("plan", t.id, person, "@Claude over to you for the numbers.", "Claude");
    const forClaude = await claude.ok("list_comments", { path: PLAN });
    expect(forClaude).toContain("Person (to Writer): @Writer make this warmer");
    expect(forClaude).toContain("Writer: Warmer now.");
    expect(forClaude).toContain("Person (to you): @Claude over to you for the numbers.");
    expect(await writer.fails("reply_to_comment", { path: PLAN, comment_id: idOf(t), text: "Me again" })).toContain("isn't addressed to you");
  });

  // Orlando (2026-11-09): the @ list shows which agents are connected right now.
  it("Corillo hears at once who is connected: as a session starts, takes its role's name, and ends", async () => {
    const claude = connect();
    const writer = connect("writer-tool");
    await writer.ok("introduce", { name: "Writer" });
    await claude.end();
    await writer.end();
    expect(corillo.connections).toEqual([
      "Claude",
      // The newest connection first, by its tool's name until it says who it is.
      "Writer Tool, Claude",
      "Writer, Claude",
      "Writer (Claude left)",
      " (Writer left)",
    ]);
  });
});

describe("looking back through the versions", () => {
  /** The person edits, comments; Claude takes it, changes the text, replies and finishes. */
  async function onePass() {
    const claude = connect();
    await claude.ok("open_document", { path: PLAN });
    corillo.unsaved.set(PLAN, PLAN_TEXT.replace("tight.", "tight. Very."));
    const t = personComments("plan", "Three, not two.", "hire two people");
    await claude.ok("take_document", { path: PLAN });
    await claude.ok("edit_document", { path: PLAN, edits: [{ find: "hire two people", replace: "hire three people" }] });
    await claude.ok("reply_to_comment", { path: PLAN, comment_id: idOf(t), text: "Changed to three." });
    await claude.ok("finish_editing", { path: PLAN });
    return claude;
  }

  it("an agent lists the versions, newest first, with who made each and what each pass addressed", async () => {
    const claude = await onePass();
    const list = await claude.ok("list_versions", { path: PLAN });
    expect(list).toMatch(/^plan\.md has 3 versions, newest first:/);
    expect(list).toMatch(
      /Version 3 \(current\): Claude, .* \(just now\)\. Addressed 1 comment:\n {2}- on "hire two people"\n {4}Person: Three, not two\.\n {4}Claude: Changed to three\./,
    );
    expect(list).toMatch(/Version 2: The person, /);
    expect(list).toMatch(/Version 1: First version, /);
    expect(list.indexOf("Version 3")).toBeLessThan(list.indexOf("Version 1"));
  });

  it("the person's unsaved edits count as the newest version when an agent looks", async () => {
    const claude = connect();
    await claude.ok("open_document", { path: PLAN });
    corillo.unsaved.set(PLAN, PLAN_TEXT + "\nA new line.\n");
    expect(await claude.ok("list_versions", { path: PLAN })).toMatch(/Version 2 \(current\): The person/);
  });

  it("an agent reads an old version's whole text, and the document stays as it is", async () => {
    const claude = await onePass();
    const old = await claude.ok("read_version", { path: PLAN, version: 1 });
    expect(old).toMatch(/^The whole text of version 1 of plan\.md \(First version, .*\) follows\.\n\n/);
    expect(old).toContain(PLAN_TEXT);
    expect(corillo.files.get(PLAN)).toContain("hire three people");
    expect(await claude.ok("read_version", { path: PLAN, version: 3 })).toContain("It's the current version.");
  });

  it("an old version of a long document is read as its outline and its start, the rest by lines, as read_document does (AG-9)", async () => {
    // About 30,000 words: over what agent tools keep in one result (Claude Code: 50,000 characters).
    const big = bigDocument();
    const lines = big.split("\n").slice(0, -1);
    const n = lines.length.toLocaleString("en-US");
    corillo.files.set(PLAN, big);
    const claude = connect();
    await claude.ok("take_document", { path: PLAN });
    await claude.ok("edit_document", { path: PLAN, edits: [{ find: "### 2.2 ", replace: "### 2.2 Rewritten " }] });
    await claude.ok("finish_editing", { path: PLAN });
    const first = await claude.ok("read_version", { path: PLAN, version: 1 });
    expect(first.length).toBeLessThan(30_000);
    expect(first).toMatch(new RegExp(`^Version 1 of plan\\.md \\(First version, .*\\) is long \\(${n} lines\\), so this is its outline and its first \\d+ lines\\. Read any part with read_version's from_line and to_line\\.\\n\\nOutline \\(line: heading\\):\\n`));
    const shown = Number(/its first (\d+) lines/.exec(first)![1]);
    expect(first.endsWith(`Lines 1 to ${shown}:\n\n${lines.slice(0, shown).join("\n")}`)).toBe(true);
    expect(await claude.ok("read_version", { path: PLAN, version: 2 })).toContain("so this is its outline and its first");
    expect(await claude.ok("read_version", { path: PLAN, version: 2 })).toContain("It's the current version.");
    // Any part of it, by its lines, as that version has them.
    const heading = lines.findIndex((l) => l.startsWith("### 2.2 ")) + 1;
    expect(await claude.ok("read_version", { path: PLAN, version: 1, from_line: heading, to_line: heading + 2 })).toBe(
      `Lines ${heading} to ${heading + 2} of version 1 of plan.md (it has ${n} lines):\n\n${lines.slice(heading - 1, heading + 2).join("\n")}`,
    );
    expect(await claude.ok("read_version", { path: PLAN, version: 2, from_line: heading, to_line: heading })).toContain("### 2.2 Rewritten ");
    const rest = await claude.ok("read_version", { path: PLAN, version: 1, from_line: 10 });
    expect(rest.length).toBeLessThan(45_000);
    expect(rest).toMatch(/\n\nStopped at line \d+ to keep this answer short: read on from line \d+\.$/);
    expect(await claude.fails("read_version", { path: PLAN, version: 1, from_line: 9000 })).toBe(`Version 1 of plan.md has ${n} lines, so there's no line 9000.`);
    expect(await claude.fails("read_version", { path: PLAN, version: 1, from_line: 0 })).toContain("from_line must be a line number");
    // The document itself is as it was, and a short version is still read whole.
    expect(corillo.files.get(PLAN)).toContain("### 2.2 Rewritten ");
    corillo.files.set("/docs/short.md", "# Short\n\nText.\n");
    expect(await claude.ok("read_version", { path: "/docs/short.md", version: 1 })).toMatch(/^The whole text of version 1 of short\.md \(First version, .*\) follows\. It's the current version\.\n\n# Short\n\nText\.\n$/);
    expect(await claude.ok("read_version", { path: "/docs/short.md", version: 1, from_line: 3 })).toBe("Lines 3 to 3 of version 1 of short.md (it has 3 lines):\n\nText.");
  });

  it("an agent brings back an earlier version with from_version, without sending its text", async () => {
    const claude = await onePass();
    // Not without taking the document first.
    expect(await claude.fails("replace_document", { path: PLAN, from_version: 1 })).not.toContain("brought back");
    await claude.ok("take_document", { path: PLAN });
    expect(await claude.fails("replace_document", { path: PLAN, from_version: 1, text: "# Mine\n" })).toContain(
      "Give either text or from_version, not both",
    );
    expect(await claude.fails("replace_document", { path: PLAN, from_version: 9 })).toContain("9");
    expect(await claude.ok("replace_document", { path: PLAN, from_version: 1 })).toMatch(/^Done: brought back version 1 of plan\.md \(/);
    expect(corillo.files.get(PLAN)).toBe(PLAN_TEXT);
    expect(await claude.ok("replace_document", { path: PLAN, from_version: 1 })).toContain("Version 1 is the same as the current text");
    expect(await claude.fails("replace_document", { path: PLAN })).toContain("or from_version to bring back an earlier version");
    await claude.ok("finish_editing", { path: PLAN });
    expect(await claude.ok("list_versions", { path: PLAN })).toMatch(/Version 4 \(current\): Claude/);
  });

  it("show_changes says what the newest version changed, like Show changes, or between any two versions", async () => {
    const claude = await onePass();
    const latest = await claude.ok("show_changes", { path: PLAN });
    expect(latest).toMatch(/^What version 3 of plan\.md \(Claude, .*\) changed, compared with version 2 \(The person\)\./);
    expect(latest).toContain("We should hire [-two-]{+three+} people this quarter.");
    expect(latest).not.toContain("Very.");
    const persons = await claude.ok("show_changes", { path: PLAN, version: 2 });
    expect(persons).toContain("The budget is tight.{+ Very.+}");
    const both = await claude.ok("show_changes", { path: PLAN, version: 3, compared_with: 1 });
    expect(both).toMatch(/^Changes to plan\.md from version 1 \(First version, .*\) to version 3 \(Claude, .*\)\./);
    expect(both).toContain("[-two-]{+three+}");
    expect(both).toContain("{+ Very.+}");
    // The other way round says the same.
    expect(await claude.ok("show_changes", { path: PLAN, version: 1, compared_with: 3 })).toBe(both);
  });

  it("the first version has nothing earlier to compare with, and a version that isn't there gets a clear answer", async () => {
    const claude = connect();
    await claude.ok("open_document", { path: PLAN });
    expect(await claude.ok("show_changes", { path: PLAN })).toContain("is its first version");
    expect(await claude.fails("read_version", { path: PLAN, version: 7 })).toBe("plan.md has no version 7. Its versions are 1 to 1.");
    expect(await claude.fails("read_version", { path: PLAN, version: "latest" })).toContain("as a version number from list_versions");
    expect(await claude.fails("read_version", { path: PLAN })).toContain("Give the version's number");
    expect(await claude.fails("show_changes", { path: PLAN, version: 1, compared_with: 1 })).toContain("two different versions");
  });

  it("only the newest 20 versions are listed unless the agent asks for all", async () => {
    const claude = connect();
    await claude.ok("open_document", { path: PLAN });
    for (let i = 2; i <= 25; i++) corillo.history.outside("plan", `${PLAN_TEXT}\nChange ${i}.\n`);
    const some = await claude.ok("list_versions", { path: PLAN });
    expect(some).toContain("Version 25 (current)");
    expect(some).toContain("Version 6:");
    expect(some).not.toContain("Version 5:");
    expect(some).toContain("5 older versions not shown; set all to true to list them.");
    const all = await claude.ok("list_versions", { path: PLAN, all: true });
    expect(all).toContain("Version 1: First version");
    expect(all).not.toContain("not shown");
  });
});

// Orlando, 2026-11-09: "is there any way to see the full context of the request
// the agent was responding to? Right now I see it cuts off." Agents asking about
// a past pass get it in full too.
describe("a past pass, in full, for agents", () => {
  const LONG_COMMENT =
    "This is good, but can you make it sound more gothic? Like something Edgar Allan Poe would write.\nKeep the numbers exactly as they are, and keep it under two sentences, because the steering group reads this on their phones.";
  const LONG_REPLY =
    "Made it darker: the hiring line now reads as a dread-soaked confession, with the same three people and the same quarter. I kept it to one sentence and left every number alone, as you asked, so the steering group sees the same facts.";

  it("gives each comment, its words, every message and the chat request whole, never cut off", async () => {
    const claude = connect();
    const hire = personComments("plan", LONG_COMMENT, "We should hire two people this quarter.");
    const budget = personComments("plan", "Say by how much.", "The budget is tight.");
    const request = `Please make the whole document read like a ghost story. ${"Every heading should feel like a door creaking open. ".repeat(4)}Thank you.`;
    await claude.ok("take_document", { path: PLAN, request });
    // The window keeps a comment on its words as they're rewritten: it's on the new words by the end.
    await claude.ok("edit_document", {
      path: PLAN,
      edits: [{ find: "We should hire two people this quarter.", replace: "In the dread of this quarter, we must hire three souls." }],
      comment_ids: [idOf(hire)],
    });
    comments.setAnchors("plan", { [hire.id]: anchorForQuote(corillo.files.get(PLAN)!, "In the dread of this quarter, we must hire three souls.")! });
    await claude.ok("reply_to_comment", { path: PLAN, comment_id: idOf(hire), text: LONG_REPLY });
    // Some back-and-forth in the same pass.
    await claude.ok("reply_to_comment", { path: PLAN, comment_id: idOf(budget), text: "By how much would you like?" });
    comments.reply("plan", budget.id, person, "Ten percent.\nSay it plainly.");
    await claude.ok("edit_document", { path: PLAN, edits: [{ find: "is tight.", replace: "is ten percent tighter." }], comment_ids: [idOf(budget)] });
    await claude.ok("reply_to_comment", { path: PLAN, comment_id: idOf(budget), text: "Said ten percent." });
    await claude.ok("finish_editing", { path: PLAN });
    // The person resolves both afterwards; History is the record, so nothing is lost.
    comments.resolve("plan", hire.id, person, true);
    comments.resolve("plan", budget.id, person, true);

    const list = await claude.ok("list_versions", { path: PLAN });
    expect(list).toContain('- on "We should hire two people this quarter."');
    expect(list).toContain(`Person: ${LONG_COMMENT.replace("\n", "\n      ")}`);
    expect(list).toContain(`Claude: ${LONG_REPLY}`);
    expect(list).toContain(
      '- on "The budget is tight."\n    Person: Say by how much.\n    Claude: By how much would you like?\n    Person: Ten percent.\n      Say it plainly.\n    Claude: Said ten percent.\n    Changed: ',
    );
    expect(list).toContain(`Asked in chat: "${request}"`);
    expect(list).not.toContain("…");
  });

  it("a thread answered over several passes is given whole once, then only what each pass added", async () => {
    const claude = connect();
    const t = personComments("plan", "Tighten the budget line.", "The budget is tight.");
    for (const [ask, answer] of [
      [null, "Cut a word."],
      ["Tighter still.", "Cut another."],
      ["Perfect, one more pass.", "Done."],
    ] as const) {
      if (ask) comments.reply("plan", t.id, person, ask);
      await claude.ok("take_document", { path: PLAN });
      await claude.ok("reply_to_comment", { path: PLAN, comment_id: idOf(t), text: answer });
      await claude.ok("finish_editing", { path: PLAN });
    }
    const list = await claude.ok("list_versions", { path: PLAN });
    const at = (n: number) => list.slice(list.indexOf(`Version ${n}`), n > 2 ? list.indexOf(`Version ${n - 1}`) : undefined);
    expect(at(2)).toContain('- on "The budget is tight."\n    Person: Tighten the budget line.\n    Claude: Cut a word.');
    expect(at(3)).toContain(
      "    Person: Tighten the budget line.\n    (1 earlier message in this thread: see version 2)\n    Person: Tighter still.\n    Claude: Cut another.",
    );
    expect(at(4)).toContain(
      "    Person: Tighten the budget line.\n    (3 earlier messages in this thread: see version 3)\n    Person: Perfect, one more pass.\n    Claude: Done.",
    );
  });

  it("says whom the person's message was for when it named an agent", async () => {
    const claude = connect();
    const t = comments.add("plan", person, "@Claude tighten this", anchorForQuote(PLAN_TEXT, "The budget is tight."), "Claude", "Claude");
    await claude.ok("take_document", { path: PLAN });
    await claude.ok("reply_to_comment", { path: PLAN, comment_id: idOf(t), text: "It's already tight." });
    await claude.ok("finish_editing", { path: PLAN });
    expect(await claude.ok("list_versions", { path: PLAN })).toContain("Person (to Claude): @Claude tighten this\n    Claude: It's already tight.");
  });
});

describe("exporting", () => {
  it("an agent exports to Word next to the document by default, with the person's pending edits", async () => {
    const claude = connect();
    await claude.ok("open_document", { path: PLAN });
    corillo.unsaved.set(PLAN, PLAN_TEXT + "\nTyped just now.\n");
    const done = await claude.ok("export_document", { path: PLAN, format: "word" });
    expect(done).toContain("Exported plan.md as a Word document: /docs/plan.docx");
    expect(corillo.files.get("/docs/plan.docx")).toContain("Typed just now.");
    expect(corillo.log).toContain("Claude exported plan.md to /docs/plan.docx");
  });

  it("an existing file is never replaced unless the agent says so", async () => {
    const claude = connect();
    corillo.files.set("/docs/plan.pdf", "the person's own PDF");
    const refused = await claude.fails("export_document", { path: PLAN, format: "pdf" });
    expect(refused).toContain("There's already a file at /docs/plan.pdf, so nothing was exported.");
    expect(refused).toContain("replace set to true");
    expect(corillo.files.get("/docs/plan.pdf")).toBe("the person's own PDF");
    expect(await claude.ok("export_document", { path: PLAN, format: "pdf", replace: true })).toContain("/docs/plan.pdf");
    expect(corillo.files.get("/docs/plan.pdf")).toMatch(/^pdf of: # Plan/);
  });

  it("an agent can choose where the export goes: a folder, or a file name (the right ending is added)", async () => {
    const claude = connect();
    expect(await claude.ok("export_document", { path: PLAN, format: "pdf", output_path: "/exports" })).toContain("/exports/plan.pdf");
    expect(await claude.ok("export_document", { path: PLAN, format: "word", output_path: "/exports/For Ana" })).toContain(
      "/exports/For Ana.docx",
    );
    expect(await claude.fails("export_document", { path: PLAN, format: "pdf", output_path: "out.pdf" })).toContain("full path");
    expect(await claude.fails("export_document", { path: PLAN, format: "html" })).toBe('Give format as "word" or "pdf".');
  });

  it("an agent can't export while the person's edits clash with an outside change or couldn't be saved", async () => {
    const claude = connect();
    corillo.flushAnswer = "conflict";
    expect(await claude.fails("export_document", { path: PLAN, format: "word" })).toContain("haven't chosen which version to keep");
    corillo.flushAnswer = "unsaved";
    expect(await claude.fails("export_document", { path: PLAN, format: "word" })).toContain("can't save");
    expect(corillo.files.has("/docs/plan.docx")).toBe(false);
  });

  it("an export doesn't hold up the person: Take over and other agents carry on meanwhile", async () => {
    const claude = connect();
    const codex = connect("codex-mcp-client");
    await claude.ok("take_document", { path: PLAN });
    let release!: () => void;
    corillo.exportGate = new Promise((r) => (release = r));
    const exporting = claude.call("export_document", { path: PLAN, format: "pdf" });
    await service.takeOver("plan");
    expect(await codex.ok("list_documents")).toContain("no comments waiting for you");
    expect(corillo.files.has("/docs/plan.pdf")).toBe(false);
    release();
    expect((await exporting).text).toContain("Exported plan.md as a PDF");
  });
});

describe("tying edits to the comments they answer", () => {
  it("records, per comment, the text its edits changed; the agent is told which comment each edit was for", async () => {
    const claude = connect();
    const hire = personComments("plan", "Make it three.", "two people");
    const tight = personComments("plan", "Say by how much.", "tight");
    await claude.ok("take_document", { path: PLAN });
    expect(
      await claude.ok("edit_document", { path: PLAN, edits: [{ find: "two people", replace: "three people" }], comment_ids: [idOf(hire)] }),
    ).toContain(`made to plan.md, for comment [${idOf(hire)}]. As it reads now:`);
    // Different comments in one call: comment_ids on each edit.
    await claude.ok("edit_document", {
      path: PLAN,
      edits: [
        { find: "is tight.", replace: "is tight: 10% under plan.", comment_ids: [idOf(tight)] },
        { find: "# Plan", replace: "# Hiring plan" },
      ],
    });
    const [a, b] = comments.threads("plan");
    expect(a.change).toMatchObject({ round: 1, agent: "Claude" });
    expect(a.change!.spans.map((s) => [s.removed, s.anchor.quote])).toEqual([["two", "three"]]);
    expect(b.change!.spans.map((s) => s.anchor.quote).join("")).toContain("10% under plan");
    // The rest is the pass's other changes, kept with its version (History), not with the comments (roadmap Batch 9, item 5).
    await claude.fails("finish_editing", { path: PLAN }); // Not finished: the two comments have no reply.
    await claude.ok("finish_editing", { path: PLAN });
    expect(ended.at(-1)!.other!.map((s) => s.anchor.quote)).toEqual(["Hiring plan"]);
    expect(readdirSync(path.join(dataDir, "documents")).flatMap((d) => readdirSync(path.join(dataDir, "documents", d)))).not.toContain("other-changes.json");
  });

  it("a change the file refused leaves no trace on the comment, in the other changes or in the history", async () => {
    const claude = connect();
    const hire = personComments("plan", "Make it three.", "two people");
    await claude.ok("take_document", { path: PLAN });
    await claude.ok("edit_document", { path: PLAN, edits: [{ find: "# Plan", replace: "# Hiring plan" }] });
    corillo.refuseWrite = "Your change to plan.md couldn't be saved: it's locked. Nothing was changed.";
    for (const [tool, args] of [
      ["edit_document", { edits: [{ find: "two people", replace: "three people" }, { find: "is tight", replace: "is fine" }] }],
      ["replace_document", { text: "# Hiring plan\n\nWe should hire three people.\n" }],
    ] as const) {
      expect(await claude.fails(tool, { path: PLAN, ...args, comment_ids: [idOf(hire)] })).toContain("couldn't be saved");
      expect(comments.threads("plan")[0].change).toBeUndefined();
    }
    // The pass carries on from where it was: a change the file takes is recorded as usual.
    corillo.refuseWrite = null;
    await claude.ok("edit_document", { path: PLAN, edits: [{ find: "is tight", replace: "is fine" }] });
    // The agent tells the person and hands it back: the version records only what was made.
    await claude.ok("reply_to_comment", { path: PLAN, comment_id: idOf(hire), text: "I couldn't change it: the file is locked." });
    await claude.ok("finish_editing", { path: PLAN });
    expect(ended.at(-1)!.addressed.map((t) => t.change)).toEqual([undefined]);
    expect(ended.at(-1)!.other!.map((s) => s.anchor.quote)).toEqual(["Hiring plan", "fine"]);
    const version = corillo.history.list("plan").at(-1)!;
    expect(version.addressed!.map((t) => t.change)).toEqual([undefined]);
    // The next pass's change is tied as usual.
    await claude.ok("take_document", { path: PLAN });
    await claude.ok("edit_document", { path: PLAN, edits: [{ find: "two people", replace: "three people" }], comment_ids: [idOf(hire)] });
    expect(comments.threads("plan")[0].change!.spans.map((s) => [s.removed, s.anchor.quote])).toEqual([["two", "three"]]);
  });

  it("refuses ids that aren't the agent's to answer, and changes nothing", async () => {
    const claude = connect();
    const forWriter = personComments("plan", "For Writer.", "two people", "Writer");
    const done = personComments("plan", "Old point.", "tight");
    comments.resolve("plan", done.id, person, true);
    await claude.ok("take_document", { path: PLAN });
    const edit = (ids: string[]) => claude.fails("edit_document", { path: PLAN, edits: [{ find: "two", replace: "three" }], comment_ids: ids });
    expect(await edit([idOf(forWriter)])).toContain("isn't addressed to you, so an edit can't answer it. Nothing was changed.");
    expect(await edit([idOf(done)])).toContain("resolved");
    expect(await edit(["nope"])).toContain("Nothing was changed.");
    expect(corillo.files.get(PLAN)).toBe(PLAN_TEXT);
  });

  it("still works for an agent that never gives ids: its changes are other changes, and it's reminded once a pass", async () => {
    const claude = connect();
    personComments("plan", "Make it three.", "two people");
    await claude.ok("take_document", { path: PLAN });
    const first = await claude.ok("edit_document", { path: PLAN, edits: [{ find: "two", replace: "three" }] });
    expect(first).toContain("This change isn't tied to a comment.");
    const second = await claude.ok("edit_document", { path: PLAN, edits: [{ find: "tight", replace: "very tight" }] });
    expect(second).not.toContain("isn't tied");
    expect(corillo.files.get(PLAN)).toContain("hire three people");
    await claude.fails("finish_editing", { path: PLAN }); // Not finished: the comment has no reply.
    await claude.ok("finish_editing", { path: PLAN });
    expect(ended.at(-1)!.other!.map((s) => s.anchor.quote)).toEqual(["three", "very"]);
  });

  it("keeps each pass's comments and other changes in the history, and list_versions shows them", async () => {
    const claude = connect();
    const hire = personComments("plan", "Make it three.", "two people");
    await claude.ok("take_document", { path: PLAN });
    await claude.ok("edit_document", { path: PLAN, edits: [{ find: "two", replace: "three" }], comment_ids: [idOf(hire)] });
    await claude.ok("edit_document", { path: PLAN, edits: [{ find: "tight", replace: "very tight" }] });
    await claude.ok("reply_to_comment", { path: PLAN, comment_id: idOf(hire), text: "Three it is." });
    await claude.ok("finish_editing", { path: PLAN });
    expect(ended[0].addressed.map((t) => t.id)).toEqual([hire.id]);
    expect(ended[0].other!.map((s) => s.anchor.quote)).toEqual(["very"]);
    const versions = await claude.ok("list_versions", { path: PLAN });
    expect(versions).toContain("Changed: [-two-]{+three+}");
    expect(versions).toContain("Changes not tied to a comment: {+very+}");
  });

  it("a later edit moves earlier changes with the text, and a second round keeps only its own change", async () => {
    const claude = connect();
    const hire = personComments("plan", "Make it three.", "two people");
    await claude.ok("take_document", { path: PLAN });
    await claude.ok("edit_document", { path: PLAN, edits: [{ find: "two", replace: "three" }], comment_ids: [idOf(hire)] });
    await claude.ok("reply_to_comment", { path: PLAN, comment_id: idOf(hire), text: "Done." });
    await claude.ok("finish_editing", { path: PLAN });
    comments.reply("plan", hire.id, person, "And say when.");
    await claude.ok("take_document", { path: PLAN });
    await claude.ok("edit_document", { path: PLAN, edits: [{ find: "# Plan", replace: "# Plan\n\nIntro." }] });
    expect(comments.threads("plan")[0].change!.spans[0].anchor.prefix).toContain("Intro.");
    await claude.ok("edit_document", { path: PLAN, edits: [{ find: "this quarter", replace: "by March" }], comment_ids: [idOf(hire)] });
    expect(comments.threads("plan")[0].change).toMatchObject({ round: 2 });
    expect(comments.threads("plan")[0].change!.spans.map((s) => s.anchor.quote)).toEqual(["by March"]);
  });

  it("when an edit deletes all of a comment's words, the comment keeps their place", async () => {
    const claude = connect();
    const budget = personComments("plan", "Drop this.", "The budget is tight.");
    await claude.ok("take_document", { path: PLAN });
    await claude.ok("edit_document", { path: PLAN, edits: [{ find: "\n\nThe budget is tight.", replace: "" }], comment_ids: [idOf(budget)] });
    const t = comments.threads("plan")[0];
    expect(t.gap).toMatchObject({ quote: "" });
    expect(t.gap!.prefix).toMatch(/Budget$/);
    expect(t.anchor!.quote).toBe("The budget is tight.");
  });
});

describe("comments follow an agent's edit by where their words are, not by searching for them (ST-1)", () => {
  const SALES = "# Sales\n\nAsk customers first. Pay customers well. Thank customers often.\n\n## Budget\n\nThe budget is tight this year.\n\nWe review it in June.\n";

  beforeEach(() => corillo.files.set(PLAN, SALES));

  /** A comment on the nth time (from 0) some words appear, anchored the way the window anchors one. */
  function commentOnNth(body: string, quote: string, nth: number): Thread {
    const doc = parseMarkdown(corillo.files.get(PLAN)!).doc;
    const index = textIndex(doc);
    let at = -1;
    for (let i = 0; i <= nth; i++) at = index.text.indexOf(quote, at + 1);
    return comments.add("plan", person, body, anchorFor(doc, posAt(index, at, "start"), posAt(index, at + quote.length, "end"), index), null);
  }
  const now = (t: Thread) => comments.threads("plan").find((x) => x.id === t.id)!;
  /** The words at a comment's stored place, in the document as it is now. */
  const wordsAt = (t: Thread) => {
    const a = now(t).anchor!;
    return textIndex(parseMarkdown(corillo.files.get(PLAN)!).doc).text.slice(a.offset, a.offset + a.quote.length);
  };

  it("a comment on a word written three times stays on the one the agent changed, even with the words before it changed too", async () => {
    const claude = connect();
    const middle = commentOnNth("Call them clients.", "customers", 1);
    await claude.ok("take_document", { path: PLAN });
    await claude.ok("edit_document", { path: PLAN, edits: [{ find: "Pay customers well.", replace: "Reward our clients well." }], comment_ids: [idOf(middle)] });
    const anchor = now(middle).anchor!;
    expect(anchor.quote).toBe("our clients");
    expect(anchor.prefix).toMatch(/Ask customers first\. Reward $/);
    expect(wordsAt(middle)).toBe("our clients");
    expect(now(middle).detached).toBeUndefined();
    // The agent is told the same place.
    expect(await claude.ok("list_comments", { path: PLAN })).toContain(`[${idOf(middle)}] on "our clients" (line 3)`);
    // A later edit before it carries it along, by position again.
    await claude.ok("edit_document", { path: PLAN, edits: [{ find: "# Sales", replace: "# Sales plan" }] });
    expect(now(middle).anchor!.quote).toBe("our clients");
    expect(wordsAt(middle)).toBe("our clients");
  });

  it("a commented sentence rewritten whole is the comment's new words; so is one word inside a sentence rewritten whole (R-AG-1)", async () => {
    const claude = connect();
    const sentence = personComments("plan", "Say it plainly.", "The budget is tight this year.");
    const word = personComments("plan", "Which review?", "review");
    await claude.ok("take_document", { path: PLAN });
    // A whole-text replacement is followed the same way as an edit.
    await claude.ok("replace_document", {
      path: PLAN,
      text: SALES.replace("The budget is tight this year.", "Money is short until spring.").replace("We review it in June.", "Finance checks everything monthly."),
      comment_ids: [idOf(sentence)],
    });
    expect(now(sentence).anchor!.quote).toBe("Money is short until spring.");
    expect(wordsAt(sentence)).toBe("Money is short until spring.");
    // Which new word is "review" can't be told, but the sentence that rewrote it can.
    expect(now(word).anchor!.quote).toBe("Finance checks everything monthly");
    expect(wordsAt(word)).toBe("Finance checks everything monthly");
    expect(now(word).gap).toBeUndefined();
    expect(now(word).detached).toBeUndefined();
  });

  it("a word rewritten along with the paragraphs around it says its text has changed, rather than guess (R-AG-1)", async () => {
    const claude = connect();
    const word = personComments("plan", "Which review?", "review");
    await claude.ok("take_document", { path: PLAN });
    await claude.ok("replace_document", {
      path: PLAN,
      text: SALES.replace("The budget is tight this year.\n\nWe review it in June.", "Money is short; finance looks at spending every month."),
    });
    expect(now(word).detached).toBe(true);
    expect(now(word).gap).toBeUndefined();
    // The words it was on are kept, for its card; the window's search doesn't find them anywhere else.
    expect(now(word).anchor).toEqual(word.anchor);
    expect(findAnchor(parseMarkdown(corillo.files.get(PLAN)!).doc, now(word).anchor!)).toBeNull();
  });

  // R-AG-1: the comment used to be left as it was, and the window's search then put it on "the board" in the next sentence.
  for (const [text, quote, sentence, rewritten] of [
    ["# Notes\n\nIntro.\n\nThe report goes to the board today for review.\n\nNext, the board meets in May.\n", "board", "The report goes to the board today for review.", "The report is sent to directors this week."],
    ["# Notes\n\nSummary first.\n\nWe will hire two people in spring if the budget allows.\n\nLater we will hire two people in autumn.\n", "hire two people", "We will hire two people in spring if the budget allows.", "Hiring waits until the budget is final."],
  ]) {
    it(`words inside a sentence the agent rewrote go onto the rewritten words, never onto "${quote}" in the next sentence`, async () => {
      corillo.files.set(PLAN, text);
      const claude = connect();
      const c = commentOnNth("Which?", quote, 0);
      await claude.ok("take_document", { path: PLAN });
      await claude.ok("replace_document", { path: PLAN, text: text.replace(sentence, rewritten), comment_ids: [idOf(c)] });
      // The window places comments from what's stored, with the same search: as it would.
      const doc = parseMarkdown(corillo.files.get(PLAN)!).doc;
      const found = findAnchor(doc, now(c).anchor!);
      expect(found && doc.resolve(found.from).parent.textContent).toBe(rewritten);
      expect(now(c).detached).toBeUndefined();
      expect(rewritten).toContain(now(c).anchor!.quote);
    });
  }

  // R-AG-5: the place was certain, but a guard on the words either side left the comment as it was, and the window lost it.
  it("a phrase whose neighbours the same edit changed stays on its words as they are now", async () => {
    corillo.files.set(PLAN, "# Notes\n\nIntro sentence here. This is very important for us. Next sentence.\n\nAnd a, b, c, d, e, f, g and h.\n");
    const claude = connect();
    const phrase = commentOnNth("Too strong?", "very important", 0);
    const letters = commentOnNth("Reorder?", "c, d, e, f", 0);
    await claude.ok("take_document", { path: PLAN });
    await claude.ok("edit_document", { path: PLAN, edits: [{ find: "This is very important for us.", replace: "That was extremely important to them." }], comment_ids: [idOf(phrase)] });
    expect(now(phrase).anchor!.quote).toBe("extremely important");
    expect(wordsAt(phrase)).toBe("extremely important");
    expect(now(phrase).detached).toBeUndefined();
    // Several edits in one call, next to the words and among them.
    await claude.ok("edit_document", {
      path: PLAN,
      edits: [
        { find: "a, b,", replace: "a, X," },
        { find: "e, f", replace: "Y, f" },
        { find: "g and h", replace: "g and Z" },
      ],
      comment_ids: [idOf(letters)],
    });
    expect(now(letters).anchor!.quote).toBe("c, d, Y, f");
    expect(now(letters).detached).toBeUndefined();
    const doc = parseMarkdown(corillo.files.get(PLAN)!).doc;
    for (const t of [phrase, letters]) {
      const found = findAnchor(doc, now(t).anchor!);
      expect(found && doc.textBetween(found.from, found.to)).toBe(now(t).anchor!.quote);
    }
  });

  // R-AG-6: "the dog and " put in before "the cat sat" could as well be "the dog and the " before "cat sat", which made the comment "the dog and the cat sat".
  it("words put in just before a comment stay outside it, even when they end with its first word", async () => {
    corillo.files.set(PLAN, "# Notes\n\nI saw the cat sat there. We met the team today.\n");
    const claude = connect();
    const cat = commentOnNth("Which cat?", "the cat sat", 0);
    const team = commentOnNth("Which team?", "met the team", 0);
    await claude.ok("take_document", { path: PLAN });
    await claude.ok("edit_document", { path: PLAN, edits: [{ find: "I saw the cat", replace: "I saw the dog and the cat" }] });
    expect(now(cat).anchor!.quote).toBe("the cat sat");
    expect(wordsAt(cat)).toBe("the cat sat");
    await claude.ok("edit_document", { path: PLAN, edits: [{ find: "the team today", replace: "the team and the team lead today" }] });
    expect(now(team).anchor!.quote).toBe("met the team");
    expect(wordsAt(team)).toBe("met the team");
    // Words put in among its words still join it.
    await claude.ok("edit_document", { path: PLAN, edits: [{ find: "the cat sat", replace: "the black cat sat" }] });
    expect(now(cat).anchor!.quote).toBe("the black cat sat");
  });

  // Found by the comment-following fuzzer: a paragraph moved past another that shares its words reads, word by word, as words changed all along the way.
  it("a comment in a paragraph the agent moved, or moved another past, stays on its words", async () => {
    const [p0, p1, p2] = ["Next quarter the team meets the board.", "The board meets next quarter and the team reviews the budget.", "The team reviews the budget next quarter and meets the board."];
    corillo.files.set(PLAN, `${p0}\n\n${p1}\n\n${p2}\n`);
    const claude = connect();
    const moved = commentOnNth("Why?", "reviews the budget", 0);
    const passed = commentOnNth("When?", "reviews the budget", 1);
    await claude.ok("take_document", { path: PLAN });
    await claude.ok("replace_document", { path: PLAN, text: `${p0}\n\n${p2}\n\n${p1}\n` });
    const text = textIndex(parseMarkdown(corillo.files.get(PLAN)!).doc).text;
    expect([wordsAt(moved), now(moved).anchor!.offset]).toEqual(["reviews the budget", text.indexOf(p1) + p1.indexOf("reviews the budget")]);
    expect([wordsAt(passed), now(passed).anchor!.offset]).toEqual(["reviews the budget", text.indexOf(p2) + p2.indexOf("reviews the budget")]);
  });

  it("a comment whose sentence the agent deleted keeps its place, never the same word in a sentence like it", async () => {
    corillo.files.set(PLAN, "Intro here.\n\nThe report goes to the board two weeks later. The board meets.\n\nThen the report goes to the board looks hire two people.\n");
    const claude = connect();
    const two = commentOnNth("Which two?", "two", 0);
    await claude.ok("take_document", { path: PLAN });
    await claude.ok("replace_document", { path: PLAN, text: "Intro here.\n\nThe board meets.\n\nThen the report goes to the board looks hire two people.\n" });
    expect(now(two)).toMatchObject({ detached: true, gap: { quote: "" }, anchor: { quote: "two", offset: two.anchor!.offset } });
    // Its empty line is where the sentence was, at the start of what's left of that paragraph.
    const text = textIndex(parseMarkdown(corillo.files.get(PLAN)!).doc).text;
    const gap = locate(text, now(two).gap!)!.start;
    expect(gap - text.indexOf("The board meets.")).toBeGreaterThanOrEqual(0);
    expect(gap - text.indexOf("The board meets.")).toBeLessThanOrEqual("The ".length);
  });

  it("commented words deleted keep their place as a gap, and a comment after them moves with the text", async () => {
    const claude = connect();
    const thank = personComments("plan", "Cut this.", "Thank customers often.");
    const june = personComments("plan", "Which day?", "June");
    await claude.ok("take_document", { path: PLAN });
    await claude.ok("edit_document", { path: PLAN, edits: [{ find: " Thank customers often.", replace: "" }], comment_ids: [idOf(thank)] });
    expect(now(thank)).toMatchObject({ detached: true, gap: { quote: "" }, anchor: { quote: "Thank customers often." } });
    expect(now(thank).gap!.prefix).toMatch(/Pay customers well\.$/);
    expect(now(june).anchor!.quote).toBe("June");
    expect(wordsAt(june)).toBe("June");
  });

  it("an edit elsewhere moves nothing: comments keep their words, and one far from the edit is kept exactly as it was", async () => {
    const claude = connect();
    const ask = personComments("plan", "Ask how?", "Ask customers first.");
    const june = personComments("plan", "Which day?", "June");
    const whole = personComments("plan", "Shorter overall.", null);
    await claude.ok("take_document", { path: PLAN });
    await claude.ok("edit_document", { path: PLAN, edits: [{ find: "tight this year", replace: "very tight this year" }] });
    expect(now(ask).anchor).toEqual(ask.anchor);
    expect(now(june).anchor!.quote).toBe("June");
    expect(now(june).anchor!.offset).toBe(june.anchor!.offset + "very ".length);
    expect(wordsAt(june)).toBe("June");
    expect(now(whole).anchor).toBeNull();
  });

  it("resolved comments follow too, so one reopened is on its words", async () => {
    const claude = connect();
    const last = commentOnNth("Old point.", "customers", 2);
    comments.resolve("plan", last.id, person, true);
    await claude.ok("take_document", { path: PLAN });
    await claude.ok("edit_document", { path: PLAN, edits: [{ find: "Thank customers often.", replace: "Thank clients often." }] });
    expect(now(last).status).toBe("resolved");
    expect(now(last).anchor!.quote).toBe("clients");
    expect(wordsAt(last)).toBe("clients");
  });

  it("an edit the file refuses moves no comment; the same edit once the file takes it does", async () => {
    const claude = connect();
    const middle = commentOnNth("Call them clients.", "customers", 1);
    await claude.ok("take_document", { path: PLAN });
    corillo.refuseWrite = "Your change to plan.md couldn't be saved: it's locked. Nothing was changed.";
    const edit = { path: PLAN, edits: [{ find: "Pay customers well.", replace: "Reward our clients well." }], comment_ids: [idOf(middle)] };
    expect(await claude.fails("edit_document", edit)).toContain("couldn't be saved");
    expect(now(middle).anchor).toEqual(middle.anchor);
    corillo.refuseWrite = null;
    await claude.ok("edit_document", edit);
    expect(now(middle).anchor!.quote).toBe("our clients");
  });
});

describe("a comment stays on its own line when an agent changes the lines around it (R-1, R-8, R-9, R-10)", () => {
  const CHANGED = "(its text has changed)";

  /** Words written more than once, and which time (from 1) the comment is on. */
  type Twin = readonly [quote: string, time: number];
  function onTwin(markdown: string, body: string, [quote, time]: Twin): Thread {
    const doc = parseMarkdown(markdown).doc;
    const index = textIndex(doc);
    let start = -1;
    for (let k = 0; k < time; k++) start = index.text.indexOf(quote, start + 1);
    return comments.add("plan", person, body, anchorFor(doc, posAt(index, start, "start"), posAt(index, start + quote.length, "end"), index), null);
  }

  /**
   * A comment on each of `on`; then the agent's edits, each for the comment
   * at its place in `on`: in one call, a call each, or sent as the whole
   * text. For each comment, the words it's on, what the agent is told, and
   * its change: each stretch of new words, with what was there before.
   */
  async function answered(markdown: string, on: (string | Twin)[], edits: [find: string, replace: string, answers: number][], how: "one call" | "a call each" | "whole text" = "one call") {
    corillo.files.set(PLAN, markdown);
    const claude = connect();
    const asked = on.map((quote, i) => (typeof quote === "string" ? personComments("plan", `Comment ${i + 1}.`, quote) : onTwin(markdown, `Comment ${i + 1}.`, quote)));
    await claude.ok("take_document", { path: PLAN });
    const sent = edits.map(([find, replace, i]) => ({ find, replace, comment_ids: [idOf(asked[i])] }));
    const after = edits.reduce((text, [find, replace]) => text.replace(find, replace), markdown);
    if (how === "one call") await claude.ok("edit_document", { path: PLAN, edits: sent });
    else if (how === "a call each") for (const e of sent) await claude.ok("edit_document", { path: PLAN, edits: [e] });
    else await claude.ok("replace_document", { path: PLAN, text: after, comment_ids: asked.map(idOf) });
    expect(corillo.files.get(PLAN)).toBe(after);
    const listed = (await claude.ok("list_comments", { path: PLAN, include_answered: true })).split("\n");
    return asked.map((t) => {
      const c = comments.threads("plan").find((x) => x.id === t.id)!;
      return {
        on: c.detached ? CHANGED : (c.anchor?.quote ?? ""),
        /** Its words deleted: kept where they were. */
        gap: !!c.gap,
        told: listed.find((l) => l.startsWith(`[${idOf(t)}]`))?.replace(/^\[[^\]]+\] /, "") ?? "",
        change: (c.change?.spans ?? []).map((s) => [s.anchor.quote, s.removed]),
      };
    });
  }

  // R-1: an equal short line was taken for the commented one, by order.
  it("a comment on Build's date stays in Build's row when the agent moves every date two weeks on (R-1)", async () => {
    const schedule = (design: string, build: string, launch: string) =>
      `# Launch schedule\n\n| Milestone | Date |\n| --- | --- |\n| Design | ${design} |\n| Build | ${build} |\n| Launch | ${launch} |\n`;
    const [build] = await answered(schedule("1 June", "15 June", "1 July"), ["15 June"], [
      ["| Design | 1 June |", "| Design | 15 June |", 0],
      ["| Build | 15 June |", "| Build | 29 June |", 0],
      ["| Launch | 1 July |", "| Launch | 15 July |", 0],
    ]);
    expect(build.on).toBe("29 June");
    expect(build.told).toContain('on "29 June" (line 6)');
  });

  for (const [what, before, after, on, line] of [
    ["a status in a table", "| Status |\n| --- |\n| Open |\n| Done |\n| Open |\n", "| Status |\n| --- |\n| Done |\n| Done |\n| Blocked |\n", "Done", 4],
    ["a name in a list", "# Owners\n\n- Ana\n- Ben\n- Cleo\n", "# Owners\n\n- Ben\n- Ben\n- Dev\n", "Ben", 4],
  ] as const) {
    it(`a comment on ${what} nobody changed stays there when one edit makes the line above read the same (R-1)`, async () => {
      const [c] = await answered(before, [on], [[before, after, 0]]);
      expect(c.told).toContain(`on "${on}" (line ${line})`);
    });
  }

  for (const [what, before, after, on, now, line] of [
    ["paragraph", "# Plan\n\nWe ship in May.\n\nIn between.\n\nWe test in April.\n", "# Plan\n\nWe ship in June.\n\nIn between.\n\nWe ship in May.\n", "We ship in May.", "We ship in June.", 3],
    ["heading", "# Plan\n\n## Risks\n\nText one.\n\n## Costs\n\nText two.\n", "# Plan\n\n## Open questions\n\nText one.\n\n## Risks\n\nText two.\n", "Risks", "Open questions", 3],
  ] as const) {
    it(`a comment on a ${what} the agent rewrote stays there when another now reads as it did, the whole text sent again (R-1)`, async () => {
      const [c] = await answered(before, [on], [[before, after, 0]], "whole text");
      expect(c.on).toBe(now);
      expect(c.told).toContain(`(line ${line})`);
    });
  }

  // R-10: a row added beside the commented one, reading the same there, took the comment.
  const DATES = "# Launch\n\n| Date | Event |\n| --- | --- |\n| 3 May | Kickoff |\n| 10 May | Review |\n| 24 May | Launch |\n";
  for (const [how, find, replace, as] of [
    ["put in right above it", "| 10 May | Review |", "| 10 May | Design check |\n| 10 May | Review |", "one call"],
    ["added after the row above", "| 3 May | Kickoff |\n", "| 3 May | Kickoff |\n| 10 May | Design check |\n", "one call"],
    ["put in above it, the whole text sent again", "| 10 May | Review |", "| 10 May | Design check |\n| 10 May | Review |", "whole text"],
  ] as const) {
    it(`a comment on a date stays in its row when the agent adds a row on the same date, ${how} (R-10)`, async () => {
      const [c] = await answered(DATES, ["10 May"], [[find, replace, 0]], as);
      // Line 7 is Review's row now; line 6 the new one.
      expect(c.told).toContain('on "10 May" (line 7)');
    });
  }

  // S21-6: the change kept for the comment was worked out without the Markdown's lines, so it fell on the old row.
  for (const [what, markdown, on, find, replace, want] of [
    ["a row on the same date put in above it", DATES, "10 May", "| 10 May | Review |", "| 10 May | Design check |\n| 10 May | Review |", "10 May\nDesign check"],
    ["a status row put in above its twin", "| Status |\n| --- |\n| Open |\n| Done |\n| Blocked |\n", "Done", "| Open |\n", "| Open |\n| Done |\n", "Done"],
  ] as const) {
    it(`the change kept for the comment is the agent's new row, not the old one: ${what} (S21-6)`, async () => {
      await answered(markdown, [on], [[find, replace, 0]]);
      const words = reading(markdown.replace(find, replace)).words;
      const spans = comments.threads("plan")[0].change!.spans.map((s) => locate(words, s.anchor)!);
      expect(spans.map((s) => words.slice(s.start, s.end))).toEqual([want]);
      expect(spans[0].start).toBe(words.indexOf(want));
    });
  }

  it("a comment on the last row's owner stays there when the agent adds a row with the same owner at the end of the document (R-10)", async () => {
    const [c] = await answered("# Launch\n\n| Step | Owner |\n| --- | --- |\n| Draft | Ana |\n| Review | Ben |\n", ["Ben"], [["| Review | Ben |", "| Review | Ben |\n| Publish | Ben |", 0]]);
    expect(c.told).toContain('on "Ben" (line 6)');
  });

  // B8R-3: a whole line put in or taken out, line break and all, right beside the commented line's twin.
  for (const [what, markdown, on, find, replace, line] of [
    ["a status row put in above its twin", "| Status |\n| --- |\n| Open |\n| Done |\n| Blocked |\n", ["Done", 1], "| Open |\n", "| Open |\n| Done |\n", 5],
    ["a schedule row copied in above it", DATES, ["Review", 1], "| 3 May | Kickoff |\n", "| 3 May | Kickoff |\n| 10 May | Review |\n", 7],
    ["the status row above it, its twin, taken out", "| Status |\n| --- |\n| Open |\n| Done |\n| Done |\n| Blocked |\n", ["Done", 2], "| Open |\n| Done |\n", "| Open |\n", 4],
    ["the list item above it, its twin, taken out", "# Owners\n\n- Ana\n- Ben\n- Ben\n", ["Ben", 2], "- Ana\n- Ben\n", "- Ana\n", 4],
  ] as const) {
    it(`a comment stays in its own row with ${what} by an exact edit (B8R-3)`, async () => {
      const [c] = await answered(markdown, [on], [[find, replace, 0]]);
      expect(c.on).toBe(on[0]);
      expect(c.told).toContain(`on "${on[0]}" (line ${line})`);
    });
  }

  // Two edits side by side, each followed on its own: a row one puts in never takes a comment from the row the other changed or cut.
  for (const [what, markdown, on, edits, now, told] of [
    ["a copy of the row above put in right above the commented row, changed by another edit", "| Task | Due |\n| --- | --- |\n| Draft | 15 June |\n| Review | 29 June |\n", "Review", [["| Draft | 15 June |\n", "| Draft | 15 June |\n| Draft | 15 June |\n"], ["| Review | 29 June |\n", "| Final check | 29 June |\n"]], "Final check", 'on "Final check" (line 5)'],
    ["a new row put in right above the commented row, changed by another edit", "| Task | Owner |\n| --- | --- |\n| Draft | Ana |\n| Review | Ben |\n", "Review", [["| Draft | Ana |\n", "| Draft | Ana |\n| Check | Cleo |\n"], ["| Review | Ben |\n", "| Final check | Ben |\n"]], "Final check", 'on "Final check" (line 5)'],
    // (Deleted: kept where its words were, not given the new item's.)
    ["the commented item taken out, and a new item put in right after it by another edit", "# Owners\n\n- Ana\n- Ben\n- Cleo\n", "Ben", [["- Ben\n", ""], ["- Cleo\n", "- Dev\n- Cleo\n"]], null, 'on "Ben" (that text is no longer in the document)'],
  ] as const) {
    it(`two exact edits side by side, each kept to its own lines: ${what}`, async () => {
      const [c] = await answered(markdown, [on], edits.map(([f, r]) => [f, r, 0]));
      if (now === null) expect([c.on, c.gap]).toEqual([CHANGED, true]);
      else expect(c.on).toBe(now);
      expect(c.told).toContain(told);
    });
  }

  // B8R-1: a paragraph moved, with a new paragraph put where it was, is the same paragraph, not rewritten as the new one.
  const REPORT = "# Report\n\nThe summary says sales rose in spring.\n\nBody one gives the numbers.\n\nBody two gives the reasons.\n";
  const INTRO = "This intro sets the scene for readers.";
  const SUMMARY = "The summary says sales rose in spring.";
  const MOVED = REPORT.replace(SUMMARY, INTRO) + `\n${SUMMARY}\n`;
  for (const [how, edits, as] of [
    ["the whole text sent again", [[REPORT, MOVED, 0]], "whole text"],
    ["by two edits in one call", [[SUMMARY, INTRO, 0], ["Body two gives the reasons.\n", `Body two gives the reasons.\n\n${SUMMARY}\n`, 0]], "one call"],
  ] as const) {
    for (const on of ["sales rose", SUMMARY]) {
      it(`a comment on "${on}" goes with its paragraph when the agent moves it to the end and puts a new one in its place, ${how} (B8R-1)`, async () => {
        const [c] = await answered(REPORT, [on], edits.map(([f, r, i]) => [f, r, i]), as);
        expect(c.on).toBe(on);
        expect(c.told).toContain("(line 9)");
      });
    }
  }

  it("a comment on a paragraph the agent rewrote stays there when the old words are put in as a new paragraph further down (B8R-1)", async () => {
    const plan = "# Plan\n\nWe ship in May.\n\nIn between.\n";
    const [c] = await answered(plan, ["We ship in May."], [[plan, "# Plan\n\nWe ship in June.\n\nIn between.\n\nWe ship in May.\n", 0]], "whole text");
    expect(c.on).toBe("We ship in June.");
    expect(c.told).toContain("(line 3)");
  });

  // R-9: a comment that took in the mark closing its words was left on that mark alone.
  for (const [what, markdown, on, find, replace] of [
    ["a sentence's last words, full stop included", "# Notes\n\nWe should hire two people this quarter.\n\nEnd.\n", "this quarter.", "We should hire two people this quarter.", "Hiring can wait until spring."],
    ["the second of two sentences made one", "# Notes\n\nWe hire two people in May. The budget is tight this year.\n\nEnd.\n", "The budget is tight this year.", "We hire two people in May. The budget is tight this year.", "Hiring waits until money allows."],
    ["a question's last words", "# Notes\n\nCan we hire two people this quarter?\n\nEnd.\n", "this quarter?", "Can we hire two people this quarter?", "Should hiring wait until spring?"],
    ["a paragraph made one with the paragraph above", "# Notes\n\nWe hire two people in May.\n\nThe budget is tight this year.\n\nEnd.\n", "The budget is tight this year.", "We hire two people in May.\n\nThe budget is tight this year.", "Hiring waits until money allows."],
    ["the last words in brackets, closing bracket included", "# Notes\n\nWe hire two people (see the budget below) this quarter.\n\nEnd.\n", "budget below)", "see the budget below", "details"],
    ["the last words before a comma, comma included", "# Notes\n\nAfter the long launch, we review the costs.\n\nEnd.\n", "long launch,", "After the long launch", "Later"],
  ] as const) {
    it(`a comment on ${what} is never left on the mark alone when the agent rewrites them (R-9)`, async () => {
      const [c] = await answered(markdown, [on], [[find, replace, 0]]);
      expect(c.on).toMatch(/[\p{L}\p{N}]/u);
      expect(c.told).not.toMatch(/^on "[^\p{L}\p{N}"]*"/u);
    });
  }

  // R-9, cut words (roadmap Batch 10, item 3): a comment whose words the agent cut, leaving the mark that closed them,
  // was left on the mark alone. Its words are gone, so it shows as deleted text where they were, as when the mark goes too.
  for (const [what, markdown, on, find, replace, place] of [
    ["a sentence's last words, full stop left", "# Notes\n\nWe should hire two people this quarter.\n\nEnd.\n", "this quarter.", "two people this quarter.", "two people.", "two people|."],
    ["a question's last words, question mark left", "# Notes\n\nCan we hire two people this quarter?\n\nEnd.\n", "this quarter?", "people this quarter?", "people?", "people|?"],
    ["the last words in brackets, closing bracket left", "# Notes\n\nWe hire two people (see the budget below) this quarter.\n\nEnd.\n", "budget below)", "(see the budget below)", "(see)", "(see|)"],
    ["the last words before a comma, comma left", "# Notes\n\nFirst we check the costs, then we plan.\n\nEnd.\n", "the costs,", "check the costs,", "check,", "check|, then"],
  ] as const) {
    it(`a comment on ${what} when the agent cuts the words shows as deleted text where they were, not on the mark (R-9)`, async () => {
      const [c] = await answered(markdown, [on], [[find, replace, 0]]);
      expect([c.on, c.gap]).toEqual([CHANGED, true]);
      expect(c.told).toContain(`on "${on}" (that text is no longer in the document)`);
      // Kept where its words were: right before the mark that's left.
      const gap = comments.threads("plan")[0].gap!;
      const [before, after] = place.split("|");
      expect([gap.quote, gap.prefix.endsWith(before), gap.suffix.startsWith(after)]).toEqual(["", true, true]);
    });
  }

  // R-8: changes on lines next to each other were read as one change.
  const BULLETS = "# Launch plan\n\n- Email the members\n- Print the posters\n- Book the hall\n";
  const REWORDED = [["Email the members", "Write to every volunteer"], ["Print the posters", "Order two hundred flyers"], ["Book the hall", "Reserve the gym"]] as const;
  for (const how of ["a call each", "one call"] as const) {
    it(`two bullets next to each other, each reworded for its own comment in ${how}, each keep their own old words (R-8)`, async () => {
      const changed = await answered(BULLETS, [REWORDED[0][0], REWORDED[1][0]], [[...REWORDED[0], 0], [...REWORDED[1], 1]], how);
      expect(changed.map((c) => c.change)).toEqual([[["Write to every volunteer", "Email the members"]], [["Order two hundred flyers", "Print the posters"]]]);
    });
  }

  for (const [what, markdown, edits, changes] of [
    ["two rows of a column", "| Status |\n| --- |\n| Planned |\n| Open |\n| Waiting |\n", [["| Open |", "| Done |"], ["| Waiting |", "| Blocked |"]], [[["Done", "Open"]], [["Blocked", "Waiting"]]]],
    ["two cells side by side", "| Task | Owner |\n| --- | --- |\n| Design | Ana |\n| Build | Ben |\n", [["| Design |", "| Research |"], ["| Ana |", "| Dev |"]], [[["Research", "Design"]], [["Dev", "Ana"]]]],
    ["a heading and the paragraph under it", "# Plan\n\nThe budget is tight this year.\n\nMore text here.\n", [["# Plan", "# Hiring"], ["The budget is tight this year.", "Money stays short until autumn."]], [[["Hiring", "Plan"]], [["Money stays short until autumn", "The budget is tight this year"]]]],
  ] as const) {
    it(`${what}, each changed for its own comment, each keep their own old words (R-8)`, async () => {
      const on = edits.map(([find]) => find.replace(/^[#|]\s*|\s*\|$/g, ""));
      const changed = await answered(markdown, on, edits.map(([find, replace], i) => [find, replace, i]), "a call each");
      expect(changed.map((c) => c.change)).toEqual(changes);
    });
  }

  it("one comment answered by rewording two bullets keeps each bullet's old words with that bullet (R-8)", async () => {
    const [c] = await answered(BULLETS, [REWORDED[0][0]], [[...REWORDED[0], 0], [...REWORDED[1], 0]]);
    expect(c.change).toEqual([["Write to every volunteer", "Email the members"], ["Order two hundred flyers", "Print the posters"]]);
  });

  for (const [what, markdown, changes] of [
    ["three bullets", BULLETS, REWORDED.map(([was, is]) => [was, is, was, is])],
    ["three rows of a column", "| Status |\n| --- |\n| Planned |\n| Open |\n| Waiting |\n| Late |\n", [["| Planned |", "| Started |", "Planned", "Started"], ["| Open |", "| Done |", "Open", "Done"], ["| Waiting |", "| Blocked |", "Waiting", "Blocked"]]],
  ] as const) {
    it(`comments on ${what}, each reworded for its own comment in the same call, each go onto their new words (R-8)`, async () => {
      const changed = await answered(markdown, changes.map(([, , on]) => on), changes.map(([find, replace], i) => [find, replace, i]));
      expect(changed.map((c) => c.on)).toEqual(changes.map(([, , , now]) => now));
    });
  }

  it("a heading renamed and the paragraph under it rewritten in one call, each for its own comment: each goes onto its new words (R-8)", async () => {
    const changed = await answered("# Plan\n\nThe budget is tight this year.\n\nMore text here.\n", ["Plan", "The budget is tight this year."], [
      ["# Plan", "# Hiring", 0],
      ["The budget is tight this year.", "Money stays short until autumn.", 1],
    ]);
    expect(changed.map((c) => c.on)).toEqual(["Hiring", "Money stays short until autumn."]);
  });

  it("a bullet cut for one comment beside one reworded for another: each keeps its own old words (R-8)", async () => {
    const changed = await answered(BULLETS, [REWORDED[0][0], REWORDED[1][0]], [["- Email the members\n", "", 0], [...REWORDED[1], 1]], "a call each");
    expect(changed.map((c) => c.change)).toEqual([[["", "Email the members\n"]], [["Order two hundred flyers", "Print the posters"]]]);
  });

  it("a paragraph put in for one comment beside one rewritten for another: each keeps its own change (R-8)", async () => {
    const notes = "# Notes\n\nWe hire two people in May.\n\nThe budget is tight this year.\n\nRisks are few.\n";
    const changed = await answered(notes, ["We hire two people in May.", "The budget is tight this year."], [
      ["We hire two people in May.\n\n", "We hire two people in May.\n\nInterviews start in March.\n\n", 0],
      ["The budget is tight this year.", "Money stays short until autumn.", 1],
    ], "a call each");
    expect(changed.map((c) => c.change)).toEqual([[["Interviews start in March.", ""]], [["Money stays short until autumn", "The budget is tight this year"]]]);
  });
});

describe("a pass that only starts comments", () => {
  it("ends with the done line and is kept as a version, worded as comments started", async () => {
    const told: PassSummary[] = [];
    corillo.passEnded = (_storeId, summary) => void told.push(summary);
    const claude = connect();
    await claude.ok("take_document", { path: PLAN });
    await claude.ok("add_comment", { path: PLAN, text: "Which quarter do you mean, Q3 or Q4?", quote: "this quarter" });
    await claude.ok("add_comment", { path: PLAN, text: "Is the budget fixed?", quote: "budget is tight" });
    await claude.ok("finish_editing", { path: PLAN });
    expect(told).toEqual([{ agent: "Claude", answered: 0, other: false, endedBy: "agent" }]);
    const version = corillo.history.list("plan").at(-1)!;
    expect(version).toMatchObject({ kind: "agent", agent: "Claude" });
    expect(version.addressed!.map((t) => t.messages[0].body)).toEqual(["Which quarter do you mean, Q3 or Q4?", "Is the budget fixed?"]);
    const listed = await claude.ok("list_versions", { path: PLAN });
    expect(listed).toContain('Started 2 comments:\n  - on "this quarter"\n    Claude: Which quarter do you mean, Q3 or Q4?');
    expect(listed).not.toContain("Addressed");
    // A comment started outside a pass is the person's to read, but no pass of the agent's.
    await claude.ok("add_comment", { path: PLAN, text: "One more thought." });
    expect(told).toHaveLength(1);
  });

  // R-AG-11: every comment with only agents' messages was listed as started, whichever pass started it.
  it("a comment started in an earlier pass is listed as addressed by a later pass that adds to it", async () => {
    const claude = connect();
    await claude.ok("take_document", { path: PLAN });
    const asked = await claude.ok("add_comment", { path: PLAN, text: "Which quarter?", quote: "this quarter" });
    await claude.ok("finish_editing", { path: PLAN });
    await claude.ok("take_document", { path: PLAN });
    await claude.ok("reply_to_comment", { path: PLAN, comment_id: /\[([0-9a-f]+)\]/.exec(asked)![1], text: "Still open." });
    await claude.ok("add_comment", { path: PLAN, text: "A new one.", quote: "hire two people" });
    await claude.ok("finish_editing", { path: PLAN });
    const listed = await claude.ok("list_versions", { path: PLAN });
    const [newest, earlier] = listed.split(/\n(?=Version \d)/).slice(1);
    expect(newest).toMatch(/Addressed 1 comment:\n {2}- on "this quarter"/);
    expect(newest).toMatch(/Started 1 comment:\n {2}- on "hire two people"/);
    expect(earlier).toMatch(/Started 1 comment:\n {2}- on "this quarter"/);
  });
});

describe("requests made in the agent's chat", () => {
  it("are given with take_document; edits tied to no comment are for them, and they're kept with the version", async () => {
    const claude = connect();
    const taken = await claude.ok("take_document", { path: PLAN, request: "  Make the budget line punchier.  " });
    expect(taken).toContain("kept with the request you gave");
    expect(await claude.ok("edit_document", { path: PLAN, edits: [{ find: "The budget is tight.", replace: "Budget: tight." }] })).toContain(
      "for the request from the chat",
    );
    await claude.ok("finish_editing", { path: PLAN });
    expect(ended[0].request).toBe("Make the budget line punchier.");
    expect(ended[0].other!.map((s) => s.anchor.quote)).toEqual(["Budget:"]);
    const versions = await claude.ok("list_versions", { path: PLAN });
    expect(versions).toContain('Asked in chat: "Make the budget line punchier."');
    expect(versions).toMatch(/Asked in chat: .*\n {4}Changed: /);
  });

  it("can be given with finish_editing instead, taking the pass's untied edits with them", async () => {
    const claude = connect();
    await claude.ok("take_document", { path: PLAN });
    expect(await claude.ok("edit_document", { path: PLAN, edits: [{ find: "tight", replace: "very tight" }] })).toContain(
      "give their request with finish_editing",
    );
    await claude.ok("finish_editing", { path: PLAN, request: "Stronger budget line." });
    expect(ended[0].request).toBe("Stronger budget line.");
    expect(ended[0].other!.map((s) => s.anchor.quote)).toEqual(["very"]);
  });

  it("are kept even for a pass that changed nothing, alongside the comments it answered", async () => {
    const claude = connect();
    const hire = personComments("plan", "Is two enough?", "two people");
    await claude.ok("take_document", { path: PLAN, request: "Check the numbers." });
    await claude.ok("reply_to_comment", { path: PLAN, comment_id: idOf(hire), text: "Yes, two is enough." });
    await claude.ok("finish_editing", { path: PLAN });
    const newest = corillo.history.list("plan").at(-1)!;
    expect(newest.request).toBe("Check the numbers.");
    expect(newest.addressed?.map((t) => t.id)).toEqual([hire.id]);
  });
});

// Roadmap Batch 1, item 3: agents that waste less and say it better (A-9, A-8, agent quick wins 2, 3, 4, 7, 9, person quick win 2).
describe("rounds that waste fewer turns (A-9)", () => {
  const PROPOSAL = "/docs/Partner onboarding proposal.md";
  const NOTES = "/docs/notes.md";
  const open = async (agent: ReturnType<typeof connect>, ...paths: string[]) => {
    for (const p of paths) {
      if (!corillo.files.has(p)) corillo.files.set(p, `# ${path.basename(p, ".md")}\n\nSome text.\n`);
      await agent.ok("open_document", { path: p });
    }
  };

  it("list_documents says which document is in front in Corillo (agent quick win 3)", async () => {
    const claude = connect();
    await open(claude, PLAN, NOTES);
    corillo.frontPath = NOTES;
    expect(await claude.ok("list_documents")).toBe(
      "Open in Corillo:\n- /docs/plan.md (no comments waiting for you)\n- /docs/notes.md (in front; no comments waiting for you)",
    );
  });

  it("take_document takes a document by its name, the way the person says it, and gives its full path for the other tools", async () => {
    const claude = connect();
    await open(claude, PLAN, PROPOSAL);
    for (const name of ["partner onboarding proposal", "Partner onboarding proposal.md", "the onboarding proposal"]) {
      const taken = await claude.ok("take_document", { path: name });
      expect(taken).toContain("You're editing Partner onboarding proposal.md now.");
      expect(taken).toContain(`Use its full path with the other tools: ${PROPOSAL}.`);
      await claude.ok("finish_editing", { path: PROPOSAL });
    }
    // The exact name wins over a looser match ("plan" is plan.md, not a "Q3 plan").
    await open(claude, "/docs/Q3 plan.md");
    expect(await claude.ok("take_document", { path: "plan" })).toContain("You're editing plan.md now.");
    await claude.ok("finish_editing", { path: PLAN });
    // A full path needs no repeating.
    expect(await claude.ok("take_document", { path: PROPOSAL })).not.toContain("Use its full path");
    await claude.ok("finish_editing", { path: PROPOSAL });
  });

  it("a name that fits no open document, or several, is refused with the documents that are open", async () => {
    const claude = connect();
    await open(claude, PLAN, PROPOSAL, "/docs/Office proposal.md");
    const none = await claude.fails("take_document", { path: "budget memo" });
    expect(none).toContain('No document called "budget memo" is open in Corillo. Give its full path to open and take it.');
    expect(none).toContain(`Open in Corillo:\n- /docs/plan.md`);
    const several = await claude.fails("take_document", { path: "proposal" });
    expect(several).toContain('2 open documents fit "proposal": Partner onboarding proposal.md and Office proposal.md. Give its full path.');
    expect(service.editingAgent("plan")).toBeNull();
  });

  it("a name the agent's connector also gave as a file in the agent's folder opens that file, as a relative path did before", async () => {
    // The connector keeps a bare name as it is, and adds where it would be as a path from the agent's folder.
    corillo.files.set("/work/draft.md", "# Draft\n");
    const claude = connect();
    const taken = await claude.ok("take_document", { path: "draft.md", here: "/work/draft.md" });
    expect(taken).toContain("You're editing draft.md now.");
    expect(taken).toContain("Use its full path with the other tools: /work/draft.md.");
  });

  it("a bare file name that is a file in the agent's folder means that file, as for the other tools, even with an open document of a like name elsewhere (B1-03)", async () => {
    const claude = connect();
    await open(claude, "/a/Q3 plan.md", "/b/README.md");
    // No file called "plan" in the agent's folder: the name is matched among the open documents.
    expect(await claude.ok("take_document", { path: "plan", here: "/c/plan" })).toContain("You're editing Q3 plan.md now.");
    await claude.ok("finish_editing", { path: "/a/Q3 plan.md" });
    corillo.files.set("/c/plan.md", "# Our plan\n");
    corillo.files.set("/c/README.md", "# About this folder\n");
    const plan = await claude.ok("take_document", { path: "plan.md", here: "/c/plan.md" });
    expect(plan).toContain("Use its full path with the other tools: /c/plan.md.");
    await claude.ok("finish_editing", { path: "/c/plan.md" });
    const readme = await claude.ok("take_document", { path: "README.md", here: "/c/README.md" });
    expect(readme).toContain("Use its full path with the other tools: /c/README.md.");
    expect(service.editingAgent("README")).not.toBeNull();
  });

  it("take_document with no path takes the one open document with comments waiting for the agent", async () => {
    const claude = connect();
    await open(claude, PLAN, NOTES);
    corillo.frontPath = NOTES; // the person moved on to other work
    expect(await claude.fails("take_document")).toContain(
      "No document open in Corillo has comments waiting for you, so say which to take: give its name or full path as path.",
    );
    personComments("plan", "Three, not two.", "hire two people");
    const taken = await claude.ok("take_document");
    expect(taken).toContain("You're editing plan.md now.");
    expect(taken).toContain("Use its full path with the other tools: /docs/plan.md.");
    expect(taken).toContain("1 comment on plan.md waiting for you");
    await claude.fails("finish_editing", { path: PLAN }); // it points the comment out once
    await claude.ok("finish_editing", { path: PLAN });
    comments.add("notes", person, "Tidy this.", null, null);
    const several = await claude.fails("take_document");
    expect(several).toContain("Comments are waiting for you on 2 documents, so say which to take: give its name or full path as path.");
    expect(several).toContain("- /docs/notes.md (in front; 1 comment waiting for you)");
    expect(service.editingAgent("plan")).toBeNull();
    expect(service.editingAgent("notes")).toBeNull();
  });

  it("with nothing open, take_document with no path asks for the document's full path", async () => {
    expect(await connect().fails("take_document")).toBe("No documents are open in Corillo. Give the document's full path as path.");
  });

  it("the first take of a session says the document changes only through Corillo, as opening or reading it does (agent quick win 9)", async () => {
    const rule = "Change plan.md only through Corillo (edit_document or replace_document), never with your own file tools.";
    const claude = connect();
    expect(await claude.ok("take_document", { path: PLAN })).toContain(rule);
    await claude.ok("finish_editing", { path: PLAN });
    expect(await claude.ok("take_document", { path: PLAN })).not.toContain(rule);
    await claude.ok("finish_editing", { path: PLAN });
    const reader = connect();
    await reader.ok("read_document", { path: PLAN }); // told there
    expect(await reader.ok("take_document", { path: PLAN })).not.toContain(rule);
  });

  it("an edit's answer shows the changes in the order they come in the document, not the order they were given (agent quick win 7)", async () => {
    const claude = connect();
    await claude.ok("take_document", { path: PLAN });
    const done = await claude.ok("edit_document", {
      path: PLAN,
      edits: [
        { find: "The budget is tight.", replace: "The budget is very tight." },
        { find: "# Plan", replace: "# Hiring plan" },
        { find: "two people", replace: "three people" },
      ],
    });
    const lines = done
      .split("As it reads now:\n")[1]
      .split("\n")
      .filter((l) => l.startsWith("line "))
      .map((l) => Number(/^line (\d+):/.exec(l)![1]));
    expect(lines).toEqual([1, 3, 7]);
  });
});

describe("a long document arrives with the paragraphs its comments are on (A-9)", () => {
  /** About 70,000 characters: 40 sections of four one-line paragraphs, each starting "Paragraph n:". */
  const para = (i: number) => `Paragraph ${i}: ${"plain words that fill the line ".repeat(13).trim()}.`;
  const LONG_TEXT = ["# Handbook", "", ...Array.from({ length: 40 }, (_, s) => [`## Section ${s}`, "", ...[0, 1, 2, 3].flatMap((p) => [para(s * 4 + p), ""])]).flat()].join("\n");
  const lineOf = (text: string, start: string) => text.split("\n").findIndex((l) => l.startsWith(start)) + 1;

  it("each comment's paragraph comes with its line number after the outline, and nothing else from the middle", async () => {
    corillo.files.set(PLAN, LONG_TEXT);
    const a = personComments("plan", "Shorter, please.", "Paragraph 101:");
    personComments("plan", "Check this one.", "Paragraph 150:");
    personComments("plan", "And the first.", "Paragraph 0:");
    personComments("plan", "Say 'site lead' everywhere.", null);
    const taken = await connect().ok("take_document", { path: PLAN });
    expect(taken).toContain("so this is its outline");
    const at101 = lineOf(LONG_TEXT, "Paragraph 101:");
    const at150 = lineOf(LONG_TEXT, "Paragraph 150:");
    expect(taken).toContain(`[${idOf(a)}] on "Paragraph 101:" (line ${at101})`);
    expect(taken).toContain(`The paragraphs the comments are on, so you needn't read the document to find them:\n\nLine ${at101}:\n${para(101)}\n\nLine ${at150}:\n${para(150)}`);
    expect(taken).not.toContain("Paragraph 102:");
    // The first paragraph is in the start already: it isn't given twice.
    expect(taken.split("Paragraph 0:").length - 1).toBe(2); // the comment's quote, and the start
    expect(taken.length).toBeLessThan(30_000);
  });

  it("a paragraph of several lines comes whole, and a short document gets no extra copy", async () => {
    const text = LONG_TEXT.replace(para(120), `${para(120)}\nA second line of the same paragraph.`);
    corillo.files.set(PLAN, text);
    personComments("plan", "Fix this.", "A second line of the same paragraph.");
    const at = lineOf(text, "Paragraph 120:");
    expect(await connect().ok("take_document", { path: PLAN })).toContain(`Lines ${at} to ${at + 1}:\n${para(120)}\nA second line of the same paragraph.`);
    corillo.files.set("/docs/short.md", "# Short\n\nOne paragraph.\n");
    comments.add("short", person, "Hm.", anchorForQuote("# Short\n\nOne paragraph.\n", "One paragraph."), null);
    expect(await connect().ok("take_document", { path: "/docs/short.md" })).not.toContain("The paragraphs the comments are on");
  });

  /** One comment on a paragraph of 30,000 characters, at the end. */
  const huge = `Huge: ${"a very long paragraph written on one line ".repeat(700)}`;
  const HUGE_TEXT = `${LONG_TEXT}\n${huge}\n`;
  /**
   * Comments kept in memory only. Each comment added or resolved is written to
   * disk and flushed there (a few milliseconds each, by design: a crash can't
   * lose one); these tests add 121 and resolve 120, which took over a second
   * that isn't what they check (roadmap Batch 6: the take itself is quick).
   */
  function commentsInMemory(): void {
    const store = new DocumentStore(dataDir);
    store.writeComments = () => {};
    comments = new CommentService(store, () => {});
    service = new AgentService(corillo, comments, hooks, { waitMs: 0 });
  }

  it("is capped, so many comments or a huge paragraph can't make a take huge", async () => {
    commentsInMemory();
    // A comment on each of 120 paragraphs, and one on a paragraph of 30,000 characters.
    const text = HUGE_TEXT;
    corillo.files.set(PLAN, text);
    for (let i = 20; i < 140; i++) personComments("plan", `Comment ${i}.`, `Paragraph ${i}:`);
    personComments("plan", "Too long.", "Huge: a very long");
    const first = connect();
    const taken = await first.ok("take_document", { path: PLAN });
    const part = taken.split("The paragraphs the comments are on")[1];
    expect(part.length).toBeLessThan(13_000);
    expect(part).toMatch(/Not shown here, to keep this answer short: the paragraphs at lines (\d+, ){9}\d+ and \d+ more\. Read them with read_document's from_line and to_line\.$/);
    expect(part).not.toContain("a very long paragraph written on one line a very long");
    // The huge paragraph alone: named by its line, not sent.
    await first.end();
    for (const t of comments.threads("plan")) if (t.messages[0].body !== "Too long.") comments.resolve("plan", t.id, person, true);
    const alone = (await connect().ok("take_document", { path: PLAN })).split("so this is its outline")[1];
    expect(alone).toContain(`Not shown here, to keep this answer short: the paragraphs at lines ${lineOf(text, "Huge:")}. Read them with read_document's from_line and to_line.`);
    expect(alone).not.toContain("a very long paragraph written on one line a very long");
  });

  it("is quick however many comments wait: with 121 a take costs little more than with one (best of three, roadmap Batch 6)", async () => {
    commentsInMemory();
    corillo.files.set(PLAN, HUGE_TEXT);
    personComments("plan", "Too long.", "Huge: a very long");
    const bestTake = async () => {
      let best = Infinity;
      for (let i = 0; i < 3; i++) {
        const agent = connect();
        const start = performance.now();
        await agent.ok("take_document", { path: PLAN });
        best = Math.min(best, performance.now() - start);
        await agent.end();
      }
      return best;
    };
    const one = await bestTake();
    for (let i = 20; i < 140; i++) personComments("plan", `Comment ${i}.`, `Paragraph ${i}:`);
    const many = await bestTake();
    // About 2 and 10 milliseconds on the Mac this was written on. A take that read the
    // document again for each comment would be dozens of times slower, not a few.
    expect(many).toBeLessThan(one * 15);
  });
});

describe("a take never grows past the size agent tools set aside (B1-04)", () => {
  /** Claude Code keeps an answer over 50,000 characters in a file and shows the agent only its start. */
  const SET_ASIDE = 50_000;
  const words = (n: number, seed: string) => `${seed} ${"and some more words to say it at length ".repeat(Math.ceil(n / 40))}`.slice(0, n).trimEnd();
  /** A document of `sections` sections of four paragraphs of about 950 characters, each starting "Paragraph n:". */
  const handbook = (sections: number) =>
    ["# Handbook", "", ...Array.from({ length: sections }, (_, s) => [`## Section ${s}`, "", ...[0, 1, 2, 3].flatMap((p) => [words(950, `Paragraph ${s * 4 + p}:`), ""])]).flat()].join("\n");
  const idsIn = (text: string) => new Set([...text.matchAll(/^\[([0-9a-f]+)\] on /gm)].map((m) => m[1]));

  it("a 200,000-character document with 40 long comments and a long history since the last round stays under the size, with every comment's id", async () => {
    corillo.files.set(PLAN, handbook(52));
    // Claude's round: it answers ten comments, each with a change.
    const first = connect();
    await first.ok("open_document", { path: PLAN });
    const answered = Array.from({ length: 10 }, (_, i) => personComments("plan", words(500, `Point ${i}.`), `Paragraph ${i * 20 + 3}:`));
    await first.ok("take_document", { path: PLAN });
    for (const [i, t] of answered.entries()) {
      await first.ok("edit_document", { path: PLAN, edits: [{ find: `Paragraph ${i * 20 + 3}: and`, replace: `Paragraph ${i * 20 + 3}: so` }], comment_ids: [idOf(t)] });
      await first.ok("reply_to_comment", { path: PLAN, comment_id: idOf(t), text: words(400, "Changed.") });
    }
    await first.ok("finish_editing", { path: PLAN });
    await first.end();
    // Since: the person replies on all ten and leaves thirty more comments, and the text changes nineteen times.
    for (const t of answered) comments.reply("plan", t.id, person, words(400, "Not quite."));
    const fresh = Array.from({ length: 30 }, (_, i) => personComments("plan", words(700, `More ${i}.`), `Paragraph ${i * 6 + 5}:`));
    let text = corillo.files.get(PLAN)!;
    for (let v = 0; v < 19; v++) {
      text = text.replace(`Paragraph ${v * 9 + 1}: and`, `Paragraph ${v * 9 + 1}: but`);
      if (v % 2) corillo.history.outside("plan", text);
      else corillo.history.edited("plan", text);
    }
    corillo.files.set(PLAN, text);
    const taken = await connect().ok("take_document", { path: PLAN });
    expect(taken.length).toBeLessThan(SET_ASIDE - 5_000);
    const ids = idsIn(taken);
    for (const t of [...answered, ...fresh]) expect(ids.has(idOf(t)), `[${idOf(t)}] listed`).toBe(true);
    expect(taken).toContain("Since your last round on plan.md");
    expect(taken).toContain("so this is its outline");
  }, 20_000); // heavy: over 2.5 seconds beside a full run (Batch 6)

  it("a document just short of being long, with many comments, comes as its outline and start so the comments still fit", async () => {
    corillo.files.set(PLAN, handbook(9)); // about 35,000 characters: sent whole on its own
    const many = Array.from({ length: 36 }, (_, i) => personComments("plan", words(500, `Note ${i}.`), `Paragraph ${i}:`));
    const first = connect();
    const taken = await first.ok("take_document", { path: PLAN });
    expect(taken.length).toBeLessThan(SET_ASIDE - 5_000);
    for (const t of many) expect(idsIn(taken).has(idOf(t))).toBe(true);
    expect(taken).toContain("so this is its outline");
    // Alone, it's sent whole as before.
    await first.end();
    for (const t of many) comments.resolve("plan", t.id, person, true);
    expect(await connect().ok("take_document", { path: PLAN })).toContain("The whole text of plan.md follows.");
  });

  it("very many comments are shortened rather than left out: every id is still listed, and the agent is told where to read them in full", async () => {
    corillo.files.set(PLAN, handbook(9));
    const many = Array.from({ length: 36 }, (_, i) => personComments("plan", words(2_000, `Long note ${i}.`), `Paragraph ${i}:`));
    const taken = await connect().ok("take_document", { path: PLAN });
    expect(taken.length).toBeLessThan(SET_ASIDE - 5_000);
    for (const t of many) expect(idsIn(taken).has(idOf(t))).toBe(true);
    expect(taken).toContain("list_comments gives them in full");
  });
});

describe("the agent keeps its chat message short and teaches the loop in the chat (agent quick win 2, person quick win 2)", () => {
  it("open and create tell the agent to say the person can tell it when they're done", async () => {
    const claude = connect();
    expect(await claude.ok("open_document", { path: PLAN })).toContain(
      "Tell the person in the chat that it's ready for their review, and that when they've finished commenting they can tell you here.",
    );
    expect(await claude.ok("create_document", { path: "/docs/new.md", text: "# New\n" })).toContain(
      "Tell the person in the chat that it's ready for their review, and that when they've finished commenting they can tell you here.",
    );
  });

  it("finishing says a line in the chat is enough, and the first time how to ask for more", async () => {
    const claude = connect();
    await claude.ok("take_document", { path: PLAN });
    expect(await claude.ok("finish_editing", { path: PLAN })).toBe(
      "Done. plan.md is back with the person. They read your replies in Corillo, so in the chat a line is enough: that it's back, and anything they must decide. Tell them too that they can reply on any comment in Corillo and tell you here when there's more.",
    );
    await claude.ok("take_document", { path: PLAN });
    expect(await claude.ok("finish_editing", { path: PLAN })).toBe(
      "Done. plan.md is back with the person. They read your replies in Corillo, so in the chat a line is enough.",
    );
  });
});

describe("what happened since the agent's last round (A-8)", () => {
  /** Claude's round: three comments answered (two with changes), then its session ends. Version 2. */
  async function firstRound() {
    const claude = connect();
    await claude.ok("open_document", { path: PLAN });
    const a = personComments("plan", "Three, not two.", "hire two people");
    const b = personComments("plan", "Say how tight.", "The budget is tight.");
    const c = personComments("plan", "Is this the right quarter?", "this quarter");
    await claude.ok("take_document", { path: PLAN });
    await claude.ok("edit_document", { path: PLAN, edits: [{ find: "hire two people", replace: "hire three people" }], comment_ids: [idOf(a)] });
    await claude.ok("edit_document", { path: PLAN, edits: [{ find: "The budget is tight.", replace: "The budget is tight: $40,000." }], comment_ids: [idOf(b)] });
    for (const t of [a, b, c]) await claude.ok("reply_to_comment", { path: PLAN, comment_id: idOf(t), text: "Done." });
    await claude.ok("finish_editing", { path: PLAN });
    return { claude, a, b, c };
  }

  it("the take opens with what the person resolved, where they replied, what they changed in the text, and what that round did", async () => {
    const { claude, a, b } = await firstRound();
    await claude.end();
    comments.resolve("plan", a.id, person, true);
    comments.reply("plan", b.id, person, "Make it $45,000.");
    const d = personComments("plan", "Add a closing line.", null);
    corillo.unsaved.set(PLAN, corillo.files.get(PLAN)!.replace("## Budget", "## Budget and staff"));
    const taken = await connect().ok("take_document", { path: PLAN });
    expect(taken).toContain(
      `Since your last round on plan.md (version 2, just now), the person resolved 1 of the comments you answered and replied on [${idOf(b)}]; they edited the text (version 3). What they changed, as a unified diff of the Markdown:\n\n@@ -5,1 +5,1 @@\n-## Budget\n+## Budget and staff`,
    );
    expect(taken).toContain(
      'In that round you addressed 3 comments:\n- "Three, not two.": [-two-]{+three+}\n- "Say how tight.": {+: $40,000+}\n- "Is this the right quarter?": replied, no change to the text',
    );
    // It opens the take: before the comments, which are listed in full as ever.
    expect(taken.indexOf("Since your last round")).toBeLessThan(taken.indexOf("comments on plan.md waiting for you"));
    expect(taken).toContain(`[${idOf(d)}] on the whole document`);
  });

  it("in the same session the person's edits are given once, in the changes to the text", async () => {
    const { claude } = await firstRound();
    corillo.unsaved.set(PLAN, corillo.files.get(PLAN)!.replace("## Budget", "## Budget and staff"));
    const taken = await claude.ok("take_document", { path: PLAN });
    expect(taken).toContain("Since your last round on plan.md (version 2, just now), the person edited the text (version 3). What they changed is in the changes to the text below.");
    expect(taken.split("+## Budget and staff").length - 1).toBe(1);
  });

  it("another agent's pass and a change outside Corillo are named as such, never passed off as the person's", async () => {
    const { claude } = await firstRound();
    await claude.end();
    const writer = connect("claude-code", "Writer");
    await writer.ok("take_document", { path: PLAN });
    await writer.ok("edit_document", { path: PLAN, edits: [{ find: "# Plan", replace: "# Hiring plan" }] });
    await writer.ok("finish_editing", { path: PLAN });
    await writer.ok("finish_editing", { path: PLAN }).catch(() => "");
    const outside = corillo.files.get(PLAN)!.replace("$40,000", "$42,000");
    corillo.files.set(PLAN, outside);
    corillo.history.outside("plan", outside);
    const taken = await connect().ok("take_document", { path: PLAN });
    expect(taken).toContain("Since your last round on plan.md (version 2, just now), Writer made a pass (version 3); it was changed outside Corillo (version 4).");
    expect(taken).toContain("What changed in the text since, as a unified diff of the Markdown:");
  });

  it("a first round has no catch-up, and a round with nothing since says the text is as the agent left it", async () => {
    const claude = connect();
    expect(await claude.ok("take_document", { path: PLAN })).not.toContain("Since your last round");
    await claude.ok("finish_editing", { path: PLAN });
    await claude.end();
    const r = await firstRound();
    await r.claude.end();
    const again = await connect().ok("take_document", { path: PLAN });
    expect(again).toContain("Since your last round on plan.md (version 2, just now), the text is as you left it.");
  });

  it("is capped: a long history since the last round isn't walked, and a big change isn't sent", async () => {
    const { claude } = await firstRound();
    await claude.end();
    const texts: number[] = [];
    service = new AgentService(corillo, comments, { ...hooks, versionText: (id, n) => (texts.push(n), hooks.versionText(id, n)) }, { waitMs: 0 });
    let text = corillo.files.get(PLAN)!;
    for (let i = 0; i < 25; i++) {
      text += `\nAdded outside, ${i}.\n`;
      corillo.history.outside("plan", text);
    }
    corillo.files.set(PLAN, text);
    const taken = await connect().ok("take_document", { path: PLAN });
    expect(taken).toContain("Since your last round on plan.md (version 2, just now), there have been 25 versions, too many to go through here: list_versions and show_changes give them.");
    expect(texts).toEqual([]);
  });

  it("another live session's round is named as that session's, not 'your last round', and this session's own answers still count (B1-05)", async () => {
    const first = connect(); // an earlier chat, still open
    await first.ok("open_document", { path: PLAN });
    const second = connect(); // a new chat: plain Claude, so the first is Claude 2 now (roadmap Batch 3, item 3)
    await second.ok("open_document", { path: PLAN });
    expect(corillo.agents.get("plan")!.map((a) => a.name)).toEqual(["Claude 2", "Claude"]);
    // Claude 2 answers a comment for it (version 2), then Claude has a round (version 3).
    const budget = personComments("plan", "Say how tight.", "The budget is tight.", "Claude 2");
    await first.ok("take_document", { path: PLAN });
    await first.ok("reply_to_comment", { path: PLAN, comment_id: idOf(budget), text: "About $40,000." });
    await first.ok("finish_editing", { path: PLAN });
    const hire = personComments("plan", "Three, not two.", "hire two people");
    await second.ok("take_document", { path: PLAN });
    await second.ok("edit_document", { path: PLAN, edits: [{ find: "hire two people", replace: "hire three people" }], comment_ids: [idOf(hire)] });
    await second.ok("reply_to_comment", { path: PLAN, comment_id: idOf(hire), text: "Done." });
    await second.ok("finish_editing", { path: PLAN });
    comments.reply("plan", budget.id, person, "Make it $45,000.");
    const taken = await first.ok("take_document", { path: PLAN });
    expect(taken).toContain(`Since Claude's last round on plan.md (version 3, just now), the person replied on [${idOf(budget)}]; the text is as Claude left it.`);
    expect(taken).toContain('In that round Claude addressed 1 comment:\n- "Three, not two.": [-two-]{+three+}');
    expect(taken).not.toContain("your last round");
    // A new chat of the same tool, once the other has gone, still gets the catch-up as its own.
    await first.ok("finish_editing", { path: PLAN }).catch(() => "");
    await first.end();
    await second.end();
    expect(await connect().ok("take_document", { path: PLAN })).toContain("Since your last round on plan.md");
  });

  it("never says the person's changes are below when the take gives the outline instead of the changes (B1-09)", async () => {
    // About 110,000 characters on 1,100 lines; the person rewrites every other line of the first half.
    const line = (i: number, word = "plain") => `Line ${i}: ${`${word} words to fill the line `.repeat(4)}`.slice(0, 100);
    corillo.files.set(PLAN, `${Array.from({ length: 1100 }, (_, i) => line(i)).join("\n")}\n`);
    const claude = connect();
    await claude.ok("take_document", { path: PLAN });
    await claude.ok("edit_document", { path: PLAN, edits: [{ find: line(1000), replace: line(1000, "other") }] });
    await claude.ok("finish_editing", { path: PLAN });
    const rewritten = corillo.files.get(PLAN)!.split("\n").map((l, i) => (i < 520 && i % 2 === 0 ? line(i, "new") : l)).join("\n");
    corillo.unsaved.set(PLAN, rewritten);
    const taken = await claude.ok("take_document", { path: PLAN });
    expect(taken).toContain("so this is its outline");
    expect(taken).not.toContain("in the changes to the text below");
    expect(taken).toContain("the person edited the text (version 3). That's too much to show here: show_changes with version 3 and compared_with 2 gives it.");
  });

  it("says the text is as the agent left it only when it is: the person's typing not yet saved counts (B1-09)", async () => {
    const { claude } = await firstRound();
    await claude.end();
    corillo.unsaved.set(PLAN, corillo.files.get(PLAN)!.replace("$40,000", "$45,000"));
    const taken = await connect().ok("take_document", { path: PLAN });
    expect(taken).not.toContain("as you left it");
    expect(taken).toContain("the person edited the text (version 3). What they changed, as a unified diff of the Markdown:");
  });

  it("a history Corillo can't make sense of never fails the take: the agent gets the document without a catch-up (B1-08)", async () => {
    const { claude } = await firstRound();
    await claude.end();
    // A round recorded with a comment missing its messages (a damaged or older record, say).
    const damaged = (id: string) => [
      ...hooks.versions(id),
      { n: 9, kind: "agent" as const, agent: "Claude", created: "x", saved: "x", addressed: [{ id: "abc" } as unknown as Thread] },
    ];
    service = new AgentService(corillo, comments, { ...hooks, versions: damaged }, { waitMs: 0 });
    const next = connect();
    const taken = await next.ok("take_document", { path: PLAN });
    expect(taken).toContain("You're editing plan.md now.");
    expect(taken).not.toContain("Since your last round");
    expect(passes.at(-1)).toBe("Claude began a pass on plan");
    expect(await next.ok("edit_document", { path: PLAN, edits: [{ find: "# Plan", replace: "# Hiring plan" }] })).toContain("Hiring plan");
  });

  it("a change too big to show is pointed to, not sent", async () => {
    const { claude } = await firstRound();
    await claude.end();
    const big = `${corillo.files.get(PLAN)!}${Array.from({ length: 400 }, (_, i) => `\nA line the person added, number ${i}, with words enough to count.\n`).join("")}`;
    corillo.unsaved.set(PLAN, big);
    const taken = await connect().ok("take_document", { path: PLAN });
    expect(taken).toContain("the person edited the text (version 3). That's too much to show here: show_changes with version 3 and compared_with 2 gives it.");
    expect(taken.split("Since your last round")[1].split("In that round")[0].length).toBeLessThan(500);
  });
});

describe("waiting for the person's review, and Send to Claude (roadmap Batch 2, item 1)", () => {
  const NOTES = "/docs/notes.md";
  beforeEach(() => corillo.files.set(NOTES, "# Notes\n\nSome notes.\n"));

  /** A session in an agent tool that can wait (Claude Code in a terminal), with a way to start a wait and cancel it. */
  function waiter(introduced?: string) {
    const agent = connect("claude-code", introduced, { canWait: true });
    const wait = (args: Record<string, unknown> = {}) => {
      const controller = new AbortController();
      const w = {
        answer: null as { text: string; isError: boolean } | null,
        done: Promise.resolve(),
        cancel: () => controller.abort(),
      };
      w.done = service.call(agent.sessionId, "wait_for_review", { ...args, canHold: true }, controller.signal).then((r) => {
        w.answer = r;
      });
      return w;
    };
    return { ...agent, wait };
  }
  /** Let everything queued run. */
  const settle = () => new Promise((r) => setTimeout(r, 5));
  const listening = (storeId: string) => (corillo.agents.get(storeId) ?? []).filter((a) => a.listening).map((a) => a.name);
  const READY_WAIT =
    "Tell the person in the chat that it's ready for their review, then call wait_for_review and end your turn: they send it back to you from Corillo when they've finished.";

  it("an agent waits at no cost until the person sends the document back, and wakes holding it, with their comments", async () => {
    const claude = waiter();
    expect(await claude.ok("open_document", { path: PLAN })).toContain(READY_WAIT);
    const w = claude.wait();
    await settle();
    expect(w.answer).toBeNull();
    expect(listening("plan")).toEqual(["Claude"]);
    expect(service.sizes().listening).toBe(1);
    const c = personComments("plan", "Make it three.", "two people");
    expect(await service.send("plan")).toEqual({ sent: true });
    await w.done;
    expect(w.answer!.isError).toBe(false);
    expect(w.answer!.text).toMatch(/^The person sent plan\.md back to you from Corillo\.\n\nYou're editing plan\.md now\./);
    expect(w.answer!.text).toContain(`[${idOf(c)}] on "two people"`);
    expect(service.editingAgent("plan")).toBe("Claude");
    // Still listening while it works, and the window knows it has the comment (the card says "Sent to Claude").
    expect(listening("plan")).toEqual(["Claude"]);
    expect(corillo.agents.get("plan")![0].has).toEqual({ [c.id]: 1 });
  });

  it("a tool that can't wait is answered at once, and its open and finish say nothing of waiting", async () => {
    // Claude Desktop, and Claude Code where its connector said it can't (run with -p, say).
    for (const agent of [connect("claude-ai"), connect("claude-code")]) {
      expect(await agent.ok("open_document", { path: PLAN })).not.toContain("wait_for_review");
      const r = await agent.call("wait_for_review", { canHold: true });
      expect(r).toEqual({
        text: "Corillo can't wait for the person's review in this app: the call would be cut off. Tell them in the chat that when they've finished commenting they can tell you here. Don't call wait_for_review again in this chat.",
        isError: false,
      });
    }
    // An agent that can wait, in a call that can't be held (no progress token): answered at once too.
    const claude = waiter();
    await claude.ok("open_document", { path: PLAN });
    expect((await claude.call("wait_for_review", {})).text).toContain("can't wait");
    expect(listening("plan")).toEqual([]);
  });

  it("three documents with three agents waiting are independent: Send on one wakes only its agent", async () => {
    corillo.files.set("/docs/third.md", "# Third\n");
    const docs = [PLAN, NOTES, "/docs/third.md"];
    const agents = docs.map(() => waiter());
    const waits = [];
    for (const [i, a] of agents.entries()) {
      await a.ok("open_document", { path: docs[i] });
      waits.push(a.wait());
    }
    await settle();
    personComments("notes", "Shorter.", null);
    await service.send("notes");
    await waits[1].done;
    await settle();
    expect(waits[1].answer!.text).toContain("The person sent notes.md back to you from Corillo.");
    expect(waits[0].answer).toBeNull();
    expect(waits[2].answer).toBeNull();
    expect(service.editingAgent("notes")).toBe("Claude");
    expect(service.editingAgent("plan")).toBeNull();
    expect(listening("plan")).toEqual(["Claude"]);
    expect(listening("third")).toEqual(["Claude"]);
    for (const a of agents) await a.end();
    await Promise.all(waits.map((w) => w.done));
    expect(service.sizes().listening).toBe(0);
  });

  it("an agent with two documents hears about whichever is sent; a Send while it's busy is kept, the card says so, and it comes at its next wait", async () => {
    const claude = waiter();
    await claude.ok("open_document", { path: PLAN });
    await claude.ok("open_document", { path: NOTES });
    const first = claude.wait();
    await settle();
    expect(listening("plan")).toEqual(["Claude"]);
    expect(listening("notes")).toEqual(["Claude"]);
    const n = personComments("notes", "Shorter.", null);
    const c = personComments("plan", "Make it three.", "two people");
    await service.send("notes");
    await first.done;
    expect(first.answer!.text).toContain("The person sent notes.md back to you from Corillo.");
    // Busy on notes.md: a Send for plan.md waits for it.
    expect(await service.send("plan")).toEqual({ sent: true });
    expect(corillo.agents.get("plan")![0].sent).toEqual({ after: "notes.md" });
    expect(service.editingAgent("plan")).toBeNull();
    // Pressed again, it's kept once.
    expect(await service.send("plan")).toEqual({ sent: true });
    await claude.ok("reply_to_comment", { path: NOTES, comment_id: idOf(n), text: "Done." });
    expect(await claude.ok("finish_editing", { path: NOTES })).toContain("Then call wait_for_review and end your turn");
    const second = claude.wait();
    await second.done;
    expect(second.answer!.text).toMatch(/^The person sent plan\.md back to you from Corillo\.\n\nYou're editing plan\.md now\./);
    expect(second.answer!.text).toContain("Make it three.");
    expect(corillo.agents.get("plan")![0].sent).toBeUndefined();
    await claude.ok("reply_to_comment", { path: PLAN, comment_id: idOf(c), text: "Three it is." });
    await claude.ok("finish_editing", { path: PLAN });
    // Nothing more was kept for it: its next wait is held.
    const third = claude.wait();
    await settle();
    expect(third.answer).toBeNull();
    third.cancel();
    await third.done;
  });

  it("a Send kept for a busy agent is let go when another chat picks up its comments, and the agent is never woken to a document with nothing for it (B3-R05)", async () => {
    const claude = waiter();
    await claude.ok("open_document", { path: PLAN });
    await claude.ok("open_document", { path: NOTES });
    const first = claude.wait();
    await settle();
    const n = personComments("notes", "Shorter.", null);
    const c = personComments("plan", "Make it three.", "two people");
    await service.send("notes");
    await first.done;
    // Busy on notes.md: the Send for plan.md is kept for it.
    expect(await service.send("plan")).toEqual({ sent: true });
    const claudeOn = (key: string) => corillo.agents.get(key)!.find((a) => a.name === "Claude")!;
    expect(claudeOn("plan").sent).toEqual({ after: "notes.md" });
    // The person asks another chat about plan.md: it takes the document, and the comment with no @ is its now (D3).
    const other = connect("claude-code");
    expect(await other.ok("take_document", { path: PLAN })).toContain("Make it three.");
    // Nothing on plan.md is left for Claude: the window no longer says it's sent to it.
    expect(claudeOn("plan").sent).toBeUndefined();
    expect(handBackFor(comments.threads("plan"), corillo.agents.get("plan")!, () => false)?.kind).not.toBe("sent");
    await other.ok("reply_to_comment", { path: PLAN, comment_id: idOf(c), text: "Three it is." });
    await other.ok("finish_editing", { path: PLAN });
    // Claude finishes notes.md and waits again: it isn't woken for plan.md, which has nothing for it.
    await claude.ok("reply_to_comment", { path: NOTES, comment_id: idOf(n), text: "Done." });
    await claude.ok("finish_editing", { path: NOTES });
    const second = claude.wait();
    await settle();
    expect(second.answer).toBeNull();
    expect(service.editingAgent("plan")).toBeNull();
    expect(claudeOn("plan").sent).toBeUndefined();
    second.cancel();
    await second.done;
  });

  it("a Send kept for comments the person resolves meanwhile doesn't wake the agent to an empty round (B3-R05)", async () => {
    const claude = waiter();
    await claude.ok("open_document", { path: PLAN });
    await claude.ok("open_document", { path: NOTES });
    const first = claude.wait();
    await settle();
    const n = personComments("notes", "Shorter.", null);
    const c = personComments("plan", "Make it three.", "two people");
    await service.send("notes");
    await first.done;
    expect(await service.send("plan")).toEqual({ sent: true });
    comments.resolve("plan", c.id, person, true);
    await claude.ok("reply_to_comment", { path: NOTES, comment_id: idOf(n), text: "Done." });
    await claude.ok("finish_editing", { path: NOTES });
    const second = claude.wait();
    await settle();
    expect(second.answer).toBeNull();
    expect(service.editingAgent("plan")).toBeNull();
    expect(corillo.agents.get("plan")![0].sent).toBeUndefined();
    second.cancel();
    await second.done;
  });

  it("once the person resolves what a Send kept for a busy agent was for, the button and the cards stop saying it was sent (roadmap Batch 6)", async () => {
    // As in the app: the agent service hears whenever the comments change.
    comments = new CommentService(new DocumentStore(dataDir), (storeId) => service.commentsChanged(storeId));
    service = new AgentService(corillo, comments, hooks, { waitMs: 0 });
    const claude = waiter();
    await claude.ok("open_document", { path: PLAN });
    await claude.ok("open_document", { path: NOTES });
    const first = claude.wait();
    await settle();
    const n = personComments("notes", "Shorter.", null);
    const c = personComments("plan", "Make it three.", "two people");
    const d = personComments("plan", "And cheaper.", null);
    await service.send("notes");
    await first.done;
    expect(await service.send("plan")).toEqual({ sent: true });
    const claudeOn = () => corillo.agents.get("plan")![0];
    const button = () => handBackFor(comments.threads("plan"), corillo.agents.get("plan")!, () => false);
    expect(claudeOn().sent).toEqual({ after: "notes.md" });
    // One of the two resolved: the other is still sent.
    comments.resolve("plan", c.id, person, true);
    await settle();
    expect(claudeOn().sent).toEqual({ after: "notes.md" });
    expect(turnLabel(comments.threads("plan").find((t) => t.id === d.id)!, corillo.agents.get("plan")!, false)).toBe("Sent to Claude: it will start when it has finished notes.md");
    // Both resolved: nothing was sent for, and nothing says it was.
    comments.resolve("plan", d.id, person, true);
    await settle();
    expect(claudeOn().sent).toBeUndefined();
    expect(claudeOn().listening).toBe(true); // it's working, and will wait again
    expect(button()).toEqual({ kind: "listening", agent: "Claude" });
    // Reopened (Undo straight after Resolve): it's for Claude again, not yet sent.
    comments.resolve("plan", d.id, person, false);
    await settle();
    expect(button()).toEqual({ kind: "send", agent: "Claude", comments: 1 });
    // A Send of the whole document with no comments for it stays sent, whatever the person resolves.
    comments.resolve("plan", d.id, person, true);
    expect(await service.send("plan")).toEqual({ sent: true });
    await settle();
    expect(claudeOn().sent).toEqual({ after: "notes.md" });
    await claude.ok("reply_to_comment", { path: NOTES, comment_id: idOf(n), text: "Done." });
    await claude.ok("finish_editing", { path: NOTES });
    const second = claude.wait();
    await second.done;
    expect(second.answer!.text).toContain("The person sent plan.md back to you from Corillo.");
  });

  it("a wait still open while the agent works on a request from the chat gets the Send made meanwhile as soon as it finishes", async () => {
    const claude = waiter();
    await claude.ok("open_document", { path: PLAN });
    await claude.ok("open_document", { path: NOTES });
    const w = claude.wait();
    await settle();
    await claude.ok("take_document", { path: NOTES, request: "Tidy it." });
    await service.send("plan");
    await settle();
    expect(w.answer).toBeNull();
    expect(corillo.agents.get("plan")![0].sent).toEqual({ after: "notes.md" });
    await claude.ok("finish_editing", { path: NOTES });
    await w.done;
    expect(w.answer!.text).toContain("The person sent plan.md back to you from Corillo.");
    expect(service.editingAgent("plan")).toBe("Claude");
  });

  it("a wait cut short ends quietly: one answer that says not to call again, and the agent stops listening", async () => {
    const claude = waiter();
    await claude.ok("open_document", { path: PLAN });
    // Cancelled: the person pressed Esc, or the connector's own time limit ran out.
    const a = claude.wait();
    await settle();
    a.cancel();
    await a.done;
    expect(a.answer).toEqual({
      text: "Stopped listening for the person's review of plan.md. Say once in the chat that you've stopped listening; don't call wait_for_review again unless they ask.",
      isError: false,
    });
    expect(listening("plan")).toEqual([]);
    expect(await service.send("plan")).toEqual({ sent: false, problem: "No agent is waiting for your review of plan.md." });
    // The person closed the document.
    const b = claude.wait();
    await settle();
    corillo.docs = [];
    await service.closed("plan", PLAN);
    await b.done;
    expect(b.answer).toEqual({
      text: "The person closed plan.md in Corillo, so you've stopped listening for their review. Say so once in the chat; don't call wait_for_review again unless they ask.",
      isError: false,
    });
    // Corillo is quitting.
    await claude.ok("open_document", { path: PLAN });
    const c = claude.wait();
    await settle();
    service.quitting();
    await c.done;
    expect(c.answer!.text).toBe(
      "Corillo is closing, so you've stopped listening for the person's review. Say so once in the chat; don't call wait_for_review again unless they ask.",
    );
    // The session ended.
    const d = claude.wait();
    await settle();
    expect(listening("plan")).toEqual(["Claude"]);
    await claude.end();
    await d.done;
    expect(corillo.agents.get("plan")).toEqual([]);
    expect(service.sizes().listening).toBe(0);
  });

  it("a wait while the agent still holds a document is answered at once: finish first, then wait; nothing is left held (B2-02)", async () => {
    const claude = waiter();
    await claude.ok("open_document", { path: PLAN });
    const w = claude.wait();
    await settle();
    const c = personComments("plan", "Make it three.", "two people");
    await service.send("plan");
    await w.done;
    // It replies, skips finish_editing (it never called take_document itself), and waits.
    await claude.ok("reply_to_comment", { path: PLAN, comment_id: idOf(c), text: "Three it is." });
    const early = claude.wait();
    await settle();
    expect(early.answer).toEqual({
      text: "You're still editing plan.md, so the person can't edit it or send it back. Reply on each comment you've addressed, call finish_editing, then call wait_for_review.",
      isError: true,
    });
    expect(service.editingAgent("plan")).toBe("Claude");
    expect(listening("plan")).toEqual(["Claude"]); // working on it, and will wait again
    await claude.ok("finish_editing", { path: PLAN });
    const later = claude.wait();
    await settle();
    expect(later.answer).toBeNull();
    expect(listening("plan")).toEqual(["Claude"]);
    later.cancel();
    await later.done;
  });

  it("right after Send the document shows as sent while the take is under way, and a take that fails is told to the window (B2-04)", async () => {
    const claude = waiter();
    await claude.ok("open_document", { path: PLAN });
    const w = claude.wait();
    await settle();
    personComments("plan", "Make it three.", "two people");
    // The person's pending edits take a moment to save before the take.
    let saved!: (answer: FlushResult) => void;
    corillo.flush = () => new Promise<FlushResult>((resolve) => (saved = resolve));
    expect(await service.send("plan")).toEqual({ sent: true });
    await settle();
    expect(w.answer).toBeNull();
    expect(corillo.agents.get("plan")![0]).toMatchObject({ listening: true, sent: { after: null }, editing: false });
    // The save fails (the file changed outside Corillo meanwhile): the take fails, and the window hears why the agent didn't start.
    saved("conflict");
    await w.done;
    expect(w.answer!.isError).toBe(true);
    expect(w.answer!.text).toMatch(/^The person sent plan\.md back to you from Corillo, but it couldn't be taken for you:/);
    expect(corillo.lost).toEqual(["Claude failed on plan"]);
    expect(corillo.agents.get("plan")![0].sent).toBeUndefined();
  });

  it("a second wait while one is open says so at once and adds its documents; the open one is what wakes", async () => {
    const claude = waiter();
    await claude.ok("open_document", { path: PLAN });
    const first = claude.wait();
    await settle();
    expect(await claude.ok("create_document", { path: "/docs/new.md", text: "# New\n" })).toContain(READY_WAIT);
    const second = claude.wait();
    await second.done;
    expect(second.answer).toEqual({
      text: "You're already waiting for the person's review of plan.md and new.md: an earlier wait_for_review is still open. End your turn now; you're woken when they send one back.",
      isError: false,
    });
    expect(listening("new")).toEqual(["Claude"]);
    await service.send("new");
    await first.done;
    expect(first.answer!.text).toContain("The person sent new.md back to you from Corillo.");
  });

  it("a wait can name its documents, by path or name; with none it's told which are open", async () => {
    const claude = waiter();
    expect(await claude.call("wait_for_review", { canHold: true })).toEqual({
      text: "No documents are open in Corillo to wait for. Open one for the person's review first (open_document or create_document), then wait.",
      isError: true,
    });
    corillo.open(NOTES); // the person opened it
    expect(await claude.call("wait_for_review", { canHold: true })).toEqual({
      text: "Say which documents to wait for: give their names or full paths as paths.\n\nOpen in Corillo:\n- /docs/notes.md (no comments waiting for you)",
      isError: true,
    });
    expect(await claude.call("wait_for_review", { canHold: true, paths: ["/docs/plan.md"] })).toEqual({
      text: "plan.md isn't open in Corillo. Open it with open_document first, then wait.",
      isError: true,
    });
    const w = claude.wait({ paths: ["notes"] });
    await settle();
    expect(w.answer).toBeNull();
    expect(listening("notes")).toEqual(["Claude"]);
    w.cancel();
    await w.done;
    expect(w.answer!.text).toContain("Stopped listening for the person's review of notes.md.");
  });

  it("a wait by name: a name that fits several open documents lists them; a file in the agent's own folder is that file (B2-05)", async () => {
    // Two README.md open, from two folders (opened by the person).
    for (const [storeId, filePath] of [["readme-a", "/a/README.md"], ["readme-b", "/b/README.md"]]) {
      corillo.files.set(filePath, "# Read me\n");
      corillo.docs.push({ id: `tab-${storeId}`, storeId, filePath });
    }
    const claude = waiter();
    expect(await claude.call("wait_for_review", { canHold: true, paths: ["README.md"] })).toEqual({
      text: '2 open documents fit "README.md": /a/README.md and /b/README.md. Give the full path of the one to wait for.',
      isError: true,
    });
    // The connector adds where a bare name would be as a file in the agent's folder: that file it is, as with take_document.
    const w = claude.wait({ paths: ["README.md"], here: ["/b/README.md"] });
    await settle();
    expect(w.answer).toBeNull();
    expect(listening("readme-b")).toEqual(["Claude"]);
    expect(listening("readme-a")).toEqual([]);
    w.cancel();
    await w.done;
    // Its own file, not open in Corillo: never another open document of that name.
    corillo.files.set("/c/README.md", "# About this folder\n");
    expect(await claude.call("wait_for_review", { canHold: true, paths: ["README.md"], here: ["/c/README.md"] })).toEqual({
      text: "README.md isn't open in Corillo. Open it with open_document first, then wait.",
      isError: true,
    });
    // No such file in its folder: the name is matched among the open documents.
    corillo.files.set(NOTES, "# Notes\n");
    corillo.open(NOTES);
    const n = claude.wait({ paths: ["notes.md"], here: ["/c/notes.md"] });
    await settle();
    expect(listening("notes")).toEqual(["Claude"]);
    n.cancel();
    await n.done;
  });

  it("Send goes to the agent named, and is refused while an agent edits or when nobody listens", async () => {
    const claude = waiter();
    const writer = waiter("Writer");
    await claude.ok("open_document", { path: PLAN });
    await writer.ok("open_document", { path: PLAN });
    expect(await service.send("plan")).toEqual({ sent: false, problem: "No agent is waiting for your review of plan.md." });
    const c = claude.wait();
    const w = writer.wait();
    await settle();
    expect(listening("plan")).toEqual(["Claude", "Writer"]);
    await service.send("plan", "Writer");
    await w.done;
    expect(w.answer!.text).toContain("The person sent plan.md back to you from Corillo.");
    expect(service.editingAgent("plan")).toBe("Writer");
    expect(await service.send("plan", "Claude")).toEqual({ sent: false, problem: "Writer is editing plan.md." });
    expect(c.answer).toBeNull();
    c.cancel();
    await c.done;
  });

  it("an agent that doesn't wait again soon after its pass stops listening, and the window is told of a Send kept for it (B2-01)", async () => {
    service = new AgentService(corillo, comments, hooks, { waitMs: 0, graceMs: 20 });
    const claude = waiter();
    await claude.ok("open_document", { path: PLAN });
    await claude.ok("open_document", { path: NOTES });
    const w = claude.wait();
    await settle();
    await service.send("notes");
    await w.done;
    await service.send("plan");
    expect(corillo.agents.get("plan")![0].sent).toEqual({ after: "notes.md" });
    await claude.ok("finish_editing", { path: NOTES });
    expect(listening("plan")).toEqual(["Claude"]); // kept for it: it was told to wait again
    expect(corillo.agents.get("plan")![0].sent).toEqual({ after: null });
    // Not waiting and not working: notes.md doesn't say it's waiting.
    expect(listening("notes")).toEqual([]);
    expect(corillo.lost).toEqual([]);
    await new Promise((r) => setTimeout(r, 80));
    expect(listening("plan")).toEqual([]);
    expect(corillo.agents.get("plan")![0].sent).toBeUndefined();
    // Never without a word: the window hears the Send didn't reach it (and only plan.md's, the one sent).
    expect(corillo.lost).toEqual(["Claude stopped on plan"]);
    expect(service.sizes().listening).toBe(0);
  });

  it("an agent that takes a document from a chat request in the little while after its round stays listening through that pass, and a Send made meanwhile reaches it (roadmap Batch 6)", async () => {
    service = new AgentService(corillo, comments, hooks, { waitMs: 0, graceMs: 250 });
    const claude = waiter();
    await claude.ok("open_document", { path: PLAN });
    await claude.ok("open_document", { path: NOTES });
    const w = claude.wait();
    await settle();
    await service.send("notes");
    await w.done;
    await claude.ok("finish_editing", { path: NOTES });
    // Before it waits again, the person asks in the chat for something on plan.md: it takes it, without waiting first.
    await claude.ok("take_document", { path: PLAN, request: "Tidy it." });
    expect(listening("plan")).toEqual(["Claude"]);
    await new Promise((r) => setTimeout(r, 400)); // longer than the little while it had
    expect(listening("plan")).toEqual(["Claude"]); // working, and will wait again
    expect(listening("notes")).toEqual(["Claude"]);
    personComments("notes", "Shorter.", null);
    expect(await service.send("notes")).toEqual({ sent: true });
    expect(corillo.agents.get("notes")![0].sent).toEqual({ after: "plan.md" });
    await claude.ok("finish_editing", { path: PLAN });
    const again = claude.wait();
    await again.done;
    expect(again.answer!.text).toContain("The person sent notes.md back to you from Corillo.");
    expect(corillo.lost).toEqual([]);
  });

  it("a Send kept while the agent is busy is handed over at its next wait, even one that names only its other document (B2-01)", async () => {
    const claude = waiter();
    await claude.ok("open_document", { path: PLAN });
    await claude.ok("open_document", { path: NOTES });
    const first = claude.wait();
    await settle();
    personComments("plan", "Make it three.", "two people");
    await service.send("notes");
    await first.done;
    expect(await service.send("plan")).toEqual({ sent: true });
    await claude.ok("finish_editing", { path: NOTES });
    const second = claude.wait({ paths: ["notes.md"] });
    await second.done;
    expect(second.answer!.text).toMatch(/^The person sent plan\.md back to you from Corillo\.\n\nYou're editing plan\.md now\./);
    expect(second.answer!.text).toContain("Make it three.");
    expect(corillo.lost).toEqual([]);
  });

  it("in the little while after its pass, before it waits again, the window doesn't say the agent is waiting (B2-01)", async () => {
    const claude = waiter();
    await claude.ok("open_document", { path: PLAN });
    const w = claude.wait();
    await settle();
    const c = personComments("plan", "Make it three.", "two people");
    await service.send("plan");
    await w.done;
    expect(listening("plan")).toEqual(["Claude"]); // working on it, and will wait again
    await claude.ok("reply_to_comment", { path: PLAN, comment_id: idOf(c), text: "Three it is." });
    await claude.ok("finish_editing", { path: PLAN });
    expect(listening("plan")).toEqual([]);
    expect(await service.send("plan")).toEqual({ sent: true }); // a press that crossed the change is kept, not refused
    const again = claude.wait();
    await again.done;
    expect(again.answer!.text).toContain("The person sent plan.md back to you from Corillo.");
  });

  it("a Send kept for an agent whose wait is cancelled, or whose session ends, is told to the window (B2-01)", async () => {
    for (const how of ["cancel", "end"] as const) {
      corillo.lost = [];
      const claude = waiter();
      await claude.ok("open_document", { path: PLAN });
      await claude.ok("open_document", { path: NOTES });
      const w = claude.wait();
      await settle();
      await claude.ok("take_document", { path: NOTES, request: "Tidy it." });
      await service.send("plan");
      expect(corillo.agents.get("plan")!.find((a) => a.listening)?.sent).toEqual({ after: "notes.md" });
      if (how === "cancel") w.cancel();
      else await claude.end();
      await w.done;
      expect(corillo.lost).toEqual([expect.stringMatching(/^Claude( 2)? stopped on plan$/)]);
      if (how === "cancel") {
        await claude.ok("finish_editing", { path: NOTES });
        await claude.end();
      }
    }
  });

  it("finishing tells an agent that can wait to wait again", async () => {
    const claude = waiter();
    await claude.ok("take_document", { path: PLAN });
    expect(await claude.ok("finish_editing", { path: PLAN })).toBe(
      "Done. plan.md is back with the person. They read your replies in Corillo, so in the chat a line is enough: that it's back, and anything they must decide. Then call wait_for_review and end your turn: they can reply on any comment and send it back to you from Corillo.",
    );
    await claude.ok("take_document", { path: PLAN });
    expect(await claude.ok("finish_editing", { path: PLAN })).toBe(
      "Done. plan.md is back with the person. They read your replies in Corillo, so in the chat a line is enough. Then call wait_for_review and end your turn.",
    );
  });

  it("a comment the agent left for its next pass isn't counted as sent: its card says not sent yet, and Send can hand it back (B2-06)", async () => {
    const claude = waiter();
    await claude.ok("open_document", { path: PLAN });
    const w = claude.wait();
    await settle();
    const a = personComments("plan", "Make it three.", "two people");
    const b = personComments("plan", "Say by how much.", "tight");
    await service.send("plan");
    await w.done;
    await claude.ok("reply_to_comment", { path: PLAN, comment_id: idOf(a), text: "Three it is." });
    expect(await claude.fails("finish_editing", { path: PLAN })).toContain("To leave it for your next pass instead, call finish_editing again.");
    expect(corillo.agents.get("plan")![0].has).toEqual({ [b.id]: 1 }); // in the pass, it has it
    await claude.ok("finish_editing", { path: PLAN }); // left for its next pass
    const again = claude.wait();
    await settle();
    const agents = corillo.agents.get("plan")!;
    expect(agents[0].has).toBeUndefined();
    const threads = comments.threads("plan");
    const yours = (t: Thread) => t.messages[t.messages.length - 1]?.author.kind === "agent";
    expect(turnLabel(threads.find((t) => t.id === b.id)!, agents, false)).toBe("For Claude, not sent yet");
    expect(handBackFor(threads, agents, yours)).toEqual({ kind: "send", agent: "Claude", comments: 1 });
    // Sent again, its next pass has it.
    await service.send("plan");
    await again.done;
    expect(again.answer!.text).toContain("Say by how much.");
    expect(corillo.agents.get("plan")![0].has).toEqual({ [b.id]: 1 });
  });

  it("the window hears what each agent has been given, by any route, so a card can say it was sent", async () => {
    const claude = connect();
    await claude.ok("open_document", { path: PLAN });
    const a = personComments("plan", "Make it three.", "two people");
    expect(corillo.agents.get("plan")![0].has).toBeUndefined();
    await claude.ok("list_comments", { path: PLAN }); // told in the chat, the agent looked
    expect(corillo.agents.get("plan")![0].has).toEqual({ [a.id]: 1 });
    comments.reply("plan", a.id, person, "Or four.");
    const b = personComments("plan", "Say by how much.", "tight");
    await claude.ok("take_document", { path: PLAN });
    expect(corillo.agents.get("plan")![0].has).toEqual({ [a.id]: 2, [b.id]: 1 });
    // Answered, it's the person's turn: nothing to say about it.
    await claude.ok("reply_to_comment", { path: PLAN, comment_id: idOf(a), text: "Four it is." });
    await claude.ok("read_document", { path: PLAN });
    expect(corillo.agents.get("plan")![0].has).toEqual({ [b.id]: 1 });
  });
});

// Roadmap Batch 2, item 3 (A-4): with finish_editing, a note for what the
// person should know or decide about the pass that doesn't belong on one
// comment. It waits at the top of their Comments panel until they mark it
// done, and History keeps it with the version.
describe("a cover note with every hand-back (roadmap Batch 2, item 3; A-4)", () => {
  const NOTE = "I also called the budget very tight; say if that's too strong.";

  it("finish_editing takes a note: it waits for the person until marked done, is kept with the pass's version, and the agent is told they read it in Corillo", async () => {
    const summaries: PassSummary[] = [];
    corillo.passEnded = (_id, summary) => summaries.push(summary);
    const claude = connect();
    const hire = personComments("plan", "Make it three.", "two people");
    await claude.ok("take_document", { path: PLAN });
    await claude.ok("edit_document", { path: PLAN, edits: [{ find: "two people", replace: "three people" }], comment_ids: [idOf(hire)] });
    await claude.ok("edit_document", { path: PLAN, edits: [{ find: "tight", replace: "very tight" }] });
    await claude.ok("reply_to_comment", { path: PLAN, comment_id: idOf(hire), text: "Made it three." });
    expect(await claude.ok("finish_editing", { path: PLAN, note: `  ${NOTE}  ` })).toBe(
      "Done. plan.md is back with the person. They read your replies and your note in Corillo, so in the chat a line is enough: that it's back. Tell them too that they can reply on any comment in Corillo and tell you here when there's more.",
    );
    const [kept] = comments.notes("plan");
    expect(kept).toEqual({ id: expect.stringMatching(/^note-/), agent: "Claude", text: NOTE, at: expect.any(String) });
    expect(comments.notes("plan")).toHaveLength(1);
    expect(ended[0].note).toBe(NOTE);
    expect(summaries).toHaveLength(1);
    const newest = corillo.history.list("plan").at(-1)!;
    expect(newest).toMatchObject({ kind: "agent", agent: "Claude", note: NOTE });
    expect(newest.addressed?.map((t) => t.id)).toEqual([hire.id]);
    expect(await claude.ok("list_versions", { path: PLAN })).toContain(`\n  Note to the person: "${NOTE}"`);
    // The person marks it done: it leaves the panel, and History still has it.
    comments.doneNote("plan", kept.id);
    expect(comments.notes("plan")).toEqual([]);
    expect(corillo.history.list("plan").at(-1)!.note).toBe(NOTE);
  });

  it("a pass that leaves only a note still gets a version, and the person hears it's done; without one, a pass that did nothing leaves nothing", async () => {
    const summaries: PassSummary[] = [];
    corillo.passEnded = (_id, summary) => summaries.push(summary);
    const claude = connect();
    await claude.ok("take_document", { path: PLAN });
    await claude.ok("finish_editing", { path: PLAN, note: "I read it through and changed nothing: the numbers add up." });
    expect(summaries.map((s) => s.agent)).toEqual(["Claude"]);
    expect(corillo.history.list("plan")).toHaveLength(2);
    expect(corillo.history.list("plan").at(-1)).toMatchObject({ kind: "agent", agent: "Claude", note: "I read it through and changed nothing: the numbers add up." });
    await claude.ok("take_document", { path: PLAN });
    await claude.ok("finish_editing", { path: PLAN, note: "   " });
    expect(corillo.history.list("plan")).toHaveLength(2);
    expect(summaries).toHaveLength(1);
    expect(comments.notes("plan")).toHaveLength(1);
  });

  it("a note given with a finish that's turned back (a comment still waiting) goes with the finish that goes through, and a newer note takes its place", async () => {
    const claude = connect();
    personComments("plan", "Say by how much.", "tight");
    await claude.ok("take_document", { path: PLAN });
    expect(await claude.fails("finish_editing", { path: PLAN, note: "First thoughts." })).toContain("Not finished");
    await claude.ok("finish_editing", { path: PLAN });
    expect(comments.notes("plan").map((n) => n.text)).toEqual(["First thoughts."]);
    expect(corillo.history.list("plan").at(-1)!.note).toBe("First thoughts.");
    await claude.ok("take_document", { path: PLAN });
    expect(await claude.fails("finish_editing", { path: PLAN, note: "Draft." })).toContain("Not finished");
    await claude.ok("finish_editing", { path: PLAN, note: "Better." });
    expect(comments.notes("plan").map((n) => n.text)).toEqual(["First thoughts.", "Better."]);
  });

  it("a note is cut at 2,000 characters, and a document keeps the newest 10 not yet marked done; History keeps every one", async () => {
    const claude = connect();
    for (let i = 1; i <= 12; i++) {
      await claude.ok("take_document", { path: PLAN });
      await claude.ok("finish_editing", { path: PLAN, note: i === 12 ? "x".repeat(2500) : `Note ${i}.` });
    }
    const kept = comments.notes("plan").map((n) => n.text);
    expect(kept).toHaveLength(10);
    expect(kept.slice(0, 9)).toEqual(Array.from({ length: 9 }, (_, i) => `Note ${i + 3}.`));
    expect(kept[9]).toBe(`${"x".repeat(2000)}…`);
    expect(corillo.history.list("plan").filter((v) => v.note)).toHaveLength(12);
  });

  it("notes are kept on disk beside the document's comments and read back after a restart; a damaged notes file is set aside, never written over unread", async () => {
    const claude = connect();
    await claude.ok("take_document", { path: PLAN });
    await claude.ok("finish_editing", { path: PLAN, note: NOTE });
    const store = new DocumentStore(dataDir);
    const setAside: string[] = [];
    store.onSetAside = (_id, what) => setAside.push(what);
    expect(new CommentService(store, () => {}).notes("plan").map((n) => [n.agent, n.text])).toEqual([["Claude", NOTE]]);
    const file = path.join(dataDir, "documents", "plan", "notes.json");
    writeFileSync(file, "{ not json");
    expect(new CommentService(store, () => {}).notes("plan")).toEqual([]);
    expect(setAside).toEqual(["notes"]);
    expect(existsSync(file)).toBe(false);
    expect(readdirSync(path.dirname(file)).some((name) => name.startsWith("notes.json") && name !== "notes.json")).toBe(true);
  });

  it("the window hears of each note as it's added and as it's marked done, and a closed document's notes aren't kept in memory", async () => {
    const told: string[][] = [];
    comments = new CommentService(new DocumentStore(dataDir), () => {}, (_id, notes) => told.push(notes.map((n) => n.text)));
    service = new AgentService(corillo, comments, hooks, { waitMs: 0 });
    const claude = connect();
    await claude.ok("take_document", { path: PLAN });
    await claude.ok("finish_editing", { path: PLAN, note: NOTE });
    comments.doneNote("plan", comments.notes("plan")[0].id);
    comments.doneNote("plan", "note-gone"); // already done: nothing to tell
    expect(told).toEqual([[NOTE], []]);
    expect(comments.sizes().notes).toBe(1);
    comments.forget("plan");
    expect(comments.sizes().notes).toBe(0);
  });
});


// The safety net (roadmap Batch 14, item 1): an agent's find and replace
// leaves every word outside what it found as it was. A fault planted in the
// splice is refused with the words named; an edit that deletes a paragraph,
// and a replace_document that rewrites most of the document, go through.
describe("the safety net on an agent's edits", () => {
  it("refuses an edit whose splice would lose words outside what it found, naming them, and writes nothing", async () => {
    service = new AgentService(corillo, comments, hooks, { waitMs: 0, spliceFault: (text) => text.replace("The budget is tight.", "The is tight.") });
    const claude = connect();
    await claude.ok("take_document", { path: PLAN });
    const said = await claude.fails("edit_document", { path: PLAN, edits: [{ find: "two people", replace: "three people" }] });
    expect(said).toContain('Nothing was changed: Corillo would also have taken out words outside the text you asked to find: "budget".');
    expect(said).toContain("replace_document instead");
    expect(corillo.files.get(PLAN)).toBe(PLAN_TEXT);
    expect(corillo.log.filter((l) => l.startsWith("showed agent text"))).toEqual([]);
  });

  it("lets an edit that deletes a whole paragraph, and a replace_document that rewrites most of the document, through", async () => {
    const claude = connect();
    await claude.ok("take_document", { path: PLAN });
    await claude.ok("edit_document", { path: PLAN, edits: [{ find: "We should hire two people this quarter.\n\n", replace: "" }] });
    expect(corillo.files.get(PLAN)).toBe("# Plan\n\n## Budget\n\nThe budget is tight.\n");
    await claude.ok("read_document", { path: PLAN });
    const rewritten = "# A new plan\n\nEverything here is new, written again from the start.\n\n## Money\n\nWe spend less.\n";
    await claude.ok("replace_document", { path: PLAN, text: rewritten });
    expect(corillo.files.get(PLAN)).toBe(rewritten);
  });
});
