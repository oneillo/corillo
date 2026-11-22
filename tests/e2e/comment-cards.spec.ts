// The comment cards, in the panel beside the document (Orlando, 2026-11-09):
// listed top to bottom with whole-document comments and any that have lost
// their words first, then in the order of their words; the panel scrolls on
// its own; clicking a card brings its words into sight, and the words in
// focus bring their card into sight; and the line being typed in a comment
// box stays in sight as the box grows. Each test runs the real app on a
// throwaway document and data folder.
import { test, expect, type Page } from "@playwright/test";
import { writeFileSync } from "node:fs";
import { clickMenu, cursorAtEnd, expectFile, messageAction, openAlso, openText, selectText, settle, EDITOR, type Running } from "./helpers";
import { AgentSession } from "./agent-session";

const PANEL = ".doc:not([hidden]) aside.comments-panel";
const CANVAS = ".doc:not([hidden]) .canvas:not(.version-view)";
const SOURCE = ".doc:not([hidden]) textarea.source";
const PREVIEW_PANE = ".doc:not([hidden]) .preview-pane";

const card = (page: Page, text: string) => page.locator(`${PANEL} .comment-card:not(.draft)`, { hasText: text });

/** Twelve paragraphs, too long for one screen, with a word to comment on in each. */
const WORDS = ["Alpha", "Bravo", "Charlie", "Delta", "Echo", "Foxtrot", "Golf", "Hotel", "India", "Juliet", "Kilo", "Lima"];
const FILLER =
  "The team met on Tuesday to go through the numbers again, and everyone agreed the plan needs a clearer story about what we stop doing, not only what we start.";
const LONG = "# Plan for the year\n\n" + WORDS.map((w) => `${w} opens this paragraph. ${FILLER} ${FILLER}`).join("\n\n") + "\n";
/** A comment long enough to take several lines in the panel. */
const NOTE = "A note long enough to take a few lines in the panel, so a handful of cards fill it and the last ones sit below its edge.";

/** Comment on these words, or on the whole document with none. */
async function comment(run: Running, words: string | null, body: string): Promise<void> {
  if (words) await selectText(run.page, words);
  else {
    await run.page.locator(`${EDITOR} h1`).click();
    await settle(run.page);
  }
  await run.page.getByRole("button", { name: "Comment", exact: true }).click();
  await run.page.getByRole("textbox", { name: "New comment" }).fill(body);
  await run.page.getByRole("button", { name: "Post" }).click();
  await expect(card(run.page, body)).toBeVisible();
}

/** Each card's first message, top to bottom. */
const order = (page: Page) =>
  page.locator(`${PANEL} .comment-card:not(.draft)`).evaluateAll((cards) => cards.map((c) => c.querySelector(".comment-body")?.textContent ?? ""));

const scrollTo = (page: Page, selector: string, top: number) => page.locator(selector).evaluate((e, y) => (e.scrollTop = y), top);
const scrollOf = (page: Page, selector: string) => page.locator(selector).evaluate((e) => e.scrollTop);

/** True if this element is wholly inside the visible part of that one (the panel, a pane); if not, where each is. */
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
const cardSel = (id: string | null) => `${PANEL} .comment-card[data-thread-id="${id}"]`;
const wordsSel = (id: string | null) => `${EDITOR} .comment-range[data-comment="${id}"]`;
const idOf = (page: Page, body: string) => card(page, body).getAttribute("data-thread-id");

test("cards are listed with whole-document comments first, then any whose words are gone, then in the order of their words, in both views", async () => {
  const LAPTOPS = "We will buy new laptops for the whole support team in March.";
  const text = LONG.replace("\n\nHotel", `\n\n${LAPTOPS}\n\nHotel`);
  const run = await openText(text);
  const { page } = run;
  await page.setViewportSize({ width: 1440, height: 900 });
  // Made in no particular order.
  await comment(run, "Kilo", "About Kilo.");
  await comment(run, "Bravo", "About Bravo.");
  await comment(run, null, "Overall: a good start.");
  await comment(run, "buy new laptops", "About the laptops.");
  await comment(run, "Foxtrot opens this paragraph.", "About Foxtrot.");
  await expect.poll(() => order(page)).toEqual(["Overall: a good start.", "About Bravo.", "About Foxtrot.", "About the laptops.", "About Kilo."]);

  // The file changes outside Corillo and the laptops' words go: that card moves up, under the whole-document one.
  writeFileSync(run.file, text.replace(`${LAPTOPS}\n\n`, ""));
  await expect(card(page, "About the laptops.")).toContainText("The text this comment was on has changed.");
  const expected = ["Overall: a good start.", "About the laptops.", "About Bravo.", "About Foxtrot.", "About Kilo."];
  await expect.poll(() => order(page)).toEqual(expected);

  // The person deletes Foxtrot's words: its card keeps its place, as the empty line keeps theirs.
  await selectText(page, "Foxtrot opens this paragraph.");
  await page.keyboard.press("Backspace");
  await expect(page.locator(`${EDITOR} .comment-gap`)).toHaveCount(1);
  await expect.poll(() => order(page)).toEqual(expected);

  await page.getByRole("button", { name: "Markdown", exact: true }).click();
  await expect(page.locator(SOURCE)).toBeVisible();
  expect(await order(page)).toEqual(expected);
  await run.app.close();
});

test("the panel scrolls on its own: scrolling it leaves the document where it is, and a short document gets no extra room", async () => {
  const run = await openText("# Short\n\nOnly a few words here at the end of the page.\n");
  const { page } = run;
  await page.setViewportSize({ width: 1440, height: 700 });
  const pageRoom = () => page.locator(CANVAS).evaluate((c) => c.scrollHeight);
  const before = await pageRoom();
  for (const w of ["Only", "few", "words", "here", "end", "page"]) await comment(run, w, `${w}: ${NOTE}`);
  await page.locator(`${EDITOR} h1`).click();
  await settle(page);
  const panel = await page.locator(PANEL).evaluate((p) => ({ own: p.scrollHeight - p.clientHeight, overflow: getComputedStyle(p).overflowY }));
  expect(panel.own).toBeGreaterThan(0);
  expect(panel.overflow).toBe("auto");
  expect(await pageRoom()).toBe(before);

  // Scrolling over the panel moves the panel only, as far as its last card
  // (to within a pixel: the cards' text lines aren't whole pixels tall).
  const box = (await page.locator(PANEL).boundingBox())!;
  await page.mouse.move(box.x + box.width / 2, box.y + 300);
  await page.mouse.wheel(0, 3000);
  await expect.poll(async () => Math.abs((await scrollOf(page, PANEL)) - panel.own)).toBeLessThan(1);
  await expect(card(page, "page: ")).toBeInViewport();
  expect(await scrollOf(page, CANVAS)).toBe(0);

  // The same beside the Markdown view: its text and preview stay where they are.
  await page.getByRole("button", { name: "Markdown", exact: true }).click();
  await scrollTo(page, PANEL, 0);
  await page.mouse.move(box.x + box.width / 2, box.y + 300);
  await page.mouse.wheel(0, 3000);
  await expect.poll(() => scrollOf(page, PANEL)).toBeGreaterThan(0);
  expect([await scrollOf(page, SOURCE), await scrollOf(page, PREVIEW_PANE)]).toEqual([0, 0]);
  await run.app.close();
});

test("with a mouse connected (scroll bars that take room), cards keep their width once there are enough to scroll, even while a comment is being typed", async () => {
  const run = await openText("# Short\n\nOnly a few words here at the end of the page.\n");
  const { page } = run;
  // Scroll bars like the ones the Mac shows when a mouse is connected, whatever this Mac's own setting.
  await page.addStyleTag({ content: "::-webkit-scrollbar { width: 15px; height: 15px; } ::-webkit-scrollbar-thumb { background: #888; }" });
  await page.setViewportSize({ width: 1200, height: 600 });
  const widthOf = (e: Element) => e.getBoundingClientRect().width;
  const scrolls = () => page.locator(PANEL).evaluate((p) => p.scrollHeight > p.clientHeight);
  await comment(run, "Only", `Only: ${NOTE}`);
  expect(await scrolls()).toBe(false);
  // The scroll bar's room is kept beside the cards before there's anything to scroll.
  expect(await page.locator(PANEL).evaluate((p: HTMLElement) => p.offsetWidth - p.clientWidth)).toBeGreaterThanOrEqual(15);
  const first = card(page, "Only: ");
  const cardWidth = await first.evaluate(widthOf);

  // A new comment, typed line by line until the panel has to scroll: its box never narrows.
  await selectText(page, "few");
  await page.getByRole("button", { name: "Comment", exact: true }).click();
  const box = page.getByRole("textbox", { name: "New comment" });
  const boxWidth = await box.evaluate(widthOf);
  for (let i = 1; i <= 30 && !(await scrolls()); i++) {
    await box.pressSequentially(`Line ${i} of a long note.\n`);
    expect(await box.evaluate(widthOf), `after line ${i}`).toBe(boxWidth);
  }
  expect(await scrolls()).toBe(true);
  await page.getByRole("button", { name: "Post" }).click();
  await expect(card(page, "Line 1 of a long note.")).toBeVisible();

  // More cards, and the panel scrolls: the first card is as wide as it was.
  for (const w of ["words", "here", "end"]) await comment(run, w, `${w}: ${NOTE}`);
  expect(await scrolls()).toBe(true);
  expect(await first.evaluate(widthOf)).toBe(cardWidth);
  await run.app.close();
});

test("clicking any part of a card puts it in focus and brings its words into sight, leaving the keyboard where the click put it; a whole-document card goes to the top", async () => {
  const run = await openText(LONG);
  const { page } = run;
  await page.setViewportSize({ width: 1440, height: 800 });
  await comment(run, "Alpha", "About Alpha.");
  await comment(run, "Kilo", "About Kilo.");
  await comment(run, null, "Overall: a good start.");
  const kilo = await idOf(page, "About Kilo.");
  const kiloWords = page.locator(wordsSel(kilo));

  // Its quote, its author, its words: anywhere on it.
  for (const part of [".comment-quote", ".comment-author", ".comment-body"]) {
    await page.locator(`${EDITOR} h1`).click();
    await scrollTo(page, CANVAS, 0);
    await expect(kiloWords).not.toBeInViewport();
    await card(page, "About Kilo.").locator(part).first().click();
    await expect(card(page, "About Kilo."), part).toHaveClass(/active/);
    await expect(kiloWords, part).toBeInViewport();
    await expect(page.locator(`${EDITOR} .ProseMirror`), part).not.toBeFocused();
  }

  // Its reply box: the words come into sight, and the keyboard stays in the box.
  await scrollTo(page, CANVAS, 0);
  const reply = card(page, "About Kilo.").getByRole("textbox", { name: "Reply" });
  await reply.click();
  await expect(kiloWords).toBeInViewport();
  await expect(reply).toBeFocused();
  await page.keyboard.type("Agreed");
  await expect(reply).toHaveValue("Agreed");
  await reply.fill("");

  // A whole-document comment: the top of the document.
  await scrollTo(page, CANVAS, 2000);
  await card(page, "Overall: a good start.").locator(".comment-author").click();
  await expect(card(page, "Overall: a good start.")).toHaveClass(/active/);
  await expect.poll(() => scrollOf(page, CANVAS)).toBe(0);
  await run.app.close();
});

