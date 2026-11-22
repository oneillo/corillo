// Corillo on a Mac that isn't its author's (roadmap Batch 13, item 3). Every
// test gives the app a made-up home folder with nothing in it, as both HOME
// and the agent tools' home, a fresh data folder, and only the Mac's own
// programs on the PATH: no Homebrew, no Node, no agent tool, nobody's
// settings. Corillo still opens, says which agent tools it works with, edits,
// comments, opens a Word document and exports to Word and PDF with the Pandoc
// inside it. And the window, Help and About name nothing of whoever runs the
// tests: their user name, home folder, the Mac's name or their git name and
// email, all read here as the tests run, so no file carries them.
import { test, expect, type ElectronApplication, type Page } from "@playwright/test";
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, writeFileSync } from "node:fs";
import { homedir, hostname, tmpdir, userInfo } from "node:os";
import { join } from "node:path";
import { clickMenu, cursorAtEnd, openFromFinder, selectText, settle, EDITOR, ONE_SCALE, launch as launchCorillo } from "./helpers";
import { makeDocx } from "../fixtures/make-docx";
import { ownWords, runnerPatterns } from "./runner-names";

const ROOT = join(import.meta.dirname, "..", "..");

test.beforeAll(() => {
  test.setTimeout(600_000);
  execFileSync(process.execPath, [join(ROOT, "scripts", "fetch-pandoc.mjs"), `--arch=${process.arch}`], { stdio: "inherit" });
});

interface Stranger {
  app: ElectronApplication;
  page: Page;
  home: string;
  /** What the app wrote on its error output so far. */
  errors: () => string;
  /** Where the app itself is, read as it starts. */
  places: string[];
}

/** Start Corillo as on a stranger's Mac. Leave out `seenBefore` for its first launch there. */
async function launch(options: { seenBefore?: boolean } = {}): Promise<Stranger> {
  const home = mkdtempSync(join(tmpdir(), "corillo-home-"));
  mkdirSync(join(home, "Documents"));
  const dataDir = mkdtempSync(join(tmpdir(), "corillo-data-"));
  if (options.seenBefore) writeFileSync(join(dataDir, "setup.json"), '{ "connectAgentsOffered": true }\n');
  // Only what any Mac has, and the test run's own temporary folder.
  const env: Record<string, string> = {
    HOME: home,
    CORILLO_HOME: home,
    PATH: "/usr/bin:/bin:/usr/sbin:/sbin",
    CORILLO_USER_DATA: dataDir,
    CORILLO_HIDDEN: "1",
  };
  for (const name of ["TMPDIR", "MAC_CHROMIUM_TMPDIR", "CORILLO_REAL_TMPDIR"]) if (process.env[name]) env[name] = process.env[name]!;
  const { app } = await launchCorillo({ args: [ONE_SCALE, "."], env });
  let errors = "";
  app.process().stderr?.on("data", (chunk: Buffer) => (errors += chunk.toString()));
  const page = await app.firstWindow();
  await page.setViewportSize({ width: 1100, height: 860 });
  await page.waitForSelector("#empty");
  const places = await app.evaluate(({ app: a }) => [process.execPath, a.getAppPath()]);
  return { app, page, home, errors: () => errors, places };
}

let runners: RegExp[] | undefined;

/** Whoever runs these tests, as their Mac knows them (runner-names.ts). */
function runnersNames(): RegExp[] {
  if (runners) return runners;
  const git = (key: string) => {
    try {
      return execFileSync("git", ["-C", ROOT, "config", key], { encoding: "utf8" }).trim();
    } catch {
      return "";
    }
  };
  let computer = "";
  try {
    computer = execFileSync("/usr/sbin/scutil", ["--get", "ComputerName"], { encoding: "utf8" }).trim();
  } catch {
    // Not every Mac answers; the host name still counts.
  }
  const runner = { username: userInfo().username, host: hostname(), computer, gitName: git("user.name"), email: git("user.email"), home: homedir() };
  return (runners = runnerPatterns(runner, ownWords(ROOT)));
}

/**
 * Text shown to the person, with the app's own place taken out: where the app
 * is (here, this checkout; on a stranger's Mac, their Applications folder) is
 * shown on purpose, in Help's settings for connecting by hand.
 */
