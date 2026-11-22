// The menu bar (spec: "Everything is discoverable"): every action in the
// window is in a menu, in Mac order and wording, greyed out where it doesn't
// apply, with words that say what it will do ("Hide Comments"), and its
// shortcut doing exactly what the item does.
import { test, expect, type ElectronApplication, type Page } from "@playwright/test";
import { unlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { canonicalAccelerator } from "../../src/core/accelerators";
import {
  openText,
  openAlso,
  clickMenu,
  clipboardHoldsText,
  selectText,
  cursorAtEnd,
  cursorInCell,
  settle,
  expectFile,
  pickInNextDialog,
  recentMenu,
  tableCells,
  tabState,
  EDITOR,
  FIXTURES,
} from "./helpers";
import { AgentSession } from "./agent-session";

const PANEL = ".doc:not([hidden]) .comments-panel";
const NOTICE = ".doc:not([hidden]) .agent-notice";

interface Item {
  id: string;
  label: string;
  accelerator: string | null;
  role: string | null;
  type: string;
  enabled: boolean;
  checked: boolean;
  visible: boolean;
  /** The menus it's in, from the top ("File", "Open Recent"). */
  path: string[];
}

/** Every item in the menu bar, in order. */
function menuBar(app: ElectronApplication): Promise<Item[]> {
  return app.evaluate(({ Menu }) => {
    const all: Item[] = [];
    const walk = (menu: Electron.Menu | null | undefined, path: string[]) => {
      for (const i of menu?.items ?? []) {
        const label = i.label || (i.role ?? "");
        all.push({
          id: i.id,
          label: i.label,
          accelerator: (i.accelerator as string | undefined) ?? null,
          role: i.role ?? null,
          type: i.type,
          enabled: i.enabled,
          checked: i.checked,
          visible: i.visible,
          path,
        });
        walk(i.submenu, [...path, label]);
      }
    };
    walk(Menu.getApplicationMenu(), []);
    return all;
  });
}

/** One item, as the menu bar shows it now. */
function menuItem(app: ElectronApplication, id: string): Promise<{ label: string; enabled: boolean; checked: boolean; accelerator: string | null }> {
  return app.evaluate(({ Menu }, itemId) => {
    const i = Menu.getApplicationMenu()?.getMenuItemById(itemId);
    if (!i) throw new Error(`No menu item ${itemId}`);
    return { label: i.label, enabled: i.enabled, checked: i.checked, accelerator: (i.accelerator as string | undefined) ?? null };
  }, id);
}

const enabled = async (app: ElectronApplication, id: string) => (await menuItem(app, id)).enabled;
const checked = async (app: ElectronApplication, id: string) => (await menuItem(app, id)).checked;
const label = async (app: ElectronApplication, id: string) => (await menuItem(app, id)).label;

/** Which of these items are enabled now. */
async function enabledOf(app: ElectronApplication, ids: string[]): Promise<Record<string, boolean>> {
  const result: Record<string, boolean> = {};
  for (const id of ids) result[id] = await enabled(app, id);
  return result;
}

const all = (ids: string[], on: boolean) => Object.fromEntries(ids.map((id) => [id, on]));

/** Choose an item and wait until the window has said what applies after it. */
async function choose(run: { app: ElectronApplication; page: Page }, id: string): Promise<void> {
  await clickMenu(run.app, id);
  await settle(run.page);
}

const FORMAT = [
  "style-paragraph", "style-h1", "style-h2", "style-h3", "style-h4",
  "format-bold", "format-italic", "format-strike", "format-code",
  "format-bullets", "format-numbers", "format-quote", "format-code-block",
];
const TABLE = [
  "table-add-row-above", "table-add-row-below", "table-add-column-left", "table-add-column-right",
  "table-align-left", "table-align-center", "table-align-right",
  "table-delete-row", "table-delete-column", "table-delete",
];

/**
 * Where each item in the menu bar is shown to work (or to be greyed out where
 * it doesn't apply). A new item fails the first test until it's added here
 * with a test of its own.
 */
const TESTED: Record<string, string> = {
  about: "about.spec.ts",
  "turn-sound": "your-turn.spec.ts",
  "new-document": "new-document.spec.ts",
  open: "menus.spec.ts",
  "open-recent": "menus.spec.ts",
  "clear-recent": "tabs.spec.ts",
  "close-tab": "tabs.spec.ts",
  "close-window": "menus.spec.ts",
  rename: "tabs.spec.ts",
  "copy-path": "tabs.spec.ts",
  "history-restore": "menus.spec.ts",
  "export-word": "export.spec.ts",
  "export-pdf": "menus.spec.ts",
  "export-settings": "menus.spec.ts",
  undo: "editing.spec.ts",
  redo: "editing.spec.ts",
  "paste-plain": "paste-copy.spec.ts",
  "copy-email": "paste-copy.spec.ts",
  "find-menu": "find.spec.ts",
  find: "find.spec.ts",
  "find-replace": "find.spec.ts",
  "find-next": "find.spec.ts",
  "find-previous": "find.spec.ts",
  "view-formatted": "menus.spec.ts",
  "view-markdown": "menus.spec.ts",
  "view-comments": "menus.spec.ts",
  "view-resolved": "menus.spec.ts",
  "view-changes": "menus.spec.ts",
  "view-history": "menus.spec.ts",
  "page-width": "page-width.spec.ts",
  "page-width-fixed": "page-width.spec.ts",
  "page-width-fill": "page-width.spec.ts",
  "line-numbers": "line-numbers.spec.ts",
  appearance: "appearance.spec.ts",
  "appearance-system": "appearance.spec.ts",
  "appearance-light": "appearance.spec.ts",
  "appearance-dark": "appearance.spec.ts",
  "view-outline": "outline.spec.ts",
  "area-next": "window-areas.spec.ts",
  "area-previous": "window-areas.spec.ts",
  "zoom-reset": "status-zoom.spec.ts",
  "zoom-in": "status-zoom.spec.ts",
  "zoom-out": "status-zoom.spec.ts",
  "comment-add": "comments.spec.ts",
  "insert-table": "menus.spec.ts",
  "insert-picture": "menus.spec.ts",
  "insert-footnote": "menus.spec.ts",
  "insert-line": "menus.spec.ts",
  "insert-link": "menus.spec.ts",
  "style-menu": "menus.spec.ts",
  ...Object.fromEntries([...FORMAT, ...TABLE, "format-indent", "format-outdent"].map((id) => [id, "menus.spec.ts"])),
  "review-next": "menus.spec.ts",
  "review-previous": "menus.spec.ts",
  "review-reply": "menus.spec.ts",
  "review-resolve": "menus.spec.ts",
  "review-delete": "menus.spec.ts",
  "review-before": "menus.spec.ts",
  "review-send": "send-to-claude.spec.ts",
  "take-over": "menus.spec.ts",
  "read-aloud": "read-aloud.spec.ts",
  "next-tab": "menus.spec.ts",
  "previous-tab": "menus.spec.ts",
  "move-tab-left": "tabs.spec.ts",
  "move-tab-right": "tabs.spec.ts",
  "corillo-help": "help.spec.ts",
  "markdown-help": "help.spec.ts",
  "keyboard-shortcuts": "help.spec.ts",
  "connect-agents": "connect-agents.spec.ts",
};

/** Shortcuts the Mac keeps for itself, or that every Mac app means the same thing by. */
const MAC_KEYS = [
  "CmdOrCtrl+H", "CmdOrCtrl+Alt+H", "CmdOrCtrl+Q", "CmdOrCtrl+M", "CmdOrCtrl+,", "CmdOrCtrl+`",
  "CmdOrCtrl+Tab", "CmdOrCtrl+Space", "Ctrl+Space", "Ctrl+Cmd+Space", "Ctrl+Cmd+F", "Ctrl+Cmd+Q", "Ctrl+Cmd+D",
  "CmdOrCtrl+Shift+3", "CmdOrCtrl+Shift+4", "CmdOrCtrl+Shift+5", "CmdOrCtrl+Shift+/",
  "CmdOrCtrl+Z", "CmdOrCtrl+Shift+Z", "CmdOrCtrl+X", "CmdOrCtrl+C", "CmdOrCtrl+V", "CmdOrCtrl+A",
  "CmdOrCtrl+S", "CmdOrCtrl+P", "CmdOrCtrl+T",
].map(canonicalAccelerator);
/** The Mac's own keys that Corillo's items carry for the very thing the Mac means by them: Edit > Undo and Redo (editing.ts). */
const MAC_ITEMS: Record<string, string> = { undo: canonicalAccelerator("CmdOrCtrl+Z"), redo: canonicalAccelerator("CmdOrCtrl+Shift+Z") };

/** Words Apple's title case leaves small, unless first or last. */
const SMALL = new Set(["a", "an", "the", "and", "but", "or", "nor", "as", "at", "by", "for", "from", "in", "into", "of", "on", "to", "with"]);

test("the menu bar: every item has its own id, every shortcut is used once and none is the Mac's own, in title case", async () => {
  const run = await openText("# Plan\n\nWe should hire two people.\n");
  const items = await menuBar(run.app);
  const real = items.filter((i) => i.type !== "separator");
  // Open Recent's documents, and the open documents the Window menu lists (your-turn.spec.ts), come and go.
  const ownIds = real.filter((i) => !/^recent-\d+$/.test(i.id) && !i.id.startsWith("window-doc-"));

  // Every item has an id, and no two share one.
  expect(real.filter((i) => !i.id).map((i) => `${i.path.join(" > ")} > ${i.label || i.role}`)).toEqual([]);
  const ids = real.map((i) => i.id);
  expect(ids.filter((id, n) => ids.indexOf(id) !== n)).toEqual([]);

  // Each shortcut is used once, and none takes one the Mac keeps for something else.
  const keyed = real.filter((i) => i.accelerator && !i.role);
  const keys = keyed.map((i) => canonicalAccelerator(i.accelerator!));
  expect(keyed.filter((_, n) => keys.indexOf(keys[n]) !== n).map((i) => `${i.label} (${i.accelerator})`)).toEqual([]);
  expect(keyed.filter((i, n) => MAC_KEYS.includes(keys[n]) && MAC_ITEMS[i.id] !== keys[n]).map((i) => `${i.label} (${i.accelerator})`)).toEqual([]);

  // Labels in title case; an ellipsis only where a window or a question follows.
  const notTitleCase = real
    .filter((i) => i.label && i.path[1] !== "Open Recent" && !i.id.startsWith("window-doc-")) // documents keep their own names
    .filter((i) => {
      const words = i.label.replace("…", "").split(" ");
      return words.some((w, n) => {
        const small = SMALL.has(w.toLowerCase()) && n > 0 && n < words.length - 1;
        return small ? w !== w.toLowerCase() : w[0] !== w[0].toUpperCase();
      });
    })
    .map((i) => i.label);
  expect(notTitleCase).toEqual([]);
  expect(real.filter((i) => i.label.includes("...")).map((i) => i.label)).toEqual([]);

  // The menus, in Mac order.
  const top = items.filter((i) => i.path.length === 0).map((i) => i.label);
  expect(top.slice(1)).toEqual(["File", "Edit", "View", "Insert", "Format", "Table", "Review", "Window", "Help"]);

  // Every item is shown to work somewhere (the Mac's own items, like Cut and Minimize, work as in every app).
  const untested = ownIds.filter((i) => !i.role && i.visible && !TESTED[i.id] && i.path.length > 0).map((i) => i.id);
  expect(untested).toEqual([]);
  await run.app.close();
});

test("with no document open, only what works without one is available", async () => {
  const run = await openText("# Plan\n");
  await clickMenu(run.app, "close-tab");
  await expect(run.page.locator("#empty")).toBeVisible();
  // The window's own items (all but Paste and Match Style, which works in any box) wait for a document.
  const windowItems = ["rename", "copy-path", "history-restore", "export-word", "export-pdf", "export-settings", "copy-email", "find", "find-next",
    "view-formatted", "view-markdown", "view-comments", "view-changes", "view-history", "comment-add", "insert-table", "insert-link",
    ...FORMAT, ...TABLE, "review-next", "review-previous", "review-resolve", "review-send", "take-over", "next-tab"];
  await expect.poll(() => enabledOf(run.app, windowItems)).toEqual(all(windowItems, false));
  const available = ["new-document", "open", "paste-plain", "corillo-help", "connect-agents"];
  await expect.poll(() => enabledOf(run.app, available)).toEqual(all(available, true));
  await run.app.close();
});

test("File: Open, Open Recent, Export to PDF, Export Settings and Close Window", async () => {
  const run = await openText("# Plan\n", { name: "plan.md" });
  const { app, page } = run;
  // Open…: the file chosen opens in a tab of its own.
  const notes = join(run.folder, "notes.md");
  writeFileSync(notes, "# Notes\n");
  await pickInNextDialog(app, notes);
  await choose(run, "open");
  await expect.poll(async () => (await tabState(page)).names).toEqual(["plan.md", "notes.md"]);
  // Open Recent: a document closed since opens again.
  await clickMenu(app, "close-tab");
  await expect.poll(async () => (await tabState(page)).names).toEqual(["plan.md"]);
  const recent = await menuBar(app);
  const entry = recent.find((i) => i.path[1] === "Open Recent" && i.label === "notes")!;
  await choose(run, entry.id);
  await expect.poll(async () => (await tabState(page)).active).toBe("notes.md");
  // Export to PDF… asks where to save the PDF.
  await app.evaluate(({ dialog }) => {
    const g = globalThis as unknown as { suggested: string };
    dialog.showSaveDialog = (async (...args: unknown[]) => {
      g.suggested = (args[args.length - 1] as { defaultPath?: string }).defaultPath ?? "";
      return { canceled: true, filePath: "" };
    }) as typeof dialog.showSaveDialog;
  });
  await choose(run, "export-pdf");
  await expect.poll(() => app.evaluate(() => (globalThis as unknown as { suggested: string }).suggested)).toMatch(/notes\.pdf$/);
  // Export Settings… opens the export settings.
  await choose(run, "export-settings");
  await expect(page.getByRole("dialog", { name: "Export settings" })).toBeVisible();
  await page.keyboard.press("Escape");
  // Close Window closes the window, documents and all.
  await clickMenu(app, "close-window");
  await expect.poll(() => app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows().length)).toBe(0);
  await run.app.close();
});

