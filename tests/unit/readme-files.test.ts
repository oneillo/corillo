// The README, CONTRIBUTING and SECURITY files a stranger reads first: every
// command they give is one package.json has, every link and picture is there,
// and the facts they state (the macOS versions, the downloads' names, the data
// folder, the agent tools' settings files) are the ones the build and the code
// use.
import { describe, it, expect } from "vitest";
import { closeSync, existsSync, openSync, readdirSync, readFileSync, readSync, statSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { TOOLS } from "../../src/main/agent-tools";
import { defaultDataFolder } from "../../src/mcp/socket-path";
import { PANDOC_MIN_MACOS } from "../../src/main/export-prep";
// @ts-expect-error: a plain JavaScript script, with no types of its own
import { ARCHES, dmgName } from "../../scripts/package-names.mjs";

const ROOT = resolve(import.meta.dirname, "..", "..");
const FILES = ["README.md", "CONTRIBUTING.md", "SECURITY.md"];
const read = (file: string) => readFileSync(join(ROOT, file), "utf8");
const pkg = JSON.parse(read("package.json")) as { scripts: Record<string, string>; description: string };
const tilde = (p: string) => p.replace(homedir(), "~");
const escape = (text: string) => text.replace(/[.*+?^${}()|[\]\\/]/g, "\\$&");

/** Corillo's repository (Orlando, 2026-11-17, roadmap Batch 17). */
const REPO = "https://github.com/oneillo/corillo";
/** GitHub's own page on privately reporting a security vulnerability. */
const GITHUB_PRIVATE_REPORTING =
  "https://docs.github.com/en/code-security/security-advisories/guidance-on-reporting-and-writing-information-about-vulnerabilities/privately-reporting-a-security-vulnerability";

/** Every file in the repository: the ones git tracks, or in a copy without git, every file but what's built or installed. */
function repositoryFiles(): string[] {
  try {
    const tracked = execFileSync("git", ["ls-files", "-z"], { cwd: ROOT, encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] })
      .split("\0")
      .filter((f) => f && existsSync(join(ROOT, f)));
    // A copy inside some other repository: git knows nothing of its files.
    if (tracked.includes("README.md")) return tracked;
  } catch {
    // Not in a git checkout: walk the folder instead.
  }
  {
    const skip = new Set(["node_modules", "vendor", "dist", "release", ".git", ".claude", "test-results"]);
    const walk = (dir: string): string[] =>
      readdirSync(join(ROOT, dir), { withFileTypes: true }).flatMap((e) => {
        const path = dir ? `${dir}/${e.name}` : e.name;
        if (e.isDirectory()) return skip.has(e.name) ? [] : walk(path);
        return e.isFile() ? [path] : [];
      });
    return walk("");
  }
}

