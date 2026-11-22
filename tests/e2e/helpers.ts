// Shared by the end-to-end tests: run the real app on a throwaway copy of a
// document, with a throwaway data folder.
import { _electron as electron, expect, test, type ElectronApplication, type Locator, type Page } from "@playwright/test";
import { lstatSync, mkdtempSync, readFileSync, realpathSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, dirname, join, resolve } from "node:path";
import { lookable } from "../run-folder";
import { EDITOR, selectText, settle } from "./page-helpers";

export const FIXTURES = join(import.meta.dirname, "..", "fixtures");

/**
 * Put before "." in a launch's arguments: the window gets a screen scale of
 * 1, whatever the display's, so a test passes or fails the same on any Mac.
 * After the power cut of 2026-11-10 the hidden window took the display's 2,
 * and two tests that clicked between two lines of a paragraph failed on
 * untouched code. It must be on the command line: Electron reads the screen's
 * scale before Corillo's own code runs, so the app can't set it for itself.
 */
export const ONE_SCALE = "--force-device-scale-factor=1";

/** Chromium's own switch that keeps its compiled graphics caches in memory, for every Corillo a test starts. */
export const NO_GPU_DISK_CACHE = "--disable-gpu-shader-disk-cache";

// The editor's selector, settle and selectText live in page-helpers.ts, which the real-agent trial imports too (C21-20).
export { EDITOR, selectText, settle } from "./page-helpers";

export interface Running {
  app: ElectronApplication;
  page: Page;
  file: string;
  folder: string;
  /** The throwaway data folder this run uses. */
  dataDir: string;
  text: () => string;
  /**
   * Errors its windows threw so far. Closing the app fails the test if any is
   * left; a test that throws on purpose takes its error out.
   */
  thrown?: string[];
}

export interface OpenOptions {
  name?: string;
  /** Set up other files next to the document before the app opens it. */
  prepare?: (folder: string) => void;
  /** Reuse a data folder, to see what Corillo remembers between launches. */
  dataDir?: string;
  /** More for the app's environment, such as the macOS it is told it runs on. */
  env?: Record<string, string>;
}

export async function openText(text: string, options: OpenOptions = {}): Promise<Running> {
  const folder = mkdtempSync(join(tmpdir(), "corillo-doc-"));
  const file = join(folder, options.name ?? "proposal.md");
  writeFileSync(file, text);
  options.prepare?.(folder);
  const dataDir = options.dataDir ?? mkdtempSync(join(tmpdir(), "corillo-data-"));
  // Not a first run (so the "Connect your agents" screen stays away), and a
  // stand-in home folder, so no test ever reads or changes real agent settings.
  writeFileSync(join(dataDir, "setup.json"), '{ "connectAgentsOffered": true }\n');
  const home = mkdtempSync(join(tmpdir(), "corillo-home-"));
  const { app, thrown } = await launch({
    args: [ONE_SCALE, ".", file],
    env: { ...process.env, ...options.env, CORILLO_USER_DATA: dataDir, CORILLO_HIDDEN: "1", CORILLO_HOME: home },
  });
  const page = await app.firstWindow();
  await page.waitForSelector(".ProseMirror");
  return { app, page, file, folder, dataDir, text: () => readFileSync(file, "utf8"), thrown };
}

/** This checkout: the only Corillo a test starts. */
const CHECKOUT = resolve(import.meta.dirname, "..", "..");

/**
 * Whether a folder is inside a temporary folder (never one itself), as the
 * Mac finds it: links on the way are followed, so a link in the run's folder
 * to the home folder doesn't count. A path that isn't in one as written is
 * never looked at on the disk.
 */
function throwawayPlace(folder: string): boolean {
  const written = resolve(folder);
  if (!folder || !lookable(dirname(written))) return false;
  let at = written;
  const below: string[] = [];
  for (;;) {
    try {
      lstatSync(at);
      break;
    } catch {
      if (dirname(at) === at) return false;
      below.unshift(basename(at));
      at = dirname(at);
    }
  }
  try {
    return lookable(dirname(join(realpathSync(at), ...below)));
  } catch {
    return false; // a link to nowhere
  }
}

