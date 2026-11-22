// The Comments panel holds comments only (Orlando, 2026-11-12, roadmap Batch
// 9, items 5, 8 and 14). What an agent changed for a request made in its chat,
// or for no comment at all, is a pass in History, not a card: "We keep the
// comments section for explicit comments I've made to the agents and their
// responses." The line when an agent is done still says the document changed,
// and shows the changes. The "Waiting for you first" tick is gone, and a New
// comment button sits at the top of the panel, comments or none.
import { test, expect, type Page } from "@playwright/test";
import { mkdtempSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ONE_SCALE, openText, selectText, settle, clickMenu, EDITOR, type Running, launch } from "./helpers";
import { AgentSession } from "./agent-session";

const PANEL = ".doc:not([hidden]) .comments-panel";
const LINE = ".doc:not([hidden]) .pass-notice";
const VERSION = ".doc:not([hidden]) .version-view .ProseMirror";
const HISTORY = ".doc:not([hidden]) .history-panel";

const PLAN = "# Plan\n\nWe should hire two people this quarter.\n\nThe budget is tight.\n";

const cards = (page: Page) => page.locator(`${PANEL} .comment-card`);
const card = (page: Page, body: string) => cards(page).filter({ hasText: body });
const newComment = (page: Page) => page.locator(PANEL).getByRole("button", { name: "New comment", exact: true });

/** The status line's two parts: who's done, and what they did. */
async function lineWords(page: Page): Promise<{ lead: string; detail: string }> {
  return {
    lead: (await page.locator(`${LINE} .pass-notice-lead`).textContent()) ?? "",
    detail: (await page.locator(`${LINE} .pass-notice-detail`).textContent()) ?? "",
  };
}

/** Leave a comment as the person, with the toolbar's Comment: on these words, or on the whole document with none. */
async function comment(run: Running, words: string | null, body: string): Promise<void> {
  if (words) await selectText(run.page, words);
  else {
    await run.page.locator(`${EDITOR} h1`).click();
    await settle(run.page);
  }
  await run.page.getByRole("button", { name: "Comment", exact: true }).click();
  await run.page.getByRole("textbox", { name: "New comment" }).fill(body);
  await run.page.getByRole("button", { name: "Post" }).click();
  await expect(card(run.page, body)).toBeVisible();
}

/** The ids take_document shows, by the words each comment is on. */
function idsIn(text: string): Map<string, string> {
  const ids = new Map<string, string>();
  for (const m of text.matchAll(/\[([^\]]+)\] on "([^"]+)"/g)) ids.set(m[2], m[1]);
  return ids;
}

/** Every item in the menu bar, by its id and words. */
function menuItems(run: Running): Promise<{ id: string; label: string }[]> {
  return run.app.evaluate(({ Menu }) => {
    const all: { id: string; label: string }[] = [];
    const walk = (menu: Electron.Menu | null | undefined) => {
      for (const i of menu?.items ?? []) {
        all.push({ id: i.id, label: i.label });
        walk(i.submenu);
      }
    };
    walk(Menu.getApplicationMenu());
    return all;
  });
}

/** Quit and start Corillo again on the same document and data folder. */
async function relaunch(run: Running): Promise<Running> {
  await run.app.close();
  const { app, thrown } = await launch({
    args: [ONE_SCALE, ".", run.file],
    env: { ...process.env, CORILLO_USER_DATA: run.dataDir, CORILLO_HIDDEN: "1", CORILLO_HOME: mkdtempSync(join(tmpdir(), "corillo-home-")) },
  });
  const page = await app.firstWindow();
  await page.waitForSelector(".ProseMirror");
  return { ...run, app, page, thrown };
}

