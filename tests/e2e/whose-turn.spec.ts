// Whose turn it is, without extra clicks (Orlando, 2026-11-09: the done line's
// cross was "a wasted click to do after every revision"; he agreed to the
// lead's version of his idea):
// - the line when an agent is done is short, has nothing to close, and clears
//   itself once he starts working (typing in either view, posting, replying,
//   resolving, reopening), not while he only reads; the page doesn't jump;
// - the status bar always says whose turn it is once an agent has worked on
//   the document: "With you", or "Claude is editing" in its colour;
// - the lines and banners about the document span the page only, not the
//   Comments or History column, and fit a narrow window.
import { test, expect, type Page } from "@playwright/test";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ONE_SCALE, openText, openAlso, selectText, settle, clickMenu, cursorAtEnd, turnSaid, EDITOR, type Running, launch } from "./helpers";
import { AgentSession } from "./agent-session";

const DOC = ".doc:not([hidden])";
const LINE = `${DOC} .pass-notice`;
const EDITING = `${DOC} .agent-notice`;
const PANEL = `${DOC} .comments-panel`;
const TURN = "#turn-status";

const PLAN = "# Plan\n\nWe should hire two people this quarter.\n\nThe budget is tight.\n\nWe meet on Friday.\n";
const LONG = `# Notes\n\n${Array.from({ length: 80 }, (_, i) => `Paragraph ${i + 1}: a line of notes that runs on for a while, so the page has some length to it.`).join("\n\n")}\n`;

const card = (page: Page, body: string) => page.locator(`${PANEL} .comment-card`).filter({ hasText: body });

/** Leave a comment as the person: on these words, or on the whole document with none. */
async function comment(run: Running, words: string | null, body: string): Promise<void> {
  if (words) await selectText(run.page, words);
  else {
    await run.page.locator(`${EDITOR} h1`).click();
    await settle(run.page);
  }
  await run.page.getByRole("button", { name: "Comment", exact: true }).click();
  await run.page.getByRole("textbox", { name: "New comment" }).fill(body);
  await run.page.getByRole("button", { name: "Post" }).click();
  await expect(card(run.page, body)).toBeVisible();
}

/** The ids take_document shows, by the words each comment is on ("" for the whole document). */
function idsIn(text: string): Map<string, string> {
  const ids = new Map<string, string>();
  for (const m of text.matchAll(/\[([^\]]+)\] on "([^"]+)"/g)) ids.set(m[2], m[1]);
  for (const m of text.matchAll(/\[([^\]]+)\] on the whole document/g)) ids.set("", m[1]);
  return ids;
}

/** One pass: a reply on every comment waiting for the agent, and these edits (tied to no comment). */
async function pass(agent: AgentSession, run: Running, edits: { find: string; replace: string }[] = []): Promise<void> {
  const ids = idsIn(await agent.ok("take_document", { path: run.file }));
  if (edits.length) await agent.ok("edit_document", { path: run.file, edits });
  for (const id of ids.values()) await agent.ok("reply_to_comment", { path: run.file, comment_id: id, text: "Done." });
  const first = await agent.call("finish_editing", { path: run.file });
  if (first.isError) await agent.ok("finish_editing", { path: run.file });
  await expect(run.page.locator(EDITING)).toBeHidden();
}

/** The line's words: who is done, and what's left to read. */
async function lineWords(page: Page): Promise<string> {
  return ((await page.locator(LINE).textContent()) ?? "").trim();
}

/** Where this element's top is on screen, in whole pixels. */
const topOf = (page: Page, selector: string) => page.locator(selector).first().evaluate((e) => Math.round(e.getBoundingClientRect().top * 100) / 100);

/** Quit and start Corillo again on the same document and data folder. */
async function relaunch(run: Running): Promise<Running> {
  await run.app.close();
  const { app, thrown } = await launch({
    args: [ONE_SCALE, ".", run.file],
    env: { ...process.env, CORILLO_USER_DATA: run.dataDir, CORILLO_HIDDEN: "1", CORILLO_HOME: mkdtempSync(join(tmpdir(), "corillo-home-")) },
  });
  const page = await app.firstWindow();
  await page.waitForSelector(".ProseMirror");
  return { ...run, app, page, thrown };
}

/** Each box's left and right edges, rounded. */
async function edges(page: Page, selector: string): Promise<{ left: number; right: number; top: number; bottom: number }> {
  const r = await page.locator(selector).first().evaluate((e) => {
    const b = e.getBoundingClientRect();
    return { left: b.left, right: b.right, top: b.top, bottom: b.bottom };
  });
  return { left: Math.round(r.left), right: Math.round(r.right), top: Math.round(r.top), bottom: Math.round(r.bottom) };
}

