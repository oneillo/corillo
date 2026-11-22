// The file Save Somewhere Else leaves where it was (the review of Batch 19,
// R19-4; roadmap Batch 20, item 1). Once the document's records move to the
// new file, the old one opens as a document of its own: it gets the same web
// pictures waiting as the document had, or, if which wait can't be read,
// every web picture in it waits. The new file keeps its list.
import { afterEach, describe, expect, it, vi } from "vitest";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import * as path from "node:path";
import { VersionHistory } from "../../src/main/version-store";
import { WaitingPictures, type WaitingRecords } from "../../src/main/waiting-pictures";

const made: string[] = [];
afterEach(() => {
  for (const dir of made.splice(0)) rmSync(dir, { recursive: true, force: true });
});

const CHART = "https://a.test/chart.png";
const TEXT = `# Plan\n\n![chart](${CHART})\n\n![mine](https://b.test/mine.png)\n`;

/** A document at plan.md with an agent's chart waiting, saved somewhere else as kept.md, with plan.md left where it was. */
function savedSomewhereElse(records?: (store: VersionHistory) => WaitingRecords) {
  const dir = mkdtempSync(path.join(tmpdir(), "corillo-left-behind-"));
  made.push(dir);
  const oldPath = path.join(dir, "plan.md");
  const newPath = path.join(dir, "kept.md");
  writeFileSync(oldPath, TEXT);
  const store = new VersionHistory(path.join(dir, "data"));
  const id = store.idFor(oldPath, TEXT);
  const waiting = new WaitingPictures(records?.(store) ?? store, () => [id]);
  waiting.change(id, { wait: [CHART] });
  writeFileSync(newPath, TEXT);
  store.saved(id, newPath, TEXT);
  return { store, waiting, id, oldPath, newPath, dir };
}

describe("the file Save Somewhere Else leaves behind", () => {
  it("after saved(id, newPath), the old path's record holds the old list; the new file keeps it too", () => {
    const { store, waiting, id, oldPath, newPath } = savedSomewhereElse();
    const oldId = store.idFor(oldPath, TEXT);
    expect(oldId).not.toBe(id);
    waiting.leftBehind(id, oldId, TEXT);
    expect(store.waitingPictures(oldId)).toEqual([CHART]);
    expect(waiting.of(oldId, TEXT)).toEqual([CHART]); // his own picture loads as before
    expect(store.idFor(newPath, TEXT)).toBe(id);
    expect(store.waitingPictures(id)).toEqual([CHART]);
  });

  it("carries 'every web picture waits', with the pictures he showed", () => {
    const { store, waiting, id, oldPath } = savedSomewhereElse();
    store.markEveryWebPictureWaits(id, ["https://b.test/mine.png"]);
    const oldId = store.idFor(oldPath, TEXT);
    waiting.leftBehind(id, oldId, TEXT);
    expect(store.everyWebPictureWaits(oldId)).toEqual(["https://b.test/mine.png"]);
    expect(waiting.of(oldId, TEXT)).toEqual([CHART]);
  });

  it("carries what couldn't be kept with the records, too", () => {
    let full = false;
    const { store, waiting, id, oldPath } = savedSomewhereElse((store) => ({
      waitingPictures: (i) => store.waitingPictures(i),
      changeWaitingPictures: (i, change) => {
        if (full) throw Object.assign(new Error("full"), { code: "ENOSPC" });
        return store.changeWaitingPictures(i, change);
      },
      everyWebPictureWaits: (i) => store.everyWebPictureWaits(i),
      markEveryWebPictureWaits: (i, shown) => store.markEveryWebPictureWaits(i, shown),
    }));
    full = true;
    const error = vi.spyOn(console, "error").mockImplementation(() => {});
    try {
      waiting.change(id, { wait: ["https://a.test/later.png"] }); // held while the app runs
      full = false;
      const oldId = store.idFor(oldPath, TEXT);
      waiting.leftBehind(id, oldId, TEXT);
      expect(store.waitingPictures(oldId)).toEqual([CHART, "https://a.test/later.png"]);
    } finally {
      error.mockRestore();
    }
  });

  it("if which wait can't be read, every web picture in the old file waits", () => {
    let unreadable = false;
    const { store, waiting, id, oldPath } = savedSomewhereElse((store) => ({
      waitingPictures: (i) => {
        if (unreadable) throw new Error("can't be read now");
        return store.waitingPictures(i);
      },
      changeWaitingPictures: (i, change) => store.changeWaitingPictures(i, change),
      everyWebPictureWaits: (i) => store.everyWebPictureWaits(i),
      markEveryWebPictureWaits: (i, shown) => store.markEveryWebPictureWaits(i, shown),
    }));
    const oldId = store.idFor(oldPath, TEXT);
    unreadable = true;
    const error = vi.spyOn(console, "error").mockImplementation(() => {});
    try {
      waiting.leftBehind(id, oldId, TEXT);
    } finally {
      error.mockRestore();
    }
    unreadable = false;
    expect(store.everyWebPictureWaits(oldId)).toEqual([]);
    expect(waiting.of(oldId, TEXT).sort()).toEqual([CHART, "https://b.test/mine.png"]);
  });

  // The review of Batch 20, R20-1: leftBehind reads the damaged list first, and the damage is set aside then: the document itself still fails closed.
  it("with the document's settings.json damaged, the old file's every web picture waits, and the document's own still wait too", () => {
    const { store, waiting, id, oldPath, dir } = savedSomewhereElse();
    writeFileSync(path.join(dir, "data", "documents", id, "settings.json"), "{ damaged");
    const oldId = store.idFor(oldPath, TEXT);
    const error = vi.spyOn(console, "error").mockImplementation(() => {});
    try {
      waiting.leftBehind(id, oldId, TEXT);
      expect(store.everyWebPictureWaits(oldId)).toEqual([]);
      expect(waiting.of(id, TEXT)).toContain(CHART);
      expect(waiting.blocks(CHART)).toBe(true);
      expect(store.waitingPictures(id)).toContain(CHART); // kept on disk, for the next open of the new file
    } finally {
      error.mockRestore();
    }
  });

  it("does nothing when the old path is still the same document (its records didn't move)", () => {
    const { store, waiting, id } = savedSomewhereElse();
    waiting.leftBehind(id, id, TEXT);
    expect(store.waitingPictures(id)).toEqual([CHART]);
    expect(store.everyWebPictureWaits(id)).toBeNull();
  });
});
