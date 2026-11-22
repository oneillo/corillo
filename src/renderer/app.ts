// Corillo's window: a tab for each open document, the toolbar, the status bar,
// and the start screen shown when nothing is open.
import { setImageResolver } from "../core/schema";
import type { AgentInfo, CorilloApi, DocInfo } from "../preload/preload";
import { DocTab, type SaveState, type TabHost } from "./doc-tab";
import { insertPictureFromDialog } from "./images";
import { createToolbar, type Mode } from "./toolbar";
import { setUpConnectScreen } from "./connect-agents";
import { setupExport } from "./export";
import { createHistory } from "./history";
import { setUpTurns, turnOf, turnWords as statusBarWords } from "./turns";
import { setupEveryday } from "./everyday";
import { setupColumns } from "./columns";
import { setupLineNumbers } from "./line-numbers";
import { ICONS } from "./icons";
import { setUpStartScreen } from "./start-screen";
import { setUpReview } from "./review";
import { setChangeCheck, setCommentsHidden, setNewComment } from "./comments-panel";
import { commentsOnScreen, setUpWindowMenus, toggleComments } from "./menus";
import { movable, setUpMore } from "./more";
import { PopupMenu, refreshOpenMenus } from "./popup-menu";
import { setUpUndoResolve, undoReopens, undoResolve } from "./undo-resolve";
import { noticeOn } from "./file-notice";
import { editable, typingElsewhere, whyNotChangeable, writingState } from "./editable";
import { turnWords, type TabTurn } from "./turn-words";
import { playCall, stopCall } from "./coqui";
import { coquiFrog, frogsChanged, paintFrog } from "./tab-coqui";
import { setUpOutline } from "./outline";
import { OPENS_WHEN_DROPPED, shownName } from "../core/doc-names";
import { setUpTabDrag } from "./tab-drag";
import { tellTabOrder } from "./tab-order";
import { setUpAreas } from "./window-areas";
import { setUpReadAloud } from "./read-aloud";

declare global {
  interface Window {
    corillo: CorilloApi;
  }
}

const api = window.corillo;

// View > Page Width: a fixed column, or the text filling the window.
const applyPageWidth = (width: string) => {
  document.documentElement.dataset.pageWidth = width;
};
void api.pageWidth().then(applyPageWidth);
api.onPageWidth(applyPageWidth);
const $ = <T extends HTMLElement>(id: string) => document.getElementById(id) as T;
const tabBar = $("tabs");
const docsEl = $("docs");
const emptyEl = $("empty");
const recentEl = $("recent");
const statusEl = $("save-status");
// Screen readers hear when the document isn't saved, and why; not "Saved" after every pause.
const notSavedTold = $("not-saved-told");
// And a tab's new place when it's moved with a key ("Plan, moved to 2 of 5"): roadmap Batch 10, item 1.
const tabMovedTold = document.createElement("span");
tabMovedTold.className = "screen-reader-only";
tabMovedTold.setAttribute("role", "status");
notSavedTold.after(tabMovedTold);
const wordsEl = $("word-count");
// Whose turn it is: "With you", or "Claude is editing" with its colour.
const turnEl = $("turn-status");
const turnDot = turnEl.querySelector<HTMLElement>(".turn-dot")!;
const turnWho = turnEl.querySelector<HTMLElement>(".turn-who")!;
const turnRead = turnEl.querySelector<HTMLElement>(".turn-read")!;
const copyPathButton = $<HTMLButtonElement>("copy-path");
const commentsButton = $<HTMLButtonElement>("comments-toggle");
// Only in the Markdown view, where the marks are on screen: what they mean.
const markdownHelpButton = $<HTMLButtonElement>("markdown-help");

const tabs: DocTab[] = [];
let active: DocTab | null = null;
// A tab dragged along the bar to a new place comes to the front there (roadmap Batch 10, item 1).
const tabDrag = setUpTabDrag({
  bar: tabBar,
  drop(id, to) {
    const tab = tabs.find((t) => t.id === id);
    if (!tab) return;
    placeTab(tab, to);
    activate(tab);
  },
});
/** Tell the menu bar what applies now (set once the menus are wired up, below). */
let updateMenus = () => {};
// Review > Read Aloud, also at the end of More (roadmap Batch 14, item 4).
const readAloud = setUpReadAloud({
  api,
  active: () => active,
  isViewing: (tab) => historyUi.isViewing(tab),
  changed: () => {
    updateMenus();
    refreshOpenMenus();
  },
});
const review = setUpReview({
  api,
  tabs: () => tabs,
  active: () => active,
  changed: () => updateMenus(),
  showComments: (tab) => commentsInView(tab),
  stepChanges: (tab, forward) => historyUi.step(tab, forward),
  // "See what changed" on the line when an agent is done (roadmap Batch 9, item 5), from a version shown too (B9-03).
  showChanges: (tab) => historyUi.showChanges(tab),
});

/** The Comments panel comes on screen: History gives up its place (a version shown is left alone). */
function commentsInView(tab: DocTab): void {
  if (historyUi.status(tab).panelOpen && !historyUi.isViewing(tab)) historyUi.togglePanel(tab);
}

/**
 * A comment can be started on the document: also while Show changes is on (roadmap Batch 25, item 1), its page still
 * read-only; not while an earlier version from History is shown.
 */
function canCommentOn(tab: DocTab): boolean {
  return !historyUi.isViewing(tab) || historyUi.status(tab).changes;
}

