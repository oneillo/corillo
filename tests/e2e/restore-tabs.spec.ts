// Your tabs come back as you left them (roadmap Batch 10, item 2). Orlando,
// 2026-11-13: "If we close it with open tabs, then it restores to that state
// the next time the app is opened." Each case runs Corillo twice (or more) on
// one throwaway data folder, quitting as the person does (Corillo > Quit).
import { test, expect, type ElectronApplication, type Page } from "@playwright/test";
import { existsSync, mkdtempSync, readFileSync, readdirSync, realpathSync, renameSync, unlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ONE_SCALE, EDITOR, clickMenu, cursorAtEnd, openFromFinder, settle, tabState, launch as launchCorillo } from "./helpers";
import { AgentSession } from "./agent-session";

const folderFor = (prefix: string) => realpathSync(mkdtempSync(join(tmpdir(), prefix)));

/** A throwaway data folder, past the first run's Connect screen. */
function dataFolder(): string {
  const dataDir = folderFor("corillo-data-");
  writeFileSync(join(dataDir, "setup.json"), '{ "connectAgentsOffered": true }\n');
  return dataDir;
}

/** Documents in a folder of their own: name to path. */
function documents(texts: Record<string, string>): Record<string, string> {
  const folder = folderFor("corillo-doc-");
  const paths: Record<string, string> = {};
  for (const [name, text] of Object.entries(texts)) {
    paths[name] = join(folder, name);
    writeFileSync(paths[name], text);
  }
  return paths;
}

/** Corillo, hidden, on this data folder, opened with these files (as Finder or a command line would). */
async function launch(dataDir: string, files: string[] = [], env: Record<string, string> = {}): Promise<{ app: ElectronApplication; page: Page }> {
  const { app } = await launchCorillo({
    args: [ONE_SCALE, ".", ...files],
    env: { ...process.env, CORILLO_USER_DATA: dataDir, CORILLO_HIDDEN: "1", CORILLO_HOME: folderFor("corillo-home-"), ...env },
  });
  const page = await app.firstWindow();
  return { app, page };
}

/** Corillo ends without quitting, as in a crash. */
async function crash(app: ElectronApplication): Promise<void> {
  app.process().kill("SIGKILL");
  await app.close().catch(() => undefined);
}

/** The list Corillo keeps of the open tabs. */
function kept(dataDir: string): Record<string, unknown> | null {
  const file = join(dataDir, "open-tabs.json");
  return existsSync(file) ? (JSON.parse(readFileSync(file, "utf8")) as Record<string, unknown>) : null;
}

/** The Window menu's list of open documents, by name. */
function windowMenu(app: ElectronApplication): Promise<string[]> {
  return app.evaluate(({ Menu }) => {
    const items = Menu.getApplicationMenu()?.getMenuItemById("window-menu")?.submenu?.items ?? [];
    return items.filter((i) => i.id?.startsWith("window-doc-")).map((i) => i.label);
  });
}

const tab = (page: Page, name: string) => page.locator(`.tab[title$="/${name}"]`);
const idOf = async (page: Page, name: string) => (await tab(page, name).getAttribute("data-doc-id"))!;
const NOTICE = "body > .window-notices .file-notice";

/** The order the documents' pages were made in this window: the first is the one opened first. */
function openedFirst(page: Page): Promise<string | null> {
  return page.evaluate(() => document.querySelector<HTMLElement>("#docs > .doc")?.dataset.docId ?? null);
}

