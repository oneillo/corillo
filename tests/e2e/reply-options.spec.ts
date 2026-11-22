// Choose between the agent's options with one click (roadmap Batch 3, item 2;
// A-3, L-8; Orlando's decision D7: "Agents can attach up to three options to
// a reply, and you apply one with a click"). The agent makes its best version
// and offers the others as options; each shows as a button under its reply. A
// click applies one as the person's own edit: one Undo takes it back, History
// shows it as theirs, the comment records "You chose: …" and stays open, and
// the change lights up. An option that no longer fits changes nothing, and
// says so. Each test runs the real app, hidden, with a pretend agent tool
// speaking to its real connector, on throwaway documents it removes.
import { test, expect, type Page } from "@playwright/test";
import { rmSync } from "node:fs";
import { cursorAtEnd, expectFile, openText, selectText, settle, turnSaid, EDITOR, type Running } from "./helpers";
import { AgentSession } from "./agent-session";

const DOC = ".doc:not([hidden])";
const PANEL = `${DOC} aside.comments-panel`;
const TURN = "#turn-status .turn-text";
const PLAN = "# Plan\n\nWe should hire two people this quarter.\n\nThe budget is tight.\n";
const BEST = "# Plan\n\nWe should hire three people this quarter.\n\nThe budget is tight.\n";
const SHORTER = "# Plan\n\nHire three this quarter.\n\nThe budget is tight.\n";
const shorter = { label: "Shorter", edits: [{ find: "We should hire three people this quarter.", replace: "Hire three this quarter." }] };
const formal = { label: "Formal", edits: [{ find: "We should hire three people this quarter.", replace: "The plan is to recruit three staff this quarter." }] };

const card = (page: Page, body: string) => page.locator(`${PANEL} .comment-card:not(.draft)`, { hasText: body });
const option = (page: Page, label: string) => page.locator(`${PANEL} .comment-option`, { hasText: label });

let run: Running | null = null;
let home: string | null = null;
const sessions: AgentSession[] = [];

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

/** The person asks; Claude makes three people its best version and offers Shorter and Formal; the comment comes back. */
async function offered(): Promise<{ run: Running; claude: AgentSession }> {
  run = await openText(PLAN, { name: "plan.md" });
  home = await run.app.evaluate(() => process.env.CORILLO_HOME ?? null);
  const { page } = run;
  await selectText(page, "two people");
  await page.getByRole("button", { name: "Comment", exact: true }).click();
  await page.getByRole("textbox", { name: "New comment" }).fill("Three, and is it too wordy?");
  await page.getByRole("button", { name: "Post" }).click();
  await expect(card(page, "Three, and is it too wordy?")).toBeVisible();
  const { session: claude } = await AgentSession.start(run.dataDir, "claude-code");
  sessions.push(claude);
  const taken = await claude.ok("take_document", { path: run.file });
  const id = /\[([0-9a-f]+)\] on /.exec(taken)![1];
  await claude.ok("edit_document", { path: run.file, edits: [{ find: "hire two people", replace: "hire three people" }], comment_ids: [id] });
  expect(
    await claude.ok("reply_to_comment", { path: run.file, comment_id: id, text: "Made it three. Shorter, or more formal?", options: [shorter, formal] }),
  ).toContain("The person can apply one of your 2 options with a click.");
  await claude.ok("finish_editing", { path: run.file });
  await expectFile(run, BEST);
  await expect(option(page, "Shorter")).toBeVisible();
  await expect(option(page, "Formal")).toBeVisible();
  return { run, claude };
}

