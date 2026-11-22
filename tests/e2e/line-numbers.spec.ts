// View > Line Numbers: beside the text, the Markdown file's own line numbers,
// the ones an agent reading the file sees, so "line 42" means the same to the
// person and the agent. In both views, kept up to date through every kind of
// change, remembered between launches, and never part of the text.
import { test, expect, type Page } from "@playwright/test";
import { statSync, writeFileSync } from "node:fs";
import { AgentSession } from "./agent-session";
import { openText, openAlso, clickMenu, cursorAtEnd, expectFile, settle, selectText, captureClipboardWrites, copySelection, EDITOR, type Running } from "./helpers";

const SAMPLE = [
  "---",
  "title: Sample",
  "---",
  "",
  "# Heading one",
  "",
  "A paragraph long enough to wrap onto several lines of the page, so its number has to stay beside the first of them, however the window is sized.",
  "And a second line of it, wrapped by hand.",
  "",
  "- Item one",
  "- Item two",
  "  - Nested",
  "1. First",
  "",
  "> A quote",
  "",
  "| a | b |",
  "|---|--:|",
  "| 1 | 2 |",
  "| 3 | 4 |",
  "",
  "```js",
  "const a = 1;",
  "const b = 2;",
  "```",
  "",
  "---",
  "",
  "Text with a note.[^1]",
  "",
  "```mermaid",
  "graph LR",
  "  A --> B",
  "```",
  "",
  "<div>html</div>",
  "",
  "[^1]: The note.",
  "",
].join("\n");

/** The numbers on screen in the formatted view, in order, each with the start of the text beside it. */
function numbersShown(page: Page): Promise<{ line: number; text: string }[]> {
  return page.evaluate((editor) => {
    const out: { line: number; text: string }[] = [];
    for (const el of document.querySelectorAll<HTMLElement>(`${editor} .ln, ${editor} .ln-line`)) {
      if (!el.checkVisibility()) continue;
      let text: string;
      if (el.classList.contains("ln-line")) {
        // A number inside a block's text: the words after it, to the end of the line.
        const after = document.createRange();
        after.setStartAfter(el);
        after.setEnd(el.parentElement!, el.parentElement!.childNodes.length);
        text = after.toString().split("\n")[0];
      } else if (el.tagName === "TR") text = (el.querySelector("th, td") as HTMLElement).innerText;
      else if (el.classList.contains("ln-fence")) text = "```"; // a code block's number is its opening fence's

      else if (el.classList.contains("ln-rule")) text = "---";
      else if (el.classList.contains("diagram")) text = "```mermaid";
      else text = el.innerText.split("\n")[0];
      out.push({ line: Number(el.dataset.ln), text: text.slice(0, 24) });
    }
    return out;
  }, EDITOR);
}

/** Each number names the file line its text starts on, and they go down the page in order. */
async function expectNumbersMatchFile(page: Page, file: string): Promise<void> {
  const lines = file.split("\n");
  const shown = await numbersShown(page);
  expect(shown.length).toBeGreaterThan(0);
  for (const { line, text } of shown) expect(lines[line - 1], `line ${line}`).toContain(text.trim().slice(0, 12));
  const order = shown.map((s) => s.line);
  expect(order).toEqual([...order].sort((a, b) => a - b));
}

const showNumbers = async (run: Running) => {
  await clickMenu(run.app, "line-numbers");
  await expect(run.page.locator(`${EDITOR} .ln`).first()).toBeVisible();
};

const menuChecked = (run: Running) =>
  run.app.evaluate(({ Menu }) => Menu.getApplicationMenu()!.getMenuItemById("line-numbers")!.checked);

/** Where each block of the page is: line numbers mustn't move any of them. */
function blockBoxes(page: Page): Promise<string[]> {
  return page.evaluate((editor) =>
    [...document.querySelectorAll(`${editor} .ProseMirror > :not(.ln-blank), ${editor} li, ${editor} th, ${editor} td, ${editor} pre code`)].map((el) => {
      const r = el.getBoundingClientRect();
      return `${el.tagName} ${r.left},${r.top},${r.width},${r.height}`;
    }),
  EDITOR);
}

