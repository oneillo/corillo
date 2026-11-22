// Version history: Show changes, the History panel, looking at an older
// version, restoring it, and changes made outside Corillo.
import { test, expect, type Page } from "@playwright/test";
import { writeFileSync } from "node:fs";
import { openText, expectFile, cursorAtEnd, clickMenu, EDITOR } from "./helpers";
import { AgentSession } from "./agent-session";
import { bigDocument } from "../fixtures/big-document";

const PANEL = ".doc:not([hidden]) .history-panel";
const VERSION = ".doc:not([hidden]) .version-view .ProseMirror";
const BANNER = ".doc:not([hidden]) .version-banner";

/** Who made each version in the History panel, newest first. */
function historyList(page: Page): Promise<string[]> {
  return page.locator(`${PANEL} .history-who`).allTextContents();
}

function historyItem(page: Page, who: string | RegExp) {
  return page.locator(`${PANEL} .history-item`).filter({ has: page.locator(".history-who", { hasText: who }) });
}

const openHistory = (page: Page) => page.getByRole("button", { name: "History", exact: true }).click();
const showChanges = (page: Page) => page.locator("#toolbar").getByRole("button", { name: "Show changes" });

test("edits made, closed and reopened are listed in the history as one version by you", async () => {
  const run = await openText("# Plan\n\nFirst point here.\n");
  await cursorAtEnd(run.page, "First point here.");
  await run.page.keyboard.type(" More.");
  await expectFile(run, "# Plan\n\nFirst point here. More.\n");
  await clickMenu(run.app, "close-tab");
  await run.page.evaluate((p) => window.corillo.openPath(p), run.file);
  await cursorAtEnd(run.page, "First point here.");
  await run.page.keyboard.type(" After reopening.");
  await expectFile(run, "# Plan\n\nFirst point here. More. After reopening.\n");
  await openHistory(run.page);
  await expect(run.page.locator(PANEL)).toBeVisible();
  await expect.poll(() => historyList(run.page)).toEqual(["You", "First version"]);
  await expect(historyItem(run.page, /^You$/).locator(".history-tag")).toHaveText("Current");
  await expect(historyItem(run.page, /^You$/).locator(".history-when")).toHaveText("Just now");
  // The panel closes with its button.
  await run.page.getByRole("button", { name: "Close history" }).click();
  await expect(run.page.locator(PANEL)).toBeHidden();
  await run.app.close();
});

// Changed 2026-11-10 (roadmap Batch 3, item 1): Show changes shows what agents changed since the hand-over, so an agent makes the change here.
test("Show changes marks added words and struck-through removed words, and turns off with one click", async () => {
  const run = await openText("# Plan\n\nThe quick brown fox jumps.\n");
  const { session } = await AgentSession.start(run.dataDir);
  await session.ok("take_document", { path: run.file });
  await session.ok("edit_document", { path: run.file, edits: [{ find: "fox jumps.", replace: "fox runs. Added words." }] });
  await session.ok("finish_editing", { path: run.file });
  await session.stop();
  await expectFile(run, "# Plan\n\nThe quick brown fox runs. Added words.\n");
  await expect(run.page.locator(EDITOR)).toContainText("Added words.");

  await expect(showChanges(run.page)).toHaveAttribute("aria-pressed", "false");
  await showChanges(run.page).click();
  await expect(showChanges(run.page)).toHaveAttribute("aria-pressed", "true");
  await expect(run.page.locator(`${VERSION} ins.diff-added`)).toHaveText("runs. Added words"); // the full stop was already there
  await expect(run.page.locator(`${VERSION} del.diff-removed`)).toHaveText("jumps");
  await expect(run.page.locator(BANNER)).toContainText("1 change by Claude since you handed it over at");
  // The formatting buttons don't apply while changes are shown, and the page can't be edited.
  await expect(run.page.getByRole("button", { name: "Bold", exact: true })).toBeDisabled();
  await expect(run.page.locator(VERSION)).toHaveAttribute("contenteditable", "false");
  await expect(run.page.locator(EDITOR)).toBeHidden();

  await showChanges(run.page).click();
  await expect(run.page.locator(EDITOR)).toBeVisible();
  await expect(run.page.locator(BANNER)).toBeHidden();
  await cursorAtEnd(run.page, "Added words.");
  await run.page.keyboard.type(" Typing again.");
  await expectFile(run, "# Plan\n\nThe quick brown fox runs. Added words. Typing again.\n");
  await run.app.close();
});

