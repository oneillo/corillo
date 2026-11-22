// A test run keeps everything it makes in its own folder, removed when the run
// ends (tests/run-folder.ts): the tests' documents and data folders, and what
// Corillo and Chromium put in the temporary folder while a test runs them.
import { test, expect } from "@playwright/test";
import { spawnSync } from "node:child_process";
import { mkdtempSync, readlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openText } from "./helpers";
import { AgentSession } from "./agent-session";

test("a test's documents, data folder, and Corillo's own temporary files all go in the run's folder", async () => {
  const runFolder = tmpdir();
  expect(runFolder).toMatch(/\/corillo-run-\d+-[^/]+$/);
  const run = await openText("# Plan\n\nSome words.\n");
  for (const made of [run.folder, run.dataDir]) expect(made.startsWith(runFolder + "/")).toBe(true);
  const app = await run.app.evaluate(({ app }) => ({
    node: process.getBuiltinModule("node:os").tmpdir(),
    chromium: app.getPath("temp"),
  }));
  expect(app.node).toBe(runFolder);
  expect(app.chromium.replace(/\/$/, "")).toBe(runFolder);
  // Chromium's lock against a second copy of the app: a socket in the temporary folder.
  expect(readlinkSync(join(run.dataDir, "SingletonSocket")).startsWith(runFolder + "/")).toBe(true);
  await run.app.close();
});

test("a Corillo started by an agent's connector puts Chromium's temporary files in the run's folder too", async () => {
  // The connector keeps Chromium's own temporary-folder setting (MAC_CHROMIUM_TMPDIR, which Chromium on the Mac
  // uses instead of TMPDIR) for the Corillo it starts, so that Corillo's lock socket and other temporary files
  // go in the run's folder with everything else.
  const runFolder = tmpdir();
  const dataDir = mkdtempSync(join(runFolder, "corillo-data-"));
  const plan = join(mkdtempSync(join(runFolder, "corillo-doc-")), "plan.md");
  writeFileSync(plan, "# Plan\n");
  const { session } = await AgentSession.start(dataDir);
  let pid = 0;
  try {
    expect(await session.ok("open_document", { path: plan })).toContain("plan.md is open in Corillo");
    pid = Number(/process (\d+)/.exec(session.stderr)?.[1]);
    expect(pid).toBeGreaterThan(0);
    expect(readlinkSync(join(dataDir, "SingletonSocket")).startsWith(runFolder + "/")).toBe(true);
  } finally {
    if (pid) process.kill(pid, "SIGTERM");
    await session.stop();
  }
});

test("a test's Corillo keeps the graphics engine's caches off the disk, so a start leaves little in its data folder (Batch 21, C21-10)", async () => {
  const run = await openText("# Plan\n\nSome words.\n\n| a | b |\n| --- | --- |\n| 1 | 2 |\n");
  await expect(run.page.locator(".ProseMirror table")).toBeVisible();
  await run.page.waitForTimeout(500);
  await run.app.close();
  // Today about 7.6 MB, nearly all of it caches (GraphiteDawnCache alone 5.6 MB); with them off, about 0.3 MB.
  const kb = Number(spawnSync("/usr/bin/du", ["-sk", run.dataDir], { encoding: "utf8" }).stdout.split("\t")[0]);
  expect(kb).toBeLessThan(2048);
});
