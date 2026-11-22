// A document whose file Corillo can no longer read as text (another app saved
// it as UTF-16, say), at the agents' door (the review of Batch 21, G21-5 and
// its Suspected 1; roadmap Batch 22, item 2). The agent is told what is wrong,
// in file-checks.ts's words, not "hasn't changed since your last read" and
// then "read it again" round and round; a take that fails gives the turn
// back, so the document isn't left held. A file that is gone keeps being read
// as the text Corillo last knew, as before.
//
// Runs Corillo's real link between the agents and the files (agents/host.ts)
// on a real file, with the window stood in for, as agent-write-refused.test.ts does.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import * as fs from "node:fs";
import { tmpdir } from "node:os";
import * as path from "node:path";

const heard = vi.hoisted(() => new Map<string, (...args: unknown[]) => void>());
vi.mock("electron", () => ({
  app: { getPath: () => tmpdir(), on: () => {} },
  BrowserWindow: { getAllWindows: () => [] },
  clipboard: { writeText: () => {} },
  ipcMain: { handle: () => {}, on: (channel: string, fn: (...args: unknown[]) => void) => heard.set(channel, fn), removeHandler: () => {} },
}));

const { setUpAgents } = await import("../../src/main/agents/host");
const { noHooks } = await import("../../src/main/agents/agent-service");
const { readText, writeDocument } = await import("../../src/main/files");
const { CommentService } = await import("../../src/main/comment-service");
const { DocumentStore } = await import("../../src/main/store");

const TEXT = "# Plan\n\nThe offer is 41,500 dollars.\n\nNext steps follow.\n";
const UTF16 = Buffer.from(String.fromCharCode(0xfeff) + "Plan, rewritten elsewhere.\n", "utf16le");
const WORDS = "Corillo can only open text files saved as UTF-8.";

let folder: string;
let file: string;
const closing: (() => void)[] = [];

beforeEach(() => {
  folder = fs.mkdtempSync(path.join(tmpdir(), "corillo-unreadable-"));
  file = path.join(folder, "plan.md");
  fs.writeFileSync(file, TEXT);
});

afterEach(() => {
  for (const close of closing.splice(0)) close();
  fs.rmSync(folder, { recursive: true, force: true });
});

/** Corillo's agents with plan.md open, and a way to connect agents to it. */
function corilloWithPlan(hooks?: Partial<import("../../src/main/agents/shapes").AgentHooks>) {
  type Doc = { id: string; storeId: string; filePath: string; diskText: string; missing?: boolean };
  const docs = new Map<string, Doc>();
  const doc: Doc = { id: "tab-1", storeId: "plan", filePath: file, diskText: TEXT };
  docs.set(doc.id, doc);
  const comments = new CommentService(new DocumentStore(path.join(folder, "data")), () => {});
  const agents = setUpAgents(
    {
      docs: docs as never,
      openDocument: () => doc as never,
      readText,
      writeFileAtomic: writeDocument,
      created: () => {},
      saved: () => {},
      picturesWait: () => {},
      send: (channel: string, ...args: unknown[]) => {
        if (channel === "agent:flush") heard.get("agent:flushed")?.({}, args[0], "saved");
      },
    },
    comments,
    hooks ? ({ ...noHooks, ...hooks } as never) : undefined,
  );
  closing.push(() => agents.close());
  const agent = (name: string) => {
    const { sessionId } = agents.service.connect({ name });
    return (tool: string, args: Record<string, unknown> = {}) => agents.service.call(sessionId, tool, { path: file, ...args });
  };
  return { agents, agent, doc, comments };
}

