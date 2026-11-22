// Checks the installable Corillo that `npm run package` makes: the app in
// release/Corillo.app and the disk image beside it. Run with
// `npm run test:package`, which packages first.
import { test, expect, _electron as electron } from "@playwright/test";
import { execFileSync, spawn, spawnSync } from "node:child_process";
import { existsSync, lstatSync, mkdtempSync, readFileSync, readdirSync, readlinkSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ONE_SCALE, throwawayStart } from "../e2e/helpers";
import { makeDocx } from "../fixtures/make-docx";
// @ts-expect-error: a plain JavaScript script, with no types of its own
import { APP_ID, dmgName } from "../../scripts/package-names.mjs";

const ROOT = join(import.meta.dirname, "..", "..");
const PKG = JSON.parse(readFileSync(join(ROOT, "package.json"), "utf8"));
const APP = join(ROOT, "release", "Corillo.app");
const CONTENTS = join(APP, "Contents");
const RESOURCES = join(CONTENTS, "Resources");
const BINARY = join(CONTENTS, "MacOS", "Corillo");
const DMG = join(ROOT, "release", dmgName(PKG.version, process.arch));

const plist = (file: string) => JSON.parse(execFileSync("plutil", ["-convert", "json", "-o", "-", file]).toString());
const temp = (prefix: string) => mkdtempSync(join(tmpdir(), prefix));

/**
 * Run a program with the app's own Node (Electron's run-as-Node mode), as an agent tool would: on a throwaway data
 * folder, with a stand-in home, like every Corillo program a test starts (Batch 23, item 3).
 */
function runAsNode(binary: string, args: string[]) {
  return spawnSync(binary, args, { env: throwawayStart({ ...process.env, ELECTRON_RUN_AS_NODE: "1", CORILLO_USER_DATA: temp("corillo-data-") }), encoding: "utf8", timeout: 30_000 });
}

/** Launch the packaged app hidden, with a throwaway data folder and a stand-in home (Batch 23, item 3). */
function launchPackaged(args: string[] = [], env: Record<string, string> = {}) {
  return electron.launch({
    executablePath: BINARY,
    args: [ONE_SCALE, ...args],
    env: throwawayStart({ ...process.env, CORILLO_USER_DATA: temp("corillo-data-"), ...env }) as Record<string, string>,
  });
}

test("the app is called Corillo, with its own app ID (made from where it is published, 2026-11-17) and the version from package.json", () => {
  const info = plist(join(CONTENTS, "Info.plist"));
  expect(info.CFBundleName).toBe("Corillo");
  expect(info.CFBundleDisplayName).toBe("Corillo");
  expect(info.CFBundleExecutable).toBe("Corillo");
  expect(info.CFBundleIdentifier).toBe(APP_ID);
  expect(info.CFBundleShortVersionString).toBe(PKG.version);
  expect(info.NSHumanReadableCopyright).toContain("MIT");
  expect(existsSync(BINARY)).toBe(true);
  // Its helper programs carry its name too.
  const helpers = readdirSync(join(CONTENTS, "Frameworks")).filter((f) => f.includes("Helper"));
  expect(helpers.sort()).toEqual([
    "Corillo Helper (GPU).app",
    "Corillo Helper (Plugin).app",
    "Corillo Helper (Renderer).app",
    "Corillo Helper.app",
  ]);
  // And IDs made from the app's.
  expect(helpers.map((h) => plist(join(CONTENTS, "Frameworks", h, "Contents", "Info.plist")).CFBundleIdentifier).sort()).toEqual(
    [`${APP_ID}.helper`, `${APP_ID}.helper.GPU`, `${APP_ID}.helper.Plugin`, `${APP_ID}.helper.Renderer`],
  );
});

test("the app asks macOS for nothing it doesn't use, and says plainly why a script may control another app (EX-10)", () => {
  const info = plist(join(CONTENTS, "Info.plist"));
  // Electron's own texts ("This app needs access to the microphone"): Corillo uses none of these.
  for (const key of ["NSMicrophoneUsageDescription", "NSCameraUsageDescription", "NSBluetoothAlwaysUsageDescription", "NSBluetoothPeripheralUsageDescription", "NSAudioCaptureUsageDescription"]) {
    expect(info[key], key).toBeUndefined();
  }
  // Shown by macOS when a script run after a Word export tells another app (Word, say) what to do.
  expect(info.NSAppleEventsUsageDescription).toBe("A script you chose in Export Settings wants to control another app.");
});

