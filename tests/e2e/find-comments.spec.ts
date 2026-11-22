// Find reaches the comments (roadmap Batch 4, item 2, L-9): the bar counts
// the matches in the cards too ("3 of 12 · 2 in comments"), and Return goes
// on from the last match in the text into the cards, then round to the text.
// Resolved comments are found too. Replace never changes a comment.
import { test, expect, type Page } from "@playwright/test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openText, expectFile, cursorAtEnd, selectText, settle, EDITOR, type Running } from "./helpers";
import { longSession } from "../fixtures/long-history";

const PANEL = ".doc:not([hidden]) .comments-panel";
const count = (page: Page) => page.locator(".find-count");
const findField = (page: Page) => page.getByRole("textbox", { name: "Find", exact: true });
const card = (page: Page, text: string) => page.locator(`${PANEL} .comment-card:not(.draft)`, { hasText: text });

async function comment(run: Running, words: string, body: string): Promise<void> {
  await selectText(run.page, words);
  await run.page.getByRole("button", { name: "Comment", exact: true }).click();
  await run.page.getByRole("textbox", { name: "New comment" }).fill(body);
  await run.page.getByRole("button", { name: "Post" }).click();
  await expect(card(run.page, body)).toBeVisible();
}

/** The words Find marks in the cards, the current one first, and the card that holds the current one. */
function marked(page: Page) {
  return page.evaluate(() => {
    const words = (name: string) => [...(CSS.highlights.get(name)?.values() ?? [])].map((r) => (r as Range).toString());
    const current = [...(CSS.highlights.get("find-comment-current")?.values() ?? [])][0] as Range | undefined;
    const holder = current?.startContainer.parentElement?.closest<HTMLElement>(".comment-card");
    return { current: words("find-comment-current"), others: words("find-comment"), card: holder?.querySelector(".comment-body")?.textContent ?? null };
  });
}

const DOC = "# Pets\n\nThe cat sat on the mat. A dog ran past.\n";

async function petsWithComments(): Promise<Running> {
  const run = await openText(DOC);
  await comment(run, "sat on the mat", "No cat sat here, it was a fox.");
  await comment(run, "dog", "Is the dog really a cat?");
  // The first one resolved: its card is hidden.
  await card(run.page, "No cat sat here").getByRole("button", { name: "Resolve", exact: true }).click();
  await expect(card(run.page, "No cat sat here")).toHaveCount(0);
  await cursorAtEnd(run.page, "Pets", "h1");
  return run;
}

test("the bar counts matches in the comments too, and Return goes on from the last in the text into the cards, a resolved one shown while it's on it, then round to the text", async () => {
  const run = await petsWithComments();
  const { page } = run;
  await page.keyboard.press("Meta+F");
  await findField(page).fill("cat");
  await expect(count(page)).toHaveText("1 of 1 · 2 in comments");
  await expect(page.locator(`${EDITOR} .find-match.current`)).toHaveText("cat");

  // Past the last match in the text: the cards, in the order the panel lists them (the resolved one's words come first).
  await findField(page).press("Enter");
  await expect(count(page)).toHaveText("1 in the text · 1 of 2 in comments");
  await expect(card(page, "No cat sat here")).toBeVisible();
  await expect(card(page, "No cat sat here")).toHaveClass(/active/);
  expect(await marked(page)).toEqual({ current: ["cat"], others: ["cat"], card: "No cat sat here, it was a fox." });
  await expect(page.locator(`${EDITOR} .find-match.current`)).toHaveCount(0);
  // The keyboard stays in the bar.
  await expect(findField(page)).toBeFocused();

  await findField(page).press("Enter");
  await expect(count(page)).toHaveText("1 in the text · 2 of 2 in comments");
  expect((await marked(page)).card).toBe("Is the dog really a cat?");
  // Find moved off the resolved comment: its card is hidden again.
  await expect(card(page, "No cat sat here")).toHaveCount(0);

  // Round to the text.
  await findField(page).press("Enter");
  await expect(count(page)).toHaveText("1 of 1 · 2 in comments");
  await expect(page.locator(`${EDITOR} .find-match.current`)).toHaveText("cat");
  expect((await marked(page)).current).toEqual([]);

  // Backwards from the text: the last match in the cards.
  await findField(page).press("Shift+Enter");
  await expect(count(page)).toHaveText("1 in the text · 2 of 2 in comments");

  // Closed on a card's match: the keyboard rests on that card, as Next Comment leaves it, and Escape goes back to the document.
  await findField(page).press("Escape");
  await expect(page.getByRole("search", { name: "Find in document" })).toBeHidden();
  await expect(card(page, "Is the dog really a cat?")).toBeFocused();
  expect((await marked(page)).current).toEqual([]);
  await page.keyboard.press("Escape");
  await expect(page.locator(`${EDITOR} .ProseMirror`)).toBeFocused();
  await run.app.close();
});

