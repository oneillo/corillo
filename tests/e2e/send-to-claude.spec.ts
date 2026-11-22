// Send to Claude (roadmap Batch 2, item 1; Orlando's decision D1: "Yes, if
// it can be done without agents polling and with several documents at once").
// An agent that has put a document in front of the person waits on Corillo
// at no cost; the person reviews in their own time and presses Send to
// Claude; the agent wakes holding the document, with their comments. Each
// test runs the real app, hidden, with pretend agent tools speaking to its
// real connector, on throwaway documents and data folders it removes.
import { test, expect, type Page } from "@playwright/test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { captureClipboard, clickMenu, cursorAtEnd, openAlso, openFromFinder, openText, selectText, settle, turnSaid, EDITOR, type Running } from "./helpers";
import { AgentSession } from "./agent-session";

const DOC = ".doc:not([hidden])";
const PANEL = `${DOC} aside.comments-panel`;
const BUTTON = `${PANEL} .comments-hand-back`;
const TURN = "#turn-status .turn-text";
const PLAN = "# Plan\n\nWe should hire two people this quarter.\n\nThe budget is tight.\n";
const NOTES = "# Notes\n\nA few words to comment on.\n";

const card = (page: Page, body: string) => page.locator(`${PANEL} .comment-card:not(.draft)`, { hasText: body });

let run: Running | null = null;
let home: string | null = null;
const sessions: AgentSession[] = [];

async function start(name = "plan.md", text = PLAN): Promise<Running> {
  run = await openText(text, { name });
  home = await run.app.evaluate(() => process.env.CORILLO_HOME ?? null);
  return run;
}

