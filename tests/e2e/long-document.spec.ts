// Long documents: Corillo stays quick on a long formal document of about
// 30,000 words, with 300 headings, 60 tables, 150 footnotes, 30 pictures and
// 20 diagrams. The time limits are several times what it takes, so they catch
// real slowdowns, not a computer that's busy with something else.
import { test, expect, type Page } from "@playwright/test";
import { copyFileSync, mkdirSync, statSync } from "node:fs";
import { join } from "node:path";
import { bigDocument, BIG_PICTURES, bigPicturePath } from "../fixtures/big-document";
import { openText, openAlso, settle, clickMenu, EDITOR, FIXTURES, type Running } from "./helpers";

const BIG = bigDocument();

/** Put the document's pictures in its "big images" folder. */
function withPictures(folder: string): void {
  mkdirSync(join(folder, "big images"));
  for (let i = 0; i < BIG_PICTURES; i++) copyFileSync(join(FIXTURES, "chart.png"), join(folder, bigPicturePath(i)));
}

const openBig = () => openText(BIG, { name: "big.md", prepare: withPictures });

const allShown = (run: Running) => expect(run.page.locator(`${EDITOR} .footnote-def`)).toHaveCount(150, { timeout: 10_000 });

const wordsShown = async (page: Page) => Number((await page.locator("#word-count").textContent())!.replace(/\D/g, ""));

test("a long document opens and shows in under 3 seconds", async () => {
  const run = await openText("Start.\n", { prepare: withPictures });
  const start = Date.now();
  await openAlso(run, "big.md", BIG);
  await allShown(run);
  expect(Date.now() - start).toBeLessThan(3000);
  await expect(run.page.locator(`${EDITOR} .picture img`)).toHaveCount(30);
  await run.app.close();
});

test("a long document opened and closed without edits is left exactly as it was", async () => {
  const run = await openBig();
  const before = statSync(run.file).mtimeMs;
  await allShown(run);
  await expect(run.page.locator("#save-status")).toHaveText("Saved");
  await run.page.waitForTimeout(800);
  await run.app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].close());
  await run.page.waitForEvent("close");
  expect(run.text()).toBe(BIG);
  expect(statSync(run.file).mtimeMs).toBe(before);
  await run.app.close();
});

test("typing 50 characters in the middle of a long document: each keystroke takes under 100 ms, the word count follows, and the save changes only that line", async () => {
  const run = await openBig();
  await allShown(run);
  const words = await wordsShown(run.page);
  await run.page.locator(`${EDITOR} h3`, { hasText: /^15\.5 / }).click();
  await settle(run.page);
  await run.page.keyboard.press("Meta+ArrowRight");
  await expect(run.page.locator(`${EDITOR} .diagram.drawing`)).toHaveCount(0); // diagrams nearby are done
  await settle(run.page);

  const typed = " and a few more words typed here at the end of it.";
  expect(typed).toHaveLength(50);
  const keystrokes: number[] = [];
  for (const ch of typed) {
    const start = performance.now();
    await run.page.keyboard.press(ch === " " ? "Space" : ch);
    keystrokes.push(performance.now() - start);
  }
  const typedAt = Date.now();
  expect(Math.max(...keystrokes)).toBeLessThan(100);
  await expect.poll(() => wordsShown(run.page)).toBe(words + 12);

  // Saved within the autosave pause (under half a second) plus a second at most.
  const line = BIG.split("\n").find((l) => l.startsWith("### 15.5 "))!;
  const expected = BIG.replace(line, line + typed);
  await expect.poll(run.text, { intervals: [50], timeout: 10_000 }).toBe(expected);
  expect(Date.now() - typedAt).toBeLessThan(1500);
  await run.app.close();
});

const median = (times: number[]) => [...times].sort((a, b) => a - b)[Math.floor(times.length / 2)];

/** Type, timing each keystroke. */
async function typeTimed(page: Page, typed: string): Promise<number[]> {
  const times: number[] = [];
  for (const ch of typed) {
    const start = performance.now();
    await page.keyboard.press(ch === " " ? "Space" : ch);
    times.push(performance.now() - start);
  }
  return times;
}

