// Step 4: comments in the window. Comments live in Corillo's data folder,
// never in the Markdown file. Each test runs the real app on a throwaway
// document with a throwaway data folder.
import { test, expect, type Page } from "@playwright/test";
import { existsSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { gunzipSync } from "node:zlib";
import { openText, cursorAtEnd, clickMenu, expectFile, listed, messageAction, selectText, settle, EDITOR, type Running } from "./helpers";
import type { Thread } from "../../src/core/comments";

const PANEL = ".doc:not([hidden]) aside.comments-panel";

const card = (page: Page, text: string) => page.locator(`${PANEL} .comment-card:not(.draft)`, { hasText: text });
const draft = (page: Page) => page.locator(`${PANEL} .comment-card.draft`);
const highlights = (page: Page) => page.locator(`${EDITOR} .comment-range`).allTextContents();
const commentButton = (page: Page) => page.getByRole("button", { name: "Comment", exact: true });

/** Select text, choose Comment, write the comment and post it. */
async function comment(run: Running, text: string, body: string): Promise<void> {
  await selectText(run.page, text);
  await commentButton(run.page).click();
  const box = run.page.getByRole("textbox", { name: "New comment" });
  await expect(box).toBeFocused();
  await box.fill(body);
  await run.page.getByRole("button", { name: "Post" }).click();
  await expect(card(run.page, body)).toBeVisible();
}

/** The comments as Corillo keeps them, in its data folder. */
async function storedThreads(run: Running): Promise<Thread[]> {
  const dir = await run.app.evaluate(({ app }) => app.getPath("userData"));
  const index = JSON.parse(readFileSync(join(dir, "documents.json"), "utf8")) as Record<string, { path: string }>;
  const id = Object.keys(index).find((k) => index[k].path === run.file);
  const file = join(dir, "documents", id ?? "none", "comments.json.gz");
  return existsSync(file) ? (JSON.parse(gunzipSync(readFileSync(file)).toString("utf8")) as Thread[]) : [];
}

/** Send the window an event from the app, as the agents' side will. */
async function sendToWindow(run: Running, channel: string, payload: unknown): Promise<void> {
  const docId = await run.page.locator(".doc:not([hidden])").getAttribute("data-doc-id");
  await run.app.evaluate(
    ({ BrowserWindow }, [ch, id, data]) => BrowserWindow.getAllWindows()[0].webContents.send(ch, id, data),
    [channel, docId, payload] as const,
  );
}

test("selecting text and choosing Comment adds a comment on that text, and the Markdown file stays as it was", async () => {
  const DOC = "# Plan\n\nWe should hire two people this spring.\n";
  const run = await openText(DOC);
  const before = statSync(run.file).mtimeMs;
  // The panel is open from the start, with a word on how to begin.
  await expect(run.page.locator(PANEL)).toBeVisible();
  await expect(run.page.locator(`${PANEL} .comments-empty`)).toContainText("Select some words, then choose New comment");
  await comment(run, "two people", "Is two enough?");
  await expect(run.page.locator(`${PANEL} .comments-empty`)).toBeHidden();
  await expect.poll(() => highlights(run.page)).toEqual(["two people"]);
  const c = card(run.page, "Is two enough?");
  await expect(c.locator(".comment-quote")).toHaveText("two people");
  await expect(c.locator(".comment-author")).toHaveText("You");
  await expect(c.locator(".comment-time")).toHaveText("Just now"); // said as History says it
  await run.page.waitForTimeout(1200);
  expect(run.text()).toBe(DOC);
  expect(statSync(run.file).mtimeMs).toBe(before);
  const stored = await storedThreads(run);
  expect(stored).toHaveLength(1);
  expect(stored[0].anchor?.quote).toBe("two people");
  expect(stored[0].messages[0].body).toBe("Is two enough?");
  await run.app.close();
});

test("a comment made with nothing selected is on the whole document, and is listed first", async () => {
  const run = await openText("Intro.\n\nMore text here.\n");
  await comment(run, "More", "Tighten this.");
  await cursorAtEnd(run.page, "Intro.");
  await commentButton(run.page).click();
  await expect(draft(run.page).locator(".comment-whole")).toHaveText("Whole document");
  await run.page.getByRole("textbox", { name: "New comment" }).fill("Overall: a good start.");
  await run.page.getByRole("button", { name: "Post" }).click();
  const cards = run.page.locator(`${PANEL} .comment-card`);
  await expect(cards).toHaveCount(2);
  await expect(cards.nth(0).locator(".comment-whole")).toHaveText("Whole document");
  await expect(cards.nth(0)).toContainText("Overall: a good start.");
  await expect(cards.nth(1)).toContainText("Tighten this.");
  expect(await highlights(run.page)).toEqual(["More"]);
  expect(run.text()).toBe("Intro.\n\nMore text here.\n");
  const stored = await storedThreads(run);
  expect(stored.find((t) => t.messages[0].body === "Overall: a good start.")?.anchor).toBeNull();
  await run.app.close();
});

test("Cmd+Option+M with nothing selected starts a whole-document comment; Insert, Comment works too", async () => {
  const run = await openText("Draft text.\n");
  await cursorAtEnd(run.page, "Draft text.");
  await run.page.keyboard.press("Meta+Alt+KeyM");
  const box = run.page.getByRole("textbox", { name: "New comment" });
  await expect(box).toBeFocused();
  await expect(draft(run.page).locator(".comment-whole")).toHaveText("Whole document");
  // No agents on the document yet, so there's nobody to choose.
  await expect(run.page.getByRole("combobox", { name: "To" })).toHaveCount(0);
  await run.page.keyboard.type("Needs a conclusion.");
  await run.page.keyboard.press("Meta+Enter");
  await expect(card(run.page, "Needs a conclusion.").locator(".comment-whole")).toHaveText("Whole document");
  await expect(draft(run.page)).toHaveCount(0);

  await selectText(run.page, "Draft");
  await clickMenu(run.app, "comment-add");
  await expect(run.page.getByRole("textbox", { name: "New comment" })).toBeFocused();
  await expect(draft(run.page).locator(".comment-quote")).toHaveText("Draft");
  await run.app.close();
});

test("an empty comment is thrown away on Escape or on clicking elsewhere; one with words in it stays", async () => {
  const run = await openText("Some words to comment on.\n");
  await selectText(run.page, "words");
  await run.page.keyboard.press("Meta+Alt+KeyM");
  await expect(draft(run.page)).toBeVisible();
  expect(await highlights(run.page)).toEqual(["words"]);
  await run.page.keyboard.press("Escape");
  await expect(draft(run.page)).toHaveCount(0);
  expect(await highlights(run.page)).toEqual([]);
  await expect(run.page.locator(`${PANEL} .comments-empty`)).toBeVisible();

  await selectText(run.page, "comment");
  await run.page.keyboard.press("Meta+Alt+KeyM");
  await expect(draft(run.page)).toBeVisible();
  await run.page.locator(`${EDITOR} p`).click();
  await expect(draft(run.page)).toHaveCount(0);
  expect(await highlights(run.page)).toEqual([]);

  await selectText(run.page, "Some");
  await run.page.keyboard.press("Meta+Alt+KeyM");
  await run.page.keyboard.type("Keep me");
  await run.page.locator(`${EDITOR} p`).click();
  await run.page.waitForTimeout(200);
  await expect(run.page.getByRole("textbox", { name: "New comment" })).toHaveValue("Keep me");
  expect(await highlights(run.page)).toEqual(["Some"]);
  expect(await storedThreads(run)).toEqual([]);
  // Closing asks about it first (answered here with Close Anyway).
  await answerNext(run, 1);
  await run.app.close();
});

// Changed 2026-11-09: Edit and Delete moved from words under the message into its "⋯" menu (Orlando's request).
// Changed 2026-11-12 (Orlando, roadmap Batch 9, item 4): "I also don't want to have to confirm a delete. Deleting
// a comment requires enough intentionality given the friction that we don't need to put a gate on it".
test("you can edit and delete your own comment: Delete deletes it at once, with no question", async () => {
  const run = await openText("Budget is tight this year.\n");
  await comment(run, "tight", "Say by how much.");
  const c = run.page.locator(`${PANEL} .comment-card`).first();
  await messageAction(c, "Edit");
  const box = run.page.getByRole("textbox", { name: "Edit comment" });
  await expect(box).toBeFocused();
  await box.fill("Say by how much, in euros.");
  await c.getByRole("button", { name: "Save" }).click();
  await expect(c.locator(".comment-body")).toHaveText("Say by how much, in euros.");
  await expect(c.locator(".comment-edited")).toHaveText("Edited");
  await expect.poll(async () => (await storedThreads(run))[0]?.messages[0].body).toBe("Say by how much, in euros.");

  // Delete: gone at once, no question asked.
  await messageAction(c, "Delete");
  await expect(run.page.locator(`${PANEL} .comment-card`)).toHaveCount(0);
  await expect(run.page.locator(PANEL)).not.toContainText("Delete this");
  await expect.poll(() => highlights(run.page)).toEqual([]);
  expect(await storedThreads(run)).toEqual([]);
  expect(run.text()).toBe("Budget is tight this year.\n");
  await run.app.close();
});

test("Undo straight after Delete brings the comment back on its words, as it was, in focus; the next Undo takes back typing as usual", async () => {
  const run = await openText("Budget is tight this year. We start in May.\n");
  const { page } = run;
  await comment(run, "tight", "Say by how much.");
  await comment(run, "May", "Is May firm?");
  const c = card(page, "Say by how much.");
  await c.locator(".comment-body").click();
  await c.getByRole("textbox", { name: "Reply" }).fill("And in euros.");
  await c.getByRole("button", { name: "Reply", exact: true }).click();
  await expect(c.locator(".comment-message")).toHaveCount(2);
  await cursorAtEnd(page, "May");
  await page.keyboard.type(" Mine.");
  await expectFile(run, "Budget is tight this year. We start in May. Mine.\n");
  await expect.poll(async () => (await storedThreads(run))[0]?.messages.length).toBe(2);
  const before = await storedThreads(run);

  // Delete with the mouse, then Command-Z: the comment and its reply come back, on their words, in focus.
  await messageAction(c.locator(".comment-message").first(), "Delete");
  await expect(c).toHaveCount(0);
  await expect.poll(() => highlights(page)).toEqual(["May"]);
  await expect.poll(async () => (await storedThreads(run)).length).toBe(1);
  await page.keyboard.press("Meta+z");
  await expect(c).toBeVisible();
  await expect(c.locator(".comment-body")).toHaveText(["Say by how much.", "And in euros."]);
  await expect(c).toHaveClass(/active/);
  await expect.poll(() => highlights(page)).toEqual(["tight", "May"]);
  await expect.poll(() => storedThreads(run)).toEqual(before);
  // The typing is untouched; the next Undo takes it back as usual, and the comment stays.
  await expectFile(run, "Budget is tight this year. We start in May. Mine.\n");
  await page.keyboard.press("Meta+z");
  await expectFile(run, "Budget is tight this year. We start in May.\n");
  await expect(c).toBeVisible();
  await expect(card(page, "Is May firm?")).toBeVisible();

  // Kept through closing and opening the document again.
  await clickMenu(run.app, "close-tab");
  await page.evaluate((p) => window.corillo.openPath(p), run.file);
  await expect(card(page, "Say by how much.")).toBeVisible();
  await expect(card(page, "Say by how much.").locator(".comment-body")).toHaveText(["Say by how much.", "And in euros."]);
  await run.app.close();
});

test("Undo straight after deleting a reply brings it back in its place; after Review > Delete Comment, the toolbar's Undo and Edit > Undo work too; anything done in between lets it go", async () => {
  const run = await openText("Budget is tight this year. We start in May.\n");
  const { page, app } = run;
  await comment(run, "tight", "Say by how much.");
  await comment(run, "May", "Is May firm?");
  const c = card(page, "Say by how much.");
  await c.locator(".comment-body").click();
  for (const reply of ["And in euros.", "Or as a share."]) {
    await c.getByRole("textbox", { name: "Reply" }).fill(reply);
    await c.getByRole("button", { name: "Reply", exact: true }).click();
  }
  await expect(c.locator(".comment-body")).toHaveText(["Say by how much.", "And in euros.", "Or as a share."]);
  await expect.poll(async () => (await storedThreads(run))[0]?.messages.length).toBe(3);
  const before = await storedThreads(run);

  // The reply in the middle: it goes at once, and Command-Z puts it back where it was, the keyboard back on the card.
  await messageAction(c.locator(".comment-message").nth(1), "Delete");
  await expect(c.locator(".comment-body")).toHaveText(["Say by how much.", "Or as a share."]);
  await page.keyboard.press("Meta+z");
  await expect(c.locator(".comment-body")).toHaveText(["Say by how much.", "And in euros.", "Or as a share."]);
  await expect.poll(() => storedThreads(run)).toEqual(before);

  // Review > Delete Comment, at once too; the toolbar's Undo brings it back.
  await c.locator(".comment-body").first().click();
  await clickMenu(app, "review-delete");
  await expect(c).toHaveCount(0);
  await page.getByRole("button", { name: "Undo", exact: true }).click();
  await expect(c).toBeVisible();
  await expect.poll(() => storedThreads(run)).toEqual(before);

  // Edit > Undo (the Mac's own, sent to the page, there once something has been typed) brings it back too;
  // the keyboard went back to the document with the "⋯" gone, and the typing stays.
  await cursorAtEnd(page, "May");
  await page.keyboard.type(" Mine.");
  await messageAction(card(page, "Is May firm?").locator(".comment-message").first(), "Delete");
  await expect(card(page, "Is May firm?")).toHaveCount(0);
  await expect(page.locator(`${EDITOR} .ProseMirror`)).toBeFocused();
  await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].webContents.undo());
  await expect(card(page, "Is May firm?")).toBeVisible();
  await expect.poll(async () => (await storedThreads(run)).map((t) => t.messages[0].body)).toEqual(["Say by how much.", "Is May firm?"]);
  await expectFile(run, "Budget is tight this year. We start in May. Mine.\n");

  // A click in the page in between: Undo is back to undoing typing, and the comment stays deleted.
  await messageAction(card(page, "Is May firm?").locator(".comment-message").first(), "Delete");
  await expect(card(page, "Is May firm?")).toHaveCount(0);
  await cursorAtEnd(page, "May");
  await page.keyboard.press("Meta+z");
  await expectFile(run, "Budget is tight this year. We start in May.\n");
  await expect(card(page, "Is May firm?")).toHaveCount(0);
  await expect.poll(async () => (await storedThreads(run)).length).toBe(1);
  await run.app.close();
});

