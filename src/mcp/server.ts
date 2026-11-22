// Corillo's agent connector: an MCP server an agent tool runs over stdin and
// stdout. It runs on Corillo's own program in Node mode (ELECTRON_RUN_AS_NODE=1),
// so nobody needs to install Node. Each run is one agent session. It passes the
// agent's tool calls to the running Corillo over a local socket, starting
// Corillo first if it isn't running.
import * as net from "node:net";
import * as path from "node:path";
import { spawn } from "node:child_process";
import { homedir } from "node:os";
import { handleMessage, errorResponse, PARSE_ERROR, type ClientInfo, type ToolOutcome } from "./protocol";
import { onLines, type AppAnswer } from "./lines";
import { defaultDataFolder, socketFolderProblem, socketPathFor } from "./socket-path";
import { START_FOLDER, startEnv } from "./start-env";
import { canWaitIn } from "../core/agents";
import { DONT_CALL_AGAIN, WAIT_GONE } from "../core/waiting-words";
import { settingsForLog } from "./log-text";

const START_TIMEOUT_MS = 30_000;
/**
 * A wait for the person's review (wait_for_review) is kept alive with a
 * progress message this often: Claude Code drops a call that's silent for 30
 * minutes, and isn't charged for these (found in a trial with real agents, roadmap Batch 1).
 */
const WAIT_PROGRESS_MS = numberFrom(process.env.CORILLO_WAIT_PROGRESS_MS, 5 * 60_000);
/** The connector ends a wait itself after this long, well inside Claude Code's own limit (about 28 hours), so it ends in words the agent can act on. */
const WAIT_LIMIT_MS = numberFrom(process.env.CORILLO_WAIT_LIMIT_MS, 8 * 60 * 60_000);

function numberFrom(text: string | undefined, fallback: number): number {
  const n = Number(text);
  return Number.isFinite(n) && n > 0 ? n : fallback;
}
const socketPath = socketPathFor(defaultDataFolder());
/** The socket is in /tmp only when the data folder's path is too long for one. */
const inTmp = socketPath.startsWith("/tmp/");

let client: ClientInfo = {};
let introduced: string | undefined;

const log = (text: string) => process.stderr.write(`corillo: ${text}\n`);

// The link to Corillo ------------------------------------------------------------

class AppLink {
  closed = false;
  private nextId = 1;
  private pending = new Map<number, { resolve: (v: unknown) => void; reject: (e: Error) => void }>();

  constructor(private socket: net.Socket) {
    onLines(
      socket,
      (line) => {
        let answer: AppAnswer;
        try {
          answer = JSON.parse(line) as AppAnswer;
        } catch {
          return;
        }
        if (typeof answer !== "object" || answer === null) return;
        this.answered(answer);
      },
      () => socket.destroy(),
    );
    socket.on("error", () => {});
    socket.on("close", () => {
      this.closed = true;
      if (link === this) closedSinceLastCall = true;
      for (const w of this.pending.values()) w.reject(new Error("Lost the connection to Corillo (it may have quit). Try again."));
      this.pending.clear();
    });
  }

  private answered(answer: AppAnswer): void {
    const waiting = this.pending.get(answer.id);
    if (!waiting) return;
    this.pending.delete(answer.id);
    if ("error" in answer) waiting.reject(new Error(String(answer.error)));
    else waiting.resolve(answer.result);
  }

  /** sent is told the request's id, for cancelling it. */
  request(method: "hello" | "call", params: Record<string, unknown>, sent?: (id: number) => void): Promise<unknown> {
    if (this.closed) return Promise.reject(new Error("Lost the connection to Corillo. Try again."));
    const id = this.nextId++;
    return new Promise((resolve, reject) => {
      this.pending.set(id, { resolve, reject });
      this.socket.write(JSON.stringify({ id, method, params }) + "\n");
      sent?.(id);
    });
  }

