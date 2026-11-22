// The review loop in the window: the person goes through an agent's work card by
// card, so a comment being written is never lost or hidden, and the Comments
// panel, History and Show changes take turns without the keyboard landing on
// the document's words. Each test runs the real app, hidden, on a throwaway
// document and data folder, and removes them when it's done.
import { test, expect, type Locator, type Page } from "@playwright/test";
import { existsSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { gunzipSync } from "node:zlib";
import { captureClipboardWrites, clickMenu, cursorAtEnd, messageAction, openAlso, openText, paste, selectText, settle, turnSaid, EDITOR, type OpenOptions, type Running } from "./helpers";
import type { Thread } from "../../src/core/comments";

const PANEL = ".doc:not([hidden]) aside.comments-panel";
const HISTORY_PANEL = ".doc:not([hidden]) .history-panel";
const SOURCE = ".doc:not([hidden]) textarea.source";
const DOC = "# Plan\n\nWe need two people this spring.\n\nThe budget is tight.\n";

const card = (page: Page, text: string) => page.locator(`${PANEL} .comment-card:not(.draft)`, { hasText: text });
const draft = (page: Page) => page.locator(`${PANEL} .comment-card.draft`);
const newBox = (page: Page) => page.getByRole("textbox", { name: "New comment" });
const commentButton = (page: Page) => page.getByRole("button", { name: "Comment", exact: true });
const historyButton = (page: Page) => page.getByRole("button", { name: "History", exact: true });
const changesButton = (page: Page) => page.locator("#toolbar .history-tools button").first();
const editorText = (page: Page) => page.locator(`${EDITOR} .ProseMirror`).innerText();

let run: Running | null = null;
let home: string | null = null;

async function start(text: string, options: OpenOptions = {}): Promise<Running> {
  run = await openText(text, options);
  home = await run.app.evaluate(() => process.env.CORILLO_HOME ?? null);
  return run;
}

test.afterEach(async () => {
  const r = run;
  run = null;
  if (!r) return;
  // Some tests end with words in a comment box, and closing would ask about them first: quit outright.
  await r.app.evaluate(({ app }) => setTimeout(() => app.exit(0), 10)).catch(() => undefined);
  await r.app.close().catch(() => undefined);
  for (const dir of [r.folder, r.dataDir, home]) if (dir) rmSync(dir, { recursive: true, force: true });
  home = null;
});

/** The comments as Corillo keeps them, in its data folder. */
function storedThreads(r: Running): Thread[] {
  const index = JSON.parse(readFileSync(join(r.dataDir, "documents.json"), "utf8")) as Record<string, { path: string }>;
  const id = Object.keys(index).find((k) => index[k].path === r.file);
  const file = join(r.dataDir, "documents", id ?? "none", "comments.json.gz");
  return existsSync(file) ? (JSON.parse(gunzipSync(readFileSync(file)).toString("utf8")) as Thread[]) : [];
}

/** Send the window an event from the app, as the agents' side does. */
async function sendToWindow(r: Running, channel: string, payload: unknown): Promise<void> {
  const docId = await r.page.locator(".doc:not([hidden])").getAttribute("data-doc-id");
  await r.app.evaluate(
    ({ BrowserWindow }, [ch, id, data]) => BrowserWindow.getAllWindows()[0].webContents.send(ch, id, data),
    [channel, docId, payload] as const,
  );
}

/** An agent's reply on a comment, as the app tells the window (the comments as stored, plus the reply). */
async function agentReplies(r: Running, onComment: string, body: string, agent = "Claude"): Promise<void> {
  await expect.poll(() => storedThreads(r).some((t) => t.messages[0]?.body === onComment)).toBe(true);
  const threads = storedThreads(r).map((t) =>
    t.messages[0]?.body === onComment
      ? {
          ...t,
          messages: [...t.messages, { id: `reply-${body.length}`, author: { kind: "agent" as const, name: agent }, body, created: new Date().toISOString() }],
        }
      : t,
  );
  await sendToWindow(r, "comments:changed", threads);
}

/** How many pixels of a box's words are cut off, past its bottom padding (0: every line shows whole). */
const cutOff = (box: Locator) =>
  box.evaluate((b: HTMLTextAreaElement) => Math.max(0, b.scrollHeight - b.clientHeight - parseFloat(getComputedStyle(b).paddingBottom)));

async function openHistory(page: Page): Promise<void> {
  await historyButton(page).click();
  await expect(page.locator(HISTORY_PANEL)).toBeVisible();
  await expect(page.locator(PANEL)).toBeHidden();
  await expect(page.locator(`${HISTORY_PANEL} .history-item`).first()).toBeVisible();
}

test("starting a comment while History is open brings the Comments panel back, and the typing goes into the comment, never over the words", async () => {
  const { page } = await start(DOC);

  // The Comment button.
  await openHistory(page);
  await selectText(page, "two people");
  await commentButton(page).click();
  await page.keyboard.type("abc");
  await expect(page.locator(HISTORY_PANEL)).toBeHidden();
  await expect(page.locator(PANEL)).toBeVisible();
  await expect(newBox(page)).toBeFocused();
  await expect(newBox(page)).toHaveValue("abc");
  expect(await editorText(page)).toContain("We need two people this spring.");
  await page.getByRole("button", { name: "Post" }).click();
  await expect(card(page, "abc")).toBeVisible();

  // Option-Command-M.
  await openHistory(page);
  await selectText(page, "budget");
  await page.keyboard.press("Alt+Meta+KeyM");
  await page.keyboard.type("def");
  await expect(page.locator(HISTORY_PANEL)).toBeHidden();
  await expect(newBox(page)).toBeFocused();
  await expect(newBox(page)).toHaveValue("def");
  expect(await editorText(page)).toContain("The budget is tight.");
  await page.getByRole("button", { name: "Post" }).click();
  await expect(card(page, "def")).toBeVisible();

  // The Markdown view.
  await page.getByRole("button", { name: "Markdown", exact: true }).click();
  await expect(page.locator(SOURCE)).toBeVisible();
  await openHistory(page);
  await page.locator(SOURCE).evaluate((area: HTMLTextAreaElement) => {
    const at = area.value.indexOf("spring");
    area.focus();
    area.setSelectionRange(at, at + "spring".length);
  });
  await settle(page);
  await commentButton(page).click();
  await page.keyboard.type("ghi");
  await expect(page.locator(HISTORY_PANEL)).toBeHidden();
  await expect(newBox(page)).toBeFocused();
  await expect(newBox(page)).toHaveValue("ghi");
  await expect(page.locator(SOURCE)).toHaveValue(DOC);
  await settle(page);
  expect(run!.text()).toBe(DOC);
});

test("Review > Next Comment and Reply with History open bring the comments back, so the card in focus is seen", async () => {
  const r = await start(DOC);
  const { page } = r;
  await selectText(page, "two people");
  await commentButton(page).click();
  await newBox(page).fill("Is two enough?");
  await page.getByRole("button", { name: "Post" }).click();
  await expect(card(page, "Is two enough?")).toBeVisible();

  await openHistory(page);
  await r.app.evaluate(({ Menu }) => Menu.getApplicationMenu()?.getMenuItemById("review-next")?.click());
  await expect(page.locator(HISTORY_PANEL)).toBeHidden();
  await expect(card(page, "Is two enough?")).toHaveClass(/active/);

  await openHistory(page);
  await r.app.evaluate(({ Menu }) => Menu.getApplicationMenu()?.getMenuItemById("review-reply")?.click());
  await expect(page.locator(HISTORY_PANEL)).toBeHidden();
  await expect(card(page, "Is two enough?").getByRole("textbox", { name: "Reply" })).toBeFocused();
});

// Since roadmap Batch 25, item 1, New Comment works while Show changes is on: on the words selected on its page. Words
// selected in the document before it came up are out of sight, so they don't take the comment.
test("Option-Command-M while Show changes is on, with nothing selected on its page, starts a comment on the whole document", async () => {
  const { page } = await start(DOC);
  await selectText(page, "two people");
  await changesButton(page).click();
  await expect(page.locator(".doc:not([hidden]) .version-banner")).toBeVisible();
  await expect(commentButton(page)).toBeEnabled();
  await page.keyboard.press("Alt+Meta+KeyM");
  await expect(draft(page)).toHaveCount(1);
  await expect(draft(page)).toContainText("Whole document");
  // Escape drops the empty comment, back on the page shown; Escape again goes back to writing.
  await page.keyboard.press("Escape");
  await expect(draft(page)).toHaveCount(0);
  await expect(page.locator(".doc:not([hidden]) .version-banner")).toBeVisible();
  await page.keyboard.press("Escape");
  await expect(page.locator(".doc:not([hidden]) .version-banner")).toBeHidden();
  await expect(page.locator(PANEL)).toBeVisible();
  await expect(draft(page)).toHaveCount(0);
  await expect(page.locator(`${EDITOR} .comment-range`)).toHaveCount(0);
});

test("a comment box is as tall as its words: an edit box redrawn by an agent's reply, and a long draft in a narrower panel, cut no line", async () => {
  const r = await start(DOC);
  const { page } = r;
  await selectText(page, "two people");
  await commentButton(page).click();
  await newBox(page).fill("Is two enough?");
  await page.getByRole("button", { name: "Post" }).click();
  await expect(card(page, "Is two enough?")).toBeVisible();
  // While its message is being edited, its words are in the box: find the card by its comment.
  const c = page.locator(`${PANEL} [data-thread-id="${await card(page, "Is two enough?").getAttribute("data-thread-id")}"]`);

  // Editing a five-line message, the agent replies: the card is drawn again, and the box still shows every line.
  await messageAction(c, "Edit");
  const edit = c.getByRole("textbox", { name: "Edit comment" });
  await expect(edit).toBeFocused();
  await page.keyboard.press("Meta+ArrowDown");
  for (const line of ["Second line.", "Third line.", "Fourth line.", "Fifth line."]) {
    await page.keyboard.press("Shift+Enter");
    await page.keyboard.type(line);
  }
  expect(await cutOff(edit)).toBe(0);
  const tall = await edit.evaluate((b) => b.clientHeight);
  await agentReplies(r, "Is two enough?", "Two is plenty for spring.");
  await expect(c).toContainText("Two is plenty for spring.");
  const again = c.getByRole("textbox", { name: "Edit comment" });
  await expect(again).toHaveValue(/Fifth line\.$/);
  expect(await cutOff(again)).toBe(0);
  expect(await again.evaluate((b) => b.clientHeight)).toBeGreaterThanOrEqual(tall - 1);
  await c.getByRole("button", { name: "Cancel" }).click();

  // A long draft, then the panel made narrower: its words wrap onto more lines, and none is cut.
  await page.evaluate(() => document.documentElement.style.setProperty("--side-width", "420px"));
  await selectText(page, "budget");
  await commentButton(page).click();
  await newBox(page).fill("This sentence goes on for a while so that it wraps onto several lines in the comment box. ".repeat(4));
  expect(await cutOff(newBox(page))).toBe(0);
  await page.evaluate(() => document.documentElement.style.setProperty("--side-width", "264px"));
  await settle(page);
  expect(await cutOff(newBox(page))).toBe(0);
});

/** Answer Corillo's next question with the button at this position (from the left), and keep what it asked. */
async function answerNext(r: Running, response: number): Promise<void> {
  await r.app.evaluate(({ dialog }, at) => {
    const g = globalThis as { asked?: string[] };
    g.asked = [];
    dialog.showMessageBox = (async (...args: unknown[]) => {
      const options = args.find((a) => typeof a === "object" && a && "message" in a) as { message: string };
      g.asked!.push(options.message);
      return { response: at, checkboxChecked: false };
    }) as typeof dialog.showMessageBox;
  }, response);
}
const asked = (r: Running) => r.app.evaluate(() => (globalThis as { asked?: string[] }).asked ?? []);

/** Select words, choose Comment, write it and post it. */
async function comment(page: Page, words: string, body: string): Promise<void> {
  await selectText(page, words);
  await commentButton(page).click();
  await newBox(page).fill(body);
  await page.getByRole("button", { name: "Post" }).click();
  await expect(card(page, body)).toBeVisible();
}

test("a reply typed and not sent comes back with Undo after a mistaken Resolve, and on a resolved comment it doesn't hold up closing", async () => {
  const r = await start(DOC);
  const { page } = r;
  await comment(page, "two people", "Is two enough?");
  await comment(page, "spring", "Too late?");

  // Resolve clicked instead of Reply: Undo brings the comment back with the words typed.
  const c = card(page, "Is two enough?");
  await c.locator(".comment-body").click();
  const reply = c.getByRole("textbox", { name: "Reply" });
  await reply.fill("Maybe three.");
  await c.getByRole("button", { name: "Resolve" }).click();
  await expect(c).toHaveCount(0);
  await page.keyboard.press("Meta+KeyZ");
  await expect(c).toBeVisible();
  await expect(reply).toHaveValue("Maybe three.");
  await expect(c.getByRole("button", { name: "Reply", exact: true })).toBeEnabled();

  // The same for an edit not saved yet.
  const byId = page.locator(`${PANEL} [data-thread-id="${await c.getAttribute("data-thread-id")}"]`);
  await messageAction(c, "Edit");
  const edit = byId.getByRole("textbox", { name: "Edit comment" });
  await edit.fill("Is two enough for spring?");
  await byId.getByRole("button", { name: "Resolve" }).click();
  await expect(byId).toHaveCount(0);
  await page.keyboard.press("Meta+KeyZ");
  await expect(edit).toHaveValue("Is two enough for spring?");
  await expect(byId.getByRole("textbox", { name: "Reply" })).toHaveValue("Maybe three.");
  await byId.getByRole("button", { name: "Cancel" }).first().click();
  await expect(edit).toHaveCount(0);

  // With resolved comments shown, a reply left on a comment then resolved doesn't ask about it on closing (its box can't be shown).
  await card(page, "Too late?").getByRole("button", { name: "Resolve" }).click();
  await page.locator(`${PANEL} .comments-show-resolved`).click();
  await c.getByRole("button", { name: "Resolve" }).click();
  await expect(c).toHaveClass(/resolved/);
  await expect(reply).toBeHidden();
  await answerNext(r, 0);
  await r.app.evaluate(({ Menu }) => Menu.getApplicationMenu()?.getMenuItemById("close-tab")?.click());
  await expect(page.locator("#empty")).toBeVisible();
  expect(await asked(r)).toEqual([]);
});

test("an edit left open on a comment that is then resolved: shown again, the resolved card has no edit box, and the comment keeps its words (S21-4)", async () => {
  const r = await start(DOC);
  const { page } = r;
  await comment(page, "two people", "Is two enough?");
  const c = card(page, "Is two enough?");
  const byId = page.locator(`${PANEL} [data-thread-id="${await c.getAttribute("data-thread-id")}"]`);
  await messageAction(c, "Edit");
  const edit = byId.getByRole("textbox", { name: "Edit comment" });
  await edit.fill("Is two enough for spring?");
  await byId.getByRole("button", { name: "Resolve" }).click();
  await expect(byId).toHaveCount(0);
  await page.locator(`${PANEL} .comments-show-resolved`).click();
  await expect(byId).toHaveClass(/resolved/);
  await expect(byId.getByRole("button", { name: "Reopen" })).toBeVisible();
  await expect(edit).toHaveCount(0);
  await expect(byId.getByRole("button", { name: "Save" })).toHaveCount(0);
  await expect(byId.locator(".comment-body").first()).toHaveText("Is two enough?");
  expect(storedThreads(r).find((t) => t.status === "resolved")?.messages[0]?.body).toBe("Is two enough?");
  // Reopen brings the edit back with the words typed, as Undo does.
  await byId.getByRole("button", { name: "Reopen" }).click();
  await expect(edit).toHaveValue("Is two enough for spring?");
});

test("with resolved comments shown, resolving a comment closes the edit box left open on it (S21-4)", async () => {
  const r = await start(DOC);
  const { page } = r;
  await comment(page, "two people", "Is two enough?");
  await comment(page, "spring", "Too late?");
  await card(page, "Too late?").getByRole("button", { name: "Resolve" }).click();
  await page.locator(`${PANEL} .comments-show-resolved`).click();
  await expect(card(page, "Too late?")).toHaveClass(/resolved/);
  const c = card(page, "Is two enough?");
  const byId = page.locator(`${PANEL} [data-thread-id="${await c.getAttribute("data-thread-id")}"]`);
  await messageAction(c, "Edit");
  const edit = byId.getByRole("textbox", { name: "Edit comment" });
  await edit.fill("Is two enough for spring?");
  await byId.getByRole("button", { name: "Resolve" }).click();
  await expect(byId).toHaveClass(/resolved/);
  await expect(byId.getByRole("button", { name: "Reopen" })).toBeVisible();
  await expect(edit).toHaveCount(0);
});

test("a card's whose-turn line follows agents arriving and leaving", async () => {
  const r = await start(DOC);
  const { page } = r;
  await comment(page, "two people", "Is two enough?");
  // Heard by a screen reader in the card's name; the card shows no line for it (roadmap Batch 9, item 3).
  const turn = card(page, "Is two enough?");
  await expect(turn).toHaveAttribute("aria-label", turnSaid("Not sent to an agent yet"));
  const agents = (list: { name: string; isDefault: boolean; colour: string }[]) =>
    sendToWindow(r, "agents:changed", list.map((a) => ({ ...a, editing: false })));
  await agents([{ name: "Writer", isDefault: true, colour: "sky" }]);
  await expect(turn).toHaveAttribute("aria-label", turnSaid("For Writer, not sent yet"));
  // Writer's session ends.
  await agents([]);
  await expect(turn).toHaveAttribute("aria-label", turnSaid("Not sent to an agent yet"));
  await agents([{ name: "Claude", isDefault: true, colour: "peach" }]);
  await expect(turn).toHaveAttribute("aria-label", turnSaid("For Claude, not sent yet"));
});

test("Show changes or a version from History, while a comment is being written, gives the keyboard back to the comment, never the words it's on", async () => {
  const r = await start(DOC);
  const { page } = r;
  const banner = page.locator(".doc:not([hidden]) .version-banner");
  const inDocument = () => page.evaluate(() => !!document.activeElement?.closest(".ProseMirror, textarea.source"));

  // Show changes, then Hide changes.
  await selectText(page, "two people");
  await commentButton(page).click();
  await newBox(page).fill("Is two");
  await changesButton(page).click();
  await expect(banner).toBeVisible();
  await page.getByRole("button", { name: "Hide changes" }).click();
  await expect(banner).toBeHidden();
  await expect(newBox(page)).toBeFocused();
  await page.keyboard.type(" enough?");
  await expect(newBox(page)).toHaveValue("Is two enough?");
  await page.getByRole("button", { name: "Post" }).click();
  await expect(card(page, "Is two enough?")).toBeVisible();

  // A reply, then a version picked in History and Back to current: the document doesn't get the keyboard
  // while History hides the reply; closing History gives it back to the reply.
  await card(page, "Is two enough?").locator(".comment-body").click();
  const reply = card(page, "Is two enough?").getByRole("textbox", { name: "Reply" });
  await reply.fill("Or three");
  await openHistory(page);
  await page.locator(`${HISTORY_PANEL} .history-item`).first().click();
  await expect(banner).toBeVisible();
  await page.locator(".doc:not([hidden]) .back-to-current").click(); // Hide changes, for the latest version
  await expect(banner).toBeHidden();
  expect(await inDocument()).toBe(false);
  await page.getByRole("button", { name: "Close history" }).click();
  await expect(page.locator(PANEL)).toBeVisible();
  await expect(reply).toBeFocused();
  await page.keyboard.type(" people");
  await expect(reply).toHaveValue("Or three people");
  expect(await editorText(page)).toContain("We need two people this spring.");
  await settle(page);
  expect(r.text()).toBe(DOC);

  // The same in the Markdown view, with Show changes.
  await page.getByRole("button", { name: "Markdown", exact: true }).click();
  await reply.click();
  await changesButton(page).click();
  await expect(banner).toBeVisible();
  await page.keyboard.press("Escape");
  await expect(banner).toBeHidden();
  await expect(reply).toBeFocused();
});

/** Select words in the page that may run across highlights (several text nodes), as if dragged over with the mouse. */
async function selectAcross(page: Page, wanted: string): Promise<void> {
  await page.evaluate(
    ([editor, text]) => {
      const root = document.querySelector<HTMLElement>(`${editor} .ProseMirror`)!;
      root.focus();
      const nodes: Text[] = [];
      const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT);
      for (let node = walker.nextNode(); node; node = walker.nextNode()) nodes.push(node as Text);
      const all = nodes.map((n) => n.data).join("");
      const at = all.indexOf(text);
      if (at < 0) throw new Error(`"${text}" isn't in the document`);
      const place = (offset: number, end: boolean): [Text, number] => {
        let seen = 0;
        for (const n of nodes) {
          if (offset < seen + n.data.length || (end && offset === seen + n.data.length)) return [n, offset - seen];
          seen += n.data.length;
        }
        const last = nodes[nodes.length - 1];
        return [last, last.data.length];
      };
      const range = document.createRange();
      range.setStart(...place(at, false));
      range.setEnd(...place(at + text.length, true));
      const selection = getSelection()!;
      selection.removeAllRanges();
      selection.addRange(range);
    },
    [EDITOR, wanted] as const,
  );
  await settle(page);
}

