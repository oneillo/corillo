// Corillo stays open all day with agents working in it, so nothing it uses
// may keep growing as the person works: memory in the window and in the app,
// open files, connections, programs, timers, and files left on disk. Each test
// repeats something many times and checks the resource comes back to about
// where it started (memory is measured after clearing out what's no longer
// used). The margins are generous, so a busy Mac doesn't fail them; what
// leaked before grew far past them.
import { test, expect, type ElectronApplication, type Page } from "@playwright/test";
import { execFileSync, spawn } from "node:child_process";
import { mkdirSync, mkdtempSync, readdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openText as openNow, openAlso, openFromFinder, selectText, messageAction, clickMenu, cursorAtEnd, launchSettled, watchTimers, EDITOR, ONE_SCALE, type Running, launch, throwawayStart } from "./helpers";
import { AgentSession } from "./agent-session";
import { bigDocument } from "../fixtures/big-document";
import { longSession } from "../fixtures/long-history";

/** A document open in Corillo, once the work it does a moment after launch is done, so measuring starts from a settled app. */
async function openText(...args: Parameters<typeof openNow>): Promise<Running> {
  const run = await openNow(...args);
  await launchSettled(run.app);
  return run;
}

const ROOT = join(import.meta.dirname, "..", "..");
const PANEL = ".doc:not([hidden]) aside.comments-panel";
const DOC = "# Plan\n\nWe should hire two people this spring.\n\nThe budget is tight but workable.\n\nThe office moves in June.\n";

/** What the window holds after clearing out what's no longer used: elements on (or kept off) the page, listeners, and its JavaScript memory in MB. */
async function windowMeter(page: Page): Promise<() => Promise<{ nodes: number; listeners: number; windowMB: number }>> {
  const cdp = await page.context().newCDPSession(page);
  await cdp.send("Performance.enable");
  return async () => {
    await cdp.send("HeapProfiler.collectGarbage");
    await page.waitForTimeout(50);
    await cdp.send("HeapProfiler.collectGarbage");
    const { metrics } = await cdp.send("Performance.getMetrics");
    const get = (name: string) => metrics.find((m) => m.name === name)?.value ?? 0;
    return { nodes: get("Nodes"), listeners: get("JSEventListeners"), windowMB: get("JSHeapUsedSize") / 1048576 };
  };
}

interface AppUse {
  /** The app's memory, in MB, after clearing out what's no longer used: its JavaScript memory and what that holds outside it (bytes read from files, unpacked or fetched). */
  heapMB: number;
  /** Files, sockets and pipes it has open. */
  openFiles: number;
  /** Timers, file watchers, connections and the like keeping it busy, by kind. */
  busy: Record<string, number>;
  windows: number;
}

function appUse(app: ElectronApplication): Promise<AppUse> {
  return app.evaluate(({ BrowserWindow }) => {
    const load = (process as unknown as { mainModule: { require: NodeRequire } }).mainModule.require;
    load("v8").setFlagsFromString("--expose-gc");
    const gc = load("vm").runInNewContext("gc") as () => void;
    gc();
    gc();
    const busy: Record<string, number> = {};
    for (const kind of (process as unknown as { getActiveResourcesInfo(): string[] }).getActiveResourcesInfo()) busy[kind] = (busy[kind] ?? 0) + 1;
    const memory = process.memoryUsage();
    return {
      heapMB: (memory.heapUsed + memory.external) / 1048576,
      openFiles: (load("fs") as typeof import("node:fs")).readdirSync("/dev/fd").length,
      busy,
      windows: BrowserWindow.getAllWindows().length,
    };
  });
}

/** The programs the app has started that are still running (its own helpers among them). */
function programsOf(app: ElectronApplication): string[] {
  const pid = app.process().pid;
  // A busy Mac lists more than Node's default megabyte of programs (several test runs at once did).
  return execFileSync("ps", ["-A", "-o", "ppid=,command="], { encoding: "utf8", maxBuffer: 64 * 1024 * 1024 })
    .split("\n")
    .map((line) => line.trim().split(/\s+/))
    .filter((parts) => Number(parts[0]) === pid)
    .map((parts) => parts.slice(1).join(" "));
}

const card = (page: Page, text: string) => page.locator(`${PANEL} .comment-card:not(.draft)`, { hasText: text });

async function comment(run: Running, text: string, body: string): Promise<void> {
  await expect(run.page.locator(EDITOR)).toContainText(text); // a document just opened shows its text first
  await selectText(run.page, text);
  await run.page.getByRole("button", { name: "Comment", exact: true }).click();
  await run.page.getByRole("textbox", { name: "New comment" }).fill(body);
  await run.page.getByRole("button", { name: "Post" }).click();
  await expect(card(run.page, body)).toBeVisible();
}

/** Type @ in a comment box: the list of agents opens; Escape closes it. */
async function lookAtAgents(run: Running): Promise<void> {
  await run.page.keyboard.type("Ask @");
  await expect(run.page.locator("#mention-list")).toBeVisible();
  await run.page.keyboard.press("Escape");
}

test("the measure of Corillo's memory sees bytes it holds outside its JavaScript memory (A-6)", async () => {
  const run = await openText(DOC);
  const before = await appUse(run.app);
  await run.app.evaluate(() => {
    (globalThis as unknown as { kept: Buffer }).kept = Buffer.alloc(16 * 1048576, 1); // as a cache of file contents kept by mistake would
  });
  const after = await appUse(run.app);
  expect(after.heapMB).toBeGreaterThan(before.heapMB + 15);
  await run.app.close();
});

test("comments written, replied to, resolved and deleted, and comments started and cancelled, leave nothing behind in the window", async () => {
  const run = await openText(DOC);
  const measure = await windowMeter(run.page);
  const round = async (i: number) => {
    await comment(run, "budget", `Resolve me ${i}`);
    const resolved = card(run.page, `Resolve me ${i}`);
    await resolved.locator(".comment-body").click();
    await resolved.getByRole("textbox", { name: "Reply" }).fill("Noted.");
    await resolved.getByRole("button", { name: "Reply", exact: true }).click();
    await expect(resolved.locator(".comment-message")).toHaveCount(2);
    await resolved.getByRole("button", { name: "Resolve", exact: true }).click();
    await expect(resolved).toBeHidden();
    await comment(run, "office", `Delete me ${i}`);
    const deleted = card(run.page, `Delete me ${i}`);
    await messageAction(deleted, "Delete"); // at once, no question (roadmap Batch 9, item 4)
    await expect(deleted).toBeHidden();
    await selectText(run.page, "spring");
    await run.page.getByRole("button", { name: "Comment", exact: true }).click();
    await lookAtAgents(run);
    await run.page.locator(`${PANEL} .comment-card.draft`).getByRole("button", { name: "Cancel" }).click();
    await expect(run.page.locator(`${PANEL} .comment-card.draft`)).toHaveCount(0);
  };
  await round(0); // the first time sets up what stays (the @ list, the resolved count)
  const before = await measure();
  for (let i = 1; i <= 10; i++) await round(i);
  const after = await measure();
  console.log(`Window after 10 rounds of comments: ${before.nodes} → ${after.nodes} elements, ${before.listeners} → ${after.listeners} listeners`);
  // Each round used to keep over 200 elements of comment boxes long gone.
  expect(after.nodes).toBeLessThan(before.nodes + 150);
  expect(after.listeners).toBeLessThan(before.listeners + 40);
  await run.app.close();
});

test("closing documents lets go of them: after commenting and using the @ list in them, and when one is closed right after it opens", async () => {
  const run = await openText("Start.\n");
  const measure = await windowMeter(run.page);
  const commentedOn = async (i: number) => {
    await openAlso(run, `doc ${i}.md`, DOC);
    await expect(run.page.locator(".tab")).toHaveCount(2);
    await comment(run, "two people", `Is two enough ${i}?`);
    const posted = card(run.page, `Is two enough ${i}?`);
    await posted.locator(".comment-body").click(); // its reply box shows on the card in use
    const reply = posted.getByRole("textbox", { name: "Reply" });
    await reply.click();
    await lookAtAgents(run);
    await reply.fill(""); // nothing unposted, so closing doesn't ask
    await run.page.locator(".tab[aria-selected='true'] .tab-close").click();
    await expect(run.page.locator(".tab")).toHaveCount(1);
  };
  const file = join(run.folder, "doc 0.md");
  /** The last document closed, the start screen, the document opened again and closed at once. */
  const openedAndClosed = async () => {
    await clickMenu(run.app, "close-tab");
    await expect(run.page.locator(".recent-card").first()).toBeVisible();
    await run.page.evaluate((p) => window.corillo.openPath(p), file);
    await expect(run.page.locator(EDITOR)).toBeVisible();
  };
  await commentedOn(0);
  await openedAndClosed();
  await clickMenu(run.app, "close-tab");
  await run.page.evaluate((p) => window.corillo.openPath(p), run.file);
  await expect(run.page.locator(EDITOR)).toContainText("Start.");
  const before = await measure();
  for (let i = 1; i <= 5; i++) await commentedOn(i);
  for (let i = 0; i < 8; i++) await openedAndClosed();
  await clickMenu(run.app, "close-tab");
  await run.page.evaluate((p) => window.corillo.openPath(p), run.file);
  await expect(run.page.locator(EDITOR)).toContainText("Start.");
  await run.page.waitForTimeout(300);
  const after = await measure();
  console.log(`Window after 13 documents closed: ${before.nodes} → ${after.nodes} elements, ${before.listeners} → ${after.listeners} listeners`);
  // The start screen's recent list gains a card for each new document (up to 15).
  // Before, each document closed straight after opening kept about 30 elements and 17 listeners.
  expect(after.nodes).toBeLessThan(before.nodes + 200);
  expect(after.listeners).toBeLessThan(before.listeners + 30);
  await run.app.close();
});

