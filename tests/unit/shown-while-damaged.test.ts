// Show picture while a document's damaged settings can't be written again (the
// review of Batch 21, R21-5; roadmap Batch 22, item 2). Every web picture in
// the document waits (G21-3), held in memory while the disk takes no writes.
// Before, his click on Show picture was lost: the mark in memory always said
// "nothing shown", so the picture he had just shown waited again. Now the
// addresses he shows are kept with that mark. Only what he clicked loads:
// every other web picture in the document still waits.
import { afterEach, describe, expect, it, vi } from "vitest";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import * as path from "node:path";
import { DocumentStore } from "../../src/main/store";
import { WaitingPictures } from "../../src/main/waiting-pictures";
import { isWebAddress } from "../../src/core/web-pictures";

const SHOWN = "https://a.test/chart.png?q=41500";
const OTHER = "https://b.test/team.png";
const TEXT = `# Plan\n\n![chart](${SHOWN})\n\n![team](${OTHER})\n`;

const made: string[] = [];
afterEach(() => {
  for (const dir of made.splice(0)) rmSync(dir, { recursive: true, force: true });
  vi.restoreAllMocks();
});

/** A document whose settings are damaged, on a disk that takes no writes. */
function damagedOnFullDisk() {
  const dir = mkdtempSync(path.join(tmpdir(), "corillo-shown-"));
  made.push(dir);
  const doc = path.join(dir, "plan.md");
  writeFileSync(doc, TEXT);
  const data = path.join(dir, "data");
  const store = new DocumentStore(data);
  const id = store.idFor(doc, TEXT);
  store.changeWaitingPictures(id, { wait: [SHOWN, OTHER] });
  writeFileSync(path.join(data, "documents", id, "settings.json"), "{ not json");
  vi.spyOn(console, "error").mockImplementation(() => {});
  const write = store.writeSettings.bind(store);
  store.writeSettings = () => {
    throw Object.assign(new Error("no space left"), { code: "ENOSPC" });
  };
  const waiting = new WaitingPictures(store, () => [id]);
  return { store, id, data, waiting, roomAgain: () => (store.writeSettings = write) };
}

/** Whether a tab opened now would hold this picture back: doc-tab.ts's own rule, from what main.ts gives it. */
function waitsInTab(waiting: WaitingPictures, id: string, src: string): boolean {
  const list = new Set(waiting.of(id, TEXT));
  const every = waiting.everyAtOpen(id);
  return list.has(src) || (every !== null && isWebAddress(src) && !every.includes(src));
}

describe("Show picture while the replacement settings can't be written", () => {
  it("sticks: the picture he showed is shown, and every other web picture still waits", () => {
    const { id, waiting } = damagedOnFullDisk();
    expect(waitsInTab(waiting, id, SHOWN)).toBe(true);
    expect(waitsInTab(waiting, id, OTHER)).toBe(true);
    waiting.change(id, { shown: [SHOWN] }); // his click; main.ts's picturesWait then tells the tabs everyBut
    expect(waiting.everyBut(id)).toEqual([SHOWN]);
    expect(waitsInTab(waiting, id, SHOWN)).toBe(false);
    expect(waitsInTab(waiting, id, OTHER)).toBe(true);
    expect(waiting.blocks(SHOWN)).toBe(false);
    expect(waiting.blocks(OTHER)).toBe(true);
    // Read again later, still with no room: the same.
    expect(waiting.everyBut(id)).toEqual([SHOWN]);
  });

  it("an agent adding the same picture again makes it wait again", () => {
    const { id, waiting } = damagedOnFullDisk();
    waiting.change(id, { shown: [SHOWN] });
    waiting.change(id, { wait: [SHOWN] });
    expect(waiting.everyBut(id)).toEqual([]);
    expect(waitsInTab(waiting, id, SHOWN)).toBe(true);
    expect(waitsInTab(waiting, id, OTHER)).toBe(true);
  });

  it("once the disk takes writes, what he showed is written with the mark; after a restart, nothing else loads", () => {
    const { store, id, data, waiting, roomAgain } = damagedOnFullDisk();
    waiting.change(id, { shown: [SHOWN] });
    roomAgain();
    store.writeSettings(id, { ...store.readSettings(id), export: { paper: "a4" } });
    const again = new DocumentStore(data);
    expect(again.everyWebPictureWaits(id)).toEqual([SHOWN]);
    expect(waitsInTab(new WaitingPictures(again, () => [id]), id, OTHER)).toBe(true);
  });

  it("after a restart with the settings still unwritten, every picture waits again: what he showed is only held while Corillo runs", () => {
    const { id, data, waiting } = damagedOnFullDisk();
    waiting.change(id, { shown: [SHOWN] });
    const again = new DocumentStore(data);
    expect(again.everyWebPictureWaits(id)).toEqual([]);
    const fresh = new WaitingPictures(again, () => [id]);
    expect(waitsInTab(fresh, id, SHOWN)).toBe(true);
    expect(waitsInTab(fresh, id, OTHER)).toBe(true);
  });
});
