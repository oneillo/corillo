// The selection's word count in the status bar, page zoom, and the window's place.
import { test, expect, type Page } from "@playwright/test";
import { chmodSync, mkdirSync, mkdtempSync, renameSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openText, cursorAtEnd, settle, clickMenu } from "./helpers";
import { tidyRuns } from "./tidy";

// Tests added on 2026-11-09 night remove their folders when they're done.
const tidy = tidyRuns();

const DOC = "# Notes\n\nOne two three four five.\n\nSix seven.\n";

const words = (page: Page) => page.locator("#word-count");
const zoomLevel = (page: Page) => page.locator("#zoom-level");
const pageZoom = (page: Page) => page.evaluate(() => getComputedStyle(document.querySelector(".doc:not([hidden]) .page.editor")!).zoom);

test("with words selected, the word count says how many of them there are", async () => {
  const run = await openText(DOC);
  await expect(words(run.page)).toHaveText("8 words");
  await cursorAtEnd(run.page, "One two");
  await run.page.keyboard.press("Alt+Shift+ArrowLeft"); // "."
  await run.page.keyboard.press("Alt+Shift+ArrowLeft"); // "five."
  await run.page.keyboard.press("Alt+Shift+ArrowLeft"); // "four five."
  await expect(words(run.page)).toHaveText("2 of 8 words");
  await run.page.keyboard.press("Meta+A");
  await expect(words(run.page)).toHaveText("8 of 8 words");
  await run.page.keyboard.press("ArrowRight");
  await expect(words(run.page)).toHaveText("8 words");
  await run.app.close();
});

test("the selection's word count works in the Markdown view too, counting words, not Markdown signs", async () => {
  const run = await openText(DOC);
  await run.page.getByRole("button", { name: "Markdown" }).click();
  const source = run.page.getByRole("textbox", { name: "Markdown text" });
  await source.click();
  await settle(run.page);
  await source.evaluate((el: HTMLTextAreaElement) => {
    el.setSelectionRange(0, el.value.indexOf("four")); // "# Notes\n\nOne two three "
    el.dispatchEvent(new Event("select"));
  });
  await expect(words(run.page)).toHaveText("4 of 8 words");
  await run.app.close();
});

test("a selection never counts more words than the whole document, and the same words count the same in both views", async () => {
  // Document details, a link definition and a hidden comment aren't words Word would count.
  const text =
    "---\ntitle: Plan for the spring\n---\n\n# Notes\n\nOne two %%a hidden note%% three.\n\nRead [the brief][b] **now**.\n\n[b]: https://example.com/brief\n";
  const run = tidy.keep(await openText(text));
  const { page } = run;
  await expect(words(page)).toHaveText("8 words");
  await page.locator(".ProseMirror p", { hasText: "One two" }).click();
  await page.keyboard.press("Meta+A");
  await expect(words(page)).toHaveText("8 of 8 words");
  // From "One two" to the end of "now.".
  await page.evaluate(() => {
    const [first, second] = [...document.querySelectorAll(".ProseMirror p")].filter((p) => /One two|brief now/.test(p.textContent!));
    const range = document.createRange();
    range.setStart(first, 0);
    range.setEnd(second, second.childNodes.length);
    getSelection()!.removeAllRanges();
    getSelection()!.addRange(range);
  });
  await expect(words(page)).toHaveText("7 of 8 words");

  await page.getByRole("button", { name: "Markdown" }).click();
  const source = page.getByRole("textbox", { name: "Markdown text" });
  await source.click();
  await settle(page);
  await page.keyboard.press("Meta+A");
  await expect(words(page)).toHaveText("8 of 8 words");
  // The same paragraphs selected in the Markdown text.
  await source.evaluate((el: HTMLTextAreaElement) => {
    el.setSelectionRange(el.value.indexOf("One two"), el.value.indexOf("\n\n[b]:"));
    el.dispatchEvent(new Event("select"));
  });
  await expect(words(page)).toHaveText("7 of 8 words");
});