/** Drag the selected words in the page and drop them just before other words, as the person would with the mouse. */
async function dragSelectionBefore(page: Page, selected: string, target: string): Promise<void> {
  await page.evaluate(
    ([editor, from, to]) => {
      const root = document.querySelector<HTMLElement>(`${editor} .ProseMirror`)!;
      const spot = (wanted: string) => {
        const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT);
        for (let node = walker.nextNode(); node; node = walker.nextNode()) {
          const at = node.textContent!.indexOf(wanted);
          if (at < 0) continue;
          const range = document.createRange();
          range.setStart(node, at);
          range.setEnd(node, at + 1);
          const r = range.getBoundingClientRect();
          return { clientX: r.left + 1, clientY: r.top + r.height / 2 };
        }
        throw new Error(`"${wanted}" isn't in the document`);
      };
      const data = new DataTransfer();
      const start = spot(from);
      const end = spot(to);
      root.dispatchEvent(new DragEvent("dragstart", { bubbles: true, cancelable: true, dataTransfer: data, ...start }));
      root.dispatchEvent(new DragEvent("dragover", { bubbles: true, cancelable: true, dataTransfer: data, ...end }));
      root.dispatchEvent(new DragEvent("drop", { bubbles: true, cancelable: true, dataTransfer: data, ...end }));
      root.dispatchEvent(new DragEvent("dragend", { bubbles: true, cancelable: true, dataTransfer: data, ...end }));
    },
    [EDITOR, selected, target] as const,
  );
  await settle(page);
}

