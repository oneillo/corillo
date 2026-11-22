// The toolbar keeps to one row at any width (Orlando, 2026-11-09). Its items
// sit in groups of like with like; as the window narrows, the named buttons
// show just their icons, then the least used move, in a set order, into More
// right after the writing buttons, where each does exactly what its button does.
import { expect, test, type Locator, type Page } from "@playwright/test";
import { AgentSession } from "./agent-session";
import { EDITOR, cursorInCell, openText, selectText, settle, type Running } from "./helpers";
import { tidyRuns } from "./tidy";

// Tests added on 2026-11-09 night remove their folders when they're done.
const tidy = tidyRuns();

const DOC = "# Plan\n\nWe need two people this spring.\n\nA second paragraph.\n\n| Item | Cost |\n| --- | --- |\n| Tool | 10 |\n";

/** The window's minimum width (src/main/main.ts). */
const NARROWEST = 560;

/** Every item on the toolbar, by the name a screen reader gives it. */
const ALL = [
  "Outline", "Undo", "Redo", "Paragraph style", "Bold", "Italic", "Strikethrough", "Bulleted list", "Numbered list", "Quote", "Code block",
  "Link", "Insert", "Table", "Comment", "Comments", "Show changes", "History", "Formatted", "Markdown", "Export",
];
/** The order items go into More, least used first; the items of one step go together. */
const STEPS = [
  ["Export"],
  ["Quote", "Code block"],
  ["Outline"], // roadmap Batch 9, item 10: on the bar while the window has room for the outline beside the comments
  ["Table"],
  ["Strikethrough"],
  ["Redo"],
  ["Insert"],
  ["Show changes", "History"],
  ["Link"],
  ["Bulleted list", "Numbered list"],
];
/** What stays on the bar however narrow the window is made. */
const ALWAYS = ["Undo", "Paragraph style", "Bold", "Italic", "Comment", "Comments", "Formatted", "Markdown"];

/** The toolbar's items on screen, group by group, left to right, and More if it shows. */
function bar(page: Page): Promise<{ groups: string[][]; more: boolean }> {
  return page.evaluate(() => {
    const toolbar = document.getElementById("toolbar")!;
    const name = (el: Element) => (el.getAttribute("aria-label") ?? el.textContent ?? "").replace(/, \d+ open$/, "");
    const shown = (el: Element) => (el as HTMLElement).checkVisibility() && el.getBoundingClientRect().width > 0;
    const groups = [...toolbar.children]
      .filter((g) => shown(g) && !g.classList.contains("more-group") && !g.classList.contains("tool-spacer"))
      .map((g) => [...g.querySelectorAll("button, select")].filter(shown).map(name));
    return { groups, more: shown(toolbar.querySelector(".more-group")!) };
  });
}

/** How the toolbar sits: on one row, inside the window, nothing squeezed or scrolled. */
function fit(page: Page) {
  return page.evaluate(() => {
    const toolbar = document.getElementById("toolbar")!;
    const items = [...toolbar.querySelectorAll<HTMLElement>("button.tool, select, .mode-switch button")].filter((b) => b.checkVisibility());
    const middles = items.map((b) => b.getBoundingClientRect()).map((r) => r.top + r.height / 2);
    return {
      rows: Math.max(...middles) - Math.min(...middles) < 2 ? 1 : 2,
      height: toolbar.getBoundingClientRect().height,
      scrolls: toolbar.scrollWidth > toolbar.clientWidth,
      outside: items.filter((b) => b.getBoundingClientRect().right > innerWidth - 16 + 0.5).length,
      squeezed: items.filter((b) => b.scrollWidth > b.clientWidth + 1).length,
    };
  });
}

/** Open More and read its items: name, kind, tick, greyed out, and the lines between groups. */
async function moreItems(page: Page): Promise<string[]> {
  await page.getByRole("button", { name: "More", exact: true }).click();
  const menu = page.getByRole("menu", { name: "More" });
  await expect(menu).toBeVisible();
  const items = await menu.evaluate((m) =>
    [...m.children].map((c) => {
      if (c.classList.contains("menu-separator")) return "---";
      const b = c as HTMLButtonElement;
      const role = b.getAttribute("role");
      const tick = b.getAttribute("aria-checked") === "true" ? " ✓" : "";
      const sub = b.getAttribute("aria-haspopup") ? " ›" : "";
      const key = b.querySelector(".menu-key")?.textContent;
      return `${b.getAttribute("aria-label")}${sub}${key ? ` ${key}` : ""}${tick}${b.disabled ? " (greyed)" : ""}${role === "menuitem" ? "" : ` [${role}]`}`;
    }),
  );
  await page.keyboard.press("Escape");
  await expect(menu).toBeHidden();
  return items;
}

/** Choose an item from More (and from its own menu, for Insert, Table, Export and Style). */
async function fromMore(page: Page, item: string, subItem?: string): Promise<void> {
  await page.getByRole("button", { name: "More", exact: true }).click();
  await page.getByRole("menu", { name: "More" }).locator(`button[aria-label="${item}"]`).click();
  if (subItem) await page.getByRole("menu", { name: item }).locator("button", { hasText: subItem }).first().click();
  await settle(page);
}

/** A new width for the window, and a moment for the bar to fit it (it does before the window is next drawn). */
async function resize(page: Page, width: number): Promise<void> {
  await page.setViewportSize({ width, height: 700 });
  await page.evaluate(() => new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve))));
}

async function narrow(run: Running, width = NARROWEST): Promise<void> {
  await resize(run.page, width);
  await settle(run.page);
}

