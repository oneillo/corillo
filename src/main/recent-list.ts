// The recent documents: File > Open Recent, the start screen's cards and the
// Dock icon's menu. Kept in memory, read from the data folder once and
// written through on each change, so building a menu never touches the disk
// (a recent document on a network drive that stopped answering would hold
// Corillo up). Which ones still exist is looked at again, without waiting on
// the disk, when Corillo comes back to the front.
import * as fs from "node:fs";
import * as path from "node:path";
import { writeAtomic } from "./store";
import { shownName } from "../core/doc-names";

export interface RecentStore {
  /** The saved list's text, or null if there's none. */
  read(): string | null;
  write(text: string): void;
  /** Whether a document is still there, without holding Corillo up. */
  exists(filePath: string): Promise<boolean>;
}

/** The list kept in a file (recent.json in the data folder). */
export function recentFile(file: () => string): RecentStore {
  return {
    read: () => {
      try {
        return fs.readFileSync(file(), "utf8");
      } catch {
        return null;
      }
    },
    write: (text) => {
      fs.mkdirSync(path.dirname(file()), { recursive: true });
      writeAtomic(file(), text);
    },
    exists: (filePath) => fs.promises.access(filePath).then(
      () => true,
      () => false,
    ),
  };
}

export interface RecentEntry {
  path: string;
  /** The name as its tab shows it, with its folder when another recent document has the same name. */
  label: string;
}

export class RecentList {
  private list: string[] | null = null;
  /** Documents found missing when last looked; left out of the menus, kept on the list in case they come back. */
  private gone = new Set<string>();

  constructor(
    private readonly store: RecentStore,
    private readonly max = 15,
  ) {}

  /** Every recent document, newest first, missing ones included (the start screen shows those, to take off the list). */
  all(): string[] {
    if (!this.list) {
      let saved: unknown = null;
      try {
        saved = JSON.parse(this.store.read() ?? "[]");
      } catch {
        // a damaged list starts again empty
      }
      this.list = Array.isArray(saved) ? saved.filter((p): p is string => typeof p === "string").slice(0, this.max) : [];
    }
    return this.list;
  }

  /**
   * The recent documents for File > Open Recent and the Dock's menu: those not known to be missing. No disk
   * work. Each is named as its tab names it, without ".md" (roadmap Batch 11, F-24), with its folder when
   * another has the same name, and with its ending too where only that tells two apart.
   */
  entries(): RecentEntry[] {
    const paths = this.all().filter((p) => !this.gone.has(p));
    const twice = (names: string[], i: number) => names.indexOf(names[i]) !== names.lastIndexOf(names[i]);
    const names = paths.map((p) => shownName(path.basename(p)));
    const withFolder = paths.map((p, i) => `${names[i]} (${path.basename(path.dirname(p))})`);
    return paths.map((p, i) => ({
      path: p,
      label: !twice(names, i) ? names[i] : !twice(withFolder, i) ? withFolder[i] : `${path.basename(p)} (${path.basename(path.dirname(p))})`,
    }));
  }

  /** A document was opened: first on the list. */
  add(filePath: string): void {
    this.gone.delete(filePath);
    this.save([filePath, ...this.all().filter((p) => p !== filePath)]);
  }

  /** A document moved: it keeps its place at the top under its new path. */
  replace(oldPath: string, newPath: string): void {
    this.gone.delete(newPath);
    this.save([newPath, ...this.all().filter((p) => p !== oldPath && p !== newPath)]);
  }

  /**
   * A closed document was found where it moved (roadmap Batch 4, item 3): it
   * keeps its place on the list under its new path, and is back in the menus.
   * Whether anything changed.
   */
  moved(oldPath: string, newPath: string): boolean {
    const list = this.all();
    const at = list.indexOf(oldPath);
    if (at < 0 || oldPath === newPath) return false;
    this.gone.delete(oldPath);
    this.gone.delete(newPath);
    this.save(list.includes(newPath) ? list.filter((p) => p !== oldPath) : list.map((p) => (p === oldPath ? newPath : p)));
    return true;
  }

  /** Taken off the list (Remove from list). */
  forget(filePath: string): void {
    this.gone.delete(filePath);
    this.save(this.all().filter((p) => p !== filePath));
  }

  /** Read the saved list again (tests change its file while Corillo runs). */
  reload(): void {
    this.list = null;
    this.gone.clear();
  }

  clear(): void {
    this.gone.clear();
    this.save([]);
  }

  /** It isn't there right now: left out of the menus until it's found again. Whether anything changed. */
  missing(filePath: string): boolean {
    if (this.gone.has(filePath)) return false;
    this.gone.add(filePath);
    return true;
  }

  /**
   * Look again which recent documents exist. Whether the menus' list changed.
   * One at a time, so a drive that stopped answering holds up only this.
   */
  async recheck(): Promise<boolean> {
    const list = [...this.all()];
    const gone = new Set<string>();
    for (const p of list) if (!(await this.store.exists(p))) gone.add(p);
    for (const p of gone) if (!this.all().includes(p)) gone.delete(p); // taken off the list meanwhile
    const changed = gone.size !== this.gone.size || [...gone].some((p) => !this.gone.has(p));
    this.gone = gone;
    return changed;
  }

  private save(list: string[]): void {
    this.list = list.slice(0, this.max);
    for (const p of this.gone) if (!this.list.includes(p)) this.gone.delete(p);
    try {
      this.store.write(JSON.stringify(this.list, null, 2));
    } catch {
      // The list is a convenience; never block opening a document over it.
    }
  }
}