/**
 * The surroundings every Corillo a test starts gets, from those the test
 * gives (Batch 22, item 4: C21-1, C21-T1): always hidden; a throwaway data
 * folder, or no start at all; and a stand-in home, as the agent tools' home
 * (CORILLO_HOME) and as HOME, so neither Corillo nor anything it runs can
 * reach the person's home folder or write his agent tools' settings. The
 * stand-in is the test's own if it gives one (it must be throwaway too),
 * else a new empty folder in the run's temporary folder. Throws, starting
 * nothing, when a folder isn't throwaway.
 */
export function throwawayStart(env: Record<string, string | undefined>): Record<string, string | undefined> {
  const data = env.CORILLO_USER_DATA ?? "";
  if (!throwawayPlace(data)) {
    throw new Error(`A test's Corillo needs a throwaway data folder (CORILLO_USER_DATA) inside the temporary folder, not ${JSON.stringify(data)}: nothing was started.`);
  }
  const home = env.CORILLO_HOME || mkdtempSync(join(tmpdir(), "corillo-home-"));
  if (!throwawayPlace(home)) {
    throw new Error(`A test's Corillo gets a stand-in home (CORILLO_HOME) inside the temporary folder, not ${JSON.stringify(home)}: nothing was started.`);
  }
  return { ...env, CORILLO_HIDDEN: "1", CORILLO_HOME: home, HOME: home };
}

/**
 * Start Corillo, as Playwright's `electron.launch` does with these options,
 * and fail the test if any of its windows throws. Every test starts Corillo
 * here (or through openText), so no window goes unwatched, a relaunched one
 * included (roadmap Batch 19, R18-8). It is always this checkout's Corillo,
 * hidden, on throwaway folders (`throwawayStart`): a test that gives no data
 * folder in `env` is refused.
 */
export async function launch(options: Parameters<typeof electron.launch>[0]): Promise<{ app: ElectronApplication; thrown: string[] }> {
  if (options?.executablePath && !resolve(options.executablePath).startsWith(CHECKOUT + "/")) {
    throw new Error(`A test starts only this checkout's Corillo, not ${options.executablePath}: nothing was started.`);
  }
  const env = throwawayStart({ ...(options?.env ?? process.env) });
  // The graphics engine's caches stay off the disk: about 7 MB a start, kept in the run's folder until it ends (Batch 21, C21-10).
  options = { ...options, env: env as Record<string, string>, args: [NO_GPU_DISK_CACHE, ...(options?.args ?? [])] };
  const app = await electron.launch(options);
  const thrown = await failOnWindowErrors(app);
  return { app, thrown };
}

/**
 * Keep every error thrown in the app's windows (the main one and any opened
 * later, such as Help), from each window's first script on, and check them
 * when the test closes the app, or the app's process ends in the test that
 * started it: any error fails the test. A test that throws
 * on purpose takes its error out of the list first. Inside a test it fails it
 * softly, so a test that already failed keeps its own message; outside one (an
 * afterAll), the close throws. Returns the list, live.
 */
