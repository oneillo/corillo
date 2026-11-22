// Dragging the lines between columns: the comments (or history) panel's left
// edge, and the line between the Markdown text and its preview. Each stays
// within limits that keep both sides usable, follows the window, is
// remembered, goes back to its usual width on a double-click, and moves with
// the arrow keys.
import { test, expect, type Locator, type Page } from "@playwright/test";
import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openText, selectText, clickMenu } from "./helpers";

const DOC = `# Plan

We should hire two people this quarter, one for support and one for the website.

The budget comes from the training line, which we didn't spend last year.
`;

const PANEL = ".doc:not([hidden]) .comments-panel";
const HISTORY = ".doc:not([hidden]) .history-panel";
/** The page's area beside the comments panel, with the room for its scroll bar (kept even when there's nothing to scroll, style.css). */
const CANVAS = ".doc:not([hidden]) .canvas.with-side";
const SOURCE = ".doc:not([hidden]) .source";
const PREVIEW = ".doc:not([hidden]) .preview-pane";
const sideLine = (page: Page) => page.getByRole("separator", { name: "Side panel width" });
const splitLine = (page: Page) => page.getByRole("separator", { name: "Markdown text width" });

const width = (page: Page, selector: string) =>
  page.locator(selector).evaluate((e) => Math.round(e.getBoundingClientRect().width));
/** Wait for the next frame, as the window draws it. */
const frame = (page: Page) => page.evaluate(() => new Promise<void>((r) => requestAnimationFrame(() => r())));

async function addComment(page: Page, quote: string, text: string): Promise<void> {
  await selectText(page, quote);
  await page.getByRole("button", { name: "Comment", exact: true }).click();
  await page.getByRole("textbox", { name: "New comment" }).fill(text);
  await page.getByRole("button", { name: "Post" }).click();
  await expect(page.locator(".comment-card:not(.draft)", { hasText: text })).toBeVisible();
}

/** Where to put the pointer to grab a line. */
async function grab(line: Locator): Promise<{ x: number; y: number }> {
  const box = (await line.boundingBox())!;
  return { x: box.x + box.width / 2, y: box.y + box.height / 2 };
}

/** Drag a line sideways by this many pixels (negative is left), the way a person would. */
async function drag(page: Page, line: Locator, by: number): Promise<void> {
  const { x, y } = await grab(line);
  await page.mouse.move(x, y);
  await page.mouse.down();
  await page.mouse.move(x + by, y, { steps: 8 });
  await page.mouse.up();
}

const valueOf = async (line: Locator) => Number(await line.getAttribute("aria-valuenow"));

test("dragging the comments panel's left edge makes it wider or narrower as the pointer moves", async () => {
  const run = await openText(DOC);
  const { page } = run;
  await page.setViewportSize({ width: 1280, height: 800 });
  await addComment(page, "two people", "Which roles?");
  expect(await width(page, PANEL)).toBe(304);

  // Nothing in the panel is drawn again while it's dragged.
  await page.evaluate((panel) => {
    const g = globalThis as unknown as { redrawn: number };
    g.redrawn = 0;
    new MutationObserver((records) => {
      g.redrawn += records.filter((r) => !(r.target as Element).closest?.("time")).length;
    }).observe(document.querySelector(`${panel} .comments-list`)!, { childList: true, subtree: true });
  }, PANEL);

  const line = sideLine(page);
  const { x, y } = await grab(line);
  await page.mouse.move(x, y);
  await page.mouse.down();
  await page.mouse.move(x - 40, y, { steps: 4 });
  await frame(page);
  expect(await width(page, PANEL), "while still dragging").toBe(344);
  await page.mouse.move(x - 96, y, { steps: 4 });
  await page.mouse.up();
  expect(await width(page, PANEL)).toBe(400);
  expect(await valueOf(line)).toBe(400);
  expect(await page.evaluate(() => (globalThis as unknown as { redrawn: number }).redrawn)).toBe(0);

  await drag(page, line, 60);
  expect(await width(page, PANEL)).toBe(340);
  // The line takes no room: the page and the panel fill the window between them.
  expect((await width(page, CANVAS)) + (await width(page, PANEL))).toBe(1280);
  await run.app.close();
});

