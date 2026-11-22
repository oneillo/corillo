// What Corillo keeps about each document outside the document itself
// (comments, versions, settings), in its own data folder. Each document gets
// a folder, found by the document's path. If the document was renamed or
// moved while Corillo wasn't looking, its folder is found again by the file's
// identity on disk, or, when that changed too (moved to another drive), by
// its name and text matching what Corillo last saved. A document whose file
// has been gone for 30 days has its folder and record cleared (see sweep).
//
// The list of documents (documents.json) is the one file every document's
// comments and history hang on, and it's written on every save. So it's
// flushed to disk before it replaces the old one; a copy read fine at launch
// is kept (documents.json.bak); and each document's folder keeps where its
// document is (record.json, written only when that changes), so the list
// can be rebuilt. A list that's damaged is set aside under a dated name,
// never written over; one that can't be read right now (no permission, a
// disk that didn't answer) stops Corillo changing it, so nothing is lost.
// The same rule holds for each document's own files: not there is "none",
// damaged is set aside, unreadable is left alone.
import * as fs from "node:fs";
import * as path from "node:path";
import { createHash, randomUUID } from "node:crypto";
import { gunzipSync, gzipSync } from "node:zlib";
import { gunzip } from "node:zlib";
import type { PassNote, Thread } from "../core/comments";
import { changingPlaces, inTrash, placeAvailable, stillOnDisk, thereNow, whereNow, type Identity } from "./whereabouts";

/** How long a document's file can be gone before what Corillo keeps for it is cleared. */
export const GONE_DAYS = 30;
const GONE_MS = GONE_DAYS * 24 * 60 * 60 * 1000;

interface Entry {
  path: string;
  ino: number;
  dev: number;
  /** A fingerprint of the text Corillo last saved, to know the file again if it moves to another drive. */
  text?: string;
  /**
   * Since Corillo noticed the file gone: how long it has counted (ms), and
   * when it last counted. No `at` while its drive or cloud folder is away,
   * so that time isn't counted.
   */
  missing?: { counted: number; at?: number };
}

export interface StoreOptions {
  /** Where drives and cloud folders appear (tests use their own). */
  drives?: string[];
}

type Index = Record<string, Entry>;

/** Which of a document's files was damaged and set aside. */
export type SetAsideKind = "comments" | "notes" | "settings" | "history";

const fingerprint = (text: string) => createHash("sha256").update(text).digest("base64url").slice(0, 22);
/** Text worth knowing a document by: not empty or only spaces, which many files share. */
const telling = (text: string | undefined): text is string => !!text && /\S/.test(text);
const sameName = (a: string, b: string) => path.basename(a).toLowerCase() === path.basename(b).toLowerCase();
const codeOf = (err: unknown) => (err as NodeJS.ErrnoException | null)?.code;

/**
 * One of Corillo's own files is there but can't be read right now (no
 * permission, a disk that didn't answer, too many files open). It isn't
 * damaged, so nothing is written over it until it can be read again.
 */
export class RecordsUnreadable extends Error {
  constructor(file: string, cause: unknown) {
    super(`Corillo couldn't read ${path.basename(file)} in its data folder (${codeOf(cause) ?? String(cause)}).`);
  }
}

/** A file's bytes, or null if it isn't there. Any other failure throws RecordsUnreadable. */
function readIfThere(file: string): Buffer | null {
  try {
    return fs.readFileSync(file);
  } catch (err) {
    if (codeOf(err) === "ENOENT" || codeOf(err) === "ENOTDIR") return null;
    throw new RecordsUnreadable(file, err);
  }
}

/** Keep a damaged file under a dated name beside it (never deleted, so it can still be looked at). */
export function setAsideDamaged(file: string, now: Date): string {
  const stamp = now.toISOString().replace(/[:.]/g, "-");
  let to = `${file}.damaged-${stamp}`;
  for (let i = 2; fs.existsSync(to); i++) to = `${file}.damaged-${stamp}-${i}`;
  fs.renameSync(file, to);
  return to;
}

