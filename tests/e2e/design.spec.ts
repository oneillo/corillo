// The look holds together on screen: things line up, and every word shown is
// readable against what's behind it, in light and dark.
import { expect, test, type Page } from "@playwright/test";
import { copyFileSync, mkdirSync, unlinkSync } from "node:fs";
import { join } from "node:path";
import { AgentSession } from "./agent-session";
import { focusSeen, measure, pagePairs, palette, type Pair } from "./contrast";
import { clickMenu, openAlso, openText, selectText } from "./helpers";

const DOC = `# A shared help desk

Proposal for the [steering group](https://example.org). Comments welcome until Friday.

> Half my Saturday goes on working out who already answered.

| Item | Cost |
| --- | --- |
| Tool | \`$0\` |

- One address for every request
`;

async function addComment(page: Page, quote: string, text: string): Promise<void> {
  await selectText(page, quote);
  await page.getByRole("button", { name: "Comment", exact: true }).click();
  await page.getByRole("textbox", { name: "New comment" }).fill(text);
  await page.getByRole("button", { name: "Post" }).click();
  await expect(page.locator(".comment-card:not(.draft)", { hasText: text })).toBeVisible();
}

/** Where things sit, in pixels from the window's left and top. */
function layout(page: Page) {
  return page.evaluate(() => {
    const box = (sel: string) => document.querySelector(sel)?.getBoundingClientRect() ?? null;
    const shown = (sel: string) => [...document.querySelectorAll<HTMLElement>(sel)].filter((e) => e.offsetParent);
    const tools = shown("#toolbar > *").map((e) => e.getBoundingClientRect());
    // Where a heading row's contents start, inside any padding of its own.
    const headTop = (sel: string) => {
      const head = document.querySelector(sel);
      return head ? head.getBoundingClientRect().top + parseFloat(getComputedStyle(head).paddingTop) : null;
    };
    return {
      width: window.innerWidth,
      pageTop: box(".doc:not([hidden]) .page.editor")!.top,
      commentsHead: headTop(".doc:not([hidden]) .comments-panel:not([hidden]) .panel-head"),
      historyHead: headTop(".doc:not([hidden]) .history-panel:not([hidden]) .panel-head"),
      firstTab: document.querySelector<HTMLElement>(".tabs")?.offsetParent ? box(".tab")!.left : null,
      toolbarLeft: Math.min(...tools.map((r) => r.left)),
      toolbarRight: Math.max(...tools.map((r) => r.right)),
      status: box(".status-bar > :first-child")!.left,
    };
  });
}

test("the side panels start level with the top of the page, and every bar keeps 16 pixels from the window's edge", async () => {
  const run = await openText(DOC);
  const { page } = run;
  await addComment(page, "Comments welcome", "Which Friday?");
  for (const width of [1440, 1100, 760]) {
    await page.setViewportSize({ width, height: 800 });
    const at = await layout(page);
    expect(Math.abs(at.commentsHead! - at.pageTop), `comments at ${width}px`).toBeLessThanOrEqual(1);
    expect([at.toolbarLeft, at.status], `left edges at ${width}px`).toEqual([16, 16]);
    if (width === 1440) expect(at.width - at.toolbarRight).toBe(16);
  }
  // At 760 pixels History is in the toolbar's More menu; View > Show History does the same.
  await clickMenu(run.app, "view-history");
  await expect(page.locator(".doc:not([hidden]) .history-panel")).toBeVisible();
  const at = await layout(page);
  expect(Math.abs(at.historyHead! - at.pageTop), "history").toBeLessThanOrEqual(1);
  // One document has no tab bar; with two, the tabs keep 16 pixels from the edge too.
  expect(at.firstTab).toBeNull();
  await openAlso(run, "second.md", "Second.\n");
  await expect.poll(async () => (await layout(page)).firstTab).toBe(16);
  await run.app.close();
});

/** Every bit of text on screen whose contrast with its background is below WCAG AA (4.5 to 1). */
function unreadable(page: Page) {
  return page.evaluate(() => {
    const rgb = (c: string) => (c.match(/[\d.]+/g) ?? []).map(Number);
    const lum = ([r, g, b]: number[]) => {
      const f = (v: number) => ((v /= 255) <= 0.03928 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4);
      return 0.2126 * f(r) + 0.7152 * f(g) + 0.0722 * f(b);
    };
    const background = (el: Element | null): number[] => {
      for (; el; el = el.parentElement) {
        const c = rgb(getComputedStyle(el).backgroundColor);
        if (c.length === 3 || (c.length === 4 && c[3] > 0)) return c;
      }
      return [255, 255, 255];
    };
    const found: string[] = [];
    const walker = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT);
    for (let node = walker.nextNode(); node; node = walker.nextNode()) {
      const el = node.parentElement;
      if (!node.textContent?.trim() || !el) continue;
      // Leave out what can't be used right now, and the diagrams' own colours.
      if (el.closest(":disabled, [aria-disabled='true'], svg, .diagram-picture, [hidden]")) continue;
      if (!el.checkVisibility({ opacityProperty: true, visibilityProperty: true })) continue;
      const style = getComputedStyle(el);
      // An invisible copy of the Markdown text, there only to place marks behind the real text.
      if (rgb(style.color)[3] === 0) continue;
      const [a, b] = [lum(rgb(style.color)), lum(background(el))].sort((x, y) => y - x);
      const ratio = (a + 0.05) / (b + 0.05);
      if (ratio < 4.5) found.push(`${el.className || el.tagName} "${node.textContent.trim().slice(0, 30)}": ${ratio.toFixed(2)}`);
    }
    return found;
  });
}

