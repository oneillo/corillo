// How Corillo's connector speaks the Model Context Protocol, and what agents read.
import { describe, expect, it } from "vitest";
import { handleMessage, PROTOCOL_VERSIONS, type ClientInfo } from "../../src/mcp/protocol";
import { INSTRUCTIONS, TOOLS } from "../../src/mcp/tools";
import { defaultDataFolder, socketPathFor } from "../../src/mcp/socket-path";
import { START_FOLDER, startEnv } from "../../src/mcp/start-env";

function fakeHost() {
  const seen: { client?: ClientInfo; calls: [string, Record<string, unknown>][]; ids: unknown[]; cancelled: unknown[]; tokens: unknown[] } = {
    calls: [],
    ids: [],
    cancelled: [],
    tokens: [],
  };
  return {
    seen,
    host: {
      setClient: (info: ClientInfo) => {
        seen.client = info;
      },
      callTool: async (name: string, args: Record<string, unknown>, id?: string | number, progressToken?: string | number) => {
        seen.calls.push([name, args]);
        seen.ids.push(id);
        seen.tokens.push(progressToken);
        return { text: `ran ${name}`, isError: name === "finish_editing" };
      },
      cancelled: (id: string | number) => {
        seen.cancelled.push(id);
      },
    },
  };
}

const request = (id: number, method: string, params?: unknown) => ({ jsonrpc: "2.0", id, method, params });

