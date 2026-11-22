// Step 5: agents. A pretend agent tool runs Corillo's connector and speaks MCP
// to it, while the real app runs on a throwaway data folder.
import { test, expect, type Page } from "@playwright/test";
import { execFileSync } from "node:child_process";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openText, cursorAtEnd, settle, tabState, clickMenu, EDITOR, type Running } from "./helpers";
import { AgentSession } from "./agent-session";

const PLAN = "# Plan\n\nWe should hire two people this quarter.\n\n## Budget\n\nThe budget is tight.\n";

/** The person's notes in front, and a plan for agents to work on next to it. */
async function setUp(): Promise<{ run: Running; plan: string; sessions: AgentSession[] }> {
  const run = await openText("My own notes.\n", { name: "notes.md" });
  const plan = join(run.folder, "plan.md");
  writeFileSync(plan, PLAN);
  return { run, plan, sessions: [] };
}

async function connect(run: Running, sessions: AgentSession[], client = "claude-code"): Promise<AgentSession> {
  const { session } = await AgentSession.start(run.dataDir, client);
  sessions.push(session);
  return session;
}

async function tearDown(run: Running, sessions: AgentSession[]): Promise<void> {
  await run.app.close();
  await Promise.all(sessions.map((s) => s.stop()));
}

const docIdOf = (page: Page, name: string) => page.locator(`.tab[title$="/${name}"]`).getAttribute("data-doc-id");

/** The person leaves a comment, as the comments panel would. */
async function personComments(page: Page, docName: string, body: string, to: string | null = null): Promise<void> {
  const id = await docIdOf(page, docName);
  await page.evaluate(
    async ({ id, body, to }) => {
      const r = await window.corillo.addComment(id!, body, null, to);
      if (!r.ok) throw new Error(r.error);
    },
    { id, body, to },
  );
}

const notice = (page: Page, docId: string | null) => page.locator(`.doc[data-doc-id="${docId}"] .agent-notice`);
const dot = (page: Page, name: string) => page.locator(`.tab[title$="/${name}"]`).locator(".tab-dot");

test("an agent connecting as Claude Code is offered Corillo's tools and how to work with the person", async () => {
  const { run, sessions } = await setUp();
  const { session, init } = await AgentSession.start(run.dataDir, "claude-code");
  sessions.push(session);
  expect(init.serverInfo).toMatchObject({ name: "corillo" });
  expect(String(init.instructions)).toContain("take_document");
  const { tools } = (await session.request("tools/list")) as { tools: { name: string }[] };
  expect(tools.map((t) => t.name)).toContain("take_document");
  expect(tools.map((t) => t.name)).toContain("finish_editing");
  await tearDown(run, sessions);
});

test("an agent opens a document in a background tab, and the person's tab stays in front", async () => {
  const { run, plan, sessions } = await setUp();
  const claude = await connect(run, sessions);
  expect(await claude.ok("open_document", { path: plan })).toContain("plan.md is open in Corillo, in a background tab");
  await expect.poll(() => tabState(run.page)).toEqual({ names: ["notes.md", "plan.md"], active: "notes.md" });
  await tearDown(run, sessions);
});

// Changed 2026-11-10 (roadmap Batch 3, item 3; D3): a comment with no @ goes to the agent that picks it up first, and a new chat is plain Claude.
test("a second Claude is Claude 2 while the first is in a round and gets only comments directed at it; a comment with no @ goes to the first to pick it up", async () => {
  const { run, plan, sessions } = await setUp();
  await run.page.evaluate(() => {
    const w = window as unknown as { agentsSeen: Record<string, string[]> };
    w.agentsSeen = {};
    window.corillo.onAgentsChanged((id, agents) => (w.agentsSeen[id] = agents.map((a) => a.name)));
  });
  const claude = await connect(run, sessions);
  await claude.ok("take_document", { path: plan }); // editing: in a round
  const claude2 = await connect(run, sessions);
  expect(await claude2.ok("open_document", { path: plan })).toContain("Your comments there show as Claude 2.");
  await claude.ok("finish_editing", { path: plan });
  // The window knows both, so the person can direct a comment at either.
  const planId = await docIdOf(run.page, "plan.md");
  await expect
    .poll(() => run.page.evaluate((id) => (window as unknown as { agentsSeen: Record<string, string[]> }).agentsSeen[id!], planId))
    .toEqual(["Claude", "Claude 2"]);

  await personComments(run.page, "plan.md", "Make the intro friendlier.");
  await personComments(run.page, "plan.md", "Claude 2: check the budget numbers.", "Claude 2");
  const forClaude2 = await claude2.ok("list_comments", { path: plan });
  expect(forClaude2).toContain("check the budget numbers");
  expect(forClaude2).toContain("Make the intro friendlier."); // it looked first
  const forClaude = await claude.ok("list_comments", { path: plan });
  expect(forClaude).not.toContain("check the budget numbers");
  expect(forClaude).not.toContain("Make the intro friendlier.");
  await tearDown(run, sessions);
});

