// Before a benchmark run: clear the results of the last one in progress.
import { rmSync } from "node:fs";
import { join } from "node:path";

export default function start(): void {
  rmSync(join(import.meta.dirname, "..", "..", "bench-results", "current.jsonl"), { force: true });
}
