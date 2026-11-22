// View > Line Numbers: the Markdown file's own line numbers beside the text,
// in both views (src/renderer/line-numbers.ts). Off at first, and remembered
// between launches, the same for every document, in the data folder's
// view.json (see view-settings.ts).
import { BrowserWindow, ipcMain, Menu, type MenuItemConstructorOptions } from "electron";
import { readView, writeView } from "./view-settings";

let shown: boolean | null = null;

function current(): boolean {
  // Read lazily: the data folder is only known once main.ts has set it.
  shown ??= readView().lineNumbers === true;
  return shown;
}

export function showLineNumbers(on: boolean): void {
  shown = on;
  writeView({ lineNumbers: on });
  const item = Menu.getApplicationMenu()?.getMenuItemById("line-numbers");
  if (item) item.checked = on;
  for (const w of BrowserWindow.getAllWindows()) w.webContents.send("view:line-numbers", on);
}

ipcMain.handle("view:line-numbers", () => current());

export function lineNumbersMenuItem(): MenuItemConstructorOptions {
  return {
    id: "line-numbers",
    label: "Line Numbers",
    type: "checkbox",
    checked: current(),
    click: (item) => showLineNumbers(item.checked),
  };
}
