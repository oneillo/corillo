// Messages as lines of JSON, one per line: how the agent connector talks to the
// agent tool (over stdin and stdout) and to Corillo (over the local socket).
import type { Readable } from "node:stream";

/**
 * The longest line read, in characters: well past any document Corillo opens
 * (25 MB) as JSON, so only a runaway sender reaches it.
 */
export const MAX_LINE = 64 * 1024 * 1024;

/**
 * Call back with each complete line that arrives on the stream. Each chunk is
 * looked through once, so a long message costs no more than reading it. A
 * line longer than max is dropped (tooLong is told) and reading carries on
 * after its end.
 */
export function onLines(stream: Readable, callback: (line: string) => void, tooLong: () => void = () => {}, max = MAX_LINE): void {
  let pieces: string[] = [];
  let size = 0;
  let dropping = false;
  stream.setEncoding("utf8");
  stream.on("data", (chunk: string) => {
    let start = 0;
    for (let i = chunk.indexOf("\n"); i >= 0; i = chunk.indexOf("\n", start)) {
      const piece = chunk.slice(start, i);
      start = i + 1;
      if (dropping || size + piece.length > max) {
        if (!dropping) tooLong();
        dropping = false;
        pieces = [];
        size = 0;
        continue;
      }
      const line = (pieces.length ? pieces.join("") + piece : piece).replace(/\r$/, "");
      pieces = [];
      size = 0;
      if (line.trim()) callback(line);
    }
    if (start >= chunk.length || dropping) return;
    const rest = start ? chunk.slice(start) : chunk;
    if (size + rest.length > max) {
      tooLong();
      dropping = true;
      pieces = [];
      size = 0;
      return;
    }
    pieces.push(rest);
    size += rest.length;
  });
}

/** Between the connector and Corillo: a request and its answer. */
export interface AppRequest {
  id: number;
  /** cancel: the agent's tool cancelled the call whose id is params.call. */
  method: "hello" | "call" | "cancel";
  params: Record<string, unknown>;
}
export type AppAnswer = { id: number; result: unknown } | { id: number; error: string };
