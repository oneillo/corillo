// Taking turns, in the window. While an agent holds a document its tab shows a
// calm line ("Claude is editing") with a Take over button, and the text is
// read-only; the person can still read and comment. When the agent's pass
// ends, the tab's dot lights up until the person looks at that tab.
//
// The status bar always says whose turn it is, once an agent has worked on
// the document: "With you", or "Claude is editing" with the agent's colour
// (Orlando, 2026-11-09). A document no agent has touched shows nothing there.
import type { AgentInfo, CorilloApi } from "../preload/preload";
import type { DocTab } from "./doc-tab";
import { coquiFrog, frogsChanged, paintFrog } from "./tab-coqui";
import { typingElsewhere } from "./editable";

export interface TurnsHost {
  api: CorilloApi;
  tabs(): DocTab[];
  /** Redraw the tab bar (for the dot). */
  renderTabs(): void;
  /** Whose turn it is on this tab changed: redraw the status bar if it's in front. */
  turnChanged(tab: DocTab): void;
}

/** Whose turn it is on a document, for the status bar; with the person, the agents waiting for their review. */
export type Turn = { agent: AgentInfo; listening?: undefined } | { agent: null; listening?: string[] };

const notices = new WeakMap<DocTab, HTMLElement>();
const editing = new WeakMap<DocTab, AgentInfo>();
/** The agents waiting for the person's review of each document (Send to Claude, roadmap Batch 2 item 1). */
const listening = new WeakMap<DocTab, string[]>();
/** Documents an agent has worked on: a version of its own in the history, or a pass here. */
const worked = new WeakSet<DocTab>();
/** Take over pressed and not yet through: when the document comes back, it's said, and the keyboard goes to the page. */
const takingOver = new WeakSet<DocTab>();
/** What the editing line says while the person only reads, and once they've typed (roadmap Batch 24, row 21). */
const CALM = "You can read and comment meanwhile.";
const typedWords = (agent: string) => `You can't type while ${agent} is editing. Take over to edit now.`;
/** Read out to a screen reader: the document is the person's again. Made by setUpTurns. */
let told: HTMLElement | null = null;

/** Said aloud, even when it's the same words as last time. */
function say(words: string): void {
  if (told) told.textContent = told.textContent === words ? `${words}\u00a0` : words;
}

/**
 * Take the document back from the agent editing it (the line's Take over, or
 * Review > Take Over). Once it's back: "The document is yours again" is said,
 * and the keyboard goes to the page, where the cursor was, unless it's in a
 * box of its own (a comment being written) (roadmap Batch 24, row 22: K-7).
 */
export function takeOver(tab: DocTab, api: CorilloApi): void {
  takingOver.add(tab);
  void api.takeOver(tab.id).then(() => {
    if (!editing.has(tab)) backFromTakeOver(tab); // else when the agents' news arrives
  });
}

function backFromTakeOver(tab: DocTab): void {
  if (!takingOver.delete(tab)) return;
  say("The document is yours again.");
  if (!tab.el.hidden && !typingElsewhere(true)) tab.focusPage();
}

/** The agent editing this document now, if any (Review > Take Over names it). */
export function editingAgent(tab: DocTab): string | null {
  return editing.get(tab)?.name ?? null;
}

/** Whose turn it is, or null on a document no agent has worked on and none is editing. */
export function turnOf(tab: DocTab): Turn | null {
  const agent = editing.get(tab);
  if (agent) return { agent };
  const names = listening.get(tab);
  if (names?.length) return { agent: null, listening: names };
  return worked.has(tab) ? { agent: null } : null;
}

/** "Claude and Writer", for the status bar. */
const both = (names: string[]) => (names.length <= 1 ? (names[0] ?? "") : `${names.slice(0, -1).join(", ")} and ${names[names.length - 1]}`);

/**
 * The status bar's words for whose turn it is, and its tooltip: "Claude is
 * editing"; with the person, "Claude is waiting for your review" while an
 * agent waits for it, else "With you"; and how many cards have something
 * new to read ("· 3 to read"). `sendTo`: the agent the panel's Send button names.
 */
