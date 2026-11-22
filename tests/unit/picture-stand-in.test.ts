// A picture, a footnote marker or a line break takes one character in a
// block's text: U+FFFC, which most editors and diffs show as nothing. It is
// written once, as PICTURE_STAND_IN in src/core/doc-diff.ts, and every other
// file uses that (roadmap Batch 20, item 2; R16-8). Two places writing it
// differently would lose comments on pictures with nothing in a diff to say why.
import { describe, expect, it } from "vitest";
import { readdirSync, readFileSync } from "node:fs";
import { join, relative } from "node:path";
import { transformSync } from "esbuild";
import { PICTURE_STAND_IN } from "../../src/core/doc-diff";

const ROOT = join(import.meta.dirname, "..", "..");
const SRC = join(ROOT, "src");
const HOME = "src/core/doc-diff.ts";
const DEFINED = 'export const PICTURE_STAND_IN = "\\uFFFC";';

/** The character itself, or any way of writing it: \uFFFC, \u{FFFC}, 0xFFFC, 65532, &#xFFFC;, &#65532;. */
const STAND_IN = /\uFFFC|\\u\{?0*fffc\}?|0x0*fffc\b|\b65532\b|&#x0*fffc;|&#0*65532;/i;

/**
 * The code without its comments: a TypeScript file as the build reads it
 * (esbuild, which writes a string's characters past ASCII as escapes), a page
 * or style sheet without <!-- --> and /* *\/.
 */
function withoutComments(file: string, text: string): string {
  if (file.endsWith(".ts")) return transformSync(text, { loader: "ts", legalComments: "none", charset: "ascii" }).code;
  return text.replace(/<!--[\s\S]*?-->/g, "").replace(/\/\*[\s\S]*?\*\//g, "");
}

/** Each line of the code (comments left out) that writes the stand-in. */
function standInsIn(file: string, text: string): string[] {
  return withoutComments(file, text)
    .split("\n")
    .filter((line) => STAND_IN.test(line))
    .map((line) => line.trim());
}

function textFiles(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const full = join(dir, entry.name);
    if (entry.isDirectory()) return textFiles(full);
    return /\.(ts|html|css|txt|json|md|mjs|js)$/.test(entry.name) ? [full] : [];
  });
}

describe("the picture's stand-in character", () => {
  it("is U+FFFC, one character", () => {
    expect(PICTURE_STAND_IN).toBe(String.fromCodePoint(0xfffc));
    expect(PICTURE_STAND_IN.length).toBe(1);
  });

  it("is written in one place in src/, PICTURE_STAND_IN in doc-diff.ts; every other file uses that (comments aside)", () => {
    const found: Record<string, string[]> = {};
    for (const file of textFiles(SRC)) {
      const name = relative(ROOT, file);
      const lines = standInsIn(name, readFileSync(file, "utf8"));
      if (lines.length) found[name] = lines;
    }
    expect(found).toEqual({ [HOME]: [DEFINED] });
  });

  it("is found planted in code however it's written, and not in a comment", () => {
    const planted = [
      'const a = "\uFFFC";',
      'const b = "\\uFFFC";',
      "const c = /[\\s|\\ufffc]/;",
      'const d = "\\u{FFFC}";',
      "const e = String.fromCharCode(0xfffc);",
      "const f = String.fromCharCode(65532);",
      "const g = `x${y}\\uFFFC`;",
    ];
    for (const line of planted) expect(standInsIn("planted.ts", line), line).toHaveLength(1);
    expect(standInsIn("planted.html", "<p>&#xFFFC;</p>")).toEqual(["<p>&#xFFFC;</p>"]);
    const comments = ['// a picture is "\uFFFC" here', "/** U+FFFC is \\uFFFC */", "const h = 1; /* 0xfffc */"];
    for (const line of comments) expect(standInsIn("planted.ts", line), line).toEqual([]);
    expect(standInsIn("planted.html", "<!-- &#xFFFC; -->")).toEqual([]);
  });
});
