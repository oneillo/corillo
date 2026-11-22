// A first launch that ends with the person's agent really connected, and a
// blank document that says what to do (roadmap Batch 5, item 2: P-5, P-8 and
// person quick wins 5 to 9). Every test uses a stand-in home folder and a
// throwaway data folder; "an agent reaching Corillo" is a stand-in session
// that names itself as that agent tool does.
import { test, expect, type ElectronApplication, type Page } from "@playwright/test";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, renameSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { AgentSession } from "./agent-session";
import { captureClipboard, clickMenu, cursorAtEnd, openAlso, openFromFinder, openText, paste, recentMenu, settle, tabState, EDITOR, ONE_SCALE, type Running, launch as launchCorillo } from "./helpers";

interface Launched {
  app: ElectronApplication;
  page: Page;
  dataDir: string;
  home: string;
}

/** A stand-in home folder with these agent tools' signs in it (Claude.app for Claude Desktop, .claude for Claude Code). */
function homeWith(...signs: string[]): string {
  const home = mkdtempSync(join(tmpdir(), "corillo-home-"));
  for (const sign of signs) mkdirSync(join(home, sign), { recursive: true });
  return home;
}

/** Start Corillo with no document open; leave out `seenBefore` for a first run. */
async function launch(home: string, options: { seenBefore?: boolean; env?: Record<string, string> } = {}): Promise<Launched> {
  const dataDir = mkdtempSync(join(tmpdir(), "corillo-data-"));
  if (options.seenBefore) writeFileSync(join(dataDir, "setup.json"), '{ "connectAgentsOffered": true }\n');
  const { app } = await launchCorillo({
    args: [ONE_SCALE, "."],
    env: { ...process.env, CORILLO_USER_DATA: dataDir, CORILLO_HIDDEN: "1", CORILLO_HOME: home, ...options.env },
  });
  const page = await app.firstWindow();
  await page.setViewportSize({ width: 1100, height: 860 });
  await page.waitForSelector("#empty");
  return { app, page, dataDir, home };
}

const box = (page: Page) => page.getByRole("dialog", { name: "Connect your agents" });
const row = (page: Page, tool: string) => box(page).locator(`.agent-row[data-tool="${tool}"]`);
const TRY_IT = "Write a one-page plan for a team offsite, save it in my Documents folder and open it in Corillo.";
const START_LINE = "Write with your AI agent: comment on the page, and it makes the changes.";

// The start screen and the Connect box -------------------------------------------------------

test("the first time Corillo opens, the Connect box sits under the start screen's name and its line on what Corillo is (P-5, quick wins 5 and 6)", async () => {
  const run = await launch(homeWith("Applications/Claude.app"));
  const { page } = run;
  await expect(box(page)).toBeVisible();
  const title = page.locator(".empty-title");
  const line = page.locator(".start-what");
  await expect(line).toHaveText(START_LINE);
  // Both in sight above the box, not covered by it.
  const dialog = (await box(page).boundingBox())!;
  for (const shown of [title, line]) {
    await expect(shown).toBeVisible();
    const b = (await shown.boundingBox())!;
    expect(b.y + b.height).toBeLessThanOrEqual(dialog.y);
  }
  // For people who use Claude in a browser.
  await expect(box(page)).toContainText("Use Claude in a web browser? Corillo works with the Claude app for Mac.");

  // Closed, the start screen is as ever: its buttons under the line.
  await page.getByRole("button", { name: "Done" }).click();
  await expect(box(page)).toBeHidden();
  await expect(page.getByRole("button", { name: "Open a document…" })).toBeVisible();
  await expect(page.locator(".empty-panel")).not.toContainText("Markdown");
  await run.app.close();
});