test("each build carries a stamp, the commit it was made from and when, shown in About, and says when it has changes not yet committed (EX-10, R-EX-12)", async () => {
  const info = plist(join(CONTENTS, "Info.plist"));
  const commit = execFileSync("git", ["rev-parse", "--short", "HEAD"], { cwd: ROOT, encoding: "utf8" }).trim();
  const changed = execFileSync("git", ["status", "--porcelain"], { cwd: ROOT, encoding: "utf8" }).trim() !== "";
  expect(info.CorilloBuildCommit).toBe(changed ? `${commit}+changes` : commit);
  expect(info.CorilloBuildDate).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}$/);
  // Two builds of the same version differ here, and a later one counts as newer (Apple's form: numbers and dots).
  const [day, time] = info.CorilloBuildDate.split("T");
  expect(info.CFBundleVersion).toBe(`${day.replace(/-/g, "")}.${Number(time.replace(":", ""))}`);
  expect(info.CFBundleShortVersionString).toBe(PKG.version);

  const app = await launchPackaged();
  await app.firstWindow();
  const opened = app.waitForEvent("window");
  await app.evaluate(({ Menu }) => Menu.getApplicationMenu()!.getMenuItemById("about")!.click());
  const about = await opened;
  await about.waitForSelector("body[data-ready]");
  await expect(about.locator("#about-build")).toHaveText(
    new RegExp(`^Build ${commit}${changed ? " with changes" : ""}, made \\d{1,2} [A-Z][a-z]+ \\d{4} at \\d{2}:\\d{2}$`),
  );
  await app.close();
});

test("packaging stops when Pandoc hasn't been fetched, unless asked to go without it (EX-10)", () => {
  // A folder with no vendor/pandoc: the check comes before anything is copied.
  const folder = temp("corillo-package-");
  writeFileSync(join(folder, "package.json"), JSON.stringify({ productName: "Corillo", version: "0.0.0" }));
  const result = spawnSync(process.execPath, [join(ROOT, "scripts", "package-mac.mjs")], { cwd: folder, encoding: "utf8", timeout: 30_000 });
  expect(result.status).not.toBe(0);
  expect(result.stderr).toContain("No Pandoc at vendor/pandoc/");
  expect(result.stderr).toContain("--without-pandoc");
  expect(existsSync(join(folder, "release"))).toBe(false);
});

test("the app's icon is the coquí, at every size macOS uses", () => {
  const info = plist(join(CONTENTS, "Info.plist"));
  const icns = join(RESOURCES, info.CFBundleIconFile);
  expect(info.CFBundleIconFile).toBe("Corillo.icns");
  expect(existsSync(join(RESOURCES, "electron.icns"))).toBe(false);
  const out = join(temp("corillo-iconset-"), "Corillo.iconset");
  execFileSync("iconutil", ["--convert", "iconset", "--output", out, icns]);
  expect(readdirSync(out).sort()).toEqual(
    [16, 32, 128, 256, 512].flatMap((s) => [`icon_${s}x${s}.png`, `icon_${s}x${s}@2x.png`]).sort(),
  );
  // Each picture really is its size (sips comes with macOS).
  for (const [name, px] of [["icon_16x16.png", 16], ["icon_512x512@2x.png", 1024]] as const) {
    const dims = execFileSync("sips", ["-g", "pixelWidth", "-g", "pixelHeight", join(out, name)]).toString();
    expect(dims).toContain(`pixelWidth: ${px}`);
    expect(dims).toContain(`pixelHeight: ${px}`);
  }
});

test("the icon shows a blue-grey frog on a pale tile, with the corners left clear", async () => {
  const out = join(temp("corillo-iconset-"), "Corillo.iconset");
  execFileSync("iconutil", ["--convert", "iconset", "--output", out, join(RESOURCES, "Corillo.icns")]);
  const app = await launchPackaged();
  // Read pixels with Electron's own image decoder.
  const pixels = await app.evaluate(({ nativeImage }, file) => {
    const img = nativeImage.createFromPath(file);
    const { width } = img.getSize();
    const bitmap = img.toBitmap(); // BGRA
    const at = (x: number, y: number) => {
      const i = (y * width + x) * 4;
      return [bitmap[i + 2], bitmap[i + 1], bitmap[i], bitmap[i + 3]];
    };
    return { width, corner: at(2, 2), tile: at(256, 70), frog: at(256, 256) };
  }, join(out, "icon_512x512.png"));
  await app.close();
  expect(pixels.width).toBe(512);
  expect(pixels.corner[3]).toBe(0); // outside the rounded tile: see-through
  expect(pixels.tile).toEqual([0xe6, 0xec, 0xeb, 255]); // limestone
  expect(pixels.frog).toEqual([0x4f, 0x6d, 0x7a, 255]); // cobblestone blue-grey
});

