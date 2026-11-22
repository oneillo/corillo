// Reading and writing documents on disk, carefully. A save never leaves half
// a file or a temporary file behind, keeps the file's permissions and Finder
// tags, writes through a symlink to the real file, and never changes a file
// someone made read-only. Problems come back in plain words.
import * as fs from "node:fs";
import * as path from "node:path";
import { execFileSync } from "node:child_process";
import { randomBytes } from "node:crypto";
import { pictureKind } from "./export-pictures";

/**
 * Corillo opens files up to this size; bigger ones are almost surely not
 * documents, and more than the window can work with (measured 2026-11-09: a
 * 25 MB document takes about 6 seconds to open and 3 GB of memory, and each
 * key typed about a third of a second to show).
 */
export const MAX_DOCUMENT_BYTES = 25 * 1024 * 1024;

/**
 * Past this size the person is asked before a document opens, and agents
 * can't open one by themselves: at 10 MB a key typed takes over a tenth of a
 * second to show, and the window holds more than a gigabyte (at 5 MB, about
 * 60 ms and 0.8 GB).
 */
export const LONG_DOCUMENT_BYTES = 10 * 1024 * 1024;

/** A file's size in megabytes, as the person reads it. */
export const megabytes = (bytes: number) => `${Math.round(bytes / (1024 * 1024))} MB`;

export type DiskState =
  | { kind: "text"; text: string }
  | { kind: "missing" }
  | { kind: "unreadable"; problem: string };

// ignoreBOM keeps a byte-order mark in the text, so saving puts it back.
const utf8 = new TextDecoder("utf-8", { fatal: true, ignoreBOM: true });

/** A problem with a file, described for the person. */
export class FileProblem extends Error {}

const codeOf = (err: unknown) => (err as NodeJS.ErrnoException | null)?.code;

/** What went wrong, in words for the status bar ("Not saved: ..."). */
export function problemText(err: unknown): string {
  if (err instanceof FileProblem) return err.message;
  switch (codeOf(err)) {
    case "ENOSPC":
    case "EDQUOT":
      return "the disk is full";
    case "EACCES":
    case "EPERM":
      return "Corillo isn't allowed to change this file or its folder";
    case "EROFS":
      return "the disk can only be read, not changed";
    case "ENOENT":
    case "ENOTDIR":
      return "the folder it was in is gone";
    case "EISDIR":
      return "there's a folder with the document's name";
    case "ENAMETOOLONG":
      return "the file name is too long";
    case "EIO":
    case "ETIMEDOUT":
    case "EAGAIN":
    case "EBUSY":
    case "ESTALE":
    case "ENETDOWN":
    case "ENETUNREACH":
    case "EHOSTDOWN":
    case "EHOSTUNREACH":
      return "the disk didn't respond";
    default:
      return "something went wrong writing the file";
  }
}

const DOCUMENTS = "Corillo opens Markdown and Word documents";

/**
 * A PDF starts with "%PDF-", after at most a byte-order mark and blank space. A document that only mentions
 * it, even on its first line, is a document (review of Batch 11, B11R-1).
 */
function startsAsPDF(head: Uint8Array): boolean {
  let i = head[0] === 0xef && head[1] === 0xbb && head[2] === 0xbf ? 3 : 0;
  while (i < head.length && (head[i] === 0x20 || head[i] === 0x09 || head[i] === 0x0a || head[i] === 0x0d || head[i] === 0x0c)) i++;
  return Buffer.from(head.subarray(i, i + 5)).toString("latin1") === "%PDF-";
}

/**
 * What a file that isn't a document is, told by what it starts with, in the words the person (and an agent)
 * is told (roadmap Batch 11, F-28): a PDF, or a picture, which belongs in a document. A drawing (SVG) is text,
 * so only one called .svg counts: a document that happens to start with one stays a document. Null for the rest.
 * Asked only when a file is opened, never of a document already open (B11R-1).
 */
function notADocument(filePath: string, bytes: Uint8Array): string | null {
  const head = bytes.subarray(0, 4096);
  if (startsAsPDF(head)) return `${DOCUMENTS}, and this is a PDF. An agent can make a Markdown document from it.`;
  const kind = pictureKind(head);
  if (kind && (kind !== "svg" || path.extname(filePath).toLowerCase() === ".svg")) {
    return `${DOCUMENTS}, and this is a picture. To put it in a document, open the document and choose Insert > Picture.`;
  }
  return null;
}

