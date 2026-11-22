// A document's comments and history stay with it when it's renamed or moved
// outside Corillo (in Finder, with mv or git, by another app), whether it's
// open at the time or not. Other apps saving by replacing the file are just
// changes. A document moved to the Trash while open closes, unless that
// would lose words. Each test runs the real app, hidden, on throwaway
// documents and a throwaway data folder. The Trash here is a pretend one: a
// folder named .Trash beside the document, which Corillo treats as the Mac's
// own Trash, so the tests never put anything in the real one.
import { test, expect, type ElectronApplication, type Page } from "@playwright/test";
import { chmodSync, copyFileSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, renameSync, unlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { gzipSync } from "node:zlib";
import { ONE_SCALE, openText, cursorAtEnd, captureClipboard, clickMenu, expectFile, openFromFinder, settle, tabState, launch } from "./helpers";
import { AgentSession } from "./agent-session";

const BANNER = ".doc:not([hidden]) .banner";
const STATUS = "#save-status";
const PANEL = ".doc:not([hidden]) aside.comments-panel";
const NOTICE = ".file-notice";

const card = (page: Page, text: string) => page.locator(`${PANEL} .comment-card:not(.draft)`, { hasText: text });
const title = (app: ElectronApplication) => app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].getTitle());
const frontId = (page: Page) => page.locator(".doc:not([hidden])").getAttribute("data-doc-id");

/** A comment on the whole document, as the panel would post it. */
async function comment(run: { page: Page }, body: string): Promise<void> {
  const id = await frontId(run.page);
  await run.page.evaluate(
    async ({ id, body }) => {
      const r = await window.corillo.addComment(id!, body, null, null);
      if (!r.ok) throw new Error(r.error);
    },
    { id, body },
  );
  await expect(card(run.page, body)).toBeVisible();
}

/** How many versions the front document's history has. */
async function versionCount(page: Page): Promise<number> {
  const id = await frontId(page);
  return page.evaluate(async (docId) => (await window.corillo.historyList(docId!)).versions.length, id);
}

/** Run Corillo again on a file, with the same data folder: what it remembers. */
async function relaunch(dataDir: string, file: string): Promise<{ app: ElectronApplication; page: Page }> {
  const home = mkdtempSync(join(tmpdir(), "corillo-home-"));
  const { app } = await launch({
    args: [ONE_SCALE, ".", file],
    env: { ...process.env, CORILLO_USER_DATA: dataDir, CORILLO_HIDDEN: "1", CORILLO_HOME: home },
  });
  const page = await app.firstWindow();
  await page.waitForSelector(".ProseMirror");
  return { app, page };
}

/** Records, in the window, whether the notice at the top ever shows, from now on. */
async function watchForBanner(page: Page): Promise<() => Promise<boolean>> {
  await page.evaluate((selector) => {
    const g = window as unknown as { bannerShown: boolean };
    g.bannerShown = false;
    const check = () => {
      const b = document.querySelector<HTMLElement>(selector);
      if (b && !b.hidden) g.bannerShown = true;
    };
    new MutationObserver(check).observe(document.body, { attributes: true, subtree: true, attributeFilter: ["hidden"] });
  }, BANNER);
  return () => page.evaluate(() => (window as unknown as { bannerShown: boolean }).bannerShown);
}

/** The person types at the end of the paragraph holding `text`. */
async function typeAfter(page: Page, text: string, typed: string): Promise<void> {
  await cursorAtEnd(page, text);
  await page.keyboard.type(typed);
}

// Renamed or moved while open ---------------------------------------------------------

