// Going through an agent's work from the keyboard, card by card (roadmap
// Batch 1, item 2). After Next or Previous Comment the keyboard rests on the
// card, so typing starts a reply and never lands in the document (D4). After
// a pass, Next takes the cards with something new first, wherever focus was,
// then goes back to the top saying so; each of those cards carries a dot
// until it has been in focus, and the status bar counts down what's left.
// Each test runs the real app, hidden, on a throwaway document and data folder.
import { test, expect, type Page } from "@playwright/test";
import { rmSync } from "node:fs";
import { captureClipboardWrites, clickMenu, clipboardHoldsText, cursorAtEnd, openAlso, openText, selectText, settle, turnSaid, EDITOR, type Running } from "./helpers";
import { AgentSession } from "./agent-session";

const PANEL = ".doc:not([hidden]) aside.comments-panel";
const TURN = "#turn-status";
const DOC = [
  "# Offsite plan",
  "",
  "We meet on Friday at the old library.",
  "",
  "The budget is two thousand dollars.",
  "",
  "Lunch is at noon, in the garden.",
  "",
  "Everyone gets home by six.",
  "",
].join("\n");

const card = (page: Page, text: string) => page.locator(`${PANEL} .comment-card:not(.draft)`, { hasText: text });
/** The first card in the panel's order: a comment Claude answered, on the document's first words. */
const asked = (page: Page) => card(page, "Who's coming?");
const replyBox = (page: Page, text: string) => card(page, text).getByRole("textbox", { name: "Reply" });
/** The cards showing a dot for something new, by their first words. */
const dotted = (page: Page) =>
  page.locator(`${PANEL} .comment-card`).evaluateAll((cards) =>
    cards
      .filter((c) => c.querySelector(".card-new:not([hidden])"))
      .map((c) => (c.querySelector(".comment-body")?.textContent ?? "").trim()),
  );
/** Where the keyboard is: "document", the card it rests on (its first words), a reply box ("reply: ..."), or something else. */
const keyboard = (page: Page) =>
  page.evaluate(() => {
    const a = document.activeElement as HTMLElement | null;
    if (!a || a === document.body) return "nowhere";
    if (a.closest(".ProseMirror")) return "document";
    const first = (c: Element | null) => (c?.querySelector(".comment-body")?.textContent ?? "").trim();
    if (a.classList.contains("comment-card")) return `card: ${first(a)}`;
    if (a instanceof HTMLTextAreaElement && a.getAttribute("aria-label") === "Reply") return `reply: ${first(a.closest(".comment-card"))}`;
    return a.tagName.toLowerCase();
  });
/** The words in the document, as on the page. */
const pageText = (page: Page) => page.locator(`${EDITOR} .ProseMirror`).innerText();

let run: Running | null = null;
let claude: AgentSession | null = null;

test.afterEach(async () => {
  const r = run;
  run = null;
  await claude?.stop().catch(() => undefined);
  claude = null;
  if (!r) return;
  // Some tests end with words in a reply box, and closing would ask about them first: quit outright.
  await r.app.evaluate(({ app }) => setTimeout(() => app.exit(0), 10)).catch(() => undefined);
  await r.app.close().catch(() => undefined);
  for (const dir of [r.folder, r.dataDir]) rmSync(dir, { recursive: true, force: true });
});

async function comment(page: Page, words: string, body: string): Promise<void> {
  await selectText(page, words);
  await page.getByRole("button", { name: "Comment", exact: true }).click();
  await page.getByRole("textbox", { name: "New comment" }).fill(body);
  await page.getByRole("button", { name: "Post" }).click();
  await expect(card(page, body)).toBeVisible();
}

/** The ids take_document shows, by the words each comment is on. */
function idsIn(text: string): Map<string, string> {
  const ids = new Map<string, string>();
  for (const m of text.matchAll(/\[([^\]]+)\] on "([^"]+)"/g)) ids.set(m[2], m[1]);
  return ids;
}

