// An agent's change written to a document whose file went and came back
// (the review of Batch 21, G21-17): Corillo has just written the file, so it
// no longer says the file is gone, and the tab is told, as when the person
// saves or the watcher sees it come back.
//
// Runs Corillo's real link between the agents and the files (agents/host.ts)
// and the real document on disk (doc-on-disk.ts) over a throwaway folder,
// with the window stood in for, as agent-write-refused.test.ts does.
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
const { forAgents, letGo, setUpDisk, watchFile } = await import("../../src/main/doc-on-disk");
const { readText } = await import("../../src/main/files");
const { CommentService } = await import("../../src/main/comment-service");
const { DocumentStore } = await import("../../src/main/store");

const TEXT = "# Plan\n\nWe should hire two people this quarter.\n";
const EDIT = { edits: [{ find: "two people", replace: "three people" }] };

const made: string[] = [];
const opened: OpenDoc[] = [];
const closing: (() => void)[] = [];
afterEach(() => {
  for (const close of closing.splice(0)) close();
  for (const doc of opened.splice(0)) letGo(doc);
  for (const dir of made.splice(0)) fs.rmSync(dir, { recursive: true, force: true });
});

/** plan.md open in Corillo, in a folder of its own, with Claude holding it. `watched`: with the watcher main.ts sets at open. */
async function claudeHoldingPlan(watched: boolean) {
  const top = fs.mkdtempSync(path.join(tmpdir(), "corillo-back-"));
  made.push(top);
  const folder = path.join(top, "project");
  fs.mkdirSync(folder);
  const file = path.join(folder, "plan.md");
  fs.writeFileSync(file, TEXT);
  const sent: string[] = [];
  const docs = new Map<string, OpenDoc>();
  const send = (channel: string, ...args: unknown[]) => {
    sent.push(channel);
    // The window has nothing unsaved: it answers each "save your pending edits" at once.
    if (channel === "agent:flush") heard.get("agent:flushed")?.({}, args[0], "saved");
  };
  setUpDisk({
    docs,
    send,
    notice: () => {},
    store: { idFor: () => "plan", created: () => {}, saved: () => {}, moved: () => {}, noticedMissing: () => {}, markEveryWebPictureWaits: () => {} } as never,
    recovery: { clear: () => {} } as never,
    historyHooks: { saved: () => {}, overwriting: () => {}, outside: () => {} } as never,
    replaceRecent: () => {},
    picturesWait: () => {},
    keepWaiting: () => {},
  });
  const doc: OpenDoc = { id: "tab-1", storeId: "plan", filePath: file, diskText: TEXT };
  docs.set(doc.id, doc);
  opened.push(doc);
  if (watched) watchFile(doc);
  const agents = setUpAgents({ docs, openDocument: () => doc, readText, ...forAgents, send, picturesWait: () => {} }, new CommentService(new DocumentStore(path.join(top, "data")), () => {}));
  closing.push(() => agents.close());
  const { sessionId } = agents.service.connect({ name: "claude-code" });
  const call = (tool: string, args: Record<string, unknown>) => agents.service.call(sessionId, tool, args);
  expect((await call("take_document", { path: file })).isError).toBe(false);
  return { call, doc, file, folder, sent };
}

describe("a document whose folder went and came back", () => {
  for (const watched of [true, false]) {
    it(`once an agent's change has been written to it, Corillo no longer says its file is gone (${watched ? "watched, as main.ts sets it at open" : "its watcher gone or never started"})`, async () => {
      const { call, doc, file, folder, sent } = await claudeHoldingPlan(watched);

      // The folder goes (a worktree taken away, a drive that left). The agent's edit is refused, and Corillo looks for the file.
      fs.rmSync(folder, { recursive: true, force: true });
      const refused = await call("edit_document", { path: file, ...EDIT });
      expect(refused.text).toContain("isn't where it was a moment ago");
      await expect.poll(() => doc.missing, { timeout: 8000 }).toBe(true);
      expect(sent).toContain("doc:missing"); // the tab says so

      // The folder comes back, the file with it, while Corillo stays in the background.
      fs.mkdirSync(folder);
      fs.writeFileSync(file, TEXT);
      await new Promise((r) => setTimeout(r, 1500)); // time for a watcher that still watches to notice

      // The agent tries again, as it was told to, and its change goes in.
      const edited = await call("edit_document", { path: file, ...EDIT });
      expect(edited.isError).toBe(false);
      expect(fs.readFileSync(file, "utf8")).toContain("three people");

      // Corillo itself has just written the file: it knows the file is there, and the tab is told.
      expect({ missing: doc.missing, tabTold: sent.includes("doc:found") }).toEqual({ missing: false, tabTold: true });
    }, 20_000);
  }
});