test("a document renamed in Finder while open: its name, the window's title and Copy Path follow it, the next save goes there, the old name never comes back, and its comments and history stay", async () => {
  const run = await openText("Draft.\n");
  await comment(run, "Keep it short.");
  await typeAfter(run.page, "Draft.", " One.");
  await expectFile(run, "Draft. One.\n");
  const renamed = join(run.folder, "renamed.md");
  renameSync(run.file, renamed);
  await expect.poll(() => title(run.app)).toBe("renamed");
  await expect.poll(async () => (await tabState(run.page)).names).toEqual(["renamed.md"]);
  await expect(run.page.locator(BANNER)).toBeHidden();
  const copied = await captureClipboard(run.app);
  const id = await frontId(run.page);
  await run.page.evaluate((docId) => window.corillo.copyPath(docId!), id);
  expect(await copied()).toBe(renamed);
  await typeAfter(run.page, "Draft. One.", " Two.");
  await expect.poll(() => readFileSync(renamed, "utf8")).toBe("Draft. One. Two.\n");
  await expect(run.page.locator(STATUS)).toHaveText("Saved");
  expect(existsSync(run.file)).toBe(false);
  await expect(card(run.page, "Keep it short.")).toBeVisible();
  expect(await versionCount(run.page)).toBe(2);
  await run.app.close();
  // Opened again from its new name: the same comments and history.
  const again = await relaunch(run.dataDir, renamed);
  await expect(card(again.page, "Keep it short.")).toBeVisible();
  expect(await versionCount(again.page)).toBe(2);
  await again.app.close();
});

test("a document moved to another folder while open follows it there: the next save goes to the new folder, and its comments stay", async () => {
  const run = await openText("Draft.\n");
  await comment(run, "Keep it short.");
  const elsewhere = join(run.folder, "Archive");
  mkdirSync(elsewhere);
  const moved = join(elsewhere, "proposal.md");
  renameSync(run.file, moved);
  await expect.poll(async () => {
    const id = await frontId(run.page);
    const copied = await captureClipboard(run.app);
    await run.page.evaluate((docId) => window.corillo.copyPath(docId!), id);
    return copied();
  }).toBe(moved);
  await expect(run.page.locator(BANNER)).toBeHidden();
  await typeAfter(run.page, "Draft.", " Moved.");
  await expect.poll(() => readFileSync(moved, "utf8")).toBe("Draft. Moved.\n");
  expect(existsSync(run.file)).toBe(false);
  await expect(card(run.page, "Keep it short.")).toBeVisible();
  await run.app.close();
});

test("a document whose folder is renamed while open follows it, by the time the person types", async () => {
  const run = await openText("Draft.\n");
  await comment(run, "Keep it short.");
  const folder = `${run.folder} renamed`;
  renameSync(run.folder, folder);
  const moved = join(folder, "proposal.md");
  await typeAfter(run.page, "Draft.", " Typed.");
  await expect.poll(() => readFileSync(moved, "utf8"), { timeout: 10_000 }).toBe("Draft. Typed.\n");
  expect(existsSync(run.file)).toBe(false);
  await expect(card(run.page, "Keep it short.")).toBeVisible();
  await run.app.close();
});

test("an agent working on a document that's renamed mid-pass carries on: the old path still works, it's told the new one, and its change goes to the new file", async () => {
  const run = await openText("# Plan\n\nWe should hire two people.\n", { name: "plan.md" });
  const { session } = await AgentSession.start(run.dataDir);
  await session.ok("take_document", { path: run.file });
  const renamed = join(run.folder, "plan v2.md");
  renameSync(run.file, renamed);
  await expect.poll(() => title(run.app)).toBe("plan v2");
  const edit = await session.ok("edit_document", { path: run.file, edits: [{ find: "two people", replace: "three people" }] });
  expect(edit).toContain(renamed);
  expect(readFileSync(renamed, "utf8")).toBe("# Plan\n\nWe should hire three people.\n");
  expect(existsSync(run.file)).toBe(false);
  await session.ok("finish_editing", { path: renamed });
  const listed = await session.ok("list_documents");
  expect(listed).toContain(renamed);
  expect(listed).not.toContain(`${run.file} `);
  await run.app.close();
  await session.stop();
});

// Renamed or moved in Corillo (File > Rename or Move…, Save somewhere else…) ------------------