/** What Comment says when only words Show changes shows as removed are selected (roadmap Batch 25, item 1). */
const REMOVED_WORDS = "These words were removed. Select words that are still in the document to comment.";

/** Start a comment (Comment, Insert > New Comment, ⌥⌘M, the panel's New comment), with its box on screen; nothing where it's greyed out. */
function startComment(): void {
  if (!active || !canCommentOn(active)) return;
  const shown = historyUi.status(active);
  if (shown.changes) {
    // Show changes stays on; the comment is made on the same words in the document, nothing done to the page shown.
    const picked = historyUi.commentPick(active);
    if (shown.panelOpen) historyUi.togglePanel(active); // History gives the comments their place, Show changes stays
    if (picked === "removed") active.comments.tell(REMOVED_WORDS);
    else active.addCommentOn(picked ?? { from: 0, to: 0 });
    return;
  }
  commentsInView(active);
  active.addComment();
}

/** Save states where the document needs the person: its tab carries a small warm mark, wherever it is. */
const NEEDS_YOU = new Set<SaveState>(["conflict", "missing", "trashed", "recovered", "error"]);
/** What the tab's mark says (the status bar's words), or null for none. */
const problemOf = (tab: DocTab): string | null => (NEEDS_YOU.has(tab.status) ? tab.statusLabel() : null);
/** What each tab's mark says on screen now, so the bar is drawn again only when that changes. */
const problemShown = new WeakMap<DocTab, string | null>();

// It's your turn (roadmap Batch 2, item 2). Each tab shows whose turn it is:
// a small coquí in the agent's colour while it edits (since Batch 9; a hollow
// ring before), a filled dot while the document waits for the person, and the tooltip says which. The app is told
// which documents are waiting, for the Dock's count, the Window menu and the
// coquí call (src/main/your-turn.ts). A document waits from when it comes
// back from an agent, or an agent opens it for the person, until they look
// at it: its tab brought to the front, a click or a key in it, or Corillo
// coming to the front with it in front (tab.backToYou, the dot's own rule).

/** The agents on each document, as last announced, and the one that last edited it ("Back from Writer"). */
const agentsOn = new WeakMap<DocTab, AgentInfo[]>();
const lastEditor = new WeakMap<DocTab, AgentInfo>();
/** The agent that opened the document for the person, while that's why it waits. */
const openedBy = new WeakMap<DocTab, string>();
/** Whether Corillo is the app in front: the document in front is then being looked at. */
let inFront = false;
/** What each tab's dot says now, so the bar is drawn again only when that changes. */
const turnShown = new WeakMap<DocTab, string>();
/** What the app was last told, so it's told only of a change. */
let turnsTold = "";

/** Whose turn it is on this tab, as its dot shows it; null on a document no agent has worked on. */
function tabTurn(tab: DocTab): TabTurn | null {
  const turn = turnOf(tab);
  if (turn?.agent) return { kind: "editing", agent: turn.agent.name, colour: turn.agent.colour };
  if (tab.backToYou) {
    const opener = openedBy.get(tab);
    const from = opener ? (agentsOn.get(tab)?.find((a) => a.name === opener) ?? null) : (lastEditor.get(tab) ?? null);
    return { kind: "back", agent: opener ?? from?.name ?? null, colour: from?.colour ?? null, opened: !!opener, toRead: { cards: tab.comments.unreadCount } };
  }
  return turn ? { kind: "with-you" } : null;
}

/** The coquí on each tab an agent is working on, kept from one drawing of the bar to the next so a hop isn't cut short. */
const tabFrogs = new WeakMap<DocTab, HTMLElement>();

/** This tab's coquí, in the agent's colour. */
function frogOn(tab: DocTab, colour: string): HTMLElement {
  const kept = tabFrogs.get(tab);
  if (kept) {
    paintFrog(kept, colour);
    return kept;
  }
  const frog = coquiFrog(colour);
  tabFrogs.set(tab, frog);
  return frog;
}

const turnKey = (turn: TabTurn | null): string => (turn ? `${turn.kind}\n${turnWords(turn)}\n${turn.kind === "with-you" ? "" : turn.colour}` : "");

const host: TabHost = {
  api,
  changed(tab) {
    readAloud.check(); // the document changed under Read Aloud, or its page went out of sight: it stops
    // Typing in a tab has looked at it already, so this costs nothing then.
    if (problemOf(tab) !== (problemShown.get(tab) ?? null) || (tab.backToYou && turnKey(tabTurn(tab)) !== turnShown.get(tab))) renderTabs();
    if (tab !== active) return;
    toolbar.update();
    historyUi.update();
    updateStatus();
    everyday.sync();
    updateMenus();
    refreshOpenMenus();
  },
  renamed(tab) {
    renderTabs();
    if (tab === active) {
      updateStatus();
      api.active(tab.id); // the window's title names it
    }
  },
  close: (tab) => void closeTab(tab),
  openLinkEditor: () => toolbar.openLinkEditor(),
};

