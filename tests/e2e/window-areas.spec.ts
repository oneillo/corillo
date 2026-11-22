// Moving round the window by keys (roadmap Batch 12, item 3). Tab stays in
// the page, where it indents (Orlando's rule); F6 moves the keyboard to the
// next area of the window and Shift-F6 to the one before: the page, the side
// panel, the status bar, the tab bar, the toolbar, and a line at the top while
// one shows, then round to the page, where the cursor was. Also: Escape from a
// toolbar menu leaves the keyboard on its button, View > Show Outline has a
// key, the page has a name and role for screen readers and commented words say
// so, and the start screen and Help open with the keyboard somewhere useful.
import { test, expect, type Page } from "@playwright/test";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { captureClipboardWrites, clickMenu, copySelection, cursorAtEnd, openAlso, openText, selectText, settle, tabState, EDITOR, ONE_SCALE, type Running, launch } from "./helpers";
import { AgentSession } from "./agent-session";

const DOC = ["# Offsite plan", "", "We meet on Friday at the old library.", "", "The budget is two thousand dollars.", "", "Lunch is at noon, in the garden.", ""].join("\n");

/** Where the keyboard is, in words a person would use. */
const where = (page: Page) =>
  page.evaluate(() => {
    const a = document.activeElement as HTMLElement | null;
    if (!a || a === document.body) return "nowhere";
    const words = (e: Element) => (e.getAttribute("aria-label") || e.textContent || "").replace(/\s+/g, " ").trim();
    if (a.closest(".ProseMirror")) return "page";
    if (a.matches("textarea.source")) return "markdown text";
    if (a.closest(".tabs")) return `tab: ${words(a)}`;
    if (a.closest("#toolbar")) return `toolbar: ${words(a)}`;
    if (a.closest(".status-bar")) return `status bar: ${words(a)}`;
    if (a.classList.contains("comment-card")) return `card: ${(a.querySelector(".comment-body")?.textContent ?? "").trim()}`;
    if (a.closest(".comments-panel")) return `comments: ${words(a)}`;
    if (a.closest(".history-panel")) return `history: ${words(a)}`;
    if (a.closest(".find-bar")) return `find bar: ${words(a)}`;
    if (a.closest(".outline-pane")) return `outline: ${words(a)}`;
    if (a.closest(".agent-notice, .pass-notice, .banner")) return `line: ${words(a)}`;
    if (a.closest("[role=menu]")) return `menu: ${words(a)}`;
    if (a.closest("#empty")) return `start screen: ${words(a)}`;
    return `${a.tagName.toLowerCase()}: ${words(a)}`;
  });

const pageText = (page: Page) => page.locator(`${EDITOR} .ProseMirror`).innerText();

let run: Running | null = null;
const sessions: AgentSession[] = [];
test.afterEach(async () => {
  for (const s of sessions.splice(0)) await s.stop().catch(() => undefined);
  await run?.app.close();
  run = null;
});

/** Comment on some words by keys, and come back to the page. */
async function comment(page: Page, words: string, text: string): Promise<void> {
  await selectText(page, words);
  await page.keyboard.press("Meta+Alt+m");
  await expect(page.getByRole("textbox", { name: "New comment" })).toBeFocused();
  await page.keyboard.type(text);
  await page.keyboard.press("Meta+Enter");
  await expect(page.locator(".doc:not([hidden]) .comment-card:not(.draft)", { hasText: text })).toBeVisible();
  await expect(page.locator(`${EDITOR} .comment-range`, { hasText: words })).toHaveCount(1); // on its words, not the whole document
}

