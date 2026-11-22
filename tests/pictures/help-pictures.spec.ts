// npm run help-pictures: retakes every picture in Help from the real app,
// hidden, on the sample document (tests/pictures/sample) with throwaway data.
// Light, at twice the size for Retina screens, each cropped to what it shows.
// Afterwards it writes each picture's size into help.html. To retake just some,
// name them: HELP_PICTURES_ONLY=history,connect npm run help-pictures.
import { test, type Locator, type Page } from "@playwright/test";
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { AgentSession } from "../e2e/agent-session";
import { openFromFinder } from "../e2e/helpers";
import { smallPng } from "./small-png";
import { launch, resize, viewSize, settle, stillShot, selectText, clickMenu, comment, rest, quit, sampleComments, samplePass, idsIn, finish, EDITOR, type Studio, type StudioOptions } from "./studio";

const ROOT = join(import.meta.dirname, "..", "..");
const HELP = join(ROOT, "src", "renderer", "help.html");
const FOLDER = join(ROOT, "src", "renderer", "help-images");
/** Help's pictures stay small (tests/unit/help.test.ts holds them to this). */
const LIMIT = 80_000;
const ONLY = process.env.HELP_PICTURES_ONLY?.split(",");

const DOC = ".doc:not([hidden])";
const PANEL = `${DOC} .comments-panel`;

interface Box {
  x: number;
  y: number;
  width: number;
  height: number;
}

/** Each picture taken this run, at its size in Help (half its pixels). */
const taken = new Map<string, { width: number; height: number }>();

/** Where this is once it has stopped moving (cards settle a moment after a resize or a scroll). */
async function boxOf(target: Locator): Promise<Box> {
  let box = await target.boundingBox();
  for (let tries = 0; tries < 20; tries++) {
    await target.page().waitForTimeout(100);
    const again = await target.boundingBox();
    if (box && again && JSON.stringify(again) === JSON.stringify(box)) return box;
    box = again;
  }
  throw new Error(`Not on screen, or never still: ${target}`);
}

/** The smallest box around all of these, with this much room around it. */
function around(boxes: Box[], room = 0): Box {
  const left = Math.min(...boxes.map((b) => b.x)) - room;
  const top = Math.min(...boxes.map((b) => b.y)) - room;
  const right = Math.max(...boxes.map((b) => b.x + b.width)) + room;
  const bottom = Math.max(...boxes.map((b) => b.y + b.height)) + room;
  return { x: left, y: top, width: right - left, height: bottom - top };
}

/** Take one of Help's pictures: this part of the window, in whole pixels. */
async function picture(page: Page, name: string, box: Box): Promise<void> {
  if (ONLY && !ONLY.includes(name)) return;
  const view = await viewSize(page);
  const x = Math.max(0, Math.round(box.x));
  const y = Math.max(0, Math.round(box.y));
  const width = Math.min(view.width, Math.round(box.x + box.width)) - x;
  const height = Math.min(view.height, Math.round(box.y + box.height)) - y;
  await settle(page, 200);
  const shot = await stillShot(page, { clip: { x, y, width, height } });
  let png = smallPng(shot);
  if (png.length >= LIMIT * 0.9) png = smallPng(shot, 128); // fewer colours, before giving up
  if (png.length >= LIMIT) throw new Error(`${name}.png would be ${png.length} bytes, over Help's ${LIMIT}: crop it tighter`);
  writeFileSync(join(FOLDER, `${name}.png`), png);
  taken.set(name, { width, height });
}

/** No focus ring or hover anywhere: nothing has been clicked. */
async function still(page: Page): Promise<void> {
  await page.evaluate(() => (document.activeElement as HTMLElement | null)?.blur());
  await rest(page);
}

/** Scroll the page so this element's top is this far below the top of the page's view. */
async function scrollTo(page: Page, selector: string, below: number): Promise<void> {
  await page.evaluate(
    ([sel, off]) => {
      const el = document.querySelector(sel)!;
      const scroller = el.closest(".canvas")!;
      scroller.scrollTop += el.getBoundingClientRect().top - scroller.getBoundingClientRect().top - off;
    },
    [selector, below] as const,
  );
  await settle(page, 200);
}

// Everything a test starts, closed after it whether it worked or not.
const running: { close(): Promise<unknown> }[] = [];

async function open(options: StudioOptions = {}): Promise<Studio> {
  const s = await launch({ theme: "light", scale: 2, width: 1000, height: 700, ...options });
  running.push({ close: () => quit(s.app) });
  // No scroll bars: on a Mac they fade once scrolling stops, so they aren't part of the look.
  await s.page.addStyleTag({ content: "* { scrollbar-width: none !important; }" });
  return s;
}

