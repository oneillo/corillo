// The list of web pictures that wait in a document is kept small (roadmap
// Batch 19, item 2, the review of Batch 18's R18-6): at most CAP addresses.
// Room is made only by letting go of addresses nothing Corillo can draw any
// more; failing that, every web picture in the document waits. No address is
// ever dropped while it can still be drawn, so none loads without his click.
// And the texts read to find an agent's pictures aren't held after its pass.
import { afterEach, describe, expect, it, vi } from "vitest";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import * as path from "node:path";
import { VersionHistory } from "../../src/main/version-store";
import { CAP, picturesOfOptions, WaitingPictures, type Drawable } from "../../src/main/waiting-pictures";
import { forgetReadTexts, isWebAddress, readTextsHeld, webPicturesIn } from "../../src/core/web-pictures";

const made: string[] = [];
afterEach(() => {
  for (const dir of made.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function setUp() {
  const dir = mkdtempSync(path.join(tmpdir(), "corillo-waiting-cap-"));
  made.push(dir);
  const doc = path.join(dir, "plan.md");
  writeFileSync(doc, "# Plan\n");
  const data = path.join(dir, "data");
  const store = new VersionHistory(data);
  const id = store.idFor(doc, "# Plan\n");
  return { store, id, data };
}

const address = (i: number) => `https://a.test/${i}.png?q=offer`;
const range = (from: number, to: number) => Array.from({ length: to - from }, (_, i) => address(from + i));

/**
 * Whether an address waits in a tab opening on the document now: what the app
 * tells it (main.ts's infoOf: of() and everyAtOpen()) read as the tab reads it
 * (doc-tab.ts's waits), so the app's own path is what's checked (the review
 * of Batch 19, R19-11).
 */
function waitsInTab(waiting: WaitingPictures, id: string, address: string): boolean {
  const list = waiting.of(id, "# Plan\n");
  const every = waiting.everyAtOpen(id);
  return list.includes(address) || (every !== null && isWebAddress(address) && !every.includes(address));
}

describe("the waiting list's cap", () => {
  it("5,000 addresses added over 50 passes, every one still drawable: the list stays at the cap and every one waits, after a fresh read too", () => {
    const { store, id, data } = setUp();
    const all = range(0, 5_000);
    // Each pass's version holds its pictures, so all of them can still be drawn in History.
    const drawable: Drawable = () => new Set(all);
    const waiting = new WaitingPictures(store, () => [id], drawable);
    for (let pass = 0; pass < 50; pass++) waiting.change(id, { wait: all.slice(pass * 100, pass * 100 + 100) });
    expect(store.waitingPictures(id)!.length).toBeLessThanOrEqual(CAP);
    expect(store.everyWebPictureWaits(id)).toEqual([]);
    for (const a of all) expect(waiting.blocks(a)).toBe(true);

    // The app started again: every one still waits, and the window is told every web picture does.
    const again = new WaitingPictures(new VersionHistory(data), () => [id], drawable);
    expect(all.every((a) => waitsInTab(again, id, a))).toBe(true);
    expect(again.everyBut(id)).toEqual([]);
    expect(again.of(id, `# Plan\n\n![last](${address(4_999)})\n`)).toContain(address(4_999));

    // He shows one: it no longer waits, after a fresh read too; added again by an agent, it waits again.
    again.change(id, { shown: [address(7)] });
    expect(waitsInTab(new WaitingPictures(new VersionHistory(data), () => [id]), id, address(7))).toBe(false);
    expect(waitsInTab(again, id, address(8))).toBe(true);
    again.change(id, { wait: [address(7)] });
    expect(waitsInTab(again, id, address(7))).toBe(true);
    expect(store.waitingPictures(id)!.length).toBeLessThanOrEqual(CAP);
  });

  it("an address gone from everything Corillo can draw for the document is let go to make room, and only then", () => {
    const { store, id } = setUp();
    const old = range(0, CAP);
    store.changeWaitingPictures(id, { wait: old }); // from an earlier run
    const stillDrawn = new Set(old.slice(0, 10));
    const waiting = new WaitingPictures(store, () => [id], () => stillDrawn);
    waiting.change(id, { wait: [address(9_000)] });
    expect(store.waitingPictures(id)!.sort()).toEqual([...old.slice(0, 10), address(9_000)].sort());
    expect(store.everyWebPictureWaits(id)).toBeNull();
    expect(waitsInTab(waiting, id, old[500])).toBe(false);
    expect(waitsInTab(waiting, id, old[5])).toBe(true);
  });

  it("when what can be drawn can't be known, or the addresses came to wait while the app runs, none is let go: every web picture waits instead", () => {
    const unknown = setUp();
    unknown.store.changeWaitingPictures(unknown.id, { wait: range(0, CAP) });
    const blind = new WaitingPictures(unknown.store, () => [unknown.id], () => null);
    blind.change(unknown.id, { wait: [address(9_000)] });
    expect(unknown.store.waitingPictures(unknown.id)).toHaveLength(CAP);
    expect(unknown.store.everyWebPictureWaits(unknown.id)).toEqual([]);
    expect(range(0, CAP).every((a) => waitsInTab(blind, unknown.id, a)) && waitsInTab(blind, unknown.id, address(9_000))).toBe(true);

    // Pasted or written this run, not yet in anything saved: kept, whatever the records say can be drawn.
    const fresh = setUp();
    const waiting = new WaitingPictures(fresh.store, () => [fresh.id], () => new Set());
    waiting.change(fresh.id, { wait: range(0, CAP) });
    waiting.change(fresh.id, { wait: [address(9_000)] });
    expect(fresh.store.waitingPictures(fresh.id)).toHaveLength(CAP);
    expect(fresh.store.everyWebPictureWaits(fresh.id)).toEqual([]);
    expect(waitsInTab(waiting, fresh.id, address(3))).toBe(true);
  });

  it("the list isn't written again when nothing changed, nor while every web picture waits", () => {
    const { store, id } = setUp();
    const waiting = new WaitingPictures(store, () => [id], () => null);
    waiting.change(id, { wait: range(0, 3) });
    const writes = vi.spyOn(store, "writeSettings");
    waiting.change(id, { wait: range(0, 3) });
    waiting.change(id, { wait: [address(1)] });
    expect(writes).not.toHaveBeenCalled();
    waiting.change(id, { wait: range(3, CAP + 1) }); // past the cap: marked once
    expect(writes).toHaveBeenCalledTimes(1);
    waiting.change(id, { wait: range(CAP + 1, CAP + 50) });
    expect(writes).toHaveBeenCalledTimes(1);
  });
});

describe("a read that fails while every web picture waits (the review of Batch 19, R19-7)", () => {
  it("never tells the document's tabs the mode is off: they keep what they have, a tab opening then has every web picture wait, and so does what of() gives", () => {
    const { store, id } = setUp();
    store.markEveryWebPictureWaits(id, [address(1)]);
    const real = store.everyWebPictureWaits.bind(store);
    let fail = true;
    vi.spyOn(store, "everyWebPictureWaits").mockImplementation((doc) => {
      if (fail) throw new Error("EIO");
      return real(doc);
    });
    const waiting = new WaitingPictures(store, () => [id]);
    expect(waiting.everyBut(id)).toBeUndefined(); // not known: what picturesWait sends leaves `every` out
    expect(waiting.everyAtOpen(id)).toEqual([]);
    expect(waiting.of(id, `# Plan\n\n![a](${address(2)})\n`)).toContain(address(2));
    fail = false;
    expect(waiting.everyBut(id)).toEqual([address(1)]);
    expect(waiting.everyAtOpen(id)).toEqual([address(1)]);
  });
});

describe("what History can still draw", () => {
  it("every version's text is read in one walk back, the oldest included", () => {
    const { store, id } = setUp();
    store.seen(id, `# Plan\n\n![old](${address(1)})\n`);
    store.outside(id, "# Plan\n\nNo picture now.\n");
    const texts: string[] = [];
    expect(store.everyText(id, (t) => texts.push(t))).toBe(true);
    expect(texts).toEqual(["# Plan\n\nNo picture now.\n", `# Plan\n\n![old](${address(1)})\n`]);
  });

  it("a document with no history can't say what it held: nothing is let go for it", () => {
    const { store, id } = setUp();
    expect(store.everyText(id, () => undefined)).toBe(false);
  });
});

describe("what a reply's options could still draw (the review of Batch 19, R19-10)", () => {
  it("each option is read as applied to the text, so a picture it writes by reference keeps its address", () => {
    const text = `# Plan\n\nThe chart goes here.\n\n[r]: ${address(1)}\n`;
    const option = { label: "With the chart", edits: [{ find: "The chart goes here.", replace: "![c][r]" }] };
    const threads = [{ messages: [{ text: "Add it?" }, { text: "One option.", options: [option] }] }];
    expect(picturesOfOptions(text, threads)).toEqual(new Set([address(1)]));
    // One that no longer fits the text adds nothing.
    expect(picturesOfOptions("# Plan\n", threads)).toEqual(new Set());
  });
});

describe("the texts read for an agent's pictures", () => {
  it("are let go when its pass ends", () => {
    webPicturesIn(`# Plan\n\n![a](${address(1)})\n`);
    webPicturesIn(`# Plan\n\n![b](${address(2)})\n`);
    expect(readTextsHeld()).toBe(2);
    forgetReadTexts();
    expect(readTextsHeld()).toBe(0);
  });
});
