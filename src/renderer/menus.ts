// The menu bar, from the window's side. The window says which of its menu
// items apply right now, which are ticked and which words change ("Show
// Comments" or "Hide Comments"), so each item is greyed out when it doesn't
// apply. It carries out the items that act on the document, and acts on their
// shortcuts itself while it has the keyboard, so a shortcut does exactly what
// its menu item does. On a right-click it says what's at the spot, so the
// right-click menu fits it (src/main/editing.ts).
import { TextSelection, type Command, type EditorState } from "prosemirror-state";
import type { ResolvedPos } from "prosemirror-model";
import { chainCommands } from "prosemirror-commands";
import { undo, redo } from "prosemirror-history";
import { liftListItem, sinkListItem } from "prosemirror-schema-list";
import { CellSelection } from "prosemirror-tables";
import { findShortcut, parseAccelerator, type Accelerator, type KeyboardLayout } from "../core/accelerators";
import { schema } from "../core/schema";
import type { CorilloApi, MenuShortcut, MenuState } from "../preload/preload";
import * as cmd from "./commands";
import type { DocTab } from "./doc-tab";
import { insertFootnote } from "./footnotes";
import type { HistoryUi } from "./history";
import { canInsertPicture } from "./images";
import type { ReviewStatus } from "./review";
import { setColumnAlign, tableCommands } from "./tables";
import { editingAgent, takeOver } from "./turns";
import { editable, writingState } from "./editable";
import { undoWhereKeyboardIs } from "./undo-resolve";

export interface MenusHost {
  api: CorilloApi;
  active(): DocTab | null;
  tabs(): DocTab[];
  /** The tab Move Tab Left and Right move: the one the keyboard is on in the tab bar, or the one in front. */
  tabToMove(): DocTab | null;
  history: HistoryUi;
  review: { status(tab: DocTab): ReviewStatus };
  openLinkEditor(): void;
  insertPicture(tab: DocTab): void;
  readAloud: { available(): boolean; reading(): boolean };
}

export interface WindowMenus {
  /** Something the menus show may have changed: tell the app soon. */
  schedule(): void;
}

const n = schema.nodes;
const m = schema.marks;
const t = tableCommands;

/** Menu items that change the document, with what ticks them. */
const EDITS: Record<string, { run: Command; on?: (s: EditorState) => boolean }> = {
  "insert-table": { run: cmd.insertTable },
  "insert-footnote": { run: insertFootnote },
  "insert-line": { run: cmd.insertHorizontalLine },
  "style-paragraph": { run: cmd.setStyle("paragraph"), on: (s) => cmd.currentStyle(s) === "paragraph" },
  "style-h1": { run: cmd.setStyle("h1"), on: (s) => cmd.currentStyle(s) === "h1" },
  "style-h2": { run: cmd.setStyle("h2"), on: (s) => cmd.currentStyle(s) === "h2" },
  "style-h3": { run: cmd.setStyle("h3"), on: (s) => cmd.currentStyle(s) === "h3" },
  "style-h4": { run: cmd.setStyle("h4"), on: (s) => cmd.currentStyle(s) === "h4" },
  "format-bold": { run: cmd.toggleBold, on: (s) => cmd.markActive(s, m.strong) },
  "format-italic": { run: cmd.toggleItalic, on: (s) => cmd.markActive(s, m.em) },
  "format-strike": { run: cmd.toggleStrike, on: (s) => cmd.markActive(s, m.strike) },
  "format-code": { run: cmd.toggleCode, on: (s) => cmd.markActive(s, m.code) },
  "format-bullets": { run: cmd.toggleList(n.bullet_list), on: (s) => cmd.listActive(s, n.bullet_list) },
  "format-numbers": { run: cmd.toggleList(n.ordered_list), on: (s) => cmd.listActive(s, n.ordered_list) },
  // As Tab and Shift-Tab do: a list item in or out a level, or lines of code.
  "format-indent": { run: chainCommands(sinkListItem(n.list_item), cmd.indentCode) },
  "format-outdent": { run: chainCommands(liftListItem(n.list_item), cmd.outdentCode) },
  "format-quote": { run: cmd.toggleQuote, on: cmd.quoteActive },
  "format-code-block": { run: cmd.toggleCodeBlock, on: cmd.codeBlockActive },
  "table-add-row-above": { run: t.addRowAbove },
  "table-add-row-below": { run: t.addRowBelow },
  "table-add-column-left": { run: t.addColumnLeft },
  "table-add-column-right": { run: t.addColumnRight },
  "table-align-left": { run: setColumnAlign("left") },
  "table-align-center": { run: setColumnAlign("center") },
  "table-align-right": { run: setColumnAlign("right") },
  "table-delete-row": { run: t.deleteRow },
  "table-delete-column": { run: t.deleteColumn },
  "table-delete": { run: t.deleteTable },
};

