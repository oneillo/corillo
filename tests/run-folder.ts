// Each test run keeps everything it makes in one folder of its own, removed
// when the run ends, whether it passed, failed or timed out. Every kind of
// run sets it up: the unit and end-to-end tests, the bench, the pictures and
// the package tests (as their global setup) and the real-agent trial.
//
// The run's temporary folder is pointed at it (TMPDIR for Node and the tests,
// MAC_CHROMIUM_TMPDIR for Chromium, which on the Mac ignores TMPDIR), so the
// tests' throwaway documents, data and home folders, copies of the app, and
// whatever Corillo itself puts in the temporary folder all land inside it,
// without any test file changing.
//
// Run folders go in /private/tmp, a shorter path than the Mac's own temporary
// folder, so an agent socket in a data folder inside one still fits macOS's
// 103-byte limit (src/mcp/socket-path.ts) and tests exercise what they did.
// The folder is named for the run's process and when it started (so a later
// process given the same number isn't taken for it): a run killed outright
// leaves its folder behind, and the programs its tests started (hidden Corillo
// apps, their helpers, export programs) still running. The next run's sweep
// stops those programs, then removes the folder, once that process is gone.
// Several runs go on at once on this Mac; none touches another's folder or
// programs, and nothing touches the installed Corillo in /Applications.
//
// Plain TypeScript Node can run as it is: the scripts import it too.
import { spawnSync } from "node:child_process";
import { existsSync, lstatSync, mkdtempSync, readdirSync, rmdirSync, rmSync, statSync, unlinkSync } from "node:fs";
import { constants as osConstants, homedir, tmpdir, userInfo } from "node:os";
import { basename, join, resolve } from "node:path";

/** Left in a run's folder by a Corillo whose real speech was reached while tests ran (src/main/main.ts): the run fails (B14-09). */
export const REAL_SPEECH_MARK = "corillo-real-speech-reached";

export const RUNS_BASE = process.platform === "darwin" ? "/private/tmp" : tmpdir();
export const RUN_PREFIX = "corillo-run-";

/** Loose test folders from before run folders (or written outside one) are cleared after this long. */
const LOOSE_MINUTES = 30;
/** The real-agent trial keeps its reports in the temporary folder, to be read after it ends. */
const TRIAL_MINUTES = 180;
/** Playwright's compiled tests unused for this long are removed from its cache. */
const CACHE_HOURS = 24;
/** The work of a downloads or packaging run, named for its process: the public copy, an app out of a disk image, Electron for the other Mac. */
const OWNED = /^corillo-(?:downloads-copy|downloads-check|electron-[a-z0-9]+)-(\d+)-[A-Za-z0-9]+$/;
/**
 * Corillo's own work in the temporary folder: an export's, and a Word copy's kept while the person has it open,
 * however long. A test's Corillo makes them in its run's folder, so one met loose is most likely the installed
 * Corillo's, and only Corillo knows which it still uses: its own start clears the rest (clearOldWork in
 * src/main/export.ts). The sweep leaves them to it (Batch 22, item 4).
 */
const CORILLOS_WORK = /^corillo-(?:export|word-copy)-\d+-/;

/** The Mac's temporary folder, as it was before any run folder took its place. */
export function realTemp(): string {
  return process.env.CORILLO_REAL_TMPDIR ?? tmpdir();
}

/**
 * Only ever look through a temporary folder (/tmp, or the Mac's own under
 * /var/folders), or a folder inside one: never the disk, the home folder or
 * anywhere else, whatever TMPDIR says.
 */
export const lookable = (dir: string) => {
  const at = resolve(dir);
  return /^\/(?:private\/)?tmp(?:\/|$)/.test(at) || /^\/(?:private\/)?var\/folders\/[^/]+\/[^/]+\/T(?:\/|$)/.test(at);
};

function alive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    return (err as NodeJS.ErrnoException).code === "EPERM"; // someone else's process
  }
}

/**
 * When a process started, in seconds since 1970 as `ps` gives it; null if it
 * can't say. Asked as a date ("Fri Nov 13 10:08:46 2026"), not as how long it
 * has run, so a slow answer doesn't move it.
 */
