// Corillo's small files (the recent list, the window's settings, the agents
// it remembers) are written whole or not at all: a write cut off half-way
// (a power cut, a crash, a full disk) leaves the old file, never half of the
// new one. The cut is played by stopping each write after half its bytes.
import { describe, expect, it, vi } from "vitest";
import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const cut = vi.hoisted(() => ({ on: false }));
vi.mock("node:fs", async (original) => {
  const real = await original<typeof import("node:fs")>();
  const half = (data: string | Uint8Array) => (typeof data === "string" ? data.slice(0, Math.floor(data.length / 2)) : data.subarray(0, Math.floor(data.length / 2)));
  const writeFileSync = ((target: string | number, data: string | Uint8Array, ...rest: unknown[]) => {
    if (!cut.on) return (real.writeFileSync as (...a: unknown[]) => void)(target, data, ...rest);
    if (typeof target === "number") real.writeSync(target, half(data) as string);
    else (real.writeFileSync as (...a: unknown[]) => void)(target, half(data), ...rest);
    throw new Error("The power went.");
  }) as typeof real.writeFileSync;
  return { ...real, writeFileSync, default: { ...real, writeFileSync } };
});

const data = vi.hoisted(() => ({ dir: "" }));
vi.mock("electron", () => ({
  app: { getPath: () => data.dir },
  BrowserWindow: { getAllWindows: () => [] },
  ipcMain: { handle: () => {}, on: () => {} },
}));

const { recentFile, RecentList } = await import("../../src/main/recent-list");
const { readView, writeView } = await import("../../src/main/view-settings");
const { rememberAgents } = await import("../../src/main/known-agents");

/** Run a write with the power going half-way through it. */
function cutShort(write: () => void): void {
  cut.on = true;
  try {
    write();
  } catch {
    // the cut
  } finally {
    cut.on = false;
  }
}

describe("a write cut off half-way", () => {
  data.dir = mkdtempSync(join(tmpdir(), "corillo-whole-"));

  it("leaves the recent list as it was", () => {
    const store = recentFile(() => join(data.dir, "recent.json"));
    const before = JSON.stringify(["/docs/plan.md", "/docs/budget.md", "/docs/notes.md"]);
    store.write(before);
    cutShort(() => store.write(JSON.stringify(["/docs/letter.md", "/docs/plan.md", "/docs/budget.md", "/docs/notes.md"])));
    expect(store.read()).toBe(before);
    expect(new RecentList(recentFile(() => join(data.dir, "recent.json"))).all()).toEqual(["/docs/plan.md", "/docs/budget.md", "/docs/notes.md"]);
  });

  it("leaves the window's settings as they were", () => {
    writeView({ zoom: 1.2, sideWidth: 340, commentsHidden: true });
    cutShort(() => writeView({ splitShare: 0.4 }));
    expect(readView()).toEqual({ zoom: 1.2, sideWidth: 340, commentsHidden: true });
  });

  it("leaves the agents Corillo remembers as they were", () => {
    rememberAgents(["Claude"]);
    const before = readFileSync(join(data.dir, "agents.json"), "utf8");
    cutShort(() => rememberAgents(["Codex"]));
    expect(readFileSync(join(data.dir, "agents.json"), "utf8")).toBe(before);
  });
});
