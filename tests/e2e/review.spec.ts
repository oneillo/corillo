// Reading what an agent did, comment by comment (spec: "Reviewing an
// agent's changes, comment by comment"): the status line when it's done,
// each comment's change highlighted when its card is in focus, what it said
// before, requests made in the chat, other changes, and an empty line where a
// comment's deleted text was. There's no Review mode (Orlando, 2026-11-09):
// the cards are the review.
import { test, expect, type ElectronApplication, type Page } from "@playwright/test";
import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ONE_SCALE, openText, selectText, settle, turnSaid, EDITOR, type Running, launch } from "./helpers";
import { AgentSession } from "./agent-session";

const PANEL = ".doc:not([hidden]) .comments-panel";
const LINE = ".doc:not([hidden]) .pass-notice";
const EDITING = ".doc:not([hidden]) .agent-notice";

const card = (page: Page, body: string) => page.locator(`${PANEL} .comment-card`).filter({ hasText: body });
const marks = (page: Page) => page.locator(`${EDITOR} .change-mark`).allTextContents();

/** The status line's two parts: who's done, and what they did. */
async function lineWords(page: Page): Promise<{ lead: string; detail: string }> {
  return {
    lead: (await page.locator(`${LINE} .pass-notice-lead`).textContent()) ?? "",
    detail: (await page.locator(`${LINE} .pass-notice-detail`).textContent()) ?? "",
  };
}

/** Where the page's first line is on screen. */
const pageTop = (page: Page) => page.locator(`${EDITOR} .ProseMirror > *`).first().evaluate((e) => Math.round(e.getBoundingClientRect().top));

/** Every item in the menu bar, by its words. */
function menuLabels(app: ElectronApplication): Promise<string[]> {
  return app.evaluate(({ Menu }) => {
    const all: string[] = [];
    const walk = (menu: Electron.Menu | null | undefined) => {
      for (const i of menu?.items ?? []) {
        all.push(i.label);
        walk(i.submenu);
      }
    };
    walk(Menu.getApplicationMenu());
    return all;
  });
}

/** No Review mode anywhere: no Review button, bar or menu item to start or end one. */
async function expectNoReviewMode(run: Running): Promise<void> {
  await expect(run.page.getByRole("button", { name: /^Review\b/ })).toHaveCount(0);
  await expect(run.page.locator(".review-bar, .comments-review-button")).toHaveCount(0);
  const labels = await menuLabels(run.app);
  expect(labels.filter((l) => /Start Review|End Review/.test(l))).toEqual([]);
}

