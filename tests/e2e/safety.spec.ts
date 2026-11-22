// Corillo never loses or mangles a document: saving when the file is
// read-only, deleted, moved or symlinked; edits brought back after a crash;
// line endings kept in the Markdown view; big and odd files.
import { test, expect, type ElectronApplication, type Page } from "@playwright/test";
import {
  chmodSync, existsSync, lstatSync, mkdtempSync, readFileSync, readdirSync, realpathSync, statSync, symlinkSync, unlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ONE_SCALE, openText, openAlso, openFromFinder, expectFile, cursorAtEnd, tabState, clickMenu, EDITOR, launch as launchCorillo } from "./helpers";
import { AgentSession } from "./agent-session";

const STATUS = "#save-status";
const BANNER = ".doc:not([hidden]) .banner";

const tempFolder = (prefix: string) => realpathSync(mkdtempSync(join(tmpdir(), prefix)));

/** Run Corillo on these files with this data folder (kept between runs to test restarts). */
async function launch(files: string[], dataDir: string): Promise<{ app: ElectronApplication; page: Page }> {
  // Not a first run, so the "Connect your agents" screen stays away now that every test's Corillo has a stand-in home.
  writeFileSync(join(dataDir, "setup.json"), '{ "connectAgentsOffered": true }\n');
  const { app } = await launchCorillo({
    args: [ONE_SCALE, ".", ...files],
    env: { ...process.env, CORILLO_USER_DATA: dataDir, CORILLO_HIDDEN: "1" },
  });
  const page = await app.firstWindow();
  return { app, page };
}

/** The person's answer to the next question Corillo asks (by button, from the left). */
function answerNext(app: ElectronApplication, response: number): Promise<void> {
  return app.evaluate(({ dialog }, r) => {
    dialog.showMessageBox = (async () => ({ response: r, checkboxChecked: false })) as typeof dialog.showMessageBox;
  }, response);
}

/** Close the window as the person would, and wait until it's gone. */
async function closeWindow(app: ElectronApplication, page: Page): Promise<void> {
  const closed = page.waitForEvent("close");
  await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].close());
  await closed;
}

test("a read-only file isn't changed: the status bar says why, and Corillo saves once it can", async () => {
  test.setTimeout(45_000);
  const run = await openText("Draft.\n");
  chmodSync(run.file, 0o444);
  await cursorAtEnd(run.page, "Draft.");
  await run.page.keyboard.type(" More.");
  await expect(run.page.locator(STATUS)).toHaveText("Not saved: the file is read-only or locked. Trying again…");
  await expect(run.page.locator(EDITOR)).toContainText("Draft. More.");
  expect(run.text()).toBe("Draft.\n");
  // Made writable again in Finder: the next try saves it, without the person doing anything.
  chmodSync(run.file, 0o644);
  await expect.poll(run.text, { timeout: 12_000 }).toBe("Draft. More.\n");
  await expect(run.page.locator(STATUS)).toHaveText("Saved");
  expect(readdirSync(run.folder)).toEqual(["proposal.md"]);
  await run.app.close();
});

test("closing a document that can't be saved asks first: Cancel keeps it open, Don't Save leaves the file alone", async () => {
  const run = await openText("Draft.\n");
  chmodSync(run.file, 0o444);
  await cursorAtEnd(run.page, "Draft.");
  await run.page.keyboard.type(" More.");
  await expect(run.page.locator(STATUS)).toHaveText(/Not saved: the file is read-only/);
  await answerNext(run.app, 2); // Cancel
  await clickMenu(run.app, "close-tab");
  await run.page.waitForTimeout(300);
  await expect(run.page.locator(".tab")).toHaveCount(1);
  await answerNext(run.app, 1); // Don't Save
  await clickMenu(run.app, "close-tab");
  await expect(run.page.locator(".tab")).toHaveCount(0);
  expect(run.text()).toBe("Draft.\n");
  await run.app.close();
});

test("typing without a pause still saves every couple of seconds", async () => {
  const run = await openText("Start.\n");
  await cursorAtEnd(run.page, "Start.");
  let done = false;
  // A key every 0.2 seconds: never the pause that usually starts a save.
  const typing = run.page.keyboard.type(" one two three four five six seven", { delay: 200 }).then(() => (done = true));
  await expect.poll(run.text, { timeout: 5000 }).toMatch(/^Start\. o/);
  expect(done).toBe(false);
  await typing;
  await expectFile(run, "Start. one two three four five six seven\n");
  await run.app.close();
});