async function agent(s: Studio, name = "claude-code"): Promise<AgentSession> {
  const { session } = await AgentSession.start(s.dataDir, name);
  running.unshift({ close: () => session.stop() });
  return session;
}

const OTHER_DOC = "# Team offsite\n\nTwo days in Ponce in October, for the whole volunteer team.\n";

test.afterEach(async () => {
  for (const r of running.splice(0)) await r.close().catch(() => undefined);
});

// Each picture's size goes into help.html, so Help shows it at exactly half its pixels.
test.afterAll(() => {
  let html = readFileSync(HELP, "utf8");
  for (const [name, { width, height }] of taken) {
    const img = new RegExp(`(<img src="help-images/${name}\\.png" )width="\\d+" height="\\d+"`);
    if (!img.test(html)) throw new Error(`help.html doesn't show ${name}.png: add a figure for it`);
    html = html.replace(img, `$1width="${width}" height="${height}"`);
  }
  writeFileSync(HELP, html);
});

test("the toolbar and the status bar", async () => {
  // Wide enough for every button's name.
  const s = await open({ width: 1440 });
  await sampleComments(s.page);
  await s.page.locator(`${EDITOR} p`, { hasText: "This proposal sets out" }).click({ position: { x: 4, y: 4 } });
  await rest(s.page);
  const toolbar = await boxOf(s.page.locator(".toolbar"));
  // Writing at the left, up to the Table menu; working with others at the right, from Comment.
  const tableMenu = await boxOf(s.page.getByRole("button", { name: "Table", exact: true }));
  const commentButton = await boxOf(s.page.getByRole("button", { name: "Comment", exact: true }));
  await picture(s.page, "toolbar-left", { ...toolbar, width: tableMenu.x + tableMenu.width + 10 - toolbar.x });
  await picture(s.page, "toolbar-right", { ...toolbar, x: commentButton.x - 10, width: toolbar.x + toolbar.width - (commentButton.x - 10) });
  await resize(s.app, s.page, 560, 700);
  await picture(s.page, "status-bar", await boxOf(s.page.locator(".status-bar")));
});

test("Connect your agents", async () => {
  const s = await open({
    text: null,
    width: 900,
    homeFiles: { ".claude.json": "{}\n", "Library/Application Support/Claude/claude_desktop_config.json": "{}\n" },
  });
  await clickMenu(s.app, "connect-agents");
  const dialog = s.page.getByRole("dialog", { name: "Connect your agents" });
  await dialog.waitFor();
  await still(s.page);
  await picture(s.page, "connect", await boxOf(dialog));
});

test("the comments panel beside the page, with New comment at its top", async () => {
  const s = await open({ width: 760 });
  await comment(s.page, "four inboxes and two group chats", "Can we say which inboxes?");
  await comment(s.page, "some people get two answers", "Give an example here.");
  // Neither in focus: the cursor in the heading, then nowhere.
  await s.page.locator(`${EDITOR} h1`).click();
  await scrollTo(s.page, `${EDITOR} h1`, 16);
  await still(s.page);
  // The heading, the paragraph and the panel beside them (cards stack from the top).
  const heading = await boxOf(s.page.locator(`${EDITOR} h1`));
  const paragraph = await boxOf(s.page.locator(`${EDITOR} p`, { hasText: "Requests reach us" }));
  const panel = await boxOf(s.page.locator(PANEL));
  const cards = await Promise.all(
    ["Can we say which inboxes?", "Give an example here."].map((text) => boxOf(s.page.locator(`${PANEL} .comment-card`, { hasText: text }))),
  );
  // New comment, at the top of the panel (roadmap Batch 9, item 14).
  const newComment = await boxOf(s.page.locator(`${PANEL} .comments-new`));
  const all = around([heading, paragraph, newComment, ...cards], 14);
  const left = paragraph.x - 16;
  await picture(s.page, "comments-panel", { x: left, y: all.y, width: panel.x + panel.width - left, height: all.height });
});

