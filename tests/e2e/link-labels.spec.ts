// A link written by label ("[the site][s]", with "[s]: https://..." below) uses the address its line
// gives now, once that line is edited on the page: Command-click, the link box and Copy all take the
// new one, as the file does (code review of Batch 16, W16-3).
import { test, expect } from "@playwright/test";
import { captureClipboardWrites, copySelection, cursorAtEnd, openText, selectText, settle, EDITOR } from "./helpers";
import { tidyRuns } from "./tidy";

const tidy = tidyRuns();
const TEXT = "# Links\n\nSee [the site][s] for more, and [s] again.\n\nA second paragraph.\n\n[s]: https://old.example/page\n";
const NEW = "https://new.example/page";

test("a link by label follows its address line when the line is edited on the page", async () => {
  const run = tidy.keep(await openText(TEXT, { name: "links.md" }));
  const { app, page } = run;
  await app.evaluate(({ shell }) => {
    const g = globalThis as unknown as { opened: string[] };
    g.opened = [];
    shell.openExternal = (async (url: string) => void g.opened.push(url)) as typeof shell.openExternal;
  });
  const opened = () => app.evaluate(() => (globalThis as unknown as { opened: string[] }).opened);
  await selectText(page, "old");
  await page.keyboard.type("new");
  await expect(page.locator("#save-status")).toHaveAttribute("data-state", "saved", { timeout: 15_000 });
  expect(run.text()).toContain(`[s]: ${NEW}`);
  expect(run.text()).toContain("See [the site][s] for more"); // still by label in the file

  // Command-click: the new address, for both links that use the label.
  await page.locator(`${EDITOR} a`, { hasText: "the site" }).click({ modifiers: ["Meta"] });
  await expect.poll(opened).toEqual([NEW]);
  await page.locator(`${EDITOR} a`, { hasText: /^s$/ }).click({ modifiers: ["Meta"] });
  await expect.poll(opened).toEqual([NEW, NEW]);

  // The link box shows it.
  await cursorAtEnd(page, "See the site");
  await page.locator(`${EDITOR} a`, { hasText: "the site" }).click();
  await settle(page);
  await page.keyboard.press("Meta+k");
  await expect(page.locator('.link-editor input[name="href"]')).toHaveValue(NEW);
  await page.keyboard.press("Escape");

  // Copied, the link carries it, as Markdown and as formatted text.
  const copied = await captureClipboardWrites(app);
  await cursorAtEnd(page, "See the site for more, and s again.");
  await page.keyboard.press("Shift+Meta+ArrowLeft");
  await settle(page);
  await copySelection(page);
  await expect.poll(copied).not.toBeNull();
  const written = (await copied())!;
  expect(written["text/plain"]).toContain(`[the site](${NEW})`);
  expect(written["text/html"]).toContain(`href="${NEW}"`);
  expect(written["text/plain"]).not.toContain("old.example");
  expect(written["text/html"]).not.toContain("old.example");
});
