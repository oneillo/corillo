// One plan for the whole window (roadmap Batch 11, F-11 and the plan's points 4 and 5): its words come in a
// few sizes, each with one line height, its gaps step by 4 pixels, its controls are 24, 28 or 32 pixels tall,
// and from the narrowest window to a very wide one nothing overlaps or is cut off but by "…".
import { expect, test, type Page } from "@playwright/test";
import { copyFileSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { AgentSession } from "./agent-session";
import { clickMenu, openAlso, openText, selectText, settle, type Running } from "./helpers";
import { tidyRuns } from "./tidy";

const tidy = tidyRuns();
const DOC = ".doc:not([hidden])";
const PANEL = `${DOC} .comments-panel`;

const TEXT = `# Volunteer help desk

Requests reach us through four inboxes and two group chats. Nobody can see what's already being handled.

![Requests by month](Plan%20images/requests.png)

## Where we are today

Last quarter we answered 1,840 requests. Most were simple, but the slow ones were slow for the same reasons.

| Month | Requests |
| --- | --- |
| April | 590 |
| May | 610 |

## What we'd like

One shared help desk, tried for three months over the summer.
`;

/** A plan with a picture, two comments, a second document open, and Claude's pass: a change for one comment, a reply with options, and a change no comment asked for. */
async function reviewed(): Promise<Running> {
  const run = tidy.keep(
    await openText(TEXT, {
      name: "Plan.md",
      prepare: (folder) => {
        mkdirSync(join(folder, "Plan images"));
        copyFileSync(join(import.meta.dirname, "..", "pictures", "sample", "requests.png"), join(folder, "Plan images", "requests.png"));
      },
    }),
  );
  const { page } = run;
  await page.setViewportSize({ width: 1440, height: 900 });
  for (const [words, body] of [
    ["four inboxes and two group chats", "Can we say which inboxes?"],
    ["1,840 requests", "Is this the right number?"],
  ]) {
    await selectText(page, words);
    await page.getByRole("button", { name: "Comment", exact: true }).click();
    await page.getByRole("textbox", { name: "New comment" }).fill(body);
    await page.getByRole("button", { name: "Post" }).click();
    await expect(page.locator(`${PANEL} .comment-card:not(.draft)`, { hasText: body })).toBeVisible();
  }
  await openAlso(run, "Offsite.md", "# Team offsite\n\nTwo days in Ponce in October.\n");
  await page.locator('.tab[title$="/Plan.md"]').click();
  await expect(page.locator(`${DOC} .comment-card`)).toHaveCount(2);
  return run;
}

/** Claude's pass on the plan, from taking it to handing it back; `meanwhile` runs while Claude holds it. */
async function pass(run: Running, meanwhile?: () => Promise<void>): Promise<void> {
  const { session } = await AgentSession.start(run.dataDir, "claude-code");
  try {
    const taken = await session.ok("take_document", { path: run.file });
    const ids = new Map([...taken.matchAll(/\[([^\]]+)\] on "([^"]+)"/g)].map((m) => [m[2], m[1]]));
    const inboxes = ids.get("four inboxes and two group chats")!;
    await session.ok("edit_document", { path: run.file, edits: [{ find: "four inboxes and two group chats", replace: "four inboxes (help, info, volunteers and events) and two group chats" }], comment_ids: [inboxes] });
    await session.ok("edit_document", { path: run.file, edits: [{ find: "over the summer.", replace: "over the summer, from July." }] });
    await session.ok("reply_to_comment", { path: run.file, comment_id: inboxes, text: "Named all four.", options: [{ label: "Shorter", edits: [{ find: "(help, info, volunteers and events)", replace: "(four of them)" }] }] });
    await session.ok("reply_to_comment", { path: run.file, comment_id: ids.get("1,840 requests")!, text: "Yes: April to June." });
    await meanwhile?.();
    const first = await session.call("finish_editing", { path: run.file });
    if (first.isError) await session.ok("finish_editing", { path: run.file });
  } finally {
    await session.stop();
  }
  await expect(run.page.locator(`${DOC} .pass-notice`)).toBeVisible();
}

/**
 * Everything drawn in the window whose words, gaps or height are off the scales: words at 11, 12, 13 or 15
 * pixels, each with its one line height; button words in one weight; margins, paddings and gaps in steps of 4;
 * controls 24, 28 or 32 tall. The page's own words (Literata, set as Word will set them) aren't the window's.
 */
function offScale(page: Page): Promise<string[]> {
  return page.evaluate(() => {
    const LINE: Record<string, number> = { 11: 16, 12: 16, 13: 18, 15: 20 };
    const HEIGHTS = [24, 28, 32];
    const BUTTON_WEIGHT = "500";
    // The page and what's set like it (previews, the Markdown text and its layers), diagrams, and words only
    // screen readers hear.
    const PAGE = ".ProseMirror, .preview, .source, .find-marks, .source-marks, .line-gutter, .together-rows, .cell-marks, .recent-page, .blank-hint, .diagram-workspace, svg, .screen-reader-only, .pass-notice-said";
    // Glyphs drawn as icons (the toolbar's B, I and S, and More's), and the display titles: sizes of their own.
    const OWN_SIZE = ".toolbar button.tool :is(b, i, s), .menu-icon :is(b, i, s), .empty-panel h1, .about-head h1";
    // Rows of a list are as tall as their words, and a comment box grows with them; menus' items are a menu's.
    const ROWS = ".recent-card, .outline-go, .history-item, .history-member, textarea, [role^='menuitem']";
    // The lines people drag take no room, and a dialog is placed where it's needed: their margins aren't gaps.
    const PLACED = ".column-handle, dialog";
    const SPACING = ["margin-top", "margin-right", "margin-bottom", "margin-left", "padding-top", "padding-right", "padding-bottom", "padding-left", "row-gap", "column-gap"];
    const name = (el: Element) => `${el.tagName.toLowerCase()}${el.id ? `#${el.id}` : ""}${[...el.classList].map((c) => `.${c}`).join("")}`;
    const found = new Set<string>();
    for (const el of document.querySelectorAll<HTMLElement>("body *")) {
      const inPage = !!el.closest(PAGE);
      if (inPage && (el.tagName !== "BUTTON" || el.closest(".screen-reader-only, .pass-notice-said"))) continue;
      if (!el.checkVisibility({ opacityProperty: true, visibilityProperty: true })) continue;
      const box = el.getBoundingClientRect();
      if (!box.width || !box.height || box.bottom < 0 || box.top > innerHeight || box.right < 0 || box.left > innerWidth) continue;
      const style = getComputedStyle(el);
      const words = [...el.childNodes].some((n) => n.nodeType === Node.TEXT_NODE && n.textContent!.trim());
      if (words && !el.matches(OWN_SIZE)) {
        const size = parseFloat(style.fontSize);
        const line = style.lineHeight === "normal" ? "normal" : parseFloat(style.lineHeight);
        if (LINE[size] !== line) found.add(`type ${name(el)}: ${size}/${line}`);
      }
      if (el.tagName === "BUTTON" && !el.matches(ROWS) && el.textContent!.trim() && style.fontWeight !== BUTTON_WEIGHT) {
        found.add(`button words ${name(el)}: ${style.fontWeight}`);
      }
      const computed = el.computedStyleMap();
      for (const prop of el.matches(PLACED) ? SPACING.filter((p) => !p.startsWith("margin")) : SPACING) {
        const v = computed.get(prop);
        if (v instanceof CSSUnitValue && v.unit === "px" && v.value % 4 !== 0) found.add(`spacing ${name(el)} ${prop}: ${v.value}`);
      }
      if (el.matches("button, select, input:not([type='radio'], [type='checkbox']), [role='tab']") && !el.matches(ROWS) && !HEIGHTS.includes(box.height)) {
        found.add(`height ${name(el)}: ${box.height}`);
      }
    }
    return [...found].sort();
  });
}

/** The window as it stands, at its new width, once it has been laid out again. */
async function widen(page: Page, width: number, height = 900): Promise<void> {
  await page.setViewportSize({ width, height });
  await page.evaluate(() => new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve))));
}

