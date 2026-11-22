// It's your turn (roadmap Batch 2, item 2; decision D5). When a document
// comes back to the person, or an agent opens one for them, and Corillo
// isn't in front: a soft two-note coquí call, and a count on the Dock icon of
// the documents waiting, which goes down as they're looked at. Every tab says
// whose turn it is: a small coquí in the agent's colour while it edits (a
// hollow ring until Batch 9), a filled dot when the document is back, and the tooltip says which ("Back
// from Claude: 2 to read"). The Window menu lists the open documents with
// their state. Nothing takes focus.
//
// No test makes a sound: in test runs the call is rendered off-line and only
// reported, and the window's speakers are replaced by a stand-in that counts.
// The Dock's count is kept in a stand-in too (quiet.ts). Corillo coming to
// the front is the Mac's message to it, sent by the test: the test window
// itself never takes focus.
import { test, expect, type ElectronApplication, type Page } from "@playwright/test";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openText, openAlso, selectText, settle, clickMenu, tabState, type Running, launch } from "./helpers";
import { AgentSession } from "./agent-session";

const PANEL = ".doc:not([hidden]) .comments-panel";
const PLAN = "# Plan\n\nWe should hire two people this quarter.\n\nThe budget is tight.\n\nWe meet on Friday.\n";
/** Longer than Corillo waits before a call, so a call that was coming has come. */
const CALL_WAIT_MS = 1500;

interface Heard {
  seconds: number;
  peak: number;
}

/** From now on, note each coquí call (rendered off-line in test runs), with how long and how loud it was. */
async function noteCalls(app: ElectronApplication): Promise<() => Promise<Heard[]>> {
  await app.evaluate(({ app: a }) => {
    const g = globalThis as unknown as { calls: Heard[] };
    g.calls = [];
    a.on("corillo-coqui" as never, ((heard: Heard) => g.calls.push(heard)) as never);
  });
  return () => app.evaluate(() => (globalThis as unknown as { calls: Heard[] }).calls);
}

/** Replace the window's speakers with a stand-in that counts: nothing in a test may reach them. */
async function noSpeakers(page: Page): Promise<() => Promise<number>> {
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
  return () => page.evaluate(() => (window as unknown as { aloud: number }).aloud);
}

/** The count on the Dock icon ("" for none), as Corillo last set it. */
const dock = (app: ElectronApplication) => app.evaluate(({ app: a }) => a.dock?.getBadge() ?? "");

/** Corillo comes to the front, or goes behind another app, as the Mac tells it. */
async function inFront(app: ElectronApplication, front: boolean): Promise<void> {
  await app.evaluate(({ app: a }, f) => {
    a.emit(f ? "did-become-active" : "did-resign-active", { preventDefault: () => undefined });
  }, front);
}

/** The documents the Window menu lists: each name, its state, and whether it's the one in front. */
function windowDocs(app: ElectronApplication): Promise<{ label: string; state: string; checked: boolean }[]> {
  return app.evaluate(({ Menu }) => {
    const items = Menu.getApplicationMenu()?.getMenuItemById("window-menu")?.submenu?.items ?? [];
    return items.filter((i) => i.id?.startsWith("window-doc-")).map((i) => ({ label: i.label, state: i.sublabel ?? "", checked: i.checked }));
  });
}

const tab = (page: Page, name: string) => page.locator(`.tab[title$="/${name}"]`);
const dotOf = (page: Page, name: string) => tab(page, name).locator(".tab-dot");
const docIdOf = async (page: Page, name: string) => (await tab(page, name).getAttribute("data-doc-id"))!;

/** How the tab's dot looks: its fill, and the colour of its ring. */
function dotLook(page: Page, name: string): Promise<{ fill: string; ring: string }> {
  return dotOf(page, name).evaluate((dot) => {
    const s = getComputedStyle(dot);
    return { fill: s.backgroundColor, ring: s.borderTopColor };
  });
}

/** The agent's colour, as the coquí in that document's "is editing" line is painted (roadmap Batch 9, item 13; a round swatch before). */
function swatchColour(page: Page, docId: string): Promise<string> {
  return page.locator(`.doc[data-doc-id="${docId}"] .agent-notice .coqui-frog .frog-body`).evaluate((e) => getComputedStyle(e).fill);
}