/** Pretend the person picks this place in the next save panel, and answer every question with its first button, noting it. */
async function pickAndNote(app: ElectronApplication, picked: string): Promise<() => Promise<string[]>> {
  await app.evaluate(({ dialog }, chosen) => {
    const g = globalThis as unknown as { asked: string[] };
    g.asked = [];
    dialog.showSaveDialog = (async () => ({ canceled: false, filePath: chosen })) as typeof dialog.showSaveDialog;
    dialog.showMessageBox = (async (_w: unknown, options: { message: string; detail?: string }) => {
      g.asked.push(`${options.message} ${options.detail ?? ""}`.trim());
      return { response: 0, checkboxChecked: false };
    }) as unknown as typeof dialog.showMessageBox;
  }, picked);
  return () => app.evaluate(() => (globalThis as unknown as { asked: string[] }).asked);
}

test("after File > Rename or Move…, an agent still using the old path reaches the document and is told its new place", async () => {
  const run = await openText("# Plan\n\nWe should hire two people.\n", { name: "plan.md" });
  const { session } = await AgentSession.start(run.dataDir);
  await session.ok("read_document", { path: run.file });
  const target = join(run.folder, "Q3 plan.md");
  await pickAndNote(run.app, target);
  await clickMenu(run.app, "rename");
  await expect.poll(async () => (await tabState(run.page)).names).toEqual(["Q3 plan.md"]);
  const taken = await session.ok("take_document", { path: run.file });
  expect(taken).toContain(`It's now ${target}: use that path from now on.`);
  await session.ok("edit_document", { path: run.file, edits: [{ find: "two people", replace: "three people" }] });
  await expect.poll(() => readFileSync(target, "utf8")).toBe("# Plan\n\nWe should hire three people.\n");
  expect(existsSync(run.file)).toBe(false);
  await session.ok("finish_editing", { path: target });
  await run.app.close();
  await session.stop();
});

test("after Save somewhere else… for a deleted document, an agent using the old path reaches it in its new place", async () => {
  const run = await openText("# Plan\n\nSaved elsewhere.\n", { name: "plan.md" });
  const { session } = await AgentSession.start(run.dataDir);
  await session.ok("read_document", { path: run.file });
  unlinkSync(run.file);
  await expect(run.page.locator(BANNER)).toBeVisible();
  const target = join(run.folder, "kept.md");
  await pickAndNote(run.app, target);
  await run.page.getByRole("button", { name: "Save somewhere else…" }).click();
  await expect.poll(async () => (await tabState(run.page)).names).toEqual(["kept.md"]);
  const read = await session.ok("read_document", { path: run.file });
  expect(read).toContain(`It's now ${target}: use that path from now on.`);
  await run.app.close();
  await session.stop();
});

test("words typed before Save somewhere else… are in the history's newest version, as the person's own", async () => {
  const run = await openText("# Plan\n\nWe should hire two people.\n", { name: "plan.md" });
  unlinkSync(run.file);
  await expect(run.page.locator(BANNER)).toBeVisible();
  await typeAfter(run.page, "We should hire two people.", " And rent an office.");
  const target = join(run.folder, "kept.md");
  await pickAndNote(run.app, target);
  await run.page.getByRole("button", { name: "Save somewhere else…" }).click();
  await expect.poll(async () => (await tabState(run.page)).names).toEqual(["kept.md"]);
  expect(readFileSync(target, "utf8")).toBe("# Plan\n\nWe should hire two people. And rent an office.\n");
  const { session } = await AgentSession.start(run.dataDir);
  const versions = await session.ok("list_versions", { path: target });
  expect(versions).not.toMatch(/outside Corillo/i);
  const newest = Number(/version (\d+)/i.exec(versions)?.[1]);
  expect(await session.ok("read_version", { path: target, version: newest })).toContain("And rent an office.");
  await run.app.close();
  await session.stop();
});