test("the window's words, gaps and controls come from one scale, in each of its main states", async () => {
  test.setTimeout(90_000);
  const run = await reviewed();
  const { app, page } = run;
  const check = async (state: string) => expect.soft(await offScale(page), state).toEqual([]);
  await check("two documents, with comments");
  await pass(run, () => check("Claude editing"));
  await check("Claude done, with new dots and an option");
  // The card with the change in focus, its change box and "Show what it said before"; then a reply with @.
  await page.locator(`${PANEL} .comment-card`, { hasText: "Named all four." }).locator(".comment-body").first().click();
  await expect(page.locator(`${PANEL} .comment-card.active .comment-change`)).toBeVisible();
  await check("a card in focus, with its change");
  await page.locator(`${PANEL} .comment-card.active`).getByRole("textbox", { name: "Reply" }).fill("Thanks @");
  await expect(page.locator("#mention-list")).toBeVisible();
  await check("a reply, with the list of agents");
  await page.keyboard.press("Escape");
  await page.locator(`${PANEL} .comment-card.active`).getByRole("textbox", { name: "Reply" }).fill("");
  // History, with a version open; Show changes; Find and replace; the outline.
  await page.getByRole("button", { name: "History", exact: true }).click();
  await page.locator(`${DOC} .history-item`).nth(1).click();
  await expect(page.locator(`${DOC} .version-banner`)).toBeVisible();
  await check("History, a version shown");
  await page.getByRole("button", { name: "Back to current" }).click();
  await page.getByRole("button", { name: "History", exact: true }).click();
  await clickMenu(app, "view-changes");
  await expect(page.locator(`${DOC} .version-steps`)).toBeVisible();
  await check("Show changes");
  await clickMenu(app, "view-changes");
  await page.locator(`${DOC} .ProseMirror h1`).click();
  await page.keyboard.press("Meta+Alt+F");
  await page.getByRole("textbox", { name: "Find" }).fill("help");
  await expect(page.locator('.find-bar input[name="replace"]')).toBeVisible();
  await check("Find and replace");
  await page.getByRole("textbox", { name: "Find" }).press("Escape");
  await clickMenu(app, "view-outline");
  await expect(page.locator(`${DOC} .outline-pane`)).toBeVisible();
  await check("the outline");
  await clickMenu(app, "view-outline");
  // The narrowest window: More and a menu inside it.
  await widen(page, 560);
  await page.getByRole("button", { name: "More", exact: true }).click();
  await page.getByRole("menu", { name: "More" }).locator('button[aria-label="Insert"]').click();
  await expect(page.getByRole("menu", { name: "Insert" })).toBeVisible();
  await check("the narrowest window, More and Insert");
  await page.keyboard.press("Escape");
  await page.keyboard.press("Escape");
  await widen(page, 1440);
  // A dialog, and a notice in the corner.
  await clickMenu(app, "export-settings");
  await expect(page.getByRole("dialog", { name: "Export settings" })).toBeVisible();
  await check("Export settings");
  await page.keyboard.press("Escape");
  await clickMenu(app, "copy-email");
  await expect(page.locator(`${DOC} .export-notice`)).toBeVisible();
  await check("a notice in the corner");
  // The start screen with recent documents, and Connect your agents over it.
  await clickMenu(app, "close-tab");
  await clickMenu(app, "close-tab");
  await expect(page.locator("#recent .recent-card")).toHaveCount(2);
  await check("the start screen");
  await clickMenu(app, "connect-agents");
  await expect(page.getByRole("dialog", { name: "Connect your agents" })).toBeVisible();
  await check("Connect your agents");
  await page.keyboard.press("Escape");
  // About Corillo, a window of its own.
  const opened = app.waitForEvent("window");
  await clickMenu(app, "about");
  const about = await opened;
  await about.waitForSelector("body[data-ready]");
  await about.locator("#licence summary").click();
  expect(await offScale(about), "About").toEqual([]);
});