test("the line when an agent is done is short, stays while you only read, and clears itself once you start working", async () => {
  const run = await openText(PLAN, { name: "plan.md" });
  const { page } = run;
  await comment(run, "two people", "Make it three.");
  await comment(run, "tight", "Say by how much.");
  const { session: claude } = await AgentSession.start(run.dataDir, "claude-code");
  try {
    await pass(claude, run, [{ find: "Friday", replace: "Thursday" }]);
    await expect(page.locator(LINE)).toBeVisible();
    // The edit no comment asked for has no card (roadmap Batch 9, item 5): the line offers to show it.
    expect(await lineWords(page)).toBe("Claude is done. Back to you.2 comments to read.Show changes");
    await expect(page.locator(`${LINE} .pass-notice-lead`)).toHaveText("Claude is done. Back to you.");
    await expect(page.locator(`${LINE} .pass-notice-detail`)).toHaveText("2 comments to read.");
    await expect(page.locator(LINE)).toHaveAttribute("title", "Claude is done. Back to you. 2 comments to read. Show changes.");
    // Nothing to close: its one button shows the changes.
    await expect(page.locator(LINE).getByRole("button")).toHaveText(["Show changes"]);

    // Reading leaves it: clicking cards, Next Comment, scrolling, clicking and
    // moving round the page, selecting words, Escape, showing History and back.
    await card(page, "Make it three.").click();
    await card(page, "Say by how much.").locator(".comment-body").first().click();
    await clickMenu(run.app, "review-next");
    await page.locator(`${DOC} .canvas`).first().hover();
    await page.mouse.wheel(0, 200);
    await page.locator(`${EDITOR} p`, { hasText: "budget" }).click();
    await settle(page);
    await page.keyboard.press("ArrowRight");
    await page.keyboard.press("Shift+ArrowRight");
    await page.keyboard.press("Escape");
    await selectText(page, "two people");
    await clickMenu(run.app, "view-history");
    await clickMenu(run.app, "view-history");
    await page.waitForTimeout(400);
    await expect(page.locator(LINE)).toBeVisible();
    await expect(page.locator(TURN)).toHaveText("With you");

    // Typing in the document is working: the line goes; the status bar still says it's with you.
    await page.locator(`${EDITOR} p`, { hasText: "budget" }).click();
    await settle(page);
    await page.keyboard.press("End");
    await page.keyboard.type(" Really.");
    await expect(page.locator(LINE)).toBeHidden();
    await expect(page.locator(TURN)).toHaveText("With you");

    // Replying is working.
    await pass(claude, run, [{ find: "We should", replace: "We must" }]);
    await expect(page.locator(LINE)).toBeVisible();
    const reply = card(page, "Make it three.").getByRole("textbox", { name: "Reply" });
    await card(page, "Make it three.").click();
    await reply.fill("And say by when.");
    await expect(page.locator(LINE)).toBeVisible(); // typing a reply isn't sending it
    await reply.press("Meta+Enter");
    await expect(card(page, "Make it three.")).toHaveAttribute("aria-label", turnSaid("For Claude, not sent yet"));
    await expect(page.locator(LINE)).toBeHidden();

    // Posting a new comment is working.
    await pass(claude, run);
    await expect(page.locator(LINE)).toBeVisible();
    await comment(run, "meet", "Which room?");
    await expect(page.locator(LINE)).toBeHidden();

    // Resolving from the Review menu is working.
    await pass(claude, run);
    await expect(page.locator(LINE)).toBeVisible();
    await card(page, "Which room?").click();
    await clickMenu(run.app, "review-resolve");
    await expect(card(page, "Which room?")).toHaveCount(0);
    await expect(page.locator(LINE)).toBeHidden();

    // Reopening a resolved comment is working; showing the resolved ones isn't.
    await pass(claude, run, [{ find: "# Plan", replace: "# Hiring plan" }]);
    await expect(page.locator(LINE)).toBeVisible();
    await page.locator(`${PANEL} .comments-show-resolved`).click();
    await expect(page.locator(LINE)).toBeVisible();
    await page.locator(`${PANEL} .comment-card.resolved`, { hasText: "Which room?" }).getByRole("button", { name: "Reopen" }).click();
    await expect(page.locator(LINE)).toBeHidden();

    // Typing in the Markdown view is working too.
    await clickMenu(run.app, "view-markdown");
    await pass(claude, run, [{ find: "quarter", replace: "season" }]);
    await expect(page.locator(LINE)).toBeVisible();
    await page.locator(`${DOC} textarea.source`).click();
    await settle(page);
    await expect(page.locator(LINE)).toBeVisible(); // a click is only reading
    await page.keyboard.type("x");
    await expect(page.locator(LINE)).toBeHidden();
  } finally {
    await run.app.close();
    await claude.stop();
  }
});

