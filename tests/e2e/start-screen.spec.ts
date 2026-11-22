// The start screen's recent documents, as cards: a live preview of the top of
// each document, its name, folder and when it last changed. Every test uses a
// stand-in home folder and a throwaway data folder holding the recent list.
import { test, expect, type ElectronApplication, type Page } from "@playwright/test";
import { createHash } from "node:crypto";
import { chmodSync, copyFileSync, mkdirSync, mkdtempSync, readFileSync, renameSync, statSync, unlinkSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { gzipSync } from "node:zlib";
import type { Thread } from "../../src/core/comments";
import { clickMenu, launchSettled, ONE_SCALE, openFromFinder, pickInNextDialog, recentMenu, tabState, turnSaid, EDITOR, FIXTURES, launch as launchCorillo } from "./helpers";

interface Launched {
  app: ElectronApplication;
  page: Page;
  home: string;
  dataDir: string;
}

const DAY = 86_400_000;

function newHome(): string {
  return mkdtempSync(join(tmpdir(), "corillo-home-"));
}

/** Write a document under the stand-in home folder, changed `daysAgo` days ago. */
function writeDoc(home: string, rel: string, text: string, daysAgo = 0): string {
  const file = join(home, rel);
  mkdirSync(join(file, ".."), { recursive: true });
  writeFileSync(file, text);
  if (daysAgo) {
    const when = new Date(Date.now() - daysAgo * DAY);
    utimesSync(file, when, when);
  }
  return file;
}

/** What Corillo keeps for one document in its data folder, as a test prepares it. */
interface Kept {
  /** Its comments (whole-document ones, so they need no words to sit on). */
  threads?: Thread[];
  /** Agents' notes waiting for the person. */
  notes?: { id: string; agent: string; text: string; at: string }[];
  /** The text Corillo last saved, to know it by after a move to another drive. */
  text?: string;
}

/** Write what Corillo keeps for these documents (by path) into a data folder, as if it had seen them before. */
function keep(dataDir: string, docs: Record<string, Kept>): Record<string, string> {
  const ids: Record<string, string> = {};
  const index: Record<string, unknown> = {};
  for (const [file, kept] of Object.entries(docs)) {
    const id = `doc-${Object.keys(ids).length + 1}`;
    ids[file] = id;
    const s = statSync(file);
    const print = kept.text ? createHash("sha256").update(kept.text).digest("base64url").slice(0, 22) : undefined;
    index[id] = { path: file, ino: s.ino, dev: s.dev, ...(print ? { text: print } : {}) };
    const folder = join(dataDir, "documents", id);
    mkdirSync(folder, { recursive: true });
    writeFileSync(join(folder, "record.json"), JSON.stringify({ path: file }));
    if (kept.threads) writeFileSync(join(folder, "comments.json.gz"), gzipSync(JSON.stringify(kept.threads)));
    if (kept.notes) writeFileSync(join(folder, "notes.json"), JSON.stringify(kept.notes));
  }
  writeFileSync(join(dataDir, "documents.json"), JSON.stringify(index));
  return ids;
}

let made = 0;
const said = (who: "person" | string, body: string, minutesAgo = 10) => ({
  id: `m${++made}`,
  author: who === "person" ? ({ kind: "person" } as const) : ({ kind: "agent", name: who } as const),
  body,
  created: new Date(Date.now() - minutesAgo * 60_000).toISOString(),
});
/** A comment on the whole document. */
const comment = (messages: ReturnType<typeof said>[], extra: Partial<Thread> = {}): Thread => ({
  id: `t${++made}`,
  anchor: null,
  to: null,
  status: "open",
  messages,
  ...extra,
});

/** A new data folder that isn't on its first run, holding this recent list. */
function dataFolder(recent: string[]): string {
  const dataDir = mkdtempSync(join(tmpdir(), "corillo-data-"));
  writeFileSync(join(dataDir, "setup.json"), '{ "connectAgentsOffered": true }\n');
  writeFileSync(join(dataDir, "recent.json"), JSON.stringify(recent));
  return dataDir;
}

/** Start Corillo with no document open (or with `open`) and this recent list, most recent first (or with a data folder already prepared). */
async function launch(home: string, recent: string[], prepared?: string, open?: string): Promise<Launched> {
  const dataDir = prepared ?? dataFolder(recent);
  const { app } = await launchCorillo({
    args: [ONE_SCALE, ".", ...(open ? [open] : [])],
    env: { ...process.env, CORILLO_USER_DATA: dataDir, CORILLO_HIDDEN: "1", CORILLO_HOME: home },
  });
  const page = await app.firstWindow();
  await page.setViewportSize({ width: 1100, height: 860 });
  await page.waitForSelector(open ? ".ProseMirror" : "#empty");
  return { app, page, home, dataDir };
}

const cards = (page: Page) => page.locator("#recent .recent-item");
const cardNames = (page: Page) => page.locator("#recent .recent-name");

/** The card for this file, named on the card without ".md" (roadmap Batch 5, item 2). */
const card = (page: Page, file: string) => {
  const shown = file.replace(/\.md$/, "").replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  return cards(page).filter({ has: page.locator(".recent-name", { hasText: new RegExp(`^${shown}$`) }) });
};

/** Which card the keyboard is on, by its document's name. */
const focusedCard = (page: Page) =>
  page.evaluate(() => document.activeElement?.closest(".recent-item")?.querySelector(".recent-name")?.textContent ?? null);

test("recent documents show as cards with their name, folder, when they changed, and a preview of the top of the document", async () => {
  const home = newHome();
  const plan = writeDoc(home, "Documents/Plans/plan.md", "# Hiring plan\n\nWe should hire **two people** this quarter.\n\n- One designer\n- One engineer\n", 1);
  const notes = writeDoc(home, "Documents/notes.md", "## Notes from Monday\n\nThe budget is *fine*.\n");
  const run = await launch(home, [plan, notes]);
  const { page } = run;

  await expect(cardNames(page)).toHaveText(["plan", "notes"]);
  const first = card(page, "plan.md");
  await expect(first.locator(".recent-folder")).toHaveText("Documents › Plans");
  await expect(first.locator(".recent-when")).toHaveText("Yesterday");
  await expect(card(page, "notes.md").locator(".recent-folder")).toHaveText("Documents");
  await expect(card(page, "notes.md").locator(".recent-when")).toHaveText("Today");

  // The preview is the document as it reads: a real heading, bold words, a list.
  const preview = first.locator(".recent-page");
  await expect(preview.locator("h1")).toHaveText("Hiring plan");
  await expect(preview.locator("strong")).toHaveText("two people");
  await expect(preview.locator("li")).toHaveText(["One designer", "One engineer"]);
  await expect(card(page, "notes.md").locator(".recent-page h2")).toHaveText("Notes from Monday");

  // Shown small: a 760-pixel page at a quarter of its size, inside the card.
  const sizes = await first.evaluate((li) => ({
    card: li.querySelector(".recent-card")!.getBoundingClientRect().width,
    page: li.querySelector(".recent-page")!.getBoundingClientRect().width,
  }));
  expect(sizes.page).toBeGreaterThan(150);
  expect(sizes.page).toBeLessThanOrEqual(sizes.card);

  // Each card is a button with a plain name; the preview isn't read out or reachable by Tab.
  await expect(page.getByRole("button", { name: "Open plan, in Plans", exact: true })).toBeVisible();
  await expect(page.getByRole("button", { name: "Open notes, in Documents", exact: true })).toBeVisible();
  expect(await first.locator(".recent-preview").evaluate((e) => (e as HTMLElement).inert)).toBe(true);
  await run.app.close();
});

test("the start screen is the whole window, and a preview looks like the page: headings, tables and task lists as the document shows them", async () => {
  const home = newHome();
  const plan = writeDoc(home, "Documents/plan.md", "# Hiring plan\n\nSome text.\n\n| Role | When |\n| --- | --- |\n| Designer | March |\n\n- [x] Agree budget\n- [ ] Post the role\n");
  const run = await launch(home, [plan]);
  const { page } = run;
  // No toolbar, tabs or status bar with nothing to act on.
  for (const part of [".toolbar", ".status-bar"]) await expect(page.locator(part).first(), part).toBeHidden();

  // How a heading, a table's header and its cells look, relative to the body text around them.
  const look = (scope: string) =>
    page.evaluate((root) => {
      const at = (sel: string) => getComputedStyle(document.querySelector(`${root} ${sel}`)!);
      const body = parseFloat(at("p").fontSize);
      return {
        heading: at("h1").color,
        headingSize: (parseFloat(at("h1").fontSize) / body).toFixed(2),
        // (Colours and styles, not widths: the preview is drawn at a quarter size, where a line is at least a pixel.)
        header: [at("th").backgroundColor, at("th").borderBottomColor, at("th").borderTopStyle, at("th").borderLeftStyle],
        cell: [at("td").backgroundColor, at("td").borderBottomColor, at("td").borderTopStyle],
        tableSize: (parseFloat(at("table").fontSize) / body).toFixed(2),
        tasks: [...document.querySelectorAll(`${root} li`)].map((li) => getComputedStyle(li).listStyleType),
      };
    }, scope);
  await expect(page.locator("#recent .recent-page li")).toHaveText(["Agree budget", "Post the role"]);
  const preview = await look("#recent .recent-page");
  expect(preview.tasks).toEqual(['"☒ "', '"☐ "']); // ticked and not, as boxes

  await page.getByRole("button", { name: "Open plan, in Documents" }).click();
  await expect(page.locator(".status-bar")).toBeVisible();
  expect(preview).toEqual(await look(`${EDITOR} .ProseMirror`));
  await run.app.close();
});

test("clicking a card, or pressing Enter on it, opens that document; the arrow keys move between cards", async () => {
  const home = newHome();
  const docs = ["one", "two", "three", "four", "five", "six"].map((n) => writeDoc(home, `Documents/${n}.md`, `# Document ${n}\n\nText.\n`));
  const run = await launch(home, docs);
  const { page } = run;
  await expect(cards(page)).toHaveCount(6);

  await page.getByRole("button", { name: "Open two, in Documents" }).click();
  await expect(page.locator(`${EDITOR} h1`)).toHaveText("Document two");
  await clickMenu(run.app, "close-tab");
  await expect(page.locator("#empty")).toBeVisible();
  await expect(cards(page)).toHaveCount(6);
  await expect(cardNames(page).first()).toHaveText("two"); // the one just opened is the most recent now

  // Four cards a row at this width: Right and Left go along, Down and Up go a row.
  await page.getByRole("button", { name: "Open two, in Documents" }).focus();
  await page.keyboard.press("ArrowRight");
  expect(await focusedCard(page)).toBe("one");
  await page.keyboard.press("ArrowDown");
  expect(await focusedCard(page)).toBe("six");
  await page.keyboard.press("ArrowDown"); // no row below: stays put
  expect(await focusedCard(page)).toBe("six");
  await page.keyboard.press("ArrowUp");
  expect(await focusedCard(page)).toBe("one");
  await page.keyboard.press("ArrowLeft");
  expect(await focusedCard(page)).toBe("two");
  await page.keyboard.press("End");
  expect(await focusedCard(page)).toBe("six");
  await page.keyboard.press("Home");
  expect(await focusedCard(page)).toBe("two");
  await page.keyboard.press("ArrowRight");
  await page.keyboard.press("ArrowRight");
  expect(await focusedCard(page)).toBe("three");
  await page.keyboard.press("Enter");
  await expect(page.locator(`${EDITOR} h1`)).toHaveText("Document three");
  await expect(page.locator("#empty")).toBeHidden();
  await run.app.close();
});

test("a document that was moved or deleted gets a card saying it can't be found, which can be taken off the list", async () => {
  const home = newHome();
  const plan = writeDoc(home, "Documents/plan.md", "# Plan\n");
  const gone = join(home, "Documents", "Old", "gone.md");
  const notes = writeDoc(home, "Documents/notes.md", "# Notes\n");
  const run = await launch(home, [plan, gone, notes]);
  const { page } = run;

  await expect(cardNames(page)).toHaveText(["plan", "gone", "notes"]);
  const lost = card(page, "gone.md");
  await expect(lost.locator(".recent-gone")).toHaveText("Can't be found");
  await expect(lost).toContainText("It may have been moved, renamed or deleted.");
  await expect(lost.locator(".recent-folder")).toHaveText("Documents › Old");
  await expect(lost.locator(".recent-page")).toHaveCount(0);
  await expect(page.getByRole("button", { name: "Open gone.md", exact: false })).toHaveCount(0);
  // File > Open Recent leaves it out, as before.
  expect(await recentMenu(run.app)).toEqual(["plan", "notes"]);

  await page.getByRole("button", { name: "Remove gone from the list" }).click();
  await expect(cardNames(page)).toHaveText(["plan", "notes"]);
  expect(JSON.parse(readFileSync(join(run.dataDir, "recent.json"), "utf8"))).toEqual([plan, notes]);
  // The keyboard moves on to the next card.
  expect(await focusedCard(page)).toBe("notes");
  await run.app.close();
});

test("a document Corillo isn't allowed to read gets a plain card saying so", async () => {
  const home = newHome();
  const locked = writeDoc(home, "Documents/locked.md", "# Locked\n");
  chmodSync(locked, 0o000);
  try {
    const run = await launch(home, [locked]);
    const card = run.page.locator("#recent .recent-item");
    await expect(card.locator(".recent-gone")).toHaveText("Can't be read");
    await expect(card).toContainText("Corillo can't open it right now.");
    await expect(run.page.getByRole("button", { name: "Remove locked from the list" })).toBeVisible();
    // Finding it elsewhere is for a document that can't be found, not one that can't be read.
    await expect(run.page.getByRole("button", { name: /^Find/ })).toHaveCount(0);
    await run.app.close();
  } finally {
    chmodSync(locked, 0o644);
  }
});

test("front matter at the top of a document isn't in its preview", async () => {
  const home = newHome();
  const doc = writeDoc(home, "Documents/proposal.md", "---\ntitle: Secret working title\nowner: Ana\n---\n\n# Onboarding proposal\n\nFor the steering group.\n");
  const run = await launch(home, [doc]);
  const preview = card(run.page, "proposal.md").locator(".recent-page");
  await expect(preview.locator("h1")).toHaveText("Onboarding proposal");
  await expect(preview).not.toContainText("Secret working title");
  await expect(preview).not.toContainText("owner");
  expect(await preview.evaluate((p) => p.firstElementChild?.tagName)).toBe("H1");
  await run.app.close();
});

test("previews never go online: a picture beside the document shows, one on the web and a diagram are plain boxes", async () => {
  const home = newHome();
  const doc = writeDoc(
    home,
    "Documents/report.md",
    "# Report\n\n![Chart](<report images/chart.png>)\n\n![Logo](https://example.org/logo.png)\n\n```mermaid\nflowchart LR\n  A --> B\n```\n\nThe [details](https://example.org) are online.\n",
  );
  mkdirSync(join(home, "Documents", "report images"));
  copyFileSync(join(FIXTURES, "chart.png"), join(home, "Documents", "report images", "chart.png"));
  const run = await launch(home, [doc]);
  const preview = card(run.page, "report.md").locator(".recent-page");
  await expect(preview.locator("h1")).toHaveText("Report");
  await expect(preview.locator("img")).toHaveCount(1);
  await expect.poll(() => preview.locator("img").evaluate((img: HTMLImageElement) => img.complete && img.naturalWidth > 0)).toBe(true);
  expect(await preview.locator("img").getAttribute("src")).toMatch(/^file:\/\/.*\/report%20images\/chart\.png$/);
  await expect(preview.locator(".preview-box")).toHaveCount(2); // the web picture and the diagram
  await expect(preview.locator("a, [href], script, svg")).toHaveCount(0);
  await expect(preview.locator(".preview-link")).toHaveText("details");
  await run.app.close();
});

test("the start screen shows at most the 8 most recent documents, and Clear list empties it", async () => {
  const home = newHome();
  const docs = Array.from({ length: 10 }, (_, i) => writeDoc(home, `Documents/doc${i + 1}.md`, `# Doc ${i + 1}\n`));
  const run = await launch(home, docs);
  const { page } = run;
  await expect(cardNames(page)).toHaveText(docs.slice(0, 8).map((_, i) => `doc${i + 1}`));
  await page.getByRole("button", { name: "Clear list" }).click();
  await expect(cards(page)).toHaveCount(0);
  await expect(page.getByRole("heading", { name: "Recent" })).toHaveCount(0);
  expect(await recentMenu(run.app)).toEqual([]);
  await run.app.close();
});

test("the cards fit four to a row in a wide window, fewer in a narrower one, one in a very narrow one, centred under the buttons", async () => {
  const home = newHome();
  const docs = Array.from({ length: 8 }, (_, i) => writeDoc(home, `Documents/doc${i + 1}.md`, `# Doc ${i + 1}\n`));
  const run = await launch(home, docs);
  const { page } = run;
  await expect(cards(page)).toHaveCount(8);
  const shape = () =>
    page.evaluate(() => {
      const items = [...document.querySelectorAll(".recent-item")].map((e) => e.getBoundingClientRect());
      const actions = document.querySelector(".empty-actions")!.getBoundingClientRect();
      const empty = document.querySelector<HTMLElement>("#empty")!;
      const left = Math.min(...items.map((r) => r.left));
      const right = Math.max(...items.map((r) => r.right));
      return {
        perRow: items.filter((r) => Math.round(r.top) === Math.round(items[0].top)).length,
        offCentre: Math.abs((left + right) / 2 - (actions.left + actions.right) / 2),
        sideways: empty.scrollWidth > empty.clientWidth,
      };
    });
  for (const [width, perRow] of [[1100, 4], [760, 3], [560, 2], [400, 1]] as const) {
    await page.setViewportSize({ width, height: 860 });
    await expect.poll(async () => (await shape()).perRow, `at ${width} pixels`).toBe(perRow);
    const at = await shape();
    expect(at.offCentre, `centred at ${width} pixels`).toBeLessThanOrEqual(1);
    expect(at.sideways, `no sideways scrolling at ${width} pixels`).toBe(false);
  }
  // Fewer documents than fit in a row: still centred.
  await page.setViewportSize({ width: 1100, height: 860 });
  await page.evaluate((gone) => Promise.all(gone.map((p) => window.corillo.forgetRecent(p))), docs.slice(2));
  await expect(cards(page)).toHaveCount(2);
  expect((await shape()).offCentre).toBeLessThanOrEqual(1);
  await run.app.close();
});

/** Show the start screen's cards again, and how long until every preview is drawn. */
async function timeShowing(run: Launched, recent: string[]): Promise<number> {
  writeFileSync(join(run.dataDir, "recent.json"), JSON.stringify(recent));
  await run.page.evaluate(() => document.querySelector("#recent")!.replaceChildren());
  const started = Date.now();
  // Corillo keeps the list in memory: it reads the file again, and the start screen shows it.
  await run.app.evaluate(({ app }) => void app.emit("corillo-recent-from-disk"));
  await run.page.waitForFunction((count) => document.querySelectorAll("#recent .recent-page h1").length === count, recent.length, { polling: "raf" });
  const took = Date.now() - started;
  // The documents asked for, not the ones shown before.
  expect(await cardNames(run.page).allTextContents()).toEqual(recent.map((p) => p.split("/").pop()!.replace(/\.md$/, "")));
  return took;
}

const median = (xs: number[]) => [...xs].sort((a, b) => a - b)[Math.floor(xs.length / 2)];

test("with 8 recent documents of 1 MB each, the start screen shows about as fast as with 8 small ones", async () => {
  const home = newHome();
  const paragraph = "A sentence about the plan, long enough to wrap onto a second line of the page. ".repeat(4) + "\n\n";
  const big = Array.from({ length: 8 }, (_, i) => writeDoc(home, `Big/big${i + 1}.md`, `# Big ${i + 1}\n\n` + paragraph.repeat(Math.ceil(1_000_000 / paragraph.length))));
  const small = Array.from({ length: 8 }, (_, i) => writeDoc(home, `Small/small${i + 1}.md`, `# Small ${i + 1}\n\nA short note.\n`));
  const run = await launch(home, big);
  await expect(run.page.locator("#recent .recent-page h1")).toHaveCount(8);

  const bigTimes: number[] = [];
  const smallTimes: number[] = [];
  for (let i = 0; i < 5; i++) {
    smallTimes.push(await timeShowing(run, small));
    bigTimes.push(await timeShowing(run, big));
  }
  // Reading the files: only their tops, so a megabyte costs about what a line does.
  const readTimes = await run.page.evaluate(async () => {
    const times: number[] = [];
    for (let i = 0; i < 5; i++) {
      const t = performance.now();
      await window.corillo.recentCards();
      times.push(performance.now() - t);
    }
    return times;
  });
  console.log(`start screen: 8 small ${median(smallTimes)} ms, 8 of 1 MB ${median(bigTimes)} ms; reading 8 of 1 MB ${median(readTimes).toFixed(1)} ms`);
  expect(median(bigTimes)).toBeLessThan(median(smallTimes) * 2 + 100);
  expect(median(bigTimes)).toBeLessThan(500);
  expect(median(readTimes)).toBeLessThan(100);
  await run.app.close();
});

// Review of Batch 11, B11R-7 (the lead's call): back to the Mac's own recent list, so Apple menu > Recent Items and
// the Dock keep the documents, and Corillo never empties it (Batch 11 gave the Dock a menu of Corillo's own, named
// without ".md", and emptied the Mac's list at launch). Corillo's own Open Recent still names them without ".md".
test("documents opened go on the Mac's own recent list, which Corillo never empties, with no Dock menu of its own; Open Recent names them without .md", async () => {
  const home = newHome();
  const plan = writeDoc(home, "Documents/plan.md", "# Plan\n");
  const notes = writeDoc(home, "Documents/notes.md", "# Notes\n");
  const run = await launch(home, []);
  // Test runs never reach the Mac's own list: what would have reached it, launch included, is kept to read here.
  expect(await run.app.evaluate(({ app }) => String(app.addRecentDocument).includes("[native code]"))).toBe(false);
  const mac = () => run.app.evaluate(() => (globalThis as unknown as { macRecent: { added: string[]; cleared: number } }).macRecent);
  const dockMenu = () => run.app.evaluate(({ app }) => app.dock?.getMenu() != null);
  expect(await mac()).toEqual({ added: [], cleared: 0 });
  await openFromFinder(run.app, plan);
  await expect.poll(async () => (await mac()).added).toEqual([plan]);
  await openFromFinder(run.app, notes);
  await expect.poll(async () => (await mac()).added).toEqual([plan, notes]);
  expect(await recentMenu(run.app)).toEqual(["notes", "plan"]);
  // Renamed while open: the Mac's list gets it under its new name too.
  const renamed = join(home, "Documents", "notes 2026.md");
  renameSync(notes, renamed);
  await expect.poll(async () => (await mac()).added).toEqual([plan, notes, renamed]);
  await expect.poll(() => recentMenu(run.app)).toEqual(["notes 2026", "plan"]);
  // Taken off Corillo's list, or that list cleared: the Mac's keeps them.
  await run.page.evaluate((p) => window.corillo.forgetRecent(p), plan);
  await expect.poll(() => recentMenu(run.app)).toEqual(["notes 2026"]);
  await clickMenu(run.app, "clear-recent");
  await expect.poll(() => recentMenu(run.app)).toEqual([]);
  expect((await mac()).cleared).toBe(0);
  // No Dock menu of Corillo's own: the Dock shows the Mac's list.
  expect(await dockMenu()).toBe(false);
  await run.app.close();
});

test("coming back to the front leaves the cards as they are when nothing changed, and redraws them when a document did", async () => {
  const home = newHome();
  const plan = writeDoc(home, "Documents/plan.md", "# Hiring plan\n\nTwo people.\n", 1);
  const notes = writeDoc(home, "Documents/notes.md", "## Notes\n\nThe budget is fine.\n");
  const run = await launch(home, [plan, notes]);
  const { page } = run;
  await expect(cards(page)).toHaveCount(2);
  // Each card as drawn now is marked, to see whether it's drawn again.
  const marked = () => page.locator("#recent .recent-item[data-drawn-before]").count();
  await page.evaluate(() => document.querySelectorAll("#recent .recent-item").forEach((li) => li.setAttribute("data-drawn-before", "")));
  // Count the times the window asks for the cards.
  await run.app.evaluate(({ ipcMain }) => {
    const g = globalThis as unknown as { looks: number };
    g.looks = 0;
    const handlers = (ipcMain as unknown as { _invokeHandlers: Map<string, (...a: unknown[]) => unknown> })._invokeHandlers;
    const real = handlers.get("app:recent-cards")!;
    ipcMain.removeHandler("app:recent-cards");
    ipcMain.handle("app:recent-cards", (...args) => {
      g.looks++;
      return real(...args);
    });
  });
  const looks = () => run.app.evaluate(() => (globalThis as unknown as { looks: number }).looks);
  await page.evaluate(() => window.dispatchEvent(new Event("focus")));
  await expect.poll(looks).toBe(1);
  await page.waitForTimeout(200);
  expect(await marked()).toBe(2);
  // A document changed meanwhile: its card shows the change.
  writeDoc(home, "Documents/notes.md", "## Notes\n\nThe budget is tight.\n");
  await page.evaluate(() => window.dispatchEvent(new Event("focus")));
  await expect.poll(looks).toBe(2);
  await expect(card(page, "notes.md").locator(".recent-page")).toContainText("tight");
  await run.app.close();
});

test("in a preview, a bullet is a small dot inside the text's edge, and a callout is a tinted box with its title in bold", async () => {
  const home = newHome();
  const plan = writeDoc(
    home,
    "Documents/plan.md",
    "# Plan\n\nSome words before the list.\n\n> [!note] What we're asking for\n> Approval to run a trial.\n\n> [!warning]\n> Untitled callout body.\n\n- One designer\n- One engineer\n",
  );
  const run = await launch(home, [plan]);
  const page = run.page.locator("#recent .recent-page").first();
  await expect(page).toContainText("One designer");
  const bullets = await page.evaluate((el) => {
    const edge = el.querySelector(":scope > p")!.getBoundingClientRect().left;
    return [...el.querySelectorAll("ul > li")].map((li) => {
      const line = li.querySelector("p")!.getClientRects()[0];
      const dot = li.querySelector(".preview-bullet")?.getBoundingClientRect();
      return dot && { right: dot.left >= edge, small: dot.height <= line.height / 2, onLine: dot.top >= line.top && dot.bottom <= line.bottom, marker: getComputedStyle(li).listStyleType };
    });
  });
  expect(bullets).toEqual([0, 1].map(() => ({ right: true, small: true, onLine: true, marker: "none" })));
  const callouts = await page.evaluate((el) =>
    [...el.querySelectorAll("blockquote")].map((q) => ({
      text: q.textContent,
      tinted: getComputedStyle(q).backgroundColor !== "rgba(0, 0, 0, 0)",
      title: q.querySelector("strong")?.textContent,
      bold: Number(getComputedStyle(q.querySelector("strong")!).fontWeight) >= 600,
    })),
  );
  expect(callouts).toEqual([
    { text: "What we're asking for\nApproval to run a trial.", tinted: true, title: "What we're asking for", bold: true },
    { text: "Warning\nUntitled callout body.", tinted: true, title: "Warning", bold: true },
  ]);
  await run.app.close();
});

// Where each document stands, and documents moved while closed (roadmap Batch 4, item 3) ---------------------------

const stateOf = (page: Page, name: string) => card(page, name).locator(".recent-state");
const PANEL = ".doc:not([hidden]) aside.comments-panel";

/**
 * Whose turn each comment's card says it is, as a screen reader hears it in the card's name: the
 * card shows no line for it (roadmap Batch 9, item 3).
 */
async function expectTurns(page: Page, turns: string[]): Promise<void> {
  const cards = page.locator(`${PANEL} .comment-card[aria-label^="Comment "]`);
  await expect(cards).toHaveCount(turns.length);
  for (const [i, turn] of turns.entries()) await expect(cards.nth(i)).toHaveAttribute("aria-label", turnSaid(turn));
}

test("each recent document says where it stands, in the words its comments use once it's open; those waiting for you come first", async () => {
  const home = newHome();
  const plan = writeDoc(home, "Documents/plan.md", "# Plan\n");
  const notes = writeDoc(home, "Documents/notes.md", "# Notes\n");
  const report = writeDoc(home, "Documents/report.md", "# Report\n");
  const draft = writeDoc(home, "Documents/draft.md", "# Draft\n");
  const old = writeDoc(home, "Documents/old.md", "# Old\n");
  const recent = [plan, notes, report, draft, old];
  const dataDir = dataFolder(recent);
  keep(dataDir, {
    // An agent has been on it, and nothing waits for anyone: nothing to say.
    [plan]: { threads: [comment([said("person", "Shorter?"), said("Claude", "Done.")], { status: "resolved" })] },
    // An agent has been on it, and the person's newest comment hasn't gone to one.
    [notes]: { threads: [comment([said("person", "Old."), said("Claude", "Done.")], { status: "resolved" }), comment([said("person", "Add the dates?")])] },
    // Two answered comments and a note waiting for the person.
    [report]: {
      threads: [comment([said("person", "Tighter?"), said("Claude", "Tightened.")]), comment([said("person", "Sources?"), said("Claude", "Added two.")])],
      notes: [{ id: "n1", agent: "Claude", text: "I left the numbers alone.", at: new Date().toISOString() }],
    },
    // Only the person's own notes to self, no agent ever: nothing to say.
    [draft]: { threads: [comment([said("person", "Come back to this.")])] },
    [old]: { threads: [comment([said("person", "Is this right?"), said("Writer", "Yes.")])] },
  });
  const run = await launch(home, recent, dataDir);
  const { page } = run;

  // Waiting for you first, each group in the list's order.
  await expect(cardNames(page)).toHaveText(["report", "old", "plan", "notes", "draft"]);
  await expect(stateOf(page, "report.md")).toHaveText("2 comments and a note waiting for you");
  await expect(stateOf(page, "report.md")).toHaveClass(/waiting/);
  await expect(stateOf(page, "old.md")).toHaveText("1 comment waiting for you");
  await expect(stateOf(page, "notes.md")).toHaveText("1 comment not sent to an agent yet");
  await expect(stateOf(page, "notes.md")).not.toHaveClass(/waiting/);
  await expect(stateOf(page, "plan.md")).toHaveCount(0);
  await expect(stateOf(page, "draft.md")).toHaveCount(0);
  // Read out with the card's name.
  await expect(page.getByRole("button", { name: "Open report, in Documents, 2 comments and a note waiting for you", exact: true })).toBeVisible();
  // File > Open Recent keeps the plain order: most recently opened first.
  expect(await recentMenu(run.app)).toEqual(["plan", "notes", "report", "draft", "old"]);

  // Inside, the cards say the same.
  await page.getByRole("button", { name: /^Open report, in / }).click();
  await expectTurns(page, ["Waiting for you", "Waiting for you"]);
  await expect(page.locator(`${PANEL} .comment-card.pass-note`)).toHaveCount(1);
  await clickMenu(run.app, "close-tab");
  await page.getByRole("button", { name: /^Open notes, in / }).click();
  await expectTurns(page, ["Not sent to an agent yet"]);
  await run.app.close();
});

test("with 8 recent documents of 200 comments each, the cards come with where each stands, about as fast as without", async () => {
  const home = newHome();
  const words = "A comment long enough to be like a real one, asking for a change to the paragraph it sits on. ".repeat(3);
  const plain = Array.from({ length: 8 }, (_, i) => writeDoc(home, `Plain/plain${i + 1}.md`, `# Plain ${i + 1}\n\nText.\n`));
  const busy = Array.from({ length: 8 }, (_, i) => writeDoc(home, `Busy/busy${i + 1}.md`, `# Busy ${i + 1}\n\nText.\n`));
  const dataDir = dataFolder(busy);
  keep(
    dataDir,
    Object.fromEntries(
      busy.map((p) => [p, { threads: Array.from({ length: 200 }, (_, k) => comment([said("person", words), ...(k % 4 === 0 ? [said("Claude", words)] : [])])) }]),
    ),
  );
  const run = await launch(home, busy, dataDir);
  await expect(run.page.locator("#recent .recent-state")).toHaveCount(8);
  await expect(stateOf(run.page, "busy1.md")).toHaveText("50 comments waiting for you");

  const read = (paths: string[]) => {
    writeFileSync(join(run.dataDir, "recent.json"), JSON.stringify(paths));
    return run.app.evaluate(({ app }) => void app.emit("corillo-recent-from-disk")).then(() =>
      run.page.evaluate(async () => {
        const t = performance.now();
        const cards = await window.corillo.recentCards();
        return { took: performance.now() - t, states: cards.filter((c) => c.standing).length };
      }),
    );
  };
  const plainTimes: number[] = [];
  const busyTimes: number[] = [];
  for (let i = 0; i < 5; i++) {
    plainTimes.push((await read(plain)).took);
    const b = await read(busy);
    busyTimes.push(b.took);
    expect(b.states, "every card comes with where it stands").toBe(8);
  }
  console.log(`start screen cards: 8 plain ${median(plainTimes).toFixed(1)} ms, 8 of 200 comments ${median(busyTimes).toFixed(1)} ms`);
  expect(median(busyTimes)).toBeLessThan(median(plainTimes) + 40);
  await run.app.close();
});

test("a recent document moved or renamed in Finder while it was closed is found where it is now, with its comments; Open Recent follows", async () => {
  const home = newHome();
  const notes = writeDoc(home, "Documents/notes.md", "# Notes\n");
  const plan = writeDoc(home, "Documents/Plans/plan.md", "# Hiring plan\n\nTwo people.\n");
  const dataDir = dataFolder([notes, plan]);
  keep(dataDir, { [plan]: { threads: [comment([said("person", "@Claude add the dates")], { to: "Claude" })] } });
  // Moved and renamed while Corillo was closed.
  mkdirSync(join(home, "Documents", "Archive"));
  const moved = join(home, "Documents", "Archive", "plan-2026.md");
  renameSync(plan, moved);
  const run = await launch(home, [notes, plan], dataDir);
  const { page } = run;

  // Its card shows where it is now, in its place on the list, saying where it stands.
  await expect(cardNames(page)).toHaveText(["notes", "plan-2026"]);
  await expect(card(page, "plan-2026.md").locator(".recent-folder")).toHaveText("Documents › Archive");
  await expect(card(page, "plan-2026.md").locator(".recent-page h1")).toHaveText("Hiring plan");
  await expect(stateOf(page, "plan-2026.md")).toHaveText("1 comment for Claude, not sent yet");
  expect(JSON.parse(readFileSync(join(run.dataDir, "recent.json"), "utf8"))).toEqual([notes, moved]);
  expect(await recentMenu(run.app)).toEqual(["notes", "plan-2026"]);

  // Moved again while Corillo is running (not open in a tab): found when the start screen next shows. The Mac's
  // own list, which the Dock shows, follows a file by itself and is never emptied (review of Batch 11, B11R-7).
  const final = join(home, "Documents", "plan-final.md");
  renameSync(moved, final);
  await page.evaluate(() => window.dispatchEvent(new Event("focus")));
  await expect(cardNames(page)).toHaveText(["notes", "plan-final"]);
  await expect(card(page, "plan-final.md").locator(".recent-folder")).toHaveText("Documents");
  expect(await recentMenu(run.app)).toEqual(["notes", "plan-final"]);
  expect(await run.app.evaluate(() => (globalThis as unknown as { macRecent: { cleared: number } }).macRecent.cleared)).toBe(0);

  // It opens with its comments.
  await page.getByRole("button", { name: /^Open plan-final, in / }).click();
  await expect(page.locator(`${PANEL} .comment-messages`)).toContainText("@Claude add the dates");
  expect((await tabState(page)).names).toEqual(["plan-final.md"]);
  await run.app.close();
});

test("launched straight into another document, a recent one moved while closed is found by the look after launch; Open Recent opens it where it is", async () => {
  const home = newHome();
  const notes = writeDoc(home, "Documents/notes.md", "# Notes\n");
  const plan = writeDoc(home, "Documents/plan.md", "# Plan\n");
  const other = writeDoc(home, "Documents/other.md", "# Other\n");
  const dataDir = dataFolder([notes, plan]);
  keep(dataDir, { [plan]: { threads: [comment([said("person", "Shorter?"), said("Claude", "Shortened.")])] } });
  const moved = join(home, "Documents", "plan-v2.md");
  renameSync(plan, moved);
  const run = await launch(home, [notes, plan], dataDir, other);
  await launchSettled(run.app);
  await expect.poll(() => recentMenu(run.app)).toEqual(["other", "notes", "plan-v2"]);

  // Renamed again while Corillo runs: File > Open Recent finds it as it opens it.
  const again = join(home, "Documents", "plan-v3.md");
  renameSync(moved, again);
  await run.app.evaluate(({ Menu }) => {
    const item = Menu.getApplicationMenu()!.getMenuItemById("open-recent")!.submenu!.items.find((i) => i.label === "plan-v2")!;
    item.click();
  });
  await expect.poll(async () => (await tabState(run.page)).active).toBe("plan-v3.md");
  await expectTurns(run.page, ["Waiting for you"]);
  expect(JSON.parse(readFileSync(join(run.dataDir, "recent.json"), "utf8"))).toEqual([again, other, notes]);
  await run.app.close();
});

test("a document that can't be found offers Find it…: the same document found elsewhere opens with its comments; another file opens as itself and the card stays", async () => {
  const home = newHome();
  const text = "# Plan\n\nThe plan as it was last saved.\n";
  const plan = writeDoc(home, "Documents/plan.md", text);
  const notes = writeDoc(home, "Documents/notes.md", "# Notes\n");
  const dataDir = dataFolder([plan, notes]);
  keep(dataDir, { [plan]: { text, threads: [comment([said("person", "Shorter?"), said("Claude", "Shortened.")])] } });
  // Gone from its place; a copy is somewhere else (on a backup drive, say: another file, the same text).
  unlinkSync(plan);
  const copy = writeDoc(home, "Backup/plan.md", text);
  const stranger = writeDoc(home, "Backup/stranger.md", "# Something else\n");
  const run = await launch(home, [plan, notes], dataDir);
  const { page } = run;
  await expect(card(page, "plan.md").locator(".recent-gone")).toHaveText("Can't be found");
  await expect(page.getByRole("button", { name: "Remove plan from the list" })).toBeVisible();
  const findIt = page.getByRole("button", { name: "Find plan", exact: true });
  await expect(findIt).toHaveText("Find it…");
  // Only on a card that can't be found.
  await expect(card(page, "notes.md").getByRole("button", { name: /^Find/ })).toHaveCount(0);

  // Another file: Corillo says it isn't that document; opened anyway, it's a document of its own, and the card stays.
  await run.app.evaluate(({ dialog }, picked) => {
    const g = globalThis as { asked?: string[]; offered?: string[] };
    g.asked = [];
    g.offered = [];
    dialog.showOpenDialog = (async (...args: unknown[]) => {
      const options = args.find((a) => typeof a === "object" && a && "properties" in a) as { message?: string };
      g.offered!.push(options.message ?? "");
      return { canceled: false, filePaths: [picked] };
    }) as typeof dialog.showOpenDialog;
    dialog.showMessageBox = (async (...args: unknown[]) => {
      const options = args.find((a) => typeof a === "object" && a && "message" in a) as { message: string; buttons: string[] };
      g.asked!.push(`${options.message} [${options.buttons.join(", ")}]`);
      return { response: 0, checkboxChecked: false };
    }) as typeof dialog.showMessageBox;
  }, stranger);
  await findIt.click();
  await expect.poll(async () => (await tabState(page)).active).toBe("stranger.md");
  expect(await run.app.evaluate(() => (globalThis as { offered?: string[] }).offered)).toEqual(["Choose plan where it is now."]);
  expect(await run.app.evaluate(() => (globalThis as { asked?: string[] }).asked)).toEqual(["That isn't plan as Corillo knew it. [Open It Anyway, Cancel]"]);
  await expectTurns(page, []);
  await clickMenu(run.app, "close-tab");
  await expect(cardNames(page)).toHaveText(["stranger", "plan", "notes"]);
  await expect(card(page, "plan.md").locator(".recent-gone")).toHaveText("Can't be found");

  // The copy: the text Corillo last saved, so it's that document, with its comments, in its place on the list.
  await pickInNextDialog(run.app, copy);
  await page.getByRole("button", { name: "Find plan", exact: true }).click();
  await expect.poll(async () => (await tabState(page)).active).toBe("plan.md");
  await expectTurns(page, ["Waiting for you"]);
  expect(await run.app.evaluate(() => (globalThis as { asked?: string[] }).asked)).toHaveLength(1);
  expect(JSON.parse(readFileSync(join(run.dataDir, "recent.json"), "utf8"))).toEqual([copy, stranger, notes]);
  await run.app.close();
});

test("a recent document in the Trash, or put away in a hidden folder, can't be found, as if deleted", async () => {
  const home = newHome();
  const plan = writeDoc(home, "Documents/plan.md", "# Plan\n");
  const notes = writeDoc(home, "Documents/notes.md", "# Notes\n");
  const gone = writeDoc(home, "Documents/gone.md", "# Gone\n");
  const recent = [plan, notes, gone];
  const dataDir = dataFolder(recent);
  keep(dataDir, { [plan]: {}, [notes]: {}, [gone]: {} });
  mkdirSync(join(home, ".Trash"));
  renameSync(plan, join(home, ".Trash", "plan.md"));
  mkdirSync(join(home, "Documents", ".sync-cache"));
  renameSync(notes, join(home, "Documents", ".sync-cache", "notes.md"));
  unlinkSync(gone);
  const run = await launch(home, recent, dataDir);
  const { page } = run;
  await expect(cardNames(page)).toHaveText(["plan", "notes", "gone"]);
  for (const name of ["plan.md", "notes.md", "gone.md"]) {
    await expect(card(page, name).locator(".recent-gone"), name).toHaveText("Can't be found");
    await expect(card(page, name).locator(".recent-folder"), name).toHaveText("Documents");
  }
  expect(JSON.parse(readFileSync(join(run.dataDir, "recent.json"), "utf8"))).toEqual(recent);
  expect(await recentMenu(run.app)).toEqual([]);
  await run.app.close();
});

test("a recent document moved while closed and opened from Finder at its new place takes its old place's card with it, not leaving one that can't be found", async () => {
  const home = newHome();
  const notes = writeDoc(home, "Documents/notes.md", "# Notes\n");
  const plan = writeDoc(home, "Documents/plan.md", "# Plan\n");
  const dataDir = dataFolder([notes, plan]);
  keep(dataDir, { [plan]: { threads: [comment([said("person", "Shorter?"), said("Claude", "Shortened.")])] } });
  mkdirSync(join(home, "Archive"));
  const moved = join(home, "Archive", "plan.md");
  renameSync(plan, moved);
  const run = await launch(home, [notes, plan], dataDir, moved);
  await expectTurns(run.page, ["Waiting for you"]);
  await launchSettled(run.app);
  expect(JSON.parse(readFileSync(join(run.dataDir, "recent.json"), "utf8"))).toEqual([moved, notes]);
  expect(await recentMenu(run.app)).toEqual(["plan", "notes"]);
  await run.app.close();
});
