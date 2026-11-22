// View > Show Outline (roadmap Batch 4, item 1): the document's headings to
// three levels at the left of the page, the one in sight marked and named in
// the status bar; beside each, its section's open comments and a dot when an
// agent changed it since the hand-over (the Done tick went in roadmap Batch 9).
// Off until turned on, then remembered; it gives way in a narrow window. The
// toolbar's Outline button does what the menu item does (roadmap Batch 9).
import { test, expect, type ElectronApplication, type Page } from "@playwright/test";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { AgentSession } from "./agent-session";
import { clickMenu, cursorAtEnd, EDITOR, expectFile, openAlso, openText, type Running, launch } from "./helpers";

const para = (n: number) => `${"Words to read in this part, enough to fill a few lines of the page. ".repeat(10)}(${n})`;
const DOC = [
  "# Plan", "", para(1), "",
  "## Goals", "", para(2), "", para(3), "",
  "### Detail", "", para(4), "",
  "#### Deeper", "", para(5), "",
  "```", "# not a heading", "```", "",
  "## Budget", "", para(6), "", para(7), "", para(8), "",
  "## Risks", "", para(9), "", para(10), "", para(11), "", para(12), "", para(13), "",
].join("\n");

const PANE = ".doc:not([hidden]) .outline-pane";
const ROWS = `${PANE} .outline-row`;
const STATUS = "#outline-section";
const go = (page: Page, words: string) => page.locator(`${ROWS} .outline-go`, { has: page.locator(".outline-words", { hasText: new RegExp(`^${words}$`) }) });
const headings = (page: Page) => page.locator(`${ROWS} .outline-words`).allTextContents();
const marked = (page: Page) => page.locator(`${ROWS}.in-sight .outline-words`);
const scroller = (page: Page) => page.locator(".doc:not([hidden]) .canvas.with-side");

function checked(app: ElectronApplication): Promise<boolean> {
  return app.evaluate(({ Menu }) => Menu.getApplicationMenu()!.getMenuItemById("view-outline")!.checked);
}

async function relaunch(run: Running): Promise<Running> {
  await run.app.close();
  const { app, thrown } = await launch({
    args: ["--force-device-scale-factor=1", ".", run.file], // ONE_SCALE (helpers.ts)
    env: { ...process.env, CORILLO_USER_DATA: run.dataDir, CORILLO_HIDDEN: "1", CORILLO_HOME: mkdtempSync(join(tmpdir(), "corillo-home-")) },
  });
  const page = await app.firstWindow();
  await page.waitForSelector(".ProseMirror");
  return { ...run, app, page, thrown };
}

/** How far the heading's top is below the top of the page's area. */
function headingFromTop(page: Page, words: string): Promise<number> {
  return page.evaluate(
    ({ editor, words }) => {
      const h = [...document.querySelectorAll<HTMLElement>(`${editor} :is(h1, h2, h3)`)].find((e) => e.textContent === words)!;
      const s = h.closest(".canvas")!;
      return h.getBoundingClientRect().top - s.getBoundingClientRect().top;
    },
    { editor: EDITOR, words },
  );
}

