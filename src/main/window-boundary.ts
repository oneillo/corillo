// The windows as the edge of what Corillo trusts. The document window's bridge
// is powerful by design (it opens and saves files), so the app answers each
// of its channels only from the window it's meant for: Help, About and the
// hidden export page each reach only their own, whatever got into them. And
// no page is given the camera, the microphone, the Mac's location or any
// other permission: Corillo uses none.
//
// Imported first in main.ts, before any part of the app sets up a channel.
import { ipcMain, session, type WebContents } from "electron";
import { PLAIN_NAME } from "../core/web-pictures";

export type WindowKind = "document" | "help" | "about";

const kinds = new WeakMap<WebContents, WindowKind>();

/** Say what a window is, when it's made. A window nobody named (the hidden export page) reaches only its own channel. */
export function windowIs(contents: WebContents, kind: WindowKind): void {
  kinds.set(contents, kind);
}

/** Whether a window is of this kind (the hidden export page is none of them). */
export function isWindow(contents: WebContents, kind: WindowKind): boolean {
  return kinds.get(contents) === kind;
}

/** The windows that may use a channel. */
function mayUse(channel: string): (WindowKind | "export page")[] {
  if (channel.startsWith("about:")) return ["about"];
  if (channel.startsWith("export-page:")) return ["export page"];
  // Help shows how to connect agents by hand, and can bring up the Connect screen.
  if (channel === "agents:manual" || channel === "agents:copy" || channel === "agents:show-connect") return ["document", "help"];
  return ["document"];
}

function allowed(channel: string, sender: WebContents | undefined): boolean {
  if (!sender) return false;
  return mayUse(channel).includes(kinds.get(sender) ?? "export page");
}

function refused(channel: string): void {
  console.error(`A message on ${channel} came from a window it isn't for, so Corillo ignored it.`);
}

// Answers to invoke: the handler runs only for the right window.
const handle = ipcMain.handle.bind(ipcMain);
ipcMain.handle = (channel, listener) =>
  handle(channel, (e, ...args) => {
    if (!allowed(channel, e.sender)) {
      refused(channel);
      throw new Error("This window can't ask for that.");
    }
    return listener(e, ...args);
  });

// Messages sent one way (and the few that wait for an answer): only the right window's reach the app.
const emit = ipcMain.emit.bind(ipcMain);
ipcMain.emit = (channel: string | symbol, ...args: unknown[]): boolean => {
  const e = args[0] as { sender?: WebContents; returnValue?: unknown } | undefined;
  const fromWindow = typeof channel === "string" && !!e && typeof e === "object" && "sender" in e;
  if (fromWindow && !allowed(channel, e.sender)) {
    refused(channel);
    e.returnValue = null; // a window waiting for an answer isn't left waiting
    return false;
  }
  return emit(channel, ...args);
};

/** Once the app is ready: every permission any page asks for is refused. */
export function refusePermissions(): void {
  session.defaultSession.setPermissionRequestHandler((_contents, _permission, callback) => callback(false));
  session.defaultSession.setPermissionCheckHandler(() => false);
}

/** The name the windows give the web (core/web-pictures.ts). */
export { PLAIN_NAME };

/** Headers a window's web request never carries: cookies, the Mac's language, where it came from, the browser's details. */
const leftOut = (name: string) =>
  name === "cookie" || name === "accept-language" || name === "referer" || name === "user-agent" || name.startsWith("sec-ch-") || name === "sec-fetch-storage-access";

/**
 * Once the app is ready: the windows (the document window, Help, About and
 * Connect share the app's main session) ask the web for a picture as the
 * export's own fetch does (export.ts, webPicture): with no cookies, sent or
 * kept, and a plain name, so a site learns the picture's address and nothing
 * else about the person or the Mac (roadmap Batch 18, item 1). And never
 * for an address that waits for the person to show it (`waits`), whatever in
 * a window asks for it: a backstop behind the page's own markers (the review
 * of Batch 18, R18-2).
 */
export function plainWebRequests(waits: (url: string) => boolean = () => false): void {
  const s = session.defaultSession;
  // Only what goes over the network: the page's own idea of its browser stays as it is, since the editor reads it.
  const web = { urls: ["https://*/*", "http://*/*", "wss://*/*", "ws://*/*"] };
  s.webRequest.onBeforeRequest(web, (details, callback) => callback({ cancel: waits(details.url) }));
  s.webRequest.onBeforeSendHeaders(web, (details, callback) => {
    const requestHeaders: Record<string, string> = { "User-Agent": PLAIN_NAME };
    for (const [name, value] of Object.entries(details.requestHeaders)) if (!leftOut(name.toLowerCase())) requestHeaders[name] = value;
    callback({ requestHeaders });
  });
  s.webRequest.onHeadersReceived(web, (details, callback) => {
    const responseHeaders: Record<string, string[]> = {};
    for (const [name, value] of Object.entries(details.responseHeaders ?? {})) if (name.toLowerCase() !== "set-cookie") responseHeaders[name] = value;
    callback({ responseHeaders });
  });
}
