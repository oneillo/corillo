// The side panels, seen fresh (roadmap Batch 11, item 3: the Comments panel, History's heading and the
// outline). Each finding's id is in its test's comment; the findings came from a fresh look at the panels.
import { expect, test, type Page } from "@playwright/test";
import { AgentSession } from "./agent-session";
import { EDITOR, clickMenu, openText, selectText, type Running } from "./helpers";
import { tidyRuns } from "./tidy";

const tidy = tidyRuns();
const sessions: AgentSession[] = [];
test.afterEach(async () => {
  for (const s of sessions.splice(0)) await s.stop().catch(() => undefined);
});

const DOC = ".doc:not([hidden])";
const PANEL = `${DOC} .comments-panel`;
const SEND = `${PANEL} .comments-hand-back`;

/** A plan with a paragraph for each comment. */
const WORDS = ["four inboxes", "two answers", "one shared help desk", "three months", "the summer", "a budget", "the board", "next year"];
const PLAN = `# Volunteer help desk\n\n${WORDS.map((w, i) => `Paragraph ${i + 1} talks about ${w} and nothing else.`).join("\n\n")}\n`;

const card = (page: Page, body: string) => page.locator(`${PANEL} .comment-card:not(.draft)`, { hasText: body });

async function comment(page: Page, words: string, body: string): Promise<void> {
  await selectText(page, words);
  await page.getByRole("button", { name: "Comment", exact: true }).click();
  await page.getByRole("textbox", { name: "New comment" }).fill(body);
  await page.getByRole("button", { name: "Post" }).click();
  await expect(card(page, body)).toBeVisible();
}

async function agent(run: Running): Promise<AgentSession> {
  const { session } = await AgentSession.start(run.dataDir, "claude-code");
  sessions.push(session);
  return session;
}

/** The element is inside the panel's view and nothing covers its middle. */
function inSight(page: Page, selector: string): Promise<boolean> {
  return page.locator(selector).evaluate((b) => {
    const r = b.getBoundingClientRect();
    const p = b.closest("aside")!.getBoundingClientRect();
    const hit = document.elementFromPoint(r.left + r.width / 2, r.top + r.height / 2);
    return r.height > 0 && r.top >= p.top - 0.5 && r.bottom <= p.bottom + 0.5 && !!hit && b.contains(hit);
  });
}

// F-2 (N-1, B-2): at the end of a review the button that hands the document back had scrolled out of sight
// with the cards. The panel's top row now stays in sight while the cards scroll under it.
test("the Comments panel's top row stays in sight while the cards scroll under it, so Send to Claude is there after the last reply", async () => {
  const run = tidy.keep(await openText(PLAN, { name: "plan.md" }));
  const { page } = run;
  await page.setViewportSize({ width: 1280, height: 700 });
  const claude = await agent(run);
  await claude.ok("open_document", { path: run.file });
  const wait = claude.waitForReview();
  await expect(page.locator("#turn-status .turn-text")).toHaveText("Claude is waiting for your review");
  for (const [i, words] of WORDS.entries()) await comment(page, words, `Comment ${i + 1} on ${words}.`);
  await expect(page.locator(SEND)).toBeEnabled();

  // The last card, replied to: the panel has scrolled down to it, and Send is still in sight, uncovered.
  const last = card(page, `Comment ${WORDS.length} on`);
  await last.locator(".comment-body").click();
  await last.getByRole("textbox", { name: "Reply" }).fill("And one more thing.");
  await expect.poll(() => page.locator(PANEL).evaluate((p) => p.scrollTop)).toBeGreaterThan(100);
  expect(await inSight(page, SEND), "Send to Claude, beside the last reply").toBe(true);
  expect(await inSight(page, `${PANEL} .comments-new`), "New comment").toBe(true);
  expect(await inSight(page, `${PANEL} .panel-head h2`), "the heading").toBe(true);
  // The card being replied to isn't hidden under the top row.
  const box = await last.getByRole("textbox", { name: "Reply" }).evaluate((t) => {
    const top = t.closest("aside")!.querySelector(".comments-top")!.getBoundingClientRect().bottom;
    return t.getBoundingClientRect().top - top;
  });
  expect(box, "the reply box is below the top row").toBeGreaterThanOrEqual(0);
  claude.cancel(wait.id);
});

