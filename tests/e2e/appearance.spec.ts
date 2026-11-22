// View > Appearance: Match the Mac, Light or Dark. Orlando, 2026-11-11: "I want
// to be able to flip between the two regardless of what the system is set to
// (light or dark mode)." Remembered between launches; exports stay light.
import { test, expect, type ElectronApplication, type Page } from "@playwright/test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { clickMenu, openText } from "./helpers";

const TEXT = "# Plan\n\nWe should hire two people.\n";

const checked = (app: ElectronApplication, id: string) =>
  app.evaluate(({ Menu }, itemId) => Menu.getApplicationMenu()?.getMenuItemById(itemId)?.checked ?? null, id);
const label = (app: ElectronApplication, id: string) =>
  app.evaluate(({ Menu }, itemId) => Menu.getApplicationMenu()?.getMenuItemById(itemId)?.label ?? null, id);

/** Whether the window draws in dark colours, and the page's colour as drawn. */
const look = (page: Page) =>
  page.evaluate(() => ({
    dark: window.matchMedia("(prefers-color-scheme: dark)").matches,
    page: getComputedStyle(document.querySelector(".doc:not([hidden]) .page.editor")!).backgroundColor,
  }));

/** Playwright pins a test window to light; let it follow Corillo's own colours, as the real app does. */
const unpinned = (page: Page) => page.emulateMedia({ colorScheme: null });

test("View > Appearance switches between light and dark whatever the Mac is set to, and is remembered", async () => {
  const run = await openText(TEXT);
  await unpinned(run.page);
  // Out of the box it follows the Mac.
  expect(await checked(run.app, "appearance-system")).toBe(true);
  expect(await label(run.app, "appearance-system")).toBe("Match the Mac");
  expect(await label(run.app, "appearance-light")).toBe("Light");
  expect(await label(run.app, "appearance-dark")).toBe("Dark");
  const mac = await run.app.evaluate(({ nativeTheme }) => nativeTheme.shouldUseDarkColors);
  expect((await look(run.page)).dark).toBe(mac);

  // Dark, then Light: the page changes at once, whichever the Mac is in.
  await clickMenu(run.app, "appearance-dark");
  await expect.poll(async () => (await look(run.page)).dark).toBe(true);
  const dark = await look(run.page);
  expect(await checked(run.app, "appearance-dark")).toBe(true);
  // The window's own colour behind the page follows, so a resize shows no strip of the other.
  expect(await run.app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].getBackgroundColor().toUpperCase())).toBe("#1B2023");

  await clickMenu(run.app, "appearance-light");
  await expect.poll(async () => (await look(run.page)).dark).toBe(false);
  const light = await look(run.page);
  expect(light.page).not.toBe(dark.page);
  expect(await checked(run.app, "appearance-light")).toBe(true);
  expect(await run.app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].getBackgroundColor().toUpperCase())).toBe("#EAEDEC");

  // Remembered after a relaunch, from the first frame.
  await clickMenu(run.app, "appearance-dark");
  expect(JSON.parse(readFileSync(join(run.dataDir, "view.json"), "utf8")).appearance).toBe("dark");
  await run.app.close();
  const again = await openText(TEXT, { dataDir: run.dataDir });
  await unpinned(again.page);
  expect(await checked(again.app, "appearance-dark")).toBe(true);
  expect((await look(again.page)).dark).toBe(true);
  expect(await again.app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].getBackgroundColor().toUpperCase())).toBe("#1B2023");

  // And back to following the Mac.
  await clickMenu(again.app, "appearance-system");
  await expect.poll(async () => (await look(again.page)).dark).toBe(mac);
  await again.app.close();
});
