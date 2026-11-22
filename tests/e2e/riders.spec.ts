// What rides on the page follows an agent's change, or another app's, as it
// arrives as an edit (roadmap Batch 7, item 2): the person's Undo, the
// comments, Find's matches. Each test runs the real app, hidden, on
// throwaway documents and a throwaway data folder, with a pretend agent tool
// speaking MCP to it.
import { test, expect, type Page } from "@playwright/test";
import { readFileSync, rmSync, writeFileSync } from "node:fs";
import { clickMenu, cursorAtEnd, openText, selectText, settle, EDITOR, type Running } from "./helpers";
import { AgentSession } from "./agent-session";

const PLAN = "# Plan\n\nWe should hire two people this quarter.\n\n## Budget\n\nThe budget is tight.\n\n## Risks\n\nHiring takes long.\n";
const SOURCE = ".doc:not([hidden]) textarea.source";

const sessions: AgentSession[] = [];
let run: Running | null = null;

async function start(text = PLAN, name = "plan.md"): Promise<Running> {
  run = await openText(text, { name });
  return run;
}

test.afterEach(async () => {
  const r = run;
  run = null;
  const home = await r?.app.evaluate(() => process.env.CORILLO_HOME).catch(() => undefined);
  await r?.app.evaluate(({ app }) => setTimeout(() => app.exit(0), 10)).catch(() => undefined);
  await r?.app.close().catch(() => undefined);
  await Promise.all(sessions.splice(0).map((s) => s.stop()));
  for (const dir of [r?.folder, r?.dataDir, home]) if (dir) rmSync(dir, { recursive: true, force: true });
});

/** The change, made by an agent (one pass: take, edit, finish) or by another app saving the file. */
async function change(by: "agent" | "app", file: string, edits: { find: string; replace: string }[]): Promise<void> {
  if (by === "app") {
    let text = readFileSync(file, "utf8");
    for (const e of edits) text = text.replace(e.find, e.replace);
    writeFileSync(file, text);
    return;
  }
  const { session } = await AgentSession.start(run!.dataDir);
  sessions.push(session);
  await session.ok("take_document", { path: file });
  await session.ok("edit_document", { path: file, edits });
  await session.ok("finish_editing", { path: file });
}

const who = (by: "agent" | "app") => (by === "agent" ? "an agent's" : "another app's");
const pageText = (page: Page) => page.locator(`${EDITOR} .ProseMirror`).innerText();

// Undo --------------------------------------------------------------------------------------------

for (const by of ["agent", "app"] as const) {
  test(`after ${who(by)} change, Undo takes back the person's own typing from before it and leaves the change; Redo puts the typing back`, async () => {
    const { page, file } = await start();
    await cursorAtEnd(page, "The budget is tight.");
    await page.keyboard.type(" Mine.");
    await expect.poll(() => readFileSync(file, "utf8")).toContain("tight. Mine.");
    await change(by, file, [{ find: "two people", replace: "three people" }]);
    await expect(page.locator(EDITOR)).toContainText("three people");
    await settle(page);
    await cursorAtEnd(page, "Hiring takes long.");
    await page.keyboard.press("Meta+z");
    await expect(page.locator(EDITOR)).not.toContainText("Mine.");
    await expect(page.locator(EDITOR)).toContainText("three people");
    await expect.poll(() => readFileSync(file, "utf8")).toBe(PLAN.replace("two people", "three people"));
    await page.keyboard.press("Shift+Meta+z");
    await expect(page.locator(EDITOR)).toContainText("tight. Mine.");
    await expect.poll(() => readFileSync(file, "utf8")).toBe(PLAN.replace("two people", "three people").replace("tight.", "tight. Mine."));
  });
}

