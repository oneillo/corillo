// Tools for the speed benchmark: start the real app with throwaway data, time
// what a person would wait for (until the result is painted on screen), and
// count the work the window and the app did meanwhile. Other programs share
// the Mac, so the benchmark repeats each step and reports medians, and the
// work done (CPU time) next to the time waited.
import { _electron as electron, type CDPSession, type ElectronApplication, type Page } from "@playwright/test";
import { copyFileSync, mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { BIG_PICTURES, bigPicturePath } from "../fixtures/big-document";
import { FIXTURES, throwawayStart } from "../e2e/helpers";

export interface Running {
  app: ElectronApplication;
  page: Page;
  cdp: CDPSession;
  dataDir: string;
  /** When the launch began (milliseconds since 1970). */
  launchedAt: number;
}

/** The screen scale the benchmark's window gets. */
const SCALE = Number(process.env.BENCH_SCALE ?? 2);

/** A throwaway folder for documents. */
export function docFolder(): string {
  return mkdtempSync(join(tmpdir(), "corillo-bench-doc-"));
}

/** A throwaway data folder that isn't on its first run (no "Connect your agents" screen). */
export function dataFolder(): string {
  const dir = mkdtempSync(join(tmpdir(), "corillo-bench-data-"));
  writeFileSync(join(dir, "setup.json"), '{ "connectAgentsOffered": true }\n');
  return dir;
}

/** Write a document; with pictures, also its "big images" folder. */
export function writeDoc(folder: string, name: string, text: string, pictures = false): string {
  const file = join(folder, name);
  writeFileSync(file, text);
  if (pictures) {
    mkdirSync(join(folder, "big images"), { recursive: true });
    for (let i = 0; i < BIG_PICTURES; i++) copyFileSync(join(FIXTURES, "chart.png"), join(folder, bigPicturePath(i)));
  }
  return file;
}

/** Page-side helpers: wait for something to show, then for the frame that paints it. */
const PAGE_HELPERS = () => {
  const w = window as unknown as Record<string, unknown>;
  if (w.bench) return;
  const afterPaint = () =>
    new Promise<number>((resolve) =>
      requestAnimationFrame(() => {
        const c = new MessageChannel();
        c.port1.onmessage = () => resolve(performance.now());
        c.port2.postMessage(null);
      }),
    );
  const until = (check: () => boolean, timeout = 60_000) =>
    new Promise<void>((resolve, reject) => {
      const start = performance.now();
      let done = false;
      const test = () => {
        if (done) return;
        if (check()) {
          done = true;
          observer.disconnect();
          clearInterval(timer);
          resolve();
        } else if (performance.now() - start > timeout) {
          done = true;
          observer.disconnect();
          clearInterval(timer);
          reject(new Error("timed out"));
        }
      };
      const observer = new MutationObserver(test);
      const timer = setInterval(test, 25);
      observer.observe(document, { subtree: true, childList: true, attributes: true, characterData: true });
      test();
    });
  w.bench = { afterPaint, until };
};

export interface PageBench {
  afterPaint(): Promise<number>;
  until(check: () => boolean, timeout?: number): Promise<void>;
}

export async function installHelpers(page: Page): Promise<void> {
  await page.evaluate(PAGE_HELPERS);
}

/** Start Corillo, optionally with documents, and wait for its window. */
export async function launch(options: { files?: string[]; dataDir?: string } = {}): Promise<Running> {
  const dataDir = options.dataDir ?? dataFolder();
  const home = mkdtempSync(join(tmpdir(), "corillo-bench-home-"));
  const launchedAt = Date.now();
  const app = await electron.launch({
    // At a Retina screen's scale, as the person sees it, whatever the display's state (BENCH_SCALE=1 for the other).
    args: [`--force-device-scale-factor=${SCALE}`, ".", ...(options.files ?? [])],
    // Hidden, on the throwaway data folder, with the stand-in home as HOME too (Batch 23, item 3: R22-9).
    env: throwawayStart({ ...process.env, CORILLO_USER_DATA: dataDir, CORILLO_HOME: home }) as Record<string, string>,
  });
  const page = await app.firstWindow();
  const cdp = await page.context().newCDPSession(page);
  await cdp.send("Performance.enable");
  return { app, page, cdp, dataDir, launchedAt };
}

export interface Work {
  /** Busy time of the window's main thread, in ms. */
  window: number;
  /** CPU time of the app's main process, in ms. */
  main: number;
}

export async function workSoFar(run: Running): Promise<Work> {
  const metrics = await run.cdp.send("Performance.getMetrics");
  const task = metrics.metrics.find((m) => m.name === "TaskDuration")?.value ?? 0;
  const main = await run.app.evaluate(() => {
    const u = process.cpuUsage();
    return (u.user + u.system) / 1000;
  });
  return { window: task * 1000, main };
}

/**
 * The longest the app's main process went without a turn of its event loop,
 * while a step ran and for `after` ms more: how long an agent's call or a
 * save arriving then could have waited. In ms.
 */
export async function mainStall(run: Running, step: () => Promise<unknown>, after = 500): Promise<number> {
  await run.app.evaluate(() => {
    const watch = { last: performance.now(), most: 0, timer: undefined as unknown as ReturnType<typeof setInterval> };
    watch.timer = setInterval(() => {
      const now = performance.now();
      watch.most = Math.max(watch.most, now - watch.last);
      watch.last = now;
    }, 1);
    (globalThis as { benchStall?: typeof watch }).benchStall = watch;
  });
  await step();
  await run.page.waitForTimeout(after);
  return run.app.evaluate(() => {
    const g = globalThis as { benchStall?: { most: number; timer: ReturnType<typeof setInterval> } };
    clearInterval(g.benchStall!.timer);
    const most = g.benchStall!.most;
    delete g.benchStall;
    return most;
  });
}

export interface Sample {
  /** Time waited, in ms. */
  wall: number;
  work?: Work;
}

/** Time a step (the step returns the time waited), and the work done meanwhile. */
export async function timed(run: Running, step: () => Promise<number>): Promise<Sample> {
  const before = await workSoFar(run);
  const wall = await step();
  const after = await workSoFar(run);
  return { wall, work: { window: after.window - before.window, main: after.main - before.main } };
}

/**
 * Record CPU profiles of the window and of the app's main process while a
 * step runs, if BENCH_PROFILE names it: bench-results/<step>.cpuprofile and
 * <step>.main.cpuprofile (open either in Chrome's DevTools), and the
 * window's own counters for the step (script, style, layout) in <step>.metrics.json.
 * A step that runs several times keeps its last run's.
 */
export async function maybeProfile<T>(run: Running, name: string, step: () => Promise<T>): Promise<T> {
  const wanted = process.env.BENCH_PROFILE;
  if (!wanted || !wanted.split(",").some((w) => name.includes(w))) return step();
  const counters = async () => Object.fromEntries((await run.cdp.send("Performance.getMetrics")).metrics.map((m) => [m.name, m.value]));
  await run.cdp.send("Profiler.enable");
  await run.cdp.send("Profiler.setSamplingInterval", { interval: 200 });
  await run.cdp.send("Profiler.start");
  await mainProfiler(run, "start");
  const before = await counters();
  try {
    return await step();
  } finally {
    const after = await counters();
    const { profile } = await run.cdp.send("Profiler.stop");
    const main = await mainProfiler(run, "stop");
    const dir = join(import.meta.dirname, "..", "..", "bench-results");
    const file = name.replace(/[^a-z0-9]+/gi, "-");
    const metrics: Record<string, number> = {};
    for (const k of ["TaskDuration", "ScriptDuration", "RecalcStyleDuration", "LayoutDuration", "RecalcStyleCount", "LayoutCount"]) {
      metrics[k] = k.endsWith("Duration") ? (after[k] - before[k]) * 1000 : after[k] - before[k];
    }
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, `${file}.cpuprofile`), JSON.stringify(profile));
    writeFileSync(join(dir, `${file}.main.cpuprofile`), main);
    writeFileSync(join(dir, `${file}.metrics.json`), JSON.stringify(metrics, null, 2));
  }
}