describe("speaking MCP", () => {
  it("starting a session: says it's Corillo, offers tools, gives the instructions, and learns the client's name", async () => {
    const { host, seen } = fakeHost();
    const answer = (await handleMessage(
      request(1, "initialize", { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "claude-code", version: "2" } }),
      host,
    )) as { result: Record<string, unknown> };
    expect(answer.result).toMatchObject({
      protocolVersion: "2025-06-18",
      capabilities: { tools: {} },
      serverInfo: { name: "corillo" },
      instructions: INSTRUCTIONS,
    });
    expect(seen.client).toEqual({ name: "claude-code", version: "2" });
  });

  it("a client asking for a protocol version Corillo doesn't know gets the newest one Corillo speaks", async () => {
    const { host } = fakeHost();
    const answer = (await handleMessage(request(1, "initialize", { protocolVersion: "2099-01-01" }), host)) as {
      result: { protocolVersion: string };
    };
    expect(answer.result.protocolVersion).toBe(PROTOCOL_VERSIONS[0]);
  });

  it("lists every tool with a description and an input schema", async () => {
    const { host } = fakeHost();
    const answer = (await handleMessage(request(2, "tools/list"), host)) as { result: { tools: typeof TOOLS } };
    expect(answer.result.tools.map((t) => t.name)).toEqual([
      "introduce",
      "list_documents",
      "open_document",
      "create_document",
      "read_document",
      "list_comments",
      "take_document",
      "edit_document",
      "replace_document",
      "reply_to_comment",
      "add_comment",
      "finish_editing",
      "wait_for_review",
      "list_versions",
      "read_version",
      "show_changes",
      "export_document",
    ]);
    for (const t of answer.result.tools) {
      expect(t.description.length).toBeGreaterThan(40);
      expect(t.inputSchema.type).toBe("object");
    }
  });

  it("passes tool calls on, with errors marked as errors", async () => {
    const { host, seen } = fakeHost();
    const ok = (await handleMessage(request(3, "tools/call", { name: "read_document", arguments: { path: "/a.md" } }), host)) as {
      result: unknown;
    };
    expect(ok.result).toEqual({ content: [{ type: "text", text: "ran read_document" }], isError: false });
    expect(seen.calls).toEqual([["read_document", { path: "/a.md" }]]);
    const failed = (await handleMessage(request(4, "tools/call", { name: "finish_editing", arguments: {} }), host)) as {
      result: { isError: boolean };
    };
    expect(failed.result.isError).toBe(true);
  });

  it("an unknown tool or method is a protocol error; notifications get no answer; ping is answered", async () => {
    const { host } = fakeHost();
    expect(await handleMessage(request(5, "tools/call", { name: "delete_everything" }), host)).toMatchObject({
      error: { code: -32602 },
    });
    expect(await handleMessage(request(6, "resources/list"), host)).toMatchObject({ error: { code: -32601 } });
    expect(await handleMessage({ jsonrpc: "2.0", method: "notifications/initialized" }, host)).toBeNull();
    expect(await handleMessage(request(7, "ping"), host)).toEqual({ jsonrpc: "2.0", id: 7, result: {} });
    expect(await handleMessage({ hello: true }, host)).toMatchObject({ error: { code: -32600 } });
  });

  // Send to Claude (roadmap Batch 2, item 1): a held wait is kept alive with progress messages on the call's own token.
  it("passes on the progress token a call carries, so a long wait can say it's still waiting", async () => {
    const { host, seen } = fakeHost();
    await handleMessage(request(9, "tools/call", { name: "wait_for_review", arguments: {}, _meta: { progressToken: 9 } }), host);
    await handleMessage(request(10, "tools/call", { name: "wait_for_review", arguments: {}, _meta: { progressToken: "w-10" } }), host);
    await handleMessage(request(11, "tools/call", { name: "wait_for_review", arguments: {} }), host);
    await handleMessage(request(12, "tools/call", { name: "wait_for_review", arguments: {}, _meta: { progressToken: { no: 1 } } }), host);
    expect(seen.tokens).toEqual([9, "w-10", undefined, undefined]);
  });

  it("a cancel from the agent tool names the call it's for, and gets no answer", async () => {
    const { host, seen } = fakeHost();
    await handleMessage(request(8, "tools/call", { name: "take_document", arguments: { path: "/a.md" } }), host);
    expect(seen.ids).toEqual([8]);
    const cancel = (requestId: unknown) => ({ jsonrpc: "2.0", method: "notifications/cancelled", params: { requestId, reason: "Interrupted" } });
    expect(await handleMessage(cancel(8), host)).toBeNull();
    expect(await handleMessage(cancel("call-9"), host)).toBeNull();
    expect(await handleMessage(cancel({ not: "an id" }), host)).toBeNull();
    expect(seen.cancelled).toEqual([8, "call-9"]);
  });

  it("answers a batch of messages together", async () => {
    const { host } = fakeHost();
    const answers = await handleMessage([request(1, "ping"), { jsonrpc: "2.0", method: "notifications/initialized" }, request(2, "ping")], host);
    expect(answers).toEqual([
      { jsonrpc: "2.0", id: 1, result: {} },
      { jsonrpc: "2.0", id: 2, result: {} },
    ]);
  });

  // R-AG-12: the connector decided on the whole message, so a call cancelled in a batch was still answered.
  it("never answers a call the agent tool cancelled, alone or in a batch", async () => {
    const { host } = fakeHost();
    const cancelledHost = { ...host, callTool: async (name: string) => ({ text: "Cancelled.", isError: true, cancelled: name === "take_document" }) };
    const take = request(3, "tools/call", { name: "take_document", arguments: { path: "/a.md" } });
    const list = request(4, "tools/call", { name: "list_documents", arguments: {} });
    expect(await handleMessage(take, cancelledHost)).toBeNull();
    expect(await handleMessage([take, list], cancelledHost)).toEqual([{ jsonrpc: "2.0", id: 4, result: { content: [{ type: "text", text: "Cancelled." }], isError: true } }]);
  });
});

