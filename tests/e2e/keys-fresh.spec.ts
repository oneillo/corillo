// Where the keyboard goes, and what is said, in the panels, from the third
// fresh-eyes round (roadmap Batch 24, item 4: the findings' rows for the
// Comments panel, History, Show changes and the outline). Driven by keys, as
// the keys-only reviewer was: after each step the keyboard is somewhere he
// can see, never nowhere. Each test runs the real app, hidden, with a pretend
// agent where one is needed, on throwaway documents and data folders it removes.
import { test, expect, type Page } from "@playwright/test";
import { rmSync } from "node:fs";
import { clickMenu, openText, selectText, settle, EDITOR, type Running } from "./helpers";
import { AgentSession } from "./agent-session";

const DOC = ".doc:not([hidden])";
const PANEL = `${DOC} aside.comments-panel`;
const TEXT = "# Plan\n\nWe should hire two people this quarter.\n\nThe budget is tight.\n\n## Later\n\nWe start in May.\n";

const card = (page: Page, body: string) => page.locator(`${PANEL} .comment-card:not(.draft)`, { hasText: body });

/** Where the keyboard is: "nowhere", "document", "version", "outline", "card: <its first words>", or "<a control's name> in <where>". */
const keyboard = (page: Page) =>
  page.evaluate(() => {
    const a = document.activeElement as HTMLElement | null;
    if (!a || a === document.body) return "nowhere";
    if (a.closest(".version-page")) return "version";
    if (a.closest(".ProseMirror")) return "document";
    if (a.closest(".outline-pane")) return "outline";
    const first = (c: Element | null) => (c?.querySelector(".comment-body")?.textContent ?? "").trim();
    if (a.classList.contains("comment-card")) return `card: ${first(a)}`;
    const name = (a.getAttribute("aria-label") || a.textContent || "").trim();
    const where = a.closest(".comment-card") ? `card: ${first(a.closest(".comment-card"))}` : a.closest(".comments-panel") ? "panel" : a.closest(".history-panel") ? "history" : a.closest(".version-banner") ? "bar" : "window";
    return `${name} in ${where}`;
  });

const selected = (page: Page) => page.evaluate(() => getSelection()?.toString() ?? "");

/** What the Comments panel's note says, for the eye and a screen reader (role status). */
const panelSays = (page: Page) => page.locator(`${PANEL} .comments-note[role=status]`);

async function tabTo(page: Page, name: string | RegExp, max = 12): Promise<void> {
  for (let i = 0; i < max; i++) {
    const at = await page.evaluate(() => {
      const a = document.activeElement as HTMLElement | null;
      return (a?.getAttribute("aria-label") || a?.textContent || "").trim();
    });
    if (typeof name === "string" ? at === name : name.test(at)) return;
    await page.keyboard.press("Tab");
  }
  throw new Error(`Tab didn't reach ${name}: the keyboard is on ${await keyboard(page)}`);
}

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

