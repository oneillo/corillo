// Whose turn it is, by the keyboard (roadmap Batch 24, rows 21 and 22 of
// review/batch-24/findings.md):
// - typing while Claude edits changes nothing, but now says why, on the
//   page's line and to a screen reader, and points to Take over (W-13);
// - Take over, from the line's button or Review > Take Over (Control-Command-T),
//   says "The document is yours again" and puts the keyboard in the page,
//   where the cursor was (K-7).
import { test, expect } from "@playwright/test";
import { openText, openAlso, cursorAtEnd, clickMenu, tabState, selectText, EDITOR } from "./helpers";
import { AgentSession } from "./agent-session";

const DOC = ".doc:not([hidden])";
const EDITING = `${DOC} .agent-notice`;
const PLAN = "# Plan\n\nWe should hire two people this quarter.\n\nThe budget is tight.\n";

/** Everything read out to a screen reader just now: the window's live regions. */
const saidAloud = (page: import("@playwright/test").Page) =>
  page.evaluate(() => [...document.querySelectorAll('[role="status"]')].map((e) => e.textContent ?? "").join(" | "));

test("typing while Claude edits says why nothing happens, and Take over gives the keyboard back to the page, said aloud", async () => {
  const run = await openText(PLAN, { name: "plan.md" });
  const { page, app } = run;
  const { session: claude } = await AgentSession.start(run.dataDir, "claude-code");
  try {
    // Row 21: a letter typed on the page while Claude has it.
    await cursorAtEnd(page, "tight.");
    await claude.ok("take_document", { path: run.file });
    await expect(page.locator(EDITING)).toContainText("Claude is editing");
    await expect(page.locator(`${EDITING} .agent-notice-hint`)).toHaveText("You can read and comment meanwhile.");
    await page.locator(`${EDITOR} p`).filter({ hasText: "tight" }).click();
    // Space, pressed to scroll while reading, isn't typing: the calm words stay (review of Batch 24, R24-2).
    await page.keyboard.press("Space");
    await expect(page.locator(`${EDITOR} p`).filter({ hasText: "tight" })).toHaveText("The budget is tight.");
    await expect(page.locator(`${EDITING} .agent-notice-hint`)).toHaveText("You can read and comment meanwhile.");
    await page.keyboard.type("x");
    await expect(page.locator(`${EDITOR} p`).filter({ hasText: "tight" })).toHaveText("The budget is tight.");
    // Words that say the keys did nothing, not that they wait (review of Batch 24, R24-2).
    const why = "You can't type while Claude is editing. Take over to edit now.";
    await expect(page.locator(`${EDITING} .agent-notice-hint`)).toHaveText(why);
    await expect.poll(() => saidAloud(page)).toContain(why);
    expect(await page.locator(EDITING).getAttribute("title")).toContain(why);

    // Row 22: Take over from the menu bar (Control-Command-T) with the keyboard on the status bar.
    await page.locator("#comments-toggle").focus();
    await clickMenu(app, "take-over");
    await expect(page.locator(EDITING)).toBeHidden();
    await expect.poll(() => saidAloud(page)).toContain("The document is yours again.");
    await expect.poll(() => page.evaluate(() => !!document.activeElement?.closest(".ProseMirror"))).toBe(true);
    await page.keyboard.type("!");
    await expect(page.locator(`${EDITOR} p`).filter({ hasText: "tight" })).toContainText("!");

    // The next pass starts with the calm words again; Take over by its button says the same.
    await claude.ok("take_document", { path: run.file });
    await expect(page.locator(`${EDITING} .agent-notice-hint`)).toHaveText("You can read and comment meanwhile.");
    await page.locator(EDITING).getByRole("button", { name: "Take over" }).click();
    await expect(page.locator(EDITING)).toBeHidden();
    await expect.poll(() => page.evaluate(() => !!document.activeElement?.closest(".ProseMirror"))).toBe(true);
    await expect.poll(() => saidAloud(page)).toContain("The document is yours again.");
  } finally {
    await run.app.close();
    await claude.stop();
  }
});

test("closing a tab whose neighbour shows an older version puts the keyboard on that version, not nowhere (row 24)", async () => {
  const run = await openText(PLAN, { name: "plan.md" });
  const { page, app } = run;
  try {
    await cursorAtEnd(page, "tight.");
    await page.keyboard.type(" Very.");
    await expect.poll(() => run.text()).toContain("Very.");
    await page.getByRole("button", { name: "History", exact: true }).click();
    await page.locator(".doc:not([hidden]) .history-item").filter({ hasText: "First version" }).click();
    await expect(page.locator(`${DOC} .version-page`)).toBeVisible();
    await openAlso(run, "notes.md", "Notes.\n");
    await expect.poll(() => tabState(page)).toMatchObject({ active: "notes.md" });
    await clickMenu(app, "close-tab");
    await expect.poll(() => tabState(page)).toMatchObject({ active: "plan.md" });
    await expect(page.locator(`${DOC} .version-page`)).toBeVisible();
    await expect.poll(() => page.evaluate(() => !!document.activeElement?.closest(".version-page"))).toBe(true);
  } finally {
    await run.app.close();
  }
});

