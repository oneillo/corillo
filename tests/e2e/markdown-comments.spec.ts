// Comments in the Markdown view (spec: Comments, "Decided while building",
// 2026-11-09): the same panel and cards as the formatted view, beside the
// preview; a comment on words selected in the text or the preview, on the same
// words as in the formatted view; the comments' words marked in both panes,
// clicking either way; and a comment being written that survives switching
// views. Each test runs the real app on a throwaway document and data folder.
import { test, expect, type Page } from "@playwright/test";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { gunzipSync } from "node:zlib";
import { chooseInContextMenu, clickMenu, expectFile, messageAction, openAlso, openText, rightClick, selectText, settle, EDITOR, type Running } from "./helpers";
import type { Thread } from "../../src/core/comments";

const PANEL = ".doc:not([hidden]) aside.comments-panel";
const SOURCE = ".doc:not([hidden]) textarea.source";
const PREVIEW = ".doc:not([hidden]) .page.preview";
const PREVIEW_PANE = ".doc:not([hidden]) .preview-pane";

const card = (page: Page, text: string) => page.locator(`${PANEL} .comment-card:not(.draft)`, { hasText: text });
const draft = (page: Page) => page.locator(`${PANEL} .comment-card.draft`);
const commentButton = (page: Page) => page.getByRole("button", { name: "Comment", exact: true });
/** The comments' words as marked in the Markdown text, one entry a mark. */
const textMarks = (page: Page) => page.locator(".doc:not([hidden]) .source-marks mark").allTextContents();
/** The comments' words as highlighted in the preview, joined up where a highlight crosses bold or italic. */
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
const editorMarks = (page: Page) => page.locator(`${EDITOR} .comment-range`).allTextContents();

async function toMarkdown(page: Page): Promise<void> {
  await page.getByRole("button", { name: "Markdown", exact: true }).click();
  await expect(page.locator(SOURCE)).toBeVisible();
}

async function toFormatted(page: Page): Promise<void> {
  await page.getByRole("button", { name: "Formatted", exact: true }).click();
  await expect(page.locator(EDITOR)).toBeVisible();
}

/** Select these characters in the Markdown text (the first time they come), as the person would. */
async function selectInText(page: Page, chars: string): Promise<void> {
  await page.locator(SOURCE).evaluate((area: HTMLTextAreaElement, wanted) => {
    const at = area.value.indexOf(wanted);
    if (at < 0) throw new Error(`"${wanted}" isn't in the Markdown text`);
    area.focus();
    area.setSelectionRange(at, at + wanted.length);
  }, chars);
  await settle(page);
}

/** Put the cursor in the Markdown text just before (or after) these characters. */
async function cursorInText(page: Page, chars: string, after = false): Promise<void> {
  await page.locator(SOURCE).evaluate(
    (area: HTMLTextAreaElement, [wanted, end]) => {
      const at = area.value.indexOf(wanted as string) + (end ? (wanted as string).length : 0);
      area.focus();
      area.setSelectionRange(at, at);
    },
    [chars, after] as const,
  );
  await settle(page);
}

/** Drag across the preview from the start of `from` to the end of `to`, as the person would with the mouse. */
async function dragInPreview(page: Page, from: string, to: string): Promise<void> {
  const ends = await page.locator(PREVIEW).evaluate(
    (preview, [first, last]) => {
      const spot = (wanted: string, end: boolean) => {
        const walker = document.createTreeWalker(preview, NodeFilter.SHOW_TEXT);
        for (let node = walker.nextNode(); node; node = walker.nextNode()) {
          const at = node.textContent!.indexOf(wanted);
          if (at < 0) continue;
          const range = document.createRange();
          range.setStart(node, end ? at + wanted.length - 1 : at);
          range.setEnd(node, end ? at + wanted.length : at + 1);
          const r = range.getBoundingClientRect();
          return { x: end ? r.right - 1 : r.left + 1, y: r.top + r.height / 2 };
        }
        throw new Error(`"${wanted}" isn't in the preview`);
      };
      return [spot(first, false), spot(last, true)];
    },
    [from, to] as const,
  );
  await page.mouse.move(ends[0].x, ends[0].y);
  await page.mouse.down();
  await page.mouse.move(ends[1].x, ends[1].y, { steps: 6 });
  await page.mouse.up();
  await settle(page);
}