// Row 3 (K-2) and row 6 (K-6).
test("Return on a card's Resolve tick goes on to the next card and says so; hiding the comments or the outline with the keyboard in them puts it back in the page", async () => {
  const { page, app } = await start();
  await comment(page, "two people", "Make it three.");
  await comment(page, "budget", "By how much?");
  await comment(page, "May", "Which day?");
  // Resolve by its tick, with Return: on to the next card, as the shortcut does, and "Comment resolved" said.
  await page.keyboard.press("Meta+Alt+ArrowDown");
  await expect.poll(() => keyboard(page)).toBe("card: Make it three.");
  await page.keyboard.press("Meta+Alt+ArrowDown");
  await expect.poll(() => keyboard(page)).toBe("card: By how much?");
  await tabTo(page, "Resolve");
  await page.keyboard.press("Enter");
  await expect(card(page, "By how much?")).toHaveCount(0);
  await expect.poll(() => keyboard(page)).toBe("card: Which day?");
  await expect(panelSays(page)).toHaveText("Comment resolved");
  // The shortcut says it too.
  await page.keyboard.press("Meta+Alt+Enter");
  await expect(card(page, "Which day?")).toHaveCount(0);
  await expect.poll(() => keyboard(page)).toBe("card: Make it three.");
  await expect(panelSays(page)).toHaveText("Comment resolved");

  // Hiding the comments with the keyboard on a card: back to the page.
  await clickMenu(app, "view-comments");
  await expect(page.locator(PANEL)).toBeHidden();
  await expect.poll(() => keyboard(page)).toBe("document");
  await clickMenu(app, "view-comments");
  await expect(page.locator(PANEL)).toBeVisible();
  await expect.poll(() => keyboard(page)).toBe("document");

  // Hiding the outline with the keyboard in it: the same.
  await clickMenu(app, "view-outline");
  const row = page.locator(`${DOC} .outline-pane button, .outline-pane a, .outline-pane [tabindex]`).first();
  await expect(row).toBeVisible();
  await row.focus();
  await expect.poll(() => keyboard(page)).toBe("outline");
  await clickMenu(app, "view-outline");
  await expect(page.locator(".outline-pane")).toHaveCount(0);
  await expect.poll(() => keyboard(page)).toBe("document");

  // With words selected before going in, the keyboard comes back with nothing selected,
  // so the next key adds a letter instead of replacing them (review of Batch 24, R24-1).
  await selectText(page, "start in May");
  await clickMenu(app, "view-outline");
  await expect(row).toBeVisible();
  await row.focus();
  await expect.poll(() => keyboard(page)).toBe("outline");
  await clickMenu(app, "view-outline");
  await expect(page.locator(".outline-pane")).toHaveCount(0);
  await expect.poll(() => keyboard(page)).toBe("document");
  expect(await selected(page)).toBe("");
  await page.keyboard.type("k");
  await expect(page.locator(EDITOR)).toContainText("start in May");
  await page.keyboard.press("Meta+z");
  await expect(page.locator(EDITOR)).toContainText("We start in May.");

  // The same from an empty New comment box, hidden with the panel.
  await selectText(page, "two people");
  await page.keyboard.press("Meta+Alt+m");
  await expect(page.getByRole("textbox", { name: "New comment" })).toBeFocused();
  await clickMenu(app, "view-comments");
  await expect(page.locator(PANEL)).toBeHidden();
  await expect.poll(() => keyboard(page)).toBe("document");
  expect(await selected(page)).toBe("");
  await page.keyboard.type("k");
  await expect(page.locator(EDITOR)).toContainText("two people");
  await clickMenu(app, "view-comments");
});

/** Claude takes the document and makes two changes, and finishes. */
async function claudeChanged(r: Running): Promise<AgentSession> {
  const { session: claude } = await AgentSession.start(r.dataDir, "claude-code");
  sessions.push(claude);
  await claude.ok("take_document", { path: r.file, request: "Tighten it." });
  await claude.ok("edit_document", { path: r.file, edits: [{ find: "hire two people", replace: "hire three people" }] });
  await claude.ok("edit_document", { path: r.file, edits: [{ find: "in May", replace: "in June" }] });
  await claude.ok("finish_editing", { path: r.file, note: "I moved the start to June. Is May still right?" });
  await expect(page(r).locator(EDITOR)).toContainText("in June");
  return claude;
}
const page = (r: Running) => r.page;

/** How the keyboard's place is drawn: its outline, as the eye sees it. */
const ring = (p: Page) => p.evaluate(() => {
  const a = document.activeElement as HTMLElement;
  const s = getComputedStyle(a);
  return { visible: a.matches(":focus-visible") && s.outlineStyle !== "none" && parseFloat(s.outlineWidth) > 0, name: a.getAttribute("aria-label") };
});

