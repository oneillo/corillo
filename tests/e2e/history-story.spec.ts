// History reads as the story of the document (roadmap Batch 4, item 2,
// L-10): each row names the sections its version changed, your own rows say
// what you changed, and several of your versions in a row are one row.
import { test, expect, type Page } from "@playwright/test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openText, expectFile, cursorAtEnd, EDITOR } from "./helpers";
import { AgentSession } from "./agent-session";
import { longSession } from "../fixtures/long-history";

const PANEL = ".doc:not([hidden]) .history-panel";
const BANNER = ".doc:not([hidden]) .version-banner";
const VERSION = ".doc:not([hidden]) .version-view .ProseMirror";

const DOC = `# Plan

## Budget

The budget is tight.

## Hiring

We should hire two people.

## Risks

Nobody answers the phone.
`;

const openHistory = (page: Page) => page.getByRole("button", { name: "History", exact: true }).click();
const row = (page: Page, who: string | RegExp) => page.locator(`${PANEL} .history-item`).filter({ has: page.locator(".history-who", { hasText: who }) });

// Review of Batch 4, B4-R04: a row that changed many sections names the
// first few and says how many more, rather than cutting the rest silently.
test("a pass over thirty sections names the first six and says how many more, with nothing cut", async () => {
  const parts = Array.from({ length: 30 }, (_, i) => `## Part ${i + 1}\n\nWords ${i + 1}.\n`).join("\n");
  const run = await openText(parts);
  const { page } = run;
  const { session } = await AgentSession.start(run.dataDir);
  try {
    await session.ok("take_document", { path: run.file });
    await session.ok("edit_document", { path: run.file, edits: Array.from({ length: 30 }, (_, i) => ({ find: `Words ${i + 1}.`, replace: `Words ${i + 1}, changed.` })) });
    await session.ok("finish_editing", { path: run.file });
  } finally {
    await session.stop();
  }
  await expect(page.locator(EDITOR)).toContainText("Words 30, changed.");
  await openHistory(page);
  const line = row(page, "Claude").locator(".history-sections");
  await expect(line.locator(".history-section")).toHaveText(["Part 1", "Part 2", "Part 3", "Part 4", "Part 5", "Part 6"]);
  await expect(line.locator(".history-sections-more")).toHaveText("and 24 more");
  await expect(line).toHaveAttribute("title", "The sections it changed: the first 6 of 30");
  // Nothing in the line is cut off.
  expect(await line.evaluate((e) => e.scrollHeight <= e.clientHeight + 1)).toBe(true);
  await run.app.close();
});

test("an agent's row names the sections it changed; your own row names them and says what you changed", async () => {
  const run = await openText(DOC);
  const { page } = run;
  const { session } = await AgentSession.start(run.dataDir);
  try {
    await session.ok("take_document", { path: run.file });
    await session.ok("edit_document", {
      path: run.file,
      edits: [
        { find: "hire two", replace: "hire three" },
        { find: "is tight", replace: "is very tight" },
      ],
    });
    await session.ok("finish_editing", { path: run.file });
  } finally {
    await session.stop();
  }
  await expect(page.locator(EDITOR)).toContainText("hire three");
  await cursorAtEnd(page, "Nobody answers the phone.");
  await page.keyboard.type(" Not even on Mondays.");
  await expectFile(run, DOC.replace("hire two", "hire three").replace("is tight", "is very tight").replace("the phone.", "the phone. Not even on Mondays."));

  await openHistory(page);
  // In the order they come in the document, whatever order the agent made them in.
  await expect(row(page, "Claude").locator(".history-section")).toHaveText(["Budget", "Hiring"]);
  // An agent's change lines are under the comments it answered: the row doesn't repeat them.
  await expect(row(page, "Claude").locator(".history-story .history-change")).toHaveCount(0);
  const mine = row(page, /^You$/);
  await expect(mine.locator(".history-section")).toHaveText(["Risks"]);
  await expect(mine.locator(".history-story .history-change ins")).toHaveText("Not even on Mondays.");
  // The first version changed nothing: it says nothing.
  await expect(row(page, "First version").locator(".history-story")).toHaveCount(0);

  // Your row follows as you type, the row itself kept.
  const kept = await mine.elementHandle();
  await cursorAtEnd(page, "We should hire three people.");
  await page.keyboard.type(" Soon.");
  await expect(mine.locator(".history-section")).toHaveText(["Hiring", "Risks"]);
  expect(await kept!.evaluate((e) => e.isConnected)).toBe(true);
  await run.app.close();
});