// The standing contrast test (roadmap Batch 12, item 3), grown from "every word on screen is readable": every word,
// every control's edge, every "on" look and every small graphic, measured against what is drawn behind it (contrast.ts),
// in the main states and in both modes, set with View > Appearance; the keyboard's arrival in a field; and the palette's
// pairs for what no scene draws (under the pointer, while pressed, every agent's colour). Words 4.5 to 1 (3 to 1 when
// large); edges, "on" looks, graphics and focus 3 to 1 (WCAG 2.2). Left out, each with its reason: a comment card's
// own edge (quiet by design, Batch 9: the card in focus stands out; its buttons are held), lines between areas and
// shadings behind words (WCAG gives them no ratio; PAGE_PAIRS says why for each).
const PLAN = `# Volunteer help desk

Requests reach us through four inboxes and two group chats. Nobody can see what's already being handled. See the [steering group's notes](https://example.org).

![Requests by month](Plan%20images/requests.png)

## Where we are today

Last quarter we answered 1,840 requests. Most were simple, but the slow ones were slow for the same reasons.

> [!note] From the April count
> Half of them came on weekends.

| Month | Requests |
| --- | --- |
| April | 590 |
| May | 610 |

### Costs

- A shared inbox costs \`$0\`
- [ ] Ask Ana about the budget

## What we'd like

One shared help desk, tried for three months over the summer.
`;

/** A comment card's own edge: quiet on purpose (Batch 9), so the card in focus stands out. Its buttons are held. */
const quietCardEdge = (p: Pair) => p.kind === "edge" && /\.comment-card(?![\w-])/.test(p.what);

test("every word and edge meets its contrast in both modes", async () => {
  test.setTimeout(180_000);
  const run = await openText(PLAN, {
    name: "Plan.md",
    prepare: (folder) => {
      mkdirSync(join(folder, "Plan images"));
      copyFileSync(join(import.meta.dirname, "..", "pictures", "sample", "requests.png"), join(folder, "Plan images", "requests.png"));
    },
  });
  const { app, page } = run;
  try {
    await page.setViewportSize({ width: 1440, height: 900 });
    for (const [words, body] of [
      ["four inboxes and two group chats", "Can we say which inboxes?"],
      ["1,840 requests", "Is this the right number?"],
      ["Costs", "Should this be its own section?"],
    ]) await addComment(page, words, body);
    await openAlso(run, "Offsite.md", "# Team offsite\n\nTwo days in Ponce in October.\n");
    await page.locator('.tab[title$="/Plan.md"]').click();
    await page.emulateMedia({ colorScheme: null });

    const short: string[] = [];
    const kinds = new Set<string>();
    /** View > Appearance, and the window (or another, like Help) following it. */
    const mode = async (scheme: "light" | "dark", on: Page) => {
      await clickMenu(app, `appearance-${scheme}`);
      await expect.poll(() => on.evaluate(() => matchMedia("(prefers-color-scheme: dark)").matches)).toBe(scheme === "dark");
    };
    /** Everything on screen, measured in light and then dark. */
    const both = async (state: string, on: Page = page) => {
      for (const scheme of ["light", "dark"] as const) {
        await mode(scheme, on);
        await on.mouse.move(2, 2);
        await on.evaluate(() => new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r))));
        const { pairs } = await measure(on);
        for (const p of pairs) {
          kinds.add(p.kind);
          if (p.ratio < p.need && !quietCardEdge(p)) short.push(`${scheme}, ${state}: ${p.kind} ${p.part} ${p.what} "${p.words}" ${p.ink} on ${p.behind} ${p.ratio} (needs ${p.need})`);
        }
      }
    };
    /** The keyboard arriving in a field shows at 3 to 1 against how it looked before, in light and dark. */
    const arrives = async (what: string, selector: string, on: Page = page) => {
      for (const scheme of ["light", "dark"] as const) {
        await mode(scheme, on);
        // Help opens with the keyboard in its search box (Batch 12, G-17): measure from a box without it.
        await on.locator(selector).blur();
        const seen = await focusSeen(on, selector, () => on.locator(selector).click());
        if (seen.ratio < 3) short.push(`${scheme}, ${what}: the keyboard's arrival shows by ${seen.how} at ${seen.ratio} (needs 3)`);
        await on.locator(selector).blur();
      }
    };

    const doc = ".doc:not([hidden])";
    const panel = `${doc} .comments-panel`;
    const card = (words: string) => page.locator(`${panel} .comment-card`, { hasText: words }).locator(".comment-body").first();
    await card("Can we say which inboxes?").click();
    await both("two documents, with comments, a card in focus");
    const reply = `${panel} .comment-card.active .comment-input`;
    await arrives("the reply box", reply);

    // Claude's pass: editing (the coquí on the tab, the dot in the status bar), then done, with an option.
    const { session } = await AgentSession.start(run.dataDir, "claude-code");
    try {
      const taken = await session.ok("take_document", { path: run.file });
      const ids = new Map([...taken.matchAll(/\[([^\]]+)\] on "([^"]+)"/g)].map((m) => [m[2], m[1]]));
      const inboxes = ids.get("four inboxes and two group chats")!;
      await session.ok("edit_document", { path: run.file, edits: [{ find: "four inboxes and two group chats", replace: "four inboxes (help, info, volunteers and events) and two group chats" }], comment_ids: [inboxes] });
      await session.ok("edit_document", { path: run.file, edits: [{ find: "over the summer.", replace: "over the summer, from July." }] });
      await session.ok("reply_to_comment", { path: run.file, comment_id: inboxes, text: "Named all four.", options: [{ label: "Shorter", edits: [{ find: "(help, info, volunteers and events)", replace: "(four of them)" }] }] });
      await expect(page.locator(".status-bar .turn-dot")).toBeVisible();
      await both("Claude editing");
      const first = await session.call("finish_editing", { path: run.file });
      if (first.isError) await session.ok("finish_editing", { path: run.file });
    } finally {
      await session.stop();
    }
    await expect(page.locator(`${doc} .pass-notice`)).toBeVisible();
    await card("Named all four.").click();
    await expect(page.locator(`${panel} .comment-card.active .comment-change`)).toBeVisible();
    await both("Claude done, a card in focus with its change and an option");
    // A comment on a heading, in focus: the heading's ink on the deeper coral.
    await card("Should this be its own section?").click();
    await expect(page.locator(`${doc} .ProseMirror h3 .comment-range.active`)).toBeVisible();
    await both("a comment on a heading, in focus");
    // The @ list, an agent chosen with the arrows.
    await card("Named all four.").click();
    await page.locator(reply).fill("Thanks @");
    await expect(page.locator("#mention-list")).toBeVisible();
    await page.keyboard.press("ArrowDown");
    await expect(page.locator(".mention-option[aria-selected='true']")).toBeVisible();
    await both("the @ list, an agent chosen");
    await page.keyboard.press("Escape");
    await page.locator(reply).fill("");

    await page.getByRole("button", { name: "History", exact: true }).click();
    await page.locator(`${doc} .history-item`).nth(1).click();
    await expect(page.locator(`${doc} .version-banner`)).toBeVisible();
    await both("History, a version shown");
    await page.getByRole("button", { name: "Back to current" }).click();
    await page.getByRole("button", { name: "History", exact: true }).click();
    await clickMenu(app, "view-changes");
    await expect(page.locator(`${doc} .version-steps`)).toBeVisible();
    await both("Show changes");
    await clickMenu(app, "view-changes");
    await page.locator(`${doc} .ProseMirror h1`).click();
    await page.keyboard.press("Meta+Alt+F");
    await page.getByRole("textbox", { name: "Find" }).fill("help");
    await expect(page.locator('.find-bar input[name="replace"]')).toBeVisible();
    await both("Find and replace");
    await arrives("Find's Replace with", '.find-bar input[name="replace"]');
    await page.getByRole("textbox", { name: "Find" }).press("Escape");
    await clickMenu(app, "view-outline");
    await expect(page.locator(`${doc} .outline-pane`)).toBeVisible();
    await both("the outline");
    await clickMenu(app, "view-outline");
    // Read Aloud's bar, a sentence marked (roadmap Batch 14, item 4). Tests' speech is a recorder: nothing is heard.
    await page.locator(`${doc} .ProseMirror h1`).click();
    await clickMenu(app, "read-aloud");
    await expect(page.locator(`${doc} .read-aloud-bar`)).toBeVisible();
    await both("Read Aloud's bar");
    await page.locator(`${doc} .read-aloud-stop`).click();
    await expect(page.locator(`${doc} .read-aloud-bar`)).toHaveCount(0);
    await clickMenu(app, "view-markdown");
    await expect(page.locator(`${doc} .source`)).toBeVisible();
    await both("the Markdown view");
    await clickMenu(app, "view-formatted");
    // The narrowest window: More open, and Insert inside it.
    await page.setViewportSize({ width: 560, height: 900 });
    await page.getByRole("button", { name: "More", exact: true }).click();
    await page.getByRole("menu", { name: "More" }).locator('button[aria-label="Insert"]').click();
    await expect(page.getByRole("menu", { name: "Insert" })).toBeVisible();
    await both("the narrowest window, More and Insert open");
    await page.keyboard.press("Escape");
    await page.keyboard.press("Escape");
    await page.setViewportSize({ width: 1440, height: 900 });
    await clickMenu(app, "export-settings");
    await expect(page.getByRole("dialog", { name: "Export settings" })).toBeVisible();
    await both("a dialog (Export settings)");
    await page.keyboard.press("Escape");

    // The palette, pair by pair, in each mode: what no scene draws.
    for (const scheme of ["light", "dark"] as const) {
      await mode(scheme, page);
      for (const row of pagePairs(await palette(page))) {
        if (row.ratio < row.need && !row.why) short.push(`${scheme}, the palette: ${row.what}, ${row.inkName} ${row.ink} on ${row.onName} ${row.on} ${row.ratio} (needs ${row.need})`);
      }
    }

    await clickMenu(app, "close-tab");
    await clickMenu(app, "close-tab");
    await expect(page.locator("#recent .recent-card")).toHaveCount(2);
    await both("the start screen");
    const [help] = await Promise.all([app.waitForEvent("window"), clickMenu(app, "corillo-help")]);
    await help.waitForSelector(".help-page:not([hidden])");
    await help.emulateMedia({ colorScheme: null });
    await help.evaluate(() => document.fonts.ready.then(() => undefined));
    await both("Help", help);
    await arrives("Help's search box", "#help-search", help);
    await help.close();

    expect(short, "words, edges, \"on\" looks, graphics and focus under their contrast").toEqual([]);
    expect([...kinds].sort(), "what was measured").toEqual(["edge", "graphic", "state", "word"]);
  } finally {
    await app.close();
  }
});