test("quit with tabs open: they come back next time, in the same order, with the same one in front; the Window menu follows the bar's order", async () => {
  const dataDir = dataFolder();
  const doc = documents({ "plan.md": "# Plan\n\nHire two people.\n", "notes.md": "Notes.\n", "budget.md": "Budget.\n" });
  let { app, page } = await launch(dataDir, [doc["plan.md"]]);
  await page.waitForSelector(".ProseMirror");
  await openFromFinder(app, doc["notes.md"]);
  await openFromFinder(app, doc["budget.md"]);
  await expect.poll(() => tabState(page)).toEqual({ names: ["plan.md", "notes.md", "budget.md"], active: "budget.md" });
  // The bar's order changes (a tab moved): the window says so, and the Window menu follows.
  const ids = [await idOf(page, "budget.md"), await idOf(page, "plan.md"), await idOf(page, "notes.md")];
  await app.evaluate(({ BrowserWindow }, order) => BrowserWindow.getAllWindows()[0].webContents.send("tabs:place", order), ids);
  await expect.poll(async () => (await tabState(page)).names).toEqual(["budget.md", "plan.md", "notes.md"]);
  await expect.poll(() => windowMenu(app)).toEqual(["budget", "plan", "notes"]);
  await tab(page, "notes.md").click();
  // Kept as it changes: the paths in the bar's order and the one in front, nothing else.
  await expect.poll(() => kept(dataDir)).toEqual({ tabs: [doc["budget.md"], doc["plan.md"], doc["notes.md"]], front: doc["notes.md"] });
  await app.close();

  // Opened again with nothing: the same tabs, the same order, the same one in front, and it opened first.
  ({ app, page } = await launch(dataDir));
  await expect.poll(() => tabState(page)).toEqual({ names: ["budget.md", "plan.md", "notes.md"], active: "notes.md" });
  await expect(page.locator(EDITOR)).toContainText("Notes.");
  expect(await openedFirst(page)).toBe(await idOf(page, "notes.md"));
  await expect.poll(() => windowMenu(app)).toEqual(["budget", "plan", "notes"]);
  await expect(page.locator(NOTICE)).toBeHidden(); // nothing was left out
  // Each is as any document opened: typing in it saves.
  await cursorAtEnd(page, "Notes.");
  await page.keyboard.type(" More.");
  await expect.poll(() => readFileSync(doc["notes.md"], "utf8")).toBe("Notes. More.\n");
  await app.close();
});

test("tabs moved with Window > Move Tab Left (and its key) and by a drag: the Window menu follows, and the next launch brings them back in that order, with the same one in front", async () => {
  const dataDir = dataFolder();
  const doc = documents({ "plan.md": "Plan.\n", "notes.md": "Notes.\n", "budget.md": "Budget.\n" });
  let { app, page } = await launch(dataDir, [doc["plan.md"], doc["notes.md"], doc["budget.md"]]);
  await expect.poll(() => tabState(page)).toEqual({ names: ["plan.md", "notes.md", "budget.md"], active: "budget.md" });
  // Window > Move Tab Left moves the tab in front a place...
  await clickMenu(app, "move-tab-left");
  await expect.poll(() => tabState(page)).toEqual({ names: ["plan.md", "budget.md", "notes.md"], active: "budget.md" });
  await expect.poll(() => windowMenu(app)).toEqual(["plan", "budget", "notes"]);
  // ...and its key, Control-Shift-Command-Left, another, from the document.
  await page.locator(`${EDITOR} p`).click();
  await settle(page);
  await page.keyboard.press("Control+Shift+Meta+ArrowLeft");
  await expect.poll(() => tabState(page)).toEqual({ names: ["budget.md", "plan.md", "notes.md"], active: "budget.md" });
  await expect.poll(() => windowMenu(app)).toEqual(["budget", "plan", "notes"]);
  // Plan dragged along the bar past notes and let go: it stays there, in front.
  await settle(page);
  const box = async (name: string) => (await tab(page, name).boundingBox())!;
  const [from, past] = [await box("plan.md"), await box("notes.md")];
  const y = from.y + from.height / 2;
  await page.mouse.move(from.x + from.width / 2, y);
  await page.mouse.down();
  await page.mouse.move(past.x + past.width / 2 + 10, y, { steps: 5 });
  await page.mouse.up();
  await expect.poll(() => tabState(page)).toEqual({ names: ["budget.md", "notes.md", "plan.md"], active: "plan.md" });
  await expect.poll(() => windowMenu(app)).toEqual(["budget", "notes", "plan"]);
  await expect.poll(() => kept(dataDir)).toEqual({ tabs: [doc["budget.md"], doc["notes.md"], doc["plan.md"]], front: doc["plan.md"] });
  await app.close();

  // Opened again with nothing: the order he left, the same one in front (opened first), and the menu follows it.
  ({ app, page } = await launch(dataDir));
  await expect.poll(() => tabState(page)).toEqual({ names: ["budget.md", "notes.md", "plan.md"], active: "plan.md" });
  await expect(page.locator(EDITOR)).toContainText("Plan.");
  expect(await openedFirst(page)).toBe(await idOf(page, "plan.md"));
  await expect.poll(() => windowMenu(app)).toEqual(["budget", "notes", "plan"]);
  await app.close();
});