// Review of Batch 11, B11R-5: in a short window the box opened under the name in the middle, squeezed into a
// scrolling area, and the keyboard starting on Done scrolled "Connect your agents" out of sight.
test("in a short window, the whole Connect box is in the window with its title in sight; where it fits under the name, nothing moves", async () => {
  const run = await launch(homeWith("Applications/Claude.app", ".claude"));
  const { page } = run;
  await expect(box(page)).toBeVisible();
  await expect(box(page).locator(".agent-row")).toHaveCount(2);
  const title = box(page).locator(".connect-title");
  for (const [width, height] of [
    [560, 700],
    [900, 600],
  ]) {
    await page.setViewportSize({ width, height });
    await page.evaluate(() => new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve))));
    const shown = await box(page).evaluate((d) => {
      const b = d.getBoundingClientRect();
      const t = d.querySelector(".connect-title")!.getBoundingClientRect();
      return { top: b.top, bottom: b.bottom, titleTop: t.top, titleBottom: t.bottom, scrolled: d.scrollTop };
    });
    expect(shown.top, `${width}x${height}`).toBeGreaterThanOrEqual(0);
    expect(shown.bottom, `${width}x${height}`).toBeLessThanOrEqual(height);
    expect(shown.scrolled, `${width}x${height}`).toBe(0);
    expect(shown.titleTop, `${width}x${height}`).toBeGreaterThanOrEqual(shown.top);
    await expect(title).toBeInViewport({ ratio: 1 });
    await expect(box(page).getByRole("button", { name: "Done" })).toBeInViewport({ ratio: 1 });
  }
  // Opened again in the short window, the keyboard starts on Done, and the title stays in sight.
  await box(page).getByRole("button", { name: "Done" }).click();
  await expect(box(page)).toBeHidden();
  await page.locator("#connect-agents-link").click();
  await expect(box(page)).toBeVisible();
  await expect(box(page).getByRole("button", { name: "Done" })).toBeFocused();
  await expect(title).toBeInViewport({ ratio: 1 });
  expect(await box(page).evaluate((d) => d.scrollTop)).toBe(0);
  // Where it fits under the name, the name stays where it is when the box opens and closes (F-27).
  await box(page).getByRole("button", { name: "Done" }).click();
  await expect(box(page)).toBeHidden();
  await expect(page.locator("body")).not.toHaveClass(/connect-rise/); // the name back where it was, once the box has closed
  await page.setViewportSize({ width: 1440, height: 900 });
  const name = () => page.locator(".empty-title").boundingBox();
  const before = await name();
  await page.locator("#connect-agents-link").click();
  await expect(box(page)).toBeVisible();
  expect(await name()).toEqual(before);
  const under = (await page.locator(".start-what").boundingBox())!;
  expect((await box(page).boundingBox())!.y).toBeGreaterThanOrEqual(under.y + under.height);
  await run.app.close();
});

test("How Corillo works opens Help at Your first document with an agent (quick win 5)", async () => {
  const run = await launch(homeWith(), { seenBefore: true });
  const [help] = await Promise.all([run.app.waitForEvent("window"), run.page.getByRole("button", { name: "How Corillo works" }).click()]);
  await help.waitForSelector("#first:not([hidden])");
  await expect(help.getByRole("heading", { name: "Your first document with an agent" })).toBeVisible();
  await run.app.close();
});

test("after Connect, the row says it's set up and to quit and reopen the app, with a request to try; a session from that app reaching Corillo turns it connected (P-5)", async () => {
  const run = await launch(homeWith("Applications/Claude.app", ".claude"));
  const { page } = run;
  const copied = await captureClipboard(run.app);
  await page.getByRole("button", { name: "Connect Claude Desktop" }).click();
  const desktop = row(page, "claude-desktop");
  await expect(desktop.locator(".agent-set-up")).toHaveText("Ready");
  await expect(desktop.locator(".agent-connected")).toHaveCount(0);
  await expect(desktop).toContainText("Now quit Claude Desktop (Command-Q) and open it again.");
  await expect(desktop).toContainText(`Then try it: paste this in a new chat. “${TRY_IT}”`);
  await desktop.getByRole("button", { name: "Copy the request to try" }).click();
  expect(await copied()).toBe(TRY_IT);
  await expect(desktop.getByRole("button", { name: "Copy the request to try" })).toHaveText("Copied");

  // A Claude Code session isn't Claude Desktop: the row still waits.
  const { session: code } = await AgentSession.start(run.dataDir, "claude-code");
  const { session: claude } = await AgentSession.start(run.dataDir, "claude-ai"); // what Claude Desktop calls itself
  try {
    await code.ok("list_documents");
    await page.waitForTimeout(400);
    await expect(desktop.locator(".agent-set-up")).toHaveText("Ready");
    await expect(desktop).toContainText("Now quit Claude Desktop");

    // Claude Desktop's own session reaches Corillo: the row says so, live.
    await claude.ok("list_documents");
    await expect(desktop.locator(".agent-connected")).toHaveText("Connected", { timeout: 2000 });
    await expect(desktop.locator(".agent-note.connected")).toHaveText("Claude Desktop is connected.");
    await expect(desktop).not.toContainText("Now quit");
    await expect(desktop).toContainText(TRY_IT); // still there to try
  } finally {
    await claude.stop();
    await code.stop();
  }
  await run.app.close();
});

