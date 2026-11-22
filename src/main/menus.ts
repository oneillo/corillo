// The menu bar. Every action in the window is in it, with its shortcut shown
// the way Mac apps show them (spec: "Everything is discoverable"), in Word's
// order and Mac wording. Items act on the tab in front. The window says which
// of its items apply right now, which are ticked and which words change
// (menu:state), so each is greyed out when it doesn't apply.
import { BrowserWindow, ipcMain, Menu, type MenuItemConstructorOptions, type WebContents } from "electron";
import { appMenu } from "./about";
import { editMenu, KEYS_LEFT_TO_THE_PAGE } from "./editing";
import { zoomMenuItems } from "./zoom";
import { pageWidthMenu } from "./page-width";
import { appearanceMenu } from "./appearance";
import { lineNumbersMenuItem } from "./line-numbers";
import { outlineMenuItem } from "./outline";
import { helpMenuItems } from "./connect-agents";
import { documentMenuItems } from "./your-turn";

export interface MenuHost {
  /** The document window, once its page can take commands. */
  window(): BrowserWindow | null;
  /** Whether these are the document window's contents (ready or not). */
  isMainWindow(contents: WebContents): boolean;
  recent(): { path: string; label: string }[];
  newDocument(): void;
  open(): void;
  openRecent(filePath: string): void;
  clearRecent(): void;
  /** Close the tab in front, or the window when no document is open. */
  closeTab(): void;
  closeWindow(): void;
}

/** What the window says about its items: which apply now, which are ticked, and words that change with the state. */
export interface MenuState {
  enabled: Record<string, boolean>;
  checked: Record<string, boolean>;
  labels: Record<string, string>;
}

/** A shortcut in the menus, and the window's action for it (null: the app carries it out). */
export interface MenuShortcut {
  id: string;
  accelerator: string;
  action: string | null;
}

/** An item carried out by the window, on the tab in front. */
export type WindowItem = (id: string, label: string, action: string, extra?: MenuItemConstructorOptions) => MenuItemConstructorOptions;

const EMPTY: MenuState = { enabled: {}, checked: {}, labels: {} };
let state: MenuState = EMPTY;
let host: MenuHost | null = null;
/** The window's items, by id, with the action each sends. */
const actions = new Map<string, string>();

const separator: MenuItemConstructorOptions = { type: "separator" };

const windowItem: WindowItem = (id, label, action, extra = {}) => {
  actions.set(id, action);
  const toggle = extra.type === "checkbox" || extra.type === "radio";
  return {
    ...extra,
    id,
    label: state.labels[id] ?? label,
    // Greyed out until the window says it applies.
    enabled: state.enabled[id] ?? false,
    ...(toggle ? { checked: state.checked[id] ?? false } : {}),
    click: (item, _window, event) => {
      // The window decides what's ticked (clicking a ticked view mustn't untick it).
      if (toggle) item.checked = state.checked[id] ?? false;
      // Tab and Escape on their own belong to the window, which knows whether
      // they're meant for a box being typed in (it acts on them itself).
      if (event?.triggeredByAccelerator && plainKey(extra.accelerator)) return;
      host?.window()?.webContents.send("menu", action);
    },
  };
};

/**
 * Go to Next or Previous Area: always available, with a document or the start screen. Its key is the window's to act on
 * (it knows where the keyboard is), so only a choice with the mouse is sent from here.
 */
function areaItem(id: string, label: string, action: string, accelerator: string): MenuItemConstructorOptions {
  return {
    id,
    label,
    accelerator,
    click: (_item, _window, event) => {
      if (event?.triggeredByAccelerator) return;
      host?.window()?.webContents.send("menu", action);
    },
  };
}

/** A shortcut with no Command, Control or Option: Tab, Shift-Tab, Escape. */
function plainKey(accelerator: MenuItemConstructorOptions["accelerator"]): boolean {
  return typeof accelerator === "string" && !/(cmd|ctrl|command|control|alt|option|super|meta)/i.test(accelerator);
}