test("after the window's page stops working, it reopens with his tabs in his order, and the list keeps them while the window is gone (B10-1)", async () => {
  const dataDir = dataFolder();
  const doc = documents({ "plan.md": "Plan.\n", "notes.md": "Notes.\n", "budget.md": "Budget.\n" });
  const { app, page } = await launch(dataDir, [doc["plan.md"], doc["notes.md"], doc["budget.md"]]);
  await expect.poll(() => tabState(page)).toEqual({ names: ["plan.md", "notes.md", "budget.md"], active: "budget.md" });
  await clickMenu(app, "move-tab-left");
  await clickMenu(app, "move-tab-left");
  await expect.poll(() => tabState(page)).toEqual({ names: ["budget.md", "plan.md", "notes.md"], active: "budget.md" });
  const moved = { tabs: [doc["budget.md"], doc["plan.md"], doc["notes.md"]], front: doc["budget.md"] };
  await expect.poll(() => kept(dataDir)).toEqual(moved);
  // The page stops working. What the list says the moment the window has gone, before the new one has said anything.
  const [again] = await Promise.all([
    app.waitForEvent("window"),
    app.evaluate(({ BrowserWindow }, file) => {
      const fs = (process as unknown as { mainModule: { require(id: string): typeof import("node:fs") } }).mainModule.require("fs");
      const w = BrowserWindow.getAllWindows()[0];
      w.once("closed", () => ((globalThis as unknown as { listWhileGone: string }).listWhileGone = fs.readFileSync(file, "utf8")));
      w.webContents.forcefullyCrashRenderer();
    }, join(dataDir, "open-tabs.json")),
  ]);
  const whileGone = await app.evaluate(() => (globalThis as unknown as { listWhileGone?: string }).listWhileGone ?? "");
  expect(JSON.parse(whileGone)).toEqual(moved);
  // Reopened in his order, with the same one in front, and the list still says so.
  await again.waitForSelector(".ProseMirror");
  await expect.poll(() => tabState(again)).toEqual({ names: ["budget.md", "plan.md", "notes.md"], active: "budget.md" });
  await expect(again.locator(NOTICE)).toContainText("Corillo's window stopped working and was reopened.");
  await settle(again);
  expect(kept(dataDir)).toEqual(moved);
  expect(await windowMenu(app)).toEqual(["budget", "plan", "notes"]);
  await app.close();
});

test("agents' passes that quitting ended stay ended: a tab brought back is nobody's, with no frog, no dot, nothing to read and no count on the Dock", async () => {
  const dataDir = dataFolder();
  const doc = documents({ "plan.md": "# Plan\n\nWe should hire two people.\n", "notes.md": "# Notes\n\nSome notes.\n" });
  let { app, page } = await launch(dataDir, [doc["plan.md"], doc["notes.md"]]);
  await expect.poll(() => tabState(page)).toEqual({ names: ["plan.md", "notes.md"], active: "notes.md" });
  const { session } = await AgentSession.start(dataDir);
  try {
    // Back from Claude on plan (a dot, a count on the Dock), and Claude still editing notes (a frog) when Corillo quits.
    await session.ok("take_document", { path: doc["plan.md"] });
    await session.ok("edit_document", { path: doc["plan.md"], edits: [{ find: "two", replace: "three" }] });
    await session.ok("finish_editing", { path: doc["plan.md"] });
    await session.ok("take_document", { path: doc["notes.md"] });
    await expect(tab(page, "plan.md").locator(".tab-dot")).toBeVisible();
    await expect(tab(page, "notes.md").locator(".tab-dot .coqui-frog")).toBeVisible();
    await expect.poll(() => app.evaluate(({ app: a }) => a.dock?.getBadge() ?? "")).toBe("1");
    await app.close();
  } finally {
    await session.stop();
  }

  ({ app, page } = await launch(dataDir));
  await expect.poll(() => tabState(page)).toEqual({ names: ["plan.md", "notes.md"], active: "notes.md" });
  await expect(page.locator(EDITOR)).toContainText("Some notes.");
  await expect(tab(page, "plan.md").locator(".tab-dot")).toBeHidden();
  await expect(tab(page, "notes.md").locator(".tab-dot")).toBeHidden();
  expect(await app.evaluate(({ app: a }) => a.dock?.getBadge() ?? "")).toBe("");
  await expect(page.locator(".doc:not([hidden]) .agent-notice")).toBeHidden(); // nobody is editing it
  expect(await page.locator(EDITOR).locator(".ProseMirror").getAttribute("contenteditable")).toBe("true");
  // The agent's edit is there, kept as any change is.
  await tab(page, "plan.md").click();
  await expect(page.locator(EDITOR)).toContainText("hire three people");
  await app.close();
});