test("Escape, or Hide changes in the banner, goes back to editing", async () => {
  const run = await openText("One.\n");
  await cursorAtEnd(run.page, "One.");
  await run.page.keyboard.type(" Two.");
  await expectFile(run, "One. Two.\n");
  await showChanges(run.page).click();
  await expect(run.page.locator(BANNER)).toBeVisible();
  await run.page.keyboard.press("Escape");
  await expect(run.page.locator(EDITOR)).toBeVisible();
  await showChanges(run.page).click();
  // Its only way out is a plain button, like every bar's action (review of Batch 11, F-10, F-21).
  await expect(run.page.locator(BANNER).getByRole("button", { name: "Hide changes" })).not.toHaveClass(/primary/);
  await run.page.locator(BANNER).getByRole("button", { name: "Hide changes" }).click();
  await expect(run.page.locator(EDITOR)).toBeVisible();
  await expect(showChanges(run.page)).toHaveAttribute("aria-pressed", "false");
  await run.app.close();
});

test("picking an older version shows what it changed; restoring it saves its text and adds a Restored version", async () => {
  const run = await openText("# Plan\n\nOriginal text.\n");
  await cursorAtEnd(run.page, "Original text.");
  await run.page.keyboard.type(" Second.");
  await expectFile(run, "# Plan\n\nOriginal text. Second.\n");
  writeFileSync(run.file, "# Plan\n\nRewritten by another app.\n");
  await expect(run.page.locator(`${EDITOR} p`)).toHaveText("Rewritten by another app.");

  await openHistory(run.page);
  await expect.poll(() => historyList(run.page)).toEqual(["Changed outside Corillo", "You", "First version"]);
  await historyItem(run.page, /^You$/).click();
  await expect(historyItem(run.page, /^You$/)).toHaveAttribute("aria-current", "true");
  await expect(run.page.locator(BANNER)).toContainText("Version from");
  await expect(run.page.locator(BANNER)).toContainText("marked with what it changed");
  // Looking is what a version is opened for most often: going back is the main button, Restore a plain one (review of Batch 11, F-21).
  await expect(run.page.locator(BANNER).getByRole("button", { name: "Back to current" })).toHaveClass(/primary/);
  await expect(run.page.locator(BANNER).getByRole("button", { name: "Restore this version" })).not.toHaveClass(/primary/);
  await expect(run.page.locator(`${VERSION} ins.diff-added`)).toHaveText(" Second.");
  await expect(run.page.locator(EDITOR)).toBeHidden();

  // The version before it shows nothing earlier to compare with.
  await historyItem(run.page, "First version").click();
  await expect(run.page.locator(BANNER)).toContainText("nothing earlier to compare it with");
  // ...and doesn't also claim to be marked with what it changed.
  await expect(run.page.locator(BANNER)).not.toContainText("what it changed");
  await expect(run.page.locator(`${VERSION} .diff-added, ${VERSION} .diff-removed`)).toHaveCount(0);

  await historyItem(run.page, /^You$/).click();
  await run.page.getByRole("button", { name: "Restore this version" }).click();
  await expectFile(run, "# Plan\n\nOriginal text. Second.\n");
  await expect(run.page.locator(`${EDITOR} p`)).toHaveText("Original text. Second.");
  await expect.poll(() => historyList(run.page)).toEqual([
    expect.stringMatching(/^Restored version from /),
    "Changed outside Corillo",
    "You",
    "First version",
  ]);
  // Nothing was lost: the outside rewrite is still in the history.
  await historyItem(run.page, "Changed outside Corillo").click();
  await expect(run.page.locator(`${VERSION} .diff-added-block`)).toHaveText("Rewritten by another app.");
  await run.page.getByRole("button", { name: "Back to current" }).click();
  await expect(run.page.locator(EDITOR)).toBeVisible();
  await run.app.close();
});