test("several of your versions in a row are one row: it shows what they changed together, and opens to each of them, any of which can be restored", async () => {
  const run = await openText(DOC);
  const { page } = run;
  const { session } = await AgentSession.start(run.dataDir);
  /** An agent takes the document and gives it back without changing anything: your next edits are a new version. */
  const takeAndGiveBack = async () => {
    await session.ok("take_document", { path: run.file });
    await session.ok("finish_editing", { path: run.file });
  };
  try {
    await cursorAtEnd(page, "The budget is tight.");
    await page.keyboard.type(" For now.");
    await expectFile(run, DOC.replace("tight.", "tight. For now."));
    await takeAndGiveBack();
    await cursorAtEnd(page, "Nobody answers the phone.");
    await page.keyboard.type(" Ever.");
    await expectFile(run, DOC.replace("tight.", "tight. For now.").replace("phone.", "phone. Ever."));
    await takeAndGiveBack();
    await cursorAtEnd(page, "We should hire two people.");
    await page.keyboard.type(" Maybe.");
    await expectFile(run, DOC.replace("tight.", "tight. For now.").replace("phone.", "phone. Ever.").replace("people.", "people. Maybe."));
  } finally {
    await session.stop();
  }

  await openHistory(page);
  await expect(page.locator(`${PANEL} .history-who`)).toHaveText(["You · 3 versions", "First version"]);
  const fold = row(page, "You · 3 versions");
  await expect(fold.locator(".history-tag")).toHaveText("Current");
  // What the three changed together, in the order the sections come.
  await expect(fold.locator(".history-section")).toHaveText(["Budget", "Hiring", "Risks"]);
  await expect(fold.locator(".history-change ins")).toHaveText(["For now.", "Maybe.", "Ever."]);

  // Clicked: everything they changed, marked, and each of them listed.
  await fold.click();
  await expect(fold).toHaveAttribute("aria-current", "true");
  await expect(page.locator(BANNER)).toContainText("Showing what you changed in your last 3 versions");
  await expect(page.locator(`${VERSION} ins.diff-added`)).toHaveText([" For now.", " Maybe.", " Ever."]);
  const members = page.locator(`${PANEL} .history-member`);
  await expect(members).toHaveCount(3);
  await expect(members.nth(2).locator(".history-section")).toHaveText(["Budget"]);
  await expect(members.nth(0).locator(".history-change ins")).toHaveText("Maybe.");

  // The oldest of them, on its own: what it changed, and Restore.
  await members.nth(2).click();
  await expect(members.nth(2)).toHaveAttribute("aria-current", "true");
  await expect(fold).toHaveAttribute("aria-current", "false");
  await expect(page.locator(BANNER)).toContainText("Version from");
  await expect(page.locator(`${VERSION} ins.diff-added`)).toHaveText(" For now.");
  await page.getByRole("button", { name: "Restore this version" }).click();
  await expectFile(run, DOC.replace("tight.", "tight. For now."));
  // The restore is a version of its own, after the three.
  await expect(page.locator(`${PANEL} .history-who`)).toHaveText([/^Restored/, "You · 3 versions", "First version"]);

  // Once they're not the newest, they're shown together with Restore, which brings back the newest of them.
  await row(page, "You · 3 versions").click();
  await expect(page.locator(BANNER)).toContainText("Your 3 versions in a row");
  await page.getByRole("button", { name: "Restore this version" }).click();
  await expectFile(run, DOC.replace("tight.", "tight. For now.").replace("phone.", "phone. Ever.").replace("people.", "people. Maybe."));
  await run.app.close();
});

test("on a long history, only the rows in sight are worked out; the rest as they're scrolled to", async () => {
  test.setTimeout(120_000);
  const dataDir = mkdtempSync(join(tmpdir(), "corillo-data-"));
  const made: { session?: ReturnType<typeof longSession> } = {};
  const run = await openText("", { name: "plan.md", dataDir, prepare: (folder) => (made.session = longSession({ passes: 60, data: dataDir, file: join(folder, "plan.md") })) });
  const { page } = run;
  const versions = made.session!.texts.length;
  await openHistory(page);
  const rows = page.locator(`${PANEL} .history-entry`);
  await expect(rows).toHaveCount(versions);
  await expect(rows.first().locator(".history-section")).toHaveText(["Help desk proposal"]);
  await expect(rows.nth(3).locator(".history-section")).toHaveText(["Help desk proposal"]);
  await page.waitForTimeout(500);
  // Far down the list, nothing yet.
  const told = () => page.locator(`${PANEL} .history-entry .history-section`).count();
  const before = await told();
  expect(before).toBeLessThan(versions / 2);
  // Scrolled to the end: the rows there are worked out too.
  await page.locator(`${PANEL} .history-list`).evaluate((list) => (list.scrollTop = list.scrollHeight));
  await expect(rows.nth(versions - 2).locator(".history-section")).toHaveText(["Help desk proposal"]);
  expect(await told()).toBeGreaterThan(before);
  await run.app.close();
});
