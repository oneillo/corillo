// The Markdown view: the file's text on the left, a preview on the right.
import { test, expect } from "@playwright/test";
import { readFileSync, statSync, writeFileSync } from "node:fs";
import { bigDocument } from "../fixtures/big-document";
import { openText, openAlso, expectFile, cursorAtEnd, selectText, settle, EDITOR, type Running } from "./helpers";
import { AgentSession } from "./agent-session";

const DOC = "---\ntitle: Notes\n---\n\n# Notes\n\n* one\n* two\n\n| a | b |\n|---|---|\n| 1 | 2 |\n";

test("switching to Markdown shows the file's exact text and a preview", async () => {
  const run = await openText(DOC);
  const before = statSync(run.file).mtimeMs;
  await run.page.getByRole("button", { name: "Markdown" }).click();
  await expect(run.page.getByRole("textbox", { name: "Markdown text" })).toHaveValue(DOC);
  await expect(run.page.locator(".page.preview h1")).toHaveText("Notes");
  await expect(run.page.locator(".page.preview table")).toBeVisible();
  await expect(run.page.getByRole("button", { name: "Bold", exact: true })).toBeDisabled();
  // Switching back and forth without typing changes nothing on disk.
  await run.page.getByRole("button", { name: "Formatted" }).click();
  await expect(run.page.locator(".page.editor h1")).toHaveText("Notes");
  await run.page.waitForTimeout(700);
  expect(run.text()).toBe(DOC);
  expect(statSync(run.file).mtimeMs).toBe(before);
  await run.app.close();
});

test("typing in the Markdown view saves exactly what was typed, and the preview follows", async () => {
  const run = await openText(DOC);
  await run.page.getByRole("button", { name: "Markdown" }).click();
  const source = run.page.getByRole("textbox", { name: "Markdown text" });
  await source.press("Meta+ArrowDown");
  await run.page.keyboard.type("\nAdded *in Markdown*.\n");
  await expectFile(run, DOC + "\nAdded *in Markdown*.\n");
  await expect(run.page.locator(".page.preview em")).toHaveText("in Markdown");
  await run.page.getByRole("button", { name: "Formatted" }).click();
  await expect(run.page.locator(".page.editor em")).toHaveText("in Markdown");
  await run.app.close();
});

test("edits made in the formatted view show in the Markdown view", async () => {
  const run = await openText(DOC);
  await cursorAtEnd(run.page, "Notes", "h1");
  await run.page.keyboard.type(" for Friday");
  await run.page.getByRole("button", { name: "Markdown" }).click();
  await expect(run.page.getByRole("textbox", { name: "Markdown text" })).toHaveValue(
    DOC.replace("# Notes", "# Notes for Friday"),
  );
  await expectFile(run, DOC.replace("# Notes", "# Notes for Friday"));
  await run.app.close();
});

test("a change made outside Corillo shows up in the Markdown view too", async () => {
  const run = await openText(DOC);
  await run.page.getByRole("button", { name: "Markdown" }).click();
  writeFileSync(run.file, DOC.replace("* two", "* two\n* three"));
  await expect(run.page.getByRole("textbox", { name: "Markdown text" })).toHaveValue(DOC.replace("* two", "* two\n* three"));
  await expect(run.page.locator(".page.preview li")).toHaveCount(3);
  await run.app.close();
});

