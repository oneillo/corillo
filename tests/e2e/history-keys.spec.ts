// History by keys alone, and what a screen reader hears of its rows (roadmap
// Batch 12, item 3: G-3 from the keys-only review's K-3, and G-15's N-3
// from the accessibility review). The list of versions is one Tab stop, as the outline is: Up
// and Down move through the versions, Home and End go to the ends, Return
// shows one. Closing History puts the keyboard back in the page. Each row is
// named short (who, when, "current"), with the rest as its description. Each
// test runs the real app, hidden, on a throwaway document and data folder.
import { test, expect, type Page } from "@playwright/test";
import { rmSync } from "node:fs";
import { clickMenu, cursorAtEnd, expectFile, openText, settle, EDITOR, type Running } from "./helpers";
import { AgentSession } from "./agent-session";

const DOC = ".doc:not([hidden])";
const PANEL = `${DOC} .history-panel`;
const ROWS = `${PANEL} .history-item, ${PANEL} .history-member`;

/** Where the keyboard is: "document", "version" (the page shown), "row: <who>", or what else. */
const keyboard = (page: Page) =>
  page.evaluate(() => {
    const a = document.activeElement as HTMLElement | null;
    if (!a || a === document.body) return "nowhere";
    if (a.closest(".version-page")) return "version";
    if (a.closest(".ProseMirror")) return "document";
    if (a.matches(".history-item")) return `row: ${a.querySelector(".history-who")?.textContent ?? ""}`;
    return a.tagName.toLowerCase() + (a.className ? `.${a.className}` : "");
  });

/** Which rows a Tab can land on: the list is one stop. */
const tabStops = (page: Page) => page.locator(ROWS).evaluateAll((rows) => rows.filter((r) => (r as HTMLElement).tabIndex >= 0).length);

let run: Running | null = null;

test.afterEach(async () => {
  const r = run;
  run = null;
  if (!r) return;
  await r.app.evaluate(({ app }) => setTimeout(() => app.exit(0), 10)).catch(() => undefined);
  await r.app.close().catch(() => undefined);
  for (const dir of [r.folder, r.dataDir]) rmSync(dir, { recursive: true, force: true });
});

/** A history of four rows, newest first: You, Claude, You, First version. */
async function withHistory(): Promise<Running> {
  run = await openText("# Plan\n\nWe hire two people.\n\nThe budget is tight.\n", { name: "plan.md" });
  const { page } = run;
  await cursorAtEnd(page, "We hire two people.");
  await page.keyboard.type(" Soon.");
  await expectFile(run, "# Plan\n\nWe hire two people. Soon.\n\nThe budget is tight.\n");
  const { session } = await AgentSession.start(run.dataDir, "claude-code");
  await session.ok("take_document", { path: run.file, request: "Make it three." });
  await session.ok("edit_document", { path: run.file, edits: [{ find: "two people", replace: "three people" }] });
  await session.ok("finish_editing", { path: run.file });
  await session.stop();
  await expect(page.locator(EDITOR)).toContainText("three people");
  await cursorAtEnd(page, "The budget is tight.");
  await page.keyboard.type(" Very.");
  await expectFile(run, "# Plan\n\nWe hire three people. Soon.\n\nThe budget is tight. Very.\n");
  return run;
}