test("an agent at work, the tab's dot, the line when it's done, a card in focus, Show changes and History", async () => {
  const s = await open();
  const { page, app } = s;
  await sampleComments(page);
  const claude = await agent(s);
  await samplePass(claude, s.file, async () => {
    // While it works, the notice says so, across the page (beside the comments,
    // about 700 pixels wide: room for all its words).
    const notice = page.locator(`${DOC} .agent-notice:not([hidden])`);
    await notice.waitFor();
    await still(page);
    await picture(page, "agent-notice", await boxOf(notice));
    // Another document in front, so this one's tab shows the dot when the agent finishes.
    writeFileSync(join(s.folder, "Team offsite.md"), OTHER_DOC);
    await openFromFinder(s.app, join(s.folder, "Team offsite.md"));
    await page.locator(".tab").nth(1).waitFor();
  });
  await page.locator('.tab .tab-dot[data-turn="back"]').waitFor(); // filled: back with you, not the hollow one while it edits
  await still(page);
  const tabs = await boxOf(page.locator(".tabs"));
  const second = await boxOf(page.locator(".tab").nth(1));
  await picture(page, "tab-dot", { ...tabs, width: second.x + second.width + 12 - tabs.x });

  // Back on the proposal: the line saying the agent is done, the document is back, and what's to read.
  await page.locator(".tab").first().click();
  const doneLine = page.locator(`${DOC} .pass-notice:not([hidden])`);
  await doneLine.waitFor();
  await still(page);
  await picture(page, "review-notice", await boxOf(doneLine));
  // The whole-document comment, at the top of the panel with the top of the page.
  await page.evaluate((doc) => document.querySelector(`${doc} .canvas`)!.scrollTo(0, 0), DOC);
  await picture(page, "comment-reply", await boxOf(page.locator(`${PANEL} .comment-card`, { hasText: "Make the opening friendlier." })));

  // Going through the cards: the second comment in focus, its change highlighted, and its card beside it.
  // Wide enough for the page to have the done line's words in full beside the panel.
  await resize(app, page, 820, 700);
  await page.locator(`${PANEL} .comment-card`, { hasText: "Can we say which inboxes?" }).locator(".comment-body").first().click();
  await settle(page, 400);
  await scrollTo(page, `${EDITOR} p:has(.change-mark)`, 12);
  // Cards stack from the top of their own column: scroll it so the card in focus
  // sits just under the line at the top, beside its words.
  await page.evaluate((panel) => {
    const card = document.querySelector<HTMLElement>(`${panel} .comment-card.active`)!;
    let column = card.parentElement;
    while (column && !/(auto|scroll)/.test(getComputedStyle(column).overflowY)) column = column.parentElement;
    if (column) column.scrollTop += card.getBoundingClientRect().top - column.getBoundingClientRect().top - 12;
  }, PANEL);
  await rest(page);
  // The line is over the page only; the panel beside it starts level with it.
  const line = await boxOf(doneLine);
  const card = await boxOf(page.locator(`${PANEL} .comment-card.active`));
  const panel = await boxOf(page.locator(PANEL));
  await picture(page, "review", { ...line, width: panel.x + panel.width - line.x, height: card.y + card.height + 12 - line.y });
  await reviewMenu(s);
  await resize(app, page, 1000, 700);

  // Show changes, with the comments out of the way.
  await clickMenu(app, "view-comments");
  await resize(app, page, 600, 700);
  await clickMenu(app, "view-changes");
  const banner = page.locator(`${DOC} .version-banner:not([hidden])`);
  await banner.waitFor();
  const bannerBox = await boxOf(banner);
  // The title near the top, the document details box above it just out of sight.
  await scrollTo(page, `${DOC} .version-view h1`, 20);
  await still(page);
  const opening = await boxOf(page.locator(`${DOC} .version-view p`, { hasText: "Requests reach us" }));
  await picture(page, "show-changes", { ...bannerBox, height: opening.y + opening.height + 12 - bannerBox.y });
  await clickMenu(app, "view-changes");
  await clickMenu(app, "view-comments");

  // History.
  await resize(app, page, 1000, 700);
  await clickMenu(app, "view-history");
  const history = page.locator(`${DOC} .history-panel`);
  await history.waitFor();
  await still(page);
  const panelBox = await boxOf(history);
  const first = await boxOf(page.locator(`${DOC} .history-item`).last());
  await picture(page, "history", { ...panelBox, height: first.y + first.height + 8 - panelBox.y });
});

/**
 * The Review menu, drawn in the page from the real menu's items (their names,
 * shortcuts and which apply right now): a menu open on screen can't be
 * pictured without bringing Corillo to the front.
 */