test("putting the cursor in a comment's words brings its card into sight in the panel, in both views", async () => {
  const run = await openText(LONG);
  const { page } = run;
  await page.setViewportSize({ width: 1440, height: 700 });
  for (const w of WORDS) await comment(run, w, `${w}: ${NOTE}`);
  const lima = await idOf(page, "Lima: ");
  const alpha = await idOf(page, "Alpha: ");

  // A click in the last comment's words, at the end of the document: its card scrolls into sight.
  await scrollTo(page, PANEL, 0);
  await page.locator(wordsSel(lima)).click();
  await expect(page.locator(cardSel(lima))).toHaveClass(/active/);
  await expect.poll(() => within(page, cardSel(lima), PANEL)).toBe(true);
  await expect(page.locator(`${EDITOR} .ProseMirror`)).toBeFocused();
  // The first one's: back up.
  await scrollTo(page, CANVAS, 0);
  await page.locator(wordsSel(alpha)).click();
  await expect.poll(() => within(page, cardSel(alpha), PANEL)).toBe(true);

  // In the Markdown text, moving the cursor into the words with the keyboard.
  await page.getByRole("button", { name: "Markdown", exact: true }).click();
  await scrollTo(page, PANEL, 0);
  await page.locator(SOURCE).evaluate((area: HTMLTextAreaElement) => {
    const at = area.value.indexOf("Lima opens");
    area.focus();
    area.setSelectionRange(at - 1, at - 1);
  });
  await settle(page);
  await page.keyboard.press("ArrowRight");
  await page.keyboard.press("ArrowRight");
  await expect(page.locator(cardSel(lima))).toHaveClass(/active/);
  await expect.poll(() => within(page, cardSel(lima), PANEL)).toBe(true);
  await expect(page.locator(SOURCE)).toBeFocused();
  await run.app.close();
});

/** The ids take_document shows, by the words each comment is on. */
function idsIn(text: string): Map<string, string> {
  const ids = new Map<string, string>();
  for (const m of text.matchAll(/\[([^\]]+)\] on "([^"]+)"/g)) ids.set(m[2], m[1]);
  return ids;
}

// Orlando, 2026-11-09: no Review mode; Next and Previous Comment go card to card, at any time.
test("Next and Previous Comment go card to card in the panel's order, bringing each card and its words into sight, in both views", async () => {
  const run = await openText(LONG);
  const { page } = run;
  await page.setViewportSize({ width: 1440, height: 700 });
  for (const w of WORDS) await comment(run, w, `${w}: ${NOTE}`);
  const { session: claude } = await AgentSession.start(run.dataDir, "claude-code");
  try {
    const ids = idsIn(await claude.ok("take_document", { path: run.file }));
    for (const w of ["Bravo", "Lima"]) await claude.ok("reply_to_comment", { path: run.file, comment_id: ids.get(w), text: `Done for ${w}.` });
    // The others are left for a later pass: the first finish says so, the second finishes.
    expect((await claude.call("finish_editing", { path: run.file })).text).toContain("still waiting for you");
    await claude.ok("finish_editing", { path: run.file });
    // The panel keeps one order, its words' (roadmap Batch 9, item 8): Next goes to the two answered first, as they're new.
    await page.locator(`${EDITOR} h1`).click(); // no card in focus
    await settle(page);
    const [alpha, bravo, kilo, lima] = [await idOf(page, "Alpha: "), await idOf(page, "Bravo: "), await idOf(page, "Kilo: "), await idOf(page, "Lima: ")];

    await clickMenu(run.app, "review-next");
    await expect(page.locator(cardSel(bravo))).toHaveClass(/active/);
    await expect.poll(() => within(page, cardSel(bravo), PANEL)).toBe(true);
    await expect(page.locator(wordsSel(bravo))).toBeInViewport();
    await page.keyboard.press("Meta+Alt+ArrowDown");
    await expect(page.locator(cardSel(lima))).toHaveClass(/active/);
    await expect.poll(() => within(page, cardSel(lima), PANEL)).toBe(true);
    await expect(page.locator(wordsSel(lima))).toBeInViewport();
    // Previous: the card before, in the panel's order.
    await clickMenu(run.app, "review-previous");
    await expect(page.locator(cardSel(kilo))).toHaveClass(/active/);
    await expect.poll(() => within(page, cardSel(kilo), PANEL)).toBe(true);
    await expect(page.locator(wordsSel(kilo))).toBeInViewport();

    // In the Markdown view: the card, and the words in the text and the preview.
    await page.getByRole("button", { name: "Markdown", exact: true }).click();
    await expect(page.locator(SOURCE)).toBeVisible();
    await clickMenu(run.app, "review-next");
    await expect(page.locator(cardSel(lima))).toHaveClass(/active/);
    await expect.poll(() => within(page, cardSel(lima), PANEL)).toBe(true);
    await expect.poll(() => within(page, `.doc:not([hidden]) .source-marks mark[data-comment="${lima}"]`, SOURCE)).toBe(true);
    await expect.poll(() => within(page, `.doc:not([hidden]) .page.preview .comment-range[data-comment="${lima}"]`, PREVIEW_PANE)).toBe(true);
    // After the last card, round to the first: Alpha.
    await clickMenu(run.app, "review-next");
    await expect(page.locator(cardSel(alpha))).toHaveClass(/active/);
    await expect.poll(() => within(page, cardSel(alpha), PANEL)).toBe(true);
    await expect.poll(() => within(page, `.doc:not([hidden]) .source-marks mark[data-comment="${alpha}"]`, SOURCE)).toBe(true);
  } finally {
    await run.app.close();
    await claude.stop();
  }
});

// Orlando, 2026-11-09: typing a comment near the bottom of the window, the
// panel scrolls so the words being typed stay in sight.

/**
 * Whether the line with the cursor in the comment box being typed in is in
 * sight in the panel (the cursor at the start or the end of what's typed),
 * and whether the box's buttons are.
 */
function caretSeen(page: Page): Promise<{ line: true | string; buttons: boolean; fits: boolean }> {
  return page.evaluate((panelSel) => {
    const box = document.activeElement as HTMLTextAreaElement;
    const panel = document.querySelector(panelSel)!.getBoundingClientRect();
    const r = box.getBoundingClientRect();
    const style = getComputedStyle(box);
    const lineHeight = parseFloat(style.lineHeight);
    const atEnd = box.selectionEnd === box.value.length;
    const top = atEnd ? r.bottom - parseFloat(style.paddingBottom) - parseFloat(style.borderBottomWidth) - lineHeight : r.top + parseFloat(style.paddingTop);
    const bottom = top + lineHeight;
    const line = top >= panel.top - 1 && bottom <= panel.bottom + 1 ? true : `line ${top}-${bottom} in panel ${panel.top}-${panel.bottom}`;
    let row: Element | null = null;
    for (let up = box.parentElement; up && !row; up = up.parentElement) row = up.querySelector(":scope > .comment-actions-row");
    const buttons = !!row && row.getBoundingClientRect().bottom <= panel.bottom + 1 && row.getBoundingClientRect().top >= panel.top - 1;
    const fits = !!row && row.getBoundingClientRect().bottom - r.top <= panel.height - 24;
    return { line, buttons, fits };
  }, PANEL);
}

const LINES = Array.from({ length: 14 }, (_, i) => `Line ${i + 1} of a long comment, typed or pasted.`);

test("typing many lines in a new comment near the bottom of the panel keeps the line being typed in sight, and Post and Cancel while they fit", async () => {
  const run = await openText(LONG);
  const { page } = run;
  await page.setViewportSize({ width: 1100, height: 600 });
  for (const w of WORDS.slice(0, 8)) await comment(run, w, `${w}: ${NOTE}`);
  // A new comment on the last paragraph: last in the list, at the bottom of the panel.
  await selectText(page, "Lima");
  await page.keyboard.press("Meta+Alt+KeyM");
  const box = page.getByRole("textbox", { name: "New comment" });
  await expect(box).toBeFocused();
  await expect.poll(async () => (await caretSeen(page)).line).toBe(true);
  expect(await scrollOf(page, PANEL)).toBeGreaterThan(0);

  for (const [i, line] of LINES.entries()) {
    await page.keyboard.type(line);
    if (i < LINES.length - 1) await page.keyboard.press("Enter");
    const seen = await caretSeen(page);
    expect(seen.line, line).toBe(true);
    if (seen.fits) expect(seen.buttons, `${line}: Post and Cancel`).toBe(true);
  }
  // Typing on a line already in sight doesn't move the panel.
  const still = await scrollOf(page, PANEL);
  await page.keyboard.type(" More.");
  expect(await scrollOf(page, PANEL)).toBe(still);
  // Up to the first line with the keyboard: it comes back into sight.
  await page.keyboard.press("Meta+ArrowUp");
  await expect.poll(async () => (await caretSeen(page)).line).toBe(true);
  await expect(box).toHaveValue(LINES.join("\n") + " More.");
  await page.keyboard.press("Meta+Enter");
  await expect(card(page, "Line 1 of a long comment")).toBeVisible();
  await run.app.close();
});