test("Format and Insert change the text, tick what the cursor is in, and grey out where they don't apply", async () => {
  const run = await openText("Alpha\n\nBravo\n\nCharlie\n\nDelta\n\nEcho one\n\nFoxtrot one\n\nGolf one\n\nHotel one\n\nIndia\n\nJuliet\n\nKilo\n\nLima\n\n- One\n- Two\n\nMike\n");
  const { app, page } = run;
  const editor = page.locator(EDITOR);

  // Styles, each ticked while the cursor is in it.
  for (const [words, id, tag] of [["Alpha", "style-h1", "h1"], ["Bravo", "style-h2", "h2"], ["Charlie", "style-h3", "h3"], ["Delta", "style-h4", "h4"]]) {
    await cursorAtEnd(page, words);
    await expect.poll(() => checked(app, "style-paragraph")).toBe(true);
    await choose(run, id);
    await expect(editor.locator(tag)).toHaveText(words);
    await expect.poll(() => checked(app, id)).toBe(true);
    expect(await checked(app, "style-paragraph")).toBe(false);
  }
  await choose(run, "style-paragraph");
  await expect(editor.locator("h4")).toHaveCount(0);

  // Text styles on selected words, ticked while the selection has them.
  for (const [words, id, tag] of [["Echo", "format-bold", "strong"], ["Foxtrot", "format-italic", "em"], ["Golf", "format-strike", "s"], ["Hotel", "format-code", "code"]]) {
    await selectText(page, words);
    await choose(run, id);
    await expect(editor.locator(tag)).toHaveText(words);
    await expect.poll(() => checked(app, id)).toBe(true);
  }

  // Lists, a quote and a code block.
  for (const [words, id, selector] of [["India", "format-bullets", "ul li"], ["Juliet", "format-numbers", "ol li"], ["Kilo", "format-quote", "blockquote"], ["Lima", "format-code-block", "pre"]]) {
    await cursorAtEnd(page, words);
    await choose(run, id);
    await expect(editor.locator(selector, { hasText: words })).toHaveCount(1);
    await expect.poll(() => checked(app, id)).toBe(true);
  }

  // Increase and Decrease Indent move a list item in and out, as Tab and Shift-Tab do.
  await cursorAtEnd(page, "Two", "li");
  await expect.poll(() => enabledOf(app, ["format-indent", "format-outdent"])).toEqual({ "format-indent": true, "format-outdent": true });
  await choose(run, "format-indent");
  await expect(editor.locator("li li")).toHaveText("Two");
  await choose(run, "format-outdent");
  await expect(editor.locator("li li")).toHaveCount(0);
  // A paragraph can't be indented in Markdown.
  await cursorAtEnd(page, "Mike");
  await expect.poll(() => enabledOf(app, ["format-indent", "format-outdent"])).toEqual({ "format-indent": false, "format-outdent": false });

  // Insert: a footnote, a table, a picture, a link and a line, at the cursor.
  await choose(run, "insert-footnote");
  await expect(editor.locator("sup.footnote-ref")).toHaveCount(1);
  await cursorAtEnd(page, "Mike");
  await choose(run, "insert-table");
  await expect(editor.locator("table")).toHaveCount(1);
  await cursorAtEnd(page, "Mike");
  await pickInNextDialog(app, join(FIXTURES, "chart.png"));
  await choose(run, "insert-picture");
  await expect(editor.locator(".picture img")).toHaveCount(1);
  await selectText(page, "Mike");
  await choose(run, "insert-link");
  await expect(page.locator(".link-editor")).toBeVisible();
  await page.keyboard.press("Escape");
  await expect(page.locator(".link-editor")).toBeHidden();

  // In a code block, text styles, pictures and links don't apply.
  await page.locator(`${EDITOR} pre`).click();
  await settle(page);
  await expect
    .poll(() => enabledOf(app, ["format-bold", "insert-picture", "insert-link", "format-code-block"]))
    .toEqual({ "format-bold": false, "insert-picture": false, "insert-link": false, "format-code-block": true });

  // While the find bar has the keyboard, the document's formatting waits.
  await cursorAtEnd(page, "Mike");
  await expect.poll(() => enabled(app, "format-bold")).toBe(true);
  await page.keyboard.press("Meta+f");
  await expect(page.getByRole("textbox", { name: "Find" })).toBeFocused();
  await expect.poll(() => enabled(app, "format-bold")).toBe(false);
  await page.keyboard.press("Escape");

  await cursorAtEnd(page, "Mike");
  await choose(run, "insert-line");
  await expect(editor.locator("hr")).toHaveCount(1);

  // In the Markdown view, the file's own text: none of them apply, but New Comment still does.
  await choose(run, "view-markdown");
  await expect.poll(() => enabledOf(app, [...FORMAT, "insert-table", "insert-link"])).toEqual(all([...FORMAT, "insert-table", "insert-link"], false));
  expect(await enabled(app, "comment-add")).toBe(true);
  await run.app.close();
});