/** WCAG 2's contrast between two colours as the window draws them ("rgb(…)" or "rgba(…)", opaque). */
function contrast(one: string, other: string): number {
  const lum = (c: string) => {
    const [r, g, b] = (c.match(/[\d.]+/g) ?? []).map(Number);
    const f = (v: number) => ((v /= 255) <= 0.03928 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4);
    return 0.2126 * f(r) + 0.7152 * f(g) + 0.0722 * f(b);
  };
  const [a, b] = [lum(one), lum(other)].sort((x, y) => y - x);
  return Math.round(((a + 0.05) / (b + 0.05)) * 100) / 100;
}

/**
 * The colours drawn for what a selector finds first on screen: its fill (or, with none, what shows through it),
 * its edge (its left border, or else the colour of an edge drawn with box-shadow), the colour of its words, and
 * what's behind it (its parent's fill, or what shows through that).
 */
function drawn(page: Page, selector: string): Promise<{ fill: string; edge: string | null; ink: string; behind: string }> {
  return page.evaluate((sel) => {
    const el = [...document.querySelectorAll<HTMLElement>(sel)].find((e) => e.checkVisibility());
    if (!el) throw new Error(`Nothing on screen for ${sel}`);
    const solid = (c: string) => !/rgba\(.*, 0\)$/.test(c) && c !== "transparent";
    const fillOf = (from: Element | null): string => {
      for (let e = from; e; e = e.parentElement) if (solid(getComputedStyle(e).backgroundColor)) return getComputedStyle(e).backgroundColor;
      return "rgb(255, 255, 255)";
    };
    const style = getComputedStyle(el);
    const border = parseFloat(style.borderLeftWidth) > 0 && solid(style.borderLeftColor) ? style.borderLeftColor : null;
    const shadow = /^(rgba?\([^)]*\))/.exec(style.boxShadow)?.[1] ?? null;
    return { fill: fillOf(el), edge: border ?? shadow, ink: style.color, behind: fillOf(el.parentElement) };
  }, selector);
}

