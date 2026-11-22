// A standing test (roadmap Batch 12, item 3): in each main state of the window,
// Tab walks every control, in the order the areas sit on screen, with a focus
// you can see: at every stop, the look the keyboard brings is measured at 3
// to 1 or more in light and in dark (review of Batch 12, B12-3; any shadow
// used to count). At the page's text, which keeps Tab for indenting, the walk
// steps past with F6, as a person would. Runs the real app, hidden, on
// throwaway documents.
import { test, expect, type Page } from "@playwright/test";
import { clickMenu, openAlso, openText, selectText, settle, tabState, type Running } from "./helpers";
import { AgentSession } from "./agent-session";
import { AREA_ORDER, unseen, walkWindow, type AreaName } from "./tab-walk";

const DOC = ["# Offsite plan", "", "We should hire two people this quarter.", "", "## Budget", "", "The budget is tight.", "", "## Lunch", "", "Lunch is at noon, in the garden.", ""].join("\n");

let run: Running | null = null;
test.afterEach(async () => {
  await run?.app.close();
  run = null;
});

/** Walk the window in this state: everything reached, in order, each focus seen, and round to the start. */
async function walkIn(page: Page, state: string, needs: AreaName[]): Promise<void> {
  await settle(page);
  const walk = await walkWindow(page);
  const where = `${state}: ${walk.areas.join(" > ")}`;
  if (process.env.WALK_DEBUG) console.log(state, JSON.stringify(walk.stops.map((s) => `${s.area}: ${s.what} [${s.shows}${s.visible ? "" : ", not visible"}]`), null, 1));
  expect(walk.trapped, `${state}: Tab can't leave`).toEqual([]);
  expect(walk.missed, `${state}: never reached`).toEqual([]);
  expect(unseen(walk), `${state}: focus not seen`).toEqual([]);
  expect(walk.cameRound, `${state}: came round`).toBe(true);
  // F6 took the keyboard out of the page's text, to an area after it.
  for (const landed of walk.f6) expect(AREA_ORDER.indexOf(landed as (typeof AREA_ORDER)[number]), `${state}: F6 from the page went to ${landed}`).toBeGreaterThan(AREA_ORDER.indexOf("page"));
  for (const area of needs) expect(walk.areas, where).toContain(area);
  // Each area once, in the order they sit on screen.
  const ranks = walk.areas.map((a) => AREA_ORDER.indexOf(a as (typeof AREA_ORDER)[number]));
  if (!needs.some((a) => a === "start screen" || a === "dialog")) {
    expect(ranks.every((r) => r >= 0), where).toBe(true);
    expect(ranks, where).toEqual([...ranks].sort((a, b) => a - b));
    expect(new Set(walk.areas).size, where).toBe(walk.areas.length);
  }
}

async function comment(page: Page, words: string, text: string): Promise<void> {
  await selectText(page, words);
  await page.keyboard.press("Meta+Alt+m");
  await page.keyboard.type(text);
  await page.keyboard.press("Meta+Enter");
  await expect(page.locator(".doc:not([hidden]) .comment-card:not(.draft)", { hasText: text })).toBeVisible();
}

test("Tab walks every control in order with a visible focus: with comments, Find, the outline, the Markdown view, the start screen", async () => {
  run = await openText(DOC, { name: "plan.md" });
  const { page } = run;
  await openAlso(run, "notes.md", "# Notes\n");
  await page.keyboard.press("Control+Shift+Tab");
  await expect.poll(async () => (await tabState(page)).active).toBe("plan.md");
  await expect.poll(() => page.evaluate(() => !!document.activeElement?.closest(".doc:not([hidden]) .ProseMirror"))).toBe(true); // a frame after it comes to the front
  await comment(page, "two people", "Make it three.");
  await walkIn(page, "with comments", ["tabs", "toolbar", "page", "side panel", "status bar"]);

  await page.keyboard.press("Meta+f");
  await page.keyboard.type("budget");
  await walkIn(page, "Find", ["toolbar", "find bar", "page", "side panel", "status bar"]);
  await page.locator(".find-bar .find-done").click();

  await page.keyboard.press("Control+Meta+o");
  await expect(page.locator(".doc:not([hidden]) .outline-pane")).toBeVisible();
  await walkIn(page, "outline", ["toolbar", "outline", "page", "side panel", "status bar"]);
  await page.keyboard.press("Control+Meta+o");

  await page.keyboard.press("Meta+/");
  await expect(page.locator(".doc:not([hidden]) textarea.source")).toBeVisible();
  const before = run.text();
  await walkIn(page, "Markdown view", ["toolbar", "page", "side panel", "status bar"]);
  expect(run.text()).toBe(before); // the walk typed nothing into the text

  await page.keyboard.press("Meta+w");
  await page.keyboard.press("Meta+w");
  await expect(page.locator("#empty")).toBeVisible();
  await walkIn(page, "start screen", ["start screen"]);
});

test("Tab walks every control in order with a visible focus: Claude done with an option, Show changes, History, a dialog", async () => {
  run = await openText(DOC, { name: "plan.md" });
  const { page, app } = run;
  await comment(page, "two people", "Make it three.");
  const { session: claude } = await AgentSession.start(run.dataDir, "claude-code");
  try {
    const listed = await claude.ok("take_document", { path: run.file });
    const id = /\[([^\]]+)\] on "two people"/.exec(listed)![1];
    await claude.ok("reply_to_comment", {
      path: run.file,
      comment_id: id,
      text: "Three is more than the budget allows. Would one of these do?",
      options: [
        { label: "Two, then a third", edits: [{ find: "hire two people", replace: "hire two people, then a third" }] },
        { label: "Three by summer", edits: [{ find: "hire two people this quarter", replace: "hire three people by summer" }] },
      ],
    });
    await claude.ok("edit_document", { path: run.file, edits: [{ find: "The budget is tight.", replace: "The budget is tight, so we hire slowly." }] });
    await claude.ok("finish_editing", { path: run.file });
  } finally {
    await claude.stop();
  }
  await expect(page.locator(".doc:not([hidden]) .comment-option-buttons button").first()).toBeVisible();
  await walkIn(page, "Claude done with an option", ["toolbar", "page", "side panel", "status bar"]);

  await clickMenu(app, "view-changes");
  await expect(page.locator(".doc:not([hidden]) .version-view")).toBeVisible();
  await walkIn(page, "Show changes", ["toolbar", "line at the top", "side panel", "status bar"]);
  await clickMenu(app, "view-changes");

  await clickMenu(app, "view-history");
  await expect(page.locator(".doc:not([hidden]) .history-panel")).toBeVisible();
  await walkIn(page, "History", ["toolbar", "page", "side panel", "status bar"]);
  await clickMenu(app, "view-history");

  await clickMenu(app, "export-settings");
  await expect(page.getByRole("dialog", { name: "Export settings" })).toBeVisible();
  await walkIn(page, "a dialog", ["dialog"]);
  await page.keyboard.press("Escape");
});