  /** Tell Corillo the agent's tool cancelled a call (Corillo still answers it); `answered`: even one it has answered. */
  cancel(id: number, answered = false): void {
    if (this.closed || (!answered && !this.pending.has(id))) return;
    this.socket.write(JSON.stringify({ id: this.nextId++, method: "cancel", params: { call: id } }) + "\n");
  }

  close(): void {
    this.socket.end();
  }
}

/** The socket's folder in /tmp isn't safe to use: nothing is sent, and Corillo isn't started. */
class Unsafe extends Error {}

function connectOnce(): Promise<net.Socket> {
  const unsafe = inTmp ? socketFolderProblem(socketPath) : null;
  if (unsafe) return Promise.reject(new Unsafe(unsafe));
  return new Promise((resolve, reject) => {
    const socket = net.createConnection(socketPath);
    socket.once("connect", () => {
      socket.removeAllListeners("error");
      resolve(socket);
    });
    socket.once("error", reject);
  });
}

/** Start Corillo: its own program, as an app this time, in the background. */
function startCorillo(): void {
  if (!process.versions.electron) throw new Error("Corillo isn't running. Open Corillo, then try again.");
  // Not the agent tool's keys, settings or working folder (see start-env.ts).
  const env = startEnv(process.env);
  // During development the program is plain Electron and needs the app's folder;
  // the finished app ignores it.
  const appFolder = path.resolve(__dirname, "..");
  const child = spawn(process.execPath, [appFolder, "--background"], { env, cwd: START_FOLDER, detached: true, stdio: "ignore" });
  child.on("error", (err) => log(`Corillo couldn't be started: ${err.message}`)); // waiting then says so
  child.unref();
  log(`Corillo wasn't running, so it was started (process ${child.pid}).`);
}

async function waitForCorillo(): Promise<net.Socket> {
  const deadline = Date.now() + START_TIMEOUT_MS;
  for (;;) {
    try {
      return await connectOnce();
    } catch (err) {
      if (err instanceof Unsafe) throw err;
      if (Date.now() > deadline) {
        throw new Error("Corillo didn't start or didn't answer. Ask the person to open Corillo (or, if it's open, to quit and open it again), then try again.");
      }
      await new Promise((r) => setTimeout(r, 200));
    }
  }
}

let link: AppLink | null = null;
let linking: Promise<AppLink> | null = null;
/** Corillo closed (the person quit it) after this session had reached it. */
let closedSinceLastCall = false;

class NotRunning extends Error {}

/** Tools that need a document the agent is editing. Nothing is being edited while Corillo is closed. */
const NEED_A_PASS = new Set(["edit_document", "replace_document", "finish_editing"]);

const CLOSED_NOTE =
  "Corillo was closed since your last call, so if you were editing a document, your editing pass ended and it's back with the person. The changes you'd made are kept. To edit again, call take_document.";

/** The link to Corillo; it's started first if need be, unless start is false. */
function connected(start = true): Promise<AppLink> {
  if (link && !link.closed) return Promise.resolve(link);
  linking ??= (async () => {
    let socket: net.Socket;
    try {
      socket = await connectOnce();
    } catch (err) {
      if (err instanceof Unsafe) throw err;
      if (!start) throw new NotRunning();
      startCorillo();
      socket = await waitForCorillo();
    }
    const fresh = new AppLink(socket);
    // Whether this agent tool can wait for the person's review (see canWaitIn): the agent tool's own settings say.
    // `seen`: those settings as this connector sees them, cut and cleaned, for one line in Corillo's log (log-text.ts).
    await fresh.request("hello", { client, introduced, canWait: canWaitIn(client.name, process.env), seen: settingsForLog(process.env) });
    link = fresh;
    return fresh;
  })().finally(() => {
    linking = null;
  });
  return linking;
}