test("while an agent edits, the tab says so and the person can't type; finishing hands it back with a dot", async () => {
  const { run, plan, sessions } = await setUp();
  const { page } = run;
  const claude = await connect(run, sessions);
  await claude.ok("open_document", { path: plan });
  await personComments(page, "plan.md", "Three people, not two.");

  const taken = await claude.ok("take_document", { path: plan });
  expect(taken).toContain("You're editing plan.md now.");
  expect(taken).toContain("Three people, not two.");
  expect(taken).toContain("We should hire two people this quarter.");
  const commentId = /\[([0-9a-f]{8,})\]/.exec(taken)![1];

  // The person looks: a calm notice, and typing does nothing.
  const planId = await docIdOf(page, "plan.md");
  await page.locator('.tab[title$="/plan.md"]').click();
  await expect(notice(page, planId)).toBeVisible();
  await expect(notice(page, planId)).toContainText("Claude is editing");
  await expect(notice(page, planId).getByRole("button", { name: "Take over" })).toBeVisible();
  await expect(page.getByRole("button", { name: "Bold" })).toBeDisabled();
  await page.locator(`${EDITOR} p`, { hasText: "hire two" }).click();
  await settle(page);
  await page.keyboard.type("TYPED");
  await page.waitForTimeout(600);
  expect(readFileSync(plan, "utf8")).toBe(PLAN);
  await expect(page.locator(EDITOR)).not.toContainText("TYPED");

  // The agent's edit appears in the tab and in the file.
  await claude.ok("edit_document", { path: plan, edits: [{ find: "hire two people", replace: "hire three people" }] });
  await expect(page.locator(`${EDITOR} p`, { hasText: "hire three people" })).toBeVisible();
  expect(readFileSync(plan, "utf8")).toBe(PLAN.replace("two people", "three people"));
  expect(await claude.ok("reply_to_comment", { path: plan, comment_id: commentId, text: "Changed to three." })).toContain("Replied");

  // The person goes back to their notes; the agent finishes.
  await page.locator('.tab[title$="/notes.md"]').click();
  expect(await claude.ok("finish_editing", { path: plan })).toContain("plan.md is back with the person");
  await expect(dot(page, "plan.md")).toBeVisible();
  await expect(dot(page, "notes.md")).toBeHidden();
  await expect(notice(page, planId)).toBeHidden();

  // Looking at the tab clears the dot, and the person can type again.
  await page.locator('.tab[title$="/plan.md"]').click();
  await expect(dot(page, "plan.md")).toBeHidden();
  await cursorAtEnd(page, "this quarter.");
  await page.keyboard.type(" Soon.");
  await expect.poll(() => readFileSync(plan, "utf8")).toContain("this quarter. Soon.");
  await tearDown(run, sessions);
});