/** The list of documents, or null if these bytes aren't one (cut short, empty, garbled). */
function parseIndex(raw: Buffer): Index | null {
  let data: unknown;
  try {
    data = JSON.parse(raw.toString("utf8"));
  } catch {
    return null;
  }
  if (!data || typeof data !== "object" || Array.isArray(data)) return null;
  const index: Index = {};
  for (const [id, e] of Object.entries(data as Record<string, unknown>)) {
    if (e && typeof e === "object" && typeof (e as Entry).path === "string") index[id] = e as Entry;
  }
  return index;
}

/** What a document's folder keeps about where its document is. */
function parseRecord(raw: Buffer | null): { path: string } | null {
  if (!raw) return null;
  try {
    const data = JSON.parse(raw.toString("utf8")) as { path?: unknown };
    return typeof data?.path === "string" ? { path: data.path } : null;
  } catch {
    return null;
  }
}

export class DocumentStore {
  private indexFile: string;
  private drives: string[];
  /** Whether this run has looked the list over once (kept a good copy, found documents missing from it). */
  private looked = false;
  /** Each document's place as the list on disk has it, to know when its folder's record needs writing. */
  private lastPaths = new Map<string, string>();
  /** Documents whose folder's record was checked this run. */
  private recordChecked = new Set<string>();
  /** Documents whose folder's record couldn't be written: it may be out of date. */
  private unnoted = new Set<string>();
  /**
   * Documents whose settings.json was found damaged this run: which web
   * pictures wait isn't known, so every one does (the review of Batch 21,
   * G21-3), even if the settings written in its place couldn't be. With
   * each, the addresses he showed since, so his click sticks while those
   * settings can't be written (the review of Batch 21, R21-5).
   */
  private settingsDamaged = new Map<string, string[]>();
  /** Called when one of a document's files was damaged and set aside, so the person can be told. */
  onSetAside: (id: string, what: SetAsideKind) => void = () => {};

  constructor(
    private base: string,
    protected clock: () => Date = () => new Date(),
    options: StoreOptions = {},
  ) {
    this.indexFile = path.join(base, "documents.json");
    this.drives = options.drives ?? changingPlaces();
  }

  private get backupFile(): string {
    return `${this.indexFile}.bak`;
  }

  private recordFile(id: string): string {
    return path.join(this.folder(id), "record.json");
  }

  /**
   * The list of documents. Not there yet: empty (or rebuilt, if documents'
   * folders say otherwise). Damaged: set aside, and rebuilt from the copy
   * kept at launch and the records in documents' folders. Can't be read
   * right now: throws RecordsUnreadable, so nothing is written over it.
   */
  private readIndex(): Index {
    const raw = readIfThere(this.indexFile);
    const index = raw && parseIndex(raw);
    if (!index) return this.rebuildIndex(raw !== null);
    this.lastPaths = new Map(Object.entries(index).map(([id, e]) => [id, e.path]));
    if (!this.looked) {
      this.looked = true;
      // Read fine: keep it as the copy to fall back on, and take back any document whose folder is here but isn't listed.
      try {
        writeAtomic(this.backupFile, raw, true);
      } catch (err) {
        console.error("Couldn't keep a copy of the list of documents.", err);
      }
      if (this.fromFolders(index, false)) this.writeIndex(index);
    }
    return index;
  }

  /** The list was damaged (set it aside) or isn't there: start from the copy kept at launch and the documents' own records. */
  private rebuildIndex(damaged: boolean): Index {
    this.looked = true;
    if (damaged) {
      const aside = setAsideDamaged(this.indexFile, this.clock());
      console.error(`The list of documents was damaged; it was set aside as ${path.basename(aside)} and rebuilt.`);
    }
    const backup = readIfThere(this.backupFile);
    const index = (backup && parseIndex(backup)) ?? {};
    this.lastPaths = new Map();
    const changed = this.fromFolders(index, true);
    if (damaged || changed) this.writeIndex(index);
    return index;
  }

