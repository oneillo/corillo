// Characters nobody can see (a byte-order mark, a line or paragraph
// separator, a private-use character, a space other than the ordinary one)
// are written in Corillo's code as escapes, a backslash, "u" and four
// digits, never typed raw, where a reader would see nothing or a plain space
// (the review of Batch 21, S21-14). By number here, so none is in this file.
import { readdirSync, readFileSync } from "node:fs";
import { join, relative } from "node:path";
import { expect, it } from "vitest";

const ROOT = join(import.meta.dirname, "..", "..");
const SRC = join(ROOT, "src");

const unseen = (code: number) =>
  code === 0xfeff ||
  code === 0x00a0 ||
  code === 0x1680 ||
  (code >= 0x2000 && code <= 0x200f) ||
  code === 0x2028 ||
  code === 0x2029 ||
  code === 0x202f ||
  code === 0x205f ||
  code === 0x2060 ||
  code === 0x3000 ||
  (code >= 0xe000 && code <= 0xf8ff);

const name16 = (code: number) => "U+" + code.toString(16).toUpperCase().padStart(4, "0");

function files(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((e) => (e.isDirectory() ? files(join(dir, e.name)) : /\.(ts|mjs|js|css|html)$/.test(e.name) ? [join(dir, e.name)] : []));
}

it("Corillo's code holds no raw character that can't be seen", () => {
  const found: string[] = [];
  for (const file of files(SRC)) {
    // (Split on the ordinary line break only: a raw line separator must not count as a line's end here.)
    readFileSync(file, "utf8")
      .split(String.fromCharCode(10))
      .forEach((line, i) => {
        const codes = [...line].map((ch) => ch.codePointAt(0)!).filter(unseen);
        if (codes.length) found.push(`${relative(ROOT, file)}:${i + 1}: ${codes.map(name16).join(" ")}`);
      });
  }
  expect(found).toEqual([]);
});