/** The Comments panel is on screen: shown, and History isn't in its place (Show changes keeps it). */
export function commentsOnScreen(tab: DocTab, history: HistoryUi): boolean {
  const versions = history.status(tab);
  return tab.comments.panelShown && !versions.panelOpen && (!versions.viewing || versions.changes);
}

/**
 * Show or hide the Comments panel (the toolbar's Comments button, View > Show
 * Comments). Comments and History share a place: with History there, the
 * comments come back in its place.
 */
export function toggleComments(tab: DocTab, history: HistoryUi): void {
  const versions = history.status(tab);
  if (!versions.panelOpen && (!versions.viewing || versions.changes)) {
    tab.comments.togglePanel();
    return;
  }
  if (versions.panelOpen) history.togglePanel(tab);
  if (history.status(tab).viewing && !history.status(tab).changes) history.toggleChanges(tab);
  if (!tab.comments.panelShown) tab.comments.togglePanel();
}

/** How deep the table cell holding this position is, if it's in one. */
function cellDepth($pos: ResolvedPos): number | null {
  for (let d = $pos.depth; d > 0; d--) {
    const role = $pos.node(d).type.spec.tableRole;
    if (role === "cell" || role === "header_cell") return d;
  }
  return null;
}

export function setUpWindowMenus(host: MenusHost): WindowMenus {
  const { api, history } = host;

  function compute(): MenuState {
    const enabled: Record<string, boolean> = {};
    const checked: Record<string, boolean> = {};
    const labels: Record<string, string> = {};
    const tab = host.active();
    const formatted = tab?.mode === "formatted";
    const state = writingState(tab, history, "menus");

    // File, Edit and Window
    for (const id of ["rename", "copy-path", "export-word", "export-pdf", "export-settings", "copy-email", "find", "find-replace", "find-next", "find-previous"]) {
      enabled[id] = !!tab;
    }
    enabled["paste-plain"] = true; // in the document, or any box being typed in
    enabled["next-tab"] = enabled["previous-tab"] = host.tabs().length > 1;
    // A place to go to on that side: greyed out at an end (no going round), and with one document (no tab bar).
    const moving = host.tabToMove();
    const place = moving ? host.tabs().indexOf(moving) : -1;
    enabled["move-tab-left"] = place > 0;
    enabled["move-tab-right"] = place >= 0 && place < host.tabs().length - 1;

    // Insert, Format and Table
    for (const [id, item] of Object.entries(EDITS)) {
      enabled[id] = !!state && item.run(state);
      if (item.on) checked[id] = !!state && item.on(state);
    }
    // The styles are one choice, as in the toolbar's menu: the ticked one stays choosable beside the others.
    const canStyle = !!state && (cmd.setStyle("paragraph")(state) || cmd.setStyle("h1")(state));
    for (const id of ["style-paragraph", "style-h1", "style-h2", "style-h3", "style-h4"]) enabled[id] = canStyle;
    enabled["insert-picture"] = !!state && canInsertPicture(state);
    enabled["insert-link"] = !!state && cmd.canLink(state);
    // The person can comment in either view, and while an agent edits, but not on an old version.
    enabled["comment-add"] = !!tab && (!history.isViewing(tab) || history.status(tab).changes); // Show changes too (roadmap Batch 25, item 1)

    // View
    enabled["view-formatted"] = enabled["view-markdown"] = !!tab;
    checked["view-formatted"] = !!tab && formatted;
    checked["view-markdown"] = tab?.mode === "markdown";
    enabled["view-comments"] = !!tab;
    labels["view-comments"] = tab && commentsOnScreen(tab, history) ? "Hide Comments" : "Show Comments";
    enabled["view-resolved"] = !!tab && tab.comments.resolvedCount > 0;
    checked["view-resolved"] = enabled["view-resolved"] && tab!.comments.showingResolved;
    const versions = tab ? history.status(tab) : null;
    enabled["view-changes"] = enabled["view-history"] = !!tab;
    labels["view-changes"] =
      versions?.viewing === "latest" ? "Hide Changes" : versions?.viewing === "older" ? "Back to Current Version" : "Show Changes";
    labels["view-history"] = versions?.panelOpen ? "Hide History" : "Show History";
    enabled["history-restore"] = !!versions?.canRestore;

    // Review: from card to card in the Comments panel, at any time (no Review mode since 2026-11-09).
    const review = tab ? host.review.status(tab) : null;
    const item = review?.current ? tab!.comments.itemInfo(review.current) : null;
    enabled["review-next"] = !!review?.hasNext;
    enabled["review-previous"] = !!review?.hasPrevious;
    // With Show changes on, they step through its changes (roadmap Batch 3, item 1).
    if (versions?.changes) {
      enabled["review-next"] = enabled["review-previous"] = versions.changeCount > 0;
      labels["review-next"] = "Next Change";
      labels["review-previous"] = "Previous Change";
    }
    enabled["review-reply"] = !!item?.canReply;
    enabled["review-resolve"] = !!item;
    labels["review-resolve"] = item?.resolved ? "Reopen Comment" : item?.note ? "Mark Note as Done" : "Resolve Comment";
    enabled["review-delete"] = !!item?.canDelete;
    const before = tab ? tab.comments.beforeInfo() : null;
    enabled["review-before"] = !!before?.available;
    labels["review-before"] = before?.on ? "Hide What It Said Before" : "Show What It Said Before";
    const handBack = tab ? tab.comments.handBackState() : null;
    enabled["review-send"] = !!handBack?.enabled;
    labels["review-send"] = handBack?.label ?? "Send to Claude";
    const agent = tab ? editingAgent(tab) : null;
    enabled["take-over"] = !!agent;
    labels["take-over"] = agent ? `Take Over from ${agent}` : "Take Over";
    enabled["read-aloud"] = host.readAloud.available();
    labels["read-aloud"] = host.readAloud.reading() ? "Stop Reading Aloud" : "Read Aloud";
    return { enabled, checked, labels };
  }

  // Telling the app, at most every few dozen milliseconds, and only what changed.
  let sent = "";
  let timer: ReturnType<typeof setTimeout> | null = null;
  function flush(): MenuState {
    if (timer) clearTimeout(timer);
    timer = null;
    const state = compute();
    const json = JSON.stringify(state);
    if (json !== sent) {
      sent = json;
      api.menus.setState(state);
    }
    return state;
  }
  function schedule(): void {
    timer ??= setTimeout(flush, 40);
  }
  document.addEventListener("focusin", schedule);
  document.addEventListener("focusout", schedule);
  api.onAgentsChanged(() => schedule());

  // The items the window carries out ------------------------------------------------
  api.onMenu((action) => {
    const tab = host.active();
    // Edit > Undo and Redo chosen with the mouse: where the keyboard is, as their keys (src/main/editing.ts).
    if (action === "edit:undo" || action === "edit:redo") {
      undoWhereKeyboardIs(action === "edit:undo", tab?.comments, (back) => {
        const doc = editable(tab, history);
        if (!doc?.view.hasFocus()) return false;
        (back ? undo : redo)(doc.view.state, doc.view.dispatch);
        return true;
      });
      return schedule();
    }
    if (!tab) return;
    const edit = Object.hasOwn(EDITS, action) ? EDITS[action] : null;
    if (edit) {
      const doc = editable(tab, history);
      if (!doc) return;
      edit.run(doc.view.state, doc.view.dispatch, doc.view);
      doc.view.focus();
    } else if (action === "insert-picture") {
      if (editable(tab, history)) host.insertPicture(tab);
    } else if (action === "insert-link") {
      if (editable(tab, history)) host.openLinkEditor();
    } else if (action === "view-comments") toggleComments(tab, history);
    else if (action === "view-resolved") tab.comments.setShowResolved(!tab.comments.showingResolved);
    else if (action === "view-changes") history.toggleChanges(tab);
    else if (action === "view-history") history.togglePanel(tab);
    else if (action === "history-restore") history.restore(tab);
    else if (action === "take-over") {
      if (editingAgent(tab)) takeOver(tab, api);
    }
    schedule();
  });

  // Shortcuts, while the window has the keyboard ------------------------------------
  // Keys the page itself acts on come first (the editor's Command-B, the find
  // bar's Command-G); the rest go to their menu items, if they apply. Tab,
  // Shift-Tab and Escape on their own stay with the page, which knows whether
  // they're meant for a box being typed in.
  let shortcuts: { id: string; action: string | null; keys: Accelerator }[] = [];
  const learn = (list: MenuShortcut[]) => {
    shortcuts = list.flatMap((s) => {
      const keys = parseAccelerator(s.accelerator);
      return keys && (keys.meta || keys.ctrl || keys.alt) ? [{ id: s.id, action: s.action, keys }] : [];
    });
    // Paste and Match Style also answers Cmd+Option+Shift+V, as many Mac apps have it.
    const plain = shortcuts.find((s) => s.id === "paste-plain");
    const withOption = parseAccelerator("CmdOrCtrl+Alt+Shift+V");
    if (plain && withOption) shortcuts.push({ ...plain, keys: withOption });
  };
  void api.menus.shortcuts().then(learn);
  api.menus.onShortcuts(learn);
  // What each key types on its own on the keyboard in use, for the shortcuts
  // with Option (which changes the character typed). Asked for again each time
  // Option goes down, before the shortcut's own key, in case the keyboard was switched.
  let layout: KeyboardLayout | undefined;
  const learnLayout = () => {
    const keyboard = (navigator as Navigator & { keyboard?: { getLayoutMap(): Promise<ReadonlyMap<string, string>> } }).keyboard;
    keyboard?.getLayoutMap().then(
      (map) => (layout = (code) => map.get(code)),
      () => {},
    );
  };
  learnLayout();
  window.addEventListener("keydown", (e) => {
    if (e.key === "Alt") learnLayout();
    // The editor stops every Return from reaching the browser, whether it used
    // it or not, so Option-Command-Return (Resolve) still counts as unused there.
    const editorReturn = e.key === "Enter" && e.target instanceof Element && !!e.target.closest(".ProseMirror");
    if ((e.defaultPrevented && !editorReturn) || e.isComposing) return;
    const hit = findShortcut(shortcuts, e, layout);
    if (!hit) return;
    if (hit.action === null) {
      // The app's own item (New Document, Close Tab): as if chosen from the menu.
      e.preventDefault();
      api.menus.press(hit.id);
      return;
    }
    if (!flush().enabled[hit.id]) return;
    let action = hit.action;
    // Command-/ goes to the view that isn't showing (the menus move it to that item a moment after each switch).
    if (hit.id === "view-formatted" || hit.id === "view-markdown") {
      action = host.active()?.mode === "markdown" ? "mode:formatted" : "mode:markdown";
    }
    e.preventDefault();
    api.menus.run(action);
  });

  // Right-click: what's at the spot ----------------------------------------------
  document.addEventListener("contextmenu", (e) => {
    const tab = host.active();
    const doc = tab && tab.mode === "formatted" && !history.isViewing(tab) ? tab : null;
    let table = false;
    if (doc && doc.view.dom.contains(e.target as Node)) {
      const view = doc.view;
      const hit = view.posAtCoords({ left: e.clientX, top: e.clientY });
      const $pos = hit ? view.state.doc.resolve(hit.pos) : null;
      const depth = $pos ? cellDepth($pos) : null;
      if ($pos && depth !== null) {
        table = true;
        // The table items act on the cell clicked: the cursor goes there, unless the selection is in it already.
        const { selection } = view.state;
        const $from = selection.$from;
        const inCell = $from.depth >= depth && $from.before(depth) === $pos.before(depth);
        if (!inCell && !(selection instanceof CellSelection)) {
          view.dispatch(view.state.tr.setSelection(TextSelection.near($pos)));
        }
      }
    }
    // In the Markdown view's text (a text box), New Comment still applies.
    const inText = !!(e.target as Element | null)?.closest?.("textarea.source");
    const comment = !!tab && tab.mode === "markdown" && !history.isViewing(tab) && inText;
    api.menus.clicked({ table, editable: !!doc && !doc.readOnly && table, comment });
    flush();
  });

  return { schedule };
}