const toolbar = createToolbar($("toolbar"), {
  view: () => (active && !active.readOnly && !historyUi.isViewing(active) ? active.view : null), // greyed out while an agent edits or a version is shown
  // The same answer as the menu bar's: greyed out also while the keyboard is in a comment box or the link editor.
  writing: () => writingState(active, historyUi, "toolbar"),
  // The style box names the paragraph even while it's greyed out (roadmap Batch 11, F-14).
  shown: () => (active?.mode === "formatted" && !historyUi.isViewing(active) ? active.view.state : null),
  mode: () => active?.mode ?? "formatted",
  setMode: (mode: Mode) => active?.setMode(mode),
  insertPicture: () => {
    if (active) void insertPictureFromDialog(active.view, active.store);
  },
  addComment: () => startComment(),
  // The person can comment in either view, and while an agent edits, but not on an old version.
  canComment: () => !!active && canCommentOn(active),
  undoResolve: (perform) => (perform ? undoResolve(active?.comments) : undoReopens(active?.comments)),
});
// Undo straight after Resolve reopens the comment, wherever the keyboard is.
setUpUndoResolve(() => active?.comments ?? null);
// The writing buttons grey out as the keyboard goes into a comment box or the link editor, and light up as it leaves.
// Once a frame: the keyboard leaving one place and arriving at the next is one change.
let focusMoved = 0;
const afterFocusMoves = () => {
  focusMoved ||= requestAnimationFrame(() => {
    focusMoved = 0;
    toolbar.update();
  });
};
document.addEventListener("focusin", afterFocusMoves);
document.addEventListener("focusout", afterFocusMoves);

// Word and PDF export: the Export menu at the right of the toolbar, and its notices.
setupExport({ api, activeTab: () => active, toolbar: $("toolbar") });
// Show changes, and the History panel (see history.ts).
const historyUi = createHistory($("toolbar"), {
  api,
  active: () => active,
  changed: () => {
    readAloud.check(); // a version or Show changes in place of the page Read Aloud reads: it stops
    toolbar.update();
    // The panel's New comment greys out with Comment, on every tab (review of Batch 9, B9-02).
    for (const tab of tabs) tab.comments.setCanComment(canCommentOn(tab));
    updateStatus();
    updateMenus();
    refreshOpenMenus();
  },
});
// The Comments panel's button, beside Comment: its icon and the open comments' count, named in its tooltip.
const commentsTool = document.createElement("button");
commentsTool.type = "button";
commentsTool.className = "tool tool-text comments-tool";
commentsTool.innerHTML = `${ICONS.comments}<span class="tool-count" hidden></span>`;
commentsTool.addEventListener("mousedown", (e) => e.preventDefault()); // keep the cursor in the document
commentsTool.addEventListener("click", () => {
  if (active) toggleComments(active, historyUi);
});
$("toolbar").querySelector(".comment-tools")?.append(commentsTool);
movable("comments", commentsTool);
// View > Show Outline: the headings at the left of the page, and the section in sight in the status bar (roadmap Batch 4,
// item 1), with its button at the toolbar's left end (roadmap Batch 9, item 10), set up before the toolbar's fitting.
const outline = setUpOutline({ api, active: () => active, tab: (id) => tabs.find((t) => t.id === id), history: historyUi, status: $("outline-section"), toolbar: $("toolbar") });
// One row at any width: what doesn't fit goes into More, at the right end (more.ts).
setUpMore($("toolbar"), { focusDocument: () => active?.focus(), always: () => [readAloud.moreEntry()] });
// Hidden on every document if the person hid it last time.
void api.commentsHidden().then(setCommentsHidden);
// Find and Replace, the right-click menu's actions, paste and copy, zoom.
const everyday = setupEveryday({
  active: () => active,
  editable: () => editable(active, historyUi),
  openLinkEditor: () => toolbar.openLinkEditor(),
  refreshStatus: () => updateStatus(),
});
// The side panel's width and the Markdown view's two halves, which the person can drag.
setupColumns();
setupLineNumbers(api);
// An agent's option applies only when the person could change the document themselves (roadmap Batch 3, item 2).
setChangeCheck((id) => {
  const tab = tabs.find((t) => t.id === id);
  return tab ? whyNotChangeable(tab, historyUi) : "agent";
});
// The Comments panel's New comment does what Comment does (roadmap Batch 9, item 14).
setNewComment(() => startComment());
// The menu bar: what applies now, the items that act on the document, their shortcuts, and the right-click menu.
const menus = setUpWindowMenus({
  api,
  active: () => active,
  tabs: () => tabs,
  tabToMove,
  history: historyUi,
  review,
  openLinkEditor: () => toolbar.openLinkEditor(),
  insertPicture: (tab) => void insertPictureFromDialog(tab.view, tab.store),
  readAloud,
});
updateMenus = () => menus.schedule();
// F6 and Shift-F6, and View > Go to Next and Previous Area: the keyboard from area to area (roadmap Batch 12, G-1).
const windowAreas = setUpAreas({ active: () => active });

// Tabs ---------------------------------------------------------------------------

function open(info: DocInfo, background: boolean): void {
  const tab = new DocTab(info, host);
  review.attach(tab);
  tabs.push(tab);
  docsEl.append(tab.el);
  if (!background || !active) activate(tab);
  else renderTabs();
}

/**
 * Bring a tab to the front (null: the start screen). The keyboard goes into it
 * a frame later, where the person left it, unless it was in front already
 * with the keyboard in one of its boxes (Command-1 on tab 1 while replying);
 * `focus`: put it there anyway (going back to a comment from closing);
 * `onTabs`: leave the keyboard in the tab bar (Delete on the tab in front).
 */