test("going through an agent's answers from the keyboard, with dots and a count for what's new, then closing the document, leaves nothing behind in the window", async () => {
  const run = await openText("Start.\n");
  const { page } = run;
  const measure = await windowMeter(page);
  const { session } = await AgentSession.start(run.dataDir, "claude-code");
  const turn = page.locator("#turn-status");
  const round = async (i: number) => {
    const file = await openAlso(run, `doc ${i}.md`, DOC);
    await expect(page.locator(".tab")).toHaveCount(2);
    await comment(run, "two people", `Is two enough ${i}?`);
    await comment(run, "office", `Which office ${i}?`);
    const taken = await session.ok("take_document", { path: file });
    for (const [, id] of taken.matchAll(/\[([^\]]+)\] on "/g)) await session.ok("reply_to_comment", { path: file, comment_id: id, text: `Yes, round ${i}.` });
    await session.ok("finish_editing", { path: file });
    await expect(turn).toHaveText("With you · 2 to read");
    // The keyboard on the first card; a letter starts the reply, taken back; Escape to the card, then the document.
    await page.keyboard.press("Meta+Alt+ArrowDown");
    const reply = card(run.page, `Is two enough ${i}?`).getByRole("textbox", { name: "Reply" });
    await page.keyboard.type("a");
    await expect(reply).toHaveValue("a");
    await page.keyboard.press("Backspace");
    await page.keyboard.press("Escape");
    await page.keyboard.press("Escape");
    // The next card, and the document closed with the keyboard resting on it.
    await page.keyboard.press("Meta+Alt+ArrowDown");
    await expect(turn).toHaveText("With you");
    await page.locator(".tab[aria-selected='true'] .tab-close").click();
    await expect(page.locator(".tab")).toHaveCount(1);
  };
  try {
    await round(0);
    await page.waitForTimeout(300);
    const before = await measure();
    for (let i = 1; i <= 6; i++) await round(i);
    await page.waitForTimeout(300);
    const after = await measure();
    console.log(`Window after 6 documents gone through and closed: ${before.nodes} → ${after.nodes} elements, ${before.listeners} → ${after.listeners} listeners`);
    // The start screen's recent list gains a card for each new document.
    expect(after.nodes).toBeLessThan(before.nodes + 200);
    expect(after.listeners).toBeLessThan(before.listeners + 30);
  } finally {
    await session.stop();
    await run.app.close();
  }
});

test("empty lines added and taken away, then the document closed at once, leave no frames, elements or listeners behind", async () => {
  const run = await openText("Start.\n");
  const measure = await windowMeter(run.page);
  /** Return and Backspace change the document's blocks, so its spacing is worked out again next frame: closing first must stop that. */
  const spacedAndClosed = async (i: number) => {
    await openAlso(run, `spaced ${i}.md`, DOC);
    await expect(run.page.locator(".tab")).toHaveCount(2);
    await cursorAtEnd(run.page, "this spring.");
    await run.page.keyboard.press("Enter");
    await run.page.keyboard.press("Enter");
    await run.page.keyboard.press("Backspace");
    await run.page.locator(".tab[aria-selected='true'] .tab-close").click();
    await expect(run.page.locator(".tab")).toHaveCount(1);
  };
  await spacedAndClosed(0);
  await run.page.waitForTimeout(300);
  const before = await measure();
  for (let i = 1; i <= 8; i++) await spacedAndClosed(i);
  await run.page.waitForTimeout(300);
  const after = await measure();
  // And nothing is left waiting for a frame.
  await run.page.evaluate(() => {
    const w = window as unknown as { woke: number };
    w.woke = 0;
    const frame = window.requestAnimationFrame.bind(window);
    window.requestAnimationFrame = (cb) => frame((t) => (w.woke++, cb(t)));
  });
  await run.page.waitForTimeout(500);
  const woke = await run.page.evaluate(() => (window as unknown as { woke: number }).woke);
  console.log(`Window after 8 spaced documents closed: ${before.nodes} → ${after.nodes} elements, ${before.listeners} → ${after.listeners} listeners, ${woke} frames`);
  expect(after.nodes).toBeLessThan(before.nodes + 200);
  expect(after.listeners).toBeLessThan(before.listeners + 30);
  expect(woke).toBe(0);
  await run.app.close();
});

test("an agent connecting and leaving 25 times leaves no connections, open files, timers or memory behind", async () => {
  const run = await openText(DOC);
  const measure = await windowMeter(run.page);
  const visit = async (i: number) => {
    const { session } = await AgentSession.start(run.dataDir, i % 3 === 0 ? "claude-code" : `tool-${i}`);
    await session.ok("read_document", { path: run.file });
    await session.ok("list_comments", { path: run.file });
    await session.stop();
  };
  for (let i = 0; i < 3; i++) await visit(i);
  await run.page.waitForTimeout(300);
  const before = await appUse(run.app);
  const page = await measure();
  for (let i = 3; i < 28; i++) await visit(i);
  // The last one's leaving reaches Corillo a moment after it's gone.
  await expect.poll(async () => (await appUse(run.app)).openFiles).toBeLessThanOrEqual(before.openFiles + 1);
  const after = await appUse(run.app);
  console.log(`After 25 agents came and went: ${before.heapMB.toFixed(2)} → ${after.heapMB.toFixed(2)} MB, ${before.openFiles} → ${after.openFiles} open files, busy ${JSON.stringify(after.busy)}`);
  expect(after.busy).toEqual(before.busy);
  expect(after.heapMB).toBeLessThan(before.heapMB + 0.75);
  const pageAfter = await measure();
  expect(pageAfter.nodes).toBeLessThan(page.nodes + 50);
  expect(pageAfter.listeners).toBeLessThan(page.listeners + 10);
  await run.app.close();
});

test("agents' editing passes, one after another, each with a note, leave nothing behind in the window or in Corillo's memory", async () => {
  const run = await openText(DOC);
  const measure = await windowMeter(run.page);
  const { session } = await AgentSession.start(run.dataDir);
  try {
    await session.ok("read_document", { path: run.file });
    const pass = async (i: number) => {
      const added = await run.page.evaluate(async (i) => {
        const id = document.querySelector(".doc:not([hidden])")!.getAttribute("data-doc-id")!;
        return window.corillo.addComment(id, `Say when, round ${i}.`, null, null);
      }, i);
      expect(added.ok).toBe(true);
      const taken = await session.ok("take_document", { path: run.file });
      const id = /\[([0-9a-f]+)\]/.exec(taken)![1];
      await session.ok("edit_document", { path: run.file, edits: [{ find: "moves in June", replace: `moves in June (${i})` }], comment_ids: [id] });
      await session.ok("edit_document", { path: run.file, edits: [{ find: ` (${i})`, replace: "" }], comment_ids: [id] });
      await session.ok("reply_to_comment", { path: run.file, comment_id: id, text: `Done, round ${i}.` });
      // A note each time (roadmap Batch 2, item 3), put away with Done as the comment is resolved.
      await session.ok("finish_editing", { path: run.file, note: `Round ${i}: I also kept the date as it was.` });
      const answered = card(run.page, `Done, round ${i}.`);
      await answered.getByRole("button", { name: "Resolve", exact: true }).click();
      await expect(answered).toBeHidden();
      const note = card(run.page, `Round ${i}: I also kept the date`);
      await note.getByRole("button", { name: "Done", exact: true }).click();
      await expect(note).toBeHidden();
    };
    for (let i = 0; i < 3; i++) await pass(i);
    await run.page.waitForTimeout(300);
    const before = { ...(await measure()), ...(await appUse(run.app)) };
    for (let i = 3; i < 15; i++) await pass(i);
    await run.page.waitForTimeout(300);
    const after = { ...(await measure()), ...(await appUse(run.app)) };
    console.log(
      `After 12 agent passes: window ${before.nodes} → ${after.nodes} elements, app ${before.heapMB.toFixed(2)} → ${after.heapMB.toFixed(2)} MB, ${before.openFiles} → ${after.openFiles} open files`,
    );
    expect(after.nodes).toBeLessThan(before.nodes + 100);
    expect(after.listeners).toBeLessThan(before.listeners + 20);
    // The history and the comments grow on disk, as they should; what's kept in memory doesn't.
    expect(after.heapMB).toBeLessThan(before.heapMB + 1);
    expect(after.openFiles).toBeLessThanOrEqual(before.openFiles + 1);
    expect(after.busy).toEqual(before.busy);
  } finally {
    await session.stop();
    await run.app.close();
  }
});

test("documents with many comments, opened and closed, are let go of in Corillo's memory, their files stop being watched, and the recent list stays at 15", async () => {
  const run = await openText("Start.\n");
  const LONG = "This comment says a good deal about the plan and what could change in it. ".repeat(25);
  const visit = async (i: number) => {
    await openAlso(run, `doc ${i}.md`, DOC);
    await expect(run.page.locator(".tab")).toHaveCount(2);
    await run.page.evaluate(async (body) => {
      const id = document.querySelector(".doc:not([hidden])")!.getAttribute("data-doc-id")!;
      for (let k = 0; k < 30; k++) await window.corillo.addComment(id, `${k} ${body}`, null, null);
    }, LONG);
    await run.page.locator(".tab[aria-selected='true'] .tab-close").click();
    await expect(run.page.locator(".tab")).toHaveCount(1);
  };
  for (let i = 0; i < 3; i++) await visit(i);
  await run.page.waitForTimeout(300);
  const before = await appUse(run.app);
  for (let i = 3; i < 23; i++) await visit(i);
  await run.page.waitForTimeout(300);
  const after = await appUse(run.app);
  console.log(`After 20 documents of 30 comments each: ${before.heapMB.toFixed(2)} → ${after.heapMB.toFixed(2)} MB, watching ${JSON.stringify(after.busy)}`);
  // Keeping every closed document's comments added about 1.5 MB here.
  expect(after.heapMB).toBeLessThan(before.heapMB + 0.75);
  expect(after.busy).toEqual(before.busy); // one file watched, the document still open
  expect(after.openFiles).toBeLessThanOrEqual(before.openFiles + 1);
  expect(JSON.parse(readFileSync(join(run.dataDir, "recent.json"), "utf8"))).toHaveLength(15);
  await run.app.close();
});

test("a document renamed and moved many times while open, and documents moved to the Trash, leave no watched files, timers, programs or open files behind", async () => {
  test.setTimeout(120_000);
  const run = await openText("Start.\n", { name: "doc 0.md" });
  const title = () => run.app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].getTitle());
  const trash = join(run.folder, ".Trash"); // a pretend Trash, never the real one
  mkdirSync(trash);
  mkdirSync(join(run.folder, "Elsewhere"));
  let at = run.file;
  const rename = async (i: number) => {
    const to = join(run.folder, i % 2 ? "Elsewhere" : "", `doc ${i}.md`);
    renameSync(at, to);
    at = to;
    await expect.poll(title, { timeout: 10_000 }).toBe(`doc ${i}`);
  };
  const trashOne = async (i: number) => {
    const other = await openAlso(run, `trashed ${i}.md`, DOC);
    await expect(run.page.locator(".tab")).toHaveCount(2);
    renameSync(other, join(trash, `trashed ${i}.md`));
    await expect(run.page.locator(".doc")).toHaveCount(1); // its tab closed
  };
  await rename(1);
  await trashOne(0);
  await run.page.waitForTimeout(500);
  const before = await appUse(run.app);
  const programs = programsOf(run.app).length;
  for (let i = 2; i < 10; i++) {
    await rename(i);
    if (i % 3 === 0) await trashOne(i);
  }
  await run.page.waitForTimeout(500);
  await expect.poll(() => programsOf(run.app).length).toBeLessThanOrEqual(programs);
  const after = await appUse(run.app);
  console.log(`After 8 renames and 2 documents trashed: watching ${JSON.stringify(after.busy)}, ${after.openFiles} open files`);
  expect(after.busy).toEqual(before.busy);
  expect(after.openFiles).toBeLessThanOrEqual(before.openFiles + 1);
  expect(programsOf(run.app).filter((p) => /osascript/.test(p))).toEqual([]);
  await run.app.close();
});

test("Word and PDF exports, many times over, leave no temporary files, windows, programs or open files behind", async () => {
  test.setTimeout(120_000);
  execFileSync(process.execPath, [join(ROOT, "scripts", "fetch-pandoc.mjs"), `--arch=${process.arch}`], { stdio: "inherit" });
  const temp = mkdtempSync(join(tmpdir(), "corillo-temp-"));
  const wasTemp = process.env.TMPDIR;
  process.env.TMPDIR = temp; // Corillo's temporary files go here, where they can be counted
  let run: Running | null = null;
  let session: AgentSession | null = null;
  try {
    const DIAGRAM = `${DOC}\n\`\`\`mermaid\ngraph LR\n  Ask --> Draft\n\`\`\`\n\n| A | B |\n|---|---|\n| 1 | 2 |\n`;
    run = await openText(DIAGRAM);
    // The connector's stand-in home, made before counting what's in the temporary folder.
    const home = mkdtempSync(join(tmpdir(), "corillo-home-"));
    const before = readdirSync(temp);
    session = (await AgentSession.start(run.dataDir, "claude-code", { env: { CORILLO_HOME: home } })).session;
    const both = async () => {
      await session!.ok("export_document", { path: run!.file, format: "word", replace: true });
      await session!.ok("export_document", { path: run!.file, format: "pdf", replace: true });
    };
    await both();
    await run.page.waitForTimeout(300);
    const start = await appUse(run.app);
    const programs = programsOf(run.app).length;
    for (let i = 0; i < 4; i++) await both();
    await run.page.waitForTimeout(500);
    const after = await appUse(run.app);
    console.log(`After 5 Word and 5 PDF exports: ${start.openFiles} → ${after.openFiles} open files, ${after.windows} window, temporary folder ${JSON.stringify(readdirSync(temp))}`);
    expect(readdirSync(temp)).toEqual(before);
    expect(readdirSync(run.folder).sort()).toEqual(["proposal.docx", "proposal.md", "proposal.pdf"]);
    expect(after.windows).toBe(1);
    expect(after.openFiles).toBeLessThanOrEqual(start.openFiles + 1);
    expect(after.busy).toEqual(start.busy);
    await expect.poll(() => programsOf(run!.app).length).toBeLessThanOrEqual(programs);
    expect(programsOf(run.app).filter((p) => /pandoc/i.test(p))).toEqual([]);
  } finally {
    if (wasTemp === undefined) delete process.env.TMPDIR;
    else process.env.TMPDIR = wasTemp;
    await session?.stop();
    await run?.app.close();
  }
});

test("Help opened and closed many times leaves no windows, programs or open files behind", async () => {
  const run = await openText(DOC);
  const help = async () => {
    const [win] = await Promise.all([run.app.waitForEvent("window"), clickMenu(run.app, "corillo-help")]);
    await win.waitForSelector(".help-page:not([hidden])");
    await win.close();
  };
  await help();
  await run.page.waitForTimeout(300);
  const before = await appUse(run.app);
  const programs = programsOf(run.app).length;
  for (let i = 0; i < 8; i++) await help();
  await expect.poll(async () => (await appUse(run.app)).windows).toBe(1);
  await expect.poll(() => programsOf(run.app).length).toBeLessThanOrEqual(programs);
  const after = await appUse(run.app);
  expect(after.openFiles).toBeLessThanOrEqual(before.openFiles + 1);
  expect(after.heapMB).toBeLessThan(before.heapMB + 0.5);
  await run.app.close();
});