test("a paste of many lines, a reply and an edit keep the line being typed in sight too, beside the Markdown view in a narrow window", async () => {
  const run = await openText(LONG);
  const { page } = run;
  for (const w of WORDS.slice(0, 8)) await comment(run, w, `${w}: ${NOTE}`);
  await page.getByRole("button", { name: "Markdown", exact: true }).click();
  await page.setViewportSize({ width: 800, height: 600 });
  const many = LINES.join("\n");

  // A paste into a new comment, on words near the end.
  await page.locator(SOURCE).evaluate((area: HTMLTextAreaElement) => {
    const at = area.value.indexOf("Lima");
    area.focus();
    area.setSelectionRange(at, at + 4);
  });
  await settle(page);
  await page.keyboard.press("Meta+Alt+KeyM");
  await expect(page.getByRole("textbox", { name: "New comment" })).toBeFocused();
  await page.keyboard.insertText(many);
  await expect.poll(async () => (await caretSeen(page)).line).toBe(true);
  await page.keyboard.press("Meta+Enter");
  await expect(card(page, "Line 14 of a long comment")).toBeVisible();

  // A reply on a card at the bottom of the panel.
  const last = card(page, "Line 1 of a long comment");
  await scrollTo(page, PANEL, 100_000);
  const reply = last.getByRole("textbox", { name: "Reply" });
  await reply.click();
  for (const line of LINES.slice(0, 8)) {
    await page.keyboard.type(line);
    await page.keyboard.press("Enter");
    expect((await caretSeen(page)).line, `reply: ${line}`).toBe(true);
  }
  await reply.fill("");
  await page.keyboard.press("Escape");

  // An edit of a comment, made longer at its end.
  const hotel = card(page, "Hotel: ");
  await hotel.locator(".comment-body").click();
  await messageAction(hotel, "Edit");
  const edit = page.getByRole("textbox", { name: "Edit comment" });
  await expect(edit).toBeFocused();
  await page.keyboard.press("Meta+ArrowDown");
  for (const line of LINES.slice(0, 10)) {
    await page.keyboard.press("Enter");
    await page.keyboard.type(line);
    const seen = await caretSeen(page);
    expect(seen.line, `edit: ${line}`).toBe(true);
    if (seen.fits) expect(seen.buttons, `edit: ${line}: Save and Cancel`).toBe(true);
  }
  await page.getByRole("button", { name: "Save" }).click();
  await expect(card(page, "Hotel: ")).toContainText("Line 10 of a long comment");
  await run.app.close();
});

// Orlando, 2026-11-09: "Each comment needs an option to resolve it. Resolving
// a comment should hide it and consider it closed."

const resolveOn = (page: Page, body: string) => card(page, body).getByRole("button", { name: "Resolve", exact: true });

// Changed 2026-11-12 (Orlando, roadmap Batch 9, item 2): "I'd actually rather have the resolve
// as a small square button with just a check alongside the ellipses menu in the top right of
// the comment card. That way, the content has more space."

