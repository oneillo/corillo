// The Help window: its pages, links, pictures and search; the places in the
// app that open it at the right page; and the shortcut table, checked against
// the app's real menus and buttons so it can't drift.
import { test, expect, type ElectronApplication, type Page } from "@playwright/test";
import { openText, clickMenu, settle, selectText, EDITOR, type Running } from "./helpers";
import { AgentSession } from "./agent-session";

const DOC = "# Plan\n\nWe should hire two people this quarter.\n";

async function openHelp(run: Running): Promise<Page> {
  const [help] = await Promise.all([run.app.waitForEvent("window"), clickMenu(run.app, "corillo-help")]);
  await help.waitForSelector(".help-page:not([hidden])");
  return help;
}

/** The page Help is showing, and whether a heading is scrolled into view. */
async function showing(help: Page): Promise<string> {
  return help.evaluate(() => document.querySelector(".help-page:not([hidden])")?.id ?? "");
}

async function inView(help: Page, id: string): Promise<boolean> {
  return help.evaluate((target) => {
    const el = document.getElementById(target);
    const main = document.querySelector(".help-main")!;
    if (!el) return false;
    const r = el.getBoundingClientRect();
    const m = main.getBoundingClientRect();
    return main.scrollTop > 0 && r.top >= m.top - 1 && r.bottom <= m.bottom;
  }, id);
}

test("Help opens from the menu; every page, link and picture in it works", async () => {
  const run = await openText(DOC);
  const help = await openHelp(run);
  expect(await showing(help)).toBe("start");
  await expect(help.getByRole("heading", { name: "Getting started" })).toBeVisible();

  // Every page in the sidebar opens.
  const nav = help.getByRole("navigation", { name: "Help pages" });
  const pages = await help.locator(".help-pages a").evaluateAll((as) => as.map((a) => [a.getAttribute("data-page")!, a.textContent!]));
  expect(pages.length).toBe(11);
  for (const [id, title] of pages) {
    await nav.getByRole("link", { name: title, exact: true }).click();
    await expect.poll(() => showing(help)).toBe(id);
    await expect(help.locator(`#${id} > h1`)).toHaveText(title); // (not the headings in Markdown examples)
    await expect(nav.getByRole("link", { name: title, exact: true })).toHaveAttribute("aria-current", "page");
  }

  // Every link inside Help leads to a page or section that's there.
  const broken = await help.evaluate(() =>
    [...document.querySelectorAll<HTMLAnchorElement>('a[href^="#"]')]
      .map((a) => a.getAttribute("href")!.slice(1))
      .filter((id) => !document.getElementById(id)),
  );
  expect(broken).toEqual([]);

  // Every picture loads, at twice the size it's shown (sharp on Retina screens).
  await expect
    .poll(() =>
      help.evaluate(() =>
        [...document.images]
          .filter((img) => {
            const [w, h] = [Number(img.getAttribute("width")), Number(img.getAttribute("height"))];
            return !img.complete || Math.abs(img.naturalWidth - 2 * w) > 1 || Math.abs(img.naturalHeight - 2 * h) > 1;
          })
          .map((img) => img.src),
      ),
    )
    .toEqual([]);
  expect(await help.evaluate(() => document.images.length)).toBeGreaterThanOrEqual(10);

  // A link to a section opens its page there.
  await nav.getByRole("link", { name: "Working with an agent", exact: true }).click();
  await help.locator("#agents").getByRole("link", { name: "My agent can't see Corillo" }).click();
  await expect.poll(() => showing(help)).toBe("trouble");
  await expect.poll(() => inView(help, "trouble-agent")).toBe(true);
  await expect(help.locator("#trouble-agent")).toBeVisible();
  await run.app.close();
});