test("the Table menu acts on the table the cursor is in, and is greyed out outside one", async () => {
  const run = await openText("| Name | Role |\n| --- | --- |\n| Ana | Sales |\n| Ben | Ops |\n\nAfter the table.\n");
  const { app, page } = run;
  await cursorAtEnd(page, "After the table.");
  await expect.poll(() => enabledOf(app, TABLE)).toEqual(all(TABLE, false));

  await cursorInCell(page, "Ana");
  await expect.poll(() => enabledOf(app, TABLE)).toEqual(all(TABLE, true));
  await choose(run, "table-add-row-below");
  await expect.poll(() => tableCells(page)).toEqual([["Name", "Role"], ["Ana", "Sales"], ["", ""], ["Ben", "Ops"]]);
  await cursorInCell(page, "Ana");
  await choose(run, "table-add-row-above");
  await expect.poll(() => tableCells(page)).toEqual([["Name", "Role"], ["", ""], ["Ana", "Sales"], ["", ""], ["Ben", "Ops"]]);
  await cursorInCell(page, "Ana");
  await choose(run, "table-delete-row");
  await cursorInCell(page, "Ben");
  await choose(run, "table-delete-row");
  await expect.poll(() => tableCells(page)).toEqual([["Name", "Role"], ["", ""], ["", ""]]);

  await cursorInCell(page, "Role");
  await choose(run, "table-add-column-right");
  await cursorInCell(page, "Role");
  await choose(run, "table-add-column-left");
  await expect.poll(async () => (await tableCells(page))[0]).toEqual(["Name", "", "Role", ""]);
  await cursorInCell(page, "Role");
  await choose(run, "table-align-right");
  await expect.poll(() => run.text()).toMatch(/\|\s*-+:\s*\|\s*-+\s*\|\n/); // Role's column, right-aligned
  await choose(run, "table-align-center");
  await expect.poll(() => run.text()).toMatch(/\|\s*:-+:\s*\|\s*-+\s*\|\n/);
  await choose(run, "table-align-left");
  await expect.poll(() => run.text()).toMatch(/\|\s*:-+\s*\|\s*-+\s*\|\n/);
  await choose(run, "table-delete-column");
  await expect.poll(async () => (await tableCells(page))[0]).toEqual(["Name", "", ""]);
  await choose(run, "table-delete");
  await expect(page.locator(`${EDITOR} table`)).toHaveCount(0);
  await expectFile(run, "After the table.\n");
  await run.app.close();
});