test("a click applies the option as the person's own edit: the file changes, the comment records the choice and lights the change, and one Undo takes it back", async () => {
  const { run: r, claude } = await offered();
  const { page } = r;
  await option(page, "Shorter").click();
  await expect(page.locator(EDITOR)).toContainText("Hire three this quarter.");
  await expectFile(r, SHORTER);
  const c = card(page, "Three, and is it too wordy?");
  await expect(c.locator(".comment-option-chosen")).toHaveText("You chose: Shorter");
  // The comment stays open until the person resolves it, and still waits for them.
  await expect(c.getByRole("button", { name: /^Resolve/ })).toBeVisible();
  await expect(c).toHaveAttribute("aria-label", turnSaid("Waiting for you"));
  // The change lights up, as the person's, in words that say what they did (roadmap Batch 11, F-15).
  await expect(c.locator(".comment-change-note")).toHaveText("What you chose is highlighted.");
  // Word by word, as an agent's change is: "We should hire" became "Hire", and "people" went.
  await expect(page.locator(`${EDITOR} .change-mark`)).toHaveText(["Hire"]);
  // The other option is still offered.
  await expect(option(page, "Formal")).toBeVisible();
  await expect(option(page, "Shorter")).toHaveCount(0);

  // History shows it as the person's edit, not the agent's.
  await page.getByRole("button", { name: "History", exact: true }).click();
  await expect.poll(() => page.locator(`${DOC} .history-panel .history-who`).first().textContent()).toBe("You");
  await page.getByRole("button", { name: "History", exact: true }).click();

  // One Undo takes it back.
  await page.locator(EDITOR).click();
  await page.keyboard.press("Meta+z");
  await expect(page.locator(EDITOR)).toContainText("We should hire three people this quarter.");
  await expectFile(r, BEST);
});

test("an option that no longer fits changes nothing, and its button says so", async () => {
  const { run: r, claude } = await offered();
  const { page } = r;
  // The person rewrites the words the options change.
  await expect(page.locator(EDITOR)).toContainText("three people");
  await selectText(page, "three"); // the agent's change: a word of its own
  await page.keyboard.type("four");
  await expectFile(r, BEST.replace("three people", "four people"));
  await option(page, "Formal").click();
  await expect(option(page, "Formal")).toHaveText("Formal: no longer fits");
  await expect(page.locator(`${PANEL} .comment-option-why`)).toHaveText("“Formal” no longer fits: the words it changes have been edited since. Nothing was changed.");
  await settle(page);
  expect(r.text()).toBe(BEST.replace("three people", "four people"));
  await expect(page.locator(`${PANEL} .comment-option-chosen`)).toHaveCount(0);
});

// Review of Batch 3, B3-R03: after one option, a click on another switches to it, worked out from the
// text as it was before the choice: one change, one Undo. Only the person's own edits to those words
// make an option no longer fit.
const FORMAL = BEST.replace("We should hire three people this quarter.", "The plan is to recruit three staff this quarter.");

test("after one option, a click on another switches to it, as one Undo; the person's edits elsewhere don't stand in the way", async () => {
  const { run: r } = await offered();
  const { page } = r;
  const c = card(page, "Three, and is it too wordy?");
  await option(page, "Shorter").click();
  await expectFile(r, SHORTER);
  await expect(c.locator(".comment-option-chosen")).toHaveText("You chose: Shorter");
  // An edit of the person's elsewhere, then the other option.
  await cursorAtEnd(page, "The budget is tight.");
  await page.keyboard.type(" Very.");
  await expectFile(r, SHORTER.replace("tight.", "tight. Very."));
  await option(page, "Formal").click();
  await expectFile(r, FORMAL.replace("tight.", "tight. Very."));
  await expect(c.locator(".comment-option-chosen")).toHaveText("You chose: Formal");
  await expect(page.locator(`${PANEL} .comment-option-why`)).toBeHidden();
  await expect(option(page, "Shorter")).toBeVisible();
  await expect(option(page, "Formal")).toHaveCount(0);
  // One Undo goes back to Shorter.
  await page.locator(EDITOR).click();
  await page.keyboard.press("Meta+z");
  await expectFile(r, SHORTER.replace("tight.", "tight. Very."));
});

test("an option the person's own edits have overtaken still says it no longer fits", async () => {
  const { run: r } = await offered();
  const { page } = r;
  await option(page, "Shorter").click();
  await expectFile(r, SHORTER);
  await selectText(page, "Hire"); // a word of the choice's
  await page.keyboard.type("Get");
  await expectFile(r, SHORTER.replace("Hire three", "Get three"));
  await option(page, "Formal").click();
  await expect(option(page, "Formal")).toHaveText("Formal: no longer fits");
  await expect(page.locator(`${PANEL} .comment-option-why`)).toHaveText("“Formal” no longer fits: the words it changes have been edited since. Nothing was changed.");
  await settle(page);
  expect(r.text()).toBe(SHORTER.replace("Hire three", "Get three"));
});

