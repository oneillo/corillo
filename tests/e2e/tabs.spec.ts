// Tabs, Open Recent, Copy path, renaming or moving a document, dark mode.
import { test, expect } from "@playwright/test";
import { chmodSync, copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, unlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  openText,
  openAlso,
  expectFile,
  cursorAtEnd,
  clickMenu,
  recentMenu,
  captureClipboard,
  tabState,
  pickInNextDialog,
  selectText,
  settle,
  EDITOR,
  FIXTURES,
  type Running,
} from "./helpers";
import { tidyRuns } from "./tidy";
import { AgentSession } from "./agent-session";

test("each document opens in its own tab, and tabs keep their own text", async () => {
  const run = await openText("# First\n\nAlpha.\n", { name: "first.md" });
  const second = await openAlso(run, "second.md", "# Second\n\nBeta.\n");
  await expect.poll(() => tabState(run.page)).toEqual({ names: ["first.md", "second.md"], active: "second.md" });
  await expect(run.page.locator(`${EDITOR} h1`)).toHaveText("Second");
  await cursorAtEnd(run.page, "Beta.");
  await run.page.keyboard.type(" Typed in second.");
  await expect.poll(() => readFileSync(second, "utf8")).toBe("# Second\n\nBeta. Typed in second.\n");
  await run.page.locator('.tab[title$="/first.md"]').click();
  await expect(run.page.locator(`${EDITOR} h1`)).toHaveText("First");
  expect(run.text()).toBe("# First\n\nAlpha.\n");
  // Opening a document that's already open just switches to its tab.
  await openAlso(run, "second.md", "# Second\n\nBeta. Typed in second.\n");
  await expect.poll(() => tabState(run.page)).toEqual({ names: ["first.md", "second.md"], active: "second.md" });
  await run.app.close();
});

test("opening a document from a terminal while Corillo is running finds it in the terminal's folder", async () => {
  const run = await openText("First.\n");
  const elsewhere = mkdtempSync(join(tmpdir(), "corillo-terminal-"));
  writeFileSync(join(elsewhere, "notes.md"), "Notes.\n");
  // What a second launch hands the running Corillo: its command line, and the folder it was started in.
  await run.app.evaluate(({ app }, folder) => {
    app.emit("second-instance", {}, [process.execPath, ".", "notes.md"], folder, {});
  }, elsewhere);
  await expect.poll(() => tabState(run.page)).toEqual({ names: ["proposal.md", "notes.md"], active: "notes.md" });
  await run.app.close();
});

test("Cmd-1, Cmd-2 and Ctrl-Tab move between tabs", async () => {
  const run = await openText("One.\n", { name: "one.md" });
  await openAlso(run, "two.md", "Two.\n");
  await openAlso(run, "three.md", "Three.\n");
  await expect.poll(async () => (await tabState(run.page)).active).toBe("three.md");
  await run.page.keyboard.press("Meta+1");
  expect((await tabState(run.page)).active).toBe("one.md");
  await run.page.keyboard.press("Meta+Shift+BracketRight");
  expect((await tabState(run.page)).active).toBe("two.md");
  await clickMenu(run.app, "next-tab");
  await expect.poll(async () => (await tabState(run.page)).active).toBe("three.md");
  await clickMenu(run.app, "next-tab");
  await expect.poll(async () => (await tabState(run.page)).active).toBe("one.md");
  await run.app.close();
});

test("closing a tab saves it first; closing the last shows the start screen with recent documents", async () => {
  const run = await openText("Keep me.\n", { name: "notes.md" });
  await cursorAtEnd(run.page, "Keep me.");
  await run.page.keyboard.type(" Saved on close.");
  await clickMenu(run.app, "close-tab");
  await expect.poll(run.text).toBe("Keep me. Saved on close.\n");
  await expect(run.page.locator(".tab")).toHaveCount(0);
  await expect(run.page.getByRole("button", { name: "Open a document…" })).toBeVisible();
  await run.page.getByRole("button", { name: /^Open notes, in / }).click();
  await expect(run.page.locator(`${EDITOR} p`)).toHaveText("Keep me. Saved on close.");
  await run.app.close();
});

test("Cmd-W closes the tab in front", async () => {
  const run = await openText("A.\n", { name: "a.md" });
  await openAlso(run, "b.md", "B.\n");
  await expect.poll(async () => (await tabState(run.page)).names).toEqual(["a.md", "b.md"]);
  await clickMenu(run.app, "close-tab");
  await expect.poll(() => tabState(run.page)).toEqual({ names: ["a.md"], active: "a.md" });
  await run.app.close();
});

test("Open Recent lists documents, newest first, and can be cleared", async () => {
  const run = await openText("A.\n", { name: "a.md" });
  await openAlso(run, "b.md", "B.\n");
  await expect.poll(() => recentMenu(run.app)).toEqual(["b", "a"]);
  await clickMenu(run.app, "clear-recent");
  await expect.poll(() => recentMenu(run.app)).toEqual([]);
  await run.app.close();
});

test("a recent document that was moved or deleted since says so when clicked, and its card says it can't be found", async () => {
  const run = await openText("A.\n", { name: "a.md" });
  const other = await openAlso(run, "b.md", "B.\n");
  await expect.poll(() => recentMenu(run.app)).toEqual(["b", "a"]);
  await clickMenu(run.app, "close-tab");
  await clickMenu(run.app, "close-tab");
  await expect(run.page.locator("#recent .recent-name")).toHaveText(["b", "a"]);
  unlinkSync(other); // deleted in Finder while the start screen shows
  await run.app.evaluate(({ dialog }) => {
    const g = globalThis as unknown as { told: string[] };
    g.told = [];
    dialog.showMessageBox = (async (...args: unknown[]) => {
      const o = args[args.length - 1] as { message: string; detail?: string };
      g.told.push(`${o.message} ${o.detail ?? ""}`.trim());
      return { response: 0, checkboxChecked: false };
    }) as typeof dialog.showMessageBox;
  });
  await run.page.getByRole("button", { name: /^Open b, in / }).click();
  await expect
    .poll(() => run.app.evaluate(() => (globalThis as unknown as { told: string[] }).told))
    .toEqual(["Corillo can't find b. It may have been moved, renamed or deleted."]);
  await expect(run.page.locator("#recent .recent-gone")).toHaveText(["Can't be found"]);
  await expect.poll(() => recentMenu(run.app)).toEqual(["a"]);
  await run.app.close();
});

