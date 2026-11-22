// Every place a test or script starts Corillo's window gives it a screen
// scale on the command line (ONE_SCALE, or an explicit
// --force-device-scale-factor for the pictures and the bench), so it passes or
// fails the same on any Mac. A launch that forgets it takes the display's
// scale, and a test that clicks between two lines of a paragraph can fail on
// untouched code (Batch 6).
import { describe, expect, it } from "vitest";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, relative, resolve } from "node:path";

const ROOT = join(import.meta.dirname, "..", "..");

function files(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    if (name === "node_modules") return [];
    const path = join(dir, name);
    if (statSync(path).isDirectory()) return files(path);
    return /\.(ts|mts|js|mjs|cjs)$/.test(name) ? [path] : [];
  });
}

/**
 * Each call in a file that starts Corillo: `electron.launch(...)`, or the e2e
 * tests' `launch(...)` helper (helpers.ts, imported as itself or as
 * `launchCorillo`, Batch 19). Where it is, and its whole text, brackets matched.
 */
export function launches(text: string): { line: number; call: string }[] {
  const out: { line: number; call: string }[] = [];
  const helper = /import \{[^}]*\blaunch\b(?! as)[^}]*\} from "\.\/helpers"/.test(text);
  const calls = helper ? /electron\.launch\(|launchCorillo\(|(?<![\w.]|function )launch\(/g : /electron\.launch\(|launchCorillo\(/g;
  for (const m of text.matchAll(calls)) {
    let depth = 0;
    let end = m.index;
    for (let i = m.index + m[0].length - 1; i < text.length; i++) {
      if (text[i] === "(") depth++;
      else if (text[i] === ")" && --depth === 0) {
        end = i + 1;
        break;
      }
    }
    out.push({ line: text.slice(0, m.index).split("\n").length, call: text.slice(m.index, end) });
  }
  return out;
}

const SCALED = /ONE_SCALE|--force-device-scale-factor/;

describe("the screen scale of every launch of Corillo's window", () => {
  it("finds a launch that sets no scale, and passes one that does", () => {
    expect(launches(`await electron.launch({ args: [".", file], env: { A: "1" } });`).map((l) => SCALED.test(l.call))).toEqual([false]);
    expect(launches(`x;\nawait electron.launch({ args: [ONE_SCALE, ".", f(file)] });`)).toEqual([
      { line: 2, call: `electron.launch({ args: [ONE_SCALE, ".", f(file)] })` },
    ]);
    // The e2e tests' helper, by its own name where imported as itself, and as launchCorillo.
    const viaHelper = `import { launch } from "./helpers";\nawait launch({ args: [".", f] });\nawait launchCorillo({ args: [ONE_SCALE, "."] });`;
    expect(launches(viaHelper).map((l) => SCALED.test(l.call))).toEqual([false, true]);
    // A spec's own function named launch (its calls start Corillo through launchCorillo) isn't counted.
    expect(launches(`async function launch(env) {}\nawait launch({ A: "1" });`)).toEqual([]);
  });

  it("every test, picture run, bench and trial sets one on the command line", () => {
    const sites = [join(ROOT, "tests"), join(ROOT, "scripts")]
      .flatMap(files)
      .filter((file) => file !== import.meta.filename) // this file's own examples
      .flatMap((file) => launches(readFileSync(file, "utf8")).map((l) => ({ ...l, where: `${relative(ROOT, file)}:${l.line}` })))
      // The helper hands on what its callers give it, and each of its calls is checked here.
      .filter((s) => !(s.where.startsWith("tests/e2e/helpers.ts:") && s.call === "electron.launch(options)"));
    expect(sites.length).toBeGreaterThan(15); // the scan finds them
    expect(sites.filter((s) => !SCALED.test(s.call)).map((s) => s.where)).toEqual([]);
  });
});

/**
 * Each call in a file that starts a program of Corillo's directly, outside the e2e tests' `launch()`: Playwright's
 * `electron.launch(...)`, or a `spawn`, `fork` or `execFile` (and their Sync forms, also called through a module, as
 * `cp.spawn(`: R22-9) that names Electron or the connector. Where it is, and its whole text.
 */
export function directStarts(text: string): { line: number; call: string }[] {
  return programStarts(text).filter((s) => s.call.startsWith("electron.launch(") || CORILLO.test(s.call));
}

/** A call that names Electron or the connector starts Corillo. */
const CORILLO = /electron|CONNECTOR|mcp\.cjs/i;

/**
 * Each `electron.launch(...)`, `spawn`, `fork`, `execFile` or `exec` call (their Sync forms, through a module too) in a
 * file, whatever program it starts: where it is, and its whole text. A regular expression's `.exec(` isn't one; `exec`
 * through a module is, by the module's usual names (review of Batch 24, R24-8).
 */
function programStarts(text: string): { line: number; call: string }[] {
  const out: { line: number; call: string }[] = [];
  const STARTS = /electron\.launch\(|(?<!\w)(?:spawn|spawnSync|fork|execFile|execFileSync|execSync)\(|(?<![\w.])exec\(|\b(?:cp|childProcess|child_process)\.exec\(/g;
  for (const m of text.matchAll(STARTS)) {
    let depth = 0;
    let end = m.index;
    for (let i = m.index + m[0].length - 1; i < text.length; i++) {
      if (text[i] === "(") depth++;
      else if (text[i] === ")" && --depth === 0) {
        end = i + 1;
        break;
      }
    }
    out.push({ line: text.slice(0, m.index).split("\n").length, call: text.slice(m.index, end) });
  }
  return out;
}

/**
 * `open -a`, as words in a command or as the program and its first argument
 * (Batch 24, item 6: R23-9). It asks the Mac to start an app by its name: the
 * installed Corillo, his real one, in front, with his own home and settings,
 * whatever the test hands it (the Mac starts the app, not the test, so no
 * throwaway surroundings reach it). No test may do that, guarded or not.
 */
const OPEN_APP = /\bopen\s+(?:-\w+\s+)*-a\b|["'`]open["'`]\s*,\s*\[\s*(?:["'`]-\w+["'`]\s*,\s*)*["'`]-a["'`]/g;

/**
 * A start of `open` by any of its forms: it asks the Mac to start an app, by its id (-b) or by the file it hands it
 * (`open plan.md` starts his own Corillo on it), as much as by its name (review of Batch 24, R24-8).
 */
const OPEN_PROGRAM = /^[\w.]+\(\s*["'`](?:\/usr\/bin\/)?open(?:["'`]|\s)/;

function openApps(text: string): { line: number; call: string }[] {
  const found = new Map<number, { line: number; call: string }>();
  for (const m of text.matchAll(OPEN_APP)) {
    const line = text.slice(0, m.index).split("\n").length;
    if (!found.has(line)) found.set(line, { line, call: m[0] });
  }
  for (const s of programStarts(text)) if (OPEN_PROGRAM.test(s.call) && !found.has(s.line)) found.set(s.line, s);
  return [...found.values()].sort((a, b) => a.line - b.line);
}

/**
 * Programs the tests run that aren't Corillo, by the program a call names
 * first, each with why it's let through without throwawayStart (Batch 24,
 * item 6: R23-9). None of them is Corillo, none can start it, and none
 * reads his home or Corillo's data folder: they read or make the test's own
 * files in its temporary folder, or ask the Mac about a process the test
 * started. A program not on this list, a variable holding Corillo's
 * packaged program included, must go through the guard.
 */
const NOT_CORILLO: [RegExp, string][] = [
  [/^"(?:\/bin\/)?ps"$/, "lists running processes, to find the test's own Corillo and what it left running"],
  [/^"lsof"$/, "asks which folder a process the test started is working in"],
  [/^"(?:\/usr\/bin\/)?unzip"$/, "reads the parts of a Word document a test exported"],
  [/^"git"$/, "reads this checkout's own history and settings (commit, author name) for the build's facts"],
  [/^"\/usr\/sbin\/scutil"$/, "reads the Mac's name, to check nothing the test makes carries it"],
  [/^"\/usr\/bin\/du"$/, "measures the size of the test's own data folder"],
  [/^"\/usr\/bin\/footprint"$/, "measures the memory of a process the test started"],
  // Only as JavaScript naming no application: see letThrough (review of Batch 24, R24-8).
  [/^"\/usr\/bin\/osascript"$/, "reads a PDF's words with the Mac's PDF reader (PDFKit), as a script: no app is opened"],
  [/^"openssl"$/, "makes a throwaway certificate for the tests' own local picture server"],
  [/^"sips"$/, "reads or makes a test picture's size and format"],
  [/^"(?:\/usr\/bin\/)?pkill"$|^"pgrep"$/, "finds or stops the test's own stand-in programs by a marker of the test's"],
  [/^"plutil"$/, "reads the built app's Info.plist"],
  [/^"ditto"$|^"cp"$/, "copies the built app into the test's temporary folder"],
  [/^"iconutil"$/, "unpacks the app's icon to check its sizes"],
  [/^"codesign"$/, "checks the built app's signature; runs nothing in it"],
  [/^"lipo"$/, "reads which Macs a built program is for"],
  [/^"hdiutil"$/, "opens the built disk image read-only, hidden from Finder (-nobrowse), and closes it"],
  [/^pandoc$/, "the bundled Pandoc, asked its version"],
];

/** Node itself, running one of this folder's own scripts or checking a file's syntax, is let through too. */
const OWN_SCRIPT = /^(?:execFileSync|spawnSync)\(process\.execPath, \[(?:join\(ROOT, "scripts", "(?:fetch-pandoc|package-mac)\.mjs"\)|join\(import\.meta\.dirname, "\.\.", "\.\.", "scripts", "fetch-pandoc\.mjs"\)|"--check", \w+\])/;

/** Why a start that skips the guard is let through, or "" when it isn't. */
function letThrough(call: string): string {
  if (call.startsWith("electron.launch(") || CORILLO.test(call)) return "";
  if (OWN_SCRIPT.test(call)) return "Node, running this folder's own script or checking a file's syntax";
  // A shell command can run anything, so none is let through by its first word (review of Batch 24, R24-8).
  if (/^(?:[\w.]+\.)?exec(?:Sync)?\(/.test(call)) return "";
  const program = /^[\w.]+\(\s*([^,)]+)/.exec(call)?.[1].trim() ?? "";
  // osascript can tell any app to start or come to the front: only as JavaScript, naming no application (R24-8).
  if (/osascript/.test(program) && (!/["'`]-l["'`]\s*,\s*["'`]JavaScript["'`]/.test(call) || /application/i.test(call))) return "";
  return NOT_CORILLO.find(([named]) => named.test(program))?.[1] ?? "";
}

/** A start whose surroundings pass through `throwawayStart` (helpers.ts): hidden, a throwaway data folder, a stand-in home. */
const GUARDED = /\bthrowawayStart\(/;

/**
 * The folders under tests/ the start scan reads: the end-to-end tests, and every other harness that starts Corillo,
 * the pictures, the bench, the package tests and the rehearsal (R22-9; Batch 23, item 3).
 */
const SCANNED = ["e2e", "pictures", "bench", "package", "rehearsal"];

/**
 * Each start in those folders under `root`, as file:line, with whether it
 * goes through the guard: every program a test starts there (Batch 24, item
 * 6), and every `open -a` or start of `open`; and in tests/unit, every start
 * of Corillo or its connector, and every `open -a` or start of `open`. A start
 * of another program that is let through says why (NOT_CORILLO); an `open`
 * never is.
 */
function startsIn(root: string): { where: string; guarded: boolean; why?: string; opensApp?: true }[] {
  const inFolder = (dir: string) => (existsSync(join(root, "tests", dir)) ? files(join(root, "tests", dir)) : []);
  const at = (file: string) => (s: { line: number; call: string }) => ({ ...s, where: `${relative(root, file)}:${s.line}` });
  const opened = (file: string, text: string) => openApps(text).map(at(file)).map((s) => ({ where: s.where, guarded: false, opensApp: true as const }));
  const scanned = SCANNED.flatMap(inFolder).flatMap((file) => {
    const text = readFileSync(file, "utf8");
    const starts = programStarts(text)
      .map(at(file))
      // launch() itself: it guards what it hands on (tests/unit/launch-guard.test.ts).
      .filter((s) => !(s.where.startsWith("tests/e2e/helpers.ts:") && s.call === "electron.launch(options)"))
      .map((s) => {
        if (GUARDED.test(s.call)) return { where: s.where, guarded: true };
        const why = letThrough(s.call);
        return why ? { where: s.where, guarded: false, why } : { where: s.where, guarded: false };
      });
    return [...starts, ...opened(file, text)];
  });
  const unit = inFolder("unit")
    .filter((file) => resolve(file) !== resolve(import.meta.filename)) // this file's own examples
    .flatMap((file) => {
      const text = readFileSync(file, "utf8");
      const starts = directStarts(text)
        .map(at(file))
        .map((s) => ({ where: s.where, guarded: GUARDED.test(s.call) }));
      return [...starts, ...opened(file, text)];
    });
  return [...scanned, ...unit];
}

describe("every start of Corillo in the tests, the pictures, the bench, the package tests and the rehearsal is hidden, on throwaway folders, with a stand-in home (Batch 22, item 4: C21-1, C21-T1; Batch 23, item 3)", () => {
  it("finds a start that skips the guard, and passes one that goes through it", () => {
    const starts = (text: string) => directStarts(text).map((s) => GUARDED.test(s.call));
    expect(starts(`spawn(ELECTRON, [CONNECTOR], { env: { ...process.env, CORILLO_USER_DATA: dataDir, CORILLO_HIDDEN: "1" } });`)).toEqual([false]);
    expect(starts(`spawn(electronPath, [ONE_SCALE, "."], { env: throwawayStart({ ...process.env, CORILLO_USER_DATA: d }) });`)).toEqual([true]);
    expect(starts(`await electron.launch({ args: [ONE_SCALE, "."], env: throwawayStart(env) });`)).toEqual([true]);
    // Called through the module's name too (R22-9).
    expect(starts(`cp.spawn(ELECTRON, [CONNECTOR], {});`)).toEqual([false]);
    expect(starts(`childProcess.execFileSync(ELECTRON, ["."], { env: throwawayStart(env) });`)).toEqual([true]);
    // The packaged app's own program, run as Node for the connector (the package tests, the rehearsal).
    expect(starts(`spawn(BINARY, [server], { env: { ...process.env, ELECTRON_RUN_AS_NODE: "1" } });`)).toEqual([false]);
    // Other programs a test runs aren't Corillo's.
    expect(starts(`execFileSync("/usr/bin/du", ["-sk", dir]); spawnSync("ps", ["-A"]);`)).toEqual([]);
  });

  it("lets another program through only by name, with why, and never one that names Corillo or holds its program in a variable (Batch 24, item 6)", () => {
    expect(letThrough(`execFileSync("unzip", ["-p", docx, "word/document.xml"], { encoding: "utf8" })`)).toBe("reads the parts of a Word document a test exported");
    expect(letThrough(`spawnSync("/usr/bin/du", ["-sk", run.dataDir], { encoding: "utf8" })`)).toBe("measures the size of the test's own data folder");
    expect(letThrough(`execFileSync(process.execPath, ["--check", driver])`)).toBe("Node, running this folder's own script or checking a file's syntax");
    // The packaged program in a variable, Node running the connector, a program not named, and one named but given Corillo.
    for (const call of [
      `spawn(BINARY, [server], { env: { ...process.env } })`,
      `spawnSync(binary, ["--version"])`,
      `spawn(process.execPath, [connector], { env: { ...process.env } })`,
      `spawn(process.execPath, [join(ROOT, "scripts", "other.mjs")])`,
      `execFileSync("/usr/local/bin/something", [])`,
      `execFileSync("ditto", [ELECTRON, copy])`,
      `execFileSync("open", ["-a", "Corillo", file])`,
      // osascript only as JavaScript naming no application (review of Batch 24, R24-8).
      `execFileSync("/usr/bin/osascript", ["-e", 'tell application "Corillo" to activate'])`,
      `execFileSync("/usr/bin/osascript", ["-l", "JavaScript", "-e", 'Application("Corillo").activate()'])`,
      // A shell command can run anything: never let through by name (R24-8).
      `execSync("du -sk /tmp/x")`,
    ])
      expect(letThrough(call), call).toBe("");
    expect(letThrough(`execFileSync("/usr/bin/osascript", ["-l", "JavaScript", "-e", script, file], { encoding: "utf8" })`)).not.toBe("");
  });

  it("finds open -a, in a command's words or as a program and its argument", () => {
    const found = (text: string) => openApps(text).map((s) => s.line);
    expect(found(`execSync("open -a Corillo plan.md");`)).toEqual([1]);
    expect(found(`x;\nspawn("open", ["-a", "/Applications/Corillo.app", file]);`)).toEqual([2]);
    expect(found(`execFileSync('open', ['-g', '-a', 'Corillo']);`)).toEqual([1]);
    expect(found(`await clickMenu(run.app, "open"); status: "open", ["-all"]`)).toEqual([]);
    expect(found(`execFileSync("lsof", ["-a", "-p", pid]); open a file`)).toEqual([]);
    // Any start of open, not just -a: by the app's id, or a file the Mac hands to its app (review of Batch 24, R24-8).
    expect(found(`execSync("open -b io.github.oneillo.corillo");`)).toEqual([1]);
    expect(found(`x;\nexecSync("open plan.md");`)).toEqual([2]);
    expect(found(`spawn("/usr/bin/open", ["-b", id]);`)).toEqual([1]);
    expect(found(`cp.exec(\`open \${file}\`);`)).toEqual([1]);
    // A regular expression's exec isn't a start.
    expect(found(`/open (\\w+)/.exec(text); OPEN.exec("open plan.md")`)).toEqual([]);
  });

  it("reaches the pictures, the bench, the package tests and the rehearsal, and finds a start there that skips the guard", () => {
    const root = mkdtempSync(join(tmpdir(), "corillo-start-scan-"));
    try {
      const put = (rel: string, text: string) => {
        mkdirSync(join(root, rel, ".."), { recursive: true });
        writeFileSync(join(root, rel), text);
      };
      put("tests/pictures/studio.ts", `x;\nawait electron.launch({ args: [ONE_SCALE, "."], env: { ...process.env, CORILLO_HIDDEN: "1" } });`);
      put("tests/bench/measure.ts", `cp.spawn(ELECTRON, [CONNECTOR], {});\nawait electron.launch({ args: ["."], env: throwawayStart(env) });`);
      put("tests/package/package.spec.ts", `spawnSync(BINARY, [probe], { env: { ...process.env, ELECTRON_RUN_AS_NODE: "1" } });`);
      put("tests/rehearsal/app-id.spec.ts", `spawn(app, [join(dist, "mcp.cjs")], { env: throwawayStart({ ...env, ELECTRON_RUN_AS_NODE: "1" }) });`);
      // Batch 24, item 6: the packaged program in a variable, open -a, and other programs, let through only by name.
      put("tests/package/binary.spec.ts", `const BINARY = join(APP, "Contents", "MacOS", "Corillo");\nspawn(BINARY, [server], { env: { ...process.env } });\nexecFileSync("unzip", ["-Z1", file]);\nexecFileSync("/usr/local/bin/something", []);`);
      put("tests/e2e/open-app.spec.ts", `x;\nexecFileSync("open", ["-a", "Corillo", file]);`);
      // tests/unit, for starts of Corillo or its connector, and open -a; other programs there aren't asked about.
      put("tests/unit/other.test.ts", `cp.spawn(ELECTRON, [CONNECTOR], {});\nexecSync("open -a Corillo");\nexecFileSync("unzip", ["-p", f]);\nspawn(process.execPath, [connector], { env: throwawayStart({ ...process.env, CORILLO_USER_DATA: d }) });`);
      // Review of Batch 24, R24-8: a shell command, osascript naming an app, and open without -a, here and in tests/unit.
      put("tests/e2e/shell.spec.ts", `execSync("ls " + dir);\nexecFileSync("/usr/bin/osascript", ["-e", 'tell application "Corillo" to activate']);\nexecSync("open plan.md");`);
      put("tests/unit/open-id.test.ts", `spawn("open", ["-b", id]);\nexecSync(\`\${ELECTRON} .\`);`);
      expect(startsIn(root)).toEqual([
        { where: "tests/e2e/open-app.spec.ts:2", guarded: false },
        { where: "tests/e2e/open-app.spec.ts:2", guarded: false, opensApp: true },
        { where: "tests/e2e/shell.spec.ts:1", guarded: false },
        { where: "tests/e2e/shell.spec.ts:2", guarded: false },
        { where: "tests/e2e/shell.spec.ts:3", guarded: false },
        { where: "tests/e2e/shell.spec.ts:3", guarded: false, opensApp: true },
        { where: "tests/pictures/studio.ts:2", guarded: false },
        { where: "tests/bench/measure.ts:1", guarded: false },
        { where: "tests/bench/measure.ts:2", guarded: true },
        { where: "tests/package/binary.spec.ts:2", guarded: false },
        { where: "tests/package/binary.spec.ts:3", guarded: false, why: "reads the parts of a Word document a test exported" },
        { where: "tests/package/binary.spec.ts:4", guarded: false },
        { where: "tests/package/package.spec.ts:1", guarded: false },
        { where: "tests/rehearsal/app-id.spec.ts:1", guarded: true },
        { where: "tests/unit/open-id.test.ts:2", guarded: false },
        { where: "tests/unit/open-id.test.ts:1", guarded: false, opensApp: true },
        { where: "tests/unit/other.test.ts:1", guarded: false },
        { where: "tests/unit/other.test.ts:4", guarded: true },
        { where: "tests/unit/other.test.ts:2", guarded: false, opensApp: true },
      ]);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("each end-to-end test starts Corillo through launch(), and every other start of Electron or the connector, there and in the other harnesses and in tests/unit, goes through the guard; any other program there is one named with why, and nothing uses open -a", () => {
    const sites = startsIn(ROOT);
    // The scan finds them.
    expect([...new Set(sites.map((s) => s.where.replace(/:\d+$/, "")))]).toEqual(
      expect.arrayContaining([
        "tests/e2e/agent-session.ts",
        "tests/e2e/leaks.spec.ts",
        "tests/pictures/studio.ts",
        "tests/bench/measure.ts",
        "tests/package/package.spec.ts",
        // The rehearsal stays private: the public copy has no tests/rehearsal.
        ...(existsSync(join(ROOT, "tests", "rehearsal")) ? ["tests/rehearsal/app-id.spec.ts"] : []),
        "tests/unit/connector-and-socket.test.ts",
        "tests/unit/connector-version.test.ts",
        "tests/unit/agent-tool-log.test.ts",
      ]),
    );
    expect(sites.filter((s) => !s.guarded && !s.why).map((s) => s.where)).toEqual([]);
  });
});