test("Undo stops at the person's edit whose words an agent rewrote: the agent's words stay, and the old ones never come back", async () => {
  const { page, file } = await start();
  await cursorAtEnd(page, "The budget is tight.");
  await page.keyboard.type(" Mine.");
  await expect.poll(() => readFileSync(file, "utf8")).toContain("tight. Mine.");
  await page.waitForTimeout(600); // a step of its own for Undo
  await cursorAtEnd(page, "Hiring takes long.");
  await page.keyboard.type(" More.");
  await expect.poll(() => readFileSync(file, "utf8")).toContain("long. More.");
  await change("agent", file, [{ find: "The budget is tight. Mine.", replace: "The budget is set, so we wait." }]);
  await expect(page.locator(EDITOR)).toContainText("so we wait.");
  await settle(page);
  await cursorAtEnd(page, "Hiring takes long.");
  // The typing the agent didn't touch is taken back; then Undo stops.
  await page.keyboard.press("Meta+z");
  await expect(page.locator(EDITOR)).not.toContainText("More.");
  await page.keyboard.press("Meta+z");
  await page.keyboard.press("Meta+z");
  await page.waitForTimeout(700);
  const after = PLAN.replace("The budget is tight.", "The budget is set, so we wait.");
  expect(await pageText(page)).toContain("The budget is set, so we wait.");
  expect(await pageText(page)).not.toContain("tight");
  await expect.poll(() => readFileSync(file, "utf8")).toBe(after);
});

test("in the Markdown view the text's own Undo starts afresh after an agent's change; back on the page, Undo takes back the Markdown typing from before it", async () => {
  const { page, file } = await start();
  await page.getByRole("button", { name: "Markdown" }).click();
  const area = page.locator(SOURCE);
  await area.press("Meta+ArrowDown");
  await page.keyboard.type("\nMine.\n");
  await expect.poll(() => readFileSync(file, "utf8")).toBe(PLAN + "\nMine.\n");
  await change("agent", file, [{ find: "two people", replace: "three people" }]);
  const both = PLAN.replace("two people", "three people") + "\nMine.\n";
  await expect(area).toHaveValue(both);
  await area.focus();
  await page.keyboard.press("Meta+z");
  await page.waitForTimeout(700);
  await expect(area).toHaveValue(both);
  await page.getByRole("button", { name: "Formatted" }).click();
  await settle(page);
  await page.keyboard.press("Meta+z");
  await expect(page.locator(EDITOR)).not.toContainText("Mine.");
  await expect(page.locator(EDITOR)).toContainText("three people");
  await expect.poll(() => readFileSync(file, "utf8")).toBe(PLAN.replace("two people", "three people"));
});

// An option the person chose, then a change by someone else elsewhere, then Undo of the choice: the comment on the words the option
// rewrote goes back on its words, as Undo straight after the choice does (roadmap Batch 6), never onto a letter the versions share.
const ASKED = "# Plan\n\nWe should hire two people this quarter.\n\nThe budget is tight.\n";
const BEST = ASKED.replace("two people", "three people");
const SHORTER = BEST.replace("We should hire three people this quarter.", "Hire three this quarter.");
const PANEL = ".doc:not([hidden]) aside.comments-panel";
const card = (page: Page) => page.locator(`${PANEL} .comment-card:not(.draft)`, { hasText: "Three, and is it too wordy?" });

async function commentOn(page: Page, expected: string): Promise<void> {
  await settle(page);
  await expect(card(page)).not.toHaveClass(/gapped|detached/);
  await card(page).click();
  await expect.poll(async () => (await page.locator(`${EDITOR} .comment-range.active`).allTextContents()).join("")).toBe(expected);
}

for (const by of ["agent", "app"] as const) {
  test(`Undo of an option chosen before ${who(by)} change puts the comment back on its words, and Redo on the words that took their place`, async () => {
    const { page, file } = await start(ASKED);
    await selectText(page, "two people");
    await page.getByRole("button", { name: "Comment", exact: true }).click();
    await page.getByRole("textbox", { name: "New comment" }).fill("Three, and is it too wordy?");
    await page.getByRole("button", { name: "Post" }).click();
    await expect(card(page)).toBeVisible();
    const { session: claude } = await AgentSession.start(run!.dataDir, "claude-code");
    sessions.push(claude);
    const taken = await claude.ok("take_document", { path: file });
    const id = /\[([0-9a-f]+)\] on /.exec(taken)![1];
    await claude.ok("edit_document", { path: file, edits: [{ find: "hire two people", replace: "hire three people" }], comment_ids: [id] });
    const shorter = { label: "Shorter", edits: [{ find: "We should hire three people this quarter.", replace: "Hire three this quarter." }] };
    await claude.ok("reply_to_comment", { path: file, comment_id: id, text: "Made it three. Shorter?", options: [shorter] });
    await claude.ok("finish_editing", { path: file });
    await expect.poll(() => readFileSync(file, "utf8")).toBe(BEST);
    await commentOn(page, "three people");
    await page.locator(`${PANEL} .comment-option`, { hasText: "Shorter" }).click();
    await expect.poll(() => readFileSync(file, "utf8")).toBe(SHORTER);
    await commentOn(page, "three");
    await change(by, file, [{ find: "The budget is tight.", replace: "The budget is set." }]);
    await expect(page.locator(EDITOR)).toContainText("The budget is set.");
    await cursorAtEnd(page, "The budget is set.");
    await page.keyboard.press("Meta+z");
    await expect.poll(() => readFileSync(file, "utf8")).toBe(BEST.replace("tight", "set"));
    await commentOn(page, "three people");
    await cursorAtEnd(page, "The budget is set.");
    await page.keyboard.press("Meta+Shift+z");
    await expect.poll(() => readFileSync(file, "utf8")).toBe(SHORTER.replace("tight", "set"));
    await commentOn(page, "three");
  });
}