test("replying adds to the comment's thread", async () => {
  const run = await openText("Launch in March.\n");
  await comment(run, "March", "Is March realistic?");
  const c = card(run.page, "Is March realistic?");
  await run.page.locator(`${EDITOR} p`).click(); // away from the comment: its card stays compact
  await expect(c.getByRole("textbox", { name: "Reply" })).toBeHidden();
  await c.locator(".comment-body").click(); // the comment in focus offers a reply box
  await c.getByRole("textbox", { name: "Reply" }).click();
  await run.page.keyboard.type("Also check the holidays.");
  await c.getByRole("button", { name: "Reply" }).click();
  await expect(c.locator(".comment-message")).toHaveCount(2);
  await expect(c.locator(".comment-message").nth(1)).toContainText("Also check the holidays.");
  await expect(c.locator(".comment-message").nth(1).locator(".comment-author")).toHaveText("You");
  await expect(c.getByRole("textbox", { name: "Reply" })).toHaveValue("");
  await expect.poll(async () => (await storedThreads(run))[0]?.messages.length).toBe(2);
  await run.app.close();
});

test("resolving hides a comment; Show beside the resolved count shows it again, and Reopen brings it back", async () => {
  const run = await openText("Alpha beta gamma.\n");
  const count = run.page.locator("#comments-toggle");
  await comment(run, "beta", "Check this.");
  await comment(run, "gamma", "And this.");
  const c = card(run.page, "Check this.");
  await c.getByRole("button", { name: "Resolve", exact: true }).click();
  await expect(c).toHaveCount(0);
  await expect.poll(() => highlights(run.page)).toEqual(["gamma"]);
  await expect(count).toHaveText("1 comment");
  await expect(run.page.locator(`${PANEL} .comments-resolved-count`)).toHaveText("1 resolved");
  await run.page.getByRole("button", { name: "Show resolved comments" }).click();
  await expect(c).toBeVisible();
  await expect(c).toHaveClass(/resolved/);
  await expect(c).toHaveAttribute("aria-label", /, resolved$/);
  expect(await highlights(run.page)).toEqual(["gamma"]);
  await c.getByRole("button", { name: "Reopen" }).click();
  await expect(c.getByRole("button", { name: "Resolve" })).toBeVisible();
  await expect.poll(() => highlights(run.page)).toEqual(["beta", "gamma"]);
  await expect(count).toHaveText("2 comments");
  await expect.poll(async () => (await storedThreads(run)).map((t) => t.status)).toEqual(["open", "open"]);
  await run.app.close();
});

