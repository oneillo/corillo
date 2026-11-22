// A comment whose words were deleted keeps its empty line, even when the same words are elsewhere
// (spec.md, Reviewing an agent's changes: "Words deleted keep their empty line even when the same
// words are elsewhere", "Only the very same words bring it back"). Its words come back only where
// they were, or in text just put in (Undo, Redo, a paste) (code review of Batch 16, R16-2 and W16-4).
import { test, expect, type Page } from "@playwright/test";
import { AgentSession } from "./agent-session";
import { clickMenu, cursorAtEnd, openText, selectText, settle, EDITOR, type Running } from "./helpers";
import { tidyRuns } from "./tidy";

const tidy = tidyRuns();
const PANEL = ".doc:not([hidden]) aside.comments-panel";
const card = (page: Page, text: string) => page.locator(`${PANEL} .comment-card:not(.draft)`, { hasText: text });
/** Each highlighted stretch, with the paragraph it's in. */
const highlights = (page: Page) =>
  page.locator(`${EDITOR} .comment-range`).evaluateAll((all) => all.map((e) => `${e.textContent} in "${e.closest("p")?.textContent}"`));
/** What a card says, its notes too (shown on the card in focus only). */
const cardText = async (page: Page, body: string) => ((await card(page, body).textContent()) ?? "").replace(/\s+/g, " ");
/** The empty lines drawn where a comment's words were deleted. */
const gaps = (page: Page) => page.locator(`${EDITOR} .comment-gap`).count();

/** The card put in focus with a click: what the person reads on it (its change row shows only then). */
async function shownOnCard(page: Page, body: string): Promise<string> {
  await card(page, body).click();
  await settle(page);
  return (await card(page, body).innerText()).replace(/\s+/g, " ");
}

async function comment(run: Running, text: string, body: string): Promise<void> {
  await selectText(run.page, text);
  await run.page.getByRole("button", { name: "Comment", exact: true }).click();
  const box = run.page.getByRole("textbox", { name: "New comment" });
  await expect(box).toBeFocused();
  await box.fill(body);
  await run.page.getByRole("button", { name: "Post" }).click();
  await expect(card(run.page, body)).toBeVisible();
}

/** Select a one-line paragraph's words from its end to its start, and delete them (the paragraph stays, empty). */
async function deleteWordsOf(page: Page, paragraph: string): Promise<void> {
  await cursorAtEnd(page, paragraph);
  await page.keyboard.press("Shift+Meta+ArrowLeft");
  await settle(page);
  await page.keyboard.press("Backspace");
  await settle(page);
}

// The comment goes on the first "costs": the one in the second paragraph.
const DOC = "Next steps follow below this line.\n\nThe costs will be reported soon.\n\nAll the costs are estimates.\n";
const WITHOUT = "Next steps follow below this line.\n\nAll the costs are estimates.\n";
const ON_SECOND = ['costs in "The costs will be reported soon."'];

test("words deleted, then the document closed and opened again: the comment keeps its empty line, not the same word in the next paragraph", async () => {
  const run = tidy.keep(await openText(DOC, { name: "notes.md" }));
  await comment(run, "costs", "Which costs?");
  await deleteWordsOf(run.page, "The costs will be reported soon.");
  await expect.poll(() => highlights(run.page)).toEqual([]);
  await expect(card(run.page, "Which costs?")).toContainText("The text it was on was deleted.");
  await run.page.keyboard.press("Meta+s");
  await settle(run.page);
  await clickMenu(run.app, "close-tab");
  await expect(run.page.locator(".tab")).toHaveCount(0);
  await run.page.evaluate((p) => window.corillo.openPath(p), run.file);
  await expect(card(run.page, "Which costs?")).toBeVisible();
  await settle(run.page);
  expect(await highlights(run.page)).toEqual([]);
  expect(await cardText(run.page, "Which costs?")).toContain("The text it was on was deleted.");
  expect(await gaps(run.page)).toBe(1);
  expect(await shownOnCard(run.page, "Which costs?")).toContain("The text it was on was deleted.");
});

test("words deleted, something else typed and undone: the comment keeps its empty line; a second Undo puts its words back and the comment on them", async () => {
  const run = tidy.keep(await openText(DOC));
  await comment(run, "costs", "Which costs?");
  await deleteWordsOf(run.page, "The costs will be reported soon.");
  await expect.poll(() => highlights(run.page)).toEqual([]);
  await expect(card(run.page, "Which costs?")).toContainText("The text it was on was deleted.");
  // Typed well after the deletion, so Undo takes back only this.
  await run.page.waitForTimeout(900);
  await cursorAtEnd(run.page, "Next steps follow below this line.");
  await run.page.keyboard.type(" More.");
  await expect(run.page.locator(`${EDITOR} p`).first()).toHaveText("Next steps follow below this line. More.");
  await run.page.keyboard.press("Meta+z");
  await expect(run.page.locator(`${EDITOR} p`).first()).toHaveText("Next steps follow below this line.");
  await settle(run.page);
  expect((await run.page.locator(`${EDITOR} p`).allTextContents()).filter((p) => p.includes("costs"))).toEqual(["All the costs are estimates."]);
  expect(await highlights(run.page)).toEqual([]);
  expect(await cardText(run.page, "Which costs?")).toContain("The text it was on was deleted.");
  expect(await gaps(run.page)).toBe(1);
  expect(await shownOnCard(run.page, "Which costs?")).toContain("The text it was on was deleted.");
  // Its own words put back by Undo: the comment is on them again.
  await run.page.locator(`${EDITOR} .ProseMirror`).focus();
  await run.page.keyboard.press("Meta+z");
  await expect.poll(() => highlights(run.page)).toEqual(ON_SECOND);
  expect(await gaps(run.page)).toBe(0);
});

