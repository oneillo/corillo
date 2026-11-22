// The Model Context Protocol, as much of it as Corillo needs: JSON-RPC 2.0
// messages for starting a session, listing tools and calling them. Written
// from the published specification at modelcontextprotocol.io.
import { INSTRUCTIONS, SERVER_NAME, SERVER_VERSION, TOOLS, TOOL_NAMES } from "./tools";

/** Protocol versions Corillo speaks, newest first. */
export const PROTOCOL_VERSIONS = ["2025-11-25", "2025-06-18", "2025-03-26", "2024-11-05"];

export interface ClientInfo {
  name?: string;
  version?: string;
}

export interface ToolOutcome {
  text: string;
  isError: boolean;
  /** The agent tool cancelled the call: it gets no answer, as MCP asks. */
  cancelled?: boolean;
}

export interface ProtocolHost {
  /** The agent tool said who it is. */
  setClient(info: ClientInfo): void;
  /** requestId is the agent tool's id for the call, which a cancel names; progressToken, the call's own, for progress messages while it runs. */
  callTool(name: string, args: Record<string, unknown>, requestId?: string | number, progressToken?: string | number): Promise<ToolOutcome>;
  /** The agent tool cancelled a request it sent (the person interrupted it, or it gave up waiting). */
  cancelled?(requestId: string | number): void;
}

type Id = string | number | null;
type Response = { jsonrpc: "2.0"; id: Id; result: unknown } | { jsonrpc: "2.0"; id: Id; error: { code: number; message: string } };

export const PARSE_ERROR = -32700;
const INVALID_REQUEST = -32600;
const METHOD_NOT_FOUND = -32601;
const INVALID_PARAMS = -32602;

export const errorResponse = (id: Id, code: number, message: string): Response => ({
  jsonrpc: "2.0",
  id,
  error: { code, message },
});

const isObject = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v);

/** Answer one message (or a batch). Null when there's nothing to send back. */
export async function handleMessage(message: unknown, host: ProtocolHost): Promise<Response | Response[] | null> {
  if (Array.isArray(message)) {
    const answers = (await Promise.all(message.map((m) => handleOne(m, host)))).filter((r): r is Response => r !== null);
    return answers.length ? answers : null;
  }
  return handleOne(message, host);
}

async function handleOne(message: unknown, host: ProtocolHost): Promise<Response | null> {
  if (!isObject(message) || message.jsonrpc !== "2.0") return errorResponse(null, INVALID_REQUEST, "Not a JSON-RPC 2.0 message.");
  const hasId = "id" in message && (typeof message.id === "string" || typeof message.id === "number");
  if (typeof message.method !== "string") return null; // a response to us; Corillo never asks the client anything
  const params = isObject(message.params) ? message.params : {};
  if (!hasId) {
    // A notification (initialized, cancelled, ...): nothing to answer.
    const cancelled = params.requestId;
    if (message.method === "notifications/cancelled" && (typeof cancelled === "string" || typeof cancelled === "number")) {
      host.cancelled?.(cancelled);
    }
    return null;
  }
  const id = message.id as string | number;
  const ok = (result: unknown): Response => ({ jsonrpc: "2.0", id, result });

  switch (message.method) {
    case "initialize": {
      const asked = typeof params.protocolVersion === "string" ? params.protocolVersion : "";
      const clientInfo = isObject(params.clientInfo) ? params.clientInfo : {};
      host.setClient({
        name: typeof clientInfo.name === "string" ? clientInfo.name : undefined,
        version: typeof clientInfo.version === "string" ? clientInfo.version : undefined,
      });
      return ok({
        protocolVersion: PROTOCOL_VERSIONS.includes(asked) ? asked : PROTOCOL_VERSIONS[0],
        capabilities: { tools: { listChanged: false } },
        serverInfo: { name: SERVER_NAME, title: "Corillo", version: SERVER_VERSION },
        instructions: INSTRUCTIONS,
      });
    }
    case "ping":
      return ok({});
    case "tools/list":
      return ok({ tools: TOOLS });
    case "tools/call": {
      const name = typeof params.name === "string" ? params.name : "";
      if (!TOOL_NAMES.has(name)) return errorResponse(id, INVALID_PARAMS, `Unknown tool: ${name || "(none)"}`);
      const args = isObject(params.arguments) ? params.arguments : {};
      const meta = isObject(params._meta) ? params._meta : {};
      const token = typeof meta.progressToken === "string" || typeof meta.progressToken === "number" ? meta.progressToken : undefined;
      const outcome = await host.callTool(name, args, id, token);
      if (outcome.cancelled) return null;
      return ok({ content: [{ type: "text", text: outcome.text }], isError: outcome.isError });
    }
    default:
      return errorResponse(id, METHOD_NOT_FOUND, `Corillo doesn't support ${message.method}.`);
  }
}
