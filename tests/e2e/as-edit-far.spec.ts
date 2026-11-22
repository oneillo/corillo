// The person reading at the far end of a long document (9,000 words, 9
// chapters) while an agent changes it far above them, far below, and right
// around them (the heading over their paragraph, a word earlier in it), shown
// as edits (roadmap Batch 7): in the Formatted and the Markdown view, their
// selection stays on the same words, what they're reading stays where it was
// on screen, and where the keyboard rests (the page, the find bar, a card)
// stays so, as it would with the page read again. Each test runs the real app, hidden, on a throwaway document and
// data folder, with a pretend agent tool speaking MCP to it.
import { test, expect, type Page } from "@playwright/test";
import { readFileSync, rmSync } from "node:fs";
import { openText, settle, EDITOR, type Running } from "./helpers";
import { AgentSession } from "./agent-session";
import { bigDocument } from "../fixtures/big-document";

const CANVAS = ".doc:not([hidden]) .canvas";
const SOURCE = ".doc:not([hidden]) textarea.source";
const PANEL = ".doc:not([hidden]) aside.comments-panel";

const DOC = bigDocument(9);
const BLOCKS = DOC.split("\n\n");
// The paragraph the person reads: the first under 9.6, near the end.
const HEADING = BLOCKS.find((b) => b.startsWith("### 9.6 "))!;
const PARAGRAPH = BLOCKS[BLOCKS.indexOf(HEADING) + 1];
// Its bold word, and the plain words after it, where the selection goes.
const BOLD = PARAGRAPH.match(/\*\*(\w+)\*\*/)![1];
const PLAIN = PARAGRAPH.slice(PARAGRAPH.indexOf(`**${BOLD}**`) + BOLD.length + 4).slice(0, 25);
const SELECTED = PLAIN.slice(2, 12);
const FIRST_WORD = PARAGRAPH.slice(0, PARAGRAPH.indexOf(" "));
const CHAPTER_2 = BLOCKS.find((b) => b.startsWith("## 2. "))!;
const LAST_NOTE = BLOCKS.find((b) => b.startsWith("[^source-45]: "))!;

/** The agent's changes, each one pass: far above, far below, the heading over the paragraph, a word earlier in it. */
const CHANGES: { where: string; edits: { find: string; replace: string }[]; shows: string }[] = [
  {
    where: "far above",
    edits: [
      { find: "### 1.2 ", replace: "### 1.2 Renamed by the agent: " },
      { find: `${CHAPTER_2}\n\n`, replace: `${CHAPTER_2}\n\nA new paragraph the agent put in near the top, long enough to wrap onto a second line of the page, so everything below it moves down.\n\nAnd a second one.\n\n` },
    ],
    shows: "And a second one.",
  },
  { where: "far below", edits: [{ find: "[^source-45]: ", replace: "[^source-45]: Checked again in November. " }], shows: "Checked again in November." },
  { where: "the heading over the paragraph", edits: [{ find: HEADING, replace: `${HEADING}, which the agent made long enough to need a second line` }], shows: "long enough to need a second line" },
  { where: "a word earlier in the paragraph", edits: [{ find: `${FIRST_WORD} **${BOLD}**`, replace: `${FIRST_WORD} newly **${BOLD}**` }], shows: `${FIRST_WORD} newly ${BOLD}` },
];

let run: Running | null = null;
let claude: AgentSession | null = null;

test.afterEach(async () => {
  const r = run;
  run = null;
  await claude?.stop();
  claude = null;
  const home = await r?.app.evaluate(() => process.env.CORILLO_HOME).catch(() => undefined);
  await r?.app.close().catch(() => undefined);
  for (const dir of [r?.folder, r?.dataDir, home]) if (dir) rmSync(dir, { recursive: true, force: true });
});

/** An agent makes these edits, as one pass: take, edit, finish. */
async function agentEdits(file: string, edits: { find: string; replace: string }[]): Promise<void> {
  claude ??= (await AgentSession.start(run!.dataDir)).session;
  await claude.ok("take_document", { path: file });
  await claude.ok("edit_document", { path: file, edits });
  // (A comment left for its next pass: finishing a second time leaves it.)
  if ((await claude.call("finish_editing", { path: file })).isError) await claude.ok("finish_editing", { path: file });
}

/** Where the keyboard is: the page, the Markdown text, a card (its first words), the find bar, or something else. */
const keyboard = (page: Page) =>
  page.evaluate(() => {
    const a = document.activeElement as HTMLElement | null;
    if (!a || a === document.body) return "nowhere";
    if (a.closest(".ProseMirror")) return "page";
    if (a.matches("textarea.source")) return "text";
    if (a.classList.contains("comment-card")) return `card: ${(a.textContent ?? "").replace(/\s+/g, " ").trim().slice(0, 60)}`;
    if (a.matches(".find-field")) return "find";
    return a.tagName.toLowerCase();
  });

