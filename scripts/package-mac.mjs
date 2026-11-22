// Packs Corillo into a Mac app, release/Corillo.app, and a disk image to
// install it from, release/Corillo-<version>-<arch>.dmg (open it, drag
// Corillo to Applications). Run `npm run build` first; `npm run package`
// does both.
//
// It packs for this Mac's kind (Apple silicon or Intel) unless told the
// other: `npm run package -- --arch=x64` makes the Intel app on an Apple
// silicon Mac (`--arch=arm64` the other way round). For the other kind it
// uses Electron's own build for that kind, of exactly the version npm
// installed, fetched once from Electron's releases on GitHub into the temp
// folder and used only if its SHA-256 is the one Electron published
// (node_modules/electron/checksums.json). An app for the other kind can't be
// opened on this Mac.
//
// It needs Pandoc, fetched by `npm run fetch-pandoc`, and stops without it:
// an app without Pandoc can't make Word documents. To leave it out on
// purpose, `npm run package -- --without-pandoc`; the app records that.
//
// Each build is stamped with the git commit it was made from and when, shown
// in About, so two builds of the same version can be told apart. A copy with
// no git (the public copy the downloads are made in) is given its commit:
// `--commit=<short commit>`, and git isn't asked.
//
// It starts from the Electron app that npm installed, renames it, gives it
// Corillo's name, icon, app ID and document types, and puts Corillo's built
// files inside. Only tools that come with macOS are used (ditto, plutil,
// iconutil, codesign, hdiutil). The app isn't signed with a developer
// certificate (Orlando's choice); it gets the ad-hoc signature every app
// needs to run on Apple silicon.
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
  cpSync,
  createReadStream,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  realpathSync,
  renameSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { createRequire } from "node:module";
import { constants, tmpdir } from "node:os";
import { basename, join, resolve } from "node:path";
import { pipeline } from "node:stream/promises";
import { fileURLToPath } from "node:url";
import electronPath from "electron";
import { makeIcns } from "./icon/make-icns.mjs";
import { APP_ID, ARCHES, dmgName } from "./package-names.mjs";
import { copyPandoc } from "./pandoc-files.mjs";
import { ChecksumMismatch, fetchChecked, option } from "./script-tools.mjs";

// Packaging runs only when this file is run as a script; imported, it does nothing and reads no options.
const isScript = process.argv[1] && realpathSync(process.argv[1]) === realpathSync(fileURLToPath(import.meta.url));
const argv = isScript ? process.argv.slice(2) : [];

const stop = (text) => {
  console.error(text);
  process.exit(1);
};
const USE_ARCH = "Use --arch=arm64 (Apple silicon) or --arch=x64 (Intel).";
const options = () => {
  try {
    return { arch: option(argv, "arch") ?? process.arch, commit: option(argv, "commit") };
  } catch (error) {
    return stop(`${error.message} ${USE_ARCH}`);
  }
};

const pkg = JSON.parse(readFileSync("package.json", "utf8"));
const NAME = pkg.productName;
const { arch: ARCH, commit: GIVEN_COMMIT } = options();
const RELEASE = "release";
const APP = join(RELEASE, `${NAME}.app`);
const CONTENTS = join(APP, "Contents");
const RESOURCES = join(CONTENTS, "Resources");
const MARKDOWN_UTI = "net.daringfireball.markdown";
const MARKDOWN_EXTENSIONS = ["md", "markdown", "mdown", "mkd", "mkdn"];

const PANDOC = join("vendor", "pandoc");
const PANDOC_BINARY = join(PANDOC, ARCH, "pandoc");
const WITHOUT_PANDOC = argv.includes("--without-pandoc");

const run = (cmd, args) => execFileSync(cmd, args, { stdio: ["ignore", "pipe", "inherit"] }).toString();
const step = (text) => console.log(`- ${text}`);

if (!ARCHES.includes(ARCH)) stop(`Unknown kind of Mac: ${ARCH}. ${USE_ARCH}`);
if (GIVEN_COMMIT !== undefined && !/^[0-9a-f]{4,40}$/.test(GIVEN_COMMIT)) stop(`Not a commit: ${GIVEN_COMMIT}. Give the short commit, as git rev-parse --short HEAD prints it.`);
const DMG = join(RELEASE, dmgName(pkg.version, ARCH));

/**
 * When this build was made (local time, to the minute) and the git commit it
 * was made from, marked "+changes" when the checkout has changes not yet
 * committed (the code then isn't that commit's).
 */