// Find ---------------------------------------------------------------------------------------------

const COUNT = ".find-count";

for (const by of ["agent", "app"] as const) {
  test(`Find's matches follow ${who(by)} change on the page: on their words, counted again`, async () => {
    const { page, file } = await start();
    await cursorAtEnd(page, "Plan", "h1");
    await page.keyboard.press("Meta+F");
    await page.getByRole("textbox", { name: "Find", exact: true }).fill("budget");
    await expect(page.locator(COUNT)).toHaveText("1 of 2");
    await change(by, file, [
      { find: "We should hire", replace: "Within budget, we should hire" },
      { find: "The budget is tight.", replace: "The budget is tight, the budget says." },
    ]);
    await expect(page.locator(EDITOR)).toContainText("Within budget");
    await expect(page.locator(COUNT)).toHaveText(/ 4$|^4 matches$/);
    await expect(page.locator(`${EDITOR} .find-match`)).toHaveText(["budget", "Budget", "budget", "budget"]);
  });

  test(`in the Markdown view, Find's matches are on their words as soon as ${who(by)} change shows, then counted again`, async () => {
    const { page, file } = await start();
    await page.getByRole("button", { name: "Markdown" }).click();
    const area = page.locator(SOURCE);
    await area.click();
    await area.press("Meta+ArrowUp");
    await settle(page);
    await page.keyboard.press("Meta+F");
    await page.getByRole("textbox", { name: "Find", exact: true }).fill("budget");
    await expect(page.locator(COUNT)).toHaveText("1 of 2");
    // The marks are drawn on a layer holding the same text as the Markdown text: the same, from the moment it shows.
    const same = page.evaluate((selector) => {
      const textarea = document.querySelector<HTMLTextAreaElement>(selector)!;
      const layer = textarea.parentElement!.querySelector<HTMLElement>(".find-marks")!;
      return new Promise<boolean>((resolve) => {
        const look = () => (textarea.value.includes("Within budget") ? resolve(layer.textContent === textarea.value + " ") : requestAnimationFrame(look));
        look();
      });
    }, SOURCE);
    await change(by, file, [
      { find: "We should hire", replace: "Within budget, we should hire" },
      { find: "The budget is tight.", replace: "The budget is tight, the budget says." },
    ]);
    expect(await same).toBe(true);
    const marks = page.locator(".doc:not([hidden]) .find-marks mark");
    await expect(marks).toHaveText(["budget", "Budget", "budget", "budget"]);
    await expect(page.locator(COUNT)).toHaveText(/ 4$|^4 matches$/);
  });
}

// Line numbers -------------------------------------------------------------------------------------

test("in the Markdown view, the line numbers follow an agent's change: a line for each line of the text, from the moment it shows", async () => {
  const run = await start();
  const { page, file } = run;
  await clickMenu(run.app, "line-numbers");
  await page.getByRole("button", { name: "Markdown" }).click();
  await expect(page.locator(".doc:not([hidden]) .line-gutter")).toBeVisible();
  const level = page.evaluate((selector) => {
    const textarea = document.querySelector<HTMLTextAreaElement>(selector)!;
    const rows = textarea.parentElement!.querySelector<HTMLElement>(".line-mirror")!;
    return new Promise<boolean>((resolve) => {
      const look = () =>
        textarea.value.includes("Two lines,")
          ? resolve([...rows.children].map((r) => r.textContent).join("\n") === textarea.value)
          : requestAnimationFrame(look);
      look();
    });
  }, SOURCE);
  await change("agent", file, [{ find: "# Plan\n", replace: "# Plan\n\nTwo lines,\nnot one.\n" }]);
  expect(await level).toBe(true);
});
