// npm run screens: a picture of every state of the window, light and dark, at
// 1440, 900 and 560 pixels wide, for a fit and finish look over. Nothing is checked:
// the pictures go to SCREENS_DIR (default: screens/ in the project, which git
// leaves out), one folder per look, to be looked at.
import { test, type Page } from "@playwright/test";
import { appendFileSync, mkdirSync, readFileSync, unlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { launch, resize, settle, stillShot, gutterDrift, selectText, clickMenu, comment, rest, unreadable, quit, finish, idsIn, sampleComments, samplePass, EDITOR, SAMPLE, type Studio, type StudioOptions } from "./studio";
import { AgentSession } from "../e2e/agent-session";
import { openFromFinder } from "../e2e/helpers";

const OUT = process.env.SCREENS_DIR ?? join(import.meta.dirname, "..", "..", "screens");
const ONLY = process.env.SCREENS_ONLY; // scenes' names, comma separated, to take just those
const LOOKS_ONLY = process.env.SCREENS_LOOKS; // looks' names, comma separated

interface Look {
  name: string;
  theme: "light" | "dark";
  width: number;
  height: number;
}
const LOOKS: Look[] = [
  { name: "light-1440", theme: "light", width: 1440, height: 900 },
  { name: "dark-1440", theme: "dark", width: 1440, height: 900 },
  { name: "light-900", theme: "light", width: 900, height: 760 },
  { name: "dark-900", theme: "dark", width: 900, height: 760 },
  // The narrowest window Corillo allows: the toolbar on one row, with More.
  { name: "light-560", theme: "light", width: 560, height: 700 },
  { name: "dark-560", theme: "dark", width: 560, height: 700 },
];

const PANEL = ".doc:not([hidden]) .comments-panel";
const CANVAS = ".doc:not([hidden]) .canvas:not([hidden])";

async function shot(page: Page, look: Look, name: string): Promise<void> {
  const dir = join(OUT, look.name);
  mkdirSync(dir, { recursive: true });
  await settle(page, 150);
  await stillShot(page, { path: join(dir, `${name}.png`) });
  // The Markdown view's line numbers stay beside their lines, picture or not (review UX-14).
  const drift = await gutterDrift(page);
  if (drift !== null && drift > 1) throw new Error(`${look.name}/${name}: the line numbers are ${drift} px out of step with the Markdown text`);
  // Words that aren't readable against what's behind them, for a look over.
  const low = await unreadable(page);
  if (low.length) appendFileSync(join(dir, "contrast.txt"), `${name}\n${low.map((l) => `  ${l}`).join("\n")}\n`);
}

// Everything a scene starts, closed after it whether it worked or not.
const running: { close(): Promise<unknown> }[] = [];

async function open(look: Look, options: StudioOptions = {}): Promise<Studio> {
  const s = await launch({ theme: look.theme, width: look.width, height: look.height, ...options });
  running.push({ close: () => quit(s.app) });
  return s;
}

/** Scroll the page so this element is near the top. */
async function scrollTo(page: Page, selector: string, offset = 80): Promise<void> {
  await page.evaluate(
    ([sel, canvas, off]) => {
      const el = document.querySelector(sel);
      const scroller = document.querySelector(canvas);
      if (!el || !scroller) throw new Error(`No ${sel}`);
      scroller.scrollTop += el.getBoundingClientRect().top - scroller.getBoundingClientRect().top - off;
    },
    [selector, CANVAS, offset] as const,
  );
  await settle(page, 200);
}

const OTHER_DOC = "# Team offsite\n\nTwo days in Ponce in October, for the whole volunteer team.\n\n## Agenda\n\n- Day one: what went well this year\n- Day two: plans for next year\n";
const NOTES = "# Board notes\n\nThe board met on 3 June. Present: Ana, Marcus, Lucía.\n\n| Item | Owner |\n|---|---|\n| Budget | Ana |\n| Guide | Marcus |\n";
// Empty lines as lines (2026-11-09 night): two and three in a row, a heading's and a table's
// spacing, a list, a quote and a footnote, to be seen with line numbers on.
const EMPTY_LINES =
  "# Volunteer update\n\n\nThanks to everyone who helped this spring.\nWe answered more requests than ever.\n\n\n\n## What's next\n\n- Pick a tool in June\n- Move the busiest inbox in July\n\n> We'd rather grow slowly than hire badly.\n\n| Month | Requests |\n|-------|---------:|\n| April | 590 |\n| May | 610 |\n\nThe numbers come from the shared count.[^count]\n\n[^count]: Counted from the four inboxes, April to June.\n";
/** A connection a tool kept to a copy of Corillo that's gone (on a disk image no longer there). */
const GONE = "/Volumes/Corillo/Corillo.app/Contents";
const MOVED_CONNECTION = JSON.stringify({ mcpServers: { corillo: { type: "stdio", command: `${GONE}/MacOS/Corillo`, args: [`${GONE}/Resources/app.asar.unpacked/dist/mcp.cjs`], env: { ELECTRON_RUN_AS_NODE: "1" } } } }, null, 2) + "\n";
const LETTER = "Dear volunteers,\n\nThank you for a wonderful spring. Here is what's coming up over the summer, and how you can help.\n";

/** An agent on the document, as the tests have it. */
async function agent(s: Studio, name = "claude-code"): Promise<AgentSession> {
  const { session } = await AgentSession.start(s.dataDir, name);
  running.unshift({ close: () => session.stop() });
  return session;
}

/** The sample's comments, an agent's pass answering them, and the status line when it's done. */
async function reviewed(s: Studio): Promise<AgentSession> {
  await sampleComments(s.page);
  const claude = await agent(s);
  await samplePass(claude, s.file);
  await s.page.locator(".doc:not([hidden]) .pass-notice:not([hidden])").waitFor();
  return claude;
}

type Scene = (look: Look) => Promise<void>;

const scenes: Record<string, Scene> = {
  async "start-empty"(look) {
    const s = await open(look, { text: null });
    await rest(s.page);
    await shot(s.page, look, "start-empty");
    await quit(s.app);
  },

  async "start-recent"(look) {
    const s = await open(look, {
      text: null,
      recent: [["Q3 proposal.md", readFileSync(SAMPLE, "utf8")], ["Team offsite.md", OTHER_DOC], ["Board notes.md", NOTES], ["Letter to volunteers.md", LETTER], ["Gone.md", "x"]],
    });
    // One that was moved, for the card that says it can't be found.
    unlinkSync(join(s.folder, "Gone.md"));
    await s.page.evaluate(() => window.dispatchEvent(new Event("focus")));
    await s.page.locator(".recent-item").first().waitFor();
    await settle(s.page, 400);
    await rest(s.page);
    await shot(s.page, look, "start-recent");
    await s.page.locator(".recent-card").first().hover();
    await shot(s.page, look, "start-recent-hover");
    await quit(s.app);
  },

  async document(look) {
    const s = await open(look);
    await rest(s.page);
    await shot(s.page, look, "doc-1-top");
    await scrollTo(s.page, `${EDITOR} img`);
    await shot(s.page, look, "doc-2-picture");
    await scrollTo(s.page, `${EDITOR} table`);
    await shot(s.page, look, "doc-3-table-diagram");
    await scrollTo(s.page, `${EDITOR} .footnote-def`, 400);
    await shot(s.page, look, "doc-4-footnotes");
    // Two documents: the tabs show.
    writeFileSync(join(s.folder, "Team offsite.md"), OTHER_DOC);
    await openFromFinder(s.app, join(s.folder, "Team offsite.md"));
    await s.page.locator(".tab").nth(1).waitFor();
    await rest(s.page);
    await shot(s.page, look, "doc-5-tabs");
    // The proposal, in the background, deleted outside Corillo: its tab's warm dot.
    unlinkSync(s.file);
    await s.page.locator(".tab .tab-problem:not([hidden])").waitFor({ timeout: 10_000 });
    await rest(s.page);
    await shot(s.page, look, "doc-6-tab-warning");
    await quit(s.app);
  },

  // Whose turn on each tab (2026-11-10): a ring in the agent's colour while it edits, filled once it's back.
  async "tab-turns"(look) {
    const s = await open(look);
    await sampleComments(s.page);
    const claude = await agent(s);
    await samplePass(claude, s.file, async () => {
      writeFileSync(join(s.folder, "Team offsite.md"), OTHER_DOC);
      await openFromFinder(s.app, join(s.folder, "Team offsite.md"));
      await s.page.locator('.tab .tab-dot[data-turn="editing"]').waitFor();
      await rest(s.page);
      await shot(s.page, look, "tabs-1-editing");
    });
    await s.page.locator('.tab .tab-dot[data-turn="back"]').waitFor();
    await rest(s.page);
    await shot(s.page, look, "tabs-2-back");
    await quit(s.app);
  },

  async comments(look) {
    const s = await open(look);
    await comment(s.page, "four inboxes and two group chats", "Can we say which inboxes?");
    await rest(s.page);
    await shot(s.page, look, "comments-1-one");
    await comment(s.page, "some people get two answers", "Give an example here.");
    await comment(s.page, "one shared help desk", "Is 'help desk' the word the team uses?");
    await comment(s.page, "Approval to run a three-month trial", "Three months feels short.");
    await comment(s.page, "1,840 requests", "Is this the right number?");
    await comment(s.page, null, "Make the opening friendlier.");
    await rest(s.page);
    await shot(s.page, look, "comments-2-many");
    // Crowded: the one in focus far down, the ones above shrink to make room.
    await s.page.locator(`${PANEL} .comment-card`, { hasText: "Is this the right number?" }).click();
    await settle(s.page, 300);
    await shot(s.page, look, "comments-3-crowded-focus");
    // Resolve one and show resolved.
    const card = s.page.locator(`${PANEL} .comment-card`, { hasText: "Give an example here." });
    await card.click();
    await card.getByRole("button", { name: "Resolve" }).click();
    await settle(s.page, 200);
    await s.page.locator(`${PANEL} .comments-show-resolved`).click();
    await rest(s.page);
    await shot(s.page, look, "comments-4-resolved-shown");
    // A draft, and a reply being typed.
    await selectText(s.page, "what it would cost");
    await s.page.getByRole("button", { name: "Comment", exact: true }).click();
    await s.page.getByRole("textbox", { name: "New comment" }).fill("Add the yearly total.");
    await shot(s.page, look, "comments-5-draft");
    await s.page.getByRole("button", { name: "Cancel" }).click();
    const other = s.page.locator(`${PANEL} .comment-card`, { hasText: "Can we say which inboxes?" });
    await other.click();
    await other.getByRole("textbox", { name: "Reply" }).fill("And the two chats too, please.");
    await shot(s.page, look, "comments-6-reply");
    await quit(s.app);
  },

  async agents(look) {
    const s = await open(look);
    await comment(s.page, "four inboxes and two group chats", "Can we say which inboxes?");
    const claude = await agent(s);
    await claude.ok("take_document", { path: s.file });
    await claude.ok("edit_document", { path: s.file, edits: [{ find: "four inboxes and two group chats", replace: "four inboxes (help, info, volunteers and events) and two group chats" }] });
    await s.page.locator(".doc:not([hidden]) .agent-notice:not([hidden])").waitFor();
    await rest(s.page);
    await shot(s.page, look, "agent-1-editing");
    await finish(claude, s.file);
    await quit(s.app);

    const r = await open(look);
    const c2 = await reviewed(r);
    await rest(r.page);
    await shot(r.page, look, "agent-2-end-of-pass");
    // Going through the cards: one in focus shows the change made for it.
    await r.page.locator(`${PANEL} .comment-card`, { hasText: "Can we say which inboxes?" }).click();
    await settle(r.page, 400);
    await rest(r.page);
    await shot(r.page, look, "agent-3-card-in-focus");
    await r.page.locator(`${PANEL} .comment-card.active`).getByRole("button", { name: /Show what it said before/ }).click({ timeout: 2000 }).catch(() => undefined);
    await rest(r.page);
    await shot(r.page, look, "agent-4-said-before");
    // The done line's Show changes: the pass's changes, the ones no comment asked for too (roadmap Batch 9, item 5).
    await r.page.locator(".doc:not([hidden]) .pass-notice-see").click();
    await settle(r.page, 400);
    await rest(r.page);
    await shot(r.page, look, "agent-5-see-what-changed");
    await clickMenu(r.app, "view-changes");
    // Resolved: the count in the panel's heading, and the resolved cards shown.
    await r.page.locator(`${PANEL} .comment-card`, { hasText: "Make the opening friendlier." }).click();
    await clickMenu(r.app, "review-resolve");
    await r.page.locator(`${PANEL} .comment-card`, { hasText: "Can we say which inboxes?" }).getByRole("button", { name: "Resolve", exact: true }).click();
    await settle(r.page, 300);
    await rest(r.page);
    await shot(r.page, look, "agent-6-resolved-count");
    await r.page.locator(`${PANEL} .comments-show-resolved`).click();
    await settle(r.page, 300);
    await rest(r.page);
    await shot(r.page, look, "agent-7-resolved-shown");
    await r.page.locator(`${PANEL} .comments-show-resolved`).click();
    // Show changes.
    await clickMenu(r.app, "view-changes");
    await settle(r.page, 400);
    await rest(r.page);
    await shot(r.page, look, "changes-1-show-changes");
    await clickMenu(r.app, "view-changes");
    // History, with an older version open.
    await clickMenu(r.app, "view-history");
    await settle(r.page, 300);
    await rest(r.page);
    await shot(r.page, look, "history-1-panel");
    await r.page.locator(".doc:not([hidden]) .history-item").last().click();
    await settle(r.page, 400);
    await rest(r.page);
    await shot(r.page, look, "history-2-old-version");
    void c2;
    await quit(r.app);
  },

  // The top of the Comments panel (New comment, then Copy for Claude) and the done line with
  // Show changes, with the panel at its narrowest and widest (roadmap Batch 9, items 5 and 14).
  async "panel-top"(look) {
    for (const [name, sideWidth] of [["narrowest", 1], ["widest", 4000]] as const) {
      const s = await open(look, { dataFiles: { "view.json": JSON.stringify({ sideWidth }) } });
      await rest(s.page);
      await shot(s.page, look, `panel-top-${name}-empty`);
      // One comment the pass leaves for later, so Copy for Claude shows beside New comment.
      await comment(s.page, "some people get two answers", "Give an example here.");
      await reviewed(s);
      await rest(s.page);
      await shot(s.page, look, `panel-top-${name}-done`);
      await quit(s.app);
    }
  },

  // Send to Claude, the cover note, the dots and counts, the keyboard resting on a card,
  // the option buttons and Show changes stepping (roadmap Batches 1 to 3).
  async send(look) {
    const s = await open(look);
    const { page, app } = s;
    const claude = await agent(s);
    await claude.ok("open_document", { path: s.file });
    let wait = claude.waitForReview();
    await page.locator("#turn-status .turn-text", { hasText: "waiting for your review" }).waitFor();
    await comment(page, "four inboxes and two group chats", "Can we say which inboxes?");
    await comment(page, "1,840 requests", "Is this the right number?");
    await rest(page);
    await shot(page, look, "send-1-waiting");
    await page.locator(`${PANEL} .comments-hand-back`).click();
    const ids = idsIn(await wait.text);
    await page.locator(".doc:not([hidden]) .agent-notice:not([hidden])").waitFor();
    await rest(page);
    await shot(page, look, "send-2-sent");
    const inboxes = ids.get("four inboxes and two group chats");
    const count = ids.get("1,840 requests");
    await claude.ok("edit_document", {
      path: s.file,
      edits: [{ find: "four inboxes and two group chats", replace: "four inboxes (help, info, volunteers and events) and two group chats" }],
      comment_ids: [inboxes],
    });
    await claude.ok("reply_to_comment", { path: s.file, comment_id: inboxes, text: "Named all four." });
    await claude.ok("reply_to_comment", {
      path: s.file,
      comment_id: count,
      text: "Yes: it's from the April to June count. Would a rounder number read better?",
      options: [
        { label: "About 1,800", edits: [{ find: "answered 1,840 requests", replace: "answered about 1,800 requests" }] },
        { label: "About 600 a month", edits: [{ find: "answered 1,840 requests", replace: "answered about 600 requests a month" }] },
      ],
    });
    await claude.ok("finish_editing", { path: s.file, note: "I left the table alone: the costs are the board's to check." });
    wait = claude.waitForReview();
    await page.locator("#turn-status .turn-text", { hasText: "to read" }).waitFor();
    await rest(page);
    await shot(page, look, "send-3-back-with-note");
    // Review > Next Comment: the keyboard rests on the card.
    await clickMenu(app, "review-next");
    await settle(page, 400);
    await rest(page);
    await shot(page, look, "send-4-resting-on-card");
    await clickMenu(app, "review-next");
    await settle(page, 400);
    await page.locator(`${PANEL} .comment-option`, { hasText: "About 1,800" }).click();
    await page.locator(`${PANEL} .comment-option-chosen`).waitFor();
    await settle(page, 300);
    await rest(page);
    await shot(page, look, "send-5-option-chosen");
    // Show changes, stepped to its first change.
    await clickMenu(app, "view-changes");
    await page.locator(".doc:not([hidden]) .version-banner:not([hidden])").waitFor();
    await clickMenu(app, "review-next");
    await settle(page, 400);
    await rest(page);
    await shot(page, look, "send-6-changes-stepping");
    await claude.cancel(wait.id);
    await quit(app);
  },

  // The outline (roadmap Batch 4, item 1): counts, dots, the section in the status bar; turned on with its button at
  // the toolbar's left end (roadmap Batch 9, item 10), or from the menu where the button has gone into More.
  async outline(look) {
    const s = await open(look);
    await reviewed(s);
    const button = s.page.getByRole("button", { name: "Outline", exact: true });
    if (await button.isVisible()) await button.click();
    else await clickMenu(s.app, "view-outline");
    const pane = s.page.locator(".doc:not([hidden]) .outline-pane");
    // It gives way to the page in a narrow window: the status bar names the section instead.
    await settle(s.page, 400);
    const shows = await pane.isVisible();
    await rest(s.page);
    await shot(s.page, look, "outline-1");
    await scrollTo(s.page, `${EDITOR} h3`);
    await rest(s.page);
    await shot(s.page, look, "outline-2-scrolled");
    if (shows) {
      await clickMenu(s.app, "view-changes");
      await s.page.locator(".doc:not([hidden]) .version-banner:not([hidden])").waitFor();
      await settle(s.page, 300);
      await rest(s.page);
      await shot(s.page, look, "outline-3-changes-shown");
    }
    await quit(s.app);
  },

  // History's rows (roadmap Batch 4, item 2): the sections each version touched, your own versions folded.
  async "history-story"(look) {
    const s = await open(look);
    const claude = await reviewed(s);
    // Three edits of the person's in a row, each its own version: the agent takes the document and gives it straight back between them.
    const edits: [string, string][] = [
      ["sat for a week before anyone saw them.", " Some sat longer."],
      ["the numbers and what the volunteers said.", " Ana will bring the slides."],
      ["invite the first five volunteers.", " She'll start this week."],
    ];
    for (const [i, [words, add]] of edits.entries()) {
      await selectText(s.page, words);
      await s.page.keyboard.press("ArrowRight");
      await s.page.keyboard.type(add);
      await settle(s.page, 2600); // saved
      if (i === edits.length - 1) break;
      await claude.ok("take_document", { path: s.file });
      await finish(claude, s.file);
    }
    await clickMenu(s.app, "view-history");
    await s.page.locator(".doc:not([hidden]) .history-item").first().waitFor();
    await settle(s.page, 600);
    await rest(s.page);
    await shot(s.page, look, "history-3-story");
    await quit(s.app);
  },

  // Find reaching the comments (roadmap Batch 4, item 2): the count, then a card.
  async "find-comments"(look) {
    const s = await open(look);
    await sampleComments(s.page);
    await comment(s.page, "Two volunteers answered the same person", "Which inboxes did this happen in?");
    await s.page.locator(`${EDITOR} p`).first().click();
    await s.page.keyboard.press("Meta+f");
    await s.page.keyboard.type("inboxes");
    await settle(s.page, 400);
    await rest(s.page);
    await shot(s.page, look, "find-3-count-in-comments");
    // On past the matches in the text, into the first card.
    for (let i = 0; i < 6 && !/of \d+ in comments/.test((await s.page.locator(".find-bar:visible").first().textContent()) ?? ""); i++) {
      await s.page.keyboard.press("Enter");
      await settle(s.page, 300);
    }
    await rest(s.page);
    await shot(s.page, look, "find-4-in-a-card");
    await quit(s.app);
  },

  // Where each recent document stands (roadmap Batch 4, item 3).
  async "start-states"(look) {
    const s = await open(look, { recent: [["Team offsite.md", OTHER_DOC], ["Board notes.md", NOTES], ["Gone.md", "x"]] });
    const claude = await reviewed(s);
    await claude.ok("finish_editing", { path: s.file, note: "I left the table alone." }).catch(() => undefined);
    // Team offsite: the agent has been on it, and the person's comment hasn't gone to it.
    await openFromFinder(s.app, join(s.folder, "Team offsite.md"));
    await s.page.locator(".tab").nth(1).waitFor();
    await claude.ok("open_document", { path: join(s.folder, "Team offsite.md") });
    await comment(s.page, "Two days in Ponce", "Can we say which weekend?");
    unlinkSync(join(s.folder, "Gone.md"));
    await clickMenu(s.app, "close-tab");
    await settle(s.page, 400);
    await clickMenu(s.app, "close-tab");
    await s.page.locator(".recent-item").first().waitFor();
    await settle(s.page, 600);
    await rest(s.page);
    await shot(s.page, look, "start-states");
    await quit(s.app);
  },

  async find(look) {
    const s = await open(look);
    await s.page.locator(`${EDITOR} p`).first().click();
    await s.page.keyboard.press("Meta+f");
    await s.page.keyboard.type("request");
    await s.page.keyboard.press("Enter");
    await settle(s.page, 300);
    await rest(s.page);
    await shot(s.page, look, "find-1-matches");
    await s.page.keyboard.press("Meta+Alt+f");
    await settle(s.page, 200);
    await shot(s.page, look, "find-2-replace");
    await quit(s.app);
  },

  async views(look) {
    const s = await open(look);
    await clickMenu(s.app, "line-numbers");
    await settle(s.page, 300);
    await rest(s.page);
    await shot(s.page, look, "view-1-line-numbers");
    await comment(s.page, "four inboxes and two group chats", "Can we say which inboxes?");
    await rest(s.page);
    await shot(s.page, look, "view-2-line-numbers-cards");
    await clickMenu(s.app, "view-markdown");
    await settle(s.page, 400);
    await rest(s.page);
    await shot(s.page, look, "view-3-markdown");
    // Scrolled down, the numbers stay beside their lines (shot checks it, after the picture).
    await s.page.evaluate(() => {
      document.querySelector<HTMLElement>(".doc:not([hidden]) .source")!.scrollTop = 600;
    });
    await settle(s.page, 300);
    await shot(s.page, look, "view-3-markdown-scrolled");
    await clickMenu(s.app, "view-formatted");
    await clickMenu(s.app, "line-numbers");
    await clickMenu(s.app, "page-width-fill");
    await settle(s.page, 300);
    await rest(s.page);
    await shot(s.page, look, "view-4-fill-width");
    await clickMenu(s.app, "page-width-fixed");
    await clickMenu(s.app, "zoom-in");
    await clickMenu(s.app, "zoom-in");
    await settle(s.page, 300);
    await rest(s.page);
    await shot(s.page, look, "view-5-zoomed");
    await clickMenu(s.app, "zoom-reset");
    await quit(s.app);
  },

  // Read Aloud's bar, the sentence being read marked and the word being said (roadmap Batch 14, item 4). The
  // pictures' speech is the tests' recorder: nothing is heard, and the scene plays the voice's part.
  async readAloud(look) {
    const s = await open(look);
    await selectText(s.page, "Requests reach us");
    await s.page.keyboard.press("ArrowLeft");
    await settle(s.page);
    await clickMenu(s.app, "read-aloud");
    await s.page.locator(".doc:not([hidden]) .read-aloud-bar").waitFor();
    await s.page.evaluate(() => {
      const speech = (window as unknown as { corilloTests: { speech: { finish(): void; word(at: number, length: number): void } } }).corilloTests.speech;
      speech.finish(); // on to the second sentence
      speech.word(15, 0); // "what's"
    });
    await rest(s.page);
    await shot(s.page, look, "read-aloud-1");
    await quit(s.app);
  },

  // The safety net's notice when a save would lose words (roadmap Batch 14, item 1): a fault planted the
  // way tests/e2e/write-check.spec.ts plants it, since Corillo itself has none to show.
  async heldBack(look) {
    const s = await open(look);
    await s.page.evaluate(() => {
      (window as unknown as { corilloTests: { netFault: unknown } }).corilloTests.netFault = "drop-word-always";
    });
    await selectText(s.page, "Requests reach us");
    await s.page.keyboard.press("ArrowLeft");
    await s.page.keyboard.type("New: ");
    await s.page.locator(".doc:not([hidden]) .file-notice:not([hidden])").first().waitFor({ timeout: 10_000 });
    await rest(s.page);
    await shot(s.page, look, "held-back-1");
    await quit(s.app);
  },

  async more(look) {
    // More is on the bar only when the window is too narrow for every button: it holds what has no room,
    // then Read aloud at its end. In a wide window there is no More, so this scene takes no picture.
    const s = await open(look);
    const more = s.page.getByRole("button", { name: "More", exact: true });
    if (!(await more.isVisible())) return quit(s.app);
    await selectText(s.page, "four inboxes");
    await more.click();
    await rest(s.page);
    await shot(s.page, look, "toolbar-1-more");
    // Insert is in More only in the narrowest windows.
    const insert = s.page.getByRole("menu", { name: "More" }).locator('button[aria-label="Insert"]');
    if (await insert.count()) {
      await insert.click();
      await rest(s.page);
      await shot(s.page, look, "toolbar-2-more-insert");
    }
    await quit(s.app);
  },

  async export(look) {
    const s = await open(look);
    await clickMenu(s.app, "export-settings");
    await settle(s.page, 300);
    await shot(s.page, look, "export-1-settings");
    await s.page.getByRole("button", { name: "Cancel" }).click();
    const pdf = join(s.folder, "Q3 proposal.pdf");
    await s.app.evaluate(({ dialog, shell }, chosen) => {
      dialog.showSaveDialog = (async () => ({ canceled: false, filePath: chosen })) as typeof dialog.showSaveDialog;
      shell.openPath = async () => "";
    }, pdf);
    await clickMenu(s.app, "export-pdf");
    await s.page.locator(".export-notice:not([hidden])[data-state='done']").waitFor({ timeout: 30_000 });
    await rest(s.page);
    await shot(s.page, look, "export-2-notice");
    await quit(s.app);
  },

  async windows(look) {
    const s = await open(look, { text: null, homeFiles: { ".claude.json": "{}\n", ".codex/config.toml": "" } });
    await clickMenu(s.app, "connect-agents");
    await s.page.getByRole("dialog", { name: "Connect your agents" }).waitFor();
    await settle(s.page, 300);
    await shot(s.page, look, "window-1-connect");
    await s.page.getByRole("button", { name: "Done" }).click();
    const [about] = await Promise.all([s.app.waitForEvent("window"), clickMenu(s.app, "about")]);
    await about.emulateMedia({ colorScheme: look.theme });
    await about.waitForLoadState();
    await settle(about, 300);
    await about.screenshot({ path: join(OUT, look.name, "window-2-about.png") });
    const [help] = await Promise.all([s.app.waitForEvent("window"), clickMenu(s.app, "corillo-help")]);
    await help.emulateMedia({ colorScheme: look.theme });
    await help.waitForSelector(".help-page:not([hidden])");
    await help.setViewportSize({ width: Math.min(look.width, 920), height: look.height });
    const pages = await help.locator(".help-pages a").evaluateAll((as) => as.map((a) => a.getAttribute("data-page")!));
    for (const [i, p] of pages.entries()) {
      await help.locator(`.help-pages a[data-page="${p}"]`).click();
      await settle(help, 200);
      await help.screenshot({ path: join(OUT, look.name, `window-3-help-${String(i + 1).padStart(2, "0")}-${p}.png`), fullPage: false });
    }
    await quit(s.app);
  },

  async "empty-lines"(look) {
    const s = await open(look, { text: EMPTY_LINES, name: "Volunteer update.md" });
    await clickMenu(s.app, "line-numbers");
    await settle(s.page, 300);
    await rest(s.page);
    await shot(s.page, look, "lines-1-empty-lines");
    await clickMenu(s.app, "view-markdown");
    await settle(s.page, 400);
    await rest(s.page);
    await shot(s.page, look, "lines-2-markdown");
    await quit(s.app);
  },

  async connect(look) {
    // Opened from the disk image: move Corillo to Applications first.
    const s = await open(look, { text: null, homeFiles: { ".claude.json": "{}\n" } });
    await s.app.evaluate(() => {
      (process as { execPath: string }).execPath = "/Volumes/Corillo/Corillo.app/Contents/MacOS/Corillo";
    });
    await clickMenu(s.app, "connect-agents");
    await s.page.getByRole("dialog", { name: "Connect your agents" }).waitFor();
    await settle(s.page, 300);
    await shot(s.page, look, "connect-2-move-first");
    await quit(s.app);
    // No agent tool on this Mac.
    const none = await open(look, { text: null });
    await clickMenu(none.app, "connect-agents");
    await none.page.getByRole("dialog", { name: "Connect your agents" }).waitFor();
    await settle(none.page, 300);
    await shot(none.page, look, "connect-3-none-found");
    await quit(none.app);
    // Agents can't reach Corillo: where it keeps their connection is taken by a file.
    const cut = await open(look, { text: null, homeFiles: { ".claude.json": "{}\n" }, dataFiles: { sockets: "Not a folder.\n" } });
    await clickMenu(cut.app, "connect-agents");
    await cut.page.locator(".connect-problem").waitFor();
    await settle(cut.page, 300);
    await shot(cut.page, look, "connect-4-cant-reach");
    await quit(cut.app);
  },

  async notices(look) {
    // A tool still pointing at a copy of Corillo that's gone is put right at launch, and the corner says so.
    const s = await open(look, { homeFiles: { ".claude.json": MOVED_CONNECTION } });
    await s.page.locator(".file-notice", { hasText: "Corillo has moved" }).waitFor({ timeout: 15_000 });
    await rest(s.page);
    await shot(s.page, look, "notice-1-connection-moved");
    // The window's page stopped working: a fresh window with the same documents, and a notice.
    const [page] = await Promise.all([
      s.app.waitForEvent("window"),
      s.app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].webContents.forcefullyCrashRenderer()),
    ]);
    await page.emulateMedia({ colorScheme: look.theme });
    await resize(s.app, page, look.width, look.height);
    await page.waitForSelector(".ProseMirror");
    await page.locator(".file-notice", { hasText: "stopped working" }).waitFor();
    await rest(page);
    await shot(page, look, "notice-2-window-reopened");
    await quit(s.app);
  },

  async banners(look) {
    // A picture that can't be found.
    const s = await open(look, { text: "# Launch\n\n![Chart](Launch%20images/chart.png)\n\nThe numbers above are from June.\n", name: "Launch.md" });
    await settle(s.page, 300);
    await rest(s.page);
    await shot(s.page, look, "banner-1-missing-picture");
    // Changed outside Corillo while there were unsaved edits.
    await s.page.locator(`${EDITOR} p`, { hasText: "The numbers" }).click();
    await s.page.keyboard.press("Meta+ArrowRight");
    await s.page.keyboard.type(" Mine.");
    writeFileSync(s.file, "# Launch\n\nTheirs.\n");
    await s.page.locator(".conflict").waitFor();
    await rest(s.page);
    await shot(s.page, look, "banner-2-outside-change");
    await s.page.getByRole("button", { name: "Keep my version" }).click();
    await settle(s.page, 600);
    // Moved or deleted.
    unlinkSync(s.file);
    await s.page.getByRole("button", { name: "Save it where it was" }).waitFor();
    await rest(s.page);
    await shot(s.page, look, "banner-3-moved");
    await s.page.getByRole("button", { name: "Save it where it was" }).click();
    await settle(s.page, 400);
    // An agent that left while a comment waits for it.
    const writer = await agent(s, "writer");
    await writer.ok("open_document", { path: s.file });
    await selectText(s.page, "Mine");
    await s.page.getByRole("button", { name: "Comment", exact: true }).click();
    await s.page.getByRole("textbox", { name: "New comment" }).fill("Say which version.");
    await s.page.getByRole("button", { name: "Post" }).click();
    await writer.stop();
    running.shift();
    await settle(s.page, 600);
    await rest(s.page);
    await shot(s.page, look, "banner-4-agent-left");
    await quit(s.app);
  },
};

test.afterEach(async () => {
  for (const r of running.splice(0)) await r.close().catch(() => undefined);
});

for (const look of LOOKS) {
  if (LOOKS_ONLY && !LOOKS_ONLY.split(",").includes(look.name)) continue;
  test.describe(look.name, () => {
    for (const [name, scene] of Object.entries(scenes)) {
      if (ONLY && !ONLY.split(",").includes(name)) continue;
      test(name, async () => {
        await scene(look);
      });
    }
  });
}