test("Copy path puts the document's full path on the clipboard", async () => {
  const run = await openText("Point an agent here.\n");
  const copied = await captureClipboard(run.app);
  await run.page.getByRole("button", { name: "Copy path" }).click();
  await expect(run.page.getByRole("button", { name: "Path copied" })).toBeVisible();
  expect(await copied()).toBe(run.file);
  await clickMenu(run.app, "copy-path");
  expect(await copied()).toBe(run.file);
  await run.app.close();
});

test("renaming a document takes its pictures folder along and keeps the pictures showing", async () => {
  const text = "Chart:\n\n![chart](<proposal images/chart.png>)\n";
  const run = await openText(text, {
    prepare: (folder) => {
      mkdirSync(join(folder, "proposal images"));
      copyFileSync(join(FIXTURES, "chart.png"), join(folder, "proposal images", "chart.png"));
    },
  });
  const target = join(run.folder, "Q3 plan.md");
  await run.app.evaluate(({ dialog }, picked) => {
    dialog.showSaveDialog = (async () => ({ canceled: false, filePath: picked })) as typeof dialog.showSaveDialog;
  }, target);
  await clickMenu(run.app, "rename");
  await expect.poll(() => existsSync(target)).toBe(true);
  expect(existsSync(run.file)).toBe(false);
  expect(existsSync(join(run.folder, "Q3 plan images", "chart.png"))).toBe(true);
  expect(existsSync(join(run.folder, "proposal images"))).toBe(false);
  await expect.poll(() => readFileSync(target, "utf8")).toBe("Chart:\n\n![chart](Q3%20plan%20images/chart.png)\n");
  await expect.poll(async () => (await tabState(run.page)).names).toEqual(["Q3 plan.md"]);
  const img = run.page.locator(`${EDITOR} .picture img`);
  await expect.poll(() => img.evaluate((el: HTMLImageElement) => el.naturalWidth)).toBe(60);
  // Typing afterwards saves to the new place.
  await cursorAtEnd(run.page, "Chart:");
  await run.page.keyboard.type(" Q3");
  await expect.poll(() => readFileSync(target, "utf8")).toContain("Chart: Q3");
  await run.app.close();
});

test("closing a tab whose file changed outside Corillo asks first, and Cancel keeps it open", async () => {
  const run = await openText("Mine.\n");
  await cursorAtEnd(run.page, "Mine.");
  await run.page.keyboard.type(" Edited.");
  // Changed outside before Corillo's autosave runs, so both sides have changes.
  writeFileSync(run.file, "Theirs.\n");
  await expect(run.page.locator(".conflict")).toBeVisible();
  const answer = (response: number) =>
    run.app.evaluate(({ dialog }, r) => {
      dialog.showMessageBox = (async () => ({ response: r, checkboxChecked: false })) as typeof dialog.showMessageBox;
    }, response);
  await answer(2); // Cancel
  await clickMenu(run.app, "close-tab");
  await run.page.waitForTimeout(300);
  await expect(run.page.locator(".tab")).toHaveCount(1);
  expect(run.text()).toBe("Theirs.\n");
  await answer(0); // Keep my version
  await clickMenu(run.app, "close-tab");
  await expect(run.page.locator(".tab")).toHaveCount(0);
  expect(run.text()).toBe("Mine. Edited.\n");
  await run.app.close();
});

test("follows the Mac's dark appearance", async () => {
  const run = await openText("Night.\n");
  const ground = () => run.page.evaluate(() => getComputedStyle(document.body).backgroundColor);
  await run.page.emulateMedia({ colorScheme: "light" });
  expect(await ground()).toBe("rgb(234, 237, 236)");
  await run.page.emulateMedia({ colorScheme: "dark" });
  expect(await ground()).toBe("rgb(27, 32, 35)");
  await run.app.close();
});

test("Insert, Picture still goes to the right document's folder with two tabs open", async () => {
  const run = await openText("One.\n", { name: "one.md" });
  const two = await openAlso(run, "two.md", "Two.\n");
  await cursorAtEnd(run.page, "Two.");
  await pickInNextDialog(run.app, join(FIXTURES, "chart.png"));
  await run.page.getByRole("button", { name: "Insert", exact: true }).click();
  await run.page.getByRole("menu", { name: "Insert" }).getByRole("menuitem", { name: "Picture…" }).click();
  await expect.poll(() => readFileSync(two, "utf8")).toBe("Two.![chart](two%20images/chart.png)\n");
  expect(existsSync(join(run.folder, "two images", "chart.png"))).toBe(true);
  await expectFile(run, "One.\n");
  await run.app.close();
});

test("the tab bar shows only when more than one document is open", async () => {
  const run = await openText("One.\n", { name: "one.md" });
  const bar = run.page.locator(".tabs");
  await expect(bar).toBeHidden();
  expect(await run.app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].getTitle())).toBe("one");
  await openAlso(run, "two.md", "Two.\n");
  await expect(bar).toBeVisible();
  await expect.poll(async () => (await tabState(run.page)).names).toEqual(["one.md", "two.md"]);
  await clickMenu(run.app, "close-tab");
  await expect(bar).toBeHidden();
  await run.app.close();
});

// Tests below this line remove the folders they made when they're done.
const tidy = tidyRuns();
const start = async (text: string, name: string) => tidy.keep(await openText(text, { name }));

/** Choose File > Close Tab twice, before the first has finished (as fast as the keys can be pressed). */
function closeTabTwice(run: Running): Promise<void> {
  return run.app.evaluate(({ BrowserWindow }) => {
    const contents = BrowserWindow.getAllWindows()[0].webContents;
    contents.send("menu", "close-tab");
    contents.send("menu", "close-tab");
  });
}

/** The next questions Corillo asks take a moment to be answered, then get this button. Returns how many were asked. */
async function answerSlowly(run: Running, button: number): Promise<() => Promise<number>> {
  await run.app.evaluate(({ dialog }, response) => {
    const g = globalThis as unknown as { asked: number };
    g.asked = 0;
    dialog.showMessageBox = (async () => {
      g.asked++;
      await new Promise((resolve) => setTimeout(resolve, 300));
      return { response, checkboxChecked: false };
    }) as typeof dialog.showMessageBox;
  }, button);
  return () => run.app.evaluate(() => (globalThis as unknown as { asked: number }).asked);
}