test("the toolbar's groups, at full width: the outline's button first, over where it opens; writing at the left, working with others at the right", async () => {
  const run = await openText(DOC);
  await resize(run.page, 1440);
  expect(await bar(run.page)).toEqual({
    groups: [
      ["Outline"],
      ["Undo", "Redo"],
      ["Paragraph style"],
      ["Bold", "Italic", "Strikethrough"],
      ["Bulleted list", "Numbered list"],
      ["Quote", "Code block"],
      ["Link", "Insert", "Table"],
      ["Comment", "Comments"],
      ["Show changes", "History"],
      ["Formatted", "Markdown"],
      ["Export"],
    ],
    more: false,
  });
  await run.app.close();
});

test("the toolbar stays on one row at every width, down to the narrowest window, never squeezed or scrolling sideways", async () => {
  const run = await openText(DOC);
  for (const width of [1800, 1440, 1280, 1100, 1000, 900, 800, 700, 640, 600, NARROWEST]) {
    await resize(run.page, width);
    expect(await fit(run.page), `at ${width}px`).toEqual({ rows: 1, height: 48, scrolls: false, outside: 0, squeezed: 0 });
  }
  await run.app.close();
});

test("on a wide window the named buttons show their names; on a narrower one, just icons with the name as a tooltip", async () => {
  const run = await openText("Text.\n");
  const history = run.page.getByRole("button", { name: "History" });
  await run.page.setViewportSize({ width: 1500, height: 700 });
  await expect(history).toContainText("History");
  await expect(history.locator("span")).toBeVisible();
  await run.page.setViewportSize({ width: 1100, height: 700 });
  await expect(history.locator("span")).toBeHidden();
  expect(await history.getAttribute("title")).toBeTruthy();
  await run.app.close();
});

test("the main action has the name: Comment shows the word where named buttons do; the panel's button beside it shows its icon and the count, named in its tooltip (lead's call, 2026-11-09 night)", async () => {
  const run = tidy.keep(await openText(DOC));
  const { page } = run;
  const comment = page.getByRole("button", { name: "Comment", exact: true });
  const panel = page.locator("#toolbar .comments-tool");
  /** The words each shows on screen, without the count. */
  const shownWords = (button: typeof comment) =>
    button.evaluate((b) =>
      [...b.querySelectorAll("span:not(.tool-count)")]
        .filter((s) => (s as HTMLElement).checkVisibility())
        .map((s) => s.textContent)
        .join(""),
    );
  await resize(page, 1440);
  expect(await shownWords(comment)).toBe("Comment");
  expect(await shownWords(panel)).toBe("");
  expect(await panel.getAttribute("aria-label")).toBe("Comments");
  expect(await panel.getAttribute("title")).toBe("Hide comments (⌃⌘M)");
  // A comment: the count shows, and names it for screen readers.
  await selectText(page, "two people");
  await page.keyboard.press("Meta+Alt+KeyM");
  await page.keyboard.type("Who?");
  await page.keyboard.press("Meta+Enter");
  await expect(panel.locator(".tool-count")).toHaveText("1");
  expect(await panel.getAttribute("aria-label")).toBe("Comments, 1 open");
  // Comment first, then the panel's button, as before.
  expect((await bar(page)).groups).toContainEqual(["Comment", "Comments"]);
  // Narrower, where named buttons show just their icons, so does Comment.
  await resize(page, 1000);
  expect(await shownWords(comment)).toBe("");
  // The narrowest window with a three-figure count: everything that stays on the bar fits, on one row.
  await page.evaluate(() => {
    const count = document.querySelector<HTMLElement>("#toolbar .tool-count")!;
    count.textContent = "888";
  });
  await resize(page, NARROWEST + 4);
  await resize(page, NARROWEST);
  const shown = (await bar(page)).groups.flat();
  for (const name of ALWAYS) expect(shown, name).toContain(name);
  expect(await fit(page)).toEqual({ rows: 1, height: 48, scrolls: false, outside: 0, squeezed: 0 });
});

test("in the narrowest window, with a three-figure count, the style menu shows all of \"Normal text\", and the bar still fits on one row", async () => {
  const run = tidy.keep(await openText(DOC));
  const { page } = run;
  await page.locator(`${EDITOR} p`, { hasText: "two people" }).click();
  await settle(page);
  await page.evaluate(() => {
    const count = document.querySelector<HTMLElement>("#toolbar .tool-count")!;
    count.hidden = false;
    count.textContent = "100";
  });
  await resize(page, NARROWEST + 4);
  await resize(page, NARROWEST);
  const select = page.getByRole("combobox", { name: "Paragraph style" });
  await expect(select).toHaveValue("paragraph");
  expect(await page.evaluate(() => document.getElementById("toolbar")!.classList.contains("tight"))).toBe(true);
  expect(await fit(page)).toEqual({ rows: 1, height: 48, scrolls: false, outside: 0, squeezed: 0 });
  // The words as drawn, compared with the same menu given all the room it could want.
  const words = await select.evaluate((s) => {
    const style = getComputedStyle(s);
    const context = document.createElement("canvas").getContext("2d")!;
    context.font = `${style.fontWeight} ${style.fontSize} ${style.fontFamily}`;
    return Math.ceil(context.measureText("Normal text").width);
  });
  const box = (await select.boundingBox())!;
  const clip = { x: box.x, y: box.y + 4, width: 1 + 8 + words + 2, height: box.height - 8 };
  const asShown = await page.screenshot({ clip });
  await select.evaluate((s) => (s.style.width = "240px"));
  const inFull = await page.screenshot({ clip });
  await select.evaluate((s) => (s.style.width = ""));
  expect(asShown.equals(inFull), "the words are cut short").toBe(true);
});

