// The document on disk (src/main/doc-on-disk.ts), over a throwaway folder and
// without Electron: a save writes the file and notes it, a file changed or gone
// meanwhile is never written over or made again, the window's answer to an
// outside change is taken only while it's still true, and an agent's write
// makes the web pictures it added wait, and still stands if noting them fails.
import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, renameSync, rmSync, statSync, unlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

// The module runs without Electron: reaching for it fails the import.
vi.mock("electron", () => {
  throw new Error("doc-on-disk.ts reached for Electron");
});

const disk = await import("../../src/main/doc-on-disk");
const { writeSeams } = await import("../../src/main/files");
const { RecoveryStore } = await import("../../src/main/recovery");
type OpenDoc = import("../../src/main/doc-on-disk").OpenDoc;

const root = mkdtempSync(join(tmpdir(), "corillo-disk-"));
afterAll(() => rmSync(root, { recursive: true, force: true }));

let folder = "";
let n = 0;
let sent: [string, ...unknown[]][] = [];
let notices: string[] = [];
let records: string[] = [];
let history: string[] = [];
let waited: { storeId: string; wait?: string[] }[] = [];
/** What was held as waiting through the app's own list (keepWaiting), when noting through picturesWait failed. */
let held: { storeId: string; wait?: string[] }[] = [];
/** Records marked "every web picture waits" straight in the records (a made document whose text couldn't be read). */
let marked: { storeId: string; shown: string[] }[] = [];
/** What the recent list was told: from, to. */
let recentMoves: [string, string][] = [];
let recovery: InstanceType<typeof RecoveryStore>;
let docs: Map<string, OpenDoc>;
const parts = { failRecords: false, failPictures: false, failHold: false, failIdFor: false, failIndex: false };

beforeEach(() => {
  folder = join(root, `case-${++n}`);
  mkdirSync(folder);
  sent = [];
  notices = [];
  records = [];
  history = [];
  waited = [];
  held = [];
  marked = [];
  recentMoves = [];
  parts.failRecords = false;
  parts.failIndex = false;
  parts.failPictures = false;
  parts.failHold = false;
  parts.failIdFor = false;
  docs = new Map();
  recovery = new RecoveryStore(join(folder, "data"));
  const note = (what: string) => {
    if (parts.failRecords) throw Object.assign(new Error("full"), { code: "ENOSPC" });
    records.push(what);
  };
  disk.setUpDisk({
    docs,
    send: (channel, ...args) => sent.push([channel, ...args]),
    notice: (text) => notices.push(text),
    store: {
      idFor: (filePath: string) => {
        if (parts.failIdFor || parts.failIndex) throw new Error("the records index can't be read");
        return `id-of-${filePath}`;
      },
      created: (filePath: string) => {
        if (parts.failIndex) throw new Error("the records index can't be read");
        note(`created ${filePath}`);
      },
      markEveryWebPictureWaits: (storeId: string, shown: string[]) => {
        if (parts.failHold) throw Object.assign(new Error("full"), { code: "ENOSPC" });
        marked.push({ storeId, shown });
      },
      saved: (storeId: string, _filePath: string, text: string) => note(`saved ${storeId}: ${text}`),
      moved: (storeId: string, to: string) => note(`moved ${storeId} to ${to}`),
      noticedMissing: (storeId: string) => note(`missing ${storeId}`),
    } as never,
    recovery,
    historyHooks: {
      saved: (storeId, text) => history.push(`saved ${storeId}: ${text}`),
      overwriting: (filePath, lastKnown) => history.push(`overwriting ${filePath}, last known: ${lastKnown}`),
      outside: (filePath, text) => history.push(`outside ${filePath}: ${text}`),
    },
    replaceRecent: (from, to) => recentMoves.push([from, to]),
    picturesWait: (storeId, change) => {
      if (parts.failPictures) throw new Error("the records can't be read");
      waited.push({ storeId, wait: change.wait });
    },
    keepWaiting: (storeId, wait) => {
      if (parts.failHold) throw new Error("the records can't be read");
      held.push({ storeId, wait });
    },
  });
});

afterEach(() => {
  writeSeams.afterTemp = null;
  writeSeams.afterSwap = null;
  for (const doc of docs.values()) disk.letGo(doc);
});

