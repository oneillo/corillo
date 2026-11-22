// A document's own pictures: copied into the "<name> images" folder beside it, and named in it by a relative address.
import { clipboard, dialog, ipcMain, type BrowserWindow } from "electron";
import * as fs from "node:fs";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import { isPicture } from "../core/obsidian";
import { IMAGE_EXTENSIONS, PICTURE_ENDINGS } from "../core/picture-kinds";
import type { OpenDoc } from "./doc-on-disk";
import { pictureKind } from "./export-pictures";
import { imagesFolder } from "./files";
import { pictureHead, picturesAllowed } from "./picture-stamps";

/** What main.ts lends a document's pictures. */
interface PicturesHost {
  docs: Map<string, OpenDoc>;
  docFor(id: string): OpenDoc;
  ensureWindow(): BrowserWindow;
}

let docs: PicturesHost["docs"];
let docFor: PicturesHost["docFor"];
let ensureWindow: PicturesHost["ensureWindow"];

/**
 * Given its parts once, as main.ts starts, after window-boundary.ts has
 * guarded the channels: the window's channels for pictures are set up here.
 */
export function setUpPictures(host: PicturesHost): void {
  ({ docs, docFor, ensureWindow } = host);

  ipcMain.handle("image:choose", async (_e, id: string) => {
    const doc = docFor(id);
    const result = await dialog.showOpenDialog(ensureWindow(), {
      title: "Insert a picture",
      properties: ["openFile"],
      filters: [{ name: "Pictures", extensions: [...IMAGE_EXTENSIONS] }],
    });
    if (result.canceled || !result.filePaths[0]) return null;
    return importImageFile(doc, result.filePaths[0]);
  });

  // Only a picture the person dropped or pasted (the bridge says so, having
  // found it from the file itself), or one written into what they pasted:
  // never another file the page names.
  ipcMain.handle("image:import", async (_e, id: string, source: unknown, dropped: unknown) => {
    if (typeof source !== "string" || (dropped !== true && !(await pastedPicture(path.resolve(source))))) {
      console.error("The window asked to copy in a picture the person didn't drop or paste, so Corillo didn't.");
      return null;
    }
    // A copy that fails (the pictures folder locked, the disk full) is an error, as for the other two, so the window says so.
    return importImageFile(docFor(id), source);
  });

  ipcMain.handle("image:save-data", (_e, id: string, bytes: Uint8Array, mimeType: string) => {
    const ext = PICTURE_ENDINGS[mimeType];
    if (!ext) return null;
    const doc = docFor(id);
    const folder = imagesFolder(doc.filePath);
    fs.mkdirSync(folder, { recursive: true });
    const target = path.join(folder, freeName(folder, "Picture", ext));
    fs.writeFileSync(target, bytes);
    return addressFor(doc, target);
  });
}

// Pictures -------------------------------------------------------------------
// A document's pictures go in a "<name> images" folder beside it, created when
// the first one is added. The document refers to them by relative address.

/** The address a document uses for a file: relative, each part URL-encoded. */
function addressFor(doc: OpenDoc, file: string): string {
  const rel = path.relative(path.dirname(doc.filePath), file);
  return rel.split(path.sep).map(encodeURIComponent).join("/");
}

/** A free file name in the folder: "chart.png", then "chart 2.png", and so on. */
function freeName(folder: string, base: string, ext: string): string {
  const clean = base.replace(/[#?%<>\\/:*|"]/g, "-").trim() || "Picture";
  for (let i = 1; ; i++) {
    const name = i === 1 ? `${clean}.${ext}` : `${clean} ${i}.${ext}`;
    if (!fs.existsSync(path.join(folder, name))) return name;
  }
}

function sameBytes(a: string, b: string): boolean {
  try {
    return fs.readFileSync(a).equals(fs.readFileSync(b));
  } catch {
    return false;
  }
}

function importImageFile(doc: OpenDoc, source: string): string | null {
  const ext = path.extname(source).slice(1).toLowerCase();
  if (!IMAGE_EXTENSIONS.includes(ext) || !fs.statSync(source, { throwIfNoEntry: false })?.isFile()) return null;
  const folder = imagesFolder(doc.filePath);
  if (path.dirname(path.resolve(source)) === folder) return addressFor(doc, source); // already there
  fs.mkdirSync(folder, { recursive: true });
  const base = path.basename(source, path.extname(source));
  const existing = path.join(folder, `${base}.${ext}`);
  if (fs.existsSync(existing) && sameBytes(existing, source)) return addressFor(doc, existing);
  const target = path.join(folder, freeName(folder, base, ext));
  fs.copyFileSync(source, target);
  return addressFor(doc, target);
}

/**
 * A picture written into content the person pasted (from Word, or from
 * another document): a real picture, by its name and its first bytes, that's
 * beside or named in an open document, or named in what's on the clipboard now.
 */
async function pastedPicture(file: string): Promise<boolean> {
  if (!isPicture(file)) return false;
  const head = await pictureHead(file, 4096);
  if (!head || !pictureKind(head)) return false;
  if (picturesAllowed(docs.values())(file)) return true;
  return (await clipboardHtml()).some((html) =>
    [...html.matchAll(/file:[^"'\s<>]+/gi)].some(([address]) => {
      try {
        return path.resolve(fileURLToPath(address.replace(/&amp;/g, "&"))) === file;
      } catch {
        return false; // not an address of a file
      }
    }),
  );
}

/** The formatted text on the clipboard now, if any. */
async function clipboardHtml(): Promise<string[]> {
  try {
    const items = await clipboard.read();
    return await Promise.all(
      items
        .filter((item) => item.types.includes("text/html"))
        .map(async (item) => {
          const html: unknown = await item.getType("text/html");
          return typeof html === "string" ? html : await (html as Blob).text();
        }),
    );
  } catch {
    return [];
  }
}