/** A document's text, to open it. Throws a FileProblem for files Corillo can't open. */
export function readText(filePath: string): string {
  return readUtf8(filePath, true);
}

/** An open document's text, as agents read it: never taken for a PDF or a picture (R22-4). Throws a FileProblem if it isn't UTF-8 text. */
export function readOpenText(filePath: string): string {
  return readUtf8(filePath, false);
}

/**
 * A file's text, if it's text saved as UTF-8 and not too big; else a FileProblem. Only when opening does it
 * ask what kind of file it is: an open document's own text, read before each save, is never taken for a PDF
 * or a picture (B11R-1).
 */
function readUtf8(filePath: string, opening: boolean): string {
  if (fs.statSync(filePath).size > MAX_DOCUMENT_BYTES) {
    throw new FileProblem(`The file is over ${megabytes(MAX_DOCUMENT_BYTES)}, too big for Corillo to open.`);
  }
  const bytes = fs.readFileSync(filePath);
  const not = opening ? notADocument(filePath, bytes) : null;
  if (not) throw new FileProblem(not);
  try {
    return utf8.decode(bytes);
  } catch (err) {
    if (!(err instanceof TypeError)) throw err;
    // Not text at all (a spreadsheet, an archive: text has no zero bytes), or text in an older encoding. Text
    // saved as UTF-16 has zero bytes too, but starts with its mark: it's text, saved another way (B11R-6).
    const utf16 = (bytes[0] === 0xff && bytes[1] === 0xfe) || (bytes[0] === 0xfe && bytes[1] === 0xff);
    if (!utf16 && bytes.subarray(0, 8192).includes(0)) throw new FileProblem(`${DOCUMENTS}, and this file isn't one.`);
    throw new FileProblem("Corillo can only open text files saved as UTF-8.");
  }
}

/** What's on disk now: the text, nothing at all, or something Corillo can't read. */
export function readDisk(filePath: string): DiskState {
  try {
    return { kind: "text", text: readUtf8(filePath, false) };
  } catch (err) {
    const code = codeOf(err);
    if (code === "ENOENT" || code === "ENOTDIR") return { kind: "missing" };
    if (err instanceof FileProblem) return { kind: "unreadable", problem: "the file was changed into something Corillo can't read" };
    return { kind: "unreadable", problem: "the file can't be read right now" };
  }
}

/** The real file behind a path: through symlinks, also to a link's missing target. */
export function realTarget(filePath: string): string {
  try {
    return fs.realpathSync.native(filePath);
  } catch {
    try {
      const link = fs.readlinkSync(filePath);
      return path.resolve(path.dirname(filePath), link);
    } catch {
      return filePath;
    }
  }
}

/** The start of the hidden name a save writes to before it replaces the file. */
const savingStart = (target: string) => `.${path.basename(target)}.corillo-saving`;

/**
 * Where a save writes before it replaces the file: a hidden name with a random part, new at each save, so no
 * other program can put a link there beforehand for the copy to write through (the review of Batch 21, R21-2).
 */
export function savingPathFor(target: string): string {
  return path.join(path.dirname(target), `${savingStart(target)}-${randomBytes(8).toString("hex")}`);
}

/** Open to write, made if missing; never through a link under that name. Emptied only once it is known to be a file of its own (R22-7). */
export const OPEN_NO_LINK = fs.constants.O_WRONLY | fs.constants.O_CREAT | fs.constants.O_NOFOLLOW;

/** Throws EEXIST when anything at all is under that name: a file, a folder, or a link, even one pointing nowhere. */
export function nothingAt(file: string): void {
  try {
    fs.lstatSync(file);
  } catch (err) {
    if (codeOf(err) === "ENOENT") return;
    throw err;
  }
  throw new FileProblem(`something is in the way of ${hiddenCopyOf(file)}`);
}

/** A save's hidden file, named so a person knows it: never by its random name (R22-13). */
function hiddenCopyOf(temp: string): string {
  const name = /^\.(.+)\.corillo-saving(?:-[0-9a-f]{16})?$/.exec(path.basename(temp))?.[1];
  return name ? `Corillo's hidden copy of ${name}` : `Corillo's hidden file ${path.basename(temp)}`;
}

/**
 * Remove the temporary files left by saves of this document that were cut off (a crash, say): every file
 * named as savingPathFor names them, and as an older Corillo named its one. Never a folder or a link.
 */