test("Save somewhere else… from the Markdown view keeps Undo: back in the Formatted view, Undo takes back the last typing (S21-T1)", async () => {
  const run = await openText("# Plan\n\nWe should hire two people.\n", { name: "plan.md" });
  await typeAfter(run.page, "We should hire two people.", " And more.");
  await expectFile(run, "# Plan\n\nWe should hire two people. And more.\n");
  unlinkSync(run.file);
  await expect(run.page.locator(BANNER)).toBeVisible();
  await run.page.getByRole("button", { name: "Markdown", exact: true }).click();
  await expect(run.page.locator(".doc:not([hidden]) textarea.source")).toBeVisible();
  const target = join(run.folder, "kept.md");
  await pickAndNote(run.app, target);
  await run.page.getByRole("button", { name: "Save somewhere else…" }).click();
  await expect.poll(async () => (await tabState(run.page)).names).toEqual(["kept.md"]);
  expect(readFileSync(target, "utf8")).toBe("# Plan\n\nWe should hire two people. And more.\n");
  await run.page.getByRole("button", { name: "Formatted", exact: true }).click();
  await run.page.locator(".doc:not([hidden]) .page.editor p", { hasText: "And more." }).click();
  await settle(run.page);
  await run.page.keyboard.press("Meta+z");
  await expect.poll(() => readFileSync(target, "utf8"), { timeout: 4000 }).toBe("# Plan\n\nWe should hire two people.\n");
  await run.app.close();
});

test("File > Rename or Move… into a folder Corillo can't change says so plainly, and the document stays where it was", async () => {
  const run = await openText("Plan.\n", { name: "plan.md" });
  const locked = join(run.folder, "Locked");
  mkdirSync(locked);
  chmodSync(locked, 0o555);
  try {
    const asked = await pickAndNote(run.app, join(locked, "plan.md"));
    await clickMenu(run.app, "rename");
    await expect.poll(asked).toEqual(["Corillo couldn't move plan. Corillo isn't allowed to change this file or its folder."]);
    expect(existsSync(run.file)).toBe(true);
    expect((await tabState(run.page)).names).toEqual(["plan.md"]);
    await typeAfter(run.page, "Plan.", " Still here.");
    await expectFile(run, "Plan. Still here.\n");
  } finally {
    chmodSync(locked, 0o755);
  }
  await run.app.close();
});

test("File > Rename or Move… to another drive that copies the file but can't remove the original says the original is still there, and works on the copy", async () => {
  const run = await openText("Plan.\n", { name: "plan.md" });
  const target = join(run.folder, "Other drive", "plan.md");
  mkdirSync(join(run.folder, "Other drive"));
  // As on another drive: no plain rename, so Corillo copies; and the original can't be removed (say it's locked).
  await run.app.evaluate((_electron, original) => {
    const fs = (process as unknown as { mainModule: { require(id: string): typeof import("node:fs") } }).mainModule.require("fs");
    const g = globalThis as unknown as { putBack: () => void };
    const { renameSync, rmSync } = fs;
    fs.renameSync = ((from: string, to: string) => {
      if (from === original) throw Object.assign(new Error("cross-device link not permitted"), { code: "EXDEV" });
      return renameSync(from, to);
    }) as typeof fs.renameSync;
    fs.rmSync = ((p: string, options?: object) => {
      if (p === original) throw Object.assign(new Error("operation not permitted"), { code: "EPERM" });
      return rmSync(p, options);
    }) as typeof fs.rmSync;
    g.putBack = () => Object.assign(fs, { renameSync, rmSync });
  }, run.file);
  try {
    const asked = await pickAndNote(run.app, target);
    await clickMenu(run.app, "rename");
    await expect.poll(asked).toEqual([
      "plan was copied to its new place, but Corillo couldn't remove the original. The original is still where it was. Corillo works on the copy in the new place from now on.",
    ]);
    await expect.poll(async () => (await tabState(run.page)).names).toEqual(["plan.md"]);
    expect(readFileSync(target, "utf8")).toBe("Plan.\n");
    await typeAfter(run.page, "Plan.", " On the copy.");
    await expect.poll(() => readFileSync(target, "utf8")).toBe("Plan. On the copy.\n");
    expect(readFileSync(run.file, "utf8")).toBe("Plan.\n");
    expect(await run.app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].getRepresentedFilename())).toBe(target);
  } finally {
    await run.app.evaluate(() => (globalThis as unknown as { putBack: () => void }).putBack());
  }
  await run.app.close();
});