test("with line numbers showing, typing in a long document is as quick, a new line renumbers the rest within a tenth of a second, and the last line has its number", async () => {
  const run = await openBig();
  const { page } = run;
  await allShown(run);
  await page.locator(`${EDITOR} h3`, { hasText: /^15\.5 / }).click();
  await settle(page);
  await page.keyboard.press("Meta+ArrowRight");
  await expect(page.locator(`${EDITOR} .diagram.drawing`)).toHaveCount(0);
  await settle(page);
  const without = await typeTimed(page, " and twenty five more words.");

  await clickMenu(run.app, "line-numbers");
  const heading = page.locator(`${EDITOR} h3`, { hasText: /^15\.5 / });
  await expect(heading).toHaveAttribute("data-ln", String(BIG.split("\n").findIndex((l) => l.startsWith("### 15.5 ")) + 1));
  await settle(page);
  const withNumbers = await typeTimed(page, " Then twenty five more, too.");
  console.log(`Keystrokes in a long document, median: ${median(without).toFixed(1)} ms without line numbers, ${median(withNumbers).toFixed(1)} ms with them`);
  expect(median(withNumbers)).toBeLessThan(Math.max(2 * median(without), median(without) + 10));
  expect(Math.max(...withNumbers)).toBeLessThan(100);

  // Splitting the heading above in two moves every line below down two.
  await page.locator(`${EDITOR} h3`, { hasText: /^15\.4 / }).click({ position: { x: 2, y: 5 } });
  await settle(page);
  const renumbering: number[] = [];
  for (let i = 0; i < 5; i++) {
    await page.keyboard.press("ArrowRight");
    await page.keyboard.press("ArrowRight");
    await settle(page);
    const before = Number(await heading.getAttribute("data-ln"));
    await page.evaluate((expected) => {
      const w = window as unknown as { renumbered: number | null };
      w.renumbered = null;
      const pressed = performance.now();
      const check = () => {
        const shown = [...document.querySelectorAll<HTMLElement>(".doc:not([hidden]) .page.editor h3")].find((h) => h.textContent!.startsWith("15.5 "));
        if (shown?.dataset.ln === String(expected)) w.renumbered = performance.now() - pressed;
        else requestAnimationFrame(check);
      };
      requestAnimationFrame(check);
    }, before + 2);
    await page.keyboard.press("Enter");
    await page.waitForFunction(() => (window as unknown as { renumbered: number | null }).renumbered !== null);
    renumbering.push(await page.evaluate(() => (window as unknown as { renumbered: number }).renumbered));
  }
  console.log(`Renumbering after a split heading, median: ${median(renumbering).toFixed(1)} ms`);
  expect(median(renumbering)).toBeLessThan(100);

  // Far down, the numbers are there once it comes into view: the last line of the file is the last footnote.
  await page.keyboard.press("Meta+ArrowDown");
  await expect.poll(run.text, { timeout: 10_000 }).toMatch(/Then twenty five more, too\./);
  const lastNote = page.locator(`${EDITOR} .footnote-def .ln-line`).last();
  await expect.poll(async () => Number(await lastNote.getAttribute("data-ln"))).toBe(run.text().split("\n").length - 1);
  await run.app.close();
});

test("in a long document, diagrams are drawn as they come into view, not all at once when it opens", async () => {
  const run = await openBig();
  await allShown(run);
  await run.page.waitForTimeout(1000);
  const drawn = () => run.page.locator(`${EDITOR} .diagram-picture svg`).count();
  await expect(run.page.locator(`${EDITOR} .diagram`)).toHaveCount(20);
  expect(await drawn()).toBeLessThan(5);
  const last = run.page.locator(`${EDITOR} .diagram`).last();
  await last.scrollIntoViewIfNeeded();
  await expect(last.locator(".diagram-picture svg")).toBeVisible({ timeout: 15_000 });
  await expect(last.locator(".diagram-picture")).toContainText("Draft 29");
  expect(await drawn()).toBeLessThan(10);
  await run.app.close();
});

