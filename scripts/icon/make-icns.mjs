// Makes Corillo's Mac icon file (.icns) from the SVG drawings in assets/:
// draws every size macOS asks for with Electron, then packs them with
// iconutil, which comes with macOS.
//   node scripts/icon/make-icns.mjs [out.icns]
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import electron from "electron";

const here = fileURLToPath(new URL(".", import.meta.url));
const ICON = resolve(here, "../../assets/corillo-icon.svg");
// The two smallest sizes use a bolder drawing, so the frog still reads at 16 pixels.
const SMALL_ICON = resolve(here, "../../assets/corillo-icon-small.svg");

// The pictures inside a Mac .icns, by file name, and their size in pixels.
const ICONSET = [
  ["icon_16x16.png", 16],
  ["icon_16x16@2x.png", 32],
  ["icon_32x32.png", 32],
  ["icon_32x32@2x.png", 64],
  ["icon_128x128.png", 128],
  ["icon_128x128@2x.png", 256],
  ["icon_256x256.png", 256],
  ["icon_256x256@2x.png", 512],
  ["icon_512x512.png", 512],
  ["icon_512x512@2x.png", 1024],
];

/** Draw SVGs as PNGs: jobs are { svg, out, size }. */
export function renderPngs(jobs) {
  const work = mkdtempSync(join(tmpdir(), "corillo-icon-"));
  try {
    const list = join(work, "jobs.json");
    writeFileSync(list, JSON.stringify(jobs));
    const env = { ...process.env };
    delete env.ELECTRON_RUN_AS_NODE;
    execFileSync(electron, [join(here, "render.cjs"), list], { stdio: "inherit", env });
  } finally {
    rmSync(work, { recursive: true, force: true });
  }
}

export function makeIcns(outFile) {
  const work = mkdtempSync(join(tmpdir(), "corillo-iconset-"));
  try {
    const set = join(work, "Corillo.iconset");
    mkdirSync(set);
    renderPngs(ICONSET.map(([name, size]) => ({ svg: size <= 32 ? SMALL_ICON : ICON, out: join(set, name), size })));
    execFileSync("iconutil", ["--convert", "icns", "--output", resolve(outFile), set]);
  } finally {
    rmSync(work, { recursive: true, force: true });
  }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  makeIcns(process.argv[2] ?? "Corillo.icns");
}