/** Write the comment in the box that just opened, and post it. */
async function post(page: Page, body: string): Promise<void> {
  const box = page.getByRole("textbox", { name: "New comment" });
  await expect(box).toBeFocused();
  await box.fill(body);
  await page.getByRole("button", { name: "Post" }).click();
  await expect(card(page, body)).toBeVisible();
}

/** Comment on words in the formatted view. */
async function commentFormatted(run: Running, words: string, body: string): Promise<void> {
  await selectText(run.page, words);
  await commentButton(run.page).click();
  await post(run.page, body);
}

/** The comments as Corillo keeps them, in its data folder. */
function storedThreads(run: Running): Thread[] {
  const index = JSON.parse(readFileSync(join(run.dataDir, "documents.json"), "utf8")) as Record<string, { path: string }>;
  const id = Object.keys(index).find((k) => index[k].path === run.file);
  const file = join(run.dataDir, "documents", id ?? "none", "comments.json.gz");
  return existsSync(file) ? (JSON.parse(gunzipSync(readFileSync(file)).toString("utf8")) as Thread[]) : [];
}

test("words selected in the Markdown text get a comment on the same words as in the formatted view, without Markdown's marks", async () => {
  const DOC = "# Plan\n\nWe need **two new** people this spring.\n";
  const run = await openText(DOC);
  const { page } = run;
  await toMarkdown(page);
  await expect(page.locator(PANEL)).toBeVisible();

  await selectInText(page, "**two new** people");
  await commentButton(page).click();
  await expect(draft(page).locator(".comment-quote")).toHaveText("two new people");
  await post(page, "Is two enough?");
  await expect(card(page, "Is two enough?").locator(".comment-quote")).toHaveText("two new people");
  await expect.poll(() => storedThreads(run)[0]?.anchor?.quote).toBe("two new people");

  // Marked in both panes: in the text from its first word, in the preview as in the formatted view.
  await expect.poll(() => textMarks(page)).toEqual(["two new** people"]);
  await expect.poll(() => previewMarks(page)).toEqual(["two new people"]);
  await toFormatted(page);
  expect((await editorMarks(page)).join("")).toBe("two new people");
  await page.waitForTimeout(600);
  expect(run.text()).toBe(DOC);
  await run.app.close();
});

test("words selected in the preview get a comment too, from ⌥⌘M, the Insert menu or a right-click, in the preview or the text", async () => {
  const DOC = "# Plan\n\nWe need **two new** people this spring.\n\nThe budget is *tight* this year, says the treasurer.\n";
  const run = await openText(DOC);
  const { page, app } = run;
  await toMarkdown(page);

  await dragInPreview(page, "new", "people");
  await page.keyboard.press("Meta+Alt+KeyM");
  await expect(draft(page).locator(".comment-quote")).toHaveText("new people");
  await post(page, "Why new?");
  await expect.poll(() => previewMarks(page)).toEqual(["new people"]);
  await expect.poll(() => textMarks(page)).toEqual(["new** people"]);

  await dragInPreview(page, "tight", "tight");
  await clickMenu(app, "comment-add");
  await expect(draft(page).locator(".comment-quote")).toHaveText("tight");
  await post(page, "How tight?");

  // A right-click in the preview offers New Comment, as on the page.
  await dragInPreview(page, "treasurer", "treasurer");
  await page.locator(PREVIEW).dispatchEvent("contextmenu");
  await settle(page);
  let items = await rightClick(app, { isEditable: false, selectionText: "treasurer" });
  expect(items.find((i) => i.label === "New Comment")).toMatchObject({ visible: true, enabled: true });
  await chooseInContextMenu(app, "New Comment");
  await expect(draft(page).locator(".comment-quote")).toHaveText("treasurer");
  await post(page, "Which one?");

  // And in the Markdown text, which is a text box.
  await selectInText(page, "budget");
  await page.locator(SOURCE).dispatchEvent("contextmenu");
  await settle(page);
  items = await rightClick(app, { formControlType: "text-area", selectionText: "budget" });
  expect(items.find((i) => i.label === "New Comment")).toMatchObject({ visible: true, enabled: true });
  await chooseInContextMenu(app, "New Comment");
  await expect(draft(page).locator(".comment-quote")).toHaveText("budget");
  await post(page, "Whose budget?");

  await expect.poll(() => previewMarks(page)).toEqual(["new people", "budget", "tight", "treasurer"]);
  await toFormatted(page);
  for (const [body, quote] of [["Why new?", "new people"], ["How tight?", "tight"], ["Which one?", "treasurer"], ["Whose budget?", "budget"]]) {
    await expect(card(page, body).locator(".comment-quote")).toHaveText(quote);
  }
  expect(run.text()).toBe(DOC);
  await run.app.close();
});