async function reviewMenu(s: Studio): Promise<void> {
  const items = await s.app.evaluate(({ Menu }) => {
    const review = Menu.getApplicationMenu()!.items.find((i) => i.label === "Review")!;
    return review.submenu!.items.map((i) => ({ separator: i.type === "separator", label: i.label, keys: String(i.accelerator ?? ""), enabled: i.enabled, checked: i.checked }));
  });
  const box = await s.page.evaluate((list) => {
    const GLYPHS: Record<string, string> = { Down: "↓", Up: "↑", Left: "←", Right: "→", Enter: "↩", Return: "↩", Escape: "⎋", Tab: "⇥", Backspace: "⌫", Delete: "⌦" };
    const keys = (accelerator: string) => {
      if (!accelerator) return "";
      const parts = accelerator.split("+");
      const key = parts.pop()!;
      const mods = new Set(parts.map((p) => (p === "CmdOrCtrl" || p === "CommandOrControl" || p === "Command" ? "Cmd" : p === "Option" ? "Alt" : p)));
      return ["Ctrl", "Alt", "Shift", "Cmd"].filter((m) => mods.has(m)).map((m) => ({ Ctrl: "⌃", Alt: "⌥", Shift: "⇧", Cmd: "⌘" })[m]).join("") + (GLYPHS[key] ?? key.toUpperCase());
    };
    const ground = document.createElement("div");
    ground.id = "menu-picture";
    ground.style.cssText = "position: fixed; left: 0; top: 0; z-index: 99999; padding: 0 24px 24px; background: var(--ground); font: 13px/1 -apple-system, system-ui, sans-serif; color: #1d1d1f;";
    const title = document.createElement("div");
    title.textContent = "Review";
    title.style.cssText = "display: inline-block; margin: 6px 0 2px; padding: 4px 9px; border-radius: 5px; background: rgba(0, 0, 0, 0.1); font-weight: 500;";
    const menu = document.createElement("div");
    menu.style.cssText = "width: 270px; padding: 5px; border-radius: 9px; background: #f6f6f6; box-shadow: 0 0 0 0.5px rgba(0, 0, 0, 0.22), 0 8px 24px rgba(0, 0, 0, 0.16);";
    for (const item of list) {
      const row = document.createElement("div");
      if (item.separator) {
        row.style.cssText = "height: 1px; margin: 5px 10px; background: rgba(0, 0, 0, 0.1);";
      } else {
        row.style.cssText = `display: flex; gap: 16px; padding: 4px 10px 4px 22px; line-height: 14px; position: relative; color: ${item.enabled ? "#1d1d1f" : "#a8a8a8"};`;
        const name = document.createElement("span");
        name.textContent = item.label;
        name.style.flex = "1";
        const shortcut = document.createElement("span");
        shortcut.textContent = keys(item.keys);
        shortcut.style.color = item.enabled ? "#7a7a7a" : "#bdbdbd";
        if (item.checked) {
          const tick = document.createElement("span");
          tick.textContent = "✓";
          tick.style.cssText = "position: absolute; left: 7px;";
          row.append(tick);
        }
        row.append(name, shortcut);
      }
      menu.append(row);
    }
    ground.append(title, menu);
    document.body.append(ground);
    const r = ground.getBoundingClientRect();
    return { x: r.x, y: r.y, width: r.width, height: r.height };
  }, items);
  await rest(s.page);
  await picture(s.page, "review-menu", box);
  await s.page.evaluate(() => document.getElementById("menu-picture")?.remove());
}

test("a new comment, with the @ list for two agents", async () => {
  const s = await open();
  const claude = await agent(s);
  await claude.ok("take_document", { path: s.file });
  await claude.ok("finish_editing", { path: s.file });
  const writer = await agent(s, "writer");
  await writer.ok("open_document", { path: s.file });
  await selectText(s.page, "a budget of $1,200");
  await s.page.getByRole("button", { name: "Comment", exact: true }).click();
  await s.page.getByRole("textbox", { name: "New comment" }).fill("Is this enough for the first year? ");
  await s.page.keyboard.type("@");
  await s.page.locator("#mention-list:not([hidden])").waitFor();
  await rest(s.page);
  const card = await boxOf(s.page.locator(`${PANEL} .comment-card.draft`));
  const list = await boxOf(s.page.locator("#mention-list"));
  await picture(s.page, "new-comment", around([card, list]));
});