// Review of Batch 3, B3-R04: the choice is kept beside Claude's change, not in its place, and "You chose"
// is said, to the person and to agents, only while it's in the text.
test("Undo takes the choice back too: \"You chose\" goes, the option is offered again, Claude's change is lit again, and agents aren't told the person chose", async () => {
  const { run: r, claude } = await offered();
  const { page } = r;
  const c = card(page, "Three, and is it too wordy?");
  await option(page, "Shorter").click();
  await expectFile(r, SHORTER);
  await expect(c.locator(".comment-option-chosen")).toHaveText("You chose: Shorter");
  await expect(c.locator(".comment-change-note")).toHaveText("What you chose is highlighted.");
  expect(await claude.ok("list_comments", { path: r.file, include_answered: true })).toContain('The person chose "Shorter".');

  await page.locator(EDITOR).click();
  await page.keyboard.press("Meta+z");
  await expectFile(r, BEST);
  await expect(c.locator(".comment-option-chosen")).toHaveCount(0);
  await expect(option(page, "Shorter")).toBeVisible();
  await expect(option(page, "Formal")).toBeVisible();
  await expect(c.locator(".comment-change-note")).toHaveText("Claude changed the highlighted text.");
  await c.click();
  await expect(page.locator(`${EDITOR} .change-mark`)).toHaveText(["three"]);
  const listed = await claude.ok("list_comments", { path: r.file, include_answered: true });
  expect(listed).toContain('Options: "Shorter", "Formal".');
  expect(listed).not.toContain("The person chose");

  // Redo puts it back, and "You chose" with it.
  await page.locator(EDITOR).click();
  await page.keyboard.press("Meta+Shift+z");
  await expectFile(r, SHORTER);
  await expect(c.locator(".comment-option-chosen")).toHaveText("You chose: Shorter");
  // Switched to Formal and undone: back to Shorter, and the card says so.
  await option(page, "Formal").click();
  await expectFile(r, FORMAL);
  await expect(c.locator(".comment-option-chosen")).toHaveText("You chose: Formal");
  await page.locator(EDITOR).click();
  await page.keyboard.press("Meta+z");
  await expectFile(r, SHORTER);
  await expect(c.locator(".comment-option-chosen")).toHaveText("You chose: Shorter");
  await expect(option(page, "Formal")).toBeVisible();
  await expect(option(page, "Shorter")).toHaveCount(0);
});

test("in the Markdown view, the text's Undo takes the choice back too, and the card says so", async () => {
  const { run: r } = await offered();
  const { page } = r;
  await page.getByRole("button", { name: "Markdown", exact: true }).click();
  const source = page.getByRole("textbox", { name: "Markdown text" });
  const c = card(page, "Three, and is it too wordy?");
  await option(page, "Shorter").click();
  await expect(source).toHaveValue(SHORTER);
  await expect(c.locator(".comment-option-chosen")).toHaveText("You chose: Shorter");
  await source.press("Meta+z");
  await expect(source).toHaveValue(BEST);
  await expect(c.locator(".comment-option-chosen")).toHaveCount(0);
  await expect(option(page, "Shorter")).toBeVisible();
});

/** The words the comment "Three, and is it too wordy?" is on: its highlight, in as many pieces as Claude's change cuts it into. */
async function commentOn(page: Page, expected: string): Promise<void> {
  const c = card(page, "Three, and is it too wordy?");
  await settle(page);
  await expect(c).not.toHaveClass(/gapped|detached/);
  await c.click();
  await expect.poll(async () => (await page.locator(`${EDITOR} .comment-range.active`).allTextContents()).join("")).toBe(expected);
}

