// Connecting agent tools with one click, and the Help pages. Every test runs
// with a stand-in home folder holding pretend agent settings.
import { test, expect, type ElectronApplication, type Page } from "@playwright/test";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { captureClipboard, clickMenu, ONE_SCALE, launch as launchCorillo } from "./helpers";

interface Launched {
  app: ElectronApplication;
  page: Page;
  dataDir: string;
}

function fakeHome(files: Record<string, string> = {}): string {
  const home = mkdtempSync(join(tmpdir(), "corillo-home-"));
  for (const [rel, text] of Object.entries(files)) {
    mkdirSync(join(home, rel, ".."), { recursive: true });
    writeFileSync(join(home, rel), text);
  }
  return home;
}

/** Start Corillo with no document open. Leave out `seenBefore` for a first run. */
async function launch(home: string, options: { dataDir?: string; seenBefore?: boolean } = {}): Promise<Launched> {
  const dataDir = options.dataDir ?? mkdtempSync(join(tmpdir(), "corillo-data-"));
  if (options.seenBefore) writeFileSync(join(dataDir, "setup.json"), '{ "connectAgentsOffered": true }\n');
  const { app } = await launchCorillo({
    args: [ONE_SCALE, "."],
    env: { ...process.env, CORILLO_USER_DATA: dataDir, CORILLO_HIDDEN: "1", CORILLO_HOME: home },
  });
  const page = await app.firstWindow();
  await page.waitForSelector("#empty");
  return { app, page, dataDir };
}

/** How this copy of Corillo starts its MCP server. */
async function launchDetails(app: ElectronApplication): Promise<{ command: string; script: string }> {
  const { command, appPath } = await app.evaluate(({ app: a }) => ({ command: process.execPath, appPath: a.getAppPath() }));
  return { command, script: join(appPath, "dist", "mcp.cjs") };
}

const screen = (page: Page) => page.getByRole("dialog", { name: "Connect your agents" });
const claudeCodeFile = ".claude.json";
const claudeCodeSettings = '{\n  "numStartups": 3,\n  "theme": "dark"\n}\n';

test("the first time Corillo opens, it offers to connect the agent tools it finds", async () => {
  const home = fakeHome({ [claudeCodeFile]: claudeCodeSettings });
  const run = await launch(home);
  await expect(screen(run.page)).toBeVisible();
  await expect(screen(run.page).locator(".agent-row")).toHaveCount(1);
  await expect(screen(run.page).locator(".agent-row")).toContainText("Claude Code");
  await expect(screen(run.page)).toContainText("Not found on this Mac: Claude Desktop, Codex, Cursor");

  await run.page.getByRole("button", { name: "Connect Claude Code" }).click();
  // Set up: Connected once a Claude Code session reaches Corillo (first-launch.spec.ts).
  await expect(screen(run.page).locator(".agent-set-up")).toHaveText("Ready");
  await expect(screen(run.page)).toContainText("Now start a new Claude Code session.");

  const { command, script } = await launchDetails(run.app);
  const saved = JSON.parse(readFileSync(join(home, claudeCodeFile), "utf8"));
  expect(saved).toEqual({
    numStartups: 3,
    theme: "dark",
    mcpServers: { corillo: { type: "stdio", command, args: [script], env: { ELECTRON_RUN_AS_NODE: "1" } } },
  });
  expect(readFileSync(join(home, `${claudeCodeFile}.before-corillo`), "utf8")).toBe(claudeCodeSettings);

  await run.page.getByRole("button", { name: "Done" }).click();
  await expect(screen(run.page)).toBeHidden();
  await run.app.close();

  // The next time, Corillo opens straight to the start screen.
  const again = await launch(home, { dataDir: run.dataDir });
  await expect(again.page.getByRole("button", { name: "Open a document…" })).toBeVisible();
  await again.page.waitForTimeout(400);
  await expect(screen(again.page)).toBeHidden();
  await again.app.close();
});