test("a tool set up earlier shows Set up, and Connected only while one of its sessions is connected (P-5)", async () => {
  const home = homeWith(".claude");
  const run = await launch(home, { seenBefore: true });
  const { page } = run;
  await clickMenu(run.app, "connect-agents");
  await page.getByRole("button", { name: "Connect Claude Code" }).click();
  await expect(row(page, "claude-code")).toContainText("Now start a new Claude Code session.");
  await page.getByRole("button", { name: "Done" }).click();
  // Opened again: set up, nothing to do now, no session yet.
  await clickMenu(run.app, "connect-agents");
  await expect(row(page, "claude-code").locator(".agent-set-up")).toHaveText("Ready");
  await expect(row(page, "claude-code").locator(".agent-note")).toHaveCount(0);
  const { session } = await AgentSession.start(run.dataDir, "claude-code");
  await session.ok("list_documents");
  await expect(row(page, "claude-code").locator(".agent-connected")).toHaveText("Connected");
  await session.stop();
  await expect(row(page, "claude-code").locator(".agent-set-up")).toHaveText("Ready");
  await run.app.close();
});

test("a while after Connect with no session, the row says to quit the app completely, or start a new session (P-5)", async () => {
  // Two minutes, made shorter for the test.
  const run = await launch(homeWith("Applications/Claude.app", ".claude"), { env: { CORILLO_CONNECT_STILL_MS: "400" } });
  const { page } = run;
  await page.getByRole("button", { name: "Connect Claude Desktop" }).click();
  await page.getByRole("button", { name: "Connect Claude Code" }).click();
  await expect(row(page, "claude-desktop")).toContainText("Still waiting? Quit Claude Desktop completely with Command-Q, not just its window. Then open it again and paste the request in a new chat.");
  await expect(row(page, "claude-code")).toContainText("Still waiting? A Claude Code session started before you connected can't see Corillo. Start a new one and paste the request there.");
  await run.app.close();
});

// Names and folders as Finder shows them --------------------------------------------------------

const windowTitle = (app: ElectronApplication) =>
  app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows().find((w) => w.getTitle() !== "Corillo Help")!.getTitle());
const windowMenu = (app: ElectronApplication) =>
  app.evaluate(({ Menu }) =>
    (Menu.getApplicationMenu()?.getMenuItemById("window-menu")?.submenu?.items ?? []).filter((i) => i.id?.startsWith("window-doc-")).map((i) => i.label),
  );

