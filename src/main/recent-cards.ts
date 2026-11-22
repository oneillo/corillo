// The start screen's cards: for each recent document, its name, its folder,
// when it last changed, and the top of its text for a small preview. Read
// fresh each time the start screen shows (no stored pictures, so a preview
// is never out of date): only the first few KB of each file, all the files
// at once, and never waiting long on one. A file that's slow to read (one
// still coming down from the cloud, say) gets a card without a preview.
// Nothing here uses Electron, so the tests run it on throwaway folders.
import { promises as fsp } from "node:fs";
import * as path from "node:path";
import { pathToFileURL } from "node:url";
import { withoutFrontMatter } from "./export-prep";
import type { Standing } from "./doc-standing";

/** One recent document, as the start screen shows it. */
export interface RecentCard {
  path: string;
  name: string;
  /** The folder it's in, shortened for the card, as Finder names it: "Documents › Plans". */
  folder: string;
  /** Just the folder's own name, for the card's spoken name: "Open plan.md, in Plans". */
  folderName: string;
  /** The folder as a file: address ending in "/", for the pictures in the preview. */
  dirUrl: string;
  /** Whether the file is there and could be read. */
  state: "ok" | "missing" | "unreadable";
  /** When the file last changed, in milliseconds since 1970; 0 if not known. */
  changed: number;
  /** The top of the document as Markdown, front matter left out; null when it couldn't be read in time. */
  head: string | null;
  /** Where the document stands (see doc-standing.ts); null with nothing to say. */
  standing: Standing | null;
}

/** How many recent documents the start screen shows. */
export const START_SCREEN_CARDS = 8;
/** How much of each file is read: room for long front matter, and a word in any script. */
export const READ_BYTES = 16 * 1024;
/** How much text goes into a preview: much more than it shows, so it's never short. */
export const PREVIEW_CHARS = 4000;
/** How long to wait for one file before showing its card without a preview. */
const SLOW_MS = 1500;

const ICLOUD = "Library/Mobile Documents/com~apple~CloudDocs";
const CLOUD_STORAGE = "Library/CloudStorage/";

/**
 * A folder as the card shows it, the way Finder names it (roadmap Batch 5,
 * item 2): from the home folder ("Documents › Plans"; the home folder itself
 * by its own name, as Finder's sidebar has it), iCloud Drive, a cloud drive
 * ("OneDrive-Personal › Plans") or a disk ("Backup › Plans"); with only the
 * last two folders when there are more than three ("… › 2026 › Plans").
 */
export function shortFolder(dir: string, home: string): string {
  const homeDir = home.replace(/\/+$/, "");
  let start = "";
  let rest: string;
  const inside = (base: string, p: string) => p === base || p.startsWith(base + "/");
  if (inside(homeDir, dir)) {
    rest = dir.slice(homeDir.length + 1);
    if (!rest) return path.basename(homeDir) || homeDir;
    if (inside(ICLOUD, rest)) {
      start = "iCloud Drive";
      rest = rest.slice(ICLOUD.length + 1);
    } else if (rest.startsWith(CLOUD_STORAGE) && rest.length > CLOUD_STORAGE.length) {
      [start, rest] = splitFirst(rest.slice(CLOUD_STORAGE.length));
    }
  } else if (dir.startsWith("/Volumes/") && dir.length > "/Volumes/".length) {
    [start, rest] = splitFirst(dir.slice("/Volumes/".length));
  } else {
    rest = dir.slice(1);
  }
  let folders = rest.split("/").filter(Boolean);
  if (folders.length > 3) folders = ["…", ...folders.slice(-2)];
  return [...(start ? [start] : []), ...folders].join(" › ") || dir;
}

function splitFirst(p: string): [string, string] {
  const at = p.indexOf("/");
  return at < 0 ? [p, ""] : [p.slice(0, at), p.slice(at + 1)];
}

/**
 * The part of a document its preview shows, from the start of the file:
 * without front matter, and ending at the end of a line (or, in a very long
 * paragraph, between words), so a word or a character the read cut in half
 * never shows. `whole` says the read got the entire file. Front matter
 * longer than the read leaves nothing to show.
 */
export function previewSource(head: string, whole: boolean, limit = PREVIEW_CHARS): string {
  let text = head.startsWith("\uFEFF") ? head.slice(1) : head;
  if (!whole) text = text.replace(/�+$/, "");
  const body = withoutFrontMatter(text);
  if (!whole && body === text && /^---[ \t]*\r?\n/.test(text)) return "";
  if (whole && body.length <= limit) return body;
  const cut = body.slice(0, limit);
  const lineEnd = cut.lastIndexOf("\n");
  if (lineEnd >= limit / 2) return cut.slice(0, lineEnd + 1);
  const space = cut.search(/\s\S*$/);
  return space > lineEnd ? cut.slice(0, space) : cut.slice(0, lineEnd + 1) || cut;
}

/** The cards for these documents, most recent first, read all at once. */
export function readRecentCards(paths: string[], home: string): Promise<RecentCard[]> {
  return Promise.all(paths.map((p) => cardWithin(p, home, SLOW_MS)));
}

function cardWithin(filePath: string, home: string, ms: number): Promise<RecentCard> {
  const dir = path.dirname(filePath);
  const plain: RecentCard = {
    path: filePath,
    name: path.basename(filePath),
    folder: shortFolder(dir, home),
    folderName: path.basename(dir) || dir,
    dirUrl: pathToFileURL(dir).href.replace(/\/?$/, "/"),
    state: "ok",
    changed: 0,
    head: null,
    standing: null,
  };
  let timer: ReturnType<typeof setTimeout> | undefined;
  const slow = new Promise<RecentCard>((resolve) => {
    timer = setTimeout(() => resolve(plain), ms);
  });
  return Promise.race([readCard(plain), slow]).finally(() => clearTimeout(timer));
}

async function readCard(plain: RecentCard): Promise<RecentCard> {
  const card = { ...plain };
  let file: Awaited<ReturnType<typeof fsp.open>> | undefined;
  try {
    file = await fsp.open(card.path, "r");
    const info = await file.stat();
    if (!info.isFile()) return { ...card, state: "unreadable" };
    card.changed = info.mtimeMs;
    const buffer = Buffer.alloc(Math.min(READ_BYTES, info.size));
    const { bytesRead } = await file.read(buffer, 0, buffer.length, 0);
    card.head = previewSource(buffer.subarray(0, bytesRead).toString("utf8"), bytesRead >= info.size);
    return card;
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code;
    return { ...card, state: code === "ENOENT" || code === "ENOTDIR" ? "missing" : "unreadable", head: null };
  } finally {
    await file?.close().catch(() => undefined);
  }
}