test("comments are still there after closing and reopening the document", async () => {
  const run = await openText("Keep this sentence.\n\nAnd another one.\n", { name: "notes.md" });
  await comment(run, "another", "Why another?");
  await clickMenu(run.app, "close-tab");
  await expect(run.page.locator(".tab")).toHaveCount(0);
  await run.page.evaluate((p) => window.corillo.openPath(p), run.file);
  await expect(card(run.page, "Why another?")).toBeVisible();
  await expect.poll(() => highlights(run.page)).toEqual(["another"]);
  await run.app.close();
});

test("a comment stays on its words when text is typed before them, and is found there next time", async () => {
  const run = await openText("We should hire two people.\n");
  await comment(run, "hire", "Hire whom?");
  await run.page.locator(`${EDITOR} p`).click();
  await settle(run.page);
  await run.page.keyboard.press("Meta+ArrowLeft");
  await settle(run.page);
  await run.page.keyboard.type("Next year, hire is hard. ");
  const followedBy = () =>
    run.page.locator(`${EDITOR} .comment-range`).evaluate((e) => [e.textContent, e.nextSibling?.textContent]);
  await expect.poll(followedBy).toEqual(["hire", " two people."]);
  // Corillo remembers the new place, so it's found next time.
  await expect.poll(async () => (await storedThreads(run))[0]?.anchor?.offset).toBe("Next year, hire is hard. We should ".length);
  expect((await storedThreads(run))[0].anchor?.prefix).toMatch(/hire is hard\. We should $/);
  await clickMenu(run.app, "close-tab");
  await expect(run.page.locator(".tab")).toHaveCount(0);
  await run.page.evaluate((p) => window.corillo.openPath(p), run.file);
  await expect(card(run.page, "Hire whom?")).toBeVisible();
  await expect.poll(followedBy).toEqual(["hire", " two people."]);
  await run.app.close();
});