test("View: the two views, comments, resolved comments, changes and history, each saying what it will do", async () => {
  const run = await openText("# Plan\n\nWe should hire two people.\n");
  const { app, page } = run;

  // Formatted or Markdown: the one showing is ticked; Command-/ goes to the other.
  await expect.poll(() => checked(app, "view-formatted")).toBe(true);
  expect(await menuItem(app, "view-markdown")).toMatchObject({ checked: false, accelerator: "CmdOrCtrl+/" });
  await choose(run, "view-markdown");
  await expect(page.getByRole("textbox", { name: "Markdown text" })).toBeVisible();
  await expect.poll(() => menuItem(app, "view-formatted")).toMatchObject({ checked: false, accelerator: "CmdOrCtrl+/" });
  expect(await menuItem(app, "view-markdown")).toMatchObject({ checked: true, accelerator: null });
  await choose(run, "view-formatted");
  await expect(page.locator(EDITOR)).toBeVisible();

  // Comments: Show or Hide, as the panel is.
  const id = (await page.locator(".tab").first().getAttribute("data-doc-id"))!;
  const threadId = await page.evaluate(async (docId) => {
    const r = await window.corillo.addComment(docId, "Three?", null, null);
    if (!r.ok) throw new Error(r.error);
    return r.value.id;
  }, id);
  await expect(page.locator(PANEL)).toBeVisible();
  await expect.poll(() => label(app, "view-comments")).toBe("Hide Comments");
  await choose(run, "view-comments");
  await expect(page.locator(PANEL)).toBeHidden();
  await expect.poll(() => label(app, "view-comments")).toBe("Show Comments");
  await choose(run, "view-comments");
  await expect(page.locator(PANEL)).toBeVisible();

  // Resolved comments: only once there are some; ticked while they're listed.
  expect(await enabled(app, "view-resolved")).toBe(false);
  await page.evaluate(([docId, t]) => window.corillo.resolveComment(docId, t, true), [id, threadId] as const);
  await expect.poll(() => enabled(app, "view-resolved")).toBe(true);
  await choose(run, "view-resolved");
  await expect(page.locator(`${PANEL} .comment-card.resolved`)).toBeVisible();
  await expect.poll(() => checked(app, "view-resolved")).toBe(true);
  await choose(run, "view-resolved");
  await expect(page.locator(`${PANEL} .comment-card.resolved`)).toBeHidden();

  // Show Changes: what agents changed since the hand-over (no agent yet, it says so), read-only, then Hide Changes.
  await cursorAtEnd(page, "two people.");
  await page.keyboard.type(" Soon.");
  await expectFile(run, "# Plan\n\nWe should hire two people. Soon.\n");
  await choose(run, "view-changes");
  await expect(page.locator(".doc:not([hidden]) .version-banner")).toContainText("You haven't handed this document to an agent yet");
  await expect.poll(() => label(app, "view-changes")).toBe("Hide Changes");
  expect(await enabledOf(app, ["format-bold", "history-restore"])).toEqual({ "format-bold": false, "history-restore": false });
  await choose(run, "view-changes");
  await expect(page.locator(".doc:not([hidden]) .version-banner")).toBeHidden();
  await expect.poll(() => label(app, "view-changes")).toBe("Show Changes");

  // History: the panel; an older version can be restored from File.
  await choose(run, "view-history");
  await expect(page.locator(".doc:not([hidden]) .history-panel")).toBeVisible();
  await expect.poll(() => label(app, "view-history")).toBe("Hide History");
  await page.locator(".doc:not([hidden]) .history-item", { hasText: "First version" }).click();
  await expect(page.locator(".doc:not([hidden]) .version-banner")).toContainText("Version from");
  await expect.poll(() => enabled(app, "history-restore")).toBe(true);
  expect(await label(app, "view-changes")).toBe("Back to Current Version");
  await choose(run, "history-restore");
  await expectFile(run, "# Plan\n\nWe should hire two people.\n");
  await expect.poll(() => enabled(app, "history-restore")).toBe(false);
  await choose(run, "view-history");
  await expect(page.locator(".doc:not([hidden]) .history-panel")).toBeHidden();
  await expect.poll(() => label(app, "view-history")).toBe("Show History");
  await run.app.close();
});

