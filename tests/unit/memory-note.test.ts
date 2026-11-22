// One line in Corillo's log when its programs pass 1 GB, and another once
// they're back under (roadmap Batch 10, item 3; W-6). Electron is stood in
// for: the programs' memory is whatever each test says.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { existsSync, mkdtempSync, readFileSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const MB = 1024 * 1024;
const electron = vi.hoisted(() => ({
  /** Each program's kind and memory, in MB. */
  programs: [] as [string, number][],
  looked: 0,
  paths: [] as string[],
  macLogs: "",
}));
vi.mock("electron", () => ({
  app: {
    getAppMetrics: () => {
      electron.looked++;
      return electron.programs.map(([type, mb], i) => ({ pid: i + 1, type, name: type === "Utility" ? "Network Service" : undefined, memory: { workingSetSize: (mb * MB) / 1024 } }));
    },
    getPath: (name: string) => {
      electron.paths.push(name);
      return electron.macLogs;
    },
  },
  ipcMain: { on: () => {} },
}));

type Note = typeof import("../../src/main/memory-note");
let note: Note;
let data: string;
const settings = () => (globalThis as unknown as { corilloMemoryNote: { limit: number; every: number; after: number } }).corilloMemoryNote;
const lines = () => (existsSync(join(data, "Logs", "memory.log")) ? readFileSync(join(data, "Logs", "memory.log"), "utf8").split("\n").filter(Boolean) : []);
/** Two open documents, with names and places that must never reach the log. */
const OPEN = new Map([
  ["a", { diskText: "x".repeat(12_345), filePath: "/Users/someone/Secret plan.md" }],
  ["b", { diskText: "y".repeat(678), filePath: "/Users/someone/Board notes.md" }],
]);

beforeEach(async () => {
  // The clock is the test's, so a look a moment later never lands in another test's folder.
  vi.useFakeTimers();
  data = mkdtempSync(join(tmpdir(), "corillo-data-"));
  electron.macLogs = mkdtempSync(join(tmpdir(), "corillo-mac-logs-"));
  electron.looked = 0;
  electron.paths = [];
  electron.programs = [["Browser", 200], ["Tab", 300], ["GPU", 60], ["Utility", 20]];
  process.env.CORILLO_USER_DATA = data;
  process.env.CORILLO_HIDDEN = "1";
  vi.resetModules();
  note = await import("../../src/main/memory-note");
  settings().every = 0;
});

afterEach(() => {
  vi.useRealTimers();
  for (const dir of [data, electron.macLogs]) rmSync(dir, { recursive: true, force: true });
});

describe("a line in Corillo's log when it passes 1 GB (W-6)", () => {
  it("writes one line when Corillo's programs together pass 1 GB, and another only once they're back under", () => {
    note.lookAtMemory(OPEN);
    expect(lines()).toEqual([]);
    for (let i = 0; i < 3; i++) note.agentChangeArrived();
    electron.programs[1] = ["Tab", 900];
    note.lookAtMemory();
    electron.programs[1] = ["Tab", 950];
    note.lookAtMemory();
    expect(lines()).toHaveLength(1);
    expect(lines()[0]).toMatch(
      /^\d{4}-\d\d-\d\d \d\d:\d\d:\d\d {2}Over 1 GB: 1,180 MB in all \(main 200 MB, window 900 MB, graphics 60 MB, network service 20 MB\)\. 2 documents open: 12,345, 678 characters\. 3 changes from agents in the last minute\.$/,
    );
    electron.programs[1] = ["Tab", 400];
    note.lookAtMemory();
    note.lookAtMemory();
    expect(lines()).toHaveLength(2);
    expect(lines()[1]).toContain("  Back under 1 GB: 680 MB in all (main 200 MB, window 400 MB");
  });

  it("says counts and sizes, never a document's name, words or place", () => {
    electron.programs[0] = ["Browser", 2000];
    note.lookAtMemory(OPEN);
    expect(lines()).toHaveLength(1);
    for (const never of ["Secret", "Board", "someone", "/", "xxx", "yyy"]) expect(lines()[0]).not.toContain(never);
  });

  it("looks at most once every few seconds however often something happens", () => {
    settings().every = 5_000;
    for (let i = 0; i < 20; i++) note.lookAtMemory(OPEN);
    expect(electron.looked).toBe(1);
    vi.advanceTimersByTime(1_000);
    note.agentChangeArrived();
    expect(electron.looked).toBe(1);
    vi.advanceTimersByTime(4_000);
    note.lookAtMemory();
    expect(electron.looked).toBe(2);
  });

  it("looks once more a moment after something happens, since what raised memory is often still being built: one look however many things happened, and never again on its own (B10-7)", () => {
    settings().every = 5_000;
    note.lookAtMemory(OPEN);
    expect(lines()).toEqual([]);
    // The window builds the document after that look, and more arrives meanwhile.
    electron.programs[1] = ["Tab", 900];
    for (let i = 0; i < 5; i++) note.agentChangeArrived();
    expect(electron.looked).toBe(1);
    expect(vi.getTimerCount()).toBe(1);
    vi.advanceTimersByTime(2_000);
    expect(electron.looked).toBe(2);
    expect(lines()).toHaveLength(1);
    expect(lines()[0]).toContain("  Over 1 GB: 1,180 MB in all (main 200 MB, window 900 MB");
    // Nothing more while nobody does anything.
    expect(vi.getTimerCount()).toBe(0);
    vi.advanceTimersByTime(10 * 60_000);
    expect(electron.looked).toBe(2);
  });

  it("counts only the agents' changes of the last minute", () => {
    note.agentChangeArrived(OPEN);
    note.agentChangeArrived();
    vi.advanceTimersByTime(61_000);
    note.agentChangeArrived();
    electron.programs[0] = ["Browser", 2000];
    note.lookAtMemory();
    expect(lines()[0]).toContain(" 1 change from an agent in the last minute.");
  });

  it("never lets the log pass 64 KB: when a line would, the newest half stays, from a line's start", () => {
    const file = join(data, "Logs", "memory.log");
    for (let i = 0; i < 600; i++) {
      electron.programs[0] = ["Browser", i % 2 ? 100 : 2000 + i];
      note.lookAtMemory(OPEN);
      expect(statSync(file).size).toBeLessThanOrEqual(note.MOST_BYTES);
    }
    const kept = lines();
    expect(kept.length).toBeGreaterThan(50);
    expect(kept.length).toBeLessThan(600);
    for (const line of kept) expect(line).toMatch(/^\d{4}-\d\d-\d\d \d\d:\d\d:\d\d {2}(Over|Back under) 1 GB: /);
    // The newest is last: the 600th look went back under.
    expect(kept.at(-1)).toContain("Back under 1 GB: 480 MB in all (main 100 MB,");
    expect(kept.at(-2)).toContain("Over 1 GB: 2,978 MB in all (main 2,598 MB,");
  });

  it("goes in the test's throwaway data folder, never the Mac's own Logs folder; a real run uses the Mac's", () => {
    electron.programs[0] = ["Browser", 2000];
    note.lookAtMemory(OPEN);
    expect(note.logFile()).toBe(join(data, "Logs", "memory.log"));
    expect(lines()).toHaveLength(1);
    expect(electron.paths).toEqual([]);
    delete process.env.CORILLO_USER_DATA;
    expect(note.logFile()).toBe(join(electron.macLogs, "memory.log"));
    expect(electron.paths).toEqual(["logs"]);
  });
});
