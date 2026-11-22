// Everyday editing in the main process: the Edit menu (with Find and Paste
// and Match Style), the right-click menu, the clipboard, and fetching
// pictures that pasted web content points at.
import {
  app,
  BrowserWindow,
  clipboard,
  ClipboardItem,
  ipcMain,
  Menu,
  net,
  shell,
  type ContextMenuParams,
  type MenuItemConstructorOptions,
  type WebContents,
} from "electron";
import { pathOf, pictureDpiOfFile, pictureStamp, picturesAllowed, type PictureOwner } from "./picture-stamps";
import { isWindow } from "./window-boundary";
import { IMAGE_TYPES } from "../core/picture-kinds";

/** An item carried out by the window (see menus.ts). */
type WindowItem = (id: string, label: string, action: string, extra?: MenuItemConstructorOptions) => MenuItemConstructorOptions;

/**
 * Undo and Redo. Their keys go as they always have, through the Mac's own
 * Undo, to whatever has the keyboard: the page acts on them first (the
 * Markdown text and the Formatted page keep their own lists), and only what
 * it leaves comes here. Chosen with the mouse, the page's own Undo list may
 * hold nothing for the place the keyboard is (the Markdown text's list is its
 * own), so the document window does it where the keyboard is, as the keys
 * would (undoWhereKeyboardIs in src/renderer/undo-resolve.ts). Any other
 * window (Help, About) gets its page's own Undo, and anything else (a panel
 * of the Mac's) the Mac's, as before.
 */
function undoItem(back: boolean): MenuItemConstructorOptions {
  return {
    id: back ? "undo" : "redo",
    label: back ? "Undo" : "Redo",
    accelerator: back ? "CmdOrCtrl+Z" : "CmdOrCtrl+Shift+Z",
    click: (_item, window, event) => {
      const contents = window instanceof BrowserWindow && !window.isDestroyed() ? window.webContents : null;
      if (!event?.triggeredByAccelerator && contents) {
        if (isWindow(contents, "document")) contents.send("menu", back ? "edit:undo" : "edit:redo");
        else if (back) contents.undo();
        else contents.redo();
      } else if (process.platform === "darwin") Menu.sendActionToFirstResponder(back ? "undo:" : "redo:");
      else if (back) contents?.undo();
      else contents?.redo();
    },
  };
}

/** Items whose keys stay with the page and the Mac (above), so the window never acts on them as shortcuts of its own (menus.ts). */
export const KEYS_LEFT_TO_THE_PAGE = new Set(["undo", "redo"]);

// The document window, for a place its own Undo doesn't cover (a comment box, the find field): the page's own Undo, which keeps to
// the box the keyboard is in (undo-resolve.ts), as the keys do.
ipcMain.on("edit:page-undo", (e, back: unknown) => {
  if (!isWindow(e.sender, "document") || typeof back !== "boolean") return;
  if (back) e.sender.undo();
  else e.sender.redo();
});

export function editMenu(item: WindowItem): MenuItemConstructorOptions {
  return {
    id: "edit-menu",
    label: "Edit",
    submenu: [
      undoItem(true),
      undoItem(false),
      { type: "separator" },
      { id: "cut", role: "cut" },
      { id: "copy", role: "copy" },
      // The whole document, formatted the way the page shows it, for the body of an email (export.ts).
      item("copy-email", "Copy for Email", "copy:email"),
      { id: "paste", role: "paste" },
      item("paste-plain", "Paste and Match Style", "paste:plain", { accelerator: "CmdOrCtrl+Shift+V" }),
      { id: "delete", role: "delete" },
      { id: "select-all", role: "selectAll" },
      { type: "separator" },
      {
        id: "find-menu",
        label: "Find",
        submenu: [
          item("find", "Find…", "find:open", { accelerator: "CmdOrCtrl+F" }),
          item("find-replace", "Find and Replace…", "find:replace", { accelerator: "CmdOrCtrl+Alt+F" }),
          item("find-next", "Find Next", "find:next", { accelerator: "CmdOrCtrl+G" }),
          item("find-previous", "Find Previous", "find:previous", { accelerator: "CmdOrCtrl+Shift+G" }),
        ],
      },
    ],
  };
}

