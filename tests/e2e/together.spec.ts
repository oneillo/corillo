// Where the parts meet: an agent working on a document while the person is in
// the middle of something of their own (the Markdown view, a comment draft,
// the link editor, an old version, another tab). A pretend agent tool speaks
// MCP to the real app, on throwaway documents and a throwaway data folder.
import { test, expect, type Page } from "@playwright/test";
import { execFileSync } from "node:child_process";
import { chmodSync, existsSync, mkdtempSync, readFileSync, symlinkSync, unlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { ONE_SCALE, openText, cursorAtEnd, settle, tabState, openAlso, clickMenu, listed, turnSaid, EDITOR, type Running, launch } from "./helpers";
import { AgentSession } from "./agent-session";

const PLAN = "# Plan\n\nWe should hire two people this quarter.\n\n## Budget\n\nThe budget is tight.\n";
const PANEL = ".doc:not([hidden]) aside.comments-panel";
const HISTORY = ".doc:not([hidden]) .history-panel";
const VERSION = ".doc:not([hidden]) .version-view .ProseMirror";

const sessions: AgentSession[] = [];
let run: Running | null = null;

async function start(text = PLAN, name = "plan.md"): Promise<Running> {
  run = await openText(text, { name });
  return run;
}

async function agent(client = "claude-code"): Promise<AgentSession> {
  const { session } = await AgentSession.start(run!.dataDir, client);
  sessions.push(session);
  return session;
}

test.afterEach(async () => {
  await run?.app.close().catch(() => undefined);
  // A Corillo an agent's connector started by itself.
  for (const s of sessions) {
    const pid = Number(/process (\d+)/.exec(s.stderr)?.[1]);
    if (pid) {
      try {
        process.kill(pid, "SIGTERM");
      } catch {
        // already gone
      }
    }
  }
  await Promise.all(sessions.splice(0).map((s) => s.stop()));
  run = null;
});

const notice = (page: Page) => page.locator(".doc:not([hidden]) .agent-notice");
const markdownBox = (page: Page) => page.getByRole("textbox", { name: "Markdown text" });

/** Select text in the formatted view, as if dragged over with the mouse. */
async function selectText(page: Page, wanted: string): Promise<void> {
  await page.evaluate(
    ([editor, text]) => {
      const root = document.querySelector<HTMLElement>(`${editor} .ProseMirror`)!;
      root.focus();
      const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT);
      for (let node = walker.nextNode(); node; node = walker.nextNode()) {
        const at = node.textContent!.indexOf(text);
        if (at < 0) continue;
        const range = document.createRange();
        range.setStart(node, at);
        range.setEnd(node, at + text.length);
        getSelection()!.removeAllRanges();
        getSelection()!.addRange(range);
        return;
      }
      throw new Error(`"${text}" isn't in the document`);
    },
    [EDITOR, wanted] as const,
  );
  await settle(page);
}

/** Select text, choose Comment, write the comment and post it. */
async function comment(page: Page, text: string, body: string): Promise<void> {
  await selectText(page, text);
  await page.getByRole("button", { name: "Comment", exact: true }).click();
  const box = page.getByRole("textbox", { name: "New comment" });
  await box.fill(body);
  await page.getByRole("button", { name: "Post" }).click();
  await expect(page.locator(`${PANEL} .comment-card:not(.draft)`, { hasText: body })).toBeVisible();
}

const commentId = (listing: string) => /\[([0-9a-f]{8,})\]/.exec(listing)![1];

// The person's own state ---------------------------------------------------------------

test("an agent taking the document while the person types in the Markdown view saves the typing first, then shows the agent's change there", async () => {
  const { page, file } = await start();
  const claude = await agent();
  await page.getByRole("button", { name: "Markdown" }).click();
  await markdownBox(page).press("Meta+ArrowDown");
  await page.keyboard.type("\nMy own line.\n");
  // Straight away, before autosave.
  const taken = await claude.ok("take_document", { path: file });
  expect(taken).toContain("My own line.");
  expect(readFileSync(file, "utf8")).toBe(PLAN + "\nMy own line.\n");
  await expect(notice(page)).toContainText("Claude is editing");

  // The person can't type in the Markdown view meanwhile.
  await markdownBox(page).press("Meta+ArrowDown");
  await page.keyboard.type("TYPED");
  await expect(markdownBox(page)).not.toHaveValue(/TYPED/);

  await claude.ok("edit_document", { path: file, edits: [{ find: "two people", replace: "three people" }] });
  await expect(markdownBox(page)).toHaveValue(PLAN.replace("two people", "three people") + "\nMy own line.\n");
  await expect(page.locator(".page.preview p", { hasText: "three people" })).toBeVisible();
  await claude.ok("finish_editing", { path: file });
  await expect(notice(page)).toBeHidden();

  // Back with the person: typing in the Markdown view works again and saves.
  await markdownBox(page).press("Meta+ArrowDown");
  await page.keyboard.type("Back to me.\n");
  await expect.poll(() => readFileSync(file, "utf8")).toBe(PLAN.replace("two people", "three people") + "\nMy own line.\nBack to me.\n");
});

