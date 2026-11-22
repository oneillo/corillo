// The connection between agents' connectors and Corillo: one message per
// line, read safely whatever a local program sends.
import { afterEach, describe, expect, it } from "vitest";
import { PassThrough } from "node:stream";
import { mkdirSync, mkdtempSync, symlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import * as net from "node:net";
import * as path from "node:path";
import { onLines } from "../../src/mcp/lines";
import { socketFolderProblem } from "../../src/mcp/socket-path";
import { listenForAgents } from "../../src/main/agents/socket-server";
import { AgentService, type AgentHost } from "../../src/main/agents/agent-service";
import { CommentService } from "../../src/main/comment-service";
import { DocumentStore } from "../../src/main/store";

function lines(max?: number) {
  const stream = new PassThrough();
  const got: string[] = [];
  let tooLong = 0;
  onLines(stream, (line) => got.push(line), () => tooLong++, max);
  return { send: (chunk: string) => stream.emit("data", chunk), got, tooLong: () => tooLong };
}

describe("reading lines", () => {
  it("puts lines split across chunks back together, and gives several in one chunk one by one", () => {
    const { send, got } = lines();
    send('{"a":');
    send('1}\r\n{"b"');
    send(':2}\n\n{"c":3}\n{"d"');
    expect(got).toEqual(['{"a":1}', '{"b":2}', '{"c":3}']);
    send(":4}\n");
    expect(got.at(-1)).toBe('{"d":4}');
  });

  it("a line longer than the limit is dropped, said so once, and reading carries on after it", () => {
    const { send, got, tooLong } = lines(10);
    send("12345");
    send("67890ab");
    send("cdef\nok\n");
    expect(tooLong()).toBe(1);
    expect(got).toEqual(["ok"]);
    send("0123456789xyz\nfine\n");
    expect(tooLong()).toBe(2);
    expect(got).toEqual(["ok", "fine"]);
  });

  it("a very long message arriving in many pieces takes as long as reading it once, not once per piece", () => {
    const { send, got } = lines();
    const piece = "a".repeat(64 * 1024);
    const started = performance.now();
    for (let i = 0; i < 480; i++) send(piece); // 30 MB, as a big replace_document would be
    send("\n");
    expect(got[0].length).toBe(480 * piece.length);
    expect(performance.now() - started).toBeLessThan(200); // it was about 640 ms, reading the whole buffer again for each piece
  });
});

describe("Corillo's end of the connection", () => {
  let server: net.Server | null = null;
  afterEach(() => {
    server?.close();
    server = null;
  });

  const listen = async () => {
    const dir = mkdtempSync(path.join(tmpdir(), "corillo-socket-"));
    const service = new AgentService({ connected() {} } as unknown as AgentHost, new CommentService(new DocumentStore(dir), () => {}));
    const socketPath = path.join(dir, "sockets", "agents.sock");
    server = listenForAgents(socketPath, service);
    await new Promise((r) => server!.once("listening", r));
    const socket = net.createConnection(socketPath);
    socket.on("error", () => {}); // writing after Corillo closed it
    await new Promise((r) => socket.once("connect", r));
    const answers: unknown[] = [];
    onLines(socket, (line) => answers.push(JSON.parse(line)));
    const closed = new Promise<void>((r) => socket.once("close", () => r()));
    return { socket, answers, closed, service };
  };

  it("lines that are JSON but not a request are ignored, and the connection still works", async () => {
    const caught: unknown[] = [];
    const onUncaught = (err: unknown) => caught.push(err);
    process.on("uncaughtException", onUncaught);
    try {
      const { socket, answers } = await listen();
      socket.write('null\n[]\n5\n"hello"\n{"id":1,"method":"hello","params":null}\n');
      await expect.poll(() => answers).toEqual([{ id: 1, result: { ok: true } }]);
      expect(caught).toEqual([]);
      socket.destroy();
    } finally {
      process.off("uncaughtException", onUncaught);
    }
  });

  it("a call that fails inside Corillo is answered with the failure, so the agent is never left waiting (A-5)", async () => {
    const { socket, answers, service } = await listen();
    service.call = async () => {
      throw new Error("The comments can't be read right now.");
    };
    socket.write('{"id":1,"method":"hello","params":{"client":{"name":"claude-code"}}}\n');
    socket.write('{"id":2,"method":"call","params":{"tool":"wait_for_review","args":{}}}\n');
    await expect.poll(() => answers).toEqual([
      { id: 1, result: { ok: true } },
      { id: 2, result: { text: "Something went wrong in Corillo: The comments can't be read right now.", isError: true } },
    ]);
    socket.destroy();
  });

  it("a line with no end, past the limit, closes the connection instead of filling memory", async () => {
    const { socket, closed } = await listen();
    const piece = "a".repeat(1024 * 1024);
    for (let i = 0; i < 65 && !socket.destroyed; i++) socket.write(piece);
    await closed;
  });
});

describe("the folder the socket is in, when it's in /tmp", () => {
  it("must be this user's own folder that only they can open", () => {
    const dir = mkdtempSync(path.join(tmpdir(), "corillo-folder-"));
    const own = path.join(dir, "own");
    mkdirSync(own, { mode: 0o700 });
    expect(socketFolderProblem(path.join(own, "x.sock"))).toBeNull();
    const open = path.join(dir, "open");
    mkdirSync(open, { mode: 0o755 });
    expect(socketFolderProblem(path.join(open, "x.sock"))).toMatch(/isn't safe/);
    const link = path.join(dir, "link");
    symlinkSync(own, link);
    expect(socketFolderProblem(path.join(link, "x.sock"))).toMatch(/isn't safe/);
    expect(socketFolderProblem(path.join(dir, "not-yet", "x.sock"))).toBeNull(); // Corillo makes it as it starts
  });
});