test("closing the same tab twice at once closes just that tab: the others stay, each still reachable", async () => {
  const run = await start("Alpha.\n", "a.md");
  await openAlso(run, "b.md", "Beta.\n");
  await openAlso(run, "c.md", "Gamma.\n");
  await run.page.locator('.tab[title$="/a.md"]').click();
  await expect.poll(async () => (await tabState(run.page)).active).toBe("a.md");
  // A comment half written, so the close has to wait for an answer.
  await selectText(run.page, "Alpha");
  await run.page.keyboard.press("Meta+Alt+KeyM");
  await run.page.keyboard.type("Not yet.");
  await answerSlowly(run, 1); // Close Anyway
  await closeTabTwice(run);
  await expect.poll(() => tabState(run.page)).toEqual({ names: ["b.md", "c.md"], active: "b.md" });
  await run.page.waitForTimeout(500); // the second close, had there been one, is over too
  expect(await tabState(run.page)).toEqual({ names: ["b.md", "c.md"], active: "b.md" });
  // The last tab is still a real tab: it comes to the front, and its document can be typed in.
  await run.page.locator('.tab[title$="/c.md"]').click();
  await expect(run.page.locator(`${EDITOR} p`)).toHaveText("Gamma.");
  await cursorAtEnd(run.page, "Gamma.");
  await run.page.keyboard.type(" Still here.");
  await expect.poll(() => readFileSync(join(run.folder, "c.md"), "utf8")).toBe("Gamma. Still here.\n");
  // Opening it again goes to its tab, as for any open document.
  await run.page.locator('.tab[title$="/b.md"]').click();
  await run.page.evaluate((p) => window.corillo.openPath(p), join(run.folder, "c.md"));
  await expect.poll(async () => (await tabState(run.page)).active).toBe("c.md");
});

test("closing a tab twice while its unposted comment is asked about, and going back to it, keeps every tab", async () => {
  const run = await start("Alpha.\n", "a.md");
  await openAlso(run, "b.md", "Beta.\n");
  await openAlso(run, "c.md", "Gamma.\n");
  await run.page.locator('.tab[title$="/a.md"]').click();
  await selectText(run.page, "Alpha");
  await run.page.keyboard.press("Meta+Alt+KeyM");
  await run.page.keyboard.type("Not yet.");
  const asked = await answerSlowly(run, 0); // Go Back to It
  await closeTabTwice(run);
  await run.page.waitForTimeout(800);
  expect(await tabState(run.page)).toEqual({ names: ["a.md", "b.md", "c.md"], active: "a.md" });
  // One question for one close, however many times it was asked for.
  expect(await asked()).toBe(1);
  await expect(run.page.getByRole("textbox", { name: "New comment" })).toHaveValue("Not yet.");
  await expect(run.page.getByRole("textbox", { name: "New comment" })).toBeFocused();
});

/** A comment on the document in front, and its card's reply box with words typed and not posted. */
async function replyTyped(run: Running, words: string): Promise<void> {
  await run.page.evaluate(async () => {
    const id = document.querySelector(".doc:not([hidden])")!.getAttribute("data-doc-id")!;
    await window.corillo.addComment(id, "Is this right?", null, null);
  });
  await run.page.locator(".doc:not([hidden]) .comment-card:not(.draft)", { hasText: "Is this right?" }).click();
  const reply = run.page.locator(".doc:not([hidden])").getByRole("textbox", { name: "Reply" });
  await reply.click();
  await run.page.keyboard.type(words);
  await expect(reply).toBeFocused();
}

/** Press Command and a digit, several times, all within one frame (as fast key repeat does on a busy Mac). */
function switchQuickly(run: Running, keys: string[]): Promise<void> {
  return run.page.evaluate((list) => {
    for (const key of list) {
      document.dispatchEvent(new KeyboardEvent("keydown", { key, code: `Digit${key}`, metaKey: true, bubbles: true, cancelable: true }));
    }
  }, keys);
}

test("switching tabs quickly never leaves the keyboard in the document of a tab where a reply was being written", async () => {
  const run = await start("One.\n", "one.md");
  await openAlso(run, "two.md", "Two.\n");
  await expect.poll(async () => (await tabState(run.page)).active).toBe("two.md");
  await replyTyped(run, "Half a reply");
  // To the first tab, back to the second and to the first again, before the window is drawn once.
  await switchQuickly(run, ["1", "2", "1"]);
  await expect.poll(async () => (await tabState(run.page)).active).toBe("one.md");
  await settle(run.page);
  await run.page.keyboard.press("Meta+2");
  await expect.poll(async () => (await tabState(run.page)).active).toBe("two.md");
  const reply = run.page.locator(".doc:not([hidden])").getByRole("textbox", { name: "Reply" });
  await expect(reply).toBeFocused();
  await run.page.keyboard.type(", and the rest.");
  await expect(reply).toHaveValue("Half a reply, and the rest.");
  await expect(run.page.locator(`${EDITOR} p`)).toHaveText("Two.");
});

test("Command and the number of the tab already in front leaves the keyboard in the comment box it's in", async () => {
  const run = await start("One.\n", "one.md");
  await openAlso(run, "two.md", "Two.\n");
  await expect.poll(async () => (await tabState(run.page)).active).toBe("two.md");
  await replyTyped(run, "Half a reply");
  await run.page.keyboard.press("Meta+2");
  await settle(run.page);
  const reply = run.page.locator(".doc:not([hidden])").getByRole("textbox", { name: "Reply" });
  await expect(reply).toBeFocused();
  await run.page.keyboard.type(", and the rest.");
  await expect(reply).toHaveValue("Half a reply, and the rest.");
});

/** Where the tab in front is, against the tab bar's visible part. */
function frontTabInSight(run: Running): Promise<{ name: string; inSight: boolean }> {
  return run.page.evaluate(() => {
    const bar = document.querySelector(".tabs")!.getBoundingClientRect();
    const tab = document.querySelector<HTMLElement>('.tab[aria-selected="true"]')!;
    const r = tab.getBoundingClientRect();
    return { name: tab.title.split("/").pop()!, inSight: r.left >= bar.left - 0.5 && r.right <= bar.right + 0.5 };
  });
}