// F-7 (N-2): back from Claude, the status bar said "Claude is waiting for your review" while Send to Claude was
// greyed out, and nothing said why. Now a quiet line under it says, in Corillo's words; no status line on a card.
test("while Claude waits with nothing new to send, Send to Claude is greyed out and a line under it says why and what to do", async () => {
  const run = tidy.keep(await openText(PLAN, { name: "plan.md" }));
  const { page } = run;
  const claude = await agent(run);
  await comment(page, "four inboxes", "Name them.");
  const taken = await claude.ok("take_document", { path: run.file });
  const id = /\[([0-9a-f]+)\] on /.exec(taken)![1];
  await claude.ok("reply_to_comment", { path: run.file, comment_id: id, text: "Help, info, volunteers and events." });
  await claude.ok("finish_editing", { path: run.file });
  const wait = claude.waitForReview();
  await expect(page.locator("#turn-status .turn-text")).toHaveText("Claude is waiting for your review · 1 to read");
  const hint = page.locator(`${PANEL} .comments-hand-back-hint`);
  await expect(page.locator(SEND)).toBeDisabled();
  await expect(hint).toBeVisible();
  await expect(hint).toHaveText("Nothing new to send. Reply or comment first.");
  await expect(page.locator(SEND)).toHaveAccessibleDescription("Nothing new to send. Reply or comment first.");
  // On the panel's top, never on a card.
  expect(await hint.evaluate((h) => !!h.closest(".comments-top") && !h.closest(".comment-card"))).toBe(true);
  // A reply is something to send: the button works, and the line goes.
  await card(page, "Name them.").locator(".comment-body").first().click();
  await card(page, "Name them.").getByRole("textbox", { name: "Reply" }).fill("Thanks. And the chats?");
  await card(page, "Name them.").getByRole("button", { name: "Reply" }).click();
  await expect(page.locator(SEND)).toBeEnabled();
  await expect(hint).toBeHidden();
  claude.cancel(wait.id);
});

/** The panel's buttons drawn filled in the accent colour, by their words. */
function filled(page: Page): Promise<string[]> {
  return page.locator(PANEL).evaluate((panel) => {
    const probe = document.createElement("div");
    probe.style.background = "var(--accent)";
    document.body.append(probe);
    const accent = getComputedStyle(probe).backgroundColor;
    probe.remove();
    return [...panel.querySelectorAll("button")]
      .filter((b) => b.checkVisibility() && getComputedStyle(b).backgroundColor === accent && b.textContent!.trim())
      .map((b) => b.textContent!.trim());
  });
}

// F-20 (D-11): while replying, Copy for Claude and Reply were both filled. One main action per place: while a
// comment, reply or edit is being written in the panel, its own button is the filled one.
test("the Comments panel has one filled button at a time: Copy for Claude, or the box being written in's own", async () => {
  const run = tidy.keep(await openText(PLAN, { name: "plan.md" }));
  const { page } = run;
  await comment(page, "four inboxes", "Name them.");
  await expect(page.locator(SEND)).toHaveText("Copy for Claude");
  expect(await filled(page)).toEqual(["Copy for Claude"]);
  const named = card(page, "Name them.");
  await named.locator(".comment-body").first().click();
  await named.getByRole("textbox", { name: "Reply" }).fill("Help, info and events.");
  expect(await filled(page), "replying").toEqual(["Reply"]);
  await named.getByRole("button", { name: "Cancel" }).click();
  expect(await filled(page)).toEqual(["Copy for Claude"]);
  await selectText(page, "two answers");
  await page.getByRole("button", { name: "Comment", exact: true }).click();
  await page.getByRole("textbox", { name: "New comment" }).fill("Which ones?");
  expect(await filled(page), "a new comment").toEqual(["Post"]);
  await page.getByRole("button", { name: "Post" }).click();
  await expect(card(page, "Which ones?")).toBeVisible();
  expect(await filled(page)).toEqual(["Copy for Claude"]);
});