/**
 * What runs into something, sticks out, or is cut off without "…", outside the page: in every row of the window
 * (a flex or grid line), things side by side that overlap or leave the row; anything out of the window or
 * scrolling sideways where nothing should; anything that clips its words with no "…"; and in every bar, anything
 * past its 16-pixel margins.
 */
function crowded(page: Page): Promise<string[]> {
  return page.evaluate(() => {
    const PAGE = ".ProseMirror, .preview, .source, .find-marks, .source-marks, .line-gutter, .together-rows, .cell-marks, .recent-page, .blank-hint, .diagram-workspace, svg";
    // Stacked on purpose: the views take one place in turn, and the Markdown view's layers lie over its text.
    const STACKS = ".views, .split";
    // Words only screen readers hear, a preview of a page's top (cut on purpose), the lines people drag (they lie over their neighbours).
    const LEAVE = ".screen-reader-only, .pass-notice-said, .recent-preview, .column-handle";
    // Scrolls sideways on purpose: the tab bar, with more tabs than it shows.
    const SIDEWAYS = ".tabs";
    const BARS = ".toolbar, .status-bar, .find-bar, .banner, .agent-notice, .pass-notice, .history-header";
    const name = (el: Element) => `${el.tagName.toLowerCase()}${el.id ? `#${el.id}` : ""}${[...el.classList].map((c) => `.${c}`).join("")}`;
    const shown = (el: Element) => {
      const r = el.getBoundingClientRect();
      return r.width > 0 && r.height > 0 && el.checkVisibility({ opacityProperty: true, visibilityProperty: true });
    };
    const scroller = (el: Element) => /(auto|scroll)/.test(getComputedStyle(el).overflowX + getComputedStyle(el).overflowY);
    const inScroller = (el: Element) => {
      for (let e = el.parentElement; e && e !== document.body; e = e.parentElement) if (scroller(e)) return true;
      return false;
    };
    const found = new Set<string>();
    for (const el of document.querySelectorAll<HTMLElement>("body *")) {
      if (el.closest(PAGE) || el.closest(LEAVE) || !shown(el)) continue;
      const style = getComputedStyle(el);
      const box = el.getBoundingClientRect();
      if ((box.left < -0.5 || box.right > innerWidth + 0.5) && !inScroller(el)) found.add(`out of the window: ${name(el)}`);
      if (scroller(el) && !el.matches(SIDEWAYS) && el.scrollWidth > el.clientWidth + 1) found.add(`scrolls sideways: ${name(el)}`);
      const clamped = style.webkitLineClamp !== "none";
      if (/(hidden|clip)/.test(style.overflowX) && el.scrollWidth > el.clientWidth + 1 && style.textOverflow !== "ellipsis" && !clamped) found.add(`cut without "…": ${name(el)}`);
      if (/(hidden|clip)/.test(style.overflowY) && el.scrollHeight > el.clientHeight + 1 && !clamped) found.add(`cut off below: ${name(el)}`);
      if (/flex|grid/.test(style.display) && !el.matches(STACKS)) {
        const kids = [...el.children]
          .filter((k) => shown(k) && !k.matches(LEAVE) && !/absolute|fixed/.test(getComputedStyle(k).position))
          .map((k) => ({ k, r: k.getBoundingClientRect(), s: getComputedStyle(k) }));
        for (const { k, r, s } of kids) {
          // A child may reach past its row only as far as a negative margin of its own takes it.
          const give = (side: string) => Math.max(0, -parseFloat(s.getPropertyValue(`margin-${side}`)));
          if (!scroller(el) && (r.left < box.left - give("left") - 0.5 || r.right > box.right + give("right") + 0.5)) found.add(`out of its row: ${name(k)} in ${name(el)}`);
        }
        for (let i = 0; i < kids.length; i++) {
          for (let j = i + 1; j < kids.length; j++) {
            const [a, b] = [kids[i].r, kids[j].r];
            if (Math.min(a.right, b.right) - Math.max(a.left, b.left) > 0.5 && Math.min(a.bottom, b.bottom) - Math.max(a.top, b.top) > 0.5) {
              found.add(`overlap: ${name(kids[i].k)} and ${name(kids[j].k)} in ${name(el)}`);
            }
          }
        }
      }
      if (el.matches(BARS)) {
        for (const d of el.querySelectorAll("*")) {
          if (!shown(d) || d.closest(LEAVE) || /absolute|fixed/.test(getComputedStyle(d).position)) continue;
          const r = d.getBoundingClientRect();
          if (r.left < box.left + 16 - 0.5 || r.right > box.right - 16 + 0.5) found.add(`past the bar's margin: ${name(d)} in ${name(el)}`);
        }
      }
    }
    return [...found].sort();
  });
}