// Roadmap Batch 11, F-3 (Orlando, 2026-11-13: "dark mode just all kind of blending for me"). The planning
// session's call, his to strike: an edge on everything you click, calmer lines between areas, a fill of
// their own for buttons and for what floats, the side panels a step darker than the page.
test("in dark, every surface stands apart from what's around it, what you click has an edge at 3 to 1, and the page's marks and pictures can be told apart", async () => {
  const run = await openText(`${DOC}\n![Requests](Plan%20images/requests.png)\n\nThe numbers above are from June.\n`, {
    prepare: (folder) => {
      mkdirSync(join(folder, "Plan images"));
      copyFileSync(join(import.meta.dirname, "..", "pictures", "sample", "requests.png"), join(folder, "Plan images", "requests.png"));
    },
  });
  const { app, page } = run;
  await page.setViewportSize({ width: 1440, height: 900 });
  await addComment(page, "Comments welcome", "Which Friday?");
  await addComment(page, "Proposal", "Settled, thanks.");
  const { session } = await AgentSession.start(run.dataDir, "claude-code");
  try {
    const listed = await session.ok("take_document", { path: run.file });
    const id = /\[([^\]]+)\] on "Comments welcome"/.exec(listed)![1];
    await session.ok("edit_document", { path: run.file, edits: [{ find: "Friday", replace: "Friday 14 May" }], comment_ids: [id] });
    await session.ok("reply_to_comment", { path: run.file, comment_id: id, text: "Added the date." });
    await session.call("finish_editing", { path: run.file });
    await session.ok("finish_editing", { path: run.file });
  } finally {
    await session.stop();
  }
  const panel = ".doc:not([hidden]) .comments-panel";
  const page_ = ".doc:not([hidden]) .canvas";
  await page.emulateMedia({ colorScheme: "dark" });
  const at = async (selector: string) => drawn(page, selector);
  const apart = (what: string, one: string, other: string, least: number) => expect(contrast(one, other), what).toBeGreaterThanOrEqual(least);

  // Surfaces: the side panel a step darker than the page, cards and buttons a step lighter than what they sit on.
  const side = await at(panel);
  apart("the Comments panel and the page", side.fill, (await at(page_)).fill, 1.15);
  const card = await at(`${panel} .comment-card:not(.active)`);
  apart("a card and the panel", card.fill, side.fill, 1.15);
  // (A card's own edge stays quiet, so the card in focus stands out: comment-cards.spec.ts, Batch 9.)
  const tick = await at(`${panel} .comment-card:not(.active) .comment-close`);
  apart("a card's Resolve tick's edge", tick.edge!, card.fill, 3);
  const button = await at(`${panel} .comments-new`);
  apart("a button and the panel", button.fill, side.fill, 1.15);
  apart("a button's edge, on the panel", button.edge!, side.fill, 3);
  apart("a button's edge, on its fill", button.edge!, button.fill, 3);
  const style = await at("#toolbar .style-select");
  apart("the style box and the toolbar", style.fill, style.behind, 1.15);
  apart("the style box's edge", style.edge!, style.behind, 3);
  // Lines between areas: calmer than a control's edge, still plain to see.
  apart("the toolbar's foot", (await at("#toolbar")).edge!, (await at("#toolbar")).fill, 1.5);
  apart("the panel's edge", side.edge!, side.fill, 1.5);
  // The "Claude changed" box in the card in focus has an edge (it was 1.01 against the card).
  await page.locator(`${panel} .comment-card`, { hasText: "Added the date." }).locator(".comment-body").first().click();
  const change = await at(`${panel} .comment-card.active .comment-change`);
  apart("the change box's edge, on the box", change.edge!, change.fill, 3);
  apart("the change box's edge, on the card", change.edge!, change.behind, 3);
  // The page's marks: commented words, the one in focus apart from the others, and the words Show changes adds.
  const shaded = await at(".doc:not([hidden]) .ProseMirror .comment-range:not(.active)");
  const focused = await at(".doc:not([hidden]) .ProseMirror .comment-range.active");
  const pageFill = (await at(page_)).fill;
  apart("commented words on the page", shaded.fill, pageFill, 1.3);
  apart("the comment in focus, against the others", focused.fill, shaded.fill, 1.2);
  for (const mark of [shaded, focused]) apart("words on a comment's shading", mark.ink, mark.fill, 4.5);
  // Pictures on the page are softened a little; in light they're as they are.
  const filter = () => page.locator(".doc:not([hidden]) .ProseMirror img").first().evaluate((img) => getComputedStyle(img).filter);
  expect(await filter()).toMatch(/^brightness\(0\.9\)$/);
  await page.emulateMedia({ colorScheme: "light" });
  expect(await filter()).toBe("none");
  await page.emulateMedia({ colorScheme: "dark" });
  await clickMenu(app, "view-changes");
  await expect(page.locator(".doc:not([hidden]) .version-view ins.diff-added").first()).toBeVisible();
  const added = await at(".doc:not([hidden]) .version-view ins.diff-added");
  apart("added words on the page", added.fill, pageFill, 1.3);
  apart("words added", added.ink, added.fill, 4.5);
  await clickMenu(app, "view-changes");
  // What floats: a menu, a notice in the corner, a dialog; a field's edge.
  await page.locator(`${panel} .comment-card`, { hasText: "Which Friday?" }).getByRole("button", { name: "More actions" }).click();
  const menu = await at(".menu:not([hidden])");
  apart("a menu, over the page", menu.fill, pageFill, 1.1);
  apart("a menu's edge", menu.edge!, pageFill, 1.5);
  await page.keyboard.press("Escape");
  await clickMenu(app, "copy-email");
  const notice = await at(".doc:not([hidden]) .export-notice");
  apart("a notice, over the page", notice.fill, pageFill, 1.1);
  await clickMenu(app, "export-settings");
  apart("a dialog, over the page", (await at("dialog.sheet[open]")).fill, pageFill, 1.1);
  await page.keyboard.press("Escape");
  await page.keyboard.press("Meta+f");
  const field = await at(".find-bar .find-field");
  apart("a field's edge", field.edge!, field.behind, 3);
  await page.keyboard.press("Escape");
  // The start screen: a step darker than its cards, which are edged like what you click.
  await clickMenu(app, "close-tab");
  await expect(page.locator("#recent .recent-card").first()).toBeVisible();
  const recent = await at("#recent .recent-card");
  apart("a recent document's card and the start screen", recent.fill, (await at("#empty")).fill, 1.15);
  apart("a recent document's card's edge", recent.edge!, (await at("#empty")).fill, 3);
  await run.app.close();
});