test("an agent's comment card and its editing notice use the same colour, even when its own colour was taken", async () => {
  const { run, plan, sessions } = await setUp();
  const { page } = run;
  // Claude and Claude 2 arrive first, so Codex can't have its usual colour.
  const claude = await connect(run, sessions);
  await claude.ok("open_document", { path: plan });
  const claude2 = await connect(run, sessions);
  await claude2.ok("open_document", { path: plan });
  const codex = await connect(run, sessions, "codex-mcp-client");
  await codex.ok("open_document", { path: plan });
  await personComments(page, "plan.md", "Codex, please check the numbers.", "Codex");
  const taken = await codex.ok("take_document", { path: plan });
  const commentId = /\[([0-9a-f]{8,})\]/.exec(taken)![1];
  await codex.ok("reply_to_comment", { path: plan, comment_id: commentId, text: "Checked: they add up." });

  const planId = await docIdOf(page, "plan.md");
  await page.locator('.tab[title$="/plan.md"]').click();
  await expect(notice(page, planId)).toContainText("Codex is editing");
  // The coquí before "Codex is editing" (roadmap Batch 9, item 13; a round swatch before) is in the agent's colour.
  const swatch = notice(page, planId).locator(".coqui-frog");
  const avatar = page
    .locator(`.doc[data-doc-id="${planId}"] .comment-message`, { hasText: "Checked: they add up." })
    .locator(".comment-avatar");
  await expect(avatar).toHaveText("C");
  const colour = await swatch.getAttribute("data-colour");
  expect(colour).toMatch(/^(peach|sky|mint|lilac|ochre|rose)$/);
  await expect(avatar).toHaveAttribute("data-colour", colour!);
  const painted = (l: typeof swatch) => l.evaluate((e) => getComputedStyle(e).backgroundColor);
  expect(await painted(avatar)).toBe(await swatch.locator(".frog-body").evaluate((e) => getComputedStyle(e).fill));
  // Claude has peach and Claude 2 has sky, Codex's usual colour, so Codex has another.
  expect(["peach", "sky"]).not.toContain(colour);
  await tearDown(run, sessions);
});

test("another agent waits while one is editing, and gets the document when it finishes", async () => {
  const { run, plan, sessions } = await setUp();
  const { page } = run;
  const claude = await connect(run, sessions);
  const codex = await connect(run, sessions, "codex-mcp-client");
  await claude.ok("take_document", { path: plan });
  const waiting = codex.call("take_document", { path: plan });
  const planId = await docIdOf(page, "plan.md");
  await expect(notice(page, planId)).toContainText("Claude is editing");
  await page.waitForTimeout(500);
  await claude.ok("finish_editing", { path: plan });
  const taken = await waiting;
  expect(taken.isError).toBe(false);
  expect(taken.text).toContain("You're editing plan.md now.");
  await expect(notice(page, planId)).toContainText("Codex is editing");
  await tearDown(run, sessions);
});

test("a take_document cancelled while it waits never takes the document later, and isn't answered", async () => {
  const { run, plan, sessions } = await setUp();
  const { page } = run;
  const claude = await connect(run, sessions);
  const codex = await connect(run, sessions, "codex-mcp-client");
  await claude.ok("take_document", { path: plan });
  const waiting = codex.begin("take_document", { path: plan });
  let answered = false;
  void waiting.answer.then(() => (answered = true));
  const planId = await docIdOf(page, "plan.md");
  await expect(notice(page, planId)).toContainText("Claude is editing");
  await page.waitForTimeout(300);
  codex.cancel(waiting.id); // the person pressed Esc in Codex
  await page.waitForTimeout(300);
  await claude.ok("finish_editing", { path: plan });
  await page.waitForTimeout(500);
  await expect(notice(page, planId)).toBeHidden();
  await expect(notice(page, planId)).not.toContainText("Codex is editing");
  expect(await claude.ok("list_documents")).not.toContain("is editing it");
  expect(answered).toBe(false);
  // Codex can still take it when the person asks.
  expect(await codex.ok("take_document", { path: plan })).toContain("You're editing plan.md now.");
  await tearDown(run, sessions);
});

// R-AG-12: the connector looked for the cancel on the whole message, so calls sent together were answered anyway.
test("a call cancelled among calls sent together isn't answered; the others are", async () => {
  const { run, plan, sessions } = await setUp();
  const { page } = run;
  const claude = await connect(run, sessions);
  const codex = await connect(run, sessions, "codex-mcp-client");
  await claude.ok("take_document", { path: plan });
  const batch = codex.beginBatch([
    ["take_document", { path: plan }],
    ["list_documents", {}],
  ]);
  const planId = await docIdOf(page, "plan.md");
  await expect(notice(page, planId)).toContainText("Claude is editing");
  await page.waitForTimeout(300);
  codex.cancel(batch.ids[0]); // the person pressed Esc in Codex
  const answers = await batch.answer;
  expect(answers.map((a) => a.id)).toEqual([batch.ids[1]]);
  await claude.ok("finish_editing", { path: plan });
  // Codex can still take it when the person asks.
  expect(await codex.ok("take_document", { path: plan })).toContain("You're editing plan.md now.");
  await tearDown(run, sessions);
});

