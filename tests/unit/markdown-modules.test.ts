// markdown.ts split into modules with one job each (Batch 19 item 6, R16-5): the
// public names stay where every caller finds them, and the modules depend on
// each other one way only, so none starts before what it uses.
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import * as markdown from "../../src/core/markdown";

const CORE = join(import.meta.dirname, "..", "..", "src", "core");
// Lowest first: each may import only the ones before it.
const ORDER = ["markdown-tokens", "markdown-alt", "markdown-read", "markdown-inline", "markdown-blocks", "markdown-apart", "markdown"];
const source = (name: string) => readFileSync(join(CORE, `${name}.ts`), "utf8");

describe("markdown.ts in modules", () => {
  it("still gives every caller the names it used to", () => {
    for (const name of ["markdownTokens", "lineBreakLines", "parseMarkdown", "isEmptyLine", "serializeMarkdown", "markdownLayout", "setSerializerFault"]) {
      expect(typeof (markdown as Record<string, unknown>)[name], name).toBe("function");
    }
  });

  it("has modules that import only the ones below them", () => {
    ORDER.forEach((name, i) => {
      const used = [...source(name).matchAll(/from "\.\/(markdown[\w-]*)"/g)].map((m) => m[1]);
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

  it("keeps markdown.ts under 700 lines", () => {
    expect(source("markdown").split("\n").length).toBeLessThan(700);
  });

  it("reads and writes a document the same through the modules", () => {
    const text = "# Notes\n\n- one\n- two\n\n| a | b |\n| - | - |\n| 1 | 2 |\n\nSee [the site][s].\n\n[s]: https://example.com\n";
    const { doc, source: kept } = markdown.parseMarkdown(text);
    expect(markdown.serializeMarkdown(doc, kept)).toBe(text);
  });
});