async function failOnWindowErrors(app: ElectronApplication): Promise<string[]> {
  const thrown: string[] = [];
  const said = (e: Error) => `${e.name}: ${e.message}\n${e.stack ?? ""}`;
  const listen = (page: Page): string[] => {
    const heard: string[] = [];
    page.on("pageerror", (e) => {
      heard.push(said(e));
      thrown.push(said(e));
    });
    return heard;
  };
  // A window that opens from now on is heard from its first script: Playwright
  // tells of a window before it tells of anything the window threw.
  app.on("window", listen);
  // A window already open may have thrown before anyone listened. Playwright
  // keeps each window's errors from its start, so ask for them, and keep the
  // ones from before listening (the list ends with what was already heard).
  await Promise.all(
    app.windows().map(async (page) => {
      const heard = listen(page);
      const kept = (await page.pageErrors({ filter: "all" }).catch(() => [])).map(said);
      let both = Math.min(heard.length, kept.length);
      while (both > 0 && kept.slice(kept.length - both).some((e, i) => e !== heard[i])) both--;
      thrown.unshift(...kept.slice(0, kept.length - both));
    }),
  );
  const testNow = (): string | null => {
    try {
      return test.info().testId;
    } catch {
      return null;
    }
  };
  const owner = testNow();
  /** Fail the test if anything was thrown; at the process's end, only from inside the test that started it, while it runs (the close says it otherwise). */
  const check = (atExit: boolean) => {
    if (!thrown.length) return;
    const inTest = testNow();
    if (atExit && (inTest === null || inTest !== owner)) return;
    const found = thrown.splice(0);
    const message = `The window threw ${found.length === 1 ? "an error" : `${found.length} errors`}:\n${found.join("\n\n")}`;
    if (inTest) expect.soft(found, message).toEqual([]);
    else throw new Error(message);
  };
  // A test that quits Corillo itself (app.quit()) never closes it: its windows' errors are checked as the process ends (the review of Batch 19, R19-11).
  app.process().once("exit", () => check(true));
  const close = app.close.bind(app);
  app.close = async () => {
    await close();
    check(false);
  };
  return thrown;
}

/** Wait until the file on disk is exactly this. */
export async function expectFile(run: Running, expected: string): Promise<void> {
  await expect.poll(run.text).toBe(expected);
}

/** Pretend the person picked this file in the next open dialog. */
export async function pickInNextDialog(app: ElectronApplication, filePath: string): Promise<void> {
  await app.evaluate(({ dialog }, picked) => {
    dialog.showOpenDialog = (async () => ({ canceled: false, filePaths: [picked] })) as typeof dialog.showOpenDialog;
  }, filePath);
}

/**
 * Keep count of the window's timers of this length (the pause before the
 * comments' places are saved, before a diagram is drawn again), so a test
 * waits for the thing itself, not a guessed time a busy Mac can overrun.
 * `hold` keeps them from running until `release` (all of this length).
 */
export async function watchTimers(page: Page, ms: number, hold = false) {
  await page.evaluate(
    ([ms, hold]) => {
      type Watched = { ran: number; waiting: Map<number, () => void>; hold: boolean };
      const w = window as unknown as { timersOf?: Record<number, Watched> };
      if (!w.timersOf) {
        const of: Record<number, Watched> = (w.timersOf = {});
        const set = window.setTimeout.bind(window);
        const clear = window.clearTimeout.bind(window);
        window.setTimeout = ((fn: TimerHandler, delay?: number, ...args: unknown[]) => {
          const watched = typeof fn === "function" && delay !== undefined ? of[delay] : undefined;
          if (!watched) return set(fn, delay, ...args);
          const run = () => {
            watched.waiting.delete(id);
            try {
              (fn as (...a: unknown[]) => void)(...args);
            } finally {
              watched.ran++;
            }
          };
          const id: number = set(run, watched.hold ? 2_000_000_000 : delay);
          watched.waiting.set(id, run);
          return id;
        }) as typeof window.setTimeout;
        window.clearTimeout = ((id?: number) => {
          for (const t of Object.values(of)) t.waiting.delete(id!);
          clear(id);
        }) as typeof window.clearTimeout;
      }
      w.timersOf[ms] ??= { ran: 0, waiting: new Map(), hold };
    },
    [ms, hold] as const,
  );
  type Seen = { timersOf: Record<number, { ran: number; waiting: Map<number, () => void>; hold: boolean }> };
  const count = () =>
    page.evaluate((ms) => {
      const t = (window as unknown as Seen).timersOf[ms];
      return { ran: t.ran, waiting: t.waiting.size };
    }, ms);
  return {
    count,
    /** Wait until one has run since `since` of them had, and none is waiting. */
    async ranSince(since: number): Promise<void> {
      await expect.poll(async () => {
        const c = await count();
        return c.ran > since && c.waiting === 0;
      }, { timeout: 15_000 }).toBe(true);
    },
    /** Run the ones held now, and stop holding. */
    release: () =>
      page.evaluate((ms) => {
        const t = (window as unknown as Seen).timersOf[ms];
        t.hold = false;
        for (const [id, run] of [...t.waiting]) {
          clearTimeout(id);
          run();
        }
      }, ms),
  };
}