test("undo in the Markdown view after an agent's pass never quietly brings back the text from before it", async () => {
  const { page, file } = await start();
  const claude = await agent();
  await page.getByRole("button", { name: "Markdown" }).click();
  await markdownBox(page).press("Meta+ArrowDown");
  await page.keyboard.type("\nMine.\n");
  await expect.poll(() => readFileSync(file, "utf8")).toBe(PLAN + "\nMine.\n");
  await claude.ok("take_document", { path: file });
  await claude.ok("edit_document", { path: file, edits: [{ find: "two people", replace: "three people" }] });
  await claude.ok("finish_editing", { path: file });
  await expect(notice(page)).toBeHidden();
  const agents = PLAN.replace("two people", "three people") + "\nMine.\n";
  await expect(markdownBox(page)).toHaveValue(agents);

  await markdownBox(page).focus();
  await page.keyboard.press("Meta+z");
  await page.keyboard.press("Meta+z");
  await page.waitForTimeout(700);
  // The agent's change is still there, on screen and in the file.
  await expect(markdownBox(page)).toHaveValue(/three people/);
  expect(readFileSync(file, "utf8")).toContain("three people");
});

test("undo in the formatted view after an agent's pass never quietly brings back the text from before it", async () => {
  const { page, file } = await start();
  const claude = await agent();
  await cursorAtEnd(page, "The budget is tight.");
  await page.keyboard.type(" Mine.");
  await expect.poll(() => readFileSync(file, "utf8")).toContain("tight. Mine.");
  await claude.ok("take_document", { path: file });
  await claude.ok("edit_document", { path: file, edits: [{ find: "two people", replace: "three people" }] });
  await claude.ok("finish_editing", { path: file });
  await expect(notice(page)).toBeHidden();
  await cursorAtEnd(page, "The budget is tight.");
  await page.keyboard.press("Meta+z");
  await page.keyboard.press("Meta+z");
  await page.waitForTimeout(700);
  await expect(page.locator(EDITOR)).toContainText("three people");
  expect(readFileSync(file, "utf8")).toContain("three people");
});

test("an agent editing while Show changes is on: the changes follow the newest version, and Hide changes shows the agent's text", async () => {
  const { page, file } = await start();
  const claude = await agent();
  await cursorAtEnd(page, "The budget is tight.");
  await page.keyboard.type(" Mine.");
  await expect.poll(() => readFileSync(file, "utf8")).toContain("tight. Mine.");
  await page.locator("#toolbar").getByRole("button", { name: "Show changes" }).click();
  await expect(page.locator(".doc:not([hidden]) .version-banner")).toContainText("You haven't handed this document to an agent yet");

  await claude.ok("take_document", { path: file });
  await expect(page.locator(".doc:not([hidden]) .version-banner")).toContainText("No one else has changed the text since you handed it over");
  await claude.ok("edit_document", { path: file, edits: [{ find: "two people", replace: "three people" }] });
  await expect(page.locator(`${VERSION} ins.diff-added`)).toHaveText("three");
  await expect(page.locator(".doc:not([hidden]) .version-banner")).toContainText("1 change by Claude since you handed it over");
  await claude.ok("finish_editing", { path: file });
  await page.getByRole("button", { name: "Hide changes" }).click();
  await expect(page.locator(EDITOR)).toContainText("hire three people");
  await cursorAtEnd(page, "The budget is tight.");
  await page.keyboard.type(" Again.");
  await expect.poll(() => readFileSync(file, "utf8")).toContain("tight. Mine. Again.");
  expect(readFileSync(file, "utf8")).toContain("three people");
});

test("while an agent edits, an old version can be looked at but not restored, and Restore works again once it's done", async () => {
  const { page, file } = await start();
  const claude = await agent();
  await cursorAtEnd(page, "The budget is tight.");
  await page.keyboard.type(" Mine.");
  await expect.poll(() => readFileSync(file, "utf8")).toContain("tight. Mine.");
  await page.getByRole("button", { name: "History", exact: true }).click();
  await page.locator(`${HISTORY} .history-item`).filter({ hasText: "First version" }).click();
  const restore = page.getByRole("button", { name: "Restore this version" });
  await expect(restore).toBeEnabled();

  await claude.ok("take_document", { path: file });
  await expect(restore).toBeDisabled();
  await claude.ok("edit_document", { path: file, edits: [{ find: "two people", replace: "three people" }] });
  await claude.ok("finish_editing", { path: file });
  await expect(restore).toBeEnabled();
  await restore.click();
  await expect.poll(() => readFileSync(file, "utf8")).toBe(PLAN);
});