test("with more tabs than the bar can show, the tab in front is always in sight", async () => {
  const run = await start("Doc 1.\n", "doc-01.md");
  await run.page.setViewportSize({ width: 700, height: 600 });
  for (let i = 2; i <= 14; i++) {
    const name = `doc-${String(i).padStart(2, "0")}.md`;
    await openAlso(run, name, `Doc ${i}.\n`);
    await expect.poll(async () => (await tabState(run.page)).active).toBe(name);
  }
  // More tabs than fit: the bar scrolls sideways.
  expect(await run.page.evaluate(() => document.querySelector(".tabs")!.scrollWidth > document.querySelector(".tabs")!.clientWidth)).toBe(true);
  await expect.poll(() => frontTabInSight(run)).toEqual({ name: "doc-14.md", inSight: true });
  await run.page.keyboard.press("Meta+1");
  await expect.poll(() => frontTabInSight(run)).toEqual({ name: "doc-01.md", inSight: true });
  await run.page.keyboard.press("Meta+9");
  await expect.poll(() => frontTabInSight(run)).toEqual({ name: "doc-14.md", inSight: true });
  await run.page.keyboard.press("Meta+Shift+BracketRight"); // round to the first
  await expect.poll(() => frontTabInSight(run)).toEqual({ name: "doc-01.md", inSight: true });
  await run.page.keyboard.press("Meta+Shift+BracketLeft"); // and back round to the last
  await expect.poll(() => frontTabInSight(run)).toEqual({ name: "doc-14.md", inSight: true });
});

test("with more tabs than the bar can show, the tab in front stays in sight as the window narrows", async () => {
  const run = await start("Doc 1.\n", "doc-01.md");
  await run.page.setViewportSize({ width: 1500, height: 600 });
  for (let i = 2; i <= 12; i++) {
    const name = `doc-${String(i).padStart(2, "0")}.md`;
    await openAlso(run, name, `Doc ${i}.\n`);
    await expect.poll(async () => (await tabState(run.page)).active).toBe(name);
  }
  await expect.poll(() => frontTabInSight(run)).toEqual({ name: "doc-12.md", inSight: true });
  for (const width of [1100, 800, 600]) {
    await run.page.setViewportSize({ width, height: 600 });
    await expect.poll(() => frontTabInSight(run)).toEqual({ name: "doc-12.md", inSight: true });
  }
});

test("after moving along the tabs with the arrows and Tab away, Shift-Tab comes back to the tab in front", async () => {
  const run = await start("Alpha.\n", "a.md");
  await openAlso(run, "b.md", "Beta.\n");
  await openAlso(run, "c.md", "Gamma.\n");
  const { page } = run;
  await page.locator('.tab[title$="/b.md"]').click();
  await expect.poll(async () => (await tabState(page)).active).toBe("b.md");
  await settle(page);
  const focused = () =>
    page.evaluate(() => {
      const el = document.activeElement;
      if (el?.getAttribute("role") === "tab") return (el as HTMLElement).title.split("/").pop()!; // its file's name
      return el?.closest(".ProseMirror") ? "document" : el?.closest("#toolbar") ? "toolbar" : (el?.tagName ?? null);
    });
  await page.getByRole("button", { name: "Outline", exact: true }).focus(); // the toolbar's first stop
  await page.keyboard.press("Shift+Tab");
  expect(await focused()).toBe("b.md");
  await page.keyboard.press("ArrowRight");
  await page.keyboard.press("ArrowRight");
  expect(await focused()).toBe("a.md");
  await page.keyboard.press("Tab");
  expect(await focused()).toBe("toolbar");
  await page.keyboard.press("Shift+Tab");
  expect(await focused()).toBe("b.md");
  expect((await tabState(page)).active).toBe("b.md");
});

test("a tab out of sight whose file can't be saved, or went missing, shows a small warm mark saying what's wrong", async () => {
  const run = await start("Alpha.\n", "a.md");
  const b = await openAlso(run, "b.md", "Beta.\n");
  const c = await openAlso(run, "c.md", "Gamma.\n");
  const mark = (name: string) => run.page.locator(`.tab[title$="/${name}"]`).locator(".tab-problem");
  await expect(mark("a.md")).toBeHidden();
  // a.md can't be written: the save made after switching away fails in the background.
  await run.page.locator('.tab[title$="/a.md"]').click();
  chmodSync(run.file, 0o444);
  await cursorAtEnd(run.page, "Alpha.");
  await run.page.keyboard.type(" More.");
  await run.page.keyboard.press("Meta+3");
  await expect(mark("a.md")).toBeVisible();
  await expect(mark("a.md")).toHaveAttribute("title", /^Not saved: /);
  await expect(run.page.locator('.tab[title$="/a.md"]')).toHaveAttribute("aria-label", /^a, not saved: /);
  // b.md deleted in Finder while it's out of sight.
  unlinkSync(b);
  await expect(mark("b.md")).toBeVisible();
  await expect(mark("b.md")).toHaveAttribute("title", "Not saved: the file was deleted");
  await expect(mark("c.md")).toBeHidden();
  // Put right: the marks go.
  chmodSync(run.file, 0o644);
  await expect(mark("a.md")).toBeHidden({ timeout: 10_000 });
  writeFileSync(b, "Beta.\n");
  await expect(mark("b.md")).toBeHidden({ timeout: 10_000 });
  expect(readFileSync(run.file, "utf8")).toBe("Alpha. More.\n");
  expect(readFileSync(c, "utf8")).toBe("Gamma.\n");
});

test("tabs from the keyboard: the tab in front takes Tab, the arrows move, Return or Space brings one to the front, Delete closes one", async () => {
  const run = await start("Alpha.\n", "a.md");
  await openAlso(run, "b.md", "Beta.\n");
  await openAlso(run, "c.md", "Gamma.\n");
  const { page } = run;
  await page.locator('.tab[title$="/b.md"]').click();
  await expect.poll(async () => (await tabState(page)).active).toBe("b.md");
  await settle(page); // the keyboard goes into its document a moment later
  /** Where the keyboard is: a tab (by its name), the document, the toolbar. */
  const focused = () =>
    page.evaluate(() => {
      const el = document.activeElement;
      if (el?.getAttribute("role") === "tab") return (el as HTMLElement).title.split("/").pop()!; // its file's name
      return el?.closest(".ProseMirror") ? "document" : el?.closest("#toolbar") ? "toolbar" : (el?.tagName ?? null);
    });
  const fromToolbar = async () => {
    await settle(page);
    await page.getByRole("button", { name: "Outline", exact: true }).focus(); // the toolbar's first stop
    await page.keyboard.press("Shift+Tab");
  };
  // Back from the toolbar, the keyboard reaches the tab in front (the tabs' close buttons aren't stops on the way).
  await fromToolbar();
  expect(await focused()).toBe("b.md");
  await page.keyboard.press("Tab");
  expect(await focused()).toBe("toolbar");
  await page.keyboard.press("Shift+Tab");
  // The arrows move between the tabs, round from the ends, Home and End to the ends; nothing comes to the front yet.
  await page.keyboard.press("ArrowRight");
  expect(await focused()).toBe("c.md");
  await page.keyboard.press("ArrowRight");
  expect(await focused()).toBe("a.md");
  await page.keyboard.press("ArrowLeft");
  expect(await focused()).toBe("c.md");
  await page.keyboard.press("Home");
  expect(await focused()).toBe("a.md");
  await page.keyboard.press("End");
  expect(await focused()).toBe("c.md");
  expect((await tabState(page)).active).toBe("b.md");
  // Return brings it to the front, with the keyboard in its document.
  await page.keyboard.press("Enter");
  await expect.poll(async () => (await tabState(page)).active).toBe("c.md");
  await expect.poll(focused).toBe("document");
  // Space too.
  await fromToolbar();
  expect(await focused()).toBe("c.md");
  await page.keyboard.press("ArrowLeft");
  await page.keyboard.press("Space");
  await expect.poll(async () => (await tabState(page)).active).toBe("b.md");
  await expect.poll(focused).toBe("document");
  // Delete closes the tab the keyboard is on; the keyboard stays in the tab bar, on the tab in front.
  await fromToolbar();
  await page.keyboard.press("ArrowLeft");
  expect(await focused()).toBe("a.md");
  await page.keyboard.press("Backspace");
  await expect.poll(() => tabState(page)).toEqual({ names: ["b.md", "c.md"], active: "b.md" });
  await expect.poll(focused).toBe("b.md");
});