function withoutAppPlace(places: string[], text: string): string {
  const all = new Set<string>();
  for (const p of [...places, ROOT]) {
    all.add(p);
    if (existsSync(p)) all.add(realpathSync(p));
  }
  // The longest first, so a place inside another is taken out whole.
  for (const p of [...all].sort((a, b) => b.length - a.length)) text = text.split(p).join("<the app>");
  // Help's settings write the app's program as JSON, where a path's slashes may be escaped.
  for (const p of [...all].sort((a, b) => b.length - a.length)) text = text.split(p.replaceAll("/", "\\/")).join("<the app>");
  return text;
}

function expectNoneOfTheRunner(run: Stranger, text: string, where: string): void {
  const shown = withoutAppPlace(run.places, text);
  for (const name of runnersNames()) expect(shown, `${where} shows ${name}`).not.toMatch(name);
}

const connectBox = (page: Page) => page.getByRole("dialog", { name: "Connect your agents" });
// Claude Desktop first, with what to do, the rest under Other tools (roadmap Batch 25, item 2).
const NONE_FOUND = [
  "To work with an AI agent, Corillo needs an agent tool: an app where you chat with the agent. There isn't one on this Mac yet.",
  "Claude Desktop",
  "The Claude app for Mac. Install it and sign in.",
  "Other tools",
  "Claude Code, Codex, Cursor, VS Code, Gemini CLI, GitHub Copilot CLI.",
  "Once you've installed one, open Connect your agents again, on the start screen or with Help > Connect Agents…, to connect it. Using a different agent tool? Connect it by hand.",
];

test("the first launch on a Mac with no agent tool: the Connect box says which tools Corillo works with, and how to connect another by hand", async () => {
  const run = await launch();
  const box = connectBox(run.page);
  await expect(box).toBeVisible();
  await expect(box.locator(".agent-row")).toHaveCount(0);
  await expect(box.locator(".agent-none > *")).toHaveText(NONE_FOUND);
  await expect(box.locator(".connect-intro")).toHaveText("Corillo works with the AI agents you already use. Connect one here, then ask it to open a document in Corillo.");
  // Nothing about moving Corillo first, and nothing wrong with agents' connection.
  await expect(box.locator(".connect-move")).toBeHidden();
  await expect(box.locator(".connect-problem")).toBeHidden();
  await expect(box.getByRole("button", { name: "Connect by hand…" })).toBeVisible();
  expectNoneOfTheRunner(run, await run.page.locator("body").innerText(), "The window");

  // Done leaves the start screen, as on any Mac.
  await box.getByRole("button", { name: "Done" }).click();
  await expect(box).toBeHidden();
  await expect(run.page.getByRole("button", { name: "Open a document…" })).toBeVisible();
  await run.app.close();
  expectNoneOfTheRunner(run, run.errors(), "The app's error output");
});

test("a document written in and commented on, then exported to Word and to PDF with the Pandoc inside Corillo", async () => {
  test.setTimeout(120_000);
  const run = await launch({ seenBefore: true });
  const file = join(run.home, "Documents", "Garden plan.md");
  writeFileSync(file, "# Garden plan\n\nWe plant tomatoes in May.\n");
  await openFromFinder(run.app, file);
  await expect(run.page.locator(`${EDITOR} h1`)).toHaveText("Garden plan");

  // Written in: saved by itself.
  await cursorAtEnd(run.page, "We plant tomatoes");
  await run.page.keyboard.type(" Beans follow in June.");
  await expect.poll(() => readFileSync(file, "utf8")).toBe("# Garden plan\n\nWe plant tomatoes in May. Beans follow in June.\n");

  // Commented on: the card shows, and the file stays as it was.
  await selectText(run.page, "Beans");
  await run.page.getByRole("button", { name: "Comment", exact: true }).click();
  const box = run.page.getByRole("textbox", { name: "New comment" });
  await expect(box).toBeFocused();
  await box.fill("Which kind?");
  await run.page.getByRole("button", { name: "Post" }).click();
  await expect(run.page.locator(".doc:not([hidden]) .comment-card:not(.draft)", { hasText: "Which kind?" })).toBeVisible();
  await expect(run.page.locator(`${EDITOR} .comment-range`)).toHaveText("Beans");
  await settle(run.page);
  expect(readFileSync(file, "utf8")).toBe("# Garden plan\n\nWe plant tomatoes in May. Beans follow in June.\n");

  // Exported to Word and to PDF, each where the person chose.
  for (const [item, name] of [["export-word", "Garden plan.docx"], ["export-pdf", "Garden plan.pdf"]] as const) {
    const out = join(run.home, "Documents", name);
    await run.app.evaluate(({ dialog }, chosen) => {
      dialog.showSaveDialog = (async () => ({ canceled: false, filePath: chosen })) as typeof dialog.showSaveDialog;
    }, out);
    await clickMenu(run.app, item);
    await expect(run.page.locator(".export-notice")).toContainText(`Exported to ${name}`, { timeout: 60_000 });
    await expect(run.page.locator(".export-notice")).not.toContainText(/couldn't|can't|wrong/i);
  }
  const word = execFileSync("/usr/bin/unzip", ["-p", join(run.home, "Documents", "Garden plan.docx"), "word/document.xml"], { encoding: "utf8" });
  expect(word).toContain("Beans follow in June.");
  expect(readFileSync(join(run.home, "Documents", "Garden plan.pdf")).subarray(0, 5).toString("latin1")).toBe("%PDF-");

  expectNoneOfTheRunner(run, await run.page.locator("body").innerText(), "The window");
  await run.app.close();
  expectNoneOfTheRunner(run, run.errors(), "The app's error output");
});