test("Help search finds sections by their words, and opens the one chosen", async () => {
  const run = await openText(DOC);
  const help = await openHelp(run);
  const search = help.getByRole("searchbox", { name: "Search help" });

  await search.fill("pandoc missing");
  const results = help.locator(".help-result");
  await expect(results.first()).toBeVisible();
  await expect(help.locator(".help-pages")).toBeHidden();
  await expect(results.filter({ hasText: "Word export says part of Corillo is missing" })).toHaveCount(1);
  await results.filter({ hasText: "Word export says part of Corillo is missing" }).click();
  await expect.poll(() => showing(help)).toBe("trouble");
  await expect.poll(() => inView(help, "trouble-pandoc")).toBe(true);

  // Words are found from their start, so a half-typed word already works.
  await search.fill("take ov");
  await expect(results.filter({ hasText: "Take over" }).first()).toBeVisible();
  await search.press("Enter");
  await expect.poll(() => showing(help)).toBe("agents");

  await search.fill("line numbers");
  await results.filter({ hasText: "Line numbers" }).first().click();
  await expect.poll(() => inView(help, "editing-line-numbers")).toBe(true);

  await search.fill("obsidian");
  await results.filter({ hasText: "Using Corillo with Obsidian" }).first().click();
  await expect.poll(() => inView(help, "editing-obsidian")).toBe(true);

  await search.fill("zebra crossing");
  await expect(help.getByText("Nothing found. Try other words.")).toBeVisible();
  await search.press("Escape");
  await expect(search).toHaveValue("");
  await expect(help.locator(".help-pages")).toBeVisible();
  await run.app.close();
});

test("Command-W closes Help, not the document behind it", async () => {
  const run = await openText(DOC);
  const help = await openHelp(run);
  // The keys as the Mac hands them to Help, before the page or the menus see them.
  const [, stopped] = await Promise.all([
    help.waitForEvent("close"),
    run.app.evaluate(({ BrowserWindow }) => {
      const w = BrowserWindow.getAllWindows().find((x) => x.getTitle() === "Corillo Help")!;
      let prevented = false;
      const input = { type: "keyDown", key: "w", code: "KeyW", meta: true, alt: false, control: false, shift: false, isAutoRepeat: false };
      w.webContents.emit("before-input-event", { preventDefault: () => (prevented = true) }, input);
      return prevented;
    }),
  ]);
  expect(stopped).toBe(true); // so the File menu's Close Tab never sees them
  await expect(run.page.locator(".tab")).toHaveCount(1);
  await expect(run.page.locator(EDITOR)).toBeVisible();
  await run.app.close();
});

test("Help opens at the right place from the start screen, the agent notice and the empty comments panel", async () => {
  const run = await openText(DOC);
  const { page, app } = run;

  // The empty comments panel (all comments resolved): How comments work.
  const id = await page.locator(".tab").first().getAttribute("data-doc-id");
  await page.evaluate(async (docId) => {
    const r = await window.corillo.addComment(docId!, "Shorter, please.", null, null);
    if (!r.ok) throw new Error(r.error);
    await window.corillo.resolveComment(docId!, r.value.id, true);
  }, id);
  await expect(page.locator("#comments-toggle")).toHaveText("1 resolved");
  await expect(page.locator(".comments-empty")).toHaveText("No open comments."); // the panel is open from the start
  const [help] = await Promise.all([app.waitForEvent("window"), page.getByRole("button", { name: "How comments work" }).click()]);
  await expect.poll(() => showing(help)).toBe("agents");
  await expect.poll(() => inView(help, "agents-comments")).toBe(true);
  // With an open comment, the panel shows comments, not the help link.
  await page.evaluate(async (docId) => void (await window.corillo.addComment(docId!, "One more thing.", null, null)), id);
  await expect(page.getByRole("button", { name: "How comments work" })).toBeHidden();

  // The agent notice: How this works. Help is already open, so it moves there.
  const { session } = await AgentSession.start(run.dataDir, "claude-code");
  await session.ok("take_document", { path: run.file });
  const notice = page.locator(".doc:not([hidden]) .agent-notice");
  await expect(notice).toContainText("Claude is editing");
  await notice.getByRole("button", { name: "How this works" }).click();
  await expect.poll(() => showing(help)).toBe("agents");
  await expect.poll(() => inView(help, "agents-turns")).toBe(true);
  // The comment left open is pointed out once; finishing again leaves it for later.
  expect((await session.call("finish_editing", { path: run.file })).isError).toBe(true);
  await session.ok("finish_editing", { path: run.file });

  // Help > Corillo Help brings Help forward where the person left it.
  await clickMenu(app, "corillo-help");
  await page.waitForTimeout(200);
  expect(await showing(help)).toBe("agents");

  // The start screen: How Corillo works, at the first round with an agent (roadmap Batch 5, item 2).
  await clickMenu(app, "close-tab");
  await expect(page.locator("#empty")).toBeVisible();
  await page.getByRole("button", { name: "How Corillo works" }).click();
  await expect.poll(() => showing(help)).toBe("first");
  await app.close();
  await session.stop();
});