export function removeLeftover(filePath: string): void {
  const target = realTarget(filePath);
  const start = savingStart(target);
  let names: string[];
  try {
    names = fs.readdirSync(path.dirname(target));
  } catch {
    return; // no folder to look in
  }
  for (const name of names) {
    if (!name.startsWith(start) || !/^(-[0-9a-f]{16})?$/.test(name.slice(start.length))) continue;
    const leftover = path.join(path.dirname(target), name);
    try {
      if (fs.lstatSync(leftover).isFile()) fs.unlinkSync(leftover);
    } catch {
      // gone meanwhile, or not ours to remove
    }
  }
}

/** An older Corillo's leftover, under the one name it used: a look at that name alone, never a listing of the folder (R22-6). */
function removeOldLeftover(target: string): void {
  const old = path.join(path.dirname(target), savingStart(target));
  try {
    if (fs.lstatSync(old).isFile()) fs.unlinkSync(old);
  } catch {
    // nothing there, or not ours to remove
  }
}

/**
 * Where tests plant a fault between writing and reading back (roadmap Batch
 * 14, item 1): wrong bytes in the temporary file (or a Word document's new copy), or another app's change
 * just after the swap. Never set outside tests.
 */
export const writeSeams: {
  /** Between the look that nothing is at the temporary name and the copy made there: where a test plants what another program could put in the folder meanwhile. */
  beforeCopy?: ((temp: string) => void) | null;
  /** Between the copy and Corillo opening it to write: where a test swaps in what another program could (R22-7). */
  afterCopy?: ((temp: string) => void) | null;
  afterTemp: ((temp: string) => void) | null;
  afterSwap: ((target: string) => void) | null;
} = {
  beforeCopy: null,
  afterCopy: null,
  afterTemp: null,
  afterSwap: null,
};

/** Enough of a file's details to tell it was saved again: its number on the disk, size and time modified. */
export interface FileStamp {
  ino: number;
  size: number;
  mtimeMs: number;
}

/** The file's stamp now, or null if it can't be looked at. */
export function fileStamp(file: string): FileStamp | null {
  try {
    const s = fs.statSync(file);
    return { ino: s.ino, size: s.size, mtimeMs: s.mtimeMs };
  } catch {
    return null;
  }
}

/** The file was changed by something else while Corillo was writing it, so Corillo's text didn't take its place. */
export class ChangedMeanwhile extends Error {}

/** What the file must still be just before Corillo's text takes its place: as stamped at the caller's look, or holding the text it was read as. */
export type StillAs = { stamp: FileStamp } | { text: string };

const sameStamp = (a: FileStamp, b: FileStamp | null) => !!b && a.ino === b.ino && a.size === b.size && a.mtimeMs === b.mtimeMs;

/** Whether the file holds exactly these bytes. */
function holds(file: string, bytes: Buffer): boolean {
  try {
    return fs.readFileSync(file).equals(bytes);
  } catch {
    return false;
  }
}

/** Whether a file Corillo just wrote holds what it meant to write (a new document, say). */
export function readsBackAs(file: string, text: string): boolean {
  return holds(file, Buffer.from(text, "utf8"));
}

/**
 * Save text to a document: written in full to a temporary file next to it,
 * then put in its place in one step, so the file is always either the old
 * version or the new one. The temporary file is read back first, so wrong
 * bytes never take the document's place (a FileProblem says so). The
 * document is read back after: if it isn't what was written (a cloud folder
 * or another app changed it in between), its text now is returned, to be
 * taken in as any change made outside Corillo is, never written over; null
 * when it's as meant. Given `stillAs`, the file is looked at again just
 * before the swap: changed since (another app saved it meanwhile), it's left
 * as it is and ChangedMeanwhile is thrown.
 */
