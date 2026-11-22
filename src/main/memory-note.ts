// One line in Corillo's log when its programs together pass 1 GB, and another
// once they're back under (roadmap Batch 10, item 3; W-6 in
// the review of Batch 8). On 2026-11-12 the Mac named Corillo at 2.13 GB and
// nothing could say what was open then; the next time, this line will.
//
// The line says when, how much memory each of Corillo's programs held (their
// working set: memory the Mac has compressed isn't in it, so when the Mac is
// short of memory it can read lower than Activity Monitor), how many documents
// were open and how long each is (in characters), and how many changes from
// agents arrived in the minute before: counts and sizes, never a
// document's name, its words or where it is. It goes in memory.log, in the
// Mac's usual folder for an app's logs (~/Library/Logs/Corillo), which is
// kept to 64 KB: when a line would pass that, the older half goes.
//
// Corillo looks only when something that raises memory happens (a document
// opened, an agent's change arriving, the Markdown view shown, an export), at
// most once every few seconds however often those happen, and once more a
// moment after the last of them, since the window is often still building what
// raised it (B10-7). That second look is one timer, never repeating: while
// nobody does anything, nothing here runs.
import { app, ipcMain } from "electron";
import * as fs from "node:fs";
import * as path from "node:path";
import { writeAtomic } from "./store";

/** What's known of an open document: only its length is read. */
interface OpenText {
  diskText: string;
}

const settings = {
  /** Past this many bytes, all programs together, a line says so. */
  limit: 1024 ** 3,
  /** At most one look this often, in milliseconds. */
  every: 5_000,
  /** One more look this long after the last thing that raised memory, in milliseconds. */
  after: 2_000,
};

/** The log is never bigger than this. */
export const MOST_BYTES = 64 * 1024;
const MINUTE = 60_000;
/** Enough to count a minute's changes, never more however fast they come. */
const MOST_COUNTED = 10_000;

let documents: ReadonlyMap<string, OpenText> | null = null;
let lastLook = -Infinity;
let lookAgain: ReturnType<typeof setTimeout> | null = null;
let over = false;
/** When agents' changes arrived, in the last minute or so. */
const arrived: number[] = [];

// The tests (hidden, from the test helpers) can make Corillo believe it has passed the limit, and look as often as they like.
if (process.env.CORILLO_HIDDEN === "1") Object.defineProperty(globalThis, "corilloMemoryNote", { value: settings, configurable: true });

// The window says when it shows the Markdown view (window-boundary.ts keeps this to the document window).
// Outside Electron (a unit test that reads export.ts, say) there is no ipcMain, and nothing to listen to.
ipcMain?.on("memory:look", () => lookAtMemory());

/** Something that raises memory happened: look, unless Corillo looked a moment ago. `open`: the documents open now. */
export function lookAtMemory(open?: ReadonlyMap<string, OpenText>): void {
  if (open) documents = open;
  if (lookAgain) clearTimeout(lookAgain);
  lookAgain = setTimeout(() => {
    lookAgain = null;
    look();
  }, settings.after);
  lookAgain.unref?.();
  if (Date.now() - lastLook < settings.every) return;
  look();
}

function look(): void {
  const now = Date.now();
  lastLook = now;
  try {
    const programs = app.getAppMetrics().map((m) => ({ kind: kindOf(m), bytes: m.memory.workingSetSize * 1024 }));
    const total = programs.reduce((n, p) => n + p.bytes, 0);
    if (total > settings.limit === over) return;
    over = !over;
    write(noteLine(new Date(now), over, programs, [...(documents?.values() ?? [])].map((d) => d.diskText.length), changesIn(now)));
  } catch (err) {
    // A note for later, never in the way of what the person is doing.
    console.error("Couldn't note how much memory Corillo uses.", err);
  }
}

/** An agent's change arrived: counted, and a look. */
export function agentChangeArrived(open?: ReadonlyMap<string, OpenText>): void {
  arrived.push(Date.now());
  if (arrived.length > MOST_COUNTED) arrived.splice(0, arrived.length - MOST_COUNTED);
  lookAtMemory(open);
}

function changesIn(now: number): number {
  while (arrived.length && arrived[0] < now - MINUTE) arrived.shift();
  return arrived.length;
}

function kindOf(m: Electron.ProcessMetric): string {
  if (m.type === "Browser") return "main";
  if (m.type === "Tab") return "window";
  if (m.type === "GPU") return "graphics";
  if (m.type === "Utility") return (m.name ?? m.serviceName ?? "helper").toLowerCase();
  return m.type.toLowerCase();
}

/** The line, as the log has it. Exported for its test. */
export function noteLine(when: Date, passed: boolean, programs: { kind: string; bytes: number }[], lengths: number[], changes: number): string {
  const mb = (bytes: number) => `${Math.round(bytes / 1024 ** 2).toLocaleString("en-US")} MB`;
  const total = programs.reduce((n, p) => n + p.bytes, 0);
  const limit = settings.limit >= 1024 ** 3 ? `${settings.limit / 1024 ** 3} GB` : mb(settings.limit);
  const each = programs.map((p) => `${p.kind} ${mb(p.bytes)}`).join(", ");
  const docs = lengths.length === 1 ? "1 document open" : `${lengths.length} documents open`;
  const sizes = lengths.length ? `: ${lengths.map((n) => n.toLocaleString("en-US")).join(", ")} characters` : "";
  const agents = changes === 1 ? "1 change from an agent" : `${changes} changes from agents`;
  return `${stamp(when)}  ${passed ? "Over" : "Back under"} ${limit}: ${mb(total)} in all (${each}). ${docs}${sizes}. ${agents} in the last minute.`;
}

/** The local time, to the second. */
function stamp(d: Date): string {
  const two = (n: number) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${two(d.getMonth() + 1)}-${two(d.getDate())} ${two(d.getHours())}:${two(d.getMinutes())}:${two(d.getSeconds())}`;
}

/** Where the log is. Tests and trial runs keep it in their throwaway data folder, never in the Mac's own Logs folder. */
export function logFile(): string {
  const data = process.env.CORILLO_USER_DATA;
  return path.join(data ? path.join(data, "Logs") : app.getPath("logs"), "memory.log");
}

/** Add the line, keeping the file to MOST_BYTES: when it would pass that, the newest half stays, from a line's start. */
function write(line: string): void {
  const file = logFile();
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const add = Buffer.from(`${line}\n`);
  let size = 0;
  try {
    size = fs.statSync(file).size;
  } catch {
    // not there yet
  }
  if (size + add.length <= MOST_BYTES) return fs.appendFileSync(file, add);
  const old = fs.readFileSync(file);
  const half = old.subarray(Math.max(0, old.length - Math.floor(MOST_BYTES / 2) + add.length));
  const start = half.indexOf(10) + 1;
  writeAtomic(file, Buffer.concat([half.subarray(start), add]));
}