// R-AG-3: the connector forgot the take as soon as it passed the answer on, so a cancel then never reached Corillo.
test("a take_document cancelled just as its answer reached the agent tool gives the document straight back", async () => {
  const { run, plan, sessions } = await setUp();
  const { page } = run;
  const claude = await connect(run, sessions);
  await claude.ok("open_document", { path: plan });
  await page.locator('.tab[title$="/plan.md"]').click();
  const planId = await docIdOf(page, "plan.md");
  const take = claude.begin("take_document", { path: plan });
  expect(JSON.stringify((await take.answer).result)).toContain("You're editing plan.md now.");
  await expect(notice(page, planId)).toContainText("Claude is editing");
  // The person pressed Esc as the answer came in: the agent tool cancels, and ignores the answer.
  claude.cancel(take.id);
  await expect(notice(page, planId)).toBeHidden();
  expect(await claude.ok("list_documents")).not.toContain("editing it");
  await cursorAtEnd(page, "this quarter.");
  await page.keyboard.type(" Mine.");
  await expect.poll(() => readFileSync(plan, "utf8")).toContain("this quarter. Mine.");
  await tearDown(run, sessions);
});

test("an agent whose session ends mid-pass gives the document back", async () => {
  const { run, plan, sessions } = await setUp();
  const { page } = run;
  const claude = await connect(run, sessions);
  await claude.ok("take_document", { path: plan });
  const planId = await docIdOf(page, "plan.md");
  await expect(notice(page, planId)).toContainText("Claude is editing");
  await claude.stop();
  await expect(notice(page, planId)).toBeHidden();
  await expect(dot(page, "plan.md")).toBeVisible();
  // Someone else can take it now.
  const next = await connect(run, sessions);
  expect(await next.ok("take_document", { path: plan })).toContain("You're editing plan.md now.");
  await tearDown(run, sessions);
});

test("Take over ends the agent's turn, and the agent is told on its next call", async () => {
  const { run, plan, sessions } = await setUp();
  const { page } = run;
  const claude = await connect(run, sessions);
  await claude.ok("take_document", { path: plan });
  const planId = await docIdOf(page, "plan.md");
  await page.locator('.tab[title$="/plan.md"]').click();
  await notice(page, planId).getByRole("button", { name: "Take over" }).click();
  await expect(notice(page, planId)).toBeHidden();
  await cursorAtEnd(page, "this quarter.");
  await page.keyboard.type(" Mine now.");
  await expect.poll(() => readFileSync(plan, "utf8")).toContain("this quarter. Mine now.");
  const refused = await claude.call("edit_document", { path: plan, edits: [{ find: "two", replace: "three" }] });
  expect(refused.isError).toBe(true);
  expect(refused.text).toContain("The person took plan.md back while you were editing");
  expect(readFileSync(plan, "utf8")).toContain("two people");
  await tearDown(run, sessions);
});

test("renaming a document waits while an agent is editing it", async () => {
  const { run, plan, sessions } = await setUp();
  const claude = await connect(run, sessions);
  await claude.ok("take_document", { path: plan });
  await run.page.locator('.tab[title$="/plan.md"]').click();
  await run.app.evaluate(({ dialog }) => {
    const g = globalThis as unknown as { told: string };
    dialog.showMessageBox = (async (_w: unknown, options: { message: string }) => {
      g.told = options.message;
      return { response: 0, checkboxChecked: false };
    }) as unknown as typeof dialog.showMessageBox;
  });
  await clickMenu(run.app, "rename");
  await expect.poll(() => run.app.evaluate(() => (globalThis as unknown as { told?: string }).told)).toBe("Claude is editing plan.");
  expect(readFileSync(plan, "utf8")).toBe(PLAN);
  await tearDown(run, sessions);
});