/**
 * Five comments, the one on "by six" posted last (so it's still in focus), then
 * Claude's pass: asked in the chat to call it a retreat, it answers four of
 * them and leaves "Is that enough?" for later. Four cards then have something
 * new. The request has no card (roadmap Batch 9, item 5).
 */
async function afterAPass(): Promise<Running> {
  run = await openText(DOC, { name: "offsite.md" });
  const { page } = run;
  await comment(page, "We meet", "Who's coming?");
  await comment(page, "Friday", "Which Friday?");
  await comment(page, "two thousand", "Is that enough?");
  await comment(page, "noon", "Make it earlier.");
  await comment(page, "by six", "Say how.");
  claude = (await AgentSession.start(run.dataDir, "claude-code")).session;
  const ids = idsIn(await claude.ok("take_document", { path: run.file, request: "Call it a retreat." }));
  await claude.ok("edit_document", { path: run.file, edits: [{ find: "# Offsite plan", replace: "# Retreat plan" }] });
  await claude.ok("edit_document", { path: run.file, edits: [{ find: "at noon", replace: "at half past eleven" }], comment_ids: [ids.get("noon")] });
  await claude.ok("reply_to_comment", { path: run.file, comment_id: ids.get("We meet"), text: "The whole team." });
  await claude.ok("reply_to_comment", { path: run.file, comment_id: ids.get("Friday"), text: "The 14th." });
  await claude.ok("reply_to_comment", { path: run.file, comment_id: ids.get("noon"), text: "Moved to half past eleven." });
  await claude.ok("reply_to_comment", { path: run.file, comment_id: ids.get("by six"), text: "A coach leaves at five." });
  await claude.call("finish_editing", { path: run.file }); // points out the one left, once
  await claude.ok("finish_editing", { path: run.file });
  await expect(page.locator(".doc:not([hidden]) .pass-notice")).toContainText("Claude is done");
  return run;
}

// L-4: "post a comment last, let an agent pass, and check that Next starts at the first new card and visits each one."
test("after a pass, Next starts at the first card with something new wherever focus was, takes those first, then goes back to the top saying so; dots and the status bar count down", async () => {
  const { page, app } = await afterAPass();

  // The card posted last is still in focus; it has something new too.
  await expect(card(page, "Say how.")).toHaveClass(/active/);
  await expect.poll(() => dotted(page)).toEqual(["Who's coming?", "Which Friday?", "Make it earlier.", "Say how."]);
  await expect(page.locator(TURN)).toHaveText("With you · 4 to read");
  await expect(page.locator(TURN)).toHaveAttribute("title", /4 to read in the Comments panel/);
  // The dot is in the agent's colour (its initial's on the card).
  const dotColour = await asked(page).locator(".card-new").evaluate((d) => getComputedStyle(d).backgroundColor);
  const claudeColour = await card(page, "Which Friday?").locator(".comment-avatar:not(.person)").evaluate((a) => getComputedStyle(a).backgroundColor);
  expect(dotColour).toBe(claudeColour);
  // A screen reader hears which cards are new.
  await expect(card(page, "Which Friday?")).toHaveAttribute("aria-label", /, new$/);
  await expect(card(page, "Is that enough?")).not.toHaveAttribute("aria-label", /, new$/);

  // Next: the first card with something new, at the top, not the one after the card in focus.
  await page.keyboard.press("Meta+Alt+ArrowDown");
  await expect(asked(page)).toHaveClass(/active/);
  await expect.poll(() => dotted(page)).toEqual(["Which Friday?", "Make it earlier.", "Say how."]);
  await expect(page.locator(TURN)).toHaveText("With you · 3 to read");
  await page.keyboard.press("Meta+Alt+ArrowDown");
  await expect(card(page, "Which Friday?")).toHaveClass(/active/);
  await expect(page.locator(TURN)).toHaveText("With you · 2 to read");
  // "Is that enough?" has nothing new (it waits for Claude): the new ones come first.
  await clickMenu(app, "review-next");
  await expect(card(page, "Make it earlier.")).toHaveClass(/active/);
  await expect(page.locator(TURN)).toHaveText("With you · 1 to read");
  await page.keyboard.press("Meta+Alt+ArrowDown");
  await expect(card(page, "Say how.")).toHaveClass(/active/);
  await expect(page.locator(TURN)).toHaveText("With you");
  await expect.poll(() => dotted(page)).toEqual([]);
  await expect(card(page, "Which Friday?")).not.toHaveAttribute("aria-label", /, new$/);

  // Past the last new one: back to the top, saying so.
  await page.keyboard.press("Meta+Alt+ArrowDown");
  await expect(asked(page)).toHaveClass(/active/);
  await expect(page.locator(`${PANEL} .comments-note`)).toHaveText("That's everything new.");
  // Then card by card in the panel's order, round from the last to the first, both ways.
  await page.keyboard.press("Meta+Alt+ArrowDown");
  await expect(card(page, "Which Friday?")).toHaveClass(/active/);
  await page.keyboard.press("Meta+Alt+ArrowDown");
  await expect(card(page, "Is that enough?")).toHaveClass(/active/);
  await page.keyboard.press("Meta+Alt+ArrowDown");
  await page.keyboard.press("Meta+Alt+ArrowDown");
  await expect(card(page, "Say how.")).toHaveClass(/active/);
  await page.keyboard.press("Meta+Alt+ArrowDown");
  await expect(asked(page)).toHaveClass(/active/);
  await page.keyboard.press("Meta+Alt+ArrowUp");
  await expect(card(page, "Say how.")).toHaveClass(/active/);

  // The next pass brings dots and a count back for what's new in it, and only that.
  const ids = idsIn(await claude!.ok("take_document", { path: run!.file }));
  await claude!.ok("reply_to_comment", { path: run!.file, comment_id: ids.get("two thousand"), text: "Yes, with room to spare." });
  await claude!.ok("finish_editing", { path: run!.file });
  await expect(page.locator(TURN)).toHaveText("With you · 1 to read");
  await expect.poll(() => dotted(page)).toEqual(["Is that enough?"]);
  await page.keyboard.press("Meta+Alt+ArrowDown");
  await expect(card(page, "Is that enough?")).toHaveClass(/active/);
  await expect(page.locator(TURN)).toHaveText("With you");
});

