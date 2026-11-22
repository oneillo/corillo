// A pretend agent tool for the end-to-end tests: it runs Corillo's connector
// (dist/mcp.cjs) the way a real agent tool would, with Electron's program in
// Node mode, and speaks MCP to it over stdin and stdout.
import { spawn, type ChildProcess } from "node:child_process";
import { createRequire } from "node:module";
import { join } from "node:path";
import { throwawayStart } from "./helpers";

const ROOT = join(import.meta.dirname, "..", "..");
const ELECTRON = createRequire(import.meta.url)("electron") as string;
export const CONNECTOR = join(ROOT, "dist", "mcp.cjs");

interface Answer {
  id: number;
  result?: Record<string, unknown>;
  error?: { code: number; message: string };
}

/** A message from the connector that isn't an answer: a progress message on a call still running. */
interface Notice {
  method: string;
  params?: { progressToken?: unknown; progress?: number; message?: string };
}

export class AgentSession {
  stderr = "";
  /** Progress messages the connector sent on calls still running (a wait for the review keeps itself alive with them). */
  progress: { token: unknown; progress: number; message?: string }[] = [];
  private nextId = 1;
  private buffer = "";
  private waiting = new Map<number, (a: Answer) => void>();
  /** The answer to the batch sent last, if one comes. */
  private batchWaiting: ((a: Answer[]) => void) | null = null;
  private exited: Promise<void>;

  private constructor(private proc: ChildProcess) {
    proc.stdout!.setEncoding("utf8");
    proc.stdout!.on("data", (chunk: string) => {
      this.buffer += chunk;
      for (let i = this.buffer.indexOf("\n"); i >= 0; i = this.buffer.indexOf("\n")) {
        const line = this.buffer.slice(0, i);
        this.buffer = this.buffer.slice(i + 1);
        const answer = JSON.parse(line) as Answer | Answer[] | Notice;
        if ("method" in answer) {
          if (answer.method === "notifications/progress") {
            this.progress.push({ token: answer.params?.progressToken, progress: answer.params?.progress ?? 0, message: answer.params?.message });
          }
          continue;
        }
        if (Array.isArray(answer)) {
          this.batchWaiting?.(answer);
          this.batchWaiting = null;
          continue;
        }
        this.waiting.get(answer.id)?.(answer);
        this.waiting.delete(answer.id);
      }
    });
    proc.stderr!.setEncoding("utf8");
    proc.stderr!.on("data", (chunk: string) => (this.stderr += chunk));
    this.exited = new Promise((resolve) => proc.once("exit", () => resolve()));
  }

  /**
   * Start a session, introduced to Corillo as this agent tool; `tool` adds to the agent tool's settings and sets the folder it works in.
   * A Corillo the connector starts takes on its surroundings, so they are a test's Corillo's (`throwawayStart`): hidden, on `dataDir`,
   * which must be throwaway, with a stand-in home (Batch 22, item 4: C21-T1).
   */
  static async start(
    dataDir: string,
    clientName = "claude-code",
    tool: { env?: Record<string, string>; cwd?: string } = {},
  ): Promise<{ session: AgentSession; init: Record<string, unknown> }> {
    // Whether an agent tool can wait for a review depends on how it was started (see canWaitIn): not on how these tests were.
    const inherited = { ...process.env };
    delete inherited.CLAUDE_CODE_ENTRYPOINT;
    delete inherited.CLAUDE_AUTO_BACKGROUND_TASKS;
    const proc = spawn(ELECTRON, [CONNECTOR], {
      env: throwawayStart({ ...inherited, ...tool.env, ELECTRON_RUN_AS_NODE: "1", CORILLO_USER_DATA: dataDir }),
      cwd: tool.cwd,
      stdio: ["pipe", "pipe", "pipe"],
    });
    const session = new AgentSession(proc);
    const init = await session.request("initialize", {
      protocolVersion: "2025-06-18",
      capabilities: {},
      clientInfo: { name: clientName, version: "1.0" },
    });
    session.send({ jsonrpc: "2.0", method: "notifications/initialized" });
    return { session, init };
  }

  private send(message: unknown): void {
    this.proc.stdin!.write(JSON.stringify(message) + "\n");
  }

  async request(method: string, params?: unknown): Promise<Record<string, unknown>> {
    const id = this.nextId++;
    const answer = await new Promise<Answer>((resolve) => {
      this.waiting.set(id, resolve);
      this.send({ jsonrpc: "2.0", id, method, params });
    });
    if (answer.error) throw new Error(answer.error.message);
    return answer.result!;
  }

  /**
   * Start a tool call without waiting for it: its id, to cancel it, and its
   * answer if one comes. `meta` goes with it, as Claude Code sends a progress
   * token with every call.
   */
  begin(tool: string, args: Record<string, unknown> = {}, meta?: { progressToken: string | number }): { id: number; answer: Promise<Answer> } {
    const id = this.nextId++;
    const answer = new Promise<Answer>((resolve) => this.waiting.set(id, resolve));
    this.send({ jsonrpc: "2.0", id, method: "tools/call", params: { name: tool, arguments: args, ...(meta ? { _meta: meta } : {}) } });
    return { id, answer };
  }

  /** Start waiting for the person's review, as Claude Code would (with a progress token): its id, and the answer's text when it comes. */
  waitForReview(args: Record<string, unknown> = {}): { id: number; text: Promise<string>; answered: () => boolean } {
    const { id, answer } = this.begin("wait_for_review", args, { progressToken: `wait-${this.nextId}` });
    let done = false;
    const text = answer.then((a) => {
      done = true;
      return (a.result as { content: { text: string }[] }).content.map((c) => c.text).join("\n");
    });
    return { id, text, answered: () => done };
  }

  /** Send tool calls together, as one JSON-RPC batch: their ids, and the batch's answer if one comes. */
  beginBatch(calls: [string, Record<string, unknown>][]): { ids: number[]; answer: Promise<Answer[]> } {
    const messages = calls.map(([tool, args]) => ({ jsonrpc: "2.0", id: this.nextId++, method: "tools/call", params: { name: tool, arguments: args } }));
    const answer = new Promise<Answer[]>((resolve) => (this.batchWaiting = resolve));
    this.send(messages);
    return { ids: messages.map((m) => m.id), answer };
  }

  /** The agent tool cancels a call it sent, as when the person presses Esc. */
  cancel(id: number): void {
    this.send({ jsonrpc: "2.0", method: "notifications/cancelled", params: { requestId: id, reason: "The person interrupted." } });
  }

  async call(tool: string, args: Record<string, unknown> = {}): Promise<{ text: string; isError: boolean }> {
    const result = (await this.request("tools/call", { name: tool, arguments: args })) as {
      content: { text: string }[];
      isError: boolean;
    };
    return { text: result.content.map((c) => c.text).join("\n"), isError: result.isError };
  }

  /** Call a tool that should work, and get its text. */
  async ok(tool: string, args: Record<string, unknown> = {}): Promise<string> {
    const r = await this.call(tool, args);
    if (r.isError) throw new Error(`${tool} failed: ${r.text}`);
    return r.text;
  }

  /** The agent tool quits: its session ends. */
  async stop(): Promise<void> {
    this.proc.stdin!.end();
    await this.exited;
  }
}