test("names show without .md on the tabs, the window's title, the Window menu, notices and the start screen's cards; Copy path keeps the file's name (quick win 9)", async () => {
  const run = await openText("First words.\n", { name: "Offsite notes.md" });
  const { page, app } = run;
  await expect.poll(() => windowTitle(app)).toBe("Offsite notes");
  const plan = await openAlso(run, "plan.md", "# Plan\n");
  await expect.poll(async () => (await tabState(page)).names).toEqual(["Offsite notes.md", "plan.md"]);
  await expect(page.locator(".tab .tab-name")).toHaveText(["Offsite notes", "plan"]);
  await expect.poll(() => windowTitle(app)).toBe("plan");
  // The tab's tooltip still says where the file is, in full.
  await expect(page.locator(".tab").last()).toHaveAttribute("title", plan);
  await expect(page.locator(".tab").last()).toHaveAttribute("aria-label", "plan");
  await expect.poll(() => windowMenu(app)).toEqual(["Offsite notes", "plan"]);
  const copied = await captureClipboard(app);
  await clickMenu(app, "copy-path");
  await expect.poll(copied).toBe(plan);

  // Moved to the Trash: the notice names it as the tab did.
  mkdirSync(join(run.folder, ".Trash"));
  renameSync(plan, join(run.folder, ".Trash", "plan.md"));
  await expect(page.locator(".window-notices .file-notice")).toContainText("plan was moved to the Trash, so Corillo closed it.");

  await clickMenu(app, "close-tab");
  await expect(page.locator("#empty")).toBeVisible();
  await expect(page.locator("#recent .recent-name")).toContainText(["plan", "Offsite notes"]);
  await expect(page.locator("#recent .recent-card", { hasText: "Offsite notes" })).toHaveAttribute("aria-label", /^Open Offsite notes, in /);
  await app.close();
});

// A blank document says what to do -------------------------------------------------------------

/** Pretend the person chose this name and folder in the next New Document dialog. */
async function nameNext(app: ElectronApplication, filePath: string): Promise<void> {
  await app.evaluate(({ dialog }, picked) => {
    dialog.showSaveDialog = (async () => ({ canceled: false, filePath: picked })) as typeof dialog.showSaveDialog;
  }, filePath);
}

/** File > New Document, named this: its tab in front. */
async function newDocument(run: Running, filePath: string): Promise<void> {
  await nameNext(run.app, filePath);
  await clickMenu(run.app, "new-document");
  await expect.poll(() => existsSync(filePath)).toBe(true);
  await expect.poll(async () => (await tabState(run.page)).active).toBe(filePath.slice(filePath.lastIndexOf("/") + 1));
}

const HINT = `${EDITOR} .blank-hint`;
const PANEL_EMPTY = ".doc:not([hidden]) .comments-empty";

test("a new, empty document says on the page how to start, never in the file, and the line goes at the first keystroke (P-8)", async () => {
  const run = await openText("First.\n");
  const { page, app } = run;
  const home = await app.evaluate(() => process.env.CORILLO_HOME!);
  mkdirSync(join(home, "Documents", "Work"), { recursive: true });
  const file = join(home, "Documents", "Work", "Q4 brief.md");
  await newDocument(run, file);
  const hint = page.locator(HINT);
  await expect(hint).toBeVisible();
  await expect(hint).toContainText("Start typing, or paste from Word or Google Docs.");
  await expect(hint).toContainText("Or ask your agent to write it:");
  await expect(hint).toContainText("A Word document can also be opened with File > Open.");
  // On the page, beside the text, never in it: the document holds one empty line and nothing else.
  await expect(page.locator(`${EDITOR} .ProseMirror .blank-hint`)).toHaveCount(0);
  expect(await page.locator(`${EDITOR} .ProseMirror`).innerHTML()).toBe('<p class="empty-line"><br class="ProseMirror-trailingBreak"></p>');
  // Its first line sits on the document's first line, where the cursor is.
  const first = (await page.locator(`${EDITOR} .ProseMirror > p`).boundingBox())!;
  const line = (await hint.locator(".blank-hint-first").boundingBox())!;
  expect(Math.abs(line.y - first.y)).toBeLessThanOrEqual(1);
  await expect(page.locator(PANEL_EMPTY)).toHaveText("Comments go here once there's something to comment on.");

  // Copy a request for the agent, naming the document and its folder as the person knows them.
  const copied = await captureClipboard(app);
  await hint.getByRole("button", { name: "Copy a request" }).click();
  expect(await copied()).toBe(`Write a first draft of "Q4 brief" in Corillo (it's in Documents › Work). `);
  await expect(hint).toContainText("Copied. Paste it in your agent's chat and say what to write.");

  await page.waitForTimeout(500);
  expect(statSync(file).size).toBe(0);

  // The first keystroke takes it away; the panel says what it always says.
  await page.locator(`${EDITOR} .ProseMirror`).focus();
  await page.keyboard.type("A");
  await expect(hint).toBeHidden();
  await expect(page.locator(PANEL_EMPTY)).toContainText("Select some words, then choose New comment");
  await expect.poll(() => readFileSync(file, "utf8")).toBe("A\n");
  // Emptied again, the page says it again.
  await page.keyboard.press("Backspace");
  await expect(hint).toBeVisible();
  await app.close();
});

