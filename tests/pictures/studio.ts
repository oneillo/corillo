// For taking pictures of Corillo (npm run help-pictures, npm run screens): the
// real app, hidden, on a throwaway copy of the sample document and a throwaway
// data folder, at a fixed window size, scale and appearance.
import { _electron as electron, type ElectronApplication, type Page } from "@playwright/test";
import { copyFileSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AgentSession } from "../e2e/agent-session";
import { throwawayStart } from "../e2e/helpers";

export const SAMPLE = join(import.meta.dirname, "sample", "Q3 proposal.md");
/** The sample's picture: a bar chart saying it was made at 144 dots per inch, like a Retina screenshot. */
const CHART = join(import.meta.dirname, "sample", "requests.png");
export const EDITOR = ".doc:not([hidden]) .page.editor";

export interface Studio {
  app: ElectronApplication;
  page: Page;
  /** The copy of the sample document this run works on. */
  file: string;
  folder: string;
  dataDir: string;
  home: string;
}

export interface StudioOptions {
  theme?: "light" | "dark";
  width?: number;
  height?: number;
  /** Device pixels per CSS pixel: 2 for Help's Retina pictures. */
  scale?: number;
  /** Open the sample document (the default), another text, or nothing (the start screen). */
  text?: string | null;
  name?: string;
  /** Documents for the start screen's recent list, most recent first: name and text. */
  recent?: [string, string][];
  /** Pretend agent settings in the stand-in home folder, so Connect your agents finds tools. */
  homeFiles?: Record<string, string>;
  /** Files in the throwaway data folder before Corillo starts. */
  dataFiles?: Record<string, string>;
}

export async function launch(options: StudioOptions = {}): Promise<Studio> {
  const folder = mkdtempSync(join(tmpdir(), "corillo-pictures-"));
  const dataDir = mkdtempSync(join(tmpdir(), "corillo-data-"));
  const home = mkdtempSync(join(tmpdir(), "corillo-home-"));
  writeFileSync(join(dataDir, "setup.json"), '{ "connectAgentsOffered": true }\n');
  for (const [rel, text] of Object.entries(options.homeFiles ?? {})) {
    mkdirSync(join(home, rel, ".."), { recursive: true });
    writeFileSync(join(home, rel), text);
  }
  for (const [rel, text] of Object.entries(options.dataFiles ?? {})) writeFileSync(join(dataDir, rel), text);
  const name = options.name ?? "Q3 proposal.md";
  const file = join(folder, name);
  const text = options.text === undefined ? readFileSync(SAMPLE, "utf8") : options.text;
  if (text !== null) writeFileSync(file, text);
  mkdirSync(join(folder, "Q3 proposal images"), { recursive: true });
  copyFileSync(CHART, join(folder, "Q3 proposal images", "requests.png"));
  if (options.recent) {
    const paths = options.recent.map(([n, t]) => {
      const p = join(folder, n);
      writeFileSync(p, t);
      return p;
    });
    writeFileSync(join(dataDir, "recent.json"), JSON.stringify(paths));
  }
  const app = await electron.launch({
    args: [`--force-device-scale-factor=${options.scale ?? 1}`, ".", ...(text !== null ? [file] : [])],
    // Hidden, on the throwaway data folder, with the stand-in home as HOME too (Batch 23, item 3: R22-9).
    env: throwawayStart({ ...process.env, CORILLO_USER_DATA: dataDir, CORILLO_HOME: home }) as Record<string, string>,
  });
  const theme = options.theme ?? "light";
  await app.evaluate(({ nativeTheme }, t) => {
    nativeTheme.themeSource = t;
  }, theme);
  const page = await app.firstWindow();
  scales.set(page, options.scale ?? 1);
  await page.emulateMedia({ colorScheme: theme });
  await resize(app, page, options.width ?? 1440, options.height ?? 900);
  if (text !== null) await page.waitForSelector(".ProseMirror");
  else await page.waitForSelector("#empty");
  await fontsReady(page);
  return { app, page, file, folder, dataDir, home };
}

/**
 * Quit, and if Corillo is still asking about something (a reply typed and not
 * posted keeps the window open), stop it: the data is all throwaway.
 */
export async function quit(app: ElectronApplication): Promise<void> {
  const closed = app.close().then(() => true).catch(() => true);
  const gaveUp = new Promise<boolean>((resolve) => setTimeout(() => resolve(false), 3000));
  if (!(await Promise.race([closed, gaveUp]))) app.process().kill("SIGKILL");
}

/** Device pixels per CSS pixel, for each window launched. */
const scales = new WeakMap<Page, number>();

/**
 * Make the window's content this size, at its scale. (Playwright's own
 * setViewportSize would set the scale back to 1.)
 */