test("View > Line Numbers puts the file's line numbers beside each block, level with its first line, without moving the text", async () => {
  const run = await openText(SAMPLE);
  const { page } = run;
  expect(await menuChecked(run)).toBe(false);
  await expect(page.locator(`${EDITOR} .ln`)).toHaveCount(0);
  await expect(page.locator(`${EDITOR} .diagram-picture svg`)).toBeVisible({ timeout: 15_000 }); // drawn, so its size is settled
  const before = await blockBoxes(page);

  await showNumbers(run);
  expect(await menuChecked(run)).toBe(true);
  expect(await numbersShown(page)).toEqual([
    { line: 1, text: "---" },
    { line: 2, text: "title: Sample" },
    { line: 3, text: "---" },
    { line: 5, text: "Heading one" },
    { line: 7, text: "A paragraph long enough " },
    { line: 8, text: "And a second line of it," },
    { line: 10, text: "Item one" },
    { line: 11, text: "Item two" },
    { line: 12, text: "Nested" },
    { line: 13, text: "First" },
    { line: 15, text: "A quote" },
    { line: 17, text: "a" },
    { line: 19, text: "1" },
    { line: 20, text: "3" },
    { line: 22, text: "```" },
    { line: 23, text: "const a = 1;" },
    { line: 24, text: "const b = 2;" },
    { line: 27, text: "---" },
    { line: 29, text: "Text with a note." },
    { line: 31, text: "```mermaid" },
    { line: 36, text: "<div>html</div>" },
    { line: 38, text: "The note." },
  ]);
  await expectNumbersMatchFile(page, SAMPLE);
  expect(await blockBoxes(page)).toEqual(before);

  // Each number is small, in the page's left margin, and level with the middle of its block's first line, 24 pixels
  // from it on a page with its full margins (roadmap Batch 9, item 12; it was 16).
  const placed = await page.evaluate((editor) => {
    const text = document.querySelector(`${editor} .ProseMirror`)!.getBoundingClientRect();
    return [...document.querySelectorAll<HTMLElement>(`${editor} p.ln, ${editor} h1.ln, ${editor} tr.ln`)].map((el) => {
      const number = getComputedStyle(el, "::before");
      const first = document.createRange();
      const words = document.createTreeWalker(el, NodeFilter.SHOW_TEXT).nextNode()!;
      first.setStart(words, 0);
      first.setEnd(words, 1);
      const glyph = first.getBoundingClientRect();
      // A table's first body row shows the dashes' number above its own (two lines): its own is the lower one.
      const middle = el.classList.contains("ln-dash") ? 0.75 : 0.5;
      return {
        line: el.dataset.ln,
        size: number.fontSize,
        offBy: Math.abs(parseFloat(number.top) + parseFloat(number.marginTop) + parseFloat(number.height) * middle - (glyph.top - text.top + glyph.height / 2)),
        gap: -(parseFloat(number.left) + parseFloat(number.width)),
      };
    });
  }, EDITOR);
  expect(placed).toHaveLength(11);
  for (const p of placed) {
    expect(p.size, `line ${p.line}`).toBe("11px");
    expect(p.offBy, `line ${p.line}`).toBeLessThan(2);
    expect(p.gap, `line ${p.line}`).toBeCloseTo(24, 1);
  }

  // A diagram's code, once shown, has its lines numbered too.
  await page.locator(`${EDITOR} .diagram`).hover();
  await page.locator(`${EDITOR} .diagram-toggle`).click();
  await expect(page.locator(`${EDITOR} .diagram .ln-line`).first()).toBeVisible();
  expect((await numbersShown(page)).filter((n) => n.line >= 31 && n.line <= 34)).toEqual([
    { line: 31, text: "```mermaid" },
    { line: 32, text: "graph LR" },
    { line: 33, text: "  A --> B" },
  ]);

  // And off again.
  await clickMenu(run.app, "line-numbers");
  await expect(page.locator(`${EDITOR} :is(.ln, .ln-line, .ln-blank, .ln-end, .ln-dash)`)).toHaveCount(0);
  expect(await menuChecked(run)).toBe(false);
  await run.app.close();
});