test("the panel stays between 264 pixels and the room the page needs, on a wide window and a narrow one", async () => {
  const run = await openText(DOC);
  const { page } = run;
  await page.setViewportSize({ width: 1600, height: 800 });
  await addComment(page, "two people", "Which roles?");
  const line = sideLine(page);

  // Wide: at most half the window. (Each drag stays inside the window, as a person's would.)
  await drag(page, line, -1000);
  expect(await width(page, PANEL)).toBe(800);
  expect([await line.getAttribute("aria-valuemin"), await line.getAttribute("aria-valuemax")]).toEqual(["264", "800"]);
  await drag(page, line, 700);
  expect(await width(page, PANEL)).toBe(264);

  // At its narrowest a comment card is still readable while replying: nothing
  // cut off, the name and time on one line, the "⋯" (Edit and Delete) and
  // Resolve together in the top right corner, and Cancel and Reply on another
  // line. (Changed 2026-11-09: Edit and Delete were words on a line of their own.
  // Changed 2026-11-12, roadmap Batch 9, item 2: the first comment's "⋯" is in the corner, beside Resolve.)
  await page.locator(".comment-card:not(.draft) .comment-body").first().click();
  const card = page.locator(".comment-card.active");
  await card.getByRole("textbox", { name: "Reply" }).click();
  await page.keyboard.type("Support first, then the website.");
  await expect(card.getByRole("button", { name: "Reply" })).toBeVisible();
  const fits = await card.evaluate((c) => {
    const right = c.getBoundingClientRect().right;
    const cut = [...c.querySelectorAll<HTMLElement>("*")].filter((e) => e.offsetParent && e.getBoundingClientRect().right > right + 0.5);
    const rows = (sel: string) => {
      const tops = [...c.querySelectorAll<HTMLElement>(`${sel} button`)].map((b) => Math.round(b.getBoundingClientRect().top));
      return `${tops.length} buttons on ${new Set(tops).size} line`;
    };
    const oneLine = (sels: string[]) => {
      const middles = sels.map((sel) => {
        const r = c.querySelector(sel)!.getBoundingClientRect();
        return r.top + r.height / 2;
      });
      return Math.max(...middles) - Math.min(...middles) <= 1;
    };
    return {
      cut: cut.length,
      overflow: c.scrollWidth - c.clientWidth,
      nameLine: oneLine([".comment-author", ".comment-time"]),
      corner: oneLine([".comment-head .comment-more", ".comment-head .comment-resolve"]),
      reply: rows(".comment-reply-actions"),
    };
  });
  expect(fits).toEqual({ cut: 0, overflow: 0, nameLine: true, corner: true, reply: "2 buttons on 1 line" });

  // Narrow: the page keeps 480 pixels.
  await page.setViewportSize({ width: 900, height: 800 });
  await drag(page, line, -600);
  expect(await width(page, PANEL)).toBe(420);
  expect(await width(page, CANVAS)).toBe(480);
  expect(await line.getAttribute("aria-valuemax")).toBe("420");
  await drag(page, line, 400);
  expect(await width(page, PANEL)).toBe(264);
  await card.getByRole("textbox", { name: "Reply" }).fill(""); // nothing left unposted, so closing doesn't ask
  await run.app.close();
});

test("when the window gets narrower, the panel gives way before the page does, and grows back when the window widens", async () => {
  const run = await openText(DOC);
  const { page } = run;
  await page.setViewportSize({ width: 1400, height: 800 });
  await addComment(page, "two people", "Which roles?");
  await drag(page, sideLine(page), -196);
  expect(await width(page, PANEL)).toBe(500);

  const at = async (windowWidth: number) => {
    await page.setViewportSize({ width: windowWidth, height: 800 });
    await frame(page);
    await frame(page);
    return { panel: await width(page, PANEL), page: await width(page, CANVAS) };
  };
  expect(await at(900)).toEqual({ panel: 420, page: 480 });
  expect(await at(760)).toEqual({ panel: 280, page: 480 });
  // Too narrow for both: the panel stops at its minimum (it can be hidden from the status bar).
  expect(await at(700)).toEqual({ panel: 264, page: 436 });
  expect(await at(1400)).toEqual({ panel: 500, page: 900 });
  await run.app.close();
});