/** The text of every code block and `inline code` span. */
function codeIn(text: string): string[] {
  const blocks = [...text.matchAll(/```[a-z]*\n([\s\S]*?)```/g)].map((m) => m[1]);
  const rest = text.replace(/```[a-z]*\n[\s\S]*?```/g, "");
  return [...blocks, ...[...rest.matchAll(/`([^`\n]+)`/g)].map((m) => m[1])];
}

/** Every npm command the file gives, as written: "npm ci", "npm test", "npm run package". */
function npmCommands(text: string): string[] {
  return codeIn(text).flatMap((code) => [...code.matchAll(/\bnpm (run [\w:-]+|[a-z]+)/g)].map((m) => `npm ${m[1]}`));
}

/** Every [link](target) and ![picture](target), without its #part. */
function links(text: string): { target: string; anchor: string }[] {
  return [...text.matchAll(/!?\[[^\]]*\]\(([^)\s]+)\)/g)].map((m) => {
    const [target, anchor = ""] = m[1].split("#");
    return { target, anchor };
  });
}

/** A heading's anchor, as GitHub makes it. */
const slug = (heading: string) =>
  heading
    .trim()
    .toLowerCase()
    .replace(/[^\p{L}\p{N} _-]/gu, "")
    .replace(/ /g, "-");

const headingsOf = (text: string) => [...text.matchAll(/^#{1,6} (.+)$/gm)].map((m) => slug(m[1]));

/** The section under a ## heading, up to the next one. */
function section(text: string, heading: string): string {
  const start = text.indexOf(`\n## ${heading}\n`);
  if (start < 0) return "";
  const end = text.indexOf("\n## ", start + 4);
  return text.slice(start, end < 0 ? undefined : end);
}

/** The macOS major version a Mach-O program needs, from its load commands. */
function machoMinimumMacos(file: string): number | null {
  const fd = openSync(file, "r");
  try {
    const header = Buffer.alloc(32);
    readSync(fd, header, 0, 32, 0);
    if (header.readUInt32LE(0) !== 0xfeedfacf) return null; // only a thin 64-bit program
    const count = header.readUInt32LE(16);
    const commands = Buffer.alloc(header.readUInt32LE(20));
    readSync(fd, commands, 0, commands.length, 32);
    for (let i = 0, at = 0; i < count; i++) {
      const cmd = commands.readUInt32LE(at);
      if (cmd === 0x32) return commands.readUInt32LE(at + 12) >>> 16; // LC_BUILD_VERSION: minos
      if (cmd === 0x24) return commands.readUInt32LE(at + 8) >>> 16; // LC_VERSION_MIN_MACOSX
      at += commands.readUInt32LE(at + 4);
    }
    return null;
  } finally {
    closeSync(fd);
  }
}

describe("the files a stranger reads first", () => {
  it("are all there", () => {
    for (const file of FILES) expect(existsSync(join(ROOT, file)), file).toBe(true);
  });

  it("give only commands package.json has", () => {
    for (const file of FILES) {
      for (const command of npmCommands(read(file))) {
        const [, run, name] = /^npm (run )?(.+)$/.exec(command)!;
        const script = run ? name : name === "test" || name === "start" ? name : null;
        if (script) expect(pkg.scripts[script], `${file}: ${command}`).toBeTruthy();
        else if (name === "ci") expect(existsSync(join(ROOT, "package-lock.json")), `${file}: npm ci needs the lock file`).toBe(true);
        else expect.fail(`${file}: "${command}" isn't one of npm's commands this project uses`);
      }
    }
  });

  it("show how to build from source, fetching Pandoc before the tests", () => {
    const commands = npmCommands(read("README.md"));
    for (const needed of ["npm ci", "npm run fetch-pandoc", "npm test", "npm run package"]) expect(commands).toContain(needed);
    expect(commands.indexOf("npm run fetch-pandoc")).toBeLessThan(commands.indexOf("npm test"));
    expect(commands.indexOf("npm ci")).toBeLessThan(commands.indexOf("npm run fetch-pandoc"));
    expect(read("CONTRIBUTING.md")).toMatch(/npm run fetch-pandoc[\s\S]*npm test/);
  });

  it("link only to what is there", () => {
    for (const file of FILES) {
      const text = read(file);
      for (const { target, anchor } of links(text)) {
        if (/^[a-z]+:/i.test(target)) {
          // A web link is checked in form only: the tests don't go online.
          expect(target, `${file}: ${target}`).toMatch(/^https:\/\/[a-z0-9-]+(\.[a-z0-9-]+)+(\/[^\s<>"]*)?$/i);
          const url = new URL(target);
          expect(url.protocol, target).toBe("https:");
          expect(url.username + url.password, target).toBe("");
          expect(url.href.replace(/\/$/, ""), target).toBe(target.replace(/\/$/, ""));
          continue;
        }
        const path = target ? join(dirname(join(ROOT, file)), decodeURIComponent(target)) : join(ROOT, file);
        expect(existsSync(path), `${file}: ${target}`).toBe(true);
        if (anchor && path.endsWith(".md")) expect(headingsOf(readFileSync(path, "utf8")), `${file}: ${target}#${anchor}`).toContain(anchor);
      }
    }
  });

  it("name only files that are there", () => {
    // A file named in `code`, such as `dependencies.md`, is one a stranger
    // will look for. In the public copy, a private file named here fails this.
    for (const file of FILES) {
      for (const code of codeIn(read(file))) {
        if (!/^[\w.-]+(\/[\w.-]+)*\.(md|mjs|cjs|ts|json|sh)$/.test(code)) continue;
        expect(existsSync(join(ROOT, code)), `${file} names ${code}`).toBe(true);
      }
    }
  });

  it("have at most four light pictures, each in docs/, small and shown", () => {
    const readme = read("README.md");
    const shown = links(readme)
      .map((l) => l.target)
      .filter((t) => /\.(png|jpe?g|gif|webp|svg)$/i.test(t));
    expect(shown.length).toBeGreaterThanOrEqual(1);
    expect(shown.length).toBeLessThanOrEqual(4);
    for (const picture of shown) {
      expect(picture, "pictures live in docs/").toMatch(/^docs\//);
      // Retina, whole-window pictures, reduced to 256 colours (publish day, 2026-11-22).
      expect(statSync(join(ROOT, picture)).size, picture).toBeLessThan(200 * 1024);
    }
    const inDocs = readdirSync(join(ROOT, "docs")).filter((f) => !f.startsWith("."));
    for (const f of inDocs) expect(shown, `docs/${f} isn't shown in the README`).toContain(`docs/${f}`);
    // A picture says what it shows, for a screen reader.
    for (const m of readme.matchAll(/!\[([^\]]*)\]\(/g)) expect(m[1].trim().length).toBeGreaterThan(10);
  });

  it("say which macOS the build needs, read from the build", () => {
    const needs = section(read("README.md"), "What it needs");
    expect(needs).not.toBe("");
    const plist = readFileSync(join(ROOT, "node_modules/electron/dist/Electron.app/Contents/Info.plist"), "utf8");
    // The app keeps Electron's minimum unless the packaging script sets its own.
    const own = /LSMinimumSystemVersion:\s*"(\d+)/.exec(read("scripts/package-mac.mjs"));
    const electron = Number((own ?? /<key>LSMinimumSystemVersion<\/key>\s*<string>(\d+)/.exec(plist)!)[1]);
    // The first version it names is the one Corillo itself needs.
    expect(Number(/macOS (\d+)/.exec(needs)?.[1])).toBe(electron);
    // Pandoc, inside the app, may need a later macOS than Corillo itself.
    const pandoc = ["arm64", "x64"].map((a) => join(ROOT, "vendor/pandoc", a, "pandoc")).find(existsSync);
    if (pandoc) {
      const needsPandoc = machoMinimumMacos(pandoc);
      expect(needsPandoc).not.toBeNull();
      const said = needs.split("\n").some((line) => /Word/.test(line) && new RegExp(`macOS ${needsPandoc}\\b`).test(line));
      if (needsPandoc! > electron) expect(said, `say Word needs macOS ${needsPandoc}`).toBe(true);
      // The app says the same where the person opens or exports a Word document.
      expect(PANDOC_MIN_MACOS, "the macOS Corillo says Word needs").toBe(needsPandoc);
    }
    expect(needs).toMatch(/Apple silicon/);
    expect(needs).toMatch(/Intel/);
  });

  it("name the downloads the packaging script makes, one for each kind of Mac, and how to tell which", () => {
    const install = section(read("README.md"), "Install");
    expect(install).not.toBe("");
    const named = [...install.matchAll(/`(Corillo-[^`]*\.dmg)`/g)].map((m) => m[1]);
    expect(named.sort()).toEqual((ARCHES as string[]).map((arch) => dmgName("<version>", arch)).sort());
    // A stranger finds which kind of Mac they have the way Apple's page says.
    expect(install).toMatch(/About This Mac/);
    expect(install).toMatch(/Chip/);
    expect(install).toMatch(/Processor/);
  });

  it("give the first open for every macOS Corillo runs on, without turning off the Mac's checks", () => {
    const install = section(read("README.md"), "Install");
    // Apple's steps differ: macOS 13 and 14 also have Control-click > Open
    // in Finder; from macOS 15 it's Privacy & Security > Open Anyway only.
    expect(install).toMatch(/macOS (13 )?Ventura/);
    expect(install).toMatch(/macOS (14 )?Sonoma/);
    expect(install).toMatch(/macOS (15 )?Sequoia/);
    expect(install).toMatch(/Control-click/);
    expect(install).toMatch(/Open Anyway/);
    expect(install).toContain("https://support.apple.com/guide/mac-help/open-a-mac-app-from-an-unknown-developer-mh40616/mac");
    // After Open Anyway the warning comes back with an Open button (Apple's "Safely open apps on your Mac", 102445; review B15-07).
    expect(install).toContain("https://support.apple.com/en-us/102445");
    const sequoia = install.slice(install.indexOf("macOS 15 Sequoia"), install.indexOf("macOS 13 Ventura"));
    expect(sequoia).toMatch(/warning (appears|comes back) again, click Open\b/);
    const alternative = install.slice(install.indexOf("Or use System Settings instead"));
    expect(alternative).toMatch(/Open Anyway[^.]*\.[^]*warning (appears|comes back) again, click Open\b/);
    for (const file of FILES) expect(read(file), file).not.toMatch(/\b(xattr|spctl)\b/);
  });

  it("say how to make the Intel app on an Apple silicon Mac", () => {
    const build = section(read("README.md"), "Build from source");
    expect(build).toContain("npm run package -- --arch=x64");
    expect(build).not.toMatch(/made on an Intel Mac/);
  });

  it("name the data folder and every settings file Connect writes, as the code does", () => {
    const readme = read("README.md");
    expect(readme).toContain(tilde(defaultDataFolder("darwin", {})));
    const uninstall = section(readme, "Uninstall");
    for (const tool of TOOLS) {
      expect(uninstall, tool.name).toContain(tool.name);
      expect(uninstall, tool.name).toContain(tilde(tool.file(homedir())));
    }
  });

  it("leave no line for the owner to fill in, in any file in the repository", () => {
    // The public copy's check refuses a line that starts with this marker.
    // Orlando filled in the last two on 2026-11-17 (roadmap Batch 17, item 2):
    // the repository's address and how to report a security problem.
    const marker = ["FILL-IN", "(owner)"].join("");
    const line = new RegExp(`^[\\s>*#-]*${marker.replace(/[()]/g, "\\$&")}`, "m");
    const files = repositoryFiles().filter((f) => !/\.(png|jpe?g|gif|webp|ico|icns|ttf|woff2?|gz|zip|dmg|docx|pdf)$/i.test(f));
    expect(files).toContain("README.md");
    for (const file of files) expect(line.test(readFileSync(join(ROOT, file), "utf8")), file).toBe(false);
    for (const file of FILES) expect(read(file), file).not.toContain(marker);
  });

  it("link the Releases page and the issues to the repository's one address", () => {
    const readme = read("README.md");
    expect(readme).toContain(`[Releases page](${REPO}/releases)`);
    expect(section(readme, "Install")).toContain(`[Releases page](${REPO}/releases)`);
    expect(section(readme, "When something is wrong")).toMatch(new RegExp(`\\[issue\\]\\(${escape(REPO)}/issues\\)`));
    // Every link to GitHub in these files is to this repository.
    for (const file of FILES)
      for (const { target } of links(read(file))) if (/^https:\/\/github\.com\//.test(target)) expect(target, file).toMatch(new RegExp(`^${escape(REPO)}(/|$)`));
  });

  it("send a security problem through GitHub's private reporting, as GitHub's own page describes it, with no email", () => {
    const security = read("SECURITY.md");
    expect(security).toMatch(/private vulnerability reporting/);
    expect(security).toContain(REPO);
    // GitHub's steps (docs.github.com, read 2026-11-17): the Security and
    // quality tab under the repository's name, then Report a vulnerability,
    // then Submit report.
    expect(security).toContain(GITHUB_PRIVATE_REPORTING);
    expect(security).toMatch(/Security and quality/);
    expect(security).toMatch(/Report a vulnerability/);
    expect(security).toMatch(/Submit report/);
    expect(security.indexOf("Security and quality")).toBeLessThan(security.indexOf("Report a vulnerability"));
    expect(security.indexOf("Report a vulnerability")).toBeLessThan(security.indexOf("Submit report"));
    // No email: no address and no mailto link, here or in the README.
    for (const file of FILES) {
      expect(read(file), file).not.toMatch(/mailto:/);
      expect(read(file), file).not.toMatch(/[\w.+-]+@[\w-]+\.[\w.]+/);
    }
    // Fixes go into the latest release only.
    expect(security).toMatch(/Fixes go into the latest release/);
  });

  it("take pull requests, and say so in CONTRIBUTING", () => {
    expect(read("CONTRIBUTING.md")).toMatch(/pull request/);
  });

  it("say beside the agent tools Connect offers that only Claude Code has been tried in real use, in the README and Help", () => {
    // The README names the Claude app too, tried by Orlando on publish day (2026-11-22); Help catches up at the next build.
    const tried = /Of these, only Claude Code (and Claude Desktop have|has) been tried in real use so far\./;
    const needs = section(read("README.md"), "What it needs");
    const toolsLine = needs.split("\n").find((l) => /connects with one click/.test(l));
    expect(toolsLine).toBeDefined();
    for (const tool of TOOLS) expect(toolsLine, tool.name).toContain(tool.name);
    expect(toolsLine).toMatch(tried);
    // Help lists the same tools, so it says the same, in the same paragraph.
    const help = readFileSync(join(ROOT, "src/renderer/help.html"), "utf8");
    const helpLine = help.split("\n").find((l) => /with one click/.test(l) && /GitHub Copilot CLI/.test(l));
    expect(helpLine).toBeDefined();
    expect(helpLine).toMatch(tried);
  });

  it("say Word needs macOS 15 Sequoia, beside what Corillo itself needs", () => {
    const needs = section(read("README.md"), "What it needs");
    const word = needs.split("\n").find((l) => /Word/.test(l));
    expect(word).toMatch(new RegExp(`macOS ${PANDOC_MIN_MACOS} Sequoia or later`));
    expect(PANDOC_MIN_MACOS).toBe(15);
  });

  it("describe Corillo in package.json as the README does: a Mac app for Markdown with AI agents", () => {
    expect(pkg.description).toMatch(/\bMac\b/);
    expect(pkg.description).toMatch(/Markdown/);
    expect(pkg.description).toMatch(/AI agents/);
  });
});