function activate(tab: DocTab | null, focus = false, onTabs = false): void {
  const stays = !focus && tab === active && !!tab && tab.el.contains(document.activeElement) && typingElsewhere(true);
  active = tab;
  if (tab) tab.backToYou = false; // the person is looking at it now
  for (const t of tabs) {
    if (t !== tab && !t.el.hidden) t.putAway(); // while the keyboard is still where the person left it
    t.el.hidden = t !== tab;
    if (t.el.hidden) review.putAway(t);
  }
  emptyEl.hidden = !!tab;
  document.body.classList.toggle("has-docs", !!tab);
  if (tab) {
    // The start screen is out of sight, so it holds nothing (cards that came just before a document did included);
    // it's drawn afresh when it shows again.
    recentEl.replaceChildren();
    setImageResolver((src) => tab.store.resolve(src)); // a web picture an agent added that waits: nothing to load, even in a copy
    // Only if it's still in front by then: quick switching (key repeat on Command-Shift-]) can pass it by.
    if (!stays && !onTabs) requestAnimationFrame(() => active === tab && tab.focus());
  } else {
    setImageResolver((src) => src); // so a closed document isn't kept in memory
    void startScreen.show(true); // with the keyboard on the first recent document
  }
  api.active(tab ? tab.id : null);
  readAloud.check(); // another tab in front: Read Aloud stops
  renderTabs();
  toolbar.update();
  historyUi.update();
  updateStatus();
  everyday.sync();
  updateMenus();
}

/**
 * Tabs being closed, each with its close. Closing one again meanwhile (Command-W
 * twice, its cross, the Trash closing it too) waits for that close instead of
 * starting another: one question, one save, and never another tab taken out.
 */
const closing = new Map<DocTab, Promise<void>>();

function closeTab(tab: DocTab, fromTabBar = false): Promise<void> {
  const already = closing.get(tab);
  if (already) return already;
  if (!tabs.includes(tab)) return Promise.resolve();
  const close = closeNow(tab, fromTabBar).finally(() => closing.delete(tab));
  closing.set(tab, close);
  return close;
}

async function closeNow(tab: DocTab, fromTabBar: boolean): Promise<void> {
  if (!(await tab.prepareToClose())) {
    if (tabs.includes(tab)) activate(tab, true); // to the comment the person went back to
    return;
  }
  const index = tabs.indexOf(tab);
  if (index < 0) return;
  tabs.splice(index, 1);
  historyUi.forget(tab);
  readAloud.forget(tab);
  tab.destroy();
  api.closed(tab.id);
  if (active === tab) activate(tabs[index] ?? tabs[index - 1] ?? null, false, fromTabBar);
  else renderTabs();
}

function cycle(step: number): void {
  if (!active || tabs.length < 2) return;
  const index = tabs.indexOf(active);
  activate(tabs[(index + step + tabs.length) % tabs.length]);
}

// His order for the tabs (roadmap Batch 10, item 1): it's the order of `tabs`, so Show Next and Previous Tab,
// Command-1 to 9 and the Window menu's list all go by it.

/** Put a tab at this place among the tabs. Whether it moved. */
function placeTab(tab: DocTab, to: number): boolean {
  const from = tabs.indexOf(tab);
  if (from < 0 || to < 0 || to >= tabs.length || to === from) return false;
  tabs.splice(from, 1);
  tabs.splice(to, 0, tab);
  return true;
}

/** The tab Move Tab Left and Right move: the one the keyboard is on in the tab bar, or else the one in front. */
function tabToMove(): DocTab | null {
  const id = document.activeElement?.closest<HTMLElement>(".tabs .tab")?.dataset.docId;
  return tabs.find((t) => t.id === id) ?? active;
}

/** Window > Move Tab Left or Right, or their keys: one place along, never round from an end; screen readers hear where it went. */
function moveTab(step: number): void {
  const tab = tabToMove();
  if (!tab || !placeTab(tab, tabs.indexOf(tab) + step)) return;
  renderTabs(); // the keyboard stays on it, if it was on the tab bar
  const said = `${shownName(tab.name)}, moved to ${tabs.indexOf(tab) + 1} of ${tabs.length}`;
  // Said again if it's the same as last time (moved there, away and back).
  tabMovedTold.textContent = tabMovedTold.textContent === said ? `${said}\u00a0` : said;
}