// Roadmap Batch 6: a comment on the words an option rewrites ends on the words that took their place, as it does
// when an agent's edit rewrites them. (Before the fix, Shorter left it on the one letter "e" the two versions
// share, and switching to Formal lost it.)
test("a comment on the words an option rewrites stays on its words as they are now, in either view, and its words are kept", async () => {
  const { run: r, claude } = await offered();
  const { page } = r;
  const words = (expected: string) => commentOn(page, expected);
  await words("three people");
  // Chosen in the Markdown view.
  await page.getByRole("button", { name: "Markdown", exact: true }).click();
  await option(page, "Shorter").click();
  await expectFile(r, SHORTER);
  await page.getByRole("button", { name: "Formatted", exact: true }).click();
  await words("three");
  // Switched to the other option, and back, in the formatted view.
  await option(page, "Formal").click();
  await expectFile(r, FORMAL);
  await words("three");
  await option(page, "Shorter").click();
  await expectFile(r, SHORTER);
  await words("three");
  // What's kept, and what agents are told, says so too.
  await expect.poll(() => claude.ok("list_comments", { path: r.file, include_answered: true })).toMatch(/\] on "three"/);
});

// Roadmap Batch 6, second round: Command-Z straight after a choice, as Help says, puts the comment back on its words,
// and Redo on the new ones. (Before, Undo left it on the one letter "e" the two versions share.)
test("Undo straight after a choice puts the comment back on its words, and Redo on the words that took their place", async () => {
  const { run: r } = await offered();
  const { page } = r;
  await commentOn(page, "three people");
  await option(page, "Shorter").click();
  await expectFile(r, SHORTER);
  await commentOn(page, "three");
  await page.locator(EDITOR).click();
  await page.keyboard.press("Meta+z");
  await expectFile(r, BEST);
  await commentOn(page, "three people");
  await page.locator(EDITOR).click();
  await page.keyboard.press("Meta+Shift+z");
  await expectFile(r, SHORTER);
  await commentOn(page, "three");
});

// Review of Batch 6 (the loop builder's note): in the Markdown view the text's own Undo of a choice puts the comment
// back on its words too, and its Redo on the new ones. (Before, the text's Undo left it on the one letter "e".)
test("in the Markdown view, the text's Undo of a choice puts the comment back on its words, and its Redo on the words that took their place", async () => {
  const { run: r } = await offered();
  const { page } = r;
  await commentOn(page, "three people");
  await page.getByRole("button", { name: "Markdown", exact: true }).click();
  const source = page.getByRole("textbox", { name: "Markdown text" });
  // The comment's words, as the document under the text has them (in the text, Claude's change is lit over them).
  const inText = async () => (await page.locator(`${EDITOR} .comment-range`).allTextContents()).join("");
  await expect.poll(inText).toBe("three people");
  await option(page, "Shorter").click();
  await expect(source).toHaveValue(SHORTER);
  await expect.poll(inText).toBe("three");
  await source.press("Meta+z");
  await expect(source).toHaveValue(BEST);
  await expectFile(r, BEST);
  await expect.poll(inText).toBe("three people");
  await source.press("Meta+Shift+z");
  await expect(source).toHaveValue(SHORTER);
  await expectFile(r, SHORTER);
  await expect.poll(inText).toBe("three");
  await page.getByRole("button", { name: "Formatted", exact: true }).click();
  await commentOn(page, "three");
});

test("choosing doesn't change whose turn it is: after the person's reply, the comment still waits for Claude", async () => {
  const { run: r } = await offered();
  const { page } = r;
  const c = card(page, "Three, and is it too wordy?");
  await c.locator(".comment-body").first().click(); // the comment in focus offers a reply box
  await c.getByRole("textbox", { name: "Reply" }).click();
  await page.keyboard.type("Let me think about which.");
  await c.getByRole("button", { name: "Reply" }).click();
  await expect(c.locator(".comment-message")).toHaveCount(3);
  // Whose turn, as a screen reader hears it at the end of the card's name, after its quote (the card shows no line
  // for it: roadmap Batch 9, item 3). The choice changes the quote, not the turn.
  const turnOf = async () => (await c.getAttribute("aria-label"))!.replace(/^Comment by .*?”/, "");
  const turn = await turnOf();
  expect(turn).toMatch(/^, /);
  expect(turn).not.toMatch(turnSaid("Waiting for you"));
  await option(page, "Shorter").click();
  await expectFile(r, SHORTER);
  await expect(c.locator(".comment-option-chosen")).toHaveText("You chose: Shorter");
  await settle(page);
  await expect.poll(turnOf).toBe(turn);
});