// Orlando, 2026-11-09: no Review mode. The Review menu works at any time, from card to card.
test("Review: Next, Previous and Resolve work at any time, card to card in the panel's order; the others act on the card in focus", async () => {
  const run = await openText("# Plan\n\nWe should hire two people this quarter.\n\nThe budget is tight.\n", { name: "plan.md" });
  const { app, page } = run;
  const REVIEW = ["review-next", "review-previous", "review-reply", "review-resolve", "review-delete", "review-before"];
  const cardOf = (body: string) => page.locator(`${PANEL} .comment-card`, { hasText: body });
  const marks = () => page.locator(`${EDITOR} .change-mark`).allTextContents();
  await expect.poll(() => enabledOf(app, REVIEW)).toEqual(all(REVIEW, false));

  // Three comments; the agent answers two of them, with a change for each, and leaves the middle one.
  for (const [words, body] of [["two people", "Make it three."], ["quarter", "Which quarter?"], ["tight", "Say by how much."]]) {
    await selectText(page, words);
    await page.keyboard.press("Meta+Alt+m");
    await page.getByRole("textbox", { name: "New comment" }).fill(body);
    await page.getByRole("button", { name: "Post" }).click();
    await expect(cardOf(body)).toBeVisible();
  }
  const { session } = await AgentSession.start(run.dataDir, "claude-code");
  try {
    const listed = await session.ok("take_document", { path: run.file });
    const idOf = (words: string) => new RegExp(`\\[([^\\]]+)\\] on "${words}"`).exec(listed)![1];
    await session.ok("edit_document", { path: run.file, edits: [{ find: "two people", replace: "three people" }], comment_ids: [idOf("two people")] });
    await session.ok("edit_document", { path: run.file, edits: [{ find: "is tight.", replace: "is tight: 10% under plan." }], comment_ids: [idOf("tight")] });
    await session.ok("reply_to_comment", { path: run.file, comment_id: idOf("two people"), text: "Now three." });
    await session.ok("reply_to_comment", { path: run.file, comment_id: idOf("tight"), text: "Added the figure." });
    await session.call("finish_editing", { path: run.file }); // points out the one left, once
    await session.ok("finish_editing", { path: run.file });
  } finally {
    await session.stop();
  }
  await expect(page.locator(".doc:not([hidden]) .pass-notice")).toContainText("Claude is done");

  // Nothing to start: with no card in focus, Next goes to the first card and Previous to the last.
  await page.locator(`${EDITOR} h1`).click();
  await settle(page);
  await expect
    .poll(() => enabledOf(app, REVIEW))
    .toEqual({ "review-next": true, "review-previous": true, "review-reply": false, "review-resolve": false, "review-delete": false, "review-before": false });

  // Option-Command-Down: the first card with something new in focus, its words in sight, the change made for it highlighted.
  // Previous is there on the first card too: it goes round to the last (roadmap Batch 1, item 2).
  await page.keyboard.press("Meta+Alt+ArrowDown");
  await expect(cardOf("Make it three.")).toHaveClass(/active/);
  await expect.poll(marks).toEqual(["three"]);
  await expect
    .poll(() => enabledOf(app, REVIEW))
    .toEqual({ "review-next": true, "review-previous": true, "review-reply": true, "review-resolve": true, "review-delete": true, "review-before": true });
  expect(await label(app, "review-resolve")).toBe("Resolve Comment");

  // What it said before, shown and hidden.
  await choose(run, "review-before");
  await expect.poll(() => label(app, "review-before")).toBe("Hide What It Said Before");
  await choose(run, "review-before");
  await expect.poll(() => label(app, "review-before")).toBe("Show What It Said Before");

  // Reply puts the cursor in the comment's reply box; Delete deletes the comment at once, and Undo straight after brings it back
  // (roadmap Batch 9, item 4).
  await choose(run, "review-reply");
  await expect(cardOf("Make it three.").getByRole("textbox", { name: "Reply" })).toBeFocused();
  expect(await label(app, "review-delete")).toBe("Delete Comment");
  await choose(run, "review-delete");
  await expect(cardOf("Make it three.")).toHaveCount(0);
  await expect(page.locator(PANEL)).not.toContainText("Delete this");
  await page.keyboard.press("Meta+z");
  await expect(cardOf("Make it three.")).toBeVisible();

  // Next: the other card with something new, past the comment still waiting for the agent (roadmap Batch 1, item 2).
  await choose(run, "review-next");
  await expect(cardOf("Say by how much.")).toHaveClass(/active/);
  await expect.poll(marks).toEqual([expect.stringContaining("10% under plan")]);
  // Nothing new left: back to the top, then card by card in the panel's order, the one waiting for the agent too,
  // and round from the last card to the first.
  await page.locator(`${EDITOR} .ProseMirror`).focus();
  await page.keyboard.press("Meta+Alt+ArrowDown");
  await expect(cardOf("Make it three.")).toHaveClass(/active/);
  await page.keyboard.press("Meta+Alt+ArrowDown");
  await expect(cardOf("Which quarter?")).toHaveClass(/active/);
  await expect.poll(marks).toEqual([]);
  await page.keyboard.press("Meta+Alt+ArrowDown");
  await expect(cardOf("Say by how much.")).toHaveClass(/active/);
  await expect.poll(() => enabled(app, "review-next")).toBe(true); // the last card: Next goes round
  await page.keyboard.press("Meta+Alt+ArrowDown");
  await expect(cardOf("Make it three.")).toHaveClass(/active/);
  // Previous, by its shortcut, round to the last and back to the first.
  await page.keyboard.press("Meta+Alt+ArrowUp");
  await expect(cardOf("Say by how much.")).toHaveClass(/active/);
  await page.keyboard.press("Meta+Alt+ArrowUp");
  await expect(cardOf("Which quarter?")).toHaveClass(/active/);
  await page.keyboard.press("Meta+Alt+ArrowUp");
  await expect(cardOf("Make it three.")).toHaveClass(/active/);
  await expect.poll(() => enabled(app, "review-previous")).toBe(true);

  // Option-Command-Return resolves the card in focus and goes to the next.
  await page.keyboard.press("Meta+Alt+Enter");
  await expect(cardOf("Make it three.")).toHaveCount(0);
  await expect(cardOf("Which quarter?")).toHaveClass(/active/);
  // From the menu too; after the last card, round to the first card left, as Next goes (B1-07).
  await choose(run, "review-next");
  await expect(cardOf("Say by how much.")).toHaveClass(/active/);
  await choose(run, "review-resolve");
  await expect(cardOf("Say by how much.")).toHaveCount(0);
  await expect(page.locator(`${PANEL} .comment-card.active`)).toHaveCount(1);
  await expect(cardOf("Which quarter?")).toHaveClass(/active/);
  await expect.poll(marks).toEqual([]);

  // A resolved comment, shown and in focus: Reopen.
  await choose(run, "view-resolved");
  await page.locator(`${PANEL} .comment-card.resolved .comment-body`, { hasText: "Make it three." }).click();
  await expect.poll(() => label(app, "review-resolve")).toBe("Reopen Comment");
  expect(await enabledOf(app, ["review-reply", "review-delete"])).toEqual({ "review-reply": false, "review-delete": false });
  await choose(run, "review-resolve");
  await expect(page.locator(`${PANEL} .comment-card:not(.resolved)`, { hasText: "Make it three." })).toBeVisible();
  await expect.poll(() => label(app, "review-resolve")).toBe("Resolve Comment");

  // No Review mode: the menu has nothing to start or end.
  const items = await menuBar(app);
  expect(items.filter((i) => i.path[0] === "Review").map((i) => i.label)).toEqual([
    "Next Comment", "Previous Comment", "Reply to Comment", "Resolve Comment", "Delete Comment", "Show What It Said Before", "",
    "Copy for Claude", "Take Over", // no agent is waiting for the review here: see send-to-claude.spec.ts
    "", "Read Aloud", // roadmap Batch 14, item 4: read-aloud.spec.ts
  ]);
  await run.app.close();
});

