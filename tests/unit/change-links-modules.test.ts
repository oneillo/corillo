// change-links.ts split into modules with one job each (Batch 20 item 3, R16-6):
// the public names stay where every caller finds them, and the modules depend
// on each other one way only, so none starts before what it uses.
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { anchorIn } from "../../src/core/anchors";
import * as links from "../../src/core/change-links";

const CORE = join(import.meta.dirname, "..", "..", "src", "core");
// Lowest first: each may import only the ones before it.
const ORDER = [
  "change-links-readings",
  "change-links-lines",
  "change-links-changed",
  "change-links-follow",
  "change-links-place",
  "change-links-carry",
  "change-links-pass",
  "change-links",
];
const source = (name: string) => readFileSync(join(CORE, `${name}.ts`), "utf8");

describe("change-links.ts in modules", () => {
  it("still gives every caller the names it used to", () => {
    const values = [
      "reading", "plainText", "forgetWords", "wordsKept", "sharedEnds", "changedPieces", "syncsFor",
      "remapSpans", "placeEdits", "applyPlaced", "gapAfter", "carry", "updateChanges", "sameSpans",
    ];
    for (const name of values) expect(typeof (links as Record<string, unknown>)[name], name).toBe("function");
    expect(typeof links.OffsetMap).toBe("function");
    expect(typeof links.PassLinks).toBe("function");
    expect(links.OTHER).toBe("other");
  });

  it("has modules that import only the ones below them", () => {
    ORDER.forEach((name, i) => {
      const used = [...source(name).matchAll(/from "\.\/(change-links[\w-]*)"/g)].map((m) => m[1]);
      for (const other of used) {
        expect(ORDER.indexOf(other), `${name} imports ${other}`).toBeGreaterThanOrEqual(0);
        expect(ORDER.indexOf(other), `${name} imports ${other}`).toBeLessThan(i);
      }
    });
  });

  it("starts each new module with one line naming its job", () => {
    for (const name of ORDER.slice(0, -1)) {
      const [first, second] = source(name).split("\n");
      expect(first, name).toMatch(/^\/\/ \S.*\.$/);
      expect(second, name).not.toMatch(/^\/\//);
    }
  });

  it("leaves an agent's exact edits, placed, with the rest of them in text-changes.ts (S21-23)", async () => {
    const edits = await import("../../src/core/text-changes");
    expect([edits.placeEdits, edits.applyPlaced]).toEqual([links.placeEdits, links.applyPlaced]);
    expect(source("change-links-place")).not.toMatch(/text-changes/);
  });

  it("keeps a comment's change on its words through an agent's edit, through the modules", () => {
    const before = "The report goes to the board today.\n\nWe ship in May.\n";
    const after = "The report goes to the directors today.\n\nWe ship in May.\n";
    const pass = new links.PassLinks("Claude", before);
    pass.edited(before, [{ text: after, owners: ["c1"] }]);
    const spans = pass.spans().get("c1")!;
    expect(spans.map((s) => [s.anchor.quote, s.removed])).toEqual([["directors", "board"]]);
    const start = before.indexOf("ship");
    const carried = links.carry(before, after, start, start + 4, new links.OffsetMap(before, after), anchorIn(before, start, start + 4));
    expect(carried).toEqual({ kind: "words", start: after.indexOf("ship"), end: after.indexOf("ship") + 4 });
  });
});
