// View > Page Width: Standard keeps the text in a comfortable column, as on
// paper; Wide lets it span the space beside the side panel, keeping the page's
// margins either side, up to about 100 characters a line (Orlando). The saved
// values stay "fixed" and "fill", so earlier settings still apply. The same for every document, and
// remembered between launches in the data folder's view.json.
import { BrowserWindow, ipcMain, type MenuItemConstructorOptions } from "electron";
import { readView, writeView } from "./view-settings";

export type PageWidth = "fixed" | "fill";

let width: PageWidth | null = null;

function current(): PageWidth {
  // Read lazily: the data folder is only known once main.ts has set it.
  width ??= readView().pageWidth === "fill" ? "fill" : "fixed";
  return width;
}

function setPageWidth(next: PageWidth): void {
  width = next;
  writeView({ pageWidth: next });
  for (const w of BrowserWindow.getAllWindows()) w.webContents.send("view:page-width", next);
}

ipcMain.handle("view:page-width", () => current());

export function pageWidthMenu(): MenuItemConstructorOptions {
  return {
    id: "page-width",
    label: "Page Width",
    submenu: [
      { id: "page-width-fixed", label: "Standard", type: "radio", checked: current() === "fixed", click: () => setPageWidth("fixed") },
      { id: "page-width-fill", label: "Wide", type: "radio", checked: current() === "fill", click: () => setPageWidth("fill") },
    ],
  };
}