test("a document deleted outside Corillo: it says so, keeps the text, and never re-creates the file unasked", async () => {
  const run = await openText("Keep this.\n");
  unlinkSync(run.file);
  await expect(run.page.locator(BANNER)).toContainText("deleted outside Corillo");
  await expect(run.page.locator(STATUS)).toHaveText("Not saved: the file was deleted");
  await cursorAtEnd(run.page, "Keep this.");
  await run.page.keyboard.type(" And this.");
  await run.page.waitForTimeout(1000);
  expect(existsSync(run.file)).toBe(false);
  await run.page.getByRole("button", { name: "Save it where it was" }).click();
  await expectFile(run, "Keep this. And this.\n");
  await expect(run.page.locator(BANNER)).toBeHidden();
  await expect(run.page.locator(STATUS)).toHaveText("Saved");
  // From then on it saves as usual.
  await run.page.keyboard.type(" Later.");
  await expectFile(run, "Keep this. And this. Later.\n");
  await run.app.close();
});

test("a deleted document can be saved somewhere else, and Corillo carries on there", async () => {
  const run = await openText("Moved.\n");
  unlinkSync(run.file);
  await expect(run.page.locator(BANNER)).toBeVisible();
  const elsewhere = join(run.folder, "new home.md");
  await run.app.evaluate(({ dialog }, picked) => {
    dialog.showSaveDialog = (async () => ({ canceled: false, filePath: picked })) as typeof dialog.showSaveDialog;
  }, elsewhere);
  await run.page.getByRole("button", { name: "Save somewhere else…" }).click();
  await expect.poll(() => existsSync(elsewhere) && readFileSync(elsewhere, "utf8")).toBe("Moved.\n");
  await expect.poll(async () => (await tabState(run.page)).names).toEqual(["new home.md"]);
  await expect(run.page.locator(STATUS)).toHaveText("Saved");
  await cursorAtEnd(run.page, "Moved.");
  await run.page.keyboard.type(" Again.");
  await expect.poll(() => readFileSync(elsewhere, "utf8")).toBe("Moved. Again.\n");
  expect(existsSync(run.file)).toBe(false);
  await run.app.close();
});

test("Save somewhere else never writes over another file: a name typed without .md next to an existing notes.md is refused, plainly", async () => {
  const run = await openText("Mine.\n");
  const theirs = join(run.folder, "notes.md");
  writeFileSync(theirs, "Someone else's notes.\n");
  unlinkSync(run.file);
  await expect(run.page.locator(BANNER)).toBeVisible();
  await run.app.evaluate(({ dialog }, picked) => {
    const g = globalThis as unknown as { asked: string[] };
    g.asked = [];
    dialog.showSaveDialog = (async () => ({ canceled: false, filePath: picked })) as typeof dialog.showSaveDialog;
    dialog.showMessageBox = (async (_w: unknown, options: { message: string; detail: string }) => {
      g.asked.push(`${options.message} ${options.detail}`);
      return { response: 0, checkboxChecked: false };
    }) as unknown as typeof dialog.showMessageBox;
  }, join(run.folder, "notes")); // the Mac's panel saw no file called "notes", so it didn't ask
  await run.page.getByRole("button", { name: "Save somewhere else…" }).click();
  await expect
    .poll(() => run.app.evaluate(() => (globalThis as unknown as { asked: string[] }).asked))
    .toEqual(["There's already a file called notes.md there. Choose another name or folder."]);
  expect(readFileSync(theirs, "utf8")).toBe("Someone else's notes.\n");
  expect((await tabState(run.page)).names).toEqual(["proposal.md"]);
  await expect(run.page.locator(BANNER)).toBeVisible();
  await run.app.evaluate(({ dialog }) => {
    dialog.showMessageBox = (async (_w: unknown, options: { buttons: string[] }) => ({
      response: options.buttons.indexOf("Don't Save"),
      checkboxChecked: false,
    })) as unknown as typeof dialog.showMessageBox;
  });
  await run.app.close();
});

test("closing a deleted document asks first, and can save it where it was", async () => {
  const run = await openText("Unsaved work.\n");
  unlinkSync(run.file);
  await expect(run.page.locator(BANNER)).toBeVisible();
  await cursorAtEnd(run.page, "Unsaved work.");
  await run.page.keyboard.type(" Kept.");
  await answerNext(run.app, 0); // Save Where It Was
  await closeWindow(run.app, run.page);
  expect(run.text()).toBe("Unsaved work. Kept.\n");
  await run.app.close();
});

test("a symlinked document is one tab with its real file, and saves go to the real file", async () => {
  const real = tempFolder("corillo-real-");
  const links = tempFolder("corillo-links-");
  const target = join(real, "Plan.md");
  writeFileSync(target, "Plan.\n");
  const link = join(links, "plan link.md");
  symlinkSync(target, link);
  const { app, page } = await launch([link], tempFolder("corillo-data-"));
  await page.waitForSelector(".ProseMirror");
  await cursorAtEnd(page, "Plan.");
  await page.keyboard.type(" Agreed.");
  await expect.poll(() => readFileSync(target, "utf8")).toBe("Plan. Agreed.\n");
  expect(lstatSync(link).isSymbolicLink()).toBe(true);
  expect(readdirSync(links)).toEqual(["plan link.md"]);
  expect(realpathSync(link)).toBe(target);
  expect(readdirSync(real)).toEqual(["Plan.md"]);
  // Opening the real file, or the same name in other letters, finds the open tab.
  await openFromFinder(app, target);
  const otherCase = join(real, "PLAN.md");
  if (existsSync(otherCase)) await openFromFinder(app, otherCase);
  await page.waitForTimeout(300);
  expect((await tabState(page)).names).toEqual(["plan link.md"]);
  await app.close();
});