test("every not-saved state in the status bar is in the warning colour, the Trash's too, and is told to screen readers; Saved isn't", async () => {
  const run = tidy.keep(await openText("Draft.\n"));
  const { page } = run;
  const status = page.locator("#save-status");
  const told = page.getByRole("status").filter({ hasText: /^Not saved/ });
  const colour = () => status.evaluate((el) => getComputedStyle(el).color);
  const warning = await page.evaluate(() => {
    const probe = document.createElement("span");
    probe.style.color = "var(--warning-ink)";
    document.body.append(probe);
    const c = getComputedStyle(probe).color;
    probe.remove();
    return c;
  });
  await expect(status).toHaveText("Saved");
  const quiet = await colour();
  expect(quiet).not.toBe(warning);
  await expect(told).toHaveCount(0);
  // Can't be saved: warm, and said.
  chmodSync(run.file, 0o444);
  await cursorAtEnd(page, "Draft.");
  await page.keyboard.type(" More.");
  await expect(status).toHaveText(/^Not saved: the file is read-only/);
  expect(await colour()).toBe(warning);
  await expect(told).toHaveText(/^Not saved: the file is read-only/);
  // Moved to the Trash with those words unsaved: warm too, and said.
  const trash = join(run.folder, ".Trash");
  mkdirSync(trash);
  renameSync(run.file, join(trash, "proposal.md"));
  await expect(status).toHaveText("Not saved: the file is in the Trash");
  expect(await colour()).toBe(warning);
  await expect(told).toHaveText("Not saved: the file is in the Trash");
  // Put back and saved: quiet again, and nothing more said.
  chmodSync(join(trash, "proposal.md"), 0o644);
  renameSync(join(trash, "proposal.md"), run.file);
  await expect(status).toHaveText("Saved", { timeout: 10_000 });
  expect(await colour()).toBe(quiet);
  await expect(told).toHaveCount(0);
});

test("View > Zoom In, Zoom Out and Actual Size scale the page", async () => {
  const run = await openText(DOC);
  await expect(zoomLevel(run.page)).toBeHidden();
  await clickMenu(run.app, "zoom-in");
  await expect(zoomLevel(run.page)).toHaveText("110%");
  expect(await pageZoom(run.page)).toBe("1.1");
  await clickMenu(run.app, "zoom-in");
  await expect(zoomLevel(run.page)).toHaveText("125%");
  await clickMenu(run.app, "zoom-out");
  await clickMenu(run.app, "zoom-out");
  await clickMenu(run.app, "zoom-out");
  await expect(zoomLevel(run.page)).toHaveText("90%");
  await clickMenu(run.app, "zoom-reset");
  await expect(zoomLevel(run.page)).toBeHidden();
  expect(await pageZoom(run.page)).toBe("1");
  await run.app.close();
});

test("clicking the zoom level in the status bar goes back to 100%", async () => {
  const run = await openText(DOC);
  await clickMenu(run.app, "zoom-in");
  await expect(zoomLevel(run.page)).toHaveText("110%");
  await expect(zoomLevel(run.page)).toHaveAttribute("title", "Back to actual size (⌘0)");
  await zoomLevel(run.page).click();
  await expect(zoomLevel(run.page)).toBeHidden();
  expect(await pageZoom(run.page)).toBe("1");
  await run.app.close();
});

test("Cmd+=, Cmd+- and Cmd+0 zoom too", async () => {
  const run = await openText(DOC);
  await cursorAtEnd(run.page, "Six seven");
  await run.page.keyboard.press("Meta+=");
  await expect(zoomLevel(run.page)).toHaveText("110%");
  await run.page.keyboard.press("Meta+-");
  await run.page.keyboard.press("Meta+-");
  await expect(zoomLevel(run.page)).toHaveText("90%");
  await run.page.keyboard.press("Meta+0");
  await expect(zoomLevel(run.page)).toBeHidden();
  await run.app.close();
});

test("the zoom level is remembered the next time Corillo opens", async () => {
  const dataDir = mkdtempSync(join(tmpdir(), "corillo-data-"));
  const first = await openText(DOC, { dataDir });
  await clickMenu(first.app, "zoom-in");
  await clickMenu(first.app, "zoom-in");
  await expect(zoomLevel(first.page)).toHaveText("125%");
  await first.app.close();

  const second = await openText(DOC, { dataDir });
  await expect(zoomLevel(second.page)).toHaveText("125%");
  expect(await pageZoom(second.page)).toBe("1.25");
  await second.app.close();
});

test("the window opens the next time where it was left, at the same size", async () => {
  const dataDir = mkdtempSync(join(tmpdir(), "corillo-data-"));
  const first = await openText(DOC, { dataDir });
  const left = await first.app.evaluate(({ BrowserWindow, screen }) => {
    const area = screen.getPrimaryDisplay().workArea;
    const w = BrowserWindow.getAllWindows()[0];
    w.setBounds({ x: area.x + 40, y: area.y + 30, width: Math.min(900, area.width - 80), height: Math.min(640, area.height - 60) });
    return w.getBounds();
  });
  await first.app.close();

  const second = await openText(DOC, { dataDir });
  expect(await second.app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].getBounds())).toEqual(left);
  await second.app.close();
});