/** The colour of the coquí on the tab while an agent edits (roadmap Batch 9, item 13; a hollow ring before). */
function tabFrogColour(page: Page, name: string): Promise<string> {
  return dotOf(page, name).locator(".coqui-frog .frog-body").evaluate((e) => getComputedStyle(e).fill);
}

/** Leave a comment as the person on these words, in the document in front. */
async function comment(run: Running, words: string, body: string): Promise<void> {
  await selectText(run.page, words);
  await run.page.getByRole("button", { name: "Comment", exact: true }).click();
  await run.page.getByRole("textbox", { name: "New comment" }).fill(body);
  await run.page.getByRole("button", { name: "Post" }).click();
  await expect(run.page.locator(`${PANEL} .comment-card`, { hasText: body })).toBeVisible();
}

/** The comment ids take_document shows. */
const idsIn = (text: string) => [...text.matchAll(/\[([0-9a-f]{8,})\] on /g)].map((m) => m[1]);

/** One pass by the agent on this document: an edit, a reply on every comment waiting for it, and back to the person. */
async function pass(agent: AgentSession, file: string, edit: { find: string; replace: string }): Promise<void> {
  const taken = await agent.ok("take_document", { path: file });
  await agent.ok("edit_document", { path: file, edits: [edit] });
  for (const id of idsIn(taken)) await agent.ok("reply_to_comment", { path: file, comment_id: id, text: "Done." });
  const first = await agent.call("finish_editing", { path: file });
  if (first.isError) await agent.ok("finish_editing", { path: file });
}

/** Quit and start Corillo again on the same document and data folder. */
async function relaunch(run: Running): Promise<Running> {
  await run.app.close();
  const { app, thrown } = await launch({
    args: ["--force-device-scale-factor=1", ".", run.file], // ONE_SCALE (helpers.ts)
    env: { ...process.env, CORILLO_USER_DATA: run.dataDir, CORILLO_HIDDEN: "1", CORILLO_HOME: mkdtempSync(join(tmpdir(), "corillo-home-")) },
  });
  const page = await app.firstWindow();
  await page.waitForSelector(".ProseMirror");
  return { ...run, app, page, thrown };
}

