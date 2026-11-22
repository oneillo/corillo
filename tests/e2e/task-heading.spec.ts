// A task (checklist item) given a heading or made code comes back as the person left it (roadmap Batch 18, R16-3
// case 2). Markdown has a task's box only at the start of a plain line, so "- [ ] # Title" read back as the words
// "# Title". Now the box goes as the line becomes a heading, code or a quote, and the item stays in its list.
import { test, expect, type Page } from "@playwright/test";
import { openText, cursorAtEnd, settle, clickMenu, EDITOR, type Running } from "./helpers";
import { tidyRuns } from "./tidy";
import { writeFileSync } from "node:fs";

const tidy = tidyRuns();

/** The page as kinds and words, with a task's box: its HTML without the attributes that only draw it. */
const shown = (page: Page) =>
  page
    .locator(`${EDITOR} .ProseMirror`)
    .evaluate((e) => e.innerHTML.replace(/ (style|contenteditable|draggable|spellcheck|data-tight)="[^"]*"/g, "").replace(/ class="(?!task")[^"]*"/g, ""));

/** Wait for the save, close the tab and open the file again: the page before and after, and the file. */
async function savedAndReopened(run: Running, fileHolds: RegExp) {
  await expect.poll(run.text).toMatch(fileHolds);
  const before = await shown(run.page);
  await clickMenu(run.app, "close-tab");
  await expect(run.page.locator(".tab")).toHaveCount(0);
  await run.page.evaluate((p) => window.corillo.openPath(p), run.file);
  await run.page.waitForSelector(`${EDITOR} .ProseMirror`);
  await settle(run.page);
  return { before, after: await shown(run.page), file: run.text() };
}

test("a task given the style Heading 1 is a heading in the list, and still one the next time the document opens", async () => {
  const run = tidy.keep(await openText("- [ ] Title here\n- [x] Book the room\n\nAfter.\n", { name: "notes.md" }));
  await expect(run.page.locator(`${EDITOR} li.task`)).toHaveCount(2);
  await cursorAtEnd(run.page, "Title here", "li");
  await run.page.getByRole("combobox", { name: "Paragraph style" }).selectOption({ label: "Heading 1" });
  const { before, after, file } = await savedAndReopened(run, /# Title/);
  expect(file).toBe("- # Title here\n- [x] Book the room\n\nAfter.\n");
  expect(before).toBe('<ul><li><h1>Title here</h1></li><li class="task" data-checked="true"><p>Book the room</p></li></ul><p>After.</p>');
  expect(after).toBe(before);
  await expect(run.page.locator(`${EDITOR} h1`)).toHaveText("Title here"); // no "#" in its words
});

test("a ticked task made a code block keeps its code as code the next time the document opens", async () => {
  const run = tidy.keep(await openText("- [x] x = 1\n\nAfter.\n", { name: "notes.md" }));
  await cursorAtEnd(run.page, "x = 1", "li");
  await run.page.getByRole("button", { name: "Code block", exact: true }).click();
  const { before, after } = await savedAndReopened(run, /```/);
  expect(before).toBe("<ul><li><pre><code>x = 1</code></pre></li></ul><p>After.</p>");
  expect(after).toBe(before);
  await expect(run.page.locator(`${EDITOR} p`)).toHaveText(["After."]); // no fence left as words
});

test("Undo after Heading 1 on a task brings its box back with the plain line", async () => {
  const run = tidy.keep(await openText("- [ ] Title here\n\nAfter.\n", { name: "notes.md" }));
  await cursorAtEnd(run.page, "Title here", "li");
  await run.page.getByRole("combobox", { name: "Paragraph style" }).selectOption({ label: "Heading 1" });
  await expect(run.page.locator(`${EDITOR} li.task`)).toHaveCount(0);
  await run.page.locator(`${EDITOR} h1`).click();
  await run.page.keyboard.press("Meta+z");
  await expect(run.page.locator(`${EDITOR} li.task p`)).toHaveText("Title here");
  await expect.poll(run.text).toBe("- [ ] Title here\n\nAfter.\n");
});

// The review of Batch 18, R18-4: typing Markdown at a task's start does the same as the style menu.
test("typing '# ', '> ' or three backticks at a task's start: the box goes, the file reads back as left, and one Undo brings the box back", async () => {
  const run = tidy.keep(await openText("- [ ] Title here\n- [ ] Quote me\n- [x] x = 1\n\nAfter.\n", { name: "notes.md" }));
  await expect(run.page.locator(`${EDITOR} li.task`)).toHaveCount(3);
  const atStart = async (words: string) => {
    await cursorAtEnd(run.page, words, "li");
    await run.page.keyboard.press("Meta+ArrowLeft");
  };
  await atStart("Title here");
  await run.page.keyboard.type("# ");
  await expect(run.page.locator(`${EDITOR} li h1`)).toHaveText("Title here");
  await expect(run.page.locator(`${EDITOR} li.task`)).toHaveCount(2);
  await atStart("Quote me");
  await run.page.keyboard.type("> ");
  await atStart("x = 1");
  await run.page.keyboard.type("```");
  await expect(run.page.locator(`${EDITOR} li.task`)).toHaveCount(0);
  const { before, after, file } = await savedAndReopened(run, /```/);
  expect(file).toBe("- # Title here\n- > Quote me\n- ```\n  x = 1\n  ```\n\nAfter.\n");
  expect(after).toBe(before);
  await expect(run.page.locator(`${EDITOR} h1`)).toHaveText("Title here"); // no "#" in its words

  // Undo, in a document opened afresh: "# " typed, then one Undo, and the task is back as it was.
  await clickMenu(run.app, "close-tab");
  writeFileSync(run.file, "- [ ] Title here\n\nAfter.\n");
  await run.page.evaluate((p) => window.corillo.openPath(p), run.file);
  await run.page.waitForSelector(`${EDITOR} li.task`);
  await atStart("Title here");
  await run.page.keyboard.type("# ");
  await expect(run.page.locator(`${EDITOR} li.task`)).toHaveCount(0);
  // One Undo: the box is back with the plain line (with the typed "# " as words, or without it if the typing went in the same step).
  await run.page.keyboard.press("Meta+z");
  await expect(run.page.locator(`${EDITOR} li.task p`)).toHaveText(/^(# )?Title here$/);
  await expect(run.page.locator(`${EDITOR} li h1`)).toHaveCount(0);
});