test("the Connect screen, opened, used and closed many times, with sessions coming and going, leaves no timers, listeners or elements behind (P-5)", async () => {
  // Claude Desktop and Claude Code on this Mac; the wait before "Still waiting?" made a length no other timer has.
  const STILL = 54_321;
  const home = mkdtempSync(join(tmpdir(), "corillo-home-"));
  for (const sign of ["Applications/Claude.app", ".claude"]) mkdirSync(join(home, sign), { recursive: true });
  const dataDir = mkdtempSync(join(tmpdir(), "corillo-data-"));
  writeFileSync(join(dataDir, "setup.json"), '{ "connectAgentsOffered": true }\n');
  const { app } = await launch({
    args: [ONE_SCALE, "."],
    env: { ...process.env, CORILLO_USER_DATA: dataDir, CORILLO_HIDDEN: "1", CORILLO_HOME: home, CORILLO_CONNECT_STILL_MS: String(STILL) },
  });
  const page = await app.firstWindow();
  await page.waitForSelector("#empty");
  await launchSettled(app);
  const waits = await watchTimers(page, STILL);
  const measure = await windowMeter(page);
  const box = page.getByRole("dialog", { name: "Connect your agents" });
  const round = async (i: number) => {
    await clickMenu(app, "connect-agents");
    await expect(box).toBeVisible();
    for (const tool of ["Claude Desktop", "Claude Code"]) {
      const disconnect = box.getByRole("button", { name: `Disconnect ${tool}` });
      if (await disconnect.count()) await disconnect.click();
      await box.getByRole("button", { name: `Connect ${tool}` }).click();
    }
    await expect.poll(async () => (await waits.count()).waiting).toBe(2);
    // Every other time, a Claude Code session reaches Corillo while the screen waits.
    if (i % 2) {
      const { session } = await AgentSession.start(dataDir, "claude-code");
      await session.ok("list_documents");
      await expect(box.locator('.agent-row[data-tool="claude-code"] .agent-connected')).toBeVisible();
      await expect.poll(async () => (await waits.count()).waiting).toBe(1);
      await session.stop();
    }
    await box.getByRole("button", { name: "Done" }).click();
    await expect(box).toBeHidden();
    // Closed: nothing waits on (the box says it's closed a moment after it goes).
    await expect.poll(async () => (await waits.count()).waiting).toBe(0);
  };
  try {
    for (let i = 0; i < 2; i++) await round(i);
    await page.waitForTimeout(300);
    const before = { ...(await measure()), ...(await appUse(app)) };
    for (let i = 0; i < 16; i++) await round(i);
    await page.waitForTimeout(300);
    const after = { ...(await measure()), ...(await appUse(app)) };
    console.log(
      `After the Connect screen 16 times: window ${before.nodes} → ${after.nodes} elements, ${before.listeners} → ${after.listeners} listeners, ${before.windowMB.toFixed(2)} → ${after.windowMB.toFixed(2)} MB; app ${before.heapMB.toFixed(2)} → ${after.heapMB.toFixed(2)} MB`,
    );
    expect((await waits.count()).ran).toBe(0);
    expect(after.nodes).toBeLessThan(before.nodes + 50);
    expect(after.listeners).toBeLessThan(before.listeners + 10);
    expect(after.windowMB).toBeLessThan(before.windowMB + 1);
    expect(after.heapMB).toBeLessThan(before.heapMB + 0.75);
    expect(after.busy).toEqual(before.busy);
  } finally {
    await app.close();
  }
});

test("a long document an agent edited is let go of in Corillo's memory once it's closed", async () => {
  const run = await openText("Start.\n");
  const { session } = await AgentSession.start(run.dataDir);
  // Twice the long test document, with an accented letter (so each character takes two bytes): about 2.9 MB as Corillo reads it for agents.
  const LONG = bigDocument(30).replace("\n\n", "\n\nSeñal.\n\n") + bigDocument(30);
  const tabs = run.page.locator(".tab");
  const close = async () => {
    await run.page.locator(".tab[aria-selected='true'] .tab-close").click();
    await expect(tabs).toHaveCount(1);
  };
  /** An agent's pass on a document, one edit after another, then the document closed. */
  const pass = async (name: string, text: string, finds: string[]) => {
    const file = await openAlso(run, name, text);
    await expect(tabs).toHaveCount(2);
    await expect(run.page.locator(EDITOR)).toContainText(finds[0]);
    await session.ok("take_document", { path: file });
    for (const find of finds) await session.ok("edit_document", { path: file, edits: [{ find, replace: `${find}Rewritten ` }] });
    await session.ok("finish_editing", { path: file });
    await close();
  };
  try {
    // Twice first, so what stays for good (the agent's session, what reading long documents sets up) is there before
    // measuring; then a small document's edits, so what Corillo kept of the long ones is gone either way.
    await pass("first.md", LONG, ["Señal."]);
    await pass("second.md", LONG, ["Señal."]);
    await pass("small.md", DOC, ["The office ", "The budget "]);
    // The agent carries on with another document: the regular-expression engine lets go of the last text it searched
    // (it keeps one until it next searches anything), so what's measured is only what Corillo keeps.
    const carryOn = () => session.ok("read_document", { path: run.file });
    await carryOn();
    await run.page.waitForTimeout(300);
    const before = await appUse(run.app);
    await pass("long.md", LONG, ["Señal."]);
    await carryOn();
    await run.page.waitForTimeout(300);
    const after = await appUse(run.app);
    console.log(`A long document edited by an agent, then closed: ${before.heapMB.toFixed(2)} → ${after.heapMB.toFixed(2)} MB`);
    // Before, the words Corillo read to tie the agent's edit to its comments stayed after closing: about 2.2 MB here.
    expect(after.heapMB).toBeLessThan(before.heapMB + 1);
  } finally {
    await session.stop();
    await run.app.close();
    rmSync(run.folder, { recursive: true, force: true });
    rmSync(run.dataDir, { recursive: true, force: true });
  }
});

test("History on a long history, opened with a version looked at and typing alongside, then closed, many times, keeps nothing in the window or in Corillo's memory", async () => {
  test.setTimeout(120_000);
  const dataDir = mkdtempSync(join(tmpdir(), "corillo-data-"));
  const made: { session?: ReturnType<typeof longSession> } = {};
  const run = await openText("", { name: "plan.md", dataDir, prepare: (folder) => (made.session = longSession({ passes: 40, data: dataDir, file: join(folder, "plan.md") })) });
  const { page } = run;
  const versions = made.session!.texts.length;
  const measure = await windowMeter(page);
  const press = (selector: string) => page.evaluate((s) => document.querySelector<HTMLElement>(s)!.click(), selector);
  // History's own parts (its panel, its banner) are made the first time it's used: Show changes and back.
  await press(".history-tools button[aria-label='Show changes']");
  await expect(page.locator(".doc:not([hidden]) .version-banner")).toBeVisible();
  await press(".doc:not([hidden]) .version-banner .back-to-current");
  await expect(page.locator(EDITOR)).toBeVisible();
  const round = async (i: number) => {
    await page.getByRole("button", { name: "History", exact: true }).click();
    const rows = page.locator(".doc:not([hidden]) .history-panel .history-entry");
    await expect(rows).toHaveCount(versions);
    // An agent's pass, its whole conversation open, then back.
    await page.locator(".doc:not([hidden]) .history-item").filter({ hasText: "Claude" }).nth(i).click();
    await expect(page.locator(".doc:not([hidden]) .history-entry.open .history-detail")).toBeVisible();
    await press(".doc:not([hidden]) .version-banner .back-to-current");
    await expect(page.locator(".doc:not([hidden]) .history-detail")).toHaveCount(0);
    // Typing with the panel open: each save brings the list up to date.
    await page.locator(`${EDITOR} p`).last().click();
    await page.keyboard.press("Meta+ArrowDown");
    await page.keyboard.type(` round ${i}`);
    await expect.poll(() => run.text()).toContain(` round ${i}`);
    await page.waitForTimeout(300);
    await page.getByRole("button", { name: "Close history" }).click();
    await expect(page.locator(".doc:not([hidden]) .history-panel")).toBeHidden();
  };
  await page.waitForTimeout(300);
  const before = { ...(await measure()), ...(await appUse(run.app)) };
  for (let i = 0; i < 6; i++) await round(i);
  await page.waitForTimeout(300);
  const after = { ...(await measure()), ...(await appUse(run.app)) };
  console.log(
    `History on ${versions} versions, opened and closed 6 times: window ${before.nodes} → ${after.nodes} elements, ${before.listeners} → ${after.listeners} listeners; app ${before.heapMB.toFixed(2)} → ${after.heapMB.toFixed(2)} MB`,
  );
  // The list's rows (about 1,000 elements here, kept before) aren't kept once the panel is closed, nor the conversation looked at.
  expect(after.nodes).toBeLessThan(before.nodes + 100);
  expect(after.listeners).toBeLessThan(before.listeners + 20);
  expect(after.heapMB).toBeLessThan(before.heapMB + 1);
  expect(after.busy).toEqual(before.busy);
  await run.app.close();
});

// A16-6: the history kept the texts behind the newest version of the last four documents whose History was shown, closed or not.
test("History shown for a document, then its tab closed: Corillo keeps none of its texts in memory", async () => {
  const run = await openText(DOC, { name: "plan.md" });
  const { page, app } = run;
  const names = ["one.md", "two.md"];
  for (const name of names) {
    const file = await openAlso(run, name, DOC);
    await expect(page.locator(".tab")).toHaveCount(2);
    writeFileSync(file, DOC.replace("June", "July")); // a second version, from another app
    await expect(page.locator(EDITOR)).toContainText("July");
    await page.getByRole("button", { name: "History", exact: true }).click();
    await expect(page.locator(".doc:not([hidden]) .history-panel .history-item")).toHaveCount(2);
    await page.locator(".tab[aria-selected='true'] .tab-close").click();
    await expect(page.locator(".tab")).toHaveCount(1);
  }
  const index = JSON.parse(readFileSync(join(run.dataDir, "documents.json"), "utf8")) as Record<string, { path: string }>;
  const closed = Object.entries(index).filter(([, e]) => names.some((n) => e.path.endsWith(`/${n}`))).map(([id]) => id);
  expect(closed).toHaveLength(2);
  // What History worked out about each row stays (bounded, a few hundred bytes each); the texts behind the newest go.
  const texts = (await mainHolders(app, closed)).filter((h) => h.shape.includes("prev"));
  expect(texts).toEqual([]);
  await app.close();
});

// Roadmap Batch 3, item 1: Show changes' marks, its arrows and the card it goes to are let go when it's hidden or its tab closes.
test("Show changes on a long history, stepped through and a card clicked, then hidden, many times, and closed with its tab, keeps nothing", async () => {
  test.setTimeout(120_000);
  const dataDir = mkdtempSync(join(tmpdir(), "corillo-data-"));
  const run = await openText("", { name: "plan.md", dataDir, prepare: (folder) => longSession({ passes: 40, data: dataDir, file: join(folder, "plan.md") }) });
  const { page } = run;
  await openAlso(run, "other.md", DOC);
  await page.locator(".tab").first().click();
  const measure = await windowMeter(page);
  const banner = page.locator(".doc:not([hidden]) .version-banner");
  const round = async () => {
    await clickMenu(run.app, "view-changes");
    await expect(banner).toContainText("since you handed it over");
    for (let k = 0; k < 3; k++) await banner.getByRole("button", { name: "Next change" }).click();
    await page.keyboard.press("Meta+Alt+ArrowDown");
    await page.keyboard.press("Meta+Alt+ArrowUp");
    await expect(banner.locator(".version-step-place")).toHaveText(/ of /);
    const card = page.locator(`${PANEL} .comment-card`).first();
    if (await card.count()) await card.click();
    await clickMenu(run.app, "view-changes");
    await expect(banner).toBeHidden();
  };
  await round(); // what's made the first time (the banner, its arrows) stays for the next
  await page.waitForTimeout(300);
  const before = { ...(await measure()), ...(await appUse(run.app)) };
  for (let i = 0; i < 6; i++) await round();
  await page.waitForTimeout(300);
  const after = { ...(await measure()), ...(await appUse(run.app)) };
  // Then closed with the changes on screen.
  await clickMenu(run.app, "view-changes");
  await expect(banner).toBeVisible();
  await banner.getByRole("button", { name: "Next change" }).click();
  await clickMenu(run.app, "close-tab");
  await expect(page.locator(".tab")).toHaveCount(1);
  await page.waitForTimeout(300);
  const closed = { ...(await measure()), ...(await appUse(run.app)) };
  console.log(
    `Show changes shown and hidden 6 times: window ${before.nodes} → ${after.nodes} elements, ${before.listeners} → ${after.listeners} listeners, app ${before.heapMB.toFixed(2)} → ${after.heapMB.toFixed(2)} MB; tab closed: ${closed.nodes} elements, ${closed.listeners} listeners`,
  );
  expect(after.nodes).toBeLessThan(before.nodes + 100);
  expect(after.listeners).toBeLessThan(before.listeners + 20);
  expect(after.heapMB).toBeLessThan(before.heapMB + 1);
  expect(after.busy).toEqual(before.busy);
  // Its tab closed, nothing of the view is left: fewer elements and listeners than with it open.
  expect(closed.nodes).toBeLessThan(before.nodes);
  expect(closed.listeners).toBeLessThanOrEqual(before.listeners);
  for (const [kind, n] of Object.entries(closed.busy)) expect(n, kind).toBeLessThanOrEqual(before.busy[kind] ?? 0); // its file is no longer watched
  await run.app.close();
});

