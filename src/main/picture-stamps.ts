// What the window needs to know about the pictures on this Mac it shows,
// without reading them whole: whether each is there and when it last changed
// (so a picture that appears, or is written again under the same name, is
// shown afresh), and the dots per inch it says it was made at (to size it as
// Word will), read from the first few kilobytes, where pictures say it.
//
// The window asks only about pictures its documents can honestly show: files
// of a picture kind, beside an open document (in its folder or below it, or in
// its Obsidian vault) or named in one's text. Anything else is answered as not
// there, so a page can't learn whether any other file on the Mac exists.
import { constants, promises as fs } from "node:fs";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import { pictureDpi } from "../core/picture-size";
import { isPicture } from "../core/obsidian";
import { vaultOf } from "./vault";

/** How much of a picture is read for its dots per inch: PNG and JPEG say it near the start. */
export const HEAD_BYTES = 64 * 1024;

/** The file a file address names, or null for any other kind of address. */
export const pathOf = (url: string): string | null => {
  try {
    return /^file:/i.test(url) ? path.resolve(fileURLToPath(url)) : null;
  } catch {
    return null;
  }
};

/** An open document, as far as the pictures its window may ask about go. */
export interface PictureOwner {
  filePath: string;
  /** Its text as last saved. */
  diskText: string;
}

const within = (file: string, folder: string) => file.startsWith(folder.endsWith(path.sep) ? folder : folder + path.sep);

/**
 * Which files the window may ask about now, given the open documents: a
 * picture in an open document's folder or below it, or in its Obsidian vault
 * (where its attachments are), or one whose name an open document's text has
 * (an absolute path the person wrote, a folder elsewhere). Worked out once
 * for a whole question about many pictures.
 */
export function picturesAllowed(owners: Iterable<PictureOwner>): (file: string) => boolean {
  const docs = [...owners];
  const folders = new Set<string>();
  for (const doc of docs) {
    folders.add(path.dirname(doc.filePath));
    const vault = vaultOf(doc.filePath);
    if (vault) folders.add(vault);
  }
  // The texts in lower case, made only if a picture isn't beside a document, and let go of with this question.
  let texts: string[] | null = null;
  return (file) => {
    if (!isPicture(file)) return false;
    for (const folder of folders) if (within(file, folder)) return true;
    const name = path.basename(file);
    const ways = [...new Set([name, encodeURIComponent(name), encodeURI(name)].map((n) => n.toLowerCase()))];
    texts ??= docs.map((doc) => doc.diskText.toLowerCase());
    return texts.some((text) => ways.some((way) => text.includes(way)));
  };
}

/** When the picture at this file address last changed, with its size; null if it isn't there. */
export async function pictureStamp(url: string): Promise<string | null> {
  const file = pathOf(url);
  if (!file) return null;
  try {
    const info = await fs.stat(file);
    return info.isFile() ? `${info.mtimeMs}-${info.size}` : null;
  } catch {
    return null;
  }
}

/**
 * The first `bytes` of a file, or null if it isn't an ordinary file that can
 * be read. Opened without waiting: a named pipe, opened the usual way, waits
 * for something to write into it, for good.
 */
export async function pictureHead(file: string, bytes: number): Promise<Uint8Array | null> {
  let handle: fs.FileHandle | null = null;
  try {
    handle = await fs.open(file, constants.O_RDONLY | constants.O_NONBLOCK);
    if (!(await handle.stat()).isFile()) return null;
    const head = new Uint8Array(bytes);
    const { bytesRead } = await handle.read(head, 0, bytes, 0);
    return head.subarray(0, bytesRead);
  } catch {
    return null;
  } finally {
    await handle?.close().catch(() => {});
  }
}

/** The dots per inch the picture at this file address says, from its first few kilobytes only. */
export async function pictureDpiOfFile(url: string): Promise<{ x: number; y: number } | null> {
  const file = pathOf(url);
  const head = file ? await pictureHead(file, HEAD_BYTES) : null;
  return head ? pictureDpi(head) : null;
}