test("clicking a card, or putting the cursor in its words, counts as reading it; Option-Command-Return moves on to the next card with something new", async () => {
  const { page } = await afterAPass();
  await card(page, "Make it earlier.").locator(".comment-body").first().click();
  await expect(page.locator(TURN)).toHaveText("With you · 3 to read");
  await selectText(page, "Friday");
  await expect(card(page, "Which Friday?")).toHaveClass(/active/);
  await expect(page.locator(TURN)).toHaveText("With you · 2 to read");
  await expect.poll(() => dotted(page)).toEqual(["Who's coming?", "Say how."]);

  // Next: the first card. Option-Command-Return resolves it and goes on to the
  // next card with something new, "Say how.", past the two already read; the keyboard rests there.
  await page.keyboard.press("Meta+Alt+ArrowDown");
  await expect(asked(page)).toHaveClass(/active/);
  await page.keyboard.press("Meta+Alt+Enter");
  await expect(asked(page)).toHaveCount(0);
  await expect(card(page, "Say how.")).toHaveClass(/active/);
  await expect.poll(() => keyboard(page)).toBe("card: Say how.");
  await expect(page.locator(TURN)).toHaveText("With you");
});

// L-5: "⌥⌘↓ then typing puts the text in that card's reply box, and the file is unchanged."
test("after Next Comment the keyboard rests on the card: typing starts its reply and never touches the page, Return opens the reply, Escape goes back", async () => {
  const r = await afterAPass();
  const { page, app } = r;
  await page.locator(`${EDITOR} h1`).click(); // the cursor in the title, away from every comment
  await settle(page);
  await page.keyboard.press("End");
  const before = { file: r.text(), words: await pageText(page) };

  // The first card: the keyboard rests on it.
  await page.keyboard.press("Meta+Alt+ArrowDown");
  await expect(asked(page)).toHaveClass(/active/);
  await expect.poll(() => keyboard(page)).toBe("card: Who's coming?");
  // The focus ring says so; a card clicked has none.
  const ring = (text: string) => card(page, text).evaluate((c) => getComputedStyle(c).outlineStyle);
  expect(await asked(page).evaluate((c) => getComputedStyle(c).outlineStyle)).toBe("solid");

  // A comment's card: typing a letter starts the reply, with that letter in it.
  await page.keyboard.press("Meta+Alt+ArrowDown");
  await expect(card(page, "Which Friday?")).toHaveClass(/active/);
  await expect.poll(() => keyboard(page)).toBe("card: Which Friday?");
  await page.keyboard.type("Good");
  await expect(replyBox(page, "Which Friday?")).toHaveValue("Good");
  await expect(replyBox(page, "Which Friday?")).toBeFocused();
  // Nothing reached the page or the file.
  await page.waitForTimeout(800); // longer than a save's pause
  expect(await pageText(page)).toBe(before.words);
  expect(r.text()).toBe(before.file);

  // Escape: back to the card, the words kept in its box; Escape again: back in the document, where the cursor was.
  await page.keyboard.press("Escape");
  await expect.poll(() => keyboard(page)).toBe("card: Which Friday?");
  await expect(replyBox(page, "Which Friday?")).toHaveValue("Good");
  await page.keyboard.press("Escape");
  await expect.poll(() => keyboard(page)).toBe("document");
  await page.keyboard.type(" for May");
  await expect(page.locator(`${EDITOR} h1`)).toHaveText("Retreat plan for May");
  expect(await ring("Which Friday?")).toBe("none");
  await card(page, "Which Friday?").locator(".comment-body").first().click();
  expect(await ring("Which Friday?")).toBe("none");

  // Return opens the reply box, empty; Command-Return posts it, and the keyboard is back on the card.
  // (Next goes to the first card not yet read, past "Is that enough?", which has nothing new.)
  await page.keyboard.press("Meta+Alt+ArrowDown");
  await expect(card(page, "Make it earlier.")).toHaveClass(/active/);
  await expect.poll(() => keyboard(page)).toBe("card: Make it earlier.");
  await page.keyboard.press("Enter");
  await expect(replyBox(page, "Make it earlier.")).toBeFocused();
  await expect(replyBox(page, "Make it earlier.")).toHaveValue("");
  await page.keyboard.type("Earlier still.");
  await page.keyboard.press("Meta+Enter");
  await expect(card(page, "Make it earlier.")).toHaveAttribute("aria-label", turnSaid("For Claude, not sent yet"));
  await expect.poll(() => keyboard(page)).toBe("card: Make it earlier.");

  // Option-Command-Return from a card resolves it, and the keyboard rests on the next one.
  await page.keyboard.press("Meta+Alt+ArrowDown");
  await expect(card(page, "Say how.")).toHaveClass(/active/);
  await page.keyboard.press("Meta+Alt+ArrowUp");
  await page.keyboard.press("Meta+Alt+ArrowUp");
  await expect(card(page, "Is that enough?")).toHaveClass(/active/);
  await page.keyboard.press("Meta+Alt+ArrowUp");
  await expect(card(page, "Which Friday?")).toHaveClass(/active/);
  await page.keyboard.press("Meta+Alt+Enter");
  await expect(card(page, "Which Friday?")).toHaveCount(0);
  await expect(card(page, "Is that enough?")).toHaveClass(/active/);
  await expect.poll(() => keyboard(page)).toBe("card: Is that enough?");

  // Reply has a shortcut, Option-Command-R, from the card or from the document.
  const item = await app.evaluate(({ Menu }) => {
    const i = Menu.getApplicationMenu()?.getMenuItemById("review-reply");
    return { accelerator: i?.accelerator, label: i?.label };
  });
  expect(item).toEqual({ accelerator: "CmdOrCtrl+Alt+R", label: "Reply to Comment" });
  await page.keyboard.press("Meta+Alt+r");
  await expect(replyBox(page, "Is that enough?")).toBeFocused();
  await page.keyboard.press("Escape");
  await expect.poll(() => keyboard(page)).toBe("card: Is that enough?");
  await page.keyboard.press("Escape");
  await expect.poll(() => keyboard(page)).toBe("document");
  await page.keyboard.press("Meta+Alt+r");
  await expect(replyBox(page, "Is that enough?")).toBeFocused();
  // Opened from the document, Escape goes back there.
  await page.keyboard.press("Escape");
  await expect.poll(() => keyboard(page)).toBe("document");

  // A click in the page works as before: typing goes there.
  await page.keyboard.press("Meta+Alt+ArrowDown");
  await expect.poll(() => keyboard(page)).toMatch(/^card: /);
  await page.locator(`${EDITOR} h1`).click();
  await settle(page);
  await page.keyboard.press("End");
  await page.keyboard.type("!");
  await expect(page.locator(`${EDITOR} h1`)).toHaveText("Retreat plan for May!");
});