test("commented words moved elsewhere (cut and paste, drag and drop, the Markdown view) keep their comment", async () => {
  const MOVING = "# Plan\n\nWe need two people this spring.\n\nThe budget is tight.\n\nWe start in May.\n";
  const r = await start(MOVING);
  const { page } = r;
  await comment(page, "two people", "Is two enough?");
  const c = card(page, "Is two enough?");
  const highlights = () => page.locator(`${EDITOR} .comment-range`).allTextContents();
  const gaps = page.locator(`${EDITOR} .comment-gap`);
  const written = await captureClipboardWrites(r.app);

  // Exactly the commented words cut, then pasted at the end of the document.
  await selectAcross(page, "two people");
  await cut(page);
  await expect(gaps).toHaveCount(1);
  await expect.poll(written).not.toBeNull();
  await cursorAtEnd(page, "We start in May.");
  await page.keyboard.type(" Then ");
  await paste(page, { "text/html": (await written())!["text/html"], "text/plain": (await written())!["text/plain"] });
  await expect.poll(() => editorText(page)).toContain("We start in May. Then two people");
  await page.keyboard.type(" too.");
  await expect.poll(highlights).toEqual(["two people"]);
  await expect(gaps).toHaveCount(0);
  await expect(c.locator(".comment-change-note")).toHaveCount(0);
  await expect(c).not.toContainText("deleted");
  // And it stays so once its place is saved.
  await page.waitForTimeout(1000);
  await expect(c).not.toContainText("deleted");
  expect(storedThreads(r)[0]?.gap ?? null).toBeNull();

  // Exactly the commented words dragged back, before "budget".
  await selectAcross(page, "two people");
  await dragSelectionBefore(page, "two", "budget");
  await expect.poll(() => editorText(page)).toContain("The two peoplebudget is tight.");
  await expect.poll(highlights).toEqual(["two people"]);
  await expect(gaps).toHaveCount(0);
  await expect(c).not.toContainText("deleted");

  // In the Markdown view: the words cut from their line and typed in at another.
  await page.getByRole("button", { name: "Markdown", exact: true }).click();
  await expect(page.locator(SOURCE)).toBeVisible();
  await page.locator(SOURCE).evaluate((area: HTMLTextAreaElement) => {
    const at = area.value.indexOf("two people");
    area.focus();
    area.setSelectionRange(at, at + "two people".length);
    document.execCommand("delete");
  });
  await expect(c).toContainText("deleted");
  await page.locator(SOURCE).evaluate((area: HTMLTextAreaElement) => {
    const at = area.value.indexOf("We need") + "We need ".length;
    area.setSelectionRange(at, at);
    document.execCommand("insertText", false, "two people");
  });
  await expect(c).not.toContainText("deleted");
  await expect.poll(() => page.locator(".doc:not([hidden]) .source-marks mark").allTextContents()).toEqual(["two people"]);
  await page.getByRole("button", { name: "Formatted", exact: true }).click();
  await expect.poll(highlights).toEqual(["two people"]);
  await settle(page);
  // Saved on the moved words, so reopening finds them there.
  await expect.poll(() => storedThreads(r)[0]?.gap ?? null).toBeNull();
});