test("a document opened through a linked folder has the comments and history it has when opened directly", async () => {
  const real = tempFolder("corillo-real-");
  const linkedFolder = join(tempFolder("corillo-links-"), "Vault");
  symlinkSync(real, linkedFolder);
  const target = join(real, "Plan.md");
  writeFileSync(target, "We should hire two people.\n");
  const dataDir = tempFolder("corillo-data-");
  // Opened directly: a comment and an edit.
  let { app, page } = await launch([target], dataDir);
  await page.waitForSelector(".ProseMirror");
  await page.evaluate((editor) => {
    const root = document.querySelector<HTMLElement>(`${editor} .ProseMirror`)!;
    root.focus();
    const node = root.querySelector("p")!.firstChild!;
    const range = document.createRange();
    range.setStart(node, 10);
    range.setEnd(node, 14);
    getSelection()!.removeAllRanges();
    getSelection()!.addRange(range);
  }, EDITOR);
  await page.waitForTimeout(50);
  await page.keyboard.press("Meta+Alt+m");
  await page.keyboard.type("How many exactly?");
  await page.keyboard.press("Meta+Enter");
  await expect(page.locator(".comment-card:not(.draft)")).toHaveCount(1);
  await cursorAtEnd(page, "people");
  await page.keyboard.type(" Soon.");
  await expectFile({ app, page, file: target, folder: real, dataDir, text: () => readFileSync(target, "utf8") }, "We should hire two people. Soon.\n");
  await app.close();
  // Opened again through the linked folder (as an agent might give it): the same comment and history.
  ({ app, page } = await launch([join(linkedFolder, "Plan.md")], dataDir));
  await page.waitForSelector(".ProseMirror");
  await expect(page.locator(".comment-card", { hasText: "How many exactly?" })).toBeVisible();
  await expect(page.locator(`${EDITOR} .comment-range`)).toHaveText(["hire"]);
  await page.getByRole("button", { name: "History", exact: true }).click();
  await expect(page.locator(".doc:not([hidden]) .history-who")).toHaveText(["You", "First version"]);
  await app.close();
});

test("edits that couldn't be saved come back after a crash, and the person can keep them", async () => {
  const dataDir = tempFolder("corillo-data-");
  const run = await launchOn("Ours.\n", dataDir);
  // Changed outside Corillo while the person types (before the autosave runs): Corillo waits for them to choose...
  await cursorAtEnd(run.page, "Ours.");
  await run.page.keyboard.type(" Typed before the crash.");
  writeFileSync(run.file, "Theirs.\n");
  await expect(run.page.locator(BANNER)).toBeVisible();
  // ...and meanwhile keeps the edits in its data folder.
  const recovery = join(dataDir, "recovery");
  await expect.poll(() => (existsSync(recovery) ? readdirSync(recovery).length : 0)).toBe(1);
  run.app.process().kill("SIGKILL");
  await run.app.close().catch(() => undefined);
  expect(readFileSync(run.file, "utf8")).toBe("Theirs.\n");
  // Not on the list of tabs to bring back (as if it had been closed before), so the crash recovery opens it itself (B10-10).
  writeFileSync(join(dataDir, "open-tabs.json"), JSON.stringify({ tabs: [], front: null }));

  // Next launch, without opening anything: the edits come back in their tab.
  const again = await launch([], dataDir);
  await again.page.waitForSelector(".ProseMirror");
  await expect(again.page.locator(EDITOR)).toContainText("Ours. Typed before the crash.");
  await expect(again.page.locator(BANNER)).toContainText("brought back changes");
  await expect(again.page.locator(STATUS)).toHaveText("Not saved: brought back after Corillo closed");
  expect(readFileSync(run.file, "utf8")).toBe("Theirs.\n");
  await again.page.getByRole("button", { name: "Keep my changes" }).click();
  await expect.poll(() => readFileSync(run.file, "utf8")).toBe("Ours. Typed before the crash.\n");
  await expect(again.page.locator(STATUS)).toHaveText("Saved");
  await expect.poll(() => readdirSync(recovery).length).toBe(0);
  await again.app.close();
});

