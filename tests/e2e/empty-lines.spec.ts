// Empty lines (Orlando, 2026-11-09): "An empty line in markdown doc should show
// up as an empty line in word", and "it's weird to see missing line numbers".
// What the page shows is what the file holds: each blank line of the file is
// one empty line of the text's height, numbered, and Return and Backspace add
// and take them away.
import { test, expect, type Page } from "@playwright/test";
import { openText, clickMenu, cursorAtEnd, expectFile, selectText, settle, EDITOR } from "./helpers";

/** Each top-level block of the page: its tag, top and bottom, and the line height of the body text. */
function blocks(page: Page): Promise<{ line: number; boxes: { tag: string; text: string; top: number; bottom: number }[] }> {
  return page.evaluate((editor) => {
    const pm = document.querySelector<HTMLElement>(`${editor} .ProseMirror`)!;
    const line = parseFloat(getComputedStyle(pm).getPropertyValue("--line"));
    const boxes = [...pm.children]
      .filter((el) => !el.classList.contains("ln-blank"))
      .map((el) => {
        const r = el.getBoundingClientRect();
        return { tag: el.tagName, text: (el as HTMLElement).innerText.split("\n")[0], top: r.top, bottom: r.bottom };
      });
    return { line, boxes };
  }, EDITOR);
}

/** Every number shown in the formatted view, whatever it's beside. */
function allNumbers(page: Page): Promise<number[]> {
  return page.evaluate((editor) => {
    const out: number[] = [];
    for (const el of document.querySelectorAll<HTMLElement>(`${editor} .ln, ${editor} .ln-line, ${editor} .ln-blank, ${editor} .ln-end, ${editor} .ln-dash`)) {
      if (!el.checkVisibility()) continue;
      for (const n of [el.dataset.ln, el.dataset.end, el.dataset.dash]) if (n !== undefined) out.push(Number(n));
    }
    return [...new Set(out)].sort((a, b) => a - b);
  }, EDITOR);
}

const showNumbers = async (page: Page, app: Parameters<typeof clickMenu>[0]) => {
  await clickMenu(app, "line-numbers");
  await expect(page.locator(`${EDITOR} .ln`).first()).toBeVisible();
};

test("Return on an empty line adds a blank line to the file and Backspace takes one away; they're there on reopening", async () => {
  const run = await openText("One.\n\nTwo.\n");
  const { page } = run;
  await cursorAtEnd(page, "One.");
  await page.keyboard.press("Enter");
  await expectFile(run, "One.\n\n\nTwo.\n");
  await page.keyboard.press("Enter");
  await expectFile(run, "One.\n\n\n\nTwo.\n");
  await page.keyboard.press("Backspace");
  await expectFile(run, "One.\n\n\nTwo.\n");
  // Words typed on an empty line get the blank line Markdown needs under them.
  await page.keyboard.type("x");
  await expectFile(run, "One.\n\nx\n\nTwo.\n");
  await page.keyboard.press("Backspace");
  await expectFile(run, "One.\n\n\nTwo.\n");
  await run.app.close();

  const again = await openText("One.\n\n\n\nTwo.\n");
  await expect(again.page.locator(`${EDITOR} .ProseMirror > p.empty-line`)).toHaveCount(2);
  await again.app.close();
});