test("when the file is rewritten outside Corillo, a comment follows its words, and one whose words are gone says so", async () => {
  const run = await openText("# Plan\n\nFirst we hire a designer.\n\nThen we buy laptops.\n");
  await comment(run, "hire a designer", "Which designer?");
  await comment(run, "buy laptops", "Too expensive.");
  writeFileSync(run.file, "# Plan\n\nAn introduction an agent added.\n\nFirst we hire a designer.\n");
  await expect.poll(() => highlights(run.page)).toEqual(["hire a designer"]);
  const gone = card(run.page, "Too expensive.");
  await expect(gone).toContainText("The text this comment was on has changed.");
  await expect(gone.locator(".comment-quote")).toHaveText("buy laptops");
  await expect(card(run.page, "Which designer?")).not.toContainText("has changed");
  // The comment whose words are gone has no place in the text: it sits at the top, above the ones on text.
  await expect(run.page.locator(`${PANEL} .comment-card`).nth(0)).toContainText("Too expensive.");
  await expect
    .poll(async () => (await storedThreads(run)).find((t) => t.messages[0].body === "Too expensive.")?.detached)
    .toBe(true);
  await run.app.close();
});

test("deleting a comment's words keeps their place (on screen only), and Undo brings the highlight back", async () => {
  const run = await openText("Keep this. Remove me. Keep that.\n");
  await comment(run, "Remove me.", "Should this go?");
  await selectText(run.page, "Remove me.");
  await run.page.keyboard.press("Backspace");
  await expect.poll(() => highlights(run.page)).toEqual([]);
  const c = card(run.page, "Should this go?");
  // Inside a paragraph, the place is a small marked gap (spec: "Deleted text keeps its place").
  await expect(run.page.locator(`${EDITOR} .comment-gap:not(.line)`)).toHaveCount(1);
  await expect(c).toContainText("The text it was on was deleted.");
  await expect(c).not.toContainText("has changed");
  await run.page.keyboard.press("Meta+z");
  await expect.poll(() => highlights(run.page)).toEqual(["Remove me."]);
  await expect(run.page.locator(`${EDITOR} .comment-gap`)).toHaveCount(0);
  await run.app.close();
});

