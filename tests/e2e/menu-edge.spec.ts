// In dark, the window's menus have an edge that stands out from what is behind
// them (roadmap Batch 24, row 29 of review/batch-24/findings.md: W-17).
import { test, expect } from "@playwright/test";
import { openText } from "./helpers";
import { contrast } from "./contrast";

test("in dark, the toolbar's menus have an edge that stands out from the panel and the page behind them, 3 to 1 or more (row 29)", async () => {
  const run = await openText("# Plan\n\nWords.\n");
  const { app, page } = run;
  try {
    await page.emulateMedia({ colorScheme: "dark" });
    await page.getByRole("button", { name: "Export", exact: true }).click();
    const menu = page.getByRole("menu", { name: "Export" });
    await expect(menu).toBeVisible();
    const looks = await menu.evaluate((m) => {
      const hex = (rgb: string) => "#" + (rgb.match(/\d+/g) ?? []).slice(0, 3).map((n) => Number(n).toString(16).padStart(2, "0")).join("");
      // What shows behind: the first box out from here with a colour of its own.
      const bg = (sel: string) => {
        for (let e: Element | null = document.querySelector(sel); e; e = e.parentElement) {
          const c = getComputedStyle(e).backgroundColor;
          if (c !== "rgba(0, 0, 0, 0)" && c !== "transparent") return hex(c);
        }
        return "#000000";
      };
      return { edge: hex(getComputedStyle(m).borderTopColor), panel: bg(".doc:not([hidden]) .comments-panel"), page: bg(".doc:not([hidden]) .ProseMirror") };
    });
    for (const behind of [looks.panel, looks.page]) expect(contrast(looks.edge, behind), `${looks.edge} on ${behind}`).toBeGreaterThanOrEqual(3);
  } finally {
    await app.close();
  }
});