test("text the person selected stays selected when an agent's edit arrives, so their comment goes on it", async () => {
  const { page, file } = await start();
  const claude = await agent();
  await claude.ok("take_document", { path: file });
  await selectText(page, "budget is tight");
  await claude.ok("edit_document", { path: file, edits: [{ find: "two people", replace: "three people" }] });
  await expect(page.locator(EDITOR)).toContainText("three people");
  await page.getByRole("button", { name: "Comment", exact: true }).click();
  await expect(page.locator(`${PANEL} .comment-card.draft .comment-quote`)).toHaveText("budget is tight");
  await page.getByRole("textbox", { name: "New comment" }).fill("By how much?");
  await page.getByRole("button", { name: "Post" }).click();
  await expect(page.locator(`${EDITOR} .comment-range`)).toHaveText("budget is tight");
});

test("the person's cursor stays where it was through an agent's pass, so typing afterwards goes there", async () => {
  const { page, file } = await start();
  const claude = await agent();
  await cursorAtEnd(page, "The budget is tight.");
  await claude.ok("take_document", { path: file });
  await claude.ok("edit_document", { path: file, edits: [{ find: "two people", replace: "three people" }] });
  await claude.ok("finish_editing", { path: file });
  await expect(notice(page)).toBeHidden();
  await page.keyboard.type(" Mine.");
  await expect.poll(() => readFileSync(file, "utf8")).toBe(PLAN.replace("two people", "three people").replace("tight.", "tight. Mine."));
});

test("a comment the person is writing survives an agent's edit, still on its words", async () => {
  const { page, file } = await start();
  const claude = await agent();
  await claude.ok("take_document", { path: file });
  await selectText(page, "budget is tight");
  await page.getByRole("button", { name: "Comment", exact: true }).click();
  const box = page.getByRole("textbox", { name: "New comment" });
  await box.pressSequentially("Say by how");
  await claude.ok("edit_document", { path: file, edits: [{ find: "two people", replace: "three people" }] });
  await expect(page.locator(EDITOR)).toContainText("three people");
  await expect(box).toBeFocused();
  await page.keyboard.type(" much");
  // The pass ending doesn't pull the keyboard away from the comment box either.
  await claude.ok("finish_editing", { path: file });
  await expect(notice(page)).toBeHidden();
  await expect(box).toBeFocused();
  await page.keyboard.type(".");
  await expect(box).toHaveValue("Say by how much.");
  await page.getByRole("button", { name: "Post" }).click();
  await expect(page.locator(`${EDITOR} .comment-range`)).toHaveText("budget is tight");
  expect(await claude.ok("list_comments", { path: file })).toContain('on "budget is tight"');
});

// R-AG-1 (2026-11-09 night, second review): a commented sentence the agent rewrote whole is the comment's new words, so
// its card still points at the answer; "has changed" is for words rewritten along with the paragraphs around them (unit tests).
test("an agent editing a commented paragraph: each comment stays on its words, or on the words that replaced them", async () => {
  const { page, file } = await start();
  await comment(page, "budget is tight", "By how much?");
  await comment(page, "hire two people", "Is two enough?");
  const claude = await agent();
  await claude.ok("take_document", { path: file });
  await claude.ok("edit_document", {
    path: file,
    edits: [
      { find: "The budget is tight.", replace: "This year the budget is tight, by about ten percent." },
      { find: "We should hire two people this quarter.", replace: "Hiring waits until next year." },
    ],
  });
  await expect(page.locator(EDITOR)).toContainText("Hiring waits");
  await expect(page.locator(`${EDITOR} .comment-range`)).toHaveText(["Hiring waits until next year", "budget is tight"]);
  await expect(page.locator(`${PANEL} .comment-card`, { hasText: "Is two enough?" })).not.toContainText(
    "The text this comment was on has changed",
  );
});

