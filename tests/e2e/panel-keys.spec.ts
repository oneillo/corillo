// The Comments panel and the bars at the top, by keys alone (roadmap Batch 12,
// item 3: G-2, G-6, G-7, G-8 and G-10, from the keys-only review's K-2
// and K-4 to K-8). Driven by page.keyboard, as the keys-only review was: after
// each step the keyboard is somewhere useful, never nowhere, and never in the
// page with words selected that the next key would replace. Each test runs the
// real app, hidden, with a pretend agent where one is needed, on throwaway
// documents and data folders it removes.
import { test, expect, type Page } from "@playwright/test";
import { rmSync } from "node:fs";
import { clickMenu, cursorAtEnd, expectFile, openText, selectText, settle, EDITOR, type Running } from "./helpers";
import { AgentSession } from "./agent-session";

const DOC = ".doc:not([hidden])";
const PANEL = `${DOC} aside.comments-panel`;
const TEXT = "# Plan\n\nWe should hire two people this quarter.\n\nThe budget is tight.\n\nWe start in May.\n";

const card = (page: Page, body: string) => page.locator(`${PANEL} .comment-card:not(.draft)`, { hasText: body });

/**
 * Where the keyboard is: "nowhere", "document", "version" (the page shown read-only), "card: <its first words>",
 * or a control: "<its name> in <card: ...|panel|bar>".
 */
const keyboard = (page: Page) =>
  page.evaluate(() => {
    const a = document.activeElement as HTMLElement | null;
    if (!a || a === document.body) return "nowhere";
    if (a.closest(".version-page")) return "version";
    if (a.closest(".ProseMirror")) return "document";
    const first = (c: Element | null) => (c?.querySelector(".comment-body")?.textContent ?? "").trim();
    if (a.classList.contains("comment-card")) return `card: ${first(a)}`;
    const name = (a.getAttribute("aria-label") || a.textContent || "").trim();
    const where = a.closest(".comment-card") ? `card: ${first(a.closest(".comment-card"))}` : a.closest(".comments-panel") ? "panel" : a.closest(".banner, .pass-notice, .agent-notice") ? "bar" : "window";
    return `${name} in ${where}`;
  });

/** Whether the keyboard is on something drawn (not on a control that just hid). */
const onSomethingShown = (page: Page) =>
  page.evaluate(() => {
    const a = document.activeElement as HTMLElement | null;
    return !!a && a !== document.body && a.checkVisibility() && a.getBoundingClientRect().height > 0;
  });

/** The document's selection: empty (a cursor) or the words selected. */
const selected = (page: Page) => page.evaluate(() => (getSelection()?.toString() ?? ""));

/** Tab until the keyboard is on the control named so (at most `max` presses). */
async function tabTo(page: Page, name: string | RegExp, max = 12, back = false): Promise<void> {
  for (let i = 0; i < max; i++) {
    const at = await page.evaluate(() => {
      const a = document.activeElement as HTMLElement | null;
      return (a?.getAttribute("aria-label") || a?.textContent || "").trim();
    });
    if (typeof name === "string" ? at === name : name.test(at)) return;
    await page.keyboard.press(back ? "Shift+Tab" : "Tab");
  }
  throw new Error(`Tab didn't reach ${name}: the keyboard is on ${await keyboard(page)}`);
}

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

async function start(text = TEXT): Promise<Running> {
  run = await openText(text, { name: "plan.md" });
  home = await run.app.evaluate(() => process.env.CORILLO_HOME ?? null);
  return run;
}

/** A comment as the person, on these words: they stay selected in the page afterwards, as after any comment. */
async function comment(page: Page, words: string, body: string): Promise<void> {
  await selectText(page, words);
  await page.getByRole("button", { name: "Comment", exact: true }).click();
  await page.getByRole("textbox", { name: "New comment" }).fill(body);
  await page.getByRole("button", { name: "Post" }).click();
  await expect(card(page, body)).toBeVisible();
}

