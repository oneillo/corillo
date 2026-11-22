// The window around the page, seen fresh (roadmap Batch 11, item 3): the toolbar, the tabs, the status bar,
// Corillo's notices, its dialogs, the start screen, Find, Help and the words they use. Each test shares one
// launch between several findings, so they add little to a run.
import { test, expect, type Page } from "@playwright/test";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { AgentSession } from "./agent-session";
import { clickMenu, cursorAtEnd, expectFile, ONE_SCALE, openAlso, openFromFinder, openText, selectText, settle, launch } from "./helpers";
import { tidyRuns } from "./tidy";

const tidy = tidyRuns();
const DOC = ".doc:not([hidden])";
const PANEL = `${DOC} .comments-panel`;

const PLAN = `# Volunteer help desk

Requests reach us through four inboxes and two group chats. Nobody can see what's already being handled.

## Where we are today

Last quarter we answered 1,840 requests. Most were simple, but the slow ones were slow for the same reasons.

## 2.2 Always a year left on the lease, and what that means for the move

One shared help desk, tried for three months over the summer.
`;

/** Where each tab is along the bar, and how wide. */
function tabBoxes(page: Page): Promise<{ x: number; width: number }[]> {
  return page.locator(".tabs .tab").evaluateAll((tabs) => tabs.map((t) => t.getBoundingClientRect()).map((r) => ({ x: r.x, width: r.width })));
}

/** The window as it stands, at its new width, once it has been laid out again. */
async function widen(page: Page, width: number, height = 900): Promise<void> {
  await page.setViewportSize({ width, height });
  await page.evaluate(() => new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve))));
}

/**
 * How alike two toolbar buttons' icons are drawn: the share of their inked pixels they have in common (1, the
 * same drawing; 0, nothing in common), each drawn twice its size in black.
 */
function iconsAlike(page: Page, one: string, other: string): Promise<number> {
  return page.evaluate(
    async ([a, b]) => {
      const inked = async (selector: string) => {
        const svg = document.querySelector(selector)!.querySelector("svg")!.outerHTML.replace(/currentColor/g, "#000").replace("<svg ", '<svg xmlns="http://www.w3.org/2000/svg" ');
        const img = new Image();
        img.src = `data:image/svg+xml,${encodeURIComponent(svg)}`;
        await img.decode();
        const canvas = document.createElement("canvas");
        canvas.width = canvas.height = 32;
        const g = canvas.getContext("2d")!;
        g.drawImage(img, 0, 0, 32, 32);
        const d = g.getImageData(0, 0, 32, 32).data;
        return Array.from({ length: 32 * 32 }, (_, i) => d[i * 4 + 3] > 64);
      };
      const [x, y] = await Promise.all([inked(a), inked(b)]);
      const both = x.filter((v, i) => v && y[i]).length;
      const either = x.filter((v, i) => v || y[i]).length;
      return both / either;
    },
    [one, other] as const,
  );
}

const COMMENT = "#toolbar button[aria-label='Comment']";
const COMMENTS = "#toolbar .comments-tool";