// Orlando: "When an agent updates a doc in response to something I ask it to
// do in the session, we still capture that context as history with changes
// diff. But we just consider it a pass. This is noise to me."
test("a request made in the chat, and changes no comment asked for, are no card: the done line says the document changed and shows it, and History keeps each pass", async () => {
  const run = await openText(PLAN, { name: "plan.md" });
  const { page } = run;
  await comment(run, "two people", "Make it three.");
  const { session: claude } = await AgentSession.start(run.dataDir, "claude-code");
  const request = "Make the budget line punchier.\nAnd keep the number of people as it is, whatever my comments say.";
  try {
    // A pass with a comment and a request made in the chat.
    const ids = idsIn(await claude.ok("take_document", { path: run.file, request }));
    await claude.ok("edit_document", { path: run.file, edits: [{ find: "The budget is tight.", replace: "Budget: tight." }] });
    await claude.ok("edit_document", { path: run.file, edits: [{ find: "two people", replace: "three people" }], comment_ids: [ids.get("two people")] });
    await claude.ok("reply_to_comment", { path: run.file, comment_id: ids.get("two people"), text: "Now three." });
    await claude.ok("finish_editing", { path: run.file });

    // The panel: the person's comment and nothing else.
    await expect(page.locator(LINE)).toBeVisible();
    await expect(cards(page)).toHaveCount(1);
    await expect(page.locator(PANEL)).not.toContainText("Asked in chat");
    await expect(page.locator(`${PANEL} .chat-request, ${PANEL} .other-changes`)).toHaveCount(0);
    // The done line counts the comment, and says the document changed: one click shows it.
    expect(await lineWords(page)).toEqual({ lead: "Claude is done. Back to you.", detail: "1 comment to read." });
    const see = page.locator(LINE).getByRole("button", { name: "Show changes" });
    await expect(see).toBeVisible();
    await expect(see).toHaveAttribute("title", "Show changes since you handed the document over (⌃⌘C)");
    expect(await page.locator(LINE).getAttribute("title")).toBe("Claude is done. Back to you. 1 comment to read. Show changes.");

    // Next and Previous Comment go through comments only; Resolve Comment is never Mark Changes as Done.
    await clickMenu(run.app, "review-next");
    await expect(card(page, "Make it three.")).toHaveClass(/active/);
    await clickMenu(run.app, "review-next");
    await expect(card(page, "Make it three.")).toHaveClass(/active/);
    await clickMenu(run.app, "review-previous");
    await expect(card(page, "Make it three.")).toHaveClass(/active/);
    expect((await menuItems(run)).map((i) => i.label)).not.toContain("Mark Changes as Done");
    // Reading the cards left the line as it was.
    await expect(see).toBeVisible();

    // Show changes: Show changes, everything since the hand-over, the request's changes too.
    await see.click();
    await expect(page.locator(".doc:not([hidden])")).toHaveClass(/viewing-changes/);
    await expect.poll(() => page.locator(`${VERSION} ins.diff-added`).allTextContents()).toEqual(expect.arrayContaining(["three", expect.stringContaining("Budget:")]));
    await clickMenu(run.app, "view-changes");
    await expect(page.locator(".doc:not([hidden])")).not.toHaveClass(/viewing-changes/);

    // A pass with a change no comment asked for, and no request: no card either, and the line still says so.
    await card(page, "Make it three.").getByRole("button", { name: "Resolve", exact: true }).click();
    await claude.ok("take_document", { path: run.file });
    await claude.ok("edit_document", { path: run.file, edits: [{ find: "tight.", replace: "very tight." }] });
    await claude.ok("finish_editing", { path: run.file });
    await expect(page.locator(LINE)).toBeVisible();
    expect(await lineWords(page)).toEqual({ lead: "Claude is done. Back to you.", detail: "" });
    await expect(see).toBeVisible();
    await expect(cards(page)).toHaveCount(0);
    await expect(page.locator(PANEL)).not.toContainText("Other changes");

    // History keeps each pass: the request whole, and its changes when it's opened.
    await page.getByRole("button", { name: "History", exact: true }).click();
    const items = page.locator(`${HISTORY} .history-item`);
    await expect(items.nth(0).locator(".history-asked")).toHaveText("Other changes");
    await expect(items.nth(1).locator(".history-asked")).toContainText("Asked in chat: Make the budget line punchier.");
    await items.nth(1).click();
    expect(await page.locator(`${HISTORY} .history-request`).evaluate((e) => (e as HTMLElement).innerText)).toBe(request);
    await expect(page.locator(`${HISTORY} .history-detail .history-change`).last()).toContainText("Budget:");
    await expect.poll(() => page.locator(`${VERSION} ins.diff-added`).allTextContents()).toEqual(expect.arrayContaining(["three", expect.stringContaining("Budget:")]));
  } finally {
    await run.app.close();
    await claude.stop();
  }
});