export async function resize(app: ElectronApplication, page: Page, width: number, height: number): Promise<void> {
  await app.evaluate(({ BrowserWindow }, [w, h]) => BrowserWindow.getAllWindows()[0].setContentSize(w, h), [width, height] as const);
  const cdp = await page.context().newCDPSession(page);
  await cdp.send("Emulation.setDeviceMetricsOverride", { width, height, deviceScaleFactor: scales.get(page) ?? 1, mobile: false });
  await cdp.detach();
  await page.waitForTimeout(150);
}

/** The window's content size, in CSS pixels. */
export function viewSize(page: Page): Promise<{ width: number; height: number }> {
  return page.evaluate(() => ({ width: innerWidth, height: innerHeight }));
}

export async function fontsReady(page: Page): Promise<void> {
  await page.evaluate(() => document.fonts.ready.then(() => undefined));
}

/**
 * Picture the window as it stands, nothing half way through a fade and no
 * cursor showing. Playwright's own way of stopping motion (animations:
 * "disabled") isn't used: it also cancels the scroll-driven animation that
 * keeps the Markdown view's line numbers and comment marks beside their
 * lines, so a scrolled Markdown view came out with the numbers out of step,
 * though the app is right (review UX-14). Instead fades are cut short and the
 * blinking cursor between blocks is held still, by a style of the pictures' own.
 */
export async function stillShot(page: Page, options: Parameters<Page["screenshot"]>[0] = {}): Promise<Buffer> {
  if (!stilled.has(page)) {
    stilled.add(page);
    await page.addStyleTag({
      content: `*, *::before, *::after { transition-duration: 0s !important; transition-delay: 0s !important; }
        .ProseMirror-gapcursor::after { animation: none !important; }`,
    });
  }
  // A coquí caught mid-hop on a tab or by "is editing" (tab-coqui.ts) is pictured sitting.
  await page.evaluate(() => {
    for (const a of document.getAnimations()) if ((a.effect as KeyframeEffect | null)?.target?.classList.contains("coqui-frog")) a.finish();
  });
  return page.screenshot({ ...options, caret: "hide" });
}
const stilled = new WeakSet<Page>();

/**
 * How far the Markdown view's line numbers are out of step with the text, in
 * pixels (0 when they're beside their lines, null when they aren't showing).
 */
export function gutterDrift(page: Page): Promise<number | null> {
  return page.evaluate(() => {
    const mirror = document.querySelector<HTMLElement>(".doc:not([hidden]) .line-gutter:not([hidden]) .line-mirror");
    const source = document.querySelector<HTMLElement>(".doc:not([hidden]) .source");
    if (!mirror || !source || !mirror.checkVisibility()) return null;
    const moved = new DOMMatrixReadOnly(getComputedStyle(mirror).transform).m42;
    const zoom = Number(getComputedStyle(mirror.parentElement!).zoom) || 1;
    return Math.abs(moved * zoom + source.scrollTop);
  });
}

/** Let the editor catch up with a click or a key, as the end-to-end tests do. */
export async function settle(page: Page, ms = 60): Promise<void> {
  await page.evaluate((wait) => new Promise((resolve) => setTimeout(resolve, wait)), ms);
}

/** Select some words in the document, as if dragged over with the mouse. */
export async function selectText(page: Page, text: string): Promise<void> {
  await page.evaluate(
    ([editor, wanted]) => {
      const root = document.querySelector<HTMLElement>(`${editor} .ProseMirror`)!;
      root.focus();
      const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT);
      for (let node = walker.nextNode(); node; node = walker.nextNode()) {
        const at = node.textContent!.indexOf(wanted);
        if (at < 0) continue;
        const range = document.createRange();
        range.setStart(node, at);
        range.setEnd(node, at + wanted.length);
        getSelection()!.removeAllRanges();
        getSelection()!.addRange(range);
        return;
      }
      throw new Error(`"${wanted}" isn't in the document`);
    },
    [EDITOR, text] as const,
  );
  await settle(page);
}

/** Choose an item from the app's menu bar, by its id. */
export async function clickMenu(app: ElectronApplication, id: string): Promise<void> {
  await app.evaluate(({ Menu }, itemId) => {
    const item = Menu.getApplicationMenu()?.getMenuItemById(itemId);
    if (!item) throw new Error(`No menu item ${itemId}`);
    item.click();
  }, id);
}

/** Leave a comment as the person, on these words (or the whole document with none). */
export async function comment(page: Page, words: string | null, body: string): Promise<void> {
  if (words) await selectText(page, words);
  else {
    await page.locator(`${EDITOR} h1`).first().click();
    await settle(page);
  }
  await page.getByRole("button", { name: "Comment", exact: true }).click();
  await page.getByRole("textbox", { name: "New comment" }).fill(body);
  await page.getByRole("button", { name: "Post" }).click();
  await page.locator(".doc:not([hidden]) .comment-card", { hasText: body }).waitFor();
}