test("close every tab, then quit: the start screen next time; close the window, then quit: the same", async () => {
  const dataDir = dataFolder();
  const doc = documents({ "plan.md": "Plan.\n", "notes.md": "Notes.\n" });
  let { app, page } = await launch(dataDir, [doc["plan.md"], doc["notes.md"]]);
  await expect.poll(async () => (await tabState(page)).names).toEqual(["plan.md", "notes.md"]);
  await clickMenu(app, "close-tab");
  await clickMenu(app, "close-tab");
  await page.waitForSelector("#empty:not([hidden])");
  await expect.poll(() => kept(dataDir)).toEqual({ tabs: [], front: null });
  await app.close();

  ({ app, page } = await launch(dataDir));
  await page.waitForSelector("#empty:not([hidden])");
  await settle(page);
  expect((await tabState(page)).names).toEqual([]);

  // Close Window: Corillo keeps running with no window, and no tab is open.
  await openFromFinder(app, doc["plan.md"]);
  await expect.poll(async () => (await tabState(page)).names).toEqual(["plan.md"]);
  const closed = page.waitForEvent("close");
  await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].close());
  await closed;
  await expect.poll(() => kept(dataDir)).toEqual({ tabs: [], front: null });
  await app.close();

  ({ app, page } = await launch(dataDir));
  await page.waitForSelector("#empty:not([hidden])");
  await settle(page);
  expect((await tabState(page)).names).toEqual([]);
  await app.close();
});

test("a document moved while closed opens where it went; one deleted, one on a drive that isn't connected and one over 10 MB are left out, named in one line in the corner", async () => {
  const dataDir = dataFolder();
  const doc = documents({ "plan.md": "Plan.\n", "notes.md": "Notes.\n", "gone.md": "Gone soon.\n" });
  let { app, page } = await launch(dataDir, [doc["plan.md"], doc["notes.md"], doc["gone.md"]]);
  await expect.poll(async () => (await tabState(page)).names).toEqual(["plan.md", "notes.md", "gone.md"]);
  await tab(page, "plan.md").click();
  await expect.poll(() => kept(dataDir)?.front).toBe(doc["plan.md"]);
  await app.close();
  // Meanwhile: notes renamed in Finder, gone deleted. And two more on the list, as if they'd been open: one on a
  // drive that isn't plugged in, and one that has grown past 10 MB.
  const moved = join(doc["notes.md"], "..", "notes from Monday.md");
  renameSync(doc["notes.md"], moved);
  unlinkSync(doc["gone.md"]);
  const away = "/Volumes/Corillo test drive that is not here/away.md";
  const big = join(doc["plan.md"], "..", "big log.md");
  writeFileSync(big, `${"A line of the log.\n".repeat(600_000)}`); // over 10 MB
  const list = kept(dataDir) as { tabs: string[]; front: string };
  writeFileSync(join(dataDir, "open-tabs.json"), JSON.stringify({ tabs: [...list.tabs, away, big], front: list.front }));

  ({ app, page } = await launch(dataDir));
  await expect.poll(() => tabState(page)).toEqual({ names: ["plan.md", "notes from Monday.md"], active: "plan.md" });
  await expect(page.locator(NOTICE)).toBeVisible();
  await expect(page.locator(NOTICE)).toContainText("3 documents weren't opened again: gone, away and big log.");
  await expect(page.locator(NOTICE)).toContainText(
    "gone was moved or deleted. away is on a drive or share that didn't answer. big log is over 10 MB: open it from File > Open Recent when you're ready.",
  );
  // The list follows: what's open now, at the moved document's new place (marked as just brought back, for half a minute).
  await expect.poll(() => kept(dataDir)).toEqual({ tabs: [doc["plan.md"], moved], front: doc["plan.md"], restoring: true });
  await app.close();
});

test("a document renamed while Corillo was closed and opened from Finder where it went comes to the front in its place, and the corner names nothing (B10-2)", async () => {
  const dataDir = dataFolder();
  const doc = documents({ "plan.md": "Plan.\n", "notes.md": "Notes.\n", "budget.md": "Budget.\n" });
  let { app, page } = await launch(dataDir, [doc["plan.md"], doc["notes.md"], doc["budget.md"]]);
  await expect.poll(async () => (await tabState(page)).names).toEqual(["plan.md", "notes.md", "budget.md"]);
  await app.close();
  // Renamed in Finder, then double-clicked there: Corillo starts with it.
  const renamed = join(doc["notes.md"], "..", "notes v2.md");
  renameSync(doc["notes.md"], renamed);
  ({ app, page } = await launch(dataDir, [renamed]));
  await expect.poll(() => tabState(page)).toEqual({ names: ["plan.md", "notes v2.md", "budget.md"], active: "notes v2.md" });
  await expect(page.locator(EDITOR)).toContainText("Notes.");
  await settle(page);
  await page.waitForTimeout(500);
  await expect(page.locator(NOTICE)).toBeHidden(); // it's open: never named as moved or deleted
  await expect.poll(() => kept(dataDir)).toEqual({ tabs: [doc["plan.md"], renamed, doc["budget.md"]], front: renamed, restoring: true });
  await app.close();
});