/** A document on disk with this text, open in a tab. */
function openDoc(text: string, name = "plan.md"): OpenDoc {
  const filePath = join(folder, name);
  writeFileSync(filePath, text);
  const doc: OpenDoc = { id: `tab-${n}-${name}`, storeId: `store-${n}-${name}`, filePath, diskText: text };
  docs.set(doc.id, doc);
  return doc;
}

const onDisk = (doc: OpenDoc) => readFileSync(doc.filePath, "utf8");

describe("saving the document", () => {
  it("writes the text, notes it in the records and the history, and lets go of edits kept for recovery", () => {
    const doc = openDoc("First draft.\n");
    recovery.keep(doc.storeId, { filePath: doc.filePath, base: doc.diskText, text: "Second draft.\n" });
    expect(disk.saveDoc(doc, "Second draft.\n", false)).toEqual({ ok: true });
    expect(onDisk(doc)).toBe("Second draft.\n");
    expect(doc.diskText).toBe("Second draft.\n");
    expect(doc.identity?.ino).toBeGreaterThan(0);
    expect(records).toEqual([`saved ${doc.storeId}: Second draft.\n`]);
    expect(history).toEqual([`saved ${doc.storeId}: Second draft.\n`]);
    expect(recovery.all()).toEqual([]);
  });

  it("never writes over a change made outside Corillo: the tab is given the text on disk", () => {
    const doc = openDoc("Ours.\n");
    writeFileSync(doc.filePath, "Another app's.\n");
    expect(disk.saveDoc(doc, "Ours, edited.\n", false)).toEqual({ ok: false, diskText: "Another app's.\n" });
    expect(onDisk(doc)).toBe("Another app's.\n");
    expect(doc.diskText).toBe("Ours.\n");
    expect(records).toEqual([]);
    expect(history).toEqual([]);
  });

  it("writes over it when the person chooses, keeping the other text in the history", () => {
    const doc = openDoc("Ours.\n");
    writeFileSync(doc.filePath, "Another app's.\n");
    expect(disk.saveDoc(doc, "Ours, edited.\n", true)).toEqual({ ok: true });
    expect(onDisk(doc)).toBe("Ours, edited.\n");
    expect(history).toEqual([`overwriting ${doc.filePath}, last known: Ours.\n`, `saved ${doc.storeId}: Ours, edited.\n`]);
  });

  it("never makes a file again that went: it goes looking for it, then says it's missing", () => {
    const doc = openDoc("Text.\n");
    unlinkSync(doc.filePath);
    expect(disk.saveDoc(doc, "Text, edited.\n", false)).toEqual({ ok: false, problem: "the file isn't where it was" });
    expect(doc.looking).toBeDefined(); // finding out where it went, a moment from now
    expect(existsSync(doc.filePath)).toBe(false);
    clearTimeout(doc.looking as NodeJS.Timeout);
    doc.looking = undefined;
    doc.missing = true;
    expect(disk.saveDoc(doc, "Text, edited.\n", false)).toEqual({ ok: false, missing: true });
    expect(existsSync(doc.filePath)).toBe(false);
  });

  it("looks again when another app saves in the moment before the swap, and never writes over it", () => {
    const doc = openDoc("Ours.\n");
    writeSeams.afterTemp = () => {
      writeSeams.afterTemp = null;
      writeFileSync(doc.filePath, "Another app's, just now.\n");
    };
    expect(disk.saveDoc(doc, "Ours, edited.\n", false)).toEqual({ ok: false, diskText: "Another app's, just now.\n" });
    expect(onDisk(doc)).toBe("Another app's, just now.\n");
    expect(readdirLeftovers()).toEqual([]);
  });

  it("says what the file holds when it changed again straight after the save", () => {
    const doc = openDoc("Ours.\n");
    writeSeams.afterSwap = (target) => writeFileSync(target, "A cloud folder's copy.\n");
    expect(disk.saveDoc(doc, "Ours, edited.\n", false)).toEqual({ ok: true, changedAfter: "A cloud folder's copy.\n" });
    expect(doc.diskText).toBe("Ours, edited.\n");
  });

  it("is saved even when Corillo's records can't be updated, and says so once", () => {
    const doc = openDoc("Text.\n");
    parts.failRecords = true;
    expect(disk.saveDoc(doc, "Text, once.\n", false)).toEqual({ ok: true });
    expect(disk.saveDoc(doc, "Text, twice.\n", false)).toEqual({ ok: true });
    expect(onDisk(doc)).toBe("Text, twice.\n");
    expect(notices).toEqual(["plan is saved, but Corillo couldn't update what it keeps beside it."]);
  });
});