test("every open card has Resolve, a small square tick named for a screen reader and in its tooltip: on the whole document, started by an agent, waiting for an agent, or answered; Done on a note looks the same", async () => {
  const run = await openText("# Plan\n\nWe should hire two people.\n\nThe budget is tight.\n\nWe start in May.\n");
  const { page } = run;
  await comment(run, null, "Overall: shorter, please.");
  await comment(run, "two people", "Make it three.");
  await comment(run, "tight", "By how much?");
  const { session: claude } = await AgentSession.start(run.dataDir, "claude-code");
  try {
    const ids = idsIn(await claude.ok("take_document", { path: run.file }));
    await claude.ok("edit_document", { path: run.file, edits: [{ find: "two people", replace: "three people" }], comment_ids: [ids.get("two people")] });
    await claude.ok("reply_to_comment", { path: run.file, comment_id: ids.get("two people"), text: "Now three." });
    await claude.ok("add_comment", { path: run.file, quote: "We start", text: "Is May firm?" });
    await claude.call("finish_editing", { path: run.file }); // the ones left are pointed out once
    await claude.ok("finish_editing", { path: run.file, note: "The budget line may need a number." });
  } finally {
    await claude.stop();
  }
  await expect(card(page, "Make it three.")).toHaveAttribute("aria-label", /waiting for you/);
  await expect(card(page, "By how much?")).toHaveAttribute("aria-label", /not sent to an agent yet/);
  await expect(card(page, "Is May firm?").locator(".comment-author").first()).toHaveText("Claude");
  await expect(card(page, "Overall: shorter, please.")).toContainText("Whole document");
  // No card in focus: every one shows Resolve, a tick with no word, named and with a tooltip that says what it does.
  await page.locator(`${EDITOR} h1`).click();
  await settle(page);
  await expect(page.locator(`${PANEL} .comment-card.active`)).toHaveCount(0);
  for (const body of ["Overall: shorter, please.", "Make it three.", "By how much?", "Is May firm?"]) {
    const resolve = resolveOn(page, body);
    await expect(resolve, body).toBeVisible();
    await expect(resolve, body).toHaveText("");
    await expect(resolve.locator("svg"), body).toHaveCount(1);
    await expect(resolve, body).toHaveAttribute("title", /^Resolve this comment: it's done, and its card is hidden/);
    const size = (await resolve.boundingBox())!;
    expect([Math.round(size.width), Math.round(size.height)], body).toEqual([24, 24]);
  }
  // Done on the agent's note: the same look (a tick alone, the same size), in the same corner. Changes no comment asked for have no card (roadmap Batch 9, item 5).
  const doneOn = (which: string) => page.locator(`${PANEL} ${which}`).getByRole("button", { name: "Done", exact: true });
  const look = (button: ReturnType<typeof resolveOn>) =>
    button.evaluate((b) => {
      const r = b.getBoundingClientRect();
      return { classes: b.className.replace(/ ?(comment-resolve|pass-note-done)/, ""), tick: !!b.querySelector("svg"), words: b.textContent, right: Math.round(r.right), width: Math.round(r.width) };
    });
  await expect(doneOn(".pass-note")).toBeVisible();
  expect(await look(doneOn(".pass-note"))).toEqual(await look(resolveOn(page, "Make it three.")));
  await expect(doneOn(".pass-note")).toHaveAttribute("title", /^Mark this note as done/);

  // Each one resolves its comment: the card goes, and the comment is closed.
  for (const body of ["Overall: shorter, please.", "Make it three.", "By how much?", "Is May firm?"]) {
    await resolveOn(page, body).click();
    await expect(card(page, body)).toHaveCount(0);
  }
  await doneOn(".pass-note").click();
  await expect(page.locator(`${PANEL} .pass-note`)).toHaveCount(0);
  await expect(page.locator("#comments-toggle")).toHaveText("4 resolved");
  await run.app.close();
});

/**
 * No card in focus: a comment's card first (an agent's note or changes stay in focus through
 * a click in the page), then the cursor to the title, away from every comment's words, moved
 * so it counts even where it already was.
 */
async function noCardInFocus(page: Page, body: string): Promise<void> {
  await card(page, body).locator(".comment-body").first().click();
  await page.locator(`${EDITOR} h1`).click();
  await page.keyboard.press("Meta+ArrowRight");
  await page.keyboard.press("Meta+ArrowLeft");
  await settle(page);
  await expect(page.locator(`${PANEL} .comment-card.active`)).toHaveCount(0);
}

/**
 * Where a card's top right corner is: Resolve (Done, Reopen) against the card's edges, the
 * line of its label (the quoted words, or "Whole document"), and the "⋯" beside it, if any.
 */
const cornerOf = (c: ReturnType<typeof card>) =>
  c.evaluate((el) => {
    const box = (e: Element | null) => (e && e.getClientRects().length ? e.getBoundingClientRect() : null);
    const card = el.getBoundingClientRect();
    const head = el.querySelector(":scope .comment-head")!;
    const close = box(head.querySelector(".comment-close"))!;
    const more = box(head.querySelector(".comment-more"));
    const labelEl = head.querySelector(".comment-quote, .comment-whole")!;
    const label = box(labelEl)!;
    const line = labelEl.classList.contains("comment-quote") ? parseFloat(getComputedStyle(labelEl).lineHeight) : label.height;
    const firstMessage = box(el.querySelector(".comment-message, .pass-note-text"));
    return {
      // In the very corner: the card's padding from its right edge and its top, a little less.
      fromRight: Math.round(card.right - close.right),
      fromTop: Math.round(close.top - card.top),
      // On the label's first line, which ends before the buttons (the quote narrower to make room).
      onFirstLine: Math.abs(close.top + close.height / 2 - (label.top + line / 2)) <= 3,
      roomForButtons: Math.round((more ?? close).left - label.right) >= 0,
      aboveTheWords: firstMessage ? firstMessage.top >= close.bottom - 4 : null,
      // The "⋯" just to its left, on the same line.
      moreBeside: more ? Math.round(close.left - more.right) : null,
      moreLevel: more ? Math.abs(more.top - close.top) <= 1 : null,
    };
  });

test("Resolve sits in the card's top right corner beside the first comment's \"⋯\", on the line of the quoted words, which narrow to make room; a reply's \"⋯\" stays on its name line; Done and Reopen are in the same corner", async () => {
  const run = await openText("# Plan\n\nWe should hire two people to run the new help desk over the summer.\n\nThe budget is tight.\n\nWe start in May.\n");
  const { page } = run;
  await comment(run, "hire two people to run the new help desk over the summer", "Make it three.");
  await comment(run, "tight", "By how much?");
  await comment(run, "in May", "Is May firm?");
  await comment(run, null, "Overall: shorter, please.");
  const { session: claude } = await AgentSession.start(run.dataDir, "claude-code");
  try {
    const ids = idsIn(await claude.ok("take_document", { path: run.file }));
    const hire = ids.get("hire two people to run the new help desk over the summer");
    await claude.ok("edit_document", { path: run.file, edits: [{ find: "two people", replace: "three people" }], comment_ids: [hire] });
    await claude.ok("edit_document", { path: run.file, edits: [{ find: "is tight", replace: "is very tight" }] }); // asked for by no comment
    await claude.ok("reply_to_comment", { path: run.file, comment_id: hire, text: "Now three." });
    await claude.ok("add_comment", { path: run.file, quote: "We start", text: "Is that firm for the team?" });
    await claude.call("finish_editing", { path: run.file }); // the ones left are pointed out once
    await claude.ok("finish_editing", { path: run.file, note: "The budget line may need a number." });
  } finally {
    await claude.stop();
  }
  const hire = card(page, "Make it three.");
  await hire.locator(".comment-body").first().click();
  await hire.getByRole("textbox", { name: "Reply" }).fill("Or four?");
  await hire.getByRole("button", { name: "Reply", exact: true }).click();
  await expect(hire.locator(".comment-message")).toHaveCount(3);
  await noCardInFocus(page, "By how much?");

  // No card in focus: Resolve in the corner, on the line of the quote (two lines here), with the "⋯" of the first comment beside it.
  for (const body of ["Make it three.", "By how much?", "Overall: shorter, please."]) {
    const at = await cornerOf(card(page, body));
    expect(at.fromRight, body).toBeLessThanOrEqual(12);
    expect(at.fromTop, body).toBeLessThanOrEqual(12);
    expect(at.onFirstLine, body).toBe(true);
    expect(at.roomForButtons, body).toBe(true);
    expect(at.aboveTheWords, body).toBe(true);
    expect(at.moreBeside, body).toBeGreaterThanOrEqual(0);
    expect(at.moreBeside, body).toBeLessThanOrEqual(8);
    expect(at.moreLevel, body).toBe(true);
  }
  // The corner's "⋯" is the first comment's; a reply of yours keeps its own at the end of its name line; Claude's reply has none.
  const messages = hire.locator(".comment-message");
  await expect(messages.nth(0).getByRole("button", { name: "More actions" })).toHaveCount(0);
  await expect(hire.locator(".comment-head").getByRole("button", { name: "More actions" })).toHaveCount(1);
  await expect(messages.nth(1).getByRole("button", { name: "More actions" })).toHaveCount(0);
  await expect(messages.nth(2).locator(".comment-byline").getByRole("button", { name: "More actions" })).toHaveCount(1);
  // A comment Claude started: Resolve alone in the corner, in the same place.
  const started = await cornerOf(card(page, "Is that firm for the team?"));
  expect(started.moreBeside).toBeNull();
  expect(started.fromRight).toBe((await cornerOf(hire)).fromRight);
  expect(started.onFirstLine).toBe(true);
  // Done on the agent's note: the same corner.
  const noteAt = await cornerOf(page.locator(`${PANEL} .pass-note`));
  expect(noteAt.fromRight).toBe(started.fromRight);
  expect(noteAt.fromTop).toBeLessThanOrEqual(12);
  expect(noteAt.onFirstLine).toBe(true);
  expect(noteAt.aboveTheWords).toBe(true);

  // The card in focus: the same corner, above the reply and the change it made.
  await hire.locator(".comment-body").first().click();
  await expect(hire).toHaveClass(/active/);
  await expect(hire.locator(".comment-change")).toBeVisible();
  const focused = await cornerOf(hire);
  expect(focused.fromRight).toBe(started.fromRight);
  expect(focused.onFirstLine).toBe(true);
  expect(focused.moreBeside).toBeGreaterThanOrEqual(0);

  // A resolved comment, shown: Reopen takes Resolve's place, the same square, its tick filled in; no "⋯".
  await resolveOn(page, "Is May firm?").click();
  await expect(card(page, "Is May firm?")).toHaveCount(0);
  await page.locator(`${PANEL} .comments-show-resolved`).click();
  const reopen = card(page, "Is May firm?").getByRole("button", { name: "Reopen", exact: true });
  await expect(reopen).toBeVisible();
  await expect(reopen).toHaveText("");
  await expect(reopen).toHaveAttribute("title", "Open this comment again");
  const resolved = await cornerOf(card(page, "Is May firm?"));
  expect(resolved.fromRight).toBe(started.fromRight);
  expect(resolved.moreBeside).toBeNull();
  const filled = await reopen.evaluate((b) => [getComputedStyle(b).backgroundColor, getComputedStyle(b).borderTopColor]);
  const plain = await resolveOn(page, "By how much?").evaluate((b) => getComputedStyle(b).backgroundColor);
  expect(filled[0]).toBe(filled[1]); // filled in its edge's colour
  expect(filled[0]).not.toBe(plain);
  await run.app.close();
});

// Orlando, 2026-11-12 (roadmap Batch 9, item 1): "can we left align all of the comments? I don't
// like that the copy indents to the right of the little person icon".

test("a comment's words start at the card's left edge, in line with the person icon, for replies and agents' messages too, and so do the option buttons, an edit box and the reply box", async () => {
  const run = await openText("# Plan\n\nWe should hire two people this quarter.\n\nThe budget is tight.\n");
  const { page } = run;
  await comment(run, "two people", "Make it three.");
  const { session: claude } = await AgentSession.start(run.dataDir, "claude-code");
  try {
    const ids = idsIn(await claude.ok("take_document", { path: run.file }));
    await claude.ok("reply_to_comment", {
      path: run.file,
      comment_id: ids.get("two people"),
      text: "Three is more than the budget allows. Would one of these do?",
      options: [
        { label: "Two, then a third", edits: [{ find: "hire two people", replace: "hire two people, then a third" }] },
        { label: "Three by summer", edits: [{ find: "hire two people this quarter", replace: "hire three people by summer" }] },
      ],
    });
    await claude.ok("finish_editing", { path: run.file });
  } finally {
    await claude.stop();
  }
  const c = card(page, "Make it three.");
  await c.locator(".comment-body").first().click();
  await c.getByRole("textbox", { name: "Reply" }).fill("Two, then.");
  await c.getByRole("button", { name: "Reply", exact: true }).click();
  await expect(c.locator(".comment-message")).toHaveCount(3);
  /** The left edge of each of the card's parts, against the first person icon's. */
  const lefts = () =>
    c.evaluate((el) => {
      const icon = el.querySelector(".comment-avatar")!.getBoundingClientRect().left;
      const of = (sel: string) => [...el.querySelectorAll(sel)].filter((e) => e.getClientRects().length).map((e) => Math.round(e.getBoundingClientRect().left - icon));
      return {
        icons: of(".comment-avatar"),
        words: of(".comment-body"),
        options: of(".comment-option-buttons"),
        quote: of(".comment-quote"),
        reply: of(".comment-reply .comment-input"),
        edit: of(".comment-edit .comment-input"),
      };
    });
  await c.getByRole("textbox", { name: "Reply" }).click();
  expect(await lefts()).toEqual({ icons: [0, 0, 0], words: [0, 0, 0], options: [0], quote: [0], reply: [0], edit: [] });
  // Only the name line has the icon beside it: the words start under the icon, not under the name.
  const nameAfterIcon = await c.locator(".comment-byline").first().evaluate((b) => b.querySelector(".comment-author")!.getBoundingClientRect().left > b.querySelector(".comment-avatar")!.getBoundingClientRect().right);
  expect(nameAfterIcon).toBe(true);
  // Editing a reply: the box starts at the edge too.
  await c.getByRole("textbox", { name: "Reply" }).fill("");
  await messageAction(c.locator(".comment-message").nth(2), "Edit");
  await expect(c.locator(".comment-edit .comment-input")).toBeFocused();
  expect((await lefts()).edit).toEqual([0]);
  await c.getByRole("button", { name: "Cancel" }).click();
  await run.app.close();
});

// Orlando, 2026-11-12 (roadmap Batch 9, item 3): "I also don't think we need the "For Claude, not
// sent yet" status line. I'd rather just have the comments. Same types of comments you'd see in
// Microsoft Word. I don't think word shows you little status notes."

const STATUS = /not sent|Sent to|Waiting for|will see it|isn't connected|isn't on this document|Resolved/;

test("a card has no status line: not \"For Claude, not sent yet\", \"Sent to Claude\", \"Waiting for you\" or that an agent is away; a screen reader still hears whose turn it is", async () => {
  const run = await openText("# Plan\n\nWe should hire two people.\n\nThe budget is tight.\n\nWe start in May.\n");
  const { page } = run;
  // No agent yet.
  await comment(run, "two people", "Make it three.");
  await expect(card(page, "Make it three.")).not.toContainText(STATUS);
  await expect(card(page, "Make it three.")).toHaveAccessibleName("Comment by You on “two people”, not sent to an agent yet");
  const { session: claude } = await AgentSession.start(run.dataDir, "claude-code");
  try {
    await claude.ok("open_document", { path: run.file });
    // For Claude, not sent yet: said only to a screen reader.
    await expect(card(page, "Make it three.")).toHaveAccessibleName("Comment by You on “two people”, for Claude, not sent yet");
    await expect(card(page, "Make it three.")).not.toContainText(STATUS);
    // Sent, then answered.
    const ids = idsIn(await claude.ok("take_document", { path: run.file }));
    await expect(card(page, "Make it three.")).toHaveAccessibleName(/, sent to Claude$/);
    await claude.ok("reply_to_comment", { path: run.file, comment_id: ids.get("two people"), text: "Now three." });
    await claude.ok("finish_editing", { path: run.file });
  } finally {
    await claude.stop();
  }
  await expect(card(page, "Make it three.")).toHaveAccessibleName(/, waiting for you(, new)?$/);
  // Nothing on any card says whose turn it is, and no card has a line for it.
  for (const c of await page.locator(`${PANEL} .comment-card`).all()) await expect(c).not.toContainText(STATUS);
  await expect(page.locator(`${PANEL} .comment-turn, ${PANEL} .comment-waiting, ${PANEL} .comment-foot`)).toHaveCount(0);
  // A resolved card, shown: it says nothing either; its look and its Reopen say it's done, and so does its name.
  await resolveOn(page, "Make it three.").click();
  await page.locator(`${PANEL} .comments-show-resolved`).click();
  await expect(card(page, "Make it three.")).toHaveClass(/resolved/);
  await expect(card(page, "Make it three.")).not.toContainText(STATUS);
  await expect(card(page, "Make it three.")).toHaveAccessibleName(/, resolved$/);
  await run.app.close();
});

test("resolving a card hides it at once, and the cards above it stay where they are, even at the end of the panel", async () => {
  const run = await openText(LONG);
  const { page } = run;
  await page.setViewportSize({ width: 1440, height: 700 });
  for (const w of WORDS) await comment(run, w, `${w}: ${NOTE}`);
  await page.locator(`${EDITOR} h1`).click();
  await settle(page);
  const panel = page.locator(PANEL);
  const topOf = (body: string) => card(page, body).evaluate((e) => Math.round(e.getBoundingClientRect().top));

  // At the end of the panel: the last card goes, and the ones above don't slide down to fill the space.
  await panel.evaluate((e) => (e.scrollTop = e.scrollHeight));
  const kilo = await topOf("Kilo: ");
  await resolveOn(page, "Lima: ").click();
  await expect(card(page, "Lima: ")).toHaveCount(0);
  await settle(page);
  expect(await topOf("Kilo: ")).toBe(kilo);
  // In the middle: the cards above stay, the ones below move up into its place.
  const juliet = await topOf("Juliet: ");
  const india = await topOf("India: ");
  await resolveOn(page, "Juliet: ").click();
  await expect(card(page, "Juliet: ")).toHaveCount(0);
  await settle(page);
  expect(await topOf("India: ")).toBe(india);
  expect(await topOf("Kilo: ")).toBe(juliet);

  // The room kept below goes once the panel is scrolled up: none is left at the end.
  await panel.evaluate((e) => (e.scrollTop = 0));
  await settle(page);
  await expect.poll(() => page.locator(`${PANEL} .comments-slack`).evaluate((e) => e.getBoundingClientRect().height)).toBe(0);
  await run.app.close();
});

// Undo straight after Resolve -------------------------------------------------------------

const PLAN = "# Plan\n\nWe should hire two people this quarter.\n\nThe budget is tight.\n";
const TYPED = PLAN.replace("tight.", "tight. Mine.");

/** A plan with a comment on "two people", and a few words typed far from it, so Undo has typing to take back. */
async function commentedAndTyped(): Promise<Running> {
  const run = await openText(PLAN);
  await comment(run, "two people", "Make it three.");
  await cursorAtEnd(run.page, "tight");
  await run.page.keyboard.type(" Mine.");
  await expectFile(run, TYPED);
  return run;
}

/** The comment is open again: its card back in the panel, with Resolve, and no resolved count. */
async function backOpen(page: Page): Promise<void> {
  await expect(resolveOn(page, "Make it three.")).toBeVisible();
  await expect(page.locator(`${PANEL} .comments-resolved`)).toBeHidden();
}

/** The comment is still resolved: no card, "1 resolved" in the heading. */
async function stillResolved(page: Page): Promise<void> {
  await expect(card(page, "Make it three.")).toHaveCount(0);
  await expect(page.locator(`${PANEL} .comments-resolved-count`)).toHaveText("1 resolved");
}

test("Undo straight after Resolve brings the comment back open, with the keyboard in the document or not, and the next Undo takes back typing as usual", async () => {
  const run = await commentedAndTyped();
  const { page } = run;

  // The keyboard in the document: the cursor in the comment's words, then Option-Command-Return.
  await page.locator(`${EDITOR} .comment-range`).click();
  await settle(page);
  await expect(card(page, "Make it three.")).toHaveClass(/active/);
  await page.keyboard.press("Meta+Alt+Enter");
  await stillResolved(page);
  await page.keyboard.press("Meta+z");
  await backOpen(page);
  // Back in focus, as Next Comment would show it; the typing is untouched.
  await expect(card(page, "Make it three.")).toHaveClass(/active/);
  await expect(page.locator(`${EDITOR} p`).last()).toHaveText("The budget is tight. Mine.");
  await expectFile(run, TYPED);
  // The next Undo is the usual one: the typing goes.
  await page.keyboard.press("Meta+z");
  await expectFile(run, PLAN);
  await backOpen(page);

  // The card's Resolve, with the mouse: the keyboard is in neither the document nor a box.
  await cursorAtEnd(page, "tight");
  await page.keyboard.type(" Again.");
  await resolveOn(page, "Make it three.").click();
  await stillResolved(page);
  await page.keyboard.press("Meta+z");
  await backOpen(page);
  await expect(page.locator(`${EDITOR} p`).last()).toHaveText("The budget is tight. Again.");
  await expectFile(run, PLAN.replace("tight.", "tight. Again."));
  await run.app.close();
});

test("anything done between Resolve and Undo (a click, a key) lets it go: Undo takes back typing and the comment stays resolved", async () => {
  const run = await commentedAndTyped();
  const { page } = run;
  await comment(run, "The budget", "How tight?");
  const resolvedCount = page.locator(`${PANEL} .comments-resolved-count`);

  // A click in the document.
  await resolveOn(page, "Make it three.").click();
  await stillResolved(page);
  await cursorAtEnd(page, "tight");
  await page.keyboard.press("Meta+z");
  await expectFile(run, PLAN);
  await stillResolved(page);

  // A key: an arrow, in the document.
  await cursorAtEnd(page, "tight");
  await page.keyboard.type(" Again.");
  await expectFile(run, PLAN.replace("tight.", "tight. Again."));
  await page.locator(`${EDITOR} .comment-range`, { hasText: "The budget" }).click();
  await settle(page);
  await expect(card(page, "How tight?")).toHaveClass(/active/);
  await page.keyboard.press("Meta+Alt+Enter");
  await expect(card(page, "How tight?")).toHaveCount(0);
  await expect(resolvedCount).toHaveText("2 resolved");
  await page.keyboard.press("ArrowRight");
  await page.keyboard.press("Meta+z");
  await expectFile(run, PLAN);
  await expect(card(page, "How tight?")).toHaveCount(0);
  await expect(resolvedCount).toHaveText("2 resolved");
  await run.app.close();
});

test("Undo after Resolve works in the Markdown view too, and from the toolbar's Undo and Edit > Undo", async () => {
  const run = await commentedAndTyped();
  const { page, app } = run;

  const typingKept = () => expect(page.locator(`${EDITOR} p`).last()).toHaveText("The budget is tight. Mine.");

  // The Markdown view, with the keyboard in the text: the cursor moved into the comment's words, then Option-Command-Return.
  await page.getByRole("button", { name: "Markdown", exact: true }).click();
  await expect(page.locator(SOURCE)).toBeVisible();
  await page.locator(SOURCE).evaluate((area: HTMLTextAreaElement) => {
    const at = area.value.indexOf("two people");
    area.focus();
    area.setSelectionRange(at - 1, at - 1);
  });
  await settle(page);
  await page.keyboard.press("ArrowRight");
  await page.keyboard.press("ArrowRight");
  await expect(card(page, "Make it three.")).toHaveClass(/active/);
  await page.keyboard.press("Meta+Alt+Enter");
  await stillResolved(page);
  await expect(page.locator(SOURCE)).toBeFocused();
  await page.keyboard.press("Meta+z");
  await backOpen(page);
  await expect(page.locator(SOURCE)).toHaveValue(TYPED);
  await page.getByRole("button", { name: "Formatted", exact: true }).click();
  await expect(page.locator(EDITOR)).toBeVisible();

  // The toolbar's Undo.
  await resolveOn(page, "Make it three.").click();
  await stillResolved(page);
  await page.getByRole("button", { name: "Undo", exact: true }).click();
  await backOpen(page);
  await typingKept();
  await expectFile(run, TYPED);

  // Edit > Undo, with the keyboard in the document (the menu's Undo is the Mac's own, sent to the page).
  await page.locator(`${EDITOR} .comment-range`).click();
  await settle(page);
  await page.keyboard.press("Meta+Alt+Enter");
  await stillResolved(page);
  await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].webContents.undo());
  await backOpen(page);
  await typingKept();
  await expectFile(run, TYPED);
  // And after the card's Resolve with the mouse.
  await resolveOn(page, "Make it three.").click();
  await stillResolved(page);
  await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].webContents.undo());
  await backOpen(page);
  await typingKept();
  await run.app.close();
});