test("a rewrite from outside Corillo shows up as a version, while open or while closed", async () => {
  const run = await openText("# Notes\n\nKept line.\n\nThe old ending of these notes.\n");
  writeFileSync(run.file, "# Notes\n\nKept line.\n\nThe new ending of these notes.\n");
  await expect(run.page.locator(`${EDITOR} p`).last()).toHaveText("The new ending of these notes.");
  await openHistory(run.page);
  await historyItem(run.page, "Changed outside Corillo").click();
  await expect(run.page.locator(BANNER)).toContainText("Changed outside Corillo");
  await expect(run.page.locator(`${VERSION} del.diff-removed`)).toHaveText("old");
  await expect(run.page.locator(`${VERSION} ins.diff-added`)).toHaveText("new");
  await run.page.getByRole("button", { name: "Close history" }).click();

  // Closed, rewritten, opened again.
  await clickMenu(run.app, "close-tab");
  writeFileSync(run.file, "# Notes\n\nKept line.\n\nWritten while closed.\n");
  await run.page.evaluate((p) => window.corillo.openPath(p), run.file);
  await openHistory(run.page);
  await expect.poll(() => historyList(run.page)).toEqual(["Changed outside Corillo", "Changed outside Corillo", "First version"]);
  await run.app.close();
});

test("with a mouse connected (scroll bars that take room), History's rows keep their width once there are enough versions to scroll", async () => {
  const run = await openText("# Notes\n\nVersion 0.\n");
  const { page } = run;
  // Scroll bars like the ones the Mac shows when a mouse is connected, whatever this Mac's own setting.
  await page.addStyleTag({ content: "::-webkit-scrollbar { width: 15px; height: 15px; } ::-webkit-scrollbar-thumb { background: #888; }" });
  await page.setViewportSize({ width: 1200, height: 480 });
  await openHistory(page);
  const list = `${PANEL} .history-list`;
  const scrolls = () => page.locator(list).evaluate((l) => l.scrollHeight > l.clientHeight);
  const rowWidth = () => page.locator(`${PANEL} .history-item`).last().evaluate((r) => r.getBoundingClientRect().width);
  const before = await rowWidth();
  // Each rewrite from outside Corillo is a version, until the list is long enough to scroll.
  for (let i = 1; i <= 20 && !(await scrolls()); i++) {
    writeFileSync(run.file, `# Notes\n\nVersion ${i}.\n`);
    await expect(page.locator(`${EDITOR} p`)).toHaveText(`Version ${i}.`);
    await expect(page.locator(`${PANEL} .history-item`)).toHaveCount(i + 1);
  }
  expect(await scrolls()).toBe(true);
  expect(await rowWidth()).toBe(before);
  await run.app.close();
});

test("a table change is marked in its cells, and a new row as a whole", async () => {
  const run = await openText("| Name | Cost |\n| --- | --- |\n| Tool A | 12 |\n");
  writeFileSync(run.file, "| Name | Cost |\n| --- | --- |\n| Tool A | 15 |\n| Tool B | 30 |\n");
  await expect(run.page.locator(`${EDITOR} td`, { hasText: "Tool B" })).toBeVisible();
  await openHistory(run.page);
  await historyItem(run.page, "Changed outside Corillo").click();
  await expect(run.page.locator(`${VERSION} td del.diff-removed`)).toHaveText("12");
  await expect(run.page.locator(`${VERSION} td ins.diff-added`)).toHaveText("15");
  await expect(run.page.locator(`${VERSION} tr.diff-added-block`)).toContainText("Tool B");
  await expect(run.page.locator(`${VERSION} tr`)).toHaveCount(3);
  await run.app.close();
});