// Rows 4 (K-3), 5 (K-4) and 12 (K-13).
test("Show changes and an older version: the page shown has a ring and a name that says what it is, Tab goes on to its bar, Next change says where it is once and says when there are no more; Escape on the first version comes back to the page", async () => {
  const r = await start();
  const { page: p } = r;
  await claudeChanged(r);
  // Row 9 (K-9): typing on Claude's note says how to answer it, on screen and to a screen reader; the page is untouched.
  await p.locator(`${EDITOR} .ProseMirror`).focus();
  await p.keyboard.press("Meta+Alt+ArrowDown");
  await expect.poll(() => p.evaluate(() => document.activeElement?.classList.contains("pass-note") ?? false)).toBe(true);
  const before = r.text();
  await p.keyboard.type("Thanks");
  await expect(panelSays(p)).toHaveText("A note can't take a reply. To answer it, start a new comment (⌥⌘M).");
  expect(r.text()).toBe(before);
  await p.keyboard.press("Escape");
  await expect.poll(() => keyboard(p)).toBe("document");
  await p.keyboard.press("Control+Meta+c");
  await expect(p.locator(`${DOC} .version-steps`)).toBeVisible();
  await expect.poll(() => keyboard(p)).toBe("version");
  expect(await ring(p)).toEqual({ visible: true, name: "Changes since you handed it over" });
  // Tab: on to the bar's buttons, not past them.
  await p.keyboard.press("Tab");
  await expect.poll(() => keyboard(p)).toBe("Previous change in bar");
  // The bar's sentence is said when it changes; the place is said once, on its own.
  await expect(p.locator(`${DOC} .version-banner`)).not.toHaveAttribute("role", "status");
  await expect(p.locator(`${DOC} .version-banner-text`)).toHaveAttribute("role", "status");
  const next = p.locator(`${DOC} .version-banner`).getByRole("button", { name: "Next change" });
  await next.focus();
  await p.keyboard.press("Enter");
  await expect(p.locator(`${DOC} .version-step-place`)).toHaveText("1 of 2");
  await p.keyboard.press("Enter");
  await expect(p.locator(`${DOC} .version-step-place`)).toHaveText("2 of 2");
  await expect(p.locator(`${DOC} .version-step-said`)).toHaveText("2 of 2");
  await expect(p.locator(`${DOC} .version-step-place`)).not.toHaveAttribute("aria-live", /./);
  // Past the last: said so, and round to the first.
  await p.keyboard.press("Enter");
  await expect(p.locator(`${DOC} .version-step-place`)).toHaveText("1 of 2");
  await expect(p.locator(`${DOC} .version-step-said`)).toHaveText("No more changes. Back to 1 of 2");
  await p.keyboard.press("Escape");
  await p.keyboard.press("Escape");
  await expect(p.locator(`${DOC} .version-banner`)).toBeHidden();

  // Shown again, a step that lands on the same words as last time is still said: its words differ, if only by
  // a space a screen reader doesn't read, so the region is read again (review of Batch 24, R24-7).
  const saidNow = () => p.locator(`${DOC} .version-step-said`).evaluate((e) => e.textContent ?? "");
  const firstStep = async (): Promise<string> => {
    await p.keyboard.press("Control+Meta+c");
    await expect(p.locator(`${DOC} .version-steps`)).toBeVisible();
    await next.focus();
    await p.keyboard.press("Enter");
    await expect(p.locator(`${DOC} .version-step-place`)).toHaveText("1 of 2");
    const words = await saidNow();
    await p.keyboard.press("Escape");
    await p.keyboard.press("Escape");
    await expect(p.locator(`${DOC} .version-banner`)).toBeHidden();
    return words;
  };
  const once = await firstStep();
  const again = await firstStep();
  expect(once.trim()).toBe("1 of 2");
  expect(again.trim()).toBe("1 of 2");
  expect(again).not.toBe(once);

  // History by keys: the oldest version, Return, then Escape: back in the page, never nowhere.
  await p.keyboard.press("Control+Meta+h");
  await p.locator(`${DOC} .history-panel .history-item[tabindex="0"]`).focus();
  await p.keyboard.press("End");
  await p.keyboard.press("Enter");
  await expect(p.locator(`${DOC} .version-banner`)).toBeVisible();
  await expect.poll(() => keyboard(p)).toBe("version");
  expect((await ring(p)).name).toMatch(/^Version from /);
  await p.keyboard.press("Escape");
  await expect(p.locator(`${DOC} .version-banner`)).toBeHidden();
  await expect.poll(() => keyboard(p)).toBe("document");
});

// Row 7 (K-8): Send from the page with words selected; Claude done, the keyboard stayed on New comment.
test("Send to Claude from the page with words selected: when Claude is done the keyboard is back in the page, at the end of those words, nothing selected", async () => {
  const r = await start();
  const { page: p } = r;
  const { session: claude } = await AgentSession.start(r.dataDir, "claude-code");
  sessions.push(claude);
  await claude.ok("open_document", { path: r.file });
  const wait = claude.waitForReview({ paths: [r.file] });
  await selectText(p, "two people");
  // Row 13 (K-15): the @ list says, as it opens, how many agents it holds; nothing is said once it closes.
  await p.keyboard.press("Meta+Alt+m");
  await p.keyboard.type("@");
  await expect(p.locator("#mention-list")).toBeVisible();
  await expect(p.locator("#mention-list [role=option]")).toHaveCount(1);
  await expect(p.locator(".mention-count[role=status]")).toHaveText("1 agent. Up and Down to choose.");
  await p.keyboard.press("Escape");
  await expect(p.locator("#mention-list")).toBeHidden();
  await p.keyboard.press("Escape");
  await expect(p.locator(".mention-count")).toHaveText("");
  await comment(p, "budget", "By how much?");
  await selectText(p, "We start");
  await p.keyboard.press("Shift+Meta+d");
  await wait.text;
  await expect.poll(() => keyboard(p)).toBe("New comment in panel");
  await claude.ok("edit_document", { path: r.file, edits: [{ find: "is tight", replace: "is very tight" }] });
  await claude.call("finish_editing", { path: r.file }); // points out the comment it didn't answer, once
  await claude.ok("finish_editing", { path: r.file });
  await expect(p.locator("#turn-status .turn-text")).not.toHaveText("Claude is editing");
  await expect.poll(() => keyboard(p)).toBe("document");
  expect(await selected(p)).toBe("");
  await p.keyboard.type("Q");
  await expect.poll(() => r.text()).toContain("We startQ in May.");
});