test("nothing runs while nobody does anything: documents open, comments, History, and an agent connected and idle", async () => {
  const run = await openText(DOC);
  await openAlso(run, "second.md", "# Second\n\nA few words to comment on.\n");
  await comment(run, "few words", "A note.");
  await run.page.getByRole("button", { name: "History", exact: true }).click();
  const { session } = await AgentSession.start(run.dataDir);
  try {
    await session.ok("read_document", { path: run.file });
    await run.page.waitForTimeout(1000);
    const cdp = await run.page.context().newCDPSession(run.page);
    await cdp.send("Performance.enable");
    // From here, count every frame asked for and every timer that fires in the window.
    await run.page.evaluate(() => {
      const w = window as unknown as { woke: number };
      w.woke = 0;
      const frame = window.requestAnimationFrame.bind(window);
      window.requestAnimationFrame = (cb) => frame((t) => (w.woke++, cb(t)));
      const timer = window.setTimeout.bind(window);
      window.setTimeout = ((cb: (...a: unknown[]) => void, ms?: number, ...args: unknown[]) =>
        timer((...a: unknown[]) => (w.woke++, typeof cb === "function" && cb(...a)), ms, ...args)) as typeof window.setTimeout;
    });
    const busyTime = async () => (await cdp.send("Performance.getMetrics")).metrics.find((m) => m.name === "TaskDuration")!.value;
    const start = await busyTime();
    await new Promise((resolve) => setTimeout(resolve, 3000));
    const spent = (await busyTime()) - start;
    const woke = await run.page.evaluate(() => (window as unknown as { woke: number }).woke);
    const app = await appUse(run.app);
    console.log(`Three idle seconds: the window worked ${(spent * 1000).toFixed(1)} ms and woke ${woke} times; the app is waiting on ${JSON.stringify(app.busy)}`);
    expect(woke).toBe(0);
    expect(spent).toBeLessThan(0.05);
    // Only waiting (for the agents' socket, the files' changes, the connection to the window), never a timer.
    expect(app.busy.Timeout ?? 0).toBe(0);
    expect(app.busy.Immediate ?? 0).toBe(0);
  } finally {
    await session.stop();
    await run.app.close();
  }
});

// Send to Claude (roadmap Batch 2, item 1): an agent waits on Corillo, at no cost, until the person sends the document back.
test("nothing runs in Corillo or its window while an agent waits for the review", async () => {
  const run = await openText(DOC);
  await comment(run, "two people", "Make it three.");
  const { session } = await AgentSession.start(run.dataDir, "claude-code", { env: { CORILLO_WAIT_PROGRESS_MS: "250" } });
  try {
    await session.ok("read_document", { path: run.file });
    const wait = session.waitForReview();
    await expect(run.page.locator("#turn-status .turn-text")).toHaveText("Claude is waiting for your review");
    await run.page.waitForTimeout(1000);
    await run.page.evaluate(() => {
      const w = window as unknown as { woke: number };
      w.woke = 0;
      const frame = window.requestAnimationFrame.bind(window);
      window.requestAnimationFrame = (cb) => frame((t) => (w.woke++, cb(t)));
      const timer = window.setTimeout.bind(window);
      window.setTimeout = ((cb: (...a: unknown[]) => void, ms?: number, ...args: unknown[]) =>
        timer((...a: unknown[]) => (w.woke++, typeof cb === "function" && cb(...a)), ms, ...args)) as typeof window.setTimeout;
    });
    const progress = session.progress.length;
    await new Promise((resolve) => setTimeout(resolve, 2000));
    const woke = await run.page.evaluate(() => (window as unknown as { woke: number }).woke);
    const app = await appUse(run.app);
    console.log(`Two seconds of an agent waiting: the window woke ${woke} times; the app is waiting on ${JSON.stringify(app.busy)}; ${session.progress.length - progress} progress messages`);
    expect(wait.answered()).toBe(false);
    // The connector keeps the call alive on its own; Corillo only holds it.
    expect(session.progress.length).toBeGreaterThan(progress + 3);
    expect(woke).toBe(0);
    expect(app.busy.Timeout ?? 0).toBe(0);
    expect(app.busy.Immediate ?? 0).toBe(0);
  } finally {
    await session.stop();
    await run.app.close();
  }
});

test("many rounds of waiting, Send and finishing, and waits cut short, leave nothing behind in Corillo or its window", async () => {
  const run = await openText(DOC);
  const measure = await windowMeter(run.page);
  const { session } = await AgentSession.start(run.dataDir, "claude-code", { env: { CORILLO_WAIT_PROGRESS_MS: "200" } });
  try {
    await session.ok("read_document", { path: run.file });
    const round = async (i: number) => {
      // Waits cut short: cancelled, then one more that's held.
      const cut = session.waitForReview();
      await expect(run.page.locator("#turn-status .turn-text")).toHaveText(/waiting for your review/);
      session.cancel(cut.id);
      await expect(run.page.locator("#turn-status .turn-text")).not.toHaveText(/waiting for your review/);
      const wait = session.waitForReview();
      await expect(run.page.locator("#turn-status .turn-text")).toHaveText(/waiting for your review/);
      const sent = await run.page.evaluate(async (i) => {
        const id = document.querySelector(".doc:not([hidden])")!.getAttribute("data-doc-id")!;
        await window.corillo.addComment(id, `Say when, round ${i}.`, null, null);
        return window.corillo.sendToAgent(id);
      }, i);
      expect(sent).toEqual({ sent: true });
      const taken = await wait.text;
      const id = /\[([0-9a-f]+)\]/.exec(taken)![1];
      await session.ok("reply_to_comment", { path: run.file, comment_id: id, text: `Done, round ${i}.` });
      await session.ok("finish_editing", { path: run.file });
      const answered = card(run.page, `Done, round ${i}.`);
      await answered.getByRole("button", { name: "Resolve", exact: true }).click();
      await expect(answered).toBeHidden();
    };
    // A wait cut short: the agent stops listening, and the little while it had to wait again after its pass goes with it.
    const stopListening = async () => {
      const last = session.waitForReview();
      await expect(run.page.locator("#turn-status .turn-text")).toHaveText(/waiting for your review/);
      session.cancel(last.id);
      await expect(run.page.locator("#turn-status .turn-text")).not.toHaveText(/waiting for your review/);
      await run.page.waitForTimeout(300);
    };
    for (let i = 0; i < 3; i++) await round(i);
    await stopListening();
    const before = { ...(await measure()), ...(await appUse(run.app)) };
    for (let i = 3; i < 15; i++) await round(i);
    await stopListening();
    const after = { ...(await measure()), ...(await appUse(run.app)) };
    console.log(
      `After 12 rounds of waiting and Send: window ${before.nodes} → ${after.nodes} elements, app ${before.heapMB.toFixed(2)} → ${after.heapMB.toFixed(2)} MB, ${before.openFiles} → ${after.openFiles} open files, busy ${JSON.stringify(after.busy)}`,
    );
    expect(after.nodes).toBeLessThan(before.nodes + 100);
    expect(after.listeners).toBeLessThan(before.listeners + 20);
    expect(after.heapMB).toBeLessThan(before.heapMB + 1);
    expect(after.openFiles).toBeLessThanOrEqual(before.openFiles + 1);
    expect(after.busy).toEqual(before.busy);
  } finally {
    await session.stop();
    await run.app.close();
  }
});

test("diagrams with mistakes, drawn again and again while their code is edited, leave nothing in the window", async () => {
  const run = await openText("Intro.\n\n```mermaid\ngraph LR\n  A -->\n```\n\n```mermaid\ngraph LR\n  Ask --> Draft\n```\n");
  const measure = await windowMeter(run.page);
  const diagram = run.page.locator(".ProseMirror .diagram").first();
  await expect(diagram.locator(".diagram-error")).toContainText("can't be drawn", { timeout: 15000 });
  await expect(run.page.locator(".ProseMirror .diagram-picture svg")).toBeVisible({ timeout: 15000 });
  /** What the window holds outside the page: the window's own parts, and anything the diagram engine leaves. */
  const outside = () =>
    run.page.evaluate(() => ({
      children: document.body.children.length,
      strays: document.querySelectorAll('body > [id^="dcorillo-diagram"], body > [id^="corillo-diagram"]').length,
      statusBarBottom: Math.round(document.querySelector(".status-bar")!.getBoundingClientRect().bottom),
      windowHeight: window.innerHeight,
    }));
  const start = await outside();
  expect(start.strays).toBe(0);
  // Nothing under the status bar: it sits at the bottom of the window.
  expect(start.statusBarBottom).toBe(start.windowHeight);
  const before = await measure();
  // Ten more mistaken versions, each drawn after a pause in typing (300 ms): each round waits for that pause
  // itself and the drawing it starts, however late they come.
  const pauses = await watchTimers(run.page, 300);
  await diagram.hover();
  await diagram.getByRole("button", { name: "Edit diagram code" }).click();
  for (let i = 1; i <= 10; i++) {
    const ran = (await pauses.count()).ran;
    await run.page.keyboard.type(` N${i} -->`);
    await pauses.ranSince(ran);
    await expect(diagram).not.toHaveClass(/drawing/);
    await expect(diagram).toHaveClass(/has-error/);
  }
  const end = await outside();
  const after = await measure();
  console.log(`Window after 10 mistaken diagrams: ${before.nodes} → ${after.nodes} elements; body children ${start.children} → ${end.children}`);
  expect(end).toEqual(start);
  expect(after.nodes).toBeLessThan(before.nodes + 150);
  await run.app.close();
});

test("documents with pictures, opened and closed, and pictures looked at again, leave nothing behind in the window", async () => {
  const { makePng } = await import("../fixtures/make-png");
  const pictures = Array.from({ length: 8 }, (_, i) => `![Chart ${i}](pics/chart${i}.png)`).join("\n\n");
  const text = `# Charts\n\n${pictures}\n\n![[embedded.png]]\n`;
  const run = await openText("Start.\n");
  mkdirSync(join(run.folder, "pics"));
  for (let i = 0; i < 8; i++) writeFileSync(join(run.folder, "pics", `chart${i}.png`), makePng(40 + i, 30));
  writeFileSync(join(run.folder, "embedded.png"), makePng(20, 20));
  const file = join(run.folder, "charts.md");
  writeFileSync(file, text);
  const measure = await windowMeter(run.page);
  const round = async () => {
    await openFromFinder(run.app, file); // the window opens only what it was offered
    await expect(run.page.locator(".tab")).toHaveCount(2);
    await expect(run.page.locator(`${EDITOR} img.ob-embed-picture`)).toHaveCount(1);
    await expect.poll(() => run.page.locator(`${EDITOR} .picture img`).evaluateAll((imgs: HTMLImageElement[]) => imgs.filter((i) => i.naturalWidth).length)).toBe(8);
    // Looked at again (the window back in front), with one picture written again meanwhile.
    writeFileSync(join(run.folder, "pics", "chart0.png"), makePng(50, 30));
    await run.page.evaluate(() => window.dispatchEvent(new Event("focus")));
    await expect.poll(() => run.page.locator(`${EDITOR} .picture img`).first().evaluate((i: HTMLImageElement) => i.naturalWidth)).toBe(50);
    writeFileSync(join(run.folder, "pics", "chart0.png"), makePng(40, 30));
    await run.page.locator(".tab[aria-selected='true'] .tab-close").click();
    await expect(run.page.locator(".tab")).toHaveCount(1);
    await expect(run.page.locator(EDITOR)).toContainText("Start.");
  };
  await round();
  await run.page.waitForTimeout(300);
  const before = await measure();
  for (let i = 0; i < 8; i++) await round();
  await run.page.waitForTimeout(300);
  const after = await measure();
  console.log(`Window after 8 documents with pictures closed: ${before.nodes} → ${after.nodes} elements, ${before.listeners} → ${after.listeners} listeners`);
  expect(after.nodes).toBeLessThan(before.nodes + 100);
  expect(after.listeners).toBeLessThan(before.listeners + 20);
  await run.app.close();
});

