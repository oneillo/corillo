// Proof, in the real app, that an agent's change (or another app's) shown as
// an edit (roadmap Batch 7) leaves the page as reading it again would: the
// same document, written back the same, and the same things riding on it
// (comment highlights on the same words, the comment cards, line numbers, the
// outline, Find's matches, an agent's change highlights, the word count).
// The same session is played twice, change for change, once as edits and once
// with the page read again each time (a switch only a test's own script can
// set), and the two are compared after every change. Each run is the real
// app, hidden, with throwaway documents and data, and a pretend agent tool
// speaking MCP to it.
import { test, expect, type Page } from "@playwright/test";
import { readFileSync, rmSync, writeFileSync } from "node:fs";
import { clickMenu, openText, settle, EDITOR, type Running } from "./helpers";
import { AgentSession } from "./agent-session";

const PANEL = ".doc:not([hidden]) aside.comments-panel";
const OUTLINE = ".doc:not([hidden]) .outline-pane";

// A plan of every kind of block, "budget" here and there for Find, comments on some of its words.
const DOC = [
  "---",
  "title: Volunteer plan",
  "---",
  "",
  "# Volunteer plan",
  "",
  "We should hire two people this spring, and the budget is tight but workable.",
  "",
  "## Budget",
  "",
  "The budget covers travel, training and the summer event.[^1]",
  "",
  "- travel for the team",
  "- training in March",
  "- the summer event",
  "",
  "| Item | Cost |",
  "|---|--:|",
  "| Travel | 1,200 |",
  "| Training | 800 |",
  "",
  "",
  "",
  "## Risks",
  "",
  "Hiring takes long; the budget may not stretch to a second person.",
  "",
  "1. Interviews run late",
  "",
  "2. Training slips into ==summer==",
  "",
  "> [!note] Keep in mind",
  "> The office moves in June.",
  "",
  "## Schedule",
  "",
  "```",
  "march: interviews",
  "april: training",
  "```",
  "",
  "The schedule is set by the board in [[Board notes]], %%not shared%% each quarter.",
  "",
  "## Notes",
  "",
  "Café, naïve and 日本語 are spelled as the board likes them.",
  "",
  "[^1]: The budget was agreed in January.",
  "",
].join("\n");

/** One change, by an agent through Corillo or by another app saving the file; `shows` is in the page once it's there. */
interface Change {
  by: "agent" | "app";
  edits?: { find: string; replace: string }[];
  /** For replace_document, or another app writing the whole file. */
  whole?: (text: string) => string;
  /** The agent's edit answers the comment in focus: its change is drawn on the page while that card stays in focus. */
  answers?: boolean;
  shows: string;
}

const MOVED = "## Schedule\n\n```\nmarch: interviews\napril: training\n```\n\nThe schedule is set by the board in [[Board notes]], %%not shared%% each quarter.\n\n";

const CHANGES: Change[] = [
  { by: "agent", edits: [{ find: "hire two people", replace: "hire three people" }], shows: "hire three people" },
  { by: "app", edits: [{ find: "## Risks\n", replace: "## Money\n\nA new paragraph about the budget, put in by another app.\n\n## Risks\n" }], shows: "put in by another app" },
  { by: "agent", edits: [{ find: "budget is tight but workable", replace: "budget is very tight" }], answers: true, shows: "budget is very tight" },
  { by: "agent", edits: [{ find: MOVED, replace: "" }, { find: "## Risks\n", replace: `${MOVED}## Risks\n` }], shows: "Schedule" },
  { by: "app", edits: [{ find: "Hiring takes long; the budget may not stretch to a second person.\n\n", replace: "" }], shows: "Interviews run late" },
  { by: "agent", edits: [{ find: "- training in March\n", replace: "- training in March\n- a budget for books\n" }], shows: "a budget for books" },
  { by: "agent", edits: [{ find: "| Training | 800 |", replace: "| Training | 900 |\n| Books | 150 |" }], shows: "Books" },
  { by: "app", edits: [{ find: "\n\n\n\n## Money", replace: "\n\n## Money" }], shows: "Money" },
  { by: "agent", edits: [{ find: "title: Volunteer plan", replace: "title: Volunteer plan, second draft" }, { find: "agreed in January.", replace: "agreed in January, and the budget again in May." }], shows: "again in May" },
  { by: "app", whole: (t) => t.replace(/\n/g, "\r\n"), shows: "Volunteer plan" },
  // The agent's whole text keeps the file's Windows line ends: Corillo keeps them in any case (A16-16).
  { by: "agent", whole: (t) => t.replace("# Volunteer plan", "# Volunteer plan\r\n\r\nA line at the very top about the budget.").replace("[^1]: ", "Last words.\r\n\r\n[^1]: "), shows: "Last words." },
];

