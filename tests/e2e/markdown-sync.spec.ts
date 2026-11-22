// The Markdown view keeping comments on their words while the document
// catches up with the text: after a space typed at the end of a paragraph,
// and through Replace All.
import { test, expect, type Page } from "@playwright/test";
import { expectFile, openText, selectText, settle, EDITOR, type Running } from "./helpers";

const PANEL = ".doc:not([hidden]) aside.comments-panel";
const SOURCE = ".doc:not([hidden]) textarea.source";
const PREVIEW = ".doc:not([hidden]) .page.preview";

let run: Running | null = null;
test.afterEach(async () => {
  await run?.app.close();
  run = null;
});

/** The comments' words as marked in the Markdown text, the preview and the formatted page. */
const textMarks = (page: Page) => page.locator(".doc:not([hidden]) .source-marks mark").allTextContents();
const previewMarks = (page: Page) =>
  page.evaluate((preview) => {
    const found: string[] = [];
    let last: Element | null = null;
    for (const el of document.querySelectorAll(`${preview} .comment-range`)) {
      const id = el.getAttribute("data-comment");
      if (last && last.getAttribute("data-comment") === id) found[found.length - 1] += el.textContent;
      else found.push(el.textContent ?? "");
      last = el;
    }
    return found;
  }, PREVIEW);
const editorMarks = (page: Page) =>
  page.evaluate((editor) => {
    const found: string[] = [];
    let last: Element | null = null;
    for (const el of document.querySelectorAll(`${editor} .comment-range`)) {
      const id = el.getAttribute("data-comment");
      if (last && last.getAttribute("data-comment") === id) found[found.length - 1] += el.textContent;
      else found.push(el.textContent ?? "");
      last = el;
    }
    return found;
  }, EDITOR);

async function comment(page: Page, words: string, body: string): Promise<void> {
  await selectText(page, words);
  await settle(page);
  await page.getByRole("button", { name: "Comment", exact: true }).click();
  await page.getByRole("textbox", { name: "New comment" }).fill(body);
  await page.getByRole("button", { name: "Post" }).click();
  await expect(page.locator(`${PANEL} .comment-card:not(.draft)`, { hasText: body })).toBeVisible();
}

async function toMarkdown(page: Page): Promise<void> {
  await page.getByRole("button", { name: "Markdown", exact: true }).click();
  await expect(page.locator(SOURCE)).toBeVisible();
}

async function toFormatted(page: Page): Promise<void> {
  await page.getByRole("button", { name: "Formatted", exact: true }).click();
  await expect(page.locator(EDITOR)).toBeVisible();
}

/** Put the cursor in the Markdown text just after these characters. */
async function cursorAfterInText(page: Page, chars: string): Promise<void> {
  await page.locator(SOURCE).evaluate((area: HTMLTextAreaElement, wanted) => {
    const at = area.value.indexOf(wanted);
    if (at < 0) throw new Error(`"${wanted}" isn't in the Markdown text`);
    area.focus();
    area.setSelectionRange(at + wanted.length, at + wanted.length);
  }, chars);
}

/** Put the cursor in the formatted page just after these words. */
async function cursorAfter(page: Page, words: string): Promise<void> {
  await page.evaluate(
    ([editor, wanted]) => {
      const root = document.querySelector<HTMLElement>(`${editor} .ProseMirror`)!;
      root.focus();
      const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT);
      for (let node = walker.nextNode(); node; node = walker.nextNode()) {
        const at = node.textContent!.indexOf(wanted);
        if (at < 0) continue;
        getSelection()!.collapse(node, at + wanted.length);
        return;
      }
      throw new Error(`"${wanted}" isn't in the document`);
    },
    [EDITOR, words] as const,
  );
  await settle(page);
}

const PARAGRAPH = "# Plan\n\nAlpha beta gamma delta.\n\nSecond paragraph here.\n";

for (const where of ["formatted", "markdown"] as const) {
  test(`a space typed at the end of a paragraph (in the ${where} view) leaves a comment in it on its own words when typing in them in the Markdown view`, async () => {
    run = await openText(PARAGRAPH);
    const { page } = run;
    await comment(page, "beta gamma", "Which ones?");
    if (where === "formatted") {
      await cursorAfter(page, "delta.");
      await page.keyboard.type(" ");
      await toMarkdown(page);
    } else {
      await toMarkdown(page);
      await cursorAfterInText(page, "delta.");
      await page.keyboard.type(" ");
    }
    await cursorAfterInText(page, "be");
    await page.keyboard.type("e");
    await settle(page);
    await expect.poll(() => previewMarks(page)).toEqual(["beeta gamma"]);
    expect(await textMarks(page)).toEqual(["beeta gamma"]);
    await toFormatted(page);
    expect(await editorMarks(page)).toEqual(["beeta gamma"]);
  });
}