test("File > Rename or Move… can change only the capitals of a name (plan.md to Plan.md)", async () => {
  const run = await openText("Plan.\n", { name: "plan.md" });
  const target = join(run.folder, "Plan.md");
  const asked = await pickAndNote(run.app, target);
  await clickMenu(run.app, "rename");
  await expect.poll(async () => (await tabState(run.page)).names).toEqual(["Plan.md"]);
  expect(readdirSync(run.folder)).toEqual(["Plan.md"]);
  expect(await asked()).toEqual([]);
  await typeAfter(run.page, "Plan.", " Renamed.");
  await expect.poll(() => readFileSync(target, "utf8")).toBe("Plan. Renamed.\n");
  expect(readdirSync(run.folder)).toEqual(["Plan.md"]);
  await run.app.close();
});

// Renamed or moved while closed ---------------------------------------------------------

test("a document renamed while Corillo was closed, then opened from its new name, has its comments and history", async () => {
  const run = await openText("Draft.\n");
  await comment(run, "Keep it short.");
  await typeAfter(run.page, "Draft.", " One.");
  await expectFile(run, "Draft. One.\n");
  await run.app.close();
  const moved = join(run.folder, "Archive", "renamed.md");
  mkdirSync(join(run.folder, "Archive"));
  renameSync(run.file, moved); // as Finder, mv or git mv would
  const again = await relaunch(run.dataDir, moved);
  await expect(card(again.page, "Keep it short.")).toBeVisible();
  expect(await versionCount(again.page)).toBe(2);
  await again.app.close();
});

test("a document moved to another drive while Corillo was closed (a new file there, the old one gone) is recognised by its text and has its comments", async () => {
  const run = await openText("A plan with enough words to know it by.\n");
  await comment(run, "Keep it short.");
  await run.app.close();
  // Another drive gives the file a new identity on disk: a copy, then the original removed.
  const other = mkdtempSync(join(tmpdir(), "corillo-other-drive-"));
  const moved = join(other, "proposal.md");
  copyFileSync(run.file, moved);
  unlinkSync(run.file);
  const again = await relaunch(run.dataDir, moved);
  await expect(card(again.page, "Keep it short.")).toBeVisible();
  await again.app.close();
});

test("a copy of a document opened while the original is still there is a new document, with no comments", async () => {
  const run = await openText("A plan with enough words to know it by.\n");
  await comment(run, "Keep it short.");
  await run.app.close();
  const copy = join(run.folder, "proposal copy.md");
  copyFileSync(run.file, copy);
  const again = await relaunch(run.dataDir, copy);
  await expect(again.page.locator(`${PANEL} .comments-empty`)).toBeVisible();
  await again.app.close();
});

test("a document moved to another drive while open, then opened from there, comes back in the same tab with its comments", async () => {
  const run = await openText("A plan with enough words to know it by.\n");
  await comment(run, "Keep it short.");
  const other = mkdtempSync(join(tmpdir(), "corillo-other-drive-"));
  const moved = join(other, "proposal.md");
  copyFileSync(run.file, moved);
  unlinkSync(run.file);
  await expect(run.page.locator(BANNER)).toContainText("deleted outside Corillo");
  await openFromFinder(run.app, moved);
  await expect(run.page.locator(".doc")).toHaveCount(1);
  await expect(run.page.locator(BANNER)).toBeHidden();
  await expect(card(run.page, "Keep it short.")).toBeVisible();
  await typeAfter(run.page, "A plan with enough words to know it by.", " More.");
  await expect.poll(() => readFileSync(moved, "utf8")).toBe("A plan with enough words to know it by. More.\n");
  expect(existsSync(run.file)).toBe(false);
  await run.app.close();
});

// Other apps saving by replacing the file ------------------------------------------------