test("when the line clears, the words under the cursor stay exactly where they were", async () => {
  const run = await openText(LONG, { name: "notes.md" });
  const { page } = run;
  const canvas = `${DOC} .canvas.with-side`;
  const para = (n: number) => `${EDITOR} p:nth-of-type(${n})`;
  const { session: claude } = await AgentSession.start(run.dataDir, "claude-code");
  try {
    // At the top of the page: the line fades, and keeps its room, empty, so nothing moves.
    // (The pass's editing line scrolled the page down by its height, to keep the words still: back to the top.)
    await pass(claude, run, [{ find: "Paragraph 1:", replace: "First paragraph:" }]);
    await expect(page.locator(LINE)).toBeVisible();
    await page.locator(canvas).evaluate((c) => (c.scrollTop = 0));
    await cursorAtEnd(page, "Paragraph 2:");
    const before = await topOf(page, para(2));
    await page.keyboard.type(" More.");
    await expect(page.locator(LINE)).toBeHidden();
    await page.waitForTimeout(500);
    expect(await topOf(page, para(2))).toBe(before);
    await expect(page.locator(LINE)).toHaveClass(/spent/);

    // Scrolling the page down gives its room back without moving the words: they stay where the scroll put them.
    const scrolled = await page.evaluate(
      ([sel, p]) => {
        document.querySelector<HTMLElement>(sel)!.scrollTop = 600;
        return document.querySelector(p)!.getBoundingClientRect().top;
      },
      [canvas, para(30)] as const,
    );
    await expect(page.locator(LINE)).toHaveAttribute("hidden", "");
    expect(await topOf(page, para(30))).toBe(Math.round(scrolled * 100) / 100);

    // Further down the page, the room goes as soon as the line has faded, and the words still don't move.
    await pass(claude, run, [{ find: "Paragraph 3:", replace: "Third paragraph:" }]);
    await expect(page.locator(LINE)).toBeVisible();
    await page.locator(para(40)).scrollIntoViewIfNeeded();
    await cursorAtEnd(page, "Paragraph 40:");
    const at = await topOf(page, para(40));
    await page.keyboard.type("!");
    // The cursor's line, just typed on, and again once the room has gone.
    const caret = await page.evaluate(async (line) => {
      const top = () => window.getSelection()!.getRangeAt(0).getBoundingClientRect().top;
      const before = top();
      const el = document.querySelector<HTMLElement>(line)!;
      for (let i = 0; i < 100 && !el.hidden; i++) await new Promise((r) => setTimeout(r, 20));
      return { before, after: top(), gone: el.hidden };
    }, LINE);
    expect(caret.gone).toBe(true);
    expect(caret.after).toBe(caret.before);
    expect(await topOf(page, para(40))).toBe(at);

    // In the Markdown view: the text under the cursor stays put too.
    await clickMenu(run.app, "view-markdown");
    await pass(claude, run, [{ find: "Paragraph 5:", replace: "Fifth paragraph:" }]);
    await expect(page.locator(LINE)).toBeVisible();
    const source = page.locator(`${DOC} textarea.source`);
    await source.click({ position: { x: 80, y: 120 } });
    await settle(page);
    const textTop = () => source.evaluate((t) => Math.round((t.getBoundingClientRect().top - t.scrollTop) * 100) / 100);
    const textBefore = await textTop();
    const scrolledBefore = await source.evaluate((t) => t.scrollTop);
    const room = await page.locator(LINE).evaluate((l) => (l as HTMLElement).offsetHeight);
    await page.keyboard.type("x");
    await expect(page.locator(LINE)).toBeHidden();
    await page.waitForTimeout(500);
    expect(await textTop()).toBe(textBefore);
    // The text moved by exactly the room the line gave back, and the preview's own scroll never pulled it further
    // (review of Batch 11, B11R-4: the two halves were scrolled one by one, and the text sometimes followed the
    // preview 30 to 40 pixels more).
    expect(await source.evaluate((t) => t.scrollTop)).toBe(scrolledBefore - room);
  } finally {
    await run.app.close();
    await claude.stop();
  }
});