/** Node's own profiler in the main process, through an inspector session there; "stop" gives the profile as JSON. */
async function mainProfiler(run: Running, action: "start" | "stop"): Promise<string> {
  return run.app.evaluate(async (_electron, action) => {
    type Session = import("node:inspector").Session;
    const g = globalThis as unknown as { benchProfiler?: Session };
    const post = (session: Session, method: string, params?: object) =>
      new Promise<unknown>((resolve, reject) => session.post(method, params, (err, result) => (err ? reject(err) : resolve(result))));
    if (action === "start") {
      const { Session } = process.getBuiltinModule("node:inspector") as typeof import("node:inspector");
      const session = (g.benchProfiler = new Session());
      session.connect();
      await post(session, "Profiler.enable");
      await post(session, "Profiler.setSamplingInterval", { interval: 200 });
      await post(session, "Profiler.start");
      return "";
    }
    const session = g.benchProfiler!;
    const { profile } = (await post(session, "Profiler.stop")) as { profile: unknown };
    session.disconnect();
    delete g.benchProfiler;
    return JSON.stringify(profile);
  }, action);
}

export const median = (xs: number[]) => {
  const s = [...xs].sort((a, b) => a - b);
  if (!s.length) return NaN;
  const mid = Math.floor(s.length / 2);
  return s.length % 2 ? s[mid] : (s[mid - 1] + s[mid]) / 2;
};

export const percentile = (xs: number[], p: number) => {
  const s = [...xs].sort((a, b) => a - b);
  if (!s.length) return NaN;
  return s[Math.min(s.length - 1, Math.ceil((p / 100) * s.length) - 1)];
};
