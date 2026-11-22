// "Show what it said before" turns off when Show changes or an older version
// takes the page (roadmap Batch 24, row 10 of review/batch-24/findings.md: W-3,
// a change of how he works, merged on its own). The real app, hidden, with a
// pretend agent, on throwaway documents and data folders it removes.
import { test, expect, type Page } from "@playwright/test";
import { rmSync } from "node:fs";
import { openText, selectText, EDITOR, type Running } from "./helpers";
import { AgentSession } from "./agent-session";

const DOC = ".doc:not([hidden])";
const PANEL = `${DOC} aside.comments-panel`;
const TEXT = "# Plan\n\nWe should hire two people this quarter.\n\nThe budget is tight.\n\n## Later\n\nWe start in May.\n";

const card = (page: Page, body: string) => page.locator(`${PANEL} .comment-card:not(.draft)`, { hasText: body });

let run: Running | null = null;
const sessions: AgentSession[] = [];

test.afterEach(async () => {
  for (const s of sessions.splice(0)) await s.stop().catch(() => undefined);
  const r = run;
  run = null;
  if (!r) return;
  await r.app.evaluate(({ app }) => setTimeout(() => app.exit(0), 10)).catch(() => undefined);
  await r.app.close().catch(() => undefined);
  for (const dir of [r.folder, r.dataDir]) rmSync(dir, { recursive: true, force: true });
});

async function start(text = TEXT): Promise<Running> {
  run = await openText(text, { name: "plan.md" });
  return run;
}

async function comment(page: Page, words: string, body: string): Promise<void> {
  await selectText(page, words);
  await page.keyboard.press("Meta+Alt+m");
  await expect(page.getByRole("textbox", { name: "New comment" })).toBeFocused();
  await page.keyboard.type(body);
  await page.keyboard.press("Meta+Enter");
  await expect(card(page, body)).toBeVisible();
}

// Row 10 (W-3), a change of how he works: "Show what it said before" stayed on through Show changes and History.
test("what an agent's change said before turns off when Show changes or an older version takes the page", async () => {
  const r = await start();
  const { page: p } = r;
  await comment(p, "two people", "Make it three.");
  const { session: claude } = await AgentSession.start(r.dataDir, "claude-code");
  sessions.push(claude);
  const taken = await claude.ok("take_document", { path: r.file });
  const id = /\[([0-9a-f]+)\] on /.exec(taken)![1];
  await claude.ok("edit_document", { path: r.file, edits: [{ find: "hire two people", replace: "hire three people" }], comment_ids: [id] });
  await claude.ok("reply_to_comment", { path: r.file, comment_id: id, text: "Made it three." });
  await claude.ok("finish_editing", { path: r.file });
  const active = card(p, "Make it three.");
  const before = p.locator(`${EDITOR} del.change-before`);
  for (const [how, key] of [["Show changes", "Control+Meta+c"], ["History", "Control+Meta+h"]] as const) {
    await active.click();
    await active.getByRole("button", { name: "Show what it said before" }).click();
    await expect(before).toHaveText(["two"]);
    if (how === "History") {
      await p.keyboard.press(key);
      await p.locator(`${DOC} .history-panel .history-item`).nth(1).click();
    } else await p.keyboard.press(key);
    await expect(p.locator(`${DOC} .version-banner`)).toBeVisible();
    await p.locator(`${DOC} .version-page`).focus();
    await p.keyboard.press("Escape");
    await expect(p.locator(`${DOC} .version-banner`)).toBeHidden();
    await expect(before, how).toHaveCount(0);
    if (how === "History") await p.keyboard.press(key);
  }
});