function startOf(pid: number): number | null {
  const out = spawnSync("/bin/ps", ["-o", "lstart=", "-p", String(pid)], { encoding: "utf8", env: { ...process.env, LC_ALL: "C" } }).stdout ?? "";
  const m = /^\s*[A-Z][a-z]{2}\s+([A-Z][a-z]{2})\s+(\d+)\s+(\d+):(\d+):(\d+)\s+(\d{4})\s*$/.exec(out);
  const month = m ? "JanFebMarAprMayJunJulAugSepOctNovDec".indexOf(m[1]) / 3 : -1;
  if (!m || !Number.isInteger(month) || month < 0) return null;
  const [day, hours, minutes, seconds, year] = m.slice(2).map(Number);
  return Math.floor(new Date(year, month, day, hours, minutes, seconds).getTime() / 1000);
}

/** This process's start, as it goes in its run folder's name. */
function stampOf(pid: number): string {
  return (startOf(pid) ?? Math.floor(Date.now() / 1000 - process.uptime())).toString(36);
}

/**
 * Whether the run a folder is named for is still going: its process is there
 * and started when the name says (folders named before start times were in
 * the name go by the process alone). Anything not named like a run's folder
 * counts as going, so it's never touched.
 */
function going(name: string): boolean {
  const m = /^corillo-run-(\d+)-(?:([0-9a-z]+)-)?[A-Za-z0-9]+$/.exec(name);
  if (!m) return true;
  const pid = Number(m[1]);
  if (!alive(pid)) return false;
  if (!m[2]) return true;
  const started = startOf(pid);
  return started === null || Math.abs(started - parseInt(m[2], 36)) <= 2;
}

/**
 * The programs of ours still running that name a run folder in `base`, in
 * their arguments or their surroundings (TMPDIR and the like, which every
 * program a test starts inherits, though the Mac shows it only for programs
 * that aren't its own), with the run folders each names; and every program's
 * group. Never this process or the one that started it, nobody else's, and
 * nothing in /Applications (the installed Corillo, and the agents' connectors
 * it runs).
 */
function programsNaming(base: string): { named: Map<number, Set<string>>; groups: Map<number, number[]> } {
  const named = new Map<number, Set<string>>();
  const groups = new Map<number, number[]>();
  if (process.platform !== "darwin") return { named, groups };
  const listed = spawnSync("/bin/ps", ["-axwwE", "-o", "pid=,pgid=,uid=,command="], { encoding: "utf8", maxBuffer: 1024 * 1024 * 1024 }).stdout ?? "";
  const naming = new RegExp(`${base.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}/(${RUN_PREFIX}[A-Za-z0-9-]+)`, "g");
  const uid = userInfo().uid;
  for (const line of listed.split("\n")) {
    const m = /^\s*(\d+)\s+(\d+)\s+(\d+)\s(.*)$/.exec(line);
    if (!m || Number(m[3]) !== uid) continue;
    const [pid, pgid] = [Number(m[1]), Number(m[2])];
    const command = m[4].trimStart();
    if (pid === process.pid || pid === process.ppid || command.startsWith("/Applications/")) continue;
    groups.set(pgid, [...(groups.get(pgid) ?? []), pid]);
    for (const hit of command.matchAll(naming)) {
      const runs = named.get(pid) ?? new Set<string>();
      runs.add(hit[1]);
      named.set(pid, runs);
    }
  }
  return { named, groups };
}

const pause = (ms: number) => Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);

/** Stop these programs: asked first, then made to, after a few seconds. How many were stopped. */
function stop(pids: number[]): number {
  const signal = (pid: number, sig: NodeJS.Signals) => {
    try {
      process.kill(pid, sig);
    } catch {
      // gone already
    }
  };
  for (const pid of pids) signal(pid, "SIGTERM");
  for (let waited = 0; waited < 3000 && pids.some(alive); waited += 100) pause(100);
  for (const pid of pids.filter(alive)) signal(pid, "SIGKILL");
  for (let waited = 0; waited < 2000 && pids.some(alive); waited += 100) pause(100);
  return pids.length;
}