test("a document back while Corillo is behind: the coquí call, a count on the Dock, and a filled dot in the agent's colour that says who and what's to read; looking clears them", async () => {
  const run = await openText(PLAN, { name: "plan.md" });
  const { app, page } = run;
  const calls = await noteCalls(app);
  const aloud = await noSpeakers(page);
  await comment(run, "two people", "Make it three.");
  await comment(run, "tight", "Say by how much.");
  await openAlso(run, "notes.md", "My notes.\n");
  await expect.poll(() => tabState(page)).toEqual({ names: ["plan.md", "notes.md"], active: "notes.md" });
  const planId = await docIdOf(page, "plan.md");
  const notesId = await docIdOf(page, "notes.md");
  // No agent yet: no dots, nothing waiting, and the Window menu lists both documents, the one in front ticked.
  await expect(dotOf(page, "plan.md")).toBeHidden();
  expect(await dock(app)).toBe("");
  await expect.poll(() => windowDocs(app)).toEqual([
    { label: "plan", state: "", checked: false },
    { label: "notes", state: "", checked: true },
  ]);

  const { session: claude } = await AgentSession.start(run.dataDir, "claude-code");
  try {
    const taken = await claude.ok("take_document", { path: run.file });
    // While Claude edits: a small coquí in Claude's colour where the dot goes (a hollow ring before Batch 9), and the tooltip says so.
    await expect(dotOf(page, "plan.md")).toHaveAttribute("data-turn", "editing");
    await expect(dotOf(page, "plan.md")).toHaveAttribute("title", "Claude is editing");
    await expect(page.getByRole("tab", { name: "plan, Claude is editing", exact: true })).toBeVisible();
    const claudeColour = await swatchColour(page, planId);
    expect(await tabFrogColour(page, "plan.md")).toBe(claudeColour);
    expect((await dotLook(page, "plan.md")).fill).toBe("rgba(0, 0, 0, 0)"); // no dot behind the frog
    await expect.poll(() => windowDocs(app)).toEqual([
      { label: "plan", state: "Claude is editing", checked: false },
      { label: "notes", state: "", checked: true },
    ]);
    expect(await dock(app)).toBe(""); // editing isn't waiting for you

    // Claude answers both comments and hands it back.
    await claude.ok("edit_document", { path: run.file, edits: [{ find: "two people", replace: "three people" }] });
    for (const id of idsIn(taken)) await claude.ok("reply_to_comment", { path: run.file, comment_id: id, text: "Done." });
    await claude.ok("finish_editing", { path: run.file });

    // The dot fills, in the same colour, and says who it's back from and what's new to read: the two comments
    // (the edit no comment asked for has no card since roadmap Batch 9, item 5).
    await expect(dotOf(page, "plan.md")).toHaveAttribute("data-turn", "back");
    await expect(dotOf(page, "plan.md")).toHaveAttribute("title", "Back from Claude: 2 to read");
    await expect(tab(page, "plan.md")).toHaveAttribute("title", `Back from Claude: 2 to read\n${run.file}`);
    await expect(page.getByRole("tab", { name: "plan, back from Claude: 2 to read", exact: true })).toBeVisible();
    expect((await dotLook(page, "plan.md")).fill).toBe(claudeColour);
    // One document waiting for you on the Dock, and one call: short and soft, and never through the speakers.
    await expect.poll(() => dock(app)).toBe("1");
    await expect.poll(async () => (await calls()).length).toBe(1);
    const [heard] = await calls();
    expect(heard.seconds).toBeGreaterThan(0.2);
    expect(heard.seconds).toBeLessThan(0.6);
    expect(heard.peak).toBeGreaterThan(0.08);
    expect(heard.peak).toBeLessThanOrEqual(0.2);
    expect(await aloud()).toBe(0);
    await expect.poll(() => windowDocs(app)).toEqual([
      { label: "plan", state: "Back from Claude: 2 to read", checked: false },
      { label: "notes", state: "", checked: true },
    ]);

    // Choosing it in the Window menu brings its tab to the front: looked at, so its dot and the Dock's count go.
    await clickMenu(app, `window-doc-${planId}`);
    await expect.poll(() => tabState(page)).toEqual({ names: ["plan.md", "notes.md"], active: "plan.md" });
    await expect(dotOf(page, "plan.md")).toBeHidden();
    await expect.poll(() => dock(app)).toBe("");
    await expect.poll(() => windowDocs(app)).toEqual([
      { label: "plan", state: "With you", checked: true },
      { label: "notes", state: "", checked: false },
    ]);
    await expect(tab(page, "plan.md")).toHaveAttribute("title", run.file);
    // And it doesn't call again.
    await page.waitForTimeout(CALL_WAIT_MS);
    expect(await calls()).toHaveLength(1);
    // Choosing the other brings it back to the front.
    await clickMenu(app, `window-doc-${notesId}`);
    await expect.poll(() => tabState(page)).toEqual({ names: ["plan.md", "notes.md"], active: "notes.md" });
  } finally {
    await claude.stop();
    await app.close();
  }
});

