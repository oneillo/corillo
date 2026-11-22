// The only bridge between Corillo's window and the rest of the app.
import { contextBridge, ipcRenderer, webUtils } from "electron";
import type { Anchor } from "../core/anchors";
import type { PassNote, Thread } from "../core/comments";
import type { KnownAgent } from "../core/mentions";
import type { ChangeSpan } from "../core/change-links";
import type { OptionEdit } from "../core/options";
import type { AnchorUpdate } from "../core/comments";
import type { ChangeAnchorReport } from "../main/comment-service";
export type { Anchor } from "../core/anchors";
export type { ChangeSpan, ThreadChange } from "../core/change-links";
export type { ChangeAnchorReport } from "../main/comment-service";
export type { Thread, Message, Author, PassNote } from "../core/comments";
import type { ManualEntry } from "../main/agent-tools";
import type { ConnectScreenResult, ConnectScreenState } from "../main/connect-agents";
import { exportApi } from "./export-api";
import type { Conversation, HistoryKnown, HistoryList, RestoreResult, SinceHandOver, VersionTexts } from "../core/versions";
import type { RecentCard } from "../main/recent-cards";
import type { MenuShortcut, MenuState } from "../main/menus";
export type { RecentCard } from "../main/recent-cards";
export type { MenuShortcut, MenuState } from "../main/menus";
// The app's own shapes, taken from where it makes them, never copied by hand (Batch 18, A16-10).
import type { DocInfo, MissingKind, NewPlace, RenameResult, SaveOutcome as SaveResult } from "../main/doc-on-disk";
import type { AgentInfo, PassSummary } from "../main/agents/agent-service";
export type { DocInfo, MissingKind, NewPlace, RenameResult, SaveOutcome as SaveResult } from "../main/doc-on-disk";
export type { AgentInfo, PassSummary } from "../main/agents/agent-service";

export type CommentResult<T = void> = { ok: true; value: T } | { ok: false; error: string };
/** What the person chose when a tab that can't simply be saved is closing. */
export type CloseChoice = "here" | "save-as" | "discard" | "mine" | "theirs" | "cancel";

const on = <A extends unknown[]>(channel: string, cb: (...args: A) => void) => {
  ipcRenderer.on(channel, (_e, ...args) => cb(...(args as A)));
};

/**
 * Files the person dragged onto the window or pasted, as the window found
 * them: real files, which a page can't make up. With the recent list's, these
 * are the only paths the window can have opened, and the only pictures it can
 * have copied in (the app checks the rest).
 */
const dropped = new Set<string>();
const DROPS_KEPT = 50;