// Last look of Batch 12, L-5: after Done the keyboard was nowhere.
test("after Done, the keyboard goes back where it was: on Open a document at first launch, on the link that opened it", async () => {
  const home = fakeHome({ [claudeCodeFile]: claudeCodeSettings });
  const run = await launch(home);
  const { page } = run;
  const on = () => page.evaluate(() => {
    const a = document.activeElement as HTMLElement | null;
    return !a || a === document.body ? "nowhere" : (a.getAttribute("aria-label") || a.textContent || "").trim();
  });
  await expect(screen(page)).toBeVisible();
  await expect.poll(on).toBe("Done");
  await page.keyboard.press("Enter");
  await expect(screen(page)).toBeHidden();
  await expect.poll(on).toBe("Open a document…");
  // Opened again from the start screen's link with the keyboard: Done brings it back to the link.
  const link = page.locator("#connect-agents-link");
  await link.focus();
  const name = await on();
  await page.keyboard.press("Enter");
  await expect(screen(page)).toBeVisible();
  await expect.poll(on).toBe("Done");
  await page.keyboard.press("Enter");
  await expect(screen(page)).toBeHidden();
  await expect.poll(on).toBe(name);
  await run.app.close();
});

test("Help > Connect Agents reopens the screen, and Disconnect puts the settings back", async () => {
  const home = fakeHome({ [claudeCodeFile]: claudeCodeSettings });
  const run = await launch(home, { seenBefore: true });
  await run.page.waitForTimeout(300);
  await expect(screen(run.page)).toBeHidden();

  await clickMenu(run.app, "connect-agents");
  await expect(screen(run.page)).toBeVisible();
  await run.page.getByRole("button", { name: "Connect Claude Code" }).click();
  await expect(screen(run.page).locator(".agent-set-up")).toHaveText("Ready");
  await run.page.getByRole("button", { name: "Done" }).click();

  // Reopened, it reads the settings again and shows Claude Code as set up.
  await clickMenu(run.app, "connect-agents");
  await expect(screen(run.page).locator(".agent-set-up")).toHaveText("Ready");
  await run.page.getByRole("button", { name: "Disconnect Claude Code" }).click();
  await expect(run.page.getByRole("button", { name: "Connect Claude Code" })).toBeVisible();
  expect(readFileSync(join(home, claudeCodeFile), "utf8")).toBe(claudeCodeSettings);
  await run.app.close();
});

test("the start screen links to the screen, which says when it can't read a tool's settings", async () => {
  const broken = '{ "mcpServers": { "notes": ';
  const home = fakeHome({ ".cursor/mcp.json": broken });
  mkdirSync(join(home, "Applications", "Claude.app"), { recursive: true });
  const run = await launch(home, { seenBefore: true });
  await run.page.getByRole("button", { name: "Connect your agents" }).click();
  await expect(screen(run.page)).toBeVisible();
  await expect(screen(run.page).locator(".agent-row .agent-title")).toHaveText(["Claude Desktop", "Cursor"]);
  const cursor = screen(run.page).locator('.agent-row[data-tool="cursor"]');
  await expect(cursor).toContainText("Can't read its settings");
  await expect(cursor).toContainText("left them as they were");

  await run.page.getByRole("button", { name: "Connect Claude Desktop" }).click();
  await expect(screen(run.page)).toContainText("Now quit Claude Desktop (Command-Q) and open it again.");
  const desktop = join(home, "Library", "Application Support", "Claude", "claude_desktop_config.json");
  expect(JSON.parse(readFileSync(desktop, "utf8")).mcpServers.corillo.env).toEqual({ ELECTRON_RUN_AS_NODE: "1" });
  expect(readFileSync(join(home, ".cursor/mcp.json"), "utf8")).toBe(broken);
  expect(existsSync(join(home, ".cursor/mcp.json.before-corillo"))).toBe(false);
  await run.app.close();
});