/**
 * How much room a toolbar item leaves left of what's drawn first in it (its words or icon) and right of what's
 * drawn last (its arrow), in pixels: read from the pixels on screen, inside its border.
 */
async function rooms(page: Page, item: Locator, border: number): Promise<{ left: number; right: number }> {
  const box = (await item.boundingBox())!;
  const clip = { x: box.x + border, y: box.y + 6, width: box.width - 2 * border, height: box.height - 12 };
  const png = (await page.screenshot({ clip })).toString("base64");
  return page.evaluate(async (data) => {
    const image = new Image();
    image.src = `data:image/png;base64,${data}`;
    await image.decode();
    const canvas = document.createElement("canvas");
    [canvas.width, canvas.height] = [image.width, image.height];
    const context = canvas.getContext("2d")!;
    context.drawImage(image, 0, 0);
    const { data: px, width, height } = context.getImageData(0, 0, image.width, image.height);
    const at = (x: number, y: number) => px.slice((y * width + x) * 4, (y * width + x) * 4 + 3);
    const ground = at(1, 1);
    const inked = (x: number) => {
      for (let y = 0; y < height; y++) if (at(x, y).some((v, i) => Math.abs(v - ground[i]) > 40)) return true;
      return false;
    };
    let first = 0;
    while (first < width && !inked(first)) first++;
    let last = width - 1;
    while (last > 0 && !inked(last)) last--;
    return { left: first, right: width - 1 - last };
  }, png);
}

// Roadmap Batch 9, item 7 (Orlando, 2026-11-12, of the box showing "Heading 1": "The dropdown arrow here is touching
// the right line. It needs some margin on the right"): as much room right of the arrow as left of the words, and the
// toolbar's menus the same.
test("the paragraph style box has as much room right of its arrow as left of its words, wide and narrow, light and dark; the Insert, Table and Export menus match", async () => {
  const run = tidy.keep(await openText(DOC));
  const { page } = run;
  const select = page.getByRole("combobox", { name: "Paragraph style" });
  await page.locator(`${EDITOR} h1`).click();
  await settle(page);
  await expect(select).toHaveValue("h1");
  for (const scheme of ["light", "dark"] as const) {
    await page.emulateMedia({ colorScheme: scheme });
    await resize(page, 1440);
    const wide = await rooms(page, select, 1);
    expect(Math.abs(wide.right - wide.left), `${scheme}: ${JSON.stringify(wide)}`).toBeLessThanOrEqual(1.5);
    expect(wide.right, scheme).toBeGreaterThanOrEqual(8);
    for (const name of ["Insert", "Table", "Export"]) {
      const menu = await rooms(page, page.getByRole("button", { name, exact: true }), 0);
      expect(Math.abs(menu.right - menu.left), `${scheme}, ${name}: ${JSON.stringify(menu)}`).toBeLessThanOrEqual(1.5);
    }
    // In the narrowest window the box is narrower and its words have less room, its arrow just as much.
    await resize(page, NARROWEST + 4);
    await resize(page, NARROWEST);
    expect(await page.evaluate(() => document.getElementById("toolbar")!.classList.contains("tight"))).toBe(true);
    const tight = await rooms(page, select, 1);
    expect(Math.abs(tight.right - tight.left), `${scheme}, narrowest: ${JSON.stringify(tight)}`).toBeLessThanOrEqual(1.5);
  }
  await page.emulateMedia({ colorScheme: null });
});

test("as the window narrows, items go into More one step at a time, least used first, and the essentials never do", async () => {
  const run = await openText(DOC);
  const seen = new Set<number>();
  let before = 0;
  for (let width = 1440; width >= NARROWEST; width -= 4) {
    await resize(run.page, width);
    const shown = new Set((await bar(run.page)).groups.flat());
    const gone = ALL.filter((name) => !shown.has(name));
    // Always the first so many steps of the order, whole: never a later item before an earlier one, or half a step.
    const k = STEPS.findIndex((_, i) => STEPS.slice(0, i + 1).flat().length > gone.length);
    const steps = k < 0 ? STEPS.length : k;
    expect(gone.sort(), `at ${width}px`).toEqual(STEPS.slice(0, steps).flat().sort());
    expect(steps, `at ${width}px nothing comes back out`).toBeGreaterThanOrEqual(before);
    before = steps;
    seen.add(steps);
    for (const name of ALWAYS) expect(shown.has(name), `${name} at ${width}px`).toBe(true);
  }
  // Each step happened on its own, at some width.
  expect([...seen].sort((a, b) => a - b)).toEqual([0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10]);
  // Even with a three-figure count of open comments, the essentials fit the narrowest window.
  await run.page.evaluate(() => {
    const count = document.querySelector<HTMLElement>("#toolbar .tool-count")!;
    count.hidden = false;
    count.textContent = "888";
  });
  await resize(run.page, NARROWEST + 4);
  await resize(run.page, NARROWEST);
  const shown = (await bar(run.page)).groups.flat();
  for (const name of ALWAYS) expect(shown, name).toContain(name);
  expect(await fit(run.page)).toEqual({ rows: 1, height: 48, scrolls: false, outside: 0, squeezed: 0 });
  await run.app.close();
});