// The other checks count what the window and the app hold in JavaScript, which
// misses pictures and memory given back late. This one reads the number the
// Mac goes by (Activity Monitor's Memory, from /usr/bin/footprint), with Corillo
// run as a person runs it: nothing attached, since an attached test tool keeps
// a copy of every picture the window loads. A few lines run inside the app do
// the work and the readings.
test("documents with pictures, opened and closed many times with nothing attached, leave the memory the Mac counts for Corillo where it was", async () => {
  test.setTimeout(90_000);
  const { makePng } = await import("../fixtures/make-png");
  const base = mkdtempSync(join(tmpdir(), "corillo-footprint-"));
  const dataDir = join(base, "data");
  const home = join(base, "home");
  mkdirSync(dataDir);
  mkdirSync(home);
  const start = join(base, "start.md");
  writeFileSync(start, "# Start\n\nNothing here yet.\n");
  const files: string[] = [];
  for (let d = 0; d < 3; d++) {
    const folder = join(base, `doc${d} images`);
    mkdirSync(folder);
    for (let i = 0; i < 6; i++) writeFileSync(join(folder, `shot${i}.png`), makePng(1200 + d * 10 + i, 900)); // about 4 MB each, drawn
    const pictures = Array.from({ length: 6 }, (_, i) => `Step ${i + 1}.\n\n![Shot ${i}](doc${d}%20images/shot${i}.png)`).join("\n\n");
    files.push(join(base, `doc${d}.md`));
    writeFileSync(files[d], `# Screens ${d}\n\n${pictures}\n`);
  }
  files.push(join(base, "notes.md"));
  writeFileSync(files[3], `# Notes\n\n${Array.from({ length: 200 }, (_, i) => `Paragraph ${i} of the notes, with a few words in it.`).join("\n\n")}\n`);
  const plan = { out: join(base, "readings.jsonl"), files, pictures: [6, 6, 6, 0], rounds: 5, quietMs: 12_000 };
  const driver = join(base, "driver.cjs");
  writeFileSync(
    driver,
    `try {
  const { app, BrowserWindow, Menu } = require("electron");
  const { execFileSync } = require("node:child_process");
  const fs = require("node:fs");
  const plan = JSON.parse(process.env.CORILLO_FOOTPRINT_PLAN);
  const write = (line) => fs.appendFileSync(plan.out, JSON.stringify(line) + "\\n");
  process.on("uncaughtException", (err) => { try { write({ stopped: String((err && err.stack) || err) }); } catch {} process.exit(1); });
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  const footprint = (pid) => {
    const out = execFileSync("/usr/bin/footprint", ["-f", "bytes", "--noCategories", String(pid)], { encoding: "utf8" });
    return Number(/phys_footprint: (\\d+) B/.exec(out)[1]) / 1048576;
  };
  app.whenReady().then(async () => {
    try {
      let w;
      for (let i = 0; !w || w.webContents.isLoading(); i++) {
        if (i > 300) throw new Error("no window");
        await sleep(100);
        w = BrowserWindow.getAllWindows()[0];
      }
      const ask = (js) => w.webContents.executeJavaScript(js);
      const until = async (js) => { for (let i = 0; i < 300; i++) { if (await ask(js).catch(() => false)) return; await sleep(100); } throw new Error("never: " + js); };
      const read = (label) => write({ label, window: footprint(w.webContents.getOSProcessId()), app: footprint(process.pid) });
      await until("!!document.querySelector('.ProseMirror')");
      // Started this way, Corillo also opens this file as a document.
      const open = await ask("document.querySelectorAll('.tab').length");
      const round = async () => {
        for (let i = 0; i < plan.files.length; i++) {
          app.emit("open-file", { preventDefault() {} }, plan.files[i]);
          await until("document.querySelectorAll('.tab').length === " + (open + i + 1));
          await until("[...document.querySelectorAll('.doc:not([hidden]) .page.editor .picture img')].filter((p) => p.naturalWidth > 0).length === " + plan.pictures[i]);
        }
        for (let left = plan.files.length; left > 0; left--) {
          Menu.getApplicationMenu().getMenuItemById("close-tab").click();
          await until("document.querySelectorAll('.tab').length === " + (open + left - 1));
        }
      };
      // One round first, so what is made once (the code that draws pictures, among others) is in both readings.
      await round();
      await sleep(plan.quietMs);
      read("start");
      for (let i = 0; i < plan.rounds; i++) await round();
      write({ pictures: await ask("document.querySelectorAll('.picture img').length") });
      await sleep(plan.quietMs);
      read("after");
    } catch (err) {
      write({ stopped: String((err && err.stack) || err) });
    }
    app.exit(0);
  });
} catch (err) {
  try { require("node:fs").appendFileSync(JSON.parse(process.env.CORILLO_FOOTPRINT_PLAN).out, JSON.stringify({ stopped: String(err) }) + "\\n"); } catch {}
  process.exit(1);
}
`,
  );
  // Never start Electron with code it can't read: it would put its own error window on the screen.
  execFileSync(process.execPath, ["--check", driver]);
  const electronPath = createRequire(import.meta.url)("electron") as string;
  const child = spawn(electronPath, [ONE_SCALE, "-r", driver, ".", start], {
    cwd: ROOT,
    env: throwawayStart({ ...process.env, CORILLO_USER_DATA: dataDir, CORILLO_HOME: home, CORILLO_FOOTPRINT_PLAN: JSON.stringify(plan) }),
    stdio: "ignore",
  });
  try {
    const ended = await Promise.race([
      new Promise<boolean>((resolve) => child.once("exit", () => resolve(true))),
      new Promise<boolean>((resolve) => setTimeout(() => resolve(false), 80_000)),
    ]);
    const said = readFileSync(plan.out, "utf8").trim().split("\n").map((line) => JSON.parse(line) as { label?: string; window?: number; app?: number; stopped?: string; pictures?: number });
    expect(said.find((line) => line.stopped)?.stopped).toBeUndefined();
    expect(ended).toBe(true);
    const at = (label: string) => said.find((line) => line.label === label)!;
    const [first, last] = [at("start"), at("after")];
    console.log(`The Mac's count after ${plan.rounds * files.length} more documents (18 pictures in each round of 4) opened and closed: window ${first.window!.toFixed(0)} → ${last.window!.toFixed(0)} MB, app ${first.app!.toFixed(0)} → ${last.app!.toFixed(0)} MB`);
    expect(said.find((line) => line.pictures !== undefined)?.pictures).toBe(0);
    // 18 pictures of about 4 MB each pass through the window every round. After the first, about 60 MB in the
    // window and 55 in the app; after the others, the window is back to 60 to 85 MB, depending on whether it has
    // given back what it no longer uses yet (2026-11-13). An attached test tool's copies took it past 150 in fewer rounds.
    expect(first.window).toBeGreaterThan(10);
    expect(first.app).toBeGreaterThan(10);
    expect(last.window).toBeLessThan(first.window! * 2);
    expect(last.app).toBeLessThan(first.app! * 2);
  } finally {
    if (child.exitCode === null) child.kill("SIGKILL");
    rmSync(base, { recursive: true, force: true });
  }
});

test("a long document typed in, in the Markdown view or the Formatted view, and then closed as the last tab, is let go of in the window's memory (B10-4)", async () => {
  test.setTimeout(120_000);
  const run = await openText("Start.\n");
  const cdp = await run.page.context().newCDPSession(run.page);
  await cdp.send("Performance.enable");
  const heapMB = async () => {
    await cdp.send("HeapProfiler.collectGarbage");
    await run.page.waitForTimeout(50);
    await cdp.send("HeapProfiler.collectGarbage");
    const { metrics } = await cdp.send("Performance.getMetrics");
    return (metrics.find((m) => m.name === "JSHeapUsedSize")?.value ?? 0) / 1048576;
  };
  /** Opened, typed in, and closed as the last tab: the keyboard goes into no other box afterwards, and no other document is typed in. */
  const typedAndClosed = async (name: string, text: string, view: "Markdown" | "Formatted") => {
    const file = join(run.folder, name);
    writeFileSync(file, text);
    await openFromFinder(run.app, file);
    await expect(run.page.locator(EDITOR)).toBeVisible();
    if (view === "Markdown") {
      await run.page.getByRole("button", { name: "Markdown" }).click();
      const source = run.page.locator(".doc:not([hidden]) textarea.source");
      await expect(source).toBeVisible();
      await source.evaluate((a: HTMLTextAreaElement) => {
        a.focus();
        a.setSelectionRange(0, 0);
      });
    } else {
      await run.page.locator(`${EDITOR} .ProseMirror`).focus();
      await run.page.keyboard.press("Meta+ArrowUp");
    }
    await run.page.keyboard.type("Typed. ");
    await expect.poll(() => readFileSync(file, "utf8").slice(0, 200).includes("Typed. "), { timeout: 20_000 }).toBe(true);
    await clickMenu(run.app, "close-tab");
    await expect(run.page.locator(".recent-card").first()).toBeVisible();
  };
  const long = Array.from({ length: 8 }, bigDocument).join("\n\n");
  await clickMenu(run.app, "close-tab");
  await expect(run.page.locator(".recent-card").first()).toBeVisible();
  // Once with a short one first, so what the Markdown view itself keeps is there before measuring.
  await typedAndClosed("short.md", "The short one.\n", "Markdown");
  const before = await heapMB();
  await typedAndClosed("long.md", long, "Markdown");
  await run.page.waitForTimeout(300);
  const afterMarkdown = await heapMB();
  await typedAndClosed("long 2.md", long, "Formatted");
  await run.page.waitForTimeout(300);
  const afterFormatted = await heapMB();
  console.log(`Window memory after a long document was typed in and closed: ${before.toFixed(1)} → ${afterMarkdown.toFixed(1)} MB (Markdown view), ${afterFormatted.toFixed(1)} MB (Formatted view)`);
  // Before, the last one typed in was kept whole (about 55 MB here) until another document was typed in.
  expect(afterMarkdown).toBeLessThan(before + 4);
  expect(afterFormatted).toBeLessThan(before + 4);
  await run.app.close();
});

test("a long document searched with Find and then closed is let go of in the window's memory", async () => {
  test.setTimeout(120_000);
  const { bigDocument } = await import("../fixtures/big-document");
  const run = await openText("Start.\n");
  const cdp = await run.page.context().newCDPSession(run.page);
  await cdp.send("Performance.enable");
  const heapMB = async () => {
    await cdp.send("HeapProfiler.collectGarbage");
    await run.page.waitForTimeout(50);
    await cdp.send("HeapProfiler.collectGarbage");
    const { metrics } = await cdp.send("Performance.getMetrics");
    return (metrics.find((m) => m.name === "JSHeapUsedSize")?.value ?? 0) / 1048576;
  };
  const searchedAndClosed = async (name: string, text: string) => {
    await openAlso(run, name, text);
    await expect(run.page.locator(".tab")).toHaveCount(2);
    await run.page.keyboard.press("Meta+f");
    // Under a full run's load, letters typed before Find's box has the keyboard were lost.
    await expect(run.page.getByRole("textbox", { name: "Find" })).toBeFocused();
    await run.page.keyboard.type("the");
    await expect(run.page.locator(".find-count")).toContainText("of", { timeout: 20_000 });
    await run.page.keyboard.press("Escape");
    await run.page.locator(".tab[aria-selected='true'] .tab-close").click();
    await expect(run.page.locator(".tab")).toHaveCount(1);
  };
  // Once with a short one first, so what the bar itself keeps is there before measuring.
  await searchedAndClosed("short.md", "Find the words in the short one.\n");
  const before = await heapMB();
  await searchedAndClosed("long.md", Array.from({ length: 8 }, bigDocument).join("\n\n"));
  await run.page.waitForTimeout(300);
  const after = await heapMB();
  console.log(`Window memory after a long document was searched and closed: ${before.toFixed(1)} → ${after.toFixed(1)} MB`);
  expect(after).toBeLessThan(before + 4);
  await run.app.close();
});