test("View > Show Outline lists the headings to three levels at the left of the page; a click goes there, and the one in sight is marked and named in the status bar", async () => {
  const run = await openText(DOC, { name: "plan.md" });
  const { app, page } = run;
  try {
    await page.setViewportSize({ width: 1200, height: 700 });
    // Off until it's turned on: nothing beside the page, nothing in the status bar.
    expect(await checked(app)).toBe(false);
    await expect(page.locator(".outline-pane")).toHaveCount(0);
    await expect(page.locator(STATUS)).toBeHidden();

    await clickMenu(app, "view-outline");
    await expect(page.locator(PANE)).toBeVisible();
    expect(await checked(app)).toBe(true);
    // A fourth-level heading is inside its section, and a # in code is no heading.
    await expect.poll(() => headings(page)).toEqual(["Plan", "Goals", "Detail", "Budget", "Risks"]);
    expect(await page.locator(ROWS).evaluateAll((rows) => rows.map((r) => (r as HTMLElement).dataset.level))).toEqual(["1", "2", "3", "2", "2"]);
    const paneBox = (await page.locator(PANE).boundingBox())!;
    const pageBox = (await page.locator(".doc:not([hidden]) .doc-main").boundingBox())!;
    expect(paneBox.x + paneBox.width).toBeLessThanOrEqual(pageBox.x + 1);
    await expect(marked(page)).toHaveText("Plan");
    await expect(page.locator(STATUS)).toHaveText("Plan");

    // A click brings the heading to the top of the page, marks it, and puts the cursor at its start.
    await go(page, "Budget").click();
    await expect(marked(page)).toHaveText("Budget");
    await expect(page.locator(STATUS)).toHaveText("Budget");
    const top = await headingFromTop(page, "Budget");
    expect(top).toBeGreaterThanOrEqual(0);
    expect(top).toBeLessThan(64);
    await page.keyboard.type("Our ");
    await expectFile(run, DOC.replace("## Budget", "## Our Budget"));
    await expect.poll(() => headings(page)).toEqual(["Plan", "Goals", "Detail", "Our Budget", "Risks"]);

    // Scrolling moves the mark, and the status bar's words, with it.
    await scroller(page).evaluate((s) => (s.scrollTop = 0));
    await expect(page.locator(STATUS)).toHaveText("Plan");
    await page.locator(`${EDITOR} h3`).evaluate((h) => h.scrollIntoView({ block: "start" }));
    await expect(marked(page)).toHaveText("Detail");
    await expect(page.locator(STATUS)).toHaveText("Detail");
    // At the end of the document, the last heading in sight.
    await scroller(page).evaluate((s) => (s.scrollTop = s.scrollHeight));
    await expect(page.locator(STATUS)).toHaveText("Risks");

    // Only in the formatted view: the Markdown view has its own two halves.
    await clickMenu(app, "view-markdown");
    await expect(page.locator(PANE)).toBeHidden();
    await expect(page.locator(STATUS)).toBeHidden();
    await clickMenu(app, "view-formatted");
    await expect(page.locator(PANE)).toBeVisible();
    await expect(page.locator(STATUS)).toBeVisible();

    // Off again: gone, and the status bar says nothing of it.
    await clickMenu(app, "view-outline");
    await expect(page.locator(".outline-pane")).toHaveCount(0);
    await expect(page.locator(STATUS)).toBeHidden();
    expect(await checked(app)).toBe(false);
  } finally {
    await run.app.close();
  }
});

test("each heading counts its section's open comments; a dot marks the sections an agent changed since you handed it over; while changes are shown the outline is dimmed", async () => {
  const run = await openText(DOC, { name: "plan.md" });
  const { app, page } = run;
  const { session } = await AgentSession.start(run.dataDir);
  try {
    await page.setViewportSize({ width: 1200, height: 700 });
    await clickMenu(app, "view-outline");
    await expect.poll(() => headings(page)).toEqual(["Plan", "Goals", "Detail", "Budget", "Risks"]);
    const counts = () => page.locator(`${ROWS} .outline-count`).allTextContents();
    expect(await counts()).toEqual(["", "", "", "", ""]);

    await session.ok("add_comment", { path: run.file, quote: "(2)", text: "Shorter?" });
    await session.ok("add_comment", { path: run.file, quote: "(6)", text: "Is this right?" });
    await session.ok("add_comment", { path: run.file, quote: "(7)", text: "And this?" });
    await expect.poll(counts).toEqual(["", "1", "", "2", ""]);
    await expect(go(page, "Budget")).toHaveAttribute("title", "Budget, 2 open comments");

    // The agent takes the document from the person and changes a paragraph in Risks.
    const dots = () =>
      page.locator(ROWS).evaluateAll((rows) => rows.filter((r) => !r.querySelector<HTMLElement>(".outline-dot")!.hidden).map((r) => r.querySelector(".outline-words")!.textContent));
    expect(await dots()).toEqual([]);
    await session.ok("take_document", { path: run.file });
    await session.ok("edit_document", { path: run.file, edits: [{ find: "(10)", replace: "(10) Changed by the agent." }] });
    await session.ok("finish_editing", { path: run.file });
    await expect.poll(dots).toEqual(["Risks"]);
    await expect(go(page, "Risks")).toHaveAttribute("title", "Risks, changed since you handed it over");

    // Show changes takes the page's place: the outline stays where it is, dimmed and out of use.
    await clickMenu(app, "view-changes");
    await expect(page.locator(".doc:not([hidden]).viewing-changes")).toBeVisible();
    await expect.poll(() => page.locator(PANE).evaluate((p) => (p as HTMLElement).inert)).toBe(true);
    await expect(page.locator(STATUS)).toBeHidden();
    await clickMenu(app, "view-changes");
    await expect.poll(() => page.locator(PANE).evaluate((p) => (p as HTMLElement).inert)).toBe(false);
    await expect(page.locator(STATUS)).toBeVisible();
  } finally {
    await session.stop();
    await run.app.close();
  }
});