test("the panel's width is remembered the next time Corillo opens, with the zoom, and History has the same width", async () => {
  const dataDir = mkdtempSync(join(tmpdir(), "corillo-data-"));
  const first = await openText(DOC, { dataDir });
  await first.page.setViewportSize({ width: 1280, height: 800 });
  await addComment(first.page, "two people", "Which roles?");
  await clickMenu(first.app, "zoom-in");
  await drag(first.page, sideLine(first.page), -96);
  expect(await width(first.page, PANEL)).toBe(400);
  await first.app.close();
  const saved = JSON.parse(readFileSync(join(dataDir, "view.json"), "utf8"));
  expect(saved).toMatchObject({ zoom: 1.1, sideWidth: 400 });

  const second = await openText(DOC, { dataDir });
  const { page } = second;
  await page.setViewportSize({ width: 1280, height: 800 });
  await expect(page.locator("#zoom-level")).toHaveText("110%");
  await page.getByRole("button", { name: "History", exact: true }).click();
  await expect(page.locator(HISTORY)).toBeVisible();
  await expect.poll(() => width(page, HISTORY)).toBe(400);

  // One width for both: dragging History's edge changes the comments panel too.
  await drag(page, sideLine(page), 50);
  expect(await width(page, HISTORY)).toBe(350);
  await page.getByRole("button", { name: "History", exact: true }).click();
  await addComment(page, "training line", "From which year?");
  expect(await width(page, PANEL)).toBe(350);
  await second.app.close();
});

test("double-clicking the panel's edge puts it back to its usual width", async () => {
  const run = await openText(DOC);
  const { page } = run;
  await page.setViewportSize({ width: 1280, height: 800 });
  await addComment(page, "two people", "Which roles?");
  const line = sideLine(page);
  await drag(page, line, -150);
  expect(await width(page, PANEL)).toBe(454);
  const { x, y } = await grab(line);
  await page.mouse.dblclick(x, y);
  expect(await width(page, PANEL)).toBe(304);
  expect(await valueOf(line)).toBe(304);
  await run.app.close();
});

test("the panel's edge moves with the arrow keys and tells assistive technology where it is", async () => {
  const run = await openText(DOC);
  const { page } = run;
  await page.setViewportSize({ width: 1280, height: 800 });
  await addComment(page, "two people", "Which roles?");
  const line = sideLine(page);
  await expect(line).toHaveAttribute("aria-orientation", "vertical");
  await expect(line).toHaveAttribute("aria-valuenow", "304");
  await expect(line).toHaveAttribute("aria-valuemin", "264");
  await expect(line).toHaveAttribute("aria-valuemax", "640");
  await expect(line).toHaveAttribute("tabindex", "0");

  await line.focus();
  await page.keyboard.press("ArrowLeft"); // the line moves left: a wider panel
  expect(await width(page, PANEL)).toBe(320);
  await page.keyboard.press("ArrowLeft");
  await expect(line).toHaveAttribute("aria-valuenow", "336");
  await page.keyboard.press("ArrowRight");
  expect(await width(page, PANEL)).toBe(320);
  for (let i = 0; i < 6; i++) await page.keyboard.press("ArrowRight");
  expect(await width(page, PANEL)).toBe(264); // and no narrower
  await run.app.close();
});

test("the edge shows a thin accent line under the pointer and while dragging, in light and dark, without moving anything", async () => {
  const run = await openText(DOC);
  const { page } = run;
  await page.setViewportSize({ width: 1280, height: 800 });
  await addComment(page, "two people", "Which roles?");
  const line = sideLine(page);
  const look = () =>
    line.evaluate((e) => {
      const after = getComputedStyle(e, "::after");
      return { line: after.backgroundColor, lineWidth: after.width, cursor: getComputedStyle(e).cursor };
    });
  const panelLeft = () => page.locator(PANEL).evaluate((e) => e.getBoundingClientRect().left);

  await page.mouse.move(200, 400);
  const before = await panelLeft();
  expect(await look()).toEqual({ line: "rgba(0, 0, 0, 0)", lineWidth: "2px", cursor: "col-resize" });
  for (const [scheme, accent] of [["light", "rgb(79, 109, 122)"], ["dark", "rgb(132, 166, 181)"]] as const) {
    await page.emulateMedia({ colorScheme: scheme });
    const { x, y } = await grab(line);
    await page.mouse.move(x, y);
    expect((await look()).line, `${scheme}, under the pointer`).toBe(accent);
    expect(await panelLeft()).toBe(before);
    await page.mouse.down();
    await page.mouse.move(x - 200, y, { steps: 4 }); // the pointer leaves the line, which stays lit
    await frame(page);
    expect((await look()).line, `${scheme}, while dragging`).toBe(accent);
    await page.mouse.move(x, y, { steps: 4 });
    await page.mouse.up();
    await page.mouse.move(200, 400);
    expect((await look()).line, `${scheme}, after`).toBe("rgba(0, 0, 0, 0)");
  }
  await run.app.close();
});