test("a Markdown view left for the formatted one is let go of once the document changes there (typing, an agent's change) or its tab goes behind, and comes back whole (W-3)", async () => {
  const LAST = "Paragraph 60 says something about the plan.";
  const doc = "# Plan\n\n" + Array.from({ length: 60 }, (_, i) => `Paragraph ${i + 1} says something about the plan.`).join("\n\n") + "\n";
  const run = await openText(doc, { name: "plan.md" });
  const { page } = run;
  /** What the tab in front holds of its Markdown view: laid out out of sight, the preview's elements, the characters in its text. */
  const held = () =>
    page.evaluate(() => {
      const tab = document.querySelector(".doc:not([hidden])")!;
      return {
        laidOut: !!tab.querySelector(".split.kept"),
        preview: tab.querySelectorAll(".page.preview *").length,
        text: tab.querySelector<HTMLTextAreaElement>("textarea.source")?.value.length ?? 0,
      };
    });
  const lookAtMarkdown = async () => {
    await page.getByRole("button", { name: "Markdown" }).click();
    await expect(page.locator(".doc:not([hidden]) .page.preview")).toContainText(LAST);
    await page.getByRole("button", { name: "Formatted" }).click();
    await expect(page.locator(EDITOR)).toBeVisible();
  };
  const letGo = { laidOut: false, preview: 0, text: 0 };

  // Left as it was, it's kept for a quick way back.
  await lookAtMarkdown();
  await settle(page);
  expect(await held()).toMatchObject({ laidOut: true, text: doc.length });
  // The person types in the formatted view.
  await cursorAtEnd(page, LAST);
  await page.keyboard.type(" More.");
  await expect.poll(held).toEqual(letGo);
  // Shown again, it's whole, with the typing.
  await page.getByRole("button", { name: "Markdown" }).click();
  await expect(page.getByRole("textbox", { name: "Markdown text" })).toHaveValue(doc.replace(LAST, `${LAST} More.`));
  await expect(page.locator(".doc:not([hidden]) .page.preview")).toContainText(`${LAST} More.`);
  await page.getByRole("button", { name: "Formatted" }).click();
  await expectFile(run, doc.replace(LAST, `${LAST} More.`));

  // An agent's change.
  await lookAtMarkdown();
  const { session } = await AgentSession.start(run.dataDir);
  try {
    await session.ok("take_document", { path: run.file, request: "Change the first paragraph." });
    await session.ok("edit_document", { path: run.file, edits: [{ find: "Paragraph 1 says", replace: "Paragraph one says" }] });
    await session.ok("finish_editing", { path: run.file });
  } finally {
    await session.stop();
  }
  await expect(page.locator(EDITOR)).toContainText("Paragraph one says");
  await expect.poll(held).toEqual(letGo);

  // Its tab goes behind.
  await lookAtMarkdown();
  await openAlso(run, "notes.md", "# Notes\n");
  await page.locator('.tab[title$="/plan.md"]').click();
  await expect(page.locator(EDITOR)).toContainText("Paragraph one says");
  await expect.poll(held).toEqual(letGo);
  await page.getByRole("button", { name: "Markdown" }).click();
  await expect(page.locator(".doc:not([hidden]) .page.preview")).toContainText("Paragraph one says");
  await run.app.close();
});

test("Tab in the Markdown view types a tab, as in any text editor, instead of leaving the text", async () => {
  const run = await openText("- one\n- two\n");
  await run.page.getByRole("button", { name: "Markdown" }).click();
  const source = run.page.getByRole("textbox", { name: "Markdown text" });
  await source.press("Meta+ArrowDown");
  await run.page.keyboard.press("ArrowUp");
  await run.page.keyboard.press("Meta+ArrowLeft");
  await run.page.keyboard.press("Tab");
  await expect(source).toBeFocused();
  await expectFile(run, "- one\n\t- two\n");
  // One Undo takes the tab back out.
  await run.page.keyboard.press("Meta+z");
  await expectFile(run, "- one\n- two\n");
  await run.page.keyboard.press("Shift+Tab");
  await expect(source).toBeFocused();
  await run.app.close();
});

test("Undo still works after a look at the Markdown view: what was typed before can be taken back", async () => {
  const run = await openText(DOC);
  await cursorAtEnd(run.page, "Notes", "h1");
  await run.page.keyboard.type(" for Monday");
  await expectFile(run, DOC.replace("# Notes", "# Notes for Monday"));
  await run.page.getByRole("button", { name: "Markdown", exact: true }).click();
  await run.page.getByRole("button", { name: "Formatted", exact: true }).click();
  await run.page.keyboard.press("Meta+z");
  await expectFile(run, DOC);
  await run.app.close();
});