/**
 * What the person sees, made comparable: the page (the preview in the
 * Markdown view, with the text and its line numbers), comment ids given as
 * their comment's words, the cards, the outline, Find's matches.
 */
function snapshot(page: Page) {
  return page.evaluate(
    ([editor, panel, outline]) => {
      const front = ".doc:not([hidden])";
      const area = document.querySelector<HTMLTextAreaElement>(`${front} textarea.source`);
      const markdown = !!area && !!area.offsetParent;
      const root = document.querySelector<HTMLElement>(markdown ? `${front} .page.preview .ProseMirror` : `${editor} .ProseMirror`)!;
      // Each comment's id stands for its words, the same in both sessions.
      const bodyOf = new Map<string, string>();
      for (const card of document.querySelectorAll<HTMLElement>(`${panel} .comment-card[data-thread-id]`)) {
        bodyOf.set(card.dataset.threadId!, card.querySelector(".comment-body")?.textContent ?? "");
      }
      const name = (id: string) => bodyOf.get(id) ?? (id === "" ? "" : "other");
      const shape = (node: globalThis.Node): unknown => {
        if (node.nodeType === Node.TEXT_NODE) return node.nodeValue;
        if (!(node instanceof Element)) return null;
        const attrs: string[] = [];
        for (const a of [...node.attributes].sort((x, y) => x.name.localeCompare(y.name))) {
          if (a.name === "data-comment" || a.name === "data-comments") attrs.push(`${a.name}=${a.value.split(" ").map(name).sort().join("|")}`);
          else if (a.name === "class") attrs.push(`class=${[...node.classList].sort().join(" ")}`);
          else attrs.push(`${a.name}=${a.value}`);
        }
        const kids: unknown[] = [];
        let text = "";
        for (const child of node.childNodes) {
          // Text split in two by the page's own workings reads the same: joined.
          if (child.nodeType === Node.TEXT_NODE) text += child.nodeValue;
          else {
            if (text) kids.push(text);
            text = "";
            kids.push(shape(child));
          }
        }
        if (text) kids.push(text);
        return [node.tagName.toLowerCase(), attrs.join(" "), ...kids];
      };
      const cards = [...document.querySelectorAll<HTMLElement>(`${panel} .comment-card`)].map((card) => {
        const clone = card.cloneNode(true) as HTMLElement;
        for (const t of clone.querySelectorAll(".comment-time")) t.remove();
        return `${[...card.classList].sort().join(" ")}: ${(clone.textContent ?? "").replace(/\s+/g, " ").trim()}`;
      });
      const rows = [...document.querySelectorAll<HTMLElement>(`${outline} .outline-row`)].map(
        (row) =>
          `${[...row.classList].sort().join(" ")}${row.querySelector<HTMLElement>(".outline-dot")?.hidden === false ? " (changed)" : ""}: ${(row.textContent ?? "").replace(/\s+/g, " ").trim()}`,
      );
      const matches = [...document.querySelectorAll(`${front} .find-match`)].map((m) => `${m.classList.contains("current") ? "*" : ""}${m.textContent}`);
      const gutter = document.querySelector(`${front} .line-gutter`);
      return {
        page: shape(root),
        text: markdown ? area!.value : null,
        gutter: markdown && gutter ? shape(gutter) : null,
        cards,
        outline: rows,
        find: { count: document.querySelector(".find-count")?.textContent ?? "", matches },
        words: document.querySelector("#word-count")?.textContent ?? "",
      };
    },
    [EDITOR, PANEL, OUTLINE] as const,
  );
}
type Snapshot = Awaited<ReturnType<typeof snapshot>>;

/**
 * Once everything riding on the page has caught up: the same snapshot twice,
 * further apart than any of them waits before looking again (the outline 300
 * ms after the last change, its dots 500, Find 250).
 */
async function settled(page: Page): Promise<Snapshot> {
  let last = await snapshot(page);
  for (let i = 0; i < 20; i++) {
    await page.waitForTimeout(600);
    const now = await snapshot(page);
    if (JSON.stringify(now) === JSON.stringify(last)) return now;
    last = now;
  }
  return last;
}