// Review of Batch 6, B6-R01: Undo and Redo of the person's own typing beside a comment leave it on its words, and
// that's what's kept. (Before the fix, Command-Z after an "s" typed just after "three people" left it on "three ",
// and after a letter typed just before, on " people", and saved it so.)
test("a letter typed just after or just before a comment's words, then Undo and Redo: the comment stays on its words", async () => {
  const DOC = "We should hire three people this quarter.\n";
  const run = await openText(DOC);
  await comment(run, "three people", "Is three enough?");
  for (const [at, typed] of [["three people", "s"], ["three", "x"]] as const) {
    await selectText(run.page, at);
    await run.page.keyboard.press(typed === "s" ? "ArrowRight" : "ArrowLeft");
    await run.page.keyboard.type(typed);
    await expect.poll(() => highlights(run.page)).toEqual(["three people"]);
    await run.page.keyboard.press("Meta+z");
    await expectFile(run, DOC);
    await expect.poll(() => highlights(run.page)).toEqual(["three people"]);
    await run.page.keyboard.press("Meta+Shift+z");
    await expect.poll(() => highlights(run.page)).toEqual(["three people"]);
    await run.page.keyboard.press("Meta+z");
    await expectFile(run, DOC);
    await expect.poll(() => highlights(run.page)).toEqual(["three people"]);
  }
  // What's kept, and what agents read, is on its words too.
  await run.page.waitForTimeout(1200);
  await expect.poll(async () => (await storedThreads(run))[0]?.anchor?.quote).toBe("three people");
  await expect(card(run.page, "Is three enough?").locator(".comment-quote")).toHaveText("three people");
  await run.app.close();
});