// Review R-EL-1: the blank line between two paragraphs is numbered and drawn
// like an empty line, so Backspace takes it away like one (the lead's call,
// 2026-11-09 night): the two then sit on consecutive lines, one paragraph over
// two lines as the file reads; a second Backspace joins the lines.
test("Backspace at the start of a paragraph takes away the blank line above it, then joins the lines; Delete at the end of the one above does the same", async () => {
  const run = await openText("Hi Ana,\n\nThanks for today.\n\n\nBye.\n");
  const { page } = run;
  const paragraphs = () => page.locator(`${EDITOR} .ProseMirror > p:not(.empty-line)`).allInnerTexts();
  await cursorAtEnd(page, "Hi Ana,");
  await page.keyboard.press("ArrowRight");
  await settle(page);
  await page.keyboard.press("Backspace");
  await expectFile(run, "Hi Ana,\nThanks for today.\n\n\nBye.\n");
  expect(await paragraphs()).toEqual(["Hi Ana,\nThanks for today.", "Bye."]);
  // The cursor stays at the start of "Thanks": typing goes there.
  await page.keyboard.type("x");
  await expectFile(run, "Hi Ana,\nxThanks for today.\n\n\nBye.\n");
  await page.keyboard.press("Backspace");
  await page.keyboard.press("Backspace");
  await expectFile(run, "Hi Ana,Thanks for today.\n\n\nBye.\n");

  // With more than one empty line above, Backspace takes one away, as before;
  // then the last blank line goes the same way.
  await cursorAtEnd(page, "Bye.");
  await page.keyboard.press("Meta+ArrowLeft");
  await settle(page);
  await page.keyboard.press("Backspace");
  await expectFile(run, "Hi Ana,Thanks for today.\n\nBye.\n");
  await page.keyboard.press("Backspace");
  await expectFile(run, "Hi Ana,Thanks for today.\nBye.\n");

  await run.app.close();

  // Delete at the end of the paragraph above does the same, and the cursor
  // stays put. In a quote, the same.
  const other = await openText("One.\n\nTwo.\n\n> Three.\n>\n> Four.\n");
  await cursorAtEnd(other.page, "One.");
  await other.page.keyboard.press("Delete");
  await expectFile(other, "One.\nTwo.\n\n> Three.\n>\n> Four.\n");
  await other.page.keyboard.type("!");
  await expectFile(other, "One.!\nTwo.\n\n> Three.\n>\n> Four.\n");
  await cursorAtEnd(other.page, "Three.");
  await other.page.keyboard.press("ArrowRight");
  await settle(other.page);
  await other.page.keyboard.press("Backspace");
  await expectFile(other, "One.!\nTwo.\n\n> Three.\n> Four.\n");
  await other.app.close();
});

/** The page's top-level blocks as words, a quote's paragraphs each in turn. */
function outline(page: Page): Promise<string[]> {
  return page.evaluate((editor) => {
    const words = (el: Element) => (el as HTMLElement).innerText.trim() || "(empty)";
    return [...document.querySelector<HTMLElement>(`${editor} .ProseMirror`)!.children]
      .filter((el) => !el.classList.contains("ln-blank"))
      .map((el) => (el.tagName === "BLOCKQUOTE" ? `quote: ${[...el.children].map(words).join(" | ")}` : words(el)));
  }, EDITOR);
}

// Review R-EL-2: Markdown has no empty paragraph inside a quote, a callout or
// a list item, so an empty line can't be left there (the lead's call: saved
// and read back, or not typed there; this is the second). Return where it
// would leave one takes the empty line out of the quote instead, which the
// file holds; one left to type into goes once the cursor leaves it.
test("an empty line can't be left inside a quote or callout: Return takes it out of the quote, where it's saved, and the page reads back the same", async () => {
  const run = await openText("> We met on Friday. We agreed.\n\n> [!note] Plan\n> First line.\n\nAfter.\n");
  const { page } = run;
  // Return twice in the middle of a quote's paragraph: two paragraphs, then an
  // empty line between two quotes. (The space before the cursor stays in the
  // file, and Markdown reads past it.)
  await selectText(page, "We agreed.");
  await page.keyboard.press("ArrowLeft");
  await settle(page);
  await page.keyboard.press("Enter");
  await expectFile(run, "> We met on Friday. \n>\n> We agreed.\n\n> [!note] Plan\n> First line.\n\nAfter.\n");
  await page.keyboard.press("Enter");
  await expectFile(run, "> We met on Friday. \n\n\n> We agreed.\n\n> [!note] Plan\n> First line.\n\nAfter.\n");
  // The cursor stays with the words.
  await page.keyboard.type("Then ");
  await expectFile(run, "> We met on Friday. \n\n\n> Then We agreed.\n\n> [!note] Plan\n> First line.\n\nAfter.\n");

  // Return at the end of a callout's line starts a paragraph in it, to type
  // into; left empty, it goes when the cursor leaves, as the file never had it.
  await cursorAtEnd(page, "First line.");
  await page.keyboard.press("Enter");
  await expect(page.locator(`${EDITOR} blockquote p`)).toHaveCount(4);
  await cursorAtEnd(page, "After.");
  await expect(page.locator(`${EDITOR} blockquote p`)).toHaveCount(3);
  // Return twice there: the empty line is after the callout, and saved.
  await cursorAtEnd(page, "First line.");
  await page.keyboard.press("Enter");
  await page.keyboard.press("Enter");
  await expectFile(run, "> We met on Friday. \n\n\n> Then We agreed.\n\n> [!note] Plan\n> First line.\n\n\nAfter.\n");
  const before = await outline(page);
  expect(before).toEqual(["quote: We met on Friday.", "(empty)", "quote: Then We agreed.", expect.stringContaining("First line."), "(empty)", "After."]);
  await run.app.close();

  const again = await openText(run.text());
  expect(await outline(again.page)).toEqual(before);
  await again.app.close();
});