// Orlando, 2026-11-09
test("in a poem, or any paragraph written line by line, every line has its number, level with it", async () => {
  const POEM = [
    "# November",
    "",
    "The maples gave up their last argument with the wind,",
    "Now the yard is a ledger of everything let go,",
    "paid out in rust and amber,",
    "the wind keeps records nobody reads.",
    "",
    "Dark comes early, dark comes hungry,",
    "At half past four the lamps come on.",
    "",
  ].join("\n");
  const run = await openText(POEM);
  const { page } = run;
  await showNumbers(run);
  expect((await numbersShown(page)).map((n) => n.line)).toEqual([1, 3, 4, 5, 6, 8, 9]);
  await expectNumbersMatchFile(page, POEM);
  // Each number sits level with its own line.
  const offBy = await page.evaluate((editor) =>
    [...document.querySelectorAll<HTMLElement>(`${editor} p .ln-line`)].map((n) => {
      const number = n.getBoundingClientRect();
      const words = document.createRange();
      words.setStartAfter(n);
      words.setEnd(n.parentElement!, n.parentElement!.childNodes.length);
      const line = words.getClientRects()[0];
      return Math.abs(number.top + number.height / 2 - (line.top + line.height / 2));
    }),
  EDITOR);
  expect(offBy).toHaveLength(4);
  for (const d of offBy) expect(d).toBeLessThan(2);
  // A line broken only by the window's width has no number of its own.
  await page.setViewportSize({ width: 700, height: 800 });
  await page.waitForTimeout(200);
  expect((await numbersShown(page)).map((n) => n.line)).toEqual([1, 3, 4, 5, 6, 8, 9]);
  await run.app.close();
});

const NOTES = "# Notes\n\nFirst paragraph here.\n\nSecond paragraph.\n\n- one\n- two\n\nLast line.\n";

test("the numbers follow typing, a new paragraph, undo, an agent's change and a change made outside Corillo", async () => {
  const run = await openText(NOTES);
  const { page } = run;
  await showNumbers(run);
  const lines = async () => (await numbersShown(page)).map((n) => n.line);
  expect(await lines()).toEqual([1, 3, 5, 7, 8, 10]);

  await cursorAtEnd(page, "First paragraph here.");
  await page.keyboard.press("Enter");
  await page.keyboard.type("Inserted.");
  await expect.poll(lines).toEqual([1, 3, 5, 7, 9, 10, 12]);
  const typed = NOTES.replace("First paragraph here.\n", "First paragraph here.\n\nInserted.\n");
  await expectFile(run, typed);
  await expectNumbersMatchFile(page, typed);

  // Two lines in one paragraph (Shift-Return): the new line has its own number, and everything below moves down a line.
  await page.keyboard.press("Shift+Enter");
  await page.keyboard.type("More.");
  await expect.poll(lines).toEqual([1, 3, 5, 6, 8, 10, 11, 13]);
  await expectNumbersMatchFile(page, await expectFileChanged(run, typed));

  await page.keyboard.press("Meta+z");
  await page.keyboard.press("Meta+z");
  await expect.poll(lines).toEqual([1, 3, 5, 7, 8, 10]);
  await expectFile(run, NOTES);

  // An agent adds a paragraph written on two lines near the top.
  const { session } = await AgentSession.start(run.dataDir);
  await session.ok("take_document", { path: run.file });
  await session.ok("edit_document", {
    path: run.file,
    edits: [{ find: "# Notes\n", replace: "# Notes\n\nA new first paragraph,\nwritten on two lines.\n" }],
  });
  await session.ok("finish_editing", { path: run.file });
  await session.stop();
  await expect.poll(lines).toEqual([1, 3, 4, 6, 8, 10, 11, 13]);
  await expectNumbersMatchFile(page, run.text());

  // Another app rewrites the file.
  const outside = "Just one line now.\n\n\n\nAnd this, far below.\n";
  writeFileSync(run.file, outside);
  // Each blank line beyond the one between them is an empty line, with its own number.
  await expect.poll(lines).toEqual([1, 3, 4, 5]);
  await expectNumbersMatchFile(page, outside);
  await run.app.close();
});

/** Wait for the file to change from this text, and give the new text. */
async function expectFileChanged(run: Running, from: string): Promise<string> {
  await expect.poll(run.text).not.toBe(from);
  await settleSave(run);
  return run.text();
}