test("a row taken out above a row whose date changed is the row struck through, and the date's old value is its own", async () => {
  const table = "| Phase | Date |\n| --- | --- |\n";
  const run = await openText(`${table}| Design | 1 June |\n| Build | 15 June |\n| Test | 29 June |\n`);
  writeFileSync(run.file, `${table}| Build | 22 June |\n| Test | 29 June |\n`);
  await expect(run.page.locator(`${EDITOR} td`, { hasText: "22 June" })).toBeVisible();
  await openHistory(run.page);
  await historyItem(run.page, "Changed outside Corillo").click();
  await expect(run.page.locator(`${VERSION} tr.diff-removed-block`)).toHaveCount(1);
  await expect(run.page.locator(`${VERSION} tr.diff-removed-block`)).toContainText("Design");
  await expect(run.page.locator(`${VERSION} tr:not(.diff-removed-block) .diff-removed`)).toHaveText(["15"]);
  await expect(run.page.locator(`${VERSION} tr:not(.diff-removed-block) .diff-added`)).toHaveText(["22"]);
  await run.app.close();
});

test("a paragraph put in between two bullets is the only thing marked", async () => {
  const run = await openText("# Launch\n\n- Email the members\n- Print the posters\n- Book the hall\n");
  writeFileSync(run.file, "# Launch\n\n- Email the members\n\nThe rest can wait until May.\n\n- Print the posters\n- Book the hall\n");
  await expect(run.page.locator(`${EDITOR} p`, { hasText: "The rest can wait until May." })).toBeVisible();
  await openHistory(run.page);
  await historyItem(run.page, "Changed outside Corillo").click();
  await expect(run.page.locator(`${VERSION} .diff-added-block`)).toHaveText(["The rest can wait until May."]);
  await expect(run.page.locator(`${VERSION} .diff-removed-block, ${VERSION} .diff-removed, ${VERSION} .diff-added`)).toHaveCount(0);
  await run.app.close();
});

test("a version marks a picture or footnote marker taken out of a paragraph, struck through", async () => {
  const run = await openText("# Notes\n\nSales rose ![chart](chart.png) in May[^1] overall.\n\n[^1]: Before returns.\n");
  writeFileSync(run.file, "# Notes\n\nSales rose in May overall.\n\n[^1]: Before returns.\n");
  await expect(run.page.locator(`${EDITOR} p`).first()).toHaveText("Sales rose in May overall.");
  await openHistory(run.page);
  await historyItem(run.page, "Changed outside Corillo").click();
  const removed = run.page.locator(`${VERSION} p`).first().locator("del.diff-removed");
  await expect(removed.locator("img")).toHaveAttribute("alt", "chart");
  await expect(removed.locator(".footnote-ref")).toHaveAttribute("data-number", "1");
  await run.app.close();
});

test("a late answer about an outside change doesn't undo a newer save: no false warning, history in order", async () => {
  // An outside app writes the file, and an agent saves a moment later, before
  // the window's "I've taken in the outside change" reaches Corillo. Here the
  // late answer is sent by hand, naming text that's no longer on disk.
  const run = await openText("# Plan\n\nOne.\n");
  const id = await run.page.locator(".doc:not([hidden])").getAttribute("data-doc-id");
  await run.page.evaluate(([docId]) => window.corillo.acceptDisk(docId!, "# Plan\n\nAn older outside text.\n"), [id]);
  await cursorAtEnd(run.page, "One.");
  await run.page.keyboard.type(" Two.");
  await expectFile(run, "# Plan\n\nOne. Two.\n");
  await expect(run.page.locator(".doc:not([hidden]) .banner.conflict")).toBeHidden();
  await openHistory(run.page);
  await expect.poll(() => historyList(run.page)).toEqual(["You", "First version"]);
  await run.app.close();
});