describe("a document whose file Corillo can no longer read", () => {
  it("an agent holding it is told what is wrong when it reads or edits, not that nothing changed", async () => {
    const { agent } = corilloWithPlan();
    const claude = agent("claude-code");
    expect((await claude("take_document")).isError).toBe(false);
    fs.writeFileSync(file, UTF16); // another app saves it in a form Corillo can't read
    const read = await claude("read_document");
    const edit = await claude("edit_document", { edits: [{ find: "Next steps follow.", replace: "Next steps follow soon." }] });
    const again = await claude("read_document");
    for (const told of [read, edit, again]) {
      expect(told.isError).toBe(true);
      expect(told.text).toContain(WORDS);
      // Which file, and what to do next (R22-13).
      expect(told.text).toContain("Corillo can't read plan.md as it is now.");
      expect(told.text).toContain("Ask the person to sort it out, then try again.");
      expect(told.text).not.toContain("hasn't changed since your last read");
      expect(told.text).not.toContain("Read it again and redo your edit");
    }
    // Nothing was written over the other app's file.
    expect(fs.readFileSync(file).equals(UTF16)).toBe(true);
    // It can still hand the document back.
    expect((await claude("finish_editing")).isError).toBe(false);
  });

  it("an agent reading it without taking it is told too, never given the text Corillo last knew", async () => {
    const { agent } = corilloWithPlan();
    const claude = agent("claude-code");
    expect((await claude("read_document")).isError).toBe(false);
    fs.writeFileSync(file, UTF16);
    const read = await claude("read_document");
    expect(read).toEqual({ text: expect.stringContaining(WORDS), isError: true });
    expect(read.text).not.toContain("41,500");
  });

  it("a take that fails on it gives the turn back: the document isn't left held", async () => {
    const { agents, agent } = corilloWithPlan();
    const claude = agent("claude-code");
    expect((await claude("read_document")).isError).toBe(false);
    fs.writeFileSync(file, UTF16);
    const took = await claude("take_document");
    expect(took).toEqual({ text: expect.stringContaining(WORDS), isError: true });
    expect(agents.service.editingAgent("plan")).toBeNull();
    // Once the file is text again, another agent takes it at once.
    fs.writeFileSync(file, TEXT);
    const codex = agent("codex");
    expect((await codex("take_document")).isError).toBe(false);
    expect(agents.service.editingAgent("plan")).not.toBeNull();
  });

  it("the control: a file that is gone is still read as the text Corillo last knew", async () => {
    const { agent } = corilloWithPlan();
    const claude = agent("claude-code");
    expect((await claude("take_document")).isError).toBe(false);
    fs.rmSync(file);
    const read = await claude("read_document", { whole: true });
    expect(read.isError).toBe(false);
    expect(read.text).toContain("41,500");
  });
});

describe("an agent's action that went through on a file Corillo can no longer read (R22-3)", () => {
  const person = { kind: "person" } as const;

  it("a reply is posted once, the agent is told so, and the person's new comment is shown to it", async () => {
    const { agent, comments } = corilloWithPlan();
    const claude = agent("claude-code");
    const asked = comments.add("plan", person, "Is the offer right?", null, null);
    expect((await claude("take_document")).isError).toBe(false);
    fs.writeFileSync(file, UTF16); // another app saves it in a form Corillo can't read
    comments.add("plan", person, "Also shorten the steps.", null, null);
    const replied = await claude("reply_to_comment", { comment_id: asked.id, text: "Yes, it is." });
    expect(replied.isError).toBe(false);
    expect(replied.text).toContain("Replied on");
    expect(replied.text).toContain("Also shorten the steps.");
    const thread = comments.threads("plan").find((t) => t.id === asked.id)!;
    expect(thread.messages.filter((m) => m.author.kind === "agent")).toHaveLength(1);
  });

  it("a new comment is added once, and the agent is told so", async () => {
    const { agent, comments } = corilloWithPlan();
    const claude = agent("claude-code");
    expect((await claude("take_document")).isError).toBe(false);
    fs.writeFileSync(file, UTF16);
    comments.add("plan", person, "Also shorten the steps.", null, null);
    const added = await claude("add_comment", { text: "I left the numbers as they are." });
    expect(added.isError).toBe(false);
    expect(added.text).toContain("Also shorten the steps.");
    expect(comments.threads("plan").filter((t) => t.messages[0].author.kind === "agent")).toHaveLength(1);
  });

  it("list_comments lists them, and finish_editing names the comments still waiting, not the file's problem", async () => {
    const { agent, comments } = corilloWithPlan();
    const claude = agent("claude-code");
    expect((await claude("take_document")).isError).toBe(false);
    fs.writeFileSync(file, UTF16);
    comments.add("plan", person, "Also shorten the steps.", null, null);
    const listed = await claude("list_comments");
    expect(listed.isError).toBe(false);
    expect(listed.text).toContain("Also shorten the steps.");
    comments.add("plan", person, "And the title.", null, null);
    const finished = await claude("finish_editing");
    expect(finished.text).toContain("Not finished");
    expect(finished.text).toContain("And the title.");
    expect(finished.text).not.toContain(WORDS);
  });
});

describe("an open document whose text starts like a PDF or a picture (R22-4)", () => {
  for (const start of ["%PDF-1.7 is the version line", "GIF89a was the format we chose"]) {
    it(`is read as its text by an agent: ${start.slice(0, 6)}`, async () => {
      const { agent } = corilloWithPlan();
      const claude = agent("claude-code");
      expect((await claude("read_document")).isError).toBe(false);
      fs.writeFileSync(file, `${start}\n\n${TEXT}`);
      const read = await claude("read_document", { whole: true });
      expect(read.isError).toBe(false);
      expect(read.text).toContain(start);
      expect((await claude("take_document")).isError).toBe(false);
    });
  }
});

describe("a take whose file turns unreadable while its pass begins (R22-5)", () => {
  it("never errors with the document held: the take reads the file once", async () => {
    const { agents, agent } = corilloWithPlan({
      beginPass: async () => {
        fs.writeFileSync(file, UTF16);
      },
    });
    const claude = agent("claude-code");
    const took = await claude("take_document");
    if (took.isError) expect(agents.service.editingAgent("plan")).toBeNull();
    else expect(took.text).toContain("41,500");
  });
});