test("More shows only when something is in it, and lists exactly what's missing from the bar, in toolbar order, grouped", async () => {
  const run = await openText(DOC);
  const { page } = run;
  await resize(page, 1440);
  await expect(page.getByRole("button", { name: "More", exact: true })).toBeHidden();
  await resize(page, 1000);
  await expect(page.getByRole("button", { name: "More", exact: true })).toBeVisible();
  await expect(page.getByRole("button", { name: "More", exact: true })).toHaveAttribute("title", /More/);
  await page.locator(`${EDITOR} p`, { hasText: "two people" }).click();
  await settle(page);
  expect(await moreItems(page)).toEqual(["Quote [menuitemcheckbox]", "Code block [menuitemcheckbox]", "---", "Export ›", "---", "Read aloud ⌃⌘R"]);
  await narrow(run);
  expect(await moreItems(page)).toEqual([
    "Outline [menuitemcheckbox]",
    "---",
    "Redo ⇧⌘Z (greyed)",
    "---",
    "Strikethrough ⇧⌘X [menuitemcheckbox]",
    "---",
    "Bulleted list ⇧⌘8 [menuitemcheckbox]",
    "Numbered list ⇧⌘7 [menuitemcheckbox]",
    "---",
    "Quote [menuitemcheckbox]",
    "Code block [menuitemcheckbox]",
    "---",
    "Link ⌘K [menuitemcheckbox]",
    "Insert ›",
    "Table › (greyed)",
    "---",
    "Show changes ⌃⌘C [menuitemcheckbox]",
    "History ⌃⌘H [menuitemcheckbox]",
    "---",
    "Export ›",
    // Read Aloud (roadmap Batch 14, item 4) sits at the end of More whenever More is on the bar.
    "---",
    "Read aloud ⌃⌘R",
  ]);
  // Wider again: everything is back on the bar, and More goes.
  await resize(page, 1440);
  await expect(page.getByRole("button", { name: "More", exact: true })).toBeHidden();
  expect((await bar(page)).groups.flat()).toEqual(ALL);
  await run.app.close();
});

// Orlando, 2026-11-09
test("More sits right after the writing buttons, beside most of what goes into it, not at the far right", async () => {
  const run = await openText(DOC);
  const { page } = run;
  for (const width of [1000, 800, 700, NARROWEST]) {
    await resize(page, width);
    const place = await page.evaluate(() => {
      const toolbar = document.getElementById("toolbar")!;
      const more = toolbar.querySelector<HTMLElement>(".more-tool")!.getBoundingClientRect();
      const spacer = toolbar.querySelector(".tool-spacer")!;
      const writing = [...toolbar.querySelectorAll<HTMLElement>("button.tool, select")].filter(
        (b) => b.checkVisibility() && !b.classList.contains("more-tool") && b.compareDocumentPosition(spacer) & Node.DOCUMENT_POSITION_FOLLOWING,
      );
      const lastWriting = writing[writing.length - 1].getBoundingClientRect();
      const comment = toolbar.querySelector<HTMLElement>('button[aria-label="Comment"]')!.getBoundingClientRect();
      return { gapAfterWriting: more.left - lastWriting.right, roomBeforeComment: comment.left - more.right };
    });
    // Just after the last writing button, with only a divider's room between them.
    expect(place.gapAfterWriting, `at ${width}`).toBeGreaterThanOrEqual(0);
    expect(place.gapAfterWriting, `at ${width}`).toBeLessThanOrEqual(20);
    // And left of Comment and the rest of the right-hand buttons.
    expect(place.roomBeforeComment, `at ${width}`).toBeGreaterThanOrEqual(0);
  }
  await run.app.close();
});

// Roadmap Batch 11, F-13: the count is a badge on the icon's corner, so it takes no room of its own (it used to
// widen the button, moving Comment 22 pixels and, in a full bar, sending items into More).
test("the open comments' count takes no room: in a full bar, a first comment moves nothing and sends nothing into More, and resolving it changes nothing", async () => {
  const run = await openText(DOC);
  const { page } = run;
  // The narrowest window with everything still on the bar, and no comments.
  let width = 1100;
  await resize(page, width);
  expect((await bar(page)).more).toBe(false);
  while (!(await bar(page)).more) await resize(page, (width -= 2));
  await resize(page, (width += 2));
  expect((await bar(page)).groups.flat()).toEqual(ALL);
  const comment = page.getByRole("button", { name: "Comment", exact: true });
  const before = await comment.boundingBox();
  // A comment: its count shows, and everything stays where it was.
  const count = page.locator("#toolbar .comments-tool .tool-count");
  await selectText(page, "two people");
  await page.keyboard.press("Meta+Alt+KeyM");
  await page.keyboard.type("Who?");
  await page.keyboard.press("Meta+Enter");
  await expect(count).toHaveText("1");
  await settle(page);
  expect((await bar(page)).groups.flat()).toEqual(ALL);
  expect(await comment.boundingBox()).toEqual(before);
  expect(await fit(page)).toEqual({ rows: 1, height: 48, scrolls: false, outside: 0, squeezed: 0 });
  // The badge sits on the corner of the button's icon, within the button's width and the bar.
  const [badge, button, toolbar] = await Promise.all([
    count.boundingBox(),
    page.locator("#toolbar .comments-tool").boundingBox(),
    page.locator("#toolbar").boundingBox(),
  ]);
  expect(badge!.x + badge!.width).toBeLessThanOrEqual(button!.x + button!.width);
  expect(badge!.y).toBeGreaterThanOrEqual(toolbar!.y);
  // Resolved: no count, and still nothing moved.
  await page.locator(".comment-card", { hasText: "Who?" }).getByRole("button", { name: "Resolve" }).click();
  await expect(count).toBeHidden();
  await settle(page);
  expect((await bar(page)).groups.flat()).toEqual(ALL);
  expect(await comment.boundingBox()).toEqual(before);
  await run.app.close();
});