test("the panel's heading counts the resolved comments, with Show and Hide in step with View > Show Resolved Comments; shown, they're quieter, with Reopen", async () => {
  const run = await openText("Alpha beta gamma delta.\n", { name: "notes.md" });
  const { page, app } = run;
  await comment(run, "beta", "Check this.");
  await comment(run, "gamma", "And this.");
  const heading = page.locator(`${PANEL} .comments-resolved`);
  const count = page.locator(`${PANEL} .comments-resolved-count`);
  const toggle = page.locator(`${PANEL} .comments-show-resolved`);
  const menu = () =>
    app.evaluate(({ Menu }) => {
      const item = Menu.getApplicationMenu()!.getMenuItemById("view-resolved")!;
      return { enabled: item.enabled, checked: item.checked };
    });

  // None resolved: no count and no control.
  await expect(heading).toBeHidden();
  await expect.poll(menu).toEqual({ enabled: false, checked: false });

  // One resolved: "1 resolved · Show", in the heading.
  await resolveOn(page, "Check this.").click();
  await expect(card(page, "Check this.")).toHaveCount(0);
  await expect(heading).toBeVisible();
  await expect(count).toHaveText("1 resolved");
  await expect(toggle).toHaveText("Show");
  await expect(toggle).toHaveAccessibleName("Show resolved comments");
  await expect.poll(menu).toEqual({ enabled: true, checked: false });

  // Show: the resolved card, quieter (no fill, a dashed edge, its words in the soft ink), with Reopen instead of Resolve.
  await toggle.click();
  const resolved = card(page, "Check this.");
  await expect(resolved).toHaveClass(/resolved/);
  // No "Resolved" line on it (roadmap Batch 9, item 3): the look and Reopen say so, and a screen reader hears it.
  await expect(resolved).not.toContainText("Resolved");
  await expect(resolved).toHaveAttribute("aria-label", /, resolved$/);
  await expect(resolved.getByRole("button", { name: "Reopen" })).toBeVisible();
  await expect(resolved.getByRole("button", { name: "Resolve", exact: true })).toHaveCount(0);
  const looks = (body: string) =>
    card(page, body).evaluate((c) => {
      const style = getComputedStyle(c);
      return { fill: style.backgroundColor, edge: style.borderTopStyle, words: getComputedStyle(c.querySelector(".comment-body")!).color };
    });
  const quiet = await looks("Check this.");
  const open = await looks("And this.");
  expect(quiet.fill).toBe("rgba(0, 0, 0, 0)");
  expect(quiet.edge).toBe("dashed");
  expect(open.edge).toBe("solid");
  expect(quiet.words).not.toBe(open.words);
  await expect(toggle).toHaveText("Hide");
  await expect(toggle).toHaveAttribute("aria-pressed", "true");
  await expect.poll(menu).toEqual({ enabled: true, checked: true });

  // The View menu does the same, and the heading follows.
  await clickMenu(app, "view-resolved");
  await expect(resolved).toHaveCount(0);
  await expect(toggle).toHaveText("Show");
  await clickMenu(app, "view-resolved");
  await expect(resolved).toBeVisible();
  await expect(toggle).toHaveText("Hide");
  await expect.poll(menu).toEqual({ enabled: true, checked: true });

  // Kept for this document while it's open: in the Markdown view, and after another document has been in front.
  await page.getByRole("button", { name: "Markdown", exact: true }).click();
  await expect(resolved).toBeVisible();
  await page.getByRole("button", { name: "Formatted", exact: true }).click();
  await openAlso(run, "other.md", "Other words.\n");
  await expect(heading).toBeHidden(); // nothing resolved on that one
  await expect.poll(menu).toEqual({ enabled: false, checked: false });
  await page.locator('.tab[title$="/notes.md"]').click();
  await expect(resolved).toBeVisible();
  await expect(toggle).toHaveText("Hide");

  // Reopen, from the shown card: open again, and the count goes down; at none, the heading has no count.
  await resolveOn(page, "And this.").click();
  await expect(count).toHaveText("2 resolved");
  await resolved.getByRole("button", { name: "Reopen" }).click();
  await expect(card(page, "Check this.").getByRole("button", { name: "Resolve", exact: true })).toBeVisible();
  await expect(count).toHaveText("1 resolved");
  await card(page, "And this.").getByRole("button", { name: "Reopen" }).click();
  await expect(heading).toBeHidden();
  await expect(page.locator(`${PANEL} .comment-card.resolved`)).toHaveCount(0);

  // Opened again later, a document starts with its resolved comments hidden.
  await resolveOn(page, "Check this.").click();
  await clickMenu(app, "close-tab");
  await page.evaluate((p) => window.corillo.openPath(p), run.file);
  await expect(count).toHaveText("1 resolved");
  await expect(toggle).toHaveText("Show");
  await expect(card(page, "Check this.")).toHaveCount(0);
  await run.app.close();
});

