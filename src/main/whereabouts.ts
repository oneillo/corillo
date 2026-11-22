// Where a document went when it's no longer at its path: renamed or moved
// (the same file on disk, somewhere else on its drive), in the Trash, deleted,
// or on a drive or cloud folder that isn't there right now. Mac only: on
// other systems nothing is found, so a document that's gone is just gone.
//
// A file keeps its identity on disk (its number on its drive) when it's
// renamed or moved on the same drive, Finder's Trash included. The Mac can
// reach a file by that number (/.vol/<drive>/<number>), which says cheaply
// whether it still exists; its path takes one small helper run, so that's
// asked only when a document has gone, for every such document at once.
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { execFile } from "node:child_process";

export interface Identity {
  ino: number;
  dev: number;
}

const mac = process.platform === "darwin";
const byNumber = (id: Identity) => `/.vol/${id.dev}/${id.ino}`;

/** Whether a look at a file failed because there's no such file, the one failure that means it isn't there. */
const noSuchFile = (err: unknown) => {
  const code = (err as NodeJS.ErrnoException | null)?.code;
  return code === "ENOENT" || code === "ENOTDIR";
};

/**
 * Whether a file is at this path: true, false when there's no such file,
 * or null when Corillo can't look (not allowed into its folder, a disk that
 * didn't answer). Can't look isn't gone: it's out of reach, as on a drive
 * that's away.
 */
export function thereNow(filePath: string): boolean | null {
  try {
    fs.statSync(filePath);
    return true;
  } catch (err) {
    return noSuchFile(err) ? false : null;
  }
}

/**
 * Whether the file is still somewhere on its drive: true, false, or null
 * when Corillo can't tell (a drive that can't be asked this way, such as a
 * USB stick or a network share; or no identity known).
 */
export function stillOnDisk(id: Identity, near: string): boolean | null {
  if (!mac || id.ino < 0) return null;
  try {
    return fs.statSync(byNumber(id)).isFile();
  } catch (err) {
    // Gone, or a drive that can't be asked: ask the same way about the
    // nearest folder above it that's still there, on the same drive. On a
    // drive that answers, only "no such file" is gone: a file the Mac won't
    // let Corillo look at is still there.
    const refused = !noSuchFile(err);
    for (let dir = path.dirname(near); ; dir = path.dirname(dir)) {
      try {
        const folder = fs.statSync(dir);
        if (folder.dev !== id.dev) return null;
        fs.statSync(byNumber({ ino: folder.ino, dev: folder.dev }));
        return refused;
      } catch {
        if (dir === path.dirname(dir)) return null;
      }
    }
  }
}

// Asks the Mac for each file's path by its identity, all in one run.
const LOOKUP = `function run(argv) {
  ObjC.import("Foundation");
  return JSON.stringify(argv.map(function (p) {
    var ref = $.NSURL.fileURLWithPath(p).fileReferenceURL;
    if (!ref || ref.isNil()) return null;
    var real = ref.filePathURL;
    return !real || real.isNil() ? null : ObjC.unwrap(real.path);
  }));
}`;

/** Where each file is now, by its identity on disk (null where it can't be found). */
export function whereNow(ids: Identity[]): Promise<(string | null)[]> {
  if (!mac || !ids.length) return Promise.resolve(ids.map(() => null));
  return new Promise((resolve) => {
    execFile(
      "/usr/bin/osascript",
      ["-l", "JavaScript", "-e", LOOKUP, ...ids.map(byNumber)],
      { timeout: 10_000, encoding: "utf8" },
      (err, out) => {
        let found: unknown = null;
        try {
          found = err ? null : JSON.parse(out);
        } catch {
          // nothing usable
        }
        resolve(ids.map((_, i) => (Array.isArray(found) && typeof found[i] === "string" ? (found[i] as string) : null)));
      },
    );
  });
}

/** Where each closed document was last found by its identity (by its old path), so one that stays there isn't asked about again. */
const lastFound = new Map<string, { at: string; ino: number; dev: number }>();
const LAST_FOUND_KEPT = 50;