test("Take Over is there only while an agent edits the document in front, names it, and Control-Command-T takes it back", async () => {
  const run = await openText("# Plan\n\nWe should hire two people.\n", { name: "plan.md" });
  const { app, page } = run;
  await cursorAtEnd(page, "two people.");
  await expect.poll(() => menuItem(app, "take-over")).toMatchObject({ label: "Take Over", enabled: false, accelerator: "Ctrl+Cmd+T" });
  await expect.poll(() => enabled(app, "format-bold")).toBe(true);

  const { session } = await AgentSession.start(run.dataDir, "claude-code");
  try {
    await session.ok("take_document", { path: run.file });
    await expect(page.locator(NOTICE)).toContainText("Claude is editing");
    await expect.poll(() => menuItem(app, "take-over")).toMatchObject({ label: "Take Over from Claude", enabled: true });
    // The text is the agent's meanwhile, so Format waits too.
    expect(await enabled(app, "format-bold")).toBe(false);

    // Another document in front: Take Over waits; back on this one, it's there again.
    await openAlso(run, "notes.md", "# Notes\n");
    await expect.poll(async () => (await tabState(page)).active).toBe("notes.md");
    await expect.poll(() => menuItem(app, "take-over")).toMatchObject({ label: "Take Over", enabled: false });
    await page.keyboard.press("Control+Tab");
    await expect.poll(async () => (await tabState(page)).active).toBe("plan.md");
    await expect.poll(() => enabled(app, "take-over")).toBe(true);

    // The shortcut ends the agent's turn.
    await page.keyboard.press("Control+Meta+t");
    await expect(page.locator(NOTICE)).toBeHidden();
    await expect(page.locator(`${EDITOR} .ProseMirror`)).toHaveAttribute("contenteditable", "true");
    await expect.poll(() => menuItem(app, "take-over")).toMatchObject({ label: "Take Over", enabled: false });
  } finally {
    await session.stop();
  }
  await run.app.close();
});