// Batch 11, F-4 (N-5, B-8): when "Claude is editing" came up, everything on
// the page dropped 45 pixels, even far down in a long document.
test("when an agent starts editing, and when its line gives way, the words being read stay where they are on screen", async () => {
  const run = await openText(LONG, { name: "notes.md" });
  const { page } = run;
  const para = (n: number) => `${EDITOR} p:nth-of-type(${n})`;
  const { session: claude } = await AgentSession.start(run.dataDir, "claude-code");
  try {
    // At the very top of the page: the title stays where it is, and so does the Comments heading, level with the
    // page's top (review of Batch 11, B11R-8: it dropped 45 pixels below it, with the page still).
    await settle(page);
    const title = await topOf(page, `${EDITOR} h1`);
    const heading = `${PANEL} .comments-top .panel-head`;
    const headingTop = await topOf(page, heading);
    await claude.ok("take_document", { path: run.file });
    await expect(page.locator(EDITING)).toBeVisible();
    expect(await topOf(page, `${EDITOR} h1`)).toBe(title);
    await page.evaluate(() => new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve))));
    expect(await topOf(page, heading)).toBe(headingTop);
    await claude.ok("finish_editing", { path: run.file }); // nothing to tell: its room stays, empty
    await expect(page.locator(EDITING)).toBeHidden();
    expect(await topOf(page, `${EDITOR} h1`)).toBe(title);

    // Reading far down the page.
    await page.locator(para(40)).evaluate((p) => {
      const canvas = p.closest(".canvas")!;
      canvas.scrollTop += p.getBoundingClientRect().top - canvas.getBoundingClientRect().top - 150;
    });
    await settle(page);
    const at = await topOf(page, para(40));
    await claude.ok("take_document", { path: run.file });
    await expect(page.locator(EDITING)).toBeVisible();
    expect(await topOf(page, para(40))).toBe(at);
    await claude.ok("edit_document", { path: run.file, edits: [{ find: "Paragraph 60:", replace: "Sixtieth paragraph:" }] });
    await claude.ok("finish_editing", { path: run.file });
    await expect(page.locator(EDITING)).toBeHidden();
    await expect(page.locator(LINE)).toBeVisible();
    expect(await topOf(page, para(40))).toBe(at);
  } finally {
    await run.app.close();
    await claude.stop();
  }
});

// Review of Batch 11, B11R-4: in the Markdown view, the editing line coming moves both halves; they were
// scrolled one by one, and the text could follow the preview's scroll as if the person had made it.
test("in the Markdown view, when an agent starts editing, the text moves by exactly the line's height and its words stay put", async () => {
  const run = await openText(LONG, { name: "notes.md" });
  const { page } = run;
  const { session: claude } = await AgentSession.start(run.dataDir, "claude-code");
  try {
    await clickMenu(run.app, "view-markdown");
    const source = page.locator(`${DOC} textarea.source`);
    await expect(source).toBeVisible();
    await source.evaluate((t) => (t.scrollTop = 1500));
    await page.waitForTimeout(300); // the preview follows
    const textTop = () => source.evaluate((t) => Math.round((t.getBoundingClientRect().top - t.scrollTop) * 100) / 100);
    const before = { top: await textTop(), scrolled: await source.evaluate((t) => t.scrollTop) };
    await claude.ok("take_document", { path: run.file });
    await expect(page.locator(EDITING)).toBeVisible();
    const height = await page.locator(EDITING).evaluate((l) => (l as HTMLElement).offsetHeight);
    await page.waitForTimeout(300);
    expect(await textTop()).toBe(before.top);
    expect(await source.evaluate((t) => t.scrollTop)).toBe(before.scrolled + height);
  } finally {
    await run.app.close();
    await claude.stop();
  }
});

// Review of Batch 11, F-10 (B-7, D-14): a bar's actions sat at its far end, about 600 pixels from its words at
// 1440 wide, and came in two kinds: 15-pixel words beside 28-pixel buttons.
test("every bar's actions sit right after its words, and are buttons of one kind, at least 20 pixels tall", async () => {
  const run = await openText(PLAN, { name: "plan.md" });
  const { page } = run;
  await run.app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].setContentSize(1440, 900));
  const { session: claude } = await AgentSession.start(run.dataDir, "claude-code");
  const BANNER = `${DOC} .version-banner`;
  const kinds: string[] = [];
  /** The bar's first action starts right after its words, give or take the gap between them. */
  const check = async (bar: string, words: string) => {
    const m = await page.locator(bar).evaluate((b, words) => {
      const end = b.querySelector(words)!.getBoundingClientRect().right;
      const actions = [...b.querySelectorAll("button")].filter((x) => x.getClientRects().length);
      return {
        gap: actions[0].getBoundingClientRect().left - end,
        kinds: actions.map((a) => `${a.getBoundingClientRect().height} ${getComputedStyle(a).borderTopWidth} ${getComputedStyle(a).borderTopStyle}`),
      };
    }, words);
    expect(m.gap, bar).toBeGreaterThanOrEqual(0);
    expect(m.gap, bar).toBeLessThanOrEqual(24);
    kinds.push(...m.kinds);
  };
  try {
    await claude.ok("take_document", { path: run.file, request: "A stronger budget line." });
    await expect(page.locator(EDITING)).toBeVisible();
    await check(EDITING, ".agent-notice-hint");
    await claude.ok("edit_document", { path: run.file, edits: [{ find: "The budget is tight.", replace: "Budget: tight." }] });
    await claude.ok("finish_editing", { path: run.file });
    const see = page.locator(LINE).getByRole("button", { name: "Show changes" });
    await expect(see).toBeVisible();
    await check(LINE, ".pass-notice-detail");
    await see.click();
    await expect(page.locator(BANNER)).toBeVisible();
    await check(BANNER, ".version-banner-text");
    await page.locator(BANNER).getByRole("button", { name: "Hide changes" }).click();
    await page.getByRole("button", { name: "History", exact: true }).click();
    await page.locator(`${DOC} .history-panel .history-item`).nth(1).click();
    await expect(page.locator(BANNER).getByRole("button", { name: "Restore this version" })).toBeVisible();
    await check(BANNER, ".version-banner-text");
    // One kind: the same height, at least 20 pixels, and the same edge.
    expect(new Set(kinds).size, kinds.join(", ")).toBe(1);
    expect(parseFloat(kinds[0])).toBeGreaterThanOrEqual(20);
  } finally {
    await run.app.close();
    await claude.stop();
  }
});