test("F6 and Shift-F6 go round the window's areas, and back to the page where the cursor was", async () => {
  run = await openText(DOC, { name: "plan.md" });
  const { page, app } = run;
  await openAlso(run, "notes.md", "# Notes\n");
  await expect.poll(async () => (await tabState(page)).names).toEqual(["plan.md", "notes.md"]);
  await page.keyboard.press("Control+Shift+Tab");
  await expect.poll(async () => (await tabState(page)).active).toBe("plan.md");
  // Its page has the keyboard (a frame after the tab comes to the front), so the selection below isn't put back by it.
  await expect.poll(() => page.evaluate(() => !!document.activeElement?.closest(".doc:not([hidden]) .ProseMirror"))).toBe(true);
  await comment(page, "old library", "Which room?");
  // The cursor somewhere with no comment: the panel's first control takes the keyboard.
  await cursorAtEnd(page, "The budget is two thousand dollars.");
  await settle(page);
  expect(await where(page)).toBe("page");

  const forward = ["comments: New comment", "status bar: 1 comment", "tab: plan", "toolbar: Outline", "page"];
  for (const stop of forward) {
    await page.keyboard.press("F6");
    expect(await where(page)).toBe(stop);
  }
  // Back in the page where the cursor was: typing lands there.
  await page.keyboard.type(" Paid.");
  await expect.poll(() => pageText(page)).toContain("two thousand dollars. Paid.");
  for (const stop of ["toolbar: Outline", "tab: plan", "status bar: 1 comment", "comments: New comment", "page"]) {
    await page.keyboard.press("Shift+F6");
    expect(await where(page)).toBe(stop);
  }

  // With a comment in focus (its words clicked), the side panel's stop is its card.
  await page.locator(`${EDITOR} .comment-range`).click();
  await settle(page);
  await expect(page.locator(".doc:not([hidden]) .comment-card.active")).toHaveCount(1);
  await page.keyboard.press("F6");
  expect(await where(page)).toBe("card: Which room?");
  await page.keyboard.press("Shift+F6");
  expect(await where(page)).toBe("page");

  // A line at the top is an area too: the find bar, between the toolbar and the page.
  await page.keyboard.press("Meta+f");
  expect(await where(page)).toMatch(/^find bar: Find/);
  await page.keyboard.press("F6");
  expect(await where(page)).toBe("page");
  await page.keyboard.press("Shift+F6");
  expect(await where(page)).toMatch(/^find bar: Find/);
  await page.keyboard.press("Shift+F6");
  expect(await where(page)).toBe("toolbar: Outline");

  // In View, with their keys shown, so they can be found: the menu items do the same.
  const items = await app.evaluate(({ Menu }) =>
    ["area-next", "area-previous"].map((id) => {
      const i = Menu.getApplicationMenu()?.getMenuItemById(id);
      return i ? { label: i.label, accelerator: i.accelerator, enabled: i.enabled } : null;
    }),
  );
  expect(items).toEqual([
    { label: "Go to Next Area", accelerator: "F6", enabled: true },
    { label: "Go to Previous Area", accelerator: "Shift+F6", enabled: true },
  ]);
  await clickMenu(app, "area-next");
  await expect.poll(() => where(page)).toMatch(/^find bar: Find/);
  await clickMenu(app, "area-previous");
  await expect.poll(() => where(page)).toBe("toolbar: Outline");
});

// Review of Batch 12, B12-1: while an agent holds the document, the page is locked and can't take the keyboard, but
// F6 counted it as reached: from nowhere F6 and Shift-F6 did nothing, and going round stopped at the page every time.
test("while an agent edits, F6 and Shift-F6 pass over the locked page, from nowhere and going round both ways", async () => {
  run = await openText(DOC, { name: "plan.md" });
  const { page } = run;
  await cursorAtEnd(page, "The budget is two thousand dollars.");
  await settle(page);
  expect(await where(page)).toBe("page");
  const { session: claude } = await AgentSession.start(run.dataDir, "claude-code");
  sessions.push(claude);
  await claude.ok("take_document", { path: run.file, request: "Tidy it." });
  await expect(page.locator("#turn-status .turn-text")).toHaveText("Claude is editing");
  // The keyboard fell to the window as the page locked (as K-4 found it): F6 goes on to the side panel.
  await page.evaluate(() => (document.activeElement as HTMLElement | null)?.blur());
  expect(await where(page)).toBe("nowhere");
  await page.keyboard.press("F6");
  expect(await where(page)).toBe("comments: New comment");
  // And Shift-F6 from nowhere to the editing line, the area before the page.
  await page.evaluate(() => (document.activeElement as HTMLElement | null)?.blur());
  await page.keyboard.press("Shift+F6");
  expect(await where(page)).toBe("line: How this works");
  // Going round, forward and back, the page is passed over, never stopped at.
  const forward = ["comments: New comment", "status bar: Copy path", "toolbar: Outline", "line: How this works", "comments: New comment"];
  for (const stop of forward) {
    await page.keyboard.press("F6");
    expect(await where(page)).toBe(stop);
  }
  for (const stop of ["line: How this works", "toolbar: Outline", "status bar: Copy path", "comments: New comment", "line: How this works"]) {
    await page.keyboard.press("Shift+F6");
    expect(await where(page)).toBe(stop);
  }
  // Coming back to its tab while Claude still has it: the keyboard goes to New comment, not nowhere.
  await openAlso(run, "notes.md", "# Notes\n");
  await expect.poll(async () => (await tabState(page)).active).toBe("notes.md");
  await page.keyboard.press("Control+Shift+Tab");
  await expect.poll(async () => (await tabState(page)).active).toBe("plan.md");
  await expect.poll(() => where(page)).toBe("comments: New comment");
  // When Claude is done, the keyboard is back in the page, where the cursor was.
  await claude.ok("finish_editing", { path: run.file });
  await expect(page.locator("#turn-status .turn-text")).not.toHaveText("Claude is editing");
  await expect.poll(() => where(page)).toBe("page");
  await page.keyboard.type(" Paid.");
  await expect.poll(() => pageText(page)).toContain("two thousand dollars. Paid.");
});