test("closed unexpectedly after bringing tabs back, with edits kept for one: that one comes back with its edits, and the corner names only the others (B10-2)", async () => {
  const dataDir = dataFolder();
  const doc = documents({ "plan.md": "Ours.\n", "notes.md": "Notes.\n" });
  let { app, page } = await launch(dataDir, [doc["notes.md"], doc["plan.md"]]);
  await expect.poll(() => tabState(page)).toEqual({ names: ["notes.md", "plan.md"], active: "plan.md" });
  await app.close();

  // Brought back; then, before the mark goes, plan changes outside Corillo while the person types, and Corillo closes unexpectedly.
  ({ app, page } = await launch(dataDir));
  await expect.poll(() => tabState(page)).toEqual({ names: ["notes.md", "plan.md"], active: "plan.md" });
  expect(kept(dataDir)?.restoring).toBe(true);
  await cursorAtEnd(page, "Ours.");
  await page.keyboard.type(" Typed before the crash.");
  writeFileSync(doc["plan.md"], "Theirs.\n");
  await expect(page.locator(".doc:not([hidden]) .banner")).toBeVisible();
  await expect.poll(() => (existsSync(join(dataDir, "recovery")) ? readdirSync(join(dataDir, "recovery")).length : 0)).toBe(1);
  await crash(app);

  // Not brought back blindly: only plan comes back, opened for its edits; the corner names notes, and where to find it.
  ({ app, page } = await launch(dataDir));
  await expect.poll(() => tabState(page)).toEqual({ names: ["plan.md"], active: "plan.md" });
  await expect(page.locator(EDITOR)).toContainText("Ours. Typed before the crash.");
  await expect(page.locator(".doc:not([hidden]) .banner")).toContainText("brought back changes");
  await expect(page.locator(NOTICE)).toContainText("notes wasn't opened again, since Corillo closed unexpectedly the last time it opened it.");
  await expect(page.locator(NOTICE)).toContainText("Open it from File > Open Recent when you're ready.");
  await expect(page.locator(NOTICE)).not.toContainText("Your documents weren't opened again");
  await page.getByRole("button", { name: "Keep my changes" }).click();
  await expect.poll(() => readFileSync(doc["plan.md"], "utf8")).toBe("Ours. Typed before the crash.\n");
  await app.close();
});

test("the look at where each document is never holds the window up: the one in front opens first, and a document whose look doesn't answer is left out as away", async () => {
  const dataDir = dataFolder();
  const doc = documents({ "plan.md": "Plan.\n", "budget.md": "Budget.\n", "notes.md": "Notes.\n" });
  let { app, page } = await launch(dataDir, [doc["plan.md"], doc["budget.md"], doc["notes.md"]]);
  await expect.poll(async () => (await tabState(page)).names).toEqual(["plan.md", "budget.md", "notes.md"]);
  await tab(page, "budget.md").click();
  await expect.poll(() => kept(dataDir)?.front).toBe(doc["budget.md"]);
  await app.close();

  // The look at notes takes 20 seconds, as on a network share that doesn't answer.
  const started = Date.now();
  ({ app, page } = await launch(dataDir, [], { CORILLO_LOOK_DELAY_AT: doc["notes.md"], CORILLO_LOOK_DELAY_MS: "20000" }));
  // An agent asking for the open documents meanwhile is answered once they're back (or after a few seconds at most).
  const waited = app.evaluate(({ app: a }) => new Promise<number>((resolve) => a.once("corillo-agent-waited-for-tabs" as never, resolve as never)));
  const { session } = await AgentSession.start(dataDir);
  try {
    const listed = await session.ok("list_documents");
    expect(listed).toContain(doc["plan.md"]);
    expect(listed).toContain(doc["budget.md"]);
    expect(listed).not.toContain(doc["notes.md"]);
    console.log(`An agent's first call waited ${await Promise.race([waited, new Promise((r) => setTimeout(() => r("no"), 100))])} ms for the tabs.`);
  } finally {
    await session.stop();
  }
  await expect.poll(() => tabState(page)).toEqual({ names: ["plan.md", "budget.md"], active: "budget.md" });
  expect(await openedFirst(page)).toBe(await idOf(page, "budget.md"));
  await expect(page.locator(NOTICE)).toContainText("notes wasn't opened.");
  await expect(page.locator(NOTICE)).toContainText("It's on a drive or share that didn't answer.");
  expect(Date.now() - started).toBeLessThan(15_000); // never the look's 20 seconds
  await app.close();
});

