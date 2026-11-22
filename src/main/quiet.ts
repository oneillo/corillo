// Test and trial runs (CORILLO_HIDDEN=1) happen while someone uses the Mac, so
// they must never take its focus: no Dock icon, no app coming to the front,
// no question or file window on screen, and no other app opened. A test that
// wants to answer a question, or see a file opened, replaces these with its
// own stand-ins.
import { app, dialog, shell } from "electron";

export function keepQuiet(): void {
  // An accessory app has no Dock icon and isn't brought to the front.
  if (process.platform === "darwin") {
    app.setActivationPolicy("accessory");
    app.dock?.hide();
    // The count of documents waiting for the person is kept here, never put on the real Dock icon.
    const dock = app.dock;
    if (dock) {
      let badge = "";
      dock.setBadge = (text: string) => void (badge = text);
      dock.getBadge = () => badge;
    }
  }
  const cancelOf = (args: unknown[]) => {
    const options = args.find((a): a is { cancelId?: number } => typeof a === "object" && a !== null && "message" in a);
    return options?.cancelId ?? 0;
  };
  // A question nobody answered gets its Cancel button, rather than a window on screen.
  dialog.showMessageBox = (async (...args: unknown[]) => ({ response: cancelOf(args), checkboxChecked: false })) as typeof dialog.showMessageBox;
  dialog.showMessageBoxSync = ((...args: unknown[]) => cancelOf(args)) as typeof dialog.showMessageBoxSync;
  dialog.showErrorBox = () => undefined;
  dialog.showOpenDialog = (async () => ({ canceled: true, filePaths: [] })) as typeof dialog.showOpenDialog;
  dialog.showSaveDialog = (async () => ({ canceled: true, filePath: "" })) as typeof dialog.showSaveDialog;
  // Nothing reaches the Mac's own list of recent documents (the Dock icon's menu, Apple menu > Recent Items):
  // what would have, from launch on, is kept here for tests to read.
  const macRecent = { added: [] as string[], cleared: 0 };
  (globalThis as unknown as { macRecent: typeof macRecent }).macRecent = macRecent;
  app.addRecentDocument = (filePath: string) => void macRecent.added.push(filePath);
  app.clearRecentDocuments = () => void macRecent.cleared++;
  // Nothing opens in another app: not Word, a browser or Finder.
  shell.openPath = async () => "";
  shell.openExternal = async () => undefined;
  shell.showItemInFolder = () => undefined;
}