// Review of Batch 12, B12-5: F6 rested the keyboard on the card of a comment being written, where letters did
// nothing, and on a card in focus scrolled out of sight.
test("F6 into the side panel goes into a comment being written, and brings the card in focus into sight", async () => {
  const many = ["# Plan", "", ...Array.from({ length: 14 }, (_, i) => [`Point ${i + 1} is about the budget for item ${i + 1}.`, ""]).flat()].join("\n");
  run = await openText(many, { name: "plan.md" });
  const { page } = run;
  const inBox = () => page.evaluate(() => document.activeElement?.matches(".comment-card.draft textarea") ?? false);
  // A comment being written, with words in it; a click back in the page; F6: into its box, where typing goes on.
  await selectText(page, "Point 2");
  await page.keyboard.press("Meta+Alt+m");
  await page.keyboard.type("Too vague");
  await cursorAtEnd(page, "Point 5 is about the budget for item 5.");
  await settle(page);
  expect(await where(page)).toBe("page");
  await page.keyboard.press("F6");
  expect(await inBox()).toBe(true);
  await page.keyboard.type(".");
  await expect(page.locator(".doc:not([hidden]) .comment-card.draft textarea")).toHaveValue("Too vague.");
  await page.keyboard.press("Meta+Enter");
  await expect(page.locator(".doc:not([hidden]) .comment-card:not(.draft)", { hasText: "Too vague." })).toBeVisible();
  // Enough comments for the panel to scroll; the first in focus, the panel scrolled away from it; F6 brings it into sight.
  for (const n of [4, 6, 8, 10, 12, 14]) await comment(page, `Point ${n} is`, `Check item ${n}.`);
  await page.locator(`${EDITOR} .comment-range`, { hasText: "Point 2" }).click();
  await settle(page);
  const panel = page.locator(".doc:not([hidden]) aside.comments-panel");
  await panel.evaluate((p) => (p.scrollTop = p.scrollHeight));
  await settle(page);
  const card = page.locator(".doc:not([hidden]) .comment-card.active");
  const inSight = async () => {
    const [c, p] = [await card.boundingBox(), await panel.boundingBox()];
    return !!c && !!p && c.y >= p.y - 1 && c.y < p.y + p.height - 20;
  };
  expect(await inSight()).toBe(false);
  await page.keyboard.press("F6");
  expect(await where(page)).toBe("card: Too vague.");
  expect(await inSight()).toBe(true);
});

test("F6 in the Markdown view goes back to the text where the cursor was; the start screen and a dialog keep it", async () => {
  run = await openText(DOC, { name: "plan.md" });
  const { page } = run;
  await page.keyboard.press("Meta+/");
  const text = page.locator(".doc:not([hidden]) textarea.source");
  await expect(text).toBeVisible();
  await text.focus();
  await text.evaluate((t: HTMLTextAreaElement) => t.setSelectionRange(20, 20));
  await page.keyboard.press("F6");
  expect(await where(page)).toBe("comments: New comment");
  await page.keyboard.press("F6");
  expect(await where(page)).toMatch(/^status bar: /);
  await page.keyboard.press("Shift+F6");
  await page.keyboard.press("Shift+F6");
  expect(await where(page)).toBe("markdown text");
  expect(await text.evaluate((t: HTMLTextAreaElement) => t.selectionStart)).toBe(20);

  // A dialog keeps the keyboard: F6 doesn't take it out.
  await page.keyboard.press("Meta+/");
  await clickMenu(run.app, "export-settings");
  const dialog = page.getByRole("dialog", { name: "Export settings" });
  await expect(dialog).toBeVisible();
  await page.keyboard.press("F6");
  expect(await page.evaluate(() => !!document.activeElement?.closest("dialog"))).toBe(true);
  await page.keyboard.press("Escape");
});