/** A clipboard event sent where the browser sends Cut and Paste: the document's selection, wherever the keyboard is. */
const clipboardEvent = (page: Page, type: "cut" | "paste", text = "") =>
  page.evaluate(
    ([editor, kind, words]) => {
      const data = new DataTransfer();
      if (words) data.setData("text/plain", words);
      const at = window.getSelection()?.anchorNode;
      const target = at instanceof Element ? at : (at?.parentElement ?? document.querySelector(`${editor} .ProseMirror`)!);
      target.dispatchEvent(new ClipboardEvent(kind, { clipboardData: data, bubbles: true, cancelable: true }));
    },
    [EDITOR, type, text] as const,
  );

test("while the keyboard rests on a card, no shortcut, key, cut or undo changes the document; a paste starts the card's reply with the text (B1-02)", async () => {
  run = await openText(DOC, { name: "offsite.md" });
  const r = run;
  const { page, app } = r;
  await comment(page, "Friday", "Which Friday?");
  await comment(page, "noon", "Make it earlier.");
  await clipboardHoldsText(app, "Pasted words");
  const written = await captureClipboardWrites(app);
  // Words selected in the document, which Cut or Bold would act on.
  await selectText(page, "two thousand");
  const before = { file: r.text(), words: await pageText(page) };
  await page.keyboard.press("Meta+Alt+ArrowDown");
  await expect.poll(() => keyboard(page)).toMatch(/^card: /);
  const resting = await keyboard(page);
  const body = resting.replace(/^card: /, "");

  for (const key of ["Meta+B", "Meta+I", "Meta+Shift+8", "Meta+Alt+2", "Meta+K", "Meta+Z", "Backspace", "Delete"]) {
    await page.keyboard.press(key);
    await settle(page);
    expect(await keyboard(page), key).toBe(resting);
  }
  await clipboardEvent(page, "cut");
  await settle(page);
  expect(await keyboard(page)).toBe(resting);
  await page.waitForTimeout(800); // longer than a save's pause
  expect(await pageText(page)).toBe(before.words);
  expect(r.text()).toBe(before.file);
  expect(await written()).toBeNull();

  // Paste: the card's reply opens with the clipboard's text in it.
  await clipboardEvent(page, "paste", "Pasted words");
  await expect(replyBox(page, body)).toBeFocused();
  await expect(replyBox(page, body)).toHaveValue("Pasted words");
  // Paste and Match Style too, on the other card.
  await page.keyboard.press("Escape");
  await expect.poll(() => keyboard(page)).toBe(resting);
  await page.keyboard.press("Meta+Alt+ArrowDown");
  await expect.poll(() => keyboard(page)).toMatch(/^card: /);
  const other = (await keyboard(page)).replace(/^card: /, "");
  expect(other).not.toBe(body);
  await page.keyboard.press("Meta+Shift+V");
  await expect(replyBox(page, other)).toBeFocused();
  await expect(replyBox(page, other)).toHaveValue("Pasted words");
  expect(await pageText(page)).toBe(before.words);
  expect(r.text()).toBe(before.file);
});

