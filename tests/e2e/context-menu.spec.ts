// The right-click menu. Corillo is handed what the browser would report about
// the spot clicked, and the test reads back the menu it would show; no real
// menu opens.
import { test, expect, type ElectronApplication, type Page } from "@playwright/test";
import {
  openText,
  expectFile,
  cursorAtEnd,
  settle,
  rightClick,
  chooseInContextMenu,
  captureClipboard,
  tableCells,
  selectText,
  EDITOR,
  type ContextMenuEntry,
} from "./helpers";
import { AgentSession } from "./agent-session";

const DOC = "Our teh plan has a [link](https://example.com/plan) in it.\n";

const shown = (items: ContextMenuEntry[]) => items.filter((i) => i.type !== "separator" && i.visible).map((i) => i.label);
const item = (items: ContextMenuEntry[], label: string) => items.find((i) => i.label === label);

/** Menu actions the page receives, recorded from now on. */
async function recordMenuActions(page: Page): Promise<() => Promise<string[]>> {
  await page.evaluate(() => {
    const w = window as unknown as { menuActions: string[] };
    w.menuActions = [];
    window.corillo.onMenu((action) => w.menuActions.push(action));
  });
  return () => page.evaluate(() => (window as unknown as { menuActions: string[] }).menuActions);
}

test("with nothing selected, Cut, Copy and New Comment are greyed out and Paste is not", async () => {
  const run = await openText(DOC);
  const items = await rightClick(run.app, {});
  expect(shown(items)).toEqual(["Cut", "Copy", "Paste", "Paste and Match Style", "Select All", "New Comment"]);
  expect(item(items, "Cut")?.enabled).toBe(false);
  expect(item(items, "Copy")?.enabled).toBe(false);
  expect(item(items, "Paste")?.enabled).toBe(true);
  expect(item(items, "Paste and Match Style")?.enabled).toBe(true);
  expect(item(items, "Select All")?.enabled).toBe(true);
  expect(item(items, "New Comment")?.enabled).toBe(false);
  await run.app.close();
});

test("with words selected, Cut, Copy and New Comment can be chosen, and New Comment starts a comment", async () => {
  const run = await openText(DOC);
  const actions = await recordMenuActions(run.page);
  const items = await rightClick(run.app, {
    selectionText: "plan",
    editFlags: { canUndo: true, canRedo: false, canCut: true, canCopy: true, canPaste: true, canDelete: true, canSelectAll: true, canEditRichly: true },
  });
  expect(item(items, "Cut")?.enabled).toBe(true);
  expect(item(items, "Copy")?.enabled).toBe(true);
  expect(item(items, "New Comment")?.enabled).toBe(true);
  await chooseInContextMenu(run.app, "New Comment");
  await expect.poll(actions).toEqual(["comment:add"]);
  await run.app.close();
});

test("Paste and Match Style in the right-click menu pastes plain text", async () => {
  const run = await openText(DOC);
  const actions = await recordMenuActions(run.page);
  await rightClick(run.app, {});
  await chooseInContextMenu(run.app, "Paste and Match Style");
  await expect.poll(actions).toEqual(["paste:plain"]);
  await run.app.close();
});

test("a misspelled word shows the Mac's suggestions first, and choosing one replaces the word", async () => {
  const run = await openText(DOC);
  await cursorAtEnd(run.page, "Our teh");
  await run.page.keyboard.press("Meta+ArrowLeft");
  for (let i = 0; i < 6; i++) await run.page.keyboard.press("ArrowRight"); // inside "teh"
  await settle(run.page);
  const items = await rightClick(run.app, { misspelledWord: "teh", dictionarySuggestions: ["the", "ten", "tech"] });
  expect(shown(items).slice(0, 4)).toEqual(["the", "ten", "tech", "Learn Spelling"]);
  await chooseInContextMenu(run.app, "the");
  await expectFile(run, DOC.replace("teh", "the"));
  // One undo puts the word back.
  await run.page.keyboard.press("Meta+z");
  await expectFile(run, DOC);
  await run.app.close();
});