/** Cut the selection, as Cmd+X would, without touching the real clipboard (capture it first). */
async function cut(page: Page): Promise<void> {
  await page.evaluate((editor) => {
    document.querySelector(`${editor} .ProseMirror`)!.dispatchEvent(
      new ClipboardEvent("cut", { clipboardData: new DataTransfer(), bubbles: true, cancelable: true }),
    );
  }, EDITOR);
  await settle(page);
}

test("a comment on a whole sentence or paragraph moves with it", async () => {
  const r = await start("# Plan\n\nWe need two people this spring. Hiring takes time.\n\nThe budget is tight.\n\nWe start in May.\n");
  const { page } = r;
  await comment(page, "We need two people this spring.", "Whole sentence?");
  await comment(page, "We start in May.", "Whole paragraph?");
  await comment(page, "The budget is tight.", "Dragged paragraph?");
  const highlights = () => page.locator(`${EDITOR} .comment-range`).allTextContents();
  const gaps = page.locator(`${EDITOR} .comment-gap`);
  const written = await captureClipboardWrites(r.app);
  const pasteWritten = async () => {
    await expect.poll(written).not.toBeNull();
    const w = (await written())!;
    await paste(page, { "text/html": w["text/html"], "text/plain": w["text/plain"] });
    await settle(page);
  };

  // The sentence and its space, cut and pasted at the start of the next paragraph.
  await selectAcross(page, "We need two people this spring. ");
  await cut(page);
  await expect(gaps).toHaveCount(1);
  await selectAcross(page, "The budget");
  await page.keyboard.press("ArrowLeft");
  await settle(page);
  await pasteWritten();
  await expect.poll(() => editorText(page)).toContain("We need two people this spring. The budget is tight.");
  await expect(gaps).toHaveCount(0);
  await expect(card(page, "Whole sentence?")).not.toContainText("deleted");

  // The whole last paragraph's words, cut and pasted on a new line under the heading.
  await expect(card(page, "Whole paragraph?")).toBeVisible();
  await selectAcross(page, "We start in May.");
  await cut(page);
  await expect(gaps).toHaveCount(1);
  await cursorAtEnd(page, "Plan", "h1");
  await page.keyboard.press("Enter");
  await pasteWritten();
  await expect.poll(() => editorText(page)).toMatch(/^Plan\s+We start in May\./);
  await expect(gaps).toHaveCount(0);
  await expect(card(page, "Whole paragraph?")).not.toContainText("deleted");

  // A whole paragraph's words dragged to the end of another paragraph.
  await selectAcross(page, "The budget is tight.");
  await dragSelectionBefore(page, "The budget", "Hiring");
  await expect.poll(() => editorText(page)).toContain("The budget is tight.Hiring takes time.");
  await expect(gaps).toHaveCount(0);
  await expect(card(page, "Dragged paragraph?")).not.toContainText("deleted");
  await expect.poll(async () => (await highlights()).sort()).toEqual(["The budget is tight.", "We need two people this spring.", "We start in May."]);
  await page.waitForTimeout(1000);
  await expect(gaps).toHaveCount(0);
  expect(storedThreads(r).map((t) => t.gap ?? null)).toEqual([null, null, null]);
});