test("an agent taking the document closes the link editor, so the link can't land somewhere else once the text changes", async () => {
  const { page, file } = await start();
  const claude = await agent();
  await selectText(page, "budget");
  await page.keyboard.press("Meta+k");
  const editor = page.locator(".link-editor");
  await expect(editor.locator("input[name=href]")).toBeFocused();
  await editor.locator("input[name=href]").fill("https://example.com/budget");
  await claude.ok("take_document", { path: file });
  await expect(editor).toBeHidden();
  await claude.ok("edit_document", { path: file, edits: [{ find: "two people", replace: "three people" }] });
  await claude.ok("finish_editing", { path: file });
  await expect(notice(page)).toBeHidden();
  await page.keyboard.press("Enter");
  await page.waitForTimeout(700);
  expect(readFileSync(file, "utf8")).toBe(PLAN.replace("two people", "three people"));

  // Once it's back, a link goes where the person puts it.
  await cursorAtEnd(page, "The budget is tight.");
  await selectText(page, "budget");
  await page.keyboard.press("Meta+k");
  await editor.locator("input[name=href]").fill("https://example.com/budget");
  await page.keyboard.press("Enter");
  await expect.poll(() => readFileSync(file, "utf8")).toContain("The [budget](https://example.com/budget) is tight.");
});

test("a change from outside Corillo closes the link editor, so the link can't land somewhere else", async () => {
  const { page, file } = await start();
  await selectText(page, "budget");
  await page.keyboard.press("Meta+k");
  const editor = page.locator(".link-editor");
  await editor.locator("input[name=href]").fill("https://example.com/budget");
  writeFileSync(file, PLAN.replace("two people", "four people"));
  await expect(page.locator(EDITOR)).toContainText("four people");
  await expect(editor).toBeHidden();
  await page.keyboard.press("Enter");
  await page.waitForTimeout(700);
  expect(readFileSync(file, "utf8")).toBe(PLAN.replace("two people", "four people"));
});

test("an agent taking the document while table cells are selected: the cells can't be cleared, and the agent's change shows", async () => {
  const TABLE = "# Costs\n\n| Item | Cost |\n|------|------|\n| Desk | 200 |\n| Chair | 90 |\n";
  const { page, file } = await start(TABLE);
  const claude = await agent();
  const first = page.locator(`${EDITOR} td`, { hasText: "Desk" });
  const last = page.locator(`${EDITOR} td`, { hasText: "90" });
  await first.click();
  await settle(page);
  await last.click({ modifiers: ["Shift"] });
  await settle(page);
  await expect(page.locator(`${EDITOR} .selectedCell`)).toHaveCount(4);
  await claude.ok("take_document", { path: file });
  await page.keyboard.press("Backspace");
  await page.waitForTimeout(600);
  expect(readFileSync(file, "utf8")).toBe(TABLE);
  await claude.ok("edit_document", { path: file, edits: [{ find: "| Chair | 90 |", replace: "| Chair | 95 |" }] });
  await expect(page.locator(`${EDITOR} td`, { hasText: "95" })).toBeVisible();
  await claude.ok("finish_editing", { path: file });
  await expect(notice(page)).toBeHidden();
  await page.locator(`${EDITOR} td`, { hasText: "Desk" }).click();
  await settle(page);
  await page.keyboard.press("Meta+ArrowRight");
  await page.keyboard.type("s");
  await expect.poll(() => readFileSync(file, "utf8")).toMatch(/\| Desks \| 200 +\|\n\| Chair \| 95 +\|/);
});

// Two documents ------------------------------------------------------------------------

test("an agent working in a background tab never interrupts the person typing in theirs, and only its tab gets the dot", async () => {
  const { page, file: plan } = await start();
  const notes = await openAlso(run!, "notes.md", "My notes.\n");
  await expect.poll(() => tabState(page)).toEqual({ names: ["plan.md", "notes.md"], active: "notes.md" });
  const claude = await agent();
  await cursorAtEnd(page, "My notes.");
  const typing = page.keyboard.type(" I keep typing while the agent works on the plan.", { delay: 15 });
  await claude.ok("take_document", { path: plan });
  await claude.ok("edit_document", { path: plan, edits: [{ find: "two people", replace: "three people" }] });
  await claude.ok("read_document", { path: plan });
  await claude.ok("replace_document", { path: plan, text: PLAN.replace("two people", "four people") });
  await claude.ok("finish_editing", { path: plan });
  await typing;
  await expect.poll(() => readFileSync(notes, "utf8")).toBe("My notes. I keep typing while the agent works on the plan.\n");
  expect(readFileSync(plan, "utf8")).toBe(PLAN.replace("two people", "four people"));
  expect(await tabState(page)).toEqual({ names: ["plan.md", "notes.md"], active: "notes.md" });
  await expect(page.locator(`${EDITOR} .ProseMirror`)).toBeFocused();
  await expect(page.locator('.tab[title$="/plan.md"]').locator(".tab-dot")).toBeVisible();
  await expect(page.locator('.tab[title$="/notes.md"]').locator(".tab-dot")).toBeHidden();

  // Tab switching still works, and looking at the plan clears its dot.
  await page.keyboard.press("Meta+1");
  await expect.poll(() => tabState(page)).toEqual({ names: ["plan.md", "notes.md"], active: "plan.md" });
  await expect(page.locator(EDITOR)).toContainText("four people");
  await expect(page.locator('.tab[title$="/plan.md"]').locator(".tab-dot")).toBeHidden();
  await page.keyboard.press("Meta+2");
  await expect.poll(() => tabState(page)).toEqual({ names: ["plan.md", "notes.md"], active: "notes.md" });
  await page.keyboard.press("Meta+Shift+BracketLeft");
  await expect.poll(() => tabState(page)).toEqual({ names: ["plan.md", "notes.md"], active: "plan.md" });
});

