// File > New Document: the person names a new document and picks its folder,
// and it opens, empty, ready to type in.
import { test, expect } from "@playwright/test";
import { existsSync, readFileSync, unlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { clickMenu, openText, selectText, settle, tabState } from "./helpers";

/** Pretend the person chose this name and folder in the next save dialog, and note what the dialog suggested. */
async function chooseInSaveDialog(app: Parameters<typeof clickMenu>[0], filePath: string): Promise<() => Promise<string>> {
  await app.evaluate(({ dialog }, picked) => {
    const g = globalThis as unknown as { suggested: string };
    dialog.showSaveDialog = (async (...args: unknown[]) => {
      const options = args[args.length - 1] as { defaultPath?: string };
      g.suggested = options.defaultPath ?? "";
      return { canceled: false, filePath: picked };
    }) as typeof dialog.showSaveDialog;
  }, filePath);
  return () => app.evaluate(() => (globalThis as unknown as { suggested: string }).suggested);
}

test("File > New Document creates an empty file where the person chose, opens it and saves what they type", async () => {
  const run = await openText("First.\n");
  const target = join(run.folder, "Ideas");
  const suggested = await chooseInSaveDialog(run.app, target);
  await clickMenu(run.app, "new-document");
  // No extension typed, so Corillo adds .md.
  const file = `${target}.md`;
  await expect.poll(() => existsSync(file)).toBe(true);
  // It suggests the folder of the document worked on last.
  expect(await suggested()).toBe(join(run.folder, "Untitled.md"));
  await expect.poll(async () => (await tabState(run.page)).active).toBe("Ideas.md");
  expect((await tabState(run.page)).names).toEqual(["proposal.md", "Ideas.md"]);
  await run.page.locator(".doc:not([hidden]) .ProseMirror").click();
  await settle(run.page);
  await run.page.keyboard.type("A fresh start.");
  await expect.poll(() => readFileSync(file, "utf8")).toBe("A fresh start.\n");
  expect(run.text()).toBe("First.\n");
  await run.app.close();
});

test("File > New Document named like a Word document makes a Markdown one: Plan.docx is made as Plan.md, and no Word file is made (B5-05)", async () => {
  const run = await openText("First.\n");
  await chooseInSaveDialog(run.app, join(run.folder, "Plan.docx"));
  await clickMenu(run.app, "new-document");
  const made = join(run.folder, "Plan.md");
  await expect.poll(() => existsSync(made)).toBe(true);
  await expect.poll(async () => (await tabState(run.page)).active).toBe("Plan.md");
  expect(readFileSync(made, "utf8")).toBe("");
  expect(existsSync(join(run.folder, "Plan.docx"))).toBe(false);
  // A dot in the name isn't an ending: .md is added.
  await chooseInSaveDialog(run.app, join(run.folder, "Notes 11.11"));
  await clickMenu(run.app, "new-document");
  await expect.poll(async () => (await tabState(run.page)).active).toBe("Notes 11.11.md");
  expect(existsSync(join(run.folder, "Notes 11.11"))).toBe(false);
  await run.app.close();
});

test("File > New Document never empties a file that's already there", async () => {
  const run = await openText("First.\n");
  const existing = join(run.folder, "notes.md");
  writeFileSync(existing, "Keep me.\n");
  await chooseInSaveDialog(run.app, existing);
  await run.app.evaluate(({ dialog }) => {
    const g = globalThis as unknown as { told: string };
    dialog.showMessageBox = (async (...args: unknown[]) => {
      g.told = (args[args.length - 1] as { message: string }).message;
      return { response: 0, checkboxChecked: false };
    }) as typeof dialog.showMessageBox;
  });
  await clickMenu(run.app, "new-document");
  await expect
    .poll(() => run.app.evaluate(() => (globalThis as unknown as { told?: string }).told))
    .toBe("There's already a file called notes.md there.");
  expect(readFileSync(existing, "utf8")).toBe("Keep me.\n");
  expect((await tabState(run.page)).names).toEqual(["proposal.md"]);
  await run.app.close();
});

test("the start screen's New document button creates and opens a document", async () => {
  const run = await openText("First.\n");
  await clickMenu(run.app, "close-tab");
  await expect(run.page.locator("#empty")).toBeVisible();
  const target = join(run.folder, "Fresh.md");
  await chooseInSaveDialog(run.app, target);
  await run.page.getByRole("button", { name: "New document…" }).click();
  await expect.poll(() => existsSync(target)).toBe(true);
  expect(readFileSync(target, "utf8")).toBe("");
  await expect.poll(() => tabState(run.page)).toEqual({ names: ["Fresh.md"], active: "Fresh.md" });
  await expect(run.page.locator("#empty")).toBeHidden();
  await run.app.close();
});

test("cancelling File > New Document creates nothing", async () => {
  const run = await openText("First.\n");
  await run.app.evaluate(({ dialog }) => {
    dialog.showSaveDialog = (async () => ({ canceled: true, filePath: "" })) as typeof dialog.showSaveDialog;
  });
  await clickMenu(run.app, "new-document");
  await run.page.waitForTimeout(300);
  expect(existsSync(join(run.folder, "Untitled.md"))).toBe(false);
  expect((await tabState(run.page)).names).toEqual(["proposal.md"]);
  await run.app.close();
});

test("a new document made where a deleted one used to be starts clean: no old comments, no old history", async () => {
  const run = await openText("Old words here.\n", { name: "Untitled.md" });
  const { page } = run;
  await selectText(page, "words");
  await page.keyboard.press("Meta+Alt+m");
  await page.keyboard.type("A comment on the old document.");
  await page.keyboard.press("Meta+Enter");
  await expect(page.locator(".comment-card:not(.draft)")).toHaveCount(1);
  await clickMenu(run.app, "close-tab");
  await expect(page.locator("#empty")).toBeVisible();
  unlinkSync(run.file); // deleted in Finder
  await chooseInSaveDialog(run.app, run.file);
  await clickMenu(run.app, "new-document");
  await expect.poll(async () => (await tabState(page)).active).toBe("Untitled.md");
  await settle(page);
  await expect(page.locator(".comment-card")).toHaveCount(0);
  await expect(page.locator("#comments-toggle")).toBeHidden();
  await page.getByRole("button", { name: "History", exact: true }).click();
  await expect(page.locator(".doc:not([hidden]) .history-who")).toHaveText(["First version"]);
  await run.app.close();
});