/** Three comments, then the page's selection left on words ("budget is tight"), as the keys-only review had it. */
async function threeComments(): Promise<Running> {
  const r = await start();
  const { page } = r;
  await comment(page, "two people", "Make it three.");
  await comment(page, "budget", "By how much?");
  await comment(page, "May", "Which day?");
  await selectText(page, "is tight");
  return r;
}

/** Claude makes it three people, and offers Shorter and Formal on its reply; the document comes back. */
async function offered(options: { wait?: boolean } = {}): Promise<{ r: Running; claude: AgentSession }> {
  const r = await start();
  const { page } = r;
  await comment(page, "two people", "Three, and is it too wordy?");
  const { session: claude } = await AgentSession.start(r.dataDir, "claude-code");
  sessions.push(claude);
  // Asked in the chat too, to move the start: a change no comment asked for, so the done line offers Show changes.
  const taken = await claude.ok("take_document", { path: r.file, request: "Start in June." });
  const id = /\[([0-9a-f]+)\] on /.exec(taken)![1];
  await claude.ok("edit_document", { path: r.file, edits: [{ find: "hire two people", replace: "hire three people" }], comment_ids: [id] });
  await claude.ok("edit_document", { path: r.file, edits: [{ find: "in May", replace: "in June" }] });
  const shorter = { label: "Shorter", edits: [{ find: "We should hire three people this quarter.", replace: "Hire three this quarter." }] };
  const formal = { label: "Formal", edits: [{ find: "We should hire three people this quarter.", replace: "The plan is to recruit three staff this quarter." }] };
  await claude.ok("reply_to_comment", { path: r.file, comment_id: id, text: "Made it three. Shorter, or more formal?", options: [shorter, formal] });
  await claude.ok("finish_editing", { path: r.file });
  await expect(page.locator(`${PANEL} .comment-option`, { hasText: "Shorter" })).toBeVisible();
  if (options.wait) claude.waitForReview();
  return { r, claude };
}

// G-2 (K-2): Delete from the keyboard used to send the keyboard into the page, where the words last selected came
// back and one key replaced them.
test("Delete from a card by keys rests the keyboard on the next card, as Resolve does, never in the page; Undo straight after brings the comment back; the last one leaves a cursor, not a selection", async () => {
  const { page, app } = await threeComments();
  // Next Comment rests the keyboard on the first card; its "⋯", Return, End (Delete), Return.
  await page.keyboard.press("Meta+Alt+ArrowDown");
  await expect.poll(() => keyboard(page)).toBe("card: Make it three.");
  await tabTo(page, "More actions");
  await page.keyboard.press("Enter");
  await page.keyboard.press("End");
  await expect(page.getByRole("menuitem", { name: "Delete" })).toBeFocused();
  await page.keyboard.press("Enter");
  await expect(card(page, "Make it three.")).toHaveCount(0);
  await expect.poll(() => keyboard(page)).toBe("card: By how much?");
  await expect(card(page, "By how much?")).toHaveClass(/active/);
  // Undo straight after: the comment is back, with the keyboard on it.
  await page.keyboard.press("Meta+z");
  await expect(card(page, "Make it three.")).toBeVisible();
  await expect.poll(() => keyboard(page)).toBe("card: Make it three.");

  // Review > Delete Comment with the keyboard on a button in the card (its tick): the same, not the page with the
  // words selected earlier (review of Batch 12, B12-8).
  await tabTo(page, "Resolve");
  await clickMenu(app, "review-delete");
  await expect(card(page, "Make it three.")).toHaveCount(0);
  await expect.poll(() => keyboard(page)).toBe("card: By how much?");
  await page.keyboard.press("Meta+z");
  await expect(card(page, "Make it three.")).toBeVisible();
  await expect.poll(() => keyboard(page)).toBe("card: Make it three.");

  // Review > Delete Comment with the keyboard on a card: the same.
  await clickMenu(app, "review-delete");
  await expect(card(page, "Make it three.")).toHaveCount(0);
  await expect.poll(() => keyboard(page)).toBe("card: By how much?");
  // A letter there starts a reply; the document's words are untouched.
  const before = await page.locator(`${EDITOR} .ProseMirror`).innerText();
  await clickMenu(app, "review-delete");
  await expect.poll(() => keyboard(page)).toBe("card: Which day?");
  // The last card goes: the keyboard goes back to the page with nothing selected, so a key can't replace words.
  await clickMenu(app, "review-delete");
  await expect(page.locator(`${PANEL} .comment-card`)).toHaveCount(0);
  await expect.poll(() => keyboard(page)).toBe("document");
  expect(await selected(page)).toBe("");
  await page.keyboard.type("Z");
  await settle(page);
  expect((await page.locator(`${EDITOR} .ProseMirror`).innerText()).replace("Z", "")).toBe(before);
});