export function writeDocument(filePath: string, text: string, stillAs?: StillAs): string | null {
  const target = realTarget(filePath);
  let mode: number | null = null;
  let created: Date | null = null;
  try {
    const s = fs.statSync(target);
    mode = s.mode & 0o7777;
    // Some network drives have no creation date, or a made-up one in the future.
    if (s.birthtimeMs > 0 && s.birthtimeMs <= Date.now()) created = s.birthtime;
  } catch (err) {
    if (codeOf(err) !== "ENOENT") throw err;
  }
  if (mode !== null) {
    // Replacing a read-only file would succeed without asking. Check first.
    try {
      fs.accessSync(target, fs.constants.W_OK);
    } catch {
      throw new FileProblem("the file is read-only or locked");
    }
  }
  const temp = savingPathFor(target);
  const bytes = Buffer.from(text, "utf8");
  let ours = false;
  try {
    // Leftovers with the random part are cleared when the document opens and after a save that failed, not at every save:
    // listing a folder of thousands of notes at each typing pause would be slow (R22-6).
    removeOldLeftover(target);
    // Whatever is still under that name (a link, a folder) isn't Corillo's: never write through it (Batch 21, E21-T1).
    nothingAt(temp);
    ours = true;
    writeSeams.beforeCopy?.(temp);
    // On a Mac, start from a copy of the file so its permissions, Finder tags
    // and other attributes carry over. (Node can't copy those itself.)
    if (mode !== null && process.platform === "darwin") {
      try {
        execFileSync("/bin/cp", ["-p", target, temp], { stdio: "ignore", timeout: 10_000 });
      } catch {
        // Some disks can't hold all of it; the text is what matters.
      }
    }
    writeSeams.afterCopy?.(temp);
    const fd = fs.openSync(temp, OPEN_NO_LINK, mode ?? 0o666);
    let made: fs.Stats;
    try {
      made = fs.fstatSync(fd); // this file, to know it again just before it takes the document's place
      // A second name for another file, put there after the copy, is never emptied or written (R22-7).
      if (!made.isFile() || made.nlink !== 1) throw new FileProblem(`something else changed ${hiddenCopyOf(temp)} while Corillo was saving`);
      fs.ftruncateSync(fd, 0);
      // The new file keeps the document's Date Created (Finder, Spotlight and
      // Obsidian sort by it): on a Mac's disk, dating a file earlier than its
      // creation moves its creation back too. Then it's dated now, as modified
      // (writing no bytes, for an emptied document, wouldn't move the date).
      if (created) {
        try {
          fs.futimesSync(fd, created, created);
          const now = new Date();
          fs.futimesSync(fd, now, now);
        } catch {
          // a disk that can't keep it: the text is what matters
        }
      }
      fs.writeFileSync(fd, bytes);
      fs.fsyncSync(fd);
      if (mode !== null) {
        try {
          fs.fchmodSync(fd, mode); // through the file Corillo opened, never through a name something else may have changed
        } catch {
          // some disks have no permissions to keep
        }
      }
    } finally {
      fs.closeSync(fd);
    }
    writeSeams.afterTemp?.(temp);
    if (!holds(temp, bytes)) {
      throw new FileProblem(`the disk didn't keep what Corillo wrote, so ${mode === null ? "nothing was made" : "the file was left as it was"}`);
    }
    if (stillAs && ("stamp" in stillAs ? !sameStamp(stillAs.stamp, fileStamp(target)) : !holds(target, Buffer.from(stillAs.text, "utf8")))) {
      throw new ChangedMeanwhile("the file was changed while Corillo was writing it");
    }
    // Still the file Corillo made, not a link or another file put under its name since (R21-2).
    const now = fs.lstatSync(temp);
    if (!now.isFile() || now.ino !== made.ino || now.dev !== made.dev) {
      throw new FileProblem(`something else changed ${hiddenCopyOf(temp)} while Corillo was saving`);
    }
    fs.renameSync(temp, target);
  } catch (err) {
    try {
      if (ours) fs.rmSync(temp, { force: true });
    } catch {
      // nothing more to do
    }
    removeLeftover(target);
    throw err;
  }
  writeSeams.afterSwap?.(target);
  if (holds(target, bytes)) return null;
  const now = readDisk(target);
  return now.kind === "text" && now.text !== text ? now.text : null;
}

/** Whether two paths are the same file: also through a symlink, a different case or a hard link. */
export function sameFile(a: string, b: string): boolean {
  if (a === b) return true;
  try {
    const sa = fs.statSync(a);
    const sb = fs.statSync(b);
    return sa.ino === sb.ino && sa.dev === sb.dev;
  } catch {
    return false;
  }
}

/** A document's pictures folder: "Offsite notes images" beside "Offsite notes.md" (doc-pictures.ts, word-copy.ts, vault.ts). */
export function imagesFolder(docPath: string): string {
  const name = path.basename(docPath).replace(/\.[^.]+$/, "");
  return path.join(path.dirname(docPath), `${name} images`);
}