const SPACED = [
  "# Title",
  "Right under the title.",
  "",
  "One blank line above.",
  "",
  "",
  "Two blank lines above.",
  "",
  "",
  "",
  "Three.",
  "- a",
  "- b",
  "",
].join("\n");

test("each blank line is one empty line of the text's height; blocks written together sit together; numbers change nothing", async () => {
  const run = await openText(SPACED);
  const { page } = run;
  const before = await blocks(page);
  const { line, boxes } = before;
  expect(line).toBeGreaterThan(20);
  const box = (text: string) => boxes.find((b) => b.text === text)!;
  const gap = (a: string, b: string) => box(b).top - box(a).bottom;
  expect(gap("Title", "Right under the title.")).toBeCloseTo(0, 0);
  expect(gap("Right under the title.", "One blank line above.")).toBeCloseTo(line, 0);
  expect(gap("One blank line above.", "Two blank lines above.")).toBeCloseTo(2 * line, 0);
  expect(gap("Two blank lines above.", "Three.")).toBeCloseTo(3 * line, 0);
  expect(gap("Three.", "a")).toBeCloseTo(0, 0);
  // An empty line is one line tall.
  for (const b of boxes.filter((x) => x.tag === "P" && x.text === "")) expect(b.bottom - b.top).toBeCloseTo(line, 0);

  // Every line of the file has a number, and showing them moves nothing.
  await showNumbers(page, run.app);
  expect(await allNumbers(page)).toEqual(Array.from({ length: 13 }, (_, i) => i + 1));
  expect(await blocks(page)).toEqual(before);
  // A blank line's number sits in the middle of its line of space.
  const offBy = await page.evaluate((editor) =>
    [...document.querySelectorAll<HTMLElement>(`${editor} .ln-blank`)].map((n) => {
      const r = n.getBoundingClientRect();
      const prev = n.previousElementSibling!.getBoundingClientRect();
      const line = parseFloat(getComputedStyle(n).getPropertyValue("--line"));
      return Math.abs(r.top + r.height / 2 - (prev.bottom + line / 2));
    }),
  EDITOR);
  expect(offBy.length).toBe(3);
  for (const d of offBy) expect(d).toBeLessThan(1.5);
  await run.app.close();
});

const EVERY_KIND = [
  "---",
  "title: Kinds",
  "---",
  "",
  "# Heading",
  "",
  "A paragraph.",
  "",
  "",
  "- loose a",
  "",
  "- loose b",
  "",
  "> quoted",
  ">",
  "> more",
  "",
  "```js",
  "const a = 1;",
  "```",
  "",
  "| h | i |",
  "|---|---|",
  "| 1 | 2 |",
  "",
  "---",
  "",
  "Last.",
  "",
].join("\n");

