// Find and replace, in the formatted view and the Markdown view.
import { test, expect, type Page } from "@playwright/test";
import { openText, openAlso, expectFile, cursorAtEnd, settle, clickMenu, selectText, EDITOR } from "./helpers";

const DOC = "# Pets\n\nThe cat sat. A cat ran. Cats nap.\n";

const bar = (page: Page) => page.getByRole("search", { name: "Find in document" });
const findField = (page: Page) => page.getByRole("textbox", { name: "Find", exact: true });
const count = (page: Page) => page.locator(".find-count");

async function find(page: Page, text: string): Promise<void> {
  await page.keyboard.press("Meta+F");
  await findField(page).fill(text);
}

test("Cmd+F opens the find bar, highlights every match and counts them", async () => {
  const run = await openText(DOC);
  await cursorAtEnd(run.page, "Pets", "h1");
  await find(run.page, "cat");
  await expect(bar(run.page)).toBeVisible();
  await expect(count(run.page)).toHaveText("1 of 3");
  await expect(run.page.locator(`${EDITOR} .find-match`)).toHaveCount(3);
  await expect(run.page.locator(`${EDITOR} .find-match.current`)).toHaveCount(1);
  await expect(run.page.locator(`${EDITOR} .find-match.current`)).toHaveText("cat");
  await findField(run.page).fill("dog");
  await expect(count(run.page)).toHaveText("No matches");
  await expect(run.page.locator(`${EDITOR} .find-match`)).toHaveCount(0);
  await run.app.close();
});

/** A box's edges on screen, in whole pixels. */
const edges = (page: Page, selector: string) =>
  page.locator(selector).first().evaluate((e) => {
    const b = e.getBoundingClientRect();
    return { left: Math.round(b.left), right: Math.round(b.right), top: Math.round(b.top), bottom: Math.round(b.bottom) };
  });

test("the find bar spans the page only, like the lines at the top, with the Comments column starting under the toolbar, in either view and on any tab", async () => {
  const run = await openText(DOC, { name: "pets.md" });
  const { page } = run;
  await page.setViewportSize({ width: 1200, height: 800 });
  const PANEL = ".doc:not([hidden]) .comments-panel";
  await expect(page.locator(PANEL)).toBeVisible();
  const toolbarBottom = (await edges(page, ".toolbar")).bottom;
  const BAR = ".doc:not([hidden]) .find-bar";

  await cursorAtEnd(page, "Pets", "h1");
  await find(page, "cat");
  await expect(count(page)).toHaveText("1 of 3");
  const panel = await edges(page, PANEL);
  let b = await edges(page, BAR);
  expect([b.left, b.right, b.top]).toEqual([0, panel.left, toolbarBottom]);
  expect(panel.top).toBe(toolbarBottom);
  // The page starts under it.
  expect((await edges(page, ".doc:not([hidden]) .canvas.with-side")).top).toBe(b.bottom);

  // With Replace showing too, and in the Markdown view.
  await page.keyboard.press("Meta+Alt+F");
  await expect(page.getByRole("textbox", { name: "Replace with" })).toBeVisible();
  await page.getByRole("button", { name: "Markdown", exact: true }).click();
  await expect(page.locator(".doc:not([hidden]) textarea.source")).toBeVisible();
  b = await edges(page, BAR);
  expect([b.left, b.right, b.top]).toEqual([0, (await edges(page, PANEL)).left, toolbarBottom]);
  expect((await edges(page, PANEL)).top).toBe(toolbarBottom);
  expect((await edges(page, ".doc:not([hidden]) .split")).top).toBe(b.bottom);
  await page.getByRole("button", { name: "Formatted", exact: true }).click();

  // Another tab in front: the bar comes with it, searching there, still across its page only.
  await openAlso(run, "dogs.md", "# Dogs\n\nOne cat, two dogs.\n");
  await expect(page.locator(".doc:not([hidden]) .page.editor h1")).toHaveText("Dogs");
  await expect(count(page)).toHaveText("1 match");
  b = await edges(page, BAR);
  // (Two documents bring the tabs above the toolbar.)
  expect([b.left, b.right, b.top]).toEqual([0, (await edges(page, PANEL)).left, (await edges(page, ".toolbar")).bottom]);
  await expect(page.locator(".find-bar")).toHaveCount(1);

  // With the column closed, the whole width.
  await clickMenu(run.app, "view-comments");
  await expect(page.locator(PANEL)).toBeHidden();
  b = await edges(page, BAR);
  expect([b.left, b.right]).toEqual([0, 1200]);
  await run.app.close();
});