/** `read`: the end of `text` that counts what's left to read (" · 3 to read"), kept whole when the status bar is short of room. */
export function turnWords(turn: Turn, toRead: number, sendTo?: string | null): { text: string; title: string; read: string } {
  if (turn.agent) return { text: `${turn.agent.name} is editing`, title: `${turn.agent.name} is editing. You can read and comment meanwhile.`, read: "" };
  const read = toRead ? ` · ${toRead} to read` : "";
  const toReadTitle = toRead ? ` ${toRead} to read in the Comments panel, each marked with a dot.` : "";
  const names = turn.listening ?? [];
  if (names.length) {
    const who = `${both(names)} ${names.length === 1 ? "is" : "are"} waiting for your review`;
    return {
      text: `${who}${read}`,
      read,
      // The button as the Comments panel shows it: Send to the agent the comments are for (B2-07).
      title: `It's your turn: ${who}.${toReadTitle} When you've finished, press Send to ${sendTo || names[0]} in the Comments panel.`,
    };
  }
  return {
    text: `With you${read}`,
    read,
    title: toRead ? `It's your turn: the document is yours to edit.${toReadTitle}` : "It's your turn: the document is yours to edit.",
  };
}

function noticeFor(tab: DocTab, api: CorilloApi): HTMLElement {
  let notice = notices.get(tab);
  if (notice) return notice;
  notice = document.createElement("div");
  notice.className = "agent-notice";
  notice.setAttribute("role", "status");
  notice.hidden = true;
  const text = document.createElement("span");
  text.className = "agent-notice-text";
  const hint = document.createElement("span");
  hint.className = "agent-notice-hint";
  hint.textContent = CALM;
  const button = document.createElement("button");
  button.type = "button";
  button.className = "take-over";
  button.textContent = "Take over";
  button.title = "Stop the agent's turn and edit the document yourself (⌃⌘T)";
  button.addEventListener("click", () => takeOver(tab, api));
  const help = document.createElement("button");
  help.type = "button";
  help.className = "agent-notice-help"; // a button like every bar's action (review of Batch 11, F-10)
  help.textContent = "How this works";
  help.addEventListener("click", () => void api.help.open("agents-turns"));
  notice.append(text, hint, help, button); // and a coquí before the words, while an agent is editing (showEditing)
  tab.main.prepend(notice);
  notices.set(tab, notice);
  return notice;
}

/** Show who is editing (or nobody), and lock or unlock the text to match. */
function showEditing(tab: DocTab, api: CorilloApi, agent: AgentInfo | null): void {
  const notice = noticeFor(tab, api);
  notice.hidden = !agent;
  const hint = notice.querySelector<HTMLElement>(".agent-notice-hint")!;
  // Each pass starts calm; typing during it says why nothing happens (typedOnLocked).
  if (agent?.name !== editing.get(tab)?.name) {
    hint.textContent = CALM;
    hint.classList.remove("agent-notice-typed");
  }
  if (agent) {
    editing.set(tab, agent);
    worked.add(tab);
  } else editing.delete(tab);
  if (agent) {
    const words = `${agent.name} is editing`;
    notice.querySelector(".agent-notice-text")!.textContent = words;
    // All of it in the tooltip, for a narrow page where the hint is cut short.
    notice.title = `${words}. ${hint.textContent}`;
    // A coquí in the same colour as the agent's comments (see agentColours in core/agents.ts), as on its tab
    // (roadmap Batch 9, item 13). It's on the page only while the agent edits, so nothing hops for it otherwise.
    const frog = notice.querySelector<HTMLElement>(".coqui-frog");
    if (frog) paintFrog(frog, agent.colour);
    else notice.prepend(coquiFrog(agent.colour));
    notice.dataset.agent = agent.name;
  } else notice.querySelector(".coqui-frog")?.remove();
  frogsChanged();
  tab.setReadOnly(!!agent);
  if (!agent) backFromTakeOver(tab);
}

/**
 * A key that would type on the page while an agent edits it: nothing changes,
 * but the line says why, and so does a screen reader (the line is a status),
 * once a pass (roadmap Batch 24, row 21: W-13). Typing stays refused.
 */
function typedOnLocked(tab: DocTab): void {
  const agent = editing.get(tab);
  const notice = notices.get(tab);
  const hint = notice?.querySelector<HTMLElement>(".agent-notice-hint");
  if (!agent || !notice || !hint || hint.classList.contains("agent-notice-typed")) return;
  hint.textContent = typedWords(agent.name);
  hint.classList.add("agent-notice-typed");
  notice.title = `${agent.name} is editing. ${hint.textContent}`;
}