/**
 * Where closed documents that aren't at their paths went (the start screen's
 * missing cards and Open Recent, roadmap Batch 4, item 3): renamed or moved
 * on their drive, found by their identity on disk, all in one helper run.
 * Null for one that's gone, on a drive that can't be asked, in a Trash, or
 * put away by a program into a hidden or temporary folder: deleted, as far
 * as the person can see, as for an open document. One found before and still
 * there (in the Trash, say) isn't asked about again.
 */
export async function movedTo(items: { was: string; id: Identity }[]): Promise<(string | null)[]> {
  const went: (string | null | undefined)[] = items.map(({ was, id }) => {
    if (stillOnDisk(id, was) !== true) return null;
    const seen = lastFound.get(was);
    if (seen && seen.ino === id.ino && seen.dev === id.dev) {
      try {
        const s = fs.statSync(seen.at);
        if (s.ino === id.ino && s.dev === id.dev) return seen.at;
      } catch {
        // moved on since: ask again
      }
    }
    return undefined;
  });
  const asking = items.flatMap((item, i) => (went[i] === undefined ? [{ item, i }] : []));
  if (asking.length) {
    const found = await whereNow(asking.map(({ item }) => item.id));
    asking.forEach(({ item, i }, k) => {
      went[i] = found[k];
      if (!found[k]) return;
      lastFound.delete(item.was);
      lastFound.set(item.was, { at: found[k]!, ino: item.id.ino, dev: item.id.dev });
      if (lastFound.size > LAST_FOUND_KEPT) lastFound.delete(lastFound.keys().next().value!);
    });
  }
  return items.map(({ was }, i) => {
    const to = went[i];
    return to && to !== was && !inTrash(to) && !putAway(to, was) ? to : null;
  });
}

/** Whether a path is in a Trash: the Mac's own (~/.Trash), a drive's (.Trashes), or iCloud Drive's. */
export function inTrash(filePath: string): boolean {
  return filePath.split(path.sep).some((part) => part === ".Trash" || part === ".Trashes");
}

/** The Mac's temporary folders, by both their names (/tmp is /private/tmp). */
const TEMPORARY = ["/tmp", "/private/tmp", "/var/folders", "/private/var/folders"];

const within = (dir: string, root: string) => dir === root || dir.startsWith(root + path.sep);

/**
 * Whether a file that went from `was` to `went` was put away by a program
 * rather than moved by the person: into a hidden folder (a sync tool's cache
 * of deleted files, such as .dropbox.cache), a temporary-items folder, or the
 * Mac's temporary folders, none of which its old place was in. Such a file is
 * gone as far as the person can see, so the tab isn't moved there with it.
 */
export function putAway(went: string, was: string): boolean {
  const from = path.dirname(was).split(path.sep);
  const to = path.dirname(went).split(path.sep);
  let same = 0;
  while (same < from.length && same < to.length && from[same] === to[same]) same++;
  if (to.slice(same).some((part) => part.startsWith(".") || part === "TemporaryItems")) return true;
  return TEMPORARY.some((root) => within(path.dirname(went), root) && !within(path.dirname(was), root));
}

/** Places whose folders come and go: drives, and the cloud folders (OneDrive, Dropbox, iCloud Drive). */
export function changingPlaces(home = os.homedir()): string[] {
  return ["/Volumes", path.join(home, "Library", "CloudStorage"), path.join(home, "Library", "Mobile Documents")];
}

/**
 * Whether the drive or cloud folder a path is on is there now. A document
 * on one that isn't (a drive not plugged in, a cloud folder not set up)
 * isn't gone, just out of reach.
 */
export function placeAvailable(filePath: string, places: string[]): boolean {
  for (const place of places) {
    const rel = path.relative(place, filePath);
    if (!rel || rel.startsWith("..") || path.isAbsolute(rel)) continue;
    const top = rel.split(path.sep)[0];
    return fs.existsSync(path.join(place, top));
  }
  return true;
}