/**
 * Paths are the agent's: "~" is its home, and a relative path starts where the
 * agent works. take_document also takes a document's name: a path with no
 * folder in it goes as it is, with `here`, where it would be as a file in the
 * agent's folder. Corillo takes that file when it's there, as the other tools
 * would; otherwise it matches the name among the documents open in Corillo.
 * (path.resolve reads the agent's folder only for a relative path: a full one
 * works even once that folder is gone.)
 */
function withFullPath(tool: string, args: Record<string, unknown>): Record<string, unknown> {
  const out = { ...args };
  delete out.here;
  delete out.canHold; // the connector's to say (see runTool), never the agent's
  // wait_for_review's documents: names go as they are, each with where it would be as a file in the agent's folder (as for take_document), paths in full.
  if (Array.isArray(args.paths)) {
    const bare = (p: string) => !p.includes("/") && !p.startsWith("~");
    out.paths = args.paths.map((p) => {
      if (typeof p !== "string" || bare(p)) return p;
      const t = p.trim();
      return path.resolve(t === "~" || t.startsWith("~/") ? path.join(homedir(), t.slice(1)) : t);
    });
    if (tool === "wait_for_review") out.here = args.paths.map((p) => (typeof p === "string" && bare(p) && p.trim() ? path.resolve(p.trim()) : ""));
  }
  for (const key of ["path", "output_path"]) {
    const value = args[key];
    if (typeof value !== "string" || !value.trim()) continue;
    let p = value.trim();
    if (tool === "take_document" && key === "path" && !p.includes("/") && !p.startsWith("~")) {
      out.path = p;
      out.here = path.resolve(p);
      continue;
    }
    if (p === "~" || p.startsWith("~/")) p = path.join(homedir(), p.slice(1));
    out[key] = path.resolve(p);
  }
  return out;
}

/** Tool calls in progress, by the agent tool's request id, so its cancel can reach them. */
const calls = new Map<string | number, { cancelled: boolean; cancel?: () => void }>();

/**
 * The last take_document answered, until the next tool call: the agent tool
 * may cancel it as the answer reaches it (the person pressed Esc just then),
 * and Corillo, told, gives the document straight back.
 */
let lastTake: { requestId: string | number; cancel: () => void } | null = null;

/** The agent tool cancelled a call: Corillo is told, and its answer isn't sent (as MCP asks). */
function cancelled(requestId: string | number): void {
  const call = calls.get(requestId);
  if (!call) {
    if (lastTake?.requestId !== requestId) return;
    lastTake.cancel();
    lastTake = null;
    return;
  }
  if (call.cancelled) return;
  call.cancelled = true;
  call.cancel?.();
}

async function callTool(name: string, args: Record<string, unknown>, requestId?: string | number, progressToken?: string | number): Promise<ToolOutcome> {
  const call = { cancelled: false } as { cancelled: boolean; cancel?: () => void };
  if (requestId !== undefined) calls.set(requestId, call);
  try {
    const outcome = await runTool(name, args, requestId, call, progressToken);
    return call.cancelled ? { ...outcome, cancelled: true } : outcome;
  } finally {
    // Each call, alone or in a batch, is let go once it's done.
    if (requestId !== undefined && calls.get(requestId) === call) calls.delete(requestId);
  }
}

