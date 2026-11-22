// "Corillo couldn't update what it keeps beside it", once per spell of trouble
// (the review of Batch 21, G21-18; his call in roadmap Batch 22, item 2).
// Before, it was said once per document for as long as Corillo ran: after the
// trouble cleared and came back hours later, he heard nothing, though the
// notice had said "Corillo will try again at the next save". Now it is said
// again each time the trouble comes back. The mark clears only when the
// records save goes through (`store.saved`) or the document closes, not after
// any other update that happens to work.
//
// Runs the real save (doc-on-disk.ts's saveDoc) over a throwaway folder, with
// Corillo's records stood in for; its proof was
// review/batch-21/proofs/guards/records-notice.test.ts.
import { afterAll, beforeEach, describe, expect, it, vi } from "vitest";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

vi.mock("electron", () => {
  throw new Error("doc-on-disk.ts reached for Electron");
});

const disk = await import("../../src/main/doc-on-disk");
type OpenDoc = import("../../src/main/doc-on-disk").OpenDoc;

const root = mkdtempSync(join(tmpdir(), "corillo-records-notice-"));
afterAll(() => rmSync(root, { recursive: true, force: true }));

const full = () => Object.assign(new Error("no space left"), { code: "ENOSPC" });
let n = 0;
let folder = "";
let notices: string[] = [];
const trouble = { saved: false, recovery: false };

beforeEach(() => {
  folder = join(root, `case-${++n}`);
  mkdirSync(folder);
  notices = [];
  trouble.saved = trouble.recovery = false;
  vi.spyOn(console, "error").mockImplementation(() => {});
  disk.setUpDisk({
    docs: new Map(),
    send: () => {},
    notice: (text) => void notices.push(text),
    store: {
      saved: () => {
        if (trouble.saved) throw full();
      },
    } as never,
    recovery: {
      clear: () => {
        if (trouble.recovery) throw full();
      },
    } as never,
    historyHooks: { saved: () => {}, overwriting: () => {}, outside: () => {} },
    replaceRecent: () => {},
    picturesWait: () => {},
    keepWaiting: () => {},
  });
});

/** plan.md open in Corillo (a new tab each time: closing and opening it again gives a new one). */
function open(storeId = "plan"): OpenDoc {
  const filePath = join(folder, "plan.md");
  writeFileSync(filePath, "# Plan\n");
  return { id: `tab-${++n}`, storeId, filePath, diskText: "# Plan\n" };
}

let edits = 0;
function save(doc: OpenDoc): void {
  expect(disk.saveDoc(doc, `# Plan\n\nEdit ${++edits}.\n`, false)).toEqual({ ok: true });
}

const SAID = "plan is saved, but Corillo couldn't update what it keeps beside it.";

describe("trouble keeping Corillo's records of a document", () => {
  it("is said once while it lasts, and again each time it comes back after the records were kept fine", () => {
    const doc = open();
    trouble.saved = true; // the disk is full
    save(doc);
    save(doc); // still full at the next save: not said again
    expect(notices).toEqual([SAID]);
    trouble.saved = false; // he made room: the records are kept again
    save(doc);
    expect(notices).toEqual([SAID]);
    trouble.saved = true; // hours later the disk is full again
    save(doc);
    save(doc);
    expect(notices).toEqual([SAID, SAID]);
    trouble.saved = false;
    save(doc);
    trouble.saved = true; // and a third time
    save(doc);
    expect(notices).toEqual([SAID, SAID, SAID]);
  });

  it("the same spell isn't said again because another record, kept beside it, went through", () => {
    const doc = open();
    trouble.saved = true; // the document's records can't be written, but its unsaved-edits copy can be cleared
    save(doc);
    save(doc);
    save(doc);
    expect(notices).toEqual([SAID]);
    // Nor when an update other than the records save goes through (noting where the file went, say).
    disk.keepRecords(doc, () => {});
    save(doc);
    expect(notices).toEqual([SAID]);
  });

  it("is said once when only the unsaved-edits copy can't be cleared, save after save (R22-8)", () => {
    const doc = open();
    trouble.recovery = true; // the records save goes through, but the copy beside it can't be cleared
    save(doc);
    save(doc);
    save(doc);
    expect(notices).toEqual([SAID]);
    // Once both go through, the spell is over: trouble coming back is said again.
    trouble.recovery = false;
    save(doc);
    trouble.recovery = true;
    save(doc);
    expect(notices).toEqual([SAID, SAID]);
  });

  it("is said again once the document was closed and opened again", () => {
    trouble.saved = true;
    save(open());
    // Closed, and opened again (a new tab on the same records), the trouble still there.
    const again = open();
    save(again);
    save(again);
    expect(notices).toEqual([SAID, SAID]);
  });

  it("is said for each document that has it", () => {
    trouble.saved = true;
    save(open("plan"));
    save(open("budget"));
    expect(notices).toEqual([SAID, SAID]);
  });

  it("other trouble, outside a save, is said in its own words, and also once per spell", () => {
    const doc = open();
    // Noting that the document was moved, say, with the data folder full.
    const moved = () =>
      disk.keepRecords(doc, () => {
        throw full();
      });
    moved();
    moved();
    expect(notices).toEqual(["Corillo couldn't update what it keeps beside plan."]);
    save(doc); // the records save goes through: the spell is over
    moved();
    expect(notices).toEqual(["Corillo couldn't update what it keeps beside plan.", "Corillo couldn't update what it keeps beside plan."]);
  });
});