// The shortcut table -----------------------------------------------------------------

const ORDER = ["Control", "Option", "Shift", "Command"];

/** "Option-Command-M", as Apple writes keys, from the parts of a shortcut. */
function words(mods: Set<string>, key: string): string {
  const names: Record<string, string> = { "=": "Plus (+)", Plus: "Plus (+)", "-": "Minus (-)", "↩": "Return", Enter: "Return", Up: "Up Arrow", Down: "Down Arrow", "↑": "Up Arrow", "↓": "Down Arrow", Left: "Left Arrow", Right: "Right Arrow" };
  return [...ORDER.filter((m) => mods.has(m)), names[key] ?? (key.length === 1 ? key.toUpperCase() : key)].join("-");
}

/** From a menu accelerator, such as "CmdOrCtrl+Alt+M". */
function fromAccelerator(accelerator: string): string {
  const parts = accelerator.split("+");
  let key = parts.pop()!;
  if (key === "" && accelerator.endsWith("++")) key = "Plus";
  const map: Record<string, string> = { CmdOrCtrl: "Command", CommandOrControl: "Command", Cmd: "Command", Command: "Command", Alt: "Option", Option: "Option", Shift: "Shift", Ctrl: "Control", Control: "Control" };
  return words(new Set(parts.map((p) => map[p] ?? p)), key);
}

/** From a button's tooltip, such as "Bold (⌘B)". */
function fromTooltip(title: string): string {
  const keys = /\(([^)]+)\)\s*$/.exec(title)![1];
  const map: Record<string, string> = { "⌃": "Control", "⌥": "Option", "⇧": "Shift", "⌘": "Command" };
  const mods = new Set([...keys].filter((c) => map[c]).map((c) => map[c]));
  return words(mods, [...keys].filter((c) => !map[c]).join(""));
}

interface MenuEntry {
  id: string;
  label: string;
  accelerator: string | null;
  visible: boolean;
  role: string | null;
}

function menuEntries(app: ElectronApplication): Promise<MenuEntry[]> {
  return app.evaluate(({ Menu }) => {
    const all: MenuEntry[] = [];
    const walk = (menu: Electron.Menu | null | undefined) => {
      for (const item of menu?.items ?? []) {
        all.push({ id: item.id, label: item.label, accelerator: (item.accelerator as string | undefined) ?? null, visible: item.visible, role: item.role ?? null });
        walk(item.submenu);
      }
    };
    walk(Menu.getApplicationMenu());
    return all;
  });
}