test("the line between the Markdown text and its preview drags too, keeps 320 pixels each side and goes back on a double-click", async () => {
  const run = await openText(DOC);
  const { page } = run;
  await page.setViewportSize({ width: 1280, height: 800 });
  await page.getByRole("button", { name: "Markdown" }).click();
  // The comments panel hidden, so the Markdown view has the whole window.
  await page.locator("#toolbar .comments-tool").click();
  await expect(page.locator(PANEL)).toBeHidden();
  const line = splitLine(page);
  await expect.poll(() => width(page, SOURCE)).toBe(640);
  expect(await width(page, PREVIEW)).toBe(640);
  await expect(line).toHaveAttribute("aria-orientation", "vertical");
  await expect(line).toHaveAttribute("aria-valuemin", "320");
  await expect(line).toHaveAttribute("aria-valuemax", "960");

  const { x, y } = await grab(line);
  await page.mouse.move(x, y);
  await page.mouse.down();
  await page.mouse.move(x - 100, y, { steps: 4 });
  await frame(page);
  expect(await width(page, SOURCE), "while still dragging").toBe(540);
  await page.mouse.move(x - 200, y, { steps: 4 });
  await page.mouse.up();
  expect([await width(page, SOURCE), await width(page, PREVIEW)]).toEqual([440, 840]);

  await drag(page, line, -400);
  expect(await width(page, SOURCE)).toBe(320);
  await drag(page, line, 940);
  expect([await width(page, SOURCE), await width(page, PREVIEW)]).toEqual([960, 320]);

  const at = await grab(line);
  await page.mouse.dblclick(at.x, at.y);
  expect(await width(page, SOURCE)).toBe(640);
  expect(await valueOf(line)).toBe(640);

  await line.focus();
  await page.keyboard.press("ArrowRight"); // the line moves right: more room for the Markdown text
  expect(await width(page, SOURCE)).toBe(656);
  await page.keyboard.press("ArrowLeft");
  await page.keyboard.press("ArrowLeft");
  expect(await width(page, SOURCE)).toBe(624);
  await expect(line).toHaveAttribute("aria-valuenow", "624");
  await run.app.close();
});

test("the Markdown view keeps its proportions as the window changes, and remembers them the next time", async () => {
  const dataDir = mkdtempSync(join(tmpdir(), "corillo-data-"));
  const first = await openText(DOC, { dataDir });
  await first.page.setViewportSize({ width: 1280, height: 800 });
  await first.page.getByRole("button", { name: "Markdown" }).click();
  // The comments panel hidden (and so the next time too), so the Markdown view has the whole window.
  await first.page.locator("#toolbar .comments-tool").click();
  await expect(first.page.locator(PANEL)).toBeHidden();
  await expect.poll(() => width(first.page, SOURCE)).toBe(640);
  await drag(first.page, splitLine(first.page), -240);
  expect(await width(first.page, SOURCE)).toBe(400);

  const at = async (page: Page, windowWidth: number) => {
    await page.setViewportSize({ width: windowWidth, height: 800 });
    await frame(page);
    await frame(page);
    return [await width(page, SOURCE), await width(page, PREVIEW)];
  };
  expect(await at(first.page, 1600)).toEqual([500, 1100]);
  expect(await at(first.page, 700)).toEqual([320, 380]); // the text keeps its minimum
  expect(await at(first.page, 1280)).toEqual([400, 880]);
  await first.app.close();

  const second = await openText(DOC, { dataDir });
  await second.page.setViewportSize({ width: 1280, height: 800 });
  await second.page.getByRole("button", { name: "Markdown" }).click();
  await expect.poll(() => width(second.page, SOURCE)).toBe(400);
  await expect(splitLine(second.page)).toHaveAttribute("aria-valuenow", "400");
  await second.app.close();
});