test("a long document switches to the Markdown view in under 3 seconds, and back, without changing the file", async () => {
  const run = await openBig();
  await allShown(run);
  const before = statSync(run.file).mtimeMs;
  const start = Date.now();
  await run.page.getByRole("button", { name: "Markdown" }).click();
  await expect(run.page.locator(".page.preview .footnote-def")).toHaveCount(150, { timeout: 10_000 });
  expect(Date.now() - start).toBeLessThan(3000);
  await expect(run.page.getByRole("textbox", { name: "Markdown text" })).toHaveValue(BIG);
  await run.page.getByRole("button", { name: "Formatted" }).click();
  await allShown(run);
  await run.page.waitForTimeout(700);
  expect(run.text()).toBe(BIG);
  expect(statSync(run.file).mtimeMs).toBe(before);
  await run.app.close();
});

test("in a long document's Markdown view, a selection's word count shows without reading the text again: a few milliseconds a frame", async () => {
  const run = await openBig();
  await allShown(run);
  await run.page.getByRole("button", { name: "Markdown" }).click();
  await expect(run.page.locator(".page.preview .footnote-def")).toHaveCount(150, { timeout: 10_000 });
  const source = run.page.getByRole("textbox", { name: "Markdown text" });
  await source.click();
  await settle(run.page);
  // The time the status bar's refresh takes in the frame after the selection
  // moves: between a frame callback queued just before it and one just after.
  const frameCost = (start: number, end: number) =>
    source.evaluate(
      (el: HTMLTextAreaElement, [start, end]) =>
        new Promise<number>((resolve) => {
          requestAnimationFrame(() =>
            requestAnimationFrame(() => {
              const times: number[] = [];
              el.setSelectionRange(start, end);
              requestAnimationFrame(() => times.push(performance.now()));
              document.dispatchEvent(new KeyboardEvent("keyup", { key: "Shift" }));
              requestAnimationFrame(() => resolve(performance.now() - times[0]));
            }),
          );
        }),
      [start, end],
    );
  const costs: number[] = [];
  for (let i = 0; i < 6; i++) costs.push(await frameCost(0, BIG.length - i * 1000));
  await expect(run.page.locator("#word-count")).toHaveText(/^[\d,.\s]+ of [\d,.\s]+ words$/);
  costs.sort((a, b) => a - b);
  expect(costs[3], costs.map((c) => c.toFixed(1)).join(", ")).toBeLessThan(5); // under 1 ms now; reading the text again took about 12 ms here
  await run.app.close();
});

const DIAGRAM = "Flow:\n\n```mermaid\ngraph LR\n  Ask --> Draft --> Review\n```\n\nEnd.\n";

test("the Markdown view's preview reuses a diagram already drawn, with its own arrowheads", async () => {
  const run = await openText(DIAGRAM);
  await expect(run.page.locator(`${EDITOR} .diagram-picture svg`)).toBeVisible({ timeout: 15_000 });
  // Count every drawing made from now on.
  await run.page.evaluate(() => {
    const w = window as unknown as { corilloDiagrams: { render(code: string): Promise<string> }; drawings: number };
    const render = w.corilloDiagrams.render;
    w.drawings = 0;
    w.corilloDiagrams.render = (code) => {
      w.drawings++;
      return render(code);
    };
  });
  await run.page.getByRole("button", { name: "Markdown" }).click();
  const preview = run.page.locator(".page.preview .diagram-picture svg");
  await expect(preview).toBeVisible({ timeout: 15_000 });
  await expect(run.page.locator(".page.preview .diagram-picture")).toContainText("Draft");
  expect(await run.page.evaluate(() => (window as unknown as { drawings: number }).drawings)).toBe(0);
  // The copy has its own names, so its arrowheads point at its own markers, not the hidden original's.
  const ids = await run.page.evaluate(() => {
    const [editor, copy] = [...document.querySelectorAll(".diagram-picture svg")];
    const refs = [...copy.innerHTML.matchAll(/url\(#([^)]+)\)/g)].map((m) => m[1]);
    return { editor: editor.id, copy: copy.id, refs: refs.length, ownRefs: refs.filter((r) => copy.querySelector(`[id="${r}"]`)).length };
  });
  expect(ids.copy).not.toBe(ids.editor);
  expect(ids.refs).toBeGreaterThan(0);
  expect(ids.ownRefs).toBe(ids.refs);
  await run.app.close();
});