/** Put the cursor at the end (or start) of the table cell holding this text. */
export async function cursorInCell(page: Page, cellText: string, where: "end" | "start" = "end"): Promise<void> {
  await page.locator(`${EDITOR} td, ${EDITOR} th`, { hasText: cellText }).first().click();
  await settle(page);
  await page.keyboard.press(where === "end" ? "Meta+ArrowRight" : "Meta+ArrowLeft");
  await settle(page);
}

/** Put the cursor at the end of the paragraph (or heading, or list item) holding this text. */
export async function cursorAtEnd(page: Page, text: string, selector = "p"): Promise<void> {
  // The click goes inside the block's last line, never its middle: the middle
  // of a two-line paragraph is the boundary between its lines, and which line
  // a click there lands on changes with the screen's scale (the second line
  // at a scale of 1, the first at a Retina display's 2).
  const block = page.locator(`${EDITOR} ${selector}`, { hasText: text }).first();
  const box = await block.boundingBox();
  await block.click(box ? { position: { x: box.width / 2, y: Math.max(box.height - 6, box.height / 2) } } : {});
  await settle(page);
  await page.keyboard.press("Meta+ArrowRight");
  await settle(page);
}

/** Text of every cell, row by row, as the editor shows it (a line break in a cell as "\n"). */
export function tableCells(page: Page): Promise<string[][]> {
  return page.evaluate(() => {
    const text = (node: Node): string => {
      if (node.nodeType === Node.TEXT_NODE) return node.nodeValue ?? "";
      const el = node as HTMLElement;
      if (el.tagName === "BR") return el.classList.contains("ProseMirror-trailingBreak") ? "" : "\n";
      return [...el.childNodes].map(text).join("");
    };
    return [...document.querySelectorAll(".doc:not([hidden]) .page.editor table tr")].map((tr) =>
      [...tr.querySelectorAll("th, td")].map(text),
    );
  });
}

/** Choose an item from one of the toolbar's menus. */
export async function chooseFromMenu(page: Page, menu: string, item: string): Promise<void> {
  await page.getByRole("button", { name: menu, exact: true }).click();
  await page.getByRole("menu", { name: menu }).getByRole("menuitem", { name: item }).click();
}

/** Choose an item from the app's menu bar, by its id. */
export async function clickMenu(app: ElectronApplication, id: string): Promise<void> {
  await app.evaluate(({ Menu }, itemId) => {
    const item = Menu.getApplicationMenu()?.getMenuItemById(itemId);
    if (!item) throw new Error(`No menu item ${itemId}`);
    item.click();
  }, id);
}

/** Labels in File > Open Recent, without the Clear Menu item. */
export function recentMenu(app: ElectronApplication): Promise<string[]> {
  return app.evaluate(({ Menu }) => {
    const submenu = Menu.getApplicationMenu()?.getMenuItemById("open-recent")?.submenu;
    return (submenu?.items ?? []).filter((i) => i.type === "normal" && i.id !== "clear-recent").map((i) => i.label);
  });
}

/** Keep the real clipboard untouched: Copy Path writes here instead. */
export async function captureClipboard(app: ElectronApplication): Promise<() => Promise<string>> {
  await app.evaluate(({ clipboard }) => {
    const g = globalThis as unknown as { copied: string };
    g.copied = "";
    clipboard.writeText = ((text: string) => {
      g.copied = text;
    }) as typeof clipboard.writeText;
  });
  return () => app.evaluate(() => (globalThis as unknown as { copied: string }).copied);
}