// F-22 (D-12): at its widest, the panel put New comment and Copy for Claude 473 pixels apart in a 1440-pixel
// window, and each card's Resolve 470 to 550 pixels from its words. Cards and their buttons now keep a readable width.
test("in a wide Comments panel the cards and the top row keep a readable width, so buttons stay near what they act on", async () => {
  const run = tidy.keep(await openText(PLAN, { name: "plan.md" }));
  const { page } = run;
  await page.setViewportSize({ width: 1440, height: 800 });
  await comment(page, "four inboxes", "Name them.");
  await comment(page, "two answers", "Which ones? Say how often it happens, and who answers twice.");
  const handle = page.locator(`${DOC} .comments-handle`);
  await handle.focus();
  for (let i = 0; i < 30; i++) await page.keyboard.press("ArrowLeft");
  await expect(handle).toHaveAttribute("aria-valuenow", "720");
  const at = await page.locator(PANEL).evaluate((panel) => {
    const box = (sel: string) => panel.querySelector(sel)!.getBoundingClientRect();
    const cards = [...panel.querySelectorAll(".comment-card")].map((c) => {
      const r = c.getBoundingClientRect();
      return { width: r.width, tick: c.querySelector(".comment-resolve")!.getBoundingClientRect().right - c.querySelector(".comment-body")!.getBoundingClientRect().left };
    });
    return { panel: panel.getBoundingClientRect().width, row: box(".comments-hand-back").right - box(".comments-new").left, resolved: box(".panel-head").width, cards };
  });
  expect(at.panel).toBe(720);
  expect(at.row, "New comment to Copy for Claude").toBeLessThanOrEqual(480);
  expect(at.resolved, "the heading's row").toBeLessThanOrEqual(480);
  for (const c of at.cards) {
    expect(c.width).toBeLessThanOrEqual(480);
    expect(c.tick, "Resolve, from the comment's words").toBeLessThanOrEqual(460);
  }
});

