// Read Aloud, for proofreading by ear (roadmap Batch 14, item 4). These tests
// check what Corillo asks the speech to do, never sound: while tests run, the
// speech is a recorder that says nothing, and the window's real speech refuses
// to start (a test that reaches it fails). The tests play the voice's part:
// `finish` ends the sentence being said, `word` says which word it's at.
import { test, expect, type ElectronApplication, type Page } from "@playwright/test";
import { existsSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { REAL_SPEECH_MARK } from "../run-folder";
import { openText, openAlso, clickMenu, selectText, settle, EDITOR, type Running } from "./helpers";
import { AgentSession } from "./agent-session";
import { bigDocument } from "../fixtures/big-document";

const DOC = "# The plan\n\nWe hire two people. They start in June.\n\nThe budget is **tight** but [workable](https://example.com). %%check this%%\n\nThe office moves.\n";
const BAR = ".doc:not([hidden]) .read-aloud-bar";

let run: Running | null = null;
const sessions: AgentSession[] = [];

async function start(text = DOC, name?: string): Promise<Running> {
  run = await openText(text, name ? { name } : {});
  return run;
}

test.afterEach(async () => {
  const r = run;
  run = null;
  await Promise.all(sessions.splice(0).map((s) => s.stop()));
  // Real speech is never reached while tests run.
  if (r && !r.page.isClosed()) expect(await r.page.evaluate(() => recorder().realReached)).toBe(0);
  const home = await r?.app.evaluate(() => process.env.CORILLO_HOME).catch(() => undefined);
  await r?.app.close().catch(() => undefined);
  for (const dir of [r?.folder, r?.dataDir, home]) if (dir) rmSync(dir, { recursive: true, force: true });
});

declare global {
  // The tests' recorder, as the page has it (src/renderer/read-aloud.ts).
  function recorder(): { calls: string[]; realReached: number; speaking: boolean; finish(): void; word(at: number, length?: number): void; fail(): void };
}

/** Make `recorder()` available in the page. */
async function withRecorder(page: Page): Promise<void> {
  await page.evaluate(() => {
    (globalThis as unknown as { recorder: () => unknown }).recorder = () => (window as unknown as { corilloTests: { speech: unknown } }).corilloTests.speech;
  });
}

const calls = (page: Page) => page.evaluate(() => [...recorder().calls]);
/** What was sent to be said, in order. */
const said = async (page: Page) => (await calls(page)).filter((c) => c.startsWith("speak: ")).map((c) => c.slice(7));
const finish = (page: Page) => page.evaluate(() => recorder().finish());
/** The words marked on the page as the sentence being read, or the word being said. */
const marked = (page: Page, what: "sentence" | "word") =>
  page.evaluate((name) => {
    const h = CSS.highlights.get(name);
    return h ? [...h].map((r) => (r as Range).toString()).join("") : null;
  }, `read-aloud-${what}`);

async function readAloud(app: ElectronApplication, page: Page): Promise<void> {
  await clickMenu(app, "read-aloud");
  await expect(page.locator(BAR)).toBeVisible();
}

/** Stopped: the bar gone, the marks gone, and the speech told to stop. */
async function expectStopped(page: Page): Promise<void> {
  await expect(page.locator(BAR)).toHaveCount(0);
  expect(await marked(page, "sentence")).toBeNull();
  expect(await marked(page, "word")).toBeNull();
  expect((await calls(page)).at(-1)).toBe("cancel");
}

async function focusPage(page: Page): Promise<void> {
  await page.locator(`${EDITOR} .ProseMirror`).focus();
}

test("paused, then Back, Next or Stop: the voice goes on, and Pause still pauses it, as Chromium's speech behaves (B14-04)", async () => {
  const { app, page } = await start();
  await withRecorder(page);
  const speaking = () => page.evaluate(() => recorder().speaking);
  await readAloud(app, page);
  const bar = page.locator(BAR);
  expect(await speaking()).toBe(true);
  await bar.getByRole("button", { name: "Pause" }).click();
  expect(await speaking()).toBe(false);
  await bar.getByRole("button", { name: "Next sentence" }).click();
  expect(await speaking()).toBe(true);
  await bar.getByRole("button", { name: "Pause" }).click();
  expect(await speaking()).toBe(false);
  await bar.getByRole("button", { name: "Previous sentence" }).click();
  expect(await speaking()).toBe(true);
  // Paused, then stopped: the next reading isn't silent.
  await bar.getByRole("button", { name: "Pause" }).click();
  await bar.getByRole("button", { name: "Stop" }).click();
  await expectStopped(page);
  await readAloud(app, page);
  expect(await speaking()).toBe(true);
  await bar.getByRole("button", { name: "Pause" }).click();
  expect(await speaking()).toBe(false);
  await focusPage(page);
  await page.keyboard.press("Escape");
  await expectStopped(page);
  await readAloud(app, page);
  expect(await speaking()).toBe(true);
});

test("reads the page sentence by sentence, in order, as the page shows it: no marks, no comments, a link as its words", async () => {
  const { app, page } = await start();
  await withRecorder(page);
  await readAloud(app, page);
  for (let i = 0; i < 5; i++) await finish(page);
  expect(await said(page)).toEqual(["The plan", "We hire two people.", "They start in June.", "The budget is tight but workable.", "The office moves."]);
  // The last sentence said, it stops by itself.
  await finish(page);
  await expectStopped(page);
});

test("marks the sentence being read, and the word where the voice says which", async () => {
  const { app, page } = await start();
  await withRecorder(page);
  await readAloud(app, page);
  expect(await marked(page, "sentence")).toBe("The plan");
  await finish(page);
  expect(await marked(page, "sentence")).toBe("We hire two people.");
  expect(await marked(page, "word")).toBeNull(); // sentences only, until the voice tells words
  await page.evaluate(() => recorder().word(8, 3));
  expect(await marked(page, "word")).toBe("two");
  // A voice that doesn't say the word's length: the word to its end.
  await page.evaluate(() => recorder().word(12, 0));
  expect(await marked(page, "word")).toBe("people");
  await finish(page);
  await finish(page);
  // Across the bold and the link, and round the comment left out.
  expect(await marked(page, "sentence")).toBe("The budget is tight but workable.");
  await page.evaluate(() => recorder().word(24, 8));
  expect(await marked(page, "word")).toBe("workable");
});

test("reads from the sentence the cursor is in to the end", async () => {
  const { app, page } = await start();
  await withRecorder(page);
  await selectText(page, "start in");
  await page.keyboard.press("ArrowRight");
  await settle(page);
  await readAloud(app, page);
  await finish(page);
  await finish(page);
  expect(await said(page)).toEqual(["They start in June.", "The budget is tight but workable.", "The office moves."]);
});

test("with words selected, reads only those", async () => {
  const { app, page } = await start();
  await withRecorder(page);
  await selectText(page, "two people. They start");
  await readAloud(app, page);
  await finish(page);
  await finish(page);
  expect(await said(page)).toEqual(["two people.", "They start"]);
  await expectStopped(page);
});

test("Pause, Resume, Previous sentence, Next sentence and Stop", async () => {
  const { app, page } = await start();
  await withRecorder(page);
  await readAloud(app, page);
  const bar = page.locator(BAR);
  await bar.getByRole("button", { name: "Pause" }).click();
  await expect(bar.getByRole("button", { name: "Resume" })).toBeVisible();
  expect((await calls(page)).at(-1)).toBe("pause");
  await bar.getByRole("button", { name: "Resume" }).click();
  expect((await calls(page)).at(-1)).toBe("resume");
  await bar.getByRole("button", { name: "Next sentence" }).click();
  await bar.getByRole("button", { name: "Next sentence" }).click();
  expect(await marked(page, "sentence")).toBe("They start in June.");
  await bar.getByRole("button", { name: "Previous sentence" }).click();
  expect(await marked(page, "sentence")).toBe("We hire two people.");
  // Back or Next while paused goes on reading from there.
  await bar.getByRole("button", { name: "Pause" }).click();
  await bar.getByRole("button", { name: "Next sentence" }).click();
  await expect(bar.getByRole("button", { name: "Pause" })).toBeVisible();
  expect((await calls(page)).slice(-4)).toEqual(["pause", "resume", "cancel", "speak: They start in June."]);
  expect(await said(page)).toEqual(["The plan", "We hire two people.", "They start in June.", "We hire two people.", "They start in June."]);
  // What the voice says of a sentence left behind no longer counts.
  await bar.getByRole("button", { name: "Stop" }).click();
  await expectStopped(page);
  // Next on the last sentence ends the reading.
  await selectText(page, "office");
  await page.keyboard.press("ArrowRight");
  await settle(page);
  await readAloud(app, page);
  await bar.getByRole("button", { name: "Next sentence" }).click();
  await expectStopped(page);
});

test("stops on Escape, on Read Aloud chosen again, by its keys, and when the voice fails", async () => {
  const { app, page } = await start();
  await withRecorder(page);
  await focusPage(page);
  await readAloud(app, page);
  await page.keyboard.press("Escape");
  await expectStopped(page);
  // On the bar's buttons too, and the keyboard goes back to the page.
  await readAloud(app, page);
  await page.locator(BAR).getByRole("button", { name: "Pause" }).focus();
  await page.keyboard.press("Escape");
  await expectStopped(page);
  expect(await page.evaluate(() => !!document.activeElement?.closest(".ProseMirror"))).toBe(true);
  // In Find's box, Escape closes Find, and the reading goes on.
  await readAloud(app, page);
  await page.keyboard.press("Meta+f");
  await expect(page.getByRole("textbox", { name: "Find" })).toBeFocused();
  await page.keyboard.press("Escape");
  await expect(page.getByRole("textbox", { name: "Find" })).toBeHidden();
  await expect(page.locator(BAR)).toBeVisible();
  await clickMenu(app, "read-aloud");
  await expectStopped(page);
  // Control-Command-R starts it and stops it, as Review > Read Aloud does.
  await focusPage(page);
  await page.keyboard.press("Control+Meta+r");
  await expect(page.locator(BAR)).toBeVisible();
  await expect.poll(() => app.evaluate(({ Menu }) => Menu.getApplicationMenu()?.getMenuItemById("read-aloud")?.label)).toBe("Stop Reading Aloud");
  await page.keyboard.press("Control+Meta+r");
  await expectStopped(page);
  await readAloud(app, page);
  await clickMenu(app, "read-aloud");
  await expectStopped(page);
  await readAloud(app, page);
  await page.evaluate(() => recorder().fail());
  await expect(page.locator(BAR)).toHaveCount(0);
});

test("stops when the document changes under it: the person typing, or an agent's edit", async () => {
  const { app, page, file, dataDir } = await start();
  await withRecorder(page);
  await readAloud(app, page);
  await finish(page);
  await page.locator(`${EDITOR} h1`).click();
  await page.keyboard.press("End");
  await page.keyboard.type("s");
  await expectStopped(page);

  await readAloud(app, page);
  const { session } = await AgentSession.start(dataDir);
  sessions.push(session);
  await session.ok("take_document", { path: file });
  await expect(page.locator(BAR)).toBeVisible(); // an agent taking the document changes nothing yet
  await session.ok("edit_document", { path: file, edits: [{ find: "The office moves.", replace: "The office moves in June." }] });
  await expectStopped(page);
  await session.ok("finish_editing", { path: file });
});

test("stops when the page goes out of sight: the Markdown view, another tab, the tab closed", async () => {
  const r = await start();
  const { app, page } = r;
  await withRecorder(page);
  await readAloud(app, page);
  await clickMenu(app, "view-markdown");
  await expectStopped(page);
  await clickMenu(app, "view-formatted");
  await expect(page.locator(`${EDITOR}`)).toBeVisible();

  await openAlso(r, "notes.md", "# Notes\n\nA second document.\n");
  await expect(page.locator(".tab")).toHaveCount(2);
  await readAloud(app, page);
  expect(await marked(page, "sentence")).toBe("Notes");
  await clickMenu(app, "previous-tab");
  await expectStopped(page);
  await clickMenu(app, "next-tab");
  await readAloud(app, page);
  await clickMenu(app, "close-tab");
  await expect(page.locator("body.single-doc")).toHaveCount(1); // one document left
  await expectStopped(page);
});

test("stops when the window closes (and so when Corillo quits)", async () => {
  const { app, page } = await start();
  await withRecorder(page);
  await readAloud(app, page);
  const heard: string[] = [];
  page.on("console", (m) => heard.push(m.text()));
  await page.evaluate(() => {
    const r = recorder() as unknown as { cancel(): void };
    const cancel = r.cancel.bind(r);
    r.cancel = () => {
      cancel();
      console.log("read aloud: cancelled");
    };
  });
  const closed = page.waitForEvent("close");
  await clickMenu(app, "close-window");
  await closed;
  expect(heard).toContain("read aloud: cancelled");
});

test("nothing speaks on launch, on opening a document, on an agent's change, or on switching tabs", async () => {
  const r = await start();
  const { app, page, file, dataDir } = r;
  await withRecorder(page);
  await settle(page);
  await openAlso(r, "notes.md", "# Notes\n\nA second document.\n");
  await expect(page.locator(".tab")).toHaveCount(2);
  await clickMenu(app, "previous-tab");
  await clickMenu(app, "next-tab");
  await clickMenu(app, "previous-tab");
  const { session } = await AgentSession.start(dataDir);
  sessions.push(session);
  await session.ok("take_document", { path: file });
  await session.ok("edit_document", { path: file, edits: [{ find: "The office moves.", replace: "The office moves in June." }] });
  await session.ok("finish_editing", { path: file });
  await expect(page.locator(`${EDITOR}`)).toContainText("in June.");
  await settle(page);
  expect(await calls(page)).toEqual([]);
  await expect(page.locator(BAR)).toHaveCount(0);
});

test("the window's real speech refuses to start while tests run, and is counted", async () => {
  const { page } = await start();
  await withRecorder(page);
  // Never a real utterance: if the guard weren't there, this would fail on its own (speak needs one) and count nothing.
  const error = await page.evaluate(() => {
    try {
      speechSynthesis.speak(null as unknown as SpeechSynthesisUtterance);
      return "";
    } catch (e) {
      return String(e);
    }
  });
  expect(error).toContain("Real speech reached while tests run");
  expect(await page.evaluate(() => recorder().realReached)).toBe(1);
  await page.evaluate(() => (recorder().realReached = 0));
  // And it's marked in the run's folder, which fails the whole run as it ends, whichever test it was (B14-09).
  const mark = join(tmpdir(), REAL_SPEECH_MARK);
  await expect.poll(() => existsSync(mark)).toBe(true);
  rmSync(mark); // (this test reached it on purpose)
});

test("Read aloud is at the end of the toolbar's More menu whenever More is on the bar, with its keys", async () => {
  const { page } = await start();
  await withRecorder(page);
  // A wide window has everything on the bar and no More: Read Aloud is in the Review menu.
  await page.setViewportSize({ width: 1440, height: 700 });
  await settle(page);
  await expect(page.getByRole("button", { name: "More", exact: true })).toBeHidden();
  for (const width of [1000, 560]) {
    await page.setViewportSize({ width, height: 700 });
    await settle(page);
    await page.getByRole("button", { name: "More", exact: true }).click();
    const menu = page.getByRole("menu", { name: "More" });
    const item = menu.getByRole("menuitem").last();
    await expect(item).toContainText("Read aloud");
    await expect(item).toContainText("⌃⌘R");
    await item.click();
    await expect(page.locator(BAR)).toBeVisible();
    await page.getByRole("button", { name: "More", exact: true }).click();
    await expect(menu.getByRole("menuitem").last()).toContainText("Stop reading aloud");
    await menu.getByRole("menuitem").last().click();
    await expectStopped(page);
  }
});

test("Review > Read Aloud is greyed out where there's nothing to read, and in the Markdown view", async () => {
  const { app, page } = await start("---\ntitle: x\n---\n");
  await withRecorder(page);
  const enabled = () => app.evaluate(({ Menu }) => Menu.getApplicationMenu()?.getMenuItemById("read-aloud")?.enabled);
  await expect.poll(enabled).toBe(false);
  await clickMenu(app, "view-markdown");
  await page.locator(".doc:not([hidden]) textarea.source").fill("Some words.\n");
  await expect.poll(enabled).toBe(false);
  await clickMenu(app, "view-formatted");
  await expect.poll(enabled).toBe(true);
});

test("Review > Read Aloud is greyed out for a document whose only words are code, and with only code selected (B14-10)", async () => {
  const r = await start("```\nlet total = 1\n```\n", "code.md");
  const { app, page } = r;
  await withRecorder(page);
  const enabled = () => app.evaluate(({ Menu }) => Menu.getApplicationMenu()?.getMenuItemById("read-aloud")?.enabled);
  await expect.poll(enabled).toBe(false);
  await openAlso(r, "mixed.md", "```\nlet total = 1\n```\n\nThe end is near.\n");
  await expect(page.locator(EDITOR)).toContainText("The end is near.");
  await expect.poll(enabled).toBe(true);
  await selectText(page, "let total");
  await expect.poll(enabled).toBe(false);
  await selectText(page, "end is");
  await expect.poll(enabled).toBe(true);
});

test("the bar: words first, then its buttons right after them, 28 pixels on the 4-pixel grid, each named for VoiceOver, at the narrowest window", async () => {
  const { app, page } = await start();
  await withRecorder(page);
  for (const [width, comments] of [[1440, false], [560, false], [560, true]] as const) {
    await page.setViewportSize({ width, height: 700 });
    const shown = await page.locator(".doc:not([hidden]) .comments-panel").isVisible();
    if (shown !== comments) await clickMenu(app, "view-comments");
    await settle(page);
    await readAloud(app, page);
    const layout = await page.evaluate((sel) => {
      const bar = document.querySelector<HTMLElement>(sel)!;
      const box = bar.getBoundingClientRect();
      const words = bar.querySelector(".read-aloud-words")!.getBoundingClientRect();
      const buttons = [...bar.querySelectorAll("button")].map((b) => {
        const r = b.getBoundingClientRect();
        return { name: b.getAttribute("aria-label") ?? b.textContent, left: r.left, right: r.right, top: r.top, width: r.width, height: r.height };
      });
      return { box: { left: box.left, right: box.right, top: box.top, bottom: box.bottom }, words: { left: words.left, right: words.right, top: words.top }, buttons, window: innerWidth };
    }, BAR);
    const at = `at ${width}${comments ? " with comments" : ""}`;
    expect(layout.buttons.map((b) => b.name), at).toEqual(["Previous sentence", "Pause", "Next sentence", "Stop"]);
    // Words 24 in from the window's edge, as every bar's.
    expect(Math.round(layout.words.left - layout.box.left), at).toBe(24);
    // Right after the words, 12 apart, then the three squares 4 apart, then Stop.
    expect(Math.round(layout.buttons[0].left - layout.words.right), at).toBe(12);
    for (const b of layout.buttons) {
      expect(b.height, at).toBe(28);
      expect(b.right, at).toBeLessThanOrEqual(layout.box.right - 16 + 0.5);
      expect(b.right, at).toBeLessThanOrEqual(layout.window);
    }
    for (const b of layout.buttons.slice(0, 3)) expect(b.width, at).toBe(28);
    expect(Math.round(layout.buttons[1].left - layout.buttons[0].right), at).toBe(4);
    expect(Math.round(layout.buttons[2].left - layout.buttons[1].right), at).toBe(4);
    expect(Math.round(layout.buttons[3].left - layout.buttons[2].right), at).toBe(12);
    // One row: everything on the words' line.
    const middles = layout.buttons.map((b) => b.top + b.height / 2);
    expect(Math.max(...middles) - Math.min(...middles), at).toBeLessThan(1);
    await page.locator(BAR).getByRole("button", { name: "Stop" }).click();
    await expectStopped(page);
  }
  // Names and roles as VoiceOver reads them.
  await readAloud(app, page);
  const tree = await page.locator(BAR).ariaSnapshot();
  expect(tree).toContain('group "Read aloud"');
  for (const name of ["Previous sentence", "Pause", "Next sentence", "Stop"]) expect(tree).toContain(`button "${name}"`);
});

test("keeps the sentence being read in sight, moving the page only when it would leave the screen", async () => {
  const { app, page } = await start(bigDocument(4), "long.md");
  await withRecorder(page);
  await page.setViewportSize({ width: 1000, height: 600 });
  await settle(page);
  const canvas = page.locator(".doc:not([hidden]) .canvas.with-side");
  const wordsAt = () => page.locator(`${EDITOR} p`).first().evaluate((p) => p.getBoundingClientRect().top);
  const before = await wordsAt();
  await readAloud(app, page);
  // The bar came in without moving the words.
  expect(Math.abs((await wordsAt()) - before)).toBeLessThan(1);
  let moves = 0;
  let last = await canvas.evaluate((c) => c.scrollTop);
  for (let i = 0; i < 60; i++) {
    await finish(page);
    const place = await page.evaluate(() => {
      const h = CSS.highlights.get("read-aloud-sentence");
      const range = h ? ([...h][0] as Range) : null;
      const c = document.querySelector(".doc:not([hidden]) .canvas.with-side")!.getBoundingClientRect();
      const r = range?.getBoundingClientRect();
      return r && r.height ? { top: r.top - c.top, bottom: c.bottom - r.bottom, scroll: document.querySelector(".doc:not([hidden]) .canvas.with-side")!.scrollTop } : null;
    });
    if (!place) continue; // a picture's description: marked on the picture
    expect(place.top).toBeGreaterThanOrEqual(0);
    expect(place.bottom).toBeGreaterThanOrEqual(0);
    if (place.scroll !== last) moves++;
    last = place.scroll;
  }
  // It moved, but far less often than once a sentence.
  expect(moves).toBeGreaterThan(0);
  expect(moves).toBeLessThan(30);
});

test("started and stopped 50 times, it leaves nothing behind: elements, listeners, memory, marks", async () => {
  const { app, page } = await start();
  await withRecorder(page);
  const cdp = await page.context().newCDPSession(page);
  await cdp.send("Performance.enable");
  const meter = async () => {
    await cdp.send("HeapProfiler.collectGarbage");
    await page.waitForTimeout(50);
    await cdp.send("HeapProfiler.collectGarbage");
    const { metrics } = await cdp.send("Performance.getMetrics");
    const get = (name: string) => metrics.find((m) => m.name === name)?.value ?? 0;
    return { nodes: get("Nodes"), listeners: get("JSEventListeners"), windowMB: get("JSHeapUsedSize") / 1048576 };
  };
  const once = async () => {
    await clickMenu(app, "read-aloud");
    await expect(page.locator(BAR)).toBeVisible();
    await finish(page);
    await clickMenu(app, "read-aloud");
    await expect(page.locator(BAR)).toHaveCount(0);
  };
  await once();
  await page.evaluate(() => (recorder().calls.length = 0));
  const before = await meter();
  for (let i = 0; i < 50; i++) await once();
  await page.evaluate(() => (recorder().calls.length = 0)); // the tests' own record of calls
  const after = await meter();
  expect(after.nodes - before.nodes).toBeLessThan(40);
  expect(after.listeners - before.listeners).toBeLessThan(5);
  expect(after.windowMB - before.windowMB).toBeLessThan(2);
  expect(await page.evaluate(() => CSS.highlights.size)).toBe(0);
});