function renderTabs(): void {
  updateMenus(); // Show Next Tab applies with two or more
  allTabsMenu.refresh(); // open, it lists the tabs as they are now: one closed goes (review of Batch 12, B12-2)
  // The document in front, with Corillo in front, is being looked at.
  if (inFront && active?.backToYou) active.backToYou = false;
  const turns = new Map(tabs.map((tab) => [tab, tabTurn(tab)]));
  // One document needs no tab bar: the window's title names it (Orlando).
  document.body.classList.toggle("single-doc", tabs.length === 1);
  // The tab the keyboard is on, if it's in the bar: it keeps it once the bar is drawn again.
  const focusedId = document.activeElement?.closest<HTMLElement>(".tabs .tab")?.dataset.docId;
  const keyboardOn = tabs.find((t) => t.id === focusedId) ?? active;
  tabBar.replaceChildren(
    ...tabs.map((tab) => {
      const item = document.createElement("div");
      item.className = "tab";
      item.setAttribute("role", "tab");
      item.setAttribute("aria-selected", String(tab === active));
      // One stop for the whole bar, on the tab in front; the arrows move from tab to tab (see below).
      item.tabIndex = tab === keyboardOn ? 0 : -1;
      item.dataset.docId = tab.id;
      // Whose turn: a coquí in the agent's colour while it edits (it hops: tab-coqui.ts), a dot in that colour while the document waits for the person.
      const turn = turns.get(tab) ?? null;
      turnShown.set(tab, turnKey(turn));
      const marked = turn?.kind === "editing" || turn?.kind === "back" ? turn : null;
      const words = marked ? turnWords(marked) : "";
      item.title = marked ? `${words}\n${tab.filePath}` : tab.filePath;
      const dot = document.createElement("span");
      dot.className = "tab-dot";
      dot.hidden = !marked;
      if (marked) {
        dot.dataset.turn = marked.kind;
        dot.title = words;
        if (marked.colour) {
          dot.dataset.colour = marked.colour;
          dot.style.setProperty("--dot-colour", `var(--agent-${marked.colour})`);
        }
      }
      if (marked?.kind === "editing") dot.append(frogOn(tab, marked.colour));
      else tabFrogs.delete(tab);
      // A warm mark when the document isn't saved and needs the person, saying why, so a tab out of sight tells too.
      const problem = problemOf(tab);
      problemShown.set(tab, problem);
      const mark = document.createElement("span");
      mark.className = "tab-problem";
      mark.hidden = !problem;
      if (problem) mark.title = problem;
      // Its name as the person knows it, without ".md" (roadmap Batch 5, item 2); the tooltip has the file's path.
      const shown = shownName(tab.name);
      const name = document.createElement("span");
      name.className = "tab-name";
      name.textContent = shown;
      // What the dot and the mark mean, for screen readers too ("plan, back from Claude: 3 to read").
      const lower = (s: string) => s[0].toLowerCase() + s.slice(1);
      const said = [shown, marked?.kind === "back" ? lower(words) : words, problem ? lower(problem) : ""];
      item.setAttribute("aria-label", said.filter(Boolean).join(", "));
      const close = document.createElement("button");
      close.type = "button";
      close.className = "tab-close";
      close.setAttribute("aria-label", `Close ${shown}`);
      close.tabIndex = -1; // with the keyboard, Delete on the tab closes it
      close.innerHTML = ICONS.close;
      close.addEventListener("click", (e) => {
        e.stopPropagation();
        void closeTab(tab);
      });
      // A click doesn't move the keyboard to the tab itself (only Tab does): it would leave
      // a comment being written before the tab is put away, and couldn't come back to it.
      // Bringing the tab to the front puts the keyboard where that tab had it.
      item.addEventListener("mousedown", (e) => {
        if (e.button === 0 || e.button === 1) e.preventDefault();
      });
      item.addEventListener("auxclick", (e) => {
        if (e.button === 1) void closeTab(tab);
      });
      item.addEventListener("click", () => activate(tab));
      item.append(dot, mark, name, close);
      return item;
    }),
  );
  tabDrag.redrawn(); // a tab being dragged stays under the pointer, the others aside
  if (focusedId) tabBar.querySelector<HTMLElement>('.tab[tabindex="0"]')?.focus();
  showFrontTab();
  frogsChanged(); // hopping while an agent works on a document, and nothing running once none does
  tellTurns(turns);
  tellTabOrder(tabs, renderTabs); // the list Corillo brings back at launch (tab-order.ts)
}

/** Tell the app whose turn it is on each document, and which wait for the person, when that changed. */
function tellTurns(turns: Map<DocTab, TabTurn | null>): void {
  const list = tabs.map((tab) => {
    const turn = turns.get(tab) ?? null;
    // The Window menu names it as its tab does.
    return { id: tab.id, name: shownName(tab.name), state: turn ? turnWords(turn) : "", waiting: turn?.kind === "back" };
  });
  const told = JSON.stringify(list);
  if (told === turnsTold) return;
  turnsTold = told;
  api.turns(list);
}

// The tab bar from the keyboard, as tabs work on the Mac: Tab reaches the tab in
// front; Left and Right move from tab to tab (round from the ends), Home and End
// to the ends; Return or Space brings the tab to the front; Delete closes it.
tabBar.addEventListener("keydown", (e) => {
  const item = (e.target as Element).closest<HTMLElement>(".tab");
  if (!item || e.metaKey || e.ctrlKey || e.altKey) return;
  const items = [...tabBar.querySelectorAll<HTMLElement>(".tab")];
  const at = items.indexOf(item);
  const tab = tabs.find((t) => t.id === item.dataset.docId);
  let to: HTMLElement | undefined;
  if (e.key === "ArrowLeft") to = items[(at - 1 + items.length) % items.length];
  else if (e.key === "ArrowRight") to = items[(at + 1) % items.length];
  else if (e.key === "Home") to = items[0];
  else if (e.key === "End") to = items[items.length - 1];
  else if (e.key === "Enter" || e.key === " ") {
    if (tab) activate(tab, true);
  } else if (e.key === "Backspace" || e.key === "Delete") {
    // The keyboard stays on the tab in front (renderTabs puts it there), or goes to the document once the bar goes.
    if (tab) void closeTab(tab, true).then(() => (!document.activeElement || document.activeElement === document.body) && active?.focus());
  } else return;
  e.preventDefault();
  if (!to) return;
  for (const i of items) i.tabIndex = i === to ? 0 : -1;
  to.focus();
});

// The keyboard leaving the bar: its one stop goes back to the tab in front, so Tab returns there, not to the tab last arrowed to.
tabBar.addEventListener("focusout", (e) => {
  if (tabBar.contains(e.relatedTarget as globalThis.Node | null)) return;
  for (const item of tabBar.querySelectorAll<HTMLElement>(".tab")) item.tabIndex = item.getAttribute("aria-selected") === "true" ? 0 : -1;
});
// The window narrowing (or widening) can take the tab in front out of sight: the bar follows.
new ResizeObserver(() => showFrontTab()).observe(tabBar);

