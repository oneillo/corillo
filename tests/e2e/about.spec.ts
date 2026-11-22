// About Corillo: the coquí, the version, Corillo's licence and the licences
// of everything it's built with. Also the coquí on the start screen.
import { test, expect, type ElectronApplication, type Page } from "@playwright/test";
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { clickMenu, ONE_SCALE, openText, settle, launch as launchCorillo } from "./helpers";

const ROOT = join(import.meta.dirname, "..", "..");
const VERSION = JSON.parse(readFileSync(join(ROOT, "package.json"), "utf8")).version as string;

/** A stand-in for the bundled Pandoc: its licence and version, as fetched. */
function fakePandoc(version: string): string {
  const dir = mkdtempSync(join(tmpdir(), "corillo-pandoc-"));
  mkdirSync(join(dir, process.arch));
  writeFileSync(join(dir, "COPYING"), "GNU GENERAL PUBLIC LICENSE\nVersion 2, June 1991\n(test copy)\n");
  writeFileSync(join(dir, "VERSION"), `${version}\n`);
  return dir;
}

/** Start Corillo with no document open. */
async function launch(env: Record<string, string> = {}): Promise<{ app: ElectronApplication; page: Page }> {
  const { app } = await launchCorillo({
    args: [ONE_SCALE, "."],
    env: { ...process.env, CORILLO_USER_DATA: mkdtempSync(join(tmpdir(), "corillo-data-")), CORILLO_HIDDEN: "1", ...env },
  });
  const page = await app.firstWindow();
  await page.waitForSelector("#empty");
  return { app, page };
}

/** Choose Corillo > About Corillo and wait for its window. */
async function openAbout(app: ElectronApplication): Promise<Page> {
  const opened = app.waitForEvent("window");
  await clickMenu(app, "about");
  const about = await opened;
  await about.waitForSelector("body[data-ready]");
  return about;
}

test("About Corillo shows the coquí, the name, the version and what Corillo is", async () => {
  const { app } = await launch({ CORILLO_PANDOC_DIR: mkdtempSync(join(tmpdir(), "corillo-no-pandoc-")) });
  const about = await openAbout(app);
  expect(await about.title()).toBe("About Corillo");
  await expect(about.getByRole("heading", { name: "Corillo", level: 1 })).toBeVisible();
  await expect(about.getByText(`Version ${VERSION}`)).toBeVisible();
  await expect(about.getByText("A Markdown editor for writing documents together with AI agents.")).toBeVisible();
  // The coquí icon is drawn, not a broken picture.
  const icon = about.locator("img.about-icon");
  await expect.poll(() => icon.evaluate((img: HTMLImageElement) => img.complete && img.naturalWidth > 0)).toBe(true);
  await app.close();
});

test("About shows Corillo's MIT licence in full", async () => {
  const { app } = await launch();
  const about = await openAbout(app);
  await expect(about.getByText("Corillo is free and open source software, under the MIT licence.")).toBeVisible();
  const text = about.locator("#licence-text");
  await expect(text).toBeHidden();
  await about.getByText("Read the licence").click();
  await expect(text).toBeVisible();
  await expect(text).toContainText("MIT License");
  await expect(text).toContainText("Permission is hereby granted, free of charge");
  await app.close();
});

test("About lists every package built into Corillo, each with its licence text", async () => {
  const { app } = await launch();
  const about = await openAbout(app);
  const bundled = readFileSync(join(ROOT, "dist", "third-party-notices.txt"), "utf8");
  const count = Number(/^(\d+) packages:/m.exec(bundled)?.[1]);
  expect(count).toBeGreaterThan(50);
  await expect(about.getByText(`${count} packages, each listed with its licence.`)).toBeVisible();
  await about.getByText("Show the list and licences").click();
  const notices = about.locator("#notices-text");
  await expect(notices).toBeVisible();
  for (const name of ["electron", "prosemirror-model", "markdown-it", "mermaid", "dompurify"]) {
    await expect(notices).toContainText(`\n- ${name} `);
  }
  await expect(notices).toContainText("Permission is hereby granted"); // an MIT licence text
  await expect(notices).toContainText("Apache License"); // an Apache licence text
  // The page's font, with the licence it asks to travel with it.
  await expect(notices).toContainText("Literata (font)");
  await expect(notices).toContainText("SIL OPEN FONT LICENSE Version 1.1");
  await app.close();
});

test("About opens Chromium's own notices, which come with Electron, in a window of their own", async () => {
  const { app } = await launch();
  const about = await openAbout(app);
  const opened = app.waitForEvent("window");
  await about.getByRole("button", { name: "Show their notices" }).click();
  const credits = await opened;
  await credits.waitForLoadState();
  expect(credits.url()).toMatch(/LICENSES\.chromium\.html$/);
  await expect(credits.getByText("Chromium software is made available as source code")).toBeVisible();
  await app.close();
});