test("Learn Spelling adds the word to the Mac's dictionary", async () => {
  const run = await openText(DOC);
  // Stand in for the real dictionary, which this test must not change.
  await run.app.evaluate(({ BrowserWindow }) => {
    const g = globalThis as unknown as { learned: string[] };
    g.learned = [];
    BrowserWindow.getAllWindows()[0].webContents.session.addWordToSpellCheckerDictionary = (word: string) => {
      g.learned.push(word);
      return true;
    };
  });
  const items = await rightClick(run.app, { misspelledWord: "Corillo", dictionarySuggestions: [] });
  expect(shown(items)[0]).toBe("No Guesses Found");
  expect(item(items, "No Guesses Found")?.enabled).toBe(false);
  await chooseInContextMenu(run.app, "Learn Spelling");
  expect(await run.app.evaluate(() => (globalThis as unknown as { learned: string[] }).learned)).toEqual(["Corillo"]);
  await run.app.close();
});

test("on a link, Open Link opens it in the browser", async () => {
  const run = await openText(DOC);
  await run.app.evaluate(({ shell }) => {
    const g = globalThis as unknown as { opened: string[] };
    g.opened = [];
    shell.openExternal = async (url: string) => {
      g.opened.push(url);
    };
  });
  const items = await rightClick(run.app, { linkURL: "https://example.com/plan", linkText: "link" });
  expect(shown(items).slice(0, 4)).toEqual(["Open Link", "Edit Link…", "Copy Link", "Remove Link"]);
  await chooseInContextMenu(run.app, "Open Link");
  await expect.poll(() => run.app.evaluate(() => (globalThis as unknown as { opened: string[] }).opened)).toEqual([
    "https://example.com/plan",
  ]);
  await run.app.close();
});

test("Open Link is greyed out for links that aren't web or email addresses", async () => {
  const run = await openText(DOC);
  const items = await rightClick(run.app, { linkURL: "javascript:alert(1)" });
  expect(item(items, "Open Link")?.enabled).toBe(false);
  await run.app.close();
});

test("on a link, Edit Link opens the link box for that link", async () => {
  const run = await openText(DOC);
  await cursorAtEnd(run.page, "Our teh");
  await run.page.keyboard.press("Meta+ArrowLeft");
  for (let i = 0; i < 21; i++) await run.page.keyboard.press("ArrowRight"); // inside "link"
  await settle(run.page);
  await rightClick(run.app, { linkURL: "https://example.com/plan", linkText: "link" });
  await chooseInContextMenu(run.app, "Edit Link…");
  await expect(run.page.locator(".link-editor")).toBeVisible();
  await expect(run.page.locator('.link-editor input[name="href"]')).toHaveValue("https://example.com/plan");
  await run.app.close();
});

test("on a link, Copy Link copies its address, and Remove Link takes the link off and keeps its words", async () => {
  const run = await openText(DOC);
  const copied = await captureClipboard(run.app);
  await rightClick(run.app, { linkURL: "https://example.com/plan", linkText: "link" });
  await chooseInContextMenu(run.app, "Copy Link");
  await expect.poll(copied).toBe("https://example.com/plan");

  await cursorAtEnd(run.page, "Our teh");
  await run.page.keyboard.press("Meta+ArrowLeft");
  for (let i = 0; i < 21; i++) await run.page.keyboard.press("ArrowRight"); // inside "link"
  await settle(run.page);
  await rightClick(run.app, { linkURL: "https://example.com/plan", linkText: "link" });
  await chooseInContextMenu(run.app, "Remove Link");
  await expectFile(run, "Our teh plan has a link in it.\n");
  // Outside the document (a link in a comment, say), there's nothing to remove.
  const elsewhere = await rightClick(run.app, { linkURL: "https://example.com/plan", isEditable: false });
  expect(shown(elsewhere)).toEqual(["Open Link", "Copy Link", "Cut", "Copy", "Paste", "Paste and Match Style", "Select All", "New Comment"]);
  await run.app.close();
});

