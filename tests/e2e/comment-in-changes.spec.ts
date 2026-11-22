// Commenting while Show changes is on (roadmap Batch 25, item 1; the planning
// session's call of 2026-11-18). Words selected on the page Show changes draws
// take a comment, by the toolbar's Comment, Insert > New Comment and
// Option-Command-M, and it lands on the same words in the document, as with
// Show changes off. The page stays read-only. Words shown only as removed
// can't take one, and Comment says why. An older version from History still
// takes none.
import { test, expect, type Page } from "@playwright/test";
import { readFileSync } from "node:fs";
import { openText, settle, clickMenu, EDITOR, type Running } from "./helpers";
import { AgentSession } from "./agent-session";

const DOC = ".doc:not([hidden])";
const PANEL = `${DOC} .comments-panel`;
const LINE = `${DOC} .pass-notice`;
const VERSION = `${DOC} .version-view .ProseMirror`;
const SHOWN_PAGE = `${DOC} .version-view .version-page`;
const HISTORY = `${DOC} .history-panel`;

const PLAN = "# Plan\n\nWe should hire two people this quarter.\n\nThe budget is tight.\n";
const AFTER = "# Plan\n\nWe should hire three people this quarter.\n\nThe budget is tight.\n";
const REMOVED_SAID = "These words were removed. Select words that are still in the document to comment.";

const commentTool = (page: Page) => page.locator("#toolbar").getByRole("button", { name: "Comment", exact: true });
const newComment = (page: Page) => page.locator(PANEL).getByRole("button", { name: "New comment", exact: true });
const draftBox = (page: Page) => page.getByRole("textbox", { name: "New comment" });
const menuEnabled = (run: Running, id: string) =>
  run.app.evaluate(({ Menu }, itemId) => Menu.getApplicationMenu()?.getMenuItemById(itemId)?.enabled ?? null, id);

/** Select words on the page Show changes draws (inside `within`, a part of it), as if dragged over with the mouse. */
async function selectShown(page: Page, words: string, within = ""): Promise<void> {
  await page.evaluate(
    ([root, wanted]) => {
      const scope = document.querySelector<HTMLElement>(root)!;
      const walker = document.createTreeWalker(scope, NodeFilter.SHOW_TEXT);
      for (let node = walker.nextNode(); node; node = walker.nextNode()) {
        const at = node.textContent!.indexOf(wanted);
        if (at < 0) continue;
        const range = document.createRange();
        range.setStart(node, at);
        range.setEnd(node, at + wanted.length);
        const read = new Promise<void>((resolve) => {
          const done = () => { document.removeEventListener("selectionchange", done); clearTimeout(timer); setTimeout(resolve, 0); };
          const timer = setTimeout(done, 500);
          document.addEventListener("selectionchange", done);
        });
        getSelection()!.removeAllRanges();
        getSelection()!.addRange(range);
        return read;
      }
      throw new Error(`"${wanted}" isn't on the page shown`);
    },
    [`${VERSION}${within ? ` ${within}` : ""}`, words] as const,
  );
  await settle(page);
}

/** An agent's pass that rewrites "two" as "three", then Show changes from the done line, with the keyboard on its page. */
async function changesShown(): Promise<{ run: Running; claude: AgentSession }> {
  const run = await openText(PLAN, { name: "plan.md" });
  const claude = (await AgentSession.start(run.dataDir, "claude-code")).session;
  await claude.ok("take_document", { path: run.file, request: "Three, not two." });
  await claude.ok("edit_document", { path: run.file, edits: [{ find: "hire two people", replace: "hire three people" }] });
  await claude.ok("finish_editing", { path: run.file });
  await run.page.locator(LINE).getByRole("button", { name: "Show changes" }).click();
  await expect(run.page.locator(DOC)).toHaveClass(/viewing-changes/);
  await expect(run.page.locator(`${VERSION} del.diff-removed`)).toHaveText("two");
  await expect(run.page.locator(SHOWN_PAGE)).toBeFocused();
  return { run, claude };
}

const selectedText = (page: Page) => page.evaluate(() => getSelection()?.toString() ?? "");
const shownText = (page: Page) => page.locator(VERSION).innerText();