  /**
   * Bring the list up to date from the records documents' folders keep: with
   * `all`, every folder's (the list was rebuilt, so a record, written when its
   * document last moved, knows better); otherwise only those of folders the
   * list doesn't have. Says whether anything changed.
   */
  private fromFolders(index: Index, all: boolean): boolean {
    let names: string[];
    try {
      names = fs.readdirSync(path.join(this.base, "documents"));
    } catch {
      return false;
    }
    const found: { id: string; path: string; at: number }[] = [];
    for (const id of names) {
      if (id.startsWith(".") || (!all && index[id])) continue;
      try {
        const rec = parseRecord(readIfThere(this.recordFile(id)));
        if (rec) found.push({ id, path: rec.path, at: fs.statSync(this.recordFile(id)).mtimeMs });
      } catch {
        // a record that can't be read: that document stays as the list has it
      }
    }
    let changed = false;
    // Oldest first, so where two records name one place, the newer one has it.
    for (const { id, path: p } of found.sort((a, b) => a.at - b.at)) {
      this.lastPaths.set(id, p);
      this.recordChecked.add(id);
      const e = index[id];
      if (e && e.path === p) continue;
      const taken = !!p && Object.entries(index).some(([other, o]) => other !== id && o.path === p);
      if (taken && !all) {
        // Listed fine for another document: the list knows better. Kept without a place, it's cleared in 30 days.
        index[id] = { path: "", ino: -1, dev: -1 };
      } else {
        if (taken) this.release(index, p, id);
        index[id] = { ...(e ?? { ino: -1, dev: -1 }), path: p };
      }
      changed = true;
    }
    if (all) {
      // The copy kept at launch has each file's identity as it was then; saves since gave it a new one.
      for (const e of Object.values(index)) {
        if (!e.path) continue;
        try {
          const s = fs.statSync(e.path);
          if (s.ino !== e.ino || s.dev !== e.dev) {
            e.ino = s.ino;
            e.dev = s.dev;
            changed = true;
          }
        } catch {
          // not there now: what the list knew stays
        }
      }
    }
    return changed;
  }

  private writeIndex(index: Index): void {
    fs.mkdirSync(this.base, { recursive: true });
    writeJsonAtomic(this.indexFile, index, true);
    // Each document's folder notes where its document is, when that changed (or the note couldn't be written
    // last time), so the list can be rebuilt.
    for (const [id, e] of Object.entries(index)) if (this.lastPaths.get(id) !== e.path || this.unnoted.has(id)) this.writeRecord(id, e.path);
    this.lastPaths = new Map(Object.entries(index).map(([id, e]) => [id, e.path]));
  }

  private writeRecord(id: string, place: string): void {
    try {
      fs.mkdirSync(this.folder(id), { recursive: true });
      writeJsonAtomic(this.recordFile(id), { path: place }, true);
      this.recordChecked.add(id);
      this.unnoted.delete(id);
    } catch (err) {
      console.error("Couldn't note where a document is in its folder.", err); // a spare: the list is what counts
      this.recordChecked.delete(id);
      this.unnoted.add(id); // tried again at the next write of the list, so a stale note never outranks it
    }
  }

  /** Once a run per document: its folder's record says where it is (documents known before records were kept get one). */
  private checkRecord(id: string): void {
    if (this.recordChecked.has(id)) return;
    this.recordChecked.add(id);
    const place = this.lastPaths.get(id);
    if (place === undefined) return;
    try {
      if (parseRecord(readIfThere(this.recordFile(id)))?.path !== place) this.writeRecord(id, place);
    } catch {
      // can't be read now: looked at again next run
    }
  }

  private identity(filePath: string): Identity {
    try {
      const s = fs.statSync(filePath);
      return { ino: s.ino, dev: s.dev };
    } catch {
      return { ino: -1, dev: -1 };
    }
  }

  /** Other paths found to be a known document (through a symlink, or other capitals), so they're looked for once. */
  private aliases = new Map<string, string>();

  /**
   * The id of a document's folder, creating one if it has none. `text`, the
   * file's text as it opens, is noted so a document moved to another drive
   * can be known by it.
   */
  idFor(filePath: string, text?: string): string {
    const id = this.lookUp(filePath, text);
    this.checkRecord(id);
    return id;
  }