// Roadmap Batch 9, item 9 (Orlando, 2026-11-12: "I don't think outline needs a "mark this section done" button. I'll
// never do that."): beside each heading, its open comments and the dot, and nothing to tick.
test("beside each heading there's no Done box, only its open comments' count and the dot; the keyboard goes from heading to heading", async () => {
  const run = await openText(DOC, { name: "plan.md" });
  const { app, page } = run;
  try {
    await page.setViewportSize({ width: 1200, height: 700 });
    await clickMenu(app, "view-outline");
    await expect.poll(() => headings(page)).toEqual(["Plan", "Goals", "Detail", "Budget", "Risks"]);
    // One button a row, the heading itself, under the pointer too.
    await go(page, "Budget").hover();
    const controls = () => page.locator(ROWS).evaluateAll((rows) => rows.map((r) => r.querySelectorAll("button, input, [role]").length));
    expect(await controls()).toEqual([1, 1, 1, 1, 1]);
    await expect(go(page, "Budget")).toHaveAttribute("title", "Budget");
    // Right and Left go nowhere; Up, Down, Home and End go from heading to heading.
    await go(page, "Plan").focus();
    await page.keyboard.press("ArrowRight");
    await expect(go(page, "Plan")).toBeFocused();
    await page.keyboard.press("ArrowDown");
    await expect(go(page, "Goals")).toBeFocused();
    await page.keyboard.press("ArrowLeft");
    await expect(go(page, "Goals")).toBeFocused();
    await page.keyboard.press("End");
    await expect(go(page, "Risks")).toBeFocused();
    await page.keyboard.press("Home");
    await expect(go(page, "Plan")).toBeFocused();
  } finally {
    await run.app.close();
  }
});

const TICKED = "# Plan\n\nIntro.\n\n## Budget\n\nThe budget is tight.\n\n## Risks\n\nSome.\n";

/** The settings Corillo keeps for this document in its own records (src/main/store.ts), once it has a record of it. */
function settingsFile(run: Running): string | null {
  try {
    const index = JSON.parse(readFileSync(join(run.dataDir, "documents.json"), "utf8")) as Record<string, { path: string }>;
    const id = Object.keys(index).find((k) => index[k].path === run.file);
    return id ? join(run.dataDir, "documents", id, "settings.json") : null;
  } catch {
    return null;
  }
}