// G-7 (K-5): after Return on an option the keyboard sat on the other option, where Command-Z and Escape did nothing.
test("an option chosen with Return leaves the keyboard on its card: Command-Z takes the choice back, and Escape goes to the page", async () => {
  const { r } = await offered();
  const { page } = r;
  await page.locator(`${EDITOR} .ProseMirror`).focus();
  await page.keyboard.press("Meta+Alt+ArrowDown");
  await expect.poll(() => keyboard(page)).toBe("card: Three, and is it too wordy?");
  await tabTo(page, "Shorter");
  await page.keyboard.press("Enter");
  await expect(page.locator(EDITOR)).toContainText("Hire three this quarter.");
  await expect(card(page, "Three, and is it too wordy?").locator(".comment-option-chosen")).toHaveText("You chose: Shorter");
  await expect.poll(() => keyboard(page)).toBe("card: Three, and is it too wordy?");
  // It's his edit: Command-Z takes it back, and the keyboard stays on the card.
  await page.keyboard.press("Meta+z");
  await expect(page.locator(EDITOR)).toContainText("We should hire three people this quarter.");
  await expectFile(r, TEXT.replace("two", "three").replace("May", "June"));
  await expect(card(page, "Three, and is it too wordy?").locator(".comment-option-chosen")).toHaveCount(0);
  await expect.poll(() => keyboard(page)).toBe("card: Three, and is it too wordy?");
  // Chosen again; this time Escape: back to the page.
  await tabTo(page, "Formal");
  await page.keyboard.press("Enter");
  await expect(page.locator(EDITOR)).toContainText("The plan is to recruit three staff this quarter.");
  await expect.poll(() => keyboard(page)).toBe("card: Three, and is it too wordy?");
  await page.keyboard.press("Escape");
  await expect.poll(() => keyboard(page)).toBe("document");

  // Chosen by keys, then a click in the page, then Command-Z: the choice is undone (the page's own Undo, since the
  // click ended "just done") and the keyboard stays where he clicked, not on the card (review of Batch 12, B12-12,
  // which this holds: it was already so).
  await page.keyboard.press("Meta+Alt+ArrowDown");
  await expect.poll(() => keyboard(page)).toBe("card: Three, and is it too wordy?");
  await tabTo(page, "Shorter");
  await page.keyboard.press("Enter");
  await expect(page.locator(EDITOR)).toContainText("Hire three this quarter.");
  await page.locator(`${EDITOR} h1`).click(); // a click only: no key that would end what Command-Z undoes first
  await settle(page);
  await expect.poll(() => keyboard(page)).toBe("document");
  await page.keyboard.press("Meta+z");
  await expect(page.locator(EDITOR)).toContainText("The plan is to recruit three staff this quarter.");
  await settle(page);
  expect(await keyboard(page)).toBe("document");
});