// Review of Batch 11, B11R-3: in both views, with the Comments panel shown; Done never on a row of its own.
for (const view of ["Formatted", "Markdown"] as const) {
  test(`in the narrowest window, the find bar fits beside the Comments column, on lines that keep together what belongs together (${view} view)`, async () => {
    const run = await openText(DOC);
    const { page } = run;
    await page.setViewportSize({ width: 560, height: 700 });
    await expect(page.locator(".doc:not([hidden]) .comments-panel")).toBeVisible();
    if (view === "Formatted") await cursorAtEnd(page, "Pets", "h1");
    else {
      await clickMenu(run.app, "view-markdown");
      await page.locator(".doc:not([hidden]) .source").click();
    }
    await page.keyboard.press("Meta+Alt+F");
    await findField(page).fill("cat");
    await expect(count(page)).toHaveText("1 of 3");
    const fit = await page.locator(".find-bar").evaluate((box) => {
      const outer = box.getBoundingClientRect();
      const out = [...box.querySelectorAll("*")].filter((c) => {
        const r = c.getBoundingClientRect();
        return r.width > 0 && (r.left < outer.left - 0.5 || r.right > outer.right + 0.5 || r.top < outer.top - 0.5 || r.bottom > outer.bottom + 0.5);
      });
      const fields = [...box.querySelectorAll("input.find-field")].map((f) => Math.round(f.getBoundingClientRect().width));
      /** Which line each is on, by the middle of its box. */
      const line = (sel: string) => {
        const r = box.querySelector(sel)!.getBoundingClientRect();
        return Math.round((r.top + r.bottom) / 2);
      };
      const lines = [
        ['input[name="find"]', ".find-count", ".find-steps"],
        [".find-option", ".find-done"],
        ['input[name="replace"]', ".find-replace", ".find-replace-all"],
      ].map((group) => new Set(group.map(line)).size === 1);
      return { out: out.map((c) => c.className), wide: box.scrollWidth > box.clientWidth, fields, width: Math.round(outer.width), lines };
    });
    expect(fit.width).toBeLessThan(330);
    expect(fit.out).toEqual([]);
    expect(fit.wide).toBe(false);
    // The boxes are wide enough to read "Replace with" in full.
    for (const w of fit.fields) expect(w).toBeGreaterThanOrEqual(96);
    // The box with its count and arrows; Match case with Done; the replace box with its buttons.
    expect(fit.lines).toEqual([true, true, true]);
    // Every button can be used.
    for (const name of ["Previous match", "Next match", "Done", "Replace", "Replace all"]) {
      await expect(bar(page).getByRole("button", { name, exact: true })).toBeInViewport({ ratio: 1 });
    }
    // Wider, up to a window of 1000: the find box gives up its room before anything goes onto another line, and
    // when something must, Match case and Done go together: Done is never on a row of its own (B11R-3).
    for (let width = 560; width <= 1000; width += 20) {
      await page.setViewportSize({ width, height: 700 });
      const at = await page.locator(".find-bar").evaluate(async (box) => {
        await new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve)));
        const mid = (sel: string) => {
          const r = box.querySelector(sel)!.getBoundingClientRect();
          return (r.top + r.bottom) / 2;
        };
        const fields = [...box.querySelectorAll("input.find-field")].map((f) => Math.round(f.getBoundingClientRect().width));
        return { find: mid('input[name="find"]'), option: mid(".find-option"), done: mid(".find-done"), bar: box.getBoundingClientRect().width, fields, wide: box.scrollWidth > box.clientWidth };
      });
      expect(Math.abs(at.done - at.option), `Match case and Done at ${width}`).toBeLessThanOrEqual(2);
      if (at.bar >= 446) expect(Math.abs(at.done - at.find), `one row at ${width}`).toBeLessThanOrEqual(2);
      for (const w of at.fields) expect(w, `the boxes at ${width}`).toBeGreaterThanOrEqual(96);
      expect(at.wide).toBe(false);
    }
    await run.app.close();
  });
}