  private lookUp(filePath: string, text?: string): string {
    const index = this.readIndex();
    const print = telling(text) ? fingerprint(text) : undefined;
    /** Note what's true of the record now: here, with this text. */
    const update = (id: string, e: Entry): string => {
      const back = e.missing && fs.existsSync(filePath); // put back from the Trash, say
      const reprint = text !== undefined && e.text !== print;
      if (back) delete e.missing;
      if (reprint) {
        if (print) e.text = print;
        else delete e.text;
      }
      if (back || reprint) this.writeIndex(index);
      return id;
    };
    for (const [id, e] of Object.entries(index)) if (e.path === filePath) return update(id, e);
    const { ino, dev } = this.identity(filePath);
    const isNow = (p: string) => {
      const other = this.identity(p);
      return ino >= 0 && other.ino === ino && other.dev === dev;
    };
    // The same file reached another way: through a linked folder, or written
    // with other capitals (the Mac's disks don't mind). It's one document,
    // with one set of comments and one history.
    const known = this.aliases.get(filePath);
    if (known && index[known] && isNow(index[known].path)) return known;
    if (ino >= 0) {
      for (const [id, e] of Object.entries(index)) {
        if (e.path && isNow(e.path)) {
          this.aliases.set(filePath, id);
          return id;
        }
      }
    }
    const adopt = (id: string) => {
      const kept = print ?? (text === undefined ? index[id].text : undefined);
      const was = index[id].path;
      index[id] = { path: filePath, ino, dev, ...(kept ? { text: kept } : {}) };
      this.writeIndex(index);
      if (was) this.onFoundMoved(was, filePath);
      return id;
    };
    // Moved in Finder: same file on disk, at a path we don't know, while the
    // old path is gone (on a drive that's here: numbers are handed out again).
    for (const [id, e] of Object.entries(index)) {
      if (e.ino === ino && e.dev === dev && ino >= 0 && thereNow(e.path) === false && this.driveHere(e, true)) return adopt(id);
    }
    // Moved to another drive (a new file there): the same name and the text
    // Corillo last saw, where the old file is gone. Only if just one fits.
    if (print) {
      const fits = Object.entries(index).filter(
        ([, e]) => e.text === print && sameName(e.path, filePath) && thereNow(e.path) === false && this.driveHere(e),
      );
      if (fits.length === 1) return adopt(fits[0][0]);
    }
    const id = randomUUID();
    index[id] = { path: filePath, ino, dev, ...(print ? { text: print } : {}) };
    this.writeIndex(index);
    return id;
  }

  /**
   * Corillo has just made a new file here. Whatever document was at this
   * path before (one deleted since) keeps its folder, but no longer answers
   * to this path, so the new document starts with no comments or history.
   */
  created(filePath: string): void {
    const index = this.readIndex();
    if (this.release(index, filePath, null)) this.writeIndex(index);
  }

  /** Stop older records answering to a path (except `keep`'s). Says whether any did. */
  private release(index: Record<string, Entry>, filePath: string, keep: string | null): boolean {
    let changed = false;
    for (const [id, e] of Object.entries(index)) {
      if (id !== keep && e.path === filePath) {
        index[id] = { ...e, path: "" };
        changed = true;
      }
    }
    for (const [alias, id] of this.aliases) if (alias === filePath && id !== keep) this.aliases.delete(alias);
    return changed;
  }

  /**
   * After Corillo saves (which replaces the file on disk), or takes in
   * another app's change: remember the file's identity now, and the text,
   * for finding it again after a Finder move or a move to another drive.
   */
  saved(id: string, filePath: string, text?: string): void {
    const index = this.readIndex();
    const { ino, dev } = this.identity(filePath);
    const e = index[id];
    const print = text === undefined ? e?.text : telling(text) ? fingerprint(text) : undefined;
    if (e && e.path === filePath && e.ino === ino && e.dev === dev && e.text === print && !e.missing) return;
    // One path is one document: one that used to be here (deleted, say) doesn't answer to it any more.
    this.release(index, filePath, id);
    index[id] = { path: filePath, ino, dev, ...(print ? { text: print } : {}) };
    this.writeIndex(index);
  }

  moved(id: string, newPath: string): void {
    this.saved(id, newPath);
  }

  /** The file as Corillo last knew it: where, and its identity on disk. */
  lastKnown(id: string): { path: string; ino: number; dev: number } | null {
    const e = this.readIndex()[id];
    return e ? { path: e.path, ino: e.ino, dev: e.dev } : null;
  }

  /** Corillo noticed an open document's file go (to the Trash, or deleted): its 30 days start now. */
  noticedMissing(id: string): void {
    const index = this.readIndex();
    const e = index[id];
    if (!e || e.missing) return;
    e.missing = { counted: 0, at: this.clock().getTime() };
    this.writeIndex(index);
  }