test("brought-back edits can be set aside for the saved version", async () => {
  const dataDir = tempFolder("corillo-data-");
  const run = await launchOn("Saved.\n", dataDir);
  unlinkSync(run.file);
  await expect(run.page.locator(BANNER)).toBeVisible();
  await cursorAtEnd(run.page, "Saved.");
  await run.page.keyboard.type(" Lost?");
  const recovery = join(dataDir, "recovery");
  await expect.poll(() => (existsSync(recovery) ? readdirSync(recovery).length : 0)).toBe(1);
  run.app.process().kill("SIGKILL");
  await run.app.close().catch(() => undefined);
  writeFileSync(run.file, "Restored from a backup.\n");

  const again = await launch([run.file], dataDir);
  await again.page.waitForSelector(".ProseMirror");
  await expect(again.page.locator(EDITOR)).toContainText("Saved. Lost?");
  await again.page.getByRole("button", { name: "Use the saved version" }).click();
  await expect(again.page.locator(EDITOR)).toContainText("Restored from a backup.");
  await expect(again.page.locator(BANNER)).toBeHidden();
  await expect.poll(() => readdirSync(recovery).length).toBe(0);
  expect(readFileSync(run.file, "utf8")).toBe("Restored from a backup.\n");
  await again.app.close();
});

test("the Markdown view keeps Windows line endings and the byte-order mark", async () => {
  const text = "﻿# Title\r\n\r\nFirst line.\r\n";
  const run = await openText(text);
  const before = statSync(run.file).mtimeMs;
  await run.page.getByRole("button", { name: "Markdown" }).click();
  const source = run.page.getByRole("textbox", { name: "Markdown text" });
  await expect(source).toHaveValue("# Title\n\nFirst line.\n");
  await run.page.waitForTimeout(700);
  expect(statSync(run.file).mtimeMs).toBe(before);
  await source.focus();
  await run.page.keyboard.press("Meta+ArrowDown");
  await run.page.keyboard.type("Second line.\nThird line.");
  await expectFile(run, "﻿# Title\r\n\r\nFirst line.\r\nSecond line.\r\nThird line.");
  await run.page.getByRole("button", { name: "Formatted" }).click();
  await run.page.waitForTimeout(700);
  expect(run.text()).toBe("﻿# Title\r\n\r\nFirst line.\r\nSecond line.\r\nThird line.");
  await run.app.close();
});

test("closing in the Markdown view without typing leaves a Windows file untouched", async () => {
  const text = "﻿One.\r\nTwo.\r\n";
  const run = await openText(text);
  const before = statSync(run.file).mtimeMs;
  await run.page.getByRole("button", { name: "Markdown" }).click();
  await closeWindow(run.app, run.page);
  expect(run.text()).toBe(text);
  expect(statSync(run.file).mtimeMs).toBe(before);
  await run.app.close();
});

test("a 5 MB document opens without hanging, and an edit saves only that change", async () => {
  test.setTimeout(90_000);
  const parts: string[] = ["# Big notes\r\n"];
  let size = 0;
  for (let k = 0; size < 5 * 1024 * 1024; k++) {
    const chunk: string[] = [];
    for (let m = 0; m < 200; m++) {
      const i = k * 200 + m;
      chunk.push(
        i % 7 === 0
          ? `## Section ${i}\r\n`
          : i % 5 === 0
            ? `- item ${i} with *emphasis*\r\n- second item ${i}\r\n`
            : `Paragraph ${i}: café, 日本語, emoji 🎉, and a [link](https://example.com/${i}).  \r\nHard break line.\r\n`,
      );
    }
    const piece = "\r\n" + chunk.join("\r\n");
    size += piece.length;
    parts.push(piece);
  }
  const big = parts.join("");
  const started = Date.now();
  const run = await openText(big, { name: "big.md" });
  await expect(run.page.locator(`${EDITOR} h1`)).toHaveText("Big notes", { timeout: 30_000 });
  expect(Date.now() - started).toBeLessThan(30_000);
  await cursorAtEnd(run.page, "Big notes", "h1");
  await run.page.keyboard.type(" (edited)");
  await expect.poll(run.text, { timeout: 20_000 }).toBe(big.replace("# Big notes\r\n", "# Big notes (edited)\r\n"));
  await run.app.close();
});

