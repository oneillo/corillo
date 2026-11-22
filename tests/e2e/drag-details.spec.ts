// The details at the top of a document (its front matter) stay first in the file whatever is dragged
// (spec.md, Look and feel: "nothing is written above front matter"; code review of Batch 16, W16-1).
// A block dropped at the very top lands just under the details; the details themselves can't be dragged.
import { test, expect, type Locator, type Page } from "@playwright/test";
import { copyFileSync } from "node:fs";
import { join } from "node:path";
import { launchSettled, openText, settle, EDITOR, FIXTURES } from "./helpers";
import { tidyRuns } from "./tidy";

const tidy = tidyRuns();
const DETAILS = "---\ntitle: Plan\nowner: Ana\n---";
const TEXT = [DETAILS, "# Heading", "First paragraph here.", "Second paragraph here.", "![Chart](chart.png)", "Third paragraph here.", ""].join("\n\n");

/** The page's blocks, by their first words. */
const blocks = (page: Page) =>
  page.evaluate(
    (editor) =>
      [...document.querySelectorAll<HTMLElement>(`${editor} .ProseMirror > *`)].map((b) =>
        b.matches("pre.raw-block") ? "(details)" : b.querySelector("img[data-src]") ? "(picture)" : (b.textContent ?? "").slice(0, 22),
      ),
    EDITOR,
  );

/** Press inside `from` and let go at the top edge of the first block, or the bottom edge of the last. */
async function drag(page: Page, from: Locator, to: "top" | "bottom"): Promise<void> {
  const box = (await from.boundingBox())!;
  const all = page.locator(`${EDITOR} .ProseMirror > *`);
  const target = (await (to === "top" ? all.first() : all.last()).boundingBox())!;
  const x = box.x + Math.min(60, box.width / 2);
  const y = box.y + box.height / 2;
  const endY = to === "top" ? target.y + 2 : target.y + target.height - 2;
  await page.mouse.move(x, y);
  await page.mouse.down();
  await page.mouse.move(x + 4, y - 6, { steps: 4 });
  await page.mouse.move(target.x + 60, endY, { steps: 12 });
  await page.waitForTimeout(150);
  await page.mouse.move(target.x + 61, endY);
  await page.waitForTimeout(150);
  await page.mouse.up();
  await settle(page);
}

async function open() {
  const run = tidy.keep(await openText(TEXT, { name: "plan.md", prepare: (folder) => copyFileSync(join(FIXTURES, "chart.png"), join(folder, "chart.png")) }));
  await launchSettled(run.app);
  await expect(run.page.locator(`${EDITOR} img[data-src]`).first()).toBeVisible();
  return run;
}

/** Saved, and what the file holds. */
async function saved(page: Page, read: () => string): Promise<string> {
  await page.keyboard.press("ArrowRight"); // a key, as a person carries on
  await expect(page.locator("#save-status")).toHaveAttribute("data-state", "saved", { timeout: 15_000 });
  await page.waitForTimeout(600);
  return read();
}

test("a picture dragged to the very top lands just under the details, and the file still starts with them; Undo puts it back", async () => {
  const run = await open();
  const picture = run.page.locator(`${EDITOR} img[data-src]`).first();
  await picture.click();
  await drag(run.page, picture, "top");
  expect(await blocks(run.page)).toEqual([
    "(details)",
    "(picture)",
    "Heading",
    "First paragraph here.",
    "Second paragraph here.",
    "", // the picture's paragraph, now empty: an empty line, as in Word
    "Third paragraph here.",
  ]);
  const file = await saved(run.page, run.text);
  expect(file.startsWith(`${DETAILS}\n\n![Chart](chart.png)\n\n# Heading`), file.slice(0, 80)).toBe(true);
  await run.page.keyboard.press("Meta+z");
  await expect.poll(() => blocks(run.page)).toEqual([
    "(details)",
    "Heading",
    "First paragraph here.",
    "Second paragraph here.",
    "(picture)",
    "Third paragraph here.",
  ]);
});

test("a paragraph Command-clicked and dragged to the very top lands just under the details", async () => {
  const run = await open();
  const paragraph = run.page.locator(`${EDITOR} p`, { hasText: "Second paragraph here." });
  await paragraph.click({ modifiers: ["Meta"], position: { x: 60, y: 8 } });
  await settle(run.page);
  await drag(run.page, paragraph, "top");
  const file = await saved(run.page, run.text);
  expect(file.startsWith(`${DETAILS}\n\nSecond paragraph here.\n\n# Heading`), file.slice(0, 80)).toBe(true);
});

test("the details Command-clicked and dragged to the end stay where they are", async () => {
  const run = await open();
  const details = run.page.locator(`${EDITOR} pre.raw-block`).first();
  await details.click({ modifiers: ["Meta"], position: { x: 60, y: 8 } });
  await settle(run.page);
  await drag(run.page, details, "bottom");
  const file = await saved(run.page, run.text);
  expect(file).toBe(TEXT);
});