test("Show changes and an earlier version don't keep the faded line's empty room above their banner, and coming back the page is where it was", async () => {
  const run = await openText(PLAN, { name: "plan.md" });
  const { page } = run;
  const { session: claude } = await AgentSession.start(run.dataDir, "claude-code");
  const banner = `${DOC} .version-banner`;
  try {
    await pass(claude, run, [{ find: "two people", replace: "three people" }]);
    await expect(page.locator(LINE)).toBeVisible();
    const lineTop = await topOf(page, LINE);
    // Typing at the top of the page: the line fades, and its room stays, empty.
    await cursorAtEnd(page, "The budget is tight.");
    await page.keyboard.type(" Very.");
    await expect(page.locator(LINE)).toHaveClass(/spent/);
    await page.waitForTimeout(400);
    const paragraphTop = await topOf(page, `${EDITOR} p`);

    for (const open of ["view-changes", "history"] as const) {
      if (open === "view-changes") await clickMenu(run.app, "view-changes");
      else {
        await clickMenu(run.app, "view-history");
        await page.locator(`${DOC} .history-item`).last().click();
      }
      await expect(page.locator(banner)).toBeVisible();
      // The banner is where the line was: no empty band above it.
      expect(await topOf(page, banner)).toBe(lineTop);
      // Scrolling the version doesn't let the room go meanwhile.
      await page.locator(`${DOC} .canvas.version-view`).evaluate((c) => c.scrollBy(0, 200));
      await page.waitForTimeout(100);
      if (open === "view-changes") await clickMenu(run.app, "view-changes");
      else await page.getByRole("button", { name: "Back to current" }).click();
      await expect(page.locator(banner)).toBeHidden();
      // Back to the document: the room is kept as it was, so the words are exactly where they were.
      await expect(page.locator(LINE)).toHaveClass(/spent/);
      expect(await topOf(page, `${EDITOR} p`)).toBe(paragraphTop);
    }
  } finally {
    await run.app.close();
    await claude.stop();
  }
});

test("Take Over: the status bar says it's with you at once, the line says you took over, and typing clears it", async () => {
  const run = await openText(PLAN, { name: "plan.md" });
  const { page } = run;
  const { session: claude } = await AgentSession.start(run.dataDir, "claude-code");
  try {
    await claude.ok("take_document", { path: run.file });
    await claude.ok("edit_document", { path: run.file, edits: [{ find: "two", replace: "three" }] });
    await claude.ok("add_comment", { path: run.file, quote: "budget", text: "How tight is it?" });
    await expect(page.locator(EDITING)).toContainText("Claude is editing");
    await expect(page.locator(TURN)).toHaveText("Claude is editing");
    const top = await topOf(page, `${EDITOR} p`);
    await page.locator(EDITING).getByRole("button", { name: "Take over" }).click();
    await expect(page.locator(EDITING)).toBeHidden();
    // With the count of what's new: the comment Claude started (the edit no comment asked for has no card; roadmap Batch 9, item 5).
    await expect(page.locator(TURN)).toHaveText("With you · 1 to read");
    await expect(page.locator(LINE)).toBeVisible();
    await expect(page.locator(`${LINE} .pass-notice-lead`)).toHaveText("You took over from Claude.");
    expect(await topOf(page, `${EDITOR} p`)).toBe(top);
    await cursorAtEnd(page, "budget");
    await page.keyboard.type(" Mine now.");
    await expect(page.locator(LINE)).toBeHidden();
    await page.waitForTimeout(400);
    expect(await topOf(page, `${EDITOR} p`)).toBe(top);
    await expect(page.locator(TURN)).toHaveText("With you · 1 to read"); // typing reads no card

    // A pass that changes and answers nothing has no line to show: the editing line goes, and the page still doesn't move.
    await claude.ok("take_document", { path: run.file });
    await expect(page.locator(EDITING)).toBeVisible();
    expect(await topOf(page, `${EDITOR} p`)).toBe(top);
    await claude.ok("finish_editing", { path: run.file });
    await expect(page.locator(EDITING)).toBeHidden();
    await expect(page.locator(TURN)).toHaveText("With you · 1 to read"); // nothing new in that pass
    await page.waitForTimeout(400);
    await expect(page.locator(LINE)).toBeHidden();
    expect(await topOf(page, `${EDITOR} p`)).toBe(top);
  } finally {
    await run.app.close();
    await claude.stop();
  }
});