test("Delete on the tab in front closes it and leaves the keyboard in the tab bar, on the tab now in front", async () => {
  const run = await start("Alpha.\n", "a.md");
  await openAlso(run, "b.md", "Beta.\n");
  await openAlso(run, "c.md", "Gamma.\n");
  const { page } = run;
  await page.locator('.tab[title$="/b.md"]').click();
  await expect.poll(async () => (await tabState(page)).active).toBe("b.md");
  await settle(page);
  const focused = () =>
    page.evaluate(() => {
      const el = document.activeElement;
      if (el?.getAttribute("role") === "tab") return (el as HTMLElement).title.split("/").pop()!; // its file's name
      return el?.closest(".ProseMirror") ? "document" : (el?.tagName ?? null);
    });
  await page.getByRole("button", { name: "Outline", exact: true }).focus(); // the toolbar's first stop
  await page.keyboard.press("Shift+Tab");
  expect(await focused()).toBe("b.md");
  await page.keyboard.press("Delete");
  await expect.poll(() => tabState(page)).toEqual({ names: ["a.md", "c.md"], active: "c.md" });
  await page.waitForTimeout(300); // the keyboard used to go into the document a moment later
  expect(await focused()).toBe("c.md");
  // The keys go on working there: Delete again closes that one too, and the keyboard goes to the last tab left.
  await page.keyboard.press("ArrowLeft");
  expect(await focused()).toBe("a.md");
  await page.keyboard.press("ArrowRight");
  await page.keyboard.press("Backspace");
  await expect.poll(() => tabState(page)).toEqual({ names: ["a.md"], active: "a.md" });
  // With one document there's no tab bar: the keyboard goes into the document.
  await expect.poll(focused).toBe("document");
  await run.app.close();
});

test("screen readers hear what a tab's dot means", async () => {
  const run = await start("Notes.\n", "notes.md");
  const plan = await openAlso(run, "plan.md", "Plan.\n");
  await run.page.locator('.tab[title$="/notes.md"]').click();
  await expect(run.page.getByRole("tab", { name: "notes", exact: true })).toHaveAttribute("aria-selected", "true");
  await expect(run.page.getByRole("tab", { name: "plan", exact: true })).toBeVisible();
  // An agent's pass ends on the tab out of sight: its dot lights up, and its name says so
  // (since roadmap Batch 2, item 2, in the tooltip's words: who it's back from).
  const { session } = await AgentSession.start(run.dataDir, "claude-code");
  try {
    await session.ok("take_document", { path: plan });
    await expect(run.page.getByRole("tab", { name: "plan, Claude is editing", exact: true })).toBeVisible();
    await session.ok("finish_editing", { path: plan });
    const tab = run.page.locator('.tab[title$="/plan.md"]');
    await expect(tab.locator(".tab-dot")).toBeVisible();
    await expect(run.page.getByRole("tab", { name: "plan, back from Claude", exact: true })).toBeVisible();
    // Looked at: the dot goes, and so do the words.
    await tab.click();
    await expect(run.page.getByRole("tab", { name: "plan", exact: true })).toHaveAttribute("aria-selected", "true");
  } finally {
    await session.stop();
  }
});

test("the menus have no developer tools", async () => {
  const run = await openText("One.\n");
  const found = await run.app.evaluate(({ Menu }) => {
    const hits: string[] = [];
    const walk = (items: Electron.MenuItem[]) => {
      for (const item of items) {
        if (item.role?.toLowerCase().includes("devtools") || /developer|inspect/i.test(item.label)) hits.push(item.label || String(item.role));
        if (item.submenu) walk(item.submenu.items);
      }
    };
    walk(Menu.getApplicationMenu()?.items ?? []);
    return hits;
  });
  expect(found).toEqual([]);
  await run.app.close();
});

// Moving a tab (roadmap Batch 10, item 1). Orlando, 2026-11-13: "Can we also ensure that in Corillo you
// can move tabs around? To change how they're ordered." By dragging it along the bar, or with a key.

/** Window > Move Tab Left and Move Tab Right: whether each applies now. */
function moveItems(run: Running): Promise<{ left: boolean; right: boolean }> {
  return run.app.evaluate(({ Menu }) => {
    const menu = Menu.getApplicationMenu()!;
    return { left: menu.getMenuItemById("move-tab-left")!.enabled, right: menu.getMenuItemById("move-tab-right")!.enabled };
  });
}

const MOVE_LEFT = "Control+Shift+Meta+ArrowLeft";
const MOVE_RIGHT = "Control+Shift+Meta+ArrowRight";

/** A tab's place on screen, as it's drawn now (moved along by a drag, or not), and its middle. */
async function tabBox(run: Running, name: string): Promise<{ x: number; y: number; width: number; middle: number; centre: number }> {
  const box = (await run.page.locator(`.tab[title$="/${name}"]`).boundingBox())!;
  return { x: box.x, y: box.y, width: box.width, middle: box.x + box.width / 2, centre: box.y + box.height / 2 };
}