// The clipboard. Copying from the document writes formatted HTML and Markdown
// text together; Paste and Match Style reads the plain text.
ipcMain.handle("clipboard:read-text", () => clipboard.readText());
ipcMain.on("clipboard:write", (_e, html: unknown, text: unknown) => {
  if (typeof html !== "string" || typeof text !== "string") return;
  void clipboard.write([new ClipboardItem({ "text/html": html, "text/plain": text })]).catch(() => {});
});

// Pictures in content pasted from the web are fetched, so the document keeps its own copy.
const MAX_PICTURE_BYTES = 25 * 1024 * 1024;

ipcMain.handle("image:fetch", async (_e, url: unknown) => {
  if (typeof url !== "string" || !/^https?:\/\//i.test(url)) return null;
  const abort = new AbortController();
  const timer = setTimeout(() => abort.abort(), 20_000);
  try {
    const response = await net.fetch(url, { signal: abort.signal });
    const mime = (response.headers.get("content-type") ?? "").split(";")[0].trim().toLowerCase();
    if (!response.ok || !IMAGE_TYPES.has(mime) || !response.body) return null;
    if (Number(response.headers.get("content-length") ?? 0) > MAX_PICTURE_BYTES) return null;
    // Read as it comes, and stop once it's past the limit, rather than take in all of it first.
    const parts: Uint8Array[] = [];
    let size = 0;
    const reader = response.body.getReader();
    for (let part = await reader.read(); !part.done; part = await reader.read()) {
      size += part.value.byteLength;
      if (size > MAX_PICTURE_BYTES) return null;
      parts.push(part.value);
    }
    if (!size) return null;
    const bytes = new Uint8Array(size);
    let at = 0;
    for (const part of parts) {
      bytes.set(part, at);
      at += part.byteLength;
    }
    return { bytes, mime };
  } catch {
    return null;
  } finally {
    clearTimeout(timer);
    abort.abort(); // lets go of a download given up part way
  }
});

// Pictures on this Mac that the window shows: whether each is there and when
// it last changed, asked for all at once at the moments one may have changed
// (see src/renderer/images.ts), and the dots per inch each says it was made at.
// Only for pictures its documents can show (see picturesAllowed); for any
// other file, the answer is that it isn't there.
const MAX_PICTURES_ASKED = 5000;
let owners: () => Iterable<PictureOwner> = () => [];

/** The open documents, whose pictures the window may ask about (main.ts says). */
export function picturesOf(open: () => Iterable<PictureOwner>): void {
  owners = open;
}

const allowedUrl = (allowed: (file: string) => boolean, url: unknown): url is string => {
  const file = typeof url === "string" ? pathOf(url) : null;
  return !!file && allowed(file);
};

ipcMain.handle("picture:stamps", (_e, urls: unknown) => {
  if (!Array.isArray(urls)) return [];
  const allowed = picturesAllowed(owners());
  return Promise.all(urls.slice(0, MAX_PICTURES_ASKED).map((u) => (allowedUrl(allowed, u) ? pictureStamp(u) : null)));
});
ipcMain.handle("picture:dpi", (_e, url: unknown) => (allowedUrl(picturesAllowed(owners()), url) ? pictureDpiOfFile(url) : null));

// The right-click menu ---------------------------------------------------------

const separator: MenuItemConstructorOptions = { type: "separator" };
const OPENABLE = /^(https?|mailto):/i;
/** A link to a file or a heading: the window reads its address as written (see DocTab.openLink). */
const IN_FILES = /^file:/i;

/** What the window said about the spot right-clicked in the document (see src/renderer/menus.ts). */
export interface ClickContext {
  /** In a table in the formatted document. */
  table: boolean;
  /** The document can be edited there (no agent holds it, no old version is shown). */
  editable: boolean;
  /** In the Markdown view's text, where a comment can be started although it's a text box. */
  comment: boolean;
}

// The window says what's at the spot as the right-click happens, before the
// menu is built, so the menu fits the spot clicked.
let clicked: { contents: WebContents; context: ClickContext; at: number } | null = null;
ipcMain.on("menu:context", (e, context: unknown) => {
  e.returnValue = true;
  if (!context || typeof context !== "object") return;
  const { table, editable, comment } = context as Record<string, unknown>;
  clicked = {
    contents: e.sender,
    context: { table: table === true, editable: editable === true, comment: comment === true },
    at: Date.now(),
  };
});

function contextFor(contents: WebContents): ClickContext | null {
  return clicked && clicked.contents === contents && Date.now() - clicked.at < 2000 ? clicked.context : null;
}

/** In a table, its rows and columns, as in the Table menu. */
const TABLE_ITEMS: [string, string][] = [
  ["table-add-row-above", "Add Row Above"],
  ["table-add-row-below", "Add Row Below"],
  ["table-add-column-left", "Add Column Left"],
  ["table-add-column-right", "Add Column Right"],
  ["", ""],
  ["table-delete-row", "Delete Row"],
  ["table-delete-column", "Delete Column"],
  ["table-delete", "Delete Table"],
];

/** What the right-click menu holds, given where the person clicked. */
export function contextMenuItems(params: ContextMenuParams, contents: WebContents, context: ClickContext | null = null): MenuItemConstructorOptions[] {
  const inField = !!params.formControlType && params.formControlType !== "none";
  const hasSelection = params.selectionText.trim() !== "";
  if (!params.isEditable && !hasSelection && !params.linkURL) return [];
  const flags = params.editFlags;
  const items: MenuItemConstructorOptions[] = [];
  const inDocument = params.isEditable && !inField;

  if (params.misspelledWord) {
    const word = params.misspelledWord;
    const suggestions = params.dictionarySuggestions.slice(0, 6);
    for (const suggestion of suggestions) {
      items.push({
        label: suggestion,
        click: () => {
          // In the document Corillo makes the change itself, so it's one undo step like any edit.
          if (inField) contents.replaceMisspelling(suggestion);
          else contents.send("spelling:replace", word, suggestion);
        },
      });
    }
    if (!suggestions.length) items.push({ label: "No Guesses Found", enabled: false });
    items.push({ id: "learn-spelling", label: "Learn Spelling", click: () => contents.session.addWordToSpellCheckerDictionary(word) });
    items.push(separator);
  }

  if (params.linkURL) {
    items.push({
      id: "open-link",
      label: "Open Link",
      // A link to a file or a heading is the document's to follow; Help's and About's own links aren't.
      enabled: OPENABLE.test(params.linkURL) || (IN_FILES.test(params.linkURL) && isWindow(contents, "document")),
      click: () => (OPENABLE.test(params.linkURL) ? void shell.openExternal(params.linkURL) : contents.send("menu", "link:open")),
    });
    if (inDocument) items.push({ id: "edit-link", label: "Edit Link…", click: () => contents.send("menu", "link:edit") });
    items.push({ id: "copy-link", label: "Copy Link", click: () => clipboard.writeText(params.linkURL) });
    if (inDocument) items.push({ id: "remove-link", label: "Remove Link", click: () => contents.send("menu", "link:remove") });
    items.push(separator);
  }

  items.push(
    { id: "cut", role: "cut", enabled: flags.canCut },
    { id: "copy", role: "copy", enabled: flags.canCopy },
    { id: "paste", role: "paste", enabled: flags.canPaste },
    {
      id: "paste-plain",
      label: "Paste and Match Style",
      enabled: flags.canPaste,
      click: () => contents.send("menu", "paste:plain"),
    },
    separator,
    { id: "select-all", role: "selectAll", enabled: flags.canSelectAll },
  );
  if (!inField || context?.comment) {
    items.push(separator, {
      id: "comment",
      label: "New Comment",
      enabled: hasSelection,
      click: () => contents.send("menu", "comment:add"),
    });
  }
  if (!inField && context?.table) {
    items.push(separator);
    for (const [id, label] of TABLE_ITEMS) {
      items.push(id ? { id, label, enabled: context.editable, click: () => contents.send("menu", id) } : separator);
    }
  }
  return items;
}

app.on("web-contents-created", (_e, contents) => {
  contents.on("context-menu", (_event, params) => {
    const items = contextMenuItems(params, contents, contextFor(contents));
    if (!items.length) return;
    Menu.buildFromTemplate(items).popup({ window: BrowserWindow.fromWebContents(contents) ?? undefined });
  });
});