test("the new shortcuts do what their menu items do, and leave a box being typed in alone", async () => {
  const run = await openText("# Plan\n\nWe should hire two people.\n");
  const { app, page } = run;
  await cursorAtEnd(page, "two people.");
  await page.keyboard.type(" Soon.");
  await expectFile(run, "# Plan\n\nWe should hire two people. Soon.\n");

  // Control-Command-M shows and hides the comments.
  const id = (await page.locator(".tab").first().getAttribute("data-doc-id"))!;
  await page.evaluate(async (docId) => void (await window.corillo.addComment(docId, "Three?", null, null)), id);
  await expect(page.locator(PANEL)).toBeVisible();
  await page.keyboard.press("Control+Meta+m");
  await expect(page.locator(PANEL)).toBeHidden();
  await page.keyboard.press("Control+Meta+m");
  await expect(page.locator(PANEL)).toBeVisible();

  // Control-Command-C shows the changes and hides them again.
  const banner = page.locator(".doc:not([hidden]) .version-banner");
  await page.keyboard.press("Control+Meta+c");
  await expect(banner).toContainText("You haven't handed this document to an agent yet");
  await page.keyboard.press("Control+Meta+c");
  await expect(banner).toBeHidden();

  // Control-Command-H opens and closes History.
  const history = page.locator(".doc:not([hidden]) .history-panel");
  await page.keyboard.press("Control+Meta+h");
  await expect(history).toBeVisible();
  await page.keyboard.press("Control+Meta+h");
  await expect(history).toBeHidden();

  // Command-/ goes to the Markdown view and back.
  await cursorAtEnd(page, "Soon.");
  await page.keyboard.press("Meta+/");
  await expect(page.getByRole("textbox", { name: "Markdown text" })).toBeVisible();
  await page.keyboard.press("Meta+/");
  await expect(page.locator(EDITOR)).toBeVisible();

  // Command-B while writing a comment doesn't bold the document's selected words.
  await selectText(page, "hire");
  await page.keyboard.press("Meta+Alt+m");
  const box = page.getByRole("textbox", { name: "New comment" });
  await expect(box).toBeFocused();
  await page.keyboard.press("Meta+b");
  await settle(page);
  await expect(page.locator(`${EDITOR} strong`)).toHaveCount(0);
  await page.keyboard.press("Escape");

  // Show Next Tab and Show Previous Tab need two documents.
  expect(await enabledOf(app, ["next-tab", "previous-tab"])).toEqual({ "next-tab": false, "previous-tab": false });
  await openAlso(run, "notes.md", "# Notes\n");
  await expect.poll(() => enabledOf(app, ["next-tab", "previous-tab"])).toEqual({ "next-tab": true, "previous-tab": true });
  await page.keyboard.press("Control+Shift+Tab");
  await expect.poll(async () => (await tabState(page)).active).toBe("proposal.md");
  await choose(run, "next-tab");
  await expect.poll(async () => (await tabState(page)).active).toBe("notes.md");
  await choose(run, "previous-tab");
  await expect.poll(async () => (await tabState(page)).active).toBe("proposal.md");
  await run.app.close();
});