test("from More: a mark, a list, a quote, a link, Redo, Insert, Table, Show changes, History and Export each do what their button does", async () => {
  const run = await openText(DOC);
  const { page } = run;
  await narrow(run);
  // A mark
  await selectText(page, "two people");
  await fromMore(page, "Strikethrough");
  await expect.poll(run.text).toContain("We need ~~two people~~ this spring.");
  // Redo, after an undo
  await page.keyboard.press("Meta+z");
  await expect.poll(run.text).toContain("We need two people this spring.");
  await fromMore(page, "Redo");
  await expect.poll(run.text).toContain("We need ~~two people~~ this spring.");
  // A list, and a quote
  await page.locator(`${EDITOR} p`, { hasText: "A second paragraph" }).click();
  await settle(page);
  await fromMore(page, "Bulleted list");
  await expect.poll(run.text).toContain("- A second paragraph.");
  await fromMore(page, "Bulleted list");
  await fromMore(page, "Quote");
  await expect.poll(run.text).toContain("> A second paragraph.");
  await fromMore(page, "Quote");
  // A link: the link editor opens under More, where Link is now
  await selectText(page, "spring");
  await fromMore(page, "Link");
  const editor = page.locator(".link-editor");
  await expect(editor).toBeVisible();
  const more = await page.getByRole("button", { name: "More", exact: true }).boundingBox();
  const box = await editor.boundingBox();
  expect(Math.abs(box!.y - (more!.y + more!.height + 6))).toBeLessThanOrEqual(1);
  await page.keyboard.type("https://example.org");
  await page.keyboard.press("Enter");
  await expect.poll(run.text).toContain("[spring](https://example.org)");
  // Insert, from its own menu beside More's
  await page.locator(`${EDITOR} p`, { hasText: "A second paragraph" }).click();
  await settle(page);
  await page.keyboard.press("Meta+ArrowRight");
  await fromMore(page, "Insert", "Horizontal line");
  await expect.poll(run.text).toMatch(/A second paragraph\.\n\n(---|\*\*\*|___)\n/);
  // Table, in a table
  await cursorInCell(page, "Tool");
  await fromMore(page, "Table", "Add row below");
  await expect.poll(async () => page.locator(`${EDITOR} table tr`).count()).toBe(3);
  // Show changes, then History
  await fromMore(page, "Show changes");
  await expect(page.locator(".doc:not([hidden]) .version-banner")).toBeVisible();
  await fromMore(page, "Show changes");
  await expect(page.locator(".doc:not([hidden]) .version-banner")).toBeHidden();
  await fromMore(page, "History");
  await expect(page.locator(".doc:not([hidden]) .history-panel")).toBeVisible();
  await fromMore(page, "History");
  await expect(page.locator(".doc:not([hidden]) .history-panel")).toBeHidden();
  // Export, from its own menu
  await fromMore(page, "Export", "Export settings…");
  await expect(page.getByRole("dialog")).toBeVisible();
  await page.getByRole("button", { name: "Cancel" }).click();
  await run.app.close();
});

test("in a window narrower than Corillo allows, even the essentials go into More last, and still work there: the style, the views and Comments", async () => {
  const run = await openText(DOC);
  const { page } = run;
  await narrow(run, 300);
  expect(await fit(page)).toEqual({ rows: 1, height: 48, scrolls: false, outside: 0, squeezed: 0 });
  expect((await bar(page)).groups.flat()).not.toContain("Paragraph style");
  // The style
  await selectText(page, "A second paragraph");
  await fromMore(page, "Style", "Heading 2");
  await expect.poll(run.text).toContain("## A second paragraph.");
  // Comments: the panel hides and shows again
  const panel = page.locator(".doc:not([hidden]) .comments-panel");
  await expect(panel).toBeVisible();
  await fromMore(page, "Comments");
  await expect(panel).toBeHidden();
  await fromMore(page, "Comments");
  await expect(panel).toBeVisible();
  // The views
  await fromMore(page, "Markdown");
  await expect(page.locator(".doc:not([hidden]) textarea.source")).toBeVisible();
  const items = await moreItems(page);
  expect(items).toContain("Formatted ⌘/ [menuitemradio]");
  expect(items).toContain("Markdown ✓ [menuitemradio]");
  await fromMore(page, "Formatted");
  await expect(page.locator(EDITOR)).toBeVisible();
  // At the narrowest Corillo allows, they're all back on the bar.
  await narrow(run);
  const shown = (await bar(page)).groups.flat();
  for (const name of ALWAYS) expect(shown, name).toContain(name);
  await run.app.close();
});