// What the person can do while an agent holds the document ------------------------------------

test("closing a tab while an agent is editing it ends the agent's turn, keeps its changes, and tells the agent on its next call", async () => {
  const { page, file } = await start();
  const claude = await agent();
  await claude.ok("take_document", { path: file });
  await claude.ok("edit_document", { path: file, edits: [{ find: "two people", replace: "three people" }] });
  await clickMenu(run!.app, "close-tab");
  await expect.poll(() => tabState(page)).toEqual({ names: [], active: null });
  expect(readFileSync(file, "utf8")).toBe(PLAN.replace("two people", "three people"));

  const refused = await claude.call("edit_document", { path: file, edits: [{ find: "tight", replace: "loose" }] });
  expect(refused.isError).toBe(true);
  expect(refused.text).toContain("The person closed plan.md");
  expect(refused.text).toContain("your editing pass ended");
  // The closed document stays closed, and the agent's earlier change is kept.
  await page.waitForTimeout(300);
  expect(await tabState(page)).toEqual({ names: [], active: null });
  expect(readFileSync(file, "utf8")).toBe(PLAN.replace("two people", "three people"));

  // Looking at its comments doesn't bring the tab back either.
  expect((await claude.call("list_comments", { path: file })).text).toContain("stays closed until they ask for more");
  await page.waitForTimeout(300);
  expect(await tabState(page)).toEqual({ names: [], active: null });

  // If the person asks for more, the agent takes it again.
  expect(await claude.ok("take_document", { path: file })).toContain("You're editing plan.md now.");
});

test("quitting Corillo while an agent is editing ends its turn, keeps its changes, and the agent is told why on its next call", async () => {
  const { page, app, file, dataDir } = await start();
  await comment(page, "budget is tight", "By how much?");
  const claude = await agent();
  const taken = await claude.ok("take_document", { path: file });
  await claude.ok("edit_document", { path: file, edits: [{ find: "two people", replace: "three people" }] });
  await claude.ok("reply_to_comment", { path: file, comment_id: commentId(taken), text: "Ten percent." });
  await app.close();
  run = null;
  expect(readFileSync(file, "utf8")).toBe(PLAN.replace("two people", "three people"));
  const refused = await claude.call("edit_document", { path: file, edits: [{ find: "tight", replace: "loose" }] });
  expect(refused.isError).toBe(true);
  expect(refused.text).toContain("Corillo was closed");
  expect(refused.text).toContain("your editing pass ended");
  // An edit that can't happen doesn't start Corillo again.
  expect(claude.stderr).not.toContain("so it was started");
  expect(readFileSync(file, "utf8")).toBe(PLAN.replace("two people", "three people"));

  // Opened again, the history has the agent's pass with the comment it answered.
  const { app: again } = await launch({
    args: [ONE_SCALE, ".", file],
    env: { ...process.env, CORILLO_USER_DATA: dataDir, CORILLO_HIDDEN: "1", CORILLO_HOME: mkdtempSync(join(tmpdir(), "corillo-home-")) },
  });
  run = { app: again } as Running; // closed after the test
  const page2 = await again.firstWindow();
  await page2.waitForSelector(".ProseMirror");
  await page2.getByRole("button", { name: "History", exact: true }).click();
  const latest = page2.locator(`${HISTORY} .history-item`).first();
  await expect(latest.locator(".history-who")).toHaveText("Claude");
  await expect(latest.locator(".history-comment")).toHaveText("By how much?");
  await expect(latest.locator(".history-reply")).toHaveText("Ten percent.");
});