/**
 * Stop the programs left running by runs in `base` that are over (or by this
 * one, `ending`), and, for one that leads a group of its own (as each Corillo
 * a test starts does), the rest of its group: the programs it started, which
 * may not name the run themselves. How many.
 */
function stopLeftPrograms(base: string, ending?: string): number {
  const over = new Map<string, boolean>();
  const isOver = (name: string) => {
    if (!over.has(name)) over.set(name, name === ending || !going(name));
    return over.get(name)!;
  };
  const { named, groups } = programsNaming(base);
  const left = new Set([...named].filter(([, runs]) => [...runs].every(isOver)).map(([pid]) => pid));
  for (const leader of [...left]) for (const pid of groups.get(leader) ?? []) left.add(pid);
  return left.size ? stop([...left]) : 0;
}

/**
 * Remove a folder and everything in it, including what tests lock or make
 * read-only to see Corillo cope, and disk images still attached inside it.
 * Links are removed, never followed. Why it couldn't be, or null.
 */
export function removeFolder(folder: string): string | null {
  const remove = () => rmSync(folder, { recursive: true, force: true, maxRetries: 3, retryDelay: 100 });
  try {
    remove();
    return null;
  } catch {
    // Unlock below, then once more.
  }
  if (process.platform === "darwin") {
    const mounts = spawnSync("/sbin/mount", { encoding: "utf8" }).stdout ?? "";
    for (const line of mounts.split("\n")) {
      const at = / on (.+) \(/.exec(line)?.[1];
      if (at && (at.startsWith(folder + "/") || at.startsWith(`/private${folder}/`))) {
        spawnSync("/usr/bin/hdiutil", ["detach", at, "-force", "-quiet"]);
      }
    }
    spawnSync("/usr/bin/chflags", ["-R", "-P", "nouchg", folder]);
  }
  spawnSync("/bin/chmod", ["-R", "-P", "u+rwx", folder]);
  try {
    remove();
    return null;
  } catch (err) {
    return (err as Error).message;
  }
}

/**
 * Before a run: stop the programs left running by runs that have ended (their
 * process is gone), then remove those runs' folders, loose test folders
 * in the temporary folder older than half an hour, the work of downloads and
 * packaging runs that have ended, and Playwright's compiled tests unused for a
 * day. Corillo's own exports and Word copies are left to Corillo. Says how
 * many programs and folders.
 */
export function sweep({ base = RUNS_BASE, temp = realTemp(), now = Date.now() } = {}): { folders: number; programs: number } {
  let removed = 0;
  const entries = (dir: string) => {
    if (!lookable(dir)) return [];
    try {
      return readdirSync(dir);
    } catch {
      return [];
    }
  };
  // Programs first (even of runs whose folder has gone), so none is left holding a removed folder.
  const programs = lookable(base) ? stopLeftPrograms(base) : 0;
  for (const name of entries(base)) {
    if (!name.startsWith(RUN_PREFIX) || going(name)) continue;
    if (removeFolder(join(base, name)) === null) removed++;
  }
  const socketFolder = `corillo-${userInfo().uid}`; // agent sockets for data folders with long paths: a running Corillo's
  for (const name of entries(temp)) {
    if (!name.startsWith("corillo-") || name.startsWith(RUN_PREFIX) || name === socketFolder || CORILLOS_WORK.test(name)) continue;
    const path = join(temp, name);
    // A downloads or packaging run's work carries its process: cleared once that's gone, never while it runs (Batch 21, C21-5).
    const owner = OWNED.exec(name);
    if (owner) {
      if (!alive(Number(owner[1])) && removeFolder(path) === null) removed++;
      continue;
    }
    const limit = (name.startsWith("corillo-trial") ? TRIAL_MINUTES : LOOSE_MINUTES) * 60_000;
    try {
      if (now - statSync(path).mtimeMs < limit) continue;
    } catch {
      continue;
    }
    if (removeFolder(path) === null) removed++;
  }
  pruneCache(join(temp, `playwright-transform-cache-${userInfo().uid}`), now - CACHE_HOURS * 3_600_000);
  return { folders: removed, programs };
}

/**
 * Playwright keeps every compiled test file in its cache and never removes one, so every worktree and change
 * adds to it (740 MB in two days, Batch 21, C21-8). Its files neither read nor written for a day go: one
 * still wanted is compiled again, in about two seconds for the whole suite. Only files in its own folders; links are left.
 */
function pruneCache(cache: string, before: number): void {
  if (!lookable(cache)) return;
  const list = (dir: string) => {
    try {
      return readdirSync(dir);
    } catch {
      return [];
    }
  };
  for (const name of list(cache)) {
    const dir = join(cache, name);
    try {
      if (!lstatSync(dir).isDirectory()) continue;
    } catch {
      continue;
    }
    for (const file of list(dir)) {
      try {
        const s = lstatSync(join(dir, file));
        if (s.isFile() && Math.max(s.mtimeMs, s.atimeMs) < before) unlinkSync(join(dir, file));
      } catch {
        // gone already, or not ours to remove
      }
    }
    try {
      if (!list(dir).length) rmdirSync(dir);
    } catch {
      // filled again meanwhile
    }
  }
}

/** What a sweep did, in a line, or "" if nothing. */
export function swept({ folders, programs }: { folders: number; programs: number }): string {
  const parts = [
    programs ? `stopped ${programs} ${programs === 1 ? "program" : "programs"} still running` : "",
    folders ? `cleared ${folders} ${folders === 1 ? "folder" : "folders"}` : "",
  ].filter(Boolean);
  return parts.length ? `Earlier test runs: ${parts.join(" and ")} they left.` : "";
}

/** Things named like ours, in the temporary folders, made since a time and outside any run's folder. */
function strays(since: number, places: string[]): string[] {
  const socketFolder = `corillo-${userInfo().uid}`; // agent sockets for data folders with long paths
  const found: string[] = [];
  for (const dir of new Set(places)) {
    if (!lookable(dir)) continue;
    let names: string[] = [];
    try {
      names = readdirSync(dir);
    } catch {
      continue;
    }
    for (const name of names) {
      const ours =
        // Not a downloads or packaging run's own work, named so the sweep knows it (R21-6), nor the installed Corillo's exports (R22-11).
        (name.startsWith("corillo-") && !name.startsWith(RUN_PREFIX) && !name.startsWith("corillo-trial") && name !== socketFolder && !OWNED.test(name) && !CORILLOS_WORK.test(name)) ||
        name.startsWith("playwright-artifacts-");
      if (!ours) continue;
      try {
        if (lstatSync(join(dir, name)).birthtimeMs >= since) found.push(join(dir, name));
      } catch {
        // gone already
      }
    }
  }
  return found;
}

function sizeOf(folder: string): string {
  const kb = Number((spawnSync("/usr/bin/du", ["-sk", folder], { encoding: "utf8" }).stdout ?? "").split("\t")[0]);
  if (!kb) return "";
  return kb >= 1024 * 1024 ? `${(kb / 1024 / 1024).toFixed(1)} GB` : kb >= 1024 ? `${Math.round(kb / 1024)} MB` : `${kb} KB`;
}

export interface Run {
  folder: string;
  /** Remove the run's folder and say what, if anything, was left. Throws if the folder couldn't be removed. */
  end(): void;
}

/** Start a run: its own folder, which this process and everything it starts use as the temporary folder. */
export function startRun(): Run {
  const real = realTemp();
  const said = swept(sweep({ temp: real }));
  if (said) console.log(said);
  const started = Date.now();
  const folder = mkdtempSync(join(RUNS_BASE, `${RUN_PREFIX}${process.pid}-${stampOf(process.pid)}-`));
  // Playwright keeps compiled test files between runs in the temporary folder: keep it where it was.
  process.env.PLAYWRIGHT_TRANSFORM_CACHE_DIR ??= join(real, `playwright-transform-cache-${userInfo().uid}`);
  // What end() puts back: inside another run (the trial's scenarios), that run's folder, not the Mac's own (C21-20).
  const found = { TMPDIR: process.env.TMPDIR, MAC_CHROMIUM_TMPDIR: process.env.MAC_CHROMIUM_TMPDIR, CORILLO_REAL_TMPDIR: process.env.CORILLO_REAL_TMPDIR };
  process.env.CORILLO_REAL_TMPDIR = real;
  process.env.TMPDIR = folder;
  process.env.MAC_CHROMIUM_TMPDIR = folder;
  let ended = false;
  const run: Run = {
    folder,
    end() {
      if (ended) return;
      ended = true;
      // Anything a test started and didn't stop (a Corillo an agent's connector started, say) stops with the run.
      const stopped = stopLeftPrograms(RUNS_BASE, basename(folder));
      if (stopped) console.log(`Stopped ${stopped} ${stopped === 1 ? "program" : "programs"} this run's tests left running.`);
      const spoke = existsSync(join(folder, REAL_SPEECH_MARK));
      const size = sizeOf(folder);
      const problem = existsSync(folder) ? removeFolder(folder) : null;
      for (const [name, value] of Object.entries(found)) {
        if (value === undefined) delete process.env[name];
        else process.env[name] = value;
      }
      if (problem) {
        throw new Error(`Temporary files: this run's folder couldn't be removed and is still there${size ? ` (${size})` : ""}: ${folder}\n${problem}`);
      }
      if (spoke) throw new Error("Real speech was reached while tests ran: a test made Corillo's window ask the Mac to speak. Nothing may speak in a test.");
      const left = strays(started, [real, RUNS_BASE]);
      const removed = `Temporary files: removed this run's folder${size ? ` (${size})` : ""}.`;
      if (!left.length) {
        console.log(`${removed} Nothing of ours was left in the temporary folder.`);
        return;
      }
      // By kind (the name without its random ending), most first, with one example of each.
      const kinds = new Map<string, string[]>();
      for (const p of left) {
        const kind = join(p, "..", basename(p).replace(/-[^-]+$/, "-…"));
        kinds.set(kind, [...(kinds.get(kind) ?? []), p]);
      }
      const shown = [...kinds].sort((a, b) => b[1].length - a[1].length).slice(0, 8);
      const lines = shown.map(([kind, paths]) => `  ${paths.length} × ${kind}${paths.length === 1 ? ` (${basename(paths[0])})` : ""}`);
      if (kinds.size > shown.length) lines.push(`  and ${kinds.size - shown.length} other kinds`);
      console.log(
        [
          `${removed} But ${left.length} new ${left.length === 1 ? "item" : "items"} named like ours appeared in the temporary folder while it ran, outside any run's folder.`,
          "Another copy of the tests running at the same time (another worktree) may have made them. If none was, a test or Corillo is writing outside its run's folder:",
          ...lines,
        ].join("\n"),
      );
    },
  };
  return run;
}

/** Global setup for Playwright and Vitest: the run's folder, removed by the teardown this returns. */
export default function setup(): () => void {
  const run = startRun();
  // A run stopped part way with a signal cleans up too: neither runner runs its teardown on SIGTERM or SIGHUP,
  // nor Vitest on SIGINT (Batch 21, C21-7). Killed outright, the next run's sweep is the net. Only here, for
  // the runners: a script that starts its own runs (the real-agent trial) stops what it started first, in its
  // own handler, and ends its runs there (R21-1).
  const signals: NodeJS.Signals[] = ["SIGTERM", "SIGHUP", ...(process.env.VITEST ? (["SIGINT"] as const) : [])];
  const onSignal = (signal: NodeJS.Signals) => {
    try {
      run.end();
    } catch (err) {
      console.error((err as Error).message);
    }
    process.exit(128 + (osConstants.signals[signal] ?? 0));
  };
  for (const signal of signals) process.on(signal, onSignal);
  return () => {
    for (const signal of signals) process.off(signal, onSignal);
    run.end();
  };
}