test("More's ticks and greying out match the buttons': the cursor's marks and list, the view, the panels, and an agent editing", async () => {
  const run = await openText("# Plan\n\n- We need **~~two~~ people** this spring.\n\nA second paragraph.\n");
  const { page } = run;
  await narrow(run);
  await page.locator(`${EDITOR} li`, { hasText: "two" }).click();
  await selectText(page, "two");
  let items = await moreItems(page);
  for (const ticked of ["Strikethrough ⇧⌘X ✓", "Bulleted list ⇧⌘8 ✓"]) {
    expect(items.some((i) => i.startsWith(ticked)), ticked).toBe(true);
  }
  for (const plain of ["Numbered list ⇧⌘7 [", "Quote [", "Link ⌘K [", "Show changes ⌃⌘C [", "History ⌃⌘H ["]) {
    expect(items.some((i) => i.startsWith(plain)), plain).toBe(true);
  }
  expect(items).toContain("Table › (greyed)");
  // Narrower than Corillo allows, so the essentials are in More too: Bold, the view and the Comments panel ticked.
  await narrow(run, 150);
  items = await moreItems(page);
  for (const ticked of ["Bold ⌘B ✓", "Strikethrough ⇧⌘X ✓", "Formatted ✓", "Comments ⌃⌘M ✓"]) {
    expect(items.some((i) => i.startsWith(ticked)), ticked).toBe(true);
  }
  for (const plain of ["Italic ⌘I [", "Markdown ⌘/ ["]) {
    expect(items.some((i) => i.startsWith(plain)), plain).toBe(true);
  }
  // History open: ticked, and Comments not (they take turns in one place).
  await fromMore(page, "History");
  items = await moreItems(page);
  expect(items.some((i) => i.startsWith("History ⌃⌘H ✓"))).toBe(true);
  expect(items.some((i) => i.startsWith("Comments ⌃⌘M ✓"))).toBe(false);
  await fromMore(page, "History");

  // An agent editing: the writing items are greyed out, as on the bar; Comment, Comments and the views aren't.
  const { session } = await AgentSession.start(run.dataDir, "claude-code");
  await session.ok("take_document", { path: run.file });
  await expect(page.locator(".doc:not([hidden]) .agent-notice:not([hidden])")).toBeVisible();
  items = await moreItems(page);
  for (const name of ["Redo", "Bold", "Italic", "Strikethrough", "Bulleted list", "Numbered list", "Quote", "Code block", "Link", "Insert", "Table", "Style"]) {
    expect(items.find((i) => i.startsWith(`${name} `))!, name).toContain("(greyed)");
  }
  for (const name of ["Outline", "Comment", "Comments", "Show changes", "History", "Formatted", "Markdown", "Export"]) {
    expect(items.find((i) => i.startsWith(`${name} `))!, name).not.toContain("(greyed)");
  }
  await session.stop();
  await run.app.close();
});

test("while the keyboard is in a comment box, a reply or the link editor, the writing buttons and More's copies are greyed out, as the menu bar's are; in the find bar they stay live", async () => {
  const run = tidy.keep(await openText(DOC));
  const { page, app } = run;
  await narrow(run, 760); // Quote, Code block and Strikethrough are in More
  const WRITING = ["Undo", "Paragraph style", "Bold", "Italic", "Bulleted list", "Numbered list", "Link", "Insert"];
  /** Whether each is greyed out, on the bar or (for what's in More) the button More presses. */
  const greyedOf = (names: string[]) =>
    page.evaluate(
      (list) =>
        Object.fromEntries(
          list.map((n) => {
            const el = document.querySelector<HTMLButtonElement | HTMLSelectElement>(`#toolbar [aria-label="${n}"], #toolbar [aria-label^="${n},"]`)!;
            return [n, el.disabled];
          }),
        ),
      names,
    );
  const greyed = () => greyedOf(WRITING);
  const all = (value: boolean) => Object.fromEntries(WRITING.map((n) => [n, value]));
  const menuEnabled = (id: string) =>
    app.evaluate(({ Menu }, itemId) => Menu.getApplicationMenu()!.getMenuItemById(itemId)!.enabled, id);
  // Something to undo, and words selected.
  await page.locator(`${EDITOR} p`, { hasText: "A second paragraph" }).click();
  await settle(page);
  await page.keyboard.press("Meta+ArrowRight");
  await page.keyboard.type(" More.");
  await expect.poll(run.text).toContain("A second paragraph. More.");
  await selectText(page, "two people");
  await expect.poll(greyed).toEqual(all(false));

  // A new comment on the selected words: the box has the keyboard.
  await page.keyboard.press("Meta+Alt+KeyM");
  const box = page.getByRole("textbox", { name: "New comment" });
  await expect(box).toBeFocused();
  await page.keyboard.type("Who?");
  await expect.poll(greyed).toEqual(all(true));
  await expect.poll(() => menuEnabled("format-bold")).toBe(false);
  // Comment, Comments, Show changes, History and the views aren't writing: they stay as they were.
  const OTHERS = ["Comment", "Comments", "Show changes", "History", "Export"];
  expect(await greyedOf(OTHERS)).toEqual(Object.fromEntries(OTHERS.map((n) => [n, false])));
  // More's copies of them are greyed out too (opening and closing More with the mouse leaves the keyboard in the box).
  const more = page.getByRole("button", { name: "More", exact: true });
  await more.click();
  const menu = page.getByRole("menu", { name: "More" });
  for (const name of ["Strikethrough", "Quote", "Code block"]) await expect(menu.locator(`button[aria-label="${name}"]`), name).toBeDisabled();
  await expect(menu.locator('button[aria-label="Export"]')).toBeEnabled();
  await more.click();
  await expect(menu).toBeHidden();
  await expect(box).toBeFocused();
  // Clicking where Bold is does nothing to the document, and the keyboard stays in the box.
  const bold = (await page.getByRole("button", { name: "Bold", exact: true }).boundingBox())!;
  await page.mouse.click(bold.x + bold.width / 2, bold.y + bold.height / 2);
  await settle(page);
  await expect(box).toBeFocused();
  // So does clicking a greyed-out item in More.
  await more.click();
  const quote = (await menu.locator('button[aria-label="Quote"]').boundingBox())!;
  await page.mouse.click(quote.x + quote.width / 2, quote.y + quote.height / 2);
  await settle(page);
  await expect(box).toBeFocused();
  await more.click();
  await expect(menu).toBeHidden();
  await expect(page.locator(`${EDITOR} strong`)).toHaveCount(0);
  await page.keyboard.type(" Really?");
  await expect(box).toHaveValue("Who? Really?");
  // Posted: the keyboard is back in the document, and the buttons with it.
  await page.keyboard.press("Meta+Enter");
  await expect.poll(greyed).toEqual(all(false));

  // A reply.
  await page.locator(".comment-card", { hasText: "Who?" }).click();
  const reply = page.getByRole("textbox", { name: "Reply" });
  await reply.click();
  await expect(reply).toBeFocused();
  await expect.poll(greyed).toEqual(all(true));
  await page.locator(`${EDITOR} p`, { hasText: "A second paragraph" }).click();
  await expect.poll(greyed).toEqual(all(false));

  // The link editor.
  await selectText(page, "spring");
  await page.keyboard.press("Meta+k");
  await expect(page.locator(".link-editor")).toBeVisible();
  await expect.poll(greyed).toEqual(all(true));
  await page.keyboard.press("Escape");
  await expect(page.locator(".link-editor")).toBeHidden();
  await expect.poll(greyed).toEqual(all(false));

  // The find bar: find a word, then click Bold (the menu bar's writing items stay greyed there, so typing in the box is left alone).
  await page.keyboard.press("Meta+f");
  const find = page.getByRole("textbox", { name: "Find" });
  await expect(find).toBeFocused();
  await expect.poll(greyed).toEqual(all(false));
  await expect.poll(() => menuEnabled("format-bold")).toBe(false);
  await page.keyboard.press("Meta+b");
  await settle(page);
  await expect(page.locator(`${EDITOR} strong`)).toHaveCount(0);
  await page.keyboard.type("spring");
  await page.keyboard.press("Enter");
  await page.getByRole("button", { name: "Bold", exact: true }).click();
  await expect.poll(run.text).toContain("We need two people this **spring**.");
});