test("Enter and Cmd+G go to the next match, Shift+Enter and Cmd+Shift+G go back, and both wrap round", async () => {
  const run = await openText(DOC);
  await cursorAtEnd(run.page, "Pets", "h1");
  await find(run.page, "cat");
  await expect(count(run.page)).toHaveText("1 of 3");
  await run.page.keyboard.press("Enter");
  await expect(count(run.page)).toHaveText("2 of 3");
  await run.page.keyboard.press("Enter");
  await expect(count(run.page)).toHaveText("3 of 3");
  await run.page.keyboard.press("Enter");
  await expect(count(run.page)).toHaveText("1 of 3");
  await run.page.keyboard.press("Shift+Enter");
  await expect(count(run.page)).toHaveText("3 of 3");
  await run.page.keyboard.press("Meta+G");
  await expect(count(run.page)).toHaveText("1 of 3");
  await run.page.keyboard.press("Meta+Shift+G");
  await expect(count(run.page)).toHaveText("3 of 3");
  await run.page.getByRole("button", { name: "Previous match" }).click();
  await expect(count(run.page)).toHaveText("2 of 3");
  await run.page.getByRole("button", { name: "Next match" }).click();
  await expect(count(run.page)).toHaveText("3 of 3");
  await run.app.close();
});

test("Escape closes the find bar and leaves the match selected", async () => {
  const run = await openText(DOC);
  await cursorAtEnd(run.page, "Pets", "h1");
  await find(run.page, "ran");
  await expect(count(run.page)).toHaveText("1 of 1");
  await run.page.keyboard.press("Escape");
  await expect(bar(run.page)).toBeHidden();
  await expect(run.page.locator(`${EDITOR} .find-match`)).toHaveCount(0);
  await settle(run.page);
  // Typing replaces the selected match.
  await run.page.keyboard.type("walked");
  await expectFile(run, DOC.replace("ran", "walked"));
  await run.app.close();
});

test("Replace changes the current match and moves on to the next", async () => {
  const run = await openText(DOC);
  await cursorAtEnd(run.page, "Pets", "h1");
  await run.page.keyboard.press("Meta+Alt+F");
  await findField(run.page).fill("cat");
  await run.page.getByRole("textbox", { name: "Replace with" }).fill("dog");
  await run.page.getByRole("button", { name: "Replace", exact: true }).click();
  await expectFile(run, "# Pets\n\nThe dog sat. A cat ran. Cats nap.\n");
  await expect(count(run.page)).toHaveText("1 of 2");
  await run.page.getByRole("button", { name: "Replace", exact: true }).click();
  await expectFile(run, "# Pets\n\nThe dog sat. A dog ran. Cats nap.\n");
  await run.app.close();
});

test("Replace All changes every match at once, and one Undo puts them all back", async () => {
  const run = await openText(DOC);
  await cursorAtEnd(run.page, "Pets", "h1");
  await run.page.keyboard.press("Meta+Alt+F");
  await findField(run.page).fill("cat");
  await run.page.getByRole("textbox", { name: "Replace with" }).fill("dog");
  await run.page.getByRole("button", { name: "Replace all" }).click();
  await expectFile(run, "# Pets\n\nThe dog sat. A dog ran. dogs nap.\n");
  await expect(count(run.page)).toHaveText("Replaced 3");
  await run.page.getByRole("button", { name: "Undo" }).click();
  await expectFile(run, DOC);
  await run.app.close();
});

test("Match case finds only the same capitals", async () => {
  const run = await openText(DOC);
  await cursorAtEnd(run.page, "Pets", "h1");
  await find(run.page, "Cat");
  await expect(count(run.page)).toHaveText("1 of 3");
  await run.page.getByRole("checkbox", { name: "Match case" }).check();
  await expect(count(run.page)).toHaveText("1 of 1");
  await expect(run.page.locator(`${EDITOR} .find-match.current`)).toHaveText("Cat");
  await run.app.close();
});

test("find skips formatting and finds words across bold and links", async () => {
  const run = await openText("A **big** [red](https://example.com) door.\n");
  await cursorAtEnd(run.page, "door");
  await find(run.page, "big red");
  await expect(count(run.page)).toHaveText("1 of 1");
  await run.app.close();
});

test("the Edit menu's Find items open the bar and step through matches", async () => {
  const run = await openText(DOC);
  await cursorAtEnd(run.page, "Pets", "h1");
  await clickMenu(run.app, "find");
  await expect(bar(run.page)).toBeVisible();
  await expect(run.page.getByRole("textbox", { name: "Replace with" })).toBeHidden();
  await findField(run.page).fill("cat");
  await clickMenu(run.app, "find-next");
  await expect(count(run.page)).toHaveText("2 of 3");
  await clickMenu(run.app, "find-previous");
  await expect(count(run.page)).toHaveText("1 of 3");
  await clickMenu(run.app, "find-replace");
  await expect(run.page.getByRole("textbox", { name: "Replace with" })).toBeVisible();
  await run.app.close();
});

