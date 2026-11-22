// An agent's edit that the file refuses is told why in words it can act on
// (roadmap Batch 18, item 3, A16-1). When another app saves the document in
// the moment Corillo is writing the agent's edit, the edit is left out and
// the agent is told to read the file again and redo it. Any other failure to
// write keeps its own words. Runs Corillo's real link between the agents and
// the files (agents/host.ts) on a real file, with the window stood in for.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import * as fs from "node:fs";
import { tmpdir } from "node:os";
import * as path from "node:path";

// The window's answers come back through ipcMain: kept here so the stand-in window can answer.
const heard = vi.hoisted(() => new Map<string, (...args: unknown[]) => void>());
vi.mock("electron", () => ({
  app: { getPath: () => tmpdir(), on: () => {} },
  BrowserWindow: { getAllWindows: () => [] },
  clipboard: { writeText: () => {} },
  ipcMain: { handle: () => {}, on: (channel: string, fn: (...args: unknown[]) => void) => heard.set(channel, fn), removeHandler: () => {} },
}));

const { setUpAgents } = await import("../../src/main/agents/host");
const { writeDocument, writeSeams } = await import("../../src/main/files");
const { CommentService } = await import("../../src/main/comment-service");
const { DocumentStore } = await import("../../src/main/store");

const TEXT = "# Plan\n\nWe should hire two people this quarter.\n";
const CHANGED = "The file changed while your edit was being saved. Read it again and redo your edit.";

let folder: string;
let file: string;

beforeEach(() => {
  folder = fs.mkdtempSync(path.join(tmpdir(), "corillo-refused-"));
  file = path.join(folder, "plan.md");
  fs.writeFileSync(file, TEXT);
});

afterEach(() => {
  writeSeams.afterTemp = null;
  fs.rmSync(folder, { recursive: true, force: true });
});

/** Corillo's agents, with plan.md open and Claude holding it. */
async function claudeHoldingPlan() {
  type Doc = { id: string; storeId: string; filePath: string; diskText: string };
  const docs = new Map<string, Doc>();
  const agents = setUpAgents(
    {
      docs: docs as never,
      openDocument(filePath: string) {
        const doc = { id: "tab-1", storeId: "plan", filePath, diskText: fs.readFileSync(filePath, "utf8") };
        docs.set(doc.id, doc);
        return doc;
      },
      readText: (p: string) => fs.readFileSync(p, "utf8"),
      writeFileAtomic: writeDocument,
      created: () => {},
      saved: () => {},
      picturesWait: () => {},
      // The window has nothing unsaved: it answers each "save your pending edits" at once.
      send: (channel: string, ...args: unknown[]) => {
        if (channel === "agent:flush") heard.get("agent:flushed")?.({}, args[0], "saved");
      },
    },
    new CommentService(new DocumentStore(path.join(folder, "data")), () => {}),
  );
  const { sessionId } = agents.service.connect({ name: "claude-code" });
  const call = (tool: string, args: Record<string, unknown>) => agents.service.call(sessionId, tool, args);
  const took = await call("take_document", { path: file });
  expect(took.isError).toBe(false);
  return { call, close: () => agents.close() };
}

const edit = { path: "", edits: [{ find: "two people", replace: "three people" }] };

describe("an agent's edit the file refuses", () => {
  it("when another app saved the file meanwhile, the agent is told to read it again and redo its edit", async () => {
    const claude = await claudeHoldingPlan();
    const theirs = `${TEXT}\nA line another app added.\n`;
    // Another app saves the document just before Corillo's text would take its place.
    writeSeams.afterTemp = () => fs.writeFileSync(file, theirs);
    const refused = await claude.call("edit_document", { ...edit, path: file });
    writeSeams.afterTemp = null;
    expect(refused.isError).toBe(true);
    expect(refused.text).toContain(CHANGED);
    expect(refused.text).not.toContain("something went wrong");
    // The other app's save is kept, not written over.
    expect(fs.readFileSync(file, "utf8")).toBe(theirs);
    claude.close();
  });

  it("any other failure to write keeps its own words", async () => {
    const claude = await claudeHoldingPlan();
    writeSeams.afterTemp = () => {
      throw Object.assign(new Error("odd"), { code: "EWHATEVER" });
    };
    const refused = await claude.call("edit_document", { ...edit, path: file });
    writeSeams.afterTemp = null;
    expect(refused.isError).toBe(true);
    expect(refused.text).toContain("Your change to plan.md couldn't be saved: something went wrong writing the file. Nothing was changed.");
    expect(refused.text).not.toContain(CHANGED);
    expect(fs.readFileSync(file, "utf8")).toBe(TEXT);
    claude.close();
  });
});
