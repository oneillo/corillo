// The script or app run on a finished Word document, and stopping programs
// that take too long: the program chosen for each kind of script, an app
// opened with the document, and nothing left running after a stop.
import { describe, it, expect, afterEach } from "vitest";
import { execFileSync, spawnSync } from "node:child_process";
import { chmodSync, mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { scriptCommand } from "../../src/main/export-prep";
import { run, type RunFailure } from "../../src/main/pandoc";

const dir = mkdtempSync(join(tmpdir(), "corillo-scripts-"));
const docx = "/Users/me/Q3 proposal.docx";

describe("the program a script is run with (EX-7)", () => {
  it("an app chosen as the program opens the Word document in that app", () => {
    const word = join(dir, "Microsoft Word.app");
    mkdirSync(join(word, "Contents", "MacOS"), { recursive: true });
    expect(scriptCommand(word, docx)).toEqual({ file: "/usr/bin/open", args: ["-a", word, docx] });
  });

  it("an executable runs itself; scripts run by their kind; JavaScript on Corillo's own engine", () => {
    const tool = join(dir, "touch-up");
    writeFileSync(tool, "#!/bin/sh\n");
    chmodSync(tool, 0o755);
    expect(scriptCommand(tool, docx)).toEqual({ file: tool, args: [docx] });
    expect(scriptCommand(join(dir, "fix.sh"), docx)).toEqual({ file: "/bin/sh", args: [join(dir, "fix.sh"), docx] });
    expect(scriptCommand(join(dir, "fix.rb"), docx)).toEqual({ file: "ruby", args: [join(dir, "fix.rb"), docx] });
    expect(scriptCommand(join(dir, "fix.js"), docx)).toEqual({ file: process.execPath, args: [join(dir, "fix.js"), docx], node: true });
  });

  it("a Python or JavaScript script made executable still runs by its kind: Python never through macOS's stand-in, JavaScript on Corillo's own engine (R-EX-8)", () => {
    const none = { pathDirs: [join(dir, "empty")], developerDir: () => null };
    for (const [name, line] of [["exec.py", "#!/usr/bin/env python3\n"], ["exec.js", "#!/usr/bin/env node\n"], ["exec.sh", "#!/bin/zsh\n"]]) {
      writeFileSync(join(dir, name), line);
      chmodSync(join(dir, name), 0o755);
    }
    expect(scriptCommand(join(dir, "exec.py"), docx, none)).toEqual({
      problem: "The script exec.py needs Python, which isn't installed on this Mac, so it wasn't run.",
    });
    expect(scriptCommand(join(dir, "exec.js"), docx, none)).toEqual({ file: process.execPath, args: [join(dir, "exec.js"), docx], node: true });
    // A shell script made executable runs itself, by its own first line (zsh here).
    expect(scriptCommand(join(dir, "exec.sh"), docx, none)).toEqual({ file: join(dir, "exec.sh"), args: [docx] });
  });

  it("a kind Corillo doesn't know is explained in plain words", () => {
    const result = scriptCommand(join(dir, "notes.txt"), docx);
    expect(result).toEqual({
      problem: "Corillo doesn't know how to run notes.txt, so it wasn't run. Choose an app, or a script ending in .py, .sh, .js or .rb.",
    });
    expect(JSON.stringify(result)).not.toMatch(/executable/i);
  });

  it("a Python script uses an installed Python, and says so plainly when there's none, rather than asking macOS to install developer tools (EX-12)", () => {
    const script = join(dir, "fix.py");
    const none = { pathDirs: [join(dir, "empty")], developerDir: () => null };
    expect(scriptCommand(script, docx, none)).toEqual({
      problem: "The script fix.py needs Python, which isn't installed on this Mac, so it wasn't run.",
    });
    const brew = join(dir, "brew-bin");
    mkdirSync(brew);
    writeFileSync(join(brew, "python3"), "#!/bin/sh\n");
    chmodSync(join(brew, "python3"), 0o755);
    expect(scriptCommand(script, docx, { pathDirs: ["/usr/bin", brew], developerDir: () => null })).toEqual({ file: join(brew, "python3"), args: [script, docx] });
    // Apple's own python3 works once its developer tools are installed.
    const tools = join(dir, "CommandLineTools");
    mkdirSync(join(tools, "usr", "bin"), { recursive: true });
    writeFileSync(join(tools, "usr", "bin", "python3"), "");
    expect(scriptCommand(script, docx, { pathDirs: ["/usr/bin"], developerDir: () => tools })).toEqual({ file: "/usr/bin/python3", args: [script, docx] });
  });
});

/** Whether a program whose command line holds this marker is still running. */
function stillRunning(marker: string): boolean {
  try {
    return execFileSync("pgrep", ["-f", marker], { encoding: "utf8" }).trim() !== "";
  } catch {
    return false;
  }
}

describe("a program stopped for taking too long (EX-8)", () => {
  // Should stopping them break, a failing test still leaves nothing running (a stubborn loop, an hour's sleep).
  const markers: string[] = [];
  afterEach(() => {
    for (const marker of markers.splice(0)) spawnSync("/usr/bin/pkill", ["-9", "-f", marker]);
  });
  /** Wait until no program holding this marker is running, for as long as a busy Mac may take. */
  const gone = (marker: string) => expect.poll(() => stillRunning(marker), { timeout: 5_000 }).toBe(false);

  it("is stopped with everything it started, and the export carries on", async () => {
    const marker = `sleep 4${Math.floor(Math.random() * 900 + 100)}`;
    markers.push(marker);
    const script = join(dir, "hand-off.sh");
    writeFileSync(script, `${marker.replace("sleep", "/bin/sleep")} &\nwait\n`);
    const started = Date.now();
    const failure = (await run("/bin/sh", [script], { cwd: dir, timeoutMs: 500, graceMs: 500 }).catch((e) => e)) as RunFailure;
    expect(failure.killed).toBe(true);
    expect(Date.now() - started).toBeLessThan(3_000);
    await gone(marker);
  });

  it("a program that ignores being asked to stop is made to, and the export always comes back", async () => {
    const marker = `corillo-stubborn-${Date.now()}`;
    markers.push(marker);
    const script = join(dir, "stubborn.sh");
    writeFileSync(script, `trap '' TERM\n# ${marker}\nwhile true; do /bin/sleep 1; done\n`);
    const started = Date.now();
    const failure = (await run("/bin/sh", [script, marker], { cwd: dir, timeoutMs: 500, graceMs: 500 }).catch((e) => e)) as RunFailure;
    expect(failure.killed).toBe(true);
    expect(Date.now() - started).toBeLessThan(4_000);
    await gone(marker);
  });

  it("a program that finishes but leaves something running in the background doesn't leave it", async () => {
    const marker = `sleep 5${Math.floor(Math.random() * 900 + 100)}`;
    markers.push(marker);
    const script = join(dir, "leaves.sh");
    writeFileSync(script, `${marker.replace("sleep", "/bin/sleep")} &\necho done\n`);
    const started = Date.now();
    const { stdout } = await run("/bin/sh", [script], { cwd: dir, timeoutMs: 10_000, graceMs: 500 });
    expect(stdout.trim()).toBe("done");
    expect(Date.now() - started).toBeLessThan(3_000);
    await gone(marker);
  });

  it("still reports a program's error and exit, and a program that isn't there", async () => {
    const failure = (await run("/bin/sh", ["-c", "echo nope >&2; exit 3"], { cwd: dir, timeoutMs: 5_000 }).catch((e) => e)) as RunFailure;
    expect(failure.killed).toBeFalsy();
    expect(failure.stderr).toBe("nope\n");
    expect(failure.code).toBe(3);
    const missing = (await run(join(dir, "no-such-program"), [], { cwd: dir, timeoutMs: 5_000 }).catch((e) => e)) as RunFailure;
    expect(missing.code).toBe("ENOENT");
  });
});