test("an agent's options under its reply", async () => {
  const s = await open();
  await comment(s.page, null, "Make the opening friendlier.");
  const claude = await agent(s);
  const ids = idsIn(await claude.ok("take_document", { path: s.file }));
  const opening = ids.get("");
  await claude.ok("edit_document", { path: s.file, edits: [{ find: "Nobody can see", replace: "Right now, nobody can see" }], comment_ids: [opening] });
  // The options Help names: the agent's best version is in the text, the others are a click away.
  await claude.ok("reply_to_comment", {
    path: s.file,
    comment_id: opening,
    text: "Softened the second sentence. Or one of these:",
    options: [
      { label: "Shorter", edits: [{ find: "Right now, nobody can see what's already being handled", replace: "Nobody can see who's on what" }] },
      { label: "More formal", edits: [{ find: "Right now, nobody can see", replace: "At present, no one can see" }] },
    ],
  });
  await finish(claude, s.file);
  const card = s.page.locator(`${PANEL} .comment-card`, { hasText: "Make the opening friendlier." });
  await card.locator(".comment-option", { hasText: "More formal" }).waitFor();
  await still(s.page);
  await picture(s.page, "reply-options", await boxOf(card));
});

test("the outline", async () => {
  // Wide enough for the outline beside the page with the comments open.
  const s = await open({ width: 1200 });
  await sampleComments(s.page);
  await samplePass(await agent(s), s.file);
  await clickMenu(s.app, "view-outline");
  const pane = s.page.locator(`${DOC} .outline-pane`);
  await pane.waitFor();
  // Reading the proposal itself, so the outline marks that section.
  await scrollTo(s.page, `${EDITOR} h2:nth-of-type(2)`, 16); // What we propose
  await pane.locator(".outline-row.in-sight", { hasText: "What we propose" }).waitFor();
  await still(s.page);
  // From its title to its last heading: the counts, the dots and the section in sight.
  const box = await boxOf(pane);
  const last = await boxOf(pane.locator(".outline-row").last());
  await picture(s.page, "outline", { ...box, height: last.y + last.height + 8 - box.y });
});

test("the export notice", async () => {
  const s = await open();
  const pdf = join(s.folder, "Q3 proposal.pdf");
  await s.app.evaluate(({ dialog }, chosen) => {
    dialog.showSaveDialog = (async () => ({ canceled: false, filePath: chosen })) as typeof dialog.showSaveDialog;
  }, pdf);
  await clickMenu(s.app, "export-pdf");
  const notice = s.page.locator(".export-notice:not([hidden])[data-state='done']");
  await notice.waitFor({ timeout: 30_000 });
  await still(s.page);
  await picture(s.page, "export-notice", await boxOf(notice));
});

test("a missing picture, and a change made outside Corillo", async () => {
  const s = await open({ width: 600, name: "Launch.md", text: "# Launch\n\n![Chart](Launch%20images/chart.png)\n\nThe numbers above are from June.\n" });
  const missing = s.page.locator(`${EDITOR} .picture.missing`);
  await missing.waitFor();
  await still(s.page);
  await picture(s.page, "missing-picture", await boxOf(missing));
  // Typed, and changed in another app before Corillo saved it. The banner spans
  // the page only: with no comments to show, the panel is put away so it has the window's width.
  await clickMenu(s.app, "view-comments");
  await s.page.locator(`${EDITOR} p`, { hasText: "The numbers" }).click();
  await s.page.keyboard.press("Meta+ArrowRight");
  await s.page.keyboard.type(" Mine.");
  writeFileSync(s.file, "# Launch\n\nTheirs.\n");
  const conflict = s.page.locator(`${DOC} .banner.conflict:not([hidden])`);
  await conflict.waitFor();
  await still(s.page);
  await picture(s.page, "outside-change", await boxOf(conflict));
});

test("the Markdown page's examples: a picture and a diagram", async () => {
  const s = await open();
  // The sample's chart, shown smaller, as it sits beside its Markdown in Help.
  const chart = s.page.locator(`${EDITOR} img[alt="Requests answered each month"]`);
  await chart.evaluate((img: HTMLImageElement) => img.decode());
  await chart.evaluate((img) => {
    img.style.width = "300px";
  });
  await scrollTo(s.page, `${EDITOR} img[alt="Requests answered each month"]`, 40);
  await still(s.page);
  await picture(s.page, "markdown-picture", await boxOf(chart));
  await quit(s.app);

  const d = await open({ name: "Flow.md", text: "```mermaid\ngraph LR\n  Draft --> Review --> Send\n```\n" });
  const drawing = d.page.locator(`${EDITOR} .diagram-picture`);
  await drawing.locator("svg").waitFor({ timeout: 15_000 });
  await still(d.page);
  await picture(d.page, "markdown-diagram", around([await boxOf(drawing.locator("svg"))], 4));
});