test("in the narrowest window the status bar keeps whose turn it is whole; the section's name gives way first (row 27)", async () => {
  const words = Array.from({ length: 100 }, () => "Many more words here.").join(" ");
  const run = await openText(`# A shared history of the neighbourhood garden\n\nWe should hire two people this quarter.\n\nThe budget is tight.\n\n${words}\n`, { name: "plan.md" });
  const { page, app } = run;
  const { session: claude } = await AgentSession.start(run.dataDir, "claude-code");
  try {
    await claude.ok("take_document", { path: run.file });
    await claude.ok("add_comment", { path: run.file, quote: "budget", text: "How tight is it?" });
    await claude.ok("finish_editing", { path: run.file });
    await expect(page.locator("#turn-status")).toHaveText("With you · 1 to read");
    await clickMenu(app, "view-outline");
    const cut = (selector: string) => page.locator(selector).evaluate((e: HTMLElement) => (e.hidden || !e.checkVisibility() ? "gone" : e.scrollWidth > e.clientWidth + 0.5 ? "cut" : "whole"));
    await page.setViewportSize({ width: 1440, height: 700 });
    await expect.poll(() => cut("#outline-section")).toBe("whole");
    await expect.poll(() => cut(".turn-who")).toBe("whole");
    // One word selected: the count says "1 of 418 words", as with a match found (W-21).
    await selectText(page, "quarter");
    await expect(page.locator("#word-count")).toContainText("1 of");
    await page.setViewportSize({ width: 560, height: 700 });
    await expect.poll(() => cut(".turn-who")).toBe("whole");
    expect(await cut("#outline-section")).not.toBe("whole");
    // Wide again, the section's name comes back.
    await page.setViewportSize({ width: 1440, height: 700 });
    await expect.poll(() => cut("#outline-section")).toBe("whole");

    // Claude waiting for his review, a second comment, two words selected: the turn's longer words stay
    // whole at 560 too, Copy path giving way after the section (review of Batch 24, R24-4).
    await claude.ok("add_comment", { path: run.file, quote: "two people", text: "Three?" });
    const wait = claude.waitForReview({ paths: [run.file] });
    await expect(page.locator("#turn-status")).toContainText("Claude is waiting for your review");
    await selectText(page, "should hire");
    await expect(page.locator("#word-count")).toContainText("2 of");
    await page.setViewportSize({ width: 560, height: 700 });
    await expect.poll(() => cut(".turn-who")).toBe("whole");
    expect(await cut("#outline-section")).toBe("gone");
    expect(await cut("#copy-path")).toBe("gone");
    // Wide again, both come back.
    await page.setViewportSize({ width: 1440, height: 700 });
    await expect.poll(() => cut("#copy-path")).toBe("whole");
    await expect.poll(() => cut("#outline-section")).toBe("whole");
    expect(wait.answered()).toBe(false);
  } finally {
    await run.app.close();
    await claude.stop();
  }
});

test("the keyboard on the side panel's width line shows a ring like every other control's, nothing over it (row 30)", async () => {
  const run = await openText(PLAN, { name: "plan.md" });
  const { page } = run;
  try {
    const handle = page.locator(`${DOC} .side-handle.comments-handle`);
    await expect(handle).toBeVisible();
    await handle.focus();
    const seen = await handle.evaluate((h) => {
      const s = getComputedStyle(h);
      const r = h.getBoundingClientRect();
      // Both sides of the ring near its ends (clear of its round corners): the line itself is on top there, not the panel's heading or anything else.
      const corners = [
        [r.left + 1, r.top + 6],
        [r.right - 1, r.top + 6],
        [r.left + 1, r.bottom - 6],
        [r.right - 1, r.bottom - 6],
      ].map(([x, y]) => document.elementFromPoint(x, y) === h);
      return { focusVisible: h.matches(":focus-visible"), outline: s.outlineStyle, width: parseFloat(s.outlineWidth), offset: parseFloat(s.outlineOffset), onTop: corners };
    });
    expect(seen.focusVisible).toBe(true);
    expect(seen.outline).toBe("solid");
    expect(seen.width).toBeGreaterThanOrEqual(2);
    expect(seen.offset).toBeLessThanOrEqual(-seen.width); // drawn inside its box, so no edge of it is cut off
    expect(seen.onTop).toEqual([true, true, true, true]);
  } finally {
    await run.app.close();
  }
});