/** Where the keyboard is: a tab (by its file's name), or what else has it. */
function keyboardOn(run: Running): Promise<string | null> {
  return run.page.evaluate(() => {
    const el = document.activeElement;
    if (el?.getAttribute("role") === "tab") return (el as HTMLElement).title.split("/").pop()!;
    return el?.closest(".ProseMirror") ? "document" : (el?.tagName ?? null);
  });
}

test("Window > Move Tab Left and Right move the tab in front a place, greyed out at an end and with one document, and the new order is the order everywhere", async () => {
  const run = await start("One.\n", "one.md");
  const { app, page } = run;
  // Shown with their keys.
  const items = await app.evaluate(({ Menu }) =>
    ["move-tab-left", "move-tab-right"].map((id) => {
      const item = Menu.getApplicationMenu()!.getMenuItemById(id)!;
      return [item.label, item.accelerator];
    }),
  );
  expect(items).toEqual([
    ["Move Tab Left", "Ctrl+Shift+Cmd+Left"],
    ["Move Tab Right", "Ctrl+Shift+Cmd+Right"],
  ]);
  // One document has no tab bar: both are greyed out.
  await expect.poll(() => moveItems(run)).toEqual({ left: false, right: false });
  await openAlso(run, "two.md", "Two.\n");
  await openAlso(run, "three.md", "Three.\n");
  await expect.poll(() => tabState(page)).toEqual({ names: ["one.md", "two.md", "three.md"], active: "three.md" });
  // At the right end, Move Tab Right is greyed out: it doesn't go round.
  await expect.poll(() => moveItems(run)).toEqual({ left: true, right: false });
  await clickMenu(app, "move-tab-left");
  await expect.poll(() => tabState(page)).toEqual({ names: ["one.md", "three.md", "two.md"], active: "three.md" });
  await expect.poll(() => moveItems(run)).toEqual({ left: true, right: true });
  // The key does the same, from the document, and the keyboard stays there.
  await page.locator(`${EDITOR} p`).click();
  await settle(page);
  await page.keyboard.press(MOVE_LEFT);
  await expect.poll(() => tabState(page)).toEqual({ names: ["three.md", "one.md", "two.md"], active: "three.md" });
  await expect.poll(() => moveItems(run)).toEqual({ left: false, right: true });
  expect(await keyboardOn(run)).toBe("document");
  // At the left end the key does nothing.
  await page.keyboard.press(MOVE_LEFT);
  await settle(page);
  expect(await tabState(page)).toEqual({ names: ["three.md", "one.md", "two.md"], active: "three.md" });
  await page.keyboard.press(MOVE_RIGHT);
  await expect.poll(() => tabState(page)).toEqual({ names: ["one.md", "three.md", "two.md"], active: "three.md" });
  // His order is the order everywhere: Command and a number, Show Next and Previous Tab.
  await page.keyboard.press("Meta+1");
  await expect.poll(async () => (await tabState(page)).active).toBe("one.md");
  await page.keyboard.press("Meta+3");
  await expect.poll(async () => (await tabState(page)).active).toBe("two.md");
  await clickMenu(app, "previous-tab");
  await expect.poll(async () => (await tabState(page)).active).toBe("three.md");
  await clickMenu(app, "next-tab");
  await expect.poll(async () => (await tabState(page)).active).toBe("two.md");
  await clickMenu(app, "next-tab");
  await expect.poll(async () => (await tabState(page)).active).toBe("one.md");
  // A tab closed: the one after it in his order comes to the front.
  await page.keyboard.press("Meta+2");
  await expect.poll(async () => (await tabState(page)).active).toBe("three.md");
  await clickMenu(app, "close-tab");
  await expect.poll(() => tabState(page)).toEqual({ names: ["one.md", "two.md"], active: "two.md" });
});

test("on the tab bar, the move keys move the tab the keyboard is on, the keyboard stays on it, and a screen reader hears its new place", async () => {
  const run = await start("Alpha.\n", "a.md");
  await openAlso(run, "b.md", "Beta.\n");
  await openAlso(run, "c.md", "Gamma.\n");
  const { page } = run;
  await page.locator('.tab[title$="/b.md"]').click();
  await expect.poll(async () => (await tabState(page)).active).toBe("b.md");
  await settle(page);
  const heard = page.getByRole("status").filter({ hasText: "moved to" });
  // To the tab bar, and along it to c: b is still in front.
  await page.getByRole("button", { name: "Outline", exact: true }).focus();
  await page.keyboard.press("Shift+Tab");
  await page.keyboard.press("ArrowRight");
  expect(await keyboardOn(run)).toBe("c.md");
  await expect.poll(() => moveItems(run)).toEqual({ left: true, right: false });
  await page.keyboard.press(MOVE_LEFT);
  await expect.poll(() => tabState(page)).toEqual({ names: ["a.md", "c.md", "b.md"], active: "b.md" });
  expect(await keyboardOn(run)).toBe("c.md");
  await expect(heard).toHaveText("c, moved to 2 of 3");
  await page.keyboard.press(MOVE_LEFT);
  await expect.poll(() => tabState(page)).toEqual({ names: ["c.md", "a.md", "b.md"], active: "b.md" });
  await expect(heard).toHaveText("c, moved to 1 of 3");
  expect(await keyboardOn(run)).toBe("c.md");
  // The menu goes by the tab the keyboard is on: at the left end now.
  await expect.poll(() => moveItems(run)).toEqual({ left: false, right: true });
  await page.keyboard.press(MOVE_LEFT);
  await settle(page);
  expect((await tabState(page)).names).toEqual(["c.md", "a.md", "b.md"]);
  // The arrows go along the new order; the other way works too.
  await page.keyboard.press("ArrowRight");
  expect(await keyboardOn(run)).toBe("a.md");
  await page.keyboard.press(MOVE_RIGHT);
  await expect.poll(() => tabState(page)).toEqual({ names: ["c.md", "b.md", "a.md"], active: "b.md" });
  await expect(heard).toHaveText("a, moved to 3 of 3");
  expect(await keyboardOn(run)).toBe("a.md");
  // Return brings it to the front, as before.
  await page.keyboard.press("Enter");
  await expect.poll(async () => (await tabState(page)).active).toBe("a.md");
});