test("documents coming back again and again while Corillo is behind, each looked at and closed, leave no timers, listeners or count behind, and never reach the speakers", async () => {
  const run = await openText("Start.\n");
  const { page, app } = run;
  const measure = await windowMeter(page);
  // Nothing in a test may reach the speakers: a stand-in counts any try.
  await page.evaluate(() => {
    const w = window as unknown as { aloud: number; AudioContext: unknown };
    w.aloud = 0;
    w.AudioContext = class {
      constructor() {
        w.aloud++;
        throw new Error("No sound in tests.");
      }
    };
  });
  await app.evaluate(({ app: a }) => {
    const g = globalThis as unknown as { calls: number };
    g.calls = 0;
    a.on("corillo-coqui" as never, (() => g.calls++) as never);
  });
  const dockBadge = () => app.evaluate(({ app: a }) => a.dock?.getBadge() ?? "");
  const listening = () => app.evaluate(({ app: a }) => ["did-become-active", "did-resign-active"].map((e) => a.listenerCount(e as never)));
  const { session } = await AgentSession.start(run.dataDir, "claude-code");
  // The same document each time, so what Corillo rightly keeps for a new one doesn't blur the measure.
  const file = join(run.folder, "back.md");
  writeFileSync(file, DOC);
  const round = async () => {
    await openFromFinder(app, file);
    await expect(page.locator(".tab")).toHaveCount(2);
    await page.locator(".tab").first().click(); // the first document in front, so this one comes back behind it
    await session.ok("take_document", { path: file });
    await session.ok("finish_editing", { path: file });
    await expect.poll(dockBadge).toBe("1");
    await page.waitForTimeout(900); // past the moment Corillo waits before a call (one call covers the next few seconds)
    // Looked at, then closed.
    await page.locator('.tab[title$="/back.md"]').click();
    await expect.poll(dockBadge).toBe("");
    await page.locator(".tab[aria-selected='true'] .tab-close").click();
    await expect(page.locator(".tab")).toHaveCount(1);
  };
  try {
    await round();
    await page.waitForTimeout(1500);
    const before = { ...(await measure()), ...(await appUse(app)), listening: await listening() };
    for (let i = 1; i <= 8; i++) await round();
    await page.waitForTimeout(1500);
    const after = { ...(await measure()), ...(await appUse(app)), listening: await listening() };
    const calls = await app.evaluate(() => (globalThis as unknown as { calls: number }).calls);
    console.log(
      `After 8 documents back, looked at and closed: window ${before.nodes} → ${after.nodes} elements, ${before.listeners} → ${after.listeners} listeners; app ${before.heapMB.toFixed(2)} → ${after.heapMB.toFixed(2)} MB, busy ${JSON.stringify(after.busy)}; ${calls} calls`,
    );
    expect(after.busy).toEqual(before.busy);
    expect(after.listening).toEqual(before.listening);
    expect(after.nodes).toBeLessThan(before.nodes + 150);
    expect(after.listeners).toBeLessThan(before.listeners + 20);
    expect(after.heapMB).toBeLessThan(before.heapMB + 1);
    expect(await dockBadge()).toBe("");
    expect(calls).toBeGreaterThan(0);
    expect(await page.evaluate(() => (window as unknown as { aloud: number }).aloud)).toBe(0);
  } finally {
    await session.stop();
    await app.close();
  }
});

// Roadmap Batch 9, item 13: a small coquí hops on the tab of each document an agent works on, from one
// timer for the whole window that runs only while a frog is on the page.
test("the coquí hopping on the tabs of documents agents work on, over many passes, with a tab closed mid-pass and Reduce Motion switched on and off, leaves no timer, hop, element or listener behind, and nothing runs once no agent works", async () => {
  const run = await openText(DOC);
  const { page } = run;
  const measure = await windowMeter(page);
  const second = await openAlso(run, "second.md", "# Second\n\nA few words to work on.\n");
  await expect(page.locator(".tab")).toHaveCount(2);
  // Count the hops as they start.
  await page.evaluate(() => {
    const w = window as unknown as { hopsSeen: number };
    w.hopsSeen = 0;
    const animate = Element.prototype.animate;
    Element.prototype.animate = function (this: Element, ...args: Parameters<Element["animate"]>) {
      if (this.classList.contains("coqui-frog")) w.hopsSeen++;
      return animate.apply(this, args);
    };
  });
  const hopsSeen = () => page.evaluate(() => (window as unknown as { hopsSeen: number }).hopsSeen);
  const frogs = () => page.locator(".coqui-frog").count();
  const closing = join(run.folder, "closing.md");
  writeFileSync(closing, "# Closing\n\nClosed while the agent has it.\n");
  const { session } = await AgentSession.start(run.dataDir, "claude-code");
  const round = async (i: number) => {
    // Two documents at once, the one in front and the one behind: a frog on each tab.
    await session.ok("take_document", { path: run.file });
    await session.ok("take_document", { path: second });
    await expect(page.locator(".tab .coqui-frog")).toHaveCount(2);
    const seen = await hopsSeen();
    await expect.poll(hopsSeen).toBeGreaterThan(seen);
    if (i % 2) {
      // Reduce Motion on mid-pass, then off again.
      await page.emulateMedia({ reducedMotion: "reduce" });
      await page.waitForTimeout(100);
      await page.emulateMedia({ reducedMotion: "no-preference" });
    }
    await session.ok("edit_document", { path: second, edits: [{ find: "A few words", replace: `A few words (${i})` }] });
    await session.ok("finish_editing", { path: run.file });
    await session.ok("finish_editing", { path: second });
    // A third document, closed while the agent has it: its frog goes with its tab.
    await openFromFinder(run.app, closing);
    await expect(page.locator(".tab")).toHaveCount(3);
    await session.ok("take_document", { path: closing });
    await expect(page.locator('.tab[title$="/closing.md"] .coqui-frog')).toBeVisible();
    await page.locator('.tab[title$="/closing.md"] .tab-close').click();
    await expect(page.locator(".tab")).toHaveCount(2);
    await expect.poll(frogs).toBe(0);
  };
  try {
    await round(0);
    await page.waitForTimeout(1500);
    const before = await measure();
    for (let i = 1; i <= 6; i++) await round(i);
    await page.waitForTimeout(1500);
    const after = await measure();
    // Nothing is moving, and from here nothing wakes the window: no timer, no frame, no hop.
    expect(await frogs()).toBe(0);
    expect(await page.evaluate(() => document.getAnimations().length)).toBe(0);
    const hopsThen = await hopsSeen();
    await page.evaluate(() => {
      const w = window as unknown as { woke: number };
      w.woke = 0;
      const frame = window.requestAnimationFrame.bind(window);
      window.requestAnimationFrame = (cb) => frame((t) => (w.woke++, cb(t)));
      const timer = window.setTimeout.bind(window);
      window.setTimeout = ((cb: (...a: unknown[]) => void, ms?: number, ...args: unknown[]) =>
        timer((...a: unknown[]) => (w.woke++, typeof cb === "function" && cb(...a)), ms, ...args)) as typeof window.setTimeout;
    });
    await page.waitForTimeout(5000);
    const woke = await page.evaluate(() => (window as unknown as { woke: number }).woke);
    console.log(
      `After 6 rounds of agents' passes with the coquí hopping: window ${before.nodes} → ${after.nodes} elements, ${before.listeners} → ${after.listeners} listeners, ${before.windowMB.toFixed(2)} → ${after.windowMB.toFixed(2)} MB; then the window woke ${woke} times in 5 idle seconds`,
    );
    expect(woke).toBe(0);
    expect(await hopsSeen()).toBe(hopsThen);
    expect(after.nodes).toBeLessThan(before.nodes + 100);
    expect(after.listeners).toBeLessThan(before.listeners + 20);
    expect(after.windowMB).toBeLessThan(before.windowMB + 2);
  } finally {
    await session.stop();
    await run.app.close();
  }
});

// Roadmap Batch 3, item 2: an agent's options are buttons on its reply's card. Their listeners go when the card is
// drawn again (the choice recorded, the comment resolved) and when the document closes.
test("agents' options, offered, chosen and resolved many times, and on documents closed, leave nothing behind in the window", async () => {
  const run = await openText(DOC);
  const measure = await windowMeter(run.page);
  const { session } = await AgentSession.start(run.dataDir);
  /** Claude adds a round number and offers to take it out, or to keep it in other words; the person takes it out. */
  const offerAndChoose = async (file: string, i: number) => {
    const added = await run.page.evaluate(async (i) => {
      const id = document.querySelector(".doc:not([hidden])")!.getAttribute("data-doc-id")!;
      return window.corillo.addComment(id, `Say when, round ${i}.`, null, null);
    }, i);
    expect(added.ok).toBe(true);
    const taken = await session.ok("take_document", { path: file });
    const id = /\[([0-9a-f]+)\]/.exec(taken)![1];
    const said = `moves in June (round ${i})`;
    await session.ok("edit_document", { path: file, edits: [{ find: "moves in June", replace: said }], comment_ids: [id] });
    const options = [
      { label: "Take it out", edits: [{ find: said, replace: "moves in June" }] },
      { label: "Say it twice", edits: [{ find: said, replace: `${said} ${said}` }] },
    ];
    await session.ok("reply_to_comment", { path: file, comment_id: id, text: `Round ${i}: added. Or:`, options });
    await session.ok("finish_editing", { path: file });
    const answered = card(run.page, `Round ${i}: added.`);
    await answered.locator(".comment-option", { hasText: "Take it out" }).click();
    await expect(answered.locator(".comment-option-chosen")).toHaveText("You chose: Take it out");
    return answered;
  };
  try {
    const round = async (i: number) => {
      const answered = await offerAndChoose(run.file, i);
      await answered.getByRole("button", { name: "Resolve", exact: true }).click();
      await expect(answered).toBeHidden();
    };
    /** How many texts the window keeps read as words for a document (choosing an option reads them). */
    const wordsKept = (id: string) => run.page.evaluate((id) => (window as unknown as { corilloTests: { wordsKept(id: string): number } }).corilloTests.wordsKept(id), id);
    const closed = async (i: number) => {
      const file = await openAlso(run, `options ${i}.md`, DOC);
      await expect(run.page.locator(".tab")).toHaveCount(2);
      await offerAndChoose(file, i);
      const id = (await run.page.locator(".doc:not([hidden])").getAttribute("data-doc-id"))!;
      expect(await wordsKept(id)).toBeGreaterThan(0);
      await run.page.locator(".tab[aria-selected='true'] .tab-close").click();
      await expect(run.page.locator(".tab")).toHaveCount(1);
      // Closed, the window lets go of them (code review of Batch 16).
      expect(await wordsKept(id)).toBe(0);
    };
    for (let i = 0; i < 3; i++) await round(i);
    await closed(0);
    await run.page.waitForTimeout(300);
    const before = await measure();
    for (let i = 3; i < 13; i++) await round(i);
    for (let i = 1; i < 6; i++) await closed(i);
    await run.page.waitForTimeout(300);
    const after = await measure();
    console.log(`After 10 rounds of options and 5 documents with options closed: window ${before.nodes} → ${after.nodes} elements, ${before.listeners} → ${after.listeners} listeners`);
    expect(after.nodes).toBeLessThan(before.nodes + 100);
    expect(after.listeners).toBeLessThan(before.listeners + 20);
  } finally {
    await session.stop();
    await run.app.close();
  }
});