test("a very long document (over 10 MB) is opened only after a plain question, which can be cancelled; an agent can't open one by itself", async () => {
  test.setTimeout(90_000);
  const run = await openText("Start.\n");
  const long = join(run.folder, "long.md");
  // Long paragraphs, so the window holds only a little more than the text itself once it's open.
  const paragraph = `${"Ordinary words, written again and again to make a very long document. ".repeat(1400)}\n\n`;
  writeFileSync(long, `# Long notes\n\n${paragraph.repeat(Math.ceil((10.6 * 1024 * 1024) / paragraph.length))}`);
  const asked = async (button: string) => {
    await run.app.evaluate(({ dialog }, chosen) => {
      const g = globalThis as unknown as { asked: string[] };
      g.asked = [];
      dialog.showMessageBox = (async (_w: unknown, options: { message: string; detail: string; buttons: string[] }) => {
        g.asked.push(`${options.message} ${options.detail} [${options.buttons.join(", ")}]`);
        return { response: options.buttons.indexOf(chosen), checkboxChecked: false };
      }) as unknown as typeof dialog.showMessageBox;
    }, button);
    return () => run.app.evaluate(() => (globalThis as unknown as { asked: string[] }).asked);
  };
  const question =
    "long is a very long document (11 MB). Corillo can open it, but it takes a few seconds, typing in it may lag, and it uses a lot of memory while it's open. [Open, Cancel]";
  // Cancel: nothing opens.
  let questions = await asked("Cancel");
  await openFromFinder(run.app, long);
  await expect.poll(questions).toEqual([question]);
  await run.page.waitForTimeout(500);
  expect((await tabState(run.page)).names).toEqual(["proposal.md"]);
  // An agent can't open it by itself: the person chooses.
  const { session } = await AgentSession.start(run.dataDir);
  try {
    const opened = await session.call("open_document", { path: long });
    expect(opened.isError).toBe(true);
    expect(opened.text).toContain("long.md is 11 MB, so long that opening it would slow Corillo's window down.");
  } finally {
    await session.stop();
  }
  expect((await tabState(run.page)).names).toEqual(["proposal.md"]);
  // Open: it opens.
  questions = await asked("Open");
  await openFromFinder(run.app, long);
  await expect(run.page.locator(`${EDITOR} h1`)).toHaveText("Long notes", { timeout: 30_000 });
  expect(await questions()).toEqual([question]);
  await run.app.close();
});

test("an empty file opens, and clicking the page and typing saves", async () => {
  const run = await openText("");
  await run.page.locator(EDITOR).click();
  await run.page.keyboard.type("First words.");
  await expectFile(run, "First words.\n");
  await run.app.close();
});

test("a file with only front matter opens and stays exactly as it was", async () => {
  const text = "---\ntitle: Empty for now\ntags: [draft]\n---\n";
  const run = await openText(text);
  await expect(run.page.locator('pre.raw-block[data-kind="front-matter"]')).toContainText("title: Empty for now");
  await expect(run.page.locator(STATUS)).toHaveText("Saved");
  await closeWindow(run.app, run.page);
  expect(run.text()).toBe(text);
  await run.app.close();
});

test("a file that isn't UTF-8 text gets a plain message instead of opening garbled", async () => {
  const run = await openText("Open.\n");
  const latin1 = join(run.folder, "old encoding.md");
  writeFileSync(latin1, Buffer.from([0x63, 0x61, 0x66, 0xe9, 0x0a]));
  await run.app.evaluate(({ dialog }) => {
    const g = globalThis as unknown as { shown: string[] };
    g.shown = [];
    dialog.showErrorBox = (title: string, content: string) => {
      g.shown.push(`${title}: ${content}`);
    };
  });
  await openFromFinder(run.app, latin1);
  await expect
    .poll(() => run.app.evaluate(() => (globalThis as unknown as { shown: string[] }).shown))
    .toEqual(["Can't open old encoding: Corillo can only open text files saved as UTF-8."]);
  expect((await tabState(run.page)).names).toEqual(["proposal.md"]);
  await run.app.close();
});

test("comments Corillo can't read (a damaged file) are set aside with a plain notice, and the document opens as usual", async () => {
  const dataDir = tempFolder("corillo-data-");
  writeFileSync(join(dataDir, "setup.json"), '{ "connectAgentsOffered": true }\n');
  const first = await launchOn("Plan.\n", dataDir);
  await first.app.close();
  const index = JSON.parse(readFileSync(join(dataDir, "documents.json"), "utf8")) as Record<string, { path: string }>;
  const id = Object.keys(index).find((k) => index[k].path === first.file)!;
  const comments = join(dataDir, "documents", id, "comments.json.gz");
  writeFileSync(comments, "damaged");
  const { app, page } = await launch([first.file], dataDir);
  await page.waitForSelector(".ProseMirror");
  await expect(page.locator(".file-notice")).toBeVisible();
  await expect(page.locator(".file-notice")).toContainText("Corillo couldn't read the comments it keeps for proposal.");
  await expect(page.locator(".file-notice")).toContainText("The document itself is fine, and the damaged copy was kept.");
  await expect(page.locator(EDITOR)).toContainText("Plan.");
  expect(readdirSync(join(dataDir, "documents", id)).filter((n) => n.startsWith("comments.json.gz.damaged-"))).toHaveLength(1);
  await app.close();
});

test("when Corillo's own data folder can't be written, a save still says Saved, with one calm line about Corillo's records", async () => {
  const run = await openText("Plan.\n");
  // The data folder stops taking changes (full, or no permission) while the document's own disk is fine.
  chmodSync(run.dataDir, 0o555);
  try {
    await cursorAtEnd(run.page, "Plan.");
    await run.page.keyboard.type(" More.");
    await expectFile(run, "Plan. More.\n");
    await expect(run.page.locator(STATUS)).toHaveText("Saved");
    await expect(run.page.locator(".file-notice")).toContainText("proposal is saved, but Corillo couldn't update what it keeps beside it.");
    await run.page.keyboard.type(" Again.");
    await expectFile(run, "Plan. More. Again.\n");
    await expect(run.page.locator(STATUS)).toHaveText("Saved");
  } finally {
    chmodSync(run.dataDir, 0o755);
  }
  await run.app.close();
});