/**
 * Where the words (or the icon, or a dot before them) start in each bar, from the window's left: the first tab's,
 * the toolbar's first icon, the status bar's first words, and the line at the top of the page.
 */
function leftLine(page: Page): Promise<Record<string, number | null>> {
  return page.evaluate(() => {
    const start = (bar: Element | null): number | null => {
      if (!bar || !(bar as HTMLElement).checkVisibility()) return null;
      let left = Infinity;
      const walker = document.createTreeWalker(bar, NodeFilter.SHOW_ALL);
      for (let n = walker.nextNode(); n; n = walker.nextNode()) {
        if (n instanceof Element && !n.checkVisibility({ opacityProperty: true, visibilityProperty: true })) continue;
        if (n.nodeType === Node.TEXT_NODE && n.textContent!.trim() && n.parentElement!.checkVisibility()) {
          const range = document.createRange();
          range.selectNodeContents(n);
          const r = range.getBoundingClientRect();
          if (r.width) left = Math.min(left, r.left);
        } else if (n instanceof SVGSVGElement || (n instanceof HTMLElement && /tab-dot|agent-swatch/.test(n.className))) {
          const r = n.getBoundingClientRect();
          if (r.width) left = Math.min(left, r.left);
        }
      }
      return left === Infinity ? null : Math.round(left * 2) / 2;
    };
    const DOC = ".doc:not([hidden])";
    return {
      tabs: start(document.querySelector(".tabs .tab")),
      toolbar: start([...document.querySelectorAll("#toolbar > *")].find((g) => (g as HTMLElement).checkVisibility()) ?? null),
      status: start(document.querySelector(".status-bar")),
      "line at the top": start(document.querySelector(`${DOC} :is(.pass-notice, .agent-notice):not([hidden])`)),
    };
  });
}