/** A pretend agent tool: Claude Code in a terminal, unless told otherwise. Progress every 300 ms, so a test sees it. */
async function agent(r: Running, client = "claude-code", env: Record<string, string> = {}): Promise<AgentSession> {
  const { session } = await AgentSession.start(r.dataDir, client, { env: { CORILLO_WAIT_PROGRESS_MS: "300", ...env } });
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

/** Leave a comment as the person, on these words. */
async function comment(r: Running, words: string, body: string): Promise<void> {
  await expect(r.page.locator(EDITOR)).toContainText(words);
  await selectText(r.page, words);
  await r.page.getByRole("button", { name: "Comment", exact: true }).click();
  await r.page.getByRole("textbox", { name: "New comment" }).fill(body);
  await r.page.getByRole("button", { name: "Post" }).click();
  await expect(card(r.page, body)).toBeVisible();
}

/** The comment ids a take shows. */
const idsIn = (text: string) => [...text.matchAll(/\[([0-9a-f]+)\] on /g)].map((m) => m[1]);

/** The agent answers every comment it was given, and finishes. */
async function answerAndFinish(claude: AgentSession, file: string, taken: string): Promise<string> {
  for (const id of idsIn(taken)) await claude.ok("reply_to_comment", { path: file, comment_id: id, text: "Done." });
  return claude.ok("finish_editing", { path: file });
}

const showTab = (page: Page, name: string) => page.locator(`.tab[title$="/${name}"]`).click();

test("Claude waits for the review at no cost, the window says so, and Send to Claude wakes it holding the document, with the comments", async () => {
  const r = await start();
  const { page } = r;
  const claude = await agent(r);
  expect(await claude.ok("open_document", { path: r.file })).toContain("then call wait_for_review and end your turn");
  const wait = claude.waitForReview();
  await expect(page.locator(TURN)).toHaveText("Claude is waiting for your review");
  await expect(page.locator("#turn-status")).toHaveAttribute("title", /When you've finished, press Send to Claude in the Comments panel\./);
  // Nothing to send yet.
  await expect(page.locator(BUTTON)).toHaveText("Send to Claude");
  await expect(page.locator(BUTTON)).toBeDisabled();

  await comment(r, "two people", "Make it three.");
  await comment(r, "tight", "Say by how much.");
  // Never "Waiting for Claude" before Claude knows.
  await expect(card(page, "Make it three.")).toHaveAttribute("aria-label", turnSaid("For Claude, not sent yet"));
  await expect(page.locator(BUTTON)).toBeEnabled();

  // Waiting costs nothing: no answer, so no turn for the agent; only a progress message now and then to keep the call alive.
  await expect.poll(() => claude.progress.length, { timeout: 10_000 }).toBeGreaterThanOrEqual(3);
  expect(wait.answered()).toBe(false);
  expect(new Set(claude.progress.map((p) => p.message))).toEqual(new Set(["Waiting for the person's review"]));
  expect(new Set(claude.progress.map((p) => p.token)).size).toBe(1);

  await page.locator(BUTTON).click();
  const text = await wait.text;
  expect(text).toMatch(/^The person sent plan\.md back to you from Corillo\.\n\nYou're editing plan\.md now\./);
  expect(text).toContain("Make it three.");
  expect(text).toContain("Say by how much.");
  await expect(page.locator(TURN)).toHaveText("Claude is editing");
  await expect(card(page, "Make it three.")).toHaveAttribute("aria-label", turnSaid("Sent to Claude"));
  await expect(page.locator(BUTTON)).toBeHidden();
  // Answered: the progress messages stop.
  const sent = claude.progress.length;
  await page.waitForTimeout(900);
  expect(claude.progress.length).toBe(sent);

  expect(await answerAndFinish(claude, r.file, text)).toContain("Then call wait_for_review and end your turn");
  const again = claude.waitForReview();
  await expect(page.locator(TURN)).toHaveText("Claude is waiting for your review · 2 to read");
  await claude.cancel(again.id);
});

test("three documents with three agents are independent, and one agent with two documents gets whichever is sent; a Send while it's busy is kept, and the card says so", async () => {
  const r = await start();
  const { page } = r;
  const notes = await openAlso(r, "notes.md", NOTES);
  const third = await openAlso(r, "third.md", "# Third\n\nMore words here.\n");
  const [one, two, three] = [await agent(r), await agent(r), await agent(r)];
  await one.ok("open_document", { path: r.file });
  await two.ok("open_document", { path: notes });
  await three.ok("open_document", { path: third });
  const waits = [one.waitForReview(), two.waitForReview(), three.waitForReview()];
  await showTab(page, "notes.md");
  await expect(page.locator(TURN)).toHaveText("Claude is waiting for your review");
  await comment(r, "few words", "Fewer words.");
  await page.locator(BUTTON).click();
  expect(await waits[1].text).toContain("The person sent notes.md back to you from Corillo.");
  await page.waitForTimeout(300);
  expect(waits[0].answered()).toBe(false);
  expect(waits[2].answered()).toBe(false);
  await showTab(page, "third.md");
  await expect(page.locator(TURN)).toHaveText("Claude is waiting for your review");
  await one.stop();
  await three.stop();
  await expect(page.locator(TURN)).toBeHidden();

  // One agent looking after plan.md and third.md, with one wait.
  const both = await agent(r);
  await both.ok("open_document", { path: r.file });
  await both.ok("open_document", { path: third });
  const first = both.waitForReview();
  await expect(page.locator(TURN)).toHaveText("Claude is waiting for your review");
  await comment(r, "More words", "Cut this.");
  await page.locator(BUTTON).click();
  const taken = await first.text;
  expect(taken).toContain("The person sent third.md back to you from Corillo.");
  // While it works on third.md, the person sends plan.md: it's kept, and the card says when it starts.
  await showTab(page, "plan.md");
  await comment(r, "two people", "Make it three.");
  await expect(page.locator(BUTTON)).toHaveText("Send to Claude");
  await page.locator(BUTTON).click();
  await expect(card(page, "Make it three.")).toHaveAttribute("aria-label", turnSaid("Sent to Claude: it will start when it has finished third.md"));
  await expect(page.locator(BUTTON)).toHaveText("Sent to Claude");
  await expect(page.locator(BUTTON)).toBeDisabled();
  // Free again, its next wait is answered at once, with plan.md.
  await answerAndFinish(both, third, taken);
  const second = both.waitForReview();
  const next = await second.text;
  expect(next).toMatch(/^The person sent plan\.md back to you from Corillo\.\n\nYou're editing plan\.md now\./);
  expect(next).toContain("Make it three.");
  await expect(page.locator(TURN)).toHaveText("Claude is editing");
  await expect(card(page, "Make it three.")).toHaveAttribute("aria-label", turnSaid("Sent to Claude"));
});

test("once the person resolves the comment sent to a busy agent, the button stops saying it was sent, and the agent isn't woken for it (roadmap Batch 6)", async () => {
  const r = await start();
  const { page } = r;
  const notes = await openAlso(r, "notes.md", NOTES);
  const claude = await agent(r);
  await claude.ok("open_document", { path: r.file });
  await claude.ok("open_document", { path: notes });
  const first = claude.waitForReview();
  await showTab(page, "notes.md");
  await comment(r, "few words", "Fewer words.");
  await page.locator(BUTTON).click();
  const taken = await first.text;
  // While it works on notes.md, the person sends plan.md, then resolves the one comment it was for.
  await showTab(page, "plan.md");
  await comment(r, "two people", "Make it three.");
  await page.locator(BUTTON).click();
  await expect(page.locator(BUTTON)).toHaveText("Sent to Claude");
  await card(page, "Make it three.").getByRole("button", { name: "Resolve", exact: true }).click();
  await expect(page.locator(BUTTON)).toHaveText("Send to Claude");
  await expect(page.locator(BUTTON)).toBeDisabled();
  // Free again, it waits: plan.md has nothing for it, so it isn't woken for it.
  await answerAndFinish(claude, notes, taken);
  const second = claude.waitForReview();
  await expect(page.locator(TURN)).toHaveText("Claude is waiting for your review");
  await page.waitForTimeout(500);
  expect(second.answered()).toBe(false);
});

/** Where the keyboard is: "nowhere", "document", or the name of the control it is on. */
const keyboard = (page: Page) =>
  page.evaluate(() => {
    const a = document.activeElement as HTMLElement | null;
    if (!a || a === document.body) return "nowhere";
    if (a.closest(".ProseMirror")) return "document";
    return (a.getAttribute("aria-label") || a.textContent || "").trim();
  });

/**
 * plan.md and notes.md open, the agent busy on notes.md. The person sends
 * plan.md by keys from its page (kept for the busy agent). `resolve`: then he
 * resolves the one comment it was for, so the Send is let go, and the agent,
 * done with notes.md, takes plan.md because it was asked to in its chat.
 * Otherwise the agent, done, waits and is woken by the kept Send. Where the
 * keyboard is once the page has locked (S21-8).
 */
async function keyboardAfterTake(resolve: boolean, send = true): Promise<string> {
  const r = await start();
  const { page } = r;
  const notes = await openAlso(r, "notes.md", NOTES);
  const claude = await agent(r);
  await claude.ok("open_document", { path: r.file });
  await claude.ok("open_document", { path: notes });
  const first = claude.waitForReview();
  await showTab(page, "notes.md");
  await comment(r, "few words", "Fewer words.");
  await page.locator(BUTTON).click();
  const taken = await first.text;
  await showTab(page, "plan.md");
  await comment(r, "two people", "Make it three.");
  if (send) {
    await cursorAtEnd(page, "The budget is tight.");
    expect(await keyboard(page)).toBe("document");
    await page.keyboard.press("Shift+Meta+d"); // Review > Send to Claude, by its keys, from the page
    await expect(page.locator(BUTTON)).toHaveText("Sent to Claude");
  }
  if (resolve) {
    await card(page, "Make it three.").getByRole("button", { name: "Resolve", exact: true }).click();
    if (send) await expect(page.locator(BUTTON)).toHaveText("Send to Claude"); // the Send is let go
    await expect(card(page, "Make it three.")).toHaveCount(0);
  }
  await answerAndFinish(claude, notes, taken);
  await cursorAtEnd(page, "The budget is tight.");
  await expect.poll(() => keyboard(page)).toBe("document");
  if (resolve) await claude.ok("take_document", { path: r.file, request: "Tidy the plan." });
  else expect(await claude.waitForReview().text).toContain("Make it three.");
  await expect(page.locator(TURN)).toHaveText("Claude is editing");
  await page.waitForTimeout(400); // past the lock, and anything that moves the keyboard after it
  return keyboard(page);
}

test("an agent that takes the document from its chat leaves the keyboard where it was, with or without a Send by keys before it that was let go (S21-8)", async () => {
  expect(await keyboardAfterTake(true, false)).toBe("nowhere"); // the page is locked; it comes back to the page when the agent is done
});

test("a Send by keys kept for a busy agent, then let go: the agent's take from its chat still doesn't move the keyboard to New comment (S21-8)", async () => {
  expect(await keyboardAfterTake(true)).toBe("nowhere");
});

test("a Send by keys kept for a busy agent and delivered when it is free moves the keyboard to New comment, as a Send that wakes it at once does", async () => {
  expect(await keyboardAfterTake(false)).toBe("New comment");
});

test("a wait cut short ends quietly, and the button becomes Copy for Claude: cancelled, the connector's own time limit, the session gone", async () => {
  const r = await start();
  const { page } = r;
  await comment(r, "two people", "Make it three.");

  // Cancelled (the person pressed Esc in the agent's chat): no answer, no turn for the agent.
  const esc = await agent(r);
  await esc.ok("read_document", { path: r.file });
  const a = esc.waitForReview();
  await expect(page.locator(BUTTON)).toHaveText("Send to Claude");
  await esc.cancel(a.id);
  await expect(page.locator(BUTTON)).toHaveText("Copy for Claude");
  await expect(page.locator(TURN)).toBeHidden();
  await page.waitForTimeout(500);
  expect(a.answered()).toBe(false);
  await esc.stop();

  // The connector ends a wait itself, well inside the agent tool's limits, in words that end it.
  const timed = await agent(r, "claude-code", { CORILLO_WAIT_LIMIT_MS: "1500" });
  await timed.ok("read_document", { path: r.file });
  const b = timed.waitForReview();
  await expect(page.locator(BUTTON)).toHaveText("Send to Claude");
  expect(await b.text).toBe(
    "Stopped listening for the person's review of plan.md. Say once in the chat that you've stopped listening; don't call wait_for_review again unless they ask.",
  );
  await expect(page.locator(BUTTON)).toHaveText("Copy for Claude");
  await timed.stop();

  // The agent's session ended (its terminal closed).
  const gone = await agent(r);
  await gone.ok("read_document", { path: r.file });
  gone.waitForReview();
  await expect(page.locator(BUTTON)).toHaveText("Send to Claude");
  await gone.stop();
  await expect(page.locator(BUTTON)).toHaveText("Copy for Claude");
  await expect(card(page, "Make it three.")).toHaveAttribute("aria-label", turnSaid("Not sent to an agent yet"));
});

test("a Send the agent never gets is never dropped without a word: when it stops listening first, the panel says so and offers Copy for Claude (B2-01)", async () => {
  // The little while an agent has to wait again after a pass, shortened for the test.
  process.env.CORILLO_WAIT_GRACE_MS = "4000";
  let r: Running;
  try {
    r = await start();
  } finally {
    delete process.env.CORILLO_WAIT_GRACE_MS;
  }
  const { page } = r;
  const copied = await captureClipboard(r.app);
  const notes = await openAlso(r, "notes.md", NOTES);
  const claude = await agent(r);
  await claude.ok("open_document", { path: r.file });
  await claude.ok("open_document", { path: notes });
  const first = claude.waitForReview();
  await showTab(page, "notes.md");
  await comment(r, "few words", "Fewer words.");
  await page.locator(BUTTON).click();
  const taken = await first.text;
  expect(taken).toContain("The person sent notes.md back to you from Corillo.");

  // While it works on notes.md, the person sends plan.md: kept for it.
  await showTab(page, "plan.md");
  await comment(r, "two people", "Make it three.");
  await page.locator(BUTTON).click();
  await expect(card(page, "Make it three.")).toHaveAttribute("aria-label", turnSaid("Sent to Claude: it will start when it has finished notes.md"));

  // It finishes notes.md and doesn't wait again.
  await answerAndFinish(claude, notes, taken);
  await showTab(page, "notes.md");
  // Not waiting: notes.md doesn't say it is (it never claims more than is true).
  await expect(page.locator(TURN)).toHaveText(/^With you/);
  await showTab(page, "plan.md");
  await expect(card(page, "Make it three.")).toHaveAttribute("aria-label", turnSaid("Sent to Claude"));

  // The little while runs out: plan.md says the comments never reached it, and the button copies the message instead.
  const why = page.locator(`${PANEL} .comments-hand-back-why`);
  await expect(why).toHaveText("Claude stopped listening before it got your comments. Press Copy for Claude, then paste it in Claude's chat.", { timeout: 10_000 });
  await expect(page.locator(BUTTON)).toHaveText("Copy for Claude");
  await expect(page.locator(BUTTON)).toBeEnabled();
  await expect(card(page, "Make it three.")).toHaveAttribute("aria-label", turnSaid("For Claude, not sent yet"));
  await page.locator(BUTTON).click();
  await expect.poll(copied).toBe(`There's feedback for you in Corillo on “plan.md” (${r.file}): 1 comment.`);
  await expect(why).toBeHidden();
});

test("a Send that fails in Corillo is never silent: the panel says it didn't go (W-Q4)", async () => {
  const r = await start();
  const { page } = r;
  const claude = await agent(r);
  await claude.ok("open_document", { path: r.file });
  claude.waitForReview();
  await comment(r, "two people", "Make it three.");
  await expect(page.locator(BUTTON)).toBeEnabled();
  // The app's Send fails outright, as it would if the comments couldn't be read.
  await r.app.evaluate(({ ipcMain }) => {
    ipcMain.removeHandler("agent:send");
    ipcMain.handle("agent:send", () => {
      throw new Error("the comments couldn't be read");
    });
  });
  await page.locator(BUTTON).click();
  // Its own words (roadmap Batch 10, item 3, W-Q4): Claude is still waiting, and Send is still there to press again.
  await expect(page.locator(`${PANEL} .comments-note`)).toHaveText("Corillo couldn't send this to Claude. Try again.");
  await expect(page.locator(BUTTON)).toHaveText("Send to Claude");
  await expect(page.locator(BUTTON)).toBeEnabled();
  await expect(page.locator(TURN)).toHaveText("Claude is waiting for your review");
});

test("a wait names a document as take_document does: a bare name is the file in the agent's own folder, not another open one of that name (B2-05)", async () => {
  const r = await start();
  const { page } = r;
  const elsewhere = mkdtempSync(join(tmpdir(), "corillo-other-"));
  try {
    const other = join(elsewhere, "plan.md");
    writeFileSync(other, "# Another plan\n\nNot this one.\n");
    await openFromFinder(r.app, other);
    await expect(page.locator(".tab")).toHaveCount(2);
    const { session } = await AgentSession.start(r.dataDir, "claude-code", { env: { CORILLO_WAIT_PROGRESS_MS: "300" }, cwd: r.folder });
    sessions.push(session);
    const wait = session.waitForReview({ paths: ["plan.md"] });
    await page.locator(".tab").nth(0).click();
    await expect(page.locator(TURN)).toHaveText("Claude is waiting for your review");
    await page.locator(".tab").nth(1).click();
    await expect(page.locator(TURN)).toBeHidden();
    expect(wait.answered()).toBe(false);
    await session.cancel(wait.id);
  } finally {
    rmSync(elsewhere, { recursive: true, force: true });
  }
});

test("an agent tool that can't wait is answered at once, and Copy for Claude copies the sentence for its chat", async () => {
  const r = await start();
  const { page } = r;
  const copied = await captureClipboard(r.app);
  // Claude Desktop cuts a call at 240 seconds; Claude Code run with -p never moves a call to the background.
  for (const [client, env] of [["claude-ai", {}], ["claude-code", { CLAUDE_CODE_ENTRYPOINT: "sdk-cli" }]] as const) {
    const s = await agent(r, client, env);
    expect(await s.ok("open_document", { path: r.file })).not.toContain("wait_for_review");
    expect(await s.waitForReview().text).toBe(
      "Corillo can't wait for the person's review in this app: the call would be cut off. Tell them in the chat that when they've finished commenting they can tell you here. Don't call wait_for_review again in this chat.",
    );
    expect(s.progress).toEqual([]);
  }
  await expect(page.locator(TURN)).toBeHidden();
  await comment(r, "two people", "Make it three.");
  await comment(r, "tight", "Say by how much.");
  await expect(card(page, "Make it three.")).toHaveAttribute("aria-label", turnSaid("For Claude, not sent yet"));
  await expect(page.locator(BUTTON)).toHaveText("Copy for Claude");
  await page.locator(BUTTON).click();
  await expect.poll(copied).toBe(`There's feedback for you in Corillo on “plan.md” (${r.file}): 2 comments.`);
  await expect(page.locator(`${PANEL} .comments-note`)).toHaveText("Copied. Paste it in Claude's chat.");
});

test("Review > Send to Claude and its shortcut send it, a comment not yet posted is never left behind, and the chat works as before", async () => {
  const r = await start();
  const { page } = r;
  const claude = await agent(r);
  await claude.ok("open_document", { path: r.file });
  const menuLabel = () =>
    r.app.evaluate(({ Menu }) => {
      const item = Menu.getApplicationMenu()!.getMenuItemById("review-send")!;
      return { label: item.label, enabled: item.enabled };
    });

  // From the menu.
  const first = claude.waitForReview();
  await comment(r, "two people", "Make it three.");
  await expect.poll(menuLabel).toEqual({ label: "Send to Claude", enabled: true });
  await clickMenu(r.app, "review-send");
  const taken = await first.text;
  expect(taken).toContain("The person sent plan.md back to you from Corillo.");
  await expect.poll(menuLabel).toEqual({ label: "Send to Claude", enabled: false });
  await answerAndFinish(claude, r.file, taken);

  // A comment typed and not posted: Send asks for it first, and nothing goes.
  const second = claude.waitForReview();
  await comment(r, "tight", "Say by how much.");
  await selectText(page, "budget");
  await page.getByRole("button", { name: "Comment", exact: true }).click();
  await page.getByRole("textbox", { name: "New comment" }).fill("And when?");
  await page.locator(BUTTON).click();
  await expect(page.locator(`${PANEL} .comments-note`)).toHaveText("Post or cancel your comment first, so it goes too.");
  await page.waitForTimeout(300);
  expect(second.answered()).toBe(false);
  await page.getByRole("button", { name: "Post" }).click();
  await expect(card(page, "And when?")).toBeVisible();

  // From the keyboard: ⇧⌘D.
  await page.locator(`${EDITOR} p`, { hasText: "budget" }).click();
  await settle(page);
  await page.keyboard.press("Meta+Shift+D");
  const next = await second.text;
  expect(next).toContain("Say by how much.");
  expect(next).toContain("And when?");
  await answerAndFinish(claude, r.file, next);
  await claude.stop();

  // The chat, as before: an agent that never waits, told in its chat, takes the document itself.
  const chat = await agent(r, "claude-ai");
  await chat.ok("read_document", { path: r.file });
  await comment(r, "We should", "Start with why.");
  await expect(card(page, "Start with why.")).toHaveAttribute("aria-label", turnSaid("For Claude, not sent yet"));
  const own = await chat.ok("take_document", { path: r.file });
  expect(own).toContain("Start with why.");
  await expect(card(page, "Start with why.")).toHaveAttribute("aria-label", turnSaid("Sent to Claude"));
  expect(await answerAndFinish(chat, r.file, own)).toBe(
    "Done. plan.md is back with the person. They read your replies in Corillo, so in the chat a line is enough: that it's back, and anything they must decide. Tell them too that they can reply on any comment in Corillo and tell you here when there's more.",
  );
});