// The outline (roadmap Batch 4, item 1): on, it follows the document in front; closed or turned off, it lets go.
test("the outline, on through documents opened, scrolled, changed by an agent and closed, and turned off and on from the menu and its button, keeps nothing in the window, and never wakes while idle", async () => {
  test.setTimeout(120_000);
  const run = await openText("Start.\n");
  await run.page.setViewportSize({ width: 1200, height: 800 });
  const measure = await windowMeter(run.page);
  await clickMenu(run.app, "view-outline");
  const pane = ".doc:not([hidden]) .outline-pane";
  const part = (n: number) => `## Part ${n}\n\n${"Words in this part of the document, enough to scroll a while. ".repeat(20)}\n\n`;
  const text = (i: number) => `# Document ${i}\n\n${Array.from({ length: 30 }, (_, n) => part(n + 1)).join("")}`;
  const { session } = await AgentSession.start(run.dataDir);
  try {
    const round = async (i: number) => {
      const file = await openAlso(run, `outline ${i}.md`, text(i));
      await expect(run.page.locator(".tab")).toHaveCount(2);
      await expect(run.page.locator(`${pane} .outline-row`)).toHaveCount(31);
      await run.page.locator(".doc:not([hidden]) .canvas.with-side").evaluate((s) => (s.scrollTop = s.scrollHeight));
      await expect(run.page.locator("#outline-section")).toHaveText("Part 30");
      await run.page.locator(`${pane} .outline-go`).nth(3).click();
      await run.page.keyboard.type("New ");
      await expect(run.page.locator(`${pane} .outline-words`).nth(3)).toHaveText("New Part 3");
      await session.ok("take_document", { path: file });
      await session.ok("edit_document", { path: file, edits: [{ find: "## Part 7\n", replace: "## Part 7\n\nAdded by the agent.\n" }] });
      await session.ok("finish_editing", { path: file });
      await expect(run.page.locator(`${pane} .outline-dot:not([hidden])`)).toHaveCount(1);
      if (i % 2) {
        await clickMenu(run.app, "view-outline");
        await expect(run.page.locator(".outline-pane")).toHaveCount(0);
        await run.page.getByRole("button", { name: "Outline", exact: true }).click(); // the toolbar's button (roadmap Batch 9, item 10)
        await expect(run.page.locator(pane)).toBeVisible();
      }
      await run.page.locator(".tab[aria-selected='true'] .tab-close").click();
      await expect(run.page.locator(".tab")).toHaveCount(1);
    };
    await round(0);
    await run.page.waitForTimeout(300);
    const before = await measure();
    for (let i = 1; i <= 6; i++) await round(i);
    await run.page.waitForTimeout(300);
    const after = await measure();
    console.log(`After 6 documents with the outline on, closed: window ${before.nodes} → ${after.nodes} elements, ${before.listeners} → ${after.listeners} listeners`);
    expect(after.nodes).toBeLessThan(before.nodes + 100);
    expect(after.listeners).toBeLessThan(before.listeners + 20);

    // Then nothing: with the outline on, the window does no work and asks for no frame or timer.
    await run.page.waitForTimeout(1500);
    await run.page.evaluate(() => {
      const w = window as unknown as { woke: number };
      w.woke = 0;
      const frame = window.requestAnimationFrame.bind(window);
      window.requestAnimationFrame = (cb) => frame((t) => (w.woke++, cb(t)));
      const timer = window.setTimeout.bind(window);
      window.setTimeout = ((cb: (...a: unknown[]) => void, ms?: number, ...args: unknown[]) =>
        timer((...a: unknown[]) => (w.woke++, typeof cb === "function" && cb(...a)), ms, ...args)) as typeof window.setTimeout;
    });
    await new Promise((resolve) => setTimeout(resolve, 2000));
    expect(await run.page.evaluate(() => (window as unknown as { woke: number }).woke)).toBe(0);
  } finally {
    await session.stop();
    await run.app.close();
  }
});

// Review of Batch 4, B4-R05: with the outline on, each background document
// an agent changed was remembered by its id until the outline was turned off,
// even once its tab was closed. Agents working on background documents all
// day made that list grow with use.
test("the outline keeps nothing for background documents an agent changed and that were closed without coming to the front", async () => {
  test.setTimeout(120_000);
  const run = await openText("# Start\n\nWords.\n");
  await run.page.setViewportSize({ width: 1200, height: 800 });
  await clickMenu(run.app, "view-outline");
  await expect(run.page.locator(".doc:not([hidden]) .outline-pane")).toBeVisible();
  const { session } = await AgentSession.start(run.dataDir);
  try {
    const files: string[] = [];
    for (let i = 1; i <= 6; i++) files.push(await openAlso(run, `background ${i}.md`, `# Part ${i}\n\nWords for part ${i}.\n`));
    await expect(run.page.locator(".tab")).toHaveCount(7);
    // The first document in front; the others stay behind it from here on.
    await run.page.locator(".tab").first().click();
    await expect(run.page.locator(".tab").first()).toHaveAttribute("aria-selected", "true");
    const ids = await run.page.locator(".tabs .tab").evaluateAll((tabs) => tabs.slice(1).map((t) => (t as HTMLElement).dataset.docId!));
    expect(new Set(ids).size).toBe(6);
    for (const [i, file] of files.entries()) {
      await session.ok("take_document", { path: file });
      await session.ok("edit_document", { path: file, edits: [{ find: `Words for part ${i + 1}.`, replace: `Words for part ${i + 1}, changed by the agent.` }] });
      await session.ok("finish_editing", { path: file });
    }
    // The last one brought to the front shows the agent's change by its dot; the other five never come to the front.
    await run.page.locator(".tab").last().click();
    await expect(run.page.locator(".doc:not([hidden]) .outline-dot:not([hidden])")).toHaveCount(1);
    await run.page.locator(".tab").first().click();
    for (let i = 0; i < 6; i++) await run.page.locator(".tab").nth(1).locator(".tab-close").click();
    await expect(run.page.locator(".tab")).toHaveCount(1);
    await expect(run.page.locator(".tab").first()).toHaveAttribute("aria-selected", "true");
    await run.page.waitForTimeout(300);
    // No list or table in the window still holds a closed document's id.
    const cdp = await run.page.context().newCDPSession(run.page);
    await cdp.send("HeapProfiler.collectGarbage");
    const holding = async (kind: "Set" | "Map") => {
      const proto = await cdp.send("Runtime.evaluate", { expression: `${kind}.prototype` });
      const found = await cdp.send("Runtime.queryObjects", { prototypeObjectId: proto.result.objectId! });
      const { result } = await cdp.send("Runtime.callFunctionOn", {
        objectId: found.objects.objectId!,
        functionDeclaration: "function (ids) { return this.filter((s) => ids.some((id) => s.has(id))).map((s) => [...s.keys()].slice(0, 3).join(', ')); }",
        arguments: [{ value: ids }],
        returnByValue: true,
      });
      return result.value as string[];
    };
    expect(await holding("Set")).toEqual([]);
    expect(await holding("Map")).toEqual([]);
    await cdp.detach();
  } finally {
    await session.stop();
    await run.app.close();
  }
});

// Roadmap Batch 6, item 3: one long session across what Batches 1 to 4 added.
// Each feature has its own check above; this one runs them together, the way
// a day of work does, and looks at everything the session holds.

/**
 * Every Map and Set in a JavaScript world (Corillo's main process, or its
 * window) that holds any of `words` (in a key, a member, a value, or a
 * value's field): how many of them, its size, what its values look like, and
 * one of them. Each gets a number the first time it's seen, so looks compare.
 */
const HOLDING = `function (words) {
  const g = globalThis;
  g.corilloHolders ??= { ids: new WeakMap(), next: 1 };
  const hit = (v) => typeof v === "string" && words.some((w) => v.includes(w));
  const deep = (v) => hit(v) || (v !== null && typeof v === "object" && !Array.isArray(v) && Object.values(v).some(hit));
  const shapeOf = (v) => v === null ? "null" : Array.isArray(v) ? "[" + (v.length ? shapeOf(v[0]) : "") + "]" : typeof v === "object" ? "{" + Object.keys(v).sort().join(",") + "}" : typeof v;
  return this.map((m) => {
    let held = 0;
    let shape = "";
    let sample = "";
    for (const [k, v] of m instanceof Map ? m : [...m].map((x) => [x, x])) {
      if (!hit(k) && !deep(v)) continue;
      if (!held++) [shape, sample] = [m instanceof Map ? shapeOf(v) : "member", String(k).slice(-48)];
    }
    if (!held) return null;
    let id = g.corilloHolders.ids.get(m);
    if (!id) g.corilloHolders.ids.set(m, (id = g.corilloHolders.next++));
    return { id, kind: m instanceof Map ? "Map" : "Set", size: m.size, held, shape, sample };
  }).filter(Boolean);
}`;

interface Holder {
  id: number;
  kind: string;
  size: number;
  held: number;
  /** What its values look like: "string", "[number]", "{sections}", "member" for a Set's. */
  shape: string;
  sample: string;
}

/** The Maps and Sets in Corillo's main process holding any of these words. */
function mainHolders(app: ElectronApplication, words: string[]): Promise<Holder[]> {
  return app.evaluate(async (_electron, { words, holding }) => {
    const { Session } = process.getBuiltinModule("node:inspector") as typeof import("node:inspector");
    const session = new Session();
    session.connect();
    const post = (method: string, params?: object) =>
      new Promise<Record<string, unknown>>((resolve, reject) => session.post(method, params, (err, result) => (err ? reject(err) : resolve(result as Record<string, unknown>))));
    try {
      await post("HeapProfiler.collectGarbage");
      const out: unknown[] = [];
      for (const kind of ["Map", "Set"]) {
        const proto = (await post("Runtime.evaluate", { expression: `${kind}.prototype` })) as { result: { objectId: string } };
        const found = (await post("Runtime.queryObjects", { prototypeObjectId: proto.result.objectId })) as { objects: { objectId: string } };
        const r = (await post("Runtime.callFunctionOn", { objectId: found.objects.objectId, functionDeclaration: holding, arguments: [{ value: words }], returnByValue: true })) as { result: { value: unknown[] } };
        out.push(...r.result.value);
      }
      return out;
    } finally {
      session.disconnect();
    }
  }, { words, holding: HOLDING }) as Promise<Holder[]>;
}

/** The Maps and Sets in the window holding any of these words. */
async function windowHolders(page: Page, words: string[]): Promise<Holder[]> {
  const cdp = await page.context().newCDPSession(page);
  try {
    await cdp.send("HeapProfiler.collectGarbage");
    const out: Holder[] = [];
    for (const kind of ["Map", "Set"]) {
      const proto = await cdp.send("Runtime.evaluate", { expression: `${kind}.prototype` });
      const found = await cdp.send("Runtime.queryObjects", { prototypeObjectId: proto.result.objectId! });
      const { result } = await cdp.send("Runtime.callFunctionOn", { objectId: found.objects.objectId!, functionDeclaration: HOLDING, arguments: [{ value: words }], returnByValue: true });
      out.push(...(result.value as Holder[]));
    }
    return out;
  } finally {
    await cdp.detach();
  }
}

/** Listeners on what lives as long as Corillo: the app, its messages from the window, the window and its page. */
function mainListeners(app: ElectronApplication): Promise<number> {
  return app.evaluate(({ app: a, ipcMain, BrowserWindow }) => {
    const count = (e: NodeJS.EventEmitter) => e.eventNames().reduce((n, name) => n + e.listenerCount(name), 0);
    const win = BrowserWindow.getAllWindows()[0];
    return count(a) + count(ipcMain) + count(win) + count(win.webContents);
  });
}

/** The window's JavaScript memory, in MB, after clearing out what's no longer used. */
async function windowHeapMB(page: Page): Promise<number> {
  const cdp = await page.context().newCDPSession(page);
  try {
    await cdp.send("Performance.enable");
    await cdp.send("HeapProfiler.collectGarbage");
    await page.waitForTimeout(50);
    await cdp.send("HeapProfiler.collectGarbage");
    const { metrics } = await cdp.send("Performance.getMetrics");
    return (metrics.find((m) => m.name === "JSHeapUsedSize")?.value ?? 0) / 1048576;
  } finally {
    await cdp.detach();
  }
}