test("after typing in the Markdown view, Undo in the formatted view takes back that typing, then what came before", async () => {
  const run = await openText(DOC);
  await cursorAtEnd(run.page, "Notes", "h1");
  await run.page.keyboard.type(" for Monday");
  await expectFile(run, DOC.replace("# Notes", "# Notes for Monday"));
  await run.page.getByRole("button", { name: "Markdown", exact: true }).click();
  const source = run.page.getByRole("textbox", { name: "Markdown text" });
  await source.press("Meta+ArrowDown");
  await run.page.keyboard.type("\nAdded *in Markdown*.\n");
  const both = DOC.replace("# Notes", "# Notes for Monday") + "\nAdded *in Markdown*.\n";
  await expectFile(run, both);
  await run.page.getByRole("button", { name: "Formatted", exact: true }).click();
  await expect(run.page.locator(".page.editor em")).toHaveText("in Markdown");
  await run.page.waitForTimeout(600);
  expect(run.text()).toBe(both); // coming back changes nothing on disk
  await run.page.keyboard.press("Meta+z");
  await expectFile(run, DOC.replace("# Notes", "# Notes for Monday"));
  await run.page.keyboard.press("Meta+z");
  await expectFile(run, DOC);
  await run.app.close();
});

test("in a long document, switching views keeps the cursor on the same words and brings them into sight, however the page was scrolled", async () => {
  const run = await openText(bigDocument(), { name: "long.md" });
  const { page } = run;
  const source = page.getByRole("textbox", { name: "Markdown text" });
  // Whether the cursor's line (or the line it starts) is within the page's scrolling area, and where.
  const cursorInSight = () =>
    page.evaluate(() => {
      const area = document.querySelector(".doc:not([hidden]) .canvas.with-side")!.getBoundingClientRect();
      const selection = getSelection()!;
      let cursor = selection.getRangeAt(0).getBoundingClientRect();
      if (!cursor.height) {
        const at = selection.focusNode!;
        cursor = (at instanceof Element ? at : at.parentElement!).getBoundingClientRect();
      }
      return { inSight: cursor.top >= area.top && cursor.top < area.bottom, top: Math.round(cursor.top) };
    });

  // The cursor at the start, the page scrolled far below it.
  await page.locator(`${EDITOR} h1`).click();
  await page.keyboard.press("Meta+ArrowUp");
  await page.locator(`${EDITOR} h3`, { hasText: /^15\.5 / }).scrollIntoViewIfNeeded();
  expect(await cursorInSight()).toMatchObject({ inSight: false });
  await page.getByRole("button", { name: "Markdown", exact: true }).click();
  expect(await source.evaluate((area: HTMLTextAreaElement) => area.value.slice(0, area.selectionStart))).toBe("# ");
  await page.getByRole("button", { name: "Formatted", exact: true }).click();
  await expect.poll(cursorInSight).toMatchObject({ inSight: true });

  // The cursor put far down in the Markdown text: the page goes there.
  await page.getByRole("button", { name: "Markdown", exact: true }).click();
  await source.evaluate((area: HTMLTextAreaElement) => {
    const at = area.value.indexOf("### 15.5 ") + "### ".length;
    area.setSelectionRange(at, at);
  });
  await page.getByRole("button", { name: "Formatted", exact: true }).click();
  await expect.poll(cursorInSight).toMatchObject({ inSight: true });
  await page.keyboard.type("Seen: ");
  await expect(page.locator(`${EDITOR} h3`, { hasText: /^Seen: 15\.5 / })).toBeVisible();
  await run.app.close();
});

