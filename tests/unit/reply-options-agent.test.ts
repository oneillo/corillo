// Options on an agent's reply (roadmap Batch 3, item 2; D7), as agents use
// them: offered with reply_to_comment, checked against the text as it is when
// posted, shown to agents with the person's choice; and the person's choice
// recorded by Corillo for the window.
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
import { turnLabel } from "../../src/renderer/comment-format";
import { planChoice } from "../../src/core/options";
import { forgetReadTexts, readTextsHeld } from "../../src/core/web-pictures";

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
  const data = mkdtempSync(path.join(tmpdir(), "corillo-options-"));
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

const shorter = { label: "Shorter", edits: [{ find: "We should hire three people this quarter.", replace: "Hire three this quarter." }] };
const formal = { label: "Formal", edits: [{ find: "We should hire three people this quarter.", replace: "The plan is to recruit three staff this quarter." }] };

/** Claude takes the plan, makes its best version, and replies on the comment with the others as options. */
async function offered() {
  const claude = connect();
  const t = personComments("Too wordy, and should it be three?", "We should hire two people");
  await claude.ok("take_document", { path: PLAN });
  await claude.ok("edit_document", { path: PLAN, edits: [{ find: "hire two people", replace: "hire three people" }], comment_ids: [idOf(t)] });
  const replied = await claude.ok("reply_to_comment", { path: PLAN, comment_id: idOf(t), text: "Made it three. Shorter or more formal?", options: [shorter, formal] });
  return { claude, t, replied };
}

describe("an agent offers options on its reply", () => {
  it("they're kept with the reply when each fits the text as the agent's edits left it, and the agent hears so", async () => {
    const { t, replied } = await offered();
    expect(replied).toMatch(/^Replied on \[[0-9a-f]+\]\. The person can apply one of your 2 options with a click\./);
    const message = comments.threads("plan").find((x) => x.id === t.id)!.messages[1];
    expect(message.options).toEqual([shorter, formal]);
    expect(cards()).toEqual(["Waiting for you"]);
  });

  it("an option that doesn't fit is refused with the reason, and nothing is posted", async () => {
    const claude = connect();
    const t = personComments("Too wordy?", "We should hire two people");
    await claude.ok("take_document", { path: PLAN });
    const r = await claude.call("reply_to_comment", { path: PLAN, comment_id: idOf(t), text: "Pick one.", options: [shorter] });
    expect(r.isError).toBe(true);
    expect(r.text).toMatch(/^Option 1 \("Shorter"\): the text to find isn't in the document\..*Nothing was posted\.$/);
    expect(comments.threads("plan")[0].messages).toHaveLength(1);
    const four = await claude.call("reply_to_comment", { path: PLAN, comment_id: idOf(t), text: "Pick one.", options: [1, 2, 3, 4] });
    expect(four.text).toBe("At most 3 options on one reply. Nothing was posted.");
  });

  it("agents see the options offered, and the person's choice only while it's in the text (B3-R04)", async () => {
    const { claude, t } = await offered();
    const reply = comments.threads("plan")[0].messages[1];
    await claude.ok("finish_editing", { path: PLAN });
    // The person chooses Formal, as the window does it: the text changes, and the choice is kept with how to take it back out.
    const best = corillo.files.get(PLAN)!;
    const plan = planChoice(best, [shorter, formal], [], 1);
    if (!plan.ok) throw new Error(plan.why);
    corillo.write(corillo.docs[0], plan.after);
    comments.choose("plan", t.id, reply.id, person, 1, [], plan.undo);
    comments.reply("plan", t.id, person, "Good, but say staff.");
    const taken = await claude.ok("take_document", { path: PLAN });
    expect(taken).toContain('    Options: "Shorter", "Formal". The person chose "Formal".');
    await claude.ok("reply_to_comment", { path: PLAN, comment_id: idOf(t), text: "Said staff." });
    await claude.ok("finish_editing", { path: PLAN });
    // Undo took it back out: agents aren't told the person chose it.
    corillo.write(corillo.docs[0], best);
    const listed = await claude.ok("list_comments", { path: PLAN, include_answered: true });
    expect(listed).toContain('    Options: "Shorter", "Formal".');
    expect(listed).not.toContain("The person chose");
  });

  it("choosing doesn't change whose turn a comment is: after the person's reply it still waits for the agent (B3-R04)", async () => {
    const { claude, t } = await offered();
    await claude.ok("finish_editing", { path: PLAN });
    comments.reply("plan", t.id, person, "Let me think about it.");
    expect(cards()).toEqual(["For Claude, not sent yet"]);
    const reply = comments.threads("plan")[0].messages[1];
    const plan = planChoice(corillo.files.get(PLAN)!, [shorter, formal], [], 0);
    if (!plan.ok) throw new Error(plan.why);
    corillo.write(corillo.docs[0], plan.after);
    comments.choose("plan", t.id, reply.id, person, 0, [{ anchor: { quote: "Hire", prefix: "", suffix: " three", offset: 6 }, removed: "We should hire" }], plan.undo);
    expect(cards()).toEqual(["For Claude, not sent yet"]);
    expect(waitingForPerson(comments.threads("plan")[0])).toBe(false);
    // And the agent is still given it.
    expect(await claude.ok("take_document", { path: PLAN })).toContain("Let me think about it.");
  });

  it("the person's choice is recorded and announced, with the text it changed as theirs", async () => {
    const { t } = await offered();
    const announced: string[] = [];
    const watched = new CommentService(new DocumentStore(mkdtempSync(path.join(tmpdir(), "corillo-options-"))), (id) => announced.push(id));
    const added = watched.add("plan", person, "Too wordy?", null, null);
    watched.reply("plan", added.id, { kind: "agent", name: "Claude" }, "Pick one.", null, [shorter]);
    const reply = watched.threads("plan")[0].messages[1];
    const spans = [{ anchor: { quote: "Hire three this quarter.", prefix: "", suffix: "", offset: 6 }, removed: "We should hire three people this quarter." }];
    watched.choose("plan", added.id, reply.id, person, 0, spans, []);
    expect(announced.length).toBe(3);
    expect(watched.threads("plan")[0].change).toBeUndefined(); // kept beside an agent's change, never in its place
    expect(watched.threads("plan")[0].messages[1].choices?.[0]).toMatchObject({ option: 0, spans });
    expect(t).toBeTruthy();
  });
});

describe("the texts read for the pictures an option would add (the review of Batch 19, R19-9)", () => {
  it("aren't held after a reply posted outside a pass", async () => {
    const claude = connect();
    const t = personComments("Add a chart?", "The budget is tight.");
    forgetReadTexts();
    const chart = { label: "With a chart", edits: [{ find: "The budget is tight.", replace: "The budget is tight.\n\n![chart](https://a.test/chart.png)" }] };
    await claude.ok("reply_to_comment", { path: PLAN, comment_id: idOf(t), text: "One option.", options: [chart] });
    expect(comments.threads("plan").find((x) => x.id === t.id)!.messages[1].options).toEqual([chart]);
    expect(readTextsHeld()).toBe(0);
  });
});
