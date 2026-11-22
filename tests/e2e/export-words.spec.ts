// The toolbar's Export menu says what the menu bar says (roadmap Batch 24,
// row 28 of review/batch-24/findings.md: W-16): the same words, in sentence
// case in the window and title case in the menu bar, as the spec has it.
import { test, expect } from "@playwright/test";
import { openText } from "./helpers";

/** "Export Settings…" in sentence case: "Export settings…" (Word and PDF keep their capitals). */
const sentenceCase = (label: string) =>
  label
    .split(" ")
    .map((w, i) => (i === 0 || /^(Word|PDF)/.test(w) ? w : w[0].toLowerCase() + w.slice(1)))
    .join(" ");

test("the toolbar's Export menu has the menu bar's words, in sentence case", async () => {
  const run = await openText("# Plan\n\nWords.\n");
  const { app, page } = run;
  try {
    const bar = await app.evaluate(({ Menu }) =>
      ["export-word", "export-pdf", "copy-email", "export-settings"].map((id) => Menu.getApplicationMenu()!.getMenuItemById(id)!.label),
    );
    expect(bar).toEqual(["Export to Word…", "Export to PDF…", "Copy for Email", "Export Settings…"]);
    await page.getByRole("button", { name: "Export", exact: true }).click();
    const items = (await page.getByRole("menu", { name: "Export" }).getByRole("menuitem").allTextContents()).map((t) => t.trim());
    expect(items).toEqual(bar.map(sentenceCase));
    await page.keyboard.press("Escape");
  } finally {
    await app.close();
  }
});