async function exportToWord(r: Running, name: string): Promise<string> {
  const out = join(r.folder, name);
  await r.app.evaluate(({ dialog }, chosen) => {
    dialog.showSaveDialog = (async () => ({ canceled: false, filePath: chosen })) as typeof dialog.showSaveDialog;
  }, out);
  await r.page.getByRole("button", { name: "Export", exact: true }).click();
  await r.page.getByRole("menu", { name: "Export" }).getByRole("menuitem", { name: "Export to Word" }).click();
  await expect(r.page.locator(".export-notice")).toContainText(`Exported to ${name}`, { timeout: 45_000 });
  return execFileSync("unzip", ["-p", out, "word/document.xml"]).toString("utf8");
}

test("Export while an agent is editing exports the text as it is so far, and the agent's turn carries on", async () => {
  test.setTimeout(90_000);
  const r = await start();
  const claude = await agent();
  await claude.ok("take_document", { path: r.file });
  await claude.ok("edit_document", { path: r.file, edits: [{ find: "two people", replace: "three people" }] });
  expect(await exportToWord(r, "plan.docx")).toContain("We should hire three people this quarter.");
  await expect(notice(r.page)).toContainText("Claude is editing");
  expect(await claude.ok("finish_editing", { path: r.file })).toContain("back with the person");
});

test("Export right after an agent's pass exports the agent's text", async () => {
  test.setTimeout(90_000);
  const r = await start();
  const claude = await agent();
  await claude.ok("take_document", { path: r.file });
  await claude.ok("edit_document", { path: r.file, edits: [{ find: "two people", replace: "three people" }] });
  await claude.ok("finish_editing", { path: r.file });
  expect(await exportToWord(r, "plan.docx")).toContain("We should hire three people this quarter.");
});

test("a change from another app while an agent is editing shows in the tab, and the agent's next edit builds on it", async () => {
  const { page, file } = await start();
  const claude = await agent();
  await claude.ok("take_document", { path: file });
  writeFileSync(file, PLAN.replace("The budget is tight.", "The budget is tight. Added in another app."));
  await expect(page.locator(EDITOR)).toContainText("Added in another app.");
  await expect(notice(page)).toContainText("Claude is editing");
  await claude.ok("edit_document", { path: file, edits: [{ find: "two people", replace: "three people" }] });
  await expect.poll(() => readFileSync(file, "utf8")).toBe(
    PLAN.replace("two people", "three people").replace("The budget is tight.", "The budget is tight. Added in another app."),
  );
  // Replacing the whole text from an old read is refused, so the outside change isn't lost.
  const stale = await claude.call("replace_document", { path: file, text: PLAN });
  expect(stale.isError).toBe(true);
  expect(readFileSync(file, "utf8")).toContain("Added in another app.");
  // Its change didn't go through, so finishing waits until it reads the text as it is (or makes the change).
  expect((await claude.call("finish_editing", { path: file })).text).toContain("Not finished: your last change to plan.md didn't go through");
  await claude.ok("read_document", { path: file });
  await claude.ok("finish_editing", { path: file });
});

test("a document deleted outside Corillo while an agent edits it isn't re-created by the agent's next change", async () => {
  const { page, app, file } = await start();
  const claude = await agent();
  await claude.ok("take_document", { path: file });
  unlinkSync(file);
  const banner = page.locator(".doc:not([hidden]) .banner.conflict");
  await expect(banner).toContainText("deleted outside Corillo");
  const refused = await claude.call("edit_document", { path: file, edits: [{ find: "two people", replace: "three people" }] });
  expect(refused.isError).toBe(true);
  expect(refused.text).toContain("plan.md was moved or deleted outside Corillo, so your change wasn't made");
  expect(existsSync(file)).toBe(false);
  await page.waitForTimeout(300);
  await expect(banner).toContainText("deleted outside Corillo");
  expect(await claude.ok("finish_editing", { path: file })).toContain("back with the person");
  // Closing asks what to do with the text; here the person chooses not to save it.
  await app.evaluate(({ dialog }) => {
    dialog.showMessageBox = (async (_w: unknown, options: { buttons: string[] }) => ({
      response: options.buttons.indexOf("Don't Save"),
      checkboxChecked: false,
    })) as unknown as typeof dialog.showMessageBox;
  });
});