test("with Show changes on, words selected on its page take a comment by Comment, landing on the same words, and the page stays as it was", async () => {
  const { run, claude } = await changesShown();
  const { page } = run;
  try {
    // Comment and New comment are there to use, Show changes still on.
    await expect(commentTool(page)).toBeEnabled();
    await expect(newComment(page)).toBeEnabled();
    await expect.poll(() => menuEnabled(run, "comment-add")).toBe(true);
    await expect(page.locator(SHOWN_PAGE)).toHaveAccessibleName("Changes since you handed it over");

    await selectShown(page, "people this quarter");
    await commentTool(page).click();
    // The new comment's box has the keyboard, named for what it is, and says which words it's on.
    await expect(draftBox(page)).toBeFocused();
    await expect(page.locator(`${PANEL} .comment-card.draft`)).toContainText("people this quarter");
    await expect(page.locator(DOC)).toHaveClass(/viewing-changes/);
    // The words it's on are marked on the page shown, as in the document.
    await expect(page.locator(`${VERSION} .comment-range.draft`)).toHaveText("people this quarter");

    await draftBox(page).fill("Who are they?");
    await page.locator(PANEL).getByRole("button", { name: "Post" }).click();
    const posted = page.locator(`${PANEL} .comment-card`).filter({ hasText: "Who are they?" });
    await expect(posted).toBeVisible();
    await expect(posted).toHaveAttribute("aria-label", /^Comment by You on “people this quarter”/);
    // Show changes stays on, the keyboard is back on its page, with nothing selected, and the comment's words are marked there.
    await expect(page.locator(DOC)).toHaveClass(/viewing-changes/);
    await expect(page.locator(SHOWN_PAGE)).toBeFocused();
    await expect(page.locator(SHOWN_PAGE)).toHaveAccessibleName("Changes since you handed it over");
    expect(await selectedText(page)).toBe("");
    await expect(page.locator(`${VERSION} .comment-range`)).toHaveText("people this quarter");
    await expect(page.locator(`${VERSION} .comment-range`)).toHaveAttribute("aria-description", "Commented");

    // The agent gets it as any comment: on the same words.
    const listed = await claude.ok("list_comments", { path: run.file });
    expect(listed).toContain("Who are they?");
    expect(listed).toContain("people this quarter");

    // Nothing on the page changed, and the file holds the agent's text, nothing more.
    await expect.poll(() => shownText(page)).toContain("We should hire twothree people this quarter.");
    expect(readFileSync(run.file, "utf8")).toBe(AFTER);

    // Back to editing: the comment is on the same words in the document.
    await page.keyboard.press("Escape");
    await expect(page.locator(DOC)).not.toHaveClass(/viewing-changes/);
    await expect(page.locator(`${EDITOR} .comment-range`)).toHaveText("people this quarter");
  } finally {
    await run.app.close();
    await claude.stop();
  }
});

test("with Show changes on, the page still refuses typing, paste, formatting keys and Undo, before and after a comment", async () => {
  const { run, claude } = await changesShown();
  const { page } = run;
  try {
    const before = await shownText(page);
    const refused = async () => {
      await selectShown(page, "budget");
      await page.keyboard.type("Typed");
      await page.keyboard.press("Backspace");
      await page.keyboard.press("Meta+b");
      await page.keyboard.press("Meta+z");
      await page.evaluate((root) => {
        const transfer = new DataTransfer();
        transfer.setData("text/plain", "Pasted");
        document.querySelector(root)!.dispatchEvent(new ClipboardEvent("paste", { clipboardData: transfer, bubbles: true, cancelable: true }));
      }, VERSION);
      await settle(page);
      expect(await shownText(page)).toBe(before);
      await expect(page.locator(VERSION)).toHaveAttribute("contenteditable", "false");
      await expect(page.locator(`${VERSION} strong`)).toHaveCount(0);
    };
    await refused();

    await selectShown(page, "budget is tight");
    await page.keyboard.press("Meta+Alt+m");
    await expect(draftBox(page)).toBeFocused();
    await draftBox(page).fill("How tight?");
    await page.keyboard.press("Meta+Enter");
    await expect(page.locator(`${PANEL} .comment-card`).filter({ hasText: "How tight?" })).toBeVisible();
    await expect(page.locator(SHOWN_PAGE)).toBeFocused();

    await refused();
    await page.keyboard.press("Escape");
    await expect(page.locator(DOC)).not.toHaveClass(/viewing-changes/);
    await expect(page.locator(`${EDITOR} .comment-range`)).toHaveText("budget is tight");
    expect(readFileSync(run.file, "utf8")).toBe(AFTER);
  } finally {
    await run.app.close();
    await claude.stop();
  }
});

test("words shown only as removed can't take a comment: Comment says why, on screen and to a screen reader, and nothing starts", async () => {
  const { run, claude } = await changesShown();
  const { page } = run;
  try {
    await selectShown(page, "two", "del.diff-removed");
    await page.keyboard.press("Meta+Alt+m");
    const note = page.locator(`${PANEL} [role="status"]`).filter({ hasText: REMOVED_SAID });
    await expect(note).toBeVisible();
    await expect(page.locator(`${PANEL} .comment-card.draft`)).toHaveCount(0);
    // The keyboard stays on the page shown, Show changes still on.
    await expect(page.locator(SHOWN_PAGE)).toBeFocused();
    await expect(page.locator(DOC)).toHaveClass(/viewing-changes/);

    // The same by the toolbar's Comment and the menu.
    await page.waitForTimeout(0);
    await commentTool(page).click();
    await expect(page.locator(`${PANEL} .comment-card.draft`)).toHaveCount(0);
    await clickMenu(run.app, "comment-add");
    await expect(page.locator(`${PANEL} .comment-card.draft`)).toHaveCount(0);
    await expect(note).toBeVisible();
    expect(readFileSync(run.file, "utf8")).toBe(AFTER);
  } finally {
    await run.app.close();
    await claude.stop();
  }
});