test("drag a tab along the bar: it follows the pointer, the others make room, and it stays where it's let go, in front", async () => {
  const run = await start("Alpha.\n", "a.md");
  await openAlso(run, "b.md", "Beta.\n");
  await openAlso(run, "c.md", "Gamma.\n");
  await openAlso(run, "d.md", "Delta.\n");
  const { page } = run;
  await expect.poll(async () => (await tabState(page)).active).toBe("d.md");
  await settle(page);
  const [a, b, c] = [await tabBox(run, "a.md"), await tabBox(run, "b.md"), await tabBox(run, "c.md")];
  await page.mouse.move(a.middle, a.centre);
  await page.mouse.down();
  await page.mouse.move(a.middle + 30, a.centre, { steps: 3 });
  // It follows the pointer, sideways only.
  await expect.poll(async () => Math.round((await tabBox(run, "a.md")).x - a.x)).toBe(30);
  await page.mouse.move(a.middle + 30, a.centre + 20, { steps: 2 });
  expect(Math.round((await tabBox(run, "a.md")).y)).toBe(Math.round(a.y));
  // Past the middles of b and c, they slide aside to make room.
  await page.mouse.move(c.middle + 10, a.centre, { steps: 5 });
  await expect.poll(async () => (await tabBox(run, "b.md")).x).toBeLessThan(b.x - 20);
  await expect.poll(async () => (await tabBox(run, "c.md")).x).toBeLessThan(c.x - 20);
  expect((await tabState(page)).names).toEqual(["a.md", "b.md", "c.md", "d.md"]);
  // Let go below the bar, over the document: it stays where it is along the bar, and comes to the front.
  await page.mouse.move(c.middle + 10, a.centre + 200, { steps: 3 });
  await page.mouse.up();
  await expect.poll(() => tabState(page)).toEqual({ names: ["b.md", "c.md", "a.md", "d.md"], active: "a.md" });
  await expect(page.locator(`${EDITOR} p`)).toHaveText("Alpha.");
  // Nothing was dropped into a document, and one window still holds every tab.
  await settle(page);
  expect(readFileSync(run.file, "utf8")).toBe("Alpha.\n");
  expect(readFileSync(join(run.folder, "d.md"), "utf8")).toBe("Delta.\n");
  expect(await run.app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows().length)).toBe(1);
  // Each tab is where the bar lays it out once it's let go.
  const after = await tabBox(run, "a.md");
  await page.waitForTimeout(300);
  expect(Math.round((await tabBox(run, "a.md")).x)).toBe(Math.round((await tabBox(run, "c.md")).x + (await tabBox(run, "c.md")).width + 4));
  expect(after.y).toBe(a.y);
  // The others slide aside quickly; with Reduce Motion in the Mac's settings they jump.
  const slide = () => page.locator('.tab[title$="/b.md"]').evaluate((el) => getComputedStyle(el).transitionDuration);
  expect(await slide()).toBe("0.12s");
  await page.emulateMedia({ reducedMotion: "reduce" });
  expect(await slide()).toBe("0s");
});

test("a tab pressed and moved less than a few pixels is a click, its close button still works, and Escape during a drag puts the tab back", async () => {
  const run = await start("Alpha.\n", "a.md");
  await openAlso(run, "b.md", "Beta.\n");
  await openAlso(run, "c.md", "Gamma.\n");
  const { page } = run;
  await expect.poll(async () => (await tabState(page)).active).toBe("c.md");
  await settle(page);
  // A press that moves 2 pixels is a click: a comes to the front, and nothing moves.
  const a = await tabBox(run, "a.md");
  await page.mouse.move(a.middle, a.centre);
  await page.mouse.down();
  await page.mouse.move(a.middle + 2, a.centre + 1);
  await page.mouse.up();
  await expect.poll(() => tabState(page)).toEqual({ names: ["a.md", "b.md", "c.md"], active: "a.md" });
  // b's close button, pressed with a small move, closes b.
  const cross = (await page.locator('.tab[title$="/b.md"] .tab-close').boundingBox())!;
  await page.mouse.move(cross.x + cross.width / 2, cross.y + cross.height / 2);
  await page.mouse.down();
  await page.mouse.move(cross.x + cross.width / 2 + 2, cross.y + cross.height / 2);
  await page.mouse.up();
  await expect.poll(() => tabState(page)).toEqual({ names: ["a.md", "c.md"], active: "a.md" });
  await openAlso(run, "d.md", "Delta.\n");
  await expect.poll(() => tabState(page)).toEqual({ names: ["a.md", "c.md", "d.md"], active: "d.md" });
  await settle(page);
  // Escape during a drag: a goes back to its place. Let go on a itself, it doesn't come to the front either.
  const start0 = await tabBox(run, "a.md");
  const d = await tabBox(run, "d.md");
  await page.mouse.move(start0.middle, start0.centre);
  await page.mouse.down();
  await page.mouse.move(d.middle + 10, start0.centre, { steps: 5 });
  await expect.poll(async () => (await tabBox(run, "a.md")).x).toBeGreaterThan(start0.x + 50);
  await page.keyboard.press("Escape");
  await expect.poll(async () => Math.round((await tabBox(run, "a.md")).x)).toBe(Math.round(start0.x));
  await expect.poll(async () => Math.round((await tabBox(run, "c.md")).x)).toBe(Math.round((await tabBox(run, "a.md")).x + start0.width + 4));
  // Moving on after Escape moves nothing.
  await page.mouse.move(start0.middle + 3, start0.centre, { steps: 3 });
  await page.mouse.up();
  await settle(page);
  expect(await tabState(page)).toEqual({ names: ["a.md", "c.md", "d.md"], active: "d.md" });
  // The next press is a click again.
  await page.mouse.click(start0.middle, start0.centre);
  await expect.poll(async () => (await tabState(page)).active).toBe("a.md");
});

test("a tab dragged out of the window stays in it, at the end of the bar it was dragged towards", async () => {
  const run = await start("Alpha.\n", "a.md");
  await openAlso(run, "b.md", "Beta.\n");
  await openAlso(run, "c.md", "Gamma.\n");
  const { page } = run;
  await expect.poll(async () => (await tabState(page)).active).toBe("c.md");
  await settle(page);
  const width = await page.evaluate(() => innerWidth);
  const first = await tabBox(run, "a.md");
  const c = await tabBox(run, "c.md");
  await page.mouse.move(c.middle, c.centre);
  await page.mouse.down();
  await page.mouse.move(-60, c.centre - 80, { steps: 8 });
  // Held at the bar's start, never past it, and on the bar.
  await expect.poll(async () => Math.round((await tabBox(run, "c.md")).x)).toBe(Math.round(first.x));
  expect(Math.round((await tabBox(run, "c.md")).y)).toBe(Math.round(c.y));
  await page.mouse.up();
  await expect.poll(() => tabState(page)).toEqual({ names: ["c.md", "a.md", "b.md"], active: "c.md" });
  const a = await tabBox(run, "a.md");
  await page.mouse.move(a.middle, a.centre);
  await page.mouse.down();
  await page.mouse.move(width + 80, a.centre + 300, { steps: 8 });
  await page.mouse.up();
  await expect.poll(() => tabState(page)).toEqual({ names: ["c.md", "b.md", "a.md"], active: "a.md" });
  expect(await run.app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows().length)).toBe(1);
});

