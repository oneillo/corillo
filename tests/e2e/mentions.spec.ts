// @ to tag an agent in a comment, the way people mention a colleague in Word,
// Google Docs or Slack (Orlando, 2026-11-09: "I want to be able to @ tag agents
// in the comments. I don't see a list of agents popping up when I enter @.").
// Each test runs the real app, hidden, on a throwaway document and data folder.
import { test, expect, type Locator, type Page } from "@playwright/test";
import { existsSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { gunzipSync } from "node:zlib";
import { openText, listed, messageAction, selectText, settle, turnSaid, type Running } from "./helpers";
import { AgentSession } from "./agent-session";
import type { Thread } from "../../src/core/comments";

const PANEL = ".doc:not([hidden]) aside.comments-panel";
const DOC = "# Plan\n\nWe should hire two people this spring.\n\n## Budget\n\nThe budget is tight.\n";

const card = (page: Page, text: string) => page.locator(`${PANEL} .comment-card:not(.draft)`, { hasText: text });
const draft = (page: Page) => page.locator(`${PANEL} .comment-card.draft`);
const newBox = (page: Page) => page.getByRole("textbox", { name: "New comment" });
const list = (page: Page) => page.locator("#mention-list");
/** Where something is in the window (also the zero-width mark at an @, which Playwright counts as unseen). */
const rectOf = (target: Locator) =>
  target.evaluate((e) => {
    const r = e.getBoundingClientRect();
    return { x: r.x, y: r.y, width: r.width, height: r.height };
  });
/** The tags drawn behind a comment box's words. */
const drawnTags = (page: Page, scope = draft(page)) => scope.locator(".mention-layer .mention-tag").allTextContents();

let run: Running | null = null;
const sessions: AgentSession[] = [];

test.afterEach(async () => {
  await Promise.all(sessions.splice(0).map((s) => s.stop()));
  // Most tests end with words in a comment box, and closing would ask about them first: quit outright.
  const app = run?.app;
  run = null;
  if (!app) return;
  await app.evaluate(({ app: electronApp }) => setTimeout(() => electronApp.exit(0), 10)).catch(() => undefined);
  await app.close().catch(() => undefined);
});

/** The comments as Corillo keeps them, in its data folder. */
function storedThreads(r: Running): Thread[] {
  const index = JSON.parse(readFileSync(join(r.dataDir, "documents.json"), "utf8")) as Record<string, { path: string }>;
  const id = Object.keys(index).find((k) => index[k].path === r.file);
  const file = join(r.dataDir, "documents", id ?? "none", "comments.json.gz");
  return existsSync(file) ? (JSON.parse(gunzipSync(readFileSync(file)).toString("utf8")) as Thread[]) : [];
}

/** Whom each comment is for, as stored: an agent's name, or null for the default agent. */
const storedTo = (r: Running) => storedThreads(r).map((t) => t.to);

/** Agents on the document, as the app tells the window (Claude the default). */
async function agentsOnDoc(r: Running, agents = [
  { name: "Claude", isDefault: true, editing: false, colour: "peach" },
  { name: "Writer", isDefault: false, editing: false, colour: "sky" },
]): Promise<void> {
  const docId = await r.page.locator(".doc:not([hidden])").getAttribute("data-doc-id");
  await r.app.evaluate(({ BrowserWindow }, [id, list]) => BrowserWindow.getAllWindows()[0].webContents.send("agents:changed", id, list), [
    docId,
    agents,
  ] as const);
}

/** Agents Corillo has met on other documents, not connected now, as the app tells the window. */
async function knownElsewhere(r: Running, names: string[]): Promise<void> {
  const known = names.map((name) => ({ name, connected: false }));
  await r.app.evaluate(({ BrowserWindow }, list) => BrowserWindow.getAllWindows()[0].webContents.send("agents:known", list), known);
}

const DAY = 24 * 60 * 60 * 1000;

/** A throwaway data folder in which Corillo remembers these agents, last seen so many days ago. */
function rememberedIn(agents: [string, number][], dataDir = mkdtempSync(join(tmpdir(), "corillo-data-"))): string {
  const now = Date.now();
  writeFileSync(join(dataDir, "agents.json"), JSON.stringify({ seen: agents.map(([name, days]) => ({ name, at: now - days * DAY })) }));
  return dataDir;
}

/** The agents Corillo remembers, as written in its data folder. */
function rememberedNames(dataDir: string): string[] | null {
  try {
    return (JSON.parse(readFileSync(join(dataDir, "agents.json"), "utf8")) as { seen: { name: string }[] }).seen.map((s) => s.name);
  } catch {
    return null;
  }
}

/** A real agent session, connected to Corillo: an agent's connector reaches Corillo on its first call. */
async function connectAgent(dataDir: string, client: string, name?: string): Promise<AgentSession> {
  const { session } = await AgentSession.start(dataDir, client);
  sessions.push(session);
  if (name) await session.ok("introduce", { name });
  else await session.ok("list_documents");
  return session;
}

async function endSession(session: AgentSession): Promise<void> {
  sessions.splice(sessions.indexOf(session), 1);
  await session.stop();
}

/** Start a comment on some words (or the whole document), with the cursor in its box. */
async function startComment(page: Page, on: string | null): Promise<void> {
  if (on) await selectText(page, on);
  else {
    await page.locator(".doc:not([hidden]) .page.editor h1").click();
    await settle(page);
  }
  await page.keyboard.press("Meta+Alt+KeyM");
  await expect(newBox(page)).toBeFocused();
}

async function post(page: Page): Promise<void> {
  await page.getByRole("button", { name: "Post" }).click();
  await expect(draft(page)).toHaveCount(0);
}

test("typing @ in a new comment opens a list of agents just under it: those connected first, the default marked, then the others Corillo knows", async () => {
  run = await openText(DOC);
  const { page } = run;
  await agentsOnDoc(run);
  await knownElsewhere(run, ["Codex", "Writer", "Gemini"]);
  await startComment(page, "two people");
  await expect(newBox(page)).toHaveAttribute("placeholder", "Write a comment. Type @ to ask a particular agent.");
  await page.keyboard.type("Please look, @");
  await expect(list(page)).toBeVisible();
  expect(await listed(page)).toEqual(["Claude, connected, default", "Writer, connected", "Codex, not connected", "Gemini, not connected"]);
  await expect(list(page).locator(".mention-group")).toHaveText(["Connected", "Not connected"]);
  await expect(list(page).locator(".mention-default")).toHaveText(["Default"]);
  // Just under the @, starting at it, or as close as the window's right edge allows.
  const at = await rectOf(draft(page).locator(".mention-at"));
  const box = await rectOf(list(page));
  const width = await page.evaluate(() => innerWidth);
  expect(box.y).toBeGreaterThanOrEqual(at.y + at.height);
  expect(box.y).toBeLessThan(at.y + at.height + 12);
  expect(box.x).toBeLessThanOrEqual(at.x);
  expect(box.x > at.x - 12 || Math.abs(box.x + box.width - (width - 8)) < 1).toBe(true);
  expect(box.x + box.width).toBeLessThanOrEqual(width);
  // The box stays a text box, tied to the list it opened (a text box has no "expanded": ARIA 1.2).
  await expect(newBox(page)).toHaveAttribute("aria-controls", "mention-list");
  await expect(newBox(page)).not.toHaveAttribute("aria-expanded", /.*/);
});

test("typing after the @ filters the list, by the start of a name in any capitals, and a name nobody has closes it", async () => {
  run = await openText(DOC);
  const { page } = run;
  await agentsOnDoc(run);
  await knownElsewhere(run, ["Codex", "Copy Editor"]);
  await startComment(page, "two people");
  await page.keyboard.type("@c");
  await expect.poll(() => listed(page)).toEqual(["Claude, connected, default", "Codex, not connected", "Copy Editor, not connected"]);
  await page.keyboard.type("O");
  await expect.poll(() => listed(page)).toEqual(["Codex, not connected", "Copy Editor, not connected"]);
  await page.keyboard.type("d");
  await expect.poll(() => listed(page)).toEqual(["Codex, not connected"]);
  await page.keyboard.press("Backspace");
  await page.keyboard.press("Backspace");
  await page.keyboard.press("Backspace");
  await expect.poll(() => listed(page)).toEqual([
    "Claude, connected, default",
    "Writer, connected",
    "Codex, not connected",
    "Copy Editor, not connected",
  ]);
  await page.keyboard.type("zz");
  await expect(list(page)).toBeHidden();
  await page.keyboard.press("Meta+a");
  await page.keyboard.type("@Bob");
  await expect(list(page)).toBeHidden();
  // A word inside a name counts too.
  await page.keyboard.press("Meta+a");
  await page.keyboard.type("@edi");
  await expect.poll(() => listed(page)).toEqual(["Copy Editor, not connected"]);
});

test("Up and Down move in the list, Return or Tab picks, a click picks, and Escape closes it leaving the @ as typed", async () => {
  run = await openText(DOC);
  const { page } = run;
  await agentsOnDoc(run);
  await startComment(page, "two people");
  const box = newBox(page);
  const selected = () => list(page).locator("[aria-selected='true']").getAttribute("aria-label");

  await page.keyboard.type("@");
  expect(await selected()).toBe("Claude, connected, default");
  await page.keyboard.press("ArrowDown");
  expect(await selected()).toBe("Writer, connected");
  await page.keyboard.press("ArrowDown"); // round to the top again
  expect(await selected()).toBe("Claude, connected, default");
  await page.keyboard.press("ArrowUp");
  await page.keyboard.press("Enter");
  await expect(box).toHaveValue("@Writer ");
  await expect(list(page)).toBeHidden();
  expect(await drawnTags(page)).toEqual(["@Writer"]);

  await page.keyboard.press("Meta+a");
  await page.keyboard.type("Over to @");
  await page.keyboard.press("Tab");
  await expect(box).toHaveValue("Over to @Claude ");
  await expect(box).toBeFocused();

  await page.keyboard.press("Meta+a");
  await page.keyboard.type("Ask @");
  await list(page).getByRole("option", { name: "Writer" }).click();
  await expect(box).toHaveValue("Ask @Writer ");
  await expect(box).toBeFocused();

  // Escape closes the list and nothing else: the @ stays, the comment stays, and the list stays closed for that @.
  await page.keyboard.press("Meta+a");
  await page.keyboard.type("Email @");
  await expect(list(page)).toBeVisible();
  await page.keyboard.press("Escape");
  await expect(list(page)).toBeHidden();
  await expect(box).toHaveValue("Email @");
  await expect(box).toBeFocused();
  await page.keyboard.type("W");
  await expect(list(page)).toBeHidden();
  // A new @ opens it again.
  await page.keyboard.type(" @");
  await expect(list(page)).toBeVisible();
});

test("picking a name directs the comment at that agent, shown as a tag; deleting the tag takes the direction away", async () => {
  run = await openText(DOC);
  const { page } = run;
  await agentsOnDoc(run);
  await startComment(page, "two people");
  await page.keyboard.type("@Wri");
  await page.keyboard.press("Enter");
  await page.keyboard.type("is two enough?");
  // In the box, the tag has Writer's colour.
  const tag = draft(page).locator(".mention-layer .mention-tag");
  await expect(tag).toHaveText("@Writer");
  expect(await tag.evaluate((e) => e.style.getPropertyValue("--tag"))).toBe("var(--agent-sky)");
  await post(page);
  const c = card(page, "is two enough?");
  await expect(c.locator(".comment-body .mention-tag")).toHaveText("@Writer");
  await expect(c.locator(".comment-recipient")).toHaveText("To Writer");
  await expect.poll(() => storedTo(run!)).toEqual(["Writer"]);
  expect(storedThreads(run)[0].messages[0]).toMatchObject({ body: "@Writer is two enough?", mention: "Writer" });

  // Backspace right after a tag takes the whole tag away, and with it the direction.
  await startComment(page, "budget is tight");
  await page.keyboard.type("@Wri");
  await page.keyboard.press("Enter");
  await page.keyboard.press("Backspace"); // the space after it
  await page.keyboard.press("Backspace"); // the tag, in one go
  await expect(newBox(page)).toHaveValue("");
  expect(await drawnTags(page)).toEqual([]);
  await page.keyboard.type("By how much?");
  await post(page);
  await expect(card(page, "By how much?").locator(".comment-recipient")).toHaveCount(0);
  await expect.poll(() => storedTo(run!)).toEqual(["Writer", null]);
});

test("a name typed by hand counts: @claude is Claude, on a whole-document comment too", async () => {
  run = await openText(DOC);
  const { page } = run;
  await agentsOnDoc(run);
  await startComment(page, null);
  await expect(draft(page).locator(".comment-whole")).toHaveText("Whole document");
  await page.keyboard.type("@claude make the whole thing shorter");
  expect(await drawnTags(page)).toEqual(["@claude"]);
  await post(page);
  await expect(card(page, "make the whole thing shorter").locator(".comment-body .mention-tag")).toHaveText("@claude");
  await expect(card(page, "make the whole thing shorter").locator(".comment-recipient")).toHaveText("To Claude");
  await expect.poll(() => storedTo(run!)).toEqual(["Claude"]);
});

test("an @ inside a word, such as an email address, doesn't open the list or make a tag", async () => {
  run = await openText(DOC);
  const { page } = run;
  await agentsOnDoc(run);
  await startComment(page, "two people");
  await page.keyboard.type("Ask ana@");
  await expect(list(page)).toBeHidden();
  await page.keyboard.type("claude.com or @claude.com first");
  await expect(list(page)).toBeHidden();
  expect(await drawnTags(page)).toEqual([]);
  await post(page);
  await expect(card(page, "Ask ana@claude.com").locator(".mention-tag")).toHaveCount(0);
  await expect.poll(() => storedTo(run!)).toEqual([null]);
});

test("two names in one comment: it goes to the first, the box says so before posting, and only the first is a tag", async () => {
  run = await openText(DOC);
  const { page } = run;
  await agentsOnDoc(run);
  await startComment(page, "two people");
  await page.keyboard.type("@Claude check the numbers and @Writer the tone");
  await expect(draft(page).locator(".mention-note")).toHaveText(
    "Goes to Claude only. A comment goes to one agent, so start another one for Writer.",
  );
  expect(await drawnTags(page)).toEqual(["@Claude"]);
  await post(page);
  const c = card(page, "check the numbers");
  await expect(c.locator(".comment-body .mention-tag")).toHaveText(["@Claude"]);
  await expect(c.locator(".comment-recipient")).toHaveText("To Claude");
  await expect.poll(() => storedTo(run!)).toEqual(["Claude"]);
});

test("@ in a reply hands the comment to that agent; taking the tag out of it in an edit hands it back", async () => {
  run = await openText(DOC);
  const { page } = run;
  await agentsOnDoc(run);
  await startComment(page, "two people");
  await page.keyboard.type("Is two enough?");
  await post(page);
  const c = card(page, "Is two enough?");
  await expect(c).toHaveAttribute("aria-label", turnSaid("For Claude, not sent yet"));
  await c.locator(".comment-body").first().click();
  const reply = c.getByRole("textbox", { name: "Reply" });
  await reply.click();
  await page.keyboard.type("@");
  await expect.poll(() => listed(page)).toEqual(["Claude, connected, default", "Writer, connected"]);
  await page.keyboard.type("wr");
  await page.keyboard.press("Enter");
  await page.keyboard.type("can you take this?");
  await expect(c.locator(".comment-reply .mention-note")).toHaveText("Hands this comment to Writer.");
  expect(await drawnTags(page, c.locator(".comment-reply"))).toEqual(["@Writer"]);
  await c.getByRole("button", { name: "Reply", exact: true }).click();
  await expect(c.locator(".comment-message")).toHaveCount(2);
  await expect(c.locator(".comment-message").nth(1).locator(".comment-recipient")).toHaveText("To Writer");
  await expect(c.locator(".comment-message").nth(1).locator(".mention-tag")).toHaveText("@Writer");
  await expect(c).toHaveAttribute("aria-label", turnSaid("For Writer, not sent yet"));
  await expect.poll(() => storedTo(run!)).toEqual(["Writer"]);

  // Naming the agent it's already for says nothing about handing it over.
  await c.locator(".comment-body").first().click();
  await reply.click();
  await page.keyboard.type("@Writer thanks");
  await expect(c.locator(".comment-reply .mention-note")).toBeHidden();
  await page.keyboard.press("Meta+a");
  await page.keyboard.press("Backspace");

  // Edit the reply and take the tag out: the comment goes back to the default agent.
  await messageAction(c.locator(".comment-message").nth(1), "Edit");
  const edit = c.getByRole("textbox", { name: "Edit comment" });
  await expect(edit).toBeFocused();
  expect(await drawnTags(page, c.locator(".comment-edit"))).toEqual(["@Writer"]);
  await page.keyboard.press("Meta+a");
  await page.keyboard.type("Can someone take this?");
  await page.keyboard.press("Meta+Enter");
  await expect(c.locator(".comment-message").nth(1)).toContainText("Can someone take this?");
  await expect(c).toHaveAttribute("aria-label", turnSaid("For Claude, not sent yet"));
  await expect.poll(() => storedTo(run!)).toEqual([null]);
});

// Orlando (2026-11-09): "keep a list of every recent agent we've seen in the app but distinguish between
// ones that are currently active right now versus not active."
test("an agent connected to Corillo shows as connected, with a dot, and the open list follows as its session ends and a new one starts", async () => {
  // Codex was seen 3 days ago, Gemini yesterday: neither is connected.
  run = await openText(DOC, { dataDir: rememberedIn([["Codex", 3], ["Gemini", 1]]) });
  const { page, dataDir } = run;
  const claude = await connectAgent(dataDir, "claude-code");
  await claude.ok("open_document", { path: run.file });
  // Writer is connected to Corillo, but hasn't looked at this document.
  const writer = await connectAgent(dataDir, "writer-tool", "Writer");
  await startComment(page, "two people");
  await page.keyboard.type("@");
  // Connected first (this document's default at the top), then the others, most recently seen first.
  await expect.poll(() => listed(page)).toEqual([
    "Claude, connected, default",
    "Writer, connected",
    "Gemini, not connected",
    "Codex, not connected",
  ]);
  await expect(list(page).locator(".mention-group")).toHaveText(["Connected", "Not connected"]);
  await expect(list(page).locator(".mention-option.connected .mention-dot")).toHaveCount(2);
  await expect(list(page).getByRole("option", { name: "Gemini" })).toHaveAttribute("title", "Gemini isn't connected right now. A comment for it waits until it is.");

  // Writer's session ends while the list is open: it moves down among the agents not connected, the most recent of them.
  await endSession(writer);
  await expect.poll(() => listed(page)).toEqual([
    "Claude, connected, default",
    "Writer, not connected",
    "Gemini, not connected",
    "Codex, not connected",
  ]);
  await expect(list(page).locator(".mention-dot")).toHaveCount(1);
  // A new Codex session: it moves up, still while the list is open.
  await connectAgent(dataDir, "codex");
  await expect.poll(() => listed(page)).toEqual([
    "Claude, connected, default",
    "Codex, connected",
    "Writer, not connected",
    "Gemini, not connected",
  ]);
  await expect(newBox(page)).toBeFocused();
  await expect(newBox(page)).toHaveValue("@");
});

// Changed 2026-11-12 (roadmap Batch 9, item 3): the card shows no line for it; a screen reader hears it in the card's name.
test("picking an agent that isn't connected: the comment waits for it, and a screen reader hears so on its card until the agent is back", async () => {
  run = await openText(DOC, { dataDir: rememberedIn([["Codex", 2]]) });
  const { page, dataDir } = run;
  await startComment(page, "two people");
  await page.keyboard.type("@");
  await expect.poll(() => listed(page)).toEqual(["Codex, not connected"]);
  await page.keyboard.press("Enter");
  await page.keyboard.type("check the sums");
  expect(await drawnTags(page)).toEqual(["@Codex"]);
  await post(page);
  const c = card(page, "check the sums");
  await expect(c.locator(".comment-recipient")).toHaveText("To Codex");
  await expect(c).toHaveAttribute("aria-label", turnSaid("Waiting for Codex"));
  await expect(c).not.toContainText("isn't connected");
  await expect.poll(() => storedTo(run!)).toEqual(["Codex"]);
  // Codex connects, and finds the comment waiting for it; still waiting until Codex is on the document.
  const codex = await connectAgent(dataDir, "codex");
  await expect(c).toHaveAttribute("aria-label", turnSaid("Waiting for Codex"));
  expect(await codex.ok("list_comments", { path: run.file })).toContain("Person (to you): @Codex check the sums");
  await codex.ok("read_document", { path: run.file });
  await expect(c).not.toHaveAttribute("aria-label", turnSaid("Waiting for Codex"));
});

test("the agents Corillo has seen are remembered between launches, as not connected until they connect again: the 12 seen most recently, none not seen for 30 days", async () => {
  run = await openText("# First\n\nWords.\n");
  const dataDir = run.dataDir;
  const writer = await connectAgent(dataDir, "writer-tool", "Writer");
  await writer.ok("open_document", { path: run.file });
  await expect.poll(() => rememberedNames(dataDir)).toEqual(["Writer"]);
  await endSession(writer);
  await run.app.close();

  // Twelve more, seen over the last fortnight, and one not seen for six weeks.
  const others = ["Codex", "Gemini", "Copilot", "Cursor", "Reviewer", "Editor", "Researcher", "Fact Checker", "Translator", "Planner", "Critic", "Summariser"];
  const before = JSON.parse(readFileSync(join(dataDir, "agents.json"), "utf8")) as { seen: { name: string; at: number }[] };
  const now = Date.now();
  before.seen.push(...others.map((name, i) => ({ name, at: now - (i + 1) * DAY })), { name: "Old Friend", at: now - 42 * DAY });
  writeFileSync(join(dataDir, "agents.json"), JSON.stringify(before));

  // Corillo again, with the same data folder, on a document no agent has looked at.
  run = await openText(DOC, { dataDir, name: "other.md" });
  const { page } = run;
  await startComment(page, "two people");
  await page.keyboard.type("@");
  // The 12 seen most recently, Writer first: Summariser (the 13th) and Old Friend are forgotten.
  const notConnected = ["Writer", ...others.slice(0, 11)].map((name) => `${name}, not connected`);
  await expect.poll(() => listed(page)).toEqual(notConnected);
  await expect(list(page).locator(".mention-group")).toHaveText(["Not connected"]);
  await expect(list(page).locator(".mention-dot")).toHaveCount(0);

  // Writer connects again: connected, at the top, while the list is open.
  await connectAgent(dataDir, "writer-tool", "Writer");
  await expect.poll(() => listed(page)).toEqual(["Writer, connected", ...notConnected.slice(1)]);
  await page.keyboard.press("Enter");
  await page.keyboard.type("have a look");
  await post(page);
  await expect.poll(() => storedTo(run!)).toEqual(["Writer"]);
});

test("with no agents known at all, the list says so in one line, with a link to Connect your agents", async () => {
  run = await openText(DOC);
  const { page } = run;
  await startComment(page, "two people");
  await page.keyboard.type("@");
  await expect(list(page)).toBeVisible();
  await expect(list(page).locator(".mention-empty")).toContainText("Corillo hasn't met any agents yet.");
  expect(await listed(page)).toEqual([]);
  // Return still starts a new line, with nothing to pick.
  await page.keyboard.press("Enter");
  await expect(newBox(page)).toHaveValue("@\n");
  await expect(list(page)).toBeHidden();
  await page.keyboard.type("@");
  await list(page).getByRole("button", { name: "Connect your agents" }).click();
  await expect(page.locator("dialog.connect-agents")).toBeVisible();
  await expect(list(page)).toBeHidden();
});

test("near the bottom of a short window, the list opens above the @, whole", async () => {
  const paragraphs = Array.from({ length: 30 }, (_, i) => `Paragraph ${i + 1} of the plan.`).join("\n\n");
  run = await openText(`# Plan\n\n${paragraphs}\n`);
  const { page } = run;
  await page.setViewportSize({ width: 1100, height: 440 });
  await agentsOnDoc(run, [
    { name: "Claude", isDefault: true, editing: false, colour: "peach" },
    { name: "Writer", isDefault: false, editing: false, colour: "sky" },
    { name: "Codex", isDefault: false, editing: false, colour: "mint" },
    { name: "Gemini", isDefault: false, editing: false, colour: "lilac" },
  ]);
  await knownElsewhere(run, ["Copilot", "Cursor"]);
  // Comments on the paragraphs above fill the panel, so a new comment further
  // down the page is last in the list, its box near the bottom of the window.
  for (const n of [1, 2, 3, 4, 5]) {
    await startComment(page, `Paragraph ${n} `);
    await page.keyboard.type(`About paragraph ${n}, with a few more words.`);
    await post(page);
  }
  await startComment(page, "Paragraph 20 ");
  const panel = await rectOf(page.locator(PANEL));
  expect((await rectOf(newBox(page))).y).toBeGreaterThan(panel.y + panel.height / 2);
  await page.keyboard.type("@");
  await expect(list(page)).toBeVisible();
  await expect.poll(() => listed(page)).toHaveLength(6);
  const at = await rectOf(draft(page).locator(".mention-at"));
  const box = await rectOf(list(page));
  const height = await page.evaluate(() => innerHeight);
  expect(at.y + at.height + box.height).toBeGreaterThan(height); // it wouldn't fit underneath
  expect(box.y + box.height).toBeLessThanOrEqual(at.y); // so it's above the @
  expect(box.y).toBeGreaterThanOrEqual(0);
  await expect(list(page)).toHaveClass(/above/);
  // Every name in it is in sight, without scrolling the list.
  expect(await list(page).evaluate((e) => e.scrollHeight <= e.clientHeight)).toBe(true);
  // Typing filters it, and it stays just above the @.
  await page.keyboard.type("c");
  await expect.poll(() => listed(page)).toEqual([
    "Claude, connected, default",
    "Codex, connected",
    "Copilot, not connected",
    "Cursor, not connected",
  ]);
  const smaller = await rectOf(list(page));
  expect(Math.abs(smaller.y + smaller.height - (box.y + box.height))).toBeLessThanOrEqual(1);
});
