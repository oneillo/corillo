// Agents keep to what they were asked (roadmap Batch 9, item 11). Orlando: "I'd
// rather that we have good system prompts in our MCP to have agents only focus
// on parts of the text that are relevant to comments/feedback they have been
// asked to address." It replaces the outline's Done tick, which kept agents out
// of ticked sections. Said where an agent reads it as it works: the
// instructions, the take's answer, and an edit that no comment asked for.
//
// And where what an agent did for a request from the chat is reviewed (item 5):
// History, under the request, not a card in the Comments panel.
import { beforeEach, describe, expect, it } from "vitest";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import * as path from "node:path";
import { AgentService, anchorForQuote, type AgentDoc, type AgentHooks, type AgentHost, type AgentInfo } from "../../src/main/agents/agent-service";
import { AgentError } from "../../src/main/agents/shapes";
import { CommentService } from "../../src/main/comment-service";
import { DocumentStore } from "../../src/main/store";
import { VersionHistory } from "../../src/main/version-store";
import { INSTRUCTIONS, TOOLS } from "../../src/mcp/tools";

const PLAN = "/docs/plan.md";
const PLAN_TEXT = "# Plan\n\nWe should hire two people this quarter.\n\n## Budget\n\nThe budget is tight.\n";

/** Stands in for Corillo's window and the files on disk. */
class FakeCorillo implements AgentHost {
  files = new Map<string, string>([[PLAN, PLAN_TEXT]]);
  docs: AgentDoc[] = [];
  picturesWait(): void {}
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
  announce(_storeId: string, _agents: AgentInfo[]) {}
  backToYou() {}
  kindOf(p: string) {
    return this.files.has(p) ? ("file" as const) : p === "/docs" ? ("folder" as const) : null;
  }
  async exportDocument(): Promise<{ outputPath: string; notes: string[] }> {
    throw new AgentError("Not here.");
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
  const data = mkdtempSync(path.join(tmpdir(), "corillo-keep-to-"));
  corillo = new FakeCorillo(new VersionHistory(data));
  comments = new CommentService(new DocumentStore(data), () => {});
  service = new AgentService(corillo, comments, hooks, { waitMs: 0 });
});

function connect() {
  const { sessionId } = service.connect({ name: "claude-code" });
  return async (tool: string, args: Record<string, unknown> = {}) => {
    const r = await service.call(sessionId, tool, args);
    if (r.isError) throw new Error(`${tool} failed: ${r.text}`);
    return r.text;
  };
}

function comment(body: string, quote: string) {
  return comments.add("plan", { kind: "person" }, body, anchorForQuote(PLAN_TEXT, quote), null);
}

const times = (text: string, part: string) => text.split(part).length - 1;
const LEAVE = "and leave the rest of the document as it is.";
const ELSEWHERE = "If a change elsewhere seems needed, suggest it in";

describe("what the instructions tell every agent", () => {
  it("to change only what the comments and the request are about, and to suggest anything else rather than make it, said once", () => {
    expect(INSTRUCTIONS).toContain("- Work only on what you were asked: the comments addressed to you, and the person's request from the chat.");
    expect(INSTRUCTIONS).toContain(`Change only the passages they're about ${LEAVE}`);
    expect(INSTRUCTIONS).toContain(`${ELSEWHERE} a reply or your note; don't make it.`);
    expect(times(INSTRUCTIONS, "leave the rest of the document as it is")).toBe(1);
    expect(times(INSTRUCTIONS, "addressed to you")).toBe(2); // step 3, and this rule; the old "Work only on comments addressed to you" is folded in
    expect(times(INSTRUCTIONS, "includes the person's")).toBe(1); // the latest text with their edits, said once
    expect(INSTRUCTIONS.length).toBeLessThan(4096);
  });

  it("that edits tied to no comment are for a request from the chat, and the person reviews them in History, not on a card", () => {
    expect(INSTRUCTIONS).toContain("Leave comment_ids out only for a change the person asked for in the chat.");
    expect(INSTRUCTIONS).toContain("Give their request, in their words, as request on take_document: they review the changes made for it in History.");
    const props = (name: string) => TOOLS.find((t) => t.name === name)!.inputSchema.properties as Record<string, { description: string }>;
    for (const name of ["take_document", "finish_editing"]) {
      expect(props(name).request.description).toContain("It's kept with this pass in History, where the person reviews your edits tied to no comment, under it.");
    }
    for (const name of ["edit_document", "replace_document"]) {
      expect(props(name).comment_ids.description).toContain("Leave it out only for a change the person asked for in the chat.");
    }
    // The note is for a change suggested, never for one made unasked.
    const note = props("finish_editing").note.description;
    expect(note).not.toContain("a change nobody asked for");
    expect(note).toContain("a change you'd suggest outside what you were asked");
    // No card in the Comments panel for a request or for other changes.
    const everything = [INSTRUCTIONS, ...TOOLS.flatMap((t) => [t.description, JSON.stringify(t.inputSchema)])].join(" ");
    expect(everything).not.toMatch(/other changes|asked in chat|\bcards?\b/i);
  });
});