test("at launch, a tool still pointing at a copy of Corillo that's gone is put right, keeping the original, and the corner says so (MP-2)", async () => {
  const gone = "/Volumes/Corillo/Corillo.app/Contents";
  const left = {
    numStartups: 3,
    mcpServers: { corillo: { type: "stdio", command: `${gone}/MacOS/Corillo`, args: [`${gone}/Resources/app.asar.unpacked/dist/mcp.cjs`], env: { ELECTRON_RUN_AS_NODE: "1" } } },
  };
  const original = JSON.stringify(left, null, 2) + "\n";
  const home = fakeHome({ [claudeCodeFile]: original });
  const run = await launch(home, { seenBefore: true });
  const { command, script } = await launchDetails(run.app);
  await expect
    .poll(() => JSON.parse(readFileSync(join(home, claudeCodeFile), "utf8")).mcpServers.corillo, { timeout: 10_000 })
    .toEqual({ type: "stdio", command, args: [script], env: { ELECTRON_RUN_AS_NODE: "1" } });
  expect(JSON.parse(readFileSync(join(home, claudeCodeFile), "utf8")).numStartups).toBe(3);
  expect(readFileSync(join(home, `${claudeCodeFile}.before-corillo`), "utf8")).toBe(original);
  await expect(run.page.locator(".file-notice")).toContainText("Corillo has moved, so it updated its connection in Claude Code.");
  await expect(run.page.locator(".file-notice")).toContainText("Start a new Claude Code session to see Corillo.");
  await run.app.close();
});

test("run from the disk image, the screen asks to move Corillo to Applications first and holds back Connect (MP-2)", async () => {
  const home = fakeHome({ [claudeCodeFile]: claudeCodeSettings });
  const run = await launch(home, { seenBefore: true });
  // As if opened from the disk image: where macOS says Corillo's program is.
  await run.app.evaluate(() => {
    (process as { execPath: string }).execPath = "/Volumes/Corillo/Corillo.app/Contents/MacOS/Corillo";
  });
  await clickMenu(run.app, "connect-agents");
  await expect(screen(run.page)).toBeVisible();
  await expect(screen(run.page)).toContainText("Move Corillo to your Applications folder first, and open it from there.");
  await expect(screen(run.page).locator(".agent-row")).toContainText("Claude Code");
  await expect(run.page.getByRole("button", { name: "Connect Claude Code" })).toHaveCount(0);
  // Asked anyway, it refuses, and the settings stay as they were.
  const result = await run.page.evaluate(() => window.corillo.agents.connect("claude-code"));
  expect(result.result.ok).toBe(false);
  expect(readFileSync(join(home, claudeCodeFile), "utf8")).toBe(claudeCodeSettings);
  await run.app.close();
});

// The notice is for a window that's there: it never makes one of its own (R-MAIN-11).
test("closed straight after launch, Corillo still puts a moved connection right, and no window comes back to say so", async () => {
  const gone = "/Volumes/Corillo/Corillo.app/Contents";
  const left = { mcpServers: { corillo: { type: "stdio", command: `${gone}/MacOS/Corillo`, args: [`${gone}/Resources/app.asar.unpacked/dist/mcp.cjs`], env: { ELECTRON_RUN_AS_NODE: "1" } } } };
  const home = fakeHome({ [claudeCodeFile]: JSON.stringify(left, null, 2) + "\n" });
  const run = await launch(home, { seenBefore: true });
  const { command } = await launchDetails(run.app);
  await run.app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].close());
  await expect.poll(() => run.app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows().length)).toBe(0);
  await expect.poll(() => JSON.parse(readFileSync(join(home, claudeCodeFile), "utf8")).mcpServers.corillo.command, { timeout: 15_000 }).toBe(command);
  await new Promise((r) => setTimeout(r, 500));
  expect(await run.app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows().length)).toBe(0);
  await run.app.close();
});

test("with no agent tool on this Mac, the screen names Claude Desktop first, with what to do, and the others under Other tools (UX-9)", async () => {
  const run = await launch(fakeHome(), { seenBefore: true });
  await clickMenu(run.app, "connect-agents");
  await expect(screen(run.page)).toBeVisible();
  await expect(screen(run.page).locator(".agent-row")).toHaveCount(0);
  const none = screen(run.page).locator(".agent-none");
  await expect(none.locator(".agent-none-what")).toHaveText(
    "To work with an AI agent, Corillo needs an agent tool: an app where you chat with the agent. There isn't one on this Mac yet.",
  );
  // Claude Desktop first, with what to do (roadmap Batch 25, item 2: the planning session's call).
  const first = none.getByRole("heading", { level: 3, name: "Claude Desktop" });
  await expect(first).toBeVisible();
  await expect(none.locator(".agent-first-what")).toHaveText("The Claude app for Mac. Install it and sign in.");
  // The rest under Other tools, after it: the same tools as before, none added.
  const others = none.getByRole("heading", { level: 3, name: "Other tools" });
  await expect(others).toBeVisible();
  await expect(none.locator(".agent-others")).toHaveText("Claude Code, Codex, Cursor, VS Code, Gemini CLI, GitHub Copilot CLI.");
  expect((await first.boundingBox())!.y).toBeLessThan((await others.boundingBox())!.y);
  await expect(none.locator(".agent-none-then")).toHaveText(
    "Once you've installed one, open Connect your agents again, on the start screen or with Help > Connect Agents…, to connect it. Using a different agent tool? Connect it by hand.",
  );
  // Nothing to connect: no Connect or Update button for a tool that isn't there.
  expect(await screen(run.page).getByRole("button").allTextContents()).toEqual(["Connect by hand…", "Done"]);
  await expect(screen(run.page).locator(".agent-missing")).toBeHidden();
  await run.app.close();
});