test("a long session: fifty documents opened and closed with the outline on, Find into the comments, History, an agent's passes, Show changes, options and notes along the way, keeps nothing of them in the window or in Corillo", async () => {
  test.setTimeout(600_000);
  const run = await openText("# Start\n\nWords to start with.\n");
  const { page, app } = run;
  await page.setViewportSize({ width: 1200, height: 800 });
  await clickMenu(app, "view-outline");
  const outline = ".doc:not([hidden]) .outline-pane";
  await expect(page.locator(outline)).toBeVisible();
  const measure = await windowMeter(page);
  const findField = page.getByRole("textbox", { name: "Find", exact: true });
  const banner = page.locator(".doc:not([hidden]) .version-banner");
  const text = (i: number) =>
    `# Document ${i}\n\n## Goals\n\nWe should hire two people this spring.\n\n## Budget\n\nThe budget is tight but workable.\n\n## Office\n\nThe office moves in June.\n`;
  const files: string[] = [];
  const tabIds: string[] = [];
  const { session } = await AgentSession.start(run.dataDir);
  let sessionOn = true;
  /** One document: opened, commented on, a heading gone to in the outline, and some of Find, History, an agent's pass, Show changes, an option and a note; then closed. */
  const visit = async (i: number) => {
    const file = await openAlso(run, `session ${i}.md`, text(i));
    files.push(file);
    await expect(page.locator(".tab")).toHaveCount(2);
    await expect(page.locator(`${outline} .outline-row`)).toHaveCount(4);
    tabIds.push((await page.locator(".doc:not([hidden])").getAttribute("data-doc-id"))!);
    await comment(run, "two people", `Is two enough for visit ${i}?`);
    const budget = page.locator(`${outline} .outline-row`, { has: page.locator(".outline-words", { hasText: /^Budget$/ }) });
    await budget.locator(".outline-go").click();
    await expect(budget).toHaveClass(/in-sight/);
    if (i % 2 === 0) {
      // Find a word only the comment has, and go into its card.
      await page.keyboard.press("Meta+F");
      await findField.fill("enough");
      await expect(page.locator(".find-count")).toContainText("1 in comments");
      await findField.press("Enter");
      await expect(card(page, `Is two enough for visit ${i}?`)).toHaveClass(/active/);
      await findField.press("Escape");
    }
    if (i % 3 === 0) {
      await page.getByRole("button", { name: "History", exact: true }).click();
      await expect(page.locator(".doc:not([hidden]) .history-panel .history-item").first()).toBeVisible();
      await page.getByRole("button", { name: "Close history" }).click();
      await expect(page.locator(".doc:not([hidden]) .history-panel")).toBeHidden();
    }
    if (i % 2 === 1) {
      // An agent's pass on every other document (25 in all, past the 20 a session keeps of its rounds): an edit, a reply with options, a note.
      const taken = await session.ok("take_document", { path: file });
      const id = /\[([0-9a-f]+)\]/.exec(taken)![1];
      await session.ok("edit_document", { path: file, edits: [{ find: "moves in June", replace: "moves in July" }], comment_ids: [id] });
      const options = [
        { label: "Make it three", edits: [{ find: "tight but workable", replace: "tight but workable for three" }] },
        { label: "Make it four", edits: [{ find: "tight but workable", replace: "tight but workable for four" }] },
      ];
      await session.ok("reply_to_comment", { path: file, comment_id: id, text: `Two is enough for visit ${i}. Or:`, options });
      await session.ok("finish_editing", { path: file, note: `Visit ${i}: I also moved the office to July.` });
      // Show changes, stepped, then hidden.
      await clickMenu(app, "view-changes");
      await expect(banner).toContainText("since you handed it over");
      await banner.getByRole("button", { name: "Next change" }).click();
      await clickMenu(app, "view-changes");
      await expect(banner).toBeHidden();
      // An option chosen, the note put away.
      const answered = card(page, `Two is enough for visit ${i}.`);
      await answered.locator(".comment-option", { hasText: "Make it three" }).click();
      await expect(answered.locator(".comment-option-chosen")).toHaveText("You chose: Make it three");
      const note = card(page, `Visit ${i}: I also moved the office`);
      await note.getByRole("button", { name: "Done", exact: true }).click();
      await expect(note).toBeHidden();
    }
    await page.locator(".tab[aria-selected='true'] .tab-close").click();
    await expect(page.locator(".tab")).toHaveCount(1);
  };
  /** Everything the session holds, and what still holds the documents closed so far. */
  const known = () => JSON.parse(readFileSync(join(run.dataDir, "documents.json"), "utf8")) as Record<string, { path: string }>;
  /** What names the documents closed so far: their tabs' ids, their folders in Corillo's data, their paths. */
  const closedWords = () => {
    const closed = new Set(files);
    return [...tabIds, ...Object.entries(known()).filter(([, e]) => closed.has(e.path)).map(([id]) => id), ...files];
  };
  const holdings = async () => {
    await page.waitForTimeout(500);
    const index = known();
    const words = closedWords();
    return {
      ...(await measure()),
      windowMB: await windowHeapMB(page),
      ...(await appUse(app)),
      listening: await mainListeners(app),
      main: await mainHolders(app, words),
      byTab: await mainHolders(app, tabIds),
      window: await windowHolders(page, words),
      known: Object.keys(index).length,
    };
  };
  /**
   * What may hold the documents closed so far in Corillo's main process:
   * Corillo's list of every document it knows (as on disk) and the set of
   * their records it has checked, both the size of that list; History's
   * stories of what versions changed (kept up to 2,000, Batch 4); and the
   * documents an agent session has been on (kept until it ends). Anything
   * else holds at most the 20 a session keeps of its rounds.
   */
  const ROSTER = /^\[\{.*\bsessionId\b.*\}\]$/;
  const unbounded = (h: Awaited<ReturnType<typeof holdings>>) =>
    h.main.filter((x) => x.size !== h.known && x.shape !== "{sections}" && !ROSTER.test(x.shape) && x.held > 20);
  try {
    for (let i = 1; i <= 10; i++) await visit(i);
    const before = await holdings();
    for (let i = 11; i <= 30; i++) await visit(i);
    const middle = await holdings();
    for (let i = 31; i <= 50; i++) await visit(i);
    const after = await holdings();
    await session.stop();
    sessionOn = false;
    const agentKept = (holders: Holder[]) => holders.filter((x) => ROSTER.test(x.shape) || x.shape === "[number]");
    await expect.poll(async () => agentKept(await mainHolders(app, closedWords())).length).toBe(0);
    const ended = await holdings();
    const held = (h: typeof after) => h.main.map((x) => `${x.held} in a ${x.kind} of ${x.shape}`).join(", ");
    console.log(
      [
        `A long session, after documents 10, 30 and 50 were closed:`,
        `window ${before.nodes} → ${middle.nodes} → ${after.nodes} elements, ${before.listeners} → ${middle.listeners} → ${after.listeners} listeners, ${before.windowMB.toFixed(2)} → ${middle.windowMB.toFixed(2)} → ${after.windowMB.toFixed(2)} MB;`,
        `app ${before.heapMB.toFixed(2)} → ${middle.heapMB.toFixed(2)} → ${after.heapMB.toFixed(2)} MB, ${before.openFiles} → ${after.openFiles} open files, ${before.listening} → ${after.listening} listeners, busy ${JSON.stringify(after.busy)};`,
        `closed documents held in the app: ${held(after)}; once the agent left: ${held(ended)}`,
      ].join("\n"),
    );
    // The window: back down once its first documents set up what stays, and nothing in it holds a closed document.
    expect(after.nodes).toBeLessThan(middle.nodes + 100);
    expect(after.listeners).toBeLessThan(middle.listeners + 20);
    expect(after.nodes).toBeLessThan(before.nodes + 150); // the start screen's recent list grows to 15 cards
    expect(after.windowMB).toBeLessThan(middle.windowMB + 1); // under 50 KB a document: a page alone is far more
    expect(after.window).toEqual([]);
    // Corillo: the same timers, watchers, connections, open files and listeners, memory back down, and nothing that grows with the documents closed.
    expect(after.busy).toEqual(before.busy);
    expect(after.openFiles).toBeLessThanOrEqual(before.openFiles + 1);
    expect(after.listening).toBe(before.listening);
    expect(after.heapMB).toBeLessThan(middle.heapMB + 1);
    expect(after.byTab).toEqual([]);
    expect(unbounded(middle)).toEqual([]);
    expect(unbounded(after)).toEqual([]);
    // The agent gone, what it kept of each document is gone with it.
    expect(agentKept(ended.main)).toEqual([]);
  } finally {
    if (sessionOn) await session.stop();
    await app.close();
  }
});

// Roadmap Batch 7: an agent's change, or another app's, arrives as an edit, with everything that rides on the page following it.
test("agents' and another app's changes arriving as edits, many times, in both views, with comments, line numbers, the outline and Find on, leave nothing behind in the window or in Corillo's memory", async () => {
  test.setTimeout(240_000);
  const DOC3 = bigDocument(3);
  const heading = (n: string) => DOC3.split("\n\n").find((b) => b.startsWith(`### ${n} `))!;
  const ADDED = "A paragraph another app put in, about the budget.";
  const run = await openText(DOC3, { name: "long.md" });
  const { page, app, file } = run;
  await page.setViewportSize({ width: 1400, height: 900 });
  const measure = await windowMeter(page);
  await clickMenu(app, "line-numbers");
  await clickMenu(app, "view-outline");
  await expect(page.locator(".doc:not([hidden]) .outline-pane .outline-row")).toHaveCount(1 + 3 * 10);
  for (const n of ["1.2", "2.6", "3.1"]) await comment(run, heading(n).slice(4), `About ${n}?`);
  const area = page.locator(".doc:not([hidden]) textarea.source");
  const findField = page.getByRole("textbox", { name: "Find", exact: true });
  /** Find open on "budget", in the view showing. */
  const findOpen = async () => {
    await page.keyboard.press("Meta+f");
    await findField.fill("budget");
    await expect(page.locator(".find-count")).toHaveText(/^\d+ (of \d+|matches)$/);
  };
  /** Whether the view showing has these words, once it does (or doesn't). */
  const shows = async (words: string, there: boolean) => {
    const has = async () => ((await area.isVisible()) ? await area.inputValue() : ((await page.locator(EDITOR).textContent()) ?? "")).includes(words);
    await expect.poll(has).toBe(there);
  };
  const { session } = await AgentSession.start(run.dataDir);
  try {
    /** An agent's pass, then another app saving the file: odd rounds take back what even ones put in. */
    const round = async (i: number) => {
      const on = i % 2 === 0;
      await session.ok("take_document", { path: file });
      await session.ok("edit_document", { path: file, edits: [on ? { find: "### 2.3 ", replace: "### 2.3 Agent: " } : { find: "### 2.3 Agent: ", replace: "### 2.3 " }] });
      // (The comments left for its next pass: finishing a second time leaves them.)
      if ((await session.call("finish_editing", { path: file })).isError) await session.ok("finish_editing", { path: file });
      await shows("Agent: ", on);
      const h = heading("1.5");
      const text = readFileSync(file, "utf8");
      writeFileSync(file, on ? text.replace(`${h}\n\n`, `${h}\n\n${ADDED}\n\n`) : text.replace(`${h}\n\n${ADDED}\n\n`, `${h}\n\n`));
      await shows(ADDED, on);
    };
    // Switched with Find open: it moves to the other view's text and finds its matches there.
    const view = async (name: "Markdown" | "Formatted") => {
      await page.getByRole("button", { name, exact: true }).click();
      await expect(name === "Markdown" ? area : page.locator(EDITOR)).toBeVisible();
      await expect(findField).toBeVisible();
      await expect(page.locator(".find-count")).toHaveText(/^\d+ (of \d+|matches)$/);
    };
    // Once in each view first, for what stays (the text area's layers, a version kept for each pass).
    await findOpen();
    for (let i = 0; i < 2; i++) await round(i);
    await view("Markdown");
    for (let i = 0; i < 2; i++) await round(i);
    await view("Formatted");
    await page.waitForTimeout(600);
    const before = { ...(await measure()), ...(await appUse(app)) };
    for (let i = 0; i < 10; i++) await round(i);
    await view("Markdown");
    for (let i = 0; i < 10; i++) await round(i);
    await view("Formatted");
    await page.waitForTimeout(600);
    const after = { ...(await measure()), ...(await appUse(app)) };
    expect(readFileSync(file, "utf8")).toBe(DOC3);
    console.log(
      `After 40 changes as edits in a 3,000-word document: window ${before.nodes} → ${after.nodes} elements, ${before.listeners} → ${after.listeners} listeners, ${before.windowMB.toFixed(2)} → ${after.windowMB.toFixed(2)} MB; app ${before.heapMB.toFixed(2)} → ${after.heapMB.toFixed(2)} MB`,
    );
    // The page is the same as before; nothing kept of the pages it was.
    expect(after.nodes).toBeLessThan(before.nodes + 100);
    expect(after.listeners).toBeLessThan(before.listeners + 20);
    // Memory settles: 40 changes added about 0.6 MB in the window and in Corillo, 120 about 1 MB, 200 about 1.2 MB
    // (2026-11-11), as much as with the page read again each time. The history grows on disk, as it should.
    expect(after.windowMB).toBeLessThan(before.windowMB + 2);
    expect(after.heapMB).toBeLessThan(before.heapMB + 1.5);
    expect(after.busy).toEqual(before.busy);
  } finally {
    await session.stop();
    await app.close();
  }
});