test("selecting only Markdown's marks says what to select instead; with no selection the comment is on the whole document; front matter can be commented on", async () => {
  const DOC = "---\ntitle: Plan\n---\n\n# Plan\n\nWe need **two new** people.\n\n| Item | Cost |\n| --- | --- |\n| Tool | 0 |\n";
  const run = await openText(DOC);
  const { page } = run;
  await toMarkdown(page);
  const note = page.locator(`${PANEL} .comments-note`);

  for (const marks of ["**", "| --- | --- |", "# "]) {
    await selectInText(page, marks);
    await commentButton(page).click();
    await expect(note, marks).toHaveText("Select some words to comment on. Markdown's marks on their own can't hold a comment.");
    await expect(draft(page)).toHaveCount(0);
  }

  // The front matter's words.
  await selectInText(page, "title: Plan");
  await commentButton(page).click();
  await expect(note).toBeHidden();
  await expect(draft(page).locator(".comment-quote")).toHaveText("title: Plan");
  await post(page, "A better title?");
  await expect.poll(() => textMarks(page)).toEqual(["title: Plan"]);

  // Only the cursor, nothing selected: a comment on the whole document, as in the formatted view.
  await cursorInText(page, "We need");
  await page.keyboard.press("Meta+Alt+KeyM");
  await expect(draft(page).locator(".comment-whole")).toBeVisible();
  await post(page, "Overall: fine.");
  await expect(card(page, "Overall: fine.").locator(".comment-whole")).toBeVisible();

  await toFormatted(page);
  await expect(card(page, "A better title?").locator(".comment-quote")).toHaveText("title: Plan");
  await page.waitForTimeout(600);
  expect(run.text()).toBe(DOC);
  await run.app.close();
});

test("a comment stays on its words while the Markdown text is typed in, and one Undo in the formatted view takes the typing back", async () => {
  const DOC = "# Plan\n\nWe need two new people this spring.\n";
  const run = await openText(DOC);
  const { page } = run;
  await commentFormatted(run, "two new people", "Is two enough?");
  await toMarkdown(page);
  await expect.poll(() => textMarks(page)).toEqual(["two new people"]);
  await expect.poll(() => previewMarks(page)).toEqual(["two new people"]);

  // Typing before the words moves the mark with them, straight away.
  await cursorInText(page, "We need");
  await page.keyboard.type("So ");
  expect(await textMarks(page)).toEqual(["two new people"]);
  // Typing among them: the comment takes in the new word.
  await cursorInText(page, "new people");
  await page.keyboard.type("very ");
  expect(await textMarks(page)).toEqual(["two very new people"]);
  // Typing just after them leaves the comment as it was.
  await cursorInText(page, "people", true);
  await page.keyboard.type(" soon");
  expect(await textMarks(page)).toEqual(["two very new people"]);

  await expect.poll(() => previewMarks(page)).toEqual(["two very new people"]);
  await expect(card(page, "Is two enough?").locator(".comment-quote")).toHaveText("two very new people");
  await expectFile(run, "# Plan\n\nSo We need two very new people soon this spring.\n");
  await toFormatted(page);
  await expect.poll(() => editorMarks(page)).toEqual(["two very new people"]);
  await page.keyboard.press("Meta+z");
  await expectFile(run, DOC);
  await expect.poll(() => editorMarks(page)).toEqual(["two new people"]);
  await run.app.close();
});

