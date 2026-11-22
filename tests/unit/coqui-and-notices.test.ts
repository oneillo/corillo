// The coquí drawings and the third-party notices file the build writes.
import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
// @ts-expect-error: a plain JavaScript script, with no types of its own
import { licenceFileIn, noticeFileIn, packageDirOf } from "../../scripts/licence-file.mjs";

const ROOT = join(import.meta.dirname, "..", "..");
const read = (file: string) => readFileSync(join(ROOT, file), "utf8");
const pathData = (svg: string) => [...svg.matchAll(/\sd="([^"]+)"/g)].map((m) => m[1]);

describe("the coquí", () => {
  it("on the start screen is the same drawing as the mark in assets/coqui-mark.svg", () => {
    const html = read("src/renderer/index.html");
    const mark = read("assets/coqui-mark.svg");
    expect(pathData(mark).length).toBeGreaterThan(2);
    for (const d of pathData(mark)) expect(html).toContain(d);
    expect(html).toContain(/viewBox="([^"]+)"/.exec(mark)![1]);
  });

  it("mark takes the colour of the text around it, so it works in dark mode", () => {
    const mark = read("assets/coqui-mark.svg");
    expect(mark).toContain('fill="currentColor"');
    expect(mark).not.toMatch(/fill="#(?!fff"|000")/); // no fixed colours besides the eye cut-outs
  });

  it("app icon sits on Apple's icon grid: a 824-unit tile, 100 units in from each edge of 1024", () => {
    for (const file of ["assets/corillo-icon.svg", "assets/corillo-icon-small.svg"]) {
      const svg = read(file);
      expect(svg).toContain('viewBox="0 0 1024 1024"');
      const tile = /id="tile"[^>]*\sd="([^"]+)"/.exec(svg)![1];
      const numbers = tile.match(/-?\d+(\.\d+)?/g)!.map(Number);
      expect(Math.min(...numbers)).toBe(100);
      expect(Math.max(...numbers)).toBe(924);
    }
  });

  it("app icon is blue-grey on a pale limestone tile, from the Adoquín palette", () => {
    const svg = read("assets/corillo-icon.svg");
    expect(svg).toMatch(/id="tile" fill="#E6ECEB"/);
    expect(svg).toMatch(/id="body" fill="#4F6D7A"/);
  });
});

describe("the third-party notices", () => {
  const notices = read("dist/third-party-notices.txt");
  const bundled: string[] = JSON.parse(read("dist/bundled-files.json"));

  it("list every package that ends up in Corillo's built files, and Electron", () => {
    const names = new Set(["electron"]);
    for (const f of bundled) {
      const parts = f.split("/");
      const i = parts.lastIndexOf("node_modules");
      if (i >= 0) names.add(parts.slice(i + 1, i + (parts[i + 1].startsWith("@") ? 3 : 2)).join("/"));
    }
    for (const name of names) expect(notices).toContain(`\n- ${name} `);
    const count = Number(/^(\d+) packages:/m.exec(notices)![1]);
    expect(count).toBeGreaterThanOrEqual(names.size);
  });

  it("give each package's full licence text, not just its name", () => {
    const sections = notices.split(/\n={72}\n/).slice(1).filter((s) => !s.includes("(font)\n"));
    expect(sections.length).toBe(Number(/^(\d+) packages:/m.exec(notices)![1]));
    for (const s of sections) {
      expect(s).toMatch(/^.+ \d+\.\d+.*\nLicence: .+/);
      expect(s.length).toBeGreaterThan(300);
    }
  });

  it("include the page font's licence in full, as the SIL Open Font License asks", () => {
    const font = notices.split(/\n={72}\n/).find((s) => s.startsWith("Literata (font)\n"));
    expect(font).toMatch(/^Literata \(font\)\nLicence: SIL Open Font License 1\.1\n/);
    expect(font).toContain("Copyright 2017 The Literata Project Authors");
    expect(font).toContain("THE FONT SOFTWARE IS PROVIDED \"AS IS\"");
  });

  it("show each shipped package's NOTICE file after its licence, es-toolkit's (Lodash's notice) among them (C21-22)", () => {
    const dirs = new Set<string>(["node_modules/electron"]);
    for (const f of bundled) if (packageDirOf(f)) dirs.add(packageDirOf(f));
    const sections = notices.split(/\n={72}\n/).slice(1);
    const withNotice = [...dirs].filter((d) => noticeFileIn(join(ROOT, d)));
    // In a worktree the build names packages through the link to the main checkout's node_modules.
    expect(withNotice.some((d) => d.endsWith("node_modules/es-toolkit"))).toBe(true);
    for (const dir of withNotice) {
      const { name, version } = JSON.parse(read(`${dir}/package.json`));
      const section = sections.find((s) => s.startsWith(`${name} ${version}\n`))!;
      const licence = read(`${dir}/${licenceFileIn(join(ROOT, dir))}`).trim();
      const notice = read(`${dir}/${noticeFileIn(join(ROOT, dir))}`).trim();
      expect(section.indexOf(notice), dir).toBeGreaterThan(section.indexOf(licence));
      expect(section.indexOf(licence), dir).toBeGreaterThan(0);
    }
    const esToolkit = sections.find((s) => s.startsWith("es-toolkit "))!;
    expect(esToolkit).toContain("Its NOTICE file:\n\nes-toolkit\n");
    expect(esToolkit).toContain("Lodash copyright notice and MIT permission notice");
  });

  it("point to Chromium's and Pandoc's own notices", () => {
    expect(notices).toContain("LICENSES.chromium.html");
    expect(notices).toContain("Pandoc");
  });
});