// G-8 (K-6): Tab from an empty Reply box went to its Cancel, which hid as the box lost the keyboard.
test("Tab from an empty Reply box goes on to a control that stays, and on to the next card, never losing a press", async () => {
  const { page } = await threeComments();
  await page.keyboard.press("Meta+Alt+ArrowDown");
  await expect.poll(() => keyboard(page)).toBe("card: Make it three.");
  await tabTo(page, "Reply");
  await expect(card(page, "Make it three.").getByRole("textbox", { name: "Reply" })).toBeFocused();
  const stops: string[] = [];
  for (let i = 0; i < 3; i++) {
    await page.keyboard.press("Tab");
    await settle(page);
    expect(await onSomethingShown(page), `Tab ${i + 1} from the Reply box landed on ${await keyboard(page)}`).toBe(true);
    stops.push(await keyboard(page));
  }
  // Cancel stays while it has the keyboard; Reply (greyed out, nothing typed) is passed by; then the next card.
  expect(stops[0]).toBe("Cancel in card: Make it three.");
  expect(stops[1]).toMatch(/in card: By how much\?$/);
  // Back with Shift-Tab: the box, its Cancel showing again while the keyboard is in it.
  await page.keyboard.press("Shift+Tab");
  await page.keyboard.press("Shift+Tab");
  expect(await onSomethingShown(page)).toBe(true);
});

// G-10 (K-8): Escape did nothing on a button in a card, the panel or a bar.
test("Escape steps out: from a button in a card to the card, then the page; from a button in the panel or a bar to the page shown", async () => {
  const { r } = await offered({ wait: true });
  const { page } = r;
  await comment(page, "budget", "By how much?");
  await page.locator(`${EDITOR} .ProseMirror`).focus();
  // A button in a card: Escape to the card, then to the page.
  await page.keyboard.press("Meta+Alt+ArrowDown");
  await tabTo(page, /^Resolve/);
  await page.keyboard.press("Escape");
  await expect.poll(() => keyboard(page)).toBe("card: Three, and is it too wordy?");
  await page.keyboard.press("Escape");
  await expect.poll(() => keyboard(page)).toBe("document");
  // An option, the same (Next goes on to the other card now, Previous back to this one).
  await page.keyboard.press("Meta+Alt+ArrowDown");
  await page.keyboard.press("Meta+Alt+ArrowUp");
  await expect.poll(() => keyboard(page)).toBe("card: Three, and is it too wordy?");
  await tabTo(page, "Formal");
  await page.keyboard.press("Escape");
  await expect.poll(() => keyboard(page)).toBe("card: Three, and is it too wordy?");
  // A button in the panel itself: to the page.
  await page.getByRole("button", { name: "New comment" }).focus();
  await page.keyboard.press("Escape");
  await expect.poll(() => keyboard(page)).toBe("document");
  // The done line's Show changes: to the page.
  await page.locator(`${DOC} .pass-notice-see`).focus();
  await page.keyboard.press("Escape");
  await expect.poll(() => keyboard(page)).toBe("document");

  // Show changes on: its arrows and Hide changes go to the page shown; Escape there goes back to writing.
  await page.keyboard.press("Control+Meta+c");
  await expect(page.locator(`${DOC} .version-steps`)).toBeVisible();
  await expect.poll(() => keyboard(page)).toBe("version");
  for (const name of ["Next change", "Previous change", "Hide changes"]) {
    await page.locator(`${DOC} .version-banner`).getByRole("button", { name }).focus();
    await page.keyboard.press("Escape");
    await expect.poll(() => keyboard(page), name).toBe("version");
  }
  // Send to Claude, in the panel beside the changes: to the page shown, too.
  await page.locator(`${PANEL} .comments-hand-back`).focus();
  await page.keyboard.press("Escape");
  await expect.poll(() => keyboard(page)).toBe("version");
  await page.keyboard.press("Escape");
  await expect(page.locator(`${DOC} .version-banner`)).toBeHidden();
  await expect.poll(() => keyboard(page)).toBe("document");

  // An earlier version from History: Back to current, then Escape, to the page shown; Escape again, back to writing.
  await page.getByRole("button", { name: "History", exact: true }).click();
  await page.locator(`${DOC} .history-item`).nth(1).click();
  await expect(page.locator(`${DOC} .version-banner`)).toBeVisible();
  await page.getByRole("button", { name: "Back to current" }).focus();
  await page.keyboard.press("Escape");
  await expect.poll(() => keyboard(page)).toBe("version");
  await page.keyboard.press("Escape");
  await expect(page.locator(`${DOC} .version-banner`)).toBeHidden();
});