test("selected words fill the find box when the bar opens", async () => {
  const run = await openText(DOC);
  await cursorAtEnd(run.page, "The cat sat");
  await run.page.keyboard.press("Alt+Shift+ArrowLeft"); // "."
  await run.page.keyboard.press("Alt+Shift+ArrowLeft"); // "nap."
  await settle(run.page);
  await run.page.keyboard.press("Meta+F");
  await expect(findField(run.page)).toHaveValue("nap.");
  await expect(count(run.page)).toHaveText("1 of 1");
  await run.app.close();
});

test("the count follows edits made while the bar is open", async () => {
  const run = await openText(DOC);
  await cursorAtEnd(run.page, "The cat sat");
  await find(run.page, "cat");
  await expect(count(run.page)).toHaveText("1 of 3"); // from the end, it wraps round to the first
  await run.page.locator(`${EDITOR} p`).click();
  await settle(run.page);
  await run.page.keyboard.press("Meta+ArrowRight");
  await run.page.keyboard.type(" One more cat.");
  await expect(count(run.page)).toHaveText("4 matches");
  await run.app.close();
});

test("find and replace work in the Markdown view too", async () => {
  const run = await openText(DOC);
  await run.page.getByRole("button", { name: "Markdown" }).click();
  const source = run.page.getByRole("textbox", { name: "Markdown text" });
  await source.click();
  await source.press("Meta+ArrowUp");
  await settle(run.page);
  await find(run.page, "cat");
  await expect(count(run.page)).toHaveText("1 of 3");
  await expect(run.page.locator(".find-marks mark")).toHaveCount(3);
  await expect(run.page.locator(".find-marks mark.current")).toHaveText("cat");
  await run.page.keyboard.press("Enter");
  await expect(count(run.page)).toHaveText("2 of 3");
  await run.page.keyboard.press("Escape");
  await expect(run.page.locator(".find-marks")).toBeHidden();
  await settle(run.page);
  await run.page.keyboard.type("dog");
  await expectFile(run, "# Pets\n\nThe cat sat. A dog ran. Cats nap.\n");

  await run.page.keyboard.press("Meta+Alt+F");
  await findField(run.page).fill("cat");
  await run.page.getByRole("textbox", { name: "Replace with" }).fill("bird");
  await run.page.getByRole("button", { name: "Replace all" }).click();
  await expectFile(run, "# Pets\n\nThe bird sat. A dog ran. birds nap.\n");
  await expect(count(run.page)).toHaveText("Replaced 2");
  // One undo takes back the whole Replace All (the text's own Undo, with the keyboard back in it).
  await run.page.keyboard.press("Escape");
  await settle(run.page);
  await expect(source).toBeFocused();
  await run.page.keyboard.press("Meta+z");
  await expectFile(run, "# Pets\n\nThe cat sat. A dog ran. Cats nap.\n");
  await run.app.close();
});

test("find is quick in a 30,000-word document", async () => {
  // 600 paragraphs of 50 words, each with "cat" five times: 3,000 matches.
  const paragraph = (n: number) =>
    `Paragraph ${n} cat ` +
    Array.from({ length: 4 }, () => "the cat sat on a warm mat by the door").join(" ") +
    " and nine more words to make fifty here.";
  const run = await openText(Array.from({ length: 600 }, (_, i) => paragraph(i + 1)).join("\n\n") + "\n");
  await cursorAtEnd(run.page, "Paragraph 1 cat");
  await run.page.keyboard.press("Meta+F");
  const took = await run.page.evaluate(() => {
    const field = document.querySelector<HTMLInputElement>('.find-bar input[name="find"]')!;
    const start = performance.now();
    field.value = "cat";
    field.dispatchEvent(new Event("input"));
    return performance.now() - start;
  });
  await expect(count(run.page)).toHaveText("6 of 3,000"); // the first match after the cursor, at the end of paragraph 1
  expect(took).toBeLessThan(1000);
  // With this many matches only the current one is highlighted, to keep scrolling smooth.
  await expect(run.page.locator(`${EDITOR} .find-match`)).toHaveCount(1);
  await run.page.keyboard.press("Enter");
  await expect(count(run.page)).toHaveText("7 of 3,000");
  await run.app.close();
});