test("words like a deleted comment's, pasted nearby, never bring it back", async () => {
  const r = await start("# Plan\n\nWe need two people this spring. Hiring takes time.\n\nThe budget is tight.\n");
  const { page } = r;
  await comment(page, "two people", "Is two enough?");
  await comment(page, "Hiring takes time", "Why so long?");
  const gaps = page.locator(`${EDITOR} .comment-gap`);

  // More than the comment's words deleted, then other words holding them pasted in the next paragraph.
  await selectAcross(page, " two people this spring");
  await page.keyboard.press("Backspace");
  await expect(gaps).toHaveCount(1);
  await cursorAtEnd(page, "The budget is tight.");
  await paste(page, { "text/plain": " Ask two people." });
  await expect.poll(() => editorText(page)).toContain("The budget is tight. Ask two people.");
  await settle(page);
  await expect(gaps).toHaveCount(1);
  await expect(card(page, "Is two enough?")).toContainText("deleted");

  // Exactly the comment's words deleted, then longer words holding them pasted where they were.
  await selectAcross(page, "Hiring takes time");
  await page.keyboard.press("Backspace");
  await expect(gaps).toHaveCount(2);
  await paste(page, { "text/plain": "Hiring takes time, they say" });
  await expect.poll(() => editorText(page)).toContain("Hiring takes time, they say.");
  await settle(page);
  await expect(gaps).toHaveCount(2);
  await expect(card(page, "Why so long?")).toContainText("deleted");

  // And they stay deleted once their places are saved.
  await page.waitForTimeout(1000);
  await expect(card(page, "Is two enough?")).toContainText("deleted");
  await expect(card(page, "Why so long?")).toContainText("deleted");
  expect(storedThreads(r).map((t) => !!t.gap)).toEqual([true, true]);
});

test("clicking the card below a long one in focus leaves the clicked card where it was", async () => {
  const r = await start(`${DOC}\nWe start in May.\n\nThe office opens in June.\n\nHiring ends in July.\n\nReview comes in August.\n`);
  const { page } = r;
  const long = Array.from({ length: 30 }, (_, i) => `Line ${i + 1} of a long comment.`).join("\n");
  await comment(page, "two people", long.split("\n")[0]);
  await comment(page, "budget", "Tight how?");
  for (const month of ["May", "June", "July", "August"]) await comment(page, month, `Why ${month}?`);
  // The first card's message, made long.
  const first = card(page, "Line 1 of a long comment.");
  await messageAction(first, "Edit");
  const edit = page.getByRole("textbox", { name: "Edit comment" });
  await edit.fill(long);
  await edit.press("Meta+Enter");
  await expect(first).toContainText("Line 30 of a long comment.");
  await first.locator(".comment-body").click();
  await expect(first).toHaveClass(/active/);
  const second = card(page, "Tight how?");
  // The panel scrolled down to the second card, as the person would to reach it. (With the panel at
  // its top, nothing can hold the card: there's no scrolling back above the first card.)
  await page.locator(PANEL).evaluate((panel, sel) => {
    const target = panel.querySelector<HTMLElement>(sel)!;
    panel.scrollTop += target.getBoundingClientRect().top - panel.getBoundingClientRect().top - 120;
  }, `.comment-card:not(.draft):nth-child(2)`);
  await settle(page);
  const top = () => second.evaluate((e) => e.getBoundingClientRect().top);
  const before = await top();
  await second.locator(".comment-body").click();
  await expect(second).toHaveClass(/active/);
  await expect(first).not.toHaveClass(/active/);
  await settle(page);
  expect(Math.abs((await top()) - before)).toBeLessThan(1);
});

test("Go Back to It, on closing with a comment being written while History is open, closes History and gives the keyboard to the comment", async () => {
  const r = await start(DOC);
  const { page } = r;
  await selectText(page, "two people");
  await commentButton(page).click();
  await newBox(page).fill("Is two");
  await openHistory(page);
  await expect(newBox(page)).toBeHidden();
  // Closing asks about the comment; the person goes back to it.
  await r.app.evaluate(({ dialog }) => {
    dialog.showMessageBox = (async () => ({ response: 0, checkboxChecked: false })) as typeof dialog.showMessageBox;
  });
  await clickMenu(r.app, "close-tab");
  await expect(page.locator(HISTORY_PANEL)).toBeHidden();
  await expect(page.locator(PANEL)).toBeVisible();
  await expect(newBox(page)).toBeFocused();
  await page.keyboard.type(" enough?");
  await expect(newBox(page)).toHaveValue("Is two enough?");
  expect(await editorText(page)).toContain("We need two people this spring.");
});