test("while a document is slow to come back: quitting keeps it on the list, in its place, and a tab moved meanwhile stays where he put it (B10-6)", async () => {
  const dataDir = dataFolder();
  const doc = documents({ "plan.md": "Plan.\n", "notes.md": "Notes.\n", "budget.md": "Budget.\n" });
  let { app, page } = await launch(dataDir, [doc["plan.md"], doc["notes.md"], doc["budget.md"]]);
  await expect.poll(() => tabState(page)).toEqual({ names: ["plan.md", "notes.md", "budget.md"], active: "budget.md" });
  const list = { tabs: [doc["plan.md"], doc["notes.md"], doc["budget.md"]], front: doc["budget.md"] };
  await expect.poll(() => kept(dataDir)).toEqual(list);
  await app.close();

  // The look at notes takes most of the time it's allowed, as on a slow share. Quit before it's back: it stays on the list.
  const slow = { CORILLO_LOOK_DELAY_AT: doc["notes.md"], CORILLO_LOOK_DELAY_MS: "1400" };
  ({ app, page } = await launch(dataDir, [], slow));
  await expect.poll(async () => (await tabState(page)).names).toEqual(["plan.md", "budget.md"]);
  await app.close();
  expect(kept(dataDir)).toEqual(list);

  // Again, and this time a tab is moved before notes is back: it stays moved, and notes comes after the others.
  ({ app, page } = await launch(dataDir, [], slow));
  await expect.poll(() => tabState(page)).toEqual({ names: ["plan.md", "budget.md"], active: "budget.md" });
  await clickMenu(app, "move-tab-left");
  await expect.poll(async () => (await tabState(page)).names).toEqual(["budget.md", "plan.md"]);
  await expect.poll(async () => (await tabState(page)).names).toEqual(["budget.md", "plan.md", "notes.md"]);
  await settle(page);
  await page.waitForTimeout(300);
  expect((await tabState(page)).names).toEqual(["budget.md", "plan.md", "notes.md"]);
  await expect.poll(() => kept(dataDir)?.tabs).toEqual([doc["budget.md"], doc["plan.md"], doc["notes.md"]]);
  await app.close();
});

test("quitting while a document is slow to come back keeps the edits kept after a crash for another: both come back next time (B10-6)", async () => {
  const dataDir = dataFolder();
  const doc = documents({ "plan.md": "Ours.\n", "notes.md": "Notes.\n" });
  let { app, page } = await launch(dataDir, [doc["notes.md"], doc["plan.md"]]);
  await expect.poll(() => tabState(page)).toEqual({ names: ["notes.md", "plan.md"], active: "plan.md" });
  await cursorAtEnd(page, "Ours.");
  await page.keyboard.type(" Typed before the crash.");
  writeFileSync(doc["plan.md"], "Theirs.\n");
  await expect(page.locator(".doc:not([hidden]) .banner")).toBeVisible();
  await expect.poll(() => (existsSync(join(dataDir, "recovery")) ? readdirSync(join(dataDir, "recovery")).length : 0)).toBe(1);
  await crash(app);

  // Brought back with notes slow to answer; Corillo quits before it's back, without stopping to ask.
  ({ app, page } = await launch(dataDir, [], { CORILLO_LOOK_DELAY_AT: doc["notes.md"], CORILLO_LOOK_DELAY_MS: "1400" }));
  await expect.poll(async () => (await tabState(page)).names).toEqual(["plan.md"]);
  await app.close();
  expect(readdirSync(join(dataDir, "recovery"))).toHaveLength(1);

  // Next time: notes, and plan with its kept edits.
  ({ app, page } = await launch(dataDir));
  await expect.poll(async () => (await tabState(page)).names).toEqual(["notes.md", "plan.md"]);
  await tab(page, "plan.md").click();
  await expect(page.locator(EDITOR)).toContainText("Ours. Typed before the crash.");
  await expect(page.locator(".doc:not([hidden]) .banner")).toContainText("brought back changes");
  await page.getByRole("button", { name: "Keep my changes" }).click();
  await expect.poll(() => readFileSync(doc["plan.md"], "utf8")).toBe("Ours. Typed before the crash.\n");
  await app.close();
});

