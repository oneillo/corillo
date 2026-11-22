// The in-app help (src/renderer/help.html) and the README: links that lead
// somewhere, pictures that exist at the right size, places in the app that
// open Help at a page that's there, and plain punctuation.
import { describe, expect, it } from "vitest";
import { existsSync, readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";

const ROOT = join(import.meta.dirname, "..", "..");
const read = (file: string) => readFileSync(join(ROOT, file), "utf8");
const html = read("src/renderer/help.html");
const ids = new Set([...html.matchAll(/\sid="([^"]+)"/g)].map((m) => m[1]));
const pages = [...html.matchAll(/<section id="([^"]+)" class="help-page"/g)].map((m) => m[1]);
const EM_DASH = String.fromCharCode(0x2014);

describe("Help", () => {
  it("has a sidebar link for every page, in the same order as the pages", () => {
    const sidebar = [...html.matchAll(/<a href="#([^"]+)" data-page="([^"]+)">/g)];
    expect(sidebar.map((m) => m[1])).toEqual(pages);
    for (const m of sidebar) expect(m[2]).toBe(m[1]);
    expect(pages).toEqual(["start", "first", "agents", "several", "changes", "sharing", "editing", "markdown", "shortcuts", "manual", "trouble"]);
  });

  it("links only to pages and sections that exist", () => {
    const targets = [...html.matchAll(/href="#([^"]+)"/g)].map((m) => m[1]);
    expect(targets.length).toBeGreaterThan(pages.length);
    for (const t of targets) expect(ids, `#${t}`).toContain(t);
  });

  it("gives every section heading an id, so search and links can find it", () => {
    // Headings inside a Markdown example are part of the example, not sections.
    for (const line of html.split("\n").filter((l) => l.includes("<h2"))) {
      if (line.includes('class="md-look')) continue;
      expect(line).toMatch(/^ {2}<h2 id="[a-z][a-z0-9-]+">/);
    }
  });

  it("is opened from the app only at pages and sections that exist", () => {
    const places: string[] = [];
    const folder = join(ROOT, "src", "renderer");
    for (const file of readdirSync(folder).filter((f) => f.endsWith(".ts"))) {
      for (const m of readFileSync(join(folder, file), "utf8").matchAll(/help\.open\("([^"]+)"\)/g)) places.push(m[1]);
    }
    expect(places).toEqual(expect.arrayContaining(["first", "manual", "agents-turns", "agents-comments", "markdown"]));
    for (const p of places) expect(ids, p).toContain(p);
  });

  it("shows only pictures that are in the repo, stored at twice their size so they're sharp on a Retina screen", () => {
    // (A picture in a Markdown example also says where the example's file would be.)
    const images = [...html.matchAll(/<img src="([^"]+)" width="(\d+)" height="(\d+)" alt="([^"]+)"(?: data-src="[^"]+")?>/g)];
    expect(images.length).toBe((html.match(/<img /g) ?? []).length); // every picture has a size and a description
    expect(images.length).toBeGreaterThanOrEqual(10);
    const used = new Set<string>();
    for (const [, src, width, height] of images) {
      expect(src).toMatch(/^help-images\/[a-z-]+\.png$/);
      const file = join(ROOT, "src", "renderer", src);
      expect(existsSync(file), src).toBe(true);
      const png = readFileSync(file);
      const size = { w: png.readUInt32BE(16), h: png.readUInt32BE(20) };
      expect(Math.abs(size.w - 2 * Number(width)), `${src} width`).toBeLessThanOrEqual(1);
      expect(Math.abs(size.h - 2 * Number(height)), `${src} height`).toBeLessThanOrEqual(1);
      expect(png.length, `${src} is small`).toBeLessThan(80_000);
      used.add(src.replace("help-images/", ""));
    }
    // No leftover pictures that nothing shows.
    expect(readdirSync(join(ROOT, "src", "renderer", "help-images")).sort()).toEqual([...used].sort());
  });

  it("has only pictures that npm run help-pictures retakes, so none can go stale", () => {
    const script = read("tests/pictures/help-pictures.spec.ts");
    const retaken = new Set([...script.matchAll(/picture\([\w.]+, "([a-z-]+)"/g)].map((m) => `${m[1]}.png`));
    expect(readdirSync(join(ROOT, "src", "renderer", "help-images")).sort()).toEqual([...retaken].sort());
  });

  it("is copied into the built app, pictures included", () => {
    const build = read("scripts/build.mjs");
    expect(build).toContain('"help.html"');
    expect(build).toContain('cpSync("src/renderer/help-images", "dist/help-images"');
  });

  it("lists each shortcut with where it comes from, so a test can check it against the app", () => {
    const rows = [...html.matchAll(/<tr data-shortcut="([^"]+)"><td>[^<]+<\/td><td><kbd>([^<]+)<\/kbd><\/td><\/tr>/g)];
    expect(rows.length).toBe((html.match(/<tr data-shortcut=/g) ?? []).length);
    expect(rows.length).toBeGreaterThan(15);
    for (const [, source] of rows) expect(source).toMatch(/^(menu:[a-z0-9-]+|menu-label:.+|toolbar:[A-Z][a-z]+|post)$/);
  });

  it("says where the comments panel and the Markdown view are described that their widths can be dragged", () => {
    const section = (id: string) => new RegExp(`<h2 id="${id}">[\\s\\S]*?(?=<h2 |</section>)`).exec(html)![0];
    expect(section("agents-comments")).toContain("drag its left edge");
    expect(section("start-views")).toContain("drag the line between the text and the preview");
  });

  it("says where an agent's note shows, how it's put away, and that History keeps it (roadmap Batch 2, item 3)", () => {
    const section = (id: string) => new RegExp(`<h2 id="${id}">[\\s\\S]*?(?=<h2 |</section>)`).exec(html)![0];
    expect(section("agents-review")).toContain("Note from Claude");
    expect(section("agents-review")).toContain("<strong>Done</strong> on the note");
    expect(section("changes-history")).toContain("the agent's note");
    // Agents suggest a change outside what they were asked rather than make it (roadmap Batch 9, item 11; review B9-04).
    expect(section("agents-review")).not.toContain("a change you didn't ask for");
    expect(section("agents-review")).toContain("such as a change it suggests beyond what you asked");
  });

  it("and the README say Kiro CLI works by hand, with Claude Desktop's settings in its own file (2026-11-22)", () => {
    const kiro = "~/.kiro/settings/mcp.json";
    const page = html.split('<h2 id="manual-kiro">')[1]?.split("</p>")[0] ?? "";
    expect(page).toContain("same settings as Claude Desktop");
    expect(page).toContain(kiro);
    expect(html).toContain('<a href="#manual-kiro">Kiro CLI</a>');
    const readme = read("README.md");
    const toolsLine = readme.split("\n").find((l) => /connects with one click/.test(l))!;
    expect(toolsLine).toContain("Kiro CLI");
    expect(toolsLine).toContain(kiro);
    expect(readme.split("## Uninstall")[1]).toContain(`Kiro CLI, if you connected it by hand: \`${kiro}\``);
  });

  it("and the README hand a document back with Send to Claude, or in the chat where no agent waits", () => {
    const handBack = read("README.md").split("\n").find((line) => line.startsWith("**Handing a document back.**"))!;
    expect(handBack).toContain("Send to Claude");
    expect(handBack).toContain("Copy for Claude");
  });

  it("keeps each mark to type, such as \"[ ] \", on one line, its closing quote included", () => {
    // A mark to type is a sign or two and a space: "- ", "1. ", "[ ] ", "> ". The space must not break.
    const typed = [...html.matchAll(/"([^"<\n]{1,16})"/g)]
      .map((m) => m[1])
      .filter((t) => /^(\S{1,3}|\[[ x]\]) $/.test(t.replaceAll("&nbsp;", " ").replaceAll("&gt;", ">")));
    expect(typed).toEqual(expect.arrayContaining(["-&nbsp;", "1.&nbsp;", "#&nbsp;", "&gt;&nbsp;", "[&nbsp;]&nbsp;", "[x]&nbsp;"]));
    for (const mark of typed) expect(mark, mark).not.toMatch(/ /);
  });

  it("and the README use no em dashes", () => {
    for (const file of ["src/renderer/help.html", "src/renderer/help.ts", "README.md"]) {
      expect(read(file).includes(EM_DASH), file).toBe(false);
    }
  });

  // Review of Batch 24, R24-6: one claim about which tools wait, and no "…." in running text.
  it("says one thing about which agent tools wait, and never ends a sentence with an ellipsis and a full stop", () => {
    const text = html.replace(/<[^>]+>/g, "");
    expect(text).toContain("Only Claude Code waits");
    expect(text).not.toMatch(/Some agent tools, such as Claude Code, can wait/);
    expect(text).toContain("choose Export to Word or Export to PDF.");
    expect(text).not.toContain("….");
  });
});