test("several documents back together while Corillo is behind: one count that's right and one call; closing a waiting document, or the window, takes the count down", async () => {
  const run = await openText("My notes.\n", { name: "notes.md" });
  const { app, page } = run;
  const calls = await noteCalls(app);
  const aloud = await noSpeakers(page);
  const a = await openAlso(run, "a.md", PLAN);
  const b = await openAlso(run, "b.md", PLAN);
  await expect(page.locator(".tab")).toHaveCount(3);
  await tab(page, "notes.md").click();
  await expect.poll(() => tabState(page)).toEqual({ names: ["notes.md", "a.md", "b.md"], active: "notes.md" });
  const { session: claude } = await AgentSession.start(run.dataDir, "claude-code");
  const { session: codex } = await AgentSession.start(run.dataDir, "codex");
  try {
    await claude.ok("take_document", { path: a });
    await codex.ok("take_document", { path: b });
    await claude.ok("edit_document", { path: a, edits: [{ find: "Friday", replace: "Thursday" }] });
    await codex.ok("edit_document", { path: b, edits: [{ find: "tight", replace: "fixed" }] });
    await Promise.all([claude.ok("finish_editing", { path: a }), codex.ok("finish_editing", { path: b })]);
    await expect.poll(() => dock(app)).toBe("2");
    // Back, with nothing to read in the panel: their edits no comment asked for have no card (roadmap Batch 9, item 5).
    await expect(dotOf(page, "a.md")).toHaveAttribute("title", "Back from Claude");
    await expect(dotOf(page, "b.md")).toHaveAttribute("title", "Back from Codex");
    // One call for both, not one on top of the other.
    await expect.poll(async () => (await calls()).length).toBe(1);
    await page.waitForTimeout(CALL_WAIT_MS);
    expect(await calls()).toHaveLength(1);
    expect(await aloud()).toBe(0);

    // Closing a document that's waiting takes it off the count.
    await tab(page, "a.md").locator(".tab-close").click();
    await expect(page.locator(".tab")).toHaveCount(2);
    await expect.poll(() => dock(app)).toBe("1");
    // With the window closed, nothing is waiting.
    await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].close());
    await expect.poll(() => app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows().length)).toBe(0);
    await expect.poll(() => dock(app)).toBe("");
  } finally {
    await claude.stop();
    await codex.stop();
    await app.close();
  }
});

test("while Corillo is in front there's no call, and the document in front counts as looked at as soon as it's back", async () => {
  const run = await openText(PLAN, { name: "plan.md" });
  const { app, page } = run;
  const calls = await noteCalls(app);
  const notes = await openAlso(run, "notes.md", "My notes.\n");
  await expect.poll(() => tabState(page)).toEqual({ names: ["plan.md", "notes.md"], active: "notes.md" });
  const { session: claude } = await AgentSession.start(run.dataDir, "claude-code");
  try {
    await inFront(app, true);
    // A document out of sight comes back: it waits for you (its dot, the Dock), but Corillo is in front, so no call.
    await pass(claude, run.file, { find: "Friday", replace: "Thursday" });
    await expect(dotOf(page, "plan.md")).toHaveAttribute("data-turn", "back");
    await expect.poll(() => dock(app)).toBe("1");
    // The document in front comes back: it's being looked at, so it isn't waiting.
    await pass(claude, notes, { find: "My notes.", replace: "My notes, tidied." });
    await expect(page.locator(".doc:not([hidden]) .pass-notice")).toBeVisible();
    await expect(dotOf(page, "notes.md")).toBeHidden();
    await page.waitForTimeout(CALL_WAIT_MS);
    expect(await dock(app)).toBe("1");
    expect(await calls()).toHaveLength(0);

    // Corillo goes behind another app: the same document coming back now waits for you, with a call.
    await inFront(app, false);
    await pass(claude, notes, { find: "tidied", replace: "tidied again" });
    await expect(dotOf(page, "notes.md")).toHaveAttribute("data-turn", "back");
    await expect.poll(() => dock(app)).toBe("2");
    await expect.poll(async () => (await calls()).length).toBe(1);
    // Back in front: the document in front is looked at; the other still waits.
    await inFront(app, true);
    await expect(dotOf(page, "notes.md")).toBeHidden();
    await expect.poll(() => dock(app)).toBe("1");
    await expect(dotOf(page, "plan.md")).toHaveAttribute("data-turn", "back");
  } finally {
    await claude.stop();
    await app.close();
  }
});

