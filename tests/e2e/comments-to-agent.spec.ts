// Comments go to the agent you told (roadmap Batch 3, item 3; Orlando's
// decision D3): a comment with no @ goes to the first agent that picks
// comments up after the person wrote it, not to whichever session looked at
// the document first. A new chat shows as plain "Claude" when no other Claude
// is in a round. An agent with a role name (Writer) takes only its @ comments
// while another agent is on the document, and a round that finds nothing says
// why. Each test runs the real app, hidden, with pretend agent tools speaking
// to its real connector, on throwaway documents and data folders it removes.
import { test, expect, type Page } from "@playwright/test";
import { rmSync } from "node:fs";
import { listed, openText, selectText, turnSaid, EDITOR, type Running } from "./helpers";
import { AgentSession } from "./agent-session";

const DOC = ".doc:not([hidden])";
const PANEL = `${DOC} aside.comments-panel`;
const BUTTON = `${PANEL} .comments-hand-back`;
const TURN = "#turn-status .turn-text";
const DONE_LINE = `${DOC} .pass-notice`;
const PLAN = "# Plan\n\nWe should hire two people this quarter.\n\nThe budget is tight.\n";

const card = (page: Page, body: string) => page.locator(`${PANEL} .comment-card:not(.draft)`, { hasText: body });

let run: Running | null = null;
let home: string | null = null;
const sessions: AgentSession[] = [];

async function start(): Promise<Running> {
  run = await openText(PLAN, { name: "plan.md" });
  home = await run.app.evaluate(() => process.env.CORILLO_HOME ?? null);
  return run;
}

async function agent(r: Running, client = "claude-code"): Promise<AgentSession> {
  const { session } = await AgentSession.start(r.dataDir, client, { env: { CORILLO_WAIT_PROGRESS_MS: "300" } });
  sessions.push(session);
  return session;
}

test.afterEach(async () => {
  for (const s of sessions.splice(0)) await s.stop().catch(() => undefined);
  const r = run;
  run = null;
  if (!r) return;
  await r.app.evaluate(({ app }) => setTimeout(() => app.exit(0), 10)).catch(() => undefined);
  await r.app.close().catch(() => undefined);
  for (const dir of [r.folder, r.dataDir, home]) if (dir) rmSync(dir, { recursive: true, force: true });
  home = null;
});

async function comment(r: Running, words: string, body: string): Promise<void> {
  await expect(r.page.locator(EDITOR)).toContainText(words);
  await selectText(r.page, words);
  await r.page.getByRole("button", { name: "Comment", exact: true }).click();
  await r.page.getByRole("textbox", { name: "New comment" }).fill(body);
  await r.page.getByRole("button", { name: "Post" }).click();
  await expect(card(r.page, body)).toBeVisible();
}

const idsIn = (text: string) => [...text.matchAll(/\[([0-9a-f]+)\] on /g)].map((m) => m[1]);

/** The agents the @ list offers in a new comment on these words. */
async function agentsListed(page: Page, words: string): Promise<string[]> {
  await selectText(page, words);
  await page.getByRole("button", { name: "Comment", exact: true }).click();
  await page.keyboard.type("@");
  await expect.poll(() => listed(page)).not.toEqual([]);
  const names = await listed(page);
  await page.keyboard.press("Escape");
  await page.getByRole("button", { name: "Cancel" }).click();
  return names;
}