test("a card's quote is cut to two lines, and shown in full while the card is in focus, replied to or edited, resolved cards too", async () => {
  const run = await openText(`# Plan\n\n${FILLER}\n\nShort one.\n`);
  const { page } = run;
  await page.setViewportSize({ width: 1100, height: 800 });
  await comment(run, FILLER, "Too long?");
  await comment(run, "Short one.", "Fine.");
  // Held by its id: while it's being edited, its words are in a box, not on the card.
  const id = await card(page, "Too long?").getAttribute("data-thread-id");
  const long = page.locator(`${PANEL} .comment-card[data-thread-id="${id}"]`);
  const quote = long.locator(".comment-quote");
  const shape = () =>
    quote.evaluate((q) => ({ lines: Math.round(q.clientHeight / parseFloat(getComputedStyle(q).lineHeight)), cut: q.scrollHeight > q.clientHeight + 1 }));
  // Every word is there, to show in full.
  await expect(quote).toHaveText(FILLER);

  // Not in focus: two lines, cut.
  await card(page, "Fine.").click();
  await expect.poll(shape).toEqual({ lines: 2, cut: true });
  // In focus: all of it.
  await card(page, "Too long?").click();
  await expect.poll(async () => (await shape()).cut).toBe(false);
  expect((await shape()).lines).toBeGreaterThan(2);
  await card(page, "Fine.").click();
  await expect.poll(shape).toEqual({ lines: 2, cut: true });

  // Being replied to, though another card is in focus: all of it.
  await card(page, "Too long?").click();
  await card(page, "Too long?").getByRole("textbox", { name: "Reply" }).fill("Cut it to one line?");
  await card(page, "Fine.").click();
  await expect(card(page, "Too long?")).not.toHaveClass(/active/);
  await expect.poll(async () => (await shape()).cut).toBe(false);
  await card(page, "Too long?").getByRole("button", { name: "Cancel" }).click();
  await card(page, "Fine.").click();
  await expect.poll(shape).toEqual({ lines: 2, cut: true });

  // Being edited: all of it.
  await card(page, "Too long?").click();
  await messageAction(card(page, "Too long?"), "Edit");
  await card(page, "Fine.").click();
  await expect(long.locator(".comment-edit")).toBeVisible();
  await expect.poll(async () => (await shape()).cut).toBe(false);
  await long.getByRole("button", { name: "Cancel" }).click();

  // Resolved and shown: cut, until it's in focus.
  await resolveOn(page, "Too long?").click();
  await page.locator(`${PANEL} .comments-show-resolved`).click();
  await card(page, "Fine.").click();
  await expect.poll(shape).toEqual({ lines: 2, cut: true });
  await card(page, "Too long?").locator(".comment-body").click();
  await expect.poll(async () => (await shape()).cut).toBe(false);
  await run.app.close();
});

test("a long message is cut to four lines on a card not in focus, ending in an ellipsis; the card in focus, or one being replied to or edited, shows every word", async () => {
  const run = await openText("# Plan\n\nWe should hire two people this quarter.\n\nThe budget is tight.\n");
  const { page } = run;
  await page.setViewportSize({ width: 1100, height: 900 });
  const POINTS = Array.from({ length: 30 }, (_, i) => `Point ${i + 1}.`).join("\n");
  const ANSWER = Array.from({ length: 8 }, (_, i) => `Line ${i + 1}.`).join("\n");
  await comment(run, "two people", POINTS);
  // Held by its id: while it's being edited, its words are in a box, not on the card.
  const id = await card(page, "Point 30.").getAttribute("data-thread-id");
  const long = page.locator(`${PANEL} .comment-card[data-thread-id="${id}"]`);
  await long.getByRole("textbox", { name: "Reply" }).fill(ANSWER);
  await long.getByRole("button", { name: "Reply", exact: true }).click();
  await expect(long.locator(".comment-body")).toHaveCount(2);
  await comment(run, "tight", "Fine.");
  /** Each message on the long card: how many lines show, whether some are cut off, and how it ends when cut. */
  const shape = () =>
    long.locator(".comment-body").evaluateAll((bodies) =>
      bodies.map((b) => {
        const s = getComputedStyle(b);
        const cut = b.scrollHeight > b.clientHeight + 1;
        return { lines: Math.round(b.clientHeight / parseFloat(s.lineHeight)), cut, ellipsis: cut && s.webkitLineClamp === "4" };
      }),
    );
  const cutShort = [
    { lines: 4, cut: true, ellipsis: true },
    { lines: 4, cut: true, ellipsis: true },
  ];
  const whole = [
    { lines: 30, cut: false, ellipsis: false },
    { lines: 8, cut: false, ellipsis: false },
  ];
  // Every word is there, to show in full.
  await expect(long.locator(".comment-body").first()).toHaveText(POINTS);

  // Not in focus: four lines each. A short message isn't touched.
  await expect(card(page, "Fine.")).toHaveClass(/active/);
  await expect.poll(shape).toEqual(cutShort);
  expect(await card(page, "Fine.").locator(".comment-body").evaluate((b) => b.scrollHeight > b.clientHeight + 1)).toBe(false);

  // Clicked: every word, and its words in the document in sight.
  await long.click();
  await expect(long).toHaveClass(/active/);
  await expect.poll(shape).toEqual(whole);
  await expect(page.locator(`${EDITOR} .comment-range[data-comment="${id}"]`)).toBeInViewport();
  await card(page, "Fine.").click();
  await expect.poll(shape).toEqual(cutShort);

  // Reached with the keyboard (Review > Previous Comment): every word.
  await clickMenu(run.app, "review-previous");
  await expect(long).toHaveClass(/active/);
  await expect.poll(shape).toEqual(whole);

  // Being replied to, though another card is in focus: every word.
  await long.getByRole("textbox", { name: "Reply" }).fill("One more thing.");
  await card(page, "Fine.").click();
  await expect(long).not.toHaveClass(/active/);
  await expect.poll(shape).toEqual(whole);
  await long.getByRole("button", { name: "Cancel" }).click();
  await card(page, "Fine.").click();
  await expect.poll(shape).toEqual(cutShort);

  // Being edited: the box holds every word, and the other message is whole too.
  await long.click();
  await messageAction(long.locator(".comment-message").first(), "Edit");
  const box = long.locator(".comment-edit textarea");
  await expect(box).toHaveValue(POINTS);
  await card(page, "Fine.").click();
  await expect(box).toBeVisible();
  expect(await box.evaluate((b: HTMLTextAreaElement) => b.scrollHeight <= b.offsetHeight)).toBe(true);
  await expect.poll(async () => (await shape()).map((m) => m.cut)).toEqual([false]);
  await long.getByRole("button", { name: "Cancel" }).click();
  await run.app.close();
});

// Orlando (2026-11-09), on a card's Edit and Delete: "I think they're easy to
// miss and add a lot of text noise to an area that already has a lot of text."
// They're now in a short menu from a "⋯" (More actions) at the end of the name
// line of each of his own messages.

const moreOn = (page: Page, body: string) => card(page, body).getByRole("button", { name: "More actions" });
const actionsMenu = (page: Page) => page.getByRole("menu", { name: "More actions" });
/** Whether the "⋯" can be seen (on cards not in focus it keeps its place, drawn in no colour, until the pointer is over the card). */
const seen = (more: ReturnType<typeof moreOn>) =>
  more.evaluate((b) => {
    const s = getComputedStyle(b);
    return s.opacity === "1" && s.visibility === "visible" && s.color !== "rgba(0, 0, 0, 0)";
  });

/** Claude, briefly on the document: a reply on one comment and a comment of its own. */
async function claudeAnswers(run: Running, quote: string): Promise<void> {
  const { session: claude } = await AgentSession.start(run.dataDir, "claude-code");
  try {
    const ids = idsIn(await claude.ok("take_document", { path: run.file }));
    await claude.ok("reply_to_comment", { path: run.file, comment_id: ids.get(quote), text: "Now three." });
    await claude.ok("add_comment", { path: run.file, quote: "We start", text: "Is May firm?" });
    const first = await claude.call("finish_editing", { path: run.file });
    if (first.isError) await claude.ok("finish_editing", { path: run.file });
  } finally {
    await claude.stop();
  }
}

test("Edit and Delete are in a \"⋯\" on each of your own messages: always shown on the card in focus, on another card while the pointer is over it, never on an agent's message", async () => {
  const run = await openText("# Plan\n\nWe should hire two people.\n\nThe budget is tight.\n\nWe start in May.\n");
  const { page } = run;
  await comment(run, "two people", "Make it three.");
  await comment(run, "tight", "By how much?");
  await comment(run, null, "Overall: shorter, please.");
  await claudeAnswers(run, "two people");
  await expect(card(page, "Make it three.")).toContainText("Now three.");
  await expect(card(page, "Is May firm?")).toBeVisible();

  // Only your own messages have one: not Claude's reply, and not the comment Claude started.
  // The first comment's is in the card's corner, beside Resolve (roadmap Batch 9, item 2).
  const answered = card(page, "Make it three.").locator(".comment-message");
  await expect(moreOn(page, "Make it three.")).toHaveCount(1);
  await expect(card(page, "Make it three.").locator(".comment-head").getByRole("button", { name: "More actions" })).toHaveCount(1);
  await expect(answered.nth(1).getByRole("button", { name: "More actions" })).toHaveCount(0);
  await expect(moreOn(page, "Is May firm?")).toHaveCount(0);
  // No words saying Edit or Delete on any card any more.
  await expect(page.locator(`${PANEL} .comment-card`).getByRole("button", { name: /^(Edit|Delete)$/ })).toHaveCount(0);

  // The card in focus shows its "⋯", with a tooltip saying what it holds, in the corner on the line with Resolve.
  await card(page, "By how much?").locator(".comment-body").click();
  await page.mouse.move(2, 2);
  await expect(card(page, "By how much?")).toHaveClass(/active/);
  expect(await seen(moreOn(page, "By how much?"))).toBe(true);
  await expect(moreOn(page, "By how much?")).toHaveAttribute("title", "Edit or delete");
  const line = await card(page, "By how much?").locator(".comment-head").evaluate((b) => {
    const more = b.querySelector(".comment-more")!.getBoundingClientRect();
    const resolve = b.querySelector(".comment-resolve")!.getBoundingClientRect();
    return Math.abs(more.top + more.height / 2 - (resolve.top + resolve.height / 2)) <= 1 && more.right <= resolve.left;
  });
  expect(line).toBe(true);
  // The other cards keep theirs out of sight, until the pointer is over the card. Nothing moves when it shows.
  expect(await seen(moreOn(page, "Make it three."))).toBe(false);
  expect(await seen(moreOn(page, "Overall: shorter, please."))).toBe(false);
  const timeAt = () => card(page, "Make it three.").locator(".comment-time").first().evaluate((t) => Math.round(t.getBoundingClientRect().left));
  const before = await timeAt();
  await card(page, "Make it three.").hover();
  expect(await seen(moreOn(page, "Make it three."))).toBe(true);
  expect(await timeAt()).toBe(before);

  // A resolved comment can't be edited: no "⋯" on it, shown or in focus.
  await resolveOn(page, "By how much?").click();
  await page.locator(`${PANEL} .comments-show-resolved`).click();
  await card(page, "By how much?").locator(".comment-body").click();
  await expect(card(page, "By how much?")).toHaveClass(/resolved/);
  await expect(moreOn(page, "By how much?")).toHaveCount(0);
  await run.app.close();
});