/** The block at the top of the page (its words) and where its top is on screen. */
const topBlock = (page: Page) =>
  page.evaluate(
    ([canvas, editor]) => {
      const scroller = document.querySelector(canvas)!;
      const top = scroller.getBoundingClientRect().top;
      for (const block of document.querySelector(`${editor} .ProseMirror`)!.children) {
        const box = block.getBoundingClientRect();
        if (box.height && box.bottom > top) return { words: block.textContent ?? "", at: box.top };
      }
      throw new Error("no block in sight");
    },
    [CANVAS, EDITOR] as const,
  );

/** Where on screen a block with these words is now. */
const blockAt = (page: Page, words: string) =>
  page.evaluate(
    ([editor, words]) => {
      // On screen: the agent's editing line, coming up above the page, moves the page's top but not the words.
      const block = [...document.querySelector(`${editor} .ProseMirror`)!.children].find((b) => b.textContent === words);
      return block ? block.getBoundingClientRect().top : null;
    },
    [EDITOR, words] as const,
  );

// The Formatted view ------------------------------------------------------------------------------

test("in the Formatted view, reading at the far end of a 9,000-word document, the selection, what's on screen and the keyboard stay put through an agent's changes far above, far below and right around them", async () => {
  test.setTimeout(180_000);
  run = await openText(DOC, { name: "long.md" });
  const { page, file } = run;
  await page.setViewportSize({ width: 1400, height: 900 });
  // The paragraph 150 pixels below the top of the window, the plain words after its bold one selected.
  await page.evaluate(
    ([canvas, editor, bold, plain, selected]) => {
      const scroller = document.querySelector(canvas)!;
      const root = document.querySelector<HTMLElement>(`${editor} .ProseMirror`)!;
      const block = [...root.children].find((b) => b.textContent!.includes(bold + plain))!;
      scroller.scrollTop += block.getBoundingClientRect().top - scroller.getBoundingClientRect().top - 150;
      let offset = block.textContent!.indexOf(bold + plain) + bold.length + plain.indexOf(selected);
      const walker = document.createTreeWalker(block, NodeFilter.SHOW_TEXT);
      const at = (n: number): [globalThis.Node, number] => {
        walker.currentNode = block;
        for (let node = walker.nextNode(); node; node = walker.nextNode()) {
          if (n < node.textContent!.length) return [node, n];
          n -= node.textContent!.length;
        }
        throw new Error("past the block's end");
      };
      root.focus({ preventScroll: true });
      const range = document.createRange();
      range.setStart(...at(offset));
      range.setEnd(...at((offset += selected.length)));
      getSelection()!.removeAllRanges();
      getSelection()!.addRange(range);
    },
    [CANVAS, EDITOR, BOLD, PLAIN, SELECTED] as const,
  );
  await settle(page);
  expect(await page.evaluate(() => getSelection()!.toString())).toBe(SELECTED);
  const reading = await topBlock(page);
  expect(reading.words.length).toBeGreaterThan(40);

  for (const change of CHANGES) {
    await agentEdits(file, change.edits);
    await expect(page.locator(EDITOR), change.where).toContainText(change.shows);
    await settle(page);
    // What's on screen stays where it was.
    expect(Math.abs((await blockAt(page, reading.words))! - reading.at), `what's on screen, after a change ${change.where}`).toBeLessThan(2);
    // With words selected, the keyboard isn't given back to the page when the agent is done (a stray key would
    // replace them): back on the page, the same words are selected, and nothing scrolled.
    expect(await keyboard(page)).toBe("nowhere");
    await page.locator(`${EDITOR} .ProseMirror`).focus();
    expect(await page.evaluate(() => getSelection()!.toString()), `the selection, after a change ${change.where}`).toBe(SELECTED);
    expect(Math.abs((await blockAt(page, reading.words))! - reading.at)).toBeLessThan(2);
  }

  // With a plain cursor (after the selected words), the keyboard is back on the page once the agent is done, and typing goes there.
  await page.keyboard.press("ArrowRight");
  await settle(page);
  expect(await page.evaluate(() => getSelection()!.isCollapsed)).toBe(true);
  await agentEdits(file, [{ find: "And a second one.", replace: "And a second one, changed." }]);
  await expect(page.locator(EDITOR)).toContainText("And a second one, changed.");
  await expect.poll(() => keyboard(page)).toBe("page");
  expect(Math.abs((await blockAt(page, reading.words))! - reading.at)).toBeLessThan(2);
  await page.keyboard.type("Q");
  await expect.poll(() => readFileSync(file, "utf8")).toContain(`newly **${BOLD}**${PLAIN.slice(0, 12)}Q${PLAIN.slice(12)}`);

  // The find bar, with words typed in it, through a change far above.
  await page.keyboard.press("Meta+f");
  await page.keyboard.type("budg");
  await expect.poll(() => keyboard(page)).toBe("find");
  await agentEdits(file, [{ find: "Renamed by the agent: ", replace: "Renamed again: " }]);
  await expect(page.locator(EDITOR)).toContainText("Renamed again: ");
  await settle(page);
  expect(await keyboard(page)).toBe("find");
  await page.keyboard.type("et");
  await expect(page.getByRole("textbox", { name: "Find" })).toHaveValue("budget");
  await page.keyboard.press("Escape");

  // A card (a comment the agent left, after Next Comment), through a change far below. (The agent's
  // changes had a card of their own until roadmap Batch 9, item 5: the panel holds comments only.)
  await claude!.ok("take_document", { path: file });
  await claude!.ok("add_comment", { path: file, text: "Shall I check the sources too?" });
  await claude!.ok("finish_editing", { path: file });
  await page.keyboard.press("Meta+Alt+ArrowDown");
  await expect.poll(() => keyboard(page)).toMatch(/^card: /);
  const resting = await keyboard(page);
  await agentEdits(file, [{ find: "Checked again in November. ", replace: "Checked twice. " }]);
  await expect(page.locator(EDITOR)).toContainText("Checked twice. ");
  await settle(page);
  expect(await keyboard(page)).toBe(resting);
  await expect(page.locator(`${PANEL} .comment-card.active`)).toHaveCount(1);
});