test("the status bar says whose turn it is once an agent has worked on the document, live, and after a relaunch", async () => {
  let run = await openText(PLAN, { name: "plan.md" });
  let claude = (await AgentSession.start(run.dataDir, "claude-code")).session;
  try {
    const { page } = run;
    // No agent has touched it: nothing extra, even once an agent has looked at it.
    await expect(page.locator("#save-status")).toHaveText("Saved");
    await expect(page.locator(TURN)).toBeHidden();
    await claude.ok("open_document", { path: run.file });
    await claude.ok("read_document", { path: run.file });
    await page.waitForTimeout(300);
    await expect(page.locator(TURN)).toBeHidden();

    // An agent editing: its name, with a dot in its colour, the same as its line at the top.
    await claude.ok("take_document", { path: run.file });
    await expect(page.locator(TURN)).toHaveText("Claude is editing");
    await expect(page.locator(`${TURN} .turn-dot`)).toBeVisible();
    const colour = (sel: string) => page.locator(sel).evaluate((e) => getComputedStyle(e).backgroundColor);
    // (Its line at the top has a coquí in that colour since roadmap Batch 9, item 13.)
    expect(await colour(`${TURN} .turn-dot`)).toBe(await page.locator(`${EDITING} .coqui-frog .frog-body`).evaluate((e) => getComputedStyle(e).fill));
    // Beside "Saved", in the bar's quiet words.
    const bar = await page.evaluate(() => {
      const saved = document.getElementById("save-status")!.getBoundingClientRect();
      const turn = document.getElementById("turn-status")!;
      const style = getComputedStyle(turn);
      return { after: turn.getBoundingClientRect().left > saved.right, size: style.fontSize, colour: style.color, savedColour: getComputedStyle(document.getElementById("save-status")!).color };
    });
    expect(bar.after).toBe(true);
    expect(bar.size).toBe("12px");
    expect(bar.colour).toBe(bar.savedColour);

    // Done: back with you, live.
    await claude.ok("edit_document", { path: run.file, edits: [{ find: "two", replace: "three" }] });
    await claude.ok("add_comment", { path: run.file, quote: "budget", text: "How tight is it?" });
    await claude.ok("finish_editing", { path: run.file });
    // With the count of what's new: the comment Claude started (the edit no comment asked for has no card; roadmap Batch 9, item 5).
    await expect(page.locator(TURN)).toHaveText("With you · 1 to read");
    await expect(page.locator(`${TURN} .turn-dot`)).toBeHidden();
    await expect(page.locator(TURN)).toHaveAttribute("title", /your turn/);

    // Another document no agent has touched: nothing there; back on the first, With you again.
    await openAlso(run, "other.md", "# Other\n\nUntouched.\n");
    await expect(page.locator(".tab")).toHaveCount(2);
    await expect(page.locator(`${EDITOR} h1`)).toHaveText("Other");
    await expect(page.locator(TURN)).toBeHidden();
    await page.locator('.tab[title$="/plan.md"]').click();
    await expect(page.locator(TURN)).toHaveText("With you · 1 to read");

    // After a relaunch, with no agent connected: the history says an agent worked on it.
    // What was there when the document opened counts as read.
    await claude.stop();
    run = await relaunch(run);
    await expect(run.page.locator(TURN)).toHaveText("With you");
    claude = (await AgentSession.start(run.dataDir, "claude-code")).session;
    await claude.ok("take_document", { path: run.file });
    await expect(run.page.locator(TURN)).toHaveText("Claude is editing");
    await claude.ok("finish_editing", { path: run.file });
    await expect(run.page.locator(TURN)).toHaveText("With you");
  } finally {
    await run.app.close();
    await claude.stop();
  }
});