  // For the start screen (roadmap Batch 4, item 3): read only, never changing the list or setting a file aside.

  /** A closed document was found moved (by the sweep, or opened where it went) and noted at its new place: the recent list follows it. */
  onFoundMoved: (from: string, to: string) => void = () => {};

  /** The document last known at each path: its record's id and identity on disk, or null. Null for all if the list can't be read. */
  knownAt(paths: string[]): ({ id: string; ino: number; dev: number } | null)[] {
    let index: Index | null = null;
    try {
      const raw = readIfThere(this.indexFile);
      index = raw && parseIndex(raw);
    } catch {
      // can't be read right now: nothing known
    }
    const byPath = new Map(Object.entries(index ?? {}).map(([id, e]) => [e.path, { id, ino: e.ino, dev: e.dev }]));
    return paths.map((p) => byPath.get(p) ?? null);
  }

  /** A document's comments and the agents' notes waiting for the person, as on disk; null if either can't be read. */
  async peek(id: string): Promise<{ threads: Thread[]; notes: PassNote[] } | null> {
    const read = (name: string) =>
      fs.promises.readFile(path.join(this.folder(id), name)).catch((err: unknown) => {
        if (codeOf(err) === "ENOENT" || codeOf(err) === "ENOTDIR") return null;
        throw err;
      });
    const list = (raw: Buffer | null): unknown[] => {
      if (!raw) return [];
      const data: unknown = JSON.parse(raw.toString("utf8"));
      if (!Array.isArray(data)) throw new Error("not a list");
      return data;
    };
    try {
      const [gz, notes] = await Promise.all([read("comments.json.gz"), read("notes.json")]);
      const threads = gz ? list(await new Promise<Buffer>((resolve, reject) => gunzip(gz, (err, out) => (err ? reject(err) : resolve(out))))) : list(await read("comments.json"));
      return {
        threads: threads as Thread[],
        notes: list(notes).filter((n): n is PassNote => !!n && typeof (n as PassNote).id === "string" && typeof (n as PassNote).agent === "string"),
      };
    } catch {
      return null;
    }
  }

  /**
   * Find it… on the start screen: whether the file the person chose is the
   * document Corillo knew as `id`, before its comments and history are joined
   * to it. It is if it's the same file on disk, or its text is the text
   * Corillo last saved; and nothing is left at the old place, and no other
   * document is known at the chosen one.
   */
  isDocument(id: string, filePath: string, text: string): boolean {
    const index = this.readIndex();
    const e = index[id];
    if (!e || (e.path && fs.existsSync(e.path))) return false;
    if (Object.entries(index).some(([other, o]) => other !== id && o.path === filePath)) return false;
    const now = this.identity(filePath);
    if (e.ino >= 0 && now.ino === e.ino && now.dev === e.dev) return true;
    return telling(text) && e.text === fingerprint(text);
  }