/** Right-click for real, at a spot in the window; the menu Corillo builds is kept instead of shown. */
async function rightClickOn(app: ElectronApplication, page: Page, selector: string, text: string): Promise<ContextMenuEntry[]> {
  await app.evaluate(({ Menu }) => {
    const g = globalThis as unknown as { shownMenu: Electron.Menu | null };
    g.shownMenu = null;
    Menu.prototype.popup = function (this: Electron.Menu) {
      g.shownMenu = this;
    };
  });
  await page.locator(selector, { hasText: text }).first().click({ button: "right" });
  await expect.poll(() => app.evaluate(() => !!(globalThis as unknown as { shownMenu: unknown }).shownMenu)).toBe(true);
  return app.evaluate(() => {
    const menu = (globalThis as unknown as { shownMenu: Electron.Menu }).shownMenu;
    return menu.items.map((i) => ({ id: i.id, label: i.label, enabled: i.enabled, visible: i.visible, type: i.type }));
  });
}

const TABLE_ITEMS = ["Add Row Above", "Add Row Below", "Add Column Left", "Add Column Right", "Delete Row", "Delete Column", "Delete Table"];
const TABLE_DOC = "| Name | Role |\n| --- | --- |\n| Ana | Sales |\n| Ben | Ops |\n\nAfter the table.\n";

test("in a table, the right-click menu has the Table menu's rows and columns, for the cell clicked", async () => {
  const run = await openText(TABLE_DOC);
  const { app, page } = run;
  const cells = `${EDITOR} td, ${EDITOR} th`;

  // Outside the table, none of them.
  const outside = await rightClickOn(app, page, `${EDITOR} p`, "After the table.");
  expect(shown(outside).filter((l) => TABLE_ITEMS.includes(l))).toEqual([]);

  // In a cell, all of them, after the usual ones.
  const inCell = await rightClickOn(app, page, cells, "Ben");
  expect(shown(inCell).slice(-TABLE_ITEMS.length)).toEqual(TABLE_ITEMS);
  expect(inCell.filter((i) => TABLE_ITEMS.includes(i.label)).every((i) => i.enabled)).toBe(true);
  await chooseInContextMenu(app, "Add Row Below");
  await expect.poll(() => tableCells(page)).toEqual([["Name", "Role"], ["Ana", "Sales"], ["Ben", "Ops"], ["", ""]]);

  // They act on the cell clicked, wherever the cursor was.
  await rightClickOn(app, page, cells, "Ana");
  await chooseInContextMenu(app, "Delete Row");
  await expect.poll(() => tableCells(page)).toEqual([["Name", "Role"], ["Ben", "Ops"], ["", ""]]);
  await rightClickOn(app, page, cells, "Role");
  await chooseInContextMenu(app, "Delete Column");
  await expect.poll(() => tableCells(page)).toEqual([["Name"], ["Ben"], [""]]);
  await run.app.close();
});

test("while an agent edits, the table items are there but greyed out", async () => {
  const run = await openText(TABLE_DOC);
  const { session } = await AgentSession.start(run.dataDir, "claude-code");
  try {
    await session.ok("take_document", { path: run.file });
    await expect(run.page.locator(".doc:not([hidden]) .agent-notice")).toContainText("Claude is editing");
    // (With nothing selected in text that can't be edited, there's no menu at all.)
    await selectText(run.page, "Ben");
    const items = await rightClickOn(run.app, run.page, `${EDITOR} td`, "Ben");
    const table = items.filter((i) => TABLE_ITEMS.includes(i.label));
    expect(table.map((i) => i.label)).toEqual(TABLE_ITEMS);
    expect(table.some((i) => i.enabled)).toBe(false);
  } finally {
    await session.stop();
  }
  await run.app.close();
});

test("outside the document, in a text box, there is no New Comment item", async () => {
  const run = await openText(DOC);
  const items = await rightClick(run.app, { formControlType: "input-text" });
  expect(shown(items)).toEqual(["Cut", "Copy", "Paste", "Paste and Match Style", "Select All"]);
  await run.app.close();
});

test("right-clicking somewhere that can't be edited, with nothing selected, shows no menu", async () => {
  const run = await openText(DOC);
  const items = await rightClick(run.app, { isEditable: false });
  expect(items).toEqual([]);
  await run.app.close();
});