test("a word only in the comments: the bar says so, and Return goes to it", async () => {
  const run = await petsWithComments();
  const { page } = run;
  await page.keyboard.press("Meta+F");
  await findField(page).fill("fox");
  await expect(count(page)).toHaveText("No matches in the text · 1 in comments");
  await expect(count(page)).not.toHaveClass(/none/);
  await findField(page).press("Enter");
  await expect(count(page)).toHaveText("No matches in the text · 1 of 1 in comments");
  await expect(card(page, "No cat sat here")).toBeVisible();
  // Closed on a resolved comment's match: its card stays while the keyboard rests on it, and goes once it moves on.
  await findField(page).press("Escape");
  await expect(card(page, "No cat sat here")).toBeFocused();
  await page.keyboard.press("Escape");
  await expect(card(page, "No cat sat here")).toHaveCount(0);
  // Nowhere at all.
  await page.keyboard.press("Meta+F");
  await findField(page).fill("zebra");
  await expect(count(page)).toHaveText("No matches");
  await expect(count(page)).toHaveClass(/none/);
  await run.app.close();
});

test("Replace and Replace All change the text only, never a comment, and the bar says so", async () => {
  const run = await petsWithComments();
  const { page } = run;
  await page.keyboard.press("Meta+Alt+F");
  await findField(page).fill("cat");
  await page.getByRole("textbox", { name: "Replace with" }).fill("bird");
  await page.getByRole("button", { name: "Replace all" }).click();
  await expect(count(page)).toHaveText("Replaced 1 (not in comments)");
  await expectFile(run, DOC.replace("cat", "bird"));
  await expect(card(page, "Is the dog really a cat?")).toBeVisible();
  // Replace on a match in a card: it goes to the next match in the text instead (none here), changing no comment.
  await findField(page).fill("cat");
  await expect(count(page)).toHaveText("No matches in the text · 2 in comments");
  await findField(page).press("Enter");
  await page.getByRole("button", { name: "Replace", exact: true }).click();
  await expect(card(page, "Is the dog really a cat?")).toBeVisible();
  await expectFile(run, DOC.replace("cat", "bird"));
  await run.app.close();
});

test("with History open, going to a match in a card gives the Comments column its place back", async () => {
  const run = await petsWithComments();
  const { page } = run;
  await page.getByRole("button", { name: "History", exact: true }).click();
  await expect(page.locator(".doc:not([hidden]) .history-panel")).toBeVisible();
  await expect(page.locator(PANEL)).toBeHidden();
  await page.keyboard.press("Meta+F");
  await findField(page).fill("dog really");
  await expect(count(page)).toHaveText("No matches in the text · 1 in comments");
  await findField(page).press("Enter");
  await expect(page.locator(".doc:not([hidden]) .history-panel")).toBeHidden();
  await expect(card(page, "Is the dog really a cat?")).toBeVisible();
  expect((await marked(page)).current).toEqual(["dog really"]);
  await run.app.close();
});

test("a word in the Markdown view's text and in a comment: the same count, the same way into the cards", async () => {
  const run = await petsWithComments();
  const { page } = run;
  await page.getByRole("button", { name: "Markdown", exact: true }).click();
  await expect(page.locator(".doc:not([hidden]) textarea.source")).toBeVisible();
  await page.locator(".doc:not([hidden]) textarea.source").click();
  await settle(page);
  await page.keyboard.press("Meta+ArrowUp");
  await page.keyboard.press("Meta+F");
  await findField(page).fill("cat");
  await expect(count(page)).toHaveText("1 of 1 · 2 in comments");
  await findField(page).press("Enter");
  await expect(count(page)).toHaveText("1 in the text · 1 of 2 in comments");
  await run.app.close();
});

test("typing in the find bar stays quick on a long history's document with about 200 comments, most of them resolved", async () => {
  test.setTimeout(120_000);
  const dataDir = mkdtempSync(join(tmpdir(), "corillo-data-"));
  const run = await openText("", { name: "plan.md", dataDir, prepare: (folder) => longSession({ data: dataDir, file: join(folder, "plan.md") }) });
  const { page } = run;
  await expect(page.locator(`${PANEL} .comments-resolved-count`)).toContainText("resolved");
  const resolved = Number((await page.locator(`${PANEL} .comments-resolved-count`).textContent())!.split(" ")[0]);
  expect(resolved).toBeGreaterThan(150);
  await page.locator(`${EDITOR} p`).first().click();
  await page.keyboard.press("Meta+F");
  await expect(findField(page)).toBeFocused();
  // Each key, from the press to the frame that shows it.
  await page.evaluate(() => {
    const w = window as unknown as { keyTimes: number[] };
    w.keyTimes = [];
    addEventListener(
      "keydown",
      (e) => {
        const pressed = e.timeStamp;
        requestAnimationFrame(() => {
          const after = new MessageChannel();
          after.port1.onmessage = () => w.keyTimes.push(performance.now() - pressed);
          after.port2.postMessage(null);
        });
      },
      true,
    );
  });
  for (const ch of "the team agreed") {
    await page.keyboard.press(ch === " " ? "Space" : ch);
    await page.waitForTimeout(40);
  }
  await page.waitForTimeout(300);
  const times = await page.evaluate(() => (window as unknown as { keyTimes: number[] }).keyTimes);
  // The comments were searched: a word every comment has.
  await findField(page).fill("e");
  await expect(count(page)).toContainText("in comments");
  const sorted = [...times].sort((a, b) => a - b);
  const ninetieth = sorted[Math.floor(sorted.length * 0.9)];
  console.log(`Typing in the find bar with ${resolved} resolved comments: median ${sorted[Math.floor(sorted.length / 2)].toFixed(1)} ms, 90th ${ninetieth.toFixed(1)} ms`);
  // The typing budget: 9 keys in 10 under 100 ms.
  expect(ninetieth).toBeLessThan(100);
  await run.app.close();
});
