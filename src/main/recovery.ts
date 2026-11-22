// Edits that couldn't be saved yet (the file changed outside Corillo, went
// missing, or the disk refused), kept in Corillo's data folder so a crash
// or a forced quit doesn't lose them. Whatever is still here when Corillo
// next opens is offered back.
//
// Ordinary typing isn't copied here: it's saved to the document itself
// moments later, which is the better copy to have.
import * as fs from "node:fs";
import * as path from "node:path";
import { writeAtomic } from "./store";

export interface Recovered {
  /** Where the document was. */
  filePath: string;
  /** The document's text on disk when the edits were kept. */
  base: string;
  /** The text in the editor, not yet saved. */
  text: string;
}

export class RecoveryStore {
  private dir: string;

  constructor(dataFolder: string) {
    this.dir = path.join(dataFolder, "recovery");
  }

  private file(id: string): string {
    return path.join(this.dir, `${id}.json`);
  }

  /** Keep unsaved edits for a document (by its id in the data folder). False if that failed too. */
  keep(id: string, entry: Recovered): boolean {
    try {
      // Flushed before it replaces the earlier copy: these are kept for a crash, so they must be on the disk.
      writeAtomic(this.file(id), JSON.stringify(entry), true, { makeFolder: true });
      return true;
    } catch {
      return false;
    }
  }

  clear(id: string): void {
    fs.rmSync(this.file(id), { force: true });
  }

  /** Everything kept and not cleared, oldest first. */
  all(): { id: string; entry: Recovered }[] {
    let names: string[];
    try {
      names = fs.readdirSync(this.dir).filter((n) => n.endsWith(".json"));
    } catch {
      return [];
    }
    const found: { id: string; entry: Recovered; at: number }[] = [];
    for (const name of names) {
      const file = path.join(this.dir, name);
      try {
        const entry = JSON.parse(fs.readFileSync(file, "utf8")) as Recovered;
        if (typeof entry.filePath === "string" && typeof entry.text === "string" && typeof entry.base === "string") {
          found.push({ id: name.slice(0, -".json".length), entry, at: fs.statSync(file).mtimeMs });
        }
      } catch {
        // unreadable: leave it for a person to look at
      }
    }
    return found.sort((a, b) => a.at - b.at).map(({ id, entry }) => ({ id, entry }));
  }
}