test("every line of the file has its number: blank lines, a code block's fences and a table's dashes too, each by its place", async () => {
  const run = await openText(EVERY_KIND);
  const { page } = run;
  const before = await blocks(page);
  await showNumbers(page, run.app);
  expect(await allNumbers(page)).toEqual(Array.from({ length: 28 }, (_, i) => i + 1));
  expect(await blocks(page)).toEqual(before);
  // The fences' numbers sit in the code block's room above and below its code; the dashes', between the table's first two rows.
  const placed = await page.evaluate((editor) => {
    const pre = document.querySelector<HTMLElement>(`${editor} pre.ln-fence`)!;
    const box = pre.getBoundingClientRect();
    const code = pre.querySelector("code")!.getBoundingClientRect();
    const pm = document.querySelector(`${editor} .ProseMirror`)!.getBoundingClientRect();
    const open = getComputedStyle(pre, "::before");
    const close = getComputedStyle(pre, "::after");
    const openMiddle = pm.top + parseFloat(open.top) + parseFloat(open.marginTop) + parseFloat(open.height) / 2;
    const closeMiddle = pm.top + parseFloat(close.top) + parseFloat(close.height) / 2;
    const rows = [...document.querySelectorAll<HTMLElement>(`${editor} tr`)].map((r) => r.getBoundingClientRect());
    const dash = getComputedStyle(document.querySelector<HTMLElement>(`${editor} tr.ln-dash`)!, "::before");
    const dashTop = pm.top + parseFloat(dash.top) + parseFloat(dash.marginTop);
    return {
      open: openMiddle > box.top && openMiddle < code.top,
      close: closeMiddle > code.bottom && closeMiddle < box.bottom,
      // The dashes' number ends above the second row's own, which is level with its words.
      dash: dashTop < rows[1].top && dashTop + parseFloat(dash.height) / 2 > rows[0].top,
    };
  }, EDITOR);
  expect(placed).toEqual({ open: true, close: true, dash: true });
  await run.app.close();
});

// Review R-EL-3: a blank line's number sits between two blocks on the page;
// it mustn't change how the block after it looks (a second footnote got its
// own rule and space above it).
test("showing line numbers moves no block: footnotes and every other kind stay where they were", async () => {
  const run = await openText(EVERY_KIND.replace("Last.\n", "Last.[^1][^2]\n\n[^1]: One.\n\n[^2]: Two.\n\n\n[^3]: Three.\n"));
  const { page } = run;
  const before = await blocks(page);
  expect(before.boxes.filter((b) => b.tag === "DIV").length).toBeGreaterThanOrEqual(3);
  await showNumbers(page, run.app);
  expect(await blocks(page)).toEqual(before);
  await run.app.close();
});

// Review R-EL-10: a paragraph of only Shift-Return line breaks is saved as one
// blank line, so the page shows it one line tall, like any empty line.
test("an empty line with Shift-Return line breaks in it is one line tall, as it's saved", async () => {
  const run = await openText("One.\n\n\nTwo.\n");
  const { page } = run;
  await cursorAtEnd(page, "One.");
  await page.keyboard.press("ArrowDown");
  await settle(page);
  await page.keyboard.press("Shift+Enter");
  await page.keyboard.press("Shift+Enter");
  await expect(page.locator(`${EDITOR} p.empty-line br:not(.ProseMirror-trailingBreak)`)).toHaveCount(2);
  const { line, boxes } = await blocks(page);
  const empty = boxes.find((b) => b.tag === "P" && b.text === "")!;
  expect(empty.bottom - empty.top).toBeCloseTo(line, 0);
  const two = boxes.find((b) => b.text === "Two.")!;
  const one = boxes.find((b) => b.text === "One.")!;
  expect(two.top - one.bottom).toBeCloseTo(2 * line, 0);
  await expectFile(run, "One.\n\n\nTwo.\n");
  await run.app.close();
});