test("with a tool found, the screen names no tool first and has no Other tools: the rows, then what isn't on this Mac", async () => {
  const run = await launch(fakeHome({ [claudeCodeFile]: claudeCodeSettings }), { seenBefore: true });
  await clickMenu(run.app, "connect-agents");
  await expect(screen(run.page).locator(".agent-row")).toHaveCount(1);
  await expect(screen(run.page).locator(".agent-none")).toBeHidden();
  await expect(screen(run.page).getByRole("heading", { name: "Other tools" })).toHaveCount(0);
  await expect(screen(run.page).locator(".agent-missing")).toHaveText(
    "Not found on this Mac: Claude Desktop, Codex, Cursor, VS Code, Gemini CLI, GitHub Copilot CLI.",
  );
  expect(await screen(run.page).getByRole("button").allTextContents()).toEqual(["Connect", "Connect by hand…", "Done"]);
  await run.app.close();
});

/** Every file and folder under `root`, with its size and when it last changed. */
function snapshot(root: string): Record<string, string> {
  const out: Record<string, string> = {};
  const walk = (dir: string) => {
    for (const name of readdirSync(dir)) {
      const at = join(dir, name);
      const s = statSync(at);
      out[at.slice(root.length)] = s.isDirectory() ? "folder" : `${s.size} ${s.mtimeMs}`;
      if (s.isDirectory()) walk(at);
    }
  };
  walk(root);
  return out;
}

test("the first view of Connect writes no agent tool's settings, found or not: only its Connect button does", async () => {
  for (const files of <Record<string, string>[]>[
    {},
    {
      "Applications/Claude.app/Contents/Info.plist": "<plist/>\n",
      ".codex/config.toml": 'model = "o3"\n',
      ".cursor/mcp.json": '{ "mcpServers": {} }\n',
      ".gemini/settings.json": '{ "theme": "Default" }\n',
      ".copilot/mcp-config.json": '{ "mcpServers": {} }\n',
    },
  ]) {
    const home = fakeHome(files);
    const before = snapshot(home);
    const run = await launch(home);
    await expect(screen(run.page)).toBeVisible();
    await run.page.waitForTimeout(400);
    await run.page.getByRole("button", { name: "Done" }).click();
    await expect(screen(run.page)).toBeHidden();
    await run.app.close();
    expect(snapshot(home)).toEqual(before);
  }
});

test("when agents can't reach Corillo, the screen says so in one plain line", async () => {
  const dataDir = mkdtempSync(join(tmpdir(), "corillo-data-"));
  // Where Corillo keeps the agents' connection is taken by a file, so it can't set it up.
  writeFileSync(join(dataDir, "sockets"), "Not a folder.\n");
  const run = await launch(fakeHome({ [claudeCodeFile]: claudeCodeSettings }), { dataDir, seenBefore: true });
  await clickMenu(run.app, "connect-agents");
  await expect(screen(run.page)).toBeVisible();
  const problem = screen(run.page).locator(".connect-problem");
  await expect(problem).toHaveText("Agents can't reach Corillo: it couldn't set up their connection. Quit Corillo and open it again.");
  await expect(problem).toHaveAttribute("role", "alert");
  await run.app.close();
});

test("with agents' connection set up, the screen shows no problem line", async () => {
  const run = await launch(fakeHome({ [claudeCodeFile]: claudeCodeSettings }), { seenBefore: true });
  await clickMenu(run.app, "connect-agents");
  await expect(screen(run.page).locator(".agent-row")).toHaveCount(1);
  await expect(screen(run.page).locator(".connect-problem")).toBeHidden();
  await run.app.close();
});