test("with line numbers on, a blank document's hint adds no line and no number (P-8)", async () => {
  const run = await openText("");
  const { page, app } = run;
  await clickMenu(app, "line-numbers");
  await expect(page.locator(HINT)).toBeVisible();
  // The page's own text is one empty line, numbered as it always was, and the hint adds none.
  expect(await page.locator(`${EDITOR} .ProseMirror`).innerHTML()).not.toContain("blank-hint");
  await expect(page.locator(`${EDITOR} [data-ln]`)).toHaveCount(await page.locator(`${EDITOR} .ProseMirror [data-ln]`).count());
  const pm = (await page.locator(`${EDITOR} .ProseMirror`).boundingBox())!;
  const p = (await page.locator(`${EDITOR} .ProseMirror > p`).boundingBox())!;
  expect(pm.height).toBeCloseTo(p.height, 0);
  expect(run.text()).toBe("");
  await app.close();
});

test("a paste, or an agent writing the draft, takes the blank document's hint away (P-8)", async () => {
  const run = await openText("");
  const { page } = run;
  await expect(page.locator(HINT)).toBeVisible();
  await page.locator(`${EDITOR} .ProseMirror`).focus();
  await paste(page, { "text/plain": "Pasted words." });
  await expect(page.locator(HINT)).toBeHidden();

  const other = await openAlso(run, "draft.md", "");
  await expect(page.locator(HINT)).toBeVisible();
  const { session } = await AgentSession.start(run.dataDir, "claude-ai");
  try {
    await session.ok("take_document", { path: other });
    // While the agent has it, the page doesn't ask the person to start.
    await expect(page.locator(HINT)).toBeHidden();
    await session.ok("replace_document", { path: other, text: "# Offsite\n\nTwo days in Ponce.\n" });
    await session.ok("finish_editing", { path: other });
    await expect(page.locator(`${EDITOR} h1`)).toHaveText("Offsite");
    await expect(page.locator(HINT)).toBeHidden();
  } finally {
    await session.stop();
  }
  await run.app.close();
});

// No leftover empty document ----------------------------------------------------------------------

test("a new document closed with nothing typed leaves no empty file and no card behind; one written in stays (quick win 8)", async () => {
  const run = await openText("First.\n");
  const { page, app } = run;

  // Made and closed straight away: gone, from the folder and the recent list.
  const untitled = join(run.folder, "Untitled.md");
  await newDocument(run, untitled);
  await clickMenu(app, "close-tab");
  await expect.poll(() => existsSync(untitled)).toBe(false);
  await expect.poll(() => recentMenu(app)).toEqual(["proposal"]);

  // Typed in: kept.
  const typed = join(run.folder, "Typed.md");
  await newDocument(run, typed);
  await page.locator(`${EDITOR} .ProseMirror`).focus();
  await page.keyboard.type("Kept.");
  await expect.poll(() => readFileSync(typed, "utf8")).toBe("Kept.\n");
  await clickMenu(app, "close-tab");
  await page.waitForTimeout(300);
  expect(readFileSync(typed, "utf8")).toBe("Kept.\n");

  // Written by an agent: kept.
  const drafted = join(run.folder, "Drafted.md");
  await newDocument(run, drafted);
  const { session } = await AgentSession.start(run.dataDir, "claude-ai");
  try {
    await session.ok("take_document", { path: drafted });
    await session.ok("replace_document", { path: drafted, text: "A draft.\n" });
    await session.ok("finish_editing", { path: drafted });
  } finally {
    await session.stop();
  }
  await expect(page.locator(`${EDITOR} p`)).toHaveText("A draft.");
  await clickMenu(app, "close-tab");
  await page.waitForTimeout(300);
  expect(readFileSync(drafted, "utf8")).toBe("A draft.\n");

  // An empty file Corillo didn't make is never taken away.
  const theirs = join(run.folder, "Theirs.md");
  writeFileSync(theirs, "");
  await openFromFinder(app, theirs);
  await expect.poll(async () => (await tabState(page)).active).toBe("Theirs.md");
  await clickMenu(app, "close-tab");
  await page.waitForTimeout(300);
  expect(existsSync(theirs)).toBe(true);

  // The start screen has no card for the one that went.
  await clickMenu(app, "close-tab");
  await expect(page.locator("#empty")).toBeVisible();
  await expect.poll(async () => (await page.locator("#recent .recent-name").allTextContents()).sort()).toEqual(["Drafted", "Theirs", "Typed", "proposal"]);
  await app.close();
});