test("cards of these kinds kept from before (an older Corillo) no longer show, nothing goes wrong, and their record is left as it was", async () => {
  let run = await openText(PLAN, { name: "plan.md" });
  await comment(run, "two people", "Make it three.");
  await run.app.close();
  // What an older Corillo kept beside the comments: a request's changes and the other changes, waiting for review.
  const [folder] = readdirSync(join(run.dataDir, "documents"));
  const kept = join(run.dataDir, "documents", folder, "other-changes.json");
  const span = { anchor: { quote: "tight", prefix: "The budget is ", suffix: ".", offset: 56 }, removed: "" };
  const old = JSON.stringify([
    { id: "request-1", request: "Make the budget line punchier.", round: 1, agents: ["Claude"], at: "2026-11-12T10:00:00.000Z", spans: [span] },
    { id: "other", round: 1, agents: ["Claude"], at: "2026-11-12T10:00:00.000Z", spans: [span] },
  ]);
  writeFileSync(kept, old);
  run = await relaunch(run);
  const { page } = run;
  try {
    await expect(card(page, "Make it three.")).toBeVisible();
    await expect(cards(page)).toHaveCount(1);
    await expect(page.locator(PANEL)).not.toContainText("Asked in chat");
    await expect(page.locator(PANEL)).not.toContainText("Other changes");
    await expect(page.locator(".file-notice:not([hidden])")).toHaveCount(0);
    await clickMenu(run.app, "review-next");
    await expect(card(page, "Make it three.")).toHaveClass(/active/);
    await clickMenu(run.app, "review-next");
    await expect(card(page, "Make it three.")).toHaveClass(/active/);
    // The person types and comments as ever; the old record stays as it was.
    await selectText(page, "tight");
    await page.keyboard.type("short");
    await comment(run, "short", "Say by how much.");
    await expect(cards(page)).toHaveCount(2);
    expect(readFileSync(kept, "utf8")).toBe(old);
    // On the start screen, nothing waits for the person in it.
    await clickMenu(run.app, "close-tab");
    await page.locator(".recent-item").first().waitFor();
    // Nothing waits for him: the card says nothing about it.
    await expect(page.locator(".recent-item").first()).not.toContainText("waiting for you");
  } finally {
    await run.app.close();
  }
});

// Orlando: "Yes. Let's take that tick out."
test("no Waiting for you first: not in the panel nor the Review menu, the cards keep the panel's one order, and a setting kept from before is dropped", async () => {
  const dataDir = mkdtempSync(join(tmpdir(), "corillo-data-"));
  writeFileSync(join(dataDir, "view.json"), JSON.stringify({ waitingFirst: true, zoom: 1 }, null, 2));
  const run = await openText(PLAN, { name: "plan.md", dataDir });
  const { page } = run;
  await comment(run, "two people", "Make it three.");
  await comment(run, "tight", "Say by how much.");
  const { session: claude } = await AgentSession.start(run.dataDir, "claude-code");
  const order = () => cards(page).evaluateAll((all) => all.map((c) => (c.textContent!.includes("Make it three.") ? "three" : "tight")));
  try {
    // Claude answers only the second: it waits for the person, the first for Claude. The order stays the words' order.
    const ids = idsIn(await claude.ok("take_document", { path: run.file }));
    await claude.ok("reply_to_comment", { path: run.file, comment_id: ids.get("tight"), text: "10% under plan." });
    expect((await claude.call("finish_editing", { path: run.file })).text).toContain("still waiting for you");
    await claude.ok("finish_editing", { path: run.file });
    await expect(page.locator(LINE)).toBeVisible();
    await expect.poll(order).toEqual(["three", "tight"]);
    await expect(page.locator(PANEL).getByRole("checkbox")).toHaveCount(0);
    await expect(page.locator(PANEL)).not.toContainText("Waiting for you first");
    const items = await menuItems(run);
    expect(items.map((i) => i.id)).not.toContain("review-waiting-first");
    expect(items.map((i) => i.label)).not.toContain("Waiting for You First");
    // The setting kept from before is gone from the data folder; the others stay.
    const view = () => JSON.parse(readFileSync(join(dataDir, "view.json"), "utf8")) as Record<string, unknown>;
    await expect.poll(() => "waitingFirst" in view()).toBe(false);
    expect(view().zoom).toBe(1);
  } finally {
    await run.app.close();
    await claude.stop();
  }
});