test("Find, Find Next, Paste and Match Style and New Comment go by the character the key types, on any keyboard (W-2)", async () => {
  const run = await openText("# Plan\n\nWe should hire two people this spring.\n\nThe budget is set for two people.\n");
  const { app, page } = run;
  // A test can't switch the Mac's keyboard: each press is sent as the browser reports it on that keyboard,
  // the character typed (key, keyCode) and the key's place on an American one (code).
  const press = (init: { key: string; code: string; keyCode: number; metaKey?: boolean; altKey?: boolean; shiftKey?: boolean }) =>
    page.evaluate((p) => void (document.activeElement ?? document.body).dispatchEvent(new KeyboardEvent("keydown", { ...p, bubbles: true, cancelable: true, composed: true })), init);
  const findBar = page.locator(".find-bar");
  await clipboardHoldsText(app, "Stray words");
  await selectText(page, "two people");
  await settle(page);

  // Dvorak: Command-I (the key in G's American place) is Italic, not Find Next.
  await press({ key: "i", code: "KeyG", keyCode: 73, metaKey: true });
  await expect(page.locator(`${EDITOR} em`)).toHaveText("two people");
  // Command-U (in F's place) isn't Find; Shift-Command-K (in V's place) isn't Paste and Match Style.
  await press({ key: "u", code: "KeyF", keyCode: 85, metaKey: true });
  await press({ key: "K", code: "KeyV", keyCode: 75, metaKey: true, shiftKey: true });
  await settle(page);
  await expect(findBar).toBeHidden();
  await expect(page.locator(EDITOR)).not.toContainText("Stray words");
  // Command-F and Command-G, typed where Dvorak has F and G, are Find and Find Next, also from the find field.
  await press({ key: "f", code: "KeyY", keyCode: 70, metaKey: true });
  await expect(findBar).toBeVisible();
  await expect(page.locator(".find-count")).toHaveText("1 of 2");
  await press({ key: "g", code: "KeyU", keyCode: 71, metaKey: true });
  await expect(page.locator(".find-count")).toHaveText("2 of 2");
  await page.keyboard.press("Escape");

  // French: Option-Command with the comma key (in M's American place) doesn't start a comment; with the M key it does.
  await page.evaluate(() => {
    const french = new Map([["KeyM", ","], ["Semicolon", "m"], ["KeyQ", "a"], ["KeyA", "q"], ["KeyW", "z"], ["KeyZ", "w"]]);
    Object.defineProperty(navigator, "keyboard", { configurable: true, value: { getLayoutMap: async () => french } });
  });
  await selectText(page, "spring");
  await press({ key: "Alt", code: "AltLeft", keyCode: 18, altKey: true }); // the window learns the keyboard as Option goes down
  await settle(page);
  await press({ key: "∞", code: "KeyM", keyCode: 188, metaKey: true, altKey: true });
  await settle(page);
  await expect(page.locator(`${PANEL} .comment-card.draft`)).toHaveCount(0);
  await press({ key: "µ", code: "Semicolon", keyCode: 77, metaKey: true, altKey: true });
  await expect(page.getByRole("textbox", { name: "New comment" })).toBeFocused();
  await run.app.close();
});

test("Shift-Command-] and [ (next and previous tab) go by the character the key types, on any keyboard (W-2)", async () => {
  const run = await openText("One.\n", { name: "one.md" });
  const { page } = run;
  await openAlso(run, "two.md", "Two.\n");
  await openAlso(run, "three.md", "Three.\n");
  await expect.poll(() => tabState(page)).toEqual({ names: ["one.md", "two.md", "three.md"], active: "three.md" });
  await settle(page);
  const press = (init: { key: string; code: string; keyCode: number }) =>
    page.evaluate(
      (p) => void (document.activeElement ?? document.body).dispatchEvent(new KeyboardEvent("keydown", { ...p, metaKey: true, shiftKey: true, bubbles: true, cancelable: true, composed: true })),
      init,
    );
  const front = async () => (await tabState(page)).active;
  // American: the ] and [ keys, as before.
  await press({ key: "}", code: "BracketRight", keyCode: 221 });
  await expect.poll(front).toBe("one.md");
  await press({ key: "{", code: "BracketLeft", keyCode: 219 });
  await expect.poll(front).toBe("three.md");
  // Dvorak: the key in [ 's American place types "/", so Shift-Command with it isn't Show Previous Tab...
  await press({ key: "?", code: "BracketLeft", keyCode: 191 });
  await settle(page);
  expect(await front()).toBe("three.md");
  // ...while ] and [, in the American = and - places there, are next and previous.
  await press({ key: "}", code: "Equal", keyCode: 221 });
  await expect.poll(front).toBe("one.md");
  await press({ key: "{", code: "Minus", keyCode: 219 });
  await expect.poll(front).toBe("three.md");
  await run.app.close();
});

test("building the menus never waits on the disk: the recent list is kept in memory (MP-14)", async () => {
  const run = await openText("Plan.\n", { name: "plan.md" });
  const notes = await openAlso(run, "notes.md", "Notes.\n");
  await expect.poll(() => recentMenu(run.app)).toEqual(["notes", "plan"]);
  // The window's state changes the menus' words three times, so the menus are built again each time.
  const seen = await run.app.evaluate(({ BrowserWindow, ipcMain, Menu }) => {
    type Fs = Record<string, (...args: unknown[]) => unknown>;
    const fs = (process as unknown as { mainModule: { require(id: string): Fs } }).mainModule.require("fs");
    const looked: string[] = [];
    const names = ["readFileSync", "existsSync", "statSync", "lstatSync", "accessSync", "readdirSync", "realpathSync", "openSync"];
    const real = Object.fromEntries(names.map((n) => [n, fs[n]]));
    for (const n of names) fs[n] = (...args: unknown[]) => (looked.push(`${n} ${String(args[0])}`), real[n](...args));
    const set = Menu.setApplicationMenu;
    let built = 0;
    Menu.setApplicationMenu = (menu) => {
      built++;
      set.call(Menu, menu);
    };
    try {
      const sender = BrowserWindow.getAllWindows()[0].webContents;
      for (const label of ["One", "Two", "Three"]) ipcMain.emit("menu:state", { sender }, { enabled: {}, checked: {}, labels: { "toggle-comments": label } });
    } finally {
      Object.assign(fs, real);
      Menu.setApplicationMenu = set;
    }
    return { built, looked };
  });
  expect(seen).toEqual({ built: 3, looked: [] });
  // Still right: a recent document deleted is left out once Corillo looks again (coming back to it).
  unlinkSync(notes);
  await run.app.evaluate(({ app, BrowserWindow }) => app.emit("browser-window-focus", {}, BrowserWindow.getAllWindows()[0]));
  await expect.poll(() => recentMenu(run.app)).toEqual(["plan"]);
  await run.app.close();
});