const api = {
  /** Corillo runs for tests (hidden, from the test helpers): the window offers the switches only tests use. */
  forTests: process.argv.includes("--corillo-for-tests"),
  /** Call once the window can take documents. */
  ready: (): void => ipcRenderer.send("app:ready"),
  onOpen: (cb: (info: DocInfo, options: { background: boolean }) => void) => on("tabs:open", cb),
  onActivate: (cb: (id: string) => void) => on("tabs:activate", cb),
  onChangedOnDisk: (cb: (id: string, text: string) => void) => on("doc:changed-on-disk", cb),
  onMenu: (cb: (action: string) => void) => on("menu", cb),
  onRecentChanged: (cb: () => void) => on("app:recent-changed", cb),
  /** A short notice for the window's corner, from the app (the window reopened); one about an open document (a damaged file set aside) names it, for its tab. */
  onNotice: (cb: (text: string, detail: string, docId?: string) => void) => on("app:notice", cb),
  /** Before the window closes: save everything; resolve false to cancel closing. */
  onFlush: (cb: () => Promise<boolean>): void => {
    // While closing, the app asks whether the page is still there (see main.ts).
    ipcRenderer.on("app:ping", () => ipcRenderer.send("app:pong"));
    ipcRenderer.on("app:flush", async () => {
      let ok = true;
      try {
        ok = await cb();
      } finally {
        ipcRenderer.send("app:flushed", ok);
      }
    });
  },

  save: (id: string, text: string): Promise<SaveResult> => ipcRenderer.invoke("doc:save", id, text),
  forceSave: (id: string, text: string): Promise<SaveResult> => ipcRenderer.invoke("doc:force-save", id, text),
  acceptDisk: (id: string, text: string): Promise<void> => ipcRenderer.invoke("doc:accept-disk", id, text),
  askConflict: (id: string): Promise<"mine" | "theirs" | "cancel"> => ipcRenderer.invoke("doc:ask-conflict", id),
  askBeforeClose: (id: string, kind: "missing" | "trashed" | "problem" | "held-back" | "recovered", problem: string): Promise<CloseChoice> =>
    ipcRenderer.invoke("doc:ask-before-close", id, kind, problem),
  /** A comment or reply was typed and not posted: close anyway ("discard") or go back to it ("cancel")? */
  askUnposted: (id: string): Promise<"discard" | "cancel"> => ipcRenderer.invoke("doc:ask-unposted", id),
  /** Choose a new place and save there; null if the person cancelled. */
  saveAs: (id: string, text: string): Promise<RenameResult | { problem: string } | null> =>
    ipcRenderer.invoke("doc:save-as", id, text),
  /** Keep edits that can't be saved yet in Corillo's data folder, in case of a crash. */
  keepRecovery: (id: string, text: string): Promise<boolean> => ipcRenderer.invoke("doc:keep-recovery", id, text),
  discardRecovery: (id: string): Promise<void> => ipcRenderer.invoke("doc:discard-recovery", id),
  onMissing: (cb: (id: string, kind?: MissingKind) => void) => on("doc:missing", cb),
  onFound: (cb: (id: string) => void) => on("doc:found", cb),
  /** The file was renamed or moved outside Corillo: the tab follows it. */
  onMoved: (cb: (id: string, place: NewPlace) => void) => on("doc:moved", cb),
  /** The file was moved to the Trash. */
  onTrashed: (cb: (id: string) => void) => on("doc:trashed", cb),
  /** Edits that weren't saved when Corillo last closed. */
  onRecovered: (cb: (id: string, text: string) => void) => on("doc:recovered", cb),
  closed: (id: string): void => ipcRenderer.send("doc:closed", id),
  active: (id: string | null): void => ipcRenderer.send("doc:active", id),
  /** The tabs' order changed: their ids, in the bar's order, for the list Corillo brings back at launch (roadmap Batch 10, item 2). */
  tabOrder: (ids: string[]): void => ipcRenderer.send("tabs:order", ids),
  /** The app puts the tabs in this order (the ones it brought back at launch). */
  onPlaceTabs: (cb: (ids: string[]) => void) => on("tabs:place", cb),
  copyPath: (id: string): Promise<string> => ipcRenderer.invoke("doc:copy-path", id),
  /** An empty document's request for an agent, naming it and its folder (roadmap Batch 5, item 2, P-8): true once copied. */
  copyDraftRequest: (id: string): Promise<boolean> => ipcRenderer.invoke("doc:copy-draft-request", id),
  rename: (id: string): Promise<RenameResult | null> => ipcRenderer.invoke("doc:rename", id),

  openDialog: (): Promise<void> => ipcRenderer.invoke("app:open-dialog"),
  newDocument: (): Promise<void> => ipcRenderer.invoke("app:new-document"),
  /** Open a document from the recent list, or one the person dropped on the window (found with pathForFile). */
  openPath: (filePath: string): Promise<void> => ipcRenderer.invoke("app:open-path", filePath, dropped.delete(filePath)),
  /** Open a link in this document: in the browser, a tab or Finder, or say it can't be found. */
  openLink: (href: string, id: string): Promise<void> => ipcRenderer.invoke("app:open-link", href, id),
  /** Open the note an Obsidian link ([[Plan]]) in this document points to, or say it can't be found. */
  openNote: (id: string, target: string): Promise<void> => ipcRenderer.invoke("obsidian:open-note", id, target),
  /** Where the picture an Obsidian embed (![[chart.png]]) in this document shows is, as an address, or null. */
  findPicture: (id: string, name: string): Promise<string | null> => ipcRenderer.invoke("obsidian:find-picture", id, name),
  /** The start screen's cards: the most recent documents, each with the top of its text. */
  recentCards: (): Promise<RecentCard[]> => ipcRenderer.invoke("app:recent-cards"),
  /** Take one document off the recent list. */
  forgetRecent: (filePath: string): Promise<void> => ipcRenderer.invoke("app:forget-recent", filePath),
  clearRecent: (): Promise<void> => ipcRenderer.invoke("app:clear-recent"),
  /** Find it…: the person shows where a recent document that can't be found is now (roadmap Batch 4, item 3). */
  findRecent: (filePath: string): Promise<void> => ipcRenderer.invoke("app:find-recent", filePath),

  // Pictures: each returns the picture's address in the document, or null.
  chooseImage: (id: string): Promise<string | null> => ipcRenderer.invoke("image:choose", id),
  /** Copy in a picture the person dropped or pasted (found with pathForFile); any other path is refused. */
  importImage: (id: string, filePath: string): Promise<string | null> =>
    ipcRenderer.invoke("image:import", id, filePath, dropped.delete(filePath)),
  saveImageData: (id: string, bytes: Uint8Array, mimeType: string): Promise<string | null> =>
    ipcRenderer.invoke("image:save-data", id, bytes, mimeType),
  // Comments, as the person. Each resolves with ok, or a plain-words error.
  // `mention` is the agent named with @ in the words, which directs the comment
  // at it (a reply hands it over); null for none.
  addComment: (id: string, body: string, anchor: Anchor | null, mention: string | null): Promise<CommentResult<Thread>> =>
    ipcRenderer.invoke("comments:add", id, body, anchor, mention),
  replyToComment: (id: string, threadId: string, body: string, mention: string | null = null): Promise<CommentResult<Thread>> =>
    ipcRenderer.invoke("comments:reply", id, threadId, body, mention),
  editComment: (id: string, threadId: string, messageId: string, body: string, mention?: string | null): Promise<CommentResult> =>
    ipcRenderer.invoke("comments:edit", id, threadId, messageId, body, mention),
  deleteComment: (id: string, threadId: string, messageId: string): Promise<CommentResult> =>
    ipcRenderer.invoke("comments:delete", id, threadId, messageId),
  /** Undo straight after a delete: the message the person just deleted is back (roadmap Batch 9, item 4). */
  restoreComment: (id: string, threadId: string, messageId: string): Promise<CommentResult> =>
    ipcRenderer.invoke("comments:restore", id, threadId, messageId),
  resolveComment: (id: string, threadId: string, resolved: boolean): Promise<CommentResult> =>
    ipcRenderer.invoke("comments:resolve", id, threadId, resolved),
  /** The person applied an option on an agent's reply (roadmap Batch 3, item 2): recorded, with the text it changed. */
  chooseOption: (id: string, threadId: string, messageId: string, option: number, spans: ChangeSpan[], undo: OptionEdit[]): Promise<CommentResult> =>
    ipcRenderer.invoke("comments:choose", id, threadId, messageId, option, spans, undo),
  /** Tell Corillo where the comments are now (after edits), so they're found next time. */
  saveCommentAnchors: (id: string, anchors: Record<string, AnchorUpdate>): void =>
    ipcRenderer.send("comments:anchors", id, anchors),
  onCommentsChanged: (cb: (id: string, threads: Thread[]) => void) => on("comments:changed", cb),
  // Agents' changes, tied to the comments they answer (see core/change-links.ts).
  /** Tell Corillo where the person's edits moved the changes, so they're found next time. */
  saveChangeAnchors: (id: string, report: ChangeAnchorReport): void => ipcRenderer.send("changes:anchors", id, report),
  /** The person has read an agent's note and marked it done: it leaves the panel (History keeps it). */
  noteDone: (id: string, note: string): Promise<CommentResult> => ipcRenderer.invoke("notes:done", id, note),
  onNotes: (cb: (id: string, notes: PassNote[]) => void) => on("notes:changed", cb),
  /** An agent's pass ended: what it did, for the "Claude answered 5 comments" notice. */
  onPassEnded: (cb: (id: string, summary: PassSummary) => void) => on("agent:pass-ended", cb),

  // Agents. Who is on each document (for the notice and the @ list in comments).
  onAgentsChanged: (cb: (id: string, agents: AgentInfo[]) => void) => on("agents:changed", cb),
  /** Every agent Corillo knows: those connected now first, then those met before (remembered between launches). */
  knownAgents: (): Promise<KnownAgent[]> => ipcRenderer.invoke("agents:known"),
  /** The agents Corillo knows changed: one connected, left, or was seen on a document. */
  onKnownAgents: (cb: (agents: KnownAgent[]) => void) => on("agents:known", cb),
  /** An agent is about to edit, or wants the latest text: save this tab's pending edits (and, with lock, stop taking edits). */
  onAgentFlush: (cb: (id: string, lock: boolean) => Promise<"saved" | "conflict" | "unsaved">): void => {
    ipcRenderer.on("agent:flush", async (_e, requestId: number, id: string, lock: boolean) => {
      let result: "saved" | "conflict" | "unsaved" | "failed" = "failed";
      try {
        result = await cb(id, lock);
      } finally {
        ipcRenderer.send("agent:flushed", requestId, result);
      }
    });
  },
  /** An agent changed the document: show its new text. */
  onAgentText: (cb: (id: string, text: string) => void) => on("agent:text", cb),
  /** An agent's change is on its way (onAgentText follows, unless the file can't be written): its text, to read ahead. */
  onAgentTextComing: (cb: (id: string, text: string) => void) => on("agent:text-coming", cb),
  /** An agent's pass ended: the document is back with the person. */
  onBackToYou: (cb: (id: string) => void) => on("agent:back-to-you", cb),
  /** A document just opened has an agent's version in its history: the status bar says whose turn it is. */
  onAgentWorked: (cb: (id: string) => void) => on("agent:worked", cb),
  /** End the editing agent's pass now. */
  takeOver: (id: string): Promise<void> => ipcRenderer.invoke("agent:take-over", id),
  /** Send to Claude: the agent waiting for the review of this document (this one, by name) gets it. */
  sendToAgent: (id: string, agent?: string): Promise<{ sent: boolean; problem?: string }> => ipcRenderer.invoke("agent:send", id, agent),
  /** Copy for Claude: the sentence to paste in an agent's chat, with the document's name and path. */
  copyForAgent: (id: string, comments: number): Promise<boolean> => ipcRenderer.invoke("agent:copy-for", id, comments),
  /** The person sent the document and the agent didn't get it: it stopped listening first, or the document couldn't be taken for it. */
  onSendLost: (cb: (id: string, agent: string, why: "stopped" | "failed") => void) => on("agent:send-lost", cb),

  // It's your turn (see src/main/your-turn.ts).
  /** An agent opened or created the document for the person to review. */
  onForYou: (cb: (id: string, agent: string) => void) => on("agent:for-you", cb),
  /** Whose turn it is on each open document, in tab order: for the Dock's count and the Window menu. */
  turns: (list: { id: string; name: string; state: string; waiting: boolean }[]): void => ipcRenderer.send("turn:states", list),
  /** Whether Corillo is the app in front. */
  inFront: (): Promise<boolean> => ipcRenderer.invoke("app:in-front"),
  onInFront: (cb: (front: boolean) => void) => on("app:in-front", cb),
  /** Play the coquí call (offline: rendered without a sound, in test runs). */
  onCall: (cb: (offline: boolean) => void) => on("turn:call", cb),
  /** The sound was turned off: stop a call that is playing. */
  onHush: (cb: () => void) => on("turn:hush", cb),
  /** The call played: how long and how loud it was. */
  called: (heard: { seconds: number; peak: number }): void => ipcRenderer.send("turn:called", heard),

  /** Where a dragged or pasted file is on disk ("" for a picture copied from an app). */
  pathForFile: (file: File): string => {
    const found = webUtils.getPathForFile(file);
    if (found) {
      dropped.add(found);
      if (dropped.size > DROPS_KEPT) dropped.delete(dropped.values().next().value!);
    }
    return found;
  },

  // Connecting agent tools, and the Help window.
  agents: {
    /** The tools on this Mac, and anything to sort out before connecting them. */
    list: (): Promise<ConnectScreenState> => ipcRenderer.invoke("agents:list"),
    connect: (id: string): Promise<ConnectScreenResult> => ipcRenderer.invoke("agents:connect", id),
    disconnect: (id: string): Promise<ConnectScreenResult> => ipcRenderer.invoke("agents:disconnect", id),
    /** `moveFirst`: Corillo runs from its disk image or a place it's passing through, so the settings would break later. */
    manual: (): Promise<{ tools: ManualEntry[]; other: string; moveFirst: boolean }> => ipcRenderer.invoke("agents:manual"),
    /** Copy a tool's snippet, or where its settings file is ("where"). */
    copy: (id: string, what: "snippet" | "where" = "snippet"): Promise<boolean> =>
      ipcRenderer.invoke("agents:copy", id, what),
    showConnect: (): Promise<void> => ipcRenderer.invoke("agents:show-connect"),
    onShowConnect: (cb: () => void) => on("agents:show-connect", cb),
    /** The tools with a session connected to Corillo now changed (by id): the screen's rows follow (roadmap Batch 5, item 2). */
    onLive: (cb: (tools: string[]) => void) => on("agents:live", cb),
    /** Copy the request a newly connected tool's row offers to try. */
    copyTryIt: (): Promise<void> => ipcRenderer.invoke("agents:copy-try"),
  },
  help: {
    open: (page?: string): Promise<void> => ipcRenderer.invoke("help:open", page),
    onPage: (cb: (page: string) => void) => on("help:page", cb),
  },
  // Word and PDF export
  ...exportApi,
  // Version history (see src/main/history.ts).
  /** The panel's rows; with what the window has (`known`), only what's new. */
  historyList: (id: string, known?: HistoryKnown): Promise<HistoryList> => ipcRenderer.invoke("history:list", id, known),
  historyVersion: (id: string, n: number): Promise<VersionTexts> => ipcRenderer.invoke("history:version", id, n),
  /** Show changes: everything since the person last handed the document over. */
  historySince: (id: string): Promise<SinceHandOver> => ipcRenderer.invoke("history:since", id),
  /** The whole conversation behind version n, for the version open in the panel. */
  historyConversation: (id: string, n: number): Promise<Conversation | null> => ipcRenderer.invoke("history:conversation", id, n),
  /** Ask to make version n current; the tab then saves its text the usual way. */
  historyRestore: (id: string, n: number): Promise<RestoreResult> => ipcRenderer.invoke("history:restore", id, n),
  onHistoryChanged: (cb: (id: string) => void) => on("history:changed", cb),
  // History reads as the story (roadmap Batch 4, item 2).
  /** What these versions changed, for the rows in sight: the sections each touched, and the change line. */
  historyStories: (id: string, asks: import("../core/versions").StoryAsk[]): Promise<Record<string, import("../core/versions").RowStory>> =>
    ipcRenderer.invoke("history:stories", id, asks),
  /** Version n compared with an earlier version, `base`, rather than the one right before it. */
  historyCompare: (id: string, n: number, base: number): Promise<VersionTexts> => ipcRenderer.invoke("history:compare", id, n, base),
  // Everyday editing: clipboard, pictures from pasted web content, zoom, spelling.
  readClipboardText: (): Promise<string> => ipcRenderer.invoke("clipboard:read-text"),
  /** Copy formatted HTML and Markdown text to the clipboard together. */
  writeClipboard: (html: string, text: string): void => ipcRenderer.send("clipboard:write", html, text),
  fetchImage: (url: string): Promise<{ bytes: Uint8Array; mime: string } | null> => ipcRenderer.invoke("image:fetch", url),
  /** The person showed a web picture an agent added (by clicking its marker, the only caller: images.ts). Addresses only. */
  showWebPicture: (id: string, address: string): Promise<void> => ipcRenderer.invoke("pictures:show", id, address),
  /** Web pictures in a copy pasted into a document that waited where they came from: they wait there too (paste.ts). Adds only; addresses only. */
  waitWebPictures: (id: string, addresses: string[]): Promise<void> => ipcRenderer.invoke("pictures:wait", id, addresses),
  /** Web pictures that now wait for the person in a document, or were shown (roadmap Batch 18, item 1). */
  onPicturesWaiting: (cb: (id: string, change: { wait: string[]; shown: string[]; every?: string[] | null }) => void) => on("pictures:waiting", cb),
  /** For pictures on this Mac (file addresses): when each last changed, with its size, or null if it isn't there. */
  pictureStamps: (urls: string[]): Promise<(string | null)[]> => ipcRenderer.invoke("picture:stamps", urls),
  /** The dots per inch a picture on this Mac says it was made at, read from its start only. */
  pictureDpi: (url: string): Promise<{ x: number; y: number } | null> => ipcRenderer.invoke("picture:dpi", url),
  /** The page zoom, after changing it if asked. */
  zoom: (change?: "in" | "out" | "reset"): Promise<number> => ipcRenderer.invoke("view:zoom", change),
  onZoom: (cb: (level: number) => void) => on("view:zoom", cb),
  /** Whether the file's line numbers show beside the text (View > Line Numbers). */
  lineNumbers: (): Promise<boolean> => ipcRenderer.invoke("view:line-numbers"),
  onLineNumbers: (cb: (on: boolean) => void) => on("view:line-numbers", cb),
  /** Whether the outline shows at the left of the page (View > Show Outline); the toolbar's Outline button turns it on and off. */
  outline: (): Promise<boolean> => ipcRenderer.invoke("view:outline"),
  setOutline: (on: boolean): Promise<void> => ipcRenderer.invoke("view:set-outline", on),
  onOutline: (cb: (on: boolean) => void) => on("view:outline", cb),
  /** Whether the person hid the Comments panel (the same for every document), after remembering it if told. */
  commentsHidden: (hidden?: boolean): Promise<boolean> => ipcRenderer.invoke("view:comments-hidden", hidden),
  /** View > Page Width: a fixed column, or the text filling the window. */
  pageWidth: (): Promise<"fixed" | "fill"> => ipcRenderer.invoke("view:page-width"),
  onPageWidth: (cb: (width: "fixed" | "fill") => void) => on("view:page-width", cb),
  /** How wide the side panel is and the Markdown text's share of the Markdown view, after remembering any given. */
  columns: (changes?: { side?: number; split?: number }): Promise<{ side: number; split: number }> =>
    ipcRenderer.invoke("view:columns", changes),
  onReplaceMisspelling: (cb: (word: string, replacement: string) => void) => on("spelling:replace", cb),
  // The menu bar (see src/main/menus.ts and src/renderer/menus.ts).
  menus: {
    /** Which of the window's menu items apply now, which are ticked, and words that change. */
    setState: (state: MenuState): void => ipcRenderer.send("menu:state", state),
    /** What's at the spot being right-clicked, said before the right-click menu is built. */
    clicked: (context: { table: boolean; editable: boolean; comment: boolean }): void => void ipcRenderer.sendSync("menu:context", context),
    /** A shortcut for an item the app carries out was pressed in the window. */
    press: (id: string): void => ipcRenderer.send("menu:press", id),
    shortcuts: (): Promise<MenuShortcut[]> => ipcRenderer.invoke("menu:shortcuts"),
    onShortcuts: (cb: (list: MenuShortcut[]) => void) => on("menu:shortcuts", cb),
    /** Carry out a menu action in the window, as if its item were chosen. */
    run: (action: string): void => void ipcRenderer.emit("menu", {} as Electron.IpcRendererEvent, action),
    /** The page's own Undo (`back`) or Redo, as Edit > Undo's key gives it, for a place the window's own Undo doesn't cover (a box). */
    pageUndo: (back: boolean): void => ipcRenderer.send("edit:page-undo", back),
  },
  /** The Markdown view was shown, which takes memory: the app may note how much it uses (memory-note.ts). */
  markdownShown: (): void => ipcRenderer.send("memory:look"),
  /** While tests run: the window's real speech was asked for (and refused). The run fails (B14-09). */
  realSpeechReached: (): void => ipcRenderer.send("tests:real-speech"),
};

export type CorilloApi = typeof api;
contextBridge.exposeInMainWorld("corillo", api);