test("another app saving by writing a new file and putting it in the document's place is a change to the same document, and later renames are still followed", async () => {
  const run = await openText("Draft.\n");
  await comment(run, "Keep it short.");
  const shown = await watchForBanner(run.page);
  const temp = join(run.folder, ".proposal.md.tmp-123");
  writeFileSync(temp, "Changed by another app.\n");
  renameSync(temp, run.file);
  await expect(run.page.locator(".doc:not([hidden]) .page.editor")).toContainText("Changed by another app.");
  await expect(card(run.page, "Keep it short.")).toBeVisible();
  expect(await shown()).toBe(false);
  // It's still the same document to Corillo: a rename afterwards is followed too.
  const renamed = join(run.folder, "renamed.md");
  renameSync(run.file, renamed);
  await expect.poll(() => title(run.app)).toBe("renamed");
  await typeAfter(run.page, "Changed by another app.", " Mine.");
  await expect.poll(() => readFileSync(renamed, "utf8")).toBe("Changed by another app. Mine.\n");
  expect(await shown()).toBe(false);
  await run.app.close();
});

test("another app deleting the document and writing it again a moment later is a change, never a deletion: no notice, nothing closes", async () => {
  const run = await openText("Draft.\n");
  await comment(run, "Keep it short.");
  const shown = await watchForBanner(run.page);
  unlinkSync(run.file);
  await run.page.waitForTimeout(500);
  writeFileSync(run.file, "Written again.\n");
  await expect(run.page.locator(".doc:not([hidden]) .page.editor")).toContainText("Written again.");
  await run.page.waitForTimeout(1500);
  expect(await shown()).toBe(false);
  await expect(run.page.locator(".doc")).toHaveCount(1);
  await expect(card(run.page, "Keep it short.")).toBeVisible();
  await run.app.close();
});

test("an app that keeps a backup (moving the document aside, then writing it anew) leaves the tab on the document, not the backup", async () => {
  const run = await openText("Draft.\n");
  const shown = await watchForBanner(run.page);
  renameSync(run.file, `${run.file}~`);
  await run.page.waitForTimeout(400);
  writeFileSync(run.file, "Saved by the other app.\n");
  await expect(run.page.locator(".doc:not([hidden]) .page.editor")).toContainText("Saved by the other app.");
  await run.page.waitForTimeout(1500);
  expect(await title(run.app)).toBe("proposal");
  expect(await shown()).toBe(false);
  await typeAfter(run.page, "Saved by the other app.", " Mine.");
  await expectFile(run, "Saved by the other app. Mine.\n");
  expect(readFileSync(`${run.file}~`, "utf8")).toBe("Draft.\n");
  await run.app.close();
});

// The Trash -------------------------------------------------------------------------------

test("a document moved to the Trash while open, with nothing unsaved, closes, and the window says it went to the Trash", async () => {
  const run = await openText("Draft.\n");
  await comment(run, "Keep it short.");
  const trash = join(run.folder, ".Trash");
  mkdirSync(trash);
  renameSync(run.file, join(trash, "proposal.md"));
  await expect(run.page.locator(".doc")).toHaveCount(0);
  await expect(run.page.locator("#empty")).toBeVisible();
  await expect(run.page.locator(NOTICE)).toContainText("proposal was moved to the Trash, so Corillo closed it.");
  await run.page.locator(`${NOTICE} button[aria-label="Close"]`).click();
  await expect(run.page.locator(NOTICE)).toBeHidden();
  // Put back from the Trash and opened again: its comments are back.
  renameSync(join(trash, "proposal.md"), run.file);
  await run.page.evaluate((p) => window.corillo.openPath(p), run.file);
  await expect(card(run.page, "Keep it short.")).toBeVisible();
  await run.app.close();
});