test("a launch that brought tabs back and then closed unexpectedly opens on the start screen next time, saying why; a clean quit, or half a minute up, clears that", async () => {
  const dataDir = dataFolder();
  const doc = documents({ "plan.md": "Plan.\n", "notes.md": "Notes.\n" });
  let { app, page } = await launch(dataDir, [doc["plan.md"], doc["notes.md"]]);
  await expect.poll(async () => (await tabState(page)).names).toEqual(["plan.md", "notes.md"]);
  await app.close();

  // Brought back, then Corillo closes unexpectedly straight away.
  ({ app, page } = await launch(dataDir));
  await expect.poll(async () => (await tabState(page)).names).toEqual(["plan.md", "notes.md"]);
  expect(kept(dataDir)?.restoring).toBe(true);
  await crash(app);

  // Not blindly again: the start screen, and why.
  ({ app, page } = await launch(dataDir));
  await page.waitForSelector("#empty:not([hidden])");
  await expect(page.locator(NOTICE)).toContainText("Your documents weren't opened again, since Corillo closed unexpectedly the last time it opened them.");
  await expect(page.locator(NOTICE)).toContainText("Open them from the list when you're ready.");
  expect((await tabState(page)).names).toEqual([]);
  // From the list, as it says.
  await openFromFinder(app, doc["notes.md"]);
  await expect.poll(async () => (await tabState(page)).names).toEqual(["notes.md"]);
  await app.close();

  // A clean quit straight after bringing them back clears the mark: they come back again.
  ({ app, page } = await launch(dataDir));
  await expect.poll(async () => (await tabState(page)).names).toEqual(["notes.md"]);
  await app.close();
  expect(kept(dataDir)).toEqual({ tabs: [doc["notes.md"]], front: doc["notes.md"] });

  // So does the window being up a while with them (half a minute; a moment here): a crash after that brings them back.
  ({ app, page } = await launch(dataDir, [], { CORILLO_TABS_SETTLED_MS: "500" }));
  await expect.poll(async () => (await tabState(page)).names).toEqual(["notes.md"]);
  await expect.poll(() => kept(dataDir)).toEqual({ tabs: [doc["notes.md"]], front: doc["notes.md"] });
  await crash(app);
  ({ app, page } = await launch(dataDir));
  await expect.poll(async () => (await tabState(page)).names).toEqual(["notes.md"]);
  await expect(page.locator(NOTICE)).toBeHidden();
  await app.close();
});

test("edits kept after a crash come back once, in the tab brought back", async () => {
  const dataDir = dataFolder();
  const doc = documents({ "plan.md": "Ours.\n", "notes.md": "Notes.\n" });
  const { app, page } = await launch(dataDir, [doc["notes.md"], doc["plan.md"]]);
  await expect.poll(() => tabState(page)).toEqual({ names: ["notes.md", "plan.md"], active: "plan.md" });
  // Changed outside Corillo while the person types: the edits are kept for a crash...
  await cursorAtEnd(page, "Ours.");
  await page.keyboard.type(" Typed before the crash.");
  writeFileSync(doc["plan.md"], "Theirs.\n");
  await expect(page.locator(".doc:not([hidden]) .banner")).toBeVisible();
  await expect.poll(() => (existsSync(join(dataDir, "recovery")) ? readdirSync(join(dataDir, "recovery")).length : 0)).toBe(1);
  await crash(app);

  // ...and come back in the one tab of plan, among the tabs brought back.
  const again = await launch(dataDir);
  await expect.poll(() => tabState(again.page)).toEqual({ names: ["notes.md", "plan.md"], active: "plan.md" });
  await expect(again.page.locator(EDITOR)).toContainText("Ours. Typed before the crash.");
  await expect(again.page.locator(".doc:not([hidden]) .banner")).toContainText("brought back changes");
  await settle(again.page);
  expect((await tabState(again.page)).names).toEqual(["notes.md", "plan.md"]);
  await again.page.getByRole("button", { name: "Keep my changes" }).click();
  await expect.poll(() => readFileSync(doc["plan.md"], "utf8")).toBe("Ours. Typed before the crash.\n");
  await again.app.close();
});

