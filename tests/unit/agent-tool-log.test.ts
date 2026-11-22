// When an agent tool connects, Corillo's log gets one line: the name and
// version the tool gives itself, and the two settings of Claude Code that
// decide whether it can wait for the person's review, as the connector sees
// them (roadmap Batch 20, item 2; R16-12). If a new release of the tool
// changes one, the line says so, instead of a wait that just doesn't work.
// It's all outside text, so each value is cut to 100 characters with control
// characters taken out, by the connector before it's sent and by Corillo again
// before it's written. Nothing in it is read back, shown or told to an agent.
import { afterEach, describe, expect, it, vi } from "vitest";
import { spawn, type ChildProcess } from "node:child_process";
import { mkdirSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import * as net from "node:net";
import * as path from "node:path";
import { build } from "esbuild";
import { onLines } from "../../src/mcp/lines";
import { connectedLine, forLog, settingsForLog, LOG_MOST } from "../../src/mcp/log-text";
import { listenForAgents } from "../../src/main/agents/socket-server";
import { AgentService, type AgentHost } from "../../src/main/agents/agent-service";
import { CommentService } from "../../src/main/comment-service";
import { DocumentStore } from "../../src/main/store";
import { throwawayStart } from "../e2e/helpers";

const ROOT = path.join(import.meta.dirname, "..", "..");
/** Every character the log leaves out: C0, DEL, C1, the line and paragraph separators, and the marks that turn text around or hide it. */
const UNSAFE = /[\p{Cc}\p{Cf}\p{Cs}\p{Zl}\p{Zp}]/u;
const NASTY = "a\u0000b\nc\rd\te\u001b[31mf\u007fg\u0085h\u009bi\u2028j\u2029k\u202el\u200bm\ud800n";

describe("a value as the log keeps it", () => {
  it("has no control characters, line or paragraph separators, or marks that turn text around", () => {
    expect(forLog(NASTY)).toBe("abcde[31mfghijklmn");
    expect(forLog("claude-code")).toBe("claude-code");
  });

  it("is at most 100 characters, counted after they're taken out, a character outside the basic plane counting once", () => {
    expect(LOG_MOST).toBe(100);
    expect(forLog("x".repeat(500))).toBe("x".repeat(100));
    expect(forLog("\n".repeat(50) + "y".repeat(150))).toBe("y".repeat(100));
    const frogs = forLog("\u{1F438}".repeat(150))!;
    expect(Array.from(frogs)).toHaveLength(100);
    expect(frogs).toBe("\u{1F438}".repeat(100)); // never half a character
  });

  // The review of Batch 20, R20-7: a value of nothing but dropped characters isn't read to its end.
  it("looks at no more than its first 1,000 characters", () => {
    expect(forLog("\u200b".repeat(2000) + "abc")).toBe("");
    expect(forLog("\u200b".repeat(900) + "abc")).toBe("abc");
  });

  it("is nothing for anything that isn't text", () => {
    for (const v of [undefined, null, 5, {}, ["a"], true]) expect(forLog(v)).toBeUndefined();
  });

  it("from the connector's settings, only the two Corillo leans on, each cut and cleaned, and none that isn't set", () => {
    expect(settingsForLog({ CLAUDE_CODE_ENTRYPOINT: "cli", ANTHROPIC_API_KEY: "secret", HOME: "/Users/x" })).toEqual({ CLAUDE_CODE_ENTRYPOINT: "cli" });
    expect(settingsForLog({ CLAUDE_CODE_ENTRYPOINT: NASTY, CLAUDE_AUTO_BACKGROUND_TASKS: "1".repeat(300) })).toEqual({
      CLAUDE_CODE_ENTRYPOINT: "abcde[31mfghijklmn",
      CLAUDE_AUTO_BACKGROUND_TASKS: "1".repeat(100),
    });
    expect(settingsForLog({})).toEqual({});
  });

  it("makes one line, each value in quotes, whatever the connector sent", () => {
    expect(connectedLine({ name: "claude-code", version: "2.1.326" }, { CLAUDE_CODE_ENTRYPOINT: "cli" })).toBe(
      'An agent tool connected: name "claude-code", version "2.1.326"; CLAUDE_CODE_ENTRYPOINT "cli", CLAUDE_AUTO_BACKGROUND_TASKS not set.',
    );
    expect(connectedLine(undefined, undefined)).toBe("An agent tool connected: name not given, version not given; settings not reported (an older connector).");
    // A connector that reports its settings, none of them set (the review of Batch 20, R20-6).
    expect(connectedLine({ name: "claude-code" }, {})).toBe(
      'An agent tool connected: name "claude-code", version not given; CLAUDE_CODE_ENTRYPOINT not set, CLAUDE_AUTO_BACKGROUND_TASKS not set.',
    );
    // Not trusted: anything that isn't plain text is left out, and what's text is cleaned again.
    const line = connectedLine({ name: NASTY, version: 7 }, { CLAUDE_CODE_ENTRYPOINT: ["cli"], CLAUDE_AUTO_BACKGROUND_TASKS: `"x".repeat\n${"z".repeat(400)}` });
    expect(line).not.toMatch(UNSAFE);
    expect(line).toBe(
      `An agent tool connected: name "abcde[31mfghijklmn", version not given; CLAUDE_CODE_ENTRYPOINT not set, CLAUDE_AUTO_BACKGROUND_TASKS ${JSON.stringify(`"x".repeat${"z".repeat(90)}`)}.`,
    );
    // Settings only from its own fields, never through a getter or the prototype.
    const sly = Object.create({ CLAUDE_CODE_ENTRYPOINT: "inherited" }) as Record<string, unknown>;
    Object.defineProperty(sly, "CLAUDE_AUTO_BACKGROUND_TASKS", { get: () => "from a getter", enumerable: true });
    expect(connectedLine({ name: "t" }, sly)).toBe('An agent tool connected: name "t", version not given; CLAUDE_CODE_ENTRYPOINT not set, CLAUDE_AUTO_BACKGROUND_TASKS not set.');
    expect(connectedLine("a string", "a string")).toBe(connectedLine(undefined, undefined));
  });
});

describe("Corillo's end, where hello is answered", () => {
  let server: net.Server | null = null;
  afterEach(() => {
    server?.close();
    server = null;
    vi.restoreAllMocks();
  });

  const listen = async () => {
    const dir = mkdtempSync(path.join(tmpdir(), "corillo-socket-"));
    const service = new AgentService({ connected() {} } as unknown as AgentHost, new CommentService(new DocumentStore(dir), () => {}));
    const connect = vi.spyOn(service, "connect");
    const socketPath = path.join(dir, "sockets", "agents.sock");
    server = listenForAgents(socketPath, service);
    await new Promise((r) => server!.once("listening", r));
    const socket = net.createConnection(socketPath);
    socket.on("error", () => {});
    await new Promise((r) => socket.once("connect", r));
    const answers: unknown[] = [];
    onLines(socket, (line) => answers.push(JSON.parse(line)));
    return { socket, answers, connect };
  };

  it("writes one line in Corillo's log when an agent tool connects, cleaned and cut again, and only once a connection", async () => {
    const logged: string[] = [];
    vi.spyOn(console, "log").mockImplementation((...args: unknown[]) => void logged.push(args.join(" ")));
    const { socket, answers, connect } = await listen();
    const client = { name: `claude-code\n${"n".repeat(200)}`, version: "2.1.326\u001b[2J" };
    const seen = { CLAUDE_CODE_ENTRYPOINT: "cli\u2028injected", CLAUDE_AUTO_BACKGROUND_TASKS: "1" };
    socket.write(JSON.stringify({ id: 1, method: "hello", params: { client, introduced: "Writer", canWait: true, seen } }) + "\n");
    socket.write(JSON.stringify({ id: 2, method: "hello", params: { client, seen } }) + "\n");
    await expect.poll(() => answers).toEqual([
      { id: 1, result: { ok: true } },
      { id: 2, result: { ok: true } },
    ]);
    expect(logged).toEqual([
      `An agent tool connected: name "claude-code${"n".repeat(89)}", version "2.1.326[2J"; CLAUDE_CODE_ENTRYPOINT "cliinjected", CLAUDE_AUTO_BACKGROUND_TASKS "1".`,
    ]);
    // What the session is told and keeps is as it was: the log line is written, never read back.
    expect(connect).toHaveBeenCalledTimes(1);
    expect(connect).toHaveBeenCalledWith(client, "Writer", { canWait: true });
    socket.destroy();
  });

  it("an old connector that sends no settings still gets its line, saying they weren't reported", async () => {
    const logged: string[] = [];
    vi.spyOn(console, "log").mockImplementation((...args: unknown[]) => void logged.push(args.join(" ")));
    const { socket, answers } = await listen();
    socket.write('{"id":1,"method":"hello","params":{"client":{"name":"claude-ai","version":"0.1.0"}}}\n');
    await expect.poll(() => answers).toHaveLength(1);
    expect(logged).toEqual(['An agent tool connected: name "claude-ai", version "0.1.0"; settings not reported (an older connector).']);
    socket.destroy();
  });
});

describe("the connector's end", () => {
  let proc: ChildProcess | null = null;
  let app: net.Server | null = null;
  afterEach(() => {
    proc?.kill();
    proc = null;
    app?.close();
    app = null;
  });

  it("sends the two settings it sees in its hello, cut and cleaned, and none it doesn't see", async () => {
    const dir = mkdtempSync(path.join(tmpdir(), "corillo-connector-"));
    const connector = path.join(dir, "mcp.cjs");
    // Built the way scripts/build.mjs builds dist/mcp.cjs.
    await build({ entryPoints: [path.join(ROOT, "src", "mcp", "server.ts")], outfile: connector, bundle: true, platform: "node", format: "cjs", target: "node22", logLevel: "silent" });

    // A stand-in for Corillo at the connector's socket, which hears the hello and answers each request.
    const data = path.join(dir, "data");
    mkdirSync(path.join(data, "sockets"), { recursive: true, mode: 0o700 });
    const socketPath = path.join(data, "sockets", "agents.sock");
    const hellos: Record<string, unknown>[] = [];
    app = net.createServer((socket) =>
      onLines(socket, (line) => {
        const request = JSON.parse(line) as { id: number; method: string; params: Record<string, unknown> };
        if (request.method === "hello") hellos.push(request.params);
        socket.write(JSON.stringify({ id: request.id, result: request.method === "hello" ? { ok: true } : { text: "No documents are open." } }) + "\n");
      }),
    );
    await new Promise<void>((r) => app!.listen(socketPath, r));

    // Hidden, with a stand-in home: never his (Batch 24, item 6).
    const home = path.join(dir, "home");
    mkdirSync(home);
    const env: Record<string, string | undefined> = { ...process.env, CORILLO_USER_DATA: data, CORILLO_HOME: home, CLAUDE_CODE_ENTRYPOINT: `cli\u001b[2J\u2028${"e".repeat(300)}` };
    delete env.CLAUDE_AUTO_BACKGROUND_TASKS;
    proc = spawn(process.execPath, [connector], { env: throwawayStart(env), stdio: ["pipe", "pipe", "ignore"] });
    const answers: { id: number }[] = [];
    onLines(proc.stdout!, (line) => answers.push(JSON.parse(line)));
    const send = (m: object) => proc!.stdin!.write(JSON.stringify({ jsonrpc: "2.0", ...m }) + "\n");
    send({ id: 1, method: "initialize", params: { protocolVersion: "2025-06-18", clientInfo: { name: "claude-code", version: "2.1.326" } } });
    send({ method: "notifications/initialized" });
    send({ id: 2, method: "tools/call", params: { name: "list_documents", arguments: {} } });
    await expect.poll(() => answers.map((a) => a.id), { timeout: 10_000 }).toEqual([1, 2]);

    expect(hellos).toEqual([
      {
        client: { name: "claude-code", version: "2.1.326" },
        canWait: false, // the entry point it sees isn't "cli"
        seen: { CLAUDE_CODE_ENTRYPOINT: `cli[2J${"e".repeat(94)}` },
      },
    ]);
  });
});
