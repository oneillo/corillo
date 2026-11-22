// A cover note with every hand-back (roadmap Batch 2, item 3; A-4). An agent
// finishing its pass can leave a note: what the person should know or decide
// that doesn't belong on one comment. It shows as a card at the top of the
// Comments panel ("Note from Claude", with Done), the line saying the agent
// is done counts it ("2 comments and a note to read."), and History keeps it
// with the version. Each test runs the real app, hidden, with a pretend agent
// tool speaking to its real connector, on throwaway documents and data
// folders it removes.
import { test, expect, type Page } from "@playwright/test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { clickMenu, ONE_SCALE, openAlso, openText, selectText, settle, type Running, launch } from "./helpers";
import { AgentSession } from "./agent-session";

const DOC = ".doc:not([hidden])";
const PANEL = `${DOC} aside.comments-panel`;
const NOTE_CARD = `${PANEL} .comment-card.pass-note`;
const DONE_LINE = `${DOC} .pass-notice`;
const TURN = "#turn-status .turn-text";
const PLAN = "# Plan\n\nWe should hire two people this quarter.\n\nThe budget is tight.\n";
const NOTE = "I also called the budget very tight; say if that's too strong.";

let run: Running | null = null;
const folders: string[] = [];
const sessions: AgentSession[] = [];

test.afterEach(async () => {
  for (const s of sessions.splice(0)) await s.stop().catch(() => undefined);
  const r = run;
  run = null;
  if (r) {
    await r.app.evaluate(({ app }) => setTimeout(() => app.exit(0), 10)).catch(() => undefined);
    await r.app.close().catch(() => undefined);
    folders.push(r.folder, r.dataDir);
  }
  for (const dir of folders.splice(0)) rmSync(dir, { recursive: true, force: true });
});

async function start(): Promise<Running> {
  run = await openText(PLAN, { name: "plan.md" });
  folders.push(await run.app.evaluate(() => process.env.CORILLO_HOME ?? ""));
  return run;
}

async function agent(r: Running): Promise<AgentSession> {
  const { session } = await AgentSession.start(r.dataDir);
  sessions.push(session);
  return session;
}

/** Quit and start Corillo again on the same document and data folder. */
async function relaunch(r: Running): Promise<Running> {
  for (const s of sessions.splice(0)) await s.stop();
  await r.app.close();
  const home = mkdtempSync(join(tmpdir(), "corillo-home-"));
  folders.push(home);
  const { app, thrown } = await launch({ args: [ONE_SCALE, ".", r.file], env: { ...process.env, CORILLO_USER_DATA: r.dataDir, CORILLO_HIDDEN: "1", CORILLO_HOME: home } });
  const page = await app.firstWindow();
  await page.waitForSelector(".ProseMirror");
  run = { ...r, app, page, thrown };
  return run;
}

/** Leave a comment as the person on these words. */
async function comment(page: Page, words: string, body: string): Promise<void> {
  await selectText(page, words);
  await page.getByRole("button", { name: "Comment", exact: true }).click();
  await page.getByRole("textbox", { name: "New comment" }).fill(body);
  await page.getByRole("button", { name: "Post" }).click();
  await expect(page.locator(`${PANEL} .comment-card`, { hasText: body })).toBeVisible();
}

const idsIn = (text: string) => [...text.matchAll(/\[([0-9a-f]{8,})\] on /g)].map((m) => m[1]);