test("Replace All changes nothing while the document can't be edited", async () => {
  const run = await openText(DOC);
  await run.page.getByRole("button", { name: "Markdown" }).click();
  const source = run.page.getByRole("textbox", { name: "Markdown text" });
  await source.evaluate((el: HTMLTextAreaElement) => (el.readOnly = true)); // as while an agent is editing
  await run.page.keyboard.press("Meta+Alt+F");
  await findField(run.page).fill("cat");
  await run.page.getByRole("textbox", { name: "Replace with" }).fill("dog");
  await run.page.getByRole("button", { name: "Replace all" }).click();
  await expect(count(run.page)).toHaveText("1 of 3");
  await run.page.waitForTimeout(700);
  expect(run.text()).toBe(DOC);
  await run.app.close();
});

/** The find highlights drawn on the earlier version's page: the other matches, and the current one. */
const versionHighlights = (page: Page) =>
  page.evaluate(() => {
    const page = document.querySelector(".doc:not([hidden]) .version-view .version-page")!;
    const ranges = (name: string) => [...((CSS.highlights.get(name) as Set<AbstractRange> | undefined) ?? [])] as Range[];
    const onPage = (r: Range) => page.contains(r.startContainer);
    return {
      others: ranges("find-match").filter(onPage).map((r) => r.toString()),
      current: ranges("find-current").filter(onPage).map((r) => r.toString()),
    };
  });

test("Find searches the earlier version on screen, read-only: Replace and Replace All change nothing until back to the current version", async () => {
  const run = await openText("Plan.\n\nOld budget words.\n");
  await cursorAtEnd(run.page, "Old budget words.");
  await run.page.keyboard.type(" New budget. Budget again.");
  const current = "Plan.\n\nOld budget words. New budget. Budget again.\n";
  await expectFile(run, current);
  await run.page.getByRole("button", { name: "History", exact: true }).click();
  await run.page.locator(".doc:not([hidden]) .history-panel .history-item").filter({ hasText: "First version" }).click();
  await expect(run.page.locator(".doc:not([hidden]) .version-view .ProseMirror")).toContainText("Old budget words.");
  await expect(run.page.locator(".doc:not([hidden]) .version-view .ProseMirror")).not.toContainText("New budget");

  await clickMenu(run.app, "find-replace");
  await findField(run.page).fill("budget");
  // The count and the highlights are for the version on screen: one "budget", not the current three.
  await expect(count(run.page)).toHaveText("1 of 1");
  await expect.poll(() => versionHighlights(run.page)).toEqual({ others: [], current: ["budget"] });
  await expect(run.page.locator(`${EDITOR} .find-match`)).toHaveCount(0);

  // Nothing on screen can be changed, and nothing hidden is.
  await run.page.getByRole("textbox", { name: "Replace with" }).fill("cost");
  await expect(run.page.getByRole("button", { name: "Replace all" })).toBeDisabled();
  await expect(run.page.getByRole("button", { name: "Replace", exact: true })).toBeDisabled();
  await run.page.getByRole("textbox", { name: "Replace with" }).press("Enter");
  await run.page.waitForTimeout(700);
  expect(run.text()).toBe(current);

  // Back to the current version: Find searches it, and Replace works again.
  await run.page.getByRole("button", { name: "Back to current" }).click();
  await expect(run.page.locator(EDITOR)).toBeVisible();
  await expect(count(run.page)).toHaveText(/3/);
  await expect.poll(() => versionHighlights(run.page)).toEqual({ others: [], current: [] });
  await expect(run.page.getByRole("button", { name: "Replace all" })).toBeEnabled();
  await run.page.getByRole("button", { name: "Replace all" }).click();
  await expectFile(run, "Plan.\n\nOld cost words. New cost. cost again.\n");
  await run.app.close();
});