/** Leave a comment as the person: on these words, or on the whole document with none. */
async function comment(run: Running, words: string | null, body: string): Promise<void> {
  if (words) await selectText(run.page, words);
  else {
    await run.page.locator(`${EDITOR} h1`).click();
    await settle(run.page);
  }
  await run.page.getByRole("button", { name: "Comment", exact: true }).click();
  const box = run.page.getByRole("textbox", { name: "New comment" });
  await box.fill(body);
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

const PLAN = "# Plan\n\nWe should hire two people this quarter.\n\nThe budget is tight.\n";

// Orlando, 2026-11-09: "When the agent is done, I'd rather a status update at
// the top saying the agent is done and document is back to you. To me the
// review is then to go through each comment one by one."
test("when an agent finishes, a status line says it's done and the document is back with you; going through the cards is the review", async () => {
  const run = await openText(PLAN, { name: "plan.md" });
  await comment(run, "two people", "Make it three.");
  await comment(run, "tight", "Say by how much.");
  await comment(run, null, "Add a closing line.");
  const { session: claude } = await AgentSession.start(run.dataDir, "claude-code");
  try {
    const ids = idsIn(await claude.ok("take_document", { path: run.file }));
    await expect(run.page.locator(EDITING)).toContainText("Claude is editing");
    await expect(run.page.locator(LINE)).toBeHidden();
    const top = await pageTop(run.page);
    await claude.ok("edit_document", { path: run.file, edits: [{ find: "two people", replace: "three people" }], comment_ids: [ids.get("two people")] });
    await claude.ok("edit_document", { path: run.file, edits: [{ find: "is tight.", replace: "is tight: 10% under plan." }], comment_ids: [ids.get("tight")] });
    await claude.ok("edit_document", { path: run.file, edits: [{ find: "# Plan", replace: "# Hiring plan" }], comment_ids: [ids.get("")] });
    for (const [words, reply] of [["two people", "Now three."], ["tight", "Added the figure."], ["", "Added one."]]) {
      await claude.ok("reply_to_comment", { path: run.file, comment_id: ids.get(words), text: reply });
    }
    await claude.ok("finish_editing", { path: run.file });

    // The status line takes the editing notice's place, at its height: the page doesn't move.
    await expect(run.page.locator(LINE)).toBeVisible();
    await expect(run.page.locator(EDITING)).toBeHidden();
    expect(await lineWords(run.page)).toEqual({
      lead: "Claude is done. Back to you.",
      detail: "3 comments to read.",
    });
    expect(await pageTop(run.page)).toBe(top);
    await expectNoReviewMode(run);
    // Nothing to close: it clears itself once you start working (Orlando, 2026-11-09).
    await expect(run.page.locator(LINE).getByRole("button")).toHaveCount(0);
    await expect(card(run.page, "Make it three.")).toHaveAttribute("aria-label", turnSaid("Waiting for you"));

    // Each card, clicked: in focus, with the words its agent changed for it highlighted.
    await card(run.page, "Add a closing line.").click();
    await expect(card(run.page, "Add a closing line.")).toHaveClass(/active/);
    await expect.poll(() => marks(run.page)).toEqual(["Hiring plan"]);
    await card(run.page, "Make it three.").click();
    await expect(card(run.page, "Make it three.")).toHaveClass(/active/);
    await expect.poll(() => marks(run.page)).toEqual(["three"]);

    // What it said before: the old word struck through beside the new one, on screen only.
    const active = card(run.page, "Make it three.");
    await active.getByRole("button", { name: "Show what it said before" }).click();
    await expect(run.page.locator(`${EDITOR} del.change-before`)).toHaveText(["two"]);
    expect(run.text()).toContain("hire three people");
    expect(run.text()).not.toContain("two");
    await active.getByRole("button", { name: "Hide what it said before" }).click();
    await expect(run.page.locator(`${EDITOR} del.change-before`)).toHaveCount(0);

    // Reading the cards left the line as it was.
    await expect(run.page.locator(LINE)).toBeVisible();

    // Resolve, on the card: done, and the card goes. Resolving is working on
    // the document, so the line has done its job: it fades away, and the page stays put.
    await active.getByRole("button", { name: "Resolve", exact: true }).click();
    await expect(card(run.page, "Make it three.")).toHaveCount(0);
    await expect(run.page.locator(LINE)).toBeHidden();
    expect(await pageTop(run.page)).toBe(top);

    // Reply: the comment stays open for the agent's next round.
    const tight = card(run.page, "Say by how much.");
    await tight.click();
    await expect.poll(() => marks(run.page)).toEqual([expect.stringContaining("10% under plan")]);
    const reply = tight.getByRole("textbox", { name: "Reply" });
    await reply.fill("Round it to 10.");
    await reply.press("Meta+Enter");
    await expect(tight).toHaveAttribute("aria-label", turnSaid("For Claude, not sent yet"));
    await card(run.page, "Add a closing line.").getByRole("button", { name: "Resolve", exact: true }).click();
    await expect(run.page.locator(LINE)).toBeHidden();
    expect(await pageTop(run.page)).toBe(top);
    await expectNoReviewMode(run);
  } finally {
    await run.app.close();
    await claude.stop();
  }
});

test("the status line goes when the next pass starts, and two agents finishing one after the other read as one line", async () => {
  const run = await openText(PLAN, { name: "plan.md" });
  await comment(run, "two people", "Make it three.");
  const writer = (await AgentSession.start(run.dataDir, "writer-tool")).session;
  const claude = (await AgentSession.start(run.dataDir, "claude-code")).session;
  try {
    await writer.ok("introduce", { name: "Writer" });
    await claude.ok("open_document", { path: run.file }); // Claude first: the default agent
    await writer.ok("open_document", { path: run.file });
    await comment(run, "tight", "@Writer warmer, please.");

    // Claude's pass.
    let ids = idsIn(await claude.ok("take_document", { path: run.file }));
    const top = await pageTop(run.page);
    await claude.ok("edit_document", { path: run.file, edits: [{ find: "two people", replace: "three people" }], comment_ids: [ids.get("two people")] });
    await claude.ok("reply_to_comment", { path: run.file, comment_id: ids.get("two people"), text: "Now three." });
    await claude.ok("finish_editing", { path: run.file });
    await expect(run.page.locator(LINE)).toBeVisible();
    expect(await lineWords(run.page)).toEqual({
      lead: "Claude is done. Back to you.",
      detail: "1 comment to read.",
    });
    // Only reading meanwhile: a card clicked leaves the line up.
    await card(run.page, "Make it three.").click();
    await expect(run.page.locator(LINE)).toBeVisible();

    // Writer takes the document: its editing notice takes the line's place, and the page stays put.
    ids = idsIn(await writer.ok("take_document", { path: run.file }));
    await expect(run.page.locator(EDITING)).toContainText("Writer is editing");
    await expect(run.page.locator(LINE)).toBeHidden();
    expect(await pageTop(run.page)).toBe(top);
    await writer.ok("edit_document", { path: run.file, edits: [{ find: "is tight.", replace: "is a little tight." }], comment_ids: [ids.get("tight")] });
    await writer.ok("reply_to_comment", { path: run.file, comment_id: ids.get("tight"), text: "Softer now." });
    await writer.ok("finish_editing", { path: run.file });

    // Both, in one line, with everything left to read: you hadn't started working in between.
    await expect(run.page.locator(EDITING)).toBeHidden();
    await expect(run.page.locator(LINE)).toBeVisible();
    expect(await lineWords(run.page)).toEqual({
      lead: "Claude and Writer are done. Back to you.",
      detail: "2 comments to read.",
    });
    await expect(run.page.locator(`${LINE} .agent-swatch`)).toHaveCount(2);
    expect(await pageTop(run.page)).toBe(top);

    // You start working: the line clears, and the next pass starts afresh, naming only its agent.
    await card(run.page, "Make it three.").getByRole("button", { name: "Resolve", exact: true }).click();
    await expect(run.page.locator(LINE)).toBeHidden();
    await claude.ok("take_document", { path: run.file, request: "Call it a hiring plan." });
    await expect(run.page.locator(EDITING)).toContainText("Claude is editing");
    // The editing line takes the room the faded line kept: still nothing moves.
    expect(await pageTop(run.page)).toBe(top);
    await claude.ok("edit_document", { path: run.file, edits: [{ find: "# Plan", replace: "# Hiring plan" }] });
    await claude.ok("finish_editing", { path: run.file });
    await expect(run.page.locator(LINE)).toBeVisible();
    // The request has no card (roadmap Batch 9, item 5): the line leads to its changes instead.
    expect(await lineWords(run.page)).toEqual({
      lead: "Claude is done. Back to you.",
      detail: "1 comment to read.",
    });
    await expect(run.page.locator(LINE).getByRole("button", { name: "Show changes" })).toBeVisible();
    await expect(run.page.locator(`${LINE} .agent-swatch`)).toHaveCount(1);
    expect(await pageTop(run.page)).toBe(top);
  } finally {
    await run.app.close();
    await claude.stop();
    await writer.stop();
  }
});

test("a request made in the chat is kept with the pass: History shows it and the changes made for it, and the panel has no card for it", async () => {
  const run = await openText("We should hire two people.\n\nThe budget is tight.\n", { name: "plan.md" });
  await comment(run, "two people", "Make it three.");
  const { session: claude } = await AgentSession.start(run.dataDir, "claude-code");
  try {
    // A pass with a comment and a request.
    const ids = idsIn(await claude.ok("take_document", { path: run.file, request: "Make the budget line punchier." }));
    expect(await claude.ok("edit_document", { path: run.file, edits: [{ find: "The budget is tight.", replace: "Budget: tight." }] })).toContain(
      "for the request from the chat",
    );
    await claude.ok("edit_document", { path: run.file, edits: [{ find: "two people", replace: "three people" }], comment_ids: [ids.get("two people")] });
    await claude.ok("reply_to_comment", { path: run.file, comment_id: ids.get("two people"), text: "Done." });
    await claude.ok("finish_editing", { path: run.file });
    expect(await lineWords(run.page)).toEqual({
      lead: "Claude is done. Back to you.",
      detail: "1 comment to read.",
    });
    await card(run.page, "Make it three.").click();
    await expect.poll(() => marks(run.page)).toEqual(["three"]);
    await card(run.page, "Make it three.").getByRole("button", { name: "Resolve", exact: true }).click();
    // Comments only: the request has no card (roadmap Batch 9, item 5).
    await expect(run.page.locator(`${PANEL} .comment-card`)).toHaveCount(0);

    // A pass with only a request, and one with a change nobody asked for.
    await claude.ok("take_document", { path: run.file, request: "Add a title." });
    await claude.ok("edit_document", { path: run.file, edits: [{ find: "We should", replace: "# Hiring\n\nWe should" }] });
    await claude.ok("finish_editing", { path: run.file });
    expect(await lineWords(run.page)).toEqual({ lead: "Claude is done. Back to you.", detail: "" });
    await expect(run.page.locator(LINE).getByRole("button", { name: "Show changes" })).toBeVisible();
    await claude.ok("take_document", { path: run.file });
    // Tied to no comment nor request: the agent is reminded to say what the person asked for.
    expect(await claude.ok("edit_document", { path: run.file, edits: [{ find: "tight.", replace: "very tight." }] })).toContain(
      "give their request with finish_editing",
    );
    await claude.ok("finish_editing", { path: run.file });
    expect(await lineWords(run.page)).toEqual({ lead: "Claude is done. Back to you.", detail: "" });
    await expect(run.page.locator(`${PANEL} .comment-card`)).toHaveCount(0);

    // History, for the person and for agents.
    await run.page.getByRole("button", { name: "History", exact: true }).click();
    const items = run.page.locator(".doc:not([hidden]) .history-panel .history-item");
    await expect(items.nth(0).locator(".history-asked")).toHaveText("Other changes");
    await expect(items.nth(1).locator(".history-asked")).toHaveText("Asked in chat: Add a title.");
    await expect(items.nth(2).locator(".history-asked")).toHaveText("Asked in chat: Make the budget line punchier.");
    await expect(items.nth(2).locator(".history-comment")).toHaveText("Make it three.");
    await expect(items.nth(2).locator(".history-change").first()).toContainText("three");
    const versions = await claude.ok("list_versions", { path: run.file });
    expect(versions).toContain('Asked in chat: "Add a title."');
    expect(versions).toContain('Asked in chat: "Make the budget line punchier."');
    expect(versions).toMatch(/Changed: \[-two-\]\{\+three\+\}/);
  } finally {
    await run.app.close();
    await claude.stop();
  }
});

test("a pass that only starts comments for the person ends with the done line, and History keeps it", async () => {
  const run = await openText("We should hire two people this quarter.\n", { name: "plan.md" });
  const { session: claude } = await AgentSession.start(run.dataDir, "claude-code");
  try {
    await claude.ok("take_document", { path: run.file });
    await claude.ok("add_comment", { path: run.file, text: "Which quarter do you mean?", quote: "this quarter" });
    await claude.ok("finish_editing", { path: run.file });
    await expect.poll(() => lineWords(run.page)).toEqual({ lead: "Claude is done. Back to you.", detail: "1 comment to read." });
    await run.page.getByRole("button", { name: "History", exact: true }).click();
    const items = run.page.locator(".doc:not([hidden]) .history-panel .history-item");
    await expect(items.nth(0).locator(".history-comment")).toHaveText("Which quarter do you mean?");
  } finally {
    await run.app.close();
    await claude.stop();
  }
});

test("History shows the first message of a comment an agent started once, not again as its reply", async () => {
  const run = await openText("We should hire two people this quarter.\n", { name: "plan.md" });
  const { session: claude } = await AgentSession.start(run.dataDir, "claude-code");
  try {
    await claude.ok("take_document", { path: run.file });
    await claude.ok("add_comment", { path: run.file, text: "Which quarter do you mean?", quote: "this quarter" });
    await claude.ok("finish_editing", { path: run.file });
    await expect.poll(() => lineWords(run.page)).toEqual({ lead: "Claude is done. Back to you.", detail: "1 comment to read." });
    await run.page.getByRole("button", { name: "History", exact: true }).click();
    const latest = run.page.locator(".doc:not([hidden]) .history-panel .history-item").nth(0);
    await expect(latest.locator(".history-comment")).toHaveText("Which quarter do you mean?");
    await expect(latest.locator(".history-reply")).toHaveCount(0);
    await expect(latest.locator(".history-thread")).toHaveText("Which quarter do you mean?");
  } finally {
    await run.app.close();
    await claude.stop();
  }
});

test("a second round highlights only its own change; the person's edits keep it in place; a relaunch keeps it all", async () => {
  let run = await openText("We should hire two people this quarter.\n", { name: "plan.md" });
  await comment(run, "hire two people", "Make it three.");
  let claude = (await AgentSession.start(run.dataDir, "claude-code")).session;
  try {
    let ids = idsIn(await claude.ok("take_document", { path: run.file }));
    const id = ids.get("hire two people");
    await claude.ok("edit_document", { path: run.file, edits: [{ find: "two", replace: "three" }], comment_ids: [id] });
    await claude.ok("reply_to_comment", { path: run.file, comment_id: id, text: "Three it is." });
    await claude.ok("finish_editing", { path: run.file });

    await card(run.page, "Make it three.").click();
    await expect.poll(() => marks(run.page)).toEqual(["three"]);
    // The person types before it: the highlight stays on the agent's word.
    await run.page.locator(`${EDITOR} p`).click();
    await run.page.keyboard.press("Meta+ArrowLeft");
    await run.page.keyboard.type("Next year, ");
    await card(run.page, "Make it three.").click();
    await expect.poll(() => marks(run.page)).toEqual(["three"]);

    // The person asks for more; the agent's second round changes other words.
    const reply = card(run.page, "Make it three.").getByRole("textbox", { name: "Reply" });
    await reply.fill("And say by when.");
    await reply.press("Meta+Enter");
    await expect(card(run.page, "Make it three.")).toHaveAttribute("aria-label", turnSaid("For Claude, not sent yet"));
    ids = idsIn(await claude.ok("take_document", { path: run.file }));
    expect(run.text()).toBe("Next year, We should hire three people this quarter.\n");
    await claude.ok("edit_document", { path: run.file, edits: [{ find: "this quarter", replace: "by March" }], comment_ids: [id] });
    await claude.ok("reply_to_comment", { path: run.file, comment_id: id, text: "By March." });
    await claude.ok("finish_editing", { path: run.file });
    // The same agent's second round: the line tells of that round only.
    expect(await lineWords(run.page)).toEqual({ lead: "Claude is done. Back to you.", detail: "1 comment to read." });
    await card(run.page, "Make it three.").click();
    await expect.poll(() => marks(run.page)).toEqual(["by March"]);

    // After a relaunch: the same change, still waiting for you (the line was for that moment, and is gone).
    await claude.stop();
    run = await relaunch(run);
    claude = (await AgentSession.start(run.dataDir, "claude-code")).session;
    await expect(run.page.locator(LINE)).toBeHidden();
    await expect(card(run.page, "Make it three.")).toHaveAttribute("aria-label", turnSaid("Waiting for you"));
    await card(run.page, "Make it three.").click();
    await expect.poll(() => marks(run.page)).toEqual(["by March"]);
  } finally {
    await run.app.close();
    await claude.stop();
  }
});

test("the comment in focus loses its coral fill while its change shows, and keeps it when its agent changed nothing", async () => {
  const run = await openText(PLAN, { name: "plan.md" });
  await comment(run, "two people", "Make it three.");
  await comment(run, "tight", "Fine as it is?");
  const { session: claude } = await AgentSession.start(run.dataDir, "claude-code");
  try {
    const ids = idsIn(await claude.ok("take_document", { path: run.file }));
    await claude.ok("edit_document", { path: run.file, edits: [{ find: "two people", replace: "three people" }], comment_ids: [ids.get("two people")] });
    await claude.ok("reply_to_comment", { path: run.file, comment_id: ids.get("two people"), text: "Now three." });
    await claude.ok("reply_to_comment", { path: run.file, comment_id: ids.get("tight"), text: "Yes, left it." });
    await claude.ok("finish_editing", { path: run.file });
    await expect(run.page.locator(LINE)).toBeVisible();

    // A comment whose change shows: its words keep the coral underline but not the coral fill.
    const fill = (selector: string) => run.page.locator(`${EDITOR} ${selector}`).first().evaluate((el) => getComputedStyle(el).backgroundColor);
    const root = run.page.locator(`${EDITOR} .ProseMirror`);
    await card(run.page, "Make it three.").click();
    await expect.poll(() => marks(run.page)).toEqual(["three"]);
    await expect(root).toHaveClass(/showing-change/);
    expect(await fill(".comment-range.active:not(.change-mark)")).toBe("rgba(0, 0, 0, 0)");
    // One the agent answered without changing anything keeps its fill, so it can still be seen.
    await card(run.page, "Fine as it is?").click();
    await expect.poll(() => marks(run.page)).toEqual([]);
    await expect(root).not.toHaveClass(/showing-change/);
    expect(await fill(".comment-range.active")).not.toBe("rgba(0, 0, 0, 0)");
  } finally {
    await run.app.close();
    await claude.stop();
  }
});

// Waiting for you first is gone (roadmap Batch 9, item 8): the cards keep one order. See comments-only.spec.ts.

const PARAS = "# Plan\n\nKeep this paragraph.\n\nDrop this whole paragraph please.\n\nAnd this one stays.\n";
const WORDS = ["Alpha", "Bravo", "Charlie", "Delta", "Echo", "Foxtrot", "Golf", "Hotel", "India", "Juliet"];
const SPELLING = WORDS.map((w) => `${w} is one of the words we spell with.`).join("\n\n") + "\n";
const WITHOUT = SPELLING.replace("Foxtrot is one of the words we spell with.\n\n", "");

/** The top of a word on the page (each has a comment on it). */
function wordTop(page: Page, word: string): Promise<number> {
  return page.locator(`${EDITOR} .comment-range`, { hasText: word }).evaluate((e) => e.getBoundingClientRect().top);
}

test("when an agent deletes a comment's paragraph, an empty line keeps its place until the comment is resolved", async () => {
  let run = await openText(SPELLING, { name: "spelling.md" });
  await run.page.setViewportSize({ width: 1280, height: 1000 });
  // Comments on it and on its neighbours.
  for (const w of ["Echo", "Foxtrot", "Golf"]) {
    await comment(run, w === "Foxtrot" ? "Foxtrot is one of the words we spell with." : w, `About ${w}, long enough to take a couple of lines in the panel.`);
  }
  const body = "About Foxtrot";
  const claude = (await AgentSession.start(run.dataDir, "claude-code")).session;
  try {
    const ids = idsIn(await claude.ok("take_document", { path: run.file }));
    const id = ids.get("Foxtrot is one of the words we spell with.");
    await claude.ok("edit_document", { path: run.file, edits: [{ find: "Foxtrot is one of the words we spell with.\n\n", replace: "" }], comment_ids: [id] });
    await claude.ok("reply_to_comment", { path: run.file, comment_id: id, text: "Cut." });
    // The other comments are left for later: finishing asks once, then lets the agent go.
    expect((await claude.call("finish_editing", { path: run.file })).text).toContain("still waiting for you");
    await claude.ok("finish_editing", { path: run.file });

    // The file has no trace of it; the page keeps an empty line where it was, between its neighbours.
    expect(run.text()).toBe(WITHOUT);
    const gap = run.page.locator(`${EDITOR} .comment-gap.line`);
    await expect(gap).toHaveCount(1);
    const box = await gap.evaluate((e) => ({ top: e.getBoundingClientRect().top, bottom: e.getBoundingClientRect().bottom }));
    expect(box.top).toBeGreaterThan(await wordTop(run.page, "Echo"));
    expect(box.bottom).toBeLessThanOrEqual(await wordTop(run.page, "Golf"));
    await expect(card(run.page, body)).not.toContainText("has changed");

    // Its card in focus: the empty line is highlighted and in sight, the card keeps its place in the list, and it shows what was there.
    await card(run.page, body).click();
    await expect(gap).toHaveClass(/active/);
    await expect(gap).toBeInViewport();
    await expect(card(run.page, body)).toHaveClass(/active/);
    const order = await run.page.locator(`${PANEL} .comment-card`).evaluateAll((cards) => cards.map((c) => c.textContent!.match(/About (\w+)/)![1]));
    expect(order).toEqual(["Echo", "Foxtrot", "Golf"]);
    await card(run.page, body).getByRole("button", { name: "Show what it said before" }).click();
    await expect(gap.locator("del.change-before")).toHaveText("Foxtrot is one of the words we spell with.");
    expect(run.text()).toBe(WITHOUT);

    // Resolving removes it; reopening the comment brings it back, since its words are still gone.
    await card(run.page, body).getByRole("button", { name: "Resolve", exact: true }).click();
    await expect(run.page.locator(`${EDITOR} .comment-gap`)).toHaveCount(0);
    await run.page.locator(`${PANEL} .comments-show-resolved`).click();
    await card(run.page, body).getByRole("button", { name: "Reopen" }).click();
    await expect(run.page.locator(`${EDITOR} .comment-gap.line`)).toHaveCount(1);

    // It's still there after a relaunch, and the file still has no blank paragraph.
    await claude.stop();
    run = await relaunch(run);
    await expect(run.page.locator(`${EDITOR} .comment-gap.line`)).toHaveCount(1);
    await expect(card(run.page, body)).not.toContainText("has changed");
    expect(readFileSync(run.file, "utf8")).toBe(WITHOUT);
  } finally {
    await run.app.close();
  }
});

test("when the person deletes a comment's words, an empty line keeps their place; Undo brings them back", async () => {
  const run = await openText(PARAS, { name: "plan.md" });
  await comment(run, "Drop this whole paragraph please.", "Cut this.");
  await selectText(run.page, "Drop this whole paragraph please.");
  await run.page.keyboard.press("Backspace");
  await expect(run.page.locator(`${EDITOR} .comment-gap`)).toHaveCount(1);
  await expect(card(run.page, "Cut this.")).not.toContainText("has changed");
  await expect(card(run.page, "Cut this.")).toBeVisible();
  // Selecting the comment shows what was there.
  await card(run.page, "Cut this.").click();
  await card(run.page, "Cut this.").getByRole("button", { name: "Show what it said before" }).click();
  await expect(run.page.locator(`${EDITOR} .comment-gap del.change-before`)).toHaveText("Drop this whole paragraph please.");
  await run.page.locator(`${EDITOR} .ProseMirror`).focus();
  await run.page.keyboard.press("Meta+z");
  await expect(run.page.locator(`${EDITOR} .comment-gap`)).toHaveCount(0);
  await expect(run.page.locator(`${EDITOR} .comment-range`)).toHaveText("Drop this whole paragraph please.");
  await run.app.close();
});

// Orlando, 2026-11-11, on a comment on the whole document that Claude answered
// in five places, mostly by adding text: "WHen I click on it, I don't see
// anything happening." and "I didn't see any difference in the words. It added
// new content to the document." Words only added had no old words to show, and
// a click on the card sent the page to the top, away from the ones that had.
test("Show what it said before always shows a difference: added words turn green, and old words off screen come into sight", async () => {
  const filler = Array.from({ length: 60 }, (_, i) => `Filler paragraph number ${i + 1} keeps the page long enough to scroll.`).join("\n\n");
  const run = await openText(`# Plan\n\nWe start soon.\n\n${filler}\n\nWe meet on Mondays.\n`, { name: "plan.md" });
  try {
    await comment(run, null, "Cross-link it.");
    const { session: claude } = await AgentSession.start(run.dataDir, "claude-code");
    try {
      const id = idsIn(await claude.ok("take_document", { path: run.file })).get("");
      // Words added near the top, nothing taken out there; a word changed far below.
      await claude.ok("edit_document", {
        path: run.file,
        edits: [
          { find: "We start soon.", replace: "We start soon. See the reading hub." },
          { find: "on Mondays.", replace: "on Tuesdays." },
        ],
        comment_ids: [id],
      });
      await claude.ok("reply_to_comment", { path: run.file, comment_id: id, text: "Linked." });
      await claude.ok("finish_editing", { path: run.file });
    } finally {
      await claude.stop();
    }

    const c = card(run.page, "Cross-link it.");
    await c.click();
    await expect(c).toHaveClass(/active/);
    // The page is at the top, on the added words; the changed word is far below.
    const added = run.page.locator(`${EDITOR} .change-mark`, { hasText: "See the reading hub." });
    await expect(added).toBeInViewport();
    const colour = () => added.evaluate((e) => getComputedStyle(e).backgroundColor);
    const plain = await colour();
    const old = run.page.locator(`${EDITOR} del.change-before`);

    // Show: the added words turn green, and the old word comes into sight, struck through.
    await c.getByRole("button", { name: "Show what it said before" }).click();
    await expect(old).toHaveCount(1);
    await expect(old).toContainText("Mon");
    await expect.poll(colour).not.toBe(plain);
    await expect(old).toBeInViewport();

    // Hide: back as it was, and the page stays where it is, not sent back to the top.
    const canvas = run.page.locator(".doc:not([hidden]) main.canvas");
    const there = await canvas.evaluate((e) => e.scrollTop);
    expect(there).toBeGreaterThan(0);
    await c.getByRole("button", { name: "Hide what it said before" }).click();
    await expect(old).toHaveCount(0);
    await expect.poll(colour).toBe(plain);
    expect(await canvas.evaluate((e) => e.scrollTop)).toBe(there);

    // Shown again with the old word already in sight: the page doesn't move.
    await c.getByRole("button", { name: "Show what it said before" }).click();
    await expect(old).toBeInViewport();
    expect(await canvas.evaluate((e) => e.scrollTop)).toBe(there);
  } finally {
    await run.app.close();
  }
});

// R-8: changes on two lines next to each other were shown as one, all the old words in the first line.
test("Show what it said before puts each line's old words in that line, for one comment answered on two bullets", async () => {
  const run = await openText("# Launch plan\n\n- Email the members\n- Print the posters\n- Book the hall\n", { name: "plan.md" });
  try {
    await comment(run, "Email the members", "Make these two say who does what.");
    const { session: claude } = await AgentSession.start(run.dataDir, "claude-code");
    try {
      const id = idsIn(await claude.ok("take_document", { path: run.file })).get("Email the members");
      await claude.ok("edit_document", {
        path: run.file,
        comment_ids: [id],
        edits: [
          { find: "Email the members", replace: "Write to every volunteer" },
          { find: "Print the posters", replace: "Order two hundred flyers" },
        ],
      });
      await claude.ok("reply_to_comment", { path: run.file, comment_id: id, text: "Done." });
      await claude.ok("finish_editing", { path: run.file });
    } finally {
      await claude.stop();
    }
    await expect(run.page.locator(EDITOR)).toContainText("Order two hundred flyers");

    const c = card(run.page, "Make these two say who does what.");
    await c.click();
    await expect(c).toHaveClass(/active/);
    await expect.poll(() => marks(run.page)).toEqual(["Write to every volunteer", "Order two hundred flyers"]);
    await c.getByRole("button", { name: "Show what it said before" }).click();
    await settle(run.page);
    const bullets = await run.page.locator(`${EDITOR} .ProseMirror li`).evaluateAll((items) =>
      items.map((li) => [...li.querySelectorAll("del.change-before")].map((d) => `[was: ${(d as HTMLElement).innerText}]`).join("") + " " + [...li.querySelectorAll(".change-mark")].map((m) => m.textContent).join("")),
    );
    expect(bullets.slice(0, 2)).toEqual(["[was: Email the members] Write to every volunteer", "[was: Print the posters] Order two hundred flyers"]);
  } finally {
    await run.app.close();
  }
});