// Roadmap Batch 11, F-5: a document back from Claude shows on its tab as plainly as one Claude is working on, and
// a card's "new" dot sits inside the card. Each keeps the agent's colour, edged in a deeper tone of it (in dark, a
// lighter one), at 3 to 1 against what it sits on.
test("a document back from Claude shows plainly on its tab, and a card's new dot inside the card, in the agent's colour, in light and dark", async () => {
  const run = await openText(DOC, { name: "plan.md" });
  const { page } = run;
  await page.setViewportSize({ width: 1440, height: 900 });
  await addComment(page, "Comments welcome", "Which Friday?");
  await openAlso(run, "notes.md", "# Notes\n\nA short note.\n");
  const { session } = await AgentSession.start(run.dataDir, "claude-code");
  try {
    const listed = await session.ok("take_document", { path: run.file });
    const id = /\[([^\]]+)\] on "Comments welcome"/.exec(listed)![1];
    await session.ok("reply_to_comment", { path: run.file, comment_id: id, text: "The 14th." });
    await session.ok("finish_editing", { path: run.file });
  } finally {
    await session.stop();
  }
  const tabDot = '.tab[title$="/plan.md"] .tab-dot';
  await expect(page.locator(tabDot)).toHaveAttribute("data-turn", "back");
  const look = (selector: string) =>
    page.locator(selector).evaluate((dot) => {
      const style = getComputedStyle(dot);
      const box = dot.getBoundingClientRect();
      return { fill: style.backgroundColor, edge: style.borderLeftColor, edgeWidth: parseFloat(style.borderLeftWidth), size: box.width, box };
    });
  const tabEdge = new Map<string, string>();
  for (const scheme of ["light", "dark"] as const) {
    await page.emulateMedia({ colorScheme: scheme });
    const dot = await look(tabDot);
    tabEdge.set(scheme, dot.edge);
    const bar = await drawn(page, ".tabs");
    expect(dot.size, `${scheme}: the tab's dot`).toBeGreaterThanOrEqual(10);
    expect(dot.edgeWidth, `${scheme}: the tab's dot`).toBeGreaterThanOrEqual(2);
    expect(contrast(dot.edge, bar.fill), `${scheme}: the tab's dot, on the tab bar`).toBeGreaterThanOrEqual(3);
    expect(contrast(dot.edge, (await drawn(page, ".tab[aria-selected='true']")).fill), `${scheme}: the dot, on the tab in front`).toBeGreaterThanOrEqual(3);
  }
  await page.locator('.tab[title$="/plan.md"]').click();
  const cardDot = ".doc:not([hidden]) .comment-card .card-new:not([hidden])";
  await expect(page.locator(cardDot)).toBeVisible();
  for (const scheme of ["light", "dark"] as const) {
    await page.emulateMedia({ colorScheme: scheme });
    const dot = await look(cardDot);
    // In the agent's colour, its initial's on the card.
    const claude = await page.locator(".doc:not([hidden]) .comment-avatar:not(.person)").first().evaluate((a) => getComputedStyle(a).backgroundColor);
    expect(dot.fill, `${scheme}: the card's dot is in Claude's colour`).toBe(claude);
    // The card and its dot measured together: the cards may still be settling after the tab came to the front.
    const card = await page.locator(".doc:not([hidden]) .comment-card").first().evaluate((c) => ({
      fill: getComputedStyle(c).backgroundColor,
      box: c.getBoundingClientRect().toJSON() as DOMRect,
      dot: c.querySelector(".card-new:not([hidden])")!.getBoundingClientRect().toJSON() as DOMRect,
    }));
    expect(dot.edgeWidth, `${scheme}: the card's dot`).toBeGreaterThanOrEqual(2);
    expect(dot.edge, `${scheme}: the card's dot is edged as the tab's, in Claude's deeper tone`).toBe(tabEdge.get(scheme));
    expect(contrast(dot.edge, card.fill), `${scheme}: the card's dot, on the card`).toBeGreaterThanOrEqual(3);
    const inside = card.dot.left >= card.box.left + 1 && card.dot.right <= card.box.right - 1 && card.dot.top >= card.box.top + 1 && card.dot.bottom <= card.box.bottom - 1;
    expect(inside, `${scheme}: the card's dot is inside the card`).toBe(true);
  }
  await run.app.close();
});

// Orlando, 2026-11-09: one row at any width, with More for what doesn't fit.
test("in the narrowest window, the toolbar, More and the menus inside it are readable, in light and dark", async () => {
  const run = await openText(DOC);
  const { page } = run;
  await addComment(page, "Comments welcome", "Which Friday?");
  await page.setViewportSize({ width: 560, height: 800 });
  for (const scheme of ["light", "dark"] as const) {
    await page.emulateMedia({ colorScheme: scheme });
    await selectText(page, "steering group"); // a link: Link is ticked
    expect(await unreadable(page), `${scheme}, the toolbar`).toEqual([]);
    await page.getByRole("button", { name: "More", exact: true }).click();
    const more = page.getByRole("menu", { name: "More" });
    await expect(more).toBeVisible();
    await expect(more.locator('button[aria-label="Link"]')).toHaveAttribute("aria-checked", "true");
    await more.locator('button[aria-label="Strikethrough"]').hover(); // the item under the pointer too
    expect(await unreadable(page), `${scheme}, More`).toEqual([]);
    await more.locator('button[aria-label="Insert"]').click();
    await expect(page.getByRole("menu", { name: "Insert" })).toBeVisible();
    expect(await unreadable(page), `${scheme}, More's Insert`).toEqual([]);
    await page.keyboard.press("Escape");
    await expect(more).toBeHidden();
  }
  await run.app.close();
});

