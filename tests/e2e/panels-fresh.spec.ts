// What the panels' small marks and notes say, from the third fresh-eyes round
// (roadmap Batch 24, item 4: rows 14 to 17 of the findings). The real app,
// hidden, with a pretend Claude Desktop (an agent tool that can't wait), on a
// throwaway document and data folder it removes.
import { test, expect } from "@playwright/test";
import { rmSync } from "node:fs";
import { clickMenu, cursorAtEnd, openText, selectText, EDITOR, type Running } from "./helpers";
import { AgentSession } from "./agent-session";

const DOC = ".doc:not([hidden])";
const PANEL = `${DOC} aside.comments-panel`;
const TEXT = "# Plan\n\nWe should hire two people this quarter.\n\n## Later\n\nWe start in May.\n";

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

test("Copied goes once he types; the unread dot sits inside the card's corner, clear of its label; the outline's dot and count, and History's section chip, say what they are", async () => {
  run = await openText(TEXT, { name: "plan.md" });
  const r = run;
  const { page, app } = r;
  const { session: claude } = await AgentSession.start(r.dataDir, "claude-ai");
  sessions.push(claude);
  await claude.ok("open_document", { path: r.file });
  await claude.waitForReview().text; // answered at once: Claude Desktop can't wait
  await selectText(page, "two people");
  await page.keyboard.press("Meta+Alt+m");
  await page.keyboard.type("Make it three.");
  await page.keyboard.press("Meta+Enter");
  const card = page.locator(`${PANEL} .comment-card:not(.draft)`, { hasText: "Make it three." });
  await expect(card).toBeVisible();

  // Row 17 (N-20): Copy for Claude's note goes once he types, not only after a while.
  const button = page.locator(`${PANEL} .comments-hand-back`);
  await expect(button).toHaveText("Copy for Claude");
  await button.click();
  const note = page.locator(`${PANEL} .comments-note`);
  await expect(note).toHaveText("Copied. Paste it in Claude's chat.");
  await cursorAtEnd(page, "We start in May.");
  await page.keyboard.type(" Or June.");
  await expect(note).toBeHidden();

  // Claude answers it.
  const taken = await claude.ok("take_document", { path: r.file });
  const id = /\[([0-9a-f]+)\] on /.exec(taken)![1];
  await claude.ok("edit_document", { path: r.file, edits: [{ find: "hire two people", replace: "hire three people" }], comment_ids: [id] });
  await claude.ok("reply_to_comment", { path: r.file, comment_id: id, text: "Made it three." });
  await claude.ok("finish_editing", { path: r.file });
  await expect(page.locator(EDITOR)).toContainText("hire three people");

  // Row 16 (N-18): the unread dot inside the card's rounded corner, not on its edge, and clear of the label.
  const dot = card.locator(".card-new");
  await expect(dot).toBeVisible();
  const fit = await card.evaluate((c) => {
    const box = c.getBoundingClientRect();
    const d = c.querySelector(".card-new")!.getBoundingClientRect();
    const label = c.querySelector(".comment-quote, .comment-whole")!.getBoundingClientRect();
    const radius = parseFloat(getComputedStyle(c).borderTopLeftRadius);
    const edge = parseFloat(getComputedStyle(c).borderTopWidth);
    // How far the dot reaches from the centre of the corner's curve: inside the curve's inner edge.
    const cx = box.left + radius;
    const cy = box.top + radius;
    const dx = d.left + d.width / 2 - cx;
    const dy = d.top + d.height / 2 - cy;
    const reach = Math.hypot(Math.min(dx, 0), Math.min(dy, 0)) + d.width / 2;
    return {
      reach,
      inner: radius - edge,
      // Room between the dot and the label beside it, and between the dot and the card's edge.
      toLabel: label.left - d.right,
      toEdge: Math.min(d.left - box.left, d.top - box.top) - edge,
      // Its middle on the label's line.
      offLine: Math.abs(d.top + d.height / 2 - (label.top + label.height / 2)),
    };
  });
  expect(fit.reach).toBeLessThanOrEqual(fit.inner);
  expect(fit.toLabel).toBeGreaterThanOrEqual(1);
  expect(fit.toEdge).toBeGreaterThanOrEqual(2);
  expect(fit.offLine).toBeLessThanOrEqual(1);

  // Row 14 (W-15): the outline's dot and count say what they are where the pointer rests on them.
  await clickMenu(app, "view-outline");
  const plan = page.locator(".outline-pane .outline-row").first();
  await expect(plan.locator(".outline-count")).toHaveText("1");
  await expect(plan.locator(".outline-count")).toHaveAttribute("title", "1 open comment");
  await expect(plan.locator(".outline-dot")).toBeVisible();
  await expect(plan.locator(".outline-dot")).toHaveAttribute("title", "Changed since you handed it over");
  await clickMenu(app, "view-outline");

  // Row 15 (N-13): History's grey chip says it's where the version changed.
  await page.getByRole("button", { name: "History", exact: true }).click();
  const chip = page.locator(`${DOC} .history-item`, { hasText: "Claude" }).locator(".history-section").first();
  await expect(chip).toHaveText("Plan");
  await expect(chip).toHaveAttribute("title", "Changed in: Plan");
});