test("typing over a comment's words keeps the comment on everything typed, and it's found there next time", async () => {
  const run = await openText("We launch in March this year.\n");
  await comment(run, "March", "Too early?");
  await selectText(run.page, "March");
  await run.page.keyboard.type("early April");
  await expect.poll(() => highlights(run.page)).toEqual(["early April"]);
  await expectFile(run, "We launch in early April this year.\n");
  await expect.poll(async () => (await storedThreads(run))[0]?.anchor?.quote).toBe("early April");
  await expect(card(run.page, "Too early?").locator(".comment-quote")).toHaveText(/early April/);
  await run.app.close();
});

// Changed 2026-11-09: Edit and Delete are in the "⋯" (More actions) menu, which only the person's own messages have.
test("an agent's reply shows under the agent's name, in its own colour, without Edit or Delete", async () => {
  const run = await openText("Draft the summary.\n");
  await comment(run, "summary", "Make it shorter.");
  const threads = await storedThreads(run);
  threads[0].messages.push({
    id: "reply-from-writer",
    author: { kind: "agent", name: "Writer" },
    body: "Done: I cut it to two lines.",
    created: new Date().toISOString(),
  });
  await sendToWindow(run, "comments:changed", threads);
  const c = card(run.page, "Make it shorter.");
  const reply = c.locator(".comment-message").nth(1);
  await expect(reply.locator(".comment-author")).toHaveText("Writer");
  await expect(reply).toContainText("Done: I cut it to two lines.");
  await expect(reply.locator(".comment-avatar")).toHaveAttribute("data-colour", /^(peach|sky|mint|lilac|ochre|rose)$/);
  await expect(reply.locator(".comment-avatar")).toHaveText("W");
  await c.locator(".comment-body").first().click();
  await expect(c.locator(".comment-head").getByRole("button", { name: "More actions" })).toBeVisible();
  await expect(reply.getByRole("button", { name: "More actions" })).toHaveCount(0);
  await expect(reply.getByRole("button", { name: "Edit" })).toHaveCount(0);
  await expect(reply.getByRole("button", { name: "Delete" })).toHaveCount(0);
  await run.app.close();
});