// Orlando: "can we also get a new comment button at the top of the comments
// pane please", "Commments are core to how the app works...so we want to make
// that easy to do."
test("New comment at the top of the panel, comments or none: on the selected words, or on the whole document with none selected", async () => {
  const run = await openText(PLAN, { name: "plan.md" });
  const { page } = run;
  try {
    // With no comments: the button, and the empty panel's words name it.
    await expect(newComment(page)).toBeVisible();
    await expect(newComment(page)).toHaveAttribute("title", "New comment on the selected words, or on the whole document (⌥⌘M)");
    await expect(page.locator(`${PANEL} .comments-empty`)).toHaveText(
      "Select some words, then choose New comment (⌥⌘M). With nothing selected, it's a comment on the whole document. Your comments go to the agents working on this document.",
    );

    // Words selected: a comment on them, the keyboard in its box.
    await selectText(page, "two people");
    await newComment(page).click();
    const box = page.getByRole("textbox", { name: "New comment" });
    await expect(box).toBeFocused();
    await expect(page.locator(`${PANEL} .comment-card.draft .comment-quote`)).toHaveText("two people");
    await page.keyboard.type("Make it three.");
    await page.getByRole("button", { name: "Post" }).click();
    await expect(card(page, "Make it three.").locator(".comment-quote")).toHaveText("two people");

    // Nothing selected: a comment on the whole document. The button is still there with comments.
    await expect(newComment(page)).toBeVisible();
    await page.locator(`${EDITOR} h1`).click();
    await settle(page);
    await newComment(page).click();
    await expect(box).toBeFocused();
    await page.keyboard.type("Add a closing line.");
    await page.getByRole("button", { name: "Post" }).click();
    await expect(card(page, "Add a closing line.")).toBeVisible();
    await expect(card(page, "Add a closing line.").locator(".comment-quote")).toHaveCount(0);
    expect(await card(page, "Add a closing line.").getAttribute("aria-label")).toContain("on the whole document");

    // In the Markdown view, on words selected in the text.
    await clickMenu(run.app, "view-markdown");
    const source = page.locator(".doc:not([hidden]) textarea.source");
    await source.evaluate((t: HTMLTextAreaElement) => {
      const at = t.value.indexOf("this quarter");
      t.focus();
      t.setSelectionRange(at, at + "this quarter".length);
    });
    await newComment(page).click();
    await expect(box).toBeFocused();
    await expect(page.locator(`${PANEL} .comment-card.draft .comment-quote`)).toHaveText("this quarter");
    await page.keyboard.press("Escape");
  } finally {
    await run.app.close();
  }
});