test("when Corillo's own data folder can't be written as it notices a document was deleted, the line about its records doesn't say it was saved (R-MAIN-7)", async () => {
  const run = await openText("Plan.\n");
  chmodSync(run.dataDir, 0o555);
  try {
    unlinkSync(run.file);
    await expect(run.page.locator(BANNER)).toBeVisible();
    await expect(run.page.locator(".file-notice")).toContainText("Corillo couldn't update what it keeps beside proposal.");
    await expect(run.page.locator(".file-notice")).not.toContainText("is saved");
  } finally {
    chmodSync(run.dataDir, 0o755);
  }
  await answerNext(run.app, 2); // closing asks about the deleted document: Don't Save
  await run.app.close();
});

test("a document whose comments and history can't be read right now isn't opened without them: a plain message says so", async () => {
  const run = await openText("Plan.\n");
  const shown = await captureErrorBoxes(run.app);
  const list = join(run.dataDir, "documents.json");
  chmodSync(list, 0o000);
  try {
    const other = join(run.folder, "other.md");
    writeFileSync(other, "Other.\n");
    await openFromFinder(run.app, other);
    await expect
      .poll(shown)
      .toEqual(["Can't open other: Corillo can't read the comments and history it keeps for it right now. Try again in a moment."]);
    expect((await tabState(run.page)).names).toEqual(["proposal.md"]);
  } finally {
    chmodSync(list, 0o644);
  }
  await run.app.close();
});

// The person may be in the middle of something else: a box that stops everything is only for what they asked (R-MAIN-12).
test("when an agent opens a document whose comments and history can't be read right now, the agent is told and the corner says so; no box stops the person", async () => {
  const run = await openText("Plan.\n");
  const shown = await captureErrorBoxes(run.app);
  const other = join(run.folder, "other.md");
  writeFileSync(other, "Other.\n");
  const { session } = await AgentSession.start(run.dataDir);
  const list = join(run.dataDir, "documents.json");
  chmodSync(list, 0o000);
  try {
    const opened = await session.call("open_document", { path: other });
    expect(opened.isError).toBe(true);
    expect(opened.text).toContain("Corillo couldn't open other.md");
    await expect(run.page.locator(".file-notice")).toContainText("Can't open other.");
    await expect(run.page.locator(".file-notice")).toContainText("Corillo can't read the comments and history it keeps for it right now.");
    expect(await shown()).toEqual([]);
    expect((await tabState(run.page)).names).toEqual(["proposal.md"]);
  } finally {
    chmodSync(list, 0o644);
    await session.stop();
  }
  await run.app.close();
});

test("an error nobody expected is told in plain words, at most once a minute, and Corillo carries on", async () => {
  const run = await openText("Plan.\n");
  await run.app.evaluate(({ dialog }) => {
    const g = globalThis as unknown as { asked: string[] };
    g.asked = [];
    dialog.showMessageBox = (async (options: { message: string; detail: string }) => {
      g.asked.push(`${options.message} ${options.detail}`);
      return { response: 0, checkboxChecked: false };
    }) as unknown as typeof dialog.showMessageBox;
    for (let i = 0; i < 2; i++) {
      setTimeout(() => {
        throw new Error("a test error");
      }, 10);
    }
  });
  const asked = () => run.app.evaluate(() => (globalThis as unknown as { asked: string[] }).asked);
  await expect.poll(asked).toEqual(["Something went wrong in Corillo. If something doesn't work as it should, quit Corillo and open it again."]);
  await cursorAtEnd(run.page, "Plan.");
  await run.page.keyboard.type(" Still here.");
  await expectFile(run, "Plan. Still here.\n");
  expect(await asked()).toHaveLength(1);
  await run.app.close();
});

// The person was closing it: a crash during its last saves doesn't bring it back (R-MAIN-14).
test("if the page stops working while the person closes the window, the window stays closed", async () => {
  const run = await openText("Plan.\n");
  await run.app.evaluate(({ BrowserWindow }) => {
    const w = BrowserWindow.getAllWindows()[0];
    w.close(); // its tabs are asked to save what they haven't yet...
    w.webContents.forcefullyCrashRenderer(); // ...and the page stops working meanwhile
  });
  await expect.poll(() => run.app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows().length)).toBe(0);
  await new Promise((r) => setTimeout(r, 1500));
  expect(await run.app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows().length)).toBe(0);
  expect(run.text()).toBe("Plan.\n");
  await run.app.close();
});

