// Every control has a name and a role a screen reader would read (roadmap
// Batch 12, item 3, the second standing test). In each main state of the
// window, every button, link, field, tab, menu, list, panel and dialog drawn
// has a role that says what it is, and a name; nothing the keyboard can reach
// is a bare "generic". Read from the accessibility tree (namesAndRoles in
// contrast.ts), never by turning VoiceOver on. The real app runs hidden, with
// a pretend Claude, on a throwaway document and data folder it removes.
import { test, expect, type Page } from "@playwright/test";
import { clickMenu, openText, selectText } from "./helpers";
import { AgentSession } from "./agent-session";
import { namesAndRoles } from "./contrast";
import { tidyRuns } from "./tidy";

const tidy = tidyRuns();
const DOC = ".doc:not([hidden])";
const PANEL = `${DOC} .comments-panel`;
const TEXT = `# Volunteer help desk

Requests reach us through four inboxes and two group chats.

## Where we are today

Last quarter we answered 1,840 requests.

| Month | Requests |
| --- | --- |
| April | 590 |

## What we'd like

One shared help desk, tried for three months over the summer.
`;

test("every control in the window has a name and a role, in each main state", async () => {
  test.setTimeout(90_000);
  const run = tidy.keep(await openText(TEXT, { name: "Plan.md" }));
  const { app, page } = run;
  const short: string[] = [];
  let states = 0;
  const check = async (state: string, on: Page = page) => {
    await on.evaluate(() => new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r))));
    const { checked, noName, noRole } = await namesAndRoles(on);
    expect(checked.length, `${state}: something to check`).toBeGreaterThan(1);
    for (const n of [...noName, ...noRole]) short.push(`${state}: ${n.what}, role "${n.role}", name "${n.name}"`);
    states++;
  };

  // With comments.
  for (const [words, body] of [
    ["four inboxes", "Can we say which inboxes?"],
    ["1,840 requests", "Is this the right number?"],
  ]) {
    await selectText(page, words);
    await page.getByRole("button", { name: "Comment", exact: true }).click();
    await page.getByRole("textbox", { name: "New comment" }).fill(body);
    await page.getByRole("button", { name: "Post" }).click();
    await expect(page.locator(`${PANEL} .comment-card:not(.draft)`, { hasText: body })).toBeVisible();
  }
  await check("with comments");

  // Claude done, with an option on its reply and a change no comment asked for.
  const { session } = await AgentSession.start(run.dataDir, "claude-code");
  try {
    const taken = await session.ok("take_document", { path: run.file, request: "Say when in summer." });
    const ids = new Map([...taken.matchAll(/\[([^\]]+)\] on "([^"]+)"/g)].map((m) => [m[2], m[1]]));
    const inboxes = ids.get("four inboxes")!;
    await session.ok("edit_document", { path: run.file, edits: [{ find: "four inboxes", replace: "four inboxes (help, info, volunteers and events)" }], comment_ids: [inboxes] });
    await session.ok("edit_document", { path: run.file, edits: [{ find: "over the summer.", replace: "over the summer, from July." }] });
    await session.ok("reply_to_comment", { path: run.file, comment_id: inboxes, text: "Named all four.", options: [{ label: "Shorter", edits: [{ find: "(help, info, volunteers and events)", replace: "(four of them)" }] }] });
    await session.ok("reply_to_comment", { path: run.file, comment_id: ids.get("1,840 requests")!, text: "Yes: April to June." });
    await session.ok("finish_editing", { path: run.file });
  } finally {
    await session.stop();
  }
  await expect(page.locator(`${DOC} .pass-notice`)).toBeVisible();
  await expect(page.locator(`${PANEL} .comment-option`, { hasText: "Shorter" })).toBeVisible();
  await check("Claude done, with an option");

  // History, with an earlier version shown.
  await page.getByRole("button", { name: "History", exact: true }).click();
  await expect(page.locator(`${DOC} .history-item`)).not.toHaveCount(0);
  await page.locator(`${DOC} .history-item`).last().click();
  await expect(page.locator(`${DOC} .version-banner`)).toBeVisible();
  await check("History, a version shown");
  await page.getByRole("button", { name: "Back to current" }).click();
  await page.getByRole("button", { name: "History", exact: true }).click();

  // Show changes.
  await clickMenu(app, "view-changes");
  await expect(page.locator(`${DOC} .version-steps`)).toBeVisible();
  await check("Show changes");
  await clickMenu(app, "view-changes");

  // Find and replace.
  await page.locator(`${DOC} .ProseMirror h1`).click();
  await page.keyboard.press("Meta+Alt+F");
  await page.getByRole("textbox", { name: "Find" }).fill("help");
  await check("Find and replace");
  await page.getByRole("textbox", { name: "Find" }).press("Escape");

  // The outline.
  await clickMenu(app, "view-outline");
  await expect(page.locator(`${DOC} .outline-pane`)).toBeVisible();
  await check("the outline");
  await clickMenu(app, "view-outline");

  // The Markdown view.
  await clickMenu(app, "view-markdown");
  await expect(page.locator(`${DOC} .source`)).toBeVisible();
  await check("the Markdown view");
  await clickMenu(app, "view-formatted");

  // A dialog.
  await clickMenu(app, "export-settings");
  await expect(page.getByRole("dialog", { name: "Export settings" })).toBeVisible();
  await check("Export settings");
  await page.keyboard.press("Escape");

  // The start screen, and a dialog over it.
  await clickMenu(app, "close-tab");
  await expect(page.locator("#recent .recent-card")).not.toHaveCount(0);
  await check("the start screen");
  await clickMenu(app, "connect-agents");
  await expect(page.getByRole("dialog", { name: "Connect your agents" })).toBeVisible();
  await check("Connect your agents");

  expect(states).toBe(10);
  expect(short, "controls with no name, or reachable with no role").toEqual([]);
});
