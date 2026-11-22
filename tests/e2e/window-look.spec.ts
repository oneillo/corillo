// What the window shows (roadmap Batch 6, item 2): a polish pass over what
// Batches 1 to 4 put on screen. Corillo's own notices about one open document
// go with its tab; Show changes says so when it can't work out the marks; and
// the small fixes the screens run found, each held by a layout check here.
import { test, expect, type Page } from "@playwright/test";
import { clickMenu, cursorAtEnd, EDITOR, expectFile, openAlso, openText, selectText, tabState, type Running } from "./helpers";
import { AgentSession } from "./agent-session";

const DOC = ".doc:not([hidden])";
const tab = (page: Page, name: string) => page.locator(`.tab[title$="/${name}"]`);
const docId = (page: Page) => page.locator(DOC).getAttribute("data-doc-id");

/** Two boxes on screen, one above the other: how far apart (negative when they overlap). */
async function gapBetween(page: Page, upper: string, lower: string): Promise<number> {
  const [a, b] = await Promise.all([page.locator(upper).boundingBox(), page.locator(lower).boundingBox()]);
  return b!.y - (a!.y + a!.height);
}

/** How far apart two boxes are, whichever is above (negative when they overlap). */
async function apart(page: Page, one: string, other: string): Promise<number> {
  return Math.max(await gapBetween(page, one, other), await gapBetween(page, other, one));
}

let run: Running | null = null;
const sessions: AgentSession[] = [];
test.afterEach(async () => {
  for (const s of sessions.splice(0)) await s.stop().catch(() => undefined);
  await run?.app.close().catch(() => undefined);
  run = null;
});

const PANEL = `${DOC} aside.comments-panel`;

/** Leave a comment as the person, on these words. */
async function comment(page: Page, words: string, body: string): Promise<void> {
  await selectText(page, words);
  await page.getByRole("button", { name: "Comment", exact: true }).click();
  await page.getByRole("textbox", { name: "New comment" }).fill(body);
  await page.getByRole("button", { name: "Post" }).click();
  await expect(page.locator(`${PANEL} .comment-card:not(.draft)`, { hasText: body })).toBeVisible();
}

/** Three comments, and Claude's pass: a reply on each and a change no comment asked for. Claude, unless told to stop, then waits for the review. */
async function backFromClaude(r: Running, wait = true): Promise<AgentSession> {
  await comment(r.page, "two people", "Make it three.");
  await comment(r.page, "tight", "Say by how much.");
  await comment(r.page, "Risks", "Add one about money.");
  const { session } = await AgentSession.start(r.dataDir, "claude-code");
  sessions.push(session);
  const taken = await session.ok("take_document", { path: r.file });
  for (const [, id] of taken.matchAll(/\[([0-9a-f]+)\] on /g)) await session.ok("reply_to_comment", { path: r.file, comment_id: id, text: "Done." });
  await session.ok("edit_document", { path: r.file, edits: [{ find: "Nobody answers", replace: "Nobody ever answers" }] });
  await session.ok("finish_editing", { path: r.file });
  if (wait) session.waitForReview();
  return session;
}

const PLAN = "# Plan\n\nWe should hire two people this quarter.\n\nThe budget is tight.\n\n## Risks\n\nNobody answers the phone.\n";

/** What sticks out of the status bar, and which of its words are cut short. */
function statusBar(page: Page) {
  return page.locator(".status-bar").evaluate((b) => {
    const outer = b.getBoundingClientRect();
    const out = [...b.querySelectorAll<HTMLElement>("*")].filter((c) => {
      const r = c.getBoundingClientRect();
      return r.width > 0 && (r.left < outer.left - 0.5 || r.right > outer.right + 0.5);
    });
    const cut = (el: HTMLElement) => el.scrollWidth > el.clientWidth;
    const turn = b.querySelector<HTMLElement>("#turn-status")!.getBoundingClientRect();
    const read = b.querySelector<HTMLElement>(".turn-read");
    return {
      out: out.map((c) => c.id || c.className),
      saved: { text: b.querySelector("#save-status")!.textContent, cut: cut(b.querySelector<HTMLElement>("#save-status")!) },
      read: read ? { text: read.textContent, inside: read.getBoundingClientRect().right <= turn.right + 0.5 && !cut(read) } : null,
    };
  });
}

