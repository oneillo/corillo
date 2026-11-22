// An agent's note in focus stays in focus when the page is made afresh, as a
// comment's card does (Batch 22, item 5b, S21-30, his call). Restoring a
// version makes the page again from text; before this, the note's card lost
// its focus there and no card was in focus.
import { test, expect } from "@playwright/test";
import { openText, expectFile, cursorAtEnd, EDITOR } from "./helpers";
import { AgentSession } from "./agent-session";

const COMMENTS = ".doc:not([hidden]) aside.comments-panel";
const HISTORY = ".doc:not([hidden]) .history-panel";
const NOTE = `${COMMENTS} .pass-note`;

test("an agent's note in focus is still in focus after a version is restored", async () => {
  const run = await openText("# Plan\n\nWe should hire two people.\n");
  const { page } = run;
  await cursorAtEnd(page, "We should hire two people.");
  await page.keyboard.type(" Soon.");
  await expectFile(run, "# Plan\n\nWe should hire two people. Soon.\n");

  const { session: claude } = await AgentSession.start(run.dataDir, "claude-code");
  try {
    await claude.ok("take_document", { path: run.file });
    await claude.ok("finish_editing", { path: run.file, note: "The budget line may need a number." });
  } finally {
    await claude.stop();
  }
  await expect(page.locator(NOTE)).toBeVisible();
  await page.locator(`${NOTE} .pass-note-text`).click();
  await expect(page.locator(NOTE)).toHaveClass(/\bactive\b/);

  // Restore the first version: the page is made again from its text.
  await page.getByRole("button", { name: "History", exact: true }).click();
  await page.locator(`${HISTORY} .history-item`).filter({ has: page.locator(".history-who", { hasText: "First version" }) }).click();
  await page.getByRole("button", { name: "Restore this version" }).click();
  await expectFile(run, "# Plan\n\nWe should hire two people.\n");
  await expect(page.locator(`${EDITOR} p`)).toHaveText("We should hire two people.");
  await page.getByRole("button", { name: "Close history" }).click();

  // The note is still the card in focus, and the only one.
  await expect(page.locator(NOTE)).toBeVisible();
  await expect(page.locator(NOTE)).toHaveClass(/\bactive\b/);
  await expect(page.locator(`${COMMENTS} .comment-card.active`)).toHaveCount(1);
  await run.app.close();
});