// S21-47: the steps of a move, in one place, for Rename or Move, Save somewhere
// else and a move made outside Corillo.
describe("the document living at a new path", () => {
  it("after Rename or Move: its former path, path, records, identity, watcher and recent list follow, and `missing` stays as it was", () => {
    const doc = openDoc("Text.\n");
    disk.watchFile(doc);
    const watcher = doc.watcher;
    doc.missing = true;
    const from = doc.filePath;
    const to = join(folder, "renamed.md");
    renameSync(from, to);
    expect(disk.nowAt(doc, to, { former: true, found: false })).toBe(true);
    expect(doc.filePath).toBe(to);
    expect([...(doc.formerPaths ?? [])]).toEqual([from]);
    expect(records).toEqual([`moved ${doc.storeId} to ${to}`]);
    expect(doc.identity).toEqual({ ino: statSync(to).ino, dev: statSync(to).dev });
    expect(doc.watcher).toBeDefined();
    expect(doc.watcher).not.toBe(watcher);
    expect(recentMoves).toEqual([[from, to]]);
    expect(doc.missing).toBe(true);
    expect(doc.diskText).toBe("Text.\n");
  });

  it("after Save somewhere else: the text written is the text on disk, noted as saved there, `missing` cleared, no former path when not asked", () => {
    const doc = openDoc("Old text.\n");
    doc.missing = true;
    const from = doc.filePath;
    const to = join(folder, "copy.md");
    writeFileSync(to, "New text.\n");
    expect(disk.nowAt(doc, to, { former: false, found: true, text: "New text.\n" })).toBe(true);
    expect(doc.filePath).toBe(to);
    expect(doc.diskText).toBe("New text.\n");
    expect(doc.missing).toBe(false);
    expect(doc.formerPaths).toBeUndefined();
    expect(records).toEqual([`saved ${doc.storeId}: New text.\n`]);
    expect(doc.identity).toEqual({ ino: statSync(to).ino, dev: statSync(to).dev });
    expect(recentMoves).toEqual([[from, to]]);
  });

  it("still moves when Corillo's records can't be updated, says so once, and returns that they weren't kept", () => {
    const doc = openDoc("Text.\n");
    const to = join(folder, "elsewhere.md");
    renameSync(doc.filePath, to);
    parts.failRecords = true;
    expect(disk.nowAt(doc, to, { former: true, found: false })).toBe(false);
    expect(doc.filePath).toBe(to);
    expect(notices).toHaveLength(1);
    expect(recentMoves).toHaveLength(1);
  });
});

describe("the window taking in an outside change", () => {
  it("is noted while the file still holds it", () => {
    const doc = openDoc("Before.\n");
    writeFileSync(doc.filePath, "After.\n");
    disk.acceptDisk(doc, "After.\n");
    expect(doc.diskText).toBe("After.\n");
    expect(records).toEqual([`saved ${doc.storeId}: After.\n`]);
    expect(history).toEqual([`outside ${doc.filePath}: After.\n`]);
  });

  it("is let go when the file has changed again since", () => {
    const doc = openDoc("Before.\n");
    writeFileSync(doc.filePath, "Later still.\n");
    disk.acceptDisk(doc, "After.\n");
    expect(doc.diskText).toBe("Before.\n");
    expect(records).toEqual([]);
    expect(history).toEqual([]);
  });
});