// The plan's point 5: "Nothing jumps, overlaps or is cut off but by '…', at any window size from 560 pixels up,
// with any panel open, with many tabs." And F-11's left line and right margin.
test("from the narrowest window to a very wide one, with the side panel at its narrowest and widest, in light and dark, nothing overlaps or is cut off but by \"…\", and every bar's words start on one line", async () => {
  test.setTimeout(90_000);
  const run = await reviewed();
  const { page } = run;
  await pass(run);
  const handle = page.locator(`${DOC} .comments-handle`);
  /** The side panel at its narrowest or widest: its line moved to the end with the keyboard. */
  const panelAt = async (end: "narrowest" | "widest") => {
    await widen(page, 2400);
    await handle.focus();
    const [now, min, max] = await handle.evaluate((h) => ["aria-valuenow", "aria-valuemin", "aria-valuemax"].map((a) => Number(h.getAttribute(a))));
    const steps = Math.ceil(Math.abs((end === "widest" ? max : min) - now) / 16) + 1;
    for (let i = 0; i < steps; i++) await page.keyboard.press(end === "widest" ? "ArrowLeft" : "ArrowRight");
    await expect(handle).toHaveAttribute("aria-valuenow", String(end === "widest" ? max : min));
    await page.locator(`${DOC} .ProseMirror h2`).first().hover(); // the pointer off the line
  };
  for (const end of ["narrowest", "widest"] as const) {
    await panelAt(end);
    for (const scheme of ["light", "dark"] as const) {
      await page.emulateMedia({ colorScheme: scheme });
      for (const width of [560, 640, 720, 800, 900, 1024, 1280, 1440, 1680, 1920, 2400]) {
        await widen(page, width);
        const where = `${width} px, the panel at its ${end}, ${scheme}`;
        expect.soft(await crowded(page), where).toEqual([]);
        if (scheme === "light") expect.soft(await leftLine(page), where).toEqual({ tabs: 24, toolbar: 24, status: 24, "line at the top": 24 });
      }
    }
  }
  // History at its widest, in the widest window: its × keeps the margin too.
  await page.getByRole("button", { name: "History", exact: true }).click();
  await expect(page.locator(`${DOC} .history-panel`)).toBeVisible();
  expect(await crowded(page), "History, 2400 px").toEqual([]);
});