/** Let an autosave that's under way finish. */
async function settleSave(run: Running): Promise<void> {
  await expect(run.page.locator("#save-status")).toHaveText("Saved");
}

const longLine = (i: number) => `Line ${i} is a long one that goes on and on, ${"so that it wraps in the text area ".repeat(4)}end.`;
const MARKDOWN = Array.from({ length: 160 }, (_, i) => (i % 9 === 4 ? longLine(i + 1) : i % 7 === 3 ? "" : `Line ${i + 1}`)).join("\n") + "\n";

/** For the Markdown view: is the numbers' copy of the text laid out exactly like the text, and level with it? */
function gutterLevel(page: Page): Promise<{ rows: number; mirror: number; text: number; worst: number }> {
  return page.evaluate(() => {
    const area = document.querySelector<HTMLTextAreaElement>(".doc:not([hidden]) textarea.source")!;
    const mirror = document.querySelector<HTMLElement>(".doc:not([hidden]) .line-mirror")!;
    const zoom = Number(getComputedStyle(area).zoom) || 1;
    const top = area.getBoundingClientRect().top;
    let worst = 0;
    for (const row of mirror.children as HTMLCollectionOf<HTMLElement>) {
      const expected = top + (row.offsetTop - area.scrollTop) * zoom;
      worst = Math.max(worst, Math.abs(row.getBoundingClientRect().top - expected));
    }
    return { rows: mirror.children.length, mirror: mirror.offsetHeight, text: area.scrollHeight, worst };
  });
}

const frames = (page: Page) => page.evaluate(() => new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r))));

test("in the Markdown view every line of the file has its number, level with it however it wraps, scrolls and zooms", async () => {
  const run = await openText(MARKDOWN);
  const { page } = run;
  await showNumbers(run);
  await page.getByRole("button", { name: "Markdown" }).click();
  const area = page.getByRole("textbox", { name: "Markdown text" });
  await expect(page.locator(".doc:not([hidden]) .line-gutter")).toBeVisible();

  const fileLines = MARKDOWN.split("\n").length; // the empty line after the last line break too, where the cursor can go
  for (const zoom of ["", "zoom-in"]) {
    if (zoom) {
      await clickMenu(run.app, zoom);
      await expect.poll(() => area.evaluate((a) => getComputedStyle(a).zoom)).not.toBe("1");
    }
    for (const scroll of [0, 1200, 1e6]) {
      await area.evaluate((a, s) => (a.scrollTop = s), scroll);
      await frames(page);
      const level = await gutterLevel(page);
      expect(level.rows).toBe(fileLines);
      // Wrapped the same way as the text (each height is rounded on its own, so allow a pixel).
      expect(Math.abs(level.mirror - level.text)).toBeLessThanOrEqual(1);
      expect(level.worst, `zoom ${zoom || "1"}, scrolled to ${scroll}`).toBeLessThan(1);
    }
  }

  // Typing a new line adds a number; the numbers stay level.
  await area.evaluate((a: HTMLTextAreaElement) => {
    a.focus();
    a.setSelectionRange(0, 0);
    a.scrollTop = 0;
  });
  await page.keyboard.type("A new first line\n");
  await expect.poll(async () => (await gutterLevel(page)).rows).toBe(fileLines + 1);
  const level = await gutterLevel(page);
  expect(Math.abs(level.mirror - level.text)).toBeLessThanOrEqual(1);
  expect(level.worst).toBeLessThan(1);
  await expectFile(run, "A new first line\n" + MARKDOWN);

  // The numbers are drawn by the style sheet: no number is in the text.
  await expect(area).toHaveValue("A new first line\n" + MARKDOWN);
  const style = await page.evaluate(() => {
    const row = document.querySelector(".doc:not([hidden]) .line-mirror > div")!;
    const number = getComputedStyle(row, "::before");
    return { content: number.content, size: number.fontSize, select: getComputedStyle(row.closest(".line-gutter")!).pointerEvents };
  });
  expect(style).toEqual({ content: 'counter(file-line) / ""', size: "11px", select: "none" });

  // Off: no numbers.
  await clickMenu(run.app, "line-numbers");
  await expect(page.locator(".doc:not([hidden]) .line-gutter")).toBeHidden();
  await run.app.close();
});