  /**
   * Look over every document Corillo keeps something for, cheaply (a check
   * of each path; the Mac asked once for where moved ones went), and clear
   * what's kept for those whose file has been gone for 30 days. Gone means
   * not at its last path and not found moved: deleted, or in the Trash. A
   * file on a drive or cloud folder that isn't there isn't gone, nor is one
   * Corillo isn't allowed to look at, and that time isn't counted. One found
   * moved is noted where it went. Open
   * documents are left alone. Says which were cleared.
   */
  async sweep(open: Set<string>): Promise<string[]> {
    const now = this.clock().getTime();
    const first = this.readIndex();
    type Seen = { e: Entry; state: "here" | "away" | "gone" | "ask" };
    const seen = new Map<string, Seen>();
    for (const [id, e] of Object.entries(first)) {
      if (open.has(id)) continue;
      const there = e.path ? thereNow(e.path) : false;
      if (there) {
        if (e.missing) seen.set(id, { e, state: "here" });
      } else if (e.path && (there === null || !this.driveHere(e))) seen.set(id, { e, state: "away" });
      else if (stillOnDisk(e, e.path || "/") === true) seen.set(id, { e, state: "ask" });
      else seen.set(id, { e, state: "gone" });
    }
    const asking = [...seen].filter(([, s]) => s.state === "ask");
    const where = new Map<string, string | null>();
    if (asking.length) {
      const found = await whereNow(asking.map(([, s]) => s.e));
      asking.forEach(([id], i) => where.set(id, found[i]));
    }
    // Saves may have changed the list meanwhile: change only what's as it was.
    const index = this.readIndex();
    const removed: string[] = [];
    let changed = false;
    for (const [id, { e, state }] of seen) {
      const cur = index[id];
      if (!cur || cur.path !== e.path || cur.ino !== e.ino || cur.dev !== e.dev || open.has(id)) continue;
      const went = where.get(id);
      if (state === "here" || (state === "ask" && went === null)) {
        // Back in its place; or somewhere Corillo can't name, so not counted as gone.
        if (state === "here") delete cur.missing;
        changed = changed || state === "here";
        continue;
      }
      if (state === "ask" && went && !inTrash(went)) {
        index[id] = { ...cur, path: went };
        delete index[id].missing;
        changed = true;
        this.onFoundMoved(e.path, went);
        continue;
      }
      if (state === "away") {
        if (cur.missing?.at !== undefined) {
          cur.missing = { counted: cur.missing.counted };
          changed = true;
        }
        continue;
      }
      // Gone: deleted, or in the Trash.
      const m = cur.missing ?? { counted: 0 };
      const counted = m.counted + (m.at === undefined ? 0 : Math.max(0, now - m.at));
      if (counted >= GONE_MS) {
        fs.rmSync(this.folder(id), { recursive: true, force: true });
        delete index[id];
        for (const [alias, to] of this.aliases) if (to === id) this.aliases.delete(alias);
        removed.push(id);
      } else cur.missing = { counted, at: now };
      changed = true;
    }
    if (changed) this.writeIndex(index);
    return removed;
  }

  private folder(id: string): string {
    return path.join(this.base, "documents", id);
  }

  /**
   * Whether the drive a document was on is here now: not an ejected drive or
   * a cloud folder that's away, nor one reached through a linked folder that
   * isn't plugged in (its folder is missing, and the nearest one above that's
   * there is on another drive). With `sameDrive`, its folder must also be on
   * the drive Corillo noted for it, even when the folder is there.
   */
  private driveHere(e: Entry, sameDrive = false): boolean {
    if (!e.path || !placeAvailable(e.path, this.drives)) return false;
    if (e.ino < 0) return true; // its drive isn't known: nothing more to check
    const own = path.dirname(e.path);
    for (let dir = own; ; dir = path.dirname(dir)) {
      try {
        return fs.statSync(dir).dev === e.dev || (dir === own && !sameDrive);
      } catch {
        if (dir === path.dirname(dir)) return false;
      }
    }
  }

  /**
   * One of a document's own files: null if it isn't there; set aside (and
   * the person told) and null if it's damaged; throws RecordsUnreadable if
   * it can't be read right now, so nothing is written over it.
   */
  private readOwn<T>(id: string, name: string, what: SetAsideKind, parse: (raw: Buffer) => T | null, damaged?: () => void): T | null {
    const file = path.join(this.folder(id), name);
    const raw = readIfThere(file);
    if (raw === null) return null;
    let value: T | null = null;
    try {
      value = parse(raw);
    } catch {
      // damaged
    }
    if (value !== null) return value;
    damaged?.();
    setAsideDamaged(file, this.clock());
    this.onSetAside(id, what);
    return null;
  }

  /**
   * A document's comments, resolved ones too, kept compressed in
   * comments.json.gz: they're kept as long as the document is, and the whole
   * file is written again whenever one changes or the person's typing moves
   * them. (Before 2026-11-09 they were plain comments.json, still read.)
   */
  readComments(id: string): Thread[] {
    const list = (text: string) => {
      const data: unknown = JSON.parse(text);
      return Array.isArray(data) ? (data as Thread[]) : null;
    };
    return (
      this.readOwn(id, "comments.json.gz", "comments", (raw) => list(gunzipSync(raw).toString("utf8"))) ??
      this.readOwn(id, "comments.json", "comments", (raw) => list(raw.toString("utf8"))) ??
      []
    );
  }

