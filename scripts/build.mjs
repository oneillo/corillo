// Builds Corillo into dist/: the main process, the window bridge and the
// window code, plus a list of every package that ends up inside, for the
// licence check.
import { build } from "esbuild";
import { createHash } from "node:crypto";
import { cpSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { writeNotices } from "./notices.mjs";

// Every path below is the checkout's, wherever the build is run from.
const root = join(import.meta.dirname, "..");
process.chdir(root);

rmSync("dist", { recursive: true, force: true });
mkdirSync("dist");

// The diagram engine can use an optional layout library (elkjs) whose licence
// (EPL or GPL) isn't on the approved list, so it's left out: a diagram that
// asks for that layout shows a message instead.
const leaveOutElk = {
  name: "leave-out-elk",
  setup(b) {
    b.onResolve({ filter: /^elkjs(\/|$)/ }, () => ({ path: "elkjs", namespace: "left-out" }));
    b.onLoad({ filter: /.*/, namespace: "left-out" }, () => ({
      contents:
        'export default class ELK { constructor() { throw new Error("This diagram asks for the ELK layout, which Corillo doesn\'t include. Remove the layout setting to draw it."); } }',
      loader: "js",
    }));
  },
};

const common = { absWorkingDir: root, bundle: true, sourcemap: true, metafile: true, logLevel: "warning", plugins: [leaveOutElk] };

// Only Corillo's own scripts may run in its pages. For a page loaded from a
// file, the usual rule ("scripts from this site") lets in any script file on
// the disk, so each page's rule names its scripts by their contents' hashes,
// and each script tag carries the same hash. The diagram engine is loaded
// later, by the window and the export page, so they're built knowing its hash.
const hashOf = (file) => `sha256-${createHash("sha256").update(readFileSync(file)).digest("base64")}`;
// The diagram engine is large, so it's its own file, loaded only when a document has a diagram.
const diagrams = await build({ ...common, entryPoints: ["src/renderer/diagram-engine.ts"], outfile: "dist/diagrams.js", platform: "browser", format: "iife", target: "chrome120", minify: true, sourcemap: false });
const knowsDiagrams = { define: { __DIAGRAMS_INTEGRITY__: JSON.stringify(hashOf("dist/diagrams.js")) } };

const builds = [diagrams, ...(await Promise.all([
  build({ ...common, entryPoints: ["src/main/main.ts"], outfile: "dist/main.cjs", platform: "node", format: "cjs", external: ["electron"], target: "node22" }),
  build({ ...common, entryPoints: ["src/preload/preload.ts"], outfile: "dist/preload.cjs", platform: "node", format: "cjs", external: ["electron"], target: "node22" }),
  build({ ...common, ...knowsDiagrams, entryPoints: ["src/renderer/app.ts"], outfile: "dist/app.js", platform: "browser", format: "iife", target: "chrome120" }),
  build({ ...common, entryPoints: ["src/renderer/help.ts"], outfile: "dist/help.js", platform: "browser", format: "iife", target: "chrome120" }),
  build({ ...common, entryPoints: ["src/preload/help-preload.ts"], outfile: "dist/help-preload.cjs", platform: "node", format: "cjs", external: ["electron"], target: "node22" }),
  // The agent connector, run by agent tools with Corillo's own program in Node mode.
  build({ ...common, entryPoints: ["src/mcp/server.ts"], outfile: "dist/mcp.cjs", platform: "node", format: "cjs", target: "node22" }),
  // Word and PDF export: the hidden page that prints documents and draws diagrams as pictures.
  build({ ...common, ...knowsDiagrams, entryPoints: ["src/renderer/export-page.ts"], outfile: "dist/export-page.js", platform: "browser", format: "iife", target: "chrome120" }),
  build({ ...common, entryPoints: ["src/preload/export-preload.ts"], outfile: "dist/export-preload.cjs", platform: "node", format: "cjs", external: ["electron"], target: "node22" }),
  // The About Corillo window.
  build({ ...common, entryPoints: ["src/preload/about-preload.ts"], outfile: "dist/about-preload.cjs", platform: "node", format: "cjs", external: ["electron"], target: "node22" }),
  build({ ...common, entryPoints: ["src/renderer/about.ts"], outfile: "dist/about.js", platform: "browser", format: "iife", target: "chrome120" }),
]))];

// Each page and the scripts it may run.
const PAGES = {
  "index.html": ["app.js", "diagrams.js"],
  "help.html": ["help.js"],
  "about.html": ["about.js"],
  "export.html": ["export-page.js", "diagrams.js"],
};
for (const [page, scripts] of Object.entries(PAGES)) {
  let html = readFileSync(`src/renderer/${page}`, "utf8");
  const hashes = scripts.map((s) => hashOf(`dist/${s}`));
  if (!html.includes("script-src 'self'")) throw new Error(`${page} has no script-src 'self' to replace`);
  html = html.replace("script-src 'self'", `script-src ${hashes.map((h) => `'${h}'`).join(" ")}`);
  const tag = `<script src="${scripts[0]}">`;
  if (!html.includes(tag)) throw new Error(`${page} has no ${tag}`);
  html = html.replace(tag, `<script src="${scripts[0]}" integrity="${hashes[0]}">`);
  writeFileSync(`dist/${page}`, html);
}
cpSync("src/renderer/style.css", "dist/style.css");
cpSync("src/renderer/help-images", "dist/help-images", { recursive: true }); // the pictures in Help
cpSync("src/renderer/fonts", "dist/fonts", { recursive: true }); // the page font, with its licence
for (const f of ["export.css", "about.css"]) cpSync(`src/renderer/${f}`, `dist/${f}`);
cpSync("assets/corillo-icon.svg", "dist/corillo-icon.svg");

const inputs = new Set();
for (const b of builds) for (const file of Object.keys(b.metafile.inputs)) inputs.add(file);
writeFileSync("dist/bundled-files.json", JSON.stringify([...inputs].sort(), null, 2));
writeNotices([...inputs]);