test("in the Markdown view the numbers and the comments' marks stay exactly level with the text to its end, at every zoom: an empty line is as tall as any", async () => {
  const run = await openText(MARKDOWN.replace("Line 158", "Line 158 has a comment"));
  const { page } = run;
  await selectText(page, "has a comment");
  await page.getByRole("button", { name: "Comment", exact: true }).click();
  await page.getByRole("textbox", { name: "New comment" }).fill("Near the end.");
  await page.getByRole("button", { name: "Post" }).click();
  await showNumbers(run);
  await page.getByRole("button", { name: "Markdown" }).click();
  const area = page.getByRole("textbox", { name: "Markdown text" });
  await expect(page.locator(".doc:not([hidden]) .source-marks mark")).toHaveText("has a comment");
  for (const zoom of ["", "zoom-in", "zoom-in", "zoom-out", "zoom-out", "zoom-out"]) {
    if (zoom) await clickMenu(run.app, zoom);
    await frames(page);
    await area.evaluate((a) => (a.scrollTop = 1e6));
    await frames(page);
    // The copies are fitted when the window has a moment, so look until then.
    const level = () => page.evaluate(() => {
      const area = document.querySelector<HTMLTextAreaElement>(".doc:not([hidden]) textarea.source")!;
      const top = area.getBoundingClientRect().top;
      const zoom = area.currentCSSZoom;
      return [".line-mirror", ".source-marks-lines"].map((copy) => {
        const lines = document.querySelector<HTMLElement>(`.doc:not([hidden]) ${copy}`)!;
        const rows = [...lines.children] as HTMLElement[];
        const height = (row: HTMLElement) => row.getBoundingClientRect().height;
        const empty = rows.find((r) => !r.textContent)!;
        const line = rows.find((r) => r.textContent === "Line 1")!;
        // Where the scrolling puts each row, against where it is in the copy, unscrolled (to the 64th of a pixel the page is laid out in).
        const unscrolled = (row: HTMLElement) => row.getBoundingClientRect().top - lines.getBoundingClientRect().top;
        const worst = Math.max(...rows.map((row) => Math.abs(row.getBoundingClientRect().top - (top + unscrolled(row) - area.scrollTop * zoom))));
        return { copy, emptyAsTall: height(empty) === height(line), worst: worst < 0.05 };
      });
    });
    await expect.poll(level, { message: `zoom ${zoom || "1"}` }).toEqual([
      { copy: ".line-mirror", emptyAsTall: true, worst: true },
      { copy: ".source-marks-lines", emptyAsTall: true, worst: true },
    ]);
  }
  await run.app.close();
});

// Orlando, 2026-11-09
test("in the Markdown view the numbers keep a clear gap from the text, and stay inside the page", async () => {
  const run = await openText(MARKDOWN);
  const { page } = run;
  await page.getByRole("button", { name: "Markdown" }).click();
  const area = page.getByRole("textbox", { name: "Markdown text" });
  const textLeft = () => area.evaluate((a) => a.getBoundingClientRect().left + parseFloat(getComputedStyle(a).paddingLeft));
  const without = await textLeft();
  await clickMenu(run.app, "line-numbers");
  await expect(page.locator(".doc:not([hidden]) .line-gutter")).toBeVisible();
  for (const zoom of ["", "zoom-in"]) {
    if (zoom) {
      await clickMenu(run.app, zoom);
      await expect.poll(() => area.evaluate((a) => getComputedStyle(a).zoom)).not.toBe("1");
    }
    await frames(page);
    const m = await page.evaluate(() => {
      const rows = [...document.querySelectorAll<HTMLElement>(".doc:not([hidden]) .line-mirror > div:not(.cont)")];
      const row = rows[rows.length - 1]; // the longest number
      const r = row.getBoundingClientRect();
      const n = getComputedStyle(row, "::before");
      const scale = r.width / row.offsetWidth || 1;
      const numberRight = r.right - parseFloat(n.right) * scale;
      const numberLeft = numberRight - parseFloat(n.width) * scale;
      const area = document.querySelector<HTMLTextAreaElement>(".doc:not([hidden]) .source")!;
      const a = area.getBoundingClientRect();
      return { rowLeft: r.left, numberRight, numberLeft, paneLeft: a.left, textLeft: a.left + parseFloat(getComputedStyle(area).paddingLeft) * scale, scale };
    });
    // The copy that carries the numbers starts exactly where the text does.
    expect(Math.abs(m.rowLeft - m.textLeft)).toBeLessThan(1);
    // At least 14 pixels (at 100%) between a number and its line.
    expect((m.rowLeft - m.numberRight) / m.scale, `zoom ${zoom || "1"}`).toBeGreaterThanOrEqual(14);
    expect(m.numberLeft).toBeGreaterThan(m.paneLeft + 4);
  }
  // With the numbers off, the text goes back to the usual margin.
  await clickMenu(run.app, "line-numbers");
  await expect(page.locator(".doc:not([hidden]) .line-gutter")).toBeHidden();
  await clickMenu(run.app, "zoom-reset");
  await expect.poll(textLeft).toBe(without);
  await run.app.close();
});