test("a notice from Corillo about one open document goes with its tab: not over another in front, there again on coming back, gone with the tab; the window's own sit under it", async () => {
  run = await openText("# Plan\n\nSee [the budget](budget.md).\n", { name: "plan.md" });
  const { app, page } = run;
  const planId = await docId(page);
  await openAlso(run, "notes.md", "# Notes\n\nA short note.\n");
  await expect.poll(async () => (await tabState(page)).active).toBe("notes.md");

  // A link plan.md doesn't have, refused while notes.md is in front: said on plan.md's tab, not over notes.md.
  await page.evaluate((id) => window.corillo.openLink("secret.md", id!), planId);
  await expect(page.locator(".file-notice", { hasText: "Corillo can't open this link." })).toHaveCount(1);
  await expect(page.locator(".file-notice:visible")).toHaveCount(0);

  // Back on plan.md, it's there, under the page, above the status bar, the window's width (roadmap Batch 11, F-17).
  await tab(page, "plan.md").click();
  const planNotice = `${DOC} .file-notice`;
  await expect(page.locator(planNotice)).toBeVisible();
  await expect(page.locator(planNotice)).toContainText("It opens only links saved in the document");
  const box = (await page.locator(planNotice).boundingBox())!;
  const view = await page.evaluate(() => ({ width: innerWidth, height: innerHeight }));
  expect(box.y + box.height).toBeGreaterThan(view.height - 100);
  expect([box.x, box.width]).toEqual([0, view.width]);

  // Its export notice too (Copy for Email): the two stack, neither over the other, with the same edges.
  await clickMenu(app, "copy-email");
  await expect(page.locator(`${DOC} .export-notice`)).toBeVisible();
  expect(await apart(page, `${DOC} .export-notice`, planNotice)).toBeGreaterThanOrEqual(0);
  const email = (await page.locator(`${DOC} .export-notice`).boundingBox())!;
  expect([email.x, email.width]).toEqual([0, view.width]);

  // One of the window's own (agents' tools updated, say) sits under the tab's, above the status bar, not on top of them.
  await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].webContents.send("app:notice", "Corillo has moved.", "Start a new session."));
  const windowNotice = "body > .window-notices .file-notice";
  await expect(page.locator(windowNotice)).toBeVisible();
  for (const own of [`${DOC} .export-notice`, planNotice]) expect(await gapBetween(page, own, windowNotice)).toBeGreaterThanOrEqual(0);
  expect(await gapBetween(page, windowNotice, ".status-bar")).toBe(0);

  // Closing plan.md takes its notices with it; the window's stays, just above the status bar.
  await clickMenu(app, "close-tab");
  await expect.poll(async () => (await tabState(page)).names).toEqual(["notes.md"]);
  await expect(page.locator(".file-notice", { hasText: "Corillo can't open this link." })).toHaveCount(0);
  await expect(page.locator(windowNotice)).toBeVisible();
  const alone = (await page.locator(windowNotice).boundingBox())!;
  expect(view.height - (alone.y + alone.height)).toBeLessThan(48);
});

test("a notice about a document that isn't open, or whose tab has closed, is the window's", async () => {
  run = await openText("# Plan\n", { name: "plan.md" });
  const { app, page } = run;
  await app.evaluate(({ BrowserWindow }) =>
    BrowserWindow.getAllWindows()[0].webContents.send("app:notice", "Corillo couldn't update what it keeps beside gone.md.", "The document itself isn't affected.", "no-such-tab"),
  );
  await expect(page.locator("body > .window-notices .file-notice")).toContainText("Corillo couldn't update what it keeps beside gone.md.");
  await expect(page.locator(`${DOC} .file-notice`)).toHaveCount(0);
});

// Show changes (B3-R09) ----------------------------------------------------------------

test("Show changes that can't work out the marks says so in plain words, on the tab, and leaves the page as it was (B3-R09)", async () => {
  run = await openText("# Plan\n\nHire three people.\n", { name: "plan.md" });
  const { app, page } = run;
  // The smallest honest way to make it fail: the history answers with what came since the
  // hand-over in a shape the marks can't be worked out from (as a damaged history might).
  await app.evaluate(({ ipcMain }) => {
    ipcMain.removeHandler("history:since");
    const at = new Date().toISOString();
    ipcMain.handle("history:since", () => ({ n: 2, saved: at, text: "# Plan\n\nHire three people.\n", at, base: "# Plan\n\nHire two people.\n", steps: null, agents: ["Claude"], outside: false }));
  });
  await clickMenu(app, "view-changes");
  const notice = page.locator(`${DOC} .file-notice`);
  await expect(notice).toBeVisible();
  await expect(notice).toContainText("Corillo couldn't show the changes.");
  await expect(notice).toContainText("Your document is fine, and History has every version.");
  // The page as it was: the document, ready to edit, not an empty page; no banner.
  await expect(page.locator(DOC)).not.toHaveClass(/viewing-version/);
  await expect(page.locator(`${DOC} .version-banner`)).toBeHidden();
  await expect(page.locator(EDITOR)).toBeVisible();
  await expect(page.locator(EDITOR)).toContainText("Hire three people.");
  await cursorAtEnd(page, "Hire three people.");
  await page.keyboard.type(" Soon.");
  await expectFile(run, "# Plan\n\nHire three people. Soon.\n");
});