test("a comment to an agent with a long name keeps You and the time on its name line and the \"⋯\" in the card, the name cut short with all of it in the tooltip", async () => {
  const run = await openText("# Plan\n\nWe should hire two people.\n");
  const { page } = run;
  const { session } = await AgentSession.start(run.dataDir, "claude-code");
  try {
    await session.ok("introduce", { name: "Senior Marketing Copywriter" });
    await session.ok("open_document", { path: run.file });
    await selectText(page, "two people");
    await page.getByRole("button", { name: "Comment", exact: true }).click();
    await page.keyboard.type("@Senior");
    await page.keyboard.press("Enter");
    await page.keyboard.type("make it warmer");
    await page.getByRole("button", { name: "Post" }).click();
    const c = card(page, "make it warmer");
    await c.locator(".comment-body").click();
    await expect(c).toHaveClass(/active/);
    const line = await c.locator(".comment-byline").first().evaluate((b) => {
      const box = (sel: string) => b.querySelector(sel)!.getBoundingClientRect();
      const inside = b.closest(".comment-card")!.getBoundingClientRect();
      const recipient = b.querySelector<HTMLElement>(".comment-recipient")!;
      const author = b.querySelector<HTMLElement>(".comment-author")!;
      return {
        author: author.textContent,
        authorWhole: author.scrollWidth <= author.clientWidth && author.clientWidth > 0,
        timeInside: box(".comment-time").right <= inside.right,
        moreInside: b.closest(".comment-card")!.querySelector(".comment-head .comment-more")!.getBoundingClientRect().right <= inside.right,
        recipientCut: recipient.scrollWidth > recipient.clientWidth,
        tooltip: recipient.title,
      };
    });
    expect(line).toEqual({
      author: "You",
      authorWhole: true,
      timeInside: true,
      moreInside: true,
      recipientCut: true,
      tooltip: "To Senior Marketing Copywriter",
    });
  } finally {
    await run.app.close();
    await session.stop();
  }
});

test("the \"⋯\" menu with the mouse: it opens under the button with Edit and Delete, puts its card in focus, and Delete deletes at once", async () => {
  const run = await openText("# Plan\n\nWe should hire two people.\n\nThe budget is tight.\n");
  const { page } = run;
  await page.setViewportSize({ width: 1280, height: 800 });
  await comment(run, "two people", "Make it three.");
  await comment(run, "tight", "By how much?");
  const c = card(page, "By how much?");
  const menu = actionsMenu(page);

  // On a card not in focus: the card comes into focus and the menu opens just under the "⋯".
  await page.locator(`${EDITOR} h1`).click();
  await settle(page);
  await expect(c).not.toHaveClass(/active/);
  await c.hover();
  await moreOn(page, "By how much?").click();
  await expect(menu).toBeVisible();
  await expect(c).toHaveClass(/active/);
  await expect(moreOn(page, "By how much?")).toHaveAttribute("aria-expanded", "true");
  await expect(menu.getByRole("menuitem")).toHaveText(["Edit", "Delete"]);
  const button = (await moreOn(page, "By how much?").boundingBox())!;
  const box = (await menu.boundingBox())!;
  expect(box.y).toBeGreaterThanOrEqual(button.y + button.height);
  expect(box.y - (button.y + button.height)).toBeLessThanOrEqual(8);
  expect(box.x + box.width).toBeLessThanOrEqual(1280 - 8);
  // Clicking the "⋯" again, or anywhere else, closes it.
  await moreOn(page, "By how much?").click();
  await expect(menu).toBeHidden();
  await moreOn(page, "By how much?").click();
  await expect(menu).toBeVisible();
  await page.locator(`${EDITOR} h1`).click();
  await expect(menu).toBeHidden();

  // Edit: the comment in a box, as before, with Save and Cancel.
  await messageAction(c, "Edit");
  const edit = page.getByRole("textbox", { name: "Edit comment" });
  await expect(edit).toBeFocused();
  await expect(edit).toHaveValue("By how much?");
  await expect(moreOn(page, "By how much?")).toHaveCount(0); // not while it's being edited
  await edit.fill("By how much, in euros?");
  await page.getByRole("button", { name: "Save" }).click();
  const edited = card(page, "By how much, in euros?");
  await expect(edited.locator(".comment-body")).toHaveText("By how much, in euros?");
  await expect(edited.locator(".comment-edited")).toHaveText("Edited");

  // A reply of yours has its own "⋯": Delete takes the reply only, at once (roadmap Batch 9, item 4).
  const other = card(page, "Make it three.");
  await other.locator(".comment-body").click();
  await other.getByRole("textbox", { name: "Reply" }).fill("Or four.");
  await other.getByRole("button", { name: "Reply", exact: true }).click();
  await expect(other.locator(".comment-message")).toHaveCount(2);
  await messageAction(other.locator(".comment-message").nth(1), "Delete");
  await expect(other.locator(".comment-message")).toHaveCount(1);
  await expect(other).toBeVisible();
  await expect(page.locator(`${PANEL}`).getByRole("button", { name: "Cancel" })).toHaveCount(0);

  // And deleting the comment itself: its card goes at once, with no question.
  await messageAction(edited, "Delete");
  await expect(card(page, "By how much, in euros?")).toHaveCount(0);
  await expect(page.locator(`${PANEL}`)).not.toContainText("Delete this");
  await run.app.close();
});

test("the \"⋯\" menu near the bottom of the window opens above its button, and closes when the panel scrolls", async () => {
  const run = await openText(LONG);
  const { page } = run;
  await page.setViewportSize({ width: 1280, height: 600 });
  for (const w of WORDS.slice(0, 6)) await comment(run, w, `${w}: ${NOTE}`);
  await card(page, "Foxtrot: ").locator(".comment-body").click();
  // The last card, in focus, scrolled so its "⋯" sits just above the bottom of the panel.
  await page.locator(PANEL).evaluate((panel, sel) => {
    const more = document.querySelector(sel)!.getBoundingClientRect();
    panel.scrollTop -= panel.getBoundingClientRect().bottom - 40 - more.bottom;
  }, `${PANEL} .comment-card.active .comment-more`);
  await settle(page);
  const button = (await moreOn(page, "Foxtrot: ").boundingBox())!;
  expect(button.y + button.height).toBeGreaterThan(600 - 80);
  await moreOn(page, "Foxtrot: ").click();
  const menu = actionsMenu(page);
  await expect(menu).toBeVisible();
  const box = (await menu.boundingBox())!;
  expect(box.y + box.height).toBeLessThanOrEqual(button.y);
  expect(box.y).toBeGreaterThanOrEqual(8);
  // It stays where it opened, so scrolling the panel closes it.
  await page.locator(PANEL).evaluate((panel) => (panel.scrollTop -= 60));
  await expect(menu).toBeHidden();
  await run.app.close();
});

test("the \"⋯\" menu from the keyboard: Tab reaches it, Return or Space opens it, the arrows move, Escape closes it, and the keyboard comes back to it; Delete deletes at once", async () => {
  const run = await openText("# Plan\n\nWe should hire two people.\n\nThe budget is tight.\n");
  const { page } = run;
  await comment(run, "two people", "Make it three.");
  await comment(run, "tight", "By how much?");
  const c = card(page, "By how much?");
  const more = moreOn(page, "By how much?");
  const menu = actionsMenu(page);
  const item = (name: string) => menu.getByRole("menuitem", { name });

  // From the card's Resolve, in its corner, Shift-Tab goes back to the "⋯" beside it, which shows while the keyboard is on it.
  await page.locator(`${EDITOR} h1`).click();
  await settle(page);
  await resolveOn(page, "By how much?").focus();
  await page.keyboard.press("Shift+Tab");
  await expect(more).toBeFocused();
  expect(await seen(more)).toBe(true);

  // Return opens it with Edit ready; the arrows go round; Escape closes it and the keyboard is back on the "⋯".
  await page.keyboard.press("Enter");
  await expect(menu).toBeVisible();
  await expect(c).toHaveClass(/active/);
  await expect(item("Edit")).toBeFocused();
  await page.keyboard.press("ArrowDown");
  await expect(item("Delete")).toBeFocused();
  await page.keyboard.press("ArrowDown");
  await expect(item("Edit")).toBeFocused();
  await page.keyboard.press("ArrowUp");
  await expect(item("Delete")).toBeFocused();
  await page.keyboard.press("Escape");
  await expect(menu).toBeHidden();
  await expect(more).toBeFocused();

  // Space opens it too. Edit, then Escape: the comment is as it was, and the keyboard is back on the "⋯".
  await page.keyboard.press(" ");
  await expect(item("Edit")).toBeFocused();
  await page.keyboard.press("Enter");
  const edit = page.getByRole("textbox", { name: "Edit comment" });
  await expect(edit).toBeFocused();
  await page.keyboard.type(" Roughly.");
  await page.keyboard.press("Escape");
  await expect(edit).toHaveCount(0);
  await expect(c.locator(".comment-body")).toHaveText("By how much?");
  await expect(more).toBeFocused();

  // Delete, with Return: the comment goes at once, with no question. Changed 2026-11-16 (roadmap Batch 12, G-2): the
  // keyboard rests on the next card, as after Resolve; it went back to the document, where words selected earlier
  // came back and the next key replaced them.
  await page.keyboard.press("Enter");
  await page.keyboard.press("ArrowDown");
  await expect(item("Delete")).toBeFocused();
  await page.keyboard.press("Enter");
  await expect(card(page, "By how much?")).toHaveCount(0);
  await expect(card(page, "Make it three.")).toBeVisible();
  await expect(card(page, "Make it three.")).toBeFocused();
  await run.app.close();
});

