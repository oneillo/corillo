// The safety net (roadmap Batch 14, item 1): Corillo never writes a file that
// has lost words the page holds. A fault planted in how a save writes the page
// stands in for a bug: where the block can be written the careful way it's
// repaired, otherwise the save is refused, the file stays as it was, the words
// stay on the page and in the edits kept for recovery, and one notice says so.
// Every way a document gets written goes through the net. And the page half
// (F-1's kind): through a whole review round on a long document, every word
// the file holds is drawn on the page.
import { test, expect, type ElectronApplication, type Page } from "@playwright/test";
import { chmodSync, existsSync, mkdtempSync, readFileSync, readdirSync, rmSync, unlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { clickMenu, cursorAtEnd, expectFile, openText, selectText, settle, EDITOR, ONE_SCALE, type Running, launch } from "./helpers";
import { AgentSession } from "./agent-session";
import { bigDocument } from "../fixtures/big-document";
import { parseMarkdown } from "../../src/core/markdown";
import { missingWords } from "../../src/core/write-check";
import type { PlantedFault } from "../../src/core/write-check";

const STATUS = "#save-status";
const NOTICE = ".doc:not([hidden]) .file-notice:not([hidden])";
const BANNER = ".doc:not([hidden]) .banner.conflict";
const PANEL = ".doc:not([hidden]) aside.comments-panel";
const PLAN = "# Plan\n\nWe should hire **two** people this quarter.\n\nThe budget is tight.\n";

let run: Running | null = null;
const sessions: AgentSession[] = [];
const made: string[] = [];

test.afterEach(async () => {
  for (const s of sessions.splice(0)) await s.stop().catch(() => undefined);
  const r = run;
  run = null;
  if (r) {
    const home = await r.app.evaluate(() => process.env.CORILLO_HOME ?? null).catch(() => null);
    // (A save held back would ask before closing: the test is over, so Corillo just stops.)
    await r.app.evaluate(({ app }) => setTimeout(() => app.exit(0), 10)).catch(() => undefined);
    await r.app.close().catch(() => undefined);
    for (const dir of [r.folder, r.dataDir, home]) if (dir) rmSync(dir, { recursive: true, force: true });
  }
  for (const dir of made.splice(0)) rmSync(dir, { recursive: true, force: true });
});

/** Plant a fault in how the window writes the page (null takes it away). */
function plant(page: Page, fault: PlantedFault | null): Promise<void> {
  return page.evaluate((f) => {
    (window as unknown as { corilloTests: { netFault: unknown } }).corilloTests.netFault = f;
  }, fault);
}

/** Plant a fault in the serializer itself, which everything writing the page passes through, the Markdown view included. */
function plantInSerializer(page: Page, fault: PlantedFault | null): Promise<void> {
  return page.evaluate((f) => {
    (window as unknown as { corilloTests: { serializerFault: unknown } }).corilloTests.serializerFault = f;
  }, fault);
}

/** What the edits kept for recovery hold, all documents together. */
function kept(dataDir: string): string {
  const dir = join(dataDir, "recovery");
  if (!existsSync(dir)) return "";
  return readdirSync(dir)
    .filter((n) => n.endsWith(".json"))
    .map((n) => (JSON.parse(readFileSync(join(dir, n), "utf8")) as { text: string }).text)
    .join("\n");
}

async function start(text = PLAN, name = "plan.md"): Promise<Running> {
  run = await openText(text, { name });
  return run;
}

async function agent(r: Running): Promise<AgentSession> {
  const { session } = await AgentSession.start(r.dataDir, "claude-code");
  sessions.push(session);
  return session;
}

test("a fault that drops a word, or turns a paragraph into a heading, is repaired: the file has every word, and nothing stops the person", async () => {
  const { page } = await start();
  await plant(page, "drop-word");
  await cursorAtEnd(page, "people this quarter.");
  await page.keyboard.type(" Soon");
  // Written the careful way: the same words and bold, the bold as HTML.
  await expectFile(run!, "# Plan\n\nWe should hire <strong>two</strong> people this quarter. Soon\n\nThe budget is tight.\n");
  await expect(page.locator(STATUS)).toHaveText("Saved");
  await plant(page, "other-kind");
  await cursorAtEnd(page, "The budget is tight.");
  await page.keyboard.type(" Still");
  await expectFile(run!, "# Plan\n\nWe should hire <strong>two</strong> people this quarter. Soon\n\nThe budget is tight. Still\n");
  await expect(page.locator(NOTICE)).toHaveCount(0);
  await expect(page.locator(STATUS)).toHaveText("Saved");
});

test("a fault that can't be repaired is refused: the file is left as it was, the words stay on the page and in the edits kept for recovery, and one notice says so", async () => {
  const { page, dataDir } = await start();
  await plant(page, "drop-word-always");
  await cursorAtEnd(page, "people this quarter.");
  await page.keyboard.type(" Soon");
  await expect(page.locator(STATUS)).toHaveText("Not saved: the file would have lost words");
  await expect(page.locator(NOTICE)).toHaveCount(1);
  await expect(page.locator(NOTICE)).toContainText('Corillo didn\'t save your latest changes: the file would have lost some of your words ("Soon").');
  await expect(page.locator(NOTICE)).toContainText("They're safe here, and come back if Corillo closes.");
  await expect(page.locator(EDITOR)).toContainText("people this quarter. Soon");
  await expect.poll(() => kept(dataDir)).toContain("Soon");
  expect(run!.text()).toBe(PLAN);
  // Typing goes on: still one notice, and the file still as it was.
  await page.keyboard.type(" and later");
  await expect(page.locator(EDITOR)).toContainText("Soon and later");
  await page.waitForTimeout(800);
  await expect(page.locator(NOTICE)).toHaveCount(1);
  expect(run!.text()).toBe(PLAN);
  // Once a save can be written whole, it is, and the notice goes.
  await plant(page, null);
  await page.keyboard.type(".");
  await expectFile(run!, "# Plan\n\nWe should hire **two** people this quarter. Soon and later.\n\nThe budget is tight.\n");
  await expect(page.locator(STATUS)).toHaveText("Saved");
  await expect(page.locator(NOTICE)).toHaveCount(0);
  await expect.poll(() => kept(dataDir)).toBe("");
});

test("the held-back notice goes once the save is held back no longer, even when another problem came between (B14-05)", async () => {
  test.setTimeout(45_000);
  const r = await start();
  const { page } = r;
  await plant(page, "drop-word-always");
  await cursorAtEnd(page, "people this quarter.");
  await page.keyboard.type(" Soon");
  await expect(page.locator(NOTICE)).toHaveCount(1);
  // The fault gone, the next save fails for another reason: the status bar says that one, and the notice no longer stands.
  await plant(page, null);
  chmodSync(r.file, 0o444);
  await page.keyboard.type(" now");
  await expect(page.locator(STATUS)).toHaveText(/Not saved: the file is read-only/);
  await expect(page.locator(NOTICE)).toHaveCount(0);
  // Then it saves, by itself.
  chmodSync(r.file, 0o644);
  await expect.poll(r.text, { timeout: 12_000 }).toContain("Soon now");
  await expect(page.locator(STATUS)).toHaveText("Saved");
  await expect(page.locator(NOTICE)).toHaveCount(0);
});

test("a block nobody edited, left out by a fault, is refused too, naming its words", async () => {
  const { page } = await start();
  await plant(page, "lose-block");
  await cursorAtEnd(page, "The budget is tight.");
  await page.keyboard.type(" Still");
  await expect(page.locator(NOTICE)).toContainText('("Plan")');
  expect(run!.text()).toBe(PLAN);
});

test("the Markdown view starts from what the net lets through: a fault in the serializer is repaired there too, and saves from the view keep every word (B14-01)", async () => {
  const r = await start();
  const { page } = r;
  await plantInSerializer(page, "drop-word");
  await cursorAtEnd(page, "people this quarter.");
  await page.keyboard.type(" Soon");
  // Straight to the Markdown view, before the save the typing queued, and a letter typed there.
  await page.getByRole("button", { name: "Markdown", exact: true }).click();
  const source = page.getByRole("textbox", { name: "Markdown text" });
  await expect(source).toBeVisible();
  expect(await source.inputValue()).toContain("people this quarter. Soon");
  await page.keyboard.type("!");
  await expect.poll(r.text).toContain("!");
  await expect(page.locator(STATUS)).toHaveText("Saved");
  expect(missingWords(["We", "should", "hire", "two", "people", "this", "quarter", "Soon", "The", "budget", "is", "tight"], r.text())).toEqual([]);
  await plantInSerializer(page, null);
  await page.getByRole("button", { name: "Formatted", exact: true }).click();
  await expect(page.locator(EDITOR)).toContainText("people this quarter. Soon");
});

test("where the net would hold a save back, the Markdown view doesn't open: the file stays as it was and the words stay kept for recovery (B14-01)", async () => {
  const r = await start();
  const { page, dataDir } = r;
  await plantInSerializer(page, "drop-word-always");
  await cursorAtEnd(page, "people this quarter.");
  await page.keyboard.type(" Soon");
  await page.getByRole("button", { name: "Markdown", exact: true }).click();
  const source = page.getByRole("textbox", { name: "Markdown text" });
  await expect(page.locator(NOTICE)).toContainText("would have lost some of your words");
  await expect(page.locator(NOTICE)).toContainText("The Markdown view opens once they can be saved.");
  await expect(source).toBeHidden();
  await expect(page.locator(EDITOR)).toContainText("people this quarter. Soon");
  await expect.poll(() => kept(dataDir)).toContain("Soon");
  await page.waitForTimeout(800); // (the save the typing queued)
  expect(r.text()).toBe(PLAN);
  expect(kept(dataDir)).toContain("Soon");
  // Once a save can be written whole, the view opens, with every word.
  await plantInSerializer(page, null);
  await page.getByRole("button", { name: "Markdown", exact: true }).click();
  await expect(source).toBeVisible();
  expect(await source.inputValue()).toContain("people this quarter. Soon");
  await page.keyboard.type(".");
  await expect.poll(r.text).toContain("people this quarter. Soon");
  await expect(page.locator(NOTICE)).toHaveCount(0);
});

/** Every question Corillo asks from now on, answered by the button `answer` picks (the default when it gives none). */
function recordQuestions(app: ElectronApplication, answer: string | null): Promise<void> {
  return app.evaluate(({ dialog }, pick) => {
    const g = globalThis as unknown as { asked: unknown[] };
    g.asked = [];
    dialog.showMessageBox = (async (_w: unknown, o: Electron.MessageBoxOptions) => {
      g.asked.push({ message: o.message, detail: o.detail, buttons: o.buttons, defaultId: o.defaultId, cancelId: o.cancelId });
      return { response: pick ? o.buttons!.indexOf(pick) : (o.defaultId ?? 0), checkboxChecked: false };
    }) as unknown as typeof dialog.showMessageBox;
  }, answer);
}

test("closing while a save is held back asks plainly: Cancel, the default, keeps the tab and the words; Don't Save says the latest changes go (B14-03)", async () => {
  const r = await start();
  const { page, app, dataDir } = r;
  const asked = () => app.evaluate(() => (globalThis as unknown as { asked: unknown[] }).asked);
  await plant(page, "drop-word-always");
  await cursorAtEnd(page, "people this quarter.");
  await page.keyboard.type(" Soon");
  await expect(page.locator(NOTICE)).toBeVisible();
  await expect.poll(() => kept(dataDir)).toContain("Soon");
  await recordQuestions(app, null);
  await clickMenu(app, "close-tab");
  await expect.poll(asked).toEqual([
    {
      message: "plan couldn't be saved: the file would have lost words.",
      detail: "If you close it now, your latest changes will be lost. To keep them, choose Cancel, then copy everything on the page into another document.",
      buttons: ["Cancel", "Don't Save"],
      defaultId: 0,
      cancelId: 0,
    },
  ]);
  await page.waitForTimeout(300);
  await expect(page.locator(".tab")).toHaveCount(1);
  await expect(page.locator(EDITOR)).toContainText("people this quarter. Soon");
  expect(kept(dataDir)).toContain("Soon");
  expect(r.text()).toBe(PLAN);
  // Don't Save: the tab closes, the file as it was, and nothing kept.
  await recordQuestions(app, "Don't Save");
  await clickMenu(app, "close-tab");
  await expect(page.locator(".tab")).toHaveCount(0);
  await expect.poll(() => kept(dataDir)).toBe("");
  expect(r.text()).toBe(PLAN);
});

test("a file changed by another app in the moment after a save is taken in as any outside change, never written over", async () => {
  const { page, app } = await start();
  const theirs = "# Plan\n\nAnother app wrote this line.\n";
  await afterSwap(app, theirs);
  await cursorAtEnd(page, "The budget is tight.");
  await page.keyboard.type(" Mine.");
  await expect(page.locator(EDITOR)).toContainText("Another app wrote this line.");
  await page.waitForTimeout(800);
  expect(run!.text()).toBe(theirs);
  await expect(page.locator(STATUS)).toHaveText("Saved");
});

// A16-1: another app's save landing while Corillo wrote the document was replaced, and nobody was told.
test("another app's save that lands while Corillo saves the person's typing isn't written over: the conflict bar shows, as for any outside change", async () => {
  const { page, app } = await start();
  const theirs = `${PLAN}\nA paragraph another app added.\n`;
  await whileWriting(app, run!.file, theirs);
  await cursorAtEnd(page, "The budget is tight.");
  await page.keyboard.type(" Mine.");
  await expect(page.locator(BANNER)).toBeVisible();
  await page.waitForTimeout(800);
  expect(run!.text()).toBe(theirs);
  await expect(page.locator(EDITOR)).toContainText("The budget is tight. Mine.");
});

test("another app's save that lands while Corillo writes an agent's edit isn't written over: the edit isn't made, and its next try is told what changed", async () => {
  const r = await start();
  const claude = await agent(r);
  await claude.ok("take_document", { path: r.file });
  const theirs = `${PLAN}\nA paragraph another app added.\n`;
  await whileWriting(r.app, r.file, theirs);
  const refused = await claude.call("edit_document", { path: r.file, edits: [{ find: "two", replace: "three" }] });
  expect(refused.isError).toBe(true);
  // In words the agent can act on (Batch 18, A16-1).
  expect(refused.text).toBe("The file changed while your edit was being saved. Read it again and redo your edit.");
  expect(r.text()).toBe(theirs);
  const again = await claude.ok("edit_document", { path: r.file, edits: [{ find: "two", replace: "three" }] });
  expect(again).toContain("plan.md was changed outside Corillo since your last read.");
  expect(again).toContain("+A paragraph another app added.");
  await expectFile(r, theirs.replace("two", "three"));
  await claude.ok("finish_editing", { path: r.file });
});

/** During the next write, "another app" saves the document: after Corillo's look at it, before its text takes the file's place. */
function whileWriting(app: ElectronApplication, file: string, text: string): Promise<void> {
  return app.evaluate(
    (_e, { file, theirs }) => {
      const seams = (globalThis as unknown as { corilloWriteSeams: { afterTemp: ((temp: string) => void) | null } }).corilloWriteSeams;
      seams.afterTemp = () => {
        seams.afterTemp = null;
        process.getBuiltinModule("node:fs").writeFileSync(file, theirs);
      };
    },
    { file, theirs: text },
  );
}

/** The next save's file is changed by "another app" straight after Corillo puts it in place. */
function afterSwap(app: ElectronApplication, text: string): Promise<void> {
  return app.evaluate((_e, theirs) => {
    const seams = (globalThis as unknown as { corilloWriteSeams: { afterSwap: ((target: string) => void) | null } }).corilloWriteSeams;
    seams.afterSwap = (target) => {
      seams.afterSwap = null;
      process.getBuiltinModule("node:fs").writeFileSync(target, theirs);
    };
  }, text);
}

/** The next save's temporary file is given wrong bytes before it's read back. */
function wrongTemp(app: ElectronApplication): Promise<void> {
  return app.evaluate(() => {
    const seams = (globalThis as unknown as { corilloWriteSeams: { afterTemp: ((temp: string) => void) | null } }).corilloWriteSeams;
    seams.afterTemp = (temp) => {
      seams.afterTemp = null;
      process.getBuiltinModule("node:fs").writeFileSync(temp, "wrong bytes");
    };
  });
}

// Every way a document gets written (the list for the Log): the person's save, Save somewhere else, an option
// applied, Undo after an agent's pass, a version restored, changes brought back after a crash, a new document
// (File > New Document… and an agent's create_document), and an agent's edit or replacement.

test("every way the person writes a document goes through the net: typing, an option, Undo after an agent's pass, a version restored, Save somewhere else", async () => {
  test.setTimeout(90_000);
  const r = await start("# Plan\n\nWe should hire **two** people this quarter.\n\nThe budget is **tight** for now.\n\nHiring takes **long**.\n");
  const { page, app } = r;
  await plant(page, "drop-word");
  // Typing.
  await cursorAtEnd(page, "people this quarter.");
  await page.keyboard.type(" Soon");
  await expect.poll(r.text).toContain("<strong>two</strong> people this quarter. Soon");
  // An option the agent offered, applied with a click.
  await selectText(page, "for now");
  await page.getByRole("button", { name: "Comment", exact: true }).click();
  await page.getByRole("textbox", { name: "New comment" }).fill("Say how long.");
  await page.getByRole("button", { name: "Post" }).click();
  const claude = await agent(r);
  const taken = await claude.ok("take_document", { path: r.file });
  const id = /\[([0-9a-f]+)\] on /.exec(taken)![1];
  await claude.ok("edit_document", { path: r.file, edits: [{ find: "Hiring takes **long**.", replace: "Hiring takes **six** weeks." }] });
  const option = { label: "Months", edits: [{ find: "is **tight** for now.", replace: "is **tight** for two months." }] };
  await claude.ok("reply_to_comment", { path: r.file, comment_id: id, text: "Or say months?", options: [option] });
  await claude.ok("finish_editing", { path: r.file });
  // (An option is written as the file's own text with its edits made, every block kept: so a fault that leaves out a block.)
  await plant(page, "lose-block");
  const withPass = r.text();
  await page.locator(`${PANEL} .comment-option`, { hasText: "Months" }).click();
  await expect(page.locator(EDITOR)).toContainText("for two months.");
  await expect(page.locator(NOTICE)).toContainText("would have lost some of your words");
  expect(r.text()).toBe(withPass);
  await plant(page, null);
  await cursorAtEnd(page, "people this quarter. Soon");
  await page.keyboard.type(" now");
  await expect.poll(r.text).toContain("is **tight** for two months.");
  await expect(page.locator(NOTICE)).toHaveCount(0);
  // Undo after the agent's pass: the typing, then the option, taken back; the paragraph written afresh, through the net.
  await plant(page, "drop-word");
  await page.waitForTimeout(600); // (Undo's steps)
  await page.keyboard.press("Meta+z");
  await expect(page.locator(EDITOR)).not.toContainText("Soon now");
  await page.keyboard.press("Meta+z");
  await expect(page.locator(EDITOR)).toContainText("for now.");
  await expect.poll(r.text).toContain("is <strong>tight</strong> for now.");
  expect(r.text()).toContain("Hiring takes **six** weeks."); // the agent's, as it wrote it
  // A version restored: every block is the version's own, so a fault leaving one out is refused.
  await plant(page, "lose-block");
  const before = r.text();
  await page.getByRole("button", { name: "History", exact: true }).click();
  await page.locator(".doc:not([hidden]) .history-panel .history-item", { hasText: "First version" }).click();
  await page.getByRole("button", { name: "Restore this version" }).click();
  await expect(page.locator(NOTICE)).toContainText("would have lost some of your words");
  expect(r.text()).toBe(before);
  // Save somewhere else, for a document deleted outside Corillo, with words typed since.
  await plant(page, "drop-word");
  unlinkSync(r.file);
  await expect(page.locator(BANNER)).toBeVisible();
  await cursorAtEnd(page, "people this quarter.");
  await page.keyboard.type(" Later");
  const target = join(r.folder, "kept.md");
  await app.evaluate(({ dialog }, chosen) => {
    dialog.showSaveDialog = (async () => ({ canceled: false, filePath: chosen })) as typeof dialog.showSaveDialog;
  }, target);
  await page.getByRole("button", { name: "Save somewhere else…" }).click();
  await expect.poll(() => (existsSync(target) ? readFileSync(target, "utf8") : "")).toContain("<strong>two</strong> people this quarter. Later");
});

test("putting back a deleted document (Save it where it was) goes through the net", async () => {
  const { page, file } = await start();
  unlinkSync(file);
  await expect(page.locator(BANNER)).toBeVisible();
  await plant(page, "drop-word");
  await cursorAtEnd(page, "people this quarter.");
  await page.keyboard.type(" Back");
  await page.getByRole("button", { name: "Save it where it was" }).click();
  await expect.poll(() => (existsSync(file) ? readFileSync(file, "utf8") : "")).toBe(
    "# Plan\n\nWe should hire <strong>two</strong> people this quarter. Back\n\nThe budget is tight.\n",
  );
});

test("a new document whose first bytes don't read back isn't made; an agent's edits and replacements go through the net, and pass", async () => {
  const r = await start();
  const { page, app } = r;
  // File > New Document…, with the temporary file's bytes wrong: nothing is made, and the person is told.
  const fresh = join(r.folder, "Fresh.md");
  await app.evaluate(({ dialog }, chosen) => {
    const g = globalThis as unknown as { told: string[] };
    g.told = [];
    dialog.showSaveDialog = (async () => ({ canceled: false, filePath: chosen })) as typeof dialog.showSaveDialog;
    dialog.showMessageBox = (async (_w: unknown, o: { message: string; detail?: string }) => {
      g.told.push(`${o.message} ${o.detail ?? ""}`);
      return { response: 0, checkboxChecked: false };
    }) as unknown as typeof dialog.showMessageBox;
  }, fresh);
  await wrongTemp(app);
  await clickMenu(app, "new-document");
  await expect.poll(() => app.evaluate(() => (globalThis as unknown as { told: string[] }).told)).toEqual([
    "Corillo couldn't create Fresh.md. the disk didn't keep what Corillo wrote, so nothing was made",
  ]);
  expect(existsSync(fresh)).toBe(false);
  expect(readdirSync(r.folder)).toEqual(["plan.md"]);
  // An agent's edit that deletes a whole paragraph, and a replacement of most of the document, go through.
  const claude = await agent(r);
  await claude.ok("take_document", { path: r.file });
  await claude.ok("edit_document", { path: r.file, edits: [{ find: "We should hire **two** people this quarter.\n\n", replace: "" }] });
  await expectFile(r, "# Plan\n\nThe budget is tight.\n");
  await claude.ok("read_document", { path: r.file });
  const rewritten = "# A new plan\n\nEverything here is written again, from the start.\n";
  await claude.ok("replace_document", { path: r.file, text: rewritten });
  await expectFile(r, rewritten);
  // An agent's new document is read back as it's made.
  const theirs = join(r.folder, "notes.md");
  expect(await claude.ok("create_document", { path: theirs, text: "# Notes\n" })).toContain("Created");
  expect(readFileSync(theirs, "utf8")).toBe("# Notes\n");
  await claude.ok("finish_editing", { path: r.file });
  await expect(page.locator(EDITOR)).toContainText("Everything here is written again");
});

test("words a refused save kept come back after a crash, and are saved once the person keeps them", async () => {
  const { page, dataDir, file, app, folder } = await start();
  await plant(page, "drop-word-always");
  await cursorAtEnd(page, "people this quarter.");
  await page.keyboard.type(" Soon");
  await expect(page.locator(NOTICE)).toBeVisible();
  await expect.poll(() => kept(dataDir)).toContain("Soon");
  const firstHome = await app.evaluate(() => process.env.CORILLO_HOME ?? "");
  made.push(folder, dataDir);
  if (firstHome) made.push(firstHome);
  app.process().kill("SIGKILL");
  await app.close().catch(() => undefined);
  run = null; // (its folders are removed below)
  expect(readFileSync(file, "utf8")).toBe(PLAN);
  // The next launch, on the same data folder and document: the words come back, to keep.
  const home = mkdtempSync(join(tmpdir(), "corillo-home-"));
  made.push(home);
  const { app: again } = await launch({
    args: [ONE_SCALE, ".", file],
    env: { ...process.env, CORILLO_USER_DATA: dataDir, CORILLO_HIDDEN: "1", CORILLO_HOME: home },
  });
  try {
    const back = await again.firstWindow();
    await back.waitForSelector(".ProseMirror");
    await expect(back.locator(EDITOR)).toContainText("people this quarter. Soon");
    await expect(back.locator(BANNER)).toContainText("brought back changes");
    // Keeping them saves through the net too: a fault planted now holds that save back.
    await plant(back, "lose-block");
    await back.getByRole("button", { name: "Keep my changes" }).click();
    await expect(back.locator(NOTICE)).toContainText("would have lost some of your words");
    expect(readFileSync(file, "utf8")).toBe(PLAN);
    await plant(back, null);
    await cursorAtEnd(back, "people this quarter. Soon");
    await back.keyboard.type(" too");
    await expect.poll(() => readFileSync(file, "utf8")).toContain("people this quarter. Soon too");
  } finally {
    await again.close();
  }
});

// The page half (F-1's kind) ------------------------------------------------------------

/** Every word the file holds that the page doesn't draw: text the person can't see. */
async function notShown(page: Page, file: string): Promise<string[]> {
  const drawn = await page.evaluate(() => {
    const views = [".doc:not([hidden]) .version-view:not([hidden]) .ProseMirror", ".doc:not([hidden]) .page.editor .ProseMirror"];
    const root = views.map((v) => document.querySelector(v)).find((r) => r && r.checkVisibility());
    if (!root) return "";
    const runs: string[] = [];
    let block: Element | null = null;
    let words = "";
    const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT);
    for (let t = walker.nextNode(); t; t = walker.nextNode()) {
      const parent = t.parentElement!;
      if (parent.closest(".diagram > pre, style, svg")) continue;
      const range = document.createRange();
      range.selectNodeContents(t);
      if (!range.getClientRects().length) continue; // not drawn: no place on screen
      const b = parent.closest("p, li, td, th, h1, h2, h3, h4, h5, h6, pre, sup, figure, blockquote, div");
      if (b !== block) {
        runs.push(words);
        words = "";
        block = b;
      }
      words += t.textContent;
    }
    runs.push(words);
    return runs.join("\n");
  });
  const { doc } = parseMarkdown(readFileSync(file, "utf8"));
  const words: string[] = [];
  doc.descendants((n) => {
    if (n.type.name === "code_block" && n.attrs.params === "mermaid") return false; // drawn as a diagram
    if (!n.isTextblock) return true;
    words.push(...(n.textBetween(0, n.content.size, " ", " ").match(/[\p{L}\p{N}\p{M}]+/gu) ?? []));
    return false;
  });
  return missingWords(words, drawn);
}