// Review of Batch 6, B6-R09: Show changes asked for just before a version is picked in History, then failing as
// it draws, left that version's banner over a page half drawn with the text now. The version is shown again whole.
test("Show changes that fails as it draws, over a version picked in History, leaves that version on screen whole (B6-R09)", async () => {
  run = await openText("# Plan\n\nOriginal text.\n", { name: "plan.md" });
  const { app, page } = run;
  await cursorAtEnd(page, "Original text.");
  await page.keyboard.type(" Second.");
  await expectFile(run, "# Plan\n\nOriginal text. Second.\n");
  await page.getByRole("button", { name: "History", exact: true }).click();
  const item = (who: string) => page.locator(`${DOC} .history-panel .history-item`).filter({ has: page.locator(".history-who", { hasText: who }) });
  await expect(item("First version")).toBeVisible();
  // History's list is slow to come for a moment, so a version can be picked while Show changes gets ready; what came
  // since the hand-over is a new paragraph, so drawing it puts a new paragraph on the page.
  await app.evaluate(({ ipcMain }) => {
    const handlers = (ipcMain as unknown as { _invokeHandlers: Map<string, (...a: unknown[]) => unknown> })._invokeHandlers;
    const real = handlers.get("history:list")!;
    const g = globalThis as unknown as { letGo: () => void };
    const held = new Promise<void>((resolve) => (g.letGo = resolve));
    handlers.set("history:list", async (...args: unknown[]) => {
      await held;
      return real(...args);
    });
    ipcMain.removeHandler("history:since");
    const at = new Date().toISOString();
    ipcMain.handle("history:since", () => ({ n: 2, saved: at, text: "# Plan\n\nOriginal text. Second.\n\nA new paragraph.\n", at, base: null, steps: [], agents: ["Claude"], outside: false }));
  });
  await page.locator("#toolbar").getByRole("button", { name: "Show changes" }).click();
  await item("First version").click();
  const VERSION = `${DOC} .version-view .ProseMirror`;
  await expect(page.locator(`${DOC} .version-banner`)).toContainText("Version from");
  await expect(page.locator(`${VERSION} p`)).toHaveText(["Original text."]);
  // Drawing fails once, as it puts the new paragraph on the page.
  await page.evaluate(() => {
    const w = window as unknown as { failOnce: boolean };
    w.failOnce = true;
    for (const name of ["insertBefore", "appendChild"] as const) {
      const real = Node.prototype[name] as (...a: unknown[]) => Node;
      (Node.prototype as unknown as Record<string, unknown>)[name] = function (this: Node, ...args: unknown[]) {
        const child = args[0] as Node;
        if (w.failOnce && (this as Element).closest?.(".version-page") && child.textContent?.includes("A new paragraph")) {
          w.failOnce = false;
          throw new Error("drawing failed (test)");
        }
        return real.apply(this, args);
      };
    }
  });
  await app.evaluate(() => (globalThis as unknown as { letGo: () => void }).letGo());
  await expect(page.locator(`${DOC} .file-notice`)).toContainText("Corillo couldn't show the changes.");
  expect(await page.evaluate(() => (window as unknown as { failOnce: boolean }).failOnce)).toBe(false);
  // The version picked, whole, under its own banner: not the text now, half drawn.
  await expect(page.locator(`${DOC} .version-banner`)).toContainText("Version from");
  await expect(item("First version")).toHaveAttribute("aria-current", "true");
  await expect(page.locator(`${VERSION} p`)).toHaveText(["Original text."]);
  await expect(page.locator(`${VERSION} h1`)).toHaveText(["Plan"]);
  await page.getByRole("button", { name: "Back to current" }).click();
  await expect(page.locator(EDITOR)).toContainText("Original text. Second.");
});

// What the screens run found ----------------------------------------------------------------