test("a document moved to the Trash with edits not yet saved stays open, says it's in the Trash, and can be saved somewhere else", async () => {
  const run = await openText("Draft.\n");
  await comment(run, "Keep it short.");
  chmodSync(run.file, 0o444); // locked, so the edit can't be saved
  await typeAfter(run.page, "Draft.", " Not saved yet.");
  await expect(run.page.locator(STATUS)).toHaveText(/Not saved: the file is read-only/);
  const trash = join(run.folder, ".Trash");
  mkdirSync(trash);
  renameSync(run.file, join(trash, "proposal.md"));
  await expect(run.page.locator(BANNER)).toContainText("This document was moved to the Trash");
  await expect(run.page.locator(STATUS)).toHaveText("Not saved: the file is in the Trash");
  await expect(run.page.locator(".doc")).toHaveCount(1);
  await expect(run.page.locator(".doc:not([hidden]) .page.editor")).toContainText("Draft. Not saved yet.");
  const elsewhere = join(run.folder, "kept.md");
  await run.app.evaluate(({ dialog }, picked) => {
    dialog.showSaveDialog = (async () => ({ canceled: false, filePath: picked })) as typeof dialog.showSaveDialog;
  }, elsewhere);
  await run.page.locator(BANNER).getByRole("button", { name: "Save somewhere else…" }).click();
  await expect.poll(() => existsSync(elsewhere) && readFileSync(elsewhere, "utf8")).toBe("Draft. Not saved yet.\n");
  await expect.poll(async () => (await tabState(run.page)).names).toEqual(["kept.md"]);
  await expect(run.page.locator(BANNER)).toBeHidden();
  await expect(card(run.page, "Keep it short.")).toBeVisible();
  expect(readFileSync(join(trash, "proposal.md"), "utf8")).toBe("Draft.\n");
  await run.app.close();
});

test("a document in the Trash with edits not yet saved can be closed from its notice, after a question that keeps the words if the person wants", async () => {
  const run = await openText("Draft.\n");
  chmodSync(run.file, 0o444);
  await typeAfter(run.page, "Draft.", " Not saved yet.");
  await expect(run.page.locator(STATUS)).toHaveText(/Not saved: the file is read-only/);
  const trash = join(run.folder, ".Trash");
  mkdirSync(trash);
  renameSync(run.file, join(trash, "proposal.md"));
  await expect(run.page.locator(BANNER)).toContainText("moved to the Trash");
  const asked: string[] = [];
  await run.app.evaluate(({ dialog }) => {
    const g = globalThis as unknown as { asked: string[] };
    g.asked = [];
    dialog.showMessageBox = (async (_w: unknown, options: { message: string; buttons: string[] }) => {
      g.asked.push(options.message);
      return { response: options.buttons.indexOf("Don't Save"), checkboxChecked: false };
    }) as unknown as typeof dialog.showMessageBox;
  });
  await run.page.locator(BANNER).getByRole("button", { name: "Close" }).click();
  await expect(run.page.locator(".doc")).toHaveCount(0);
  asked.push(...(await run.app.evaluate(() => (globalThis as unknown as { asked: string[] }).asked)));
  expect(asked).toEqual(["proposal is in the Trash."]);
  await run.app.close();
});

// Deleted outright -------------------------------------------------------------------------

test("a document deleted outright while open (not to the Trash) stays open with its text, and says it was deleted", async () => {
  const run = await openText("Keep this.\n");
  unlinkSync(run.file);
  await expect(run.page.locator(BANNER)).toContainText("This document was deleted outside Corillo. Your text is still here.");
  await expect(run.page.locator(STATUS)).toHaveText("Not saved: the file was deleted");
  await expect(run.page.locator(".doc")).toHaveCount(1);
  await run.page.waitForTimeout(1000);
  expect(existsSync(run.file)).toBe(false);
  // Closing asks first, since the window holds the only copy; here the person lets it go.
  await run.app.evaluate(({ dialog }) => {
    dialog.showMessageBox = (async (_w: unknown, options: { buttons: string[] }) => ({
      response: options.buttons.indexOf("Don't Save"),
      checkboxChecked: false,
    })) as unknown as typeof dialog.showMessageBox;
  });
  await run.app.close();
});

test("a document whose folder Corillo is no longer allowed into is out of reach, not deleted, and is back once it's allowed again (A-1)", async () => {
  const run = await openText("Keep this.\n");
  const focus = () => run.app.evaluate(({ app, BrowserWindow }) => app.emit("browser-window-focus", {}, BrowserWindow.getAllWindows()[0]));
  chmodSync(run.folder, 0o000);
  try {
    await focus();
    await expect(run.page.locator(BANNER)).toContainText("The drive or cloud folder this document is on isn't available. Your text is still here.");
  } finally {
    chmodSync(run.folder, 0o755);
  }
  await focus();
  await expect(run.page.locator(BANNER)).toBeHidden();
  await typeAfter(run.page, "Keep this.", " Typed after.");
  await expectFile(run, "Keep this. Typed after.\n");
  await run.app.close();
});

