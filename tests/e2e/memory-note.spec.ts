// A line in Corillo's log when its programs pass 1 GB, and another once
// they're back under (roadmap Batch 10, item 3; W-6). The test makes Corillo
// believe it has passed (or gone back under) just before each thing that
// raises memory, and looks for the line each one writes. Throwaway documents
// and data only; the Mac's own Logs folder is never written to.
import { test, expect } from "@playwright/test";
import { existsSync, mkdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { openAlso, openText } from "./helpers";
import { AgentSession } from "./agent-session";

const PLAN = "# Plan\n\nWe should hire two people this quarter.\n";
const NOTES = "# Notes\n\nNothing yet.\n";

/** What the Mac's own Logs folder for Corillo holds before and after: nothing of the test's may land there. */
function macLogs(): string {
  const folder = join(homedir(), "Library", "Logs", "Corillo");
  const file = join(folder, "memory.log");
  if (existsSync(file)) return `memory.log, ${statSync(file).size} bytes, changed ${statSync(file).mtimeMs}`;
  return existsSync(folder) ? "the folder, no memory.log" : "no folder";
}

test("a document opened, the Markdown view shown, an agent's change and an export each look, and the line, counts and sizes only, goes in the test's own folder", async () => {
  const macBefore = macLogs();
  const run = await openText(PLAN, { name: "plan.md" });
  const plan = run.file;
  const log = join(run.dataDir, "Logs", "memory.log");
  const lines = () => (existsSync(log) ? readFileSync(log, "utf8").split("\n").filter(Boolean) : []);
  // Opening the first document looked already, and found Corillo well under 1 GB: nothing written.
  expect(lines()).toEqual([]);

  let written = 0;
  /** Corillo is made to believe it has just passed the limit (or gone back under), then `act` should write the line that says so. */
  const writes = async (what: string, act: () => Promise<unknown>) => {
    const passes = written % 2 === 0;
    await run.app.evaluate((_electron, limit) => {
      const settings = (globalThis as unknown as { corilloMemoryNote: { limit: number; every: number; after: number } }).corilloMemoryNote;
      settings.every = 0;
      // The look a moment later (the unit test's) waits, so each line here is the one `act` wrote.
      settings.after = 60_000;
      settings.limit = limit;
    }, passes ? 1 : 1024 ** 4);
    expect(lines(), `nothing before ${what}`).toHaveLength(written);
    await act();
    written++;
    await expect.poll(() => lines().length, { message: what }).toBe(written);
    expect(lines().at(-1), what).toMatch(passes ? /^\d{4}-\d\d-\d\d \d\d:\d\d:\d\d {2}Over / : /^\d{4}-\d\d-\d\d \d\d:\d\d:\d\d {2}Back under /);
  };

  await writes("a document opened", () => openAlso(run, "notes.md", NOTES));
  expect(lines().at(-1)).toContain(`2 documents open: ${PLAN.length}, ${NOTES.length} characters. 0 changes from agents in the last minute.`);
  expect(lines().at(-1)).toMatch(/ in all \(main [\d,]+ MB, .*window [\d,]+ MB/);

  await writes("the Markdown view shown", () => run.page.getByRole("button", { name: "Markdown", exact: true }).click());

  const { session: claude } = await AgentSession.start(run.dataDir, "claude-code");
  await claude.ok("open_document", { path: plan });
  await claude.ok("take_document", { path: plan });
  await writes("an agent's change arriving", () => claude.ok("edit_document", { path: plan, edits: [{ find: "two people", replace: "three people" }] }));
  expect(lines().at(-1)).toContain(`2 documents open: ${PLAN.length + 2}, ${NOTES.length} characters. 1 change from an agent in the last minute.`);
  await claude.ok("finish_editing", { path: plan });

  await writes("an export", () => claude.ok("export_document", { path: plan, format: "word" }));

  // Nothing else wrote: no look of its own.
  await run.page.waitForTimeout(1500);
  expect(lines()).toHaveLength(written);
  // Counts and sizes, never a name, a word of the documents or where they are.
  for (const never of ["plan", "notes", "Plan", "Notes", "people", "quarter", run.folder, run.dataDir, "/"]) {
    for (const line of lines()) expect(line).not.toContain(never);
  }
  await run.app.close();
  await claude.stop();
  expect(macLogs()).toBe(macBefore);
});

test("the log is kept to 64 KB however long Corillo runs: the newest half stays", async () => {
  const run = await openText(PLAN, { name: "plan.md" });
  const log = join(run.dataDir, "Logs", "memory.log");
  // A log nearly full from earlier days.
  const old = Array.from({ length: 1200 }, (_, i) => `2026-11-01 09:00:${String(i % 60).padStart(2, "0")}  Over 1 GB: earlier line ${i}.`).join("\n") + "\n";
  mkdirSync(join(run.dataDir, "Logs"), { recursive: true });
  writeFileSync(log, old);
  expect(statSync(log).size).toBeGreaterThan(58 * 1024);
  const markdown = run.page.getByRole("button", { name: "Markdown", exact: true });
  for (let i = 0; i < 40; i++) {
    const passes = i % 2 === 0;
    await run.page.getByRole("button", { name: "Formatted", exact: true }).click();
    await run.app.evaluate((_electron, limit) => {
      const settings = (globalThis as unknown as { corilloMemoryNote: { limit: number; every: number } }).corilloMemoryNote;
      settings.every = 0;
      settings.limit = limit;
    }, passes ? 1 : 1024 ** 4);
    await markdown.click();
    await expect.poll(() => readFileSync(log, "utf8").trimEnd().split("\n").at(-1)).toMatch(passes ? /  Over 0 MB: / : /  Back under /);
    expect(statSync(log).size).toBeLessThanOrEqual(64 * 1024);
  }
  const kept = readFileSync(log, "utf8");
  expect(kept).not.toContain("earlier line 0.");
  expect(kept).toContain("earlier line 1199.");
  expect(kept.split("\n").filter(Boolean).every((l) => /^\d{4}-\d\d-\d\d \d\d:\d\d:\d\d {2}(Over|Back under) /.test(l))).toBe(true);
  expect(kept.split("\n").filter((l) => / {2}(Over 0 MB|Back under 1024 GB): /.test(l))).toHaveLength(40);
  await run.app.close();
});
