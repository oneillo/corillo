// A small coquí hops on a tab while an agent works on it (roadmap Batch 9,
// item 13). Orlando: "Do we do any sort of animation when an agent is working
// on a tab? If not, can we do something cute on brand? Like the Coqui hopping
// or something?"
//
// While an agent holds a document, a small coquí in the agent's colour sits on
// its tab, where the ring was, and hops: one small hop every few seconds, with
// rest between. When the agent is done it goes, and the tab shows its dot as
// before. With one document open there is no tab bar, so the frog by "Claude
// is editing" at the top hops instead; with tabs, that one sits still. With
// Reduce Motion on, the frog sits still. Nothing runs for it once no agent
// holds a document. The frog is decoration: screen readers hear "Claude is
// editing", as before.
import { test, expect, type Page } from "@playwright/test";
import { openText, openAlso, tabState, type Running } from "./helpers";
import { AgentSession } from "./agent-session";

const PLAN = "# Plan\n\nWe should hire two people this quarter.\n\nThe budget is tight.\n";
const NOTES = "# Notes\n\nA few words.\n";

const tab = (page: Page, name: string) => page.locator(`.tab[title$="/${name}"]`);
const tabFrog = (page: Page, name: string) => tab(page, name).locator(".coqui-frog");
/** The frog by "Claude is editing" at the top of the document in front. */
const lineFrog = (page: Page) => page.locator(".doc:not([hidden]) .agent-notice .coqui-frog");

interface Hop {
  /** The file of the tab it's on, or "line" for the frog at the top. */
  where: string;
  at: number;
  ms: number;
}

/** From now on, note every hop: which frog, when, and how long it lasted. */
async function noteHops(page: Page): Promise<() => Promise<Hop[]>> {
  await page.evaluate(() => {
    const w = window as unknown as { hops: Hop[] };
    w.hops = [];
    const animate = Element.prototype.animate;
    Element.prototype.animate = function (this: Element, ...args: Parameters<Element["animate"]>) {
      if (this.classList.contains("coqui-frog")) {
        const tabEl = this.closest<HTMLElement>(".tab");
        const timing = args[1];
        w.hops.push({
          where: tabEl ? tabEl.title.split("\n").pop()!.split("/").pop()! : "line",
          at: performance.now(),
          ms: typeof timing === "number" ? timing : Number(timing?.duration ?? 0),
        });
      }
      return animate.apply(this, args);
    };
  });
  return () => page.evaluate(() => (window as unknown as { hops: Hop[] }).hops);
}

/** Animations running in the window now. */
const animating = (page: Page) => page.evaluate(() => document.getAnimations().length);

/** From now on, count every timer that fires and every frame asked for in the window. */
async function countWakes(page: Page): Promise<() => Promise<number>> {
  await page.evaluate(() => {
    const w = window as unknown as { woke: number };
    w.woke = 0;
    const frame = window.requestAnimationFrame.bind(window);
    window.requestAnimationFrame = (cb) => frame((t) => (w.woke++, cb(t)));
    const timer = window.setTimeout.bind(window);
    window.setTimeout = ((cb: (...a: unknown[]) => void, ms?: number, ...args: unknown[]) =>
      timer((...a: unknown[]) => (w.woke++, typeof cb === "function" && cb(...a)), ms, ...args)) as typeof window.setTimeout;
  });
  return () => page.evaluate(() => (window as unknown as { woke: number }).woke);
}

/** The colour the frog is painted in (its body), and what its outline is. */
function frogLook(frog: ReturnType<typeof tabFrog>): Promise<{ body: string; edge: string }> {
  return frog.evaluate((f) => ({
    body: getComputedStyle(f.querySelector(".frog-body")!).fill,
    edge: getComputedStyle(f.querySelector(".frog-edge")!).fill,
  }));
}