async function commentOn(page: Page, words: string, body: string): Promise<void> {
  await page.evaluate(
    ([editor, wanted]) => {
      const root = document.querySelector<HTMLElement>(`${editor} .ProseMirror`)!;
      root.focus();
      const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT);
      for (let node = walker.nextNode(); node; node = walker.nextNode()) {
        const at = node.textContent!.indexOf(wanted);
        if (at < 0) continue;
        const range = document.createRange();
        range.setStart(node, at);
        range.setEnd(node, at + wanted.length);
        getSelection()!.removeAllRanges();
        getSelection()!.addRange(range);
        return;
      }
      throw new Error(`"${wanted}" isn't in the document`);
    },
    [EDITOR, words] as const,
  );
  await settle(page);
  await page.getByRole("button", { name: "Comment", exact: true }).click();
  await page.getByRole("textbox", { name: "New comment" }).fill(body);
  await page.getByRole("button", { name: "Post" }).click();
  await expect(page.locator(`${PANEL} .comment-card:not(.draft)`, { hasText: body })).toBeVisible();
}

const runs: Running[] = [];
const sessions: AgentSession[] = [];

test.afterEach(async () => {
  await Promise.all(sessions.splice(0).map((s) => s.stop()));
  for (const r of runs.splice(0)) {
    const home = await r.app.evaluate(() => process.env.CORILLO_HOME).catch(() => undefined);
    await r.app.close().catch(() => undefined);
    for (const dir of [r.folder, r.dataDir, home]) if (dir) rmSync(dir, { recursive: true, force: true });
  }
});

/** The document's first block, as the editor holds it (its own record of it), kept to compare with after a change. */
const keepFirst = (page: Page) =>
  page.evaluate((editor) => {
    const w = window as unknown as { firstBlock: unknown };
    w.firstBlock = (document.querySelector(`${editor} .ProseMirror`) as unknown as { pmViewDesc: { node: { firstChild: unknown } } }).pmViewDesc.node.firstChild;
  }, EDITOR);
/** Whether the first block is still the very one kept: an edit keeps a block it didn't touch, reading the page again makes every block anew. */
const firstKept = (page: Page) =>
  page.evaluate(
    (editor) =>
      (document.querySelector(`${editor} .ProseMirror`) as unknown as { pmViewDesc: { node: { firstChild: unknown } } }).pmViewDesc.node.firstChild ===
      (window as unknown as { firstBlock: unknown }).firstBlock,
    EDITOR,
  );
/** The document's first block as the file writes it (its front matter), whatever the line endings. */
const firstBlockOf = (text: string) => text.replace(/\r\n/g, "\n").split("\n\n")[0];

/**
 * The session: comments, line numbers, the outline and Find on, then each
 * change, in the view given. The snapshots after each, and for each change
 * whether the first block was kept through it.
 */