test("Escape from the toolbar's Insert and Export menus leaves the keyboard on the button, so Space opens it again", async () => {
  run = await openText(DOC);
  const { page } = run;
  await cursorAtEnd(page, "Lunch is at noon, in the garden.");
  await settle(page);
  const before = await pageText(page);
  for (const name of ["Insert", "Export"]) {
    const button = page.locator("#toolbar").getByRole("button", { name, exact: true });
    await button.focus();
    await page.keyboard.press("Enter");
    const menu = page.getByRole("menu", { name });
    await expect(menu).toBeVisible();
    await page.keyboard.press("Escape");
    await expect(menu).toBeHidden();
    expect(await where(page)).toBe(`toolbar: ${name}`);
    await page.keyboard.press("Space");
    await expect(menu).toBeVisible();
    await page.keyboard.press("Escape");
  }
  expect(await pageText(page)).toBe(before);

  // Opened with the mouse, the keyboard then brought to the toolbar by Shift-F6: Escape closes the menu and leaves
  // the keyboard on the toolbar, so a Space doesn't type into the page (review of Batch 12, B12-10).
  await cursorAtEnd(page, "Lunch is at noon, in the garden.");
  await page.locator("#toolbar").getByRole("button", { name: "Insert", exact: true }).click();
  const insert = page.getByRole("menu", { name: "Insert" });
  await expect(insert).toBeVisible();
  expect(await where(page)).toBe("page");
  await page.keyboard.press("Shift+F6");
  expect(await where(page)).toBe("toolbar: Outline");
  await page.keyboard.press("Escape");
  await expect(insert).toBeHidden();
  expect(await where(page)).toBe("toolbar: Outline");
  await page.keyboard.press("Space");
  await settle(page);
  expect(await pageText(page)).toBe(before);
});

test("View > Show Outline has Control-Command-O", async () => {
  run = await openText(DOC);
  const { page, app } = run;
  const key = await app.evaluate(({ Menu }) => Menu.getApplicationMenu()?.getMenuItemById("view-outline")?.accelerator);
  expect(key).toBe("Ctrl+Cmd+O");
  // Free: no other item has it.
  const all = await app.evaluate(({ Menu }) => {
    const keys: string[] = [];
    const walk = (m: Electron.Menu | null | undefined) => {
      for (const i of m?.items ?? []) {
        if (i.accelerator) keys.push(String(i.accelerator));
        walk(i.submenu);
      }
    };
    walk(Menu.getApplicationMenu());
    return keys;
  });
  expect(all.filter((k) => /^(Ctrl\+Cmd|Cmd\+Ctrl|Control\+Command)\+O$/i.test(k))).toHaveLength(1);
  const pane = page.locator(".doc:not([hidden]) .outline-pane");
  await page.locator(`${EDITOR} p`).first().click();
  await page.keyboard.press("Control+Meta+o");
  await expect(pane).toBeVisible();
  await expect.poll(() => app.evaluate(({ Menu }) => Menu.getApplicationMenu()?.getMenuItemById("view-outline")?.checked)).toBe(true);
  await page.keyboard.press("Control+Meta+o");
  await expect(pane).toBeHidden();
});