// More tabs than the bar can show (roadmap Batch 12, G-19): All tabs, at its end, lists every open document in his
// order, the one in front ticked; choosing one brings it to the front. Only while they don't all fit.
const tabsEnd = document.createElement("div");
tabsEnd.className = "tabs-end";
tabsEnd.hidden = true;
const allTabs = document.createElement("button");
allTabs.type = "button";
allTabs.className = "tabs-all";
allTabs.setAttribute("aria-label", "All tabs");
allTabs.setAttribute("aria-haspopup", "menu");
allTabs.setAttribute("aria-expanded", "false");
allTabs.title = "All tabs";
allTabs.innerHTML = ICONS.next;
tabsEnd.append(allTabs);
tabBar.after(tabsEnd);
const allTabsMenu = new PopupMenu(
  "All tabs",
  // A closed tab is never brought forward, even from a list drawn before it closed (review of Batch 12, B12-2).
  () => tabs.map((tab) => ({ label: shownName(tab.name), radio: true, checked: tab === active, run: () => tabs.includes(tab) && activate(tab) })),
  () => active?.focus(),
);
allTabs.addEventListener("mousedown", (e) => e.preventDefault()); // the keyboard stays where it is
allTabs.addEventListener("click", (e) => {
  if (allTabsMenu.isOpen) return allTabsMenu.close();
  const keyboard = e.detail === 0;
  allTabsMenu.open(allTabs, { keyboard });
  // From the keyboard, on the document in front, so the arrows go from there.
  if (keyboard) allTabsMenu.el.querySelector<HTMLElement>('[aria-checked="true"]')?.focus();
});

/** The room the bar leaves at its end for All tabs, while the tabs don't all fit (style.css, .tabs.overflowing). */
const ALL_TABS_ROOM = 36;

/** All tabs shows while the tabs, as narrow as they go, are wider than the bar with nothing beside it. */
function fitAllTabs(): void {
  const making = tabBar.classList.contains("overflowing");
  const over = tabBar.clientWidth > 0 && tabBar.scrollWidth > tabBar.clientWidth + (making ? ALL_TABS_ROOM : 0) + 1;
  if (over === making) return;
  tabBar.classList.toggle("overflowing", over);
  tabsEnd.hidden = !over;
  if (!over) allTabsMenu.close();
}

/** With more tabs than the bar can show, it scrolls sideways so the tab in front is in sight. */
function showFrontTab(): void {
  fitAllTabs();
  const front = tabBar.querySelector<HTMLElement>('.tab[aria-selected="true"]');
  if (!front || !tabBar.clientWidth) return; // no bar with one document, or none
  if (tabDrag.dragging()) return; // the bar follows the tab being dragged; the dragged tab comes to the front when it's let go
  const bar = tabBar.getBoundingClientRect();
  const edge = parseFloat(getComputedStyle(tabBar).paddingLeft);
  const r = front.getBoundingClientRect();
  if (r.left < bar.left + edge) tabBar.scrollLeft -= bar.left + edge - r.left;
  else if (r.right > bar.right - edge) tabBar.scrollLeft += r.right - (bar.right - edge);
}

// Status bar -----------------------------------------------------------------------

function updateStatus(): void {
  outline.update();
  updateCommentsButton();
  copyPathButton.hidden = !active;
  markdownHelpButton.hidden = active?.mode !== "markdown";
  updateTurn();
  const notSaved = active ? (problemOf(active) ?? "") : "";
  if (notSavedTold.textContent !== notSaved) notSavedTold.textContent = notSaved;
  if (!active) {
    wordsEl.textContent = "";
    statusEl.textContent = "";
    statusEl.dataset.state = "";
    return;
  }
  wordsEl.textContent = everyday.wordLabel(active);
  statusEl.dataset.state = active.status;
  statusEl.textContent = active.statusLabel();
  copyPathButton.title = active.filePath;
}

/**
 * Whose turn it is, beside "Saved", once an agent has worked on the document
 * (Orlando, 2026-11-09): "With you", or "Claude is editing" with the agent's
 * colour. Nothing on a document no agent has touched. With you, it counts
 * the cards with something new from an agent ("With you · 4 to read"),
 * down as each is read (roadmap Batch 1, item 2). Only what changed is
 * written, so typing costs nothing here.
 */
// Short of room, the section's name in the status bar gives way, whole, before whose turn it is is cut
// ("Wit… · 1 to read"): roadmap Batch 24, row 27 (W-21). Still short, Copy path gives way too (it is in the File
// menu): review of Batch 24, R24-4. Looked at only when the bar or something in it changes size (the word count
// growing shorter can make room for the section again).
const statusBar = document.querySelector<HTMLElement>(".status-bar")!;
function fitTurn(): void {
  const turnCut = () => !turnEl.hidden && turnWho.scrollWidth > turnWho.clientWidth + 0.5;
  statusBar.classList.remove("section-gives-way", "path-gives-way");
  if (!turnCut()) return;
  statusBar.classList.add("section-gives-way");
  if (turnCut()) statusBar.classList.add("path-gives-way");
}
const turnRoom = new ResizeObserver(fitTurn);
turnRoom.observe(statusBar);
for (const part of statusBar.children) turnRoom.observe(part);
turnRoom.observe(turnWho);

