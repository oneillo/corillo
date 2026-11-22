// Tabs share the bar's room fairly (roadmap Batch 24, row 26 of
// review/batch-24/findings.md: W-24, W-11, N-5). A name is cut only when the
// bar is full; short names keep their words while long ones share what's left
// equally; and in a narrow window, where they can't all show, each tab still
// shows a word or so of its name. Batch 10 and 12's tabs (dragging, Move Tab,
// All tabs, a tab never changing width for its frog or dot) are held by
// tabs.spec.ts and tab-coqui.spec.ts.
import { test, expect, type Page } from "@playwright/test";
import { openText, openAlso, tabState } from "./helpers";

const NAMES = [
  "Board notes from the June meeting with the trustees",
  "Plan",
  "Grant application for the community garden",
  "Ideas",
  "Letter to the council about the bike lanes",
  "Budget 2027",
  "Quarterly planning notes, third draft",
  "To do",
];

interface TabRoom {
  name: string;
  width: number;
  cut: boolean;
  letters: number;
}

/** Each tab's width, whether its name is cut, and roughly how many letters of it show; and the bar's room. */
function room(page: Page): Promise<{ tabs: TabRoom[]; bar: number; used: number; overflowing: boolean }> {
  return page.evaluate(() => {
    const bar = document.querySelector<HTMLElement>(".tabs")!;
    const pad = parseFloat(getComputedStyle(bar).paddingLeft) + parseFloat(getComputedStyle(bar).paddingRight);
    const tabs = [...bar.querySelectorAll<HTMLElement>(".tab")].map((t) => {
      const name = t.querySelector<HTMLElement>(".tab-name")!;
      const full = name.textContent ?? "";
      const cut = name.scrollWidth > name.clientWidth + 0.5;
      const each = name.scrollWidth / Math.max(1, full.length);
      return { name: full, width: t.getBoundingClientRect().width, cut, letters: cut ? Math.floor(name.clientWidth / each) : full.length };
    });
    const gap = parseFloat(getComputedStyle(bar).columnGap) || 0;
    const used = tabs.reduce((sum, t) => sum + t.width, 0) + gap * Math.max(0, tabs.length - 1);
    return { tabs, bar: bar.clientWidth - pad, used, overflowing: bar.classList.contains("overflowing") };
  });
}

test("tabs share the bar fairly: nothing cut while there's room, short names whole while long ones share the rest, and a word or so each when narrow", async () => {
  const run = await openText("First.\n", { name: `${NAMES[0]}.md` });
  const { page } = run;
  try {
    await page.setViewportSize({ width: 2400, height: 700 });
    for (const name of NAMES.slice(1)) {
      await openAlso(run, `${name}.md`, `${name}.\n`);
      await expect.poll(async () => (await tabState(page)).active).toBe(`${name}.md`);
    }

    // Wide: the bar has room for every name whole, so none is cut.
    await expect.poll(async () => (await room(page)).tabs.filter((t) => t.cut).map((t) => t.name)).toEqual([]);

    // Medium: the bar is full before any name is cut; the short names are whole, and the cut ones share the rest equally,
    // each at least as wide as any whole one.
    await page.setViewportSize({ width: 1200, height: 700 });
    await expect.poll(async () => (await room(page)).tabs.some((t) => t.cut)).toBe(true);
    const medium = await room(page);
    expect(medium.overflowing).toBe(false);
    expect(medium.used).toBeGreaterThan(medium.bar - 4);
    for (const short of ["Plan", "Ideas", "To do", "Budget 2027"]) expect(medium.tabs.find((t) => t.name === short)?.cut, short).toBe(false);
    const cut = medium.tabs.filter((t) => t.cut);
    const whole = medium.tabs.filter((t) => !t.cut);
    expect(Math.max(...cut.map((t) => t.width)) - Math.min(...cut.map((t) => t.width))).toBeLessThan(2);
    expect(Math.min(...cut.map((t) => t.width))).toBeGreaterThanOrEqual(Math.max(...whole.map((t) => t.width)) - 1);

    // Narrow: more tabs than fit (All tabs at the end), each the same width, showing a word or so of its name, not two letters.
    await page.setViewportSize({ width: 560, height: 700 });
    await expect.poll(async () => (await room(page)).overflowing).toBe(true);
    const narrow = await room(page);
    const long = narrow.tabs.filter((t) => t.cut);
    expect(Math.max(...long.map((t) => t.width)) - Math.min(...long.map((t) => t.width))).toBeLessThan(2);
    for (const t of long) expect(t.letters, t.name).toBeGreaterThanOrEqual(7);
  } finally {
    await run.app.close();
  }
});