test("the keyboard shortcut table matches the app's menus and buttons", async () => {
  const run = await openText(DOC);
  const { page, app } = run;
  const menu = await menuEntries(app);

  // What the buttons say: the toolbar's tooltips, and the new comment's Post button.
  const toolbar = await page.locator("#toolbar button[aria-label]").evaluateAll((bs) =>
    Object.fromEntries(bs.map((b) => [b.getAttribute("aria-label")!, b.getAttribute("title") ?? ""])),
  );
  await page.locator(`${EDITOR} p`).first().click();
  await settle(page);
  await page.keyboard.press("Meta+Alt+m");
  const post = (await page.locator(".comment-card.draft").getByRole("button", { name: "Post" }).getAttribute("title"))!;
  await page.keyboard.press("Escape");

  const help = await openHelp(run);
  const rows = await help.locator("tr[data-shortcut]").evaluateAll((trs) =>
    trs.map((tr) => ({ source: tr.getAttribute("data-shortcut")!, keys: tr.querySelector("kbd")!.textContent!, action: tr.querySelector("td")!.textContent! })),
  );
  expect(rows.length).toBeGreaterThan(15);

  for (const row of rows) {
    const [kind, name] = row.source.split(/:(.*)/s);
    let expected: string;
    if (kind === "menu" || kind === "menu-label") {
      const item = menu.find((m) => (kind === "menu" ? m.id === name : m.label === name));
      expect(item, `${row.action}: no menu item ${name}`).toBeDefined();
      expect(item!.accelerator, `${row.action}: ${name} has no shortcut`).toBeTruthy();
      expected = fromAccelerator(item!.accelerator!);
    } else if (kind === "toolbar") {
      expect(toolbar[name], `${row.action}: no toolbar button ${name}`).toMatch(/\(.+\)$/);
      expected = fromTooltip(toolbar[name]);
    } else {
      expected = fromTooltip(post);
    }
    expect(row.keys, row.action).toBe(expected);
  }

  // And every shortcut in the menus is in the table (the menu's standard
  // items, like Cut and Copy, have their own Mac shortcuts and aren't listed).
  const listed = new Set(rows.map((r) => r.source));
  const missing = menu
    .filter((m) => m.accelerator && m.visible && !m.role)
    .filter((m) => !listed.has(`menu:${m.id}`) && !listed.has(`menu-label:${m.label}`))
    .map((m) => `${m.label} (${m.accelerator})`);
  expect(missing).toEqual([]);
  // Every shortcut a toolbar button's tooltip names is its menu item's (Undo and Redo are the Edit menu's own).
  const TOOLBAR_ITEMS: Record<string, string> = {
    Bold: "format-bold",
    Italic: "format-italic",
    Strikethrough: "format-strike",
    Link: "insert-link",
    "Bulleted list": "format-bullets",
    "Numbered list": "format-numbers",
    Comment: "comment-add",
    "Show changes": "view-changes",
    History: "view-history",
    Comments: "view-comments",
  };
  for (const [name, title] of Object.entries(toolbar)) {
    if (!/\(.+\)$/.test(title) || name === "Undo" || name === "Redo") continue;
    const item = menu.find((m) => m.id === TOOLBAR_ITEMS[name]);
    expect(item?.accelerator, `${name}: no menu item with its shortcut`).toBeTruthy();
    expect(fromTooltip(title), name).toBe(fromAccelerator(item!.accelerator!));
  }
  expect(Object.keys(TOOLBAR_ITEMS).filter((name) => !/\(.+\)$/.test(toolbar[name] ?? ""))).toEqual([]);
  await app.close();
});

test("Help > Keyboard Shortcuts opens Help at the shortcuts", async () => {
  const run = await openText(DOC);
  const [help] = await Promise.all([run.app.waitForEvent("window"), clickMenu(run.app, "keyboard-shortcuts")]);
  await expect.poll(() => showing(help)).toBe("shortcuts");
  await expect(help.getByRole("heading", { name: "Keyboard shortcuts" })).toBeVisible();
  // In Help at its narrowest, the table fits its pane: no sideways scrolling, its right edge in sight (last look of
  // Batch 12, L-13).
  for (const width of [560, 640, 720, 800, 900]) {
    await help.setViewportSize({ width, height: 700 });
    await settle(help);
    const fits = await help.evaluate(() => {
      const main = document.querySelector<HTMLElement>(".help-main")!;
      const table = document.querySelector<HTMLElement>("#shortcuts .help-shortcuts")!;
      return { scrolls: main.scrollWidth - main.clientWidth, over: Math.round(table.getBoundingClientRect().right - main.getBoundingClientRect().right) };
    });
    expect(fits.scrolls, `at ${width}`).toBeLessThanOrEqual(0);
    expect(fits.over, `at ${width}`).toBeLessThanOrEqual(0);
  }
  await run.app.close();
});