describe("an agent's write", () => {
  const picture = "![Chart](https://example.com/chart.png)";

  it("writes the file, and the web pictures it added wait", () => {
    const doc = openDoc("Intro.\n");
    expect(disk.forAgents.writeFileAtomic(doc.filePath, `Intro.\n\n${picture}\n`, undefined)).toBeNull();
    expect(onDisk(doc)).toBe(`Intro.\n\n${picture}\n`);
    expect(waited).toEqual([{ storeId: doc.storeId, wait: ["https://example.com/chart.png"] }]);
  });

  it("still stands when noting its pictures fails: the file holds the agent's text and the write goes on", () => {
    const doc = openDoc("Intro.\n");
    parts.failPictures = true;
    const error = vi.spyOn(console, "error").mockImplementation(() => {});
    try {
      expect(disk.forAgents.writeFileAtomic(doc.filePath, `Intro.\n\n${picture}\n`, undefined)).toBeNull();
    } finally {
      error.mockRestore();
    }
    expect(onDisk(doc)).toBe(`Intro.\n\n${picture}\n`);
    expect(waited).toEqual([]);
  });

  // The review of Batch 19, R19-6: noting them failed, so every web picture in the text it wrote waits.
  const mine = "![Mine](https://example.com/mine.png)";
  const every = ["https://example.com/mine.png", "https://example.com/chart.png"];

  it("when noting its pictures fails, the window is told every web picture in the text waits, and the records keep them", () => {
    const doc = openDoc(`Intro.\n\n${mine}\n`);
    parts.failPictures = true;
    const error = vi.spyOn(console, "error").mockImplementation(() => {});
    try {
      expect(disk.forAgents.writeFileAtomic(doc.filePath, `Intro.\n\n${mine}\n\n${picture}\n`, undefined)).toBeNull();
    } finally {
      error.mockRestore();
    }
    expect(onDisk(doc)).toBe(`Intro.\n\n${mine}\n\n${picture}\n`);
    expect(sent).toEqual([["pictures:waiting", doc.id, { wait: every, shown: [] }]]);
    expect(held).toEqual([{ storeId: doc.storeId, wait: every }]);
  });

  it("when keeping them fails too, the window is still told, and the write stands", () => {
    const doc = openDoc("Intro.\n");
    parts.failPictures = true;
    parts.failHold = true;
    const error = vi.spyOn(console, "error").mockImplementation(() => {});
    try {
      expect(disk.forAgents.writeFileAtomic(doc.filePath, `Intro.\n\n${picture}\n`, undefined)).toBeNull();
    } finally {
      error.mockRestore();
    }
    expect(onDisk(doc)).toBe(`Intro.\n\n${picture}\n`);
    expect(sent).toEqual([["pictures:waiting", doc.id, { wait: ["https://example.com/chart.png"], shown: [] }]]);
    expect(held).toEqual([]);
  });

  it("when noting a made document's pictures fails, every web picture in it is kept as waiting, and a tab open on it is told", () => {
    const filePath = join(folder, "new.md");
    writeFileSync(filePath, `${mine}\n\n${picture}\n`);
    const tab: OpenDoc = { id: `tab-${n}-new`, storeId: `id-of-${filePath}`, filePath, diskText: "" };
    docs.set(tab.id, tab);
    parts.failPictures = true;
    const error = vi.spyOn(console, "error").mockImplementation(() => {});
    try {
      disk.forAgents.created(filePath);
    } finally {
      error.mockRestore();
    }
    expect(records).toEqual([`created ${filePath}`]);
    expect(sent).toEqual([["pictures:waiting", tab.id, { wait: every, shown: [] }]]);
    expect(held).toEqual([{ storeId: `id-of-${filePath}`, wait: every }]);
  });

  it("a made document whose records can't be found at all still stands, with a line in the log", () => {
    const filePath = join(folder, "new.md");
    writeFileSync(filePath, `${picture}\n`);
    parts.failIdFor = true;
    const error = vi.spyOn(console, "error").mockImplementation(() => {});
    try {
      expect(() => disk.forAgents.created(filePath)).not.toThrow();
      expect(error).toHaveBeenCalled();
    } finally {
      error.mockRestore();
    }
    expect(held).toEqual([]);
    expect(sent).toEqual([]);
  });

  // The review of Batch 20, R20-3: what can really fail for a made document.
  it("a made document whose text can't be read back (not allowed, say): every web picture in it waits", () => {
    const filePath = join(folder, "new.md");
    writeFileSync(filePath, `${picture}\n`);
    chmodSync(filePath, 0o000); // readText fails for real: EACCES
    const error = vi.spyOn(console, "error").mockImplementation(() => {});
    try {
      expect(() => disk.forAgents.created(filePath)).not.toThrow();
    } finally {
      error.mockRestore();
      chmodSync(filePath, 0o644);
    }
    expect(records).toEqual([`created ${filePath}`]);
    expect(waited).toEqual([]);
    expect(marked).toEqual([{ storeId: `id-of-${filePath}`, shown: [] }]);
  });

  it("a made document whose records index can't be read: the file stands, with a line in the log, and nothing goes on to the agent's call", () => {
    const filePath = join(folder, "new.md");
    writeFileSync(filePath, `${picture}\n`);
    parts.failIndex = true;
    const error = vi.spyOn(console, "error").mockImplementation(() => {});
    try {
      expect(() => disk.forAgents.created(filePath)).not.toThrow();
      expect(error).toHaveBeenCalled();
    } finally {
      error.mockRestore();
    }
    expect(readFileSync(filePath, "utf8")).toBe(`${picture}\n`);
    expect(marked).toEqual([]);
    expect(held).toEqual([]);
  });

  it("makes every web picture wait in a document an agent made", () => {
    const filePath = join(folder, "new.md");
    writeFileSync(filePath, `${picture}\n`);
    disk.forAgents.created(filePath);
    expect(records).toEqual([`created ${filePath}`]);
    expect(waited).toEqual([{ storeId: `id-of-${filePath}`, wait: ["https://example.com/chart.png"] }]);
  });

  it("is noted as saved, as the agent's, in the records and the history", () => {
    const doc = openDoc("Intro.\n");
    writeFileSync(doc.filePath, "Agent's text.\n");
    doc.diskText = "Agent's text.\n";
    disk.forAgents.saved(doc);
    expect(records).toEqual([`saved ${doc.storeId}: Agent's text.\n`]);
    expect(history).toEqual([`saved ${doc.storeId}: Agent's text.\n`]);
  });
});