test("Insert > New Comment and Option-Command-M start one too; Escape from its card leaves Show changes on, the keyboard on its page, nothing selected", async () => {
  const { run, claude } = await changesShown();
  const { page } = run;
  try {
    // By the menu: Escape from the empty card goes back to the page shown.
    await selectShown(page, "people");
    await clickMenu(run.app, "comment-add");
    await expect(draftBox(page)).toBeFocused();
    await expect(page.locator(`${PANEL} .comment-card.draft`)).toContainText("people");
    await page.keyboard.press("Escape");
    await expect(page.locator(`${PANEL} .comment-card.draft`)).toHaveCount(0);
    await expect(page.locator(SHOWN_PAGE)).toBeFocused();
    await expect(page.locator(DOC)).toHaveClass(/viewing-changes/);
    expect(await selectedText(page)).toBe("");
    await expect(page.locator(`${VERSION} .comment-range`)).toHaveCount(0);

    // By the keys: Escape from a card with words in it keeps the card and goes to the page, nothing selected there.
    await selectShown(page, "quarter");
    await page.keyboard.press("Meta+Alt+m");
    await expect(draftBox(page)).toBeFocused();
    await page.keyboard.type("Which one?");
    await page.keyboard.press("Escape");
    await expect(page.locator(SHOWN_PAGE)).toBeFocused();
    expect(await selectedText(page)).toBe("");
    await expect(page.locator(DOC)).toHaveClass(/viewing-changes/);
    await expect(draftBox(page)).toHaveValue("Which one?");

    // Nothing selected: a comment on the whole document, as with Show changes off.
    await page.locator(PANEL).getByRole("button", { name: "Cancel" }).click();
    await newComment(page).click();
    await expect(draftBox(page)).toBeFocused();
    await expect(page.locator(`${PANEL} .comment-card.draft`)).toContainText("Whole document");
    await page.keyboard.press("Escape");
  } finally {
    await run.app.close();
    await claude.stop();
  }
});

test("an older version from History still takes no comment", async () => {
  const { run, claude } = await changesShown();
  const { page } = run;
  try {
    await page.keyboard.press("Escape");
    await page.getByRole("button", { name: "History", exact: true }).click();
    const first = page.locator(`${HISTORY} .history-item`).filter({ has: page.locator(".history-who", { hasText: "First version" }) });
    await first.click();
    await expect(page.locator(DOC)).toHaveClass(/viewing-version/);
    await expect(page.locator(DOC)).not.toHaveClass(/viewing-changes/);
    await expect(commentTool(page)).toBeDisabled();
    await expect.poll(() => menuEnabled(run, "comment-add")).toBe(false);
    await selectShown(page, "people");
    await page.keyboard.press("Meta+Alt+m");
    await clickMenu(run.app, "comment-add");
    await expect(page.locator(`${PANEL} .comment-card.draft`)).toHaveCount(0);
  } finally {
    await run.app.close();
    await claude.stop();
  }
});

test("in the Markdown view, a comment made with Show changes on lands on the same words in the text", async () => {
  const run = await openText(PLAN, { name: "plan.md" });
  const { page } = run;
  const claude = (await AgentSession.start(run.dataDir, "claude-code")).session;
  try {
    await clickMenu(run.app, "view-markdown");
    await claude.ok("take_document", { path: run.file, request: "Three, not two." });
    await claude.ok("edit_document", { path: run.file, edits: [{ find: "hire two people", replace: "hire three people" }] });
    await claude.ok("finish_editing", { path: run.file });
    await clickMenu(run.app, "view-changes");
    await expect(page.locator(DOC)).toHaveClass(/viewing-changes/);
    await expect(page.locator(`${VERSION} del.diff-removed`)).toHaveText("two");
    await selectShown(page, "budget is tight");
    await page.keyboard.press("Meta+Alt+m");
    await draftBox(page).fill("How tight?");
    await page.keyboard.press("Meta+Enter");
    await expect(page.locator(`${PANEL} .comment-card`).filter({ hasText: "How tight?" })).toHaveAttribute("aria-label", /^Comment by You on “budget is tight”/);
    const listed = await claude.ok("list_comments", { path: run.file });
    expect(listed).toContain("budget is tight");
    expect(readFileSync(run.file, "utf8")).toBe(AFTER);
  } finally {
    await run.app.close();
    await claude.stop();
  }
});