test("an old session opened the document; the person comments, and the chat they told takes it and gets both; the old one gets none", async () => {
  const r = await start();
  const { page } = r;
  const yesterday = await agent(r); // left open from an earlier chat: the first to look
  await yesterday.ok("open_document", { path: r.file });
  await comment(r, "two people", "Make this three people.");
  await comment(r, "budget is tight", "And say by how much.");
  await expect(card(page, "Make this three people.")).toHaveAttribute("aria-label", turnSaid("For Claude, not sent yet"));

  const today = await agent(r); // the chat the person told
  const taken = await today.ok("take_document", { path: r.file });
  expect(idsIn(taken)).toHaveLength(2);
  expect(taken).toContain("Make this three people.");
  expect(taken).toContain("And say by how much.");
  // The window shows the chat the person told as plain Claude, editing, with both.
  await expect(page.locator(TURN)).toHaveText("Claude is editing");
  await expect(card(page, "Make this three people.")).toHaveAttribute("aria-label", turnSaid("Sent to Claude"));
  await expect(card(page, "And say by how much.")).toHaveAttribute("aria-label", turnSaid("Sent to Claude"));

  // The old session gets none, and is told where they went.
  const old = await yesterday.ok("list_comments", { path: r.file });
  expect(old).toContain("No comments on plan.md are waiting for you.");
  expect(old).toContain("2 comments on plan.md have no @ and went to Claude, another session that picked them up first.");
  for (const id of idsIn(taken)) await today.ok("reply_to_comment", { path: r.file, comment_id: id, text: "Done." });
  await today.ok("finish_editing", { path: r.file });
  await expect(page.locator(TURN)).toHaveText(/^With you/);
  await expect(card(page, "Make this three people.")).toHaveAttribute("aria-label", turnSaid("Waiting for you"));
});

test("with two chats of Claude, a comment is shown for the one waiting for the review, and Send to Claude wakes that one", async () => {
  const r = await start();
  const { page } = r;
  const yesterday = await agent(r);
  await yesterday.ok("open_document", { path: r.file });
  const today = await agent(r); // a new chat: plain Claude, the old one Claude 2
  expect(await today.ok("open_document", { path: r.file })).not.toContain("Your comments there show as");
  const wait = today.waitForReview();
  await expect(page.locator(TURN)).toHaveText("Claude is waiting for your review");
  await comment(r, "two people", "Make it three.");
  await expect(card(page, "Make it three.")).toHaveAttribute("aria-label", turnSaid("For Claude, not sent yet"));
  await expect(page.locator(BUTTON)).toHaveText("Send to Claude");
  await page.locator(BUTTON).click();
  const woke = await wait.text;
  expect(woke).toContain("Make it three.");
  await expect(card(page, "Make it three.")).toHaveAttribute("aria-label", turnSaid("Sent to Claude"));
  expect(await yesterday.ok("list_comments", { path: r.file })).toContain("No comments on plan.md are waiting for you.");
  for (const id of idsIn(woke)) await today.ok("reply_to_comment", { path: r.file, comment_id: id, text: "Done." });
  await today.ok("finish_editing", { path: r.file });
});

test("Writer takes only its @ comments while Claude is on the document; its empty round says whom the comments are for", async () => {
  const r = await start();
  const { page } = r;
  const claude = await agent(r);
  await claude.ok("open_document", { path: r.file });
  const writer = await agent(r, "writer-tool");
  await writer.ok("introduce", { name: "Writer" });
  await writer.ok("open_document", { path: r.file });
  expect((await agentsListed(page, "budget is tight")).slice(0, 2)).toEqual(["Claude, connected, default", "Writer, connected"]);
  await comment(r, "two people", "Make it three.");
  const taken = await writer.ok("take_document", { path: r.file });
  expect(taken).toContain("No comments on plan.md are waiting for you.");
  expect(taken).toContain("1 comment on plan.md has no @, so it's for Claude, also on it: you take only comments that name you (@Writer).");
  await writer.ok("finish_editing", { path: r.file });
  await expect(page.locator(`${DONE_LINE} .pass-notice-lead`)).toHaveText("Writer found nothing addressed to it.");
  await expect(page.locator(`${DONE_LINE} .pass-notice-detail`)).toHaveText("1 comment is for Claude.");
  await expect(card(page, "Make it three.")).toHaveAttribute("aria-label", turnSaid("For Claude, not sent yet"));

  // Once Claude has it, the line says it's waiting for Claude.
  expect(await claude.ok("list_comments", { path: r.file })).toContain("Make it three.");
  await writer.ok("take_document", { path: r.file });
  await writer.ok("finish_editing", { path: r.file });
  await expect(page.locator(`${DONE_LINE} .pass-notice-detail`)).toHaveText("1 comment is waiting for Claude.");
});