test("a new document left empty when Corillo quits isn't brought back", async () => {
  const dataDir = dataFolder();
  const doc = documents({ "plan.md": "Plan.\n" });
  let { app, page } = await launch(dataDir, [doc["plan.md"]]);
  await page.waitForSelector(".ProseMirror");
  const untitled = join(doc["plan.md"], "..", "Untitled.md");
  await app.evaluate(({ dialog }, picked) => {
    dialog.showSaveDialog = (async () => ({ canceled: false, filePath: picked })) as typeof dialog.showSaveDialog;
  }, untitled);
  await clickMenu(app, "new-document");
  await expect.poll(() => tabState(page)).toEqual({ names: ["plan.md", "Untitled.md"], active: "Untitled.md" });
  await expect.poll(() => kept(dataDir)).toEqual({ tabs: [doc["plan.md"], untitled], front: untitled });
  await app.close();
  expect(existsSync(untitled)).toBe(false);
  expect(kept(dataDir)).toEqual({ tabs: [doc["plan.md"]], front: null });

  ({ app, page } = await launch(dataDir));
  await expect.poll(() => tabState(page)).toEqual({ names: ["plan.md"], active: "plan.md" });
  await settle(page);
  await expect(page.locator(NOTICE)).toBeHidden(); // not named as gone: nothing was lost
  await app.close();
});

test("opened with a file from Finder while Corillo isn't running: the tabs come back and that file is in front", async () => {
  const dataDir = dataFolder();
  const doc = documents({ "plan.md": "Plan.\n", "notes.md": "Notes.\n", "letter.md": "Dear Ana,\n" });
  let { app, page } = await launch(dataDir, [doc["plan.md"], doc["notes.md"]]);
  await expect.poll(() => tabState(page)).toEqual({ names: ["plan.md", "notes.md"], active: "notes.md" });
  await app.close();

  // A file that wasn't open: after the others, in front.
  ({ app, page } = await launch(dataDir, [doc["letter.md"]]));
  await expect.poll(() => tabState(page)).toEqual({ names: ["plan.md", "notes.md", "letter.md"], active: "letter.md" });
  await expect(page.locator(EDITOR)).toContainText("Dear Ana,");
  await app.close();

  // One that was: in its place, in front.
  ({ app, page } = await launch(dataDir, [doc["plan.md"]]));
  await expect.poll(() => tabState(page)).toEqual({ names: ["plan.md", "notes.md", "letter.md"], active: "plan.md" });
  await settle(page);
  expect((await tabState(page)).active).toBe("plan.md");
  await app.close();
});

test("started by an agent's call: his tabs come back quietly, a take by name finds one, the agent's document opens in a tab of its own, and the one he had in front stays in front", async () => {
  const dataDir = dataFolder();
  const doc = documents({ "plan.md": "# Plan\n\nWe should hire two people.\n", "notes.md": "Notes.\n", "letter.md": "Dear Ana,\n" });
  const { app, page } = await launch(dataDir, [doc["notes.md"], doc["plan.md"]]);
  await expect.poll(() => tabState(page)).toEqual({ names: ["notes.md", "plan.md"], active: "plan.md" });
  await tab(page, "notes.md").click();
  await expect.poll(() => kept(dataDir)?.front).toBe(doc["notes.md"]);
  await app.close();

  // Corillo isn't running: the agent's connector starts it, in the background (hidden here).
  const { session } = await AgentSession.start(dataDir, "claude-code", { cwd: folderFor("corillo-agent-") });
  let pid = 0;
  try {
    // The first call: a take by name, among the documents open in Corillo (its tabs brought back).
    const taken = await session.ok("take_document", { path: "plan" });
    pid = Number(/process (\d+)/.exec(session.stderr)?.[1]);
    expect(pid).toBeGreaterThan(0);
    expect(taken).toContain("plan");
    await session.ok("edit_document", { path: doc["plan.md"], edits: [{ find: "two", replace: "three" }] });
    await session.ok("finish_editing", { path: doc["plan.md"] });
    expect(readFileSync(doc["plan.md"], "utf8")).toContain("three people");
    // The agent's own document: a tab of its own at the end, and the one he had in front stays there.
    expect(await session.ok("open_document", { path: doc["letter.md"] })).toContain("letter.md is open in Corillo");
    await expect.poll(() => kept(dataDir)).toEqual({ tabs: [doc["notes.md"], doc["plan.md"], doc["letter.md"]], front: doc["notes.md"], restoring: true });
  } finally {
    if (pid) process.kill(pid, "SIGTERM");
    await session.stop();
  }
});