/** How far each number in the formatted view is from its block's words, and how wide the page's left margin is. */
function gaps(page: Page): Promise<{ gaps: number[]; margin: number }> {
  return page.evaluate((editor) => {
    const pm = document.querySelector(`${editor} .ProseMirror`)!;
    const pageEl = document.querySelector<HTMLElement>(editor)!;
    const gaps = [...document.querySelectorAll<HTMLElement>(`${editor} p.ln, ${editor} h1.ln`)].map((el) => {
      const n = getComputedStyle(el, "::before");
      return -(parseFloat(n.left) + parseFloat(n.width));
    });
    return { gaps, margin: pm.getBoundingClientRect().left - pageEl.getBoundingClientRect().left };
  }, EDITOR);
}

// Roadmap Batch 9, item 12 (Orlando, 2026-11-12: "I think the line numbers are too dark and distracting. Can we make
// them a bit more subtle. In part because they're still pretty close to the text IMO."): lighter, still readable, and
// further from the words where the page's margin has room for it.
test("the numbers are quieter than before, in light and dark and in both views, yet readable; further from the words on a page with its full margins, at Standard and Wide", async () => {
  const run = await openText(SAMPLE);
  const { page, app } = run;
  await showNumbers(run);
  const contrast = (selector: string, pseudo: string) =>
    page.evaluate(
      ([selector, pseudo]) => {
        const rgb = (c: string) => (c.match(/[\d.]+/g) ?? []).map(Number);
        const lum = ([r, g, b]: number[]) => {
          const f = (v: number) => ((v /= 255) <= 0.03928 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4);
          return 0.2126 * f(r) + 0.7152 * f(g) + 0.0722 * f(b);
        };
        const ratio = (x: number, y: number) => (Math.max(x, y) + 0.05) / (Math.min(x, y) + 0.05);
        const probe = document.createElement("span");
        probe.style.color = "var(--ink-soft)";
        document.body.append(probe);
        const soft = lum(rgb(getComputedStyle(probe).color));
        probe.remove();
        const number = lum(rgb(getComputedStyle(document.querySelector(selector)!, pseudo).color));
        const ground = lum(rgb(getComputedStyle(document.querySelector(".doc:not([hidden]) :is(.page.editor, .source)")!).backgroundColor));
        return { number: ratio(number, ground), soft: ratio(soft, ground) };
      },
      [selector, pseudo] as const,
    );
  for (const scheme of ["light", "dark"] as const) {
    await page.emulateMedia({ colorScheme: scheme });
    const formatted = await contrast(`${EDITOR} .ln`, "::before");
    // Quieter than the soft grey of the page's other small words (as they were), and still readable at their size.
    expect(formatted.number, `${scheme}: ${JSON.stringify(formatted)}`).toBeLessThan(formatted.soft - 1);
    expect(formatted.number, scheme).toBeGreaterThanOrEqual(4.5);
    await page.getByRole("button", { name: "Markdown" }).click();
    await expect(page.locator(".doc:not([hidden]) .line-gutter")).toBeVisible();
    const markdown = await contrast(".doc:not([hidden]) .line-mirror > div", "::before");
    expect(markdown.number, scheme).toBeCloseTo(formatted.number, 2);
    await page.getByRole("button", { name: "Formatted" }).click();
    await expect(page.locator(EDITOR)).toBeVisible();
  }
  await page.emulateMedia({ colorScheme: null });

  // 24 pixels from the words where the page has its full margins, at Standard and at Wide; 16 where a narrow window
  // gives the page less margin, as before, so the numbers never run off the page.
  for (const width of ["page-width-fixed", "page-width-fill"]) {
    await clickMenu(app, width);
    await page.setViewportSize({ width: 1440, height: 800 });
    await expect.poll(async () => (await gaps(page)).margin).toBe(80);
    expect(new Set((await gaps(page)).gaps), width).toEqual(new Set([24]));
    await page.setViewportSize({ width: 900, height: 800 });
    await expect.poll(async () => (await gaps(page)).margin).toBe(40);
    expect(new Set((await gaps(page)).gaps), width).toEqual(new Set([16]));
  }
  await run.app.close();
});