function buildStamp() {
  const now = new Date();
  const two = (n) => String(n).padStart(2, "0");
  const day = `${now.getFullYear()}-${two(now.getMonth() + 1)}-${two(now.getDate())}`;
  const time = `${two(now.getHours())}:${two(now.getMinutes())}`;
  // Given one (a copy with no git), git isn't asked.
  let commit = GIVEN_COMMIT ?? "unknown";
  if (!GIVEN_COMMIT) {
    try {
      commit = run("git", ["rev-parse", "--short", "HEAD"]).trim();
      if (run("git", ["status", "--porcelain"]).trim()) {
        commit += "+changes";
        console.warn("  Note: the checkout has changes not yet committed, so the build is stamped as having them.");
      }
    } catch {
      console.warn("  Warning: not a git checkout, so the build is stamped without a commit.");
    }
  }
  return {
    date: `${day}T${time}`,
    commit,
    // Apple's form for a build number, numbers and dots, and later builds count as newer: 20261109.2105.
    bundleVersion: `${day.replace(/-/g, "")}.${now.getHours() * 100 + now.getMinutes()}`,
  };
}

/** Read an Info.plist, change it, write it back. */
function editPlist(file, change) {
  const data = JSON.parse(run("plutil", ["-convert", "json", "-o", "-", file]));
  change(data);
  const dir = mkdtempSync(join(tmpdir(), "corillo-plist-"));
  try {
    writeFileSync(join(dir, "Info.json"), JSON.stringify(data));
    run("plutil", ["-convert", "xml1", "-o", file, join(dir, "Info.json")]);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

/** Where Electron's builds for the other kind of Mac are kept once fetched, so they're fetched once. */
const electronCache = () => join(tmpdir(), "electron-downloads");

/** Removes zips of other Electron versions from the cache (each over 100 MB), so an upgrade doesn't leave the last one behind. */
function pruneElectronCache(version) {
  if (!existsSync(electronCache())) return;
  for (const f of readdirSync(electronCache())) {
    if (/^electron-v.+-darwin-.+\.zip(\.part)?$/.test(f) && !f.startsWith(`electron-v${version}-`)) rmSync(join(electronCache(), f), { force: true });
  }
}

/**
 * What this run has under way in the temp folder (the unpacked Electron,
 * about 450 MB, and a zip half fetched), removed if it's stopped with Ctrl-C
 * or a kill: Node would otherwise stop without running any `finally`.
 */
const underWay = new Set();
for (const signal of isScript ? ["SIGINT", "SIGTERM", "SIGHUP"] : []) {
  process.once(signal, () => {
    for (const path of underWay) rmSync(path, { recursive: true, force: true });
    process.exit(128 + constants.signals[signal]);
  });
}

async function sha256(file) {
  const hash = createHash("sha256");
  await pipeline(createReadStream(file), hash);
  return hash.digest("hex");
}

/**
 * Electron's own build for the other kind of Mac, of the version npm
 * installed: fetched once from Electron's releases on GitHub, used only if its
 * SHA-256 is the one Electron published, and unpacked with ditto, which keeps
 * the frameworks' links. Returns the folder it was unpacked into.
 */
async function otherElectron() {
  const require = createRequire(import.meta.url);
  const { version } = require("electron/package.json");
  const name = `electron-v${version}-darwin-${ARCH}.zip`;
  const expected = require("electron/checksums.json")[name];
  if (!expected) stop(`Electron's checksums (node_modules/electron/checksums.json) have no line for ${name}, so it can't be checked.`);
  pruneElectronCache(version);
  const zip = join(electronCache(), name);
  const mismatch = () =>
    stop(
      `Electron's ${name} doesn't match the SHA-256 Electron published for it (node_modules/electron/checksums.json), ` +
        "so it wasn't used. It has been removed: run again to fetch it afresh.",
    );
  if (!existsSync(zip)) {
    if (process.env.CORILLO_NO_FETCH) stop(`Electron's ${name} isn't in ${electronCache()}, and fetching is turned off.`);
    mkdirSync(electronCache(), { recursive: true });
    const url = `https://github.com/electron/electron/releases/download/v${version}/${name}`;
    console.log(`  fetching ${url}`);
    try {
      await fetchChecked(url, expected, zip, { part: `${zip}.part`, underWay });
    } catch (error) {
      if (error instanceof ChecksumMismatch) mismatch();
      stop(`Couldn't fetch ${name}: ${error.message}`);
    }
  }
  if ((await sha256(zip)) !== expected) {
    rmSync(zip, { force: true });
    mismatch();
  }
  const dir = mkdtempSync(join(tmpdir(), `corillo-electron-${ARCH}-${process.pid}-`));
  underWay.add(dir);
  try {
    run("ditto", ["-x", "-k", zip, dir]);
  } catch (error) {
    rmSync(dir, { recursive: true, force: true });
    throw error;
  }
  return dir;
}

function copyElectron(otherDist) {
  if (!existsSync("dist/main.cjs")) throw new Error("Build Corillo first: npm run build");
  // electronPath is .../Electron.app/Contents/MacOS/Electron
  const electronApp = otherDist ? join(otherDist, "Electron.app") : resolve(electronPath, "../../..");
  rmSync(APP, { recursive: true, force: true });
  mkdirSync(RELEASE, { recursive: true });
  run("ditto", [electronApp, APP]);
  return resolve(electronApp, "..");
}

function rename(stamp) {
  renameSync(join(CONTENTS, "MacOS", "Electron"), join(CONTENTS, "MacOS", NAME));
  editPlist(join(CONTENTS, "Info.plist"), (p) => {
    Object.assign(p, {
      CFBundleName: NAME,
      CFBundleDisplayName: NAME,
      CFBundleExecutable: NAME,
      CFBundleIdentifier: APP_ID,
      CFBundleShortVersionString: pkg.version,
      CFBundleVersion: stamp.bundleVersion,
      CorilloBuildDate: stamp.date,
      CorilloBuildCommit: stamp.commit,
      // What macOS shows if a script run after a Word export tells another app what to do.
      NSAppleEventsUsageDescription: "A script you chose in Export Settings wants to control another app.",
      CFBundleIconFile: `${NAME}.icns`,
      LSApplicationCategoryType: "public.app-category.productivity",
      NSHumanReadableCopyright: "Copyright © 2026 Orlando O'Neill. Free and open source under the MIT licence.",
      // Markdown files list Corillo under Open With, without taking over as
      // the default app for them: the person chooses that in Finder. Word
      // documents list it too, as a viewer (Corillo works on a Markdown copy
      // made beside one, and never changes the Word file), never their default.
      CFBundleDocumentTypes: [
        {
          CFBundleTypeName: "Markdown document",
          CFBundleTypeRole: "Editor",
          LSHandlerRank: "Alternate",
          LSItemContentTypes: [MARKDOWN_UTI],
        },
        {
          CFBundleTypeName: "Word document",
          CFBundleTypeRole: "Viewer",
          LSHandlerRank: "Alternate",
          LSItemContentTypes: ["org.openxmlformats.wordprocessingml.document"],
        },
      ],
      // Teach macOS what a Markdown file is, in case it doesn't already know.
      UTImportedTypeDeclarations: [
        {
          UTTypeIdentifier: MARKDOWN_UTI,
          UTTypeDescription: "Markdown document",
          UTTypeConformsTo: ["public.plain-text"],
          UTTypeReferenceURL: "https://daringfireball.net/projects/markdown/",
          UTTypeTagSpecification: {
            "public.filename-extension": MARKDOWN_EXTENSIONS,
            "public.mime-type": ["text/markdown"],
          },
        },
      ],
    });
    if (WITHOUT_PANDOC) p.CorilloWithoutPandoc = true;
    // Electron's sample app is left out, so its integrity record goes too.
    delete p.ElectronAsarIntegrity;
    // Electron asks for these in its own words; Corillo uses none of them.
    for (const key of [
      "NSMicrophoneUsageDescription",
      "NSCameraUsageDescription",
      "NSBluetoothAlwaysUsageDescription",
      "NSBluetoothPeripheralUsageDescription",
      "NSAudioCaptureUsageDescription",
    ]) {
      delete p[key];
    }
  });

  // The helper programs behind the window carry Corillo's name too, so
  // Activity Monitor shows "Corillo Helper" rather than "Electron Helper".
  const frameworks = join(CONTENTS, "Frameworks");
  for (const helper of readdirSync(frameworks).filter((f) => /^Electron Helper.*\.app$/.test(f))) {
    const oldName = helper.replace(/\.app$/, "");
    const newName = oldName.replace(/^Electron/, NAME);
    const kind = /\((.+)\)/.exec(oldName)?.[1];
    const dir = join(frameworks, `${newName}.app`);
    renameSync(join(frameworks, helper), dir);
    renameSync(join(dir, "Contents", "MacOS", oldName), join(dir, "Contents", "MacOS", newName));
    editPlist(join(dir, "Contents", "Info.plist"), (p) => {
      p.CFBundleName = newName;
      p.CFBundleExecutable = newName;
      p.CFBundleIdentifier = `${APP_ID}.helper${kind ? `.${kind}` : ""}`;
    });
  }
}

function addCorillo(electronDist) {
  rmSync(join(RESOURCES, "default_app.asar"), { force: true });
  rmSync(join(RESOURCES, "electron.icns"), { force: true });
  makeIcns(join(RESOURCES, `${NAME}.icns`));

  // Corillo itself, as plain files (not an archive), so tools can run the
  // MCP server inside it by path. Everything is bundled into dist/, so
  // nothing from node_modules is needed.
  const app = join(RESOURCES, "app");
  mkdirSync(app);
  cpSync("dist", join(app, "dist"), {
    recursive: true,
    filter: (src) => !src.endsWith(".map") && !src.endsWith("bundled-files.json") && !isFinderFile(src),
  });
  cpSync("LICENSE", join(app, "LICENSE"));
  const { name, productName, version, description, license, main, type } = pkg;
  writeFileSync(join(app, "package.json"), JSON.stringify({ name, productName, version, description, license, main, type }, null, 2) + "\n");

  // Electron's licence and Chromium's notices, which Electron ships beside its
  // app rather than in it: Corillo is given out as the app alone, so both go
  // inside, where the About window finds Chromium's. Shipping them is the
  // condition of Orlando's approval of Chromium's LGPL and MPL parts
  // (dependencies.md); make-downloads.mjs checks each download has them.
  for (const f of ["LICENSE", "LICENSES.chromium.html"]) cpSync(join(electronDist, f), join(RESOURCES, f));
}

/** A Finder .DS_Store, left behind wherever a folder was opened in Finder: it can carry file names, so it never ships. */
const isFinderFile = (path) => basename(path) === ".DS_Store";

/** Pandoc, for Word export, as scripts/fetch-pandoc.mjs fetched it. */
function addPandoc() {
  const source = PANDOC;
  const target = join(RESOURCES, "pandoc");
  // Its licence, its version and the program for this Mac's processor, each by name: not the other
  // processors' copies, and nothing else in the folder, such as a half-fetched download (C21-14).
  copyPandoc(source, target, ARCH);
  for (const f of ["COPYING", "VERSION"]) {
    if (!existsSync(join(target, f))) console.warn(`  Warning: vendor/pandoc/${f} is missing; the About window won't show Pandoc's licence.`);
  }
  // Apple silicon only runs signed programs: give Pandoc an ad-hoc signature if it has none.
  try {
    run("codesign", ["--verify", join(target, ARCH, "pandoc")]);
  } catch {
    run("codesign", ["--force", "--sign", "-", join(target, ARCH, "pandoc")]);
  }
}

function sign() {
  run("codesign", ["--force", "--deep", "--sign", "-", APP]);
  run("codesign", ["--verify", "--deep", "--strict", APP]);
}

function makeDmg() {
  const stage = mkdtempSync(join(tmpdir(), "corillo-dmg-"));
  try {
    run("ditto", [APP, join(stage, `${NAME}.app`)]);
    symlinkSync("/Applications", join(stage, "Applications"));
    rmSync(DMG, { force: true });
    run("hdiutil", ["create", "-quiet", "-volname", NAME, "-srcfolder", stage, "-fs", "HFS+", "-format", "UDZO", "-ov", DMG]);
  } finally {
    rmSync(stage, { recursive: true, force: true });
  }
}

if (isScript) {
  if (!WITHOUT_PANDOC && !existsSync(PANDOC_BINARY)) {
    console.error(
      `No Pandoc at ${PANDOC_BINARY}, so this app couldn't make Word documents. Fetch it first (npm run fetch-pandoc), ` +
        "or package without it on purpose: npm run package -- --without-pandoc",
    );
    process.exit(1);
  }

  const other = ARCH !== process.arch;
  if (other) step(`checking Electron's own build for ${ARCH} Macs`);
  const otherDist = other ? await otherElectron() : undefined;
  try {
    const stamp = buildStamp();
    console.log(`Packaging ${NAME} ${pkg.version} (build ${stamp.commit}, ${stamp.date.replace("T", " ")}) for ${ARCH} Macs`);
    step("copying Electron");
    const electronDist = copyElectron(otherDist);
    step("naming it Corillo");
    rename(stamp);
    step("adding Corillo, its icon and notices");
    addCorillo(electronDist);
    if (WITHOUT_PANDOC) step("leaving Pandoc out, as asked: this app can't make Word documents");
    else {
      step("adding Pandoc");
      addPandoc();
    }
    step("signing (ad hoc)");
    sign();
    step("making the disk image");
    makeDmg();
    console.log(`Done: ${APP} and ${DMG}${other ? ` (for ${ARCH} Macs: it can't be opened on this one)` : ""}`);
  } finally {
    if (otherDist) rmSync(otherDist, { recursive: true, force: true });
  }
}