test("Markdown files and Word documents can be opened with Corillo from Finder, without Corillo taking over as their default app", () => {
  const info = plist(join(CONTENTS, "Info.plist"));
  expect(info.CFBundleDocumentTypes).toEqual([
    {
      CFBundleTypeName: "Markdown document",
      CFBundleTypeRole: "Editor",
      LSHandlerRank: "Alternate",
      LSItemContentTypes: ["net.daringfireball.markdown"],
    },
    // Roadmap Batch 5, item 1: a Word document opens as a Markdown copy beside it; the Word file is only read.
    {
      CFBundleTypeName: "Word document",
      CFBundleTypeRole: "Viewer",
      LSHandlerRank: "Alternate",
      LSItemContentTypes: ["org.openxmlformats.wordprocessingml.document"],
    },
  ]);
  const markdown = info.UTImportedTypeDeclarations.find((t: { UTTypeIdentifier: string }) => t.UTTypeIdentifier === "net.daringfireball.markdown");
  expect(markdown.UTTypeConformsTo).toContain("public.plain-text");
  expect(markdown.UTTypeTagSpecification["public.filename-extension"]).toEqual(expect.arrayContaining(["md", "markdown"]));
});

test("the app has the ad-hoc signature a Mac with Apple silicon needs to run it", () => {
  const result = spawnSync("codesign", ["--verify", "--deep", "--strict", APP], { encoding: "utf8" });
  expect(result.stderr).toBe("");
  expect(result.status).toBe(0);
});

test("with no --arch, the app is for this Mac's kind only, its Pandoc too, and the other kind's Pandoc isn't in it", () => {
  const lipo = process.arch === "arm64" ? "arm64" : "x86_64";
  const archs = (file: string) => execFileSync("lipo", ["-archs", file], { encoding: "utf8" }).trim();
  expect(archs(BINARY)).toBe(lipo);
  expect(archs(join(CONTENTS, "Frameworks", "Electron Framework.framework", "Electron Framework"))).toBe(lipo);
  if (existsSync(join(RESOURCES, "pandoc"))) {
    expect(readdirSync(join(RESOURCES, "pandoc")).filter((f) => ["arm64", "x64"].includes(f))).toEqual([process.arch]);
    expect(archs(join(RESOURCES, "pandoc", process.arch, "pandoc"))).toBe(lipo);
  }
  expect(existsSync(DMG)).toBe(true);
});

test("the app carries Corillo's built files and licence, and nothing from the development tools", () => {
  const app = join(RESOURCES, "app");
  expect(readdirSync(app).sort()).toEqual(["LICENSE", "dist", "package.json"]);
  const files = readdirSync(join(app, "dist"));
  for (const f of ["main.cjs", "preload.cjs", "app.js", "index.html", "style.css", "about.html", "third-party-notices.txt"]) {
    expect(files).toContain(f);
  }
  expect(files.filter((f) => f.endsWith(".map"))).toEqual([]);
  expect(existsSync(join(RESOURCES, "default_app.asar"))).toBe(false);
  expect(existsSync(join(RESOURCES, "app.asar"))).toBe(false);
  expect(JSON.parse(readFileSync(join(app, "package.json"), "utf8"))).toEqual({
    name: PKG.name,
    productName: "Corillo",
    version: PKG.version,
    description: PKG.description,
    license: "MIT",
    main: PKG.main,
    type: PKG.type,
  });
  expect(readFileSync(join(app, "LICENSE"), "utf8")).toContain("MIT License");
  // Chromium's notices ship with it, for the About window.
  expect(statSync(join(RESOURCES, "LICENSES.chromium.html")).size).toBeGreaterThan(1_000_000);
});

test("the app carries Electron's licence and Chromium's notices, as Electron ships them: the condition of the licence approval (\"Chromium as Electron ships it, with its notices\", 2026-11-17)", () => {
  // Electron ships both beside its app, not in it; packaging puts them in, unchanged.
  const electronDist = join(ROOT, "node_modules", "electron", "dist");
  expect(existsSync(join(electronDist, "Electron.app", "Contents", "Resources", "LICENSE"))).toBe(false);
  for (const f of ["LICENSE", "LICENSES.chromium.html"]) {
    expect(readFileSync(join(RESOURCES, f)).equals(readFileSync(join(electronDist, f))), f).toBe(true);
  }
  expect(readFileSync(join(RESOURCES, "LICENSE"), "utf8")).toContain("Copyright (c) Electron contributors");
  expect(readFileSync(join(RESOURCES, "LICENSES.chromium.html"), "utf8")).toContain("<title>Credits</title>");
});