function template(h: MenuHost): MenuItemConstructorOptions[] {
  const w = windowItem;
  const recent = h.recent();
  // The shortcut between the two views is on the one not showing: it takes you there.
  const inMarkdown = !!state.checked["view-markdown"];
  const STYLES: [string, string, string][] = [
    ["style-paragraph", "Normal Text", "0"],
    ["style-h1", "Heading 1", "1"],
    ["style-h2", "Heading 2", "2"],
    ["style-h3", "Heading 3", "3"],
    ["style-h4", "Heading 4", "4"],
  ];
  return [
    appMenu(),
    {
      id: "file-menu",
      label: "File",
      submenu: [
        { id: "new-document", label: "New Document…", accelerator: "CmdOrCtrl+N", click: () => h.newDocument() },
        { id: "open", label: "Open…", accelerator: "CmdOrCtrl+O", click: () => h.open() },
        {
          id: "open-recent",
          label: "Open Recent",
          submenu: [
            ...recent.map((r, i) => ({ id: `recent-${i}`, label: r.label, click: () => h.openRecent(r.path) })),
            ...(recent.length ? [separator] : []),
            { id: "clear-recent", label: "Clear Menu", enabled: recent.length > 0, click: () => h.clearRecent() },
          ],
        },
        separator,
        { id: "close-tab", label: "Close Tab", accelerator: "CmdOrCtrl+W", click: () => h.closeTab() },
        { id: "close-window", label: "Close Window", accelerator: "CmdOrCtrl+Shift+W", click: () => h.closeWindow() },
        separator,
        w("rename", "Rename or Move…", "rename"),
        w("copy-path", "Copy Path", "copy-path", { accelerator: "CmdOrCtrl+Alt+C" }),
        w("history-restore", "Restore This Version", "history-restore"),
        separator,
        w("export-word", "Export to Word…", "export:docx"),
        w("export-pdf", "Export to PDF…", "export:pdf"),
        w("export-settings", "Export Settings…", "export:settings"),
      ],
    },
    editMenu(w),
    {
      id: "view-menu",
      label: "View",
      submenu: [
        w("view-formatted", "Formatted", "mode:formatted", { type: "checkbox", accelerator: inMarkdown ? "CmdOrCtrl+/" : undefined }),
        w("view-markdown", "Markdown", "mode:markdown", { type: "checkbox", accelerator: inMarkdown ? undefined : "CmdOrCtrl+/" }),
        separator,
        w("view-comments", "Show Comments", "view-comments", { accelerator: "Ctrl+Cmd+M" }),
        w("view-resolved", "Show Resolved Comments", "view-resolved", { type: "checkbox" }),
        w("view-changes", "Show Changes", "view-changes", { accelerator: "Ctrl+Cmd+C" }),
        w("view-history", "Show History", "view-history", { accelerator: "Ctrl+Cmd+H" }),
        separator,
        outlineMenuItem(),
        pageWidthMenu(),
        lineNumbersMenuItem(),
        appearanceMenu(),
        separator,
        // Tab stays in the page, where it indents (spec, the bullet on Tab and Shift-Tab), so these move the keyboard between the
        // window's areas: the page, the side panel, the status bar, the tab bar, the toolbar (roadmap Batch 12, G-1).
        areaItem("area-next", "Go to Next Area", "area:next", "F6"),
        areaItem("area-previous", "Go to Previous Area", "area:previous", "Shift+F6"),
        separator,
        ...zoomMenuItems(),
      ],
    },
    {
      id: "insert-menu",
      label: "Insert",
      submenu: [
        w("comment-add", "New Comment", "comment:add", { accelerator: "CmdOrCtrl+Alt+M" }),
        separator,
        w("insert-table", "Table", "insert-table"),
        w("insert-picture", "Picture…", "insert-picture"),
        w("insert-footnote", "Footnote", "insert-footnote"),
        w("insert-line", "Horizontal Line", "insert-line"),
        separator,
        w("insert-link", "Link…", "insert-link", { accelerator: "CmdOrCtrl+K" }),
      ],
    },
    {
      id: "format-menu",
      label: "Format",
      submenu: [
        {
          id: "style-menu",
          label: "Style",
          submenu: STYLES.map(([id, label, key]) => w(id, label, id, { type: "checkbox", accelerator: `CmdOrCtrl+Alt+${key}` })),
        },
        separator,
        w("format-bold", "Bold", "format-bold", { type: "checkbox", accelerator: "CmdOrCtrl+B" }),
        w("format-italic", "Italic", "format-italic", { type: "checkbox", accelerator: "CmdOrCtrl+I" }),
        w("format-strike", "Strikethrough", "format-strike", { type: "checkbox", accelerator: "CmdOrCtrl+Shift+X" }),
        w("format-code", "Code", "format-code", { type: "checkbox", accelerator: "CmdOrCtrl+E" }),
        separator,
        w("format-bullets", "Bulleted List", "format-bullets", { type: "checkbox", accelerator: "CmdOrCtrl+Shift+8" }),
        w("format-numbers", "Numbered List", "format-numbers", { type: "checkbox", accelerator: "CmdOrCtrl+Shift+7" }),
        w("format-indent", "Increase Indent", "format-indent", { accelerator: "Tab" }),
        w("format-outdent", "Decrease Indent", "format-outdent", { accelerator: "Shift+Tab" }),
        separator,
        w("format-quote", "Quote", "format-quote", { type: "checkbox" }),
        w("format-code-block", "Code Block", "format-code-block", { type: "checkbox" }),
      ],
    },
    {
      id: "table-menu",
      label: "Table",
      submenu: [
        w("table-add-row-above", "Add Row Above", "table-add-row-above"),
        w("table-add-row-below", "Add Row Below", "table-add-row-below"),
        w("table-add-column-left", "Add Column Left", "table-add-column-left"),
        w("table-add-column-right", "Add Column Right", "table-add-column-right"),
        separator,
        w("table-align-left", "Align Column Left", "table-align-left"),
        w("table-align-center", "Align Column Center", "table-align-center"),
        w("table-align-right", "Align Column Right", "table-align-right"),
        separator,
        w("table-delete-row", "Delete Row", "table-delete-row"),
        w("table-delete-column", "Delete Column", "table-delete-column"),
        w("table-delete", "Delete Table", "table-delete"),
      ],
    },
    // Working with agents, as Word's Review tab: going through the comments
    // card by card, at any time (there's no Review mode), and taking a
    // document back. Still "Review": it's the everyday word for going
    // through the cards, and where Word keeps its comments.
    {
      id: "review-menu",
      label: "Review",
      submenu: [
        w("review-next", "Next Comment", "review:next", { accelerator: "CmdOrCtrl+Alt+Down" }),
        w("review-previous", "Previous Comment", "review:previous", { accelerator: "CmdOrCtrl+Alt+Up" }),
        w("review-reply", "Reply to Comment", "review:reply", { accelerator: "CmdOrCtrl+Alt+R" }),
        w("review-resolve", "Resolve Comment", "review:resolve", { accelerator: "CmdOrCtrl+Alt+Enter" }),
        w("review-delete", "Delete Comment", "review:delete"),
        w("review-before", "Show What It Said Before", "review:before"),
        separator,
        // Hand the document back to the agent waiting for the review (or copy the sentence for its chat): roadmap Batch 2, item 1.
        w("review-send", "Send to Claude", "review:send", { accelerator: "CmdOrCtrl+Shift+D" }),
        w("take-over", "Take Over", "take-over", { accelerator: "Ctrl+Cmd+T" }),
        separator,
        // Proofreading by ear (roadmap Batch 14, item 4). Control-Command-R: free in Corillo's menus and the page's keys,
        // and not one of the Mac's own (Option-Escape, the Mac's Speak Selection, is left to the Mac).
        w("read-aloud", "Read Aloud", "read-aloud", { accelerator: "Ctrl+Cmd+R" }),
      ],
    },
    {
      id: "window-menu",
      label: "Window",
      role: "windowMenu",
      submenu: [
        { id: "minimize", role: "minimize" },
        { id: "window-zoom", role: "zoom" },
        separator,
        w("next-tab", "Show Next Tab", "next-tab", { accelerator: "Ctrl+Tab" }),
        w("previous-tab", "Show Previous Tab", "previous-tab", { accelerator: "Ctrl+Shift+Tab" }),
        // His order for the tabs (roadmap Batch 10, item 1), one place at a time: the tab in front, or the one the keyboard is on
        // in the tab bar. Not Control-Command and an arrow alone: Word for Mac has those for the writing's direction.
        w("move-tab-left", "Move Tab Left", "move-tab-left", { accelerator: "Ctrl+Shift+Cmd+Left" }),
        w("move-tab-right", "Move Tab Right", "move-tab-right", { accelerator: "Ctrl+Shift+Cmd+Right" }),
        separator,
        { id: "bring-all-to-front", role: "front" },
        // The open documents with their state, where the Mac lists windows (your-turn.ts).
        ...documentMenuItems(),
      ],
    },
    { id: "help-menu", role: "help", submenu: helpMenuItems() },
  ];
}

