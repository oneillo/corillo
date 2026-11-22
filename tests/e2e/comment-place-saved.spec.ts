// A comment's place is saved as soon as it moves (roadmap Batch 18, W-S2). Typing above a comment moves it without
// changing its words or the words around them. Corillo used to tell its records only once a comment had moved 300
// characters or more, or when the tab closed, so the place it kept could be stale for the whole session. Where the
// same words are written more than once in the same surroundings, the place decides which copy is the comment's:
// if Corillo then stopped without closing (a crash, a forced quit), the comment came back on another copy.
import { test, expect, type Page } from "@playwright/test";
import { EDITOR, ONE_SCALE, cursorAtEnd, openText, watchTimers, launch } from "./helpers";
import { tidyRuns } from "./tidy";

const tidy = tidyRuns();

const REPEATED = "Status: waiting on the partner for the signed survey.";
const AROUND = "Owner: Ana, to check again before Friday.";
const TEXT = ["# Plan", "Intro paragraph one.", AROUND, REPEATED, AROUND, REPEATED, AROUND, REPEATED, AROUND, "End."].join("\n\n") + "\n";

/** Select the words of the nth paragraph (from 0) whose text is exactly this. */
async function selectParagraph(page: Page, text: string, nth: number): Promise<void> {
  await page.evaluate(
    ([editor, wanted, n]) => {
      const root = document.querySelector<HTMLElement>(`${editor} .ProseMirror`)!;
      root.focus();
      const p = [...root.querySelectorAll("p")].filter((e) => e.textContent === wanted)[n as number];
      const range = document.createRange();
      range.selectNodeContents(p);
      return new Promise<void>((resolve) => {
        const done = () => {
          document.removeEventListener("selectionchange", done);
          setTimeout(resolve, 0);
        };
        document.addEventListener("selectionchange", done);
        getSelection()!.removeAllRanges();
        getSelection()!.addRange(range);
      });
    },
    [EDITOR, text, nth] as const,
  );
}

/** Which of the paragraphs written this way holds the comment's highlight (from 0), or -1. */
const highlighted = (page: Page, text: string) =>
  page.evaluate(
    ([editor, wanted]) => [...document.querySelectorAll(`${editor} p`)].filter((e) => e.textContent === wanted).findIndex((p) => !!p.querySelector(".comment-range")),
    [EDITOR, text] as const,
  );

test("a comment on the last of three same sentences, typed above, then Corillo stopped without closing: it comes back on the same sentence", async () => {
  const run = tidy.keep(await openText(TEXT, { name: "plan.md" }));
  const { page } = run;
  await selectParagraph(page, REPEATED, 2);
  await page.getByRole("button", { name: "Comment", exact: true }).click();
  await page.getByRole("textbox", { name: "New comment" }).fill("Who chases this one?");
  await page.getByRole("button", { name: "Post" }).click();
  await expect(page.locator(".comment-card:not(.draft)")).toHaveCount(1);
  expect(await highlighted(page, REPEATED)).toBe(2);

  // Typed above it: less than a paragraph's worth, a few seconds of typing. The pause after it passes, and the file is saved.
  const placesSaved = await watchTimers(page, 800);
  const before = await placesSaved.count();
  await cursorAtEnd(page, "Intro paragraph one.");
  const typed = " And more words typed here.".repeat(11); // 297 characters
  await page.keyboard.insertText(typed);
  await placesSaved.ranSince(before.ran);
  await expect.poll(run.text).toContain(typed);
  expect(await highlighted(page, REPEATED)).toBe(2);

  // Corillo stops without closing anything, then opens the document again.
  const home = (await run.app.evaluate(() => process.env.CORILLO_HOME)) ?? "";
  run.app.process().kill("SIGKILL");
  await run.app.close().catch(() => undefined);
  const { app, thrown } = await launch({
    args: [ONE_SCALE, ".", run.file],
    env: { ...process.env, CORILLO_USER_DATA: run.dataDir, CORILLO_HIDDEN: "1", CORILLO_HOME: home },
  });
  // The same run from here on, so it is closed and its folders removed after the test.
  run.app = app;
  run.page = await app.firstWindow();
  run.thrown = thrown;
  await run.page.waitForSelector(".ProseMirror");
  await expect(run.page.locator(`${EDITOR} .comment-range`)).toHaveText([REPEATED]);
  expect(await highlighted(run.page, REPEATED)).toBe(2);
});