// Row 11 (W-9): an option chosen said "What you chose is highlighted" with the highlight out of sight.
test("an option chosen brings the words it changed into sight", async () => {
  const lines = Array.from({ length: 40 }, (_, i) => `Paragraph ${i + 1} of the notes.`).join("\n\n");
  const r = await start(`# Notes\n\n${lines}\n\nThe last line is long winded.\n`);
  const { page: p, app } = r;
  await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].setContentSize(560, 700));
  await p.locator(`${EDITOR} .ProseMirror`).focus();
  await p.keyboard.press("Meta+ArrowUp");
  await p.keyboard.press("Meta+Alt+m");
  await p.keyboard.type("Tighten the end?");
  await p.keyboard.press("Meta+Enter");
  await expect(card(p, "Tighten the end?")).toBeVisible();
  const { session: claude } = await AgentSession.start(r.dataDir, "claude-code");
  sessions.push(claude);
  const taken = await claude.ok("take_document", { path: r.file });
  const id = /\[([0-9a-f]+)\]/.exec(taken)![1];
  await claude.ok("reply_to_comment", { path: r.file, comment_id: id, text: "One way:", options: [{ label: "Shorter", edits: [{ find: "The last line is long winded.", replace: "The end." }] }] });
  await claude.ok("finish_editing", { path: r.file });
  await p.locator(`${DOC} .canvas`).first().evaluate((el) => (el.scrollTop = 0));
  await card(p, "Tighten the end?").getByRole("button", { name: "Shorter" }).click();
  await expect(p.locator(EDITOR)).toContainText("The end.");
  const inSight = () =>
    p.evaluate(() => {
      const para = [...document.querySelectorAll(".doc:not([hidden]) .ProseMirror p")].find((e) => e.textContent === "The end.");
      const scroller = para?.closest(".canvas");
      if (!para || !scroller) return false;
      const a = para.getBoundingClientRect();
      const b = scroller.getBoundingClientRect();
      return a.top >= b.top && a.bottom <= b.bottom;
    });
  await expect.poll(inSight).toBe(true);
});

// Row 8 (W-1): at 560 the outline's "no room" note covered the Comments heading, and a bar opened after it.
test("at 560 the outline's no-room note stays over the page: clear of the Comments panel, and below a bar that opens after it", async () => {
  const r = await start();
  const { page: p, app } = r;
  await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].setContentSize(560, 700));
  await settle(p);
  await clickMenu(app, "view-outline");
  const told = p.locator(".outline-told");
  await expect(told).toBeVisible();
  const box = (sel: string) => p.locator(sel).first().evaluate((e) => { const b = e.getBoundingClientRect(); return { left: b.left, top: b.top, right: b.right, bottom: b.bottom }; });
  const panel = await box(PANEL);
  expect((await box(".outline-told")).right).toBeLessThanOrEqual(panel.left);
  await clickMenu(app, "find");
  await expect(p.locator(`${DOC} .find-bar`)).toBeVisible();
  await expect.poll(async () => (await box(".outline-told")).top >= (await box(`${DOC} .find-bar`)).bottom).toBe(true);
  expect((await box(".outline-told")).right).toBeLessThanOrEqual((await box(PANEL)).left);
});

// Row 1 (K-1), a change of how he works: after Post, and Escape from a card, the commented words were selected
// again, and the next key replaced them.
test("after Post, and after Escape from a card, the cursor sits at the end of the commented words with nothing selected: the next key replaces nothing", async () => {
  const r = await start();
  const { page: p } = r;
  await comment(p, "two people", "Make it three.");
  await expect.poll(() => keyboard(p)).toBe("document");
  expect(await selected(p)).toBe("");
  await p.keyboard.type("x");
  await expect.poll(() => r.text()).toContain("We should hire two peoplex this quarter.");
  await p.keyboard.press("Backspace");
  // Escape from a card: the same.
  await p.keyboard.press("Meta+Alt+ArrowDown");
  await expect.poll(() => keyboard(p)).toBe("card: Make it three.");
  await p.keyboard.press("Escape");
  await expect.poll(() => keyboard(p)).toBe("document");
  expect(await selected(p)).toBe("");
  await p.keyboard.type("y");
  await expect.poll(() => r.text()).toContain("We should hire two peopley this quarter.");
});