test("the installed app opens a Markdown document and shows the licences in About", async () => {
  const folder = temp("corillo-doc-");
  const file = join(folder, "notes.md");
  writeFileSync(file, "# Packed\n\nOpened by the installed app.\n");
  const app = await launchPackaged([file]);
  const page = await app.firstWindow();
  await expect(page.locator(".ProseMirror h1")).toHaveText("Packed");
  expect(await app.evaluate(({ app }) => [app.isPackaged, app.getName(), app.getVersion()])).toEqual([true, "Corillo", PKG.version]);
  expect(await app.evaluate(({ app }) => app.getPath("userData"))).toContain("corillo-data-");
  // Agent setup launches the MCP server as <the app's own program> <app path>/dist/mcp.cjs:
  // that's the Corillo binary and a plain folder (no archive), as the next test runs it.
  expect(await app.evaluate(({ app }) => [process.execPath, app.getAppPath()])).toEqual([BINARY, join(RESOURCES, "app")]);

  const opened = app.waitForEvent("window");
  await app.evaluate(({ Menu }) => Menu.getApplicationMenu()!.getMenuItemById("about")!.click());
  const about = await opened;
  await about.waitForSelector("body[data-ready]");
  await expect(about.getByText(`Version ${PKG.version}`)).toBeVisible();
  await expect(about.getByText(/^\d+ packages, each listed with its licence\.$/)).toBeVisible();
  await expect(about.getByText("Electron and Chromium")).toBeVisible();
  await about.getByText("Read the licence").click();
  await expect(about.locator("#licence-text")).toContainText("Permission is hereby granted");
  await app.close();
});

test("agent tools can run a script inside the app with the app's own Node, so nobody needs Node installed", () => {
  // The switch that allows it (Electron's RunAsNode fuse) is left on.
  const framework = readFileSync(join(CONTENTS, "Frameworks", "Electron Framework.framework", "Electron Framework"));
  const sentinel = Buffer.from("dL7pKGdnNz796PbbjQWNKmHXBZaB9tsX");
  const at = framework.indexOf(sentinel);
  expect(at).toBeGreaterThan(0);
  const fuses = framework.subarray(at + sentinel.length + 2, at + sentinel.length + 2 + framework[at + sentinel.length + 1]);
  expect(String.fromCharCode(fuses[0])).toBe("1"); // the first fuse is RunAsNode

  // Corillo's files are plain files, reachable by path. Run a small script
  // placed among them, in a copy of the app (so the real one stays as signed).
  const copy = join(temp("corillo-app-copy-"), "Corillo.app");
  execFileSync("cp", ["-c", "-R", APP, copy]); // a quick copy-on-write clone
  const dist = join(copy, "Contents", "Resources", "app", "dist");
  writeFileSync(
    join(dist, "probe.cjs"),
    `const fs = require("node:fs"), path = require("node:path");
     console.log(JSON.stringify({ node: process.versions.node, electron: process.versions.electron,
       sibling: fs.existsSync(path.join(__dirname, "main.cjs")) }));`,
  );
  const result = runAsNode(join(copy, "Contents", "MacOS", "Corillo"), [join(dist, "probe.cjs")]);
  expect(result.stderr).toBe("");
  const out = JSON.parse(result.stdout);
  expect(out.node).toMatch(/^\d+\.\d+\.\d+$/);
  expect(out.electron).toBe(JSON.parse(readFileSync(join(ROOT, "node_modules", "electron", "package.json"), "utf8")).version);
  expect(out.sibling).toBe(true);
});

