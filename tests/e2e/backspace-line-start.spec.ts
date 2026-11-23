// Backspace at the start of a line (Orlando, 2026-11-22, feedback.md): "I'm
// trying to delete the new line at the front of Line 4 to bring this up to the
// paragraph above, and it's not working." A line written straight under a
// paragraph, with no blank line between, is that paragraph's next line; with
// the cursor at its very start, Backspace takes out the line break and brings
// the line up onto the end of the one above, as in any editor. Delete at the
// end of the line above does the same.
import { test, expect, type Page } from "@playwright/test";
import { openText, clickMenu, expectFile, selectText, settle, EDITOR } from "./helpers";

const ABOVE =
  "I've been using Corillo every day for a few weeks now, for my blog posts and for the plans my agents and I work on together, and it has changed how I write.";
const BELOW = "These apps are such a core part of my workflow";
const TEXT = `# My post\n\n${ABOVE}\n${BELOW} that I wanted to share them.\n\nThe end.\n`;
const JOINED = `# My post\n\n${ABOVE}${BELOW} that I wanted to share them.\n\nThe end.\n`;

/** The cursor at the very start of the line that starts with these words, as the person puts it there: a click just before its first letter. */
async function cursorAtLineStart(page: Page, words: string): Promise<void> {
  const at = await page.evaluate(
    ([editor, wanted]) => {
      const root = document.querySelector<HTMLElement>(`${editor} .ProseMirror`)!;
      const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT);
      for (let node = walker.nextNode(); node; node = walker.nextNode()) {
        const i = node.textContent!.indexOf(wanted);
        if (i < 0) continue;
        const range = document.createRange();
        range.setStart(node, i);
        range.setEnd(node, i + 1);
        const r = range.getBoundingClientRect();
        return { x: r.left + 1, y: r.top + r.height / 2 };
      }
      throw new Error(`"${wanted}" isn't in the document`);
    },
    [EDITOR, words] as const,
  );
  await page.mouse.click(at.x, at.y);
  await settle(page);
}

for (const numbers of [false, true]) {
  test(`Backspace at the start of a line joins it onto the end of the line above, line numbers ${numbers ? "on" : "off"}`, async () => {
    const run = await openText(TEXT);
    const { page } = run;
    if (numbers) {
      await clickMenu(run.app, "line-numbers");
      await expect(page.locator(`${EDITOR} .ln`).first()).toBeVisible();
    }
    await cursorAtLineStart(page, BELOW);
    await page.keyboard.press("Backspace");
    await expectFile(run, JOINED);
    // The cursor stays where the line was joined: typing goes between the two.
    await page.keyboard.type(" ");
    await expectFile(run, JOINED.replace(`${ABOVE}${BELOW}`, `${ABOVE} ${BELOW}`));
    // Undo puts the line break back.
    await page.keyboard.press("Meta+z");
    await page.keyboard.press("Meta+z");
    await expectFile(run, TEXT);
    await run.app.close();
  });

  test(`Delete at the end of a line joins the line below onto it, line numbers ${numbers ? "on" : "off"}`, async () => {
    const run = await openText(TEXT);
    const { page } = run;
    if (numbers) {
      await clickMenu(run.app, "line-numbers");
      await expect(page.locator(`${EDITOR} .ln`).first()).toBeVisible();
    }
    await cursorAtLineStart(page, BELOW);
    await page.keyboard.press("ArrowLeft");
    await settle(page);
    await page.keyboard.press("Delete");
    await expectFile(run, JOINED);
    await page.keyboard.type(" ");
    await expectFile(run, JOINED.replace(`${ABOVE}${BELOW}`, `${ABOVE} ${BELOW}`));
    await run.app.close();
  });

  // With line numbers on, Left at the start of a line stopped at its number.
  test(`Left at the start of a line goes to the end of the line above, and Shift-Left selects over the line break, line numbers ${numbers ? "on" : "off"}`, async () => {
    const run = await openText(TEXT);
    const { page } = run;
    if (numbers) {
      await clickMenu(run.app, "line-numbers");
      await expect(page.locator(`${EDITOR} .ln`).first()).toBeVisible();
    }
    await cursorAtLineStart(page, BELOW);
    await page.keyboard.press("ArrowLeft");
    await settle(page);
    await page.keyboard.type("!");
    await expectFile(run, TEXT.replace("write.\n", "write.!\n"));
    await cursorAtLineStart(page, BELOW);
    await page.keyboard.press("Shift+ArrowLeft");
    await page.keyboard.press("Shift+ArrowLeft");
    await page.keyboard.press("Shift+ArrowLeft");
    await settle(page);
    await page.keyboard.type(" ");
    await expectFile(run, JOINED.replace("write.These", "write These"));
    await run.app.close();
  });
}

// The same for a line started with Shift-Return, and for a line of code.
test("Backspace at the start of a Shift-Return line or a line of code joins it to the line above, line numbers on", async () => {
  const run = await openText("One.\n\n```\nlet a = 1;\nlet b = 2;\n```\n");
  const { page } = run;
  await clickMenu(run.app, "line-numbers");
  await expect(page.locator(`${EDITOR} .ln`).first()).toBeVisible();
  await cursorAtLineStart(page, "let b");
  await page.keyboard.press("Backspace");
  await expectFile(run, "One.\n\n```\nlet a = 1;let b = 2;\n```\n");

  await selectText(page, "One.");
  await page.keyboard.press("ArrowRight");
  await page.keyboard.press("Shift+Enter");
  await page.keyboard.type("Two.");
  await expectFile(run, "One.\\\nTwo.\n\n```\nlet a = 1;let b = 2;\n```\n");
  await cursorAtLineStart(page, "Two.");
  await page.keyboard.press("Backspace");
  await expectFile(run, "One.Two.\n\n```\nlet a = 1;let b = 2;\n```\n");
  await run.app.close();
});
