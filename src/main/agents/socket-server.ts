// Corillo listens for agent connectors on a local socket that only this Mac
// user can reach. Each connection is one agent session; when it closes, the
// session ends.
import * as fs from "node:fs";
import * as net from "node:net";
import * as path from "node:path";
import { onLines, type AppAnswer, type AppRequest } from "../../mcp/lines";
import { connectedLine } from "../../mcp/log-text";
import type { AgentService } from "./agent-service";

/** What the person is told when agents can't reach Corillo. */
const UNREACHABLE = "Agents can't reach Corillo: it couldn't set up their connection. Quit Corillo and open it again.";

/**
 * onProblem hears, in words for the person, when agents can't reach Corillo.
 * `first`: something a call waits for before it's answered, if anything
 * (the tabs Corillo is bringing back at launch, roadmap Batch 10, item 2).
 */
export function listenForAgents(
  socketPath: string,
  service: AgentService,
  onProblem: (text: string) => void = () => {},
  first: () => Promise<void> | null = () => null,
): net.Server | null {
  if (process.platform !== "win32") {
    const folder = path.dirname(socketPath);
    try {
      fs.mkdirSync(folder, { recursive: true, mode: 0o700 });
      const stat = fs.lstatSync(folder);
      // The folder must be this user's own, and nobody else's to look in.
      if (!stat.isDirectory() || (process.getuid && stat.uid !== process.getuid())) throw new Error(`${folder} isn't ours`);
      fs.chmodSync(folder, 0o700);
      // Only one Corillo runs per data folder, so a socket left here is from one that quit.
      fs.rmSync(socketPath, { force: true });
    } catch (err) {
      console.error("Corillo couldn't set up the connection for agents:", (err as Error).message);
      onProblem(UNREACHABLE);
      return null;
    }
  }

  const server = net.createServer((socket) => {
    let sessionId: string | null = null;
    // Calls in progress, by id, so the agent's tool can cancel them; and the
    // last take_document, whose cancel may cross its answer (until the next call).
    const calls = new Map<number, AbortController>();
    let lastTake: { id: number; controller: AbortController } | null = null;
    const answer = (message: AppAnswer) => {
      if (!socket.destroyed) socket.write(JSON.stringify(message) + "\n");
    };
    socket.on("error", () => {});
    socket.on("close", () => {
      if (sessionId) void service.disconnect(sessionId);
      for (const controller of calls.values()) controller.abort();
      calls.clear();
      lastTake = null;
    });
    const onRequest = (line: string) => {
      let request: AppRequest;
      try {
        request = JSON.parse(line) as AppRequest;
      } catch {
        return;
      }
      // Only Corillo's connector talks here, but anything this Mac user runs could: take only a request's shape.
      if (typeof request !== "object" || request === null || Array.isArray(request) || typeof request.id !== "number") return;
      const params = (typeof request.params === "object" && request.params !== null ? request.params : {}) as Record<string, unknown>;
      if (request.method === "hello") {
        if (!sessionId) {
          const given = (params.client ?? {}) as { name?: unknown };
          // (A name that isn't text is left out.)
          const client = (typeof given.name === "string" || given.name === undefined ? given : { ...given, name: undefined }) as { name?: string };
          const introduced = typeof params.introduced === "string" ? params.introduced : undefined;
          // Its connector says whether the agent tool can keep a wait for the person's review open (see canWaitIn).
          sessionId = service.connect(client, introduced, { canWait: params.canWait === true }).sessionId;
          // One line in the log of what the agent tool says it is and the settings it runs with, cleaned again here: written, never read back.
          console.log(connectedLine(params.client, params.seen));
        }
        answer({ id: request.id, result: { ok: true } });
      } else if (request.method === "call") {
        if (!sessionId) {
          answer({ id: request.id, error: "Say hello first." });
          return;
        }
        const tool = typeof params.tool === "string" ? params.tool : "";
        const args = (params.args ?? {}) as Record<string, unknown>;
        const id = request.id;
        const controller = new AbortController();
        calls.set(id, controller);
        lastTake = null;
        const session = sessionId;
        const waiting = first();
        void (waiting ? waiting.then(() => service.call(session, tool, args, controller.signal)) : service.call(session, tool, args, controller.signal)).then(
          (result) => {
            calls.delete(id);
            if (tool === "take_document") lastTake = { id, controller };
            answer({ id, result });
          },
          // Every call gets an answer: an agent is never left waiting on one that failed.
          (err: unknown) => {
            calls.delete(id);
            answer({ id, result: { text: `Something went wrong in Corillo: ${err instanceof Error ? err.message : String(err)}`, isError: true } });
          },
        );
      } else if (request.method === "cancel") {
        const id = params.call;
        const take = lastTake;
        (calls.get(id as number) ?? (take && take.id === id ? take.controller : undefined))?.abort();
      } else {
        answer({ id: request.id, error: "Unknown request." });
      }
    };
    // A line with no end, past the limit, ends the connection rather than fill Corillo's memory.
    onLines(socket, onRequest, () => socket.destroy());
  });

  server.on("error", (err) => {
    console.error("Corillo couldn't listen for agents:", err.message);
    onProblem(UNREACHABLE);
  });
  server.listen(socketPath, () => {
    if (process.platform !== "win32") fs.chmodSync(socketPath, 0o600);
  });
  return server;
}