test("Corillo > Sound When It's Your Turn is on at first; off, a document back makes no call but still counts; remembered between launches", async () => {
  let run = await openText(PLAN, { name: "plan.md" });
  const menu = () =>
    run.app.evaluate(({ Menu }) => {
      const items = Menu.getApplicationMenu()?.getMenuItemById("app-menu")?.submenu?.items ?? [];
      const at = items.findIndex((i) => i.id === "turn-sound");
      return { label: items[at]?.label, checked: items[at]?.checked, after: items[at - 2]?.id, between: items[at - 1]?.type, before: items[at + 1]?.type };
    });
  // In the Corillo menu, after About, set apart; ticked at first.
  expect(await menu()).toEqual({ label: "Sound When It's Your Turn", checked: true, after: "about", between: "separator", before: "separator" });
  await clickMenu(run.app, "turn-sound");
  expect((await menu()).checked).toBe(false);
  expect(JSON.parse(readFileSync(join(run.dataDir, "view.json"), "utf8")).turnSound).toBe(false);

  let calls = await noteCalls(run.app);
  let claude = (await AgentSession.start(run.dataDir, "claude-code")).session;
  try {
    // Off: back, waiting and counted, but no call.
    await pass(claude, run.file, { find: "Friday", replace: "Thursday" });
    await expect.poll(() => dock(run.app)).toBe("1");
    await run.page.waitForTimeout(CALL_WAIT_MS);
    expect(await calls()).toHaveLength(0);
  } finally {
    await claude.stop();
  }

  // Still off after quitting and starting again; turned on, it plays once to be
  // heard (since 2026-11-10, roadmap Batch 6, item 5), and the next document back calls.
  run = await relaunch(run);
  expect((await menu()).checked).toBe(false);
  calls = await noteCalls(run.app);
  await clickMenu(run.app, "turn-sound");
  expect((await menu()).checked).toBe(true);
  await expect.poll(async () => (await calls()).length).toBe(1);
  claude = (await AgentSession.start(run.dataDir, "claude-code")).session;
  try {
    await pass(claude, run.file, { find: "Thursday", replace: "Wednesday" });
    await expect.poll(async () => (await calls()).length).toBe(2);
  } finally {
    await claude.stop();
    await run.app.close();
  }
});

test("an agent opening or creating a document for you while Corillo is behind: the call, the count, and a dot that says so", async () => {
  const run = await openText("My notes.\n", { name: "notes.md" });
  const { app, page } = run;
  const calls = await noteCalls(app);
  const aloud = await noSpeakers(page);
  const { session: claude } = await AgentSession.start(run.dataDir, "claude-code");
  try {
    // A new draft, for your review: its tab opens behind, with a filled dot, and Corillo calls.
    const draft = join(run.folder, "proposal.md");
    await claude.ok("create_document", { path: draft, text: PLAN });
    await expect(page.locator(".tab")).toHaveCount(2);
    await expect.poll(() => tabState(page)).toEqual({ names: ["notes.md", "proposal.md"], active: "notes.md" });
    await expect(dotOf(page, "proposal.md")).toHaveAttribute("data-turn", "back");
    await expect(dotOf(page, "proposal.md")).toHaveAttribute("title", "Opened for you by Claude");
    await expect.poll(() => dock(app)).toBe("1");
    await expect.poll(async () => (await calls()).length).toBe(1);
    expect(await aloud()).toBe(0);
    await expect.poll(() => windowDocs(app)).toEqual([
      { label: "notes", state: "", checked: true },
      { label: "proposal", state: "Opened for you by Claude", checked: false },
    ]);

    // An existing document opened for review counts too.
    const brief = join(run.folder, "brief.md");
    writeFileSync(brief, "# Brief\n\nShort.\n");
    await claude.ok("open_document", { path: brief });
    await expect(dotOf(page, "brief.md")).toHaveAttribute("title", "Opened for you by Claude");
    await expect.poll(() => dock(app)).toBe("2");

    // Looked at, one by one: the count goes down.
    await tab(page, "proposal.md").click();
    await expect(dotOf(page, "proposal.md")).toBeHidden();
    await expect.poll(() => dock(app)).toBe("1");
    await tab(page, "brief.md").click();
    await expect.poll(() => dock(app)).toBe("");

    // Opening the document you're looking at, with Corillo in front, isn't news.
    await inFront(app, true);
    await claude.ok("open_document", { path: brief });
    await settle(page);
    await page.waitForTimeout(CALL_WAIT_MS);
    await expect(dotOf(page, "brief.md")).toBeHidden();
    expect(await dock(app)).toBe("");
  } finally {
    await claude.stop();
    await app.close();
  }
});