// A16-3: another app's save just before an agent's edit went into History as the agent's own.
test("another app's change that reaches the file just before an agent's edit has its own version, apart from the agent's", async () => {
  const plan = "# Plan\n\nWe should hire two people this quarter.\n";
  const theirs = `${plan}\nA paragraph another app added.\n`;
  const run = await openText(plan, { name: "plan.md" });
  const { session } = await AgentSession.start(run.dataDir, "claude-code");
  await session.ok("take_document", { path: run.file });
  // The agent's edit arrives before Corillo has taken in the other app's save.
  writeFileSync(run.file, theirs);
  const edit = await session.ok("edit_document", { path: run.file, edits: [{ find: "two people", replace: "three people" }] });
  expect(edit).toContain("changed outside Corillo");
  await session.ok("finish_editing", { path: run.file });
  await session.stop();
  await expectFile(run, theirs.replace("two people", "three people"));
  await openHistory(run.page);
  await expect.poll(() => historyList(run.page)).toEqual(["Claude", "Changed outside Corillo", "First version"]);
  // The outside version holds the other app's words; the agent's holds only its own change.
  await historyItem(run.page, "Changed outside Corillo").click();
  await expect(run.page.locator(`${VERSION} .diff-added-block`)).toHaveText(["A paragraph another app added."]);
  await expect(run.page.locator(`${VERSION} .diff-removed-block, ${VERSION} .diff-removed, ${VERSION} .diff-added`)).toHaveCount(0);
  await run.app.close();
});

test("an agent's new version shows in the open History list while Help is open, also after the document window was closed and opened again", async () => {
  const run = await openText("# Plan\n\nWe should hire two people.\n", { name: "plan.md" });
  const [help] = await Promise.all([run.app.waitForEvent("window"), clickMenu(run.app, "corillo-help")]);
  await help.waitForSelector(".help-page:not([hidden])");
  const { session } = await AgentSession.start(run.dataDir);
  const pass = async (from: string, to: string) => {
    await session.ok("take_document", { path: run.file });
    await session.ok("edit_document", { path: run.file, edits: [{ find: from, replace: to }] });
    await session.ok("finish_editing", { path: run.file });
  };
  await openHistory(run.page);
  await expect.poll(() => historyList(run.page)).toEqual(["First version"]);
  await pass("two", "three");
  await expect.poll(() => historyList(run.page)).toEqual(["Claude", "First version"]);

  // The person closes the document window (Corillo keeps running, with Help open) and clicks the Dock icon.
  await run.app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows().find((w) => w.getTitle() !== "Corillo Help")!.close());
  await expect.poll(() => run.app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows().length)).toBe(1);
  const [page] = await Promise.all([run.app.waitForEvent("window"), run.app.evaluate(({ app }) => app.emit("activate"))]);
  await page.waitForSelector("#empty:not([hidden])");
  await page.evaluate((p) => window.corillo.openPath(p), run.file);
  await page.waitForSelector(".ProseMirror");
  await openHistory(page);
  await expect.poll(() => historyList(page)).toEqual(["Claude", "First version"]);
  await pass("three", "four");
  await expect.poll(() => historyList(page)).toEqual(["Claude", "Claude", "First version"]);
  await run.app.close();
  await session.stop();
});

test("a version picked in History is shown even when a new version arrives while it loads, with Show changes on", async () => {
  const run = await openText("# Plan\n\nOne.\n");
  await cursorAtEnd(run.page, "One.");
  await run.page.keyboard.type(" Two.");
  await expectFile(run, "# Plan\n\nOne. Two.\n");
  await showChanges(run.page).click();
  await expect(run.page.locator(BANNER)).toContainText("You haven't handed this document to an agent yet");
  await openHistory(run.page);
  await expect.poll(() => historyList(run.page)).toEqual(["You", "First version"]);
  // The first version's text is slow to come (a long document's old version), until let go.
  await run.app.evaluate(({ ipcMain }) => {
    const handlers = (ipcMain as unknown as { _invokeHandlers: Map<string, (...a: unknown[]) => unknown> })._invokeHandlers;
    const real = handlers.get("history:version")!;
    const g = globalThis as unknown as { letGo: () => void };
    const held = new Promise<void>((resolve) => (g.letGo = resolve));
    handlers.set("history:version", async (e, id, n) => {
      if (n === 1) await held;
      return real(e, id, n);
    });
  });
  await historyItem(run.page, "First version").click();
  // Meanwhile the file is rewritten by another app: a new latest version.
  writeFileSync(run.file, "# Plan\n\nOne. Two. Three.\n");
  await expect.poll(() => historyList(run.page)).toEqual(["Changed outside Corillo", "You", "First version"]);
  await run.page.waitForTimeout(300);
  await run.app.evaluate(() => (globalThis as unknown as { letGo: () => void }).letGo());
  // The version picked is the one shown.
  await expect(historyItem(run.page, "First version")).toHaveAttribute("aria-current", "true");
  await expect(run.page.locator(BANNER)).toContainText("Version from");
  await expect(run.page.locator(BANNER)).toContainText("nothing earlier to compare it with");
  await run.page.waitForTimeout(300);
  await expect(run.page.locator(BANNER)).toContainText("nothing earlier to compare it with");
  await run.app.close();
});