test("with Show changes on, Find counts what's on screen and Replace All changes nothing", async () => {
  const run = await openText("One cat.\n");
  await cursorAtEnd(run.page, "One cat.");
  await run.page.keyboard.type(" Two cats.");
  await expectFile(run, "One cat. Two cats.\n");
  await run.page.locator("#toolbar").getByRole("button", { name: "Show changes" }).click();
  await expect(run.page.locator(".doc:not([hidden]) .version-view .ProseMirror")).toBeVisible();
  await clickMenu(run.app, "find-replace");
  await findField(run.page).fill("cat");
  await expect(count(run.page)).toHaveText("1 of 2");
  await expect.poll(() => versionHighlights(run.page)).toEqual({ others: ["cat"], current: ["cat"] });
  await expect(run.page.getByRole("button", { name: "Replace all" })).toBeDisabled();
  await run.page.waitForTimeout(700);
  expect(run.text()).toBe("One cat. Two cats.\n");
  await run.app.close();
});

test("Replace All of 10,000 matches, and its Undo, keep the window responsive", async () => {
  test.setTimeout(60_000);
  const run = await openText(Array.from({ length: 2000 }, (_, i) => `Line ${i + 1}: a cat, a cat, a cat, a cat and a cat.`).join("\n\n") + "\n");
  await cursorAtEnd(run.page, "Line 1:");
  await run.page.keyboard.press("Meta+Alt+F");
  await findField(run.page).fill("cat");
  await expect(count(run.page)).toHaveText(/10,000/);
  await run.page.getByRole("textbox", { name: "Replace with" }).fill("dog");
  const took = await run.page.evaluate(() => {
    const start = performance.now();
    document.querySelector<HTMLButtonElement>(".find-replace-all")!.click();
    return performance.now() - start;
  });
  await expect(count(run.page)).toHaveText("Replaced 10,000");
  const undoTook = await run.page.evaluate(() => {
    const editor = document.querySelector<HTMLElement>(".doc:not([hidden]) .page.editor .ProseMirror")!;
    editor.focus();
    const start = performance.now();
    editor.dispatchEvent(new KeyboardEvent("keydown", { key: "z", code: "KeyZ", metaKey: true, bubbles: true, cancelable: true }));
    return performance.now() - start;
  });
  console.log(`Replace All of 10,000 matches: ${took.toFixed(0)} ms; Undo: ${undoTook.toFixed(0)} ms`);
  await expect(run.page.locator(EDITOR)).toContainText("Line 2000: a cat");
  expect(took).toBeLessThan(600);
  expect(undoTook).toBeLessThan(600);
  await run.app.close();
});

test("Replace All of 10,000 matches stays as quick with a comment whose words were deleted", async () => {
  test.setTimeout(60_000);
  const lines = Array.from({ length: 2000 }, (_, i) => `Line ${i + 1}: a cat, a cat, a cat, a cat and a cat.`);
  const run = await openText(`We keep pets.\n\n${lines.join("\n\n")}\n`);
  const { page } = run;
  await selectText(page, "pets");
  await page.getByRole("button", { name: "Comment", exact: true }).click();
  await page.getByRole("textbox", { name: "New comment" }).fill("Which ones?");
  await page.getByRole("button", { name: "Post" }).click();
  await expect(page.locator(".doc:not([hidden]) aside.comments-panel .comment-card:not(.draft)", { hasText: "Which ones?" })).toBeVisible();
  // Its words deleted: an empty line holds their place, and anything put in is checked for them.
  await selectText(page, "pets");
  await page.keyboard.press("Backspace");
  await expect(page.locator(`${EDITOR} .comment-gap`)).toHaveCount(1);
  await page.keyboard.press("Meta+Alt+F");
  await findField(page).fill("cat");
  await expect(count(page)).toHaveText(/10,000/);
  // As long as the deleted words, so each replacement could hold them.
  await page.getByRole("textbox", { name: "Replace with" }).fill("kitty");
  const took = await page.evaluate(() => {
    const start = performance.now();
    document.querySelector<HTMLButtonElement>(".find-replace-all")!.click();
    return performance.now() - start;
  });
  await expect(count(page)).toHaveText("Replaced 10,000");
  console.log(`Replace All of 10,000 matches with a deleted comment's words: ${took.toFixed(0)} ms`);
  await expect(page.locator(`${EDITOR} .comment-gap`)).toHaveCount(1);
  expect(took).toBeLessThan(600);
  await run.app.close();
});