// Orlando (2026-11-09): "Can we do anything to make it more visually clear which comment you are clicked into?"
// Changed 2026-11-12 (Orlando, roadmap Batch 9, item 6): "I don't think we visually do a good enough job of
// distinguishing which comment you have selected." It stands out at a glance, in light and dark, at the
// panel's narrowest, not by colour alone, with nothing on it moving, and not like the keyboard's focus ring.
test("the card in focus stands out at a glance, in light and dark at the panel's narrowest: a blue-grey wash and a thick bar down its left edge, not a ring, with nothing on it moving; every kind of card the same, resolved ones dashed until then", async () => {
  const run = await openText("# Plan\n\nWe should hire two people.\n\nThe budget is tight.\n\nWe start in May.\n\nThe office opens in June.\n");
  const { page, app } = run;
  await page.setViewportSize({ width: 560, height: 900 });
  await expect.poll(async () => Math.round((await page.locator(PANEL).boundingBox())!.width), { message: "the panel at its narrowest" }).toBeLessThanOrEqual(264);
  await comment(run, "two people", "Make it three.");
  await comment(run, "tight", "By how much?");
  await comment(run, "start in May", "Is May firm?");
  await comment(run, null, "Overall: shorter, please.");
  const { session: claude } = await AgentSession.start(run.dataDir, "claude-code");
  try {
    const ids = idsIn(await claude.ok("take_document", { path: run.file }));
    await claude.ok("reply_to_comment", { path: run.file, comment_id: ids.get("two people"), text: "Now three." });
    await claude.call("finish_editing", { path: run.file }); // the ones left are pointed out once
    await claude.ok("finish_editing", { path: run.file, note: "The budget line may need a number." });
  } finally {
    await claude.stop();
  }
  await resolveOn(page, "Is May firm?").click();
  await page.locator(`${PANEL} .comments-show-resolved`).click();
  await expect(card(page, "Is May firm?")).toHaveClass(/resolved/);
  await expect(page.locator(`${PANEL} .pass-note`)).toBeVisible();

  // Each kind of card, and how to put it in focus with a click.
  const kinds = [
    { name: "a comment on words", sel: cardSel(await idOf(page, "By how much?")), click: ".comment-body" },
    { name: "an answered comment", sel: cardSel(await idOf(page, "Make it three.")), click: ".comment-body" },
    { name: "a whole-document comment", sel: cardSel(await idOf(page, "Overall: shorter, please.")), click: ".comment-body" },
    { name: "a resolved comment", sel: `${PANEL} .comment-card.resolved`, click: ".comment-body" },
    { name: "an agent's note", sel: `${PANEL} .pass-note`, click: ".pass-note-text" },
  ];

  /** How a card looks, and where its parts sit inside it. */
  const lookOf = (sel: string) =>
    page.evaluate(
      ([cardSel, panelSel, editor]) => {
        const rgb = (c: string) => (c.match(/[\d.]+/g) ?? []).map(Number);
        const lum = ([r, g, b]: number[]) => {
          const f = (v: number) => ((v /= 255) <= 0.03928 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4);
          return 0.2126 * f(r) + 0.7152 * f(g) + 0.0722 * f(b);
        };
        const contrast = (a: string, b: string) => {
          const [x, y] = [lum(rgb(a)), lum(rgb(b))].sort((p, q) => q - p);
          return Math.round(((x + 0.05) / (y + 0.05)) * 10) / 10;
        };
        const c = document.querySelector<HTMLElement>(cardSel)!;
        const s = getComputedStyle(c);
        const panel = getComputedStyle(document.querySelector(panelSel)!).backgroundColor;
        const box = c.getBoundingClientRect();
        const at = (e: Element | null) => {
          if (!e) return null;
          const r = e.getBoundingClientRect();
          return [Math.round(r.left - box.left), Math.round(r.top - box.top), Math.round(r.width)];
        };
        const shadows = s.boxShadow === "none" ? [] : s.boxShadow.split(/,(?![^(]*\))/).map((x) => x.trim());
        const bar = shadows.find((x) => x.endsWith("inset") && /\b3px 0px 0px/.test(x));
        const barColour = bar?.match(/rgba?\([^)]*\)/)?.[0] ?? null;
        const quote = c.querySelector(".comment-quote");
        const label = c.querySelector(".comment-whole");
        const words = document.querySelector(`${editor} .comment-range.active`);
        return {
          active: c.classList.contains("active"),
          fill: s.backgroundColor,
          edge: contrast(s.borderTopColor, panel),
          edgeWidths: [s.borderTopWidth, s.borderRightWidth, s.borderBottomWidth, s.borderLeftWidth],
          style: s.borderTopStyle,
          // The bar: an inset shadow 3 pixels wide on the left, in a colour that stands out from the wash.
          bar: barColour ? contrast(barColour, s.backgroundColor) : 0,
          // A ring all round, as the keyboard's focus has: an outline, or a shadow outside the card.
          ring: s.outlineStyle !== "none" || shadows.some((x) => !x.endsWith("inset")),
          quote: quote ? getComputedStyle(quote).backgroundColor : null,
          label: label ? getComputedStyle(label).backgroundColor : null,
          words: words ? getComputedStyle(words).backgroundColor : null,
          width: Math.round(box.width),
          parts: {
            label: at(c.querySelector(".comment-head > :first-child")),
            corner: at(c.querySelector(".comment-head .comment-close")),
            icon: at(c.querySelector(".comment-avatar")),
            words: at(c.querySelector(".comment-body, .pass-note-text")),
          },
        };
      },
      [sel, PANEL, EDITOR] as const,
    );
  const clear = "rgba(0, 0, 0, 0)";

  for (const scheme of ["light", "dark"] as const) {
    await page.emulateMedia({ colorScheme: scheme });
    // Nothing in focus: how each card usually looks.
    await noCardInFocus(page, "By how much?");
    const usual = new Map<string, Awaited<ReturnType<typeof lookOf>>>();
    for (const k of kinds) usual.set(k.name, await lookOf(k.sel));
    for (const k of kinds) {
      const was = usual.get(k.name)!;
      const why = `${scheme}, ${k.name}, not in focus`;
      expect(was.edge, why).toBeLessThan(1.6);
      expect([was.bar, was.ring], why).toEqual([0, false]);
      if (k.name === "a resolved comment") expect([was.style, was.fill], why).toEqual(["dashed", clear]);
      if (was.quote !== null) expect(was.quote, why).toBe(clear);
    }

    let wash = "";
    for (const k of kinds) {
      const why = `${scheme}, ${k.name}`;
      await page.locator(k.sel).locator(k.click).first().click();
      await page.mouse.move(2, 2);
      await expect(page.locator(k.sel), why).toHaveClass(/active/);
      await settle(page);
      const was = usual.get(k.name)!;
      const now = await lookOf(k.sel);
      // A wash over the whole card, apart from every card not in focus.
      expect(now.fill, why).not.toBe(was.fill);
      for (const other of kinds) expect(now.fill, `${why}, against ${other.name}`).not.toBe(usual.get(other.name)!.fill);
      wash ||= now.fill;
      expect(now.fill, `${why}: the same wash on every kind`).toBe(wash);
      // A shape as well as a colour: the thick bar down its left edge, at least 3 to 1 against the wash, and a strong edge.
      expect(now.bar, `${why}: the bar`).toBeGreaterThanOrEqual(3);
      expect(now.edge, `${why}: the edge`).toBeGreaterThanOrEqual(3);
      // Not a ring all round, so it isn't taken for the keyboard's focus.
      expect(now.ring, `${why}: no ring`).toBe(false);
      expect(now.style, why).toBe("solid");
      // Nothing moves or changes size: the card's width, its edge, and where its label, corner button, icon and words sit.
      expect(now.width, `${why}: width`).toBe(was.width);
      expect(now.edgeWidths, `${why}: edge`).toEqual(was.edgeWidths);
      expect(now.parts, `${why}: its parts`).toEqual(was.parts);
      // Its label lit: the quote in the coral its words have on the page; "Whole document" and the others' labels in blue-grey.
      if (k.name === "a comment on words" || k.name === "an answered comment") {
        expect(now.words, why).not.toBeNull();
        expect(now.quote, `${why}: the quote`).toBe(now.words);
      } else if (k.name === "a resolved comment") expect(now.quote, `${why}: its words aren't marked on the page`).toBe(clear);
      else expect(now.label, `${why}: the label`).not.toBe(was.label);
    }

    // A comment being written is in focus too, with the same look.
    await selectText(page, "We should");
    await page.getByRole("button", { name: "Comment", exact: true }).click();
    const draft = await lookOf(`${PANEL} .comment-card.draft`);
    expect([draft.active, draft.ring, draft.style], `${scheme}, a new comment`).toEqual([true, false, "solid"]);
    expect(draft.bar, `${scheme}, a new comment`).toBeGreaterThanOrEqual(3);
    expect(draft.fill, `${scheme}, a new comment`).toBe(wash);
    await page.keyboard.press("Escape");
    await expect(page.locator(`${PANEL} .comment-card.draft`)).toHaveCount(0);

    // The keyboard resting on a card (Next Comment) adds its focus ring, outside the card, on top of the look.
    await page.locator(`${EDITOR} h1`).click();
    await settle(page);
    await clickMenu(app, "review-next");
    const resting = page.locator(`${PANEL} .comment-card:focus`);
    await expect(resting).toHaveCount(1);
    const ring = await resting.evaluate((c) => {
      const s = getComputedStyle(c);
      return [c.classList.contains("active"), s.outlineStyle, s.outlineWidth, s.outlineOffset];
    });
    expect(ring, scheme).toEqual([true, "solid", "2px", "2px"]);
  }
  await run.app.close();
});

test("a card drawn again while a button in it has the keyboard (the \"⋯\", Resolve) keeps the keyboard on that button", async () => {
  const run = await openText("# Plan\n\nWe should hire two people.\n\nThe budget is tight.\n");
  const { page } = run;
  await comment(run, "two people", "Make it three.");
  const c = card(page, "Make it three.");
  await c.locator(".comment-body").click();
  await expect(c).toHaveClass(/active/);
  const more = moreOn(page, "Make it three.");
  await more.focus();
  await expect(more).toBeFocused();
  const { session: claude } = await AgentSession.start(run.dataDir, "claude-code");
  try {
    // Claude takes the document and answers: the card is drawn again, twice.
    const ids = idsIn(await claude.ok("take_document", { path: run.file }));
    await claude.ok("reply_to_comment", { path: run.file, comment_id: ids.get("two people"), text: "Now three." });
    await expect(c).toContainText("Now three.");
    await expect(more).toBeFocused();
    await claude.ok("finish_editing", { path: run.file });
    await expect(c).toHaveAttribute("aria-label", /waiting for you/);
    await expect(more).toBeFocused();
    // Resolve, beside it in the corner: the keyboard stays on it as the card is drawn again.
    const resolve = resolveOn(page, "Make it three.");
    await page.keyboard.press("Tab");
    await expect(resolve).toBeFocused();
    await claude.ok("take_document", { path: run.file });
    await claude.ok("reply_to_comment", { path: run.file, comment_id: ids.get("two people"), text: "Or four?" });
    await expect(c).toContainText("Or four?");
    await expect(resolve).toBeFocused();
    await claude.ok("finish_editing", { path: run.file });
    await expect(c).toHaveAttribute("aria-label", /waiting for you/);
    await expect(resolve).toBeFocused();
  } finally {
    await claude.stop();
    await run.app.close();
  }
});
