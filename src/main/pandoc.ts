// Pandoc: the separate program, bundled with Corillo, that makes Word
// documents. In the packaged app it sits in the app's resources
// (pandoc/<processor>/pandoc); while developing, in vendor/pandoc/ (fetched
// by `npm run fetch-pandoc`).
import { app } from "electron";
import { spawn, type ChildProcess } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { ExportError, macTooOldForWord, PANDOC_MISSING, pandocLocation, WORD_NEEDS_NEWER_MAC } from "./export-prep";

/** Darwin's release number for this Mac. The tests can set another, to stand for an older macOS. */
const darwinRelease = () => process.env.CORILLO_DARWIN_RELEASE || os.release();

/** Whether Pandoc can run on this Mac: it needs a later macOS than Corillo does. */
export const wordWorksHere = () => !macTooOldForWord(darwinRelease());

/** The Pandoc program to run. Throws a plain explanation if this Mac is too old for it, or it's missing. */
export function pandocPath(): string {
  if (!wordWorksHere()) throw new ExportError(WORD_NEEDS_NEWER_MAC);
  const file = pandocLocation({
    packaged: app.isPackaged,
    resourcesPath: process.resourcesPath,
    appPath: app.getAppPath(),
    arch: process.arch,
  });
  try {
    fs.accessSync(file, fs.constants.X_OK);
  } catch {
    throw new ExportError(PANDOC_MISSING);
  }
  return file;
}

export interface RunFailure extends Error {
  stderr?: string;
  code?: string | number;
  killed?: boolean;
}

/** Programs running for an export now, each the first of its own group (see run). */
const running = new Set<ChildProcess>();

const stopGroup = (child: ChildProcess, signal: NodeJS.Signals) => {
  try {
    if (child.pid) process.kill(-child.pid, signal);
  } catch {
    // the group has ended
  }
};

/** Stop every program an export started, for when Corillo quits. */
export function stopAllPrograms(): void {
  for (const child of running) stopGroup(child, "SIGKILL");
  running.clear();
}

const MAX_OUTPUT = 32 * 1024 * 1024;

/**
 * Run a program and wait for it; fails with its error output. It runs in a
 * group of its own, so stopping it (after `timeoutMs`) stops whatever it
 * started too, and it's made to stop if it hasn't after `graceMs` more. When
 * it ends, anything it left running goes with it: an export leaves no
 * program behind. It always comes back.
 */
export function run(
  file: string,
  args: string[],
  options: { cwd: string; timeoutMs: number; env?: NodeJS.ProcessEnv; graceMs?: number },
): Promise<{ stdout: string; stderr: string }> {
  return new Promise((resolve, reject) => {
    const child = spawn(file, args, { cwd: options.cwd, env: options.env ?? process.env, detached: true, stdio: ["ignore", "pipe", "pipe"] });
    running.add(child);
    const out: Buffer[] = [];
    const err: Buffer[] = [];
    let size = 0;
    let killed = false;
    let done = false;
    let exit: { code: number | null; signal: NodeJS.Signals | null } | null = null;
    const timers: NodeJS.Timeout[] = [];
    const finish = (failure?: Error & { code?: string | number }) => {
      if (done) return;
      done = true;
      timers.forEach(clearTimeout);
      running.delete(child);
      stopGroup(child, "SIGKILL"); // whatever it left running
      child.stdout?.destroy();
      child.stderr?.destroy();
      const stdout = Buffer.concat(out).toString("utf8");
      const stderr = Buffer.concat(err).toString("utf8");
      const name = path.basename(file);
      if (failure) reject(Object.assign(failure, { stderr, killed }));
      else if (killed) reject(Object.assign(new Error(`${name} took too long and was stopped.`), { stderr, killed, signal: exit?.signal }));
      else if (exit && exit.code !== 0) {
        const message = exit.code === null ? `${name} was stopped (${exit.signal}).` : `${name} stopped with exit code ${exit.code}.`;
        reject(Object.assign(new Error(message), { stderr, killed, code: exit.code ?? undefined }));
      } else resolve({ stdout, stderr });
    };
    const keep = (into: Buffer[]) => (chunk: Buffer) => {
      size += chunk.length;
      if (size <= MAX_OUTPUT) into.push(chunk);
    };
    child.stdout?.on("data", keep(out));
    child.stderr?.on("data", keep(err));
    child.on("error", (e) => finish(e));
    child.on("exit", (code, signal) => {
      exit = { code, signal };
      // Its output ends when it does, unless something it started holds it open: don't wait for that.
      timers.push(setTimeout(() => finish(), 250));
    });
    child.on("close", () => finish());
    timers.push(
      setTimeout(() => {
        killed = true;
        stopGroup(child, "SIGTERM");
        timers.push(setTimeout(() => {
          stopGroup(child, "SIGKILL");
          timers.push(setTimeout(() => finish(), 250));
        }, options.graceMs ?? 3_000));
      }, options.timeoutMs),
    );
  });
}
