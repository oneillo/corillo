// View > Page Width: Standard, a column of text as on paper, or Wide, the text
// using the space beside the comments with the page's margins kept either side,
// up to about 100 characters a line. Remembered between launches.
import { test, expect, type ElectronApplication, type Page } from "@playwright/test";
import { clickMenu, openText } from "./helpers";

const TEXT = `# Plan\n\n${"A long line of text that keeps going so it wraps across the page. ".repeat(12)}\n`;

async function size(app: ElectronApplication, page: Page, width: number): Promise<void> {
  await app.evaluate(({ BrowserWindow }, w) => BrowserWindow.getAllWindows()[0].setContentSize(w, 800), width);
  await page.waitForTimeout(200);
}

/** The page's width, its text's distance from each side of the space it sits
 * in, and how many characters the paragraph's first line holds. */
function measure(page: Page, view: "editor" | "preview" = "editor") {
  return page.evaluate((v) => {
    const pageEl = document.querySelector<HTMLElement>(`.doc:not([hidden]) .page.${v}`)!;
    const space = pageEl.parentElement!.getBoundingClientRect();
    const p = pageEl.querySelector("p")!;
    const text = p.getBoundingClientRect();
    // Walk the first text node until a character starts a new line.
    const walker = document.createTreeWalker(p, NodeFilter.SHOW_TEXT);
    const node = walker.nextNode() as Text;
    const range = document.createRange();
    let firstTop = -1;
    let chars = 0;
    for (let i = 0; i < node.length; i++) {
      range.setStart(node, i);
      range.setEnd(node, i + 1);
      const r = range.getClientRects()[0];
      if (!r) continue;
      if (firstTop < 0) firstTop = r.top;
      else if (r.top > firstTop + 4) break;
      chars++;
    }
    return { width: pageEl.getBoundingClientRect().width, left: text.left - space.left, right: space.right - text.right, chars };
  }, view);
}

const checked = (app: ElectronApplication, id: string) =>
  app.evaluate(({ Menu }, itemId) => Menu.getApplicationMenu()?.getMenuItemById(itemId)?.checked ?? null, id);
const label = (app: ElectronApplication, id: string) =>
  app.evaluate(({ Menu }, itemId) => Menu.getApplicationMenu()?.getMenuItemById(itemId)?.label ?? null, id);

test("Page Width: Standard keeps a column, Wide uses the space beside the comments, and it's remembered", async () => {
  const run = await openText(TEXT);
  await size(run.app, run.page, 1200);
  expect(await checked(run.app, "page-width-fixed")).toBe(true);
  expect(await label(run.app, "page-width-fixed")).toBe("Standard");
  expect(await label(run.app, "page-width-fill")).toBe("Wide");
  const standard = await measure(run.page);
  expect(standard.width).toBeLessThanOrEqual(760);
  // About 75 characters a line.
  expect(standard.chars).toBeGreaterThan(60);
  expect(standard.chars).toBeLessThanOrEqual(85);

  // Wide: the whole space beside the comments panel (304 pixels, open from the
  // start) when that's under the limit, with white space either side.
  await clickMenu(run.app, "page-width-fill");
  await expect.poll(async () => (await measure(run.page)).width).toBeGreaterThan(800);
  const wide = await measure(run.page);
  expect(wide.left).toBeGreaterThanOrEqual(80);
  expect(Math.abs(wide.left - wide.right)).toBeLessThanOrEqual(24);
  expect(await checked(run.app, "page-width-fill")).toBe(true);

  // The Markdown view's preview follows: its page fills its half.
  await run.page.getByRole("button", { name: "Markdown", exact: true }).click();
  await expect
    .poll(() =>
      run.page.evaluate(() => {
        const pageEl = document.querySelector<HTMLElement>(".doc:not([hidden]) .page.preview")!;
        return pageEl.parentElement!.clientWidth - pageEl.getBoundingClientRect().width; // inside the pane, beside the room for its scroll bar
      }),
    )
    .toBeLessThanOrEqual(40);
  await run.app.close();

  // Remembered after a relaunch.
  const again = await openText(TEXT, { dataDir: run.dataDir });
  await size(again.app, again.page, 1200);
  await expect.poll(async () => (await measure(again.page)).width).toBeGreaterThan(800);
  expect(await checked(again.app, "page-width-fill")).toBe(true);
  await clickMenu(again.app, "page-width-fixed");
  await expect.poll(async () => (await measure(again.page)).width).toBeLessThanOrEqual(760);
  await again.app.close();
});

// Orlando, 2026-11-09
test("on a big screen Wide stops at about 100 characters a line and stays centred, at any zoom", async () => {
  const run = await openText(TEXT);
  await clickMenu(run.app, "page-width-fill");
  await size(run.app, run.page, 1900);
  for (const zoom of ["", "zoom-in"]) {
    if (zoom) await clickMenu(run.app, zoom);
    await run.page.waitForTimeout(200);
    const wide = await measure(run.page);
    // Wider than Standard, never past about 100 characters a line.
    expect(wide.chars, `zoom ${zoom || "1"}`).toBeGreaterThan(85);
    expect(wide.chars, `zoom ${zoom || "1"}`).toBeLessThanOrEqual(105);
    // The page is centred in the space, with room either side.
    const space = await run.page.evaluate(() => {
      const pageEl = document.querySelector<HTMLElement>(".doc:not([hidden]) .page.editor")!;
      const s = pageEl.parentElement!.getBoundingClientRect();
      const r = pageEl.getBoundingClientRect();
      return { left: r.left - s.left, right: s.right - r.right };
    });
    expect(Math.abs(space.left - space.right)).toBeLessThanOrEqual(2);
  }
  await run.app.close();
});