function updateTurn(): void {
  const turn = active ? turnOf(active) : null;
  const agent = turn?.agent ?? null;
  const toRead = turn && !agent ? active!.comments.unreadCount : 0;
  const sendTo = turn?.listening ? active!.comments.sendsTo() : null;
  const key = !turn ? "" : agent ? `${agent.name}\n${agent.colour}` : `you\n${toRead}\n${turn.listening ?? ""}\n${sendTo ?? ""}`;
  if (turnEl.dataset.key === key) return;
  turnEl.dataset.key = key;
  turnEl.hidden = !turn;
  turnEl.dataset.turn = agent ? "agent" : "you";
  // With you, an agent may be waiting for your review (Send to Claude): see turnWords in turns.ts.
  const words = turn ? statusBarWords(turn, toRead, sendTo) : { text: "", title: "", read: "" };
  turnWho.textContent = words.text.slice(0, words.text.length - words.read.length);
  turnRead.textContent = words.read;
  turnEl.title = words.title;
  turnDot.hidden = !agent;
  turnDot.style.background = agent ? `var(--agent-${agent.colour})` : "";
  if (agent) turnDot.dataset.colour = agent.colour;
}

let copiedTimer: ReturnType<typeof setTimeout> | null = null;
async function copyPath(): Promise<void> {
  if (!active) return;
  await api.copyPath(active.id);
  copyPathButton.textContent = "Path copied";
  copyPathButton.classList.add("done");
  if (copiedTimer) clearTimeout(copiedTimer);
  copiedTimer = setTimeout(() => {
    copyPathButton.textContent = "Copy path";
    copyPathButton.classList.remove("done");
  }, 1600);
}
copyPathButton.addEventListener("mousedown", (e) => e.preventDefault());
markdownHelpButton.addEventListener("mousedown", (e) => e.preventDefault());
markdownHelpButton.addEventListener("click", () => void api.help.open("markdown"));
copyPathButton.addEventListener("click", () => void copyPath());

// "3 comments" in the status bar, and the toolbar's Comments button: both
// show or hide the Comments panel, in either view.
function updateCommentsButton(): void {
  const label = active ? active.comments.countLabel : "";
  const shown = !!active && commentsOnScreen(active, historyUi);
  const title = shown ? "Hide comments (⌃⌘M)" : "Show comments (⌃⌘M)";
  commentsButton.hidden = !label;
  commentsButton.textContent = label;
  commentsButton.disabled = !active;
  commentsButton.setAttribute("aria-pressed", String(shown));
  commentsButton.title = title;
  const open = active?.comments.openCount ?? 0;
  // A badge on the icon's corner: it takes no room, so nothing on the bar moves when it comes (roadmap Batch 11, F-13).
  const count = commentsTool.querySelector<HTMLElement>(".tool-count")!;
  count.hidden = open === 0;
  count.textContent = String(open);
  // Whether a side column shows beside the page (Comments or History), for the window's styles.
  const side = !!active && (shown || historyUi.status(active).panelOpen);
  document.body.classList.toggle("side-open", side);
  document.body.classList.toggle("side-open-markdown", side && active?.mode === "markdown");
  commentsTool.disabled = !active;
  commentsTool.classList.toggle("on", shown);
  commentsTool.setAttribute("aria-pressed", String(shown));
  commentsTool.setAttribute("aria-label", open ? `Comments, ${open} open` : "Comments");
  commentsTool.title = title;
}
commentsButton.addEventListener("mousedown", (e) => e.preventDefault());
commentsButton.addEventListener("click", () => {
  if (active) toggleComments(active, historyUi);
});

async function renameOrMove(): Promise<void> {
  const tab = active;
  if (!tab) return;
  await tab.saveNow();
  const result = await api.rename(tab.id);
  if (!result) return;
  tab.atNewPlace(result);
  renderTabs();
  updateStatus();
}

// The start screen ------------------------------------------------------------------

// Recent documents as cards with a preview of each (see start-screen.ts).
const startScreen = setUpStartScreen({ api, container: recentEl, showing: () => !active });

$("open-document").addEventListener("click", () => void api.openDialog());
$("new-document").addEventListener("click", () => void api.newDocument());
// Help's walk through a first round with an agent: what a newcomer wants to know (roadmap Batch 5, item 2).
$("getting-started-link").addEventListener("click", () => void api.help.open("first"));

// Dropping Markdown files on the window opens them; a Word document opens as a Markdown copy (Corillo asks first).
document.addEventListener("dragover", (e) => {
  if (e.dataTransfer?.types.includes("Files")) e.preventDefault();
});
document.addEventListener("drop", (e) => {
  if (e.defaultPrevented) return;
  const files = [...(e.dataTransfer?.files ?? [])].map((f) => api.pathForFile(f)).filter((p) => OPENS_WHEN_DROPPED.test(p));
  if (!files.length) return;
  e.preventDefault();
  for (const f of files) void api.openPath(f);
});

// Keys for moving between tabs: Cmd-1 to Cmd-9, Cmd-Shift-[ and ]. The brackets go by the character the
// key types, as the menus' shortcuts do, so on any keyboard they're the keys marked ] and [ (W-2).
const NEXT_TAB = new Set(["]", "}"]);
const PREVIOUS_TAB = new Set(["[", "{"]);
document.addEventListener(
  "keydown",
  (e) => {
    if (!e.metaKey || e.altKey || e.ctrlKey) return;
    if (!e.shiftKey && /^[1-9]$/.test(e.key)) {
      const tab = e.key === "9" ? tabs[tabs.length - 1] : tabs[Number(e.key) - 1];
      if (tab) activate(tab);
      e.preventDefault();
    } else if (e.shiftKey && (NEXT_TAB.has(e.key) || PREVIOUS_TAB.has(e.key))) {
      cycle(NEXT_TAB.has(e.key) ? 1 : -1);
      e.preventDefault();
    }
  },
  true,
);