test("the note is a card at the top of the Comments panel; the done line and the status bar count it; History keeps it with the version; Done puts it away for good", async () => {
  const r = await start();
  const { page } = r;
  const claude = await agent(r);
  await claude.ok("open_document", { path: r.file });
  await comment(page, "two people", "Make it three.");
  await comment(page, "tight", "Say by how much.");
  const taken = await claude.ok("take_document", { path: r.file });
  const ids = idsIn(taken);
  await claude.ok("edit_document", { path: r.file, edits: [{ find: "two people", replace: "three people" }], comment_ids: [ids[0]] });
  for (const id of ids) await claude.ok("reply_to_comment", { path: r.file, comment_id: id, text: "Done." });
  await claude.ok("finish_editing", { path: r.file, note: NOTE });

  // The done line counts it, after the comments.
  await expect(page.locator(`${DONE_LINE} .pass-notice-detail`)).toHaveText("2 comments and a note to read.");
  await expect(page.locator(DONE_LINE)).toHaveAttribute("title", "Claude is done. Back to you. 2 comments and a note to read.");
  // A card at the top of the panel, above every comment: whom it's from, the note, and Done.
  const note = page.locator(NOTE_CARD);
  await expect(note).toHaveCount(1);
  await expect(page.locator(`${PANEL} .comments-list > .comment-card`).first()).toHaveClass(/pass-note/);
  await expect(note.locator(".comment-whole")).toHaveText("Note from Claude");
  await expect(note.locator(".pass-note-text")).toHaveText(NOTE);
  await expect(note.getByRole("button", { name: "Done", exact: true })).toBeVisible();
  // New, like a comment Claude answered: a dot, and counted with the cards to read.
  await expect(note).toHaveAttribute("aria-label", "Note from Claude, new");
  await expect(note.locator(".card-new")).toBeVisible();
  await expect(page.locator(TURN)).toHaveText("With you · 3 to read");
  // Reading it (a click) takes its dot away, as a comment's; reading isn't working, so the done line stays.
  await note.click();
  await expect(note.locator(".card-new")).toBeHidden();
  await expect(page.locator(TURN)).toHaveText("With you · 2 to read");
  await expect(page.locator(DONE_LINE)).toBeVisible();

  // History keeps it with the version, in brief in the list and whole in the conversation.
  await page.getByRole("button", { name: "History", exact: true }).click();
  const newest = page.locator(`${DOC} .history-panel .history-item`).first();
  await expect(newest.locator(".history-who")).toHaveText("Claude");
  await expect(newest.locator(".history-note")).toHaveText(`Note: ${NOTE}`);
  await newest.locator(".history-who").click();
  await expect(page.locator(`${DOC} .history-panel .history-detail .history-note-text`)).toHaveText(NOTE);
  await page.getByRole("button", { name: "Close history" }).click();

  // It stays until it's marked done, launch after launch (what's there as a document opens counts as read).
  const again = await relaunch(r);
  await expect(again.page.locator(NOTE_CARD)).toHaveCount(1);
  await expect(again.page.locator(`${NOTE_CARD} .card-new`)).toBeHidden();
  await again.page.locator(NOTE_CARD).getByRole("button", { name: "Done", exact: true }).click();
  await expect(again.page.locator(NOTE_CARD)).toHaveCount(0);
  const third = await relaunch(again);
  await expect(third.page.locator(`${PANEL} .comment-card`, { hasText: "Make it three." })).toBeVisible();
  await expect(third.page.locator(NOTE_CARD)).toHaveCount(0);
  // History still has it.
  await third.page.getByRole("button", { name: "History", exact: true }).click();
  await expect(third.page.locator(`${DOC} .history-panel .history-item`).first().locator(".history-note")).toHaveText(`Note: ${NOTE}`);
});

test("a note alone: the document is back like any hand-back, its tab says what's to read, Next Comment goes to the note first, and Review's Resolve marks it done", async () => {
  const r = await start();
  const { page } = r;
  const claude = await agent(r);
  await claude.ok("open_document", { path: r.file });
  await openAlso(r, "notes.md", "My own notes.\n");
  await expect(page.locator('.tab[aria-selected="true"][title$="/notes.md"]')).toBeVisible();
  await claude.ok("take_document", { path: r.file });
  await claude.ok("finish_editing", { path: r.file, note: "I read it through and changed nothing: the numbers add up." });

  // Back on its tab, the dot lit, one thing to read: the note.
  const dot = page.locator('.tab[title$="/plan.md"]').locator(".tab-dot");
  await expect(dot).toHaveAttribute("data-turn", "back");
  await expect(dot).toHaveAttribute("title", "Back from Claude: 1 to read");
  await page.locator('.tab[title$="/plan.md"]').click();
  await expect(page.locator(`${DONE_LINE} .pass-notice-detail`)).toHaveText("A note to read.");
  await expect(page.locator(TURN)).toHaveText("With you · 1 to read");

  // Next Comment goes to it first, with the keyboard resting on it.
  await page.locator(`${DOC} .page.editor .ProseMirror`).click();
  await settle(page);
  await clickMenu(r.app, "review-next");
  const note = page.locator(NOTE_CARD);
  await expect(note).toBeFocused();
  await expect(note).toHaveClass(/active/);
  await expect(page.locator(TURN)).toHaveText("With you");
  // Resolve, from the Review menu, marks it done.
  await clickMenu(r.app, "review-resolve");
  await expect(note).toHaveCount(0);
  await expect(page.locator(`${PANEL} .comments-empty`)).toBeVisible();
});