test("Help shows how to connect each tool by hand, with Corillo's real locations, and Copy puts it on the clipboard", async () => {
  const home = fakeHome();
  const run = await launch(home, { seenBefore: true });
  const copied = await captureClipboard(run.app);
  const [help] = await Promise.all([run.app.waitForEvent("window"), clickMenu(run.app, "corillo-help")]);
  await help.waitForSelector("#start:not([hidden])");
  await expect(help.getByRole("heading", { name: "Getting started" })).toBeVisible();

  await help.getByRole("navigation").getByRole("link", { name: "Working with an agent" }).click();
  await expect(help.getByRole("heading", { name: "Point it at a document" })).toBeVisible();
  await expect(help.locator("#agents")).toContainText("Open this in Corillo:");

  await help.getByRole("navigation").getByRole("link", { name: "Connecting an agent by hand" }).click();
  const { command, script } = await launchDetails(run.app);
  const desktop = help.locator('.manual-tool[data-tool="claude-desktop"]');
  await expect(desktop.locator("code")).toHaveText("~/Library/Application Support/Claude/claude_desktop_config.json");
  await expect(desktop.locator("pre")).toContainText(JSON.stringify(command));
  await expect(desktop.locator("pre")).toContainText(JSON.stringify(script));
  await expect(desktop).toContainText("Quit and reopen Claude Desktop");

  await help.getByRole("button", { name: "Copy the Claude Desktop settings" }).click();
  await expect(help.getByRole("button", { name: "Copy the Claude Desktop settings" })).toHaveText("Copied");
  expect(JSON.parse(await copied())).toEqual({
    mcpServers: { corillo: { command, args: [script], env: { ELECTRON_RUN_AS_NODE: "1" } } },
  });

  await help.getByRole("button", { name: "Copy where Claude Desktop keeps its settings" }).click();
  expect(await copied()).toBe(join(home, "Library", "Application Support", "Claude", "claude_desktop_config.json"));

  await expect(help.locator('.manual-tool[data-tool="codex"] pre')).toContainText("[mcp_servers.corillo]");
  await help.getByRole("button", { name: "Copy the details for another tool" }).click();
  expect(await copied()).toContain(`Command: ${command}`);

  // Help > Connect Agents from the Help window brings up the screen in the main window.
  await help.getByRole("navigation").getByRole("link", { name: "Getting started" }).click();
  await help.getByRole("button", { name: "Connect your agents" }).click();
  await expect(screen(run.page)).toBeVisible();
  await run.app.close();
});

test("run from the disk image, Help's connect-by-hand page asks to move Corillo to Applications first, in place of settings that would break (MP-2)", async () => {
  const run = await launch(fakeHome(), { seenBefore: true });
  const copied = await captureClipboard(run.app);
  await run.app.evaluate(() => {
    (process as { execPath: string }).execPath = "/Volumes/Corillo/Corillo.app/Contents/MacOS/Corillo";
  });
  const [help] = await Promise.all([run.app.waitForEvent("window"), clickMenu(run.app, "corillo-help")]);
  await help.waitForSelector("#start:not([hidden])");
  await help.getByRole("navigation").getByRole("link", { name: "Connecting an agent by hand" }).click();
  const page = help.locator("#manual");
  await expect(page.locator(".manual-move").first()).toHaveText(
    "Move Corillo to your Applications folder first, and open it from there. Settings copied from here now would point at this copy of Corillo, which won't be there later.",
  );
  await expect(page).not.toContainText("/Volumes/");
  await expect(page.locator("pre:visible")).toHaveCount(0);
  await expect(page.getByRole("button", { name: /^Copy the / })).toHaveCount(0);
  // Asked anyway, nothing that would break is copied.
  expect(await help.evaluate(() => (window as unknown as { corilloHelp: { agents: { copy(id: string): Promise<boolean> } } }).corilloHelp.agents.copy("codex"))).toBe(false);
  expect(await help.evaluate(() => (window as unknown as { corilloHelp: { agents: { copy(id: string): Promise<boolean> } } }).corilloHelp.agents.copy("other"))).toBe(false);
  expect(await copied()).toBe("");
  await run.app.close();
});
