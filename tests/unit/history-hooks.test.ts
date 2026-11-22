// What a save costs the history (A16-5): the save already knows its
// document's id, so the history is given it, and Corillo's list of documents
// is read once a save, not three times.
import { afterAll, describe, expect, it, vi } from "vitest";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const data = vi.hoisted(() => ({ dir: "" }));
vi.mock("electron", () => ({
  app: { getPath: () => data.dir },
  ipcMain: { handle: () => {}, on: () => {} },
}));
data.dir = mkdtempSync(join(tmpdir(), "corillo-history-hooks-"));
afterAll(() => rmSync(data.dir, { recursive: true, force: true }));

const { historyHooks, versionHistory } = await import("../../src/main/history");

describe("a save, in the history", () => {
  it("is recorded under the id the save gives, without looking the document up again", () => {
    const file = join(data.dir, "plan.md");
    writeFileSync(file, "# Plan\n");
    const h = versionHistory();
    const id = h.idFor(file);
    h.seen(id, "# Plan\n");
    // As main.ts's save does just before: the list of documents knows the file as it is now.
    writeFileSync(file, "# Plan\n\nMore.\n");
    h.saved(id, file, "# Plan\n\nMore.\n");
    const lookUp = vi.spyOn(h, "idFor");
    const saved = vi.spyOn(h, "saved");
    historyHooks.saved(id, "# Plan\n\nMore.\n");
    expect(lookUp).not.toHaveBeenCalled();
    expect(saved).not.toHaveBeenCalled();
    expect(h.list(id).map((v) => v.kind)).toEqual(["first", "person"]);
  });
});