test("a card clicked just above the panel's bottom edge opens up into sight, its reply box included, as Next Comment shows it", async () => {
  const months = ["January", "February", "March", "April", "May", "June", "July", "August", "September", "October", "November", "December"];
  const r = await start(`# Plan\n\n${months.map((m) => `We meet in ${m}.`).join("\n\n")}\n`);
  const { page } = r;
  for (const m of months) await comment(page, m, `Why ${m}?`);
  await page.locator(`${EDITOR} .ProseMirror`).click();
  await settle(page);
  // The panel scrolled so a card's top is 40 pixels above its bottom edge.
  const panelBottom = await page.locator(PANEL).evaluate((p) => p.getBoundingClientRect().bottom);
  const target = card(page, "Why October?");
  await page.locator(PANEL).evaluate((panel, bottom) => {
    const c = [...panel.querySelectorAll<HTMLElement>(".comment-card")].find((e) => e.textContent!.includes("Why October?"))!;
    panel.scrollTop += c.getBoundingClientRect().top - (bottom - 40);
  }, panelBottom);
  await settle(page);
  const at = await target.evaluate((e) => e.getBoundingClientRect());
  expect(Math.round(at.top)).toBe(Math.round(panelBottom - 40));
  // Clicked where it shows, with nothing scrolled first (as the person's pointer would).
  await page.mouse.click(at.left + at.width / 2, at.top + 20);
  await expect(target).toHaveClass(/active/);
  await settle(page);
  const reply = target.getByRole("textbox", { name: "Reply" });
  await expect(reply).toBeVisible();
  const box = await reply.evaluate((e) => e.getBoundingClientRect().bottom);
  expect(box).toBeLessThanOrEqual(panelBottom);
});

// Roadmap Batch 18, W-S2: comments' places are told at every pause, however little they moved (before, only once
// they had moved 300 characters, so a stale place could last the session); an agent's change still waits.
test("typing above comments sends Corillo their new places once the typing pauses, not an agent's change that moved a little; typing in a comment's words sends that one", async () => {
  const fruit = ["apples", "pears", "plums", "grapes", "melons"];
  const text = `# Plan\n\nThis opening paragraph is long enough that typing in it is far from every comment under it.\n\n${fruit.map((f) => `We buy ${f} on Monday.`).join("\n\n")}\n`;
  const r = await start(text);
  const { page } = r;
  for (const f of fruit) await comment(page, f, `Why ${f}?`);
  await expect.poll(() => storedThreads(r).length).toBe(5);
  // The places are told after a pause in typing (800 ms): wait for that pause itself, however late it comes.
  const { watchTimers } = await import("./helpers");
  const pauses = await watchTimers(page, 800);
  // An agent changed "kiwis" to "melons" for the last comment: its change is on the card and kept in place too.
  const plain = ["Plan", "This opening paragraph is long enough that typing in it is far from every comment under it.", ...fruit.map((f) => `We buy ${f} on Monday.`)].join("\n");
  const at = plain.indexOf("melons");
  const span = { anchor: { quote: "melons", prefix: plain.slice(at - 32, at), suffix: plain.slice(at + 6, at + 38), offset: at }, removed: "kiwis" };
  await sendToWindow(
    r,
    "comments:changed",
    storedThreads(r).map((t) => (t.messages[0].body === "Why melons?" ? { ...t, change: { round: 1, agent: "Claude", at: new Date().toISOString(), spans: [span] } } : t)),
  );
  await expect(card(page, "Why melons?")).toContainText("Claude changed the highlighted text.");
  if ((await pauses.count()).waiting) await pauses.ranSince((await pauses.count()).ran); // the last places are told
  await r.app.evaluate(({ ipcMain }) => {
    const g = globalThis as { anchorSends?: string[][]; changeSends?: number };
    g.anchorSends = [];
    g.changeSends = 0;
    ipcMain.on("comments:anchors", (_e, _id, anchors: Record<string, unknown>) => g.anchorSends!.push(Object.keys(anchors)));
    ipcMain.on("changes:anchors", () => g.changeSends!++);
  });
  const sends = () => r.app.evaluate(() => (globalThis as { anchorSends?: string[][] }).anchorSends ?? []);
  const changeSends = () => r.app.evaluate(() => (globalThis as { changeSends?: number }).changeSends ?? 0);

  // At the paragraph's first letter, wherever its lines wrap (a click in its middle can land on its second line,
  // close enough to the first comment to change the words remembered before it).
  await selectText(page, "This opening");
  await page.keyboard.press("ArrowLeft");
  await settle(page);
  const idOf = (f: string) => storedThreads(r).find((t) => t.messages[0].body === `Why ${f}?`)!.id;
  let ran = (await pauses.count()).ran;
  await page.keyboard.type("Truly, ");
  await pauses.ranSince(ran);
  const above = await sends();
  expect(above.length).toBeGreaterThan(0);
  expect([...new Set(above.flat())].sort()).toEqual(fruit.map(idOf).sort());
  expect(await changeSends()).toBe(0);

  // Typing over a comment's words: its quote changed, so it is told (and the comments it moved), not the
  // comments above it, which didn't move.
  const before = above.length;
  await selectText(page, "plums");
  ran = (await pauses.count()).ran;
  await page.keyboard.type("damsons");
  await pauses.ranSince(ran);
  await expect.poll(async () => (await sends()).length).toBeGreaterThan(before);
  const told = (await sends()).slice(before).flat();
  expect(told).toContain(idOf("plums"));
  expect(told).not.toContain(idOf("apples"));
  const plums = idOf("plums");
  await expect.poll(() => storedThreads(r).find((t) => t.id === plums)?.anchor?.quote).toBe("damsons");
});

