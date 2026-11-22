// Help's picture of the Review menu shows the menu as it is (roadmap Batch 19, item 4).
// Batch 14 added Read Aloud to the menu and the picture stayed as it was. The size check
// in help.test.ts holds the declared size to the file; this one holds the picture's
// description to the menu, so a new item means a new picture.
import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const ROOT = join(import.meta.dirname, "..", "..");
const read = (file: string) => readFileSync(join(ROOT, file), "utf8");

/** The labels of the Review menu, in order, as src/main/menus.ts builds it. */
function reviewMenuLabels(): string[] {
  const menus = read("src/main/menus.ts");
  const start = menus.indexOf('id: "review-menu"');
  expect(start, "the Review menu in menus.ts").toBeGreaterThan(-1);
  const end = menus.indexOf("],", start);
  return [...menus.slice(start, end).matchAll(/\bw\("[^"]+", "([^"]+)"/g)].map((m) => m[1]);
}

describe("Help's picture of the Review menu", () => {
  it("is described with every item of the menu, in the menu's order", () => {
    const labels = reviewMenuLabels();
    expect(labels.length).toBeGreaterThanOrEqual(9);
    const html = read("src/renderer/help.html");
    const alt = html.match(/<img src="help-images\/review-menu\.png"[^>]* alt="([^"]+)"/)?.[1];
    expect(alt, "the picture in help.html").toBeTruthy();
    let from = 0;
    for (const label of labels) {
      const at = alt!.indexOf(label, from);
      expect(at, `"${label}" in the picture's description, after the items before it`).toBeGreaterThan(-1);
      from = at + label.length;
    }
  });
});
