// Hearing the coquí call (roadmap Batch 6, item 5). Orlando asked "How can I
// hear the coqui sound that plays when its your turn?": the only way was to
// wait for an agent's hand-back with Corillo behind another app. Now ticking
// Corillo > Sound When It's Your Turn plays the call once, whether or not
// Corillo is in front, as the Mac plays an alert sound when you pick it.
// Unticking plays nothing.
//
// No test makes a sound: in test runs the call is rendered off-line and only
// reported, and the window's speakers are replaced by a stand-in that counts.
import { test, expect, type ElectronApplication, type Page } from "@playwright/test";
import { rmSync } from "node:fs";
import { openText, clickMenu, type Running } from "./helpers";

interface Heard {
  seconds: number;
  peak: number;
}

/** Longer than a call takes to be played and reported. */
const CALL_WAIT_MS = 1000;

let run: Running | null = null;
test.afterEach(async () => {
  const r = run;
  run = null;
  const home = await r?.app.evaluate(() => process.env.CORILLO_HOME).catch(() => undefined);
  await r?.app.close().catch(() => undefined);
  for (const dir of [r?.folder, r?.dataDir, home]) if (dir) rmSync(dir, { recursive: true, force: true });
});

/** From now on, note each coquí call (rendered off-line in test runs). */
async function noteCalls(app: ElectronApplication): Promise<() => Promise<Heard[]>> {
  await app.evaluate(({ app: a }) => {
    const g = globalThis as unknown as { calls: Heard[] };
    g.calls = [];
    a.on("corillo-coqui" as never, ((heard: Heard) => g.calls.push(heard)) as never);
  });
  return () => app.evaluate(() => (globalThis as unknown as { calls: Heard[] }).calls);
}

/** Replace the window's speakers with a stand-in that counts: nothing in a test may reach them. */
async function noSpeakers(page: Page): Promise<() => Promise<number>> {
  await page.evaluate(() => {
    const w = window as unknown as { aloud: number; AudioContext: unknown };
    w.aloud = 0;
    w.AudioContext = class {
      constructor() {
        w.aloud++;
        throw new Error("No sound in tests.");
      }
    };
  });
  return () => page.evaluate(() => (window as unknown as { aloud: number }).aloud);
}

/** Corillo comes to the front, or goes behind another app, as the Mac tells it. */
async function inFront(app: ElectronApplication, front: boolean): Promise<void> {
  await app.evaluate(({ app: a }, f) => {
    a.emit(f ? "did-become-active" : "did-resign-active", { preventDefault: () => undefined });
  }, front);
}

const ticked = (app: ElectronApplication) =>
  app.evaluate(({ Menu }) => Menu.getApplicationMenu()?.getMenuItemById("turn-sound")?.checked ?? null);

test("ticking Corillo > Sound When It's Your Turn plays the call once, in front or behind; unticking plays nothing", async () => {
  run = await openText("# Plan\n\nWe meet on Friday.\n", { name: "plan.md" });
  const { app, page } = run;
  const speakers = await noSpeakers(page);
  const calls = await noteCalls(app);
  expect(await ticked(app)).toBe(true);

  // Corillo in front: unticking is silent, ticking plays the call once.
  await inFront(app, true);
  await clickMenu(app, "turn-sound");
  expect(await ticked(app)).toBe(false);
  await page.waitForTimeout(CALL_WAIT_MS);
  expect(await calls()).toHaveLength(0);
  await clickMenu(app, "turn-sound");
  expect(await ticked(app)).toBe(true);
  await expect.poll(async () => (await calls()).length).toBe(1);
  // The whole call: about a third of a second, soft.
  const [heard] = await calls();
  expect(heard.seconds).toBeGreaterThan(0.25);
  expect(heard.seconds).toBeLessThan(0.35);
  expect(heard.peak).toBeGreaterThan(0.1);
  expect(heard.peak).toBeLessThanOrEqual(0.16);

  // Corillo behind another app: the same.
  await inFront(app, false);
  await clickMenu(app, "turn-sound");
  await page.waitForTimeout(CALL_WAIT_MS);
  expect(await calls()).toHaveLength(1);
  await clickMenu(app, "turn-sound");
  await expect.poll(async () => (await calls()).length).toBe(2);
  await page.waitForTimeout(CALL_WAIT_MS);
  expect(await calls()).toHaveLength(2); // once, not again
  expect(await speakers()).toBe(0);
});