test("History's list is one Tab stop: Up and Down move through the versions, Home and End go to the ends, Return shows one, Escape comes back; closing History puts the keyboard back in the page", async () => {
  const { page } = await withHistory();
  await cursorAtEnd(page, "Very.");
  await page.getByRole("button", { name: "History", exact: true }).click();
  await expect.poll(() => page.locator(`${PANEL} .history-who`).allTextContents()).toEqual(["You", "Claude", "You", "First version"]);
  await expect.poll(() => tabStops(page)).toBe(1);
  // The keyboard reaches the list on its newest version (as F6 will bring it there).
  await page.locator(`${PANEL} .history-item[tabindex="0"]`).focus();
  await expect.poll(() => keyboard(page)).toBe("row: You");
  await page.keyboard.press("ArrowDown");
  await expect.poll(() => keyboard(page)).toBe("row: Claude");
  await page.keyboard.press("ArrowDown");
  await page.keyboard.press("ArrowDown");
  await expect.poll(() => keyboard(page)).toBe("row: First version");
  await page.keyboard.press("ArrowDown"); // the end: stays
  await expect.poll(() => keyboard(page)).toBe("row: First version");
  await page.keyboard.press("Home");
  await expect.poll(() => keyboard(page)).toBe("row: You");
  await page.keyboard.press("End");
  await expect.poll(() => keyboard(page)).toBe("row: First version");
  await page.keyboard.press("ArrowUp");
  await expect.poll(() => keyboard(page)).toBe("row: You");
  // Still one stop, on the row the keyboard was last on.
  await expect.poll(() => tabStops(page)).toBe(1);
  await expect(page.locator(`${PANEL} .history-item[tabindex="0"] .history-who`)).toHaveText("You");
  await page.keyboard.press("ArrowUp");
  await expect.poll(() => keyboard(page)).toBe("row: Claude");

  // Return shows Claude's version; Escape back to writing.
  await page.keyboard.press("Enter");
  await expect(page.locator(`${DOC} .version-banner`)).toContainText("(Claude)");
  await expect.poll(() => keyboard(page)).toBe("version");
  await page.keyboard.press("Escape");
  await expect(page.locator(`${DOC} .version-banner`)).toBeHidden();
  await expect.poll(() => keyboard(page)).toBe("document");

  // Closing History (Control-Command-H) with the keyboard on a row: back in the page, at the cursor.
  await page.locator(`${PANEL} .history-item[tabindex="0"]`).focus();
  await page.keyboard.press("ArrowDown");
  await page.keyboard.press("Control+Meta+h");
  await expect(page.locator(PANEL)).toBeHidden();
  await expect.poll(() => keyboard(page)).toBe("document");
  await page.keyboard.type("!");
  await expectFile(run!, "# Plan\n\nWe hire three people. Soon.\n\nThe budget is tight. Very.!\n");
  await settle(page);
});

// A change to how the person works (roadmap Batch 12, G-3): undone by reverting the commit "Changes how you work: opening History by its key...".
test("opening History by its key or the menu puts the keyboard on the newest version; with the mouse it stays in the page", async () => {
  const { page, app } = await withHistory();
  await cursorAtEnd(page, "Very.");
  await page.keyboard.press("Control+Meta+h");
  await expect.poll(() => page.locator(`${PANEL} .history-who`).allTextContents()).toEqual(["You", "Claude", "You", "First version"]);
  await expect.poll(() => keyboard(page)).toBe("row: You");
  await page.keyboard.press("ArrowDown");
  await expect.poll(() => keyboard(page)).toBe("row: Claude");
  await page.keyboard.press("Control+Meta+h");
  await expect(page.locator(PANEL)).toBeHidden();
  await expect.poll(() => keyboard(page)).toBe("document");
  // View > Show History: the same, on the newest again.
  await clickMenu(app, "view-history");
  await expect.poll(() => keyboard(page)).toBe("row: You");
  await clickMenu(app, "view-history");
  await expect.poll(() => keyboard(page)).toBe("document");
  // The toolbar's button pressed with Return: the same.
  await page.getByRole("button", { name: "History", exact: true }).focus();
  await page.keyboard.press("Enter");
  await expect.poll(() => keyboard(page)).toBe("row: You");
  await page.keyboard.press("Control+Meta+h");
  // Clicked with the mouse: the keyboard stays in the page.
  await cursorAtEnd(page, "Very.");
  await page.getByRole("button", { name: "History", exact: true }).click();
  await expect(page.locator(PANEL)).toBeVisible();
  await expect.poll(() => page.locator(`${PANEL} .history-who`).count()).toBe(4);
  await expect.poll(() => keyboard(page)).toBe("document");
});

test("History's rows have short names, who, when and whether it's current, with what they changed as their description", async () => {
  const { page } = await withHistory();
  await page.getByRole("button", { name: "History", exact: true }).click();
  await expect.poll(() => page.locator(`${PANEL} .history-who`).allTextContents()).toEqual(["You", "Claude", "You", "First version"]);
  const rows = page.locator(`${PANEL} .history-item`);
  await expect(rows.nth(0)).toHaveAccessibleName("You, Just now, current");
  await expect(rows.nth(1)).toHaveAccessibleName("Claude, Just now");
  await expect(rows.nth(3)).toHaveAccessibleName("First version, Just now");
  // What a row changed, and the request behind Claude's, are its description.
  await expect(rows.nth(0)).toHaveAccessibleDescription(/Very/);
  await expect(rows.nth(1)).toHaveAccessibleDescription(/Make it three\./);
  // The name keeps up as the newest moves on.
  await page.locator(`${EDITOR} .ProseMirror`).focus();
  await page.keyboard.press("Meta+ArrowDown");
  await page.keyboard.type(" More.");
  await page.keyboard.press("Meta+s");
  await expect.poll(() => rows.count()).toBeGreaterThanOrEqual(4);
  await expect(rows.first()).toHaveAccessibleName(/, current$/);
  await expect(page.locator(`${PANEL} .history-item[aria-label$="current"]`)).toHaveCount(1);
});

