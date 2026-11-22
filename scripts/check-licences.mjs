// Fails if anything Corillo ships carries a licence outside the approved list.
// Checks every package that actually ends up inside the built app (from the
// build's list of bundled files), plus Electron itself.
import { readFileSync, existsSync, realpathSync } from "node:fs";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { licenceFileIn, packageDirOf } from "./licence-file.mjs";

// Permissive licences allowed without asking (see CONTRIBUTING.md, "Licences").
const ALLOWED = new Set([
  "MIT", "BSD-2-Clause", "BSD-3-Clause", "Apache-2.0", "ISC", "Zlib",
  "0BSD", "Unlicense", "CC0-1.0", "BlueOak-1.0.0",
]);

// Some packages state their licence only in a licence file, not package.json.
function licenceFromFile(dir) {
  const file = licenceFileIn(dir);
  if (!file) return null;
  const text = readFileSync(join(dir, file), "utf8");
  if (/^\s*(the )?mit license/i.test(text) || /permission is hereby granted, free of charge/i.test(text)) return "MIT";
  return null;
}

function licenceOf(dir) {
  const pkg = JSON.parse(readFileSync(join(dir, "package.json"), "utf8"));
  const lic = typeof pkg.license === "string" ? pkg.license : pkg.license?.type;
  return { name: pkg.name, version: pkg.version, licence: lic ?? licenceFromFile(dir) ?? "NONE" };
}

/**
 * Whether a licence, as package.json writes it, is allowed: of a choice
 * ("MIT OR Apache-2.0") one option must be, and of terms that all hold
 * ("(MIT OR X) AND Y") every one. Anything it can't read is not.
 */
export function ok(licence) {
  const words = licence.match(/[()]|[^\s()]+/g) ?? [];
  let at = 0;
  const either = () => {
    let yes = both();
    while (words[at] === "OR") {
      at++;
      yes = both() || yes;
    }
    return yes;
  };
  const both = () => {
    let yes = one();
    while (words[at] === "AND") {
      at++;
      yes = one() && yes;
    }
    return yes;
  };
  const one = () => {
    const word = words[at++];
    if (word !== "(") return word !== undefined && ALLOWED.has(word);
    const yes = either();
    return words[at++] === ")" && yes;
  };
  return either() && at === words.length;
}

// Run as a script (the tests import ok alone).
if (process.argv[1] && realpathSync(process.argv[1]) === realpathSync(fileURLToPath(import.meta.url))) {
  // The checkout's, wherever it's run from.
  const root = join(import.meta.dirname, "..");
  const listFile = join(root, "dist", "bundled-files.json");
  if (!existsSync(listFile)) {
    console.error("Run the build first (npm run build).");
    process.exit(1);
  }
  const dirs = new Set();
  for (const f of JSON.parse(readFileSync(listFile, "utf8"))) {
    const d = packageDirOf(f);
    if (d) dirs.add(d);
  }
  // Electron's own licence is MIT. Chromium's LGPL and MPL parts inside it are
  // approved as "Chromium as Electron ships it, with its notices" (Orlando,
  // 2026-11-17, widening his approval of 2026-11-08 of Chromium's LGPL and MPL
  // parts): unmodified, with Electron's licence and Chromium's notices in the
  // app, which packaging puts there and each download's check looks for.
  dirs.add("node_modules/electron");

  const rows = [...dirs].map((d) => licenceOf(resolve(root, d))).sort((a, b) => a.name.localeCompare(b.name));
  const bad = rows.filter((r) => !ok(r.licence));
  for (const r of rows) console.log(`${ok(r.licence) ? "ok " : "BAD"}  ${r.name}@${r.version}  ${r.licence}`);
  if (bad.length) {
    console.error(`\n${bad.length} package(s) have a licence that is not on the approved list in CONTRIBUTING.md ("Licences").`);
    process.exit(1);
  }
  console.log(`\nAll ${rows.length} shipped packages have approved licences.`);
}