// The Markdown view -------------------------------------------------------------------------------

/**
 * In the Markdown text: how far the line starting at `start` is from the top
 * of the screen, measured by laying out the text before it in a copy of the
 * text area out of sight. With no `start`, the line at the top's.
 */
const lineAt = (page: Page, start?: number) =>
  page.locator(SOURCE).evaluate((a, start) => {
    const t = a as HTMLTextAreaElement;
    const style = getComputedStyle(t);
    const probe = t.cloneNode(false) as HTMLTextAreaElement;
    Object.assign(probe.style, { position: "absolute", visibility: "hidden", height: "0", minHeight: "0", width: style.width });
    t.parentElement!.append(probe);
    const v = t.value;
    const topOf = (s: number) => {
      if (s === 0) return parseFloat(style.paddingTop);
      probe.value = v.slice(0, s - 1);
      return probe.scrollHeight - parseFloat(style.paddingBottom);
    };
    try {
      // `at` is on screen: the agent's editing line, coming up above the text, moves its top but not the words.
      const screen = t.getBoundingClientRect().top;
      if (start !== undefined) return { start, at: topOf(start) - t.scrollTop + screen };
      const starts = [0];
      for (let i = v.indexOf("\n"); i >= 0; i = v.indexOf("\n", i + 1)) starts.push(i + 1);
      // The last line starting at or above the window's top.
      let lo = 0;
      let hi = starts.length - 1;
      while (lo < hi) {
        const mid = (lo + hi + 1) >> 1;
        if (topOf(starts[mid]) <= t.scrollTop) lo = mid;
        else hi = mid - 1;
      }
      return { start: starts[lo], at: topOf(starts[lo]) - t.scrollTop + screen };
    } finally {
      probe.remove();
    }
  }, start);

