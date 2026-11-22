// A test fails when the window throws (roadmap Batch 18, W16-13). Before, a
// test passed if a feature did its visible work and then threw: only one test
// listened. Now every run started with launch or openText (helpers.ts) keeps
// what its windows throw, from each window's first script on, relaunched ones
// included (Batch 19, R18-8), and closing the app fails the test. A test that
// throws on purpose takes its error out of `thrown` first.
import { test, expect } from "@playwright/test";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { launch, ONE_SCALE, openText, settle, type Running } from "./helpers";

let run: Running | undefined;
test.afterEach(async () => {
  await run?.app.close();
  run = undefined;
});

/** Throw in the window, outside anything that would catch it, as a fault in a feature would. */
async function plant(r: Running, how: "throw" | "reject"): Promise<void> {
  await r.page.evaluate((h) => {
    if (h === "throw") setTimeout(() => { throw new Error("planted fault"); }, 0);
    else void Promise.reject(new Error("planted rejection"));
  }, how);
  await settle(r.page);
}

// Expected to fail: the only thing in it that can fail is the check at close.
test.fail("a planted throw in the window fails the test that closes the app", async () => {
  run = await openText("# Plan\n\nWords.\n");
  await plant(run, "throw");
  await expect.poll(() => run!.thrown!.length).toBe(1);
  await run.app.close();
  run = undefined;
});

// Expected to fail too: a test that quits Corillo itself never closes the app, and is checked as its process ends (the review of Batch 19, R19-11).
test.fail("a planted throw in the window fails a test that ends by quitting Corillo", async () => {
  const quitting = await openText("# Plan\n\nWords.\n");
  await plant(quitting, "throw");
  await expect.poll(() => quitting.thrown!.length).toBe(1);
  const exited = new Promise((resolve) => quitting.app.process().once("exit", resolve));
  await quitting.app.evaluate(({ app }) => app.quit());
  await exited;
});

test("what the window threw is kept, by name, until the test closes the app", async () => {
  run = await openText("# Plan\n\nWords.\n");
  expect(run.thrown!).toEqual([]);
  await plant(run, "throw");
  await plant(run, "reject");
  await expect.poll(() => run!.thrown!.length).toBe(2);
  expect(run.thrown![0]).toContain("Error: planted fault");
  expect(run.thrown![1]).toContain("Error: planted rejection");
  run.thrown!.length = 0; // thrown on purpose: forgiven, so this test passes
});

/**
 * Started with this file, Corillo's document window throws in its first
 * script, before anything else of the page runs (and then runs on): its
 * script is served with a line in front that reports an uncaught error.
 */
function throwInFirstScript(): string {
  const file = join(mkdtempSync(join(tmpdir(), "corillo-plant-")), "plant.cjs");
  writeFileSync(file, `
const { app, protocol, net } = require("electron");
const { readFileSync } = require("node:fs");
const { fileURLToPath } = require("node:url");
const { createHash } = require("node:crypto");
const hash = (text) => "sha256-" + createHash("sha256").update(text).digest("base64");
const planted = 'addEventListener("planted", () => { throw new Error("planted in the first script"); }); dispatchEvent(new Event("planted"));\\n';
app.whenReady().then(() => {
  protocol.handle("file", (request) => {
    const url = request.url;
    if (!url.endsWith("/dist/app.js") && !url.endsWith("/dist/index.html")) return net.fetch(request, { bypassCustomProtocolHandlers: true });
    const dist = fileURLToPath(url).replace(/[^/]+$/, "");
    const script = readFileSync(dist + "app.js", "utf8");
    if (url.endsWith("app.js")) return new Response(planted + script, { headers: { "content-type": "text/javascript" } });
    // The page lets only its own script run, by hash: let the planted one run instead.
    const page = readFileSync(dist + "index.html", "utf8").split(hash(script)).join(hash(planted + script));
    return new Response(page, { headers: { "content-type": "text/html" } });
  });
});
`);
  return file;
}

test("a throw in the window's first script, as Corillo starts, is kept: listening starts before the page runs", async () => {
  const dataDir = mkdtempSync(join(tmpdir(), "corillo-data-"));
  writeFileSync(join(dataDir, "setup.json"), '{ "connectAgentsOffered": true }\n');
  const { app, thrown } = await launch({
    args: ["-r", throwInFirstScript(), ONE_SCALE, "."],
    env: { ...process.env, CORILLO_USER_DATA: dataDir, CORILLO_HIDDEN: "1", CORILLO_HOME: mkdtempSync(join(tmpdir(), "corillo-home-")) },
  });
  const page = await app.firstWindow();
  await page.waitForSelector("#empty");
  await expect.poll(() => thrown.length).toBe(1);
  expect(thrown[0]).toContain("Error: planted in the first script");
  thrown.length = 0; // thrown on purpose: forgiven, so this test passes
  await app.close();
});

test("a throw in a window Corillo opens again, on the same document, is kept too", async () => {
  const first = await openText("# Plan\n\nWords.\n");
  await first.app.close();
  const { app, thrown } = await launch({
    args: [ONE_SCALE, ".", first.file],
    env: { ...process.env, CORILLO_USER_DATA: first.dataDir, CORILLO_HIDDEN: "1", CORILLO_HOME: mkdtempSync(join(tmpdir(), "corillo-home-")) },
  });
  run = { ...first, app, page: await app.firstWindow(), thrown };
  await run.page.waitForSelector(".ProseMirror");
  await plant(run, "throw");
  await expect.poll(() => thrown.length).toBe(1);
  expect(thrown[0]).toContain("Error: planted fault");
  thrown.length = 0; // thrown on purpose: forgiven, so this test passes
});