// Changed 2026-11-09: @ in the comment (Orlando's request) took the place of the To menu.
test("@ lists the document's agents, the default first, and a comment can go to a particular agent", async () => {
  const run = await openText("Section one.\n\nSection two.\n");
  await sendToWindow(run, "agents:changed", [
    { name: "Claude", isDefault: true },
    { name: "Writer", isDefault: false },
  ]);
  await selectText(run.page, "one");
  await run.page.keyboard.press("Meta+Alt+KeyM");
  await expect(run.page.getByRole("combobox", { name: "To" })).toHaveCount(0);
  await run.page.keyboard.type("@");
  await expect.poll(() => listed(run.page)).toEqual(["Claude, connected, default", "Writer, connected"]);
  await run.page.keyboard.type("Wr");
  await run.page.keyboard.press("Enter");
  await run.page.keyboard.type("polish this.");
  await run.page.getByRole("button", { name: "Post" }).click();
  await expect(card(run.page, "@Writer polish this.").locator(".comment-recipient")).toHaveText("To Writer");

  // A comment for the default agent says nothing about who it's for.
  await selectText(run.page, "two");
  await run.page.keyboard.press("Meta+Alt+KeyM");
  await run.page.getByRole("textbox", { name: "New comment" }).fill("For the default agent.");
  await run.page.getByRole("button", { name: "Post" }).click();
  await expect(card(run.page, "For the default agent.")).toBeVisible();
  await expect(card(run.page, "For the default agent.").locator(".comment-recipient")).toHaveCount(0);
  const stored = await storedThreads(run);
  expect(stored.map((t) => t.to)).toEqual(["Writer", null]);
  await run.app.close();
});

test("clicking highlighted text puts its comment in focus, and clicking a comment highlights its text", async () => {
  const run = await openText("Alpha comes first. Omega comes last.\n");
  await comment(run, "Alpha", "About alpha.");
  await comment(run, "Omega", "About omega.");
  await run.page.locator(`${EDITOR} .comment-range`, { hasText: "Alpha" }).click();
  await expect(card(run.page, "About alpha.")).toHaveClass(/active/);
  await expect(run.page.locator(`${EDITOR} .comment-range.active`)).toHaveText("Alpha");
  await card(run.page, "About omega.").locator(".comment-body").click();
  await expect(card(run.page, "About omega.")).toHaveClass(/active/);
  await expect(card(run.page, "About alpha.")).not.toHaveClass(/active/);
  await expect(run.page.locator(`${EDITOR} .comment-range.active`)).toHaveText("Omega");
  await run.app.close();
});