// Review of Batch 12, B12-4: F6 into History put the keyboard on Close, one Return from closing it, and Escape did
// nothing there. Last look, L-1: opened by its key after a click in the page, the newest version had no ring.
test("F6 into History lands on its list with the ring showing, and Escape there, or on Close, goes to the page", async () => {
  const { page } = await withHistory();
  const ringed = () => page.evaluate(() => {
    const a = document.activeElement as HTMLElement | null;
    return !!a && a.matches(":focus-visible") && getComputedStyle(a).outlineStyle !== "none";
  });
  await cursorAtEnd(page, "Very.");
  // By View > Show History (as a Command key reaches the menu on a real keyboard), the mouse last used (Bold clicked on
  // and off): the newest version, ringed at once.
  const bold = page.locator("#toolbar").getByRole("button", { name: "Bold", exact: true });
  await bold.click();
  await bold.click();
  await settle(page);
  await clickMenu(run!.app, "view-history");
  await expect.poll(() => keyboard(page)).toBe("row: You");
  expect(await ringed()).toBe(true);
  await page.keyboard.press("ArrowDown");
  await expect.poll(() => keyboard(page)).toBe("row: Claude");
  // Escape on a row, with no version shown: to the page, at the cursor.
  await page.keyboard.press("Escape");
  await expect.poll(() => keyboard(page)).toBe("document");
  await expect(page.locator(PANEL)).toBeVisible();
  // F6 from the page: the list's stop, the row last on, not Close.
  await page.keyboard.press("F6");
  await expect.poll(() => keyboard(page)).toBe("row: Claude");
  expect(await ringed()).toBe(true);
  // Shift-Tab to Close, and Escape there: the page too.
  await page.keyboard.press("Shift+Tab");
  await expect.poll(() => page.evaluate(() => document.activeElement?.getAttribute("aria-label"))).toBe("Close history");
  await page.keyboard.press("Escape");
  await expect.poll(() => keyboard(page)).toBe("document");
  await page.keyboard.type("!");
  await expectFile(run!, "# Plan\n\nWe hire three people. Soon.\n\nThe budget is tight. Very.!\n");

  // The first version, with nothing earlier to compare: Show changes isn't shown pressed, as nothing is marked
  // (last look of Batch 12, L-8). A later one, marked with what it changed: pressed, as before.
  const showChanges = page.locator("#toolbar").getByRole("button", { name: "Show changes", exact: true });
  await page.keyboard.press("F6");
  await page.keyboard.press("End");
  await expect.poll(() => keyboard(page)).toBe("row: First version");
  await page.keyboard.press("Enter");
  await expect(page.locator(`${DOC} .version-banner`)).toContainText("nothing earlier to compare");
  await expect(showChanges).toHaveAttribute("aria-pressed", "false");
  await expect(page.locator("#toolbar").getByRole("button", { name: "History", exact: true })).toHaveAttribute("aria-pressed", "true");
  await page.locator(`${PANEL} .history-item`, { hasText: "Claude" }).click();
  await expect(page.locator(`${DOC} .version-banner`)).toContainText("(Claude)");
  await expect(showChanges).toHaveAttribute("aria-pressed", "true");
});

// Review of Batch 12, B12-7: chosen from More with the mouse, History read as pressed by keys and took the keyboard.
test("in a narrow window, History chosen from More with the mouse leaves the keyboard in the page; by keys, on the newest version", async () => {
  const { page } = await withHistory();
  await page.setViewportSize({ width: 560, height: 700 });
  await settle(page);
  const more = page.getByRole("button", { name: "More", exact: true });
  await expect(more).toBeVisible();
  await expect(page.locator("#toolbar").getByRole("button", { name: "History", exact: true })).toBeHidden();
  await cursorAtEnd(page, "Very.");
  await more.click();
  await page.getByRole("menu", { name: "More" }).locator('button[aria-label="History"]').click();
  await expect.poll(() => page.locator(`${PANEL} .history-who`).count()).toBe(4);
  await settle(page);
  expect(await keyboard(page)).toBe("document");
  await page.keyboard.press("Control+Meta+h");
  await expect(page.locator(PANEL)).toBeHidden();
  // By keys: More opened with Return, History chosen with Return.
  await more.focus();
  await page.keyboard.press("Enter");
  const item = page.getByRole("menu", { name: "More" }).locator('button[aria-label="History"]');
  await item.focus();
  await page.keyboard.press("Enter");
  await expect.poll(() => keyboard(page)).toBe("row: You");
});