test("in the narrowest window, New comment sits beside Copy for Claude without crowding it, and the done line keeps its words whole beside Show changes", async () => {
  const run = await openText(PLAN, { name: "plan.md" });
  const { page } = run;
  const claude = (await AgentSession.start(run.dataDir, "claude-code")).session;
  try {
    // Scroll bars that take room, as with a mouse connected: the panel keeps 15 px for its own.
    await page.addStyleTag({ content: "::-webkit-scrollbar { width: 15px; height: 15px; } ::-webkit-scrollbar-thumb { background: #888; }" });
    await run.app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].setContentSize(560, 700));
    await comment(run, "two people", "Make it three.");
    await expect.poll(() => page.locator(PANEL).evaluate((p) => Math.round(p.getBoundingClientRect().width))).toBe(264);
    expect(await page.locator(PANEL).evaluate((p) => p.clientWidth)).toBe(248); // its scroll bar's room taken
    const send = page.locator(PANEL).getByRole("button", { name: "Copy for Claude" });
    await expect(send).toBeVisible();
    await expect(newComment(page)).toBeVisible();
    const box = (sel: string) => page.locator(sel).evaluate((e) => e.getBoundingClientRect().toJSON() as DOMRect);
    const a = await box(`${PANEL} .comments-new`);
    const b = await box(`${PANEL} .comments-hand-back`);
    const panel = await box(PANEL);
    // One row, apart, inside the panel, neither cut short.
    expect(Math.abs(a.top - b.top)).toBeLessThan(2);
    expect(a.right + 8).toBeLessThanOrEqual(b.left + 0.5);
    expect(b.right).toBeLessThanOrEqual(panel.right - 16);
    for (const sel of [".comments-new", ".comments-hand-back"]) {
      expect(await page.locator(`${PANEL} ${sel}`).evaluate((e) => e.scrollWidth <= e.clientWidth)).toBe(true);
    }

    // A pass that changes words no comment asked for: who is done reads whole, and Show changes fits
    // beside it, in words (review of Batch 11, F-23: it was a picture with no name, and the count was cut to "4…").
    // What's left to read is whole or left out, never cut: the Comments panel beside it counts the same.
    const id = /\[([0-9a-f]+)\] on /.exec(await claude.ok("take_document", { path: run.file, request: "A stronger budget line." }))![1];
    await claude.ok("edit_document", { path: run.file, edits: [{ find: "The budget is tight.", replace: "Budget: tight." }] });
    await claude.ok("reply_to_comment", { path: run.file, comment_id: id, text: "Three it is, once the budget allows." });
    await claude.ok("finish_editing", { path: run.file });
    await expect(page.locator(LINE)).toBeVisible();
    await expect(page.locator(`${LINE} .pass-notice-detail`)).toHaveText("1 comment to read.");
    const see = page.locator(LINE).getByRole("button", { name: "Show changes" });
    await expect(see).toBeVisible();
    await expect(see).toHaveAttribute("title", /^Show changes since you handed the document over/);
    expect(await page.locator(`${LINE} .pass-notice-lead`).evaluate((e) => e.scrollWidth <= e.clientWidth)).toBe(true);
    await expect(page.locator(`${LINE} .pass-notice-lead`)).toContainText("Claude is done.");
    await expect(see).toHaveText("Show changes");
    expect(await see.evaluate((e) => e.scrollWidth <= e.clientWidth)).toBe(true);
    expect(await page.locator(`${LINE} .pass-notice-detail`).evaluate((e) => !e.getClientRects().length || e.scrollWidth <= e.clientWidth)).toBe(true);
    const line = await box(LINE);
    const link = await box(`${LINE} .pass-notice-see`);
    expect(link.right).toBeLessThanOrEqual(line.right - 8);
    // A little wider, where the count had room for "1 comm…": still whole or left out.
    await run.app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].setContentSize(700, 700));
    await expect.poll(() => page.locator(LINE).evaluate((e) => Math.round(e.getBoundingClientRect().width))).toBeGreaterThan(400);
    expect(await page.locator(`${LINE} .pass-notice-lead`).evaluate((e) => e.scrollWidth <= e.clientWidth)).toBe(true);
    expect(await page.locator(`${LINE} .pass-notice-detail`).evaluate((e) => !e.getClientRects().length || e.scrollWidth <= e.clientWidth)).toBe(true);
    await see.click();
    await expect(page.locator(".doc:not([hidden])")).toHaveClass(/viewing-changes/);
  } finally {
    await run.app.close();
    await claude.stop();
  }
});

// New comment never does nothing without a word (review of Batch 9, B9-02): it stays in step with Comment. Since
// roadmap Batch 25, item 1, both work while Show changes is on (its page still read-only), and Show changes stays on.
test("while Show changes is on, New comment works with Comment, and Show changes stays on", async () => {
  const run = await openText(PLAN, { name: "plan.md" });
  const { page } = run;
  const claude = (await AgentSession.start(run.dataDir, "claude-code")).session;
  const commentTool = page.locator("#toolbar").getByRole("button", { name: "Comment", exact: true });
  try {
    await expect(newComment(page)).toBeEnabled();
    await claude.ok("take_document", { path: run.file, request: "A stronger budget line." });
    await claude.ok("edit_document", { path: run.file, edits: [{ find: "The budget is tight.", replace: "Budget: tight." }] });
    await claude.ok("finish_editing", { path: run.file });
    await page.locator(LINE).getByRole("button", { name: "Show changes" }).click();
    await expect(page.locator(".doc:not([hidden])")).toHaveClass(/viewing-changes/);
    await expect(page.locator(PANEL)).toBeVisible();
    await expect(commentTool).toBeEnabled();
    await expect(newComment(page)).toBeEnabled();
    // Nothing selected: a comment on the whole document starts, and Show changes stays on.
    await newComment(page).click();
    await expect(page.getByRole("textbox", { name: "New comment" })).toBeFocused();
    await expect(page.locator(`${PANEL} .comment-card.draft`)).toHaveCount(1);
    await expect(page.locator(".doc:not([hidden])")).toHaveClass(/viewing-changes/);
    await page.keyboard.press("Escape");
    await expect(page.locator(`${PANEL} .comment-card.draft`)).toHaveCount(0);

    // Show changes off: both still work, and New comment starts a comment.
    await clickMenu(run.app, "view-changes");
    await expect(page.locator(".doc:not([hidden])")).not.toHaveClass(/viewing-changes/);
    await expect(commentTool).toBeEnabled();
    await expect(newComment(page)).toBeEnabled();
    await newComment(page).click();
    await expect(page.getByRole("textbox", { name: "New comment" })).toBeFocused();
    await page.keyboard.press("Escape");
  } finally {
    await run.app.close();
    await claude.stop();
  }
});