test("About names the bundled Pandoc, shows its GPL licence and links to its exact source code", async () => {
  const { app } = await launch({ CORILLO_PANDOC_DIR: fakePandoc("3.9.1") });
  const about = await openAbout(app);
  await expect(about.getByText("Pandoc 3.9.1")).toBeVisible();
  await expect(about.locator("#pandoc .about-part-note")).toContainText("GNU General Public License");
  await about.getByText("Read its licence").click();
  await expect(about.locator("#pandoc-text")).toContainText("GNU GENERAL PUBLIC LICENSE");
  // The source link opens the release page for exactly this version, in the browser.
  await app.evaluate(({ shell }) => {
    const g = globalThis as unknown as { opened: string[] };
    g.opened = [];
    shell.openExternal = (async (url: string) => {
      g.opened.push(url);
    }) as typeof shell.openExternal;
  });
  await about.getByRole("button", { name: "Get its source code" }).click();
  await expect
    .poll(() => app.evaluate(() => (globalThis as unknown as { opened: string[] }).opened))
    .toEqual(["https://github.com/jgm/pandoc/releases/tag/3.9.1"]);
  await app.close();
});

test("About doesn't mention Pandoc when the app was built without it", async () => {
  const { app } = await launch({ CORILLO_PANDOC_DIR: mkdtempSync(join(tmpdir(), "corillo-no-pandoc-")) });
  const about = await openAbout(app);
  await expect(about.locator("#pandoc")).toBeHidden();
  await expect(about.getByText("Electron and Chromium")).toBeVisible();
  await app.close();
});

test("choosing About again brings back the same window instead of opening another", async () => {
  const { app } = await launch();
  await openAbout(app);
  await clickMenu(app, "about");
  await settle(app.windows()[0]);
  expect(app.windows()).toHaveLength(2);
  await app.close();
});

// A16-14: About, and Chromium's notices, brought back to the front a window a hidden run never shows.
test("in a hidden run, choosing About or Chromium's notices again never brings a window to the front", async () => {
  const { app } = await launch();
  const about = await openAbout(app);
  const opened = app.waitForEvent("window");
  await about.getByRole("button", { name: "Show their notices" }).click();
  await (await opened).waitForLoadState();
  // Count each call to focus a window from here on, without letting one through.
  await app.evaluate(({ BrowserWindow }) => {
    const g = globalThis as unknown as { focused: number };
    g.focused = 0;
    BrowserWindow.prototype.focus = function () {
      g.focused++;
    };
  });
  await clickMenu(app, "about");
  await about.getByRole("button", { name: "Show their notices" }).click();
  await settle(app.windows()[0]);
  expect(app.windows()).toHaveLength(3);
  expect(await app.evaluate(() => (globalThis as unknown as { focused: number }).focused)).toBe(0);
  await app.close();
});

test("Cmd-W closes the About window, not the document behind it", async () => {
  const run = await openText("Still here.\n");
  const about = await openAbout(run.app);
  const closed = about.waitForEvent("close");
  // Pressed as the Mac would deliver it, so the menu's Close Tab shortcut could catch it.
  await run.app.evaluate(({ BrowserWindow }) => {
    const w = BrowserWindow.getAllWindows().find((b) => b.getTitle() === "About Corillo")!;
    w.webContents.sendInputEvent({ type: "keyDown", keyCode: "W", modifiers: ["meta"] });
  });
  await closed;
  expect(run.app.windows()).toHaveLength(1);
  await expect(run.page.locator(".tab")).toHaveCount(1);
  await run.app.close();
});

test("the start screen shows the coquí beside the name, in the accent colour, light and dark", async () => {
  const { app, page } = await launch();
  const mark = page.locator("#empty h1 svg.coqui-mark");
  await expect(mark).toBeVisible();
  await expect(page.locator("#empty h1")).toHaveText("Corillo");
  const colour = () => mark.evaluate((el) => getComputedStyle(el).color);
  await page.emulateMedia({ colorScheme: "light" });
  expect(await colour()).toBe("rgb(79, 109, 122)");
  await page.emulateMedia({ colorScheme: "dark" });
  expect(await colour()).toBe("rgb(132, 166, 181)");
  // Side by side: the mark sits to the left of the word, centred on it.
  const box = await mark.boundingBox();
  const word = await page.locator("#empty h1").boundingBox();
  expect(box && word && box.x < word.x + 40 && box.height >= 28).toBe(true);
  await app.close();
});
