// While an agent holds a document, the person can't change the text but can
// still read it and comment on it (spec: "No collisions").
import { test, expect, type Page } from "@playwright/test";
import { chmodSync, rmSync } from "node:fs";
import { openText, settle, cursorAtEnd, EDITOR } from "./helpers";
import { AgentSession } from "./agent-session";

const PLAN = "# Plan\n\nWe should hire two people this quarter.\n\n## Budget\n\nThe budget is tight.\n";

async function selectText(page: Page, wanted: string): Promise<void> {
  await page.evaluate(
    ([editor, text]) => {
      const root = document.querySelector<HTMLElement>(`${editor} .ProseMirror`)!;
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

test("while an agent is editing, the person can still comment on the text, and the agent sees the comment", async () => {
  const run = await openText(PLAN, { name: "plan.md" });
  const { session: claude } = await AgentSession.start(run.dataDir, "claude-code");
  try {
    await claude.ok("take_document", { path: run.file });
    await expect(run.page.locator(".doc:not([hidden]) .agent-notice")).toContainText("Claude is editing");

    // The formatting buttons are greyed out, but Comment isn't.
    await expect(run.page.getByRole("button", { name: "Bold" })).toBeDisabled();
    const commentButton = run.page.getByRole("button", { name: "Comment", exact: true });
    await expect(commentButton).toBeEnabled();

    await selectText(run.page, "budget is tight");
    await commentButton.click();
    const box = run.page.getByRole("textbox", { name: "New comment" });
    await expect(box).toBeFocused();
    await box.fill("Say by how much.");
    await run.page.getByRole("button", { name: "Post" }).click();
    await expect(run.page.locator(`${EDITOR} .comment-range`)).toHaveText("budget is tight");

    // The text itself is unchanged, and the agent can pick the comment up in this pass.
    expect(run.text()).toBe(PLAN);
    expect(await claude.ok("list_comments", { path: run.file })).toContain("Say by how much.");
  } finally {
    await run.app.close();
    await claude.stop();
  }
});

test("a comment stays on its words when an agent changes them, even where the same words are elsewhere", async () => {
  const text = [
    "# Plan",
    "Our customers in the north region asked for faster delivery this year.",
    "The south region is different. There, customers care most about price.",
    "Finally, customers everywhere want clearer invoices.",
  ].join("\n\n") + "\n";
  const run = await openText(text, { name: "plan.md" });
  const { session: claude } = await AgentSession.start(run.dataDir, "claude-code");
  try {
    await selectText(run.page, "customers");
    await run.page.getByRole("button", { name: "Comment", exact: true }).click();
    await run.page.getByRole("textbox", { name: "New comment" }).fill("Call them clients.");
    await run.page.getByRole("button", { name: "Post" }).click();
    const mark = run.page.locator(`${EDITOR} .comment-range`);
    await expect(mark).toHaveText("customers");

    await claude.ok("take_document", { path: run.file });
    await claude.ok("edit_document", { path: run.file, edits: [{ find: "Our customers in", replace: "Our clients in" }] });
    await expect(run.page.locator(EDITOR)).toContainText("Our clients in");
    await expect(mark).toHaveText("clients");
    // On the first paragraph, where it was; not on the next "customers".
    expect(await mark.evaluate((el) => el.closest("p")?.textContent)).toContain("Our clients in the north");
    // The agent is told where the comment is now, too.
    expect(await claude.ok("list_comments", { path: run.file })).toContain('on "clients"');
  } finally {
    await run.app.close();
    await claude.stop();
  }
});

test("a comment follows an agent's edit by where its words are: on a word written three times, with the words before it changed too", async () => {
  // Searching for the comment's words after this edit finds the first "customers"; only where the edit put them says "our clients".
  // Corillo stores that place (follow-edits.ts, followEdit), and the window keeps it when it shows the agent's text.
  const text = "# Sales\n\nAsk customers first. Pay customers well. Thank customers often.\n\nThe budget is tight.\n";
  const run = await openText(text, { name: "sales.md" });
  const { session: claude } = await AgentSession.start(run.dataDir, "claude-code");
  try {
    await run.page.evaluate((editor) => {
      const node = document.querySelector(`${editor} .ProseMirror p`)!.firstChild!;
      const at = node.textContent!.indexOf("customers", node.textContent!.indexOf("customers") + 1);
      const range = document.createRange();
      range.setStart(node, at);
      range.setEnd(node, at + "customers".length);
      getSelection()!.removeAllRanges();
      getSelection()!.addRange(range);
    }, EDITOR);
    await settle(run.page);
    await run.page.getByRole("button", { name: "Comment", exact: true }).click();
    await run.page.getByRole("textbox", { name: "New comment" }).fill("Call them clients.");
    await run.page.getByRole("button", { name: "Post" }).click();
    const mark = run.page.locator(`${EDITOR} .comment-range`);
    await expect(mark).toHaveText("customers");
    // The paragraph's words before the mark (the card stays in focus through the agent's change, so the change's own
    // highlight may split them into pieces).
    const before = () =>
      mark.evaluate((el) => {
        const range = document.createRange();
        range.setStart(el.closest("p")!, 0);
        range.setEndBefore(el);
        return range.toString();
      });
    expect(await before()).toBe("Ask customers first. Pay ");

    const taken = await claude.ok("take_document", { path: run.file });
    const id = /\[([0-9a-f]+)\]/.exec(taken)![1];
    await claude.ok("edit_document", { path: run.file, edits: [{ find: "Pay customers well.", replace: "Reward our clients well." }], comment_ids: [id] });
    await expect(run.page.locator(EDITOR)).toContainText("Reward our clients well.");
    await expect(mark).toHaveText("our clients");
    expect(await before()).toBe("Ask customers first. Reward ");
    // Corillo keeps that place (the window doesn't put the old one back), and the agent is told it.
    await run.page.waitForTimeout(1000);
    expect(await claude.ok("list_comments", { path: run.file })).toContain(`[${id}] on "our clients" (line 3)`);
  } finally {
    await run.app.close();
    await claude.stop();
    rmSync(run.folder, { recursive: true, force: true });
    rmSync(run.dataDir, { recursive: true, force: true });
  }
});

test("while an agent is editing, Option-Command-M starts a comment on the whole document", async () => {
  const run = await openText(PLAN, { name: "plan.md" });
  const { session: claude } = await AgentSession.start(run.dataDir, "claude-code");
  try {
    await claude.ok("take_document", { path: run.file });
    await expect(run.page.locator(".doc:not([hidden]) .agent-notice")).toContainText("Claude is editing");
    await run.page.locator(`${EDITOR} p`).first().click();
    await settle(run.page);
    await run.page.keyboard.press("Meta+Alt+m");
    await expect(run.page.getByRole("textbox", { name: "New comment" })).toBeFocused();
  } finally {
    await run.app.close();
    await claude.stop();
  }
});

test("an agent can't take a document while the person's latest edits can't be saved, and is told why", async () => {
  const run = await openText(PLAN, { name: "plan.md" });
  const { session: claude } = await AgentSession.start(run.dataDir, "claude-code");
  try {
    chmodSync(run.file, 0o444); // locked in Finder, say
    await cursorAtEnd(run.page, "The budget is tight.");
    await run.page.keyboard.type(" Very tight.");
    await expect(run.page.locator("#save-status")).toContainText("Not saved");
    const taken = await claude.call("take_document", { path: run.file });
    expect(taken.isError).toBe(true);
    expect(taken.text).toContain("can't save plan.md right now");
    // The person's words are still there and still theirs to edit.
    await expect(run.page.locator(EDITOR)).toContainText("Very tight.");
    await expect(run.page.locator(".doc:not([hidden]) .agent-notice")).toBeHidden();
  } finally {
    chmodSync(run.file, 0o644);
    await run.app.close();
    await claude.stop();
  }
});