async function twoDocs(): Promise<Running> {
  const run = await openText(PLAN, { name: "plan.md" });
  await openAlso(run, "notes.md", NOTES);
  await expect.poll(() => tabState(run.page)).toEqual({ names: ["plan.md", "notes.md"], active: "notes.md" });
  return run;
}

test("while an agent holds a document, a small coquí in its colour sits on its tab and hops every few seconds, resting between; when it's done, the tab shows its dot as before", async () => {
  const run = await twoDocs();
  const { page } = run;
  const hops = await noteHops(page);
  // No agent: no frog anywhere.
  await expect(page.locator(".coqui-frog")).toHaveCount(0);
  const { session: claude } = await AgentSession.start(run.dataDir, "claude-code");
  try {
    await claude.ok("take_document", { path: run.file });
    // The frog sits where the ring was, on the plan's tab only, and is decoration: the tab's name says who is editing.
    await expect(tabFrog(page, "plan.md")).toBeVisible();
    await expect(tabFrog(page, "notes.md")).toHaveCount(0);
    await expect(tabFrog(page, "plan.md")).toHaveAttribute("aria-hidden", "true");
    await expect(tab(page, "plan.md").locator(".tab-dot")).toHaveAttribute("data-turn", "editing");
    await expect(tab(page, "plan.md").locator(".tab-dot")).toHaveAttribute("title", "Claude is editing");
    await expect(page.getByRole("tab", { name: "plan, Claude is editing", exact: true })).toBeVisible();
    // Small: about the size of the tab's words, and inside the tab.
    const box = (await tabFrog(page, "plan.md").boundingBox())!;
    const tabBox = (await tab(page, "plan.md").boundingBox())!;
    expect(box.width).toBeGreaterThanOrEqual(12);
    expect(box.width).toBeLessThanOrEqual(20);
    expect(box.height).toBeLessThanOrEqual(16);
    expect(box.y).toBeGreaterThanOrEqual(tabBox.y);
    expect(box.y + box.height).toBeLessThanOrEqual(tabBox.y + tabBox.height);
    // In Claude's colour, edged like the dot, and the same colour as the frog by "Claude is editing" in the plan.
    await expect(tabFrog(page, "plan.md")).toHaveAttribute("data-colour", "peach");
    const planId = await tab(page, "plan.md").getAttribute("data-doc-id");
    const inLine = page.locator(`.doc[data-doc-id="${planId}"] .agent-notice .coqui-frog`);
    const look = await frogLook(tabFrog(page, "plan.md"));
    expect(look).toEqual(await frogLook(inLine));
    expect(look.body).not.toBe(look.edge);

    // It hops: on the tab (the frog at the top sits still while there are tabs), a short hop every few seconds.
    await expect.poll(async () => (await hops()).length, { timeout: 15_000 }).toBeGreaterThanOrEqual(3);
    const seen = await hops();
    expect(new Set(seen.map((h) => h.where))).toEqual(new Set(["plan.md"]));
    for (const hop of seen) expect(hop.ms).toBeLessThanOrEqual(1000);
    for (let i = 1; i < seen.length; i++) {
      const gap = seen[i].at - seen[i - 1].at;
      expect(gap).toBeGreaterThanOrEqual(3000);
      expect(gap).toBeLessThanOrEqual(6000);
    }
    // Between hops it rests: nothing is moving.
    await page.waitForTimeout(1500);
    expect(await animating(page)).toBe(0);

    // Claude is done: the frog goes, and the tab shows the filled dot, as before.
    await claude.ok("finish_editing", { path: run.file });
    await expect(page.locator(".coqui-frog")).toHaveCount(0);
    await expect(tab(page, "plan.md").locator(".tab-dot")).toHaveAttribute("data-turn", "back");
    await expect(page.getByRole("tab", { name: "plan, back from Claude", exact: true })).toBeVisible();
    // And no more hops: nothing runs for it (once the hand-back's own work is done).
    await page.waitForTimeout(1000);
    const after = (await hops()).length;
    const woke = await countWakes(page);
    await page.waitForTimeout(5000);
    expect((await hops()).length).toBe(after);
    expect(await animating(page)).toBe(0);
    expect(await woke()).toBe(0);
  } finally {
    await claude.stop();
    await run.app.close();
  }
});