test("a Word document opens as a Markdown copy beside it, made by the Pandoc inside Corillo", async () => {
  test.setTimeout(90_000);
  const run = await launch({ seenBefore: true });
  const word = join(run.home, "Documents", "Offsite notes.docx");
  writeFileSync(word, makeDocx());
  const before = readFileSync(word);
  await run.app.evaluate(({ dialog }) => {
    const g = globalThis as unknown as { asked: string[] };
    g.asked = [];
    dialog.showMessageBox = (async (...args: unknown[]) => {
      const o = args.find((a) => typeof a === "object" && a !== null && "message" in a) as { message: string; buttons?: string[] };
      g.asked.push(o.message);
      return { response: Math.max(0, (o.buttons ?? []).indexOf("Make a Copy")), checkboxChecked: false };
    }) as unknown as typeof dialog.showMessageBox;
  });
  await openFromFinder(run.app, word);

  await expect(run.page.locator(`${EDITOR} h2`)).toHaveText("Who");
  expect(await run.app.evaluate(() => (globalThis as unknown as { asked: string[] }).asked)).toEqual([
    "Corillo works on a copy of Offsite notes.docx, saved next to it as Offsite notes.md.",
  ]);
  await expect(run.page.locator(`${EDITOR} li`)).toHaveText(["Book the venue", "Send the agenda"]);
  expect(readFileSync(join(run.home, "Documents", "Offsite notes.md"), "utf8")).toContain("at the lake house");
  expect(readFileSync(word).equals(before)).toBe(true);
  await expect(run.page.locator(".doc:not([hidden]) .file-notice:not([hidden]) .export-notice-text")).toHaveText("Made from Offsite notes.docx.");

  expectNoneOfTheRunner(run, await run.page.locator("body").innerText(), "The window");
  await run.app.close();
  expectNoneOfTheRunner(run, run.errors(), "The app's error output");
});

test("Help and About name nothing of whoever runs Corillo; Help's settings for connecting by hand use the made-up home", async () => {
  const run = await launch({ seenBefore: true });

  const [help] = await Promise.all([run.app.waitForEvent("window"), clickMenu(run.app, "corillo-help")]);
  await help.waitForSelector(".help-page:not([hidden])");
  // Every page, shown or not.
  const helpText = await help.evaluate(() => document.body.textContent ?? "");
  expect(helpText).toContain("Connecting an agent by hand");
  expectNoneOfTheRunner(run, helpText, "Help");
  // Each tool's settings file is named from the home folder, written as ~.
  await help.getByRole("navigation").getByRole("link", { name: "Connecting an agent by hand" }).click();
  await expect(help.getByText("~/.claude.json", { exact: false }).first()).toBeVisible();
  expect(helpText).not.toContain(run.home);

  const aboutOpened = run.app.waitForEvent("window");
  await clickMenu(run.app, "about");
  const about = await aboutOpened;
  await about.waitForSelector("body[data-ready]");
  // Pandoc, inside Corillo, is found and named.
  await expect(about.locator("#pandoc")).toBeVisible();
  // The licences' own texts are left out: Corillo's names its copyright holder, as its author chose.
  const aboutText = await about.evaluate(() => {
    const copy = document.body.cloneNode(true) as HTMLElement;
    for (const pre of copy.querySelectorAll("pre.about-text")) pre.remove();
    return copy.textContent ?? "";
  });
  expect(aboutText).toContain("A Markdown editor for writing documents together with AI agents.");
  expectNoneOfTheRunner(run, aboutText, "About");

  await run.app.close();
  expectNoneOfTheRunner(run, run.errors(), "The app's error output");
});