// Review of Batch 3, B3-R02 (the lead's call): Show changes keeps the Comments panel, so its options are
// there to click. A click applies the option and Show changes stays on, brought up to date with the
// page where it was: the person's choice is their own edit, so it isn't marked, and the count follows.
const VERSION = `${DOC} .version-view .ProseMirror`;
const BANNER = `${DOC} .version-banner`;

test("with Show changes on, a click applies the option and the changes stay shown, up to date; the person's choice isn't marked", async () => {
  const { run: r } = await offered();
  const { page } = r;
  await page.locator("#toolbar").getByRole("button", { name: "Show changes" }).click();
  await expect(page.locator(BANNER)).toContainText(/^1 change by Claude since you handed it over at /);
  await expect(page.locator(`${VERSION} ins.diff-added`)).toHaveText(["three"]);
  await page.locator(`${DOC} .version-view`).evaluate((c) => (c.scrollTop = 0));
  await option(page, "Shorter").click();
  await expectFile(r, SHORTER);
  await expect(card(page, "Three, and is it too wordy?").locator(".comment-option-chosen")).toHaveText("You chose: Shorter");
  // The card's note on the change points at a highlight on the document, out of sight: it waits (review of Batch 11, F-16).
  await expect(card(page, "Three, and is it too wordy?")).toHaveClass(/active/);
  await expect(card(page, "Three, and is it too wordy?").locator(".comment-change")).toBeHidden();
  // Still showing changes, now of the text as it is: the person's own words aren't marked, and the count follows the marks.
  await expect(page.locator(VERSION)).toContainText("Hire three this quarter.");
  await expect(page.locator(BANNER)).toBeVisible();
  await expect(page.locator(BANNER)).toContainText("Hide changes");
  expect(await page.locator(`${VERSION} ins`).filter({ hasText: /Hire/ }).count()).toBe(0);
  const marked = await page.evaluate((sel) => new Set([...document.querySelectorAll<HTMLElement>(`${sel} [data-change]`)].map((m) => m.dataset.change)).size, VERSION);
  await expect(page.locator(`${BANNER} .version-banner-text`)).toHaveText(
    marked ? new RegExp(`^${marked === 1 ? "1 change" : `${marked} changes`} by Claude since you handed it over`) : /^None of the changes Claude made since you handed it over .* are left to mark: you've edited those places since\./,
  );
  // The keyboard isn't left in the document out of sight: typing changes nothing.
  await page.keyboard.type("x");
  await settle(page);
  expect(r.text()).toBe(SHORTER);
  // Hiding the changes, the page has it, and one Undo takes it back.
  await page.getByRole("button", { name: "Hide changes" }).first().click();
  await expect(page.locator(EDITOR)).toContainText("Hire three this quarter.");
  await expect(card(page, "Three, and is it too wordy?").locator(".comment-change")).toBeVisible();
  await page.locator(EDITOR).click();
  await page.keyboard.press("Meta+z");
  await expectFile(r, BEST);
});

test("in the Markdown view too, with Show changes on, a click applies the option and the changes stay shown; the text's Undo takes it back after", async () => {
  const { run: r } = await offered();
  const { page } = r;
  await page.getByRole("button", { name: "Markdown", exact: true }).click();
  const source = page.getByRole("textbox", { name: "Markdown text" });
  await expect(source).toHaveValue(BEST);
  await page.locator("#toolbar").getByRole("button", { name: "Show changes" }).click();
  await expect(page.locator(BANNER)).toContainText(/^1 change by Claude since you handed it over at /);
  await option(page, "Formal").click();
  await expectFile(r, FORMAL);
  await expect(page.locator(VERSION)).toContainText("The plan is to recruit three staff this quarter.");
  await expect(page.locator(BANNER)).toBeVisible();
  await expect(source).toBeHidden();
  await page.keyboard.type("x");
  await settle(page);
  expect(r.text()).toBe(FORMAL);
  await page.getByRole("button", { name: "Hide changes" }).first().click();
  await expect(source).toHaveValue(FORMAL);
  await source.press("Meta+z");
  await expect(source).toHaveValue(BEST);
  await expectFile(r, BEST);
});