const BUDGET = "# Plan\n\nThe Q3 plan.\n\nWe need the Q3 budget soon, and **the Q3 team** too.\n\nAfter Q3 ends.\n";

for (const where of ["formatted", "markdown"] as const) {
  test(`Replace All in the ${where} view keeps comments on their words, replaced words included`, async () => {
    run = await openText(BUDGET);
    const { page } = run;
    await comment(page, "the Q3 budget", "How much?");
    await comment(page, "soon, and", "When?");
    await comment(page, "the Q3 team", "Who?");
    if (where === "markdown") await toMarkdown(page);
    await page.keyboard.press("Meta+Alt+F");
    await page.getByRole("textbox", { name: "Find", exact: true }).fill("Q3");
    await page.getByRole("textbox", { name: "Replace with" }).fill("Q4");
    await page.getByRole("button", { name: "Replace all" }).click();
    await expect(page.locator(".find-count")).toHaveText("Replaced 4");
    await page.keyboard.press("Escape");
    await expectFile(run, "# Plan\n\nThe Q4 plan.\n\nWe need the Q4 budget soon, and **the Q4 team** too.\n\nAfter Q4 ends.\n");
    if (where === "markdown") {
      await settle(page);
      await expect.poll(() => previewMarks(page)).toEqual(["the Q4 budget", "soon, and", "the Q4 team"]);
      expect(await textMarks(page)).toEqual(["the Q4 budget", "soon, and", "the Q4 team"]);
      await toFormatted(page);
    }
    expect(await editorMarks(page)).toEqual(["the Q4 budget", "soon, and", "the Q4 team"]);
    await expect(page.locator(`${PANEL} .comment-card`, { hasText: "has changed" })).toHaveCount(0);
  });
}

test("Undo and Redo of a Replace All made in the Markdown view keep comments on their words, replaced words included", async () => {
  run = await openText(BUDGET);
  const { page } = run;
  await comment(page, "the Q3 budget", "How much?");
  await comment(page, "soon, and", "When?");
  await comment(page, "the Q3 team", "Who?");
  await toMarkdown(page);
  await page.keyboard.press("Meta+Alt+F");
  await page.getByRole("textbox", { name: "Find", exact: true }).fill("Q3");
  await page.getByRole("textbox", { name: "Replace with" }).fill("Q4");
  await page.getByRole("button", { name: "Replace all" }).click();
  await expect(page.locator(".find-count")).toHaveText("Replaced 4");
  await page.keyboard.press("Escape");
  await expectFile(run, "# Plan\n\nThe Q4 plan.\n\nWe need the Q4 budget soon, and **the Q4 team** too.\n\nAfter Q4 ends.\n");
  await settle(page);
  await expect.poll(() => previewMarks(page)).toEqual(["the Q4 budget", "soon, and", "the Q4 team"]);
  // Undo (the text's own, with the keyboard back in it): every match back as it was, and every comment still on its words.
  await expect(page.getByRole("textbox", { name: "Markdown text" })).toBeFocused();
  await page.keyboard.press("Meta+z");
  await expectFile(run, BUDGET);
  await settle(page);
  await expect.poll(() => previewMarks(page)).toEqual(["the Q3 budget", "soon, and", "the Q3 team"]);
  expect(await textMarks(page)).toEqual(["the Q3 budget", "soon, and", "the Q3 team"]);
  // Redo: the Replace All again, the comments with it.
  await page.keyboard.press("Meta+Shift+z");
  await expectFile(run, "# Plan\n\nThe Q4 plan.\n\nWe need the Q4 budget soon, and **the Q4 team** too.\n\nAfter Q4 ends.\n");
  await settle(page);
  await expect.poll(() => previewMarks(page)).toEqual(["the Q4 budget", "soon, and", "the Q4 team"]);
  await toFormatted(page);
  expect(await editorMarks(page)).toEqual(["the Q4 budget", "soon, and", "the Q4 team"]);
  await expect(page.locator(`${PANEL} .comment-card`, { hasText: "has changed" })).toHaveCount(0);
});