/** Twelve paragraphs, too long for one screen, with a word to comment on in each. */
const WORDS = ["Alpha", "Bravo", "Charlie", "Delta", "Echo", "Foxtrot", "Golf", "Hotel", "India", "Juliet", "Kilo", "Lima"];
const FILLER =
  "The team met on Tuesday to go through the numbers again, and everyone agreed the plan needs a clearer story about what we stop doing, not only what we start.";
const LONG = "# Plan for the year\n\n" + WORDS.map((w) => `${w} opens this paragraph. ${FILLER} ${FILLER}`).join("\n\n") + "\n";

/** True if this element is wholly inside the visible part of that one; if not, where each is. */
function within(page: Page, inner: string, outer: string): Promise<true | string> {
  return page.evaluate(
    ([a, b]) => {
      const i = document.querySelector(a)?.getBoundingClientRect();
      const o = document.querySelector(b)?.getBoundingClientRect();
      if (i && o && i.height > 0 && i.top >= o.top - 1 && i.bottom <= o.bottom + 1) return true;
      return `${a}: ${i ? `${i.top}-${i.bottom}` : "missing"}, in ${o ? `${o.top}-${o.bottom}` : "missing"}`;
    },
    [inner, outer] as const,
  );
}

test("clicking a comment's words in the text or the preview puts its card in focus; clicking a card brings its words into sight in both", async () => {
  const run = await openText(LONG);
  const { page } = run;
  await page.setViewportSize({ width: 1440, height: 800 });
  await commentFormatted(run, "Alpha", "About Alpha.");
  await commentFormatted(run, "Lima", "About Lima.");
  await page.locator(`${EDITOR} h1`).click();
  await settle(page);
  await page.keyboard.press("Meta+Alt+KeyM");
  await post(page, "Overall: a good start.");
  await expect(card(page, "Overall: a good start.").locator(".comment-whole")).toBeVisible();
  await toMarkdown(page);
  const id = (body: string) => card(page, body).getAttribute("data-thread-id");
  const alpha = await id("About Alpha.");
  const lima = await id("About Lima.");
  const textMark = (thread: string | null) => `.doc:not([hidden]) .source-marks mark[data-comment="${thread}"]`;
  const previewMark = (thread: string | null) => `${PREVIEW} .comment-range[data-comment="${thread}"]`;

  // A click on the words in the text (the marks sit behind it).
  await page.locator(SOURCE).evaluate((area) => (area.scrollTop = area.scrollHeight));
  await expect.poll(() => within(page, textMark(lima), SOURCE)).toBe(true);
  const box = (await page.locator(textMark(lima)).boundingBox())!;
  await page.mouse.click(box.x + box.width / 2, box.y + box.height / 2);
  await expect(card(page, "About Lima.")).toHaveClass(/active/);
  await expect(card(page, "About Lima.")).toBeInViewport();
  await expect(page.locator(SOURCE)).toBeFocused(); // the cursor stays in the text
  await expect.poll(() => page.locator(textMark(lima)).getAttribute("class")).toBe("active");

  // A click on the words in the preview.
  await page.locator(PREVIEW_PANE).evaluate((p) => (p.scrollTop = 0));
  await page.locator(previewMark(alpha)).click();
  await expect(card(page, "About Alpha.")).toHaveClass(/active/);
  await expect(card(page, "About Lima.")).not.toHaveClass(/active/);

  // A click on a card: its words come into sight in both, wherever they were scrolled.
  await page.locator(SOURCE).evaluate((area) => (area.scrollTop = 0));
  await page.locator(PREVIEW_PANE).evaluate((p) => (p.scrollTop = 0));
  await card(page, "About Lima.").locator(".comment-body").click();
  await expect(card(page, "About Lima.")).toHaveClass(/active/);
  await expect.poll(() => within(page, textMark(lima), SOURCE)).toBe(true);
  await expect.poll(() => within(page, previewMark(lima), PREVIEW_PANE)).toBe(true);
  await expect(page.locator(SOURCE)).not.toBeFocused(); // and the keyboard stays with the card
  // In focus, its words are marked more strongly in both halves, with the same colour.
  const fill = await page.locator(textMark(lima)).evaluate((m) => getComputedStyle(m).backgroundColor);
  await expect(page.locator(previewMark(lima)).first()).toHaveCSS("background-color", fill);
  await expect(page.locator(textMark(alpha))).not.toHaveCSS("background-color", fill);

  // A whole-document comment: both go to the top.
  await card(page, "Overall: a good start.").locator(".comment-body").click();
  await expect.poll(() => page.locator(SOURCE).evaluate((a) => a.scrollTop)).toBe(0);
  await expect.poll(() => page.locator(PREVIEW_PANE).evaluate((p) => p.scrollTop)).toBe(0);
  await run.app.close();
});