test("with the keyboard in a comment box or a reply, Escape after opening More with the mouse closes More and leaves the keyboard in the box, words and all", async () => {
  const run = tidy.keep(await openText(DOC));
  const { page } = run;
  await narrow(run, 760);
  const more = page.getByRole("button", { name: "More", exact: true });
  const menu = page.getByRole("menu", { name: "More" });
  await selectText(page, "two people");
  await page.keyboard.press("Meta+Alt+KeyM");
  const box = page.getByRole("textbox", { name: "New comment" });
  await expect(box).toBeFocused();
  // With words in it (clicking away from an empty one throws it away, as Word does).
  await page.keyboard.type("Who?");
  await more.click();
  await expect(menu).toBeVisible();
  await page.keyboard.press("Escape");
  await expect(menu).toBeHidden();
  await expect(box).toBeFocused();
  await page.keyboard.type(" Really?");
  await expect(box).toHaveValue("Who? Really?");
  await page.keyboard.press("Meta+Enter");
  await expect(page.locator(".comment-card:not(.draft)", { hasText: "Who? Really?" })).toBeVisible();
  // A reply.
  await page.locator(".comment-card", { hasText: "Who? Really?" }).click();
  const reply = page.getByRole("textbox", { name: "Reply" });
  await reply.click();
  await page.keyboard.type("Ana");
  await more.click();
  await expect(menu).toBeVisible();
  await page.keyboard.press("Escape");
  await expect(menu).toBeHidden();
  await expect(reply).toBeFocused();
  await expect(reply).toHaveValue("Ana");
  // Escape with no menu open still does what it did: back to the document.
  await page.keyboard.press("Escape");
  await expect(reply).not.toBeFocused();
  expect(await page.evaluate(() => !!document.activeElement?.closest(".ProseMirror"))).toBe(true);
});

test("the link editor is a dialog named Link, its two boxes named, for screen readers", async () => {
  const run = tidy.keep(await openText(DOC));
  const { page } = run;
  await selectText(page, "spring");
  await page.keyboard.press("Meta+k");
  const dialog = page.getByRole("dialog", { name: "Link" });
  await expect(dialog).toBeVisible();
  await expect(dialog.getByRole("textbox", { name: "Link" })).toBeFocused();
  await page.keyboard.press("Escape");
  await expect(dialog).toBeHidden();
});

test("the toolbar's Undo straight after Resolve reopens the comment even where the writing buttons are greyed out (the Markdown view)", async () => {
  const run = tidy.keep(await openText(DOC));
  const { page } = run;
  await selectText(page, "two people");
  await page.keyboard.press("Meta+Alt+KeyM");
  await page.keyboard.type("Who?");
  await page.keyboard.press("Meta+Enter");
  const card = page.locator(".doc:not([hidden]) .comment-card", { hasText: "Who?" });
  await expect(card.getByRole("button", { name: "Resolve" })).toBeVisible();
  await page.getByRole("button", { name: "Markdown", exact: true }).click();
  const undo = page.getByRole("button", { name: "Undo", exact: true });
  await expect(undo).toBeDisabled(); // nothing of the Markdown text's to undo from here
  await card.getByRole("button", { name: "Resolve" }).click();
  await expect(card).toHaveCount(0);
  await expect(undo).toBeEnabled();
  await undo.click();
  await expect(card.getByRole("button", { name: "Resolve" })).toBeVisible();
  await expect(undo).toBeDisabled();
});

