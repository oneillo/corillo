// Where a package's licence is, and its NOTICE file if it has one, for the licence check (check-licences.mjs) and
// About's notices (notices.mjs): one way of finding it, so the check never
// reads a file About doesn't show, or the other way round.
import { readdirSync } from "node:fs";

/** A licence file's name: LICENSE, LICENCE or COPYING, in any case, maybe with "-MIT", maybe .md, .txt or .markdown. */
export const LICENCE_FILE = /^(licen[cs]e|copying)(-mit)?(\.(md|txt|markdown))?$/i;

/** The folder of the package a bundled file is in (node_modules/name or node_modules/@scope/name), or null for Corillo's own files. */
export function packageDirOf(file) {
  const parts = file.split("/");
  const i = parts.lastIndexOf("node_modules");
  if (i < 0) return null;
  const n = parts[i + 1].startsWith("@") ? 2 : 1;
  return parts.slice(0, i + 1 + n).join("/");
}

/** The name of the package's licence file (the first by name, if it has several), or null. */
export function licenceFileIn(dir) {
  return readdirSync(dir).filter((f) => LICENCE_FILE.test(f)).sort()[0] ?? null;
}

/** A NOTICE file's name: NOTICE, in any case, maybe .md, .txt or .markdown. Apache-2.0 asks that it travel with the code, and some MIT packages carry one (es-toolkit, Lodash's notice). */
export const NOTICE_FILE = /^notice(\.(md|txt|markdown))?$/i;

/** The name of the package's NOTICE file (the first by name, if it has several), or null (C21-22). */
export function noticeFileIn(dir) {
  return readdirSync(dir).filter((f) => NOTICE_FILE.test(f)).sort()[0] ?? null;
}