test("with History open, changes that come in a burst are taken together, and each time only what's new is asked for", async () => {
  const run = await openText("# Plan\n\nOne.\n");
  await cursorAtEnd(run.page, "One.");
  await run.page.keyboard.type(" Two.");
  await expectFile(run, "# Plan\n\nOne. Two.\n");
  await openHistory(run.page);
  await expect.poll(() => historyList(run.page)).toEqual(["You", "First version"]);
  await run.page.waitForTimeout(300);
  // Count, in Corillo, each time the window asks for the list, and what it says it has.
  await run.app.evaluate(({ ipcMain }) => {
    const handlers = (ipcMain as unknown as { _invokeHandlers: Map<string, (...a: unknown[]) => unknown> })._invokeHandlers;
    const asked: unknown[] = [];
    (globalThis as unknown as { asked: unknown[] }).asked = asked;
    const list = handlers.get("history:list")!;
    handlers.set("history:list", (e, id, known) => {
      asked.push(known ?? null);
      return list(e, id, known);
    });
  });
  // Twenty changes at once, as when an agent's pass and the saves around it arrive together.
  const id = await run.page.locator(".doc:not([hidden])").getAttribute("data-doc-id");
  await run.app.evaluate(({ BrowserWindow }, tabId) => {
    const win = BrowserWindow.getAllWindows()[0];
    for (let i = 0; i < 20; i++) win.webContents.send("history:changed", tabId);
  }, id);
  await run.page.waitForTimeout(1000);
  const asked = await run.app.evaluate(() => (globalThis as unknown as { asked: { count: number }[] }).asked);
  expect(asked.length).toBeGreaterThanOrEqual(1);
  expect(asked.length).toBeLessThanOrEqual(2);
  expect(asked.every((known) => known?.count === 2)).toBe(true);
  await expect.poll(() => historyList(run.page)).toEqual(["You", "First version"]);
  await run.app.close();
});

/** Words the page holds but doesn't draw: text with no place on screen, which a person reading would never see. */
function undrawn(page: Page): Promise<string[]> {
  return page.evaluate((editor) => {
    const missing: string[] = [];
    const root = document.querySelector(`${editor} .ProseMirror`)!;
    const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT);
    for (let t = walker.nextNode(); t; t = walker.nextNode()) {
      // A diagram's source and its drawing's own styles are never drawn as words.
      if (!t.textContent!.trim() || t.parentElement!.closest(".diagram > pre, style, svg")) continue;
      const range = document.createRange();
      range.selectNodeContents(t);
      if (!range.getClientRects().length) missing.push(t.textContent!);
    }
    return missing;
  }, EDITOR);
}

// Batch 11, F-1 (B-1): after Show changes, runs of plain words between bold,
// italic and links vanished from the page and the lines closed up, the next
// time the page marked something (a selection on a comment, Find), and stayed
// gone. The file, the Markdown view and Copy for Email still had them. It took
// a long document read far down.
test("after Show changes on a long document read far down, every word on the page is still drawn when Find marks words", async () => {
  const run = await openText(bigDocument(8), { name: "long.md" });
  const { page } = run;
  const { session } = await AgentSession.start(run.dataDir);
  try {
    await session.ok("take_document", { path: run.file });
    await session.ok("edit_document", { path: run.file, edits: [{ find: "# Annual report on the volunteer programme", replace: "# Annual report on our volunteer programme" }] });
    await session.ok("finish_editing", { path: run.file });
  } finally {
    await session.stop();
  }
  await expect(page.locator(EDITOR)).toContainText("Annual report on our");
  // Reading in chapter 3 or so.
  await page.locator(`${EDITOR} .ProseMirror > p`).nth(40).evaluate((p) => p.scrollIntoView({ block: "start" }));
  await showChanges(page).click();
  await expect(page.locator(BANNER)).toBeVisible();
  await showChanges(page).click();
  await expect(page.locator(BANNER)).toBeHidden();
  await page.keyboard.press("Meta+f");
  await page.keyboard.type("just");
  await expect(page.locator(`${EDITOR} .find-match`).first()).toBeAttached();
  expect(await undrawn(page)).toEqual([]);
  await page.keyboard.press("Escape");
  await expect(page.locator(`${EDITOR} .find-match`)).toHaveCount(0);
  expect(await undrawn(page)).toEqual([]);
  await run.app.close();
});