test("with one document open there's no tab bar, so the frog by \"Claude is editing\" hops; once a second document opens, the tab's frog hops and that one sits still", async () => {
  const run = await openText(PLAN, { name: "plan.md" });
  const { page } = run;
  const hops = await noteHops(page);
  const { session: claude } = await AgentSession.start(run.dataDir, "claude-code");
  try {
    await claude.ok("take_document", { path: run.file });
    // The line at the top says who, for screen readers too; its frog is decoration, in Claude's colour.
    const notice = page.locator(".doc:not([hidden]) .agent-notice");
    await expect(notice).toHaveAttribute("role", "status");
    await expect(notice).toContainText("Claude is editing");
    await expect(lineFrog(page)).toBeVisible();
    await expect(lineFrog(page)).toHaveAttribute("aria-hidden", "true");
    await expect(lineFrog(page)).toHaveAttribute("data-colour", "peach");
    // The frog is before the words, where the colour dot was, and about the line's text size.
    const frogBox = (await lineFrog(page).boundingBox())!;
    const wordsBox = (await notice.locator(".agent-notice-text").boundingBox())!;
    expect(frogBox.x + frogBox.width).toBeLessThanOrEqual(wordsBox.x);
    expect(frogBox.height).toBeLessThanOrEqual(20);
    await expect.poll(async () => (await hops()).length, { timeout: 8000 }).toBeGreaterThanOrEqual(1);
    expect(new Set((await hops()).map((h) => h.where))).toEqual(new Set(["line"]));

    // A second document: now there are tabs, and the plan's tab has the frog that hops.
    await openAlso(run, "notes.md", NOTES);
    await expect.poll(() => tabState(page)).toEqual({ names: ["plan.md", "notes.md"], active: "notes.md" });
    await tab(page, "plan.md").click();
    await expect(lineFrog(page)).toBeVisible();
    const before = (await hops()).length;
    await expect.poll(async () => (await hops()).length, { timeout: 12_000 }).toBeGreaterThanOrEqual(before + 2);
    expect(new Set((await hops()).slice(before).map((h) => h.where))).toEqual(new Set(["plan.md"]));
    await claude.ok("finish_editing", { path: run.file });
    await expect(page.locator(".coqui-frog")).toHaveCount(0);
  } finally {
    await claude.stop();
    await run.app.close();
  }
});

test("with Reduce Motion on in the Mac's settings, the frog sits still and nothing runs for it; turned off, it hops again", async () => {
  const run = await twoDocs();
  const { page } = run;
  await page.emulateMedia({ reducedMotion: "reduce" });
  const hops = await noteHops(page);
  const { session: claude } = await AgentSession.start(run.dataDir, "claude-code");
  try {
    await claude.ok("take_document", { path: run.file });
    await expect(tabFrog(page, "plan.md")).toBeVisible();
    await page.waitForTimeout(500);
    const woke = await countWakes(page);
    await page.waitForTimeout(6000);
    expect(await hops()).toEqual([]);
    expect(await animating(page)).toBe(0);
    expect(await woke()).toBe(0);
    // Reduce Motion turned off while the agent works: it starts hopping.
    await page.emulateMedia({ reducedMotion: "no-preference" });
    await expect.poll(async () => (await hops()).length, { timeout: 8000 }).toBeGreaterThanOrEqual(1);
    // And on again: it stops at once.
    await page.emulateMedia({ reducedMotion: "reduce" });
    await page.waitForTimeout(1000);
    const still = (await hops()).length;
    await page.waitForTimeout(5000);
    expect((await hops()).length).toBe(still);
    expect(await animating(page)).toBe(0);
    await expect(tabFrog(page, "plan.md")).toBeVisible();
  } finally {
    await claude.stop();
    await run.app.close();
  }
});