test("an agent asking for a file Corillo can't read, or a folder it can't make, is told why in plain words", async () => {
  const { run, sessions } = await setUp();
  const claude = await connect(run, sessions);
  const locked = join(run.folder, "locked.md");
  writeFileSync(locked, "# Locked\n");
  chmodSync(locked, 0o000);
  try {
    const refused = await claude.call("open_document", { path: locked });
    expect(refused.isError).toBe(true);
    expect(refused.text).toContain(`Corillo isn't allowed to read ${locked}.`);
  } finally {
    chmodSync(locked, 0o600);
  }
  const shut = join(run.folder, "shut");
  mkdirSync(shut, { mode: 0o500 });
  try {
    const refused = await claude.call("create_document", { path: join(shut, "drafts", "new.md"), text: "# New\n" });
    expect(refused.text).toBe(`Corillo couldn't create ${join(shut, "drafts", "new.md")}: Corillo isn't allowed to change this file or its folder.`);
  } finally {
    chmodSync(shut, 0o700);
  }
  await tearDown(run, sessions);
});

// Roadmap Batch 1, item 3: no turn spent finding the document.
test("an agent takes a document by its name, or with none when one has comments for it, and is told which is in front", async () => {
  const { run, plan, sessions } = await setUp();
  writeFileSync(join(run.folder, "draft.md"), "# Draft\n\nNot open yet.\n");
  // The agent works in another folder, as it often does: a bare name isn't taken as a file there.
  const elsewhere = mkdtempSync(join(tmpdir(), "corillo-agent-folder-"));
  const { session: claude } = await AgentSession.start(run.dataDir, "claude-code", { cwd: elsewhere });
  sessions.push(claude);
  await claude.ok("open_document", { path: plan });
  const list = await claude.ok("list_documents");
  expect(list).toMatch(/notes\.md \(in front; no comments waiting for you\)/);
  expect(list).toMatch(/plan\.md \(no comments waiting for you\)/);
  await personComments(run.page, "plan.md", "Make it three.");
  // No path: the one document with comments waiting.
  const taken = await claude.ok("take_document");
  expect(taken).toContain("You're editing plan.md now.");
  expect(taken).toMatch(/Use its full path with the other tools: \/.*\/plan\.md\./);
  const id = /^\[([0-9a-f]{8,})\]/m.exec(taken)![1];
  await claude.ok("reply_to_comment", { path: plan, comment_id: id, text: "Made it three." });
  await claude.ok("finish_editing", { path: plan });
  // By its name, as the person said it.
  expect(await claude.ok("take_document", { path: "the plan" })).toContain("You're editing plan.md now.");
  await claude.ok("finish_editing", { path: plan });
  // A name that's a file in the agent's own folder, not open in Corillo: opened and taken, as a relative path always was.
  const { session: there } = await AgentSession.start(run.dataDir, "claude-code", { cwd: run.folder });
  sessions.push(there);
  expect(await there.ok("take_document", { path: "draft.md" })).toContain("You're editing draft.md now.");
  await expect.poll(() => tabState(run.page)).toEqual({ names: ["notes.md", "plan.md", "draft.md"], active: "notes.md" });
  await tearDown(run, sessions);
  rmSync(elsewhere, { recursive: true, force: true });
});

test("an agent can create a new draft, which opens in a background tab", async () => {
  const { run, sessions } = await setUp();
  const claude = await connect(run, sessions);
  const draft = join(run.folder, "Q3 proposal.md");
  expect(await claude.ok("create_document", { path: draft, text: "# Q3 proposal\n\nA first draft.\n" })).toContain("Created");
  expect(readFileSync(draft, "utf8")).toBe("# Q3 proposal\n\nA first draft.\n");
  await expect.poll(() => tabState(run.page)).toEqual({ names: ["notes.md", "Q3 proposal.md"], active: "notes.md" });
  await tearDown(run, sessions);
});

test("reading again after the person typed gives the agent just what changed, unsaved edits included", async () => {
  const { run, plan, sessions } = await setUp();
  const long = PLAN + "\nA paragraph that stays the same between reads, as most of a document does.\n".repeat(6);
  writeFileSync(plan, long);
  const claude = await connect(run, sessions);
  expect(await claude.ok("read_document", { path: plan })).toContain("The whole text of plan.md follows.");
  await run.page.locator('.tab[title$="/plan.md"]').click();
  await cursorAtEnd(run.page, "The budget is tight.");
  await run.page.keyboard.type(" Very.");
  // Read straight away, before autosave: Corillo saves the person's edit first.
  const changes = await claude.ok("read_document", { path: plan });
  expect(changes).toContain("@@ -7,1 +7,1 @@\n-The budget is tight.\n+The budget is tight. Very.");
  await tearDown(run, sessions);
});