/** Wait for what Corillo does a moment after launch (afterLaunch in main.ts), so measuring starts from a settled app. */
export function launchSettled(app: ElectronApplication): Promise<void> {
  return app.evaluate(({ app: a }) => new Promise<void>((resolve) => void a.emit("corillo-when-launched", resolve)));
}

/**
 * Open a file in the running app as Finder does (Open With, or a file dropped
 * on the Dock icon). The window itself can only open what the person chose.
 */
export async function openFromFinder(app: ElectronApplication, file: string): Promise<void> {
  await app.evaluate(({ app: a }, p) => {
    a.emit("open-file", { preventDefault: () => undefined }, p);
  }, file);
}

/** Open another document in the running app, as File > Open would. */
export async function openAlso(run: Running, name: string, text: string): Promise<string> {
  const file = join(run.folder, name);
  writeFileSync(file, text);
  await openFromFinder(run.app, file);
  return file;
}

/** The tab names, in order, and which one is in front. */
export function tabState(page: Page): Promise<{ names: string[]; active: string | null }> {
  // Each tab by its file's name ("plan.md"), from the full path in its tooltip.
  // The tab itself shows the name without ".md" (first-launch.spec.ts checks that).
  return page.evaluate(() => {
    const tabs = [...document.querySelectorAll<HTMLElement>(".tab")];
    const file = (t: HTMLElement) => t.title.split("\n").pop()!.split("/").pop()!;
    const active = tabs.find((t) => t.getAttribute("aria-selected") === "true");
    return { names: tabs.map(file), active: active ? file(active) : null };
  });
}

/** Paste into the document as if from another app, without touching the real clipboard. */
export async function paste(page: Page, data: Record<string, string>): Promise<void> {
  await page.evaluate((items) => {
    const transfer = new DataTransfer();
    for (const [type, value] of Object.entries(items)) transfer.setData(type, value);
    document.querySelector(".doc:not([hidden]) .page.editor .ProseMirror")!.dispatchEvent(
      new ClipboardEvent("paste", { clipboardData: transfer, bubbles: true, cancelable: true }),
    );
  }, data);
}

/** Copy the selection, as Cmd+C would, without touching the real clipboard (capture it first). */
export async function copySelection(page: Page): Promise<void> {
  await page.evaluate(() => {
    document.querySelector(".doc:not([hidden]) .page.editor .ProseMirror")!.dispatchEvent(
      new ClipboardEvent("copy", { clipboardData: new DataTransfer(), bubbles: true, cancelable: true }),
    );
  });
}

/** Keep the real clipboard untouched: what Corillo copies is kept here instead, by type. */
export async function captureClipboardWrites(app: ElectronApplication): Promise<() => Promise<Record<string, string> | null>> {
  await app.evaluate(({ clipboard }) => {
    const g = globalThis as unknown as { written: Record<string, string> | null };
    g.written = null;
    clipboard.write = (async (items: Electron.ClipboardItem[]) => {
      const written: Record<string, string> = {};
      for (const item of items) {
        for (const type of item.types) {
          const value: unknown = await item.getType(type);
          written[type] = typeof value === "string" ? value : await (value as Blob).text();
        }
      }
      g.written = written;
    }) as typeof clipboard.write;
  });
  return () => app.evaluate(() => (globalThis as unknown as { written: Record<string, string> | null }).written);
}

/** Pretend the clipboard holds this formatted text (as after copying in Word), without touching the real one. */
export async function clipboardHoldsHtml(app: ElectronApplication, html: string): Promise<void> {
  await app.evaluate(({ clipboard, ClipboardItem }, value) => {
    clipboard.read = (async () => [new ClipboardItem({ "text/html": value })]) as typeof clipboard.read;
  }, html);
}

/** Pretend the clipboard holds this plain text, without touching the real one. */
export async function clipboardHoldsText(app: ElectronApplication, text: string): Promise<void> {
  await app.evaluate(({ clipboard }, value) => {
    clipboard.readText = (async () => value) as typeof clipboard.readText;
  }, text);
}