test("after Copy a request, the blank document stays when its tab is closed: the agent may be writing it (B5-07)", async () => {
  const run = await openText("First.\n");
  const file = join(run.folder, "Q4 brief.md");
  await newDocument(run, file);
  await captureClipboard(run.app);
  await run.page.locator(HINT).getByRole("button", { name: "Copy a request" }).click();
  await expect(run.page.locator(HINT)).toContainText("Copied.");
  await clickMenu(run.app, "close-tab");
  await expect.poll(async () => (await tabState(run.page)).names).toEqual(["proposal.md"]);
  await run.page.waitForTimeout(300);
  expect(existsSync(file)).toBe(true);
  expect(await recentMenu(run.app)).toContain("Q4 brief");
  await run.app.close();
});

/** Note every error nobody caught in Corillo's main program, and keep its "Something went wrong" box from showing. */
async function noteTroubles(app: ElectronApplication): Promise<() => Promise<string[]>> {
  await app.evaluate(({ dialog }) => {
    const g = globalThis as unknown as { troubles: string[] };
    g.troubles = [];
    process.on("uncaughtException", (err) => g.troubles.push(String(err)));
    dialog.showMessageBox = (async () => ({ response: 0, checkboxChecked: false })) as unknown as typeof dialog.showMessageBox;
  });
  return () => app.evaluate(() => (globalThis as unknown as { troubles: string[] }).troubles);
}

const windowCount = (app: ElectronApplication) => app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows().length);

test("closing the window with a new, empty document open takes it away with no error, and the next window still saves its last typing (B5-03)", async () => {
  const run = await openText("First.\n");
  const { app } = run;
  const troubles = await noteTroubles(app);
  const untitled = join(run.folder, "Untitled.md");
  await newDocument(run, untitled);
  await settle(run.page);
  // The window's red button: the window goes, Corillo stays.
  await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].close());
  await expect.poll(() => windowCount(app)).toBe(0);
  await expect.poll(() => existsSync(untitled)).toBe(false);
  expect(await troubles()).toEqual([]);

  // The next window: typed in and closed straight away, its words are saved first.
  const [page] = await Promise.all([app.waitForEvent("window"), openFromFinder(app, run.file)]);
  await page.waitForSelector(".ProseMirror");
  await cursorAtEnd(page, "First.");
  await page.keyboard.type(" Saved.");
  await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].close());
  await expect.poll(() => windowCount(app)).toBe(0);
  expect(run.text()).toBe("First. Saved.\n");
  expect(await troubles()).toEqual([]);
  await app.close();
});

test("a new document left empty when Corillo quits is taken away too (quick win 8)", async () => {
  const run = await openText("First.\n");
  const untitled = join(run.folder, "Untitled.md");
  await newDocument(run, untitled);
  await settle(run.page);
  const exited = new Promise((resolve) => run.app.process().once("exit", resolve));
  await run.app.evaluate(({ app }) => app.quit());
  await expect.poll(() => existsSync(untitled), { timeout: 10_000 }).toBe(false);
  expect(run.text()).toBe("First.\n");
  await exited; // Corillo has ended inside this test, so what its window threw is checked (the review of Batch 19, R19-11)
});