/** A key that types or deletes text, with nothing held but Shift. Not Space: on the locked page it scrolls, as when reading (review of Batch 24, R24-2). */
const typingKey = (e: KeyboardEvent) =>
  !e.metaKey && !e.ctrlKey && !e.altKey && !e.isComposing && ((e.key.length === 1 && e.key !== " ") || e.key === "Enter" || e.key === "Backspace" || e.key === "Delete");

export function setUpTurns(host: TurnsHost): void {
  const { api } = host;
  told = document.createElement("span");
  told.className = "screen-reader-only";
  told.setAttribute("role", "status");
  document.querySelector(".status-bar")?.append(told);
  // Typing on the locked page: on the page itself, its Markdown text, or nowhere (a click on the locked page leaves the keyboard there).
  document.addEventListener("keydown", (e) => {
    if (!typingKey(e)) return;
    const tab = host.tabs().find((t) => !t.el.hidden);
    if (!tab || !editing.has(tab)) return;
    const at = e.target as HTMLElement;
    const onPage = at === document.body || !!at.closest?.(".ProseMirror") || (at instanceof HTMLTextAreaElement && at.readOnly && tab.el.contains(at));
    if (onPage) typedOnLocked(tab);
  });
  const tabFor = (id: string) => host.tabs().find((t) => t.id === id);
  const looked = (tab: DocTab) => {
    if (!tab.backToYou) return;
    tab.backToYou = false;
    host.renderTabs();
  };
  const watched = new WeakSet<DocTab>();
  const watch = (tab: DocTab) => {
    if (watched.has(tab)) return;
    watched.add(tab);
    // Clicking or typing in the document counts as looking at it.
    tab.el.addEventListener("pointerdown", () => looked(tab));
    tab.el.addEventListener("keydown", () => looked(tab));
  };

  api.onAgentsChanged((id, agents) => {
    const tab = tabFor(id);
    if (!tab) return;
    watch(tab);
    const before = editing.get(tab);
    const now = agents.find((a) => a.editing) ?? null;
    showEditing(tab, api, now);
    const wasListening = (listening.get(tab) ?? []).join("\n");
    // Not one the person has already sent it to (it starts once it has finished elsewhere: the cards say so).
    const names = agents.filter((a) => a.listening && !a.sent).map((a) => a.name);
    if (names.length) listening.set(tab, names);
    else listening.delete(tab);
    if (before?.name !== now?.name || before?.colour !== now?.colour || wasListening !== names.join("\n")) host.turnChanged(tab);
  });

  // Opened with an agent's version in its history (or one was just made).
  api.onAgentWorked((id) => {
    const tab = tabFor(id);
    if (!tab || worked.has(tab)) return;
    worked.add(tab);
    host.turnChanged(tab);
  });

  api.onAgentFlush(async (id, lock) => {
    const tab = tabFor(id);
    if (!tab) return "saved";
    if (lock) tab.setReadOnly(true); // no new edits while the person's pending ones are saved
    await tab.saveNow();
    // Where the person's edits moved comments and agents' changes, before the agent edits.
    tab.comments.saveAnchorsNow();
    // Anything short of saved (a conflict, a missing file, a failing save) means
    // the person's edits aren't safely in the file yet: the agent must wait.
    // But when it's only reading, "saving" after that save means it went
    // through and the person has typed more since: what it reads is fine.
    // (Taking the document locks it first, so nothing is typed meanwhile.)
    if (tab.status !== "saved" && !(tab.status === "pending" && !lock)) {
      if (lock) tab.setReadOnly(false);
      return tab.status === "conflict" ? "conflict" : "unsaved";
    }
    return "saved";
  });

  api.onAgentTextComing((id, text) => tabFor(id)?.readAhead(text));
  api.onAgentText((id, text) => tabFor(id)?.applyAgentText(text));

  api.onBackToYou((id) => {
    const tab = tabFor(id);
    if (!tab) return;
    watch(tab);
    tab.backToYou = true;
    host.renderTabs();
  });

  api.onPassEnded((id) => {
    const tab = tabFor(id);
    if (!tab || worked.has(tab)) return;
    worked.add(tab);
    host.turnChanged(tab);
  });
}