test("the status bar counts open comments, and its button hides and shows them, in either view", async () => {
  const run = await openText("One two three.\n");
  const button = run.page.locator("#comments-toggle");
  const panel = run.page.locator(PANEL);
  await expect(button).toBeHidden();
  await comment(run, "two", "First.");
  await expect(button).toHaveText("1 comment");
  await comment(run, "three", "Second.");
  await expect(button).toHaveText("2 comments");
  await expect(panel).toBeVisible();
  await button.click();
  await expect(panel).toBeHidden();
  await expect(button).toHaveAttribute("aria-pressed", "false");
  expect(await highlights(run.page)).toEqual(["two", "three"]);
  await button.click();
  await expect(panel).toBeVisible();
  await expect(button).toHaveAttribute("aria-pressed", "true");

  // The Markdown view shows the same comments, and the button works there too.
  await run.page.getByRole("button", { name: "Markdown", exact: true }).click();
  await expect(panel).toBeVisible();
  await expect(card(run.page, "First.")).toBeVisible();
  await expect(button).toBeEnabled();
  await expect(commentButton(run.page)).toBeEnabled();
  await expect(run.page.getByRole("textbox", { name: "Markdown text" })).toHaveValue("One two three.\n");
  await button.click();
  await expect(panel).toBeHidden();
  await button.click();
  await expect(panel).toBeVisible();
  await run.page.getByRole("button", { name: "Formatted", exact: true }).click();
  await expect(panel).toBeVisible();
  await expect.poll(() => highlights(run.page)).toEqual(["two", "three"]);
  await run.app.close();
});

/** Answer Corillo's next question with the button at this position (from the left), and keep what it asked. */
async function answerNext(run: Running, response: number): Promise<void> {
  await run.app.evaluate(({ dialog }, r) => {
    const g = globalThis as { asked?: string[] };
    g.asked = [];
    dialog.showMessageBox = (async (...args: unknown[]) => {
      const options = args.find((a) => typeof a === "object" && a && "message" in a) as { message: string };
      g.asked!.push(options.message);
      return { response: r, checkboxChecked: false };
    }) as typeof dialog.showMessageBox;
  }, response);
}
const asked = (run: Running) => run.app.evaluate(() => (globalThis as { asked?: string[] }).asked ?? []);

test("closing with a comment typed and not posted asks first: Go Back keeps it, Close Anyway lets it go", async () => {
  const run = await openText("# Plan\n\nWe start in May.\n");
  await selectText(run.page, "May");
  await commentButton(run.page).click();
  const box = run.page.getByRole("textbox", { name: "New comment" });
  await box.fill("Is May too soon?");
  await run.page.locator(`${EDITOR} p`).click(); // the cursor goes back to the page; the draft stays
  await answerNext(run, 0);
  await clickMenu(run.app, "close-tab");
  await expect.poll(() => asked(run)).toEqual(["You haven't posted your comment on proposal."]);
  // Still open, with the cursor back in the unposted comment.
  await expect(box).toBeFocused();
  await expect(box).toHaveValue("Is May too soon?");
  await expect(run.page.locator("#empty")).toBeHidden();
  // Posted, then a reply typed and not sent: Close Anyway closes it.
  await run.page.getByRole("button", { name: "Post" }).click();
  await expect(card(run.page, "Is May too soon?")).toBeVisible();
  await card(run.page, "Is May too soon?").click();
  await run.page.getByRole("textbox", { name: "Reply" }).fill("Or June.");
  await answerNext(run, 1);
  await clickMenu(run.app, "close-tab");
  await expect(run.page.locator("#empty")).toBeVisible();
  expect(await asked(run)).toEqual(["You haven't posted your comment on proposal."]);
  await run.app.close();
});

test("closing with nothing unposted doesn't ask", async () => {
  const run = await openText("# Plan\n\nWe start in May.\n");
  await comment(run, "May", "Is May too soon?");
  await answerNext(run, 0);
  await clickMenu(run.app, "close-tab");
  await expect(run.page.locator("#empty")).toBeVisible();
  expect(await asked(run)).toEqual([]);
  await run.app.close();
});