// F-4 (the tabs), F-13, F-14 and F-30.
test("nothing on the toolbar or the tabs moves when a count, a coquí or a dot comes; the style box keeps naming the paragraph while a comment is written or Claude edits; Comment and the Comments panel's button look unalike", async () => {
  const run = tidy.keep(await openText(PLAN, { name: "Plan.md" }));
  const { page } = run;
  await widen(page, 1440);
  const offsite = await openAlso(run, "Offsite.md", "# Team offsite\n\nTwo days in Ponce in October.\n");
  await page.locator('.tab[title$="/Plan.md"]').click();
  const style = page.getByRole("combobox", { name: "Paragraph style" });
  const shownStyle = style.locator("option:checked");

  // F-13: the first comment's count comes without moving Comment, at a width where it has its name and where it hasn't.
  for (const width of [1440, 900]) {
    await widen(page, width);
    const before = await page.locator(COMMENT).boundingBox();
    const moreBefore = await page.getByRole("button", { name: "More", exact: true }).isVisible();
    await selectText(page, width === 1440 ? "four inboxes" : "two group chats");
    await page.locator(COMMENT).click();
    // F-14: while it's written, the style box still names the paragraph, greyed out.
    await expect(page.getByRole("textbox", { name: "New comment" })).toBeFocused();
    await expect(style).toBeDisabled();
    await expect(shownStyle).toHaveText("Normal text");
    await page.getByRole("textbox", { name: "New comment" }).fill("Which ones?");
    await page.getByRole("button", { name: "Post" }).click();
    await expect(page.locator(`${COMMENTS} .tool-count`)).toHaveText(width === 1440 ? "1" : "2");
    await settle(page);
    expect(await page.locator(COMMENT).boundingBox(), `Comment at ${width} px`).toEqual(before);
    expect(await page.getByRole("button", { name: "More", exact: true }).isVisible(), `More at ${width} px`).toBe(moreBefore);
    if (width === 1440) {
      // Resolved, the count goes, and still nothing moves.
      await page.locator(`${PANEL} .comment-card`, { hasText: "Which ones?" }).getByRole("button", { name: "Resolve" }).click();
      await expect(page.locator(`${COMMENTS} .tool-count`)).toBeHidden();
      await settle(page);
      expect(await page.locator(COMMENT).boundingBox(), "Comment, the count gone").toEqual(before);
      await page.keyboard.press("Meta+z"); // back again, for the narrower window
      await expect(page.locator(`${COMMENTS} .tool-count`)).toHaveText("1");
    }
  }

  // F-30: at 900 px and below, where both show only their icons, they're drawn unalike (they were two
  // bubbles, 0.82 alike; now a bubble with a plus, and a window with a panel at its right).
  for (const width of [900, 560]) {
    await widen(page, width);
    await expect(page.locator(COMMENT)).toBeVisible();
    await expect(page.locator(COMMENTS)).toBeVisible();
    expect(await iconsAlike(page, COMMENT, COMMENTS), `at ${width} px`).toBeLessThan(0.6);
  }
  await widen(page, 1440);

  // F-4: Claude takes the document behind (a coquí on its tab), then hands it back (a dot): no tab grows or moves.
  await page.locator(`${DOC} .ProseMirror h1`).click();
  const tabsBefore = await tabBoxes(page);
  const { session } = await AgentSession.start(run.dataDir, "claude-code");
  try {
    await session.ok("take_document", { path: offsite });
    await expect(page.locator('.tab[title*="/Offsite.md"] .tab-dot[data-turn="editing"]')).toBeVisible();
    expect(await tabBoxes(page), "while Claude edits").toEqual(tabsBefore);
    await session.ok("edit_document", { path: offsite, edits: [{ find: "Two days", replace: "Three days" }] });
    await session.ok("finish_editing", { path: offsite });
    await expect(page.locator('.tab[title*="/Offsite.md"] .tab-dot[data-turn="back"]')).toBeVisible();
    expect(await tabBoxes(page), "back from Claude").toEqual(tabsBefore);

    // F-14: while Claude edits the document in front, the style box names the paragraph too, greyed out.
    await expect(shownStyle).toHaveText("Heading 1");
    await session.ok("take_document", { path: run.file });
    await expect(page.locator(`${DOC} .agent-notice:not([hidden])`)).toBeVisible();
    await expect(style).toBeDisabled();
    await expect(shownStyle).toHaveText("Heading 1");
  } finally {
    await session.stop();
  }
});

/** A box's edges, rounded to the pixel. */
async function edgesOf(page: Page, selector: string): Promise<{ left: number; right: number; top: number; bottom: number }> {
  const b = (await page.locator(selector).boundingBox())!;
  return { left: Math.round(b.x), right: Math.round(b.x + b.width), top: Math.round(b.y), bottom: Math.round(b.y + b.height) };
}