test("a line ending in an old Mac line break doesn't count as a new line of the file, in either view", async () => {
  const run = await openText("one\rcontinued\ntwo\n");
  const { page } = run;
  await showNumbers(run);
  // "one" and "continued" are one line of the file; "two" is the next.
  expect((await numbersShown(page)).map((n) => n.line)).toEqual([1, 2]);
  await page.getByRole("button", { name: "Markdown" }).click();
  await expect(page.locator(".doc:not([hidden]) .line-mirror > div")).toHaveCount(4);
  const continued = await page.locator(".doc:not([hidden]) .line-mirror > div").evaluateAll((rows) => rows.map((r) => r.classList.contains("cont")));
  expect(continued).toEqual([false, true, false, false]);
  await run.app.close();
});

test("Line Numbers is remembered after quitting, and shows on every document", async () => {
  const run = await openText(NOTES);
  await showNumbers(run);
  await openAlso(run, "other.md", "# Other\n\nText.\n");
  await expect(run.page.locator(`${EDITOR} .ln`)).toHaveCount(2);
  await run.app.close();

  const again = await openText("# Later\n\n\nText.\n", { dataDir: run.dataDir });
  await expect(again.page.locator(`${EDITOR} .ln`)).toHaveCount(3);
  expect((await numbersShown(again.page)).map((n) => n.line)).toEqual([1, 3, 4]);
  expect(await menuChecked(again)).toBe(true);
  await again.app.close();
});

test("the numbers are never part of the text: not copied, not saved, and readable in light and dark", async () => {
  const run = await openText(SAMPLE);
  const { page, app } = run;
  const savedAt = statSync(run.file).mtimeMs;
  const copied = await captureClipboardWrites(app);
  const copyAll = async () => {
    await selectText(page, "Heading one");
    await page.keyboard.press("Meta+a");
    await settle(page);
    await copySelection(page);
    return copied();
  };
  const without = await copyAll();
  expect(without?.["text/plain"]).toContain("Heading one");
  await showNumbers(run);
  const withNumbers = await copyAll();
  expect(withNumbers).toEqual(without);
  expect(withNumbers!["text/plain"]).not.toMatch(/^\s*\d+\s*$/m);

  // Showing them doesn't change or save the file.
  await page.waitForTimeout(700);
  expect(run.text()).toBe(SAMPLE);
  expect(statSync(run.file).mtimeMs).toBe(savedAt);

  for (const scheme of ["light", "dark"] as const) {
    await page.emulateMedia({ colorScheme: scheme });
    const ratio = await page.evaluate((editor) => {
      const rgb = (c: string) => (c.match(/[\d.]+/g) ?? []).map(Number);
      const lum = ([r, g, b]: number[]) => {
        const f = (v: number) => ((v /= 255) <= 0.03928 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4);
        return 0.2126 * f(r) + 0.7152 * f(g) + 0.0722 * f(b);
      };
      const number = lum(rgb(getComputedStyle(document.querySelector(`${editor} .ln`)!, "::before").color));
      const page = lum(rgb(getComputedStyle(document.querySelector(editor)!).backgroundColor));
      const [a, b] = [number, page].sort((x, y) => y - x);
      return (a + 0.05) / (b + 0.05);
    }, EDITOR);
    expect(ratio, scheme).toBeGreaterThanOrEqual(4.5);
  }
  await run.app.close();
});