/** Every bit of text on screen whose contrast with what's behind it is below WCAG AA (4.5 to 1). */
export function unreadable(page: Page): Promise<string[]> {
  return page.evaluate(() => {
    const rgb = (c: string) => (c.match(/[\d.]+/g) ?? []).map(Number);
    const lum = ([r, g, b]: number[]) => {
      const f = (v: number) => ((v /= 255) <= 0.03928 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4);
      return 0.2126 * f(r) + 0.7152 * f(g) + 0.0722 * f(b);
    };
    const background = (el: Element | null): number[] => {
      for (; el; el = el.parentElement) {
        const c = rgb(getComputedStyle(el).backgroundColor);
        if (c.length === 3 || (c.length === 4 && c[3] > 0)) return c;
      }
      return [255, 255, 255];
    };
    const found: string[] = [];
    const walker = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT);
    for (let node = walker.nextNode(); node; node = walker.nextNode()) {
      const el = node.parentElement;
      if (!node.textContent?.trim() || !el) continue;
      if (el.closest(":disabled, [aria-disabled='true'], svg, .diagram-picture, [hidden]")) continue;
      if (!el.checkVisibility({ opacityProperty: true, visibilityProperty: true })) continue;
      const r = el.getBoundingClientRect();
      if (r.bottom < 0 || r.top > innerHeight || r.right < 0 || r.left > innerWidth) continue;
      const style = getComputedStyle(el);
      if (rgb(style.color)[3] === 0) continue; // drawn in no colour: a layer that copies the text to mark it, never read
      const [a, b] = [lum(rgb(style.color)), lum(background(el))].sort((x, y) => y - x);
      const ratio = (a + 0.05) / (b + 0.05);
      if (ratio < 4.5) found.push(`${el.className || el.tagName} "${node.textContent.trim().slice(0, 30)}": ${ratio.toFixed(2)}`);
    }
    return found;
  });
}

/** Click nowhere in particular, so no card is in focus and no button shows hover. */
export async function rest(page: Page): Promise<void> {
  await page.mouse.move(2, 2);
  await settle(page, 120);
}

/** The ids take_document shows, by the words each comment is on ("" for the whole document). */
export function idsIn(text: string): Map<string, string> {
  const ids = new Map<string, string>();
  for (const m of text.matchAll(/\[([^\]]+)\] on "([^"]+)"/g)) ids.set(m[2], m[1]);
  for (const m of text.matchAll(/\[([^\]]+)\] on the whole document/g)) ids.set("", m[1]);
  return ids;
}

/** Finish an agent's pass, past its reminder about comments still waiting. */
export async function finish(agent: AgentSession, file: string): Promise<void> {
  const first = await agent.call("finish_editing", { path: file });
  if (first.isError) await agent.ok("finish_editing", { path: file });
}

/** The sample's three comments, as the person leaves them. */
export async function sampleComments(page: Page): Promise<void> {
  await comment(page, "four inboxes and two group chats", "Can we say which inboxes?");
  await comment(page, "1,840 requests", "Is this the right number?");
  await comment(page, null, "Make the opening friendlier.");
}

/**
 * An agent's pass over the sample's three comments: a change for two of them,
 * one no comment asked for, and a reply on each. `meanwhile` runs while the
 * agent still has the document, before it finishes.
 */
export async function samplePass(agent: AgentSession, file: string, meanwhile?: () => Promise<void>): Promise<void> {
  const ids = idsIn(await agent.ok("take_document", { path: file }));
  const inboxes = ids.get("four inboxes and two group chats");
  const edit = (find: string, replace: string, comment?: string) =>
    agent.ok("edit_document", { path: file, edits: [{ find, replace }], ...(comment ? { comment_ids: [comment] } : {}) });
  await edit("four inboxes and two group chats", "four inboxes (help, info, volunteers and events) and two group chats", inboxes);
  await edit("Nobody can see", "Right now, nobody can see", ids.get(""));
  await edit("over the summer.", "over the summer, starting in July.");
  await agent.ok("reply_to_comment", { path: file, comment_id: inboxes, text: "Named all four." });
  await agent.ok("reply_to_comment", { path: file, comment_id: ids.get("1,840 requests"), text: "Yes: it's from the April to June count." });
  await agent.ok("reply_to_comment", { path: file, comment_id: ids.get(""), text: "Softened the second sentence." });
  await meanwhile?.();
  await finish(agent, file);
}