// Messages from the app --------------------------------------------------------------

api.onOpen((info, { background }) => open(info, background));
api.onActivate((id) => {
  const tab = tabs.find((t) => t.id === id);
  if (tab) activate(tab);
});
api.onChangedOnDisk((id, text) => tabs.find((t) => t.id === id)?.changedOnDisk(text));
api.onPicturesWaiting((id, change) => tabs.find((t) => t.id === id)?.picturesWaiting(change));
api.onCommentsChanged((id, threads) => tabs.find((t) => t.id === id)?.comments.setThreads(threads));
api.onNotes((id, notes) => tabs.find((t) => t.id === id)?.comments.setNotes(notes));
if (typeof api.onAgentsChanged === "function") {
  api.onAgentsChanged((id, agents) => {
    const tab = tabs.find((t) => t.id === id);
    if (!tab) return;
    tab.comments.setAgents(agents);
    // Who is on it, and who edited it last, for its dot and tooltip ("Back from Writer").
    agentsOn.set(tab, agents);
    const editing = agents.find((a) => a.editing);
    if (editing) lastEditor.set(tab, editing);
  });
}
// It's your turn: back from a pass (turns.ts lights the dot just after this), or opened for the person by an agent.
api.onBackToYou((id) => {
  const tab = tabs.find((t) => t.id === id);
  if (tab) openedBy.delete(tab); // it says who it's back from now, not who opened it
});
// A Send the agent never got: the Comments panel says why, beside Copy for Claude.
api.onSendLost((id, agent, why) => tabs.find((t) => t.id === id)?.comments.sendLost(agent, why));
api.onForYou((id, agent) => {
  const tab = tabs.find((t) => t.id === id);
  if (!tab || turnOf(tab)?.agent) return; // an agent editing it hands it back when its pass ends
  openedBy.set(tab, agent);
  tab.backToYou = true;
  renderTabs(); // the document in front, with Corillo in front, is being looked at already
});
// Corillo coming to the front, or going behind another app.
const frontChanged = (front: boolean) => {
  inFront = front;
  if (front && active?.backToYou) renderTabs();
};
api.onInFront(frontChanged);
void api.inFront().then(frontChanged);
// The coquí call, when the app asks for it (coqui.ts): rendered without a sound in test runs.
api.onCall((offline) => void playCall(offline).then((heard) => heard && api.called(heard)));
api.onHush(stopCall);
api.onMissing((id, kind) => tabs.find((t) => t.id === id)?.missing(kind));
api.onFound((id) => tabs.find((t) => t.id === id)?.found());
api.onMoved((id, place) => tabs.find((t) => t.id === id)?.followed(place));
// Moved to the Trash: the tab closes, with a word in the corner, unless that would lose words.
api.onTrashed(async (id) => {
  const tab = tabs.find((t) => t.id === id);
  if (!tab) return;
  if (!tab.canLetGo()) return tab.trashed();
  await closeTab(tab);
  if (!tabs.includes(tab)) noticeOn(document.body).show(`${shownName(tab.name)} was moved to the Trash, so Corillo closed it.`, "Put it back within 30 days to keep its comments and history.");
});
api.onRecovered((id, text) => tabs.find((t) => t.id === id)?.recovered(text));
// From the app: one about an open document goes on its tab (roadmap Batch 6, item 2); the rest, and one whose tab has closed, are the window's.
api.onNotice((text, detail, docId) => noticeOn(tabs.find((t) => t.id === docId)?.el ?? document.body).show(text, detail));
api.onRecentChanged(() => {
  if (!active) void startScreen.show(true); // Clear list, say: the keyboard goes on to Open a document…
});
api.onFlush(async () => {
  readAloud.stop(); // the window is closing or Corillo is quitting
  for (const tab of [...tabs]) {
    let ready: boolean;
    try {
      ready = await tab.prepareToClose();
    } catch (err) {
      // Something went wrong in this tab's last steps: still save its text, and carry on with the others.
      console.error("Couldn't get a tab ready to close:", err);
      try {
        await tab.saveNow();
      } catch {
        // reported by its status
      }
      continue;
    }
    if (!ready) {
      activate(tab, true);
      return false;
    }
  }
  return true;
});
api.onMenu((action) => {
  if (action === "close-tab" && active) void closeTab(active);
  else if (action === "copy-path") void copyPath();
  else if (action === "rename") void renameOrMove();
  else if (action === "next-tab") cycle(1);
  else if (action === "previous-tab") cycle(-1);
  else if (action === "move-tab-left") moveTab(-1);
  else if (action === "move-tab-right") moveTab(1);
  else if (action === "comment:add") startComment();
  else if (action === "area:next") windowAreas.next();
  else if (action === "area:previous") windowAreas.previous();
  else if (action.startsWith("review:")) review.menu(action.slice(7));
  else if (action.startsWith("mode:")) active?.setMode(action.slice(5) as Mode);
});

setUpConnectScreen(api, () => (active ? active.focus() : void startScreen.show(true)));
setUpTurns({
  api,
  tabs: () => tabs,
  renderTabs,
  turnChanged: (tab) => {
    if (tab === active) updateTurn();
    if (turnKey(tabTurn(tab)) !== turnShown.get(tab)) renderTabs(); // its dot: an agent editing, or done
  },
});

activate(null);
api.ready();