describe("what agents are told", () => {
  it("the instructions teach the review workflow and the rules", () => {
    for (const phrase of [
      "Don't look for comments until they tell you",
      "take_document",
      "Address all those comments in this one pass",
      "reply_to_comment, saying briefly what you changed",
      "finish_editing",
      "read it with read_document and change it only with these tools, never with your own file tools",
      "A comment that asks a question gets its answer in your reply",
      "Once your edits have gone in and read well, reply on each comment",
      "If the person takes a document back while you're editing, stop",
      "Only the person resolves comments",
      "Don't reply to other agents",
      "go to the person",
      "introduce",
      "mermaid",
      "images",
      // Each blank line is an empty line on the page and in Word (Orlando, 2026-11-09).
      "exactly one between paragraphs",
    ]) {
      expect(INSTRUCTIONS).toContain(phrase);
    }
  });

  // Roadmap Batch 1, item 3 (A-9): Claude Code defers MCP tools, so every round began with a turn spent loading them.
  it("the core tools of a round load up front in Claude Code, so a round needs no turn to look them up", async () => {
    const { host } = fakeHost();
    const answer = (await handleMessage(request(2, "tools/list"), host)) as { result: { tools: { name: string; _meta?: Record<string, unknown> }[] } };
    const upfront = answer.result.tools.filter((t) => t._meta?.["anthropic/alwaysLoad"] === true).map((t) => t.name);
    // read_document too: a long document's take tells the agent to read parts with it, and the real trial
    // (long) spent a whole turn looking it up when it wasn't loaded.
    // wait_for_review too (Batch 2, item 1): it's called after every open and every finish.
    expect(upfront).toEqual(["list_documents", "read_document", "take_document", "edit_document", "reply_to_comment", "finish_editing", "wait_for_review"]);
  });

  // Agent quick win 1: Claude Code keeps only the first 4,096 characters of server instructions and of a description loaded up front.
  it("the instructions, and each tool's description, stay under the length Claude Code cuts at", () => {
    expect(INSTRUCTIONS.length).toBeLessThan(4096);
    for (const t of TOOLS) {
      const upfront = (t as { _meta?: Record<string, unknown> })._meta?.["anthropic/alwaysLoad"] === true;
      expect(t.description.length, t.name).toBeLessThan(upfront ? 4096 : 16_384);
    }
  });

  // Roadmap Batch 2, item 1: the agent waits in Corillo for the review, and a wait cut short ends quietly (the trial's two sentences).
  it("agents put long things in Corillo and wait there for the review; a wait that ends without one is said once and not called again", () => {
    expect(INSTRUCTIONS).toContain(
      "When you have something long for the person to read (a proposal, a plan, findings), put it in Corillo, not the chat, and wait there for their review.",
    );
    expect(INSTRUCTIONS).toContain("wait_for_review");
    const wait = TOOLS.find((t) => t.name === "wait_for_review")!;
    expect(wait.description).toContain("Once it has started, end your turn and do nothing else");
    expect(wait.description).toContain("If it ends without a review, say so once in the chat and don't call it again");
    expect(wait.description).toContain("at no cost");
    // The real trial (proposal, 2026-11-10): when Claude Code moved the wait to the background it asked the agent
    // what it was doing, and the agent summed up its proposal, then its changes, in a paragraph and a list.
    expect(wait.description).toContain(
      "When it moves to the background, say in one line that you're waiting for their review in Corillo; don't sum up the document or your changes, they're there.",
    );
    expect(wait.inputSchema.required).toEqual([]);
    expect(Object.keys(wait.inputSchema.properties)).toEqual(["paths"]);
  });

  // Roadmap Batch 2, item 3 (A-4): a cover note, only when the replies don't say it all.
  it("finish_editing takes a note for what the person should know or decide that isn't on one comment, left out when the replies say it all", () => {
    const finish = TOOLS.find((t) => t.name === "finish_editing")!;
    expect(Object.keys(finish.inputSchema.properties)).toEqual(["path", "request", "note"]);
    expect(finish.inputSchema.required).toEqual(["path"]);
    const note = (finish.inputSchema.properties.note as { description: string }).description;
    expect(note).toContain("doesn't belong on one comment");
    expect(note).toContain("Leave it out when your replies say it all");
    expect(INSTRUCTIONS).toContain("with a note only for what they should know or decide that isn't on one comment");
  });

  it("agents keep their chat message to a line, since the person reads their replies in Corillo", () => {
    expect(INSTRUCTIONS).toContain("They read your replies in Corillo, so in the chat a line is enough");
    const describe = (name: string) => TOOLS.find((t) => t.name === name)!.description;
    // Agent quick win 4: two rounds in five went looking for the file themselves first.
    expect(describe("list_documents")).toContain("which one is in front");
    expect(describe("list_documents")).toContain("before looking for the file yourself");
    expect(describe("take_document")).toContain("its name is enough");
  });

  it("names no particular agent vendor, so any agent tool can follow it", () => {
    const everything = INSTRUCTIONS + TOOLS.map((t) => t.description).join(" ");
    expect(everything).not.toMatch(/\b(claude|anthropic|openai|codex|gpt|gemini|cursor|copilot)\b/i);
  });

  it("tools say honestly what they can do: exporting can write over a file and run the person's own export script", () => {
    const hints = (name: string) => TOOLS.find((t) => t.name === name)!.annotations;
    expect(hints("export_document")).toEqual({ readOnlyHint: false, destructiveHint: true, idempotentHint: false, openWorldHint: true });
    expect(TOOLS.find((t) => t.name === "export_document")!.description).toContain("export script");
    for (const name of ["edit_document", "replace_document"]) expect(hints(name)!.destructiveHint).toBe(true);
    for (const name of ["list_documents", "read_document", "list_comments", "list_versions", "read_version", "show_changes"]) {
      expect(hints(name)!.readOnlyHint).toBe(true);
    }
  });

  it("every comment tool says only the person resolves comments", () => {
    for (const name of ["list_comments", "reply_to_comment", "add_comment"]) {
      expect(TOOLS.find((t) => t.name === name)!.description).toMatch(/only the person resolves/i);
    }
  });
});