export interface ContextMenuEntry {
  id: string;
  label: string;
  enabled: boolean;
  visible: boolean;
  type: string;
}

/**
 * Right-click, as far as Corillo's menu goes: hand it what the browser would
 * report about the spot, and get back the items it would show. The real menu
 * never opens.
 */
export async function rightClick(app: ElectronApplication, params: Record<string, unknown>): Promise<ContextMenuEntry[]> {
  return app.evaluate(({ BrowserWindow, Menu }, given) => {
    const g = globalThis as unknown as { shownMenu: Electron.Menu | null };
    g.shownMenu = null;
    Menu.prototype.popup = function (this: Electron.Menu) {
      g.shownMenu = this;
    };
    const defaults = {
      x: 10, y: 10, linkURL: "", linkText: "", pageURL: "", frameURL: "", srcURL: "", mediaType: "none",
      hasImageContents: false, isEditable: true, selectionText: "", titleText: "", altText: "",
      suggestedFilename: "", misspelledWord: "", dictionarySuggestions: [], frameCharset: "utf-8",
      formControlType: "none", spellcheckEnabled: true, menuSourceType: "mouse", referrerPolicy: {},
      editFlags: { canUndo: true, canRedo: true, canCut: false, canCopy: false, canPaste: true, canDelete: false, canSelectAll: true, canEditRichly: true },
    };
    BrowserWindow.getAllWindows()[0].webContents.emit("context-menu", { preventDefault() {} }, { ...defaults, ...given });
    const menu = g.shownMenu as Electron.Menu | null; // set by popup above
    return (menu?.items ?? []).map((i) => ({ id: i.id, label: i.label, enabled: i.enabled, visible: i.visible, type: i.type }));
  }, params);
}

/** Choose an item in the right-click menu last shown by rightClick, by its label. */
export async function chooseInContextMenu(app: ElectronApplication, label: string): Promise<void> {
  await app.evaluate((_electron, itemLabel) => {
    const menu = (globalThis as unknown as { shownMenu: Electron.Menu | null }).shownMenu;
    const item = menu?.items.find((i) => i.label === itemLabel);
    if (!item) throw new Error(`No item ${itemLabel} in the right-click menu`);
    item.click();
  }, label);
}

/**
 * Whose turn a comment's card says it is ("For Claude, not sent yet", "Waiting for you"). The card
 * shows no line for it (roadmap Batch 9, item 3); a screen reader hears it at the end of the card's
 * name. Use as `expect(card).toHaveAttribute("aria-label", turnSaid("Sent to Claude"))`.
 */
export function turnSaid(turn: string): RegExp {
  const words = (turn.charAt(0).toLowerCase() + turn.slice(1)).replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  return new RegExp(`, ${words}(, new)?$`);
}

/**
 * Edit or delete one of the person's messages: its "⋯" (More actions), then
 * Edit or Delete in the short menu it opens. `message` is a card (its first
 * message) or one message in it.
 */
export async function messageAction(message: Locator, item: "Edit" | "Delete"): Promise<void> {
  // The first comment's "⋯" is in its card's top right corner; a reply's is on its own name line (roadmap Batch 9, item 2).
  const first = await message.evaluate((m) => m.matches(".comment-message") && !m.previousElementSibling);
  const holder = first ? message.locator("xpath=ancestor::article[1]").locator(".comment-head") : message;
  await holder.getByRole("button", { name: "More actions" }).first().click();
  await message.page().getByRole("menu", { name: "More actions" }).getByRole("menuitem", { name: item }).click();
}

/** The agents in the @ list that's open in a comment box, as a screen reader names them ("Claude, connected, default"). */
export function listed(page: Page): Promise<string[]> {
  return page.evaluate(() =>
    [...document.querySelectorAll("#mention-list:not([hidden]) [role='option']")].map((o) => o.getAttribute("aria-label") ?? ""),
  );
}
