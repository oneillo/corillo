// Batch 21, G21-6: the connector gave no answer, and ended, when the folder
// the agent tool started it in was gone by its first call with a path.
// G21-7: Corillo's end of the socket threw, with no answer, on a hello whose
// client name isn't text.
import { afterAll, afterEach, describe, expect, it } from "vitest";
import { spawn, type ChildProcess } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import * as net from "node:net";
import * as path from "node:path";
import { build } from "esbuild";
import { onLines } from "../../src/mcp/lines";
import { listenForAgents } from "../../src/main/agents/socket-server";
import { AgentService, type AgentHost } from "../../src/main/agents/agent-service";
import { CommentService } from "../../src/main/comment-service";
import { DocumentStore } from "../../src/main/store";
import { throwawayStart } from "../e2e/helpers";

const ROOT = path.join(import.meta.dirname, "..", "..");
const made: string[] = [];
afterAll(() => {
  for (const dir of made) rmSync(dir, { recursive: true, force: true });
});

describe("the connector, started in a folder that is then removed", () => {
  let proc: ChildProcess | null = null;
  let app: net.Server | null = null;
  afterEach(() => {
    proc?.kill();
    proc = null;
    app?.close();
    app = null;
  });

  it("still answers a call that gives a full path", async () => {
    const dir = mkdtempSync(path.join(tmpdir(), "corillo-connector-"));
    made.push(dir);
    const connector = path.join(dir, "mcp.cjs");
    // Built the way scripts/build.mjs builds dist/mcp.cjs.
    await build({ entryPoints: [path.join(ROOT, "src", "mcp", "server.ts")], outfile: connector, bundle: true, platform: "node", format: "cjs", target: "node22", logLevel: "silent" });

    // A stand-in for Corillo at the connector's socket, which answers each request.
    const data = path.join(dir, "data");
    mkdirSync(path.join(data, "sockets"), { recursive: true, mode: 0o700 });
    const calls: unknown[] = [];
    app = net.createServer((socket) =>
      onLines(socket, (line) => {
        const request = JSON.parse(line) as { id: number; method: string; params: Record<string, unknown> };
        if (request.method === "call") calls.push(request.params);
        socket.write(JSON.stringify({ id: request.id, result: request.method === "hello" ? { ok: true } : { text: "The text." } }) + "\n");
      }),
    );
    await new Promise<void>((r) => app!.listen(path.join(data, "sockets", "agents.sock"), r));

    // The agent tool's folder: a worktree or a temporary folder, say.
    const folder = path.join(dir, "worktree");
    mkdirSync(folder);
    // Hidden, on its throwaway data folder, with a stand-in home: never his (Batch 24, item 6).
    const home = path.join(dir, "home");
    mkdirSync(home);
    proc = spawn(process.execPath, [connector], { env: throwawayStart({ ...process.env, CORILLO_USER_DATA: data, CORILLO_HOME: home }), cwd: folder, stdio: ["pipe", "pipe", "pipe"] });
    let stderr = "";
    proc.stderr!.on("data", (chunk: Buffer) => (stderr += chunk.toString()));
    let exit: number | null | undefined;
    proc.once("exit", (code) => (exit = code));
    const answers: { id: number; result?: { content?: { text: string }[]; isError?: boolean } }[] = [];
    onLines(proc.stdout!, (line) => answers.push(JSON.parse(line)));
    const send = (m: object) => proc!.stdin!.write(JSON.stringify({ jsonrpc: "2.0", ...m }) + "\n");
    send({ id: 1, method: "initialize", params: { protocolVersion: "2025-06-18", clientInfo: { name: "claude-code", version: "2.1.326" } } });
    send({ method: "notifications/initialized" });
    await expect.poll(() => answers.map((a) => a.id), { timeout: 10_000 }).toEqual([1]);

    rmSync(folder, { recursive: true, force: true }); // the folder goes while the session is still open
    send({ id: 2, method: "tools/call", params: { name: "read_document", arguments: { path: path.join(dir, "plan.md") } } });
    await new Promise((r) => setTimeout(r, 3000));

    // The agent gets an answer, and the connector is still there for the next call.
    expect({ answered: answers.map((a) => a.id), exit, stderr: stderr.split("\n")[0] ?? "" }).toEqual({ answered: [1, 2], exit: undefined, stderr: "" });
    expect(calls).toHaveLength(1);

    // A path relative to the folder that's gone can't be made full: the call is still answered, as an error, and nothing reaches Corillo.
    send({ id: 3, method: "tools/call", params: { name: "read_document", arguments: { path: "plan.md" } } });
    await expect.poll(() => answers.map((a) => a.id), { timeout: 10_000 }).toEqual([1, 2, 3]);
    expect(answers[2].result?.isError).toBe(true);
    expect({ exit, calls: calls.length }).toEqual({ exit: undefined, calls: 1 });
  });
});

describe("Corillo's end of the socket", () => {
  let server: net.Server | null = null;
  afterEach(() => {
    server?.close();
    server = null;
  });

  it("answers a hello whose client name isn't text, as it answers any other", async () => {
    const dir = mkdtempSync(path.join(tmpdir(), "corillo-socket-"));
    made.push(dir);
    const service = new AgentService({ connected() {} } as unknown as AgentHost, new CommentService(new DocumentStore(dir), () => {}));
    const socketPath = path.join(dir, "sockets", "agents.sock");
    server = listenForAgents(socketPath, service);
    await new Promise((r) => server!.once("listening", r));
    const socket = net.createConnection(socketPath);
    socket.on("error", () => {});
    await new Promise((r) => socket.once("connect", r));
    const answers: unknown[] = [];
    onLines(socket, (line) => answers.push(JSON.parse(line)));

    // Anything this Mac user runs can write to the socket (socket-server.ts says so itself).
    const thrown: unknown[] = [];
    const caught = (err: unknown) => void thrown.push(err);
    process.on("uncaughtException", caught);
    try {
      socket.write('{"id":1,"method":"hello","params":{"client":{"name":42}}}\n');
      await new Promise((r) => setTimeout(r, 1000));
    } finally {
      process.off("uncaughtException", caught);
    }
    socket.destroy();
    expect({ answers, thrown: thrown.map((e) => (e instanceof Error ? e.message : String(e))) }).toEqual({ answers: [{ id: 1, result: { ok: true } }], thrown: [] });
  });
});