test("Replace All of three times as many matches, and its Undo, take about three times as long, not more", async () => {
  test.setTimeout(180_000);
  // Ten matches to a line: the page's own update of each changed line grows
  // a little with the document's length (in the editor's libraries, not in
  // Replace All), so long lines keep that out of the timing.
  const lines = (n: number) => Array.from({ length: n }, (_, i) => `Line ${i + 1}: ${"a cat, ".repeat(9)}and a cat.`).join("\n\n") + "\n";
  const run = await openText(lines(1000));
  const { page } = run;
  /** The quickest of three rounds of Replace All of "cat" in the document in front, and of three of its Undo. */
  const quickest = async (matches: string) => {
    await cursorAtEnd(page, "Line 1:");
    await page.keyboard.press("Meta+Alt+F");
    await page.getByRole("textbox", { name: "Replace with" }).fill("dog");
    const took = { replace: Infinity, undo: Infinity };
    for (let round = 0; round < 3; round++) {
      // Found afresh, so the timing is Replace All's alone.
      await findField(page).fill("");
      await findField(page).fill("cat");
      await expect(count(page)).toHaveText(new RegExp(`(^| of )${matches}`));
      const replace = await page.evaluate(() => {
        const start = performance.now();
        document.querySelector<HTMLButtonElement>(".doc:not([hidden]) .find-replace-all")!.click();
        return performance.now() - start;
      });
      await expect(count(page)).toHaveText(`Replaced ${matches}`);
      const undo = await page.evaluate(() => {
        const editor = document.querySelector<HTMLElement>(".doc:not([hidden]) .page.editor .ProseMirror")!;
        editor.focus();
        const start = performance.now();
        editor.dispatchEvent(new KeyboardEvent("keydown", { key: "z", code: "KeyZ", metaKey: true, bubbles: true, cancelable: true }));
        return performance.now() - start;
      });
      await expect(page.locator(EDITOR)).toContainText("Line 1: a cat");
      took.replace = Math.min(took.replace, replace);
      took.undo = Math.min(took.undo, undo);
    }
    return took;
  };
  const fewer = await quickest("10,000");
  await openAlso(run, "three times as long.md", lines(3000));
  await expect(page.locator(EDITOR)).toContainText("Line 3000:");
  const more = await quickest("30,000");
  console.log(
    `Replace All of 10,000 and 30,000 matches: ${fewer.replace.toFixed(0)} and ${more.replace.toFixed(0)} ms; ` +
      `Undo: ${fewer.undo.toFixed(0)} and ${more.undo.toFixed(0)} ms`,
  );
  // In step with the matches: three times as many take about three times as
  // long. A step for each match took about nine times (each step rebuilt the
  // document's list of blocks).
  expect(more.replace / fewer.replace).toBeLessThan(5);
  expect(more.undo / fewer.undo).toBeLessThan(5);
  await run.app.close();
});

for (const view of ["Formatted", "Markdown"] as const) {
  test(`Replace All in the ${view} view keeps a comment on its words, replaced words included`, async () => {
    const run = await openText("We plan the Q3 budget now.\n\nThe Q3 goals and Q3 hires come later.\n");
    await selectText(run.page, "the Q3 budget");
    await run.page.getByRole("button", { name: "Comment", exact: true }).click();
    await run.page.getByRole("textbox", { name: "New comment" }).fill("Is this final?");
    await run.page.getByRole("button", { name: "Post" }).click();
    const card = run.page.locator(".doc:not([hidden]) aside.comments-panel .comment-card:not(.draft)", { hasText: "Is this final?" });
    await expect(card).toBeVisible();
    if (view === "Markdown") {
      await run.page.getByRole("button", { name: "Markdown", exact: true }).click();
      await expect(run.page.locator(".doc:not([hidden]) textarea.source")).toBeVisible();
    }
    await run.page.keyboard.press("Meta+Alt+F");
    await findField(run.page).fill("Q3");
    await run.page.getByRole("textbox", { name: "Replace with" }).fill("Q4");
    await run.page.getByRole("button", { name: "Replace all" }).click();
    await expect(count(run.page)).toHaveText("Replaced 3");
    await expectFile(run, "We plan the Q4 budget now.\n\nThe Q4 goals and Q4 hires come later.\n");
    if (view === "Markdown") {
      await expect.poll(() => run.page.locator(".doc:not([hidden]) .source-marks mark").allTextContents()).toEqual(["the Q4 budget"]);
      await run.page.getByRole("button", { name: "Formatted", exact: true }).click();
    }
    await expect.poll(() => run.page.locator(`${EDITOR} .comment-range`).allTextContents()).toEqual(["the Q4 budget"]);
    await expect(card).not.toContainText(/changed|can't find/i);
    await run.app.close();
  });
}