test("the keyboard: Tab reaches More, Return or Space opens it, the arrows move, Escape closes back to More, and a choice puts the keyboard back in the document", async () => {
  const run = await openText(DOC);
  const { page } = run;
  await narrow(run);
  await page.locator(`${EDITOR} p`, { hasText: "A second paragraph" }).click();
  await settle(page);
  await page.keyboard.press("Meta+ArrowRight");
  // The editor hears of a cursor move a moment after the key. Moving the
  // keyboard to a button before then (only a test can be that quick) loses
  // the move, and the cursor goes back to where the click put it.
  await settle(page);
  // The page first: it has a name of its own now, the document's (roadmap Batch 12, N-1).
  const focused = () => page.evaluate(() => (document.activeElement?.closest(".ProseMirror") ? "document" : (document.activeElement?.getAttribute("aria-label") ?? document.activeElement?.tagName)));
  // Tab from the button before it: the last writing button left on the bar
  await page.getByRole("button", { name: "Italic", exact: true }).focus();
  await page.keyboard.press("Tab");
  expect(await focused()).toBe("More");
  // Return opens it, with the keyboard on the first item
  await page.keyboard.press("Enter");
  const menu = page.getByRole("menu", { name: "More" });
  await expect(menu).toBeVisible();
  await expect(page.getByRole("button", { name: "More", exact: true })).toHaveAttribute("aria-expanded", "true");
  expect(await focused()).toBe("Outline"); // first on the bar, so first in More (roadmap Batch 9, item 10)
  await page.keyboard.press("ArrowDown");
  expect(await focused()).toBe("Strikethrough"); // Redo is greyed out: nothing to redo
  await page.keyboard.press("ArrowDown");
  expect(await focused()).toBe("Bulleted list");
  await page.keyboard.press("ArrowUp");
  await page.keyboard.press("ArrowUp");
  await page.keyboard.press("ArrowUp");
  expect(await focused()).toBe("Read aloud"); // round from the top to the end
  await page.keyboard.press("Home");
  expect(await focused()).toBe("Outline");
  await page.keyboard.press("End");
  expect(await focused()).toBe("Read aloud");
  // Escape closes it, with the keyboard back on More (roadmap Batch 12, G-9: it went to the document before)
  await page.keyboard.press("Escape");
  await expect(menu).toBeHidden();
  expect(await focused()).toBe("More");
  // Space opens it; a choice acts on the document and leaves the keyboard there
  await page.keyboard.press("Space");
  await expect(menu).toBeVisible();
  await page.keyboard.press("ArrowDown");
  await page.keyboard.press("ArrowDown");
  await page.keyboard.press("Enter");
  await expect(menu).toBeHidden();
  await expect.poll(run.text).toContain("- A second paragraph.");
  expect(await focused()).toBe("document");
  await page.keyboard.type(" Typed");
  await expect.poll(run.text).toContain("- A second paragraph. Typed");
  // A menu inside More: Right opens it on its first item, Left goes back
  await page.locator(`${EDITOR} h1`).click();
  await settle(page);
  await page.keyboard.press("Meta+ArrowRight");
  await settle(page);
  await page.getByRole("button", { name: "More", exact: true }).focus();
  await page.keyboard.press("Enter");
  for (let i = 0; i < 20 && (await focused()) !== "Insert"; i++) await page.keyboard.press("ArrowDown");
  expect(await focused()).toBe("Insert");
  await page.keyboard.press("ArrowRight");
  const insert = page.getByRole("menu", { name: "Insert" });
  await expect(insert).toBeVisible();
  expect(await page.evaluate(() => document.activeElement?.textContent)).toBe("Table");
  await page.keyboard.press("ArrowLeft");
  await expect(insert).toBeHidden();
  expect(await focused()).toBe("Insert");
  await page.keyboard.press("Enter"); // Return opens it too
  await expect(insert).toBeVisible();
  await page.keyboard.press("End");
  expect(await page.evaluate(() => document.activeElement?.textContent)).toBe("Horizontal line");
  await page.keyboard.press("Enter");
  await expect(menu).toBeHidden();
  await expect(insert).toBeHidden();
  await expect.poll(run.text).toMatch(/^# Plan\n\n(---|\*\*\*|___)\n/);
  expect(await focused()).toBe("document");
  await run.app.close();
});

test("the mouse: More opens and closes without taking the cursor from the document, and resting on Insert opens its menu", async () => {
  const run = await openText(DOC);
  const { page } = run;
  await narrow(run);
  await selectText(page, "two people");
  const more = page.getByRole("button", { name: "More", exact: true });
  await more.click();
  const menu = page.getByRole("menu", { name: "More" });
  await expect(menu).toBeVisible();
  expect(await page.evaluate(() => !!document.activeElement?.closest(".ProseMirror"))).toBe(true);
  await menu.locator('button[aria-label="Insert"]').hover();
  await expect(page.getByRole("menu", { name: "Insert" })).toBeVisible();
  // Resting on a plain item closes it again
  await menu.locator('button[aria-label="Quote"]').hover();
  await expect(page.getByRole("menu", { name: "Insert" })).toBeHidden();
  // Clicking More again, or anywhere else, closes it
  await more.click();
  await expect(menu).toBeHidden();
  await more.click();
  await page.locator(`${EDITOR} h1`).click();
  await expect(menu).toBeHidden();
  // Both menus stay inside the window
  await more.click();
  await menu.locator('button[aria-label="Export"]').click();
  const sub = await page.getByRole("menu", { name: "Export" }).boundingBox();
  const main = await menu.boundingBox();
  for (const box of [sub!, main!]) {
    expect(box.x).toBeGreaterThanOrEqual(8);
    expect(box.x + box.width).toBeLessThanOrEqual(NARROWEST - 8 + 0.5);
  }
  expect(sub!.x + sub!.width).toBeLessThanOrEqual(main!.x + 4 + 0.5); // to the side, not over it
  await run.app.close();
});