test("a document put away into a hidden folder (a sync tool's cache) or a temporary-items folder is gone, not followed: nothing is saved there", async () => {
  for (const away of [join(".dropbox.cache", "2026-11-09"), "TemporaryItems"]) {
    const run = await openText("Keep this.\n");
    const folder = join(run.folder, away);
    mkdirSync(folder, { recursive: true });
    const cached = join(folder, "proposal.md");
    renameSync(run.file, cached);
    await expect(run.page.locator(BANNER), away).toContainText("This document was deleted outside Corillo. Your text is still here.");
    await typeAfter(run.page, "Keep this.", " Typed after.");
    await expect(run.page.locator(STATUS)).toHaveText("Not saved: the file was deleted");
    await run.page.waitForTimeout(1000);
    expect(readFileSync(cached, "utf8"), away).toBe("Keep this.\n");
    expect(existsSync(run.file)).toBe(false);
    await run.app.evaluate(({ dialog }) => {
      dialog.showMessageBox = (async (_w: unknown, options: { buttons: string[] }) => ({
        response: options.buttons.indexOf("Don't Save"),
        checkboxChecked: false,
      })) as unknown as typeof dialog.showMessageBox;
    });
    await run.app.close();
  }
});

test("a document already in a hidden folder is still followed when it's renamed there", async () => {
  const run = await openText("Other.\n");
  const hidden = join(run.folder, ".notes");
  mkdirSync(hidden);
  const plan = join(hidden, "plan.md");
  writeFileSync(plan, "Draft.\n");
  await openFromFinder(run.app, plan);
  await expect.poll(async () => (await tabState(run.page)).active).toBe("plan.md");
  const renamed = join(hidden, "renamed.md");
  renameSync(plan, renamed);
  await expect.poll(async () => (await tabState(run.page)).names).toEqual(["proposal.md", "renamed.md"]);
  await typeAfter(run.page, "Draft.", " Two.");
  await expect.poll(() => readFileSync(renamed, "utf8")).toBe("Draft. Two.\n");
  await run.app.close();
});

// Gone for 30 days -------------------------------------------------------------------------

test("at launch, Corillo clears the comments and history of a document gone for 30 days, and keeps those of one gone for less", async () => {
  const dataDir = mkdtempSync(join(tmpdir(), "corillo-data-"));
  writeFileSync(join(dataDir, "setup.json"), '{ "connectAgentsOffered": true }\n');
  const folder = mkdtempSync(join(tmpdir(), "corillo-doc-"));
  const day = 24 * 60 * 60 * 1000;
  const now = Date.now();
  const record = (name: string, daysGone: number) => ({
    path: join(folder, name),
    ino: 1,
    dev: 1,
    missing: { counted: daysGone * day, at: now - 60_000 },
  });
  writeFileSync(join(dataDir, "documents.json"), JSON.stringify({ old: record("old.md", 31), recent: record("recent.md", 3) }));
  for (const id of ["old", "recent"]) {
    mkdirSync(join(dataDir, "documents", id), { recursive: true });
    writeFileSync(join(dataDir, "documents", id, "comments.json.gz"), gzipSync("[]"));
  }
  const open = join(folder, "open.md");
  writeFileSync(open, "Here.\n");
  const run = await relaunch(dataDir, open);
  // Looked at a moment after the window shows, so it never holds up the first document.
  await expect.poll(() => existsSync(join(dataDir, "documents", "old")), { timeout: 10_000 }).toBe(false);
  expect(existsSync(join(dataDir, "documents", "recent"))).toBe(true);
  const index = JSON.parse(readFileSync(join(dataDir, "documents.json"), "utf8")) as Record<string, unknown>;
  expect(Object.keys(index)).not.toContain("old");
  expect(Object.keys(index)).toContain("recent");
  await run.app.close();
});