test("one letter typed reaches the file as soon in the Markdown view as in the Formatted view (S21-9)", async () => {
  const run = await openText("Plan for the week.\n\nSecond paragraph.\n", { name: "plan.md" });
  const { page } = run;
  // The save is set going a short while after the last change; set going again, it's put off. So the cause is
  // counted, not timed (the review of Batch 21, R21-7): a busy Mac slows a timing, never a count.
  const savesSet = () => page.evaluate(() => (window as unknown as { corilloTests: { savesSet: number } }).corilloTests.savesSet);
  /** How many times one letter typed sets the save going (or puts it off), counted until the file on disk has the letter. */
  const setsFor = async (r: Running, letter: string): Promise<number> => {
    const before = readFileSync(r.file, "utf8");
    const count = await savesSet();
    await r.page.keyboard.type(letter);
    await expect.poll(() => readFileSync(r.file, "utf8") !== before, { intervals: [5], timeout: 5000 }).toBe(true);
    await r.page.waitForTimeout(500); // the save done and the status settled before the next letter
    return (await savesSet()) - count;
  };
  await cursorAtEnd(page, "Plan for the week.");
  await settle(page);
  const formatted: number[] = [];
  for (const letter of ["a", "b", "c"]) formatted.push(await setsFor(run, letter));
  await page.getByRole("button", { name: "Markdown", exact: true }).click();
  await expect(page.getByRole("textbox", { name: "Markdown text" })).toBeFocused();
  await settle(page);
  const markdown: number[] = [];
  for (const letter of ["d", "e", "f"]) markdown.push(await setsFor(run, letter));
  // Once per letter in each view: in the Markdown view, the page catching up with the text doesn't put the save off again.
  expect(formatted).toEqual([1, 1, 1]);
  expect(markdown).toEqual([1, 1, 1]);
  await expectFile(run, "Plan for the week.abcdef\n\nSecond paragraph.\n");
  await run.app.close();
});

test("letting go of the Markdown view lets go of the comments' copy of its text too (S21-10)", async () => {
  const PARAGRAPHS = 300;
  const text = Array.from({ length: PARAGRAPHS }, (_, i) => `Point ${i + 1}: budget, hiring and the plan for the quarter.`).join("\n\n") + "\n";
  const run = await openText(text, { name: "plan.md" });
  const { page } = run;
  const rows = () => page.locator(".doc:not([hidden]) .source-marks-lines").evaluate((lines) => lines.children.length);
  await selectText(page, "Point 2:");
  await page.getByRole("button", { name: "Comment", exact: true }).click();
  await page.getByRole("textbox", { name: "New comment" }).fill("Check this.");
  await page.getByRole("button", { name: "Post" }).click();
  await expect(page.locator(".doc:not([hidden]) aside.comments-panel .comment-card:not(.draft)", { hasText: "Check this." })).toBeVisible();
  await page.getByRole("button", { name: "Markdown", exact: true }).click();
  // While the view shows, the layer behind the text holds a row for every line.
  await expect.poll(rows).toBeGreaterThanOrEqual(2 * PARAGRAPHS - 1);
  await page.getByRole("button", { name: "Formatted", exact: true }).click();
  await cursorAtEnd(page, "Point 1:");
  await page.keyboard.type(" More.");
  // The view kept out of sight is let go of: its text, and the comments' copy of it.
  await expect.poll(() => page.locator(".doc:not([hidden]) textarea.source").evaluate((area: HTMLTextAreaElement) => area.value.length)).toBe(0);
  await expect.poll(rows).toBe(0);
  // Shown again, the comment is drawn in the text as before.
  await page.getByRole("button", { name: "Markdown", exact: true }).click();
  await expect.poll(rows).toBeGreaterThanOrEqual(2 * PARAGRAPHS - 1);
  await run.app.evaluate(({ app }) => setTimeout(() => app.exit(0), 10)).catch(() => undefined);
  await run.app.close().catch(() => undefined);
});