type Line = { left: number; top: number; right: number };
/** Boxes on the same line joined into one (a space at a line's end may come as a box of its own). */
function byLine(boxes: Line[]): Line[] {
  const lines = new Map<number, Line>();
  for (const b of boxes) {
    const line = lines.get(b.top);
    lines.set(b.top, line ? { top: b.top, left: Math.min(line.left, b.left), right: Math.max(line.right, b.right) } : b);
  }
  return [...lines.values()].sort((a, b) => a.top - b.top);
}

/**
 * Where these words are in the Markdown text, worked out afresh from the text
 * box's own style: a copy laid over it, set the same way, with the words in a
 * span. Each line of the words, as a box on screen.
 */
async function wordsInText(page: Page, words: string): Promise<Line[]> {
  return byLine(await page.locator(SOURCE).evaluate((area: HTMLTextAreaElement, wanted) => {
    const style = getComputedStyle(area);
    const box = area.getBoundingClientRect();
    const copy = document.createElement("div");
    Object.assign(copy.style, {
      position: "fixed", left: `${box.left + area.clientLeft}px`, top: `${box.top + area.clientTop - area.scrollTop}px`,
      boxSizing: "border-box", width: `${area.clientWidth}px`, padding: style.padding, font: style.font,
      letterSpacing: style.letterSpacing, tabSize: style.tabSize, whiteSpace: "pre-wrap", overflowWrap: "break-word", visibility: "hidden",
    });
    const at = area.value.indexOf(wanted);
    const span = document.createElement("span");
    span.textContent = wanted;
    copy.append(area.value.slice(0, at), span, area.value.slice(at + wanted.length));
    document.body.append(copy);
    const lines = [...span.getClientRects()].map((r) => ({ left: Math.round(r.left), top: Math.round(r.top), right: Math.round(r.right) }));
    copy.remove();
    return lines;
  }, words));
}

/** Each line of a comment's mark behind the Markdown text, as a box on screen. */
async function markInText(page: Page, words: string): Promise<Line[]> {
  return byLine(await page.evaluate((wanted) => {
    const marks = [...document.querySelectorAll<HTMLElement>(".doc:not([hidden]) .source-marks mark")].filter((m) => m.textContent === wanted);
    return marks.flatMap((m) => [...m.getClientRects()].map((r) => ({ left: Math.round(r.left), top: Math.round(r.top), right: Math.round(r.right) })));
  }, words));
}

test("in the Markdown view, a comment's words are marked exactly over them, with line numbers on and scroll bars that take room", async () => {
  const filler = "Each line here runs on long enough to wrap in the Markdown text, so the marks have to wrap exactly as the words do.";
  const run = await openText(`# Plan\n\nWe need two people this spring. ${filler} ${filler} The budget comes from training. ${filler}\n`);
  const { page } = run;
  // Scroll bars like the ones the Mac shows when a mouse is connected, whatever this Mac's own setting.
  await page.addStyleTag({ content: "::-webkit-scrollbar { width: 15px; height: 15px; } ::-webkit-scrollbar-thumb { background: #888; }" });
  await page.setViewportSize({ width: 1100, height: 700 });
  await commentFormatted(run, "We need", "Who's we?");
  await commentFormatted(run, "The budget comes from training", "Which training line?");
  await toMarkdown(page);
  // The second comment's words come after several wrapped lines, so the marks must wrap as the text does.
  for (const lineNumbers of [false, true]) {
    if (lineNumbers) await clickMenu(run.app, "line-numbers");
    await expect(page.locator(".doc:not([hidden]) .line-gutter")).toBeVisible({ visible: lineNumbers });
    for (const words of ["We need", "The budget comes from training"]) {
      const where = await wordsInText(page, words);
      expect(where.length).toBeGreaterThan(0);
      await expect.poll(() => markInText(page, words)).toEqual(where);
    }
  }
  await run.app.close();
});

