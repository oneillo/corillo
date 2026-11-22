// Test and trial runs happen while someone uses the Mac: they must never take
// its focus, show a window or a question, or open another app.
import { test, expect, type ElectronApplication, type Page } from "@playwright/test";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openText, launch } from "./helpers";
import { AgentSession } from "./agent-session";

test("a test run stays out of the way: no Dock icon, no window on screen, unanswered questions cancelled, no other app opened", async () => {
  const run = await openText("# Plan\n");
  const quiet = await run.app.evaluate(async ({ app, BrowserWindow, dialog, shell }) => {
    const question = await dialog.showMessageBox({ message: "Anyone there?", buttons: ["Yes", "Cancel"], cancelId: 1 });
    const open = await dialog.showOpenDialog({ properties: ["openFile"] });
    const save = await dialog.showSaveDialog({});
    const opened = await shell.openPath("/System/Applications/Calculator.app");
    return {
      dock: app.dock?.isVisible() ?? false,
      windowsShown: BrowserWindow.getAllWindows().filter((w) => w.isVisible()).length,
      question: question.response,
      open: open.canceled,
      save: save.canceled,
      opened,
    };
  });
  expect(quiet).toEqual({ dock: false, windowsShown: 0, question: 1, open: true, save: true, opened: "" });
  await run.app.close();
});

/** From now on, note how each new window would be shown: with the person's focus, or without taking it. */
async function noteWindows(app: ElectronApplication): Promise<() => Promise<string[]>> {
  await app.evaluate(({ app: electronApp }) => {
    const g = globalThis as unknown as { shown: string[] };
    g.shown = [];
    electronApp.on("corillo-window-shown" as never, ((how: { focused: boolean }) => g.shown.push(how.focused ? "focused" : "inactive")) as never);
  });
  return () => app.evaluate(() => (globalThis as unknown as { shown: string[] }).shown);
}

async function closeTheWindow(app: ElectronApplication): Promise<void> {
  await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].close());
  await expect.poll(() => app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows().length)).toBe(0);
}

test("who asked decides whether a window takes focus: an agent's open after the window was closed doesn't; the Dock icon and Finder do", async () => {
  const run = await openText("# Plan\n");
  const shown = await noteWindows(run.app);
  const { session } = await AgentSession.start(run.dataDir);
  await closeTheWindow(run.app);
  // The person closed the window and is typing in their agent's chat; the agent opens a document.
  const notes = join(run.folder, "notes.md");
  writeFileSync(notes, "Notes.\n");
  await session.ok("open_document", { path: notes });
  await expect.poll(shown).toEqual(["inactive"]);
  // The person clicks Corillo in the Dock: that window is theirs.
  await closeTheWindow(run.app);
  await run.app.evaluate(({ app }) => app.emit("activate"));
  await expect.poll(shown).toEqual(["inactive", "focused"]);
  // Opened from Finder: the window made to show the tab is the person's, so it takes focus.
  await closeTheWindow(run.app);
  await run.app.evaluate(async ({ app }, files) => {
    app.emit("open-file", { preventDefault() {} }, files[0]);
  }, [run.file]);
  await expect.poll(shown).toEqual(["inactive", "focused", "focused"]);
  await run.app.close();
  await session.stop();
});

// After the power cut of 2026-11-10 the hidden window took the display's scale
// of 2, where before it had 1, and two tests that clicked between two lines of
// a paragraph failed on untouched code. A test passes or fails the same on any
// Mac, whatever the display's state: the test window's scale is 1 (ONE_SCALE
// in the helpers), and a launch that asks for another keeps it (the pictures
// for Help are taken at 2).
test("the test window gets a screen scale of 1 whatever the display's, and a launch that asks for 2 gets 2", async () => {
  const run = await openText("# Plan\n\nA paragraph.\n");
  const scaleOf = (app: ElectronApplication, page: Page) =>
    Promise.all([
      page.evaluate(() => window.devicePixelRatio),
      app.evaluate(({ BrowserWindow, screen }) => {
        const win = BrowserWindow.getAllWindows()[0];
        return screen.getDisplayMatching(win.getBounds()).scaleFactor;
      }),
    ]);
  expect(await scaleOf(run.app, run.page)).toEqual([1, 1]);
  await run.app.close();
  const { app: asked } = await launch({
    args: ["--force-device-scale-factor=2", ".", run.file],
    env: { ...process.env, CORILLO_USER_DATA: run.dataDir, CORILLO_HIDDEN: "1", CORILLO_HOME: mkdtempSync(join(tmpdir(), "corillo-home-")) },
  });
  const page = await asked.firstWindow();
  await page.waitForSelector(".ProseMirror");
  expect(await scaleOf(asked, page)).toEqual([2, 2]);
  await asked.close();
});

// The person's request wins over an agent's window that hasn't shown yet (R-MAIN-10).
test("a Dock click while an agent's window is still on its way makes that window the person's", async () => {
  const run = await openText("# Plan\n");
  const shown = await noteWindows(run.app);
  const { session } = await AgentSession.start(run.dataDir);
  await closeTheWindow(run.app);
  // The agent opens a document; the person clicks the Dock icon as its window is being made.
  await run.app.evaluate(({ app }) => {
    app.once("browser-window-created", () => setImmediate(() => app.emit("activate")));
  });
  const notes = join(run.folder, "notes.md");
  writeFileSync(notes, "Notes.\n");
  await session.ok("open_document", { path: notes });
  await expect.poll(shown).toEqual(["focused"]);
  await run.app.close();
  await session.stop();
});