describe("where Corillo listens", () => {
  it("a socket inside Corillo's data folder, which tests can point elsewhere", () => {
    expect(defaultDataFolder("darwin", {})).toMatch(/Library\/Application Support\/Corillo$/);
    expect(defaultDataFolder("darwin", { CORILLO_USER_DATA: "/tmp/x" })).toBe("/tmp/x");
    expect(socketPathFor("/Users/ana/Library/Application Support/Corillo", "darwin")).toBe(
      "/Users/ana/Library/Application Support/Corillo/sockets/agents.sock",
    );
  });

  it("too long a path for macOS falls back to a short one, different for each data folder", () => {
    const deep = "/Users/ana/" + "a-very-long-folder-name/".repeat(5);
    const p = socketPathFor(deep, "darwin");
    expect(Buffer.byteLength(p)).toBeLessThanOrEqual(103);
    expect(p).toMatch(/^\/tmp\/corillo-[^/]+\/[0-9a-f]{16}\.sock$/);
    expect(socketPathFor(deep + "other/", "darwin")).not.toBe(p);
  });
});

describe("starting Corillo for an agent (AG-8)", () => {
  it("passes on only what any app on the Mac starts with, and Corillo's own settings", () => {
    const tool = {
      HOME: "/Users/ana",
      PATH: "/opt/homebrew/bin:/usr/bin:/bin",
      TMPDIR: "/var/folders/xy/T/",
      LANG: "es_PR.UTF-8",
      LC_ALL: "es_PR.UTF-8",
      USER: "ana",
      LOGNAME: "ana",
      SHELL: "/bin/zsh",
      __CF_USER_TEXT_ENCODING: "0x1F5:0x0:0x0",
      CORILLO_USER_DATA: "/tmp/corillo-data-1",
      CORILLO_HIDDEN: "1",
      // The agent tool's own, not Corillo's.
      ANTHROPIC_API_KEY: "sk-ant-secret",
      OPENAI_API_KEY: "sk-secret",
      GITHUB_TOKEN: "ghp_secret",
      NODE_OPTIONS: "--require /tmp/hook.cjs",
      ELECTRON_RUN_AS_NODE: "1",
      PWD: "/Users/ana/projects/site",
      CLAUDECODE: "1",
      npm_config_prefix: "/opt/homebrew",
    };
    expect(startEnv(tool)).toEqual({
      HOME: "/Users/ana",
      PATH: "/opt/homebrew/bin:/usr/bin:/bin",
      TMPDIR: "/var/folders/xy/T/",
      LANG: "es_PR.UTF-8",
      LC_ALL: "es_PR.UTF-8",
      USER: "ana",
      LOGNAME: "ana",
      SHELL: "/bin/zsh",
      __CF_USER_TEXT_ENCODING: "0x1F5:0x0:0x0",
      CORILLO_USER_DATA: "/tmp/corillo-data-1",
      CORILLO_HIDDEN: "1",
    });
    expect(START_FOLDER).toBe("/");
  });

  // R-TE-10: Chromium on the Mac keeps its temporary files where this says, not TMPDIR; a test run sets both to its own folder.
  it("passes on where Chromium keeps its temporary files, with the temporary folder", () => {
    const tool = { HOME: "/Users/ana", TMPDIR: "/runs/r1/tmp/", MAC_CHROMIUM_TMPDIR: "/runs/r1/tmp/", ANTHROPIC_API_KEY: "sk-ant-secret" };
    expect(startEnv(tool)).toEqual({ HOME: "/Users/ana", TMPDIR: "/runs/r1/tmp/", MAC_CHROMIUM_TMPDIR: "/runs/r1/tmp/" });
  });
});