test("the keyboard stays on a card after Resolve while any card is left, after posting from a reply reached with Tab, and on coming back to the tab (B1-07)", async () => {
  run = await openText(DOC, { name: "offsite.md" });
  const r = run;
  const { page, app } = r;
  await comment(page, "Friday", "Which Friday?");
  await comment(page, "two thousand", "Is that enough?");
  await comment(page, "noon", "Make it earlier.");
  for (let i = 0; i < 4 && (await keyboard(page)) !== "card: Make it earlier."; i++) await page.keyboard.press("Meta+Alt+ArrowDown");
  await expect.poll(() => keyboard(page)).toBe("card: Make it earlier.");

  // Resolve on the last card goes round to the first one left, as Next does.
  await page.keyboard.press("Meta+Alt+Enter");
  await expect(card(page, "Make it earlier.")).toHaveCount(0);
  await expect.poll(() => keyboard(page)).toBe("card: Which Friday?");

  // A reply box reached with Tab: posting goes back to the card.
  for (let i = 0; i < 8 && (await keyboard(page)) !== "reply: Which Friday?"; i++) await page.keyboard.press("Tab");
  await expect.poll(() => keyboard(page)).toBe("reply: Which Friday?");
  await page.keyboard.type("The 14th.");
  await page.keyboard.press("Meta+Enter");
  await expect(card(page, "Which Friday?")).toContainText("The 14th.");
  await expect.poll(() => keyboard(page)).toBe("card: Which Friday?");

  // Another tab and back: the keyboard is on the card again.
  await openAlso(r, "other.md", "Other notes.\n");
  await expect(page.locator(`${EDITOR}`)).toContainText("Other notes.");
  await clickMenu(app, "previous-tab");
  await expect(page.locator(`${EDITOR}`)).toContainText("Offsite plan");
  await expect.poll(() => keyboard(page)).toBe("card: Which Friday?");

  // With no card left, Resolve leaves the keyboard in the document.
  await page.keyboard.press("Meta+Alt+Enter");
  await expect.poll(() => keyboard(page)).toBe("card: Is that enough?");
  await page.keyboard.press("Meta+Alt+Enter");
  await expect(card(page, "Is that enough?")).toHaveCount(0);
  await expect.poll(() => keyboard(page)).toBe("document");
});