test("while a version picked in History shows, the options are out of sight; while an agent is editing, a click changes nothing and says why", async () => {
  const { run: r, claude } = await offered();
  const { page } = r;
  await page.getByRole("button", { name: "History", exact: true }).click();
  await page.locator(`${DOC} .history-panel .history-item`).nth(1).click();
  await expect(page.locator(BANNER)).toContainText("Version from");
  await expect(option(page, "Shorter")).toBeHidden();
  await page.getByRole("button", { name: "Back to current" }).first().click();
  await page.getByRole("button", { name: "History", exact: true }).click();
  await expect(option(page, "Shorter")).toBeVisible();

  await claude.ok("take_document", { path: r.file });
  await option(page, "Shorter").click();
  await expect(page.locator(`${PANEL} .comment-option-why`)).toHaveText("Claude is editing this document. Choose once it's back with you. Nothing was changed.");
  await settle(page);
  expect(r.text()).toBe(BEST);
  // Back with the person, the click works.
  await claude.ok("finish_editing", { path: r.file });
  await option(page, "Shorter").click();
  await expectFile(r, SHORTER);
});

// Review of Batch 3, B3-R01: an option with edits in two places changes only those places. The words
// between them keep their comments and Claude's change highlights, in either view, and one Undo takes it all back.
const BUDGET = "# Budget\n\nThe request is $68,000 for the year.\n\nWe will hire two guides for the summer.\n\nIn short, we ask for $68,000 in total.\n";
const BEST_BUDGET = BUDGET.replace("two guides", "three guides");
const KEPT = BEST_BUDGET.replace("$68,000 for the year", "$52,000 for the year").replace("$68,000 in total", "$52,000 in total");
const keep = {
  label: "Keep the request at $52,000",
  edits: [
    { find: "$68,000 for the year", replace: "$52,000 for the year" },
    { find: "$68,000 in total", replace: "$52,000 in total" },
  ],
};

/** Comment on a passage, as the person does. */
async function comment(page: Page, words: string, body: string): Promise<void> {
  await selectText(page, words);
  await page.getByRole("button", { name: "Comment", exact: true }).click();
  await page.getByRole("textbox", { name: "New comment" }).fill(body);
  await page.getByRole("button", { name: "Post" }).click();
  await expect(card(page, body)).toBeVisible();
}

/**
 * Claude makes it three guides for one comment and, for another, offers to keep the request at
 * $52,000, in two places; between them are Claude's change and the person's own comment.
 */
async function between(): Promise<Running> {
  run = await openText(BUDGET, { name: "budget.md" });
  home = await run.app.evaluate(() => process.env.CORILLO_HOME ?? null);
  const { page } = run;
  await comment(page, "$68,000 for", "Is this the figure?");
  await comment(page, "two guides", "Make it three.");
  const { session: claude } = await AgentSession.start(run.dataDir, "claude-code");
  sessions.push(claude);
  const taken = await claude.ok("take_document", { path: run.file });
  const idOf = (quote: string) => new RegExp(`\\[([0-9a-f]+)\\] on "${quote.replace(/\$/g, "\\$")}`).exec(taken)![1];
  const figure = idOf("$68,000 for");
  const guides = idOf("two guides");
  await claude.ok("edit_document", { path: run.file, edits: [{ find: "two guides", replace: "three guides" }], comment_ids: [guides] });
  await claude.ok("reply_to_comment", { path: run.file, comment_id: guides, text: "Three it is." });
  await claude.ok("reply_to_comment", { path: run.file, comment_id: figure, text: "It is, with Austin. Or keep it as it was?", options: [keep] });
  await claude.ok("finish_editing", { path: run.file });
  await expectFile(run, BEST_BUDGET);
  await expect(option(page, "Keep the request")).toBeVisible();
  // The person's own comment on other words between the two edits.
  await comment(page, "for the summer", "Which months?");
  await stillThere(page);
  return run;
}