// Review R-EL-8: a comment's words that were a whole paragraph, deleted on the
// page, leave that paragraph empty: an empty line of the document, saved. Its
// coral box is drawn within that line, which stays one line tall.
test("a comment's whole paragraph deleted leaves an empty line, saved, with the comment's box inside its one line", async () => {
  const run = await openText("Keep this.\n\nRemove me.\n\nKeep that.\n");
  const { page } = run;
  await selectText(page, "Remove me.");
  await page.getByRole("button", { name: "Comment", exact: true }).click();
  const box = page.getByRole("textbox", { name: "New comment" });
  await expect(box).toBeFocused();
  await box.fill("Should this go?");
  await page.getByRole("button", { name: "Post" }).click();
  await selectText(page, "Remove me.");
  await page.keyboard.press("Backspace");
  await expectFile(run, "Keep this.\n\n\nKeep that.\n");
  const gap = page.locator(`${EDITOR} p.empty-line .comment-gap.line`);
  await expect(gap).toHaveCount(1);
  const { line, boxes } = await blocks(page);
  const empty = boxes.find((b) => b.tag === "P" && b.text === "")!;
  expect(empty.bottom - empty.top).toBeCloseTo(line, 0);
  const drawn = (await gap.boundingBox())!;
  expect(drawn.y).toBeGreaterThanOrEqual(empty.top - 0.5);
  expect(drawn.y + drawn.height).toBeLessThanOrEqual(empty.bottom + 0.5);
  await run.app.close();
});

test("what follows an empty line sits close under it through a style of its own, not a rule that restyles the whole page on each Return (code review of Batch 16, W16-5)", async () => {
  const run = await openText("First paragraph.\n\nSecond paragraph.\n\n\nThird paragraph.\n");
  const { page } = run;
  // No rule for "whatever follows an empty line": in a long document it made each Return that makes or
  // removes an empty line restyle every block (1.6 to 1.8 times the work of a key, measured).
  const universal = await page.evaluate(() =>
    [...document.styleSheets].flatMap((sheet) => [...sheet.cssRules]).filter((r) => r instanceof CSSStyleRule && /\.empty-line\s*\+\s*\*/.test(r.selectorText)).length,
  );
  expect(universal).toBe(0);
  /** Each block's margin above it, read at once (before the next frame's look at the whole page). */
  const margins = () =>
    page.evaluate((editor) => [...document.querySelectorAll<HTMLElement>(`${editor} .ProseMirror > *`)].map((b) => `${b.textContent || "(empty)"}: ${getComputedStyle(b).marginTop}`), EDITOR);
  const line = await page.evaluate((editor) => getComputedStyle(document.querySelector(`${editor} .ProseMirror`)!).getPropertyValue("--line"), EDITOR);
  expect(await margins()).toEqual(["First paragraph.: 0px", `Second paragraph.: ${line}`, `(empty): ${line}`, "Third paragraph.: 0px"]);
  // Return at the end of the first paragraph: an empty line under it, and the second paragraph close under that, straight away.
  await cursorAtEnd(page, "First paragraph.");
  await page.keyboard.press("Enter");
  expect(await margins()).toEqual(["First paragraph.: 0px", `(empty): ${line}`, "Second paragraph.: 0px", `(empty): ${line}`, "Third paragraph.: 0px"]);
  // A word typed on it: no longer an empty line, and the second paragraph a line below it again.
  await page.keyboard.type("x");
  expect(await margins()).toEqual(["First paragraph.: 0px", `x: ${line}`, `Second paragraph.: ${line}`, `(empty): ${line}`, "Third paragraph.: 0px"]);
  await page.keyboard.press("Backspace");
  expect(await margins()).toEqual(["First paragraph.: 0px", `(empty): ${line}`, "Second paragraph.: 0px", `(empty): ${line}`, "Third paragraph.: 0px"]);
  await settle(page);
  expect(await margins()).toEqual(["First paragraph.: 0px", `(empty): ${line}`, "Second paragraph.: 0px", `(empty): ${line}`, "Third paragraph.: 0px"]);
  await run.app.close();
});