test("in the Markdown view, reading at the far end of a 9,000-word document, the selection, the line at the top and the keyboard stay put through an agent's changes far above, far below and right around them", async () => {
  test.setTimeout(180_000);
  run = await openText(DOC, { name: "long.md" });
  const { page, file } = run;
  await page.setViewportSize({ width: 1400, height: 900 });
  await page.getByRole("button", { name: "Markdown" }).click();
  const area = page.locator(SOURCE);
  // The paragraph's line 150 pixels below the top of the window, the plain words after its bold one selected.
  const from = DOC.indexOf(`**${BOLD}**${PLAIN}`) + BOLD.length + 6;
  expect(DOC.slice(from, from + SELECTED.length)).toBe(SELECTED);
  const paragraphAt = (await lineAt(page, DOC.indexOf(PARAGRAPH))).at - (await area.evaluate((a) => a.getBoundingClientRect().top));
  await area.evaluate((a, [by, from, to]) => {
    const t = a as HTMLTextAreaElement;
    t.focus({ preventScroll: true });
    t.setSelectionRange(from, to);
    t.scrollTop += by;
  }, [paragraphAt - 150, from, from + SELECTED.length] as const);
  await settle(page);
  let top = await lineAt(page);
  expect(top.start).toBeLessThan(DOC.indexOf(PARAGRAPH));
  const selection = () => area.evaluate((a) => {
    const t = a as HTMLTextAreaElement;
    return { words: t.value.slice(t.selectionStart, t.selectionEnd), before: t.value.slice(t.selectionStart - 8, t.selectionStart) };
  });
  const before = DOC.slice(from - 8, from);

  let text = DOC;
  for (const change of CHANGES) {
    // Where the line at the top starts once the change is made: further down by what was put in above it.
    let start = top.start;
    for (const e of change.edits) {
      const at = text.indexOf(e.find);
      if (at + e.find.length <= start) start += e.replace.length - e.find.length;
      text = text.replace(e.find, e.replace);
    }
    await agentEdits(file, change.edits);
    await expect(area, change.where).toHaveValue(text);
    await settle(page);
    // The line at the top stays where it was.
    const now = await lineAt(page, start);
    expect(Math.abs(now.at - top.at), `the line at the top, after a change ${change.where}`).toBeLessThan(2);
    top = now;
    await expect(area, `the keyboard, after a change ${change.where}`).toBeFocused();
    expect(await selection(), `the selection, after a change ${change.where}`).toEqual({ words: SELECTED, before });
  }

  // Typing replaces the selected words, there in the file.
  await page.keyboard.type("Q");
  await expect.poll(() => readFileSync(file, "utf8")).toContain(`newly **${BOLD}**${PLAIN.slice(0, 2)}Q${PLAIN.slice(12)}`);

  // The find bar, with words typed in it, through a change far above.
  await page.keyboard.press("Meta+f");
  await page.keyboard.type("budg");
  await expect.poll(() => keyboard(page)).toBe("find");
  await agentEdits(file, [{ find: "Renamed by the agent: ", replace: "Renamed again: " }]);
  await expect(area).toHaveValue(/Renamed again: /);
  await settle(page);
  expect(await keyboard(page)).toBe("find");
  await page.keyboard.type("et");
  await expect(page.getByRole("textbox", { name: "Find" })).toHaveValue("budget");
  await page.keyboard.press("Escape");

  // A card (a comment the agent left, after Next Comment), through a change far below. (The agent's
  // changes had a card of their own until roadmap Batch 9, item 5: the panel holds comments only.)
  await claude!.ok("take_document", { path: file });
  await claude!.ok("add_comment", { path: file, text: "Shall I check the sources too?" });
  await claude!.ok("finish_editing", { path: file });
  await page.keyboard.press("Meta+Alt+ArrowDown");
  await expect.poll(() => keyboard(page)).toMatch(/^card: /);
  const resting = await keyboard(page);
  await agentEdits(file, [{ find: "Checked again in November. ", replace: "Checked twice. " }]);
  await expect(area).toHaveValue(/Checked twice\. /);
  await settle(page);
  expect(await keyboard(page)).toBe(resting);
});

// Found while building these tests (roadmap Batch 7, item 3), and there before Batch 7: with Find open in the
// Formatted view, switching to the Markdown view ran the window out of stack. The find bar cleared its old place
// before taking the new one; clearing told the window, which asked the find bar to move again, without end. From
// then on, an agent's take_document failed ("Corillo's window didn't answer in time"). The bar now takes its new
// place first.
test("with Find open, switching to the Markdown view goes without a fault, and an agent can take the document after", async () => {
  run = await openText("# Plan\n\nThe budget is tight.\n\n## Budget\n\nMore budget words.\n", { name: "plan.md" });
  const { page, file } = run;
  const faults: string[] = [];
  page.on("pageerror", (e) => faults.push(e.message));
  await page.keyboard.press("Meta+f");
  await page.getByRole("textbox", { name: "Find", exact: true }).fill("budget");
  await expect(page.locator(".find-count")).toHaveText(/^\d+ (of \d+|matches)$/);
  await page.getByRole("button", { name: "Markdown", exact: true }).click();
  await expect(page.locator(SOURCE)).toBeVisible();
  await settle(page);
  expect(faults).toEqual([]);
  // Find is still open, on the Markdown text's matches.
  await expect(page.locator(".find-count")).toHaveText(/^\d+ (of \d+|matches)$/);
  await agentEdits(file, [{ find: "is tight", replace: "is very tight" }]);
  await expect(page.locator(SOURCE)).toHaveValue(/is very tight/);
  // And back, Find still open: no fault either way, and the agent can take the document again.
  await page.getByRole("button", { name: "Formatted", exact: true }).click();
  await expect(page.locator(EDITOR)).toBeVisible();
  await settle(page);
  expect(faults).toEqual([]);
  await expect(page.locator(".find-count")).toHaveText(/^\d+ (of \d+|matches)$/);
  await agentEdits(file, [{ find: "More budget", replace: "Fewer budget" }]);
  await expect(page.locator(EDITOR)).toContainText("Fewer budget words.");
});