test("in the narrowest window the status bar keeps Saved, what's left to read and the agent's words whole: Copy path gives way (review of Batch 24, R24-4)", async () => {
  run = await openText(PLAN.replace("The budget is tight.", "The budget is tight. " + "We have looked at every line of it twice. ".repeat(120)), { name: "plan.md" });
  const { page } = run;
  await backFromClaude(run);
  await expect(page.locator("#turn-status .turn-text")).toHaveText("Claude is waiting for your review · 3 to read");
  await page.setViewportSize({ width: 560, height: 700 });
  await expect.poll(() => statusBar(page)).toEqual({ out: [], saved: { text: "Saved", cut: false }, read: { text: " · 3 to read", inside: true } });
  // Copy path is what gave way (it is in the File menu), so the agent's words are whole too; all of them are in the tooltip.
  // Before R24-4 the agent's words were cut here ("Claude is waiting for yo…") and Copy path stayed.
  await expect(page.locator("#copy-path")).toBeHidden();
  expect(await page.locator(".turn-who").evaluate((w) => w.scrollWidth > w.clientWidth + 0.5)).toBe(false);
  await expect(page.locator("#turn-status")).toHaveAttribute("title", /Claude is waiting for your review\. 3 to read/);
});

test("the start screen says in full where a recent document stands, on a second line if need be", async () => {
  run = await openText(PLAN, { name: "plan.md" });
  const { app, page } = run;
  const claude = await backFromClaude(run, false);
  // A note too, for words long enough to need a second line. (Until roadmap Batch 9, item 5, the
  // changes no comment asked for were counted instead: "3 comments and other changes".)
  await claude.ok("take_document", { path: run.file });
  await claude.ok("finish_editing", { path: run.file, note: "Read the risks first." });
  await clickMenu(app, "close-tab");
  const state = page.locator("#recent .recent-state");
  await expect(state).toHaveText("3 comments and a note waiting for you");
  const fit = await state.evaluate((el) => ({
    whole: el.scrollWidth <= el.clientWidth && el.scrollHeight <= el.clientHeight + 1,
    lines: Math.round(el.clientHeight / parseFloat(getComputedStyle(el).lineHeight)),
  }));
  expect(fit).toEqual({ whole: true, lines: 2 });
});

test("the outline shows a long heading on two lines rather than cutting it to a few words", async () => {
  run = await openText("# A shared help desk for the volunteer team\n\nRequests reach us through four inboxes.\n\n## Where we are today\n\nWe answered 1,840 requests.\n", { name: "plan.md" });
  const { app, page } = run;
  await page.setViewportSize({ width: 1200, height: 700 });
  await clickMenu(app, "view-outline");
  const words = page.locator(`${DOC} .outline-row`).first().locator(".outline-words");
  await expect(words).toHaveText("A shared help desk for the volunteer team");
  const fit = await words.evaluate((el) => ({
    whole: el.scrollWidth <= el.clientWidth && el.scrollHeight <= el.clientHeight + 1,
    lines: Math.round(el.clientHeight / parseFloat(getComputedStyle(el).lineHeight)),
  }));
  expect(fit).toEqual({ whole: true, lines: 2 });
  // Its row is tall enough for both lines: the next heading starts below them, not over the second.
  const rows = await page.locator(`${DOC} .outline-row`).evaluateAll((els) =>
    els.map((el) => ({ row: el.getBoundingClientRect(), words: el.querySelector(".outline-words")!.getBoundingClientRect() })),
  );
  expect(rows[0].words.bottom).toBeLessThanOrEqual(rows[0].row.bottom + 0.5);
  expect(rows[1].row.top).toBeGreaterThanOrEqual(rows[0].words.bottom - 0.5);
});

const LONG = ["# Volunteer plan", ...["Budget", "Hiring", "Training", "Risks", "Next steps"].flatMap((h) => [`## ${h}`, ...Array.from({ length: 6 }, (_, i) => `${h} paragraph ${i + 1}. ${"Some words about it, one after another. ".repeat(6)}`)])].join("\n\n") + "\n";

test("while Show changes is on, the outline keeps marking the section you were reading, not one the dimmed page happens to land on", async () => {
  run = await openText(LONG, { name: "plan.md" });
  const { app, page } = run;
  await page.setViewportSize({ width: 1200, height: 700 });
  await clickMenu(app, "view-outline");
  const marked = page.locator(`${DOC} .outline-row.in-sight .outline-words`);
  // Read down to Risks.
  await page.evaluate((doc) => {
    const h = [...document.querySelectorAll<HTMLElement>(`${doc} .page.editor h2`)].find((e) => e.textContent === "Risks")!;
    const s = h.closest<HTMLElement>(".canvas")!;
    s.scrollTop += h.getBoundingClientRect().top - s.getBoundingClientRect().top - 24;
  }, DOC);
  await expect(marked).toHaveText("Risks");
  await clickMenu(app, "view-changes");
  await expect(page.locator(`${DOC} .version-banner`)).toBeVisible();
  await page.waitForTimeout(300);
  await expect(marked).toHaveText("Risks");
  await clickMenu(app, "view-changes");
  await expect(page.locator(`${DOC} .version-banner`)).toBeHidden();
  await expect(marked).toHaveText("Risks");
});