test("the page is a text box named after the document, and commented words say they're commented, without changing what's copied", async () => {
  run = await openText(DOC, { name: "plan.md" });
  const { page, app } = run;
  const editor = page.locator(`${EDITOR} .ProseMirror`);
  await expect(editor).toHaveAttribute("role", "textbox");
  await expect(editor).toHaveAttribute("aria-multiline", "true");
  await expect(editor).toHaveAttribute("aria-label", "plan");
  await expect(page.getByRole("textbox", { name: "plan", exact: true })).toHaveCount(1);
  await comment(page, "old library", "Which room?");
  const marked = page.locator(`${EDITOR} .comment-range`);
  await expect(marked).toHaveText("old library");
  await expect(marked).toHaveAttribute("role", "mark");
  await expect(marked).toHaveAttribute("aria-description", "Commented");
  // What a screen reader is given: a highlight, said to be commented.
  const cdp = await page.context().newCDPSession(page);
  const { nodes } = (await cdp.send("Accessibility.getFullAXTree")) as { nodes: { role?: { value: string }; description?: { value: string } }[] };
  expect(nodes.some((n) => n.role?.value === "mark" && n.description?.value === "Commented")).toBe(true);
  await cdp.detach();
  // Copying the commented words gives the words, with nothing of the mark.
  const writes = await captureClipboardWrites(app);
  await selectText(page, "old library");
  await copySelection(page);
  await expect.poll(writes).not.toBeNull();
  const copied = (await writes())!;
  expect(copied["text/plain"]).toBe("old library");
  expect(JSON.stringify(copied)).not.toMatch(/mark|Commented|comment-range/);
  // Renamed with File > Rename or Move…: the page's name follows.
  const target = join(run.folder, "Q3 plan.md");
  await app.evaluate(({ dialog }, picked) => {
    dialog.showSaveDialog = (async () => ({ canceled: false, filePath: picked })) as typeof dialog.showSaveDialog;
  }, target);
  await clickMenu(app, "rename");
  await expect(editor).toHaveAttribute("aria-label", "Q3 plan");
});

test("the start screen opens with the keyboard on the first recent document", async () => {
  run = await openText(DOC, { name: "plan.md" });
  const { page } = run;
  await page.keyboard.press("Meta+w");
  await expect(page.locator("#empty")).toBeVisible();
  await expect.poll(() => where(page)).toBe("start screen: Open plan, in " + run!.folder.split("/").pop());
  await page.keyboard.press("Enter");
  await expect.poll(async () => (await tabState(page)).names).toEqual(["plan.md"]);
  await expect(page.locator(EDITOR)).toBeVisible();
});

test("with no recent documents, the start screen opens with the keyboard on Open a document", async () => {
  const dataDir = mkdtempSync(join(tmpdir(), "corillo-data-"));
  writeFileSync(join(dataDir, "setup.json"), '{ "connectAgentsOffered": true }\n');
  const home = mkdtempSync(join(tmpdir(), "corillo-home-"));
  const { app } = await launch({ args: [ONE_SCALE, "."], env: { ...process.env, CORILLO_USER_DATA: dataDir, CORILLO_HIDDEN: "1", CORILLO_HOME: home } });
  try {
    const page = await app.firstWindow();
    await expect(page.locator("#empty")).toBeVisible();
    await expect.poll(() => where(page)).toBe("start screen: Open a document…");
  } finally {
    await app.close();
  }
});

test("Help opens with the keyboard in Search help, Command-F goes there, and Tab runs on to the topics, then the text", async () => {
  run = await openText(DOC);
  const [help] = await Promise.all([run.app.waitForEvent("window"), clickMenu(run.app, "corillo-help")]);
  await help.waitForSelector(".help-page:not([hidden])");
  const focused = () => help.evaluate(() => {
    const a = document.activeElement as HTMLElement | null;
    if (!a || a === document.body) return "nowhere";
    return a.closest(".help-main") ? `text: ${a.textContent}` : a.closest(".help-pages") ? `topic: ${a.textContent}` : a.id || a.tagName;
  });
  await expect.poll(focused).toBe("help-search");
  await help.keyboard.press("Tab");
  expect(await focused()).toBe("topic: Getting started");
  for (let i = 0; i < 10; i++) await help.keyboard.press("Tab");
  expect(await focused()).toBe("topic: Troubleshooting");
  await help.keyboard.press("Tab");
  expect(await focused()).toMatch(/^text: /);
  await help.keyboard.press("Meta+f");
  expect(await focused()).toBe("help-search");
  await help.keyboard.type("outline");
  await expect(help.locator("#help-results a").first()).toBeVisible();
});