// Markdown at a glance --------------------------------------------------------------
// (tests/unit/help-markdown.test.ts checks every example against Corillo's parser.)

test("Markdown help shows in the status bar only in the Markdown view, and opens Markdown at a glance", async () => {
  const run = await openText(DOC);
  const { page, app } = run;
  const button = page.getByRole("button", { name: "Markdown help" });
  await expect(button).toBeHidden();
  await page.getByRole("button", { name: "Markdown", exact: true }).click();
  await expect(button).toBeVisible();
  const [help] = await Promise.all([app.waitForEvent("window"), button.click()]);
  await expect.poll(() => showing(help)).toBe("markdown");
  await expect(help.getByRole("heading", { name: "Markdown at a glance" })).toBeVisible();
  // The Markdown text keeps the keyboard, so typing carries on there.
  await expect(page.getByRole("textbox", { name: "Markdown text" })).toBeFocused();
  await page.getByRole("button", { name: "Formatted", exact: true }).click();
  await expect(button).toBeHidden();
  // Help > Markdown Help opens it too, from either view.
  await help.locator(".help-pages a", { hasText: "Getting started" }).click();
  await expect.poll(() => showing(help)).toBe("start");
  await clickMenu(app, "markdown-help");
  await expect.poll(() => showing(help)).toBe("markdown");

  // Each example fits its box, and its look is drawn in the page's own type.
  expect(await help.locator("#markdown .md-example").count()).toBeGreaterThanOrEqual(18);
  const spilling = await help.evaluate(() =>
    [...document.querySelectorAll<HTMLElement>("#markdown .md-text, #markdown .md-look")]
      .filter((el) => el.scrollWidth > el.clientWidth + 1)
      .map((el) => el.textContent!.slice(0, 40)),
  );
  expect(spilling).toEqual([]);
  const pageFont = await page.locator(`${EDITOR} .ProseMirror p`).first().evaluate((p) => getComputedStyle(p).fontFamily);
  const lookFont = await help.locator("#markdown .md-look p").first().evaluate((p) => getComputedStyle(p).fontFamily);
  expect(lookFont).toBe(pageFont);
  const size = (selector: string) =>
    help.locator(`#markdown .md-look ${selector}`).first().evaluate((el) => parseFloat(getComputedStyle(el).fontSize));
  expect(await size("h1")).toBeGreaterThan(await size("h2"));
  expect(await size("h2")).toBeGreaterThan(await size("p"));
  await expect(help.locator("#markdown .md-look .diagram img")).toHaveJSProperty("complete", true);
  await app.close();
});

/** "Option-Command-1", as the page writes it, as Playwright presses it. */
function pressable(keys: string): string {
  const names: Record<string, string> = { Command: "Meta", Option: "Alt", Shift: "Shift", Control: "Control", Return: "Enter" };
  return keys
    .split("-")
    .map((k) => names[k] ?? (k.length === 1 ? k.toLowerCase() : k))
    .join("+");
}