// Roadmap Batch 11, F-31: in History, what a version changed shows as small chips, one for each place; a chip
// moves to the next line whole rather than breaking in two ("Ana" on one line, "will bring the slides." on the next).
test("History's change chips wrap whole, at every width of the panel", async () => {
  const run = tidy.keep(await openText("# Offsite\n\nWe meet on Friday.\n\nMarta books the room.\n\nThe agenda is short.\n", { name: "Offsite.md" }));
  const { page } = run;
  await page.setViewportSize({ width: 1440, height: 900 });
  const { session } = await AgentSession.start(run.dataDir, "claude-code");
  try {
    await session.ok("take_document", { path: run.file });
    await session.ok("edit_document", {
      path: run.file,
      edits: [
        { find: "We meet on Friday.", replace: "We meet on Friday. Some sat longer." },
        { find: "Marta books the room.", replace: "Marta books the room. She'll start this week." },
        { find: "The agenda is short.", replace: "The agenda is short. Ana will bring the slides." },
      ],
    });
    await session.ok("finish_editing", { path: run.file });
  } finally {
    await session.stop();
  }
  await page.getByRole("button", { name: "History", exact: true }).click();
  const chips = page.locator(`${DOC} .history-panel .history-change-place`);
  await expect(chips).toHaveCount(3);
  const handle = page.locator(`${DOC} .side-handle:not(.comments-handle)`);
  await handle.focus();
  for (let width = 264; width <= 520; width += 16) {
    const broken = await chips.evaluateAll((all) => all.filter((c) => c.getClientRects().length > 1).map((c) => c.textContent));
    expect(broken, `the panel at ${await handle.getAttribute("aria-valuenow")} px`).toEqual([]);
    await page.keyboard.press("ArrowLeft");
  }
});

// Roadmap Batch 11, F-32: About's lines break evenly, never leaving "agents." or "licence." alone on a line.
test("About's lines break evenly, with no word left alone on a line", async () => {
  const run = tidy.keep(await openText("# A note\n"));
  const opened = run.app.waitForEvent("window");
  await clickMenu(run.app, "about");
  const about = await opened;
  await about.waitForSelector("body[data-ready]");
  const lines = await about.locator(".about-head p, .about-section > p, .about-part-note").evaluateAll((all) =>
    all
      .filter((p) => (p as HTMLElement).checkVisibility() && p.textContent!.trim())
      .map((p) => {
        // Each line's width, from the boxes of its words.
        const range = document.createRange();
        range.selectNodeContents(p);
        const widths = new Map<number, [number, number]>();
        for (const r of range.getClientRects()) {
          const top = Math.round(r.top);
          const [l, rt] = widths.get(top) ?? [Infinity, -Infinity];
          widths.set(top, [Math.min(l, r.left), Math.max(rt, r.right)]);
        }
        const each = [...widths.values()].map(([l, r]) => r - l);
        return { text: p.textContent!.trim().slice(0, 40), even: each.length < 2 || Math.min(...each) >= 0.5 * Math.max(...each) };
      }),
  );
  expect(lines.filter((l) => !l.even).map((l) => l.text)).toEqual([]);
  expect(lines.length).toBeGreaterThanOrEqual(3);
});