/** Between the option's two edits: Claude's change for "Make it three." and the person's comment "Which months?", both where they were. */
async function stillThere(page: Page): Promise<void> {
  await settle(page);
  const three = card(page, "Make it three.");
  const months = card(page, "Which months?");
  for (const c of [three, months]) await expect(c).not.toHaveClass(/gapped|detached/);
  await expect(three.locator(".comment-change-note")).toHaveText("Claude changed the highlighted text.");
  await three.click();
  await expect(page.locator(`${EDITOR} .change-mark`)).toHaveText(["three"]);
  await months.click();
  await expect(page.locator(`${EDITOR} .comment-range.active`)).toHaveText("for the summer");
}

test("an option with edits in two places keeps what's between them, comments and Claude's changes, and one Undo takes it back", async () => {
  const r = await between();
  const { page } = r;
  await option(page, "Keep the request").click();
  await expectFile(r, KEPT);
  await expect(card(page, "Is this the figure?").locator(".comment-option-chosen")).toHaveText("You chose: Keep the request at $52,000");
  await stillThere(page);
  // One Undo takes the whole option back, and what's between stays.
  await page.locator(EDITOR).click();
  await page.keyboard.press("Meta+z");
  await expectFile(r, BEST_BUDGET);
  await stillThere(page);
});

test("in the Markdown view too, an option with edits in two places keeps what's between them, through Undo and Redo", async () => {
  const r = await between();
  const { page } = r;
  await page.getByRole("button", { name: "Markdown", exact: true }).click();
  const source = page.getByRole("textbox", { name: "Markdown text" });
  await expect(source).toHaveValue(BEST_BUDGET);
  await option(page, "Keep the request").click();
  await expect(source).toHaveValue(KEPT);
  await expectFile(r, KEPT);
  // The text's own Undo takes it back as one step, and its Redo puts it in again.
  await source.press("Meta+z");
  await expect(source).toHaveValue(BEST_BUDGET);
  await expectFile(r, BEST_BUDGET);
  await source.press("Meta+Shift+z");
  await expect(source).toHaveValue(KEPT);
  await expectFile(r, KEPT);
  // Back in the formatted view, what was between is where it was.
  await page.getByRole("button", { name: "Formatted", exact: true }).click();
  await stillThere(page);
});

// Review of Batch 3, B3-R06: the person's own click is nothing new for them to read. (On the code before the
// fix, the choice took the comment's change and its time, so the card's dot came back and "1 to read" stayed.)
test("choosing an option leaves no new dot on its card, and nothing more to read in the status bar", async () => {
  const { run: r } = await offered();
  const { page } = r;
  const c = card(page, "Three, and is it too wordy?");
  await expect(c.locator(".card-new")).toBeVisible(); // Claude's reply is new
  await expect(page.locator(TURN)).toHaveText("With you · 1 to read");
  await option(page, "Shorter").click();
  await expect(c.locator(".comment-option-chosen")).toHaveText("You chose: Shorter");
  await settle(page);
  await expect(c.locator(".card-new")).toBeHidden();
  await expect(page.locator(TURN)).toHaveText("With you");
  // Undo and Redo of it are no news either.
  await page.locator(EDITOR).click();
  await page.keyboard.press("Meta+z");
  await expectFile(r, BEST);
  await expect(c.locator(".comment-option-chosen")).toHaveCount(0);
  await page.keyboard.press("Meta+Shift+z");
  await expectFile(r, SHORTER);
  await expect(c.locator(".comment-option-chosen")).toHaveText("You chose: Shorter");
  await expect(c.locator(".card-new")).toBeHidden();
  await expect(page.locator(TURN)).toHaveText("With you");
});