test("the keys named on Markdown at a glance do what it says", async () => {
  const run = await openText("Plan\n\nAna Ruiz Head of Sales\n\nHire people\n\nOpen an office\n\n- One\n- Two\n");
  const { page } = run;
  const editor = page.locator(EDITOR);
  const tried = new Set<string>();
  const press = async (keys: string) => {
    tried.add(keys);
    await page.keyboard.press(pressable(keys));
    await settle(page);
  };

  // Headings, and back to a paragraph.
  await selectText(page, "Plan");
  await press("Option-Command-1");
  await expect(editor.locator("h1")).toHaveText("Plan");
  await press("Option-Command-4");
  await expect(editor.locator("h4")).toHaveText("Plan");
  await press("Option-Command-0");
  await expect(editor.locator("h1, h4")).toHaveCount(0);
  await expect(editor.locator("p").first()).toHaveText("Plan");

  // Bold, italic, strikethrough and code, each on its own word.
  const marks = [["Ana", "Command-B", "strong"], ["Ruiz", "Command-I", "em"], ["Head", "Shift-Command-X", "s"], ["Sales", "Command-E", "code"]];
  for (const [word, keys, tag] of marks) {
    await selectText(page, word);
    await press(keys);
    await expect(editor.locator(tag), keys).toHaveText(word);
  }

  // A link starts with the link editor.
  await selectText(page, "Plan");
  await press("Command-K");
  await expect(page.locator(".link-editor")).toBeVisible();
  await page.keyboard.press("Escape");
  await expect(page.locator(".link-editor")).toBeHidden();

  // A new line inside the paragraph.
  await selectText(page, "Ruiz");
  await page.keyboard.press("ArrowRight");
  await settle(page);
  await press("Shift-Return");
  await expect(editor.locator("p br")).toHaveCount(1);

  // Lists.
  await selectText(page, "Hire people");
  await press("Shift-Command-8");
  await expect(editor.locator("ul li", { hasText: "Hire people" })).toHaveCount(1);
  await selectText(page, "Open an office");
  await press("Shift-Command-7");
  await expect(editor.locator("ol li", { hasText: "Open an office" })).toHaveCount(1);
  await selectText(page, "Two");
  await press("Tab");
  await expect(editor.locator("li li")).toHaveText("Two");
  await press("Shift-Tab");
  await expect(editor.locator("li li")).toHaveCount(0);

  // Every key the page names was tried here.
  const help = await openHelp(run);
  const named = new Set(await help.locator("#markdown .md-how kbd").allTextContents());
  expect([...tried].sort()).toEqual([...named].sort());
  await run.app.close();
});

// Help's links go to its own pages: Open Link is for links in a document (R-MAIN-8).
test("right-clicking one of Help's own links offers Open Link greyed out, since only the document window opens links that way", async () => {
  const run = await openText(DOC);
  const help = await openHelp(run);
  await run.app.evaluate(({ Menu }) => {
    const g = globalThis as unknown as { shownMenu: Electron.Menu | null };
    g.shownMenu = null;
    Menu.prototype.popup = function (this: Electron.Menu) {
      g.shownMenu = this;
    };
  });
  await help.locator('.help-pages a[data-page="agents"]').click({ button: "right" });
  await expect.poll(() => run.app.evaluate(() => !!(globalThis as unknown as { shownMenu: unknown }).shownMenu)).toBe(true);
  const openLink = await run.app.evaluate(() => {
    const menu = (globalThis as unknown as { shownMenu: Electron.Menu }).shownMenu;
    return menu.items.find((i) => i.label === "Open Link")?.enabled;
  });
  expect(openLink).toBe(false);
  await run.app.close();
});

// Roadmap Batch 24, row 31 (N-16, N-17): Help for someone new.
test("Help in plain words for someone new: print finds Export to PDF, what Corillo doesn't do is said, and the first round needs no 'terminal'", async () => {
  const run = await openText(DOC);
  try {
    const help = await openHelp(run);
    const search = help.getByRole("searchbox", { name: "Search help" });
    const results = help.locator(".help-result");
    await search.fill("print");
    await expect(results.filter({ hasText: "Export to Word or PDF" })).toHaveCount(1);
    await expect(results.filter({ hasText: "What Corillo doesn't do" })).toHaveCount(1);
    for (const words of ["track changes", "spelling"]) {
      await search.fill(words);
      await expect(results.filter({ hasText: "What Corillo doesn't do" }), words).toHaveCount(1);
    }
    // The first round says what an agent tool is, and why one agent waits for you and another doesn't, without "terminal".
    const first = await help.locator("#first").textContent();
    expect(first).not.toMatch(/terminal/i);
    expect(first).toContain("An agent tool is the app where you chat with an AI agent");
    expect(first).toMatch(/only answer when you write in their chat/);
  } finally {
    await run.app.close();
  }
});
