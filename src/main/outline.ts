// View > Show Outline (roadmap Batch 4, item 1; decision D6, by the roadmap's
// recommendation): the document's headings in a pane at the left of the page
// (src/renderer/outline.ts). Off until the person turns it on, then remembered
// between launches, the same for every document, in the data folder's
// view.json, as Line Numbers is. The menu item and the toolbar's Outline
// button (roadmap Batch 9, item 10) both turn it on and off here, and every
// window hears of it, so the two never disagree.
//
// The outline once had a Done tick beside each heading, kept in the
// document's settings.json and told to agents. It went in roadmap Batch 9,
// item 9; ticks kept from before are taken out as the document opens.
import { BrowserWindow, ipcMain, Menu, type MenuItemConstructorOptions } from "electron";
import { readView, writeView } from "./view-settings";
import { versionHistory } from "./history";

let shown: boolean | null = null;

function current(): boolean {
  // Read lazily: the data folder is only known once main.ts has set it.
  shown ??= readView().outline === true;
  return shown;
}

function showOutline(on: boolean): void {
  shown = on;
  writeView({ outline: on });
  const item = Menu.getApplicationMenu()?.getMenuItemById("view-outline");
  if (item) item.checked = on;
  for (const w of BrowserWindow.getAllWindows()) w.webContents.send("view:outline", on);
}

ipcMain.handle("view:outline", () => current());
// The toolbar's Outline button: the same as choosing the menu item.
ipcMain.handle("view:set-outline", (_e, on: unknown) => {
  if (typeof on === "boolean") showOutline(on);
});

export function outlineMenuItem(): MenuItemConstructorOptions {
  return {
    id: "view-outline",
    label: "Show Outline",
    type: "checkbox",
    // Beside Show Comments, Show Changes and Show History (Control-Command-M, C and H): roadmap Batch 12, G-18.
    accelerator: "Ctrl+Cmd+O",
    checked: current(),
    click: (item) => showOutline(item.checked),
  };
}

/** Where an earlier Corillo kept the Done ticks, in the document's settings. */
const DONE = "doneSections";

/**
 * Done ticks an earlier Corillo kept for this document are taken out of its
 * settings, everything else left as it was. Settings that can't be read right
 * now read as none, so they're never written over; and a problem here never
 * holds up opening the document.
 */
export function forgetDoneTicks(storeId: string): void {
  try {
    const store = versionHistory();
    const settings = store.readSettings(storeId);
    if (!(DONE in settings)) return;
    const { [DONE]: _gone, ...rest } = settings;
    store.writeSettings(storeId, rest);
  } catch {
    // Left for the next time it opens; nothing reads them.
  }
}