// F-17 and F-23 (the status bar's part).
test("at 560 px Corillo's notices lie under the page and the Comments panel, not on them, stacked with one width and edge; the status bar names the section in sight with enough words, cut by \"…\"", async () => {
  const filler = Array.from({ length: 14 }, (_, i) => `Paragraph ${i + 1} about the requests we answered and how long each took.`).join("\n\n");
  const run = tidy.keep(await openText(PLAN.replace("## 2.2", `${filler}\n\n## 2.2`) + `\n${filler}\n`, { name: "Plan.md" }));
  const { app, page } = run;
  await widen(page, 560, 700);
  await clickMenu(app, "view-outline");
  await selectText(page, "four inboxes");
  await page.locator(COMMENT).click();
  await page.getByRole("textbox", { name: "New comment" }).fill("Which ones?");
  await page.getByRole("button", { name: "Post" }).click();
  await expect(page.locator(`${PANEL} .comment-card:not(.draft)`)).toHaveCount(1);
  // Claude answers it, so the status bar says whose turn it is too.
  const { session } = await AgentSession.start(run.dataDir, "claude-code");
  try {
    const taken = await session.ok("take_document", { path: run.file });
    const id = /\[([^\]]+)\] on "four inboxes"/.exec(taken)![1];
    await session.ok("reply_to_comment", { path: run.file, comment_id: id, text: "Help, info, volunteers and events." });
    await session.ok("finish_editing", { path: run.file });
  } finally {
    await session.stop();
  }
  await expect(page.locator("#turn-status")).toBeVisible();

  // Three notices: the tab's two (a link it won't open, Copy for Email) and one of the window's.
  const planId = await page.locator(DOC).getAttribute("data-doc-id");
  await page.evaluate((docId) => window.corillo.openLink("secret.md", docId!), planId);
  await clickMenu(app, "copy-email");
  await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].webContents.send("app:notice", "Corillo has moved.", "Start a new session."));
  const tabNotices = [`${DOC} .file-notice`, `${DOC} .export-notice`];
  const windowNotice = "body > .window-notices .file-notice";
  for (const n of [...tabNotices, windowNotice]) await expect(page.locator(n)).toBeVisible();
  await expect(page.locator(PANEL)).toBeVisible();

  const pageBox = await edgesOf(page, `${DOC} .doc-main`);
  const panelBox = await edgesOf(page, PANEL);
  const boxes = await Promise.all([...tabNotices, windowNotice].map((n) => edgesOf(page, n)));
  for (const [i, box] of boxes.entries()) {
    // Under the page and the panel, not on them, and the window's width.
    expect(box.top, `notice ${i}`).toBeGreaterThanOrEqual(Math.max(pageBox.bottom, panelBox.bottom));
    expect([box.left, box.right], `notice ${i}`).toEqual([0, 560]);
  }
  // Stacked, none on another: the tab's, then the window's, then the status bar.
  const [link, email, windows] = boxes;
  expect(email.top >= link.bottom || link.top >= email.bottom, "the tab's two notices").toBe(true);
  expect(windows.top).toBeGreaterThanOrEqual(Math.max(link.bottom, email.bottom));
  expect(windows.bottom).toBeLessThanOrEqual((await edgesOf(page, ".status-bar")).top);

  // F-23: the section in sight, a long heading, keeps enough words to mean something, and is cut with "…".
  await page.locator(`${DOC} .ProseMirror h2`, { hasText: "2.2 Always" }).evaluate((h) => h.scrollIntoView({ block: "start" }));
  await page.locator(`${DOC} .ProseMirror h2`, { hasText: "2.2 Always" }).click(); // nothing selected: the word count is short
  await expect(page.locator("#outline-section")).toHaveText(/^2\.2 Always a year left/);
  await settle(page);
  const section = await page.locator("#outline-section").evaluate((s) => {
    const style = getComputedStyle(s);
    const room = s.clientWidth - parseFloat(style.paddingLeft) - parseFloat(style.paddingRight);
    const bar = s.parentElement!;
    const who = bar.querySelector(".turn-who")!;
    return { room, cut: s.scrollWidth > s.clientWidth, ellipsis: style.textOverflow, fits: bar.scrollWidth <= bar.clientWidth, turnWhole: who.scrollWidth <= who.clientWidth };
  });
  expect(section.cut).toBe(true);
  expect(section.turnWhole, "whose turn it is, whole").toBe(true);
  expect(section.ellipsis).toBe("ellipsis");
  expect(section.fits).toBe(true);
  // "2.2 Always a…": a dozen characters at least (it was "2", with no "…").
  expect(section.room).toBeGreaterThanOrEqual(72);
});

/** Whether a control looks like one you can click: an edge of its own, and how tall it is. */
function looksClickable(page: Page, selector: string): Promise<{ edged: boolean; height: number }> {
  return page.locator(selector).first().evaluate((b) => {
    const s = getComputedStyle(b);
    const edged = parseFloat(s.borderTopWidth) >= 1 && s.borderTopStyle !== "none" && !/rgba\(0, 0, 0, 0\)|transparent/.test(s.borderTopColor);
    return { edged, height: b.getBoundingClientRect().height };
  });
}