/** Where on screen (pixels from the window's top) the paragraph holding these words is drawn, in the editor or the page shown in its place. */
function drawnAt(page: Page, words: string): Promise<number | null> {
  return page.evaluate((w) => {
    const views = [".doc:not([hidden]) .version-view:not([hidden]) .ProseMirror", ".doc:not([hidden]) .canvas.with-side:not([hidden]) .ProseMirror"];
    for (const view of views) {
      const root = document.querySelector(view);
      if (!root || !root.checkVisibility()) continue;
      const p = [...root.querySelectorAll("p")].find((el) => el.textContent!.includes(w));
      return p ? Math.round(p.getBoundingClientRect().top) : null;
    }
    return null;
  }, words);
}

// Batch 11, F-6 (B-4): Show changes, and an older version picked in History,
// moved the page away from where he was reading (67 to 380 pixels), and so
// did going back.
test("Show changes, and an older version from History, keep the words he was reading where they were, on the way in and on the way back", async () => {
  const run = await openText(bigDocument(8), { name: "long.md" });
  const { page } = run;
  // Claude rewrites a paragraph near the top, so Show changes has struck-through words above the place the person reads.
  const second = run.text().split("\n").filter((line) => /^[A-Z]/.test(line) && line.length > 80)[1];
  const { session } = await AgentSession.start(run.dataDir);
  try {
    await session.ok("take_document", { path: run.file });
    await session.ok("edit_document", { path: run.file, edits: [{ find: second, replace: "A short new opening, rewritten by Claude." }] });
    await session.ok("finish_editing", { path: run.file });
  } finally {
    await session.stop();
  }
  await expect(page.locator(EDITOR)).toContainText("rewritten by Claude");
  // Reading in chapter 3 or so: a paragraph a third of the way down the window.
  const reading = (await page.locator(`${EDITOR} .ProseMirror > p`).nth(40).textContent())!.slice(0, 60);
  await page.locator(`${EDITOR} .ProseMirror > p`).nth(40).evaluate((p) => {
    const canvas = p.closest(".canvas")!;
    canvas.scrollTop += p.getBoundingClientRect().top - canvas.getBoundingClientRect().top - 200;
  });
  const at = await drawnAt(page, reading);
  expect(at).not.toBeNull();
  // (Within a pixel: a scroll position is a whole number of pixels, and the words may sit between two.)

  await showChanges(page).click();
  await expect(page.locator(BANNER)).toBeVisible();
  await expect.poll(async () => Math.abs((await drawnAt(page, reading))! - at!)).toBeLessThanOrEqual(1);
  await showChanges(page).click();
  await expect(page.locator(BANNER)).toBeHidden();
  await expect.poll(async () => Math.abs((await drawnAt(page, reading))! - at!)).toBeLessThanOrEqual(1);

  await openHistory(page);
  await historyItem(page, "First version").click();
  await expect(page.locator(BANNER)).toContainText("Version from");
  await expect.poll(async () => Math.abs((await drawnAt(page, reading))! - at!)).toBeLessThanOrEqual(1);
  await page.getByRole("button", { name: "Back to current" }).click();
  await expect(page.locator(BANNER)).toBeHidden();
  await expect.poll(async () => Math.abs((await drawnAt(page, reading))! - at!)).toBeLessThanOrEqual(1);
  await run.app.close();
});