// F-8 (N-6): after a reply to Claude's answer, the "Claude changed the highlighted text" box moved under the new
// reply, so it read as if Claude had already acted on it. It stays with the reply it belongs to; so does the box
// for an option the person chose.
test("the box saying Claude changed the highlighted text stays with Claude's reply, not under the person's newer one", async () => {
  const run = tidy.keep(await openText(PLAN, { name: "plan.md" }));
  const { page } = run;
  await comment(page, "four inboxes", "Name them.");
  await comment(page, "three months", "Is three enough?");
  const claude = await agent(run);
  const taken = await claude.ok("take_document", { path: run.file });
  const ids = new Map([...taken.matchAll(/\[([0-9a-f]+)\] on "([^"]+)"/g)].map((m) => [m[2], m[1]]));
  await claude.ok("edit_document", { path: run.file, edits: [{ find: "about four inboxes", replace: "about four inboxes (help, info, volunteers and events)" }], comment_ids: [ids.get("four inboxes")] });
  await claude.ok("reply_to_comment", { path: run.file, comment_id: ids.get("four inboxes"), text: "Named all four." });
  await claude.ok("reply_to_comment", {
    path: run.file,
    comment_id: ids.get("three months"),
    text: "It's what the budget allows. Longer?",
    options: [{ label: "Six months", edits: [{ find: "about three months", replace: "about six months" }] }],
  });
  await claude.ok("finish_editing", { path: run.file });
  /** Which message (by its words) the change box is in, and whether it comes before the last message. */
  const boxIn = (c: ReturnType<typeof card>) =>
    c.evaluate((el) => {
      const box = el.querySelector(".comment-change")!;
      const messages = [...el.querySelectorAll(".comment-message")];
      return { in: box.closest(".comment-message")?.querySelector(".comment-body")?.textContent ?? null, beforeLast: box.getBoundingClientRect().bottom <= messages.at(-1)!.getBoundingClientRect().top };
    });

  const named = card(page, "Name them.");
  await named.locator(".comment-body").first().click();
  await expect(named.locator(".comment-change")).toHaveText(/Claude changed the highlighted text\./);
  await named.getByRole("textbox", { name: "Reply" }).fill("And the two chats too, please.");
  await named.getByRole("button", { name: "Reply" }).click();
  await expect(named.locator(".comment-message")).toHaveCount(3);
  await named.locator(".comment-body").first().click();
  expect(await boxIn(named)).toEqual({ in: "Named all four.", beforeLast: true });

  const longer = card(page, "Is three enough?");
  await longer.locator(".comment-body").first().click();
  await longer.getByRole("button", { name: "Six months" }).click();
  await expect(longer.locator(".comment-change")).toHaveText(/What you chose is highlighted\./);
  await longer.getByRole("textbox", { name: "Reply" }).fill("Good, thanks.");
  await longer.getByRole("button", { name: "Reply" }).click();
  await expect(longer.locator(".comment-message")).toHaveCount(3);
  await longer.locator(".comment-body").first().click();
  expect(await boxIn(longer)).toEqual({ in: "It's what the budget allows. Longer?", beforeLast: true });
});

// F-12 (N-5, B-9): under "Claude is editing" the Comments heading sat a bar's height above the page, and the
// outline's title was smaller, grey and higher than the Comments heading beside it.
test("under a bar over the page, the Comments and History headings stay level with the page, and the outline's title matches them", async () => {
  const run = tidy.keep(await openText(PLAN, { name: "plan.md" }));
  const { page, app } = run;
  await page.setViewportSize({ width: 1440, height: 800 });
  await comment(page, "four inboxes", "Which four?");
  await clickMenu(app, "view-outline");
  await expect(page.locator(`${DOC} .outline-pane`)).toBeVisible();
  const at = () =>
    page.evaluate((editor) => {
      // Where a row's contents start, inside any padding of its own.
      const top = (sel: string) => {
        const row = document.querySelector(sel);
        return row ? row.getBoundingClientRect().top + parseFloat(getComputedStyle(row).paddingTop) : null;
      };
      const look = (sel: string) => {
        const s = getComputedStyle(document.querySelector(sel)!);
        return `${s.fontSize} ${s.fontWeight} ${s.lineHeight} ${s.color}`;
      };
      return {
        // Where the page's top is on screen. A line arriving at the top scrolls the page as far as it can, so its
        // words keep still (F-4), and the headings keep still with it (review of Batch 11, B11R-8: they were
        // measured against the page as laid out at its top, under the line, and dropped by the line's height).
        page: document.querySelector(editor)!.getBoundingClientRect().top,
        comments: top(".doc:not([hidden]) .comments-panel:not([hidden]) .panel-head"),
        history: top(".doc:not([hidden]) .history-panel:not([hidden]) .panel-head"),
        outline: top(".doc:not([hidden]) .outline-title"),
        looks: [look(".doc:not([hidden]) .comments-panel .panel-head h2"), look(".doc:not([hidden]) .outline-title")],
      };
    }, EDITOR);

  const claude = await agent(run);
  await claude.ok("take_document", { path: run.file });
  await expect(page.locator(`${DOC} .agent-notice`)).toContainText("Claude is editing");
  await expect.poll(async () => Math.round((await at()).comments! - (await at()).page), { message: "Comments, under the bar" }).toBe(0);
  const now = await at();
  expect(Math.round(now.outline! - now.comments!), "the outline's title, level with Comments").toBe(0);
  expect(now.looks[1], "the outline's title, in the Comments heading's style").toBe(now.looks[0]);

  await clickMenu(app, "view-history");
  await expect.poll(async () => Math.round((await at()).history! - (await at()).page), { message: "History, under the bar" }).toBe(0);

  // The bar goes: the headings follow the page back up.
  await clickMenu(app, "view-history");
  await claude.call("finish_editing", { path: run.file }); // the comment is left for the next pass
  await claude.ok("finish_editing", { path: run.file });
  await expect(page.locator(`${DOC} .agent-notice`)).toBeHidden();
  await expect.poll(async () => Math.round((await at()).comments! - (await at()).page), { message: "Comments, without the bar" }).toBe(0);
});

// F-19 (N-11): at 900 pixels with the comments open, View > Show Outline ticked and nothing showed: the pane had
// given way to the page. Turned on where it can't show, the outline now says why, and what to do.
test("turning the outline on where it can't show says why and what to do: hide the comments, or the Formatted view", async () => {
  const run = tidy.keep(await openText(PLAN, { name: "plan.md" }));
  const { page, app } = run;
  await page.setViewportSize({ width: 900, height: 700 });
  await comment(page, "four inboxes", "Which four?");
  const told = page.locator(`${DOC} .outline-told`);
  await clickMenu(app, "view-outline");
  await expect(told).toHaveText("The outline is on, but there isn't room for it beside the page. Hide the comments or make the window wider.");
  await expect(told).toHaveAttribute("role", "status");
  await expect(page.locator(`${DOC} .outline-pane`)).toBeHidden();
  // Hiding the comments makes room: the outline shows, and the note has done its work.
  await clickMenu(app, "view-comments");
  await expect(page.locator(`${DOC} .outline-pane`)).toBeVisible();
  await expect(told).toHaveCount(0);

  // In the Markdown view it waits for the Formatted view, and says so.
  await clickMenu(app, "view-outline");
  await clickMenu(app, "view-markdown");
  await clickMenu(app, "view-outline");
  await expect(told).toHaveText("The outline is on. It shows in the Formatted view.");
  await clickMenu(app, "view-formatted");
  await expect(page.locator(`${DOC} .outline-pane`)).toBeVisible();
  await expect(told).toHaveCount(0);
});

// F-18 (N-8), changes how you work: in the Markdown view with the comments open, a window under about 900 pixels
// left the text and the preview each too narrow to read. The preview gives way, and the text has the room.
test("in the Markdown view, when the text and the preview can't both have room, the preview gives way and the text takes the view", async () => {
  const run = tidy.keep(await openText(PLAN, { name: "plan.md" }));
  const { page, app } = run;
  await page.setViewportSize({ width: 1100, height: 700 });
  await comment(page, "four inboxes", "Which four?");
  await clickMenu(app, "view-markdown");
  const split = `${DOC} .split`;
  const preview = page.locator(`${split} > .preview-pane`);
  const line = page.locator(`${split} > .split-handle`);
  await expect(preview).toBeVisible();
  const widths = () =>
    page.locator(split).evaluate((v) => ({ view: v.clientWidth, text: v.querySelector<HTMLElement>(".source")!.offsetWidth }));

  // With the comments open, a window under about 900 pixels: the text alone, across the whole view.
  await page.setViewportSize({ width: 880, height: 700 });
  await expect(preview).toBeHidden();
  await expect(line).toBeHidden();
  const narrow = await widths();
  expect(narrow.view, "the comments panel kept its least width").toBe(880 - 264);
  expect(narrow.text).toBe(narrow.view);
  // Typing in the text still works.
  await page.locator(`${split} > .source`).click();
  await page.keyboard.press("End");
  await page.keyboard.type(" More.");
  await expect(page.locator(`${split} > .source`)).toHaveValue(/More\./);

  // Hiding the comments makes room: the preview is back beside the text.
  await clickMenu(app, "view-comments");
  await expect(preview).toBeVisible();
  await expect(preview).toContainText("More.");
  await clickMenu(app, "view-comments");
  await expect(preview).toBeHidden();
  // So does a wider window.
  await page.setViewportSize({ width: 1000, height: 700 });
  await expect(preview).toBeVisible();
  await expect(line).toBeVisible();
});