// Orlando, 2026-11-09: no Review mode; a status line when an agent is done,
// Resolve in words on every card, and the resolved count with Show and Hide.
test("the line saying an agent is done, Resolve and Done on the cards, and the resolved count are readable, in light and dark", async () => {
  const run = await openText(DOC);
  const { page } = run;
  await page.setViewportSize({ width: 1440, height: 800 });
  await addComment(page, "Comments welcome", "Which Friday?");
  await addComment(page, "Proposal", "Settled, thanks.");
  const { session } = await AgentSession.start(run.dataDir, "claude-code");
  try {
    const listed = await session.ok("take_document", { path: run.file });
    const id = /\[([^\]]+)\] on "Comments welcome"/.exec(listed)![1];
    await session.ok("edit_document", { path: run.file, edits: [{ find: "Friday", replace: "Friday 14 May" }], comment_ids: [id] });
    await session.ok("edit_document", { path: run.file, edits: [{ find: "One address", replace: "A single address" }] });
    await session.ok("reply_to_comment", { path: run.file, comment_id: id, text: "Added the date." });
    await session.call("finish_editing", { path: run.file });
    await session.ok("finish_editing", { path: run.file });
  } finally {
    await session.stop();
  }
  const panel = page.locator(".doc:not([hidden]) .comments-panel");
  await expect(page.locator(".doc:not([hidden]) .pass-notice")).toBeVisible();
  // The line, while it's up (resolving a card below clears it), with "Show changes" for the edit no comment asked for,
  // and "With you" in the status bar, with what's new to read (the answered comment; roadmap Batch 1, item 2, and Batch 9, item 5).
  for (const scheme of ["light", "dark"] as const) {
    await page.emulateMedia({ colorScheme: scheme });
    await page.locator(".doc:not([hidden]) .ProseMirror h1").click();
    await expect(page.locator(".doc:not([hidden]) .pass-notice")).toBeVisible();
    await expect(page.locator(".doc:not([hidden]) .pass-notice-see")).toBeVisible();
    await expect(page.locator("#turn-status")).toHaveText("With you · 1 to read");
    expect(await unreadable(page), `${scheme}, the line when the agent is done`).toEqual([]);
  }
  await panel.locator(".comment-card", { hasText: "Settled, thanks." }).getByRole("button", { name: "Resolve", exact: true }).click();
  await expect(panel.locator(".comments-resolved-count")).toHaveText("1 resolved");
  for (const scheme of ["light", "dark"] as const) {
    await page.emulateMedia({ colorScheme: scheme });
    // Nothing in focus: every card's Resolve, the count and Show (the line went once a card was resolved).
    await page.locator(".doc:not([hidden]) .ProseMirror h1").click();
    expect(await unreadable(page), `${scheme}, the cards`).toEqual([]);
    // Resolved cards shown: quieter, still readable.
    await panel.locator(".comments-show-resolved").click();
    await expect(panel.locator(".comment-card.resolved")).toBeVisible();
    expect(await unreadable(page), `${scheme}, resolved shown`).toEqual([]);
    await panel.locator(".comment-card.resolved .comment-body").click();
    expect(await unreadable(page), `${scheme}, a resolved card in focus`).toEqual([]);
    await panel.locator(".comments-show-resolved").click();
  }
  await run.app.close();
});

// Orlando, 2026-11-09: Edit and Delete in a "⋯" menu, and the card in focus plain to see.
test("the card in focus, with its quote lit in its words' coral, and the \"⋯\" menu are readable, in light and dark, wide and narrow", async () => {
  const run = await openText(DOC);
  const { page } = run;
  await addComment(page, "Comments welcome", "Which Friday?");
  await addComment(page, "steering group", "Who's on it?");
  const c = page.locator(".comment-card", { hasText: "Which Friday?" });
  const menu = page.getByRole("menu", { name: "More actions" });
  for (const width of [1440, 900]) {
    await page.setViewportSize({ width, height: 800 });
    for (const scheme of ["light", "dark"] as const) {
      await page.emulateMedia({ colorScheme: scheme });
      await c.locator(".comment-body").click();
      await c.getByRole("button", { name: "More actions" }).click();
      await expect(menu).toBeVisible();
      await menu.getByRole("menuitem", { name: "Delete" }).hover(); // the item under the pointer too
      expect(await unreadable(page), `${scheme}, ${width}px`).toEqual([]);
      await page.keyboard.press("Escape");
      await expect(menu).toBeHidden();
    }
  }
  await run.app.close();
});

// Orlando, 2026-11-09: whose turn it is, without extra clicks.
test("whose turn it is is readable, in light and dark, wide and narrow: the editing line, and the status bar's turn in the agent's colour", async () => {
  const run = await openText(DOC);
  const { page } = run;
  await addComment(page, "Comments welcome", "Which Friday?");
  const { session } = await AgentSession.start(run.dataDir, "claude-code");
  try {
    await session.ok("take_document", { path: run.file });
    await expect(page.locator(".doc:not([hidden]) .agent-notice")).toBeVisible();
    await expect(page.locator("#turn-status")).toHaveText("Claude is editing");
    for (const width of [1280, 560]) {
      await page.setViewportSize({ width, height: 800 });
      for (const scheme of ["light", "dark"] as const) {
        await page.emulateMedia({ colorScheme: scheme });
        expect(await unreadable(page), `${scheme}, ${width}px, while Claude edits`).toEqual([]);
      }
    }
  } finally {
    await session.stop();
  }
  await run.app.close();
});

