// Finding what an Obsidian link points to: [[Plan]] is a note called Plan.md,
// ![[chart.png]] a picture, wherever Obsidian would have put it. Obsidian
// looks a name up across the whole vault (the folder it was opened on, which
// holds its settings in a ".obsidian" folder), and keeps new attachments in
// the vault's top folder, next to the note, in a subfolder next to it
// ("attachments" unless renamed) or in a folder of the person's choice.
//
// Corillo looks in the likely places first, then searches the vault by name:
//   1. a path written in the link, from the document's folder, then from the vault's top folder;
//   2. the document's own folder;
//   3. the document's picture folder ("<name> images", where Corillo puts pictures);
//   4. an "attachments" folder in the document's folder or a folder above it, up to the vault's top
//      (outside a vault, up to three folders above);
//   5. the vault's top folder;
//   6. anywhere in the vault (or, outside a vault, in the document's folder and below), nearest first.
// The search skips hidden folders and stops after a few thousand folders, so a
// huge folder can't hold anything up.
import * as fs from "node:fs";
import * as path from "node:path";
import { imagesFolder } from "./files";

const SETTINGS_FOLDER = ".obsidian";
const ATTACHMENT_FOLDERS = ["attachments", "Attachments"];
const MAX_FOLDERS = 3000;
const SKIPPED = new Set(["node_modules"]);

const isFile = async (p: string) => {
  try {
    return (await fs.promises.stat(p)).isFile();
  } catch {
    return false;
  }
};

/** The vault a document is in: the nearest folder above it with Obsidian's settings folder, or null. */
export function vaultOf(docPath: string): string | null {
  let dir = path.dirname(path.resolve(docPath));
  for (;;) {
    if (fs.existsSync(path.join(dir, SETTINGS_FOLDER))) return dir;
    const up = path.dirname(dir);
    if (up === dir) return null;
    dir = up;
  }
}

/** The file name a link means: a note's name gets ".md" unless it names another kind of file. */
export function fileNameFor(target: string): string {
  const name = target.trim();
  return /\.[A-Za-z0-9]{1,5}$/.test(name) && !/\.md$/i.test(name) ? name : name.replace(/\.md$/i, "") + ".md";
}

async function searchByName(root: string, name: string): Promise<string | null> {
  const wanted = name.toLowerCase();
  let folders = [root];
  let seen = 0;
  while (folders.length && seen < MAX_FOLDERS) {
    const next: string[] = [];
    for (const dir of folders) {
      if (++seen > MAX_FOLDERS) break;
      let entries: fs.Dirent[];
      try {
        entries = await fs.promises.readdir(dir, { withFileTypes: true });
      } catch {
        continue;
      }
      entries.sort((a, b) => a.name.localeCompare(b.name));
      for (const e of entries) if (e.isFile() && e.name.toLowerCase() === wanted) return path.join(dir, e.name);
      for (const e of entries) if (e.isDirectory() && !e.name.startsWith(".") && !SKIPPED.has(e.name)) next.push(path.join(dir, e.name));
    }
    folders = next;
  }
  return null;
}

/**
 * Where the note or file a link points to is, or null. target is the link's
 * path as written ("Plan", "Projects/Plan", "chart.png").
 */
export async function findLinked(docPath: string, target: string): Promise<string | null> {
  const file = fileNameFor(target);
  if (!file || file === ".md") return null;
  const docDir = path.dirname(path.resolve(docPath));
  const vault = vaultOf(docPath);
  const top = vault ?? docDir;
  const tries: string[] = [];
  if (file.includes("/")) tries.push(path.resolve(docDir, file), path.resolve(top, file));
  const base = path.basename(file);
  tries.push(path.join(docDir, base));
  tries.push(path.join(imagesFolder(path.resolve(docPath)), base));
  // Attachment folders up to the vault's top folder; outside a vault, up to three folders above.
  let dir = docDir;
  for (let level = 0; ; level++) {
    for (const folder of ATTACHMENT_FOLDERS) tries.push(path.join(dir, folder, base));
    const up = path.dirname(dir);
    if (dir === top && vault) break;
    if (!vault && level >= 3) break;
    if (up === dir) break;
    dir = up;
  }
  tries.push(path.join(top, base));
  for (const p of tries) if (await isFile(p)) return p;
  return searchByName(top, base);
}

/** An address for a found file from the document's folder, as Markdown writes it. */
export function addressFrom(docPath: string, file: string): string {
  return path.relative(path.dirname(path.resolve(docPath)), file).split(path.sep).join("/");
}