async function session(readAgain: boolean, view: "Formatted" | "Markdown"): Promise<{ snaps: Snapshot[]; file: string; texts: string[]; kept: boolean[] }> {
  const run = await openText(DOC, { name: "plan.md" });
  runs.push(run);
  const { page, app, file } = run;
  await page.setViewportSize({ width: 1400, height: 1000 });
  await clickMenu(app, "line-numbers");
  await clickMenu(app, "view-outline");
  await expect(page.locator(`${OUTLINE} .outline-row`)).toHaveCount(5);
  await commentOn(page, "hire two people", "Is two enough?");
  await commentOn(page, "budget is tight", "How tight?");
  await commentOn(page, "the budget may not stretch", "Say more.");
  await commentOn(page, "set by the board", "Which meeting?");
  await commentOn(page, "Café, naïve", "Check the spelling.");
  // The cursor in a paragraph none of the changes touches.
  await commentOn(page, "summer event.", "Which event?");
  if (view === "Markdown") await page.getByRole("button", { name: "Markdown" }).click();
  await page.evaluate((again) => ((window as unknown as { corilloTests: { readAgain: boolean } }).corilloTests.readAgain = again), readAgain);
  await page.keyboard.press("Meta+f");
  await page.keyboard.type("budget");
  await expect(page.locator(".find-count")).not.toBeEmpty();
  const { session: claude } = await AgentSession.start(run.dataDir);
  sessions.push(claude);
  const snaps: Snapshot[] = [await settled(page)];
  const texts: string[] = [];
  const kept: boolean[] = [];
  for (const change of CHANGES) {
    await keepFirst(page);
    let text = readFileSync(file, "utf8");
    if (change.whole) text = change.whole(text);
    else for (const e of change.edits!) {
      expect(text, e.find).toContain(e.find);
      text = text.replace(e.find, e.replace);
    }
    if (change.by === "app") writeFileSync(file, text);
    else {
      await claude.ok("take_document", { path: file });
      const answering = change.answers ? { comment_ids: [await page.locator(`${PANEL} .comment-card.active`).getAttribute("data-thread-id")] } : {};
      if (change.whole) await claude.ok("replace_document", { path: file, text });
      else await claude.ok("edit_document", { path: file, edits: change.edits, ...answering });
      if ((await claude.call("finish_editing", { path: file })).isError) await claude.ok("finish_editing", { path: file });
    }
    await expect.poll(() => readFileSync(file, "utf8")).toBe(text);
    if (view === "Formatted") await expect(page.locator(EDITOR)).toContainText(change.shows);
    else await expect(page.locator(".doc:not([hidden]) textarea.source")).toHaveValue(text.replace(/\r\n/g, "\n"));
    snaps.push(await settled(page));
    texts.push(readFileSync(file, "utf8"));
    kept.push(await firstKept(page));
  }
  return { snaps, file, texts, kept };
}

for (const view of ["Formatted", "Markdown"] as const) {
  test(`in the ${view} view, eleven changes by an agent and another app shown as edits leave the page, the comments, line numbers, outline and Find just as reading the page again does`, async () => {
    test.setTimeout(240_000);
    const asEdits = await session(false, view);
    const readAgain = await session(true, view);
    // The same file, change for change.
    expect(asEdits.texts).toEqual(readAgain.texts);
    // Each change was shown as an edit in the one session and by reading the page again in the other: the first
    // block, where the change didn't touch it, is the very one the page had before it, and only when shown as an edit.
    let checked = 0;
    for (let i = 0; i < CHANGES.length; i++) {
      if (firstBlockOf(asEdits.texts[i]) !== firstBlockOf(i ? asEdits.texts[i - 1] : DOC)) continue;
      const label = `change ${i + 1} (${CHANGES[i].by}: ${CHANGES[i].shows})`;
      expect(asEdits.kept[i], `${label} shown as an edit`).toBe(true);
      expect(readAgain.kept[i], `${label} shown by reading the page again`).toBe(false);
      checked++;
    }
    expect(checked).toBeGreaterThanOrEqual(CHANGES.length - 1);
    for (let i = 0; i < asEdits.snaps.length; i++) {
      const label = i ? `after change ${i} (${CHANGES[i - 1].by}: ${CHANGES[i - 1].shows})` : "before the changes";
      expect(asEdits.snaps[i].page, `the page, ${label}`).toEqual(readAgain.snaps[i].page);
      expect(asEdits.snaps[i].text, `the Markdown text, ${label}`).toEqual(readAgain.snaps[i].text);
      expect(asEdits.snaps[i].gutter, `the Markdown text's line numbers, ${label}`).toEqual(readAgain.snaps[i].gutter);
      expect(asEdits.snaps[i].cards, `the comment cards, ${label}`).toEqual(readAgain.snaps[i].cards);
      expect(asEdits.snaps[i].outline, `the outline, ${label}`).toEqual(readAgain.snaps[i].outline);
      expect(asEdits.snaps[i].find, `Find's matches, ${label}`).toEqual(readAgain.snaps[i].find);
      expect(asEdits.snaps[i].words, `the word count, ${label}`).toEqual(readAgain.snaps[i].words);
    }
    // What was compared was there: comments' highlights, line numbers, the agent's change drawn, the outline's new heading, Find's matches.
    const last = asEdits.snaps.at(-1)!;
    const shown = JSON.stringify(last.page);
    for (const there of ["data-comment", "change-mark", ...(view === "Formatted" ? ["data-ln", "find-match"] : [])]) expect(shown, there).toContain(there);
    if (view === "Markdown") expect(JSON.stringify(last.gutter)).toContain("line-gutter");
    expect(last.find.count).toMatch(/^\d+ matches$/);
    expect(last.outline.join("\n")).toContain("Money");
  });
}