// F-20 (Connect), F-26 and F-27.
test("Connect your agents opens with one main action (Connect while a tool is left: Batch 24, row 20), the keyboard on Done; a status reads as one and every button looks like a button; the start screen stays put when it closes", async () => {
  const home = mkdtempSync(join(tmpdir(), "corillo-home-"));
  writeFileSync(join(home, ".claude.json"), '{\n  "numStartups": 3\n}\n');
  mkdirSync(join(home, ".codex")); // a second tool found, so two are left to connect (review of Batch 24, R24-3)
  const dataDir = mkdtempSync(join(tmpdir(), "corillo-data-"));
  const { app } = await launch({ args: [ONE_SCALE, "."], env: { ...process.env, CORILLO_USER_DATA: dataDir, CORILLO_HIDDEN: "1", CORILLO_HOME: home } });
  try {
    const page = await app.firstWindow();
    await page.setViewportSize({ width: 1440, height: 900 });
    const screen = page.getByRole("dialog", { name: "Connect your agents" });
    await expect(screen).toBeVisible();
    const title = () => page.locator(".empty-title").boundingBox();
    const titleWithBox = await title();

    // F-20: one filled button (Connect, while a tool is left to connect: Batch 24, row 20), and the keyboard starts on Done.
    // With two tools left, only the first one's Connect is filled (review of Batch 24, R24-3).
    await expect(screen.getByRole("button", { name: "Connect Codex" })).toBeVisible();
    await expect(screen.locator("button.primary")).toHaveCount(1);
    await expect(screen.locator("button.primary")).toHaveAccessibleName("Connect Claude Code");
    await expect(screen.getByRole("button", { name: "Done" })).toBeFocused();

    // F-26: once set up, the status is quiet words with a mark, not bold; Disconnect, Copy and Connect by hand… are edged buttons.
    await screen.getByRole("button", { name: "Connect Claude Code" }).click();
    const setUp = screen.locator(".agent-set-up");
    await expect(setUp).toHaveText("Ready");
    // The next one left takes the fill.
    await expect(screen.locator("button.primary")).toHaveCount(1);
    await expect(screen.locator("button.primary")).toHaveAccessibleName("Connect Codex");
    expect(
      await setUp.evaluate((s) => ({ weight: getComputedStyle(s).fontWeight, mark: getComputedStyle(s, "::before").content !== "none" })),
    ).toEqual({ weight: "400", mark: true });
    for (const name of ["Disconnect Claude Code", "Copy the request to try"]) {
      const b = await looksClickable(page, `dialog.connect-agents button[aria-label="${name}"]`);
      expect(b.edged, name).toBe(true);
      expect([24, 28], name).toContain(b.height);
    }
    expect((await looksClickable(page, "dialog.connect-agents .connect-actions button:not(.primary)")).edged, "Connect by hand…").toBe(true);

    // F-27: Done, and the start screen's name is where it was.
    await screen.getByRole("button", { name: "Done" }).click();
    await expect(screen).toBeHidden();
    expect(await title()).toEqual(titleWithBox);
  } finally {
    await app.close();
  }
});

