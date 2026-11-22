// Step 1: opening a document, seeing it formatted, and saving automatically.
// Each test runs the real app on a copy of a document, with a throwaway data
// folder.
import { test, expect, type ElectronApplication, type Page } from "@playwright/test";
import { mkdtempSync, copyFileSync, readFileSync, writeFileSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ONE_SCALE, launch } from "./helpers";

const FIXTURE = join(import.meta.dirname, "..", "fixtures", "proposal.md");
const ORIGINAL = readFileSync(FIXTURE, "utf8");

interface Running {
  app: ElectronApplication;
  page: Page;
  file: string;
  dataDir: string;
}

async function openCopy(): Promise<Running> {
  const work = mkdtempSync(join(tmpdir(), "corillo-doc-"));
  const file = join(work, "proposal.md");
  copyFileSync(FIXTURE, file);
  const dataDir = mkdtempSync(join(tmpdir(), "corillo-data-"));
  // Not a first run, so the "Connect your agents" screen stays away now that every test's Corillo has a stand-in home.
  writeFileSync(join(dataDir, "setup.json"), '{ "connectAgentsOffered": true }\n');
  const { app } = await launch({
    args: [ONE_SCALE, ".", file],
    env: { ...process.env, CORILLO_USER_DATA: dataDir, CORILLO_HIDDEN: "1" },
  });
  const page = await app.firstWindow();
  await page.waitForSelector(".ProseMirror");
  return { app, page, file, dataDir };
}

async function typeAtEndOf(page: Page, paragraphText: string, text: string) {
  await page.locator("p", { hasText: paragraphText }).click();
  await page.keyboard.press("Meta+ArrowRight");
  await page.keyboard.type(text);
}

const fileText = (file: string) => () => readFileSync(file, "utf8");

test("shows the document formatted, like a Word page", async () => {
  const { app, page } = await openCopy();
  await expect(page.locator(".ProseMirror h1")).toHaveText("A shared help desk for the volunteer team");
  await expect(page.locator(".ProseMirror em")).toHaveText("four");
  await expect(page.locator(".ProseMirror strong")).toHaveText("two");
  await expect(page.locator(".ProseMirror li")).toHaveCount(2);
  await expect(page.locator(".ProseMirror table td", { hasText: "Tool A" })).toBeVisible();
  // Not shown formatted: kept exactly, as Markdown.
  await expect(page.locator('pre.raw-block[data-kind="front-matter"]')).toContainText("title: Help desk proposal");
  await expect(page.locator("#word-count")).toHaveText(/\d+ words/);
  await app.close();
});

test("opening and closing without editing leaves the file untouched", async () => {
  const { app, page, file } = await openCopy();
  const before = statSync(file).mtimeMs;
  await expect(page.locator("#save-status")).toHaveText("Saved");
  await page.waitForTimeout(800);
  await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].close());
  await page.waitForEvent("close");
  expect(readFileSync(file, "utf8")).toBe(ORIGINAL);
  expect(statSync(file).mtimeMs).toBe(before);
  await app.close();
});

test("typing saves automatically, and only the edited paragraph changes", async () => {
  const { app, page, file } = await openCopy();
  await typeAtEndOf(page, "Volunteers would answer", " Added text.");
  await expect.poll(fileText(file)).toBe(ORIGINAL.replace("faster.", "faster. Added text."));
  await expect(page.locator("#save-status")).toHaveText("Saved");
  await app.close();
});

test("closing the window right after typing still saves", async () => {
  const { app, page, file } = await openCopy();
  await typeAtEndOf(page, "Volunteers would answer", " Last words");
  await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].close());
  await expect.poll(fileText(file)).toBe(ORIGINAL.replace("faster.", "faster. Last words"));
  await app.close();
});

test("quitting right after typing still saves", async () => {
  const { app, page, file } = await openCopy();
  await typeAtEndOf(page, "Volunteers would answer", " Before quitting");
  const exited = new Promise((resolve) => app.process().once("exit", resolve));
  await app.evaluate(({ app: electronApp }) => electronApp.quit());
  await exited;
  expect(readFileSync(file, "utf8")).toBe(ORIGINAL.replace("faster.", "faster. Before quitting"));
});

test("undo brings the file back to exactly what it was", async () => {
  const { app, page, file } = await openCopy();
  await typeAtEndOf(page, "Volunteers would answer", "xyz");
  await expect.poll(fileText(file)).toContain("faster.xyz");
  await page.keyboard.press("Meta+z");
  await expect.poll(fileText(file)).toBe(ORIGINAL);
  await app.close();
});

test("bold and italic shortcuts work while typing", async () => {
  const { app, page, file } = await openCopy();
  await page.locator("p", { hasText: "Volunteers would answer" }).click();
  await page.keyboard.press("Meta+ArrowRight");
  await page.keyboard.type(" ");
  await page.keyboard.press("Meta+b");
  await page.keyboard.type("bold");
  await page.keyboard.press("Meta+b");
  await page.keyboard.type(" and ");
  await page.keyboard.press("Meta+i");
  await page.keyboard.type("italic");
  await expect.poll(fileText(file)).toContain("faster. **bold** and *italic*");
  await app.close();
});

test("a change made outside Corillo shows up when nothing is unsaved", async () => {
  const { app, page, file } = await openCopy();
  await expect(page.locator("#save-status")).toHaveText("Saved");
  writeFileSync(file, ORIGINAL.replace("Volunteers would answer people faster.", "Changed by an agent."));
  await expect(page.locator(".ProseMirror p", { hasText: "Changed by an agent." })).toBeVisible();
  await expect(page.locator(".conflict")).toBeHidden();
  await app.close();
});

test("an outside change is never overwritten by an autosave", async () => {
  const { app, page, file } = await openCopy();
  const theirs = ORIGINAL.replace("faster.", "faster. Theirs.");
  writeFileSync(file, theirs);
  // Save immediately, before the window has heard about the outside change.
  const id = await page.locator(".doc").getAttribute("data-doc-id");
  const result = await page.evaluate((docId) => window.corillo.save(docId!, "mine"), id);
  expect(result.ok).toBe(false);
  expect(readFileSync(file, "utf8")).toBe(theirs);
  await app.close();
});

test("when both sides changed, the person chooses which version to keep", async () => {
  const { app, page, file } = await openCopy();
  // The person types, and the file changes outside Corillo before the
  // autosave runs. Corillo must ask rather than overwrite.
  await typeAtEndOf(page, "Volunteers would answer", " Mine.");
  writeFileSync(file, ORIGINAL.replace("faster.", "faster. Theirs."));
  await expect(page.locator(".conflict")).toBeVisible();
  await expect(page.locator("#save-status")).toHaveText(/Not saved/);
  await page.getByRole("button", { name: "Keep my version" }).click();
  await expect.poll(fileText(file)).toContain("Mine.");
  await expect(page.locator(".conflict")).toBeHidden();
  await app.close();
});

test("uses its own data folder, never another app's", async () => {
  const { app, dataDir } = await openCopy();
  const info = await app.evaluate(({ app: a }) => ({ name: a.getName(), data: a.getPath("userData") }));
  expect(info.name).toBe("Corillo");
  expect(info.data).toBe(dataDir);
  await app.close();
});