test("with more tabs than fit, a button at the end of the tab bar lists every open document and brings the one chosen to the front", async () => {
  run = await openText("# Plan\n", { name: "plan.md" });
  const { page } = run;
  const long = "Notes from the volunteers meeting about the shared help desk and its budget";
  const names = [long, "Budget", "Venue", "Travel", "Menu", "Agenda", "Speakers", "Follow-up"];
  for (const n of names) await openAlso(run, `${n}.md`, `# ${n}\n`);
  await expect.poll(async () => (await tabState(page)).names.length).toBe(9);
  const all = page.getByRole("button", { name: "All tabs" });
  // Wide enough for every tab: no button.
  await page.setViewportSize({ width: 1440, height: 700 });
  await settle(page);
  await expect(all).toBeHidden();
  // At 560 pixels they don't all fit: the button shows, beside the bar, covering no tab, and the tab in front is in sight.
  await page.setViewportSize({ width: 560, height: 700 });
  await settle(page);
  await expect(all).toBeVisible();
  const box = await all.boundingBox();
  const bar = await page.locator("#tabs").boundingBox();
  expect(box!.x).toBeGreaterThanOrEqual(bar!.x + bar!.width - 1);
  expect(box!.x + box!.width).toBeLessThanOrEqual(560);
  const front = await page.locator('.tab[aria-selected="true"]').boundingBox();
  expect(front!.x + front!.width).toBeLessThanOrEqual(bar!.x + bar!.width + 1);
  // From the keyboard: Tab from the tab bar reaches it, Return opens the list on the document in front.
  await page.locator('.tab[aria-selected="true"]').focus();
  await page.keyboard.press("Tab");
  await expect(all).toBeFocused();
  await page.keyboard.press("Enter");
  const list = page.getByRole("menu", { name: "All tabs" });
  await expect(list).toBeVisible();
  expect(await list.getByRole("menuitemradio").allTextContents()).toEqual(["plan", ...names]);
  await expect(list.getByRole("menuitemradio", { name: "Follow-up" })).toHaveAttribute("aria-checked", "true");
  // A long name doesn't take the list off the window's edge: it ends in "…" (review of Batch 12, B12-9).
  const listBox = await list.boundingBox();
  expect(listBox!.x).toBeGreaterThanOrEqual(0);
  expect(listBox!.x + listBox!.width).toBeLessThanOrEqual(560);
  const label = list.getByRole("menuitemradio", { name: long }).locator(".menu-label");
  expect(await label.evaluate((l) => l.scrollWidth > l.clientWidth && getComputedStyle(l).textOverflow === "ellipsis")).toBe(true);
  // Escape goes back to the button; choosing one brings it to the front with the keyboard in its page.
  await page.keyboard.press("Escape");
  await expect(all).toBeFocused();
  await all.click();
  await list.getByRole("menuitemradio", { name: "plan" }).click();
  await expect.poll(async () => (await tabState(page)).active).toBe("plan.md");
  await expect.poll(() => where(page)).toBe("page");
  const planTab = await page.locator('.tab[aria-selected="true"]').boundingBox();
  expect(planTab!.x).toBeGreaterThanOrEqual(bar!.x - 1);
  // F6 counts it with the tab bar: from the toolbar, Shift-F6 goes to the tab bar, not the button.
  await page.keyboard.press("Shift+F6");
  await page.keyboard.press("Shift+F6");
  expect(await where(page)).toBe("tab: plan");
  // A tab closing while the list is open with the mouse, the keyboard still in the page (Command-W): the list loses it
  // at once, so nothing in it brings a closed document forward (review of Batch 12, B12-2).
  await cursorAtEnd(page, "Plan", "h1");
  await all.click();
  await expect(list).toBeVisible();
  expect(await where(page)).toBe("page");
  await page.keyboard.press("Meta+w");
  await expect.poll(async () => (await tabState(page)).names).toEqual(names.map((n) => `${n}.md`));
  await expect(list).toBeVisible();
  await expect(list.getByRole("menuitemradio")).toHaveText(names);
  await list.getByRole("menuitemradio", { name: "Menu" }).click();
  await expect.poll(async () => (await tabState(page)).active).toBe("Menu.md");
  await expect(page.locator(EDITOR)).toBeVisible();
  // Back to fewer tabs than fit: it goes.
  await page.setViewportSize({ width: 1440, height: 700 });
  await settle(page);
  await expect(all).toBeHidden();
});
