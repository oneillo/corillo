// The whole round of feedback, end to end: the person reviews in the window
// and leaves comments; an agent, through Corillo's connector, takes the
// document, edits it, replies on each comment and finishes; then the person
// sees the replies, the new text, the dot on the tab, and one version by the
// agent in the history with the feedback it addressed.
import { test, expect, type Page } from "@playwright/test";
import { readFileSync } from "node:fs";
import { openText, openAlso, selectText, settle, cursorAtEnd, EDITOR } from "./helpers";
import { AgentSession } from "./agent-session";

const PROPOSAL = `# Volunteer help desk

We should hire two people this quarter to answer questions from volunteers.

## Budget

The budget is tight.

## Next steps

Start in March.
`;

const PANEL = ".doc:not([hidden]) aside.comments-panel";
const card = (page: Page, text: string) => page.locator(`${PANEL} .comment-card:not(.draft)`, { hasText: text });

/** The person comments as they would: select words (or nothing, for the whole document), Comment, type, Post. */
async function comment(page: Page, on: string | null, body: string): Promise<void> {
  if (on) await selectText(page, on);
  else await cursorAtEnd(page, "Start in March.");
  await page.getByRole("button", { name: "Comment", exact: true }).click();
  const box = page.getByRole("textbox", { name: "New comment" });
  await expect(box).toBeFocused();
  await box.fill(body);
  await page.getByRole("button", { name: "Post" }).click();
  await expect(card(page, body)).toBeVisible();
  await settle(page);
}

test("the whole loop: the person comments, the agent edits, replies and finishes, and the person sees it all", async () => {
  const run = await openText(PROPOSAL, { name: "proposal.md" });
  const { page } = run;

  // The person reviews: two comments on words, one on the whole document, then moves on to other work.
  await comment(page, "two people", "Make it three.");
  await comment(page, "The budget is tight.", "Give the figure.");
  await comment(page, null, "Add a one-line summary at the top.");
  await openAlso(run, "notes.md", "My own notes.\n");

  // The agent is told there's feedback, and does its pass.
  const { session: claude } = await AgentSession.start(run.dataDir, "claude-code");
  const taken = await claude.ok("take_document", { path: run.file });
  expect(taken).toContain("You're editing proposal.md now.");
  expect(taken).toContain("3 comments on proposal.md waiting for you");
  const idFor = (body: string) => new RegExp(`\\[([0-9a-f]{8,})\\] [^\\n]*\\n  Person: ${body}`).exec(taken)![1];
  const replies: [string, string][] = [
    ["Make it three.", "Changed to three people."],
    ["Give the figure.", "Added the figure: $40,000."],
    ["Add a one-line summary at the top.", "Added a summary under the title."],
  ];
  await claude.ok("edit_document", {
    path: run.file,
    edits: [
      { find: "hire two people", replace: "hire three people" },
      { find: "The budget is tight.", replace: "The budget is tight: $40,000 for the year." },
      { find: "# Volunteer help desk\n", replace: "# Volunteer help desk\n\nSummary: three new hires to answer volunteers, within $40,000.\n" },
    ],
  });
  for (const [body, reply] of replies) await claude.ok("reply_to_comment", { path: run.file, comment_id: idFor(body), text: reply });
  expect(await claude.ok("finish_editing", { path: run.file })).toMatch(/^Done\. proposal\.md is back with the person\. They read your replies in Corillo, so in the chat a line is enough/);

  // The tab's dot says it's back; looking at it clears the dot.
  const tab = page.locator('.tab[title$="/proposal.md"]');
  await expect(tab.locator(".tab-dot")).toBeVisible();
  await tab.click();
  await expect(tab.locator(".tab-dot")).toBeHidden();

  // The new text, in the window and the file.
  await expect(page.locator(`${EDITOR} p`).first()).toHaveText("Summary: three new hires to answer volunteers, within $40,000.");
  await expect(page.locator(`${EDITOR} p`, { hasText: "hire three people" })).toBeVisible();
  expect(readFileSync(run.file, "utf8")).toContain("The budget is tight: $40,000 for the year.");
  await expect(page.locator(".doc:not([hidden]) .agent-notice")).toBeHidden();

  // Each comment has the agent's reply under its name, and stays open for the person to resolve.
  for (const [body, reply] of replies) {
    const answer = card(page, body).locator(".comment-message").nth(1);
    await expect(answer.locator(".comment-author")).toHaveText("Claude");
    await expect(answer.locator(".comment-body")).toHaveText(reply);
  }
  // Three comments, and only those: the agent's edits here aren't tied to them, and such changes have no card (roadmap Batch 9, item 5).
  await expect(page.locator(`${PANEL} .comment-card:not(.draft)`)).toHaveCount(3);
  // The comments on words still sit on their (changed) words.
  await expect(card(page, "Make it three.")).not.toContainText("has changed");
  await expect(card(page, "Give the figure.")).not.toContainText("has changed");

  // History: one version by Claude, listing the comments it addressed and its replies.
  await page.getByRole("button", { name: "History", exact: true }).click();
  const history = ".doc:not([hidden]) .history-panel";
  await expect.poll(() => page.locator(`${history} .history-who`).allTextContents()).toEqual(["Claude", "First version"]);
  const version = page.locator(`${history} .history-item`).first();
  await expect(version.locator(".history-comment")).toHaveText(replies.map(([body]) => body));
  await expect(version.locator(".history-reply")).toHaveText(replies.map(([, reply]) => reply));

  await run.app.close();
  await claude.stop();
});