test("if the window's page stops working, Corillo reopens it with the same documents and a plain notice; if it stops again straight away, it opens without them", async () => {
  const run = await openText("Plan.\n");
  await openAlso(run, "budget.md", "Budget.\n");
  await run.page.locator('.tab[title$="/proposal.md"]').click();
  await expect.poll(async () => (await tabState(run.page)).active).toBe("proposal.md");
  const crash = async () => {
    const [page] = await Promise.all([
      run.app.waitForEvent("window"),
      run.app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].webContents.forcefullyCrashRenderer()),
    ]);
    return page;
  };
  const page = await crash();
  await page.waitForSelector(".ProseMirror");
  await expect.poll(() => tabState(page)).toEqual({ names: ["proposal.md", "budget.md"], active: "proposal.md" });
  await expect(page.locator(".file-notice")).toContainText("Corillo's window stopped working and was reopened.");
  await expect(page.locator(".file-notice")).toContainText("Your documents are as they were last saved.");
  await cursorAtEnd(page, "Plan.");
  await page.keyboard.type(" After.");
  await expectFile(run, "Plan. After.\n");
  // Again within moments: no going round in circles, the start screen instead.
  const again = await crash();
  await again.waitForSelector("#empty:not([hidden])");
  await expect(again.locator(".file-notice")).toContainText("Corillo's window stopped working again, so it opened without your documents.");
  expect((await tabState(again)).names).toEqual([]);
  await run.app.close();
});

// A page that stops answering (MP-9) ----------------------------------------------------

/** The window's page stops answering: busy for good, as if stuck on something huge. */
async function hang(page: Page): Promise<void> {
  await page.evaluate(() => {
    setTimeout(() => {
      for (;;);
    }, 0);
  });
}

/** A run whose window hung is never left behind, whatever happens in the test. */
async function stopped(run: { app: ElectronApplication }, body: () => Promise<void>): Promise<void> {
  const program = run.app.process();
  try {
    await body();
  } finally {
    if (program.exitCode === null && program.signalCode === null) program.kill("SIGKILL");
  }
}

/** Note the questions Corillo asks from now on, answering each with this button. */
async function answerWith(app: ElectronApplication, button: string): Promise<() => Promise<string[]>> {
  await app.evaluate(({ dialog }, chosen) => {
    const g = globalThis as unknown as { asked: string[] };
    g.asked = [];
    dialog.showMessageBox = (async (_w: unknown, options: { message: string; buttons: string[] }) => {
      g.asked.push(`${options.message} [${options.buttons.join(", ")}]`);
      return { response: options.buttons.indexOf(chosen), checkboxChecked: false };
    }) as unknown as typeof dialog.showMessageBox;
  }, button);
  return () => app.evaluate(() => (globalThis as unknown as { asked: string[] }).asked);
}

test("a window that stops answering gets the choice to wait or reopen it; Reopen brings its documents back (MP-9)", async () => {
  const run = await openText("# Plan\n\nKept.\n", { name: "plan.md" });
  await stopped(run, async () => {
    const asked = await answerWith(run.app, "Reopen");
    await hang(run.page);
    // What the browser engine says when a page hasn't answered for a while.
    const [page] = await Promise.all([
      run.app.waitForEvent("window"),
      run.app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].webContents.emit("unresponsive")),
    ]);
    expect(await asked()).toEqual(["Corillo's window isn't responding. [Wait, Reopen]"]);
    await page.waitForSelector(".ProseMirror");
    await expect(page.locator(`${EDITOR} p`)).toHaveText("Kept.");
    await expect.poll(async () => (await tabState(page)).names).toEqual(["plan.md"]);
    await cursorAtEnd(page, "Kept.");
    await page.keyboard.type(" Again.");
    await expectFile(run, "# Plan\n\nKept. Again.\n");
    await run.app.close();
  });
});

test("Wait leaves the window as it is, asks only once, and the question goes away by itself once the page answers again (MP-9)", async () => {
  const run = await openText("Plan.\n");
  await run.app.evaluate(({ dialog }) => {
    const g = globalThis as unknown as { asked: string[]; gone: number };
    g.asked = [];
    g.gone = 0;
    // The person leaves the question up: it's answered only by going away.
    dialog.showMessageBox = ((_w: unknown, options: { message: string; signal?: AbortSignal; cancelId?: number }) => {
      g.asked.push(options.message);
      return new Promise((resolve) => {
        options.signal?.addEventListener("abort", () => {
          g.gone++;
          resolve({ response: options.cancelId ?? 0, checkboxChecked: false });
        });
      });
    }) as unknown as typeof dialog.showMessageBox;
  });
  const say = (event: string) => run.app.evaluate(({ BrowserWindow }, e) => BrowserWindow.getAllWindows()[0].webContents.emit(e), event);
  await say("unresponsive");
  await say("unresponsive");
  const state = () =>
    run.app.evaluate(() => {
      const g = globalThis as unknown as { asked: string[]; gone: number };
      return { asked: g.asked, gone: g.gone };
    });
  expect(await state()).toEqual({ asked: ["Corillo's window isn't responding."], gone: 0 });
  await say("responsive");
  await expect.poll(state).toEqual({ asked: ["Corillo's window isn't responding."], gone: 1 });
  expect(await run.app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows().length)).toBe(1);
  await cursorAtEnd(run.page, "Plan.");
  await run.page.keyboard.type(" Still here.");
  await expectFile(run, "Plan. Still here.\n");
  await run.app.close();
});