test("straight after Option-Command-Return, with the keyboard resting on the next card, Undo reopens the comment: by its key, Edit > Undo and the toolbar's Undo; otherwise Undo leaves the document alone", async () => {
  run = await openText(DOC, { name: "offsite.md" });
  const r = run;
  const { page, app } = r;
  await comment(page, "Friday", "Which Friday?");
  await comment(page, "two thousand", "Is that enough?");
  await comment(page, "noon", "Make it earlier.");
  // Typing in the document first, which an ordinary Undo would take back.
  await cursorAtEnd(page, "six.");
  await page.keyboard.type(" Mine.");
  await expect.poll(() => r.text()).toContain("by six. Mine.");
  const typed = r.text();
  const resolvedCount = page.locator(`${PANEL} .comments-resolved-count`);
  const restOn = async (body: string) => {
    for (let i = 0; i < 4 && (await keyboard(page)) !== `card: ${body}`; i++) await page.keyboard.press("Meta+Alt+ArrowDown");
    await expect.poll(() => keyboard(page)).toBe(`card: ${body}`);
  };
  const resolveFromCard = async () => {
    await restOn("Which Friday?");
    await page.keyboard.press("Meta+Alt+Enter");
    await expect(card(page, "Which Friday?")).toHaveCount(0);
    await expect(resolvedCount).toHaveText("1 resolved");
    await expect.poll(() => keyboard(page)).toBe("card: Is that enough?");
  };
  const reopened = async () => {
    await expect(card(page, "Which Friday?")).toHaveCount(1);
    await expect(page.locator(`${PANEL} .comments-resolved`)).toBeHidden();
    await expect(card(page, "Which Friday?")).toHaveClass(/active/);
    expect(await pageText(page)).toContain("by six. Mine.");
    expect(r.text()).toBe(typed);
  };

  // Command-Z: the comment is back, in focus, and the keyboard rests on its card.
  await resolveFromCard();
  await page.keyboard.press("Meta+z");
  await reopened();
  await expect.poll(() => keyboard(page)).toBe("card: Which Friday?");

  // Edit > Undo (the Mac's own, sent to the page).
  await resolveFromCard();
  await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].webContents.undo());
  await reopened();
  await expect.poll(() => keyboard(page)).toBe("card: Which Friday?");

  // The toolbar's Undo.
  await resolveFromCard();
  await page.getByRole("button", { name: "Undo", exact: true }).click();
  await reopened();

  // With nothing just resolved, Undo on a resting card leaves the document alone, by its key and from Edit > Undo.
  await restOn("Is that enough?");
  await page.keyboard.press("Meta+z");
  await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].webContents.undo());
  await page.waitForTimeout(800); // longer than a save's pause
  expect(r.text()).toBe(typed);
  expect(await pageText(page)).toContain("by six. Mine.");
  await expect.poll(() => keyboard(page)).toBe("card: Is that enough?");
});