test("in the Markdown view a click applies the option to the text, and Undo there takes it back", async () => {
  const { run: r, claude } = await offered();
  const { page } = r;
  await page.getByRole("button", { name: "Markdown" }).click();
  const source = page.getByRole("textbox", { name: "Markdown text" });
  await expect(source).toHaveValue(BEST);
  await option(page, "Formal").click();
  await expect(source).toHaveValue(BEST.replace("We should hire three people this quarter.", "The plan is to recruit three staff this quarter."));
  await expectFile(r, BEST.replace("We should hire three people this quarter.", "The plan is to recruit three staff this quarter."));
  await expect(page.locator(`${PANEL} .comment-option-chosen`)).toHaveText("You chose: Formal");
  await source.press("Meta+z");
  await expect(source).toHaveValue(BEST);
  await expectFile(r, BEST);
});

test("in the Markdown view, an option chosen is an Undo step of its own: typing straight after it, where it left the keyboard, is another (B10-3)", async () => {
  const { run: r } = await offered();
  const { page } = r;
  await page.getByRole("button", { name: "Markdown" }).click();
  const source = page.getByRole("textbox", { name: "Markdown text" });
  await expect(source).toHaveValue(BEST);
  await option(page, "Shorter").click();
  await expect(source).toHaveValue(SHORTER);
  await expect(source).toBeFocused();
  await page.keyboard.type(" Now");
  await expect(source).not.toHaveValue(SHORTER);
  const typed = await source.inputValue();
  expect(typed.replace(" Now", "")).toBe(SHORTER);
  await expectFile(r, typed);
  // The typing goes first, on its own; then the choice.
  await source.press("Meta+z");
  await expect(source).toHaveValue(SHORTER);
  await source.press("Meta+z");
  await expect(source).toHaveValue(BEST);
  await expectFile(r, BEST);
});

// Review of Batch 11, F-15 (N-11): an option that changed a number was marked in pieces, "about" and "800" with
// "1," left plain between them, on the page and in History ("about · 840 800").
test("an option that changes a number marks it as one change, on the page and in History", async () => {
  const VISITS = "# Visits\n\nWe expect 1,840 visitors in the spring.\n";
  run = await openText(VISITS, { name: "visits.md" });
  home = await run.app.evaluate(() => process.env.CORILLO_HOME ?? null);
  const { page } = run;
  await selectText(page, "1,840 visitors");
  await page.getByRole("button", { name: "Comment", exact: true }).click();
  await page.getByRole("textbox", { name: "New comment" }).fill("Round it?");
  await page.getByRole("button", { name: "Post" }).click();
  const { session: claude } = await AgentSession.start(run.dataDir, "claude-code");
  sessions.push(claude);
  const id = /\[([0-9a-f]+)\] on /.exec(await claude.ok("take_document", { path: run.file }))![1];
  await claude.ok("edit_document", { path: run.file, edits: [{ find: "in the spring", replace: "this spring" }], comment_ids: [id] });
  const round = { label: "About 1,800", edits: [{ find: "1,840", replace: "about 1,800" }] };
  await claude.ok("reply_to_comment", { path: run.file, comment_id: id, text: "Kept it exact. Or round it?", options: [round] });
  await claude.ok("finish_editing", { path: run.file });
  await option(page, "About 1,800").click();
  await expectFile(run, "# Visits\n\nWe expect about 1,800 visitors this spring.\n");
  // On the page: the whole new number, with the word that came with it, lit as one change.
  await expect(page.locator(`${EDITOR} .change-mark`)).toHaveText(["about 1,800"]);
  // In History, the person's version: the number that went, and the one that came, each whole.
  await page.getByRole("button", { name: "History", exact: true }).click();
  await expect.poll(() => page.locator(`${DOC} .history-panel .history-who`).first().textContent()).toBe("You");
  await page.locator(`${DOC} .history-panel .history-item`).first().click();
  const version = `${DOC} .version-view .ProseMirror`;
  await expect(page.locator(`${version} ins.diff-added`)).toHaveText(["about 1,800"]);
  await expect(page.locator(`${version} del.diff-removed`)).toHaveText(["1,840"]);
});