test("the MCP server inside the app answers an agent tool's first message", async () => {
  const server = join(RESOURCES, "app", "dist", "mcp.cjs");
  test.skip(!existsSync(server), "This build has no MCP server (dist/mcp.cjs) yet.");
  const child = spawn(BINARY, [server], {
    env: throwawayStart({ ...process.env, ELECTRON_RUN_AS_NODE: "1", CORILLO_USER_DATA: temp("corillo-data-") }),
    stdio: ["pipe", "pipe", "pipe"],
  });
  try {
    const reply = new Promise<string>((resolve, reject) => {
      let out = "";
      child.stdout.on("data", (d: Buffer) => {
        out += d.toString();
        const line = out.split("\n").find((l) => l.includes('"id":1'));
        if (line) resolve(line);
      });
      child.on("exit", (code) => reject(new Error(`The MCP server stopped (exit ${code})`)));
    });
    const hello = {
      jsonrpc: "2.0",
      id: 1,
      method: "initialize",
      params: { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "corillo-package-test", version: "1" } },
    };
    child.stdin.write(JSON.stringify(hello) + "\n");
    const answer = JSON.parse(await Promise.race([reply, new Promise<string>((_, no) => setTimeout(() => no(new Error("No answer in 15 seconds")), 15_000))]));
    expect(answer.result?.serverInfo?.name).toBeTruthy();
  } finally {
    child.kill();
  }
});

test("Pandoc is inside the app, with its licence and version, and About names it", async () => {
  // Changed 2026-11-09 night (EX-10): skipped only for an app built without Pandoc on purpose, not when it's missing.
  test.skip(plist(join(CONTENTS, "Info.plist")).CorilloWithoutPandoc === true, "This app was built with --without-pandoc.");
  const dir = join(RESOURCES, "pandoc");
  const version = readFileSync(join(dir, "VERSION"), "utf8").trim();
  expect(readFileSync(join(dir, "COPYING"), "utf8")).toContain("GNU GENERAL PUBLIC LICENSE");
  const pandoc = join(dir, process.arch, "pandoc");
  expect(statSync(pandoc).mode & 0o111).not.toBe(0);
  const result = spawnSync(pandoc, ["--version"], { encoding: "utf8" });
  expect(result.status).toBe(0);
  expect(result.stdout.split("\n")[0]).toContain(version);

  const app = await launchPackaged();
  await app.firstWindow();
  const opened = app.waitForEvent("window");
  await app.evaluate(({ Menu }) => Menu.getApplicationMenu()!.getMenuItemById("about")!.click());
  const about = await opened;
  await about.waitForSelector("body[data-ready]");
  await expect(about.getByText(`Pandoc ${version}`)).toBeVisible();
  await app.close();
});

test("the installed app makes a Markdown copy of a Word document opened from Finder, with the Pandoc inside it", async () => {
  test.skip(plist(join(CONTENTS, "Info.plist")).CorilloWithoutPandoc === true, "This app was built with --without-pandoc.");
  const folder = temp("corillo-doc-");
  const word = join(folder, "Offsite notes.docx");
  writeFileSync(word, makeDocx());
  const app = await launchPackaged();
  const page = await app.firstWindow();
  // The person answers Make a Copy; then Finder hands Corillo the Word document (Open With, or a drop on the Dock icon).
  await app.evaluate(({ dialog }) => {
    dialog.showMessageBox = (async () => ({ response: 0, checkboxChecked: false })) as unknown as typeof dialog.showMessageBox;
  });
  await app.evaluate(({ app: a }, p) => void a.emit("open-file", { preventDefault: () => undefined }, p), word);
  await expect(page.locator(".ProseMirror h2")).toHaveText("Who");
  expect(readFileSync(join(folder, "Offsite notes.md"), "utf8")).toContain("The offsite is in **March**, at the lake house.");
  expect(readdirSync(join(folder, "Offsite notes images"))).toEqual(["image1.png"]);
  await app.close();
});

test("the disk image holds Corillo and a shortcut to Applications, to drag it into", () => {
  expect(statSync(DMG).size).toBeGreaterThan(50_000_000);
  const mount = temp("corillo-dmg-mount-");
  execFileSync("hdiutil", ["attach", DMG, "-readonly", "-nobrowse", "-noautoopen", "-mountpoint", mount]);
  try {
    expect(readdirSync(mount).filter((f) => !f.startsWith(".")).sort()).toEqual(["Applications", "Corillo.app"]);
    expect(lstatSync(join(mount, "Applications")).isSymbolicLink()).toBe(true);
    expect(readlinkSync(join(mount, "Applications"))).toBe("/Applications");
    expect(plist(join(mount, "Corillo.app", "Contents", "Info.plist")).CFBundleIdentifier).toBe(APP_ID);
    const signed = spawnSync("codesign", ["--verify", "--deep", "--strict", join(mount, "Corillo.app")], { encoding: "utf8" });
    expect(signed.status).toBe(0);
  } finally {
    execFileSync("hdiutil", ["detach", mount, "-quiet"]);
  }
});