async function runTool(
  name: string,
  args: Record<string, unknown>,
  requestId: string | number | undefined,
  call: { cancelled: boolean; cancel?: () => void },
  progressToken?: string | number,
): Promise<ToolOutcome> {
  // Told once, on the first call after Corillo closed.
  const note = closedSinceLastCall ? `${CLOSED_NOTE}\n\n` : "";
  closedSinceLastCall = false;
  lastTake = null;
  const needsPass = NEED_A_PASS.has(name);
  const waits = name === "wait_for_review";
  let progress: ReturnType<typeof setInterval> | undefined;
  let limit: ReturnType<typeof setTimeout> | undefined;
  try {
    // Held until the person sends a document back: only where the agent tool keeps a call open in the background, with a token to keep it alive.
    // (Inside the try: a path relative to a folder that's gone can't be made full, and the call is still answered.)
    const sent = waits ? { ...withFullPath(name, args), canHold: canWaitIn(client.name, process.env) && progressToken !== undefined } : withFullPath(name, args);
    // An edit can't succeed while Corillo is closed, so it doesn't start Corillo; nor is it started to wait for a review.
    const app = await connected(!needsPass && !waits).catch((err) => (err instanceof NotRunning && !needsPass && !waits ? connected() : Promise.reject(err)));
    if (call.cancelled) return { text: "Cancelled.", isError: true };
    let sentAs = 0;
    const answer = app.request("call", { tool: name, args: sent }, (id) => {
      sentAs = id;
      call.cancel = () => app.cancel(id);
    });
    if (waits && sent.canHold) {
      let n = 0;
      progress = setInterval(
        () => send({ jsonrpc: "2.0", method: "notifications/progress", params: { progressToken, progress: ++n, message: "Waiting for the person's review" } }),
        WAIT_PROGRESS_MS,
      );
      // Corillo ends the wait in words the agent can act on, and the answer goes to the agent.
      limit = setTimeout(() => app.cancel(sentAs), WAIT_LIMIT_MS);
    }
    let outcome: ToolOutcome;
    try {
      outcome = (await answer) as ToolOutcome;
    } catch (err) {
      if (waits && !call.cancelled) return { text: WAIT_GONE, isError: false };
      throw err;
    }
    if (name === "take_document" && requestId !== undefined && !call.cancelled) lastTake = { requestId, cancel: () => app.cancel(sentAs, true) };
    if (name === "introduce" && !outcome.isError && typeof args.name === "string") introduced = args.name;
    return { ...outcome, text: note + outcome.text };
  } catch (err) {
    if (err instanceof NotRunning && waits) {
      return {
        text: `${note}Corillo isn't open, so there's nothing to wait for. Tell the person in the chat that when they've finished commenting they can tell you here; ${DONT_CALL_AGAIN}`,
        isError: false,
      };
    }
    if (err instanceof NotRunning) {
      return { text: `${note}Corillo isn't open, so you're not editing that document and nothing was changed. Call take_document first; it opens Corillo.`, isError: true };
    }
    return { text: note + (err instanceof Error ? err.message : String(err)), isError: true };
  } finally {
    clearInterval(progress);
    clearTimeout(limit);
  }
}

// The agent tool, over stdin and stdout --------------------------------------------

const send = (message: unknown) => {
  if (message !== null) process.stdout.write(JSON.stringify(message) + "\n");
};

process.stdout.on("error", () => process.exit(0));

onLines(process.stdin, onMessage, () => send(errorResponse(null, PARSE_ERROR, "That message was too long for Corillo.")));

function onMessage(line: string): void {
  let message: unknown;
  try {
    message = JSON.parse(line);
  } catch {
    send(errorResponse(null, PARSE_ERROR, "That wasn't valid JSON."));
    return;
  }
  inflight++;
  void handleMessage(message, {
    setClient: (info) => {
      client = info;
    },
    callTool,
    cancelled,
  })
    // No call is left without an answer.
    .catch((err) => errorResponse(idOf(message), INTERNAL_ERROR, err instanceof Error ? err.message : String(err)))
    .then(send)
    .finally(() => {
      inflight--;
      if (ending && inflight === 0) stop();
    });
}

const INTERNAL_ERROR = -32603;
const idOf = (message: unknown) => {
  const id = typeof message === "object" && message !== null ? (message as { id?: unknown }).id : null;
  return typeof id === "string" || typeof id === "number" ? id : null;
};

// When the agent tool goes, so does this session (once its last answers are out).
let inflight = 0;
let ending = false;
const stop = () => {
  link?.close();
  process.exit(0);
};
process.stdin.on("end", () => {
  ending = true;
  if (inflight === 0) stop();
  else setTimeout(stop, 5000);
});
process.on("SIGTERM", stop);
process.on("SIGINT", stop);