  /**
   * Write a document's comments, flushed to the disk before it replaces what
   * was: every write holds every comment, so one that only moves them with
   * the person's typing is flushed too (with 200 comments, about 7 ms in
   * place of 3, after a pause in typing).
   */
  writeComments(id: string, threads: Thread[]): void {
    fs.mkdirSync(this.folder(id), { recursive: true });
    // zlib's quickest level: about a quarter of the room, in a few milliseconds for hundreds of comments.
    writeAtomic(path.join(this.folder(id), "comments.json.gz"), gzipSync(JSON.stringify(threads), { level: 1 }), true);
    fs.rmSync(path.join(this.folder(id), "comments.json"), { force: true });
  }

  // An older Corillo kept agents' changes tied to no comment here too
  // (other-changes.json), for cards in the Comments panel. Those cards are
  // gone (roadmap Batch 9, item 5: they're passes in History), and the file is
  // left as it was: nothing reads or writes it.

  /** Agents' notes waiting for the person (notes.json; roadmap Batch 2, item 3), oldest first. */
  readNotes(id: string): PassNote[] {
    const notes = this.readOwn(id, "notes.json", "notes", (raw) => {
      const data: unknown = JSON.parse(raw.toString("utf8"));
      return Array.isArray(data) ? (data as unknown[]) : null;
    });
    return (notes ?? []).filter((n): n is PassNote => {
      const x = n as PassNote;
      return !!x && typeof x.id === "string" && typeof x.agent === "string" && typeof x.text === "string" && typeof x.at === "string";
    });
  }

  /** Flushed every time, as comments are. */
  writeNotes(id: string, notes: PassNote[]): void {
    fs.mkdirSync(this.folder(id), { recursive: true });
    writeJsonAtomic(path.join(this.folder(id), "notes.json"), notes, true);
  }

  /** A document's settings (export settings, for one), in settings.json in its folder. */
  readSettings(id: string): Record<string, unknown> {
    return this.settingsOf(id).settings;
  }

  /**
   * The settings, and whether settings.json was there but damaged (set
   * aside, so the usual ones are back). Which web pictures wait was in it, so
   * from then on every web picture in the document waits (spec, Batch 18's
   * review): settings.json is written again holding only that, and it holds
   * for as long as Corillo runs even if that write fails.
   */
  private settingsOf(id: string): { settings: Record<string, unknown>; damaged: boolean } {
    let damaged = false;
    const read = this.readOwn(
      id,
      "settings.json",
      "settings",
      (raw) => {
        const data: unknown = JSON.parse(raw.toString("utf8"));
        return data && typeof data === "object" && !Array.isArray(data) ? (data as Record<string, unknown>) : null;
      },
      () => (damaged = true),
    );
    let settings = read ?? {};
    // No settings.json, but damaged ones set aside beside it: the replacement was never written (the disk full,
    // or Corillo stopped in between), so the mark holds after a restart too (the review of Batch 21, R21-4).
    if (!damaged && read === null && !this.settingsDamaged.has(id) && this.settingsSetAside(id)) this.settingsDamaged.set(id, []);
    if (damaged) {
      this.settingsDamaged.set(id, []);
      settings = { everyWebPictureWaits: { shown: [] } };
      try {
        this.writeSettings(id, settings);
      } catch (err) {
        console.error("Couldn't write a document's settings again after setting the damaged ones aside; every web picture in it waits while Corillo runs.", err);
      }
    } else if (this.settingsDamaged.has(id) && !("everyWebPictureWaits" in settings)) settings = { ...settings, everyWebPictureWaits: { shown: [...this.settingsDamaged.get(id)!] } };
    return { settings, damaged };
  }

  /** Whether damaged settings were set aside in a document's folder (settings.json.damaged-…). */
  private settingsSetAside(id: string): boolean {
    const folder = this.folder(id);
    try {
      return fs.readdirSync(folder).some((name) => name.startsWith("settings.json.damaged-"));
    } catch (err) {
      if (codeOf(err) === "ENOENT" || codeOf(err) === "ENOTDIR") return false;
      throw new RecordsUnreadable(folder, err);
    }
  }

  writeSettings(id: string, settings: Record<string, unknown>): void {
    fs.mkdirSync(this.folder(id), { recursive: true });
    writeJsonAtomic(path.join(this.folder(id), "settings.json"), settings, true);
  }