/** Where a tab is against the tab bar's visible part, and how far the bar is scrolled of how far it can be. */
function inSight(run: Running, name: string): Promise<{ inSight: boolean; scrolled: number; most: number }> {
  return run.page.evaluate((file) => {
    const bar = document.querySelector<HTMLElement>(".tabs")!;
    const shown = bar.getBoundingClientRect();
    const r = document.querySelector<HTMLElement>(`.tab[title$="/${file}"]`)!.getBoundingClientRect();
    return { inSight: r.left >= shown.left - 0.5 && r.right <= shown.right + 0.5, scrolled: Math.round(bar.scrollLeft), most: bar.scrollWidth - bar.clientWidth };
  }, name);
}

test("at the narrowest window, with more tabs than the bar shows, dragging near an end scrolls the bar and the moved tab stays in sight", async () => {
  const run = await start("Doc 1.\n", "doc-01.md");
  const { page } = run;
  await page.setViewportSize({ width: 560, height: 600 });
  const names = ["doc-01.md"];
  for (let i = 2; i <= 10; i++) {
    names.push(`doc-${String(i).padStart(2, "0")}.md`);
    await openAlso(run, names[i - 1], `Doc ${i}.\n`);
    await expect.poll(async () => (await tabState(page)).active).toBe(names[i - 1]);
  }
  await page.keyboard.press("Meta+1");
  await expect.poll(() => inSight(run, "doc-01.md")).toMatchObject({ inSight: true, scrolled: 0 });
  const { most } = await inSight(run, "doc-01.md");
  expect(most).toBeGreaterThan(300);
  const bar = (await page.locator(".tabs").boundingBox())!;
  const first = await tabBox(run, "doc-01.md");
  await page.mouse.move(first.middle, first.centre);
  await page.mouse.down();
  // Held near the right end: the bar scrolls along, a little at a time, with the tab in sight all the way.
  await page.mouse.move(bar.x + bar.width - 10, first.centre, { steps: 10 });
  const seen: number[] = [];
  await expect
    .poll(async () => {
      const now = await inSight(run, "doc-01.md");
      expect(now.inSight).toBe(true);
      seen.push(now.scrolled);
      return now.scrolled;
    }, { intervals: [50] })
    .toBe(Math.round(most));
  expect(new Set(seen).size).toBeGreaterThan(2); // in steps, not one jump
  await page.mouse.up();
  await expect.poll(() => tabState(page)).toEqual({ names: [...names.slice(1), "doc-01.md"], active: "doc-01.md" });
  await expect.poll(() => inSight(run, "doc-01.md")).toMatchObject({ inSight: true });
  // And back to the left end.
  const last = await tabBox(run, "doc-01.md");
  await page.mouse.move(last.middle, last.centre);
  await page.mouse.down();
  await page.mouse.move(bar.x + 6, last.centre, { steps: 10 });
  await expect.poll(async () => (await inSight(run, "doc-01.md")).scrolled, { intervals: [50] }).toBe(0);
  expect((await inSight(run, "doc-01.md")).inSight).toBe(true);
  await page.mouse.up();
  await expect.poll(() => tabState(page)).toEqual({ names, active: "doc-01.md" });
});

test("dragging tabs many times, with Escape and the bar scrolling, leaves no listeners, frames or timers behind", async () => {
  const run = await start("Doc 1.\n", "doc-01.md");
  const { page } = run;
  await page.setViewportSize({ width: 560, height: 600 });
  for (let i = 2; i <= 8; i++) await openAlso(run, `doc-0${i}.md`, `Doc ${i}.\n`);
  await expect.poll(async () => (await tabState(page)).names.length).toBe(8);
  const bar = (await page.locator(".tabs").boundingBox())!;
  /** Drag the tab in front to near an end of the bar and let go (or press Escape first). */
  const dragFront = async (toRight: boolean, escape: boolean) => {
    const name = (await tabState(page)).active!;
    const t = await tabBox(run, name);
    await page.mouse.move(t.middle, t.centre);
    await page.mouse.down();
    await page.mouse.move(toRight ? bar.x + bar.width - 12 : bar.x + 12, t.centre, { steps: 6 });
    await page.waitForTimeout(120);
    if (escape) await page.keyboard.press("Escape");
    await page.mouse.up();
    await settle(page);
  };
  const cdp = await page.context().newCDPSession(page);
  await cdp.send("Performance.enable");
  const meter = async () => {
    await cdp.send("HeapProfiler.collectGarbage");
    await page.waitForTimeout(50);
    await cdp.send("HeapProfiler.collectGarbage");
    const { metrics } = await cdp.send("Performance.getMetrics");
    const get = (name: string) => metrics.find((m) => m.name === name)?.value ?? 0;
    return { nodes: get("Nodes"), listeners: get("JSEventListeners") };
  };
  await dragFront(false, false);
  await page.waitForTimeout(300);
  const before = await meter();
  for (let round = 0; round < 8; round++) await dragFront(round % 2 === 0, round % 3 === 2);
  await page.waitForTimeout(300);
  const after = await meter();
  console.log(`Window after 8 drags: ${before.nodes} → ${after.nodes} elements, ${before.listeners} → ${after.listeners} listeners`);
  expect(after.listeners).toBeLessThan(before.listeners + 5);
  expect(after.nodes).toBeLessThan(before.nodes + 100);
  // Once let go, nothing runs: no frames asked for, no timers.
  await page.evaluate(() => {
    const w = window as unknown as { woke: number };
    w.woke = 0;
    const frame = window.requestAnimationFrame.bind(window);
    window.requestAnimationFrame = (cb) => frame((t) => (w.woke++, cb(t)));
    const timer = window.setTimeout.bind(window);
    window.setTimeout = ((cb: (...a: unknown[]) => void, ms?: number, ...args: unknown[]) =>
      timer((...a: unknown[]) => (w.woke++, typeof cb === "function" && cb(...a)), ms, ...args)) as typeof window.setTimeout;
  });
  await page.waitForTimeout(1000);
  expect(await page.evaluate(() => (window as unknown as { woke: number }).woke)).toBe(0);
  await cdp.detach();
});