// Orlando, 2026-11-09: @ to tag an agent in a comment.
test("an @ tag is readable in every agent's colour, in light and dark: in a posted comment, in the box while typing, and in the list", async () => {
  const run = await openText(DOC);
  const { page } = run;
  const colours = ["peach", "sky", "mint", "lilac", "ochre", "rose"];
  const names = ["Claude", "Codex", "Cursor", "Gemini", "Writer", "Copilot"];
  const docId = await page.locator(".doc:not([hidden])").getAttribute("data-doc-id");
  const agents = names.map((name, i) => ({ name, isDefault: i === 0, editing: false, colour: colours[i] }));
  await run.app.evaluate(({ BrowserWindow }, [id, list]) => BrowserWindow.getAllWindows()[0].webContents.send("agents:changed", id, list), [
    docId,
    agents,
  ] as const);
  // And one that isn't connected, shown quieter in the list: still readable.
  await run.app.evaluate(({ BrowserWindow }) =>
    BrowserWindow.getAllWindows()[0].webContents.send("agents:known", [{ name: "Reviewer", connected: false }]),
  );
  // A posted comment for each agent, with its tag.
  for (const name of names) await addComment(page, "Comments welcome", `@${name} have a look.`);
  await expect(page.locator(".comment-card .comment-body .mention-tag")).toHaveCount(6);
  // The box's own words over a tag's colour, as it's typed.
  const inBox = () =>
    page.evaluate(() => {
      const rgb = (c: string) => (c.match(/[\d.]+/g) ?? []).map(Number);
      const lum = ([r, g, b]: number[]) => {
        const f = (v: number) => ((v /= 255) <= 0.03928 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4);
        return 0.2126 * f(r) + 0.7152 * f(g) + 0.0722 * f(b);
      };
      const box = document.querySelector<HTMLTextAreaElement>(".comment-card.draft textarea")!;
      const tag = document.querySelector<HTMLElement>(".comment-card.draft .mention-layer .mention-tag")!;
      const [a, b] = [lum(rgb(getComputedStyle(box).color)), lum(rgb(getComputedStyle(tag).backgroundColor))].sort((x, y) => y - x);
      return (a + 0.05) / (b + 0.05);
    });
  await selectText(page, "Proposal");
  await page.getByRole("button", { name: "Comment", exact: true }).click();
  const box = page.getByRole("textbox", { name: "New comment" });
  for (const scheme of ["light", "dark"] as const) {
    await page.emulateMedia({ colorScheme: scheme });
    for (const name of names) {
      await box.fill(`@${name} shorter, please`);
      await expect(page.locator(".comment-card.draft .mention-layer .mention-tag")).toHaveText(`@${name}`);
      expect(await inBox(), `${scheme}, ${name} in the box`).toBeGreaterThanOrEqual(4.5);
    }
    await box.fill("Ask ");
    await box.press("End");
    await page.keyboard.type("@");
    await expect(page.locator("#mention-list")).toBeVisible();
    await expect(page.locator("#mention-list .mention-option:not(.connected)")).toHaveText(["RReviewer"]);
    expect(await unreadable(page), `${scheme}, tags in comments and the list`).toEqual([]);
    await page.keyboard.press("Escape");
  }
  await page.getByRole("button", { name: "Cancel" }).click();
  await run.app.close();
});

test("Obsidian's marks kept on the page while editing ([!note], [[ ]], ==) are readable in every callout colour, in light and dark", async () => {
  const callouts = ["note", "tip", "warning", "danger", "example", "quote"]
    .map((type) => `> [!${type}] A ${type}\n> See [[Q2 review]] and ==the figures==.\n`)
    .join("\n");
  const run = await openText(`# Notes\n\n${callouts}`, { name: "notes.md", prepare: (folder) => mkdirSync(join(folder, ".obsidian")) });
  const { page } = run;
  await expect(page.locator(".doc:not([hidden]) .ob-callout-marker")).toHaveCount(6);
  await page.setViewportSize({ width: 1100, height: 1400 });
  for (const scheme of ["light", "dark"] as const) {
    await page.emulateMedia({ colorScheme: scheme });
    expect(await unreadable(page), scheme).toEqual([]);
  }
  await run.app.close();
});

/** Contrast of the Markdown text's words with each comment mark drawn behind them. */
function textOverMarks(page: Page) {
  return page.evaluate(() => {
    const rgb = (c: string) => (c.match(/[\d.]+/g) ?? []).map(Number);
    const lum = ([r, g, b]: number[]) => {
      const f = (v: number) => ((v /= 255) <= 0.03928 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4);
      return 0.2126 * f(r) + 0.7152 * f(g) + 0.0722 * f(b);
    };
    const words = lum(rgb(getComputedStyle(document.querySelector(".doc:not([hidden]) textarea.source")!).color));
    return [...document.querySelectorAll(".doc:not([hidden]) .source-marks mark")].map((m) => {
      const [a, b] = [words, lum(rgb(getComputedStyle(m).backgroundColor))].sort((x, y) => y - x);
      return { kind: m.className, ratio: (a + 0.05) / (b + 0.05) };
    });
  });
}

// Orlando, 2026-11-09: comments in the Markdown view, marked in its text and its preview.
test("in the Markdown view, the comments' marks keep every word readable, in the text and the preview, in light and dark", async () => {
  const run = await openText(DOC);
  const { page } = run;
  await addComment(page, "Comments welcome", "Which Friday?");
  await addComment(page, "steering group", "Who's on it?");
  await page.setViewportSize({ width: 1440, height: 800 });
  await page.getByRole("button", { name: "Markdown", exact: true }).click();
  // One comment in focus, one not.
  await page.locator(".comment-card", { hasText: "Which Friday?" }).locator(".comment-body").click();
  await expect(page.locator(".doc:not([hidden]) .source-marks mark.active")).toHaveText(["Comments welcome"]);
  await expect(page.locator(".doc:not([hidden]) .source-marks mark.comment")).toHaveText(["steering group"]);
  for (const scheme of ["light", "dark"] as const) {
    await page.emulateMedia({ colorScheme: scheme });
    const marks = await textOverMarks(page);
    expect(marks.map((m) => m.kind).sort(), scheme).toEqual(["active", "comment"]);
    for (const m of marks) expect(m.ratio, `${scheme}, ${m.kind}`).toBeGreaterThanOrEqual(4.5);
    expect(await unreadable(page), `${scheme}, the preview and the panel`).toEqual([]);
  }
  await run.app.close();
});

