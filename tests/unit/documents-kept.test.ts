// What Corillo keeps beside a document (comments, history, settings) stays
// with it when the file is renamed or moved while Corillo is closed, and is
// cleared once the file has been gone for 30 days. Run on the real disk, in
// throwaway folders; the Trash is a pretend one (a folder named .Trash), and
// a drive that comes and goes is a folder the test adds and takes away.
import { describe, expect, it } from "vitest";
import {
  chmodSync, copyFileSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, realpathSync, renameSync, rmSync, statSync,
  symlinkSync, unlinkSync, writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { VersionHistory } from "../../src/main/version-store";
import { putAway, stillOnDisk } from "../../src/main/whereabouts";
import { addThread, type Author } from "../../src/core/comments";
import { CommentService } from "../../src/main/comment-service";
import { countFlushes } from "./flushes";

const me: Author = { kind: "person" };
const DAY = 24 * 60 * 60 * 1000;
const TEXT = "# Plan\n\nA plan with enough words to know it by.\n";

/** A throwaway data folder and document, Corillo's records of it, and a clock the test moves by hand. */
function setup(options: { text?: string; drives?: string[] } = {}) {
  const text = options.text ?? TEXT;
  const data = mkdtempSync(join(tmpdir(), "corillo-kept-"));
  const docs = realpathSync(mkdtempSync(join(tmpdir(), "corillo-docs-")));
  const file = join(docs, "plan.md");
  writeFileSync(file, text);
  let time = new Date("2026-11-09T10:00:00Z").getTime();
  const clock = () => new Date(time);
  const make = () => new VersionHistory(data, clock, { drives: options.drives });
  const h = make();
  const id = h.idFor(file, text);
  h.seen(id, text);
  h.saved(id, file, text);
  h.writeComments(id, addThread([], me, "Is two enough?", null, null).threads);
  h.writeSettings(id, { style: "corillo" });
  const later = (days: number) => {
    time += days * DAY;
  };
  const kept = () => existsSync(join(data, "documents", id));
  const index = () => JSON.parse(readFileSync(join(data, "documents.json"), "utf8")) as Record<string, { path: string }>;
  return { h, id, data, docs, file, text, later, kept, index, make, clock };
}

describe("comments and history follow a document renamed or moved while Corillo was closed", () => {
  it("renamed in its folder, or moved to another folder (Finder, mv, git mv), it's found by its identity on disk", () => {
    const { id, docs, file, make } = setup();
    const renamed = join(docs, "plan final.md");
    renameSync(file, renamed);
    expect(make().idFor(renamed)).toBe(id);
    mkdirSync(join(docs, "Archive"));
    const moved = join(docs, "Archive", "plan final.md");
    renameSync(renamed, moved);
    const again = make();
    expect(again.idFor(moved)).toBe(id);
    expect(again.readComments(id)[0].messages[0].body).toBe("Is two enough?");
  });

  it("moved to another drive (the file there is new to the disk), it's found by its text matching what Corillo last saved, once the old file is gone", () => {
    const { id, file, text, make } = setup();
    const other = mkdtempSync(join(tmpdir(), "corillo-other-drive-"));
    const moved = join(other, "plan.md");
    copyFileSync(file, moved);
    unlinkSync(file);
    expect(make().idFor(moved, text)).toBe(id);
  });

  it("a copy opened while the original is still in its place is a new document", () => {
    const { id, docs, file, text, make } = setup();
    const copy = join(docs, "plan copy.md");
    copyFileSync(file, copy);
    expect(make().idFor(copy, text)).not.toBe(id);
  });

  it("text alone never matches an empty document, a file with another name, or text that two gone documents share", () => {
    const empty = setup({ text: "" });
    const other = mkdtempSync(join(tmpdir(), "corillo-other-drive-"));
    copyFileSync(empty.file, join(other, "plan.md"));
    unlinkSync(empty.file);
    expect(empty.make().idFor(join(other, "plan.md"), "")).not.toBe(empty.id);

    // A new document from the same template as one deleted, under another name: a new document.
    const a = setup();
    unlinkSync(a.file);
    const fromTemplate = join(other, "plan for May.md");
    writeFileSync(fromTemplate, a.text);
    expect(a.make().idFor(fromTemplate, a.text)).not.toBe(a.id);

    // Two gone documents of the same name and text: which one is this? Neither, to be safe.
    const b = setup();
    mkdirSync(join(b.docs, "Copy"));
    const twin = join(b.docs, "Copy", "plan.md");
    writeFileSync(twin, b.text);
    const twinId = b.h.idFor(twin, b.text);
    unlinkSync(b.file);
    unlinkSync(twin);
    const elsewhere = join(mkdtempSync(join(tmpdir(), "corillo-other-drive-")), "plan.md");
    writeFileSync(elsewhere, b.text);
    const found = b.make().idFor(elsewhere, b.text);
    expect(found).not.toBe(b.id);
    expect(found).not.toBe(twinId);
  });
});

describe("a document gone for 30 days has its comments, history and record cleared", () => {
  it("its file not at its place and not found moved for 30 days: comments, history, settings and record are removed, not before", async () => {
    const { h, id, file, later, kept, index } = setup();
    unlinkSync(file);
    await h.sweep(new Set());
    expect(kept()).toBe(true);
    later(29);
    await h.sweep(new Set());
    expect(kept()).toBe(true);
    later(1.5);
    await h.sweep(new Set());
    expect(kept()).toBe(false);
    expect(Object.keys(index())).not.toContain(id);
    expect(h.list(id)).toEqual([]);
  });

  it("the Word document's look kept for a copy made from it goes with the rest (B5-02)", async () => {
    const { h, id, file, later, kept } = setup();
    h.writeWordStyles(id, Buffer.from("the look"));
    expect(readFileSync(h.wordStylesFile(id), "utf8")).toBe("the look");
    unlinkSync(file);
    await h.sweep(new Set());
    later(31);
    await h.sweep(new Set());
    expect(kept()).toBe(false);
    expect(existsSync(h.wordStylesFile(id))).toBe(false);
  });

  it("the 30 days count from when Corillo first noticed it gone, not from when it was last saved", async () => {
    const { h, file, later, kept } = setup();
    unlinkSync(file);
    later(20); // Corillo wasn't open meanwhile
    await h.sweep(new Set());
    later(25);
    await h.sweep(new Set());
    expect(kept()).toBe(true);
    later(6);
    await h.sweep(new Set());
    expect(kept()).toBe(false);
  });

  it("a document that comes back before the 30 days keeps everything, and the count starts again if it goes again", async () => {
    const { h, file, text, later, kept } = setup();
    unlinkSync(file);
    await h.sweep(new Set());
    later(20);
    writeFileSync(file, text); // back in its place (from a backup, say)
    await h.sweep(new Set());
    later(20);
    await h.sweep(new Set());
    expect(kept()).toBe(true);
    unlinkSync(file);
    await h.sweep(new Set());
    later(25);
    await h.sweep(new Set());
    expect(kept()).toBe(true);
    later(6);
    await h.sweep(new Set());
    expect(kept()).toBe(false);
  });

  it("the Trash counts as gone: its 30 days run while it sits there, and put back in time it keeps everything", async () => {
    const { h, id, docs, file, later, kept, make } = setup();
    const trash = join(docs, ".Trash");
    mkdirSync(trash);
    renameSync(file, join(trash, "plan.md"));
    await h.sweep(new Set());
    later(29);
    await h.sweep(new Set());
    expect(kept()).toBe(true);
    renameSync(join(trash, "plan.md"), file); // Put Back
    await h.sweep(new Set());
    later(40);
    await h.sweep(new Set());
    expect(kept()).toBe(true);
    expect(make().idFor(file)).toBe(id);
    // In the Trash again, and left there.
    renameSync(file, join(trash, "plan.md"));
    await h.sweep(new Set());
    later(31);
    await h.sweep(new Set());
    expect(kept()).toBe(false);
  });

  it("a document moved elsewhere while Corillo was closed isn't gone, however long it's been, and is found where it went", async () => {
    const { h, id, docs, file, later, kept, index, make } = setup();
    mkdirSync(join(docs, "Archive"));
    const moved = join(docs, "Archive", "plan.md");
    renameSync(file, moved);
    await h.sweep(new Set());
    later(90);
    await h.sweep(new Set());
    expect(kept()).toBe(true);
    expect(index()[id].path).toBe(moved);
    expect(make().idFor(moved)).toBe(id);
  });

  it("a document on a drive that isn't connected isn't counted while the drive is away, and counts on from where it was when the drive is back", async () => {
    const drives = realpathSync(mkdtempSync(join(tmpdir(), "corillo-drives-")));
    const drive = join(drives, "Backup");
    mkdirSync(drive);
    const { h, data, later, kept } = setup({ drives: [drives] });
    // Corillo knew a document on the drive; it was deleted there (10 days counted), then the drive was ejected.
    const onDrive = join(drive, "notes.md");
    const index = JSON.parse(readFileSync(join(data, "documents.json"), "utf8"));
    index.ondrive = { path: onDrive, ino: -1, dev: -1, missing: { counted: 10 * DAY, at: new Date("2026-11-09T10:00:00Z").getTime() } };
    writeFileSync(join(data, "documents.json"), JSON.stringify(index));
    mkdirSync(join(data, "documents", "ondrive"));
    writeFileSync(join(data, "documents", "ondrive", "settings.json"), "{}");
    const driveKept = () => existsSync(join(data, "documents", "ondrive"));
    rmSync(drive, { recursive: true });
    await h.sweep(new Set());
    later(60);
    await h.sweep(new Set());
    expect(driveKept()).toBe(true);
    // Back, still without the file: the count goes on from 10 days.
    mkdirSync(drive);
    await h.sweep(new Set());
    later(19);
    await h.sweep(new Set());
    expect(driveKept()).toBe(true);
    later(2);
    await h.sweep(new Set());
    expect(driveKept()).toBe(false);
    expect(kept()).toBe(true); // the document on the Mac, still there, is untouched
  });

  it("an open document is never cleared, even while its file is gone", async () => {
    const { h, id, file, later, kept } = setup();
    unlinkSync(file);
    await h.sweep(new Set([id]));
    later(40);
    await h.sweep(new Set([id]));
    expect(kept()).toBe(true);
  });

  it("Corillo noticing an open document go to the Trash starts its count then", async () => {
    const { h, id, docs, file, later, kept } = setup();
    mkdirSync(join(docs, ".Trash"));
    renameSync(file, join(docs, ".Trash", "plan.md"));
    h.noticedMissing(id);
    later(31);
    await h.sweep(new Set());
    expect(kept()).toBe(false);
  });
});

describe("a document on a drive that's away keeps its comments and history for when the drive is back", () => {
  /** Corillo's list, with a document added by hand as it would be on a drive. */
  function remember(data: string, id: string, entry: Record<string, unknown>) {
    const list = join(data, "documents.json");
    const index = JSON.parse(readFileSync(list, "utf8"));
    index[id] = entry;
    writeFileSync(list, JSON.stringify(index));
    mkdirSync(join(data, "documents", id));
    writeFileSync(join(data, "documents", id, "settings.json"), "{}");
  }

  it("another file with the same number on disk, on a drive that happens to get the same number, doesn't take it over", () => {
    const drives = realpathSync(mkdtempSync(join(tmpdir(), "corillo-drives-")));
    const { data, docs, make } = setup({ drives: [drives] });
    // A document on the drive "Backup", now ejected; a file here happens to have the same numbers.
    const here = join(docs, "notes.md");
    writeFileSync(here, "Other notes.\n");
    const { ino, dev } = statSync(here);
    remember(data, "ondrive", { path: join(drives, "Backup", "notes.md"), ino, dev });
    expect(make().idFor(here, "Other notes.\n")).not.toBe("ondrive");
  });

  it("a copy opened while the original's drive is away is a new document, also when the drive was reached through a linked folder", () => {
    const drives = realpathSync(mkdtempSync(join(tmpdir(), "corillo-drives-")));
    const { data, docs, text, make } = setup({ drives: [drives] });
    const [known] = Object.values(JSON.parse(readFileSync(join(data, "documents.json"), "utf8")) as Record<string, { text: string }>);
    const print = known.text; // what Corillo knows the text by
    remember(data, "ejected", { path: join(drives, "Backup", "Report.md"), ino: 41, dev: 9_999_001, text: print });
    // A linked folder in the documents folder, pointing at a drive that isn't plugged in.
    symlinkSync(join(drives, "Work", "Projects"), join(docs, "Projects"));
    remember(data, "linked", { path: join(docs, "Projects", "Summary.md"), ino: 42, dev: 9_999_002, text: print });
    const copies = realpathSync(mkdtempSync(join(tmpdir(), "corillo-copies-")));
    for (const name of ["Report.md", "Summary.md"]) {
      writeFileSync(join(copies, name), text);
      expect(["ejected", "linked"]).not.toContain(make().idFor(join(copies, name), text));
    }
  });

  it("one reached through a linked folder onto a drive that isn't plugged in isn't counted gone while the drive is away", async () => {
    const drives = realpathSync(mkdtempSync(join(tmpdir(), "corillo-drives-")));
    const { h, data, docs, later } = setup({ drives: [drives] });
    symlinkSync(join(drives, "Work", "Projects"), join(docs, "Projects"));
    remember(data, "linked", { path: join(docs, "Projects", "Summary.md"), ino: 42, dev: 9_999_002 });
    await h.sweep(new Set());
    later(60);
    await h.sweep(new Set());
    expect(existsSync(join(data, "documents", "linked"))).toBe(true);
  });
});

describe("a document Corillo isn't allowed to look at is out of reach, not gone (A-1)", () => {
  /** Lock the document's folder (no permissions, as a shared folder whose access was taken away), run the test, and unlock it. */
  async function locked(folder: string, run: () => unknown): Promise<void> {
    chmodSync(folder, 0o000);
    try {
      await run();
    } finally {
      chmodSync(folder, 0o755);
    }
  }

  it("isn't said to be off its disk", async () => {
    const { docs, file } = setup();
    const { ino, dev } = statSync(file);
    await locked(docs, () => expect(stillOnDisk({ ino, dev }, file)).not.toBe(false));
  });

  it("keeps its comments and history however long it's locked away, and its days don't run meanwhile", async () => {
    const { h, id, docs, file, later, kept } = setup();
    await locked(docs, async () => {
      await h.sweep(new Set());
      later(31);
      expect(await h.sweep(new Set())).toEqual([]);
    });
    expect(kept()).toBe(true);
    expect(h.readComments(id)).toHaveLength(1);
    // Deleted once it can be looked at again: the 30 days start then, not from when it was locked.
    unlinkSync(file);
    await h.sweep(new Set());
    later(29);
    await h.sweep(new Set());
    expect(kept()).toBe(true);
  });

  it("a copy with the same name and text, opened elsewhere meanwhile, doesn't take its comments and history", async () => {
    const { id, docs, text, make } = setup();
    const copies = realpathSync(mkdtempSync(join(tmpdir(), "corillo-copies-")));
    writeFileSync(join(copies, "plan.md"), text);
    await locked(docs, () => expect(make().idFor(join(copies, "plan.md"), text)).not.toBe(id));
  });
});

describe("a damaged or unreadable list of documents never cuts documents off from their comments and history", () => {
  const BUDGET = "# Budget\n\nThe numbers behind the plan, with enough words to know it by.\n";
  /** Two documents with a comment each; then Corillo starts again and reads its list of documents fine. */
  function two() {
    const s = setup();
    const budget = join(s.docs, "budget.md");
    writeFileSync(budget, BUDGET);
    const budgetId = s.h.idFor(budget, BUDGET);
    s.h.writeComments(budgetId, addThread([], me, "Too high?", null, null).threads);
    s.make().idFor(s.file, s.text); // the next launch
    const list = join(s.data, "documents.json");
    const setAside = () => readdirSync(s.data).filter((n) => n.startsWith("documents.json.damaged-"));
    const comment = (h: VersionHistory, id: string) => h.readComments(id)[0]?.messages[0].body;
    return { ...s, budget, budgetId, list, setAside, comment };
  }

  it("cut short, as a power cut can leave it: both documents keep their comments, and the damaged list is kept aside", () => {
    const s = two();
    const damaged = readFileSync(s.list, "utf8").slice(0, 40);
    writeFileSync(s.list, damaged);
    const h = s.make();
    expect(h.idFor(s.file, s.text)).toBe(s.id);
    expect(s.comment(h, s.id)).toBe("Is two enough?");
    expect(h.idFor(s.budget, BUDGET)).toBe(s.budgetId);
    expect(s.comment(h, s.budgetId)).toBe("Too high?");
    expect(Object.keys(s.index()).sort()).toEqual([s.id, s.budgetId].sort());
    expect(s.setAside()).toHaveLength(1);
    expect(readFileSync(join(s.data, s.setAside()[0]), "utf8")).toBe(damaged);
  });

  it("empty: the same", () => {
    const s = two();
    writeFileSync(s.list, "");
    const h = s.make();
    expect(h.idFor(s.budget, BUDGET)).toBe(s.budgetId);
    expect(h.idFor(s.file, s.text)).toBe(s.id);
    expect(s.comment(h, s.budgetId)).toBe("Too high?");
    expect(s.setAside()).toHaveLength(1);
  });

  it("damaged with no earlier copy to fall back on: the list is rebuilt from what each document's folder keeps", () => {
    const s = two();
    rmSync(join(s.data, "documents.json.bak"), { force: true });
    writeFileSync(s.list, "{ not json");
    const h = s.make();
    expect(h.idFor(s.budget)).toBe(s.budgetId);
    expect(h.idFor(s.file)).toBe(s.id);
    expect(s.comment(h, s.id)).toBe("Is two enough?");
    expect(s.index()[s.budgetId].path).toBe(s.budget);
  });

  it("a document first opened after the earlier copy was made is found again too, and so is one renamed since", () => {
    const s = two();
    const h = s.make();
    const notes = join(s.docs, "notes.md");
    writeFileSync(notes, "# Notes\n\nNotes from the planning meeting, long enough to know.\n");
    const notesId = h.idFor(notes);
    h.writeComments(notesId, addThread([], me, "Who was there?", null, null).threads);
    const renamed = join(s.docs, "plan final.md");
    renameSync(s.file, renamed);
    h.moved(s.id, renamed); // File > Rename or Move
    writeFileSync(s.list, "\u0000\u0000\u0000");
    const again = s.make();
    expect(again.idFor(notes)).toBe(notesId);
    expect(s.comment(again, notesId)).toBe("Who was there?");
    expect(again.idFor(renamed)).toBe(s.id);
    expect(s.index()[s.id].path).toBe(renamed);
  });

  // A record that couldn't be written is tried again at the next write of the list, so it never outranks it stale (R-MAIN-13).
  it("a document's note of where it is that couldn't be written is written at the next chance, so a rebuilt list keeps the document's new place", () => {
    const s = two();
    const h = s.make();
    const folder = join(s.data, "documents", s.id);
    const renamed = join(s.docs, "plan final.md");
    renameSync(s.file, renamed);
    chmodSync(folder, 0o555); // its folder can't take the note right now
    try {
      h.moved(s.id, renamed); // File > Rename or Move
    } finally {
      chmodSync(folder, 0o755);
    }
    // Something else changes the list: Corillo tries the note again.
    const notes = join(s.docs, "notes.md");
    writeFileSync(notes, "# Notes\n\nNotes from the planning meeting, long enough to know.\n");
    h.idFor(notes);
    expect(JSON.parse(readFileSync(join(folder, "record.json"), "utf8")).path).toBe(renamed);
    // The list is damaged, and its copy from launch has the old place: the document keeps its new one.
    writeFileSync(s.list, "{ not json");
    const again = s.make();
    expect(again.idFor(renamed)).toBe(s.id);
    expect(s.index()[s.id].path).toBe(renamed);
  });

  it("a list that can't be read right now (no permission, say) is never written over", () => {
    const s = two();
    const before = readFileSync(s.list);
    chmodSync(s.list, 0o000);
    try {
      const h = s.make();
      const other = join(s.docs, "other.md");
      writeFileSync(other, "Another document.\n");
      expect(() => h.idFor(other)).toThrow();
      expect(() => h.saved(s.id, s.file, "Changed.\n")).toThrow();
    } finally {
      chmodSync(s.list, 0o644);
    }
    expect(readFileSync(s.list).equals(before)).toBe(true);
    expect(s.setAside()).toEqual([]);
  });

  it("the list is flushed to disk before it takes the old one's place, and a save that leaves the document where it was writes only the list", () => {
    const s = two();
    const h = s.make();
    h.lastKnown(s.id); // this run has read the list once (and kept its copy)
    const record = join(s.data, "documents", s.id, "record.json");
    expect(existsSync(record)).toBe(true);
    const recordBefore = statSync(record);
    const flushes = countFlushes(s.list, `${s.list}.bak`);
    try {
      // A save gives the file a new identity on disk, which the list notes.
      writeFileSync(`${s.file}.new`, "Changed.\n");
      renameSync(`${s.file}.new`, s.file);
      h.saved(s.id, s.file, "Changed.\n");
    } finally {
      flushes.stop();
    }
    expect(flushes.count).toBe(1);
    expect(statSync(record).mtimeMs).toBe(recordBefore.mtimeMs);
    expect(h.lastKnown(s.id)?.ino).toBe(statSync(s.file).ino);
  });
});

describe("a document's own files: not there means none, damaged is set aside, and unreadable is never written over", () => {
  /** Every name in the document's folder (and its history folder) that a damaged file was set aside under. */
  const setAsideIn = (dir: string) => (existsSync(dir) ? readdirSync(dir).filter((n) => n.includes("damaged-") || n.startsWith("set-aside-")) : []);
  const folderOf = (s: ReturnType<typeof setup>) => join(s.data, "documents", s.id);

  it("damaged comments are set aside, the person is told, and the next comment doesn't write over them", () => {
    const s = setup();
    const file = join(folderOf(s), "comments.json.gz");
    writeFileSync(file, "not compressed comments");
    const h = s.make();
    const told: string[] = [];
    h.onSetAside = (id, what) => told.push(`${id}:${what}`);
    const comments = new CommentService(h, () => {});
    expect(comments.threads(s.id)).toEqual([]);
    expect(told).toEqual([`${s.id}:comments`]);
    comments.add(s.id, me, "A new comment.", null, null);
    const aside = setAsideIn(folderOf(s));
    expect(aside).toHaveLength(1);
    expect(readFileSync(join(folderOf(s), aside[0]), "utf8")).toBe("not compressed comments");
    expect(s.make().readComments(s.id).map((t) => t.messages[0].body)).toEqual(["A new comment."]);
  });

  it("comments that can't be read right now stop any change to them, and are all there once they can be read", () => {
    const s = setup();
    const file = join(folderOf(s), "comments.json.gz");
    const before = readFileSync(file);
    chmodSync(file, 0o000);
    try {
      const comments = new CommentService(s.make(), () => {});
      expect(() => comments.add(s.id, me, "Lost?", null, null)).toThrow();
      expect(() => comments.threads(s.id)).toThrow();
    } finally {
      chmodSync(file, 0o644);
    }
    expect(readFileSync(file).equals(before)).toBe(true);
    expect(s.make().readComments(s.id)[0].messages[0].body).toBe("Is two enough?");
    expect(setAsideIn(folderOf(s))).toEqual([]);
  });

  it("a history that can't be read right now is never set aside or started again: every version is there once it can be read", () => {
    const s = setup();
    s.h.edited(s.id, `${s.text}More.\n`);
    s.h.outside(s.id, `${s.text}More, from another app.\n`);
    const latest = join(folderOf(s), "versions", "latest.json.gz");
    chmodSync(latest, 0o000);
    try {
      const h = s.make();
      h.edited(s.id, `${s.text}Typed while it couldn't be read.\n`);
      h.seen(s.id, `${s.text}Opened while it couldn't be read.\n`);
    } catch {
      // saying so is fine; changing it isn't
    } finally {
      chmodSync(latest, 0o644);
    }
    expect(setAsideIn(join(folderOf(s), "versions"))).toEqual([]);
    expect(s.make().list(s.id).map((v) => v.kind)).toEqual(["first", "person", "outside"]);
  });

  it("a damaged history is set aside (as before) and the person is told", () => {
    const s = setup();
    writeFileSync(join(folderOf(s), "versions", "latest.json.gz"), "garbled");
    const h = s.make();
    const told: string[] = [];
    h.onSetAside = (_id, what) => told.push(what);
    h.seen(s.id, s.text);
    expect(told).toEqual(["history"]);
    expect(setAsideIn(join(folderOf(s), "versions")).length).toBeGreaterThan(0);
    expect(h.list(s.id).map((v) => v.kind)).toEqual(["first"]);
  });

  it("damaged settings are set aside; ones that can't be read right now are left alone; the old changes file is never read", () => {
    const s = setup();
    const settings = join(folderOf(s), "settings.json");
    const other = join(folderOf(s), "other-changes.json");
    writeFileSync(settings, '{"style": "corillo"'); // cut short
    writeFileSync(other, "[{]");
    const h = s.make();
    const told: string[] = [];
    h.onSetAside = (_id, what) => told.push(what);
    // Which web pictures wait went with them, so every one does (the review of Batch 21, G21-3).
    expect(h.readSettings(s.id)).toEqual({ everyWebPictureWaits: { shown: [] } });
    expect(told).toEqual(["settings"]);
    expect(setAsideIn(folderOf(s))).toHaveLength(1);
    // Changes tied to no comment used to wait in the panel; they are kept with each version now (roadmap Batch 9, item 5). The old file stays as it was.
    expect(readFileSync(other, "utf8")).toBe("[{]");

    h.writeSettings(s.id, { style: "plain" });
    chmodSync(settings, 0o000);
    try {
      expect(() => s.make().readSettings(s.id)).toThrow();
    } finally {
      chmodSync(settings, 0o644);
    }
    expect(s.make().readSettings(s.id)).toEqual({ style: "plain" });
  });

  // Each write replaces the whole file, every comment in it: one left unflushed can come back empty after a power cut (R-MAIN-3).
  it("comments and the changes made for them are flushed to disk every time they're written, also when they only move with the person's typing", () => {
    const s = setup();
    const comments = new CommentService(s.make(), () => {});
    const thread = comments.add(s.id, me, "Which words?", { quote: "plan", prefix: "A ", suffix: " with", offset: 8 }, null);
    const flushes = countFlushes(join(folderOf(s), "comments.json.gz"));
    try {
      comments.setAnchors(s.id, { [thread.id]: { quote: "plan", prefix: "# A ", suffix: " with", offset: 10 } });
      expect(comments.threads(s.id).find((t) => t.id === thread.id)?.anchor?.offset).toBe(10);
      expect(flushes.count).toBe(1);
      comments.reply(s.id, thread.id, me, "Or three?");
      expect(flushes.count).toBe(2);
      comments.resolve(s.id, thread.id, me, true);
      expect(flushes.count).toBe(3);
    } finally {
      flushes.stop();
    }
    const span = (offset: number) => ({ anchor: { quote: "plan", prefix: "A ", suffix: " with", offset }, removed: "" });
    comments.updateChanges(s.id, (threads) => threads.map((t) => (t.id === thread.id ? { ...t, change: { round: 1, agent: "Claude", at: "2026-11-09T10:00:00Z", spans: [span(8)] } } : t)));
    const changes = countFlushes(join(folderOf(s), "comments.json.gz"));
    try {
      comments.setChangeAnchors(s.id, { threads: { [thread.id]: { round: 1, anchors: [span(10).anchor] } } });
      expect(comments.threads(s.id).find((t) => t.id === thread.id)!.change!.spans[0].anchor.offset).toBe(10);
      expect(changes.count).toBe(1);
    } finally {
      changes.stop();
    }
  });
});

describe("a document put away by a program, rather than moved by the person, is gone (not followed)", () => {
  it("into a hidden folder or a temporary-items folder its old place wasn't in, or the Mac's temporary folders", () => {
    const was = "/Users/me/Dropbox/Plans/plan.md";
    expect(putAway("/Users/me/Dropbox/.dropbox.cache/2026-11-09/plan.md", was)).toBe(true);
    expect(putAway("/Users/me/Dropbox/Plans/.Trash-ish/plan.md", was)).toBe(true);
    expect(putAway("/Volumes/Work/.TemporaryItems/folders.501/plan.md", "/Volumes/Work/plan.md")).toBe(true);
    expect(putAway("/Users/me/Dropbox/TemporaryItems/plan.md", was)).toBe(true);
    expect(putAway("/private/var/folders/xy/abc/T/TemporaryItems/plan.md", was)).toBe(true);
    expect(putAway("/private/tmp/plan.md", was)).toBe(true);
    // Moved or renamed by the person: followed.
    expect(putAway("/Users/me/Dropbox/Plans/renamed.md", was)).toBe(false);
    expect(putAway("/Users/me/Documents/Archive/plan.md", was)).toBe(false);
    // Already in a hidden or temporary folder, and moved within it.
    expect(putAway("/Users/me/.notes/renamed.md", "/Users/me/.notes/plan.md")).toBe(false);
    expect(putAway("/Users/me/.notes/Archive/plan.md", "/Users/me/.notes/plan.md")).toBe(false);
    expect(putAway("/private/tmp/run/b/plan.md", "/private/tmp/run/a/plan.md")).toBe(false);
  });
});