  /**
   * The web pictures an agent added that wait for the person to show them
   * (roadmap Batch 18, item 1): their addresses only, in settings.json's
   * `waitingPictures`, which an older Corillo leaves as it is. Null if
   * settings.json was damaged: which wait isn't known (the review of Batch 18,
   * R18-9). Throws if it can't be read now.
   */
  waitingPictures(id: string): string[] | null {
    const { settings, damaged } = this.settingsOf(id);
    if (damaged) return null;
    const list = settings.waitingPictures;
    return Array.isArray(list) ? list.filter((a): a is string => typeof a === "string") : [];
  }

  /** Change which web pictures wait: `wait` added, `shown` taken off. Returns the list now. */
  changeWaitingPictures(id: string, change: { wait?: string[]; shown?: string[] }): string[] {
    const settings = this.readSettings(id);
    const was = Array.isArray(settings.waitingPictures) ? settings.waitingPictures.filter((a): a is string => typeof a === "string") : [];
    const now = [...new Set([...was, ...(change.wait ?? [])])].filter((a) => !change.shown?.includes(a));
    if (now.length === was.length && now.every((a, i) => a === was[i])) return now;
    const { waitingPictures: _old, ...rest } = settings;
    this.writeSettings(id, now.length ? { ...rest, waitingPictures: now } : rest);
    return now;
  }

  /**
   * Past the cap on the list (waiting-pictures.ts), every web picture in the
   * document waits but those he showed since: `everyWebPictureWaits` in
   * settings.json, with the addresses shown. Null if it isn't so (or
   * settings.json was damaged: then waitingPictures says so).
   */
  everyWebPictureWaits(id: string): string[] | null {
    const mark = this.readSettings(id).everyWebPictureWaits;
    if (!mark || typeof mark !== "object" || Array.isArray(mark)) return null;
    const shown = (mark as { shown?: unknown }).shown;
    return Array.isArray(shown) ? shown.filter((a): a is string => typeof a === "string") : [];
  }

  /** Mark that every web picture waits but these (he showed them). Not written again when nothing changed. */
  markEveryWebPictureWaits(id: string, shown: string[]): void {
    const was = this.everyWebPictureWaits(id);
    if (was && was.length === shown.length && was.every((a, i) => a === shown[i])) return;
    if (this.settingsDamaged.has(id)) this.settingsDamaged.set(id, [...shown]); // held while Corillo runs, if the write below fails
    this.writeSettings(id, { ...this.readSettings(id), everyWebPictureWaits: { shown } });
  }

  /**
   * Where the look of the Word document a copy was made from is kept
   * (word-styles.docx; see wordStyles in word-copy.ts): in the copy's own
   * folder, so it goes with the rest of its records.
   */
  wordStylesFile(id: string): string {
    return path.join(this.folder(id), "word-styles.docx");
  }

  writeWordStyles(id: string, docx: Buffer): void {
    fs.mkdirSync(this.folder(id), { recursive: true });
    writeAtomic(this.wordStylesFile(id), docx, true);
  }
}

function writeJsonAtomic(file: string, data: unknown, flush = false): void {
  writeAtomic(file, JSON.stringify(data), flush);
}

/**
 * Write a file whole or not at all: to a temporary file, then renamed into
 * place. Flushed, the new file is on the disk before it takes the old one's
 * place, so a power cut just after leaves one or the other, never an empty
 * or cut-short file. With makeFolder, the file's folder is made first if
 * need be. The one such writer for Corillo's own files: its records here,
 * the history (version-store.ts) and unsaved edits kept for a crash
 * (recovery.ts) (Batch 18, A16-9).
 */
export function writeAtomic(file: string, data: string | Buffer, flush = false, { makeFolder = false } = {}): void {
  if (makeFolder) fs.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = `${file}.saving`;
  try {
    const fd = fs.openSync(tmp, "w");
    try {
      fs.writeFileSync(fd, data);
      if (flush) fs.fsyncSync(fd);
    } finally {
      fs.closeSync(fd);
    }
    fs.renameSync(tmp, file);
  } catch (err) {
    try {
      fs.rmSync(tmp, { force: true });
    } catch {
      // nothing more to do
    }
    throw err;
  }
}