test("the Markdown text keeps the page's colour while Find is open, with comments' marks and without, in light and dark", async () => {
  const run = await openText(DOC);
  const { page } = run;
  // The colour behind the Markdown text: the text box's own, or that of the first layer behind it that has one.
  const behindText = () =>
    page.evaluate(() => {
      const shown = (sel: string) => [...document.querySelectorAll<HTMLElement>(sel)].filter((e) => !e.hidden);
      const layers = [...shown(".doc:not([hidden]) textarea.source"), ...shown(".doc:not([hidden]) .find-marks"), ...shown(".doc:not([hidden]) .source-marks")];
      for (const layer of layers) {
        const colour = getComputedStyle(layer).backgroundColor;
        if (colour !== "rgba(0, 0, 0, 0)" && colour !== "transparent") return colour;
      }
      return "none";
    });
  for (const withComment of [false, true]) {
    if (withComment) {
      await page.getByRole("button", { name: "Formatted", exact: true }).click();
      await addComment(page, "Comments welcome", "Which Friday?");
    }
    await page.getByRole("button", { name: "Markdown", exact: true }).click();
    for (const scheme of ["light", "dark"] as const) {
      await page.emulateMedia({ colorScheme: scheme });
      const before = await behindText();
      expect(before).not.toBe("none");
      await page.keyboard.press("Meta+f");
      await page.getByRole("textbox", { name: "Find" }).fill("help");
      await expect(page.locator(".doc:not([hidden]) .find-marks mark").first()).toBeVisible();
      expect(await behindText(), scheme).toBe(before);
      // The comment's mark still shows, through Find's layer.
      if (withComment) {
        await expect(page.locator(".doc:not([hidden]) .source-marks mark")).toBeVisible();
        await expect(page.locator(".doc:not([hidden]) .find-marks")).toHaveCSS("background-color", "rgba(0, 0, 0, 0)");
      }
      await page.getByRole("textbox", { name: "Find" }).press("Escape");
    }
  }
  await run.app.close();
});

test("the start screen's cards are readable, in light and dark, previews and a missing document's card included", async () => {
  const run = await openText(DOC);
  const { page } = run;
  const gone = await openAlso(run, "gone.md", "# Gone\n");
  await clickMenu(run.app, "close-tab");
  await clickMenu(run.app, "close-tab");
  await expect(page.locator("#empty")).toBeVisible();
  unlinkSync(gone); // deleted: a renamed one is found where it went (roadmap Batch 4, item 3)
  await run.app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].webContents.send("app:recent-changed"));
  await expect(page.locator("#recent .recent-gone")).toHaveText("Can't be found");
  await expect(page.locator("#recent .recent-page h1")).toHaveText("A shared help desk");
  await page.setViewportSize({ width: 1100, height: 800 });
  for (const scheme of ["light", "dark"] as const) {
    await page.emulateMedia({ colorScheme: scheme });
    await page.locator("#recent .recent-card").first().hover();
    expect(await unreadable(page), scheme).toEqual([]);
  }
  await run.app.close();
});

test("the page is set in Literata, bundled with Corillo, in roman and italic", async () => {
  const run = await openText("# A plan\n\nPlain words and *leaning words* here.\n");
  const { page } = run;
  await expect(page.locator(".doc:not([hidden]) .page.editor em")).toHaveText("leaning words");
  const fonts = await page.evaluate(async () => {
    await document.fonts.ready;
    const p = document.querySelector(".doc:not([hidden]) .page.editor p")!;
    // Which faces the page actually drew with: Chromium loads a face only once text uses it.
    const loaded = [...document.fonts].filter((f) => f.family.replace(/"/g, "") === "Literata" && f.status === "loaded").map((f) => f.style).sort();
    return { family: getComputedStyle(p).fontFamily.split(",")[0].replace(/"/g, "").trim(), loaded };
  });
  expect(fonts).toEqual({ family: "Literata", loaded: ["italic", "normal"] });
  await run.app.close();
});

test("a picture that can't be found keeps its Find it… button inside its box, in the narrowest window too", async () => {
  const run = await openText("# Launch\n\n![Chart](Launch%20images/chart.png)\n\nThe numbers above are from June.\n");
  const { page } = run;
  const box = page.locator(".ProseMirror .picture.missing");
  await expect(box).toBeVisible();
  // Scroll bars that take room, as with a mouse connected.
  await page.addStyleTag({ content: "::-webkit-scrollbar { width: 15px; height: 15px; } ::-webkit-scrollbar-thumb { background: #888; }" });
  for (const width of [560, 640, 760, 1100]) {
    await page.setViewportSize({ width, height: 800 });
    const sticks = await box.evaluate((el) => {
      const outer = el.getBoundingClientRect();
      const button = el.querySelector("button")!.getBoundingClientRect();
      return button.right > outer.right - 1 || button.left < outer.left;
    });
    expect(sticks, `${width} px`).toBe(false);
  }
  await run.app.close();
});

test("with less motion asked for in the Mac's settings, nothing on screen fades", async () => {
  const run = await openText("Flow:\n\n```mermaid\ngraph LR\n  Ask --> Draft\n```\n");
  const { page } = run;
  await expect(page.locator(".ProseMirror .diagram-toggle")).toHaveCount(1);
  const durations = () =>
    page.evaluate(() =>
      [".pass-notice", ".ProseMirror .diagram-toggle"].map((sel) => {
        const el = document.querySelector(sel)!;
        const all = [getComputedStyle(el).transitionDuration];
        el.classList.add("spent");
        all.push(getComputedStyle(el).transitionDuration);
        el.classList.remove("spent");
        return all.join(",");
      }),
    );
  expect((await durations()).every((d) => /[1-9]/.test(d))).toBe(true); // they fade as usual
  await page.emulateMedia({ reducedMotion: "reduce" });
  expect((await durations()).join(",").replace(/0s/g, "").replace(/,/g, "")).toBe("");
  await run.app.close();
});