// Code review of Batch 16's fixes, B16R-1: an Undo next to the same word elsewhere put the comment on that word.
for (const [how, edit] of [
  ["a letter typed right after", async (page: Page) => {
    await selectText(page, "costs are");
    await page.keyboard.press("ArrowLeft");
    for (let i = 0; i < 5; i++) await page.keyboard.press("ArrowRight");
    await page.keyboard.type("s");
  }],
  ["the same word typed over", async (page: Page) => {
    await selectText(page, "costs are");
    await page.keyboard.press("Shift+ArrowLeft");
    await page.keyboard.press("Shift+ArrowLeft");
    await page.keyboard.press("Shift+ArrowLeft");
    await page.keyboard.press("Shift+ArrowLeft");
    await page.keyboard.type("expenses");
  }],
] as const) {
  test(`words deleted, then ${how} the same word in the next paragraph and undone: the comment keeps its empty line; a second Undo puts its words back`, async () => {
    const run = tidy.keep(await openText(DOC));
    const { page } = run;
    await comment(run, "costs", "Which costs?");
    await deleteWordsOf(page, "The costs will be reported soon.");
    await expect.poll(() => highlights(page)).toEqual([]);
    await page.waitForTimeout(900); // a separate step for Undo
    await edit(page);
    await expect(page.locator(`${EDITOR} p`).last()).not.toHaveText("All the costs are estimates.");
    await page.keyboard.press("Meta+z");
    await expect(page.locator(`${EDITOR} p`).last()).toHaveText("All the costs are estimates.");
    await settle(page);
    expect(await highlights(page)).toEqual([]);
    expect(await gaps(page)).toBe(1);
    expect(await shownOnCard(page, "Which costs?")).toContain("The text it was on was deleted.");
    await page.locator(`${EDITOR} .ProseMirror`).focus();
    await page.keyboard.press("Meta+z");
    await expect.poll(() => highlights(page)).toEqual(ON_SECOND);
    expect(await gaps(page)).toBe(0);
  });
}

test("an agent deletes the paragraph a one-word comment was in: an empty line keeps its place, not the same word in the next paragraph", async () => {
  const run = tidy.keep(await openText(DOC));
  await comment(run, "costs", "Which costs?");
  const claude = (await AgentSession.start(run.dataDir, "claude-code")).session;
  try {
    const taken = await claude.ok("take_document", { path: run.file });
    const id = /\[([^\]]+)\] on "costs"/.exec(taken)?.[1];
    await claude.ok("edit_document", { path: run.file, edits: [{ find: "The costs will be reported soon.\n\n", replace: "" }], comment_ids: [id] });
    await claude.ok("reply_to_comment", { path: run.file, comment_id: id, text: "Cut." });
    await claude.ok("finish_editing", { path: run.file });
    await expect(run.page.locator(`${EDITOR} p`)).toHaveCount(2);
    await settle(run.page);
    expect(run.text()).toBe(WITHOUT);
    expect(await highlights(run.page)).toEqual([]);
    expect(await run.page.locator(`${EDITOR} .comment-gap`).count()).toBe(1);
  } finally {
    await claude.stop();
  }
});

// Code review of Batch 16, S-1: words selected with the keys, then ⌥⌘M at once, before the editor
// had heard of the selection, made a comment on the whole document.
test("words selected with the keys and ⌥⌘M pressed straight after: the comment is on those words", async () => {
  const run = tidy.keep(await openText("# Plan\n\nWe should hire two people this spring.\n\nThe budget is tight but workable.\n", { name: "plan.md" }));
  const { page } = run;
  await page.locator(`${EDITOR} .ProseMirror`).focus();
  await page.keyboard.press("Meta+ArrowUp");
  for (const [i, word] of ["alpha", "bravo", "charlie"].entries()) {
    await page.keyboard.press("ArrowDown");
    await page.keyboard.press("Meta+ArrowRight");
    await page.keyboard.type(` ${word}`);
    await page.keyboard.press("Alt+Shift+ArrowLeft");
    await page.keyboard.press("Meta+Alt+KeyM");
    const box = page.getByRole("textbox", { name: "New comment" });
    await expect(box).toBeFocused();
    await box.fill(`note ${i}`);
    await page.keyboard.press("Meta+Enter");
    await expect(card(page, `note ${i}`).locator(".comment-quote")).toHaveText(word);
    await page.locator(`${EDITOR} .ProseMirror`).focus();
  }
});
