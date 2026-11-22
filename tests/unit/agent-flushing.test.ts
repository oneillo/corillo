// While an agent takes a document, the window saves the person's last edits
// first, and that one save must get past the guard that refuses the window's
// saves while an agent holds it. The agents' side (agents/host.ts) keeps which
// tab each such save is for (S21-49): from the ask until the window answers or
// goes, not only until the ask times out, since the window's save can still be
// on its way after that.
//
// Runs Corillo's real link between the agents and the files over a throwaway
// folder, with the window stood in for, as agent-file-back.test.ts does.
import { afterEach, describe, expect, it, vi } from "vitest";
import * as fs from "node:fs";
import { tmpdir } from "node:os";
import * as path from "node:path";
import type { OpenDoc } from "../../src/main/doc-on-disk";

// The window's answers come back through ipcMain: kept here so the stand-in window can answer.
const heard = vi.hoisted(() => new Map<string, (...args: unknown[]) => void>());
vi.mock("electron", () => ({
  app: { getPath: () => tmpdir(), on: () => {} },
  BrowserWindow: { getAllWindows: () => [] },
  clipboard: { writeText: () => {} },
  ipcMain: { handle: () => {}, on: (channel: string, fn: (...args: unknown[]) => void) => heard.set(channel, fn), removeHandler: () => {} },
}));

const { setUpAgents } = await import("../../src/main/agents/host");
const { forAgents } = await import("../../src/main/doc-on-disk");
const { readText } = await import("../../src/main/files");
const { CommentService } = await import("../../src/main/comment-service");
const { DocumentStore } = await import("../../src/main/store");

const made: string[] = [];
const closing: (() => void)[] = [];
afterEach(() => {
  vi.useRealTimers();
  for (const close of closing.splice(0)) close();
  for (const dir of made.splice(0)) fs.rmSync(dir, { recursive: true, force: true });
});

/** plan.md open in tab-1, an agent asking to take it, and a window that hasn't answered the save yet. */
async function takeAsked() {
  const top = fs.mkdtempSync(path.join(tmpdir(), "corillo-flushing-"));
  made.push(top);
  const file = path.join(top, "plan.md");
  fs.writeFileSync(file, "# Plan\n");
  const asked: number[] = [];
  const send = (channel: string, ...args: unknown[]) => {
    if (channel === "agent:flush") asked.push(args[0] as number);
  };
  const docs = new Map<string, OpenDoc>();
  const doc: OpenDoc = { id: "tab-1", storeId: "plan", filePath: file, diskText: "# Plan\n" };
  docs.set(doc.id, doc);
  const agents = setUpAgents({ docs, openDocument: () => doc, readText, ...forAgents, send, picturesWait: () => {} }, new CommentService(new DocumentStore(path.join(top, "data")), () => {}));
  closing.push(() => agents.close());
  const { sessionId } = agents.service.connect({ name: "claude-code" });
  const take = agents.service.call(sessionId, "take_document", { path: file });
  while (!asked.length) await new Promise((r) => setImmediate(r));
  const answer = (result: string) => heard.get("agent:flushed")?.({}, asked[0], result);
  return { agents, take, answer };
}

describe("which tab is saving for an agent's take", () => {
  it("is that tab from the ask until the window answers, and no other", async () => {
    const { agents, take, answer } = await takeAsked();
    expect([agents.flushing("tab-1"), agents.flushing("tab-2")]).toEqual([true, false]);
    answer("saved");
    expect(agents.flushing("tab-1")).toBe(false);
    expect((await take).isError).toBe(false);
  });

  it("stays that tab after the ask times out, until the window's late answer", async () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    const { agents, take, answer } = await takeAsked();
    await vi.advanceTimersByTimeAsync(10_001);
    expect((await take).text).toContain("didn't answer in time");
    expect(agents.flushing("tab-1")).toBe(true); // its save may still be on its way
    answer("saved");
    expect(agents.flushing("tab-1")).toBe(false);
  });

  it("is no tab once the window is gone, which answers nothing", async () => {
    const { agents, take, answer } = await takeAsked();
    agents.windowGone();
    expect(agents.flushing("tab-1")).toBe(false);
    answer("saved"); // ends the take here rather than at its time-out
    await take;
  });
});
