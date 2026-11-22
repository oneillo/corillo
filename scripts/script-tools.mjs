// What the packaging and fetching scripts share: one way to read an option
// and one way to fetch a file and check it (C21-16, C21-17).
import { createHash, randomUUID } from "node:crypto";
import { createWriteStream, mkdirSync, renameSync, rmSync } from "node:fs";
import { dirname } from "node:path";
import { Readable } from "node:stream";
import { pipeline } from "node:stream/promises";

/**
 * The value of `--name=value` among a script's arguments, or undefined when
 * it isn't given. `--name value`, with a space, is refused rather than taken
 * for no option at all (once, `--arch arm64` packaged for this Mac instead).
 */
export function option(argv, name) {
  if (argv.includes(`--${name}`)) throw new Error(`Give --${name} with an equals sign.`);
  return argv.find((a) => a.startsWith(`--${name}=`))?.slice(name.length + 3);
}

/** A download whose SHA-256 isn't the one pinned for it. */
export class ChecksumMismatch extends Error {}

/**
 * Fetches `url` into `target`, but only if its SHA-256 is `sha256`: it is
 * written to a `.part` file first (named for this fetch, unless `part` names
 * it) and renamed into place once it matches, so `target` is never half a
 * file or the wrong one. A mismatch throws ChecksumMismatch and leaves
 * nothing. `underWay` holds the `.part` file while it's written, for a
 * script that removes what's under way when it's stopped.
 */
export async function fetchChecked(url, sha256, target, { part = `${target}.${randomUUID()}.part`, underWay = new Set() } = {}) {
  const response = await fetch(url);
  if (!response.ok || !response.body) throw new Error(`Download failed (${response.status} ${response.statusText}): ${url}`);
  mkdirSync(dirname(target), { recursive: true });
  underWay.add(part);
  try {
    const hash = createHash("sha256");
    await pipeline(
      Readable.fromWeb(response.body),
      async function* (chunks) {
        for await (const chunk of chunks) {
          hash.update(chunk);
          yield chunk;
        }
      },
      createWriteStream(part),
    );
    const actual = hash.digest("hex");
    if (actual !== sha256) throw new ChecksumMismatch(`Checksum mismatch for ${url}: expected ${sha256}, got ${actual}`);
    renameSync(part, target);
  } finally {
    rmSync(part, { force: true });
    underWay.delete(part);
  }
}