test("a comment being written, a reply or an edit stays, with its cursor, when switching views and when the panel is hidden and shown", async () => {
  const run = await openText("# Plan\n\nWe need two people this spring.\n");
  const { page } = run;
  await commentFormatted(run, "two people", "Is two enough?");
  const caret = (box: ReturnType<Page["getByRole"]>) => box.evaluate((b: HTMLTextAreaElement) => [b.value, b.selectionStart, b.selectionEnd]);
  const commentsTool = page.locator("#toolbar .comments-tool");

  // A new comment, half written in the formatted view, the cursor in the middle.
  await selectText(page, "spring");
  await commentButton(page).click();
  const box = page.getByRole("textbox", { name: "New comment" });
  await box.fill("Too late?");
  await box.press("ArrowLeft");
  await toMarkdown(page);
  await expect(box).toBeFocused();
  expect(await caret(box)).toEqual(["Too late?", 8, 8]);
  await expect(draft(page).locator(".comment-quote")).toHaveText("spring");
  await expect.poll(() => textMarks(page)).toEqual(["two people", "spring"]);
  await page.keyboard.type("r");
  await toFormatted(page);
  await expect(box).toBeFocused();
  expect(await caret(box)).toEqual(["Too later?", 9, 9]);
  // Hidden and shown again, it's still there, the cursor in it.
  await commentsTool.click();
  await expect(page.locator(PANEL)).toBeHidden();
  await commentsTool.click();
  await expect(box).toBeFocused();
  expect(await caret(box)).toEqual(["Too later?", 9, 9]);
  await page.getByRole("button", { name: "Post" }).click();
  await expect(card(page, "Too later?")).toBeVisible();

  // A reply, in the Markdown view, and back.
  await toMarkdown(page);
  await card(page, "Is two enough?").locator(".comment-body").click();
  const reply = card(page, "Is two enough?").getByRole("textbox", { name: "Reply" });
  await reply.fill("Three, maybe.");
  await toFormatted(page);
  await expect(reply).toBeFocused();
  expect(await caret(reply)).toEqual(["Three, maybe.", 13, 13]);
  await toMarkdown(page);
  await expect(reply).toBeFocused();
  await reply.press("Meta+Enter");
  await expect(card(page, "Is two enough?")).toContainText("Three, maybe.");

  // An edit of a comment already posted.
  await card(page, "Too later?").locator(".comment-body").click();
  await messageAction(card(page, "Too later?"), "Edit");
  const edit = page.getByRole("textbox", { name: "Edit comment" });
  await expect(edit).toBeFocused();
  await page.keyboard.type(" Or June.");
  await toFormatted(page);
  await expect(edit).toBeFocused();
  expect((await caret(edit))[0]).toBe("Too later? Or June.");
  await commentsTool.click();
  await commentsTool.click();
  await expect(edit).toBeFocused();
  await page.getByRole("button", { name: "Save" }).click();
  await expect(card(page, "Too later? Or June.")).toBeVisible();
  await run.app.close();
});

test("coming back to a tab mid-comment, the keyboard is back in the comment, so typing goes on there and never over the words it's on", async () => {
  const DOC = "# Plan\n\nWe need two people this spring.\n";
  const run = await openText(DOC);
  const { page } = run;
  const tab = (name: string) => page.locator(`.tab[title$="/${name}"]`);
  await selectText(page, "two people");
  await commentButton(page).click();
  const box = page.getByRole("textbox", { name: "New comment" });
  await box.fill("Is two");
  await openAlso(run, "other.md", "# Other\n\nSomething else.\n");
  await expect(tab("other.md")).toHaveAttribute("aria-selected", "true");
  await tab("proposal.md").click();
  await expect(box).toBeFocused();
  await page.keyboard.type(" enough?");
  await expect(box).toHaveValue("Is two enough?");
  await settle(page);
  expect(run.text()).toBe(DOC);

  // The same in the Markdown view, with a reply.
  await page.getByRole("button", { name: "Post" }).click();
  await toMarkdown(page);
  await card(page, "Is two enough?").locator(".comment-body").click();
  const reply = card(page, "Is two enough?").getByRole("textbox", { name: "Reply" });
  await reply.fill("Or three");
  await tab("other.md").click();
  await expect(page.locator(`${EDITOR} .ProseMirror`)).toBeFocused();
  await tab("proposal.md").click();
  await expect(reply).toBeFocused();
  // Having gone back to the document, the keyboard comes back to the document.
  await page.locator(SOURCE).click();
  await tab("other.md").click();
  await tab("proposal.md").click();
  await expect(page.locator(SOURCE)).toBeFocused();
  await reply.press("Meta+Enter");
  await expect(card(page, "Is two enough?")).toContainText("Or three");
  await run.app.close();
});

