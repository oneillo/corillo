// Which of vendor/pandoc's files go into the app, and the leftovers a stopped
// fetch can leave there (C21-14). Packaging (scripts/package-mac.mjs) copies
// only the files named here, so nothing else that turns up in the folder (a
// half-fetched download, a note, a Finder file) ships. The fetch
// (scripts/fetch-pandoc.mjs) clears its own old leftovers when it starts.
import { cpSync, existsSync, mkdirSync, readdirSync, rmSync, statSync } from "node:fs";
import { join } from "node:path";

/** Pandoc's licence, its copyright notice with where to get its source, and its version: beside the program in the app. */
export const PANDOC_NOTICES = ["COPYING", "COPYRIGHT", "VERSION"];

/** Copies Pandoc's notices that are there and its program for this kind of Mac, and nothing else, from `source` to `target`. */
export function copyPandoc(source, target, arch) {
  mkdirSync(join(target, arch), { recursive: true });
  for (const f of PANDOC_NOTICES) {
    if (existsSync(join(source, f))) cpSync(join(source, f), join(target, f));
  }
  cpSync(join(source, arch, "pandoc"), join(target, arch, "pandoc"));
}

/**
 * How old a fetch's half-written file (`<name>.<id>.part`) must be before
 * it's taken for a leftover: a fetch writes and renames one within seconds,
 * so one this old belongs to a fetch that was stopped, never to one under way.
 */
export const LEFTOVER_AGE_MS = 10 * 60_000;

/** Removes the fetch's old `.part` files from `vendor` and the folders in it. Returns what it removed, by path. */
export function removeOldParts(vendor, now = Date.now()) {
  const removed = [];
  if (!existsSync(vendor)) return removed;
  const dirs = [vendor, ...readdirSync(vendor, { withFileTypes: true }).filter((e) => e.isDirectory()).map((e) => join(vendor, e.name))];
  for (const dir of dirs) {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const at = join(dir, entry.name);
      if (!entry.isFile() || !entry.name.endsWith(".part")) continue;
      if (now - statSync(at).mtimeMs < LEFTOVER_AGE_MS) continue;
      rmSync(at, { force: true });
      removed.push(at);
    }
  }
  return removed;
}