test("History opened and closed in the same moment, ten times, then the document closed, leaves no timer running", async () => {
  const r = await start(DOC);
  const { page } = r;
  // From here, keep count of the repeating timers the window starts and stops: the second document's
  // Comments panel starts its clock as it opens.
  await page.evaluate(() => {
    const live = new Set<unknown>();
    (window as unknown as { liveTimers: Set<unknown> }).liveTimers = live;
    const start = window.setInterval.bind(window);
    const stop = window.clearInterval.bind(window);
    window.setInterval = ((...a: Parameters<typeof window.setInterval>) => {
      const id = start(...a);
      live.add(id);
      return id;
    }) as typeof window.setInterval;
    window.clearInterval = ((id?: number) => (live.delete(id), stop(id))) as typeof window.clearInterval;
  });
  const liveTimers = () => page.evaluate(() => (window as unknown as { liveTimers: Set<unknown> }).liveTimers.size);
  await openAlso(r, "second.md", "# Second\n\nA few words.\n");
  await expect(page.locator(".tab")).toHaveCount(2);
  await expect(page.locator(EDITOR)).toContainText("A few words.");
  expect(await liveTimers()).toBe(1); // the Comments panel's clock
  const pressTwice = () =>
    historyButton(page).evaluate((b: HTMLButtonElement) => {
      b.click();
      b.click();
    });
  for (let i = 0; i < 10; i++) {
    await pressTwice();
    await page.waitForTimeout(60); // the save and the list come back
  }
  await expect(page.locator(HISTORY_PANEL)).toBeHidden();
  // History pressed and the document closed in the same moment.
  await historyButton(page).evaluate((b: HTMLButtonElement) => {
    b.click();
    document.querySelector<HTMLElement>(".tab[aria-selected='true'] .tab-close")!.click();
  });
  await expect(page.locator(".tab")).toHaveCount(1);
  await page.waitForTimeout(300);
  // The closed document's Comments panel stopped its clock too, so nothing it started is left.
  expect(await liveTimers()).toBe(0);
});

test("closing a document with Close Anyway while the @ list is open in its comment takes the list away too", async () => {
  const r = await start(DOC);
  const { page } = r;
  await openAlso(r, "second.md", "# Second\n\nA few words.\n");
  await expect(page.locator(".tab")).toHaveCount(2);
  await expect(page.locator(EDITOR)).toContainText("A few words.");
  await selectText(page, "few words");
  await commentButton(page).click();
  await newBox(page).pressSequentially("Ask @");
  await expect(page.locator("#mention-list")).toBeVisible();
  await answerNext(r, 1); // Close Anyway
  await r.app.evaluate(({ Menu }) => Menu.getApplicationMenu()?.getMenuItemById("close-tab")?.click());
  await expect(page.locator(".tab")).toHaveCount(1);
  await expect(page.locator(EDITOR)).toContainText("We need two people");
  await page.waitForTimeout(200);
  expect(await asked(r)).toHaveLength(1);
  await expect(page.locator("#mention-list")).toBeHidden();
});

test("Command-Return pressed twice before Corillo answers sends a reply once, and saves an edit once", async () => {
  const r = await start(DOC);
  const { page } = r;
  await comment(page, "two people", "Is two enough?");
  // Count what reaches the app.
  await r.app.evaluate(({ ipcMain }) => {
    const g = globalThis as { calls?: Record<string, number> };
    g.calls = {};
    const handlers = (ipcMain as unknown as { _invokeHandlers: Map<string, (...a: unknown[]) => unknown> })._invokeHandlers;
    for (const channel of ["comments:reply", "comments:edit"]) {
      const real = handlers.get(channel)!;
      handlers.set(channel, (...a: unknown[]) => ((g.calls![channel] = (g.calls![channel] ?? 0) + 1), real(...a)));
    }
  });
  const calls = () => r.app.evaluate(() => (globalThis as { calls?: Record<string, number> }).calls ?? {});
  const pressTwice = (box: Locator) =>
    box.evaluate((b) => {
      for (let i = 0; i < 2; i++) b.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", metaKey: true, bubbles: true, cancelable: true }));
    });

  const posted = card(page, "Is two enough?");
  await posted.locator(".comment-body").click();
  const reply = posted.getByRole("textbox", { name: "Reply" });
  await reply.fill("Three would be safer.");
  await pressTwice(reply);
  await expect(posted.locator(".comment-message")).toHaveCount(2);
  await page.waitForTimeout(300);
  expect((await calls())["comments:reply"]).toBe(1);
  await expect.poll(() => storedThreads(r)[0]?.messages.length).toBe(2);

  await messageAction(posted.locator(".comment-message", { hasText: "Three would be safer." }), "Edit");
  const edit = posted.getByRole("textbox", { name: "Edit comment" });
  await edit.fill("Three would be safer, or four.");
  await pressTwice(edit);
  await expect(posted).toContainText("Three would be safer, or four.");
  await page.waitForTimeout(300);
  expect((await calls())["comments:edit"]).toBe(1);
});

test("a screen reader hears Claude is done: the line's words arrive in a status region already on the page", async () => {
  const r = await start(DOC);
  const { page } = r;
  // Before the pass ends, mark every status region a screen reader is already following in the document.
  await expect(page.locator(EDITOR)).toContainText("two people");
  await page.evaluate(() => {
    for (const s of document.querySelectorAll<HTMLElement>(".doc:not([hidden]) [role='status']")) {
      if (s.checkVisibility() || (!s.closest("[hidden], [aria-hidden='true']") && getComputedStyle(s).display !== "none")) s.dataset.followed = "yes";
    }
  });
  await sendToWindow(r, "agent:pass-ended", { agent: "Claude", answered: 0, other: true, endedBy: "agent" });
  await expect(page.locator(".doc:not([hidden]) .pass-notice")).toContainText("Claude is done");
  await expect(page.locator(".doc:not([hidden]) [role='status'][data-followed='yes']", { hasText: "Claude is done" })).toHaveCount(1);
});

test("each card is named for a screen reader by who wrote it, its words and whose turn it is", async () => {
  const r = await start(DOC);
  const { page } = r;
  await comment(page, "two people", "Is two enough?");
  const posted = card(page, "Is two enough?");
  await expect(posted).toHaveAccessibleName("Comment by You on “two people”, not sent to an agent yet");
  await sendToWindow(r, "agents:changed", [{ name: "Claude", isDefault: true, colour: "peach", editing: false }]);
  await expect(posted).toHaveAccessibleName("Comment by You on “two people”, for Claude, not sent yet");
  await expect(page.getByRole("article", { name: "Comment by You on “two people”, for Claude, not sent yet" })).toHaveCount(1);
});

test("Escape leaves a version from History's list too, not only from the page", async () => {
  const r = await start(DOC);
  const { page } = r;
  await page.locator(`${EDITOR} p`, { hasText: "budget" }).click();
  await page.keyboard.type(" Very.");
  await openHistory(page);
  await expect(page.locator(`${HISTORY_PANEL} .history-item`)).toHaveCount(2);
  await page.locator(`${HISTORY_PANEL} .history-item`).nth(1).click();
  const banner = page.locator(".doc:not([hidden]) .version-banner");
  await expect(banner).toBeVisible();
  await page.locator(`${HISTORY_PANEL} .history-item`).nth(1).focus();
  await page.keyboard.press("Escape");
  await expect(banner).toBeHidden();
  await expect(page.locator(HISTORY_PANEL)).toBeVisible();
});