export function buildMenu(): void {
  if (!host) return;
  actions.clear();
  Menu.setApplicationMenu(Menu.buildFromTemplate(template(host)));
  host.window()?.webContents.send("menu:shortcuts", shortcuts());
}

/** Every shortcut in the menus, so the window can act on it while it has the keyboard. */
function shortcuts(): MenuShortcut[] {
  const list: MenuShortcut[] = [];
  const walk = (items: Electron.MenuItem[]) => {
    for (const item of items) {
      if (item.accelerator && item.id && !item.role && !KEYS_LEFT_TO_THE_PAGE.has(item.id)) list.push({ id: item.id, accelerator: String(item.accelerator), action: actions.get(item.id) ?? null });
      if (item.submenu) walk(item.submenu.items);
    }
  };
  walk(Menu.getApplicationMenu()?.items ?? []);
  return list;
}

const isRecord = (value: unknown, kind: "boolean" | "string") =>
  !!value && typeof value === "object" && !Array.isArray(value) && Object.values(value).every((v) => typeof v === kind);

function sameRecord(a: Record<string, unknown>, b: Record<string, unknown>): boolean {
  const keys = Object.keys(a);
  return keys.length === Object.keys(b).length && keys.every((k) => a[k] === b[k]);
}

function applyState(next: MenuState): void {
  // New words (Show Comments to Hide Comments) or a shortcut moving need the menus built again.
  const rebuild = !sameRecord(next.labels, state.labels) || !!next.checked["view-markdown"] !== !!state.checked["view-markdown"];
  state = next;
  if (rebuild) return buildMenu();
  const menu = Menu.getApplicationMenu();
  if (!menu) return;
  for (const id of actions.keys()) {
    const item = menu.getMenuItemById(id);
    if (!item) continue;
    const on = state.enabled[id] ?? false;
    if (item.enabled !== on) item.enabled = on;
    if (item.type === "checkbox" || item.type === "radio") {
      const ticked = state.checked[id] ?? false;
      if (item.checked !== ticked) item.checked = ticked;
    }
  }
}

/** Wire the menus to the app. */
export function setUpMenus(h: MenuHost): void {
  host = h;
  ipcMain.on("menu:state", (e, next: unknown) => {
    if (!h.isMainWindow(e.sender) || !next || typeof next !== "object") return;
    const s = next as MenuState;
    if (isRecord(s.enabled, "boolean") && isRecord(s.checked, "boolean") && isRecord(s.labels, "string")) applyState(s);
  });
  // A shortcut pressed in the window, for an item the app carries out: as if chosen from the menu.
  ipcMain.on("menu:press", (e, id: unknown) => {
    if (!h.isMainWindow(e.sender) || typeof id !== "string") return;
    const item = Menu.getApplicationMenu()?.getMenuItemById(id);
    if (item && item.enabled && !item.role) item.click();
  });
  ipcMain.handle("menu:shortcuts", () => shortcuts());
}

/** The window went away: nothing in it applies until a new one says so. */
export function windowClosed(): void {
  state = EMPTY;
  buildMenu();
}
