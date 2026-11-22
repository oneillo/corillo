// The Comments panel, the document's tab and main.ts were each split into
// parts (roadmap Batches 19 to 21). As for the two core families (see
// markdown-modules.test.ts and change-links-modules.test.ts), each part takes
// values only from the parts below it, so none starts before what it uses,
// and none takes a value back from its main file: a type may go either way.
// The review of Batch 21, S21-12.
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

const SRC = join(import.meta.dirname, "..", "..", "src");

// Each family's parts, lowest first; its main file last.
const FAMILIES: Record<string, { folder: string; order: string[] }> = {
  "the Comments panel": {
    folder: "renderer",
    order: ["comments-panel-places", "comments-panel-cards", "comments-panel-keyboard", "comments-panel-find", "comments-panel"],
  },
  "the document's tab": { folder: "renderer", order: ["doc-tab-place", "doc-tab-edits", "doc-tab-markdown", "doc-tab"] },
  "main.ts": { folder: "main", order: ["doc-on-disk", "doc-pictures", "main"] },
};

/** What a file imports from the others in its folder, and whether each is only types. */
function importsOf(folder: string, name: string): { from: string; typesOnly: boolean }[] {
  const code = readFileSync(join(SRC, folder, `${name}.ts`), "utf8");
  return [...code.matchAll(/^(?:import|export)\s+(type\s+)?(?:\{([^}]*)\}|[\w*\s]+?)\s+from\s+"\.\/([\w-]+)";/gms)].map(([, wholeType, names, from]) => ({
    from,
    typesOnly: !!wholeType || (names !== undefined && names.split(",").every((n) => !n.trim() || /^type\s/.test(n.trim()))),
  }));
}

describe("the parts of the panel, the tab and main.ts", () => {
  for (const [family, { folder, order }] of Object.entries(FAMILIES)) {
    it(`${family}: each part takes values only from the parts below it`, () => {
      order.forEach((name, i) => {
        for (const { from, typesOnly } of importsOf(folder, name)) {
          const at = order.indexOf(from);
          if (at < 0 || typesOnly) continue;
          expect(at, `${name} takes a value from ${from}`).toBeLessThan(i);
        }
      });
    });
  }

  it("the check reads the imports it's for", () => {
    const panel = importsOf("renderer", "comments-panel-cards").find((i) => i.from === "comments-panel");
    expect(panel).toEqual({ from: "comments-panel", typesOnly: true });
    const tab = importsOf("renderer", "doc-tab").filter((i) => i.from.startsWith("doc-tab-"));
    expect(tab.map((i) => i.from).sort()).toEqual(["doc-tab-edits", "doc-tab-markdown", "doc-tab-place"]);
    expect(tab.every((i) => !i.typesOnly)).toBe(true);
  });
});