test("on a resting card, a letter made with a dead key or an input method starts the reply with that letter, never touching the page (B1-11)", async () => {
  run = await openText(DOC, { name: "offsite.md" });
  const r = run;
  const { page } = r;
  await comment(page, "Friday", "Which Friday?");
  await comment(page, "noon", "Make it earlier.");
  await selectText(page, "two thousand");
  const before = { file: r.text(), words: await pageText(page) };
  // What the Mac sends: the key down, the letter being made (shown underlined), then the letter.
  const cdp = await page.context().newCDPSession(page);
  const compose = async (key: string, code: string, keyCode: number, marked: string, letter: string) => {
    await cdp.send("Input.dispatchKeyEvent", { type: "rawKeyDown", key, code, windowsVirtualKeyCode: keyCode });
    await cdp.send("Input.imeSetComposition", { text: marked, selectionStart: marked.length, selectionEnd: marked.length });
    await cdp.send("Input.dispatchKeyEvent", { type: "keyUp", key, code, windowsVirtualKeyCode: keyCode });
    await cdp.send("Input.insertText", { text: letter });
  };

  // A dead key (´ then a, on a Spanish keyboard).
  await page.keyboard.press("Meta+Alt+ArrowDown");
  await expect.poll(() => keyboard(page)).toMatch(/^card: /);
  const first = (await keyboard(page)).replace(/^card: /, "");
  await compose("Dead", "Quote", 222, "´", "á");
  await expect(replyBox(page, first)).toBeFocused();
  await expect(replyBox(page, first)).toHaveValue("á");

  // An input method (Japanese, say): its keys come as "Process".
  await page.keyboard.press("Escape");
  await page.keyboard.press("Meta+Alt+ArrowDown");
  await expect.poll(() => keyboard(page)).toMatch(/^card: /);
  const other = (await keyboard(page)).replace(/^card: /, "");
  expect(other).not.toBe(first);
  await compose("Process", "KeyK", 229, "か", "か");
  await expect(replyBox(page, other)).toBeFocused();
  await expect(replyBox(page, other)).toHaveValue("か");

  await page.waitForTimeout(800); // longer than a save's pause
  expect(await pageText(page)).toBe(before.words);
  expect(r.text()).toBe(before.file);
  await cdp.detach();
});

test("in the Markdown view too, the keyboard rests on the card and Escape goes back to the Markdown text", async () => {
  const { page } = await afterAPass();
  await page.getByRole("button", { name: "Markdown", exact: true }).click();
  const source = page.locator(".doc:not([hidden]) textarea.source");
  await expect(source).toBeVisible();
  const text = await source.inputValue();
  await source.focus();
  await page.keyboard.press("Meta+Alt+ArrowDown");
  await page.keyboard.press("Meta+Alt+ArrowDown");
  await expect(card(page, "Which Friday?")).toHaveClass(/active/);
  await page.keyboard.type("Fine");
  await expect(replyBox(page, "Which Friday?")).toHaveValue("Fine");
  await expect(source).toHaveValue(text);
  await page.keyboard.press("Escape");
  await page.keyboard.press("Escape");
  await expect(source).toBeFocused();
});
