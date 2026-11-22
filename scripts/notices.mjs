// Writes dist/third-party-notices.txt: every package that ends up inside
// Corillo's built files, plus Electron, each with the full text of its
// licence, then its NOTICE file when it has one (C21-22). The About window shows it, and it ships inside the app.
import { readFileSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { licenceFileIn, noticeFileIn, packageDirOf } from "./licence-file.mjs";

const RULE = "=".repeat(72);
/** The checkout, which every path here is taken from, wherever the build is run from. */
const ROOT = join(import.meta.dirname, "..");

function licenceText(dir) {
  const file = licenceFileIn(dir);
  return file ? readFileSync(join(dir, file), "utf8").trim() : null;
}

function noticeText(dir) {
  const file = noticeFileIn(dir);
  return file ? readFileSync(join(dir, file), "utf8").trim() : null;
}

function entry(dir) {
  const pkg = JSON.parse(readFileSync(join(dir, "package.json"), "utf8"));
  const licence = typeof pkg.license === "string" ? pkg.license : pkg.license?.type;
  const home = typeof pkg.repository === "string" ? pkg.repository : pkg.repository?.url;
  return {
    name: pkg.name,
    version: pkg.version,
    licence: licence ? licence.replace(/^\((.*)\)$/, "$1") : "see the licence text",
    home,
    text: licenceText(dir),
    notice: noticeText(dir),
  };
}

/** The notices, from the build's list of bundled files. Returns how many packages it lists. */
export function writeNotices(bundledFiles, outFile = join(ROOT, "dist", "third-party-notices.txt")) {
  const dirs = new Set(["node_modules/electron"]);
  for (const f of bundledFiles) {
    const d = packageDirOf(f);
    if (d) dirs.add(d);
  }
  const entries = [...dirs].map((d) => entry(resolve(ROOT, d))).sort((a, b) => a.name.localeCompare(b.name));
  const { version } = JSON.parse(readFileSync(join(ROOT, "package.json"), "utf8"));

  const out = [
    `Third-party software in Corillo ${version}`,
    "",
    "Corillo is built with the open source software listed below. Each one is",
    "used under its own licence, and the full text of each licence follows its",
    "name.",
    "",
    "Listed separately, with their own notices:",
    "- Chromium and the other parts that come inside Electron (LICENSES.chromium.html).",
    "- Pandoc, which Corillo runs as a separate program to make Word documents",
    "  (its licence is in the pandoc folder, with a link to its source code).",
    "- The Literata font (SIL Open Font License 1.1), whose licence is at the",
    "  end of this file.",
    "",
    `${entries.length} packages:`,
    ...entries.map((e) => `- ${e.name} ${e.version} (${e.licence})`),
  ];
  for (const e of entries) {
    out.push("", RULE, `${e.name} ${e.version}`, `Licence: ${e.licence}`);
    if (e.home) out.push(`Source: ${e.home.replace(/^git\+/, "").replace(/\.git$/, "")}`);
    out.push("", e.text ?? "This package came with no licence text beyond the name of its licence, given above.");
    if (e.notice) out.push("", "Its NOTICE file:", "", e.notice);
  }
  // The page font, used under the SIL Open Font License, which asks that its
  // licence travel with it.
  const ofl = readFileSync(join(ROOT, "src", "renderer", "fonts", "Literata-OFL.txt"), "utf8").trim();
  out.push("", RULE, "Literata (font)", "Licence: SIL Open Font License 1.1", "Source: https://github.com/googlefonts/literata", "", ofl);
  writeFileSync(outFile, out.join("\n") + "\n");
  return entries.length;
}
