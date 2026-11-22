// The web pictures an agent added that wait for the person, kept with the
// document's records (roadmap Batch 18, item 1): addresses only, in a field
// of settings.json an older Corillo keeps as it is.
import { afterEach, describe, expect, it, vi } from "vitest";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import * as path from "node:path";
import { DocumentStore } from "../../src/main/store";
import { WaitingPictures, type WaitingRecords } from "../../src/main/waiting-pictures";
import { isWebAddress } from "../../src/core/web-pictures";

const made: string[] = [];
afterEach(() => {
  for (const dir of made.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function setUp() {
  const dir = mkdtempSync(path.join(tmpdir(), "corillo-waiting-"));
  made.push(dir);
  const doc = path.join(dir, "plan.md");
  writeFileSync(doc, "# Plan\n");
  const data = path.join(dir, "data");
  const store = new DocumentStore(data);
  const id = store.idFor(doc, "# Plan\n");
  const settingsFile = () => path.join(dir, "data", "documents", id, "settings.json");
  return { store, id, data, settingsFile };
}

describe("waiting web pictures, kept with the document", () => {
  it("added, kept across a fresh read, and taken off when shown; nothing else in settings is touched", () => {
    const { store, id, data } = setUp();
    store.writeSettings(id, { export: { paper: "letter" } });
    expect(store.waitingPictures(id)).toEqual([]);
    expect(store.changeWaitingPictures(id, { wait: ["https://a.test/one.png", "https://a.test/two.png"] })).toEqual(["https://a.test/one.png", "https://a.test/two.png"]);
    expect(store.changeWaitingPictures(id, { wait: ["https://a.test/one.png"] })).toEqual(["https://a.test/one.png", "https://a.test/two.png"]);
    const again = new DocumentStore(data);
    expect(again.waitingPictures(id)).toEqual(["https://a.test/one.png", "https://a.test/two.png"]);
    expect(store.changeWaitingPictures(id, { shown: ["https://a.test/one.png"] })).toEqual(["https://a.test/two.png"]);
    expect(store.readSettings(id)).toEqual({ export: { paper: "letter" }, waitingPictures: ["https://a.test/two.png"] });
    store.changeWaitingPictures(id, { shown: ["https://a.test/two.png"] });
    expect(store.readSettings(id)).toEqual({ export: { paper: "letter" } });
  });

  it("an older Corillo's way of saving settings (all of them, spread) keeps the list", () => {
    const { store, id } = setUp();
    store.changeWaitingPictures(id, { wait: ["https://a.test/one.png"] });
    const all = store.readSettings(id);
    store.writeSettings(id, { ...all, export: { paper: "a4" } });
    expect(store.waitingPictures(id)).toEqual(["https://a.test/one.png"]);
  });

  it("a list that isn't a list of addresses is read as none, never as a reason to fail", () => {
    const { store, id, settingsFile } = setUp();
    store.writeSettings(id, { waitingPictures: "https://a.test/x.png" });
    expect(store.waitingPictures(id)).toEqual([]);
    store.writeSettings(id, { waitingPictures: [1, "https://a.test/y.png", null] });
    expect(store.waitingPictures(id)).toEqual(["https://a.test/y.png"]);
    expect(JSON.parse(readFileSync(settingsFile(), "utf8")).waitingPictures).toHaveLength(3);
  });
});

// The review of Batch 18, R18-9: a list that can't be read fails closed, never open.
describe("waiting web pictures in the app", () => {
  const TEXT = "# Plan\n\n![a](https://a.test/one.png)\n\n![b](https://a.test/two.png)\n\n![mine](plan%20images/x.png)\n";

  it("records that can't be read now: every web picture in the document waits", () => {
    const records: WaitingRecords = {
      waitingPictures: () => {
        throw new Error("EIO");
      },
      changeWaitingPictures: () => {
        throw new Error("EIO");
      },
    };
    const waiting = new WaitingPictures(records, () => ["doc"]);
    expect(waiting.of("doc", TEXT).sort()).toEqual(["https://a.test/one.png", "https://a.test/two.png"]);
    expect(waiting.blocks("https://a.test/one.png")).toBe(true);
  });

  it("a damaged settings file: every web picture waits, and is kept so after the file is set aside (the review of Batch 21, G21-3)", () => {
    const { store, id, data, settingsFile } = setUp();
    store.changeWaitingPictures(id, { wait: ["https://a.test/one.png"] });
    writeFileSync(settingsFile(), "{ not json");
    expect(store.waitingPictures(id)).toBeNull();
    expect(store.everyWebPictureWaits(id)).toEqual([]);
    expect(new DocumentStore(data).everyWebPictureWaits(id)).toEqual([]);
    writeFileSync(settingsFile(), "{ not json");
    const waiting = new WaitingPictures(store, () => [id]);
    expect(waiting.of(id, TEXT).sort()).toEqual(["https://a.test/one.png", "https://a.test/two.png"]);
    // Every web picture, not only those in the text now: one added later waits too.
    expect(waiting.everyAtOpen(id)).toEqual([]);
    expect(new DocumentStore(data).everyWebPictureWaits(id)).toEqual([]);
  });

  it("a list that couldn't be kept still waits, while the app runs, the next time the document opens", () => {
    let fail = true;
    const kept: string[] = [];
    const records: WaitingRecords = {
      waitingPictures: () => [...kept],
      changeWaitingPictures: (_id, change) => {
        if (fail) throw new Error("ENOSPC");
        kept.push(...(change.wait ?? []));
        return kept;
      },
    };
    const waiting = new WaitingPictures(records, () => ["doc"]);
    waiting.change("doc", { wait: ["https://a.test/one.png"] });
    expect(waiting.of("doc", TEXT)).toEqual(["https://a.test/one.png"]);
    fail = false;
    waiting.change("doc", { shown: ["https://a.test/one.png"] });
    expect(waiting.of("doc", TEXT)).toEqual([]);
  });

  it("blocks a request for an address that waits in an open document, however it's spelled, until shown; closed documents are let go", () => {
    const lists: Record<string, string[]> = { a: ["https://a.test/x.png?q=offer to Acme"], b: ["https://a.test/y.png"] };
    let open = ["a", "b"];
    const records: WaitingRecords = { waitingPictures: (id) => lists[id] ?? [], changeWaitingPictures: (id) => lists[id] ?? [] };
    const waiting = new WaitingPictures(records, () => open);
    waiting.of("a", "");
    waiting.of("b", "");
    expect(waiting.blocks("https://A.test/x.png?q=offer%20to%20Acme")).toBe(true);
    expect(waiting.blocks("https://a.test/x.png?q=offer%20to%20Acme#part")).toBe(true);
    expect(waiting.blocks("https://a.test/other.png")).toBe(false);
    waiting.change("a", { shown: ["https://a.test/x.png?q=offer to Acme"] });
    expect(waiting.blocks("https://a.test/x.png?q=offer%20to%20Acme")).toBe(false);
    expect(waiting.blocks("https://a.test/y.png")).toBe(true);
    open = ["a"];
    expect(waiting.blocks("https://a.test/y.png")).toBe(false);
    waiting.of("a", "");
    expect(waiting.held()).toBe(1);
  });
});

// The review of Batch 21, G21-3: a damaged list fails closed whoever reads it
// first, for pictures no longer in the text too, and even when the
// replacement can't be written. As spec.md says: every web picture waits.
describe("a damaged list of waiting pictures", () => {
  const OLD = "https://a.test/chart.png?q=41500";
  const NOW = "# Plan\n\nThe person took the agent's picture out. History still shows the version with it.\n";
  const WITH_OLD = `# Plan\n\n![chart](${OLD})\n`;

  /** Whether a tab opened now would hold this picture back: doc-tab.ts's own rule, from what main.ts's infoOf gives it. */
  function waitsInTab(waiting: WaitingPictures, id: string, text: string, src: string): boolean {
    const list = new Set(waiting.of(id, text));
    const every = waiting.everyAtOpen(id);
    return list.has(src) || (every !== null && isWebAddress(src) && !every.includes(src));
  }

  it("the control: with its list readable, a picture that is only in History still waits", () => {
    const { store, id } = setUp();
    store.changeWaitingPictures(id, { wait: [OLD] });
    const waiting = new WaitingPictures(store, () => [id]);
    expect(waitsInTab(waiting, id, NOW, OLD)).toBe(true);
    expect(waiting.blocks(OLD)).toBe(true);
  });

  it("with its list damaged, a picture that waited and is no longer in the text still waits", () => {
    const { store, id, settingsFile } = setUp();
    store.changeWaitingPictures(id, { wait: [OLD] });
    writeFileSync(settingsFile(), "{ not json");
    expect(waitsInTab(new WaitingPictures(store, () => [id]), id, NOW, OLD)).toBe(true);
  });

  it("with its list damaged while every web picture waited (past the cap), every web picture still waits", () => {
    const { store, id, settingsFile } = setUp();
    store.markEveryWebPictureWaits(id, []);
    writeFileSync(settingsFile(), "{ not json");
    expect(waitsInTab(new WaitingPictures(store, () => [id]), id, NOW, OLD)).toBe(true);
  });

  it("with its list damaged and read first by something else (the export's settings), the picture in the text still waits", () => {
    const { store, id, settingsFile } = setUp();
    store.changeWaitingPictures(id, { wait: [OLD] });
    writeFileSync(settingsFile(), "{ not json");
    store.readSettings(id); // as export.ts's settingsFor does: the damaged file is set aside here
    expect(waitsInTab(new WaitingPictures(store, () => [id]), id, WITH_OLD, OLD)).toBe(true);
  });

  it("with its list found damaged as an agent adds another picture, the one that waited still waits when Corillo starts again", () => {
    const { store, id, data, settingsFile } = setUp();
    const ADDED = "https://a.test/second.png?q=offer";
    store.changeWaitingPictures(id, { wait: [OLD] });
    const waiting = new WaitingPictures(store, () => [id]);
    expect(waiting.of(id, WITH_OLD)).toEqual([OLD]);
    writeFileSync(settingsFile(), "{ not json"); // damaged while the document is open
    waiting.change(id, { wait: [ADDED] }); // an agent's next change adds another picture
    const again = new WaitingPictures(new DocumentStore(data), () => [id]); // Corillo starts again
    expect(waitsInTab(again, id, `${WITH_OLD}\n![more](${ADDED})\n`, OLD)).toBe(true);
    expect(waitsInTab(again, id, `${WITH_OLD}\n![more](${ADDED})\n`, ADDED)).toBe(true);
  });

  it("with its list found damaged as an agent adds a picture while every web picture waited, the open tabs aren't told that not every picture waits", () => {
    const { store, id, settingsFile } = setUp();
    store.markEveryWebPictureWaits(id, []);
    const waiting = new WaitingPictures(store, () => [id]);
    expect(waiting.everyAtOpen(id)).toEqual([]);
    writeFileSync(settingsFile(), "{ not json");
    waiting.change(id, { wait: ["https://a.test/second.png?q=offer"] });
    expect(waiting.everyBut(id)).not.toBeNull(); // null is sent to the tabs as "not every picture waits"
  });

  it("with its list damaged and no new settings file written (the disk full), every web picture still waits while Corillo runs", () => {
    const { store, id, data, settingsFile } = setUp();
    store.changeWaitingPictures(id, { wait: [OLD] });
    writeFileSync(settingsFile(), "{ not json");
    const error = vi.spyOn(console, "error").mockImplementation(() => {});
    const write = store.writeSettings.bind(store);
    store.writeSettings = () => {
      throw new Error("ENOSPC");
    };
    try {
      const waiting = new WaitingPictures(store, () => [id]);
      expect(waitsInTab(waiting, id, NOW, OLD)).toBe(true);
      expect(waitsInTab(waiting, id, NOW, OLD)).toBe(true); // read again, with the damaged file gone
      // Written again once the disk takes it, the mark goes with what is written.
      store.writeSettings = write;
      store.writeSettings(id, { ...store.readSettings(id), export: { paper: "a4" } });
      expect(new DocumentStore(data).everyWebPictureWaits(id)).toEqual([]);
    } finally {
      store.writeSettings = write;
      error.mockRestore();
    }
  });

  // The review of Batch 21, R21-4: the mark held only in memory was lost when Corillo started again.
  it("with its list damaged and no new settings file written (the disk full, or Corillo stopped), every web picture still waits when Corillo starts again", () => {
    const { store, id, data, settingsFile } = setUp();
    store.changeWaitingPictures(id, { wait: [OLD] });
    writeFileSync(settingsFile(), "{ not json");
    const error = vi.spyOn(console, "error").mockImplementation(() => {});
    store.writeSettings = () => {
      throw new Error("ENOSPC");
    };
    try {
      expect(store.everyWebPictureWaits(id)).toEqual([]); // found damaged and set aside; the replacement isn't written
    } finally {
      error.mockRestore();
    }
    const again = new DocumentStore(data); // Corillo starts again
    expect(again.everyWebPictureWaits(id)).toEqual([]);
    expect(waitsInTab(new WaitingPictures(again, () => [id]), id, NOW, OLD)).toBe(true);
    // Once settings are written again, the mark goes with them.
    again.markEveryWebPictureWaits(id, [OLD]);
    expect(new DocumentStore(data).everyWebPictureWaits(id)).toEqual([OLD]);
  });

  it("the control: a document whose settings were never written has no mark", () => {
    const { store, id } = setUp();
    expect(store.everyWebPictureWaits(id)).toBeNull();
  });
});