describe("what taking a document tells the agent", () => {
  it("with comments: change only the passages they're about, once", async () => {
    const call = connect();
    comment("Make it three.", "two people");
    const taken = await call("take_document", { path: PLAN });
    expect(taken).toContain(
      `Address all of them in this pass: make your changes, then reply on each, then call finish_editing.\nChange only the passages these comments are about, ${LEAVE} ${ELSEWHERE} a reply or your note; don't make it.\nWith each edit, give comment_ids: the ids of the comments it answers. The person reviews every change with its comment.`,
    );
    expect(times(taken, LEAVE)).toBe(1);
  });

  it("with comments and a request: the passages both are about, and edits for the request reviewed in History", async () => {
    const call = connect();
    comment("Make it three.", "two people");
    const taken = await call("take_document", { path: PLAN, request: "Make the budget line punchier." });
    expect(taken).toContain(`Change only the passages these comments and the request are about, ${LEAVE}`);
    expect(taken).toContain("Edits you don't tie to a comment are kept with the request you gave, and the person reviews them in History.");
    expect(times(taken, LEAVE)).toBe(1);
  });

  it("with only a request: the passages it's about, anything else in the note, the changes reviewed in History", async () => {
    const call = connect();
    const taken = await call("take_document", { path: PLAN, request: "Make the budget line punchier." });
    expect(taken).toContain(
      `No comments on plan.md are waiting for you. Change only the passages the request is about, ${LEAVE} ${ELSEWHERE} your note; don't make it. Your edits are kept with the request you gave, and the person reviews them in History.`,
    );
    // Taken again in the same pass, it still knows the request it gave.
    expect(await call("take_document", { path: PLAN })).toContain("Change only the passages the request is about");
  });

  it("with nothing asked yet: give the chat's request, and change only what it's about", async () => {
    const call = connect();
    expect(await call("take_document", { path: PLAN })).toContain(
      "No comments on plan.md are waiting for you. If the person asked for changes in the chat, give their request with finish_editing, and change only the passages it's about.",
    );
  });
});

describe("what an edit no comment asked for tells the agent", () => {
  it("to tie it if it answers one, to give the request if the person asked in the chat, else to put it back and suggest it instead, once a pass", async () => {
    const call = connect();
    const hire = comment("Make it three.", "two people");
    await call("take_document", { path: PLAN });
    const untied = await call("edit_document", { path: PLAN, edits: [{ find: "tight", replace: "very tight" }] });
    // The chat's route comes before the revert (review of Batch 9, B9-01): the request may be given at the end.
    expect(untied).toContain(
      "\n\nThis change isn't tied to a comment. If it answers one, say so with comment_ids next time, so the person can review each change with its comment. If the person asked for it in the chat, give their request with finish_editing. If nobody asked for it, put it back as it was and suggest it in a reply or your note instead.",
    );
    expect(untied.indexOf("give their request with finish_editing")).toBeLessThan(untied.indexOf("put it back"));
    expect(await call("edit_document", { path: PLAN, edits: [{ find: "very tight", replace: "tight" }] })).not.toContain("put it back");
    // An edit tied to its comment is told nothing of the kind.
    const tied = await call("edit_document", { path: PLAN, edits: [{ find: "two", replace: "three" }], comment_ids: [hire.id.slice(0, 8)] });
    expect(tied).not.toContain("put it back");
  });

  // The usual round (review of Batch 9, B9-01): the agent answered the person's comment and they left it open, then
  // they asked for a change in the chat. The take said to give their request at the end, so the edit is never undone.
  it("with only comments already answered, left open: give the request, never put it back", async () => {
    const call = connect();
    const hire = comment("Make it three.", "two people");
    await call("take_document", { path: PLAN });
    await call("edit_document", { path: PLAN, edits: [{ find: "two", replace: "three" }], comment_ids: [hire.id.slice(0, 8)] });
    await call("reply_to_comment", { path: PLAN, comment_id: hire.id.slice(0, 8), text: "Now three." });
    await call("finish_editing", { path: PLAN });
    expect(comments.threads("plan").find((t) => t.id === hire.id)?.status).toBe("open");

    const taken = await call("take_document", { path: PLAN });
    expect(taken).toContain("No comments on plan.md are waiting for you. If the person asked for changes in the chat, give their request with finish_editing");
    const asked = await call("edit_document", { path: PLAN, edits: [{ find: "tight", replace: "very tight" }] });
    expect(asked).not.toContain("put it back");
    expect(asked).toContain("\n\nIf the person asked for this in the chat, give their request with finish_editing, so it's kept with this version.");
  });
});
