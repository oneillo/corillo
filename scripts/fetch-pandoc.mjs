// Downloads Pandoc, the separate program Corillo runs to make Word documents,
// into vendor/pandoc/: the program for each kind of Mac processor
// (vendor/pandoc/arm64/pandoc, vendor/pandoc/x64/pandoc), Pandoc's licence
// (COPYING) and copyright notice with where to get its source (COPYRIGHT),
// and the version (VERSION). Skips whatever is already there.
//
//   node scripts/fetch-pandoc.mjs              both processors (for packaging)
//   node scripts/fetch-pandoc.mjs --arch=arm64 just one (tests use this Mac's)
//
// The version and the files' SHA-256 checksums are pinned here. To update,
// change VERSION and the checksums (GitHub lists them on the release page).
import { randomUUID } from "node:crypto";
import { execFileSync } from "node:child_process";
import { chmodSync, existsSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { removeOldParts } from "./pandoc-files.mjs";
import { fetchChecked, option } from "./script-tools.mjs";

const VERSION = "3.13";
const RELEASE = `https://github.com/jgm/pandoc/releases/download/${VERSION}`;
const SOURCE = `https://raw.githubusercontent.com/jgm/pandoc/${VERSION}`;
const PROGRAMS = {
  arm64: { zip: `pandoc-${VERSION}-arm64-macOS.zip`, folder: `pandoc-${VERSION}-arm64`, sha256: "f436d18bebbfb3ddd326597686dacab9fac5dc23bd060495020f35a28a43a7c3" },
  x64: { zip: `pandoc-${VERSION}-x86_64-macOS.zip`, folder: `pandoc-${VERSION}-x86_64`, sha256: "1823278715aa405aaf21b59cde5dc789346aa8d4fc307467f9a9ee84162bedc5" },
};
const NOTICES = {
  COPYING: { url: `${SOURCE}/COPYING.md`, sha256: "3ebfbf9235b049d384cdba5a66a1a3434bb544391e720b76faa8e1b3ee61a4e5" },
  COPYRIGHT: { url: `${SOURCE}/COPYRIGHT`, sha256: "842e33ef01625e93f85bebb8bac83aa570186b7aa77a09971257cc29f8f60740" },
};

const vendor = join(import.meta.dirname, "..", "vendor", "pandoc");

/** Put a file in place in one step, so a second run at the same time never sees half of it. */
function place(target, bytes, mode) {
  mkdirSync(dirname(target), { recursive: true });
  const tmp = `${target}.${randomUUID()}.part`;
  writeFileSync(tmp, bytes);
  if (mode) chmodSync(tmp, mode);
  renameSync(tmp, target);
}

async function fetchProgram(arch) {
  const target = join(vendor, arch, "pandoc");
  if (existsSync(target)) return;
  const { zip, folder, sha256 } = PROGRAMS[arch];
  console.log(`Downloading Pandoc ${VERSION} for ${arch}…`);
  const work = join(tmpdir(), `corillo-pandoc-${randomUUID()}`);
  mkdirSync(work);
  try {
    await fetchChecked(`${RELEASE}/${zip}`, sha256, join(work, zip));
    execFileSync("unzip", ["-q", join(work, zip), `${folder}/bin/pandoc`, "-d", join(work, "x")]);
    place(target, readFileSync(join(work, "x", folder, "bin", "pandoc")), 0o755);
  } finally {
    rmSync(work, { recursive: true, force: true });
  }
}

async function fetchNotices() {
  for (const [name, { url, sha256 }] of Object.entries(NOTICES)) {
    const target = join(vendor, name);
    if (!existsSync(target)) await fetchChecked(url, sha256, target);
  }
  const versionFile = join(vendor, "VERSION");
  if (!existsSync(versionFile) || readFileSync(versionFile, "utf8").trim() !== VERSION) place(versionFile, `${VERSION}\n`);
}

let arches;
try {
  const arch = option(process.argv.slice(2), "arch");
  arches = arch ? [arch] : Object.keys(PROGRAMS);
} catch (error) {
  console.error(`${error.message} Use --arch=arm64 or --arch=x64.`);
  process.exit(1);
}
for (const arch of arches) {
  if (!PROGRAMS[arch]) {
    console.error(`No Pandoc for "${arch}". Use one of: ${Object.keys(PROGRAMS).join(", ")}.`);
    process.exit(1);
  }
}
const installed = existsSync(join(vendor, "VERSION")) ? readFileSync(join(vendor, "VERSION"), "utf8").trim() : null;
if (installed && installed !== VERSION) {
  // A different version is there: replace it rather than mix versions.
  rmSync(vendor, { recursive: true, force: true });
}
// What a stopped fetch left half-written: never shipped (packaging copies Pandoc's files by name), but not kept either.
removeOldParts(vendor);
await fetchNotices();
for (const arch of arches) await fetchProgram(arch);