test("the lines and banners about the document span the page, not the Comments or History column, and the whole width with it closed", async () => {
  const run = await openText(PLAN, { name: "plan.md" });
  const { page } = run;
  await page.setViewportSize({ width: 1200, height: 800 });
  await comment(run, "two people", "Make it three.");
  const { session: claude } = await AgentSession.start(run.dataDir, "claude-code");
  const toolbarBottom = (await edges(page, ".toolbar")).bottom;
  const panelLeft = async () => (await edges(page, PANEL)).left;
  try {
    // The editing line: across the page, up to the column; the column starts right under the toolbar.
    const ids = idsIn(await claude.ok("take_document", { path: run.file }));
    await expect(page.locator(EDITING)).toBeVisible();
    let line = await edges(page, EDITING);
    expect(line.left).toBe(0);
    expect(line.right).toBe(await panelLeft());
    expect(line.top).toBe(toolbarBottom);
    expect((await edges(page, PANEL)).top).toBe(toolbarBottom);
    // The page starts under it.
    expect((await edges(page, `${DOC} .canvas.with-side`)).top).toBe(line.bottom);

    // The line when it's done: the same place.
    await claude.ok("reply_to_comment", { path: run.file, comment_id: ids.get("two people"), text: "Now three." });
    await claude.ok("finish_editing", { path: run.file });
    await expect(page.locator(LINE)).toBeVisible();
    line = await edges(page, LINE);
    expect([line.left, line.right, line.top]).toEqual([0, await panelLeft(), toolbarBottom]);

    // With the column closed, the whole width.
    await clickMenu(run.app, "view-comments");
    await expect(page.locator(PANEL)).toBeHidden();
    line = await edges(page, LINE);
    expect([line.left, line.right]).toEqual([0, 1200]);
    await clickMenu(run.app, "view-comments");
    await expect(page.locator(PANEL)).toBeVisible();

    // A change made outside Corillo while you had edits: the warm banner, across the page only.
    await cursorAtEnd(page, "tight");
    await page.keyboard.type(" Mine.");
    writeFileSync(run.file, PLAN.replace("tight.", "tight. Theirs."));
    const conflict = `${DOC} .banner.conflict`;
    await expect(page.locator(conflict)).toBeVisible();
    const banner = await edges(page, conflict);
    expect([banner.left, banner.right]).toEqual([0, await panelLeft()]);
    await page.getByRole("button", { name: "Keep my version" }).click();
    await expect(page.locator(conflict)).toBeHidden();

    // An older version from History: its banner across the page, up to History.
    await clickMenu(run.app, "view-history");
    const history = `${DOC} .history-panel`;
    await expect(page.locator(history)).toBeVisible();
    expect((await edges(page, history)).top).toBe(toolbarBottom);
    await page.locator(`${history} .history-item`).last().click();
    const versionBanner = `${DOC} .version-banner`;
    await expect(page.locator(versionBanner)).toBeVisible();
    const vb = await edges(page, versionBanner);
    expect([vb.left, vb.right]).toEqual([0, (await edges(page, history)).left]);
    await page.getByRole("button", { name: "Back to current" }).click();
    await clickMenu(run.app, "view-history");

    // Show changes keeps the comments (roadmap Batch 3, item 1): its banner spans the page, up to them.
    await clickMenu(run.app, "view-changes");
    await expect(page.locator(versionBanner)).toBeVisible();
    await expect(page.locator(PANEL)).toBeVisible();
    const sc = await edges(page, versionBanner);
    expect([sc.left, sc.right]).toEqual([0, await panelLeft()]);
    await clickMenu(run.app, "view-changes");
    await expect(page.locator(versionBanner)).toBeHidden();

    // The export notice: under the page and the column, the window's width, never over either (roadmap
    // Batch 11, F-17); the same without the column.
    await run.app.evaluate(({ dialog }, chosen) => {
      dialog.showSaveDialog = (async () => ({ canceled: false, filePath: chosen })) as typeof dialog.showSaveDialog;
    }, join(run.folder, "plan.pdf"));
    await clickMenu(run.app, "export-pdf");
    const notice = ".export-notice[data-state='done']";
    await expect(page.locator(notice)).toBeVisible({ timeout: 30_000 });
    let n = await edges(page, notice);
    expect([n.left, n.right, n.top]).toEqual([0, 1200, (await edges(page, PANEL)).bottom]);
    expect(n.top).toBe((await edges(page, `${DOC} .doc-main`)).bottom);
    await clickMenu(run.app, "view-comments");
    await expect(page.locator(PANEL)).toBeHidden();
    n = await edges(page, notice);
    expect([n.left, n.right, n.top]).toEqual([0, 1200, (await edges(page, `${DOC} .doc-main`)).bottom]);
  } finally {
    await run.app.close();
    await claude.stop();
  }
});

