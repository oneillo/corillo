// The speed benchmark (npm run bench): what a person feels, in the real app
// with throwaway data. Each step is repeated and the median kept; next to the
// time waited is the work the window and the app's main process did, which
// other programs on the Mac disturb less. The table goes to bench-results/.
//
// BENCH_RUNS=3 for a quicker run. BENCH_ONLY=typing runs only the steps whose
// name includes that (=history: that step alone). BENCH_PROFILE=typing saves a
// CPU profile of those steps. BENCH_SCALE=1 for a screen scale of 1 (2 by default).
// BENCH_COMPARE=bench-results/before.json adds a column with earlier results.
import { test } from "@playwright/test";
import { appendFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { statSync } from "node:fs";
import { gzipSync } from "node:zlib";
import { join } from "node:path";
import { bigDocument } from "../fixtures/big-document";
import { FIXTURES, pickInNextDialog } from "../e2e/helpers";
import { AgentSession } from "../e2e/agent-session";
import { longSession } from "../fixtures/long-history";
import {
  dataFolder,
  docFolder,
  installHelpers,
  launch,
  mainStall,
  maybeProfile,
  median,
  percentile,
  timed,
  workSoFar,
  writeDoc,
  type PageBench,
  type Running,
  type Sample,
} from "./measure";

const RUNS = Number(process.env.BENCH_RUNS ?? 7);
const ONLY = process.env.BENCH_ONLY ?? "";
const OUT = join(import.meta.dirname, "..", "..", "bench-results");

const LONG = bigDocument(); // about 30,000 words: 300 headings, 60 tables, 150 footnotes, 30 pictures, 20 diagrams
const MEDIUM = bigDocument(3); // about 3,000 words
const SHORT = readFileSync(join(FIXTURES, "proposal.md"), "utf8");
const LONG_NOTES = 150;
const H3 = LONG.split("\n").filter((l) => l.startsWith("### "));

interface Row {
  name: string;
  /** What's reported: the time waited, or a count. */
  unit: string;
  value: number;
  /** The slow end: 90th percentile, or the worst. */
  high?: number;
  window?: number;
  main?: number;
  n: number;
}

const CURRENT = join(OUT, "current.jsonl");

/** Each result is kept as it comes, so a step that fails doesn't lose the others. */
function keep(row: Row): void {
  mkdirSync(OUT, { recursive: true });
  appendFileSync(CURRENT, JSON.stringify(row) + "\n");
}

function report(name: string, samples: Sample[], unit = "ms"): void {
  const walls = samples.map((s) => s.wall);
  const withWork = samples.filter((s) => s.work);
  keep({
    name,
    unit,
    value: median(walls),
    high: percentile(walls, 90),
    window: withWork.length ? median(withWork.map((s) => s.work!.window)) : undefined,
    main: withWork.length ? median(withWork.map((s) => s.work!.main)) : undefined,
    n: samples.length,
  });
}

function reportValue(name: string, value: number, unit: string, high?: number): void {
  keep({ name, unit, value, high, n: 1 });
}

/** A step whose name includes one of BENCH_ONLY's words, or is one given with "=" ("=history" is History alone, not the long one). */
const want = (name: string) => !ONLY || ONLY.split(",").some((o) => (o.startsWith("=") ? name === o.slice(1) : name.includes(o)));
const step = (name: string, body: () => Promise<void>) => {
  if (want(name)) test(name, body);
  else test.skip(name, () => {});
};

/** In the window: run an action, wait until `ready`, then for the frame that shows it. Returns ms. */
async function shown(run: Running, action: string, ready: string, arg: unknown = null): Promise<number> {
  return run.page.evaluate(
    async ({ action, ready, arg }) => {
      const bench = (window as unknown as { bench: PageBench }).bench;
      const act = new Function("arg", action) as (a: unknown) => unknown;
      const isReady = new Function("arg", `return (${ready});`) as (a: unknown) => boolean;
      const start = performance.now();
      await act(arg);
      await bench.until(() => isReady(arg));
      return (await bench.afterPaint()) - start;
    },
    { action, ready, arg },
  );
}

const FRONT = ".doc:not([hidden])";
const NOTES_SHOWN = (count: number) => `document.querySelectorAll('${FRONT} .page.editor .footnote-def').length === ${count}`;

/** Open a document in the running app, as File > Open does, and wait until it's shown whole. */
async function openShown(run: Running, file: string, ready: string): Promise<number> {
  await pickInNextDialog(run.app, file); // the open panel answers at once with this file
  return shown(run, "return window.corillo.openDialog()", ready);
}

async function closeFront(run: Running): Promise<void> {
  const before = await run.page.locator(".tab").count();
  await run.page.locator(".tab[aria-selected='true'] .tab-close").click();
  await run.page.waitForFunction((n) => document.querySelectorAll(".tab").length === n - 1, before);
}

/** Type characters one at a time, at a quick typist's pace, and measure key press to painted. */
async function typeMeasured(run: Running, text: string, name: string): Promise<{ latencies: number[]; work: { window: number; main: number } }> {
  await run.page.evaluate(() => {
    const lat: number[] = [];
    const onKey = (e: KeyboardEvent) => {
      const t0 = e.timeStamp;
      requestAnimationFrame(() => {
        const c = new MessageChannel();
        c.port1.onmessage = () => lat.push(performance.now() - t0);
        c.port2.postMessage(null);
      });
    };
    addEventListener("keydown", onKey, true);
    (window as unknown as { benchKeys: unknown }).benchKeys = { lat, stop: () => removeEventListener("keydown", onKey, true) };
  });
  const before = await workSoFar(run);
  await maybeProfile(run, name, async () => {
    for (const ch of text) {
      await run.page.keyboard.press(ch === " " ? "Space" : ch);
      await run.page.waitForTimeout(45);
    }
    await run.page.waitForTimeout(200);
  });
  const after = await workSoFar(run);
  const latencies = await run.page.evaluate(() => {
    const k = (window as unknown as { benchKeys: { lat: number[]; stop(): void } }).benchKeys;
    k.stop();
    return k.lat;
  });
  return { latencies, work: { window: (after.window - before.window) / text.length, main: (after.main - before.main) / text.length } };
}

function reportTyping(name: string, result: { latencies: number[]; work: { window: number; main: number } }): void {
  keep({
    name,
    unit: "ms",
    value: median(result.latencies),
    high: percentile(result.latencies, 95),
    window: result.work.window,
    main: result.work.main,
    n: result.latencies.length,
  });
}

/** Put the cursor at the end of a heading in the document in front. */
async function cursorAtHeadingEnd(run: Running, startsWith: string): Promise<void> {
  await run.page.locator(`${FRONT} .page.editor h3`, { hasText: new RegExp(`^${startsWith.replace(/\./g, "\\.")} `) }).click();
  await run.page.waitForTimeout(60);
  await run.page.keyboard.press("Meta+ArrowRight");
  await run.page.waitForTimeout(300);
}

const TYPED = " and then a few more words typed here at the end of this line, quickly";
/** Typed in a comment box: words, then an @ and a name, the way a person directs a comment. */
const TYPED_COMMENT = "Could this be shorter and clearer for the board? @Claude please";

/** In the Markdown view: put the cursor at the end of a heading's line in the text. */
async function sourceCursorAtHeadingEnd(run: Running, startsWith: string): Promise<void> {
  await run.page.evaluate((wanted) => {
    const area = document.querySelector<HTMLTextAreaElement>(".doc:not([hidden]) textarea.source")!;
    const at = area.value.indexOf(`### ${wanted} `);
    const end = area.value.indexOf("\n", at);
    area.focus();
    area.setSelectionRange(end, end);
  }, startsWith);
  await run.page.waitForTimeout(300);
}

async function switchView(run: Running, label: "Markdown" | "Formatted"): Promise<void> {
  await run.page.locator(".mode-switch button", { hasText: label }).click();
  await run.page.waitForTimeout(800);
}

// Launch ------------------------------------------------------------------------

step("launch", async () => {
  const folder = docFolder();
  const short = writeDoc(folder, "proposal.md", SHORT);
  const startScreen: Sample[] = [];
  const cold: Sample[] = [];
  const warm: Sample[] = [];
  for (let i = 0; i < RUNS; i++) {
    // The start screen: nothing to open.
    let run = await launch();
    await run.page.waitForSelector("#toolbar .tool-group", { state: "attached" });
    await installHelpers(run.page);
    let painted = await run.page.evaluate(() => (window as unknown as { bench: PageBench }).bench.afterPaint().then((t) => performance.timeOrigin + t));
    startScreen.push({ wall: painted - run.launchedAt });
    await run.app.close();

    // A document, the first time (a new data folder) and again (the same one).
    const data = dataFolder();
    for (const list of [cold, warm]) {
      run = await launch({ files: [short], dataDir: data });
      await run.page.waitForSelector(`${FRONT} .ProseMirror h1`);
      await installHelpers(run.page);
      painted = await run.page.evaluate(
        (ready) =>
          (window as unknown as { bench: PageBench }).bench
            .until(() => !!document.querySelector(ready))
            .then(() => (window as unknown as { bench: PageBench }).bench.afterPaint())
            .then((t) => performance.timeOrigin + t),
        `${FRONT} .ProseMirror h1`,
      );
      list.push({ wall: painted - run.launchedAt });
      await run.app.close();
    }
  }
  report("Launch to the start screen", startScreen);
  report("Launch to a document, first time", cold);
  report("Launch to a document, again", warm);

  // Launching straight into the long document.
  const long: Sample[] = [];
  const longFile = writeDoc(folder, "long.md", LONG, true);
  const data = dataFolder();
  for (let i = 0; i < Math.max(3, Math.ceil(RUNS / 2)); i++) {
    const run = await launch({ files: [longFile], dataDir: data });
    await run.page.waitForSelector(`${FRONT} .ProseMirror h1`);
    await installHelpers(run.page);
    const painted = await run.page.evaluate(
      (count) => {
        const bench = (window as unknown as { bench: PageBench }).bench;
        return bench
          .until(() => document.querySelectorAll(".doc:not([hidden]) .page.editor .footnote-def").length === count)
          .then(() => bench.afterPaint())
          .then((t) => performance.timeOrigin + t);
      },
      LONG_NOTES,
    );
    long.push({ wall: painted - run.launchedAt });
    await run.app.close();
  }
  report("Launch to the long document", long);
});

// The start screen with documents waiting (roadmap Batch 4, item 3) -----------------
// 8 recent documents of 200 comments each, a quarter answered by an agent: the
// cards say where each stands, read from what Corillo keeps for them.

step("start screen with recent documents", async () => {
  const folder = docFolder();
  const data = dataFolder();
  const docs = Array.from({ length: 8 }, (_, i) => writeDoc(folder, `doc${i + 1}.md`, SHORT));
  writeFileSync(join(data, "recent.json"), JSON.stringify(docs));
  const words = "Could this paragraph be shorter, and say who the plan is for before it says what it costs? ".repeat(6);
  const at = new Date().toISOString();
  const index: Record<string, unknown> = {};
  docs.forEach((file, i) => {
    const id = `bench-${i + 1}`;
    const { ino, dev } = statSync(file);
    index[id] = { path: file, ino, dev };
    const threads = Array.from({ length: 200 }, (_, k) => ({
      id: `t${k}`,
      anchor: null,
      to: null,
      status: "open",
      messages: [
        { id: `m${k}`, author: { kind: "person" }, body: words, created: at },
        ...(k % 4 === 0 ? [{ id: `r${k}`, author: { kind: "agent", name: "Claude" }, body: words, created: at }] : []),
      ],
    }));
    mkdirSync(join(data, "documents", id), { recursive: true });
    writeFileSync(join(data, "documents", id, "record.json"), JSON.stringify({ path: file }));
    writeFileSync(join(data, "documents", id, "comments.json.gz"), gzipSync(JSON.stringify(threads), { level: 1 }));
  });
  writeFileSync(join(data, "documents.json"), JSON.stringify(index));
  const painted: Sample[] = [];
  for (let i = 0; i < RUNS; i++) {
    const run = await launch({ dataDir: data });
    await run.page.waitForSelector("#empty", { state: "attached" });
    await installHelpers(run.page);
    const seen = await run.page.evaluate(() => {
      const bench = (window as unknown as { bench: PageBench }).bench;
      return bench
        .until(() => document.querySelectorAll("#recent .recent-page").length === 8)
        .then(() => bench.afterPaint())
        .then((t) => ({ painted: performance.timeOrigin + t, states: document.querySelectorAll("#recent .recent-state").length }));
    });
    painted.push({ wall: seen.painted - run.launchedAt });
    console.log(`start screen: cards painted ${Math.round(seen.painted - run.launchedAt)} ms after launch, ${seen.states} saying where they stand`);
    await run.app.close();
  }
  report("Launch to the start screen, 8 recent documents of 200 comments", painted);
});

// Opening ------------------------------------------------------------------------

step("open documents", async () => {
  const folder = docFolder();
  const start = writeDoc(folder, "start.md", "Start.\n");
  const long = writeDoc(folder, "long.md", LONG, true);
  const short = writeDoc(folder, "proposal.md", SHORT);
  const run = await launch({ files: [start] });
  await run.page.waitForSelector(".ProseMirror");
  await installHelpers(run.page);
  const longSamples: Sample[] = [];
  const shortSamples: Sample[] = [];
  for (let i = 0; i < RUNS; i++) {
    longSamples.push(await timed(run, () => maybeProfile(run, "open long", () => openShown(run, long, NOTES_SHOWN(LONG_NOTES)))));
    await run.page.waitForTimeout(300);
    await closeFront(run);
    shortSamples.push(await timed(run, () => openShown(run, short, `document.querySelector('${FRONT} .page.editor h1')`)));
    await run.page.waitForTimeout(200);
    await closeFront(run);
  }
  report("Open the long document", longSamples);
  report("Open a short document", shortSamples);
  await run.app.close();
});

// Typing ------------------------------------------------------------------------

step("typing", async () => {
  const folder = docFolder();
  const short = writeDoc(folder, "proposal.md", SHORT);
  const long = writeDoc(folder, "long.md", LONG, true);

  let run = await launch({ files: [short] });
  await run.page.waitForSelector(".ProseMirror");
  await run.page.locator(`${FRONT} .page.editor p`, { hasText: "Volunteers would answer" }).click();
  await run.page.waitForTimeout(60);
  await run.page.keyboard.press("Meta+ArrowRight");
  await run.page.waitForTimeout(300);
  reportTyping("Typing in a short document", await typeMeasured(run, TYPED, "typing short"));
  await run.app.close();

  run = await launch({ files: [long] });
  await run.page.waitForSelector(".ProseMirror");
  await installHelpers(run.page);
  await run.page.evaluate((n) => (window as unknown as { bench: PageBench }).bench.until(() => document.querySelectorAll(".footnote-def").length === n), LONG_NOTES);
  await cursorAtHeadingEnd(run, "15.5");
  await run.page.waitForTimeout(1500); // diagrams nearby drawn
  reportTyping("Typing in the long document", await typeMeasured(run, TYPED, "typing long"));
  await switchView(run, "Markdown");
  await sourceCursorAtHeadingEnd(run, "15.6");
  reportTyping("Typing in the Markdown view, long document", await typeMeasured(run, TYPED, "typing markdown"));
  await switchView(run, "Formatted");

  // 100 comments, from an agent, on headings all through the document.
  const { session } = await AgentSession.start(run.dataDir);
  let made = 0;
  for (let i = 0; made < 100 && i < H3.length; i++) {
    const r = await session.call("add_comment", { path: long, text: `Comment ${made + 1}: tighten this heading, please.`, quote: H3[i].slice(4) });
    if (!r.isError) made++;
  }
  await session.stop();
  await run.page.waitForFunction((n) => document.querySelectorAll(".comments-panel .comment-card").length === n, made, { timeout: 60_000 });
  await run.page.waitForTimeout(1000);
  await cursorAtHeadingEnd(run, "16.5");
  reportTyping(`Typing in the long document, ${made} comments`, await typeMeasured(run, TYPED, "typing comments"));
  await switchView(run, "Markdown");
  await sourceCursorAtHeadingEnd(run, "16.6");
  reportTyping(`Typing in the Markdown view, long document, ${made} comments`, await typeMeasured(run, TYPED, "typing markdown comments"));
  await switchView(run, "Formatted");

  // Typing in a new comment's box, with the others there (an @ list may open as you type).
  await cursorAtHeadingEnd(run, "17.5");
  await run.page.keyboard.press("Shift+Home");
  await run.page.waitForTimeout(100);
  await run.page.keyboard.press("Meta+Alt+KeyM");
  await run.page.waitForSelector(".comment-card.draft textarea");
  await run.page.waitForTimeout(300);
  reportTyping(`Typing in a new comment (long document, ${made} comments)`, await typeMeasured(run, TYPED_COMMENT, "typing in a comment"));
  await run.page.locator(".comment-card.draft").getByRole("button", { name: "Cancel" }).click();
  await run.page.waitForTimeout(300);

  // Posting a comment, with the others there.
  const posts: Sample[] = [];
  for (let i = 0; i < RUNS; i++) {
    const target = H3[200 + i].slice(4);
    await run.page.evaluate((wanted) => {
      const root = document.querySelector<HTMLElement>(".doc:not([hidden]) .page.editor .ProseMirror")!;
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
    }, target.slice(0, 12));
    await run.page.waitForTimeout(100);
    await run.page.keyboard.press("Meta+Alt+KeyM");
    await run.page.waitForSelector(".comment-card.draft textarea");
    await run.page.keyboard.type(`Posted note ${i}`);
    const body = `Posted note ${i}`;
    await run.page.evaluate((text) => {
      const w = window as unknown as { bench: PageBench; posted: Promise<number> };
      w.posted = new Promise<number>((resolve) => {
        const onKey = (e: KeyboardEvent) => {
          if (e.key !== "Enter") return;
          removeEventListener("keydown", onKey, true);
          const t0 = e.timeStamp;
          void w.bench
            .until(
              () =>
                !document.querySelector(".comment-card.draft") &&
                [...document.querySelectorAll(".comment-card[data-thread-id] .comment-body")].some((b) => b.textContent === text),
            )
            .then(() => w.bench.afterPaint())
            .then((t) => resolve(t - t0));
        };
        addEventListener("keydown", onKey, true);
      });
    }, body);
    const before = await workSoFar(run);
    await run.page.keyboard.press("Meta+Enter");
    const wall = await run.page.evaluate(() => (window as unknown as { posted: Promise<number> }).posted);
    const after = await workSoFar(run);
    posts.push({ wall, work: { window: after.window - before.window, main: after.main - before.main } });
    await run.page.waitForTimeout(1000);
  }
  report(`Post a comment (long document, ${made} comments)`, posts);
  await run.app.close();
});

// Tabs and views ------------------------------------------------------------------------

step("tabs and views", async () => {
  const folder = docFolder();
  const long = writeDoc(folder, "long.md", LONG, true);
  const files = [writeDoc(folder, "start.md", SHORT)];
  for (let i = 0; i < 8; i++) files.push(writeDoc(folder, `medium ${i + 1}.md`, MEDIUM));
  const run = await launch({ files: [...files, long] });
  await run.page.waitForFunction(() => document.querySelectorAll(".tab").length === 10, null, { timeout: 60_000 });
  await installHelpers(run.page);
  await run.page.waitForTimeout(1500);
  const ids = await run.page.evaluate(() => [...document.querySelectorAll<HTMLElement>(".tab")].map((t) => t.dataset.docId!));
  const toMedium: Sample[] = [];
  const toLong: Sample[] = [];
  const switchTo = (id: string) =>
    timed(run, () =>
      shown(
        run,
        `document.querySelector('.tab[data-doc-id="' + arg + '"]').click()`,
        `!document.querySelector('.doc[data-doc-id="' + arg + '"]').hidden && document.querySelector('.tab[data-doc-id="' + arg + '"]').getAttribute('aria-selected') === 'true'`,
        id,
      ),
    );
  for (let round = 0; round < Math.max(2, Math.ceil(RUNS / 3)); round++) {
    for (const id of ids.slice(1, 9)) toMedium.push(await switchTo(id));
    toLong.push(await maybeProfile(run, "switch to long", () => switchTo(ids[9])));
    toMedium.push(await switchTo(ids[0]));
    toLong.push(await switchTo(ids[9]));
  }
  report("Switch tabs (10 open), to a 3,000-word document", toMedium);
  report("Switch tabs (10 open), to the long document", toLong);

  // Formatted and Markdown views, on the long document (in front now).
  const toMarkdown: Sample[] = [];
  const toFormatted: Sample[] = [];
  for (let i = 0; i < RUNS; i++) {
    toMarkdown.push(
      await timed(run, () =>
        maybeProfile(run, "to markdown", () =>
          shown(
            run,
            `[...document.querySelectorAll('.mode-switch button')].find((b) => b.textContent === 'Markdown').click()`,
            `document.querySelectorAll('${FRONT} .page.preview .footnote-def').length === ${LONG_NOTES}`,
          ),
        ),
      ),
    );
    await run.page.waitForTimeout(300);
    toFormatted.push(
      await timed(run, () =>
        maybeProfile(run, "to formatted", () =>
          shown(
            run,
            `[...document.querySelectorAll('.mode-switch button')].find((b) => b.textContent === 'Formatted').click()`,
            `!document.querySelector('${FRONT} .canvas:not(.version-view)').hidden && ${NOTES_SHOWN(LONG_NOTES)}`,
          ),
        ),
      ),
    );
    await run.page.waitForTimeout(300);
  }
  report("Long document: Formatted to Markdown view", toMarkdown);
  report("Long document: Markdown to Formatted view", toFormatted);

  // Scrolling the long document from top to bottom, and back up.
  const scroll = async (down: boolean) =>
    run.page.evaluate(async (down) => {
      const canvas = document.querySelector<HTMLElement>(".doc:not([hidden]) .canvas:not(.version-view)")!;
      if (down) canvas.scrollTop = 0;
      const frames: number[] = [];
      let last = performance.now();
      await new Promise<void>((resolve) => {
        const tick = (now: number) => {
          frames.push(now - last);
          last = now;
          const before = canvas.scrollTop;
          canvas.scrollTop += down ? 120 : -120;
          if (canvas.scrollTop === before) resolve();
          else requestAnimationFrame(tick);
        };
        requestAnimationFrame((now) => {
          last = now;
          requestAnimationFrame(tick);
        });
      });
      return frames;
    }, down);
  await run.page.waitForTimeout(500);
  const first = await maybeProfile(run, "scroll", () => scroll(true));
  const back = await scroll(false);
  const dropped = (frames: number[]) => frames.filter((f) => f > 25).length;
  reportValue("Scroll the long document, first time: frames dropped", dropped(first), `of ${first.length}`, Math.max(...first));
  reportValue("Scroll the long document, again: frames dropped", dropped(back), `of ${back.length}`, Math.max(...back));
  await run.app.close();
});

// History ------------------------------------------------------------------------

step("history", async () => {
  const folder = docFolder();
  const long = writeDoc(folder, "long.md", LONG, true);
  const run = await launch({ files: [long] });
  await run.page.waitForSelector(".ProseMirror");
  await installHelpers(run.page);
  // 50 passes by an agent: 50 versions after the first.
  const { session } = await AgentSession.start(run.dataDir);
  const passes = H3.slice(0, 50).map((h) => h.split(" ").slice(0, 2).join(" ") + " ");
  for (const p of passes) {
    await session.ok("take_document", { path: long });
    await session.ok("edit_document", { path: long, edits: [{ find: p, replace: `${p}Revised ` }] });
    await session.ok("finish_editing", { path: long });
  }
  await session.stop();
  await run.page.waitForTimeout(1000);
  const versions = passes.length + 1;
  const historyButton = `document.querySelector('.history-tools button[aria-label="History"]')`;
  const changesButton = `document.querySelector('.history-tools button[aria-label="Show changes"]')`;
  const panelItems = `document.querySelectorAll('${FRONT} .history-panel:not([hidden]) .history-item').length === ${versions}`;
  const versionShown = `!document.querySelector('${FRONT} .version-banner').hidden && document.querySelectorAll('${FRONT} .version-view .footnote-def').length === ${LONG_NOTES}`;

  const openPanel: Sample[] = [];
  const showChanges: Sample[] = [];
  const pick: Sample[] = [];
  const pickStall: Sample[] = [];
  const restore: Sample[] = [];
  for (let i = 0; i < RUNS; i++) {
    openPanel.push(await timed(run, () => maybeProfile(run, "history panel", () => shown(run, `${historyButton}.click()`, panelItems))));
    await run.page.waitForTimeout(200);
    await run.page.getByRole("button", { name: "Close history" }).click();
    await run.page.waitForTimeout(200);
    showChanges.push(await timed(run, () => maybeProfile(run, "show changes", () => shown(run, `${changesButton}.click()`, versionShown))));
    await run.page.waitForTimeout(200);
    await run.page.evaluate(() => document.querySelector<HTMLButtonElement>(".doc:not([hidden]) .version-banner .back-to-current")!.click());
    await run.page.waitForTimeout(200);
  }
  // Look at an older version, then restore it.
  for (let i = 0; i < Math.min(RUNS, 5); i++) {
    await run.page.evaluate((b) => (new Function(`${b}.click()`))(), historyButton);
    await run.page.waitForFunction((n) => document.querySelectorAll(".doc:not([hidden]) .history-item").length >= n, versions + i);
    await run.page.waitForTimeout(200);
    const n = 40 - i * 7;
    // The rows that come into sight then say what they changed: worked out in the main process meanwhile.
    const stall = await mainStall(run, async () =>
      pick.push(
        await timed(run, () =>
          maybeProfile(run, "pick version", () =>
            shown(
              run,
              `document.querySelector('${FRONT} .history-item[data-n="' + arg + '"]').click()`,
              `document.querySelector('${FRONT} .history-item[data-n="' + arg + '"]').getAttribute('aria-current') === 'true' && ${versionShown} && document.querySelector('${FRONT} .version-banner-text').textContent.startsWith('Version from')`,
              n,
            ),
          ),
        ),
      ),
    );
    pickStall.push({ wall: stall });
    // Version n has the first n - 1 passes; the pass after them is gone once it's restored.
    const gone = `${passes[n - 1]}Revised`.replace("### ", "");
    const kept = `${passes[n - 2]}Revised`.replace("### ", "");
    restore.push(
      await timed(run, () =>
        maybeProfile(run, "restore", () =>
          shown(
            run,
            `document.querySelector('${FRONT} .version-banner .restore-version').click()`,
            `document.querySelector('${FRONT} .version-banner').hidden && (() => { const hs = [...document.querySelectorAll('${FRONT} .page.editor h3')].map((h) => h.textContent); return !hs.some((t) => t.startsWith(arg.gone)) && hs.some((t) => t.startsWith(arg.kept)); })()`,
            { gone, kept },
          ),
        ),
      ),
    );
    await run.page.waitForTimeout(800);
    await run.page.getByRole("button", { name: "Close history" }).click();
    await run.page.waitForTimeout(300);
  }
  report(`History panel opens (long document, ${versions} versions)`, openPanel);
  report("Show changes (long document)", showChanges);
  report("Look at an older version from History", pick);
  report("Look at an older version: the app's main process held up at most", pickStall);
  report("Restore a version", restore);
  await run.app.close();
});

// A long history: 200 passes and about 200 comments (the storage tests' session),
// played on a 5,000-word document and after the long one. History stays open while the person types.
step("long history", async () => {
  test.setTimeout(1_800_000);
  for (const [label, after] of [
    ["5,000 words", undefined],
    ["long document", LONG],
  ] as const) {
    const folder = docFolder();
    const data = dataFolder();
    const file = writeDoc(folder, "plan.md", after ?? "", after !== undefined);
    const session = longSession({ after, data, file });
    const versions = session.texts.length;
    const lastParagraph = session.text().trimEnd().split("\n\n").pop()!.slice(0, 40);
    const run = await launch({ files: [file], dataDir: data });
    await run.page.waitForSelector(`${FRONT} .page.editor p`);
    await installHelpers(run.page);
    await run.page.waitForTimeout(1500);
    const historyButton = `document.querySelector('.history-tools button[aria-label="History"]')`;
    const rows = `document.querySelectorAll('${FRONT} .history-panel:not([hidden]) .history-item').length === ${versions}`;
    const closePanel = async () => {
      await run.page.getByRole("button", { name: "Close history" }).click();
      await run.page.waitForTimeout(300);
    };

    // Opening the panel.
    const openPanel: Sample[] = [];
    for (let i = 0; i < RUNS; i++) {
      openPanel.push(await timed(run, () => maybeProfile(run, "long history panel", () => shown(run, `${historyButton}.click()`, rows))));
      await run.page.waitForTimeout(200);
      await closePanel();
    }
    report(`Long history (${label}, ${versions} versions): History panel opens`, openPanel);

    // One autosave: the work it takes, with History closed and open.
    const cursorAtEnd = async () => {
      await run.page.locator(`${FRONT} .page.editor p`, { hasText: lastParagraph }).click();
      await run.page.waitForTimeout(60);
      await run.page.keyboard.press("Meta+ArrowRight");
      await run.page.waitForTimeout(300);
    };
    const autosave = async () => {
      const before = await workSoFar(run);
      await run.page.keyboard.press("x");
      await run.page.waitForTimeout(2000); // saved after 0.4 s, and the history brought up to date
      const after = await workSoFar(run);
      return { wall: 0, work: { window: after.window - before.window, main: after.main - before.main } };
    };
    await cursorAtEnd();
    const closedSaves: Sample[] = [];
    for (let i = 0; i < RUNS; i++) closedSaves.push(await autosave());
    await run.page.evaluate((b) => new Function(`${b}.click()`)(), historyButton);
    await run.page.waitForFunction((n) => document.querySelectorAll(".doc:not([hidden]) .history-item").length >= n, versions);
    await run.page.waitForTimeout(500);
    await cursorAtEnd();
    const openSaves: Sample[] = [];
    for (let i = 0; i < RUNS; i++) openSaves.push(await maybeProfile(run, "long history autosave", autosave));
    report(`Long history (${label}): one autosave, History closed (CPU only)`, closedSaves);
    report(`Long history (${label}): one autosave, History open (CPU only)`, openSaves);

    // Typing with History open: the history changes with each autosave meanwhile. Closed first, to compare.
    await run.page.getByRole("button", { name: "Close history" }).click();
    await cursorAtEnd();
    reportTyping(`Long history (${label}): typing with History closed`, await typeMeasured(run, TYPED, "long history typing closed"));
    await run.page.evaluate((b) => new Function(`${b}.click()`)(), historyButton);
    await run.page.waitForFunction((n) => document.querySelectorAll(".doc:not([hidden]) .history-item").length >= n, versions);
    await run.page.waitForTimeout(500);
    await cursorAtEnd();
    reportTyping(`Long history (${label}): typing with History open`, await typeMeasured(run, TYPED, "long history typing"));

    // The oldest version, from the open panel.
    const oldest: Sample[] = [];
    for (let i = 0; i < Math.min(RUNS, 5); i++) {
      await run.page.waitForTimeout(500);
      oldest.push(
        await timed(run, () =>
          maybeProfile(run, "long history oldest", () =>
            shown(
              run,
              `document.querySelector('${FRONT} .history-item[data-n="1"]').click()`,
              `document.querySelector('${FRONT} .history-item[data-n="1"]').getAttribute('aria-current') === 'true' && !document.querySelector('${FRONT} .version-banner').hidden && document.querySelector('${FRONT} .version-banner-text').textContent.startsWith('Version from') && !!document.querySelector('${FRONT} .version-view .ProseMirror p')`,
            ),
          ),
        ),
      );
      await run.page.waitForTimeout(300);
      await run.page.evaluate(() => document.querySelector<HTMLButtonElement>(".doc:not([hidden]) .version-banner .back-to-current")!.click());
    }
    report(`Long history (${label}): look at the oldest version`, oldest);
    await run.app.close();
  }
});

// Agents ------------------------------------------------------------------------

step("agent edits", async () => {
  const folder = docFolder();
  const long = writeDoc(folder, "long.md", LONG, true);
  const short = writeDoc(folder, "proposal.md", SHORT);
  const run = await launch({ files: [short, long] });
  await run.page.waitForFunction(() => document.querySelectorAll(".tab").length === 2);
  await installHelpers(run.page);
  await run.page.waitForTimeout(1000);
  const { session } = await AgentSession.start(run.dataDir);
  for (const [file, label, find] of [
    [long, "the long document", "### 20.2 "],
    [short, "a short document", "Volunteers would answer"],
  ] as const) {
    await run.page.evaluate((name) => {
      // By the file's path in its tooltip: the tab shows the name without ".md" (roadmap Batch 5, item 2).
      const tab = [...document.querySelectorAll<HTMLElement>(".tab")].find((t) => t.title.endsWith(`/${name}`))!;
      tab.click();
    }, file.split("/").pop()!);
    await run.page.waitForTimeout(500);
    await session.ok("take_document", { path: file });
    await session.ok("read_document", { path: file });
    const samples: Sample[] = [];
    let current: string = find;
    for (let i = 0; i < RUNS; i++) {
      const next = `${find}Agent ${i} `;
      const marker = `Agent ${i} `;
      await run.page.evaluate((m) => {
        const w = window as unknown as { bench: PageBench; arrived: Promise<number>; kept: { root: Element; title: unknown } };
        // The document the editor shows (its own record of it), and in it the title, which the edit doesn't touch.
        const root = document.querySelector(".doc:not([hidden]) .page.editor .ProseMirror")!;
        w.kept = { root, title: (root as unknown as { pmViewDesc?: { node: { firstChild: unknown } } }).pmViewDesc?.node.firstChild };
        w.arrived = w.bench
          .until(() => (document.querySelector(".doc:not([hidden]) .page.editor .ProseMirror")?.textContent ?? "").includes(m))
          .then(() => w.bench.afterPaint())
          .then((t) => performance.timeOrigin + t);
      }, marker);
      const before = await workSoFar(run);
      const sent = Date.now();
      await maybeProfile(run, "agent edit", async () => {
        await session.ok("edit_document", { path: file, edits: [{ find: current, replace: next }] });
        await run.page.evaluate(() => (window as unknown as { arrived: Promise<number> }).arrived);
      });
      const arrived = await run.page.evaluate(() => (window as unknown as { arrived: Promise<number> }).arrived);
      const after = await workSoFar(run);
      // Measured as an edit (roadmap Batch 7): the document shown still has the very same title, not one read again from the text.
      const asEdit = await run.page.evaluate(() => {
        const { root, title } = (window as unknown as { kept: { root: Element; title: unknown } }).kept;
        return title !== undefined && (root as unknown as { pmViewDesc?: { node: { firstChild: unknown } } }).pmViewDesc?.node.firstChild === title;
      });
      if (!asEdit) throw new Error(`The agent's edit to ${label} was shown by reading the page again, not as an edit`);
      samples.push({ wall: arrived - sent, work: { window: after.window - before.window, main: after.main - before.main } });
      current = next;
      await run.page.waitForTimeout(300);
    }
    await session.ok("finish_editing", { path: file });
    report(`An agent's edit appears in ${label}`, samples);
  }
  await session.stop();
  await run.app.close();
});

// Memory ------------------------------------------------------------------------

step("memory", async () => {
  const folder = docFolder();
  const start = writeDoc(folder, "start.md", SHORT);
  writeDoc(folder, "pictures.md", "", true);
  const run = await launch({ files: [start] });
  await run.page.waitForSelector(".ProseMirror");
  await installHelpers(run.page);
  await run.page.waitForTimeout(1000);
  const measureMemory = async () => {
    await run.cdp.send("HeapProfiler.collectGarbage");
    await run.page.waitForTimeout(300);
    await run.cdp.send("HeapProfiler.collectGarbage");
    const metrics = await run.cdp.send("Performance.getMetrics");
    const get = (n: string) => metrics.metrics.find((m) => m.name === n)?.value ?? 0;
    const processes = await run.app.evaluate(({ app, BrowserWindow }) => {
      const pid = BrowserWindow.getAllWindows()[0].webContents.getOSProcessId();
      const all = app.getAppMetrics();
      return {
        window: (all.find((p) => p.pid === pid)?.memory.workingSetSize ?? 0) / 1024,
        main: (all.find((p) => p.type === "Browser")?.memory.workingSetSize ?? 0) / 1024,
      };
    });
    return { heap: get("JSHeapUsedSize") / 1024 / 1024, nodes: get("Nodes"), listeners: get("JSEventListeners"), ...processes };
  };
  const before = await measureMemory();
  for (let i = 0; i < 20; i++) {
    const long = i % 2 === 0;
    const file = writeDoc(folder, `doc ${i + 1}.md`, long ? LONG : MEDIUM);
    await openShown(run, file, long ? NOTES_SHOWN(LONG_NOTES) : `document.querySelector('${FRONT} .page.editor h1')`);
    // A little work in each: type, switch views, scroll to the end.
    await run.page.locator(`${FRONT} .page.editor h3`).first().click();
    await run.page.keyboard.press("Meta+ArrowRight");
    await run.page.keyboard.type(" edited");
    if (i % 4 === 1) {
      await run.page.evaluate(() => [...document.querySelectorAll<HTMLButtonElement>(".mode-switch button")].find((b) => b.textContent === "Markdown")!.click());
      await run.page.waitForTimeout(300);
      await run.page.evaluate(() => [...document.querySelectorAll<HTMLButtonElement>(".mode-switch button")].find((b) => b.textContent === "Formatted")!.click());
    }
    await run.page.evaluate(() => {
      const c = document.querySelector<HTMLElement>(".doc:not([hidden]) .canvas")!;
      c.scrollTop = c.scrollHeight;
    });
    await run.page.waitForTimeout(600);
    await closeFront(run);
  }
  // Carry on in the document still open. (The editor library keeps hold of the
  // last document typed or moved around in until the next time, wherever it is.)
  await run.page.locator(`${FRONT} .page.editor p`).first().click();
  await run.page.keyboard.press("Meta+ArrowRight");
  await run.page.keyboard.type("x");
  await run.page.waitForTimeout(1500);
  const after = await measureMemory();
  reportValue("Memory: window's JavaScript, before and after 20 documents", after.heap, "MB", before.heap);
  reportValue("Memory: window process, before and after", after.window, "MB", before.window);
  reportValue("Memory: main process, before and after", after.main, "MB", before.main);
  reportValue("Memory: page elements left, before and after", after.nodes, "nodes", before.nodes);
  reportValue("Memory: event listeners left, before and after", after.listeners, "listeners", before.listeners);
  await run.app.close();
});

// The table ------------------------------------------------------------------------

test.afterAll(() => {
  if (!existsSync(CURRENT)) return;
  const rows: Row[] = readFileSync(CURRENT, "utf8")
    .split("\n")
    .filter(Boolean)
    .map((l) => JSON.parse(l) as Row);
  const compareFile = process.env.BENCH_COMPARE;
  const earlier: Row[] = compareFile && existsSync(compareFile) ? JSON.parse(readFileSync(compareFile, "utf8")).rows : [];
  const fmt = (x: number | undefined) => (x === undefined || Number.isNaN(x) ? "" : x >= 100 ? x.toFixed(0) : x.toFixed(1));
  const pair = (a: number | undefined, b: number | undefined) => (a === undefined ? fmt(b) : `${fmt(a)} → ${fmt(b)}`);
  const lines = [
    `Corillo speed benchmark, ${new Date().toISOString().slice(0, 16).replace("T", " ")}, ${RUNS} runs each. Times are medians.`,
    "",
    earlier.length
      ? "| Measure | Before → now | Slow end (p90, or before) | Window CPU ms | Main CPU ms | Unit |"
      : "| Measure | Median | Slow end (p90, or before) | Window CPU ms | Main CPU ms | Unit |",
    "|---|---:|---:|---:|---:|---|",
  ];
  for (const r of rows) {
    const old = earlier.find((e) => e.name === r.name);
    const cells = earlier.length
      ? [r.name, pair(old?.value, r.value), pair(old?.high, r.high), pair(old?.window, r.window), pair(old?.main, r.main), r.unit]
      : [r.name, fmt(r.value), fmt(r.high), fmt(r.window), fmt(r.main), r.unit];
    lines.push(`| ${cells.join(" | ")} |`);
  }
  const table = lines.join("\n") + "\n";
  writeFileSync(join(OUT, "latest.md"), table);
  // Results from a partial run (BENCH_ONLY) are merged into the last full set.
  const latestJson = join(OUT, "latest.json");
  let merged = rows;
  if (ONLY && existsSync(latestJson)) {
    const previous: Row[] = JSON.parse(readFileSync(latestJson, "utf8")).rows;
    merged = [...previous.filter((p) => !rows.some((r) => r.name === p.name)), ...rows];
  }
  writeFileSync(latestJson, JSON.stringify({ when: new Date().toISOString(), runs: RUNS, rows: merged }, null, 2));
  console.log("\n" + table);
});