// F-20 (Export settings), F-24, F-25, F-28 and F-29.
test("Export settings starts on Save; the window's words match (Export's boxes end in \"…\", Show changes says what it shows, Replace all); Find's arrows are Show changes' and Done sits with the rest; a PDF is told what Corillo opens; Help opens at its top", async () => {
  const run = tidy.keep(await openText(PLAN, { name: "Plan.md" }));
  const { app, page } = run;
  await widen(page, 1440);

  // F-20: Export settings' main action is Save, and the keyboard starts there.
  await clickMenu(app, "export-settings");
  const sheet = page.locator("dialog.export-settings[open]");
  await expect(sheet).toBeVisible();
  await expect(sheet.locator("button.primary")).toHaveText("Save");
  await expect(sheet.locator("button.primary")).toBeFocused();
  await page.keyboard.press("Escape");
  await expect(sheet).toBeHidden();

  // F-24: the toolbar's Export menu ends each item that asks where to save in "…"; Show changes' tooltip says what it shows.
  await page.getByRole("button", { name: "Export", exact: true }).click();
  const items = await page.locator(".menu:not([hidden]) [role^='menuitem']").allTextContents();
  expect(items.slice(0, 2).map((t) => t.trim())).toEqual(["Export to Word…", "Export to PDF…"]); // the menu bar's words since Batch 24, row 28
  await page.keyboard.press("Escape");
  expect(await page.locator("#toolbar").getByRole("button", { name: "Show changes", exact: true }).getAttribute("title")).toBe("Show what changed since you handed the document over (⌃⌘C)");

  // F-25: Find's arrows, as Show changes' are: two buttons of their own, 28 square, 4 apart, the keyboard staying in the box.
  await page.keyboard.press("Meta+f");
  const field = page.getByRole("textbox", { name: "Find", exact: true });
  await expect(field).toBeFocused();
  await field.fill("requests");
  const arrows = await page.locator(".find-bar .find-step").evaluateAll((bs) =>
    bs.map((b) => {
      const r = b.getBoundingClientRect();
      const s = getComputedStyle(b);
      return { x: r.x, right: r.right, width: r.width, height: r.height, corners: [s.borderTopLeftRadius, s.borderTopRightRadius, s.borderBottomRightRadius, s.borderBottomLeftRadius].every((c) => parseFloat(c) > 0), edge: s.borderLeftStyle };
    }),
  );
  expect(arrows.map((a) => [a.width, a.height, a.corners, a.edge])).toEqual([
    [28, 28, true, "solid"],
    [28, 28, true, "solid"],
  ]);
  expect(Math.round(arrows[1].x - arrows[0].right)).toBe(4);
  await expect(page.locator(".find-count")).toHaveText("1 of 2");
  await page.getByRole("button", { name: "Next match" }).click();
  await expect(page.locator(".find-count")).toHaveText("2 of 2");
  await expect(field).toBeFocused();
  // Done sits with the other controls, not at the far end.
  const [replace, done] = await Promise.all([page.getByRole("button", { name: "Replace…" }).boundingBox(), page.getByRole("button", { name: "Done" }).boundingBox()]);
  expect(Math.round(done!.x - (replace!.x + replace!.width))).toBe(8);
  await page.getByRole("button", { name: "Replace…" }).click();
  await expect(page.getByRole("button", { name: "Replace all" })).toBeVisible();
  await page.keyboard.press("Escape");

  // F-28: a PDF opened from the Finder is told what Corillo opens, in plain words.
  await app.evaluate(({ dialog }) => {
    const g = globalThis as unknown as { shown: string[] };
    g.shown = [];
    dialog.showErrorBox = (title: string, content: string) => void g.shown.push(`${title}: ${content}`);
  });
  const pdf = join(run.folder, "Budget.pdf");
  writeFileSync(pdf, Buffer.concat([Buffer.from("%PDF-1.7\n"), Buffer.from([0xe2, 0xe3, 0xcf, 0xd3, 0x00, 0xff, 0xfe])]));
  await openFromFinder(app, pdf);
  await expect
    .poll(() => app.evaluate(() => (globalThis as unknown as { shown: string[] }).shown))
    .toEqual(["Can't open Budget.pdf: Corillo opens Markdown and Word documents, and this is a PDF. An agent can make a Markdown document from it."]);

  // F-29: Help opens at the top of its page.
  const [help] = await Promise.all([app.waitForEvent("window"), clickMenu(app, "corillo-help")]);
  await help.waitForSelector(".help-page:not([hidden])");
  await help.waitForTimeout(300); // after the address's own jump, if any
  expect(await help.locator(".help-main").evaluate((m) => m.scrollTop)).toBe(0);
  // F-24: Help names Format > Code as the menu does.
  const code = await app.evaluate(({ Menu }) => Menu.getApplicationMenu()!.getMenuItemById("format-code")!.label);
  await expect(help.locator('tr[data-shortcut="menu:format-code"] td').first()).toHaveText(code);
});

// Review of Batch 11, B11R-1: a document that mentions "%PDF-" near its top was taken for a PDF, so every save
// after the first was refused ("the file was changed into something Corillo can't read") and it wouldn't open again.
test("a document that mentions %PDF- near its top keeps saving and opens again", async () => {
  const run = tidy.keep(await openText("# Notes\n\nA line.\n", { name: "notes.md" }));
  const { app, page } = run;
  await app.evaluate(({ dialog }) => {
    const g = globalThis as unknown as { shown: string[] };
    g.shown = [];
    dialog.showErrorBox = (title: string, content: string) => void g.shown.push(`${title}: ${content}`);
  });
  await cursorAtEnd(page, "A line.");
  await page.keyboard.type(" A PDF file starts with %PDF-1.7 on its first line.");
  await expectFile(run, "# Notes\n\nA line. A PDF file starts with %PDF-1.7 on its first line.\n");
  await page.keyboard.type(" Then more.");
  await expectFile(run, "# Notes\n\nA line. A PDF file starts with %PDF-1.7 on its first line. Then more.\n");
  await expect(page.locator("#save-status")).toHaveText("Saved");
  await clickMenu(app, "close-tab");
  await expect(page.locator(".ProseMirror")).toHaveCount(0);
  await openFromFinder(app, run.file);
  await expect(page.locator(".ProseMirror p")).toHaveText("A line. A PDF file starts with %PDF-1.7 on its first line. Then more.");
  expect(await app.evaluate(() => (globalThis as unknown as { shown: string[] }).shown)).toEqual([]);
});