// Review of Batch 11, B11R-3: in both views, with the Comments panel shown.
for (const view of ["Formatted", "Markdown"] as const) {
  test(`in the narrowest window, each line stays on one line, with all its words in the tooltip, and banners put their buttons under the words (${view} view)`, async () => {
    const run = await openText(PLAN, { name: "plan.md" });
    const { page } = run;
    await page.setViewportSize({ width: 560, height: 700 });
    await comment(run, "two people", "Make it three.");
    await comment(run, "tight", "Say by how much.");
    await comment(run, "Friday", "Which Friday?");
    const { session: claude } = await AgentSession.start(run.dataDir, "claude-code");
    /** Nothing inside sticks out of the box, and the box doesn't scroll sideways. */
    const fits = (sel: string) =>
      page.locator(sel).evaluate((box) => {
        const outer = box.getBoundingClientRect();
        const out = [...box.querySelectorAll("*")].filter((c) => {
          const r = c.getBoundingClientRect();
          return r.width > 0 && (r.left < outer.left - 0.5 || r.right > outer.right + 0.5 || r.top < outer.top - 0.5 || r.bottom > outer.bottom + 0.5);
        });
        return { out: out.map((c) => c.className), wide: box.scrollWidth > box.clientWidth };
      });
    try {
      await expect(page.locator(PANEL)).toBeVisible();
      if (view === "Markdown") await clickMenu(run.app, "view-markdown");
      await expect.poll(async () => (await edges(page, `${DOC} .doc-main`)).right).toBeLessThan(330);

      // Editing: one line, 45 pixels, the name and Take over in full.
      await claude.ok("take_document", { path: run.file });
      await expect(page.locator(EDITING)).toBeVisible();
      expect((await edges(page, EDITING)).bottom - (await edges(page, EDITING)).top).toBe(45);
      expect(await fits(EDITING)).toEqual({ out: [], wide: false });
      await expect(page.locator(`${EDITING} .agent-notice-text`)).toHaveText("Claude is editing");
      expect(await page.locator(`${EDITING} .agent-notice-text`).evaluate((e) => e.scrollWidth <= e.clientWidth)).toBe(true);
      await expect(page.locator(EDITING).getByRole("button", { name: "Take over" })).toBeVisible();
      await expect(page.locator(EDITING)).toHaveAttribute("title", "Claude is editing. You can read and comment meanwhile.");

      // Done: one line, 45 pixels; who is done in full, all of it in the tooltip. What's left to read is left out
      // rather than cut to "3…" (review of Batch 11, F-23): the Comments panel beside it counts the same.
      const ids = idsIn(await claude.ok("list_comments", { path: run.file }));
      for (const id of ids.values()) await claude.ok("reply_to_comment", { path: run.file, comment_id: id, text: "Done." });
      await claude.ok("finish_editing", { path: run.file });
      await expect(page.locator(LINE)).toBeVisible();
      expect((await edges(page, LINE)).bottom - (await edges(page, LINE)).top).toBe(45);
      expect(await fits(LINE)).toEqual({ out: [], wide: false });
      const lead = page.locator(`${LINE} .pass-notice-lead`);
      expect(await lead.evaluate((e) => e.scrollWidth <= e.clientWidth)).toBe(true);
      const detail = page.locator(`${LINE} .pass-notice-detail`);
      expect(await detail.evaluate((e) => e.getClientRects().length)).toBe(0);
      await expect(page.locator(LINE)).toHaveAttribute("title", "Claude is done. Back to you. 3 comments to read.");

      // The status bar still fits, with whose turn it is and what's left to read, in full.
      await expect(page.locator(TURN)).toHaveText("With you · 3 to read");
      expect(await fits(".status-bar")).toEqual({ out: [], wide: false });
      expect(await page.locator(`${TURN} .turn-text`).evaluate((e) => e.scrollWidth <= e.clientWidth)).toBe(true);

      // A warm banner: its words keep their width, and the buttons go under them, inside the banner.
      if (view === "Formatted") await cursorAtEnd(page, "tight");
      else {
        await page.locator(`${DOC} .source`).evaluate((text: HTMLTextAreaElement) => {
          const at = text.value.indexOf("tight") + "tight".length;
          text.focus();
          text.setSelectionRange(at, at);
        });
      }
      await page.keyboard.type(" Mine.");
      writeFileSync(run.file, PLAN.replace("tight.", "tight. Theirs."));
      const conflict = `${DOC} .banner.conflict`;
      await expect(page.locator(conflict)).toBeVisible();
      expect(await fits(conflict)).toEqual({ out: [], wide: false });
      const words = await edges(page, `${conflict} > span`);
      const keep = await edges(page, `${conflict} .keep-mine`);
      expect(keep.top).toBeGreaterThanOrEqual(words.bottom);
      expect(words.right - words.left).toBeGreaterThan(240);
      await page.getByRole("button", { name: "Keep my version" }).click();
    } finally {
      await run.app.close();
      await claude.stop();
    }
  });
}