test("a document deleted while an agent edits it can still be saved where it was, and closing it asks only once", async () => {
  const { page, app, file } = await start();
  const claude = await agent();
  await claude.ok("take_document", { path: file });
  unlinkSync(file);
  const banner = page.locator(".doc:not([hidden]) .banner.conflict");
  await expect(banner).toBeVisible();
  await expect(banner).toContainText("deleted outside Corillo");
  await page.getByRole("button", { name: "Save it where it was" }).click();
  await expect.poll(() => existsSync(file) && readFileSync(file, "utf8")).toBe(PLAN);
  await expect(banner).toBeHidden();
  // The agent carries on with it.
  await claude.ok("edit_document", { path: file, edits: [{ find: "two people", replace: "three people" }] });
  await expect.poll(() => readFileSync(file, "utf8")).toBe(PLAN.replace("two people", "three people"));
  // Deleted again, and the person closes it while the agent still holds it: one question, and the answer works.
  unlinkSync(file);
  await expect(banner).toBeVisible();
  await app.evaluate(({ dialog }) => {
    const g = globalThis as unknown as { asked: string[] };
    g.asked = [];
    dialog.showMessageBox = (async (_w: unknown, options: { message: string; buttons: string[] }) => {
      g.asked.push(options.message);
      return { response: options.buttons.indexOf("Save Where It Was"), checkboxChecked: false };
    }) as unknown as typeof dialog.showMessageBox;
  });
  await clickMenu(app, "close-tab");
  await expect.poll(async () => (await tabState(page)).names).toEqual([]);
  expect(await app.evaluate(() => (globalThis as unknown as { asked: string[] }).asked)).toEqual(["plan was moved or deleted outside Corillo."]);
  expect(readFileSync(file, "utf8")).toBe(PLAN.replace("two people", "three people"));
});

test("an agent's change to a locked file is refused in plain words, and nothing changes", async () => {
  const { file } = await start();
  const claude = await agent();
  await claude.ok("take_document", { path: file });
  chmodSync(file, 0o444);
  try {
    const refused = await claude.call("edit_document", { path: file, edits: [{ find: "two people", replace: "three people" }] });
    expect(refused.isError).toBe(true);
    expect(refused.text).toBe("Your change to plan.md couldn't be saved: the file is read-only or locked. Nothing was changed.");
    expect(readFileSync(file, "utf8")).toBe(PLAN);
  } finally {
    chmodSync(file, 0o644);
  }
  // Once it can be written again, the same change goes through.
  await claude.ok("edit_document", { path: file, edits: [{ find: "two people", replace: "three people" }] });
  expect(readFileSync(file, "utf8")).toBe(PLAN.replace("two people", "three people"));
});

test("an agent can take and edit a document it names by another path to the same file (a linked folder)", async () => {
  const { page, file } = await start();
  const linked = join(mkdtempSync(join(tmpdir(), "corillo-link-")), "Vault");
  symlinkSync(dirname(file), linked);
  const other = join(linked, "plan.md");
  const claude = await agent();
  await claude.ok("take_document", { path: other });
  await claude.ok("edit_document", { path: other, edits: [{ find: "two people", replace: "three people" }] });
  await claude.ok("finish_editing", { path: other });
  expect(readFileSync(file, "utf8")).toBe(PLAN.replace("two people", "three people"));
  expect((await tabState(page)).names).toEqual(["plan.md"]);
  await expect(page.locator(EDITOR)).toContainText("three people");
});

// History and comments --------------------------------------------------------------------

test("the History panel, open while an agent edits, shows its version with the comments it answered once it's done", async () => {
  const { page, file } = await start();
  await comment(page, "budget is tight", "By how much?");
  const claude = await agent();
  await page.getByRole("button", { name: "History", exact: true }).click();
  await expect(page.locator(`${HISTORY} .history-who`)).toHaveText(["First version"]);
  const taken = await claude.ok("take_document", { path: file });
  await claude.ok("edit_document", { path: file, edits: [{ find: "The budget is tight.", replace: "The budget is tight: ten percent less." }] });
  await expect(page.locator(`${HISTORY} .history-who`)).toHaveText(["Claude", "First version"]);
  await claude.ok("reply_to_comment", { path: file, comment_id: commentId(taken), text: "Added the ten percent." });
  await claude.ok("finish_editing", { path: file });
  const latest = page.locator(`${HISTORY} .history-item`).first();
  await expect(latest.locator(".history-comment")).toHaveText("By how much?");
  await expect(latest.locator(".history-reply")).toHaveText("Added the ten percent.");
  await latest.click();
  await expect(page.locator(`${VERSION} ins.diff-added`)).toContainText("ten percent less");
});

test("resolving a comment while the agent works on it: the agent is told plainly, and nothing else breaks", async () => {
  const { page, file } = await start();
  await comment(page, "budget is tight", "By how much?");
  const claude = await agent();
  const taken = await claude.ok("take_document", { path: file });
  await page.locator(`${PANEL} .comment-card`, { hasText: "By how much?" }).getByRole("button", { name: "Resolve" }).click();
  await expect(page.locator(`${PANEL} .comment-card`, { hasText: "By how much?" })).toBeHidden();
  const reply = await claude.call("reply_to_comment", { path: file, comment_id: commentId(taken), text: "Ten percent." });
  expect(reply.isError).toBe(true);
  expect(reply.text).toContain("The person has resolved that comment");
  expect(await claude.ok("finish_editing", { path: file })).toContain("back with the person");
  await expect(notice(page)).toBeHidden();
});