/** Send the window an event from the app, as the agents' side does. */
async function sendToWindow(run: Running, channel: string, payload: unknown): Promise<void> {
  const docId = await run.page.locator(".doc:not([hidden])").getAttribute("data-doc-id");
  await run.app.evaluate(
    ({ BrowserWindow }, [ch, id, data]) => BrowserWindow.getAllWindows()[0].webContents.send(ch, id, data),
    [channel, docId, payload] as const,
  );
}

const menuLabel = (run: Running, id: string) =>
  run.app.evaluate(({ Menu }, itemId) => Menu.getApplicationMenu()?.getMenuItemById(itemId)?.label ?? null, id);

test("the panel is open from the start; hiding it is remembered for every document between launches; a new comment or an agent's reply shows it again", async () => {
  const DOC = "# Plan\n\nWe need two people this spring.\n";
  const first = await openText(DOC);
  const tool = (page: Page) => page.locator("#toolbar .comments-tool");
  let page = first.page;
  await expect(page.locator(PANEL)).toBeVisible();
  await expect(page.locator(`${PANEL} .comments-empty`)).toHaveText(
    "Select some words, then choose New comment (⌥⌘M). With nothing selected, it's a comment on the whole document. Your comments go to the agents working on this document.",
  );
  await expect(tool(page)).toHaveAttribute("aria-pressed", "true");
  await expect.poll(() => menuLabel(first, "view-comments")).toBe("Hide Comments");

  // Hidden with the toolbar's Comments button: for this document, and the next one opened.
  await tool(page).click();
  await expect(page.locator(PANEL)).toBeHidden();
  await expect(tool(page)).toHaveAttribute("aria-pressed", "false");
  await expect.poll(() => menuLabel(first, "view-comments")).toBe("Show Comments");
  await openAlso(first, "second.md", "Second document.\n");
  await expect(page.locator(".tab")).toHaveCount(2);
  await expect(page.locator(PANEL)).toBeHidden();
  await first.app.close();

  // The next launch, with the same data folder: still hidden.
  const again = await openText(DOC, { dataDir: first.dataDir });
  page = again.page;
  // Last launch's two tabs come back beside this one (restore-tabs.spec.ts).
  await expect(page.locator(".tab")).toHaveCount(3);
  await expect.poll(() => menuLabel(again, "view-comments")).toBe("Show Comments");
  await expect(page.locator(PANEL)).toBeHidden();

  // A new comment shows it, in the Markdown view too.
  await toMarkdown(page);
  await selectInText(page, "two people");
  await page.keyboard.press("Meta+Alt+KeyM");
  await expect(page.locator(PANEL)).toBeVisible();
  await post(page, "Is two enough?");
  await expect(page.locator(PANEL)).toBeVisible();
  await expect(tool(page)).toHaveAttribute("aria-pressed", "true");

  // Hidden again, then an agent replies: it shows, with the reply.
  await tool(page).click();
  await expect(page.locator(PANEL)).toBeHidden();
  const threads = storedThreads(again);
  threads[0].messages.push({ id: "reply-from-writer", author: { kind: "agent", name: "Writer" }, body: "Two is plenty.", created: new Date().toISOString() });
  await sendToWindow(again, "comments:changed", threads);
  await expect(page.locator(PANEL)).toBeVisible();
  await expect(card(page, "Is two enough?")).toContainText("Two is plenty.");
  // The choice stays hidden: the next document opened starts without the panel.
  await openAlso(again, "third.md", "Third document.\n");
  await expect(page.locator(".tab")).toHaveCount(4);
  await expect(page.locator(PANEL)).toBeHidden();
  await again.app.close();
});