test("Comment pressed on other words while a comment is being written says why the keyboard went back to it", async () => {
  const r = await start(DOC);
  const { page } = r;
  await selectText(page, "two people");
  await commentButton(page).click();
  await newBox(page).fill("Is two enough?");
  await selectText(page, "budget");
  await commentButton(page).click();
  await expect(page.locator(`${PANEL} .comments-note`)).toHaveText("Post or cancel this comment first.");
  await expect(newBox(page)).toBeFocused();
  await expect(newBox(page)).toHaveValue("Is two enough?");
  await expect(draft(page).locator(".comment-quote")).toHaveText("two people");
});

test("the panel's one-line message shows where the person is in the panel, without scrolling the cards away", async () => {
  const months = ["March", "April", "May", "June", "July", "August", "September", "October"];
  const r = await start(`# Plan\n\n${months.map((m) => `We meet in **${m}** for a long review of everything.`).join("\n\n")}\n`);
  const { page } = r;
  for (const m of months) await comment(page, m, `Why ${m}?`);
  await page.getByRole("button", { name: "Markdown", exact: true }).click();
  await expect(page.locator(SOURCE)).toBeVisible();
  const panel = page.locator(PANEL);
  await panel.evaluate((p) => (p.scrollTop = Math.round((p.scrollHeight - p.clientHeight) / 2)));
  await settle(page);
  expect(await panel.evaluate((p) => p.scrollTop)).toBeGreaterThan(40);
  const july = card(page, "Why July?");
  const top = () => july.evaluate((e) => e.getBoundingClientRect().top);
  const before = await top();
  // Only Markdown's marks selected: the panel says what to select instead.
  await page.locator(SOURCE).evaluate((area: HTMLTextAreaElement) => {
    const at = area.value.indexOf("**");
    area.focus();
    area.setSelectionRange(at, at + 2);
  });
  await settle(page);
  await commentButton(page).click();
  const note = page.locator(`${PANEL} .comments-note`);
  await expect(note).toHaveText("Select some words to comment on. Markdown's marks on their own can't hold a comment.");
  await settle(page);
  // In sight at the top of the panel, and the card stays where it was.
  const seen = await note.evaluate((n) => {
    const p = n.closest("aside")!.getBoundingClientRect();
    const b = n.getBoundingClientRect();
    return b.top >= p.top - 1 && b.bottom <= p.bottom + 1;
  });
  expect(seen).toBe(true);
  expect(Math.abs((await top()) - before)).toBeLessThan(1);
});

test("a comment being written on words an agent rewrites quotes the new words, as its highlight marks them", async () => {
  const r = await start(DOC);
  const { page } = r;
  await selectText(page, "two people");
  await commentButton(page).click();
  await newBox(page).fill("Is two enough?");
  writeFileSync(r.file, DOC.replace("two people", "three people"));
  await expect(page.locator(EDITOR)).toContainText("three people");
  await expect(page.locator(`${EDITOR} .comment-range.draft`)).toHaveText("three people");
  await expect(draft(page).locator(".comment-quote")).toHaveText("three people");
  await expect(newBox(page)).toHaveValue("Is two enough?");
});

test("a comment being written on words an agent holding the document rewrites, then edits next to, stays on the new words", async () => {
  const { AgentSession } = await import("./agent-session");
  const r = await start(DOC);
  const { page } = r;
  await selectText(page, "two people");
  await commentButton(page).click();
  await newBox(page).fill("Is two enough?");
  const { session } = await AgentSession.start(r.dataDir);
  try {
    await session.ok("take_document", { path: r.file });
    await session.ok("edit_document", { path: r.file, edits: [{ find: "two people", replace: "three people" }] });
    await expect(page.locator(EDITOR)).toContainText("three people");
    await expect(page.locator(`${EDITOR} .comment-range.draft`)).toHaveText("three people");
    await session.ok("edit_document", { path: r.file, edits: [{ find: "We need three", replace: "We will need three" }] });
    await expect(page.locator(EDITOR)).toContainText("We will need three people");
    await expect(page.locator(`${EDITOR} .comment-range.draft`)).toHaveText("three people");
    await session.ok("edit_document", { path: r.file, edits: [{ find: "this spring", replace: "by the end of this spring" }] });
    await expect(page.locator(EDITOR)).toContainText("people by the end");
    await expect(page.locator(`${EDITOR} .comment-range.draft`)).toHaveText("three people");
    await expect(draft(page).locator(".comment-quote")).toHaveText("three people");
    await expect(newBox(page)).toHaveValue("Is two enough?");
  } finally {
    await session.stop();
  }
});

test("a comment being written while an agent rewrites its words, then edits just before them, stays on the new words (R-TE-5)", async () => {
  const r = await start(DOC);
  const { page } = r;
  await selectText(page, "two people");
  await commentButton(page).click();
  await newBox(page).fill("Is two enough?");
  const { AgentSession } = await import("./agent-session");
  const { session } = await AgentSession.start(r.dataDir);
  try {
    await session.ok("take_document", { path: r.file });
    await session.ok("edit_document", { path: r.file, edits: [{ find: "two people", replace: "three people" }] });
    await expect(page.locator(EDITOR)).toContainText("three people");
    await expect(page.locator(`${EDITOR} .comment-range.draft`)).toHaveText("three people");
    // A second edit, just before the words: the draft is found from where it is now, not where it was at the take.
    await session.ok("edit_document", { path: r.file, edits: [{ find: "We need", replace: "We really need" }] });
    await expect(page.locator(EDITOR)).toContainText("We really need three people");
    await expect(page.locator(`${EDITOR} .comment-range.draft`)).toHaveText("three people");
    await expect(draft(page).locator(".comment-quote")).toHaveText("three people");
    await session.ok("finish_editing", { path: r.file });
    await expect(page.locator(`${EDITOR} .comment-range.draft`)).toHaveText("three people");
    await expect(newBox(page)).toHaveValue("Is two enough?");
  } finally {
    await session.stop();
  }
});

test("back from Show changes or a version, its page is let go of, and shown afresh next time", async () => {
  const r = await start(DOC);
  const { page } = r;
  const versionPage = page.locator(".doc:not([hidden]) .version-page");
  await page.locator(`${EDITOR} p`, { hasText: "budget" }).click();
  await page.keyboard.type(" Very.");
  await changesButton(page).click();
  await expect(versionPage).toBeVisible();
  await expect(versionPage).toContainText("Very.");
  await page.keyboard.press("Escape");
  await expect(versionPage).toBeHidden();
  // Not kept, hidden, as a second copy of the document.
  await expect(versionPage.locator("*")).toHaveCount(0);
  await changesButton(page).click();
  await expect(versionPage).toBeVisible();
  await expect(versionPage).toContainText("Very.");
  await expect(versionPage.locator(".ProseMirror")).toHaveCount(1);
});