/** Temporary files a save may have left beside the documents. */
function readdirLeftovers(): string[] {
  return readdirSync(folder).filter((f) => f !== "plan.md" && f !== "data");
}

// The review of Batch 20, R20-4: the way round, when noting an agent's pictures
// the usual way fails, goes through the app's own list of waiting pictures, so
// the request guard knows the addresses at once, and what can't be kept with
// the records is still held while the app runs.
describe("an agent's write, when noting its pictures fails, through the app's own list", () => {
  const CHART = "https://Host.test/x.png";

  /** Over real records and the app's list; settings.json can be made unwritable (a full disk). */
  async function withRealRecords() {
    const { VersionHistory } = await import("../../src/main/version-store");
    const { WaitingPictures } = await import("../../src/main/waiting-pictures");
    class Records extends VersionHistory {
      full = false;
      override writeSettings(id: string, settings: Record<string, unknown>): void {
        if (this.full) throw Object.assign(new Error("full"), { code: "ENOSPC" });
        super.writeSettings(id, settings);
      }
    }
    const store = new Records(join(folder, "data"));
    const filePath = join(folder, "plan.md");
    writeFileSync(filePath, "Intro.\n");
    const doc: OpenDoc = { id: `tab-${n}`, storeId: store.idFor(filePath, "Intro.\n"), filePath, diskText: "Intro.\n" };
    docs.set(doc.id, doc);
    const waiting = new WaitingPictures(store, () => [...docs.values()].map((d) => d.storeId));
    waiting.of(doc.storeId, doc.diskText); // as the tab opened
    disk.setUpDisk({
      docs,
      send: (channel, ...args) => sent.push([channel, ...args]),
      notice: (text) => notices.push(text),
      store,
      recovery,
      historyHooks: { saved: () => {}, overwriting: () => {}, outside: () => {} },
      replaceRecent: (from, to) => recentMoves.push([from, to]),
      picturesWait: () => {
        throw new Error("the window couldn't be told"); // what can throw there: waiting.change catches its own storage errors
      },
      keepWaiting: (storeId, wait) => waiting.change(storeId, { wait }),
    });
    return { store, waiting, doc };
  }

  it("the guard knows the addresses at once, however they're written", async () => {
    const { waiting, doc } = await withRealRecords();
    const error = vi.spyOn(console, "error").mockImplementation(() => {});
    try {
      disk.forAgents.writeFileAtomic(doc.filePath, `Intro.\n\n![Chart](${CHART})\n`, undefined);
    } finally {
      error.mockRestore();
    }
    expect(sent).toEqual([["pictures:waiting", doc.id, { wait: [CHART], shown: [] }]]);
    expect(waiting.blocks(CHART)).toBe(true);
    expect(waiting.blocks("https:host.test/x.png")).toBe(true);
  });

  it("with records that can't be written, the addresses are still held while the app runs", async () => {
    const { store, waiting, doc } = await withRealRecords();
    store.full = true;
    const text = `Intro.\n\n![Chart](${CHART})\n`;
    const error = vi.spyOn(console, "error").mockImplementation(() => {});
    try {
      disk.forAgents.writeFileAtomic(doc.filePath, text, undefined);
      expect(waiting.of(doc.storeId, text)).toEqual([CHART]);
    } finally {
      error.mockRestore();
    }
    expect(waiting.blocks(CHART)).toBe(true);
  });
});