// One bar at a time (review of Batch 11, F-9): with Show changes on after a pass, the done line stayed above
// Show changes' own bar, still offering to show what was already shown. Now Show changes, or an earlier version
// picked in History, takes the done line's place, and going back brings the line back as it was. (Until then, from
// review of Batch 9, B9-03, the line stayed over an earlier version, and its button went to the changes from there.)
test("one bar at a time: Show changes, or an earlier version, takes the done line's place, and the line comes back after", async () => {
  const run = await openText(PLAN, { name: "plan.md" });
  const { page } = run;
  const claude = (await AgentSession.start(run.dataDir, "claude-code")).session;
  // The bars above the page that can be seen.
  const bars = () =>
    page
      .locator(".doc:not([hidden]) .doc-main > :is(.pass-notice, .agent-notice, .banner)")
      .evaluateAll((all) => all.filter((e) => e.getClientRects().length && getComputedStyle(e).visibility !== "hidden").map((e) => e.className));
  try {
    await claude.ok("take_document", { path: run.file, request: "A stronger budget line." });
    await claude.ok("edit_document", { path: run.file, edits: [{ find: "The budget is tight.", replace: "Budget: tight." }] });
    await claude.ok("finish_editing", { path: run.file });
    const see = page.locator(LINE).getByRole("button", { name: "Show changes" });
    await expect(see).toBeVisible();
    expect(await bars()).toEqual(["pass-notice"]);

    // Show changes, from the line: its bar alone.
    await see.click();
    await expect(page.locator(".doc:not([hidden])")).toHaveClass(/viewing-changes/);
    await expect(page.locator(LINE)).toBeHidden();
    expect(await bars()).toEqual(["banner version-banner"]);
    await page.locator(".doc:not([hidden]) .version-banner").getByRole("button", { name: "Hide changes" }).click();
    await expect(see).toBeVisible();
    expect(await bars()).toEqual(["pass-notice"]);

    // An earlier version, picked in History: its bar alone, and the line again on the way back.
    await page.getByRole("button", { name: "History", exact: true }).click();
    const items = page.locator(`${HISTORY} .history-item`);
    await expect(items).toHaveCount(2);
    await items.nth(1).click();
    await expect(page.locator(".doc:not([hidden])")).toHaveClass(/viewing-version/);
    await expect(page.locator(VERSION)).not.toContainText("Budget:");
    await expect(page.locator(LINE)).toBeHidden();
    expect(await bars()).toEqual(["banner version-banner"]);
    // Back to current: the line is there again, and its Show changes shows everything since the hand-over.
    await page.locator(".doc:not([hidden]) .version-banner").getByRole("button", { name: "Back to current" }).click();
    await expect(page.locator(".doc:not([hidden])")).not.toHaveClass(/viewing-version/);
    await expect(see).toBeVisible();
    expect(await bars()).toEqual(["pass-notice"]);
    await see.click();
    await expect(page.locator(".doc:not([hidden])")).toHaveClass(/viewing-changes/);
    await expect.poll(() => page.locator(`${VERSION} ins.diff-added`).allTextContents()).toEqual(expect.arrayContaining([expect.stringContaining("Budget:")]));
    expect(await bars()).toEqual(["banner version-banner"]);
  } finally {
    await run.app.close();
    await claude.stop();
  }
});