// Changed 2026-11-09: @ in the comment (Orlando's request) took the place of the To menu.
test("the @ list follows the agents: when the default agent's session ends, the next one to look becomes the default", async () => {
  const { page, file } = await start();
  const claude = await agent();
  await claude.ok("open_document", { path: file });
  const writer = await agent("writer-tool");
  await writer.ok("introduce", { name: "Writer" });
  await writer.ok("open_document", { path: file });
  await selectText(page, "budget is tight");
  await page.getByRole("button", { name: "Comment", exact: true }).click();
  await page.keyboard.type("@");
  await expect.poll(() => listed(page)).toEqual(["Claude, connected, default", "Writer, connected"]);
  await page.keyboard.press("Escape");
  await page.getByRole("button", { name: "Cancel" }).click();

  await claude.stop();
  sessions.splice(sessions.indexOf(claude), 1);
  await writer.ok("list_comments", { path: file });
  await selectText(page, "budget is tight");
  await page.getByRole("button", { name: "Comment", exact: true }).click();
  await page.keyboard.type("@");
  // Writer is the default now; Claude, who has left, is still offered, as not connected.
  await expect.poll(() => listed(page)).toEqual(["Writer, connected, default", "Claude, not connected"]);
  await page.keyboard.press("Escape");
  await page.getByRole("textbox", { name: "New comment" }).fill("For the writer.");
  await page.getByRole("button", { name: "Post" }).click();
  expect(await writer.ok("list_comments", { path: file })).toContain("For the writer.");
});

test("a comment directed at an agent that has gone waits for it; the default agent doesn't take it", async () => {
  const { page, file } = await start();
  const claude = await agent();
  await claude.ok("open_document", { path: file });
  const writer = await agent("writer-tool");
  await writer.ok("introduce", { name: "Writer" });
  await writer.ok("open_document", { path: file });
  await selectText(page, "budget is tight");
  await page.getByRole("button", { name: "Comment", exact: true }).click();
  await page.keyboard.type("@Wri");
  await page.keyboard.press("Enter");
  await page.keyboard.type("tighten this.");
  const box = page.getByRole("textbox", { name: "New comment" });
  await expect(box).toHaveValue("@Writer tighten this.");
  await writer.stop();
  sessions.splice(sessions.indexOf(writer), 1);
  await page.waitForTimeout(300);
  // The person's choice stays as they made it, even though Writer left while they typed: still a tag.
  await expect(page.locator(`${PANEL} .comment-card.draft .mention-layer .mention-tag`)).toHaveText("@Writer");
  await page.getByRole("button", { name: "Post" }).click();
  const card = page.locator(`${PANEL} .comment-card`, { hasText: "@Writer tighten this." });
  await expect(card).toContainText("To Writer");
  // It waits for Writer: a screen reader hears so in the card's name; the card shows no line for it (roadmap Batch 9, item 3).
  await expect(card).toHaveAttribute("aria-label", turnSaid("Waiting for Writer"));
  expect(await claude.ok("list_comments", { path: file })).not.toContain("tighten this.");
  // A new Writer session picks it up, and the note goes once it's on the document.
  const writerAgain = await agent("writer-tool");
  await writerAgain.ok("introduce", { name: "Writer" });
  await expect(card).toHaveAttribute("aria-label", turnSaid("Waiting for Writer"));
  expect(await writerAgain.ok("list_comments", { path: file })).toContain("Person (to you): @Writer tighten this.");
  await writerAgain.ok("read_document", { path: file });
  await expect(card).not.toHaveAttribute("aria-label", turnSaid("Waiting for Writer"));
});

test("closing the last tab while an agent is connected shows the start screen with recent documents, and the agent can still open one", async () => {
  const { page, file } = await start();
  const claude = await agent();
  await claude.ok("read_document", { path: file });
  await clickMenu(run!.app, "close-tab");
  await expect(page.locator("#empty")).toBeVisible();
  await expect(page.locator("#recent .recent-name")).toHaveText(["plan"]);
  await page.getByRole("button", { name: "Connect your agents" }).click();
  await expect(page.getByRole("dialog", { name: "Connect your agents" })).toBeVisible();
  await page.getByRole("button", { name: "Done" }).click();
  expect(await claude.ok("open_document", { path: file })).toContain("plan.md is open in Corillo");
  await expect.poll(() => tabState(page)).toEqual({ names: ["plan.md"], active: "plan.md" });
  await expect(page.locator("#empty")).toBeHidden();
});