test("Quit never hangs on a window that stopped answering (MP-9)", async () => {
  const run = await openText("Kept.\n");
  await stopped(run, async () => {
    await hang(run.page);
    const quit = Date.now();
    await Promise.all([run.app.waitForEvent("close", { timeout: 20_000 }), run.app.evaluate(({ app }) => app.quit())]);
    expect(Date.now() - quit).toBeLessThan(15_000);
  });
});

test("closing a window that stopped answering doesn't hang either, and the window comes back from the Dock (MP-9)", async () => {
  const run = await openText("Kept.\n");
  await stopped(run, async () => {
    await hang(run.page);
    const closing = Date.now();
    await run.app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].close());
    await expect.poll(() => run.app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows().length), { timeout: 15_000 }).toBe(0);
    expect(Date.now() - closing).toBeLessThan(15_000);
    const [page] = await Promise.all([run.app.waitForEvent("window"), run.app.evaluate(({ app }) => app.emit("activate"))]);
    await page.waitForSelector("#empty");
    await run.app.close();
  });
});

test("an agent asking for a document while the window has stopped answering gets a plain answer within seconds, never a call that hangs (MP-9)", async () => {
  test.setTimeout(90_000);
  const run = await openText("# Plan\n\nKept.\n", { name: "plan.md" });
  const { session } = await AgentSession.start(run.dataDir);
  await stopped(run, async () => {
    try {
      await answerWith(run.app, "Wait"); // if the Mac asks whether to wait for the window, the person waits
      await hang(run.page);
      // Reading: the text as last saved, saying the person may have edits not saved yet.
      let started = Date.now();
      const read = await session.call("read_document", { path: run.file });
      expect(Date.now() - started).toBeLessThan(15_000);
      expect(read.isError).toBe(false);
      expect(read.text).toContain("Kept.");
      expect(read.text).toContain("Corillo's window didn't answer in time, so the person may have edits that aren't saved yet.");
      // Taking it: refused plainly, and the document stays free.
      started = Date.now();
      const take = await session.call("take_document", { path: run.file });
      expect(Date.now() - started).toBeLessThan(15_000);
      expect(take).toEqual({ isError: true, text: expect.stringContaining("Corillo's window didn't answer in time. Try again in a moment.") });
      const list = await session.ok("list_documents");
      expect(list).not.toMatch(/editing/i);
    } finally {
      await session.stop();
    }
  });
});

test("closing the window when one tab's last steps go wrong still saves the other tabs' latest typing", async () => {
  const run = await openText("Plan.\n");
  // The first tab has a reply typed and not posted, so closing asks about it; here that question fails.
  await run.page.evaluate(async () => {
    const id = document.querySelector(".doc:not([hidden])")!.getAttribute("data-doc-id")!;
    await window.corillo.addComment(id, "Is this right?", null, null);
  });
  const card = run.page.locator(".doc:not([hidden]) .comment-card:not(.draft)", { hasText: "Is this right?" });
  await card.click();
  await run.page.getByRole("textbox", { name: "Reply" }).fill("Not posted.");
  await run.app.evaluate(({ ipcMain }) => {
    ipcMain.removeHandler("doc:ask-unposted");
    ipcMain.handle("doc:ask-unposted", () => {
      throw new Error("a question that went wrong");
    });
  });
  const budget = await openAlso(run, "budget.md", "Budget.\n");
  await expect.poll(async () => (await tabState(run.page)).active).toBe("budget.md");
  await cursorAtEnd(run.page, "Budget.");
  await run.page.keyboard.type(" Typed just before closing.");
  await closeWindow(run.app, run.page);
  expect(readFileSync(budget, "utf8")).toBe("Budget. Typed just before closing.\n");
  await run.app.close();
});

/** Error boxes Corillo shows from now on, as "title: content". */
async function captureErrorBoxes(app: ElectronApplication): Promise<() => Promise<string[]>> {
  await app.evaluate(({ dialog }) => {
    const g = globalThis as unknown as { shown: string[] };
    g.shown = [];
    dialog.showErrorBox = (title: string, content: string) => {
      g.shown.push(`${title}: ${content}`);
    };
  });
  return () => app.evaluate(() => (globalThis as unknown as { shown: string[] }).shown);
}

/** Like openText, but with a data folder the test keeps for a second launch. */
async function launchOn(text: string, dataDir: string) {
  const folder = tempFolder("corillo-doc-");
  const file = join(folder, "proposal.md");
  writeFileSync(file, text);
  const { app, page } = await launch([file], dataDir);
  await page.waitForSelector(".ProseMirror");
  return { app, page, file, folder };
}