test("an agent session started while Corillo isn't running starts Corillo", async () => {
  const dataDir = mkdtempSync(join(tmpdir(), "corillo-data-"));
  const folder = mkdtempSync(join(tmpdir(), "corillo-doc-"));
  const plan = join(folder, "plan.md");
  writeFileSync(plan, PLAN);
  const { session } = await AgentSession.start(dataDir);
  let pid = 0;
  try {
    expect(await session.ok("open_document", { path: plan })).toContain("plan.md is open in Corillo");
    pid = Number(/process (\d+)/.exec(session.stderr)?.[1]);
    expect(pid).toBeGreaterThan(0);
    expect(await session.ok("list_documents")).toContain(plan);
  } finally {
    if (pid) process.kill(pid, "SIGTERM");
    await session.stop();
  }
  await expect
    .poll(() => {
      try {
        process.kill(pid, 0);
        return "running";
      } catch {
        return "stopped";
      }
    })
    .toBe("stopped");
});

test("Corillo started by an agent's connector doesn't take on the agent tool's settings, keys or working folder (AG-8)", async () => {
  const dataDir = mkdtempSync(join(tmpdir(), "corillo-data-"));
  const folder = mkdtempSync(join(tmpdir(), "corillo-doc-"));
  const plan = join(folder, "plan.md");
  writeFileSync(plan, PLAN);
  // A setting of the agent tool's that runs code in every Node program it starts. If it reaches Corillo, this
  // notes what Corillo was started with.
  const probe = join(folder, "probe.cjs");
  const seen = join(folder, "seen.json");
  writeFileSync(probe, `if (process.type === "browser") require("node:fs").writeFileSync(${JSON.stringify(seen)}, JSON.stringify({ env: process.env, cwd: process.cwd() }));\n`);
  const { session } = await AgentSession.start(dataDir, "claude-code", {
    env: { NODE_OPTIONS: `--require ${probe}`, ANTHROPIC_API_KEY: "sk-ant-not-corillos" },
    cwd: folder,
  });
  let pid = 0;
  try {
    expect(await session.ok("open_document", { path: plan })).toContain("plan.md is open in Corillo");
    pid = Number(/process (\d+)/.exec(session.stderr)?.[1]);
    expect(pid).toBeGreaterThan(0);
    expect(await session.ok("list_documents")).toContain(plan);
    const started = existsSync(seen) ? (JSON.parse(readFileSync(seen, "utf8")) as { env: Record<string, string>; cwd: string }) : null;
    expect(started?.env.ANTHROPIC_API_KEY).toBeUndefined();
    expect(started?.env.NODE_OPTIONS).toBeUndefined();
    expect(started).toBeNull(); // the agent tool's setting never ran inside Corillo
    // What Corillo was started with, read from outside (in case a setting like that one were ignored): its own
    // settings, and none of the agent tool's.
    // Only the names are compared, so a failure shows no one's keys.
    const env = execFileSync("ps", ["-wwE", "-o", "command=", "-p", String(pid)], { encoding: "utf8" });
    const names = [...env.matchAll(/ ([A-Za-z_][A-Za-z0-9_]*)=/g)].map((m) => m[1]);
    expect(names).toContain("CORILLO_USER_DATA");
    expect(env.includes(` CORILLO_USER_DATA=${dataDir}`)).toBe(true);
    expect(names).not.toContain("ANTHROPIC_API_KEY");
    expect(names).not.toContain("NODE_OPTIONS");
    // It works from the folder an app opened from the Finder or the Dock works from, not the agent's.
    const cwd = execFileSync("lsof", ["-a", "-p", String(pid), "-d", "cwd", "-Fn"], { encoding: "utf8" }).trim().split("\n").pop();
    expect(cwd).toBe("n/");
  } finally {
    if (pid) process.kill(pid, "SIGTERM");
    await session.stop();
  }
  await expect
    .poll(() => {
      try {
        process.kill(pid, 0);
        return "running";
      } catch {
        return "stopped";
      }
    })
    .toBe("stopped");
  rmSync(folder, { recursive: true, force: true });
  rmSync(dataDir, { recursive: true, force: true });
});