test("the toolbar's Comments button counts the open comments, and takes turns with History in the same place", async () => {
  const run = await openText("# Plan\n\nWe need two people this spring.\n");
  const { page } = run;
  const tool = page.locator("#toolbar .comments-tool");
  const history = page.getByRole("button", { name: "History", exact: true });
  // Beside Comment, in the same group (Orlando, 2026-11-09: like with like).
  await expect(page.locator("#toolbar .comment-tools .comments-tool")).toHaveCount(1);
  await expect(page.locator("#toolbar .comment-tools button").first()).toHaveAccessibleName("Comment");
  await expect(tool).toHaveAccessibleName("Comments");
  await expect(tool.locator(".tool-count")).toBeHidden();
  await commentFormatted(run, "two people", "Is two enough?");
  await commentFormatted(run, "spring", "Too late?");
  await expect(tool).toHaveAccessibleName("Comments, 2 open");
  await expect(tool.locator(".tool-count")).toHaveText("2");
  await expect(page.locator("#comments-toggle")).toHaveText("2 comments");
  await card(page, "Too late?").getByRole("button", { name: "Resolve" }).click();
  await expect(tool.locator(".tool-count")).toHaveText("1");

  // History takes the panel's place; Comments brings the comments back.
  await history.click();
  await expect(page.locator(".doc:not([hidden]) .history-panel")).toBeVisible();
  await expect(page.locator(PANEL)).toBeHidden();
  await expect(tool).toHaveAttribute("aria-pressed", "false");
  await tool.click();
  await expect(page.locator(".doc:not([hidden]) .history-panel")).toBeHidden();
  await expect(page.locator(PANEL)).toBeVisible();
  await expect(tool).toHaveAttribute("aria-pressed", "true");

  // The same in the Markdown view, and the status bar's count does the same as the button.
  await toMarkdown(page);
  await expect(page.locator(PANEL)).toBeVisible();
  await page.locator("#comments-toggle").click();
  await expect(page.locator(PANEL)).toBeHidden();
  await expect(tool).toHaveAttribute("aria-pressed", "false");
  await page.keyboard.press("Control+Meta+KeyM");
  await expect(page.locator(PANEL)).toBeVisible();
  await expect(tool).toHaveAttribute("aria-pressed", "true");
  await run.app.close();
});

test("in a narrow window the panel gives way first in the Markdown view, and nothing scrolls sideways", async () => {
  const run = await openText(LONG);
  const { page } = run;
  await commentFormatted(run, "Alpha", "About Alpha.");
  await toMarkdown(page);
  const sizes = () =>
    page.evaluate(
      ([panel, source, pane]) => ({
        panel: Math.round(document.querySelector(panel)!.getBoundingClientRect().width),
        text: Math.round(document.querySelector(source)!.getBoundingClientRect().width),
        preview: Math.round(document.querySelector(pane)!.getBoundingClientRect().width),
        sideways: document.documentElement.scrollWidth > innerWidth,
      }),
      [PANEL, SOURCE, PREVIEW_PANE] as const,
    );
  await page.setViewportSize({ width: 1440, height: 800 });
  await expect.poll(sizes).toMatchObject({ panel: 304, sideways: false });
  // Narrower: the panel shrinks first, so the text and its preview keep 320 pixels each.
  await page.setViewportSize({ width: 920, height: 800 });
  await expect.poll(sizes).toMatchObject({ panel: 280, sideways: false });
  const at920 = await sizes();
  expect(Math.min(at920.text, at920.preview)).toBeGreaterThanOrEqual(319);
  // Narrower still: the panel stays at its smallest, and the two halves share the rest.
  for (const width of [800, 760]) {
    await page.setViewportSize({ width, height: 800 });
    await expect.poll(sizes).toMatchObject({ panel: 264, sideways: false });
  }
  await expect(card(page, "About Alpha.")).toBeVisible();
  // The formatted view, in a 920-pixel window, keeps the panel's chosen width.
  await page.setViewportSize({ width: 920, height: 800 });
  await toFormatted(page);
  await expect.poll(sizes).toMatchObject({ panel: 304, sideways: false });
  await run.app.close();
});