// G-6 (K-4): Send to Claude left the keyboard nowhere, and the next Tab jumped down the page.
test("Send to Claude from the page puts the keyboard on New comment, so he can go on commenting while Claude edits; back in the page when Claude is done", async () => {
  const { r, claude } = await offered({ wait: true });
  const { page } = r;
  await expect(page.locator("#turn-status .turn-text")).toHaveText(/Claude is waiting for your review/);
  await comment(page, "budget", "By how much?");
  await cursorAtEnd(page, "We start in June.");
  for (let i = 0; i < 6; i++) await page.keyboard.press("ArrowLeft"); // inside the paragraph: "We start in| June."
  await page.keyboard.press("Shift+Meta+d");
  await expect(page.locator("#turn-status .turn-text")).toHaveText("Claude is editing");
  await expect.poll(() => keyboard(page)).toBe("New comment in panel");
  // Return there starts a comment, as it says.
  await page.keyboard.press("Enter");
  await expect(page.getByRole("textbox", { name: "New comment" })).toBeFocused();
  await page.keyboard.press("Escape");
  await expect.poll(() => onSomethingShown(page)).toBe(true);
  // Claude rewrites the paragraph the cursor is in, and finishes: the keyboard, still where the lock put it, goes
  // back to the page, at the cursor, so typing lands in that paragraph (as keep-place.spec.ts has it), not elsewhere.
  await page.getByRole("button", { name: "New comment" }).focus();
  await claude.ok("edit_document", { path: r.file, edits: [{ find: "We start in June.", replace: "We start on the first working day of June." }] });
  await claude.call("finish_editing", { path: r.file }); // points out the comment it didn't answer, once
  await claude.ok("finish_editing", { path: r.file });
  await expect(page.locator("#turn-status .turn-text")).not.toHaveText("Claude is editing");
  await expect.poll(() => keyboard(page)).toBe("document");
  await page.keyboard.type("Q");
  await expect.poll(() => r.text()).toContain("Q");
  const typed = r.text().split("\n").find((line) => line.includes("Q")) ?? "";
  expect(typed.replace("Q", "")).toBe("We start on the first working day of June.");
  expect(typed.indexOf("Q")).toBeGreaterThan(0);
});

test("Send to Claude from its own button with the keyboard: the button goes, and the keyboard moves to New comment beside it; back in the page when Claude is done", async () => {
  const { r, claude } = await offered({ wait: true });
  const { page } = r;
  await comment(page, "budget", "By how much?");
  await cursorAtEnd(page, "The budget is tight.");
  const send = page.locator(`${PANEL} .comments-hand-back`);
  await expect(send).toBeEnabled();
  await send.focus();
  await page.keyboard.press("Enter");
  await expect(page.locator("#turn-status .turn-text")).toHaveText("Claude is editing");
  await expect(send).toBeHidden();
  await expect.poll(() => keyboard(page)).toBe("New comment in panel");
  // Claude is done: the keyboard, still where the Send put it, goes back to the page at the cursor, as Help says
  // (review of Batch 12, B12-6; it stayed on New comment).
  await claude.call("finish_editing", { path: r.file }); // points out the comment it didn't answer, once
  await claude.ok("finish_editing", { path: r.file });
  await expect(page.locator("#turn-status .turn-text")).not.toHaveText("Claude is editing");
  await expect.poll(() => keyboard(page)).toBe("document");
  await page.keyboard.type("Q");
  await expect.poll(() => r.text()).toContain("The budget is tight.Q");
});