test("through a review round on a long document (an option, Show changes, a version, a selection and Find), the page draws every word the file holds", async () => {
  test.setTimeout(120_000);
  const r = await start(bigDocument(8), "long.md");
  const { page, file } = r;
  const check = async (step: string) => expect(await notShown(page, file), step).toEqual([]);
  await check("opened");
  // Claude rewrites the title and offers an option on a comment.
  await selectText(page, "Annual report");
  await page.getByRole("button", { name: "Comment", exact: true }).click();
  await page.getByRole("textbox", { name: "New comment" }).fill("Warmer title?");
  await page.getByRole("button", { name: "Post" }).click();
  const claude = await agent(r);
  const taken = await claude.ok("take_document", { path: file });
  const id = /\[([0-9a-f]+)\] on /.exec(taken)![1];
  await claude.ok("edit_document", { path: file, edits: [{ find: "# Annual report on the volunteer programme", replace: "# Annual report on our volunteer programme" }] });
  const option = { label: "Our year", edits: [{ find: "# Annual report on our volunteer programme", replace: "# Our year with the volunteers" }] };
  await claude.ok("reply_to_comment", { path: file, comment_id: id, text: "Warmer. Or this?", options: [option] });
  await claude.ok("finish_editing", { path: file });
  await expect(page.locator(EDITOR)).toContainText("Annual report on our");
  await check("after Claude's pass");
  // Reading in chapter 3 or so.
  await page.locator(`${EDITOR} .ProseMirror > p`).nth(40).evaluate((p) => p.scrollIntoView({ block: "start" }));
  await page.locator(`${PANEL} .comment-option`, { hasText: "Our year" }).click();
  await expect(page.locator(EDITOR)).toContainText("Our year with the volunteers");
  await expect.poll(() => readFileSync(file, "utf8")).toContain("# Our year with the volunteers");
  await check("after the option");
  const showChanges = page.locator("#toolbar").getByRole("button", { name: "Show changes" });
  await showChanges.click();
  await expect(page.locator(".doc:not([hidden]) .version-banner")).toBeVisible();
  await check("with Show changes");
  await showChanges.click();
  await expect(page.locator(".doc:not([hidden]) .version-banner")).toBeHidden();
  await check("after Show changes");
  await page.getByRole("button", { name: "History", exact: true }).click();
  await page.locator(".doc:not([hidden]) .history-panel .history-item", { hasText: "First version" }).click();
  await expect(page.locator(".doc:not([hidden]) .version-banner")).toContainText("Version from");
  await page.getByRole("button", { name: "Back to current" }).click();
  await expect(page.locator(".doc:not([hidden]) .version-banner")).toBeHidden();
  await check("after a version");
  await selectText(page, "volunteers");
  await check("with a selection");
  await page.keyboard.press("Meta+f");
  await page.keyboard.type("just");
  await expect(page.locator(`${EDITOR} .find-match`).first()).toBeAttached();
  await check("with Find");
  await page.keyboard.press("Escape");
  await expect(page.locator(`${EDITOR} .find-match`)).toHaveCount(0);
  await check("after Find");
  // And the check sees words the page doesn't draw. (A style sheet's rule: the editor would undo a change to its own element.)
  const words = ((await page.locator(`${EDITOR} .ProseMirror > p`).nth(41).textContent()) ?? "").match(/[\p{L}\p{N}]+/gu) ?? [];
  await page.evaluate(() => {
    const style = document.createElement("style");
    style.id = "hide-one";
    style.textContent = ".page.editor .ProseMirror > p:nth-of-type(42) { display: none }";
    document.head.append(style);
  });
  expect((await notShown(page, file)).length).toBeGreaterThanOrEqual(words.length - 2);
  await page.evaluate(() => document.getElementById("hide-one")!.remove());
  await check("drawn again");
});