test("Done ticks an earlier Corillo kept are ignored and cleaned up: no tick shows, the agent hears nothing of them, and the document's other settings stay", async () => {
  let run = await openText(TICKED, { name: "plan.md" });
  try {
    await run.page.setViewportSize({ width: 1200, height: 700 });
    await clickMenu(run.app, "view-outline");
    await expect.poll(() => headings(run.page)).toEqual(["Plan", "Budget", "Risks"]);
    await expect.poll(() => settingsFile(run)).not.toBeNull();
    const settings = settingsFile(run)!;
    // As an earlier Corillo kept them: Budget and Risks ticked, beside the export settings (and one it couldn't have written).
    writeFileSync(settings, JSON.stringify({ export: { style: "corillo" }, doneSections: ["Budget", "Risks", 7] }));

    run = await relaunch(run);
    await run.page.setViewportSize({ width: 1200, height: 700 });
    await expect(run.page.locator(PANE)).toBeVisible();
    await expect.poll(() => headings(run.page)).toEqual(["Plan", "Budget", "Risks"]);
    expect(await run.page.locator(ROWS).evaluateAll((rows) => rows.map((r) => r.querySelectorAll("button").length))).toEqual([1, 1, 1]);

    const { session } = await AgentSession.start(run.dataDir);
    try {
      const said = await session.ok("take_document", { path: run.file });
      expect(said).toContain("Budget");
      expect(said).not.toMatch(/sections done|\(done\)|Leave them alone/);
      expect(said).not.toMatch(/^5: ## Budget$/m);
      // An agent rewording a heading: nothing is carried, nothing kept.
      await session.ok("edit_document", { path: run.file, edits: [{ find: "## Budget", replace: "## Costs" }] });
      await session.ok("finish_editing", { path: run.file });
    } finally {
      await session.stop();
    }
    // Cleaned up: the ticks are gone from Corillo's records, everything else as it was.
    await expect.poll(() => JSON.parse(readFileSync(settings, "utf8"))).toEqual({ export: { style: "corillo" } });
    expect(run.text()).toBe(TICKED.replace("## Budget", "## Costs"));
    // Remembered after quitting, the outline is on, and its button says so.
    expect(await checked(run.app)).toBe(true);
    await expect(run.page.getByRole("button", { name: "Outline", exact: true })).toHaveAttribute("aria-pressed", "true");
  } finally {
    await run.app.close();
  }
});

// Roadmap Batch 9, item 10 (Orlando, 2026-11-12: "I also couldn't find a button in the UI to get the outline to show
// up. Is there one?", then "Yes to the button."): at the toolbar's left end, over where the outline opens.
test("the Outline button at the toolbar's left end shows and hides the outline, looks pressed while it's on, and always agrees with View > Show Outline", async () => {
  const run = await openText(DOC, { name: "plan.md" });
  const { app, page } = run;
  const button = page.getByRole("button", { name: "Outline", exact: true });
  try {
    await page.setViewportSize({ width: 1200, height: 700 });
    // First on the bar, with a name for screen readers and a tooltip that says what a click does.
    expect(await page.evaluate(() => document.querySelector("#toolbar :is(button, select)")?.getAttribute("aria-label"))).toBe("Outline");
    await expect(button).toBeVisible();
    await expect(button).toBeEnabled();
    await expect(button).toHaveAttribute("aria-pressed", "false");
    await expect(button).toHaveAttribute("title", "Show outline");

    // A click shows it, and leaves the keyboard in the document.
    await cursorAtEnd(page, "(2)");
    await button.click();
    await expect(page.locator(PANE)).toBeVisible();
    await expect(button).toHaveAttribute("aria-pressed", "true");
    await expect(button).toHaveAttribute("title", "Hide outline");
    await expect(button).toHaveClass(/\bon\b/);
    await expect.poll(() => checked(app)).toBe(true);
    await page.keyboard.type(" More.");
    await expectFile(run, DOC.replace("(2)", "(2) More."));
    // The button sits over the outline: its left edge within the pane's.
    const [b, p] = [(await button.boundingBox())!, (await page.locator(PANE).boundingBox())!];
    expect(b.x).toBeGreaterThanOrEqual(p.x);
    expect(b.x + b.width).toBeLessThanOrEqual(p.x + p.width);

    // Off from the menu: the button follows. On from the menu, off from the button: the menu follows.
    await clickMenu(app, "view-outline");
    await expect(page.locator(".outline-pane")).toHaveCount(0);
    await expect(button).toHaveAttribute("aria-pressed", "false");
    await expect(button).toHaveAttribute("title", "Show outline");
    await clickMenu(app, "view-outline");
    await expect(button).toHaveAttribute("aria-pressed", "true");
    await button.click();
    await expect(page.locator(".outline-pane")).toHaveCount(0);
    await expect.poll(() => checked(app)).toBe(false);
    await expect(button).toHaveAttribute("aria-pressed", "false");

    // From the keyboard too: Tab to it, Space.
    await button.focus();
    await page.keyboard.press("Space");
    await expect(page.locator(PANE)).toBeVisible();
    await expect.poll(() => checked(app)).toBe(true);
  } finally {
    await run.app.close();
  }
});

test("in a narrow window the outline gives way to the page, and the status bar names the section in sight on one line", async () => {
  const long = DOC.replace("## Risks", "## Risks to the plan, and what we would do about each of them if they came about");
  const run = await openText(long, { name: "plan.md" });
  const { app, page } = run;
  try {
    await page.setViewportSize({ width: 1200, height: 700 });
    await clickMenu(app, "view-outline");
    await expect(page.locator(PANE)).toBeVisible();
    await scroller(page).evaluate((s) => (s.scrollTop = s.scrollHeight));
    await expect(page.locator(STATUS)).toHaveText(/^Risks to the plan/);

    await page.setViewportSize({ width: 560, height: 700 });
    await expect(page.locator(PANE)).toBeHidden();
    // The page has all the room beside the Comments column.
    await expect.poll(async () => (await page.locator(".doc:not([hidden]) .doc-main").boundingBox())!.x).toBe(0);
    await expect(page.locator(STATUS)).toBeVisible();
    // Nothing in the bar sticks out or wraps; the section's words give way first, all of them in the tooltip.
    const bar = await page.locator(".status-bar").evaluate((b) => {
      const outer = b.getBoundingClientRect();
      const out = [...b.children].filter((c) => {
        const r = c.getBoundingClientRect();
        return r.width > 0 && (r.left < outer.left - 0.5 || r.right > outer.right + 0.5 || r.height > outer.height);
      });
      const s = document.getElementById("outline-section")!;
      return { out: out.map((c) => c.id || c.className), wide: b.scrollWidth > b.clientWidth, cut: s.scrollWidth > s.clientWidth, title: s.title };
    });
    expect(bar).toEqual({ out: [], wide: false, cut: true, title: "In sight: Risks to the plan, and what we would do about each of them if they came about" });
    await expect(page.locator("#copy-path")).toBeVisible();

    // Wide again, it's back.
    await page.setViewportSize({ width: 1200, height: 700 });
    await expect(page.locator(PANE)).toBeVisible();
  } finally {
    await run.app.close();
  }
});

test("with no document open, Show Outline can still be turned on, and the next document opens with it", async () => {
  const run = await openText(DOC, { name: "plan.md" });
  const { app, page } = run;
  try {
    await page.setViewportSize({ width: 1200, height: 700 });
    await clickMenu(app, "close-tab");
    await expect(page.locator("#empty")).toBeVisible();
    expect(await app.evaluate(({ Menu }) => Menu.getApplicationMenu()!.getMenuItemById("view-outline")!.enabled)).toBe(true);
    await clickMenu(app, "view-outline");
    await expect.poll(() => checked(app)).toBe(true);
    await expect(page.locator(STATUS)).toBeHidden();
    await openAlso(run, "notes.md", "# Notes\n\n## First\n\nText.\n");
    await expect(page.locator(PANE)).toBeVisible();
    await expect.poll(() => headings(page)).toEqual(["Notes", "First"]);
    // The toolbar's Outline button agrees: pressed.
    await expect(page.getByRole("button", { name: "Outline", exact: true })).toHaveAttribute("aria-pressed", "true");
  } finally {
    await run.app.close();
  }
});
