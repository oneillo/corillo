// Corillo's look, checked from its style sheets: colours come only from the
// Adoquín tokens, every pair of text and background the app uses is readable
// (WCAG AA) in light and dark, and interface text is never set in capitals.
import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const ROOT = join(import.meta.dirname, "..", "..");
const css = (file: string) => readFileSync(join(ROOT, "src/renderer", file), "utf8").replace(/\/\*[\s\S]*?\*\//g, "");
const style = css("style.css");

function tokens(block: string): Record<string, string> {
  return Object.fromEntries([...block.matchAll(/--([a-z-]+):\s*(#[0-9A-Fa-f]{6})\s*;/g)].map((m) => [m[1], m[2]]));
}
const lightBlock = /:root\s*\{([^}]*)\}/.exec(style)![1];
const darkBlock = /@media \(prefers-color-scheme: dark\)\s*\{\s*:root[^{]*\{([^}]*)\}/.exec(style)![1];
const light = tokens(lightBlock);
const dark = { ...light, ...tokens(darkBlock) };

function luminance(hex: string): number {
  const [r, g, b] = [1, 3, 5].map((i) => {
    const c = parseInt(hex.slice(i, i + 2), 16) / 255;
    return c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
  });
  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
}
function contrast(a: string, b: string): number {
  const [hi, lo] = [luminance(a), luminance(b)].sort((x, y) => y - x);
  return (hi + 0.05) / (lo + 0.05);
}

// Each kind of text, and every surface it's shown on.
const SURFACES = ["chrome", "ground", "panel", "page", "hover", "raw"];
// Obsidian's callouts hold ordinary text, comments, links and the rest.
const CALLOUTS = ["callout-sky", "callout-mint", "callout-ochre", "callout-rose", "callout-lilac"];
const TEXT_ON: [string, string[]][] = [
  ["ink", [...SURFACES, "pressed", "accent-tint", "accent-line", "warn-tint", "comment-mark", "comment-mark-active", "find-tint", "find-current", "diff-added", "diff-removed-tint", "change-mark", ...CALLOUTS, "highlight-mark"]],
  ["ink-soft", [...SURFACES, "accent-tint", "warn-tint", ...CALLOUTS]],
  ["warning-ink", CALLOUTS],
  ["accent-ink", CALLOUTS],
  ["accent-ink", [...SURFACES, "accent-tint"]],
  ["on-accent", ["accent", "accent-strong", "accent-ink"]],
  ["warning-ink", [...SURFACES, "warn-tint"]],
  ["diff-removed", ["page", "diff-removed-tint"]],
  // Line numbers, beside the page's text and the Markdown text (roadmap Batch 9, item 12: quieter, still readable).
  ["line-number", ["page"]],
  ["agent-ink", ["agent-peach", "agent-sky", "agent-mint", "agent-lilac", "agent-ochre", "agent-rose"]],
  // An @ tag while it's typed: the comment box's own words over the agent's colour.
  ["ink", ["agent-peach", "agent-sky", "agent-mint", "agent-lilac", "agent-ochre", "agent-rose"]],
];

describe("Colours", () => {
  it("are all tokens: no colour is written anywhere else in the style sheets", () => {
    for (const file of ["style.css", "about.css"]) {
      const rules = css(file).replace(lightBlock, "").replace(darkBlock, "");
      // A colour inside a drawing written into the style sheet (%23 is #) counts too.
      expect(rules.match(/(#|%23)[0-9A-Fa-f]{3,8}\b|rgba?\(|hsla?\(/g), file).toBeNull();
    }
    expect(style).not.toMatch(/gradient\(/);
  });

  it("are the same tokens in light and dark", () => {
    expect(Object.keys(tokens(darkBlock)).sort()).toEqual(Object.keys(light).sort());
  });

  for (const [mode, palette] of [["light", light], ["dark", dark]] as const) {
    it(`keep text readable in ${mode} mode`, () => {
      const failures: string[] = [];
      for (const [text, backgrounds] of TEXT_ON) {
        for (const bg of backgrounds) {
          const ratio = contrast(palette[text], palette[bg]);
          if (ratio < 4.5) failures.push(`${text} on ${bg}: ${ratio.toFixed(2)}`);
        }
      }
      expect(failures).toEqual([]);
    });
  }

  it("keep the export on paper light, whatever the Mac's appearance", () => {
    expect(style).toMatch(/@media \(prefers-color-scheme: dark\)\s*\{\s*:root:not\(\.on-paper\)/);
    expect(readFileSync(join(ROOT, "src/renderer/export.html"), "utf8")).toMatch(/<html[^>]*class="on-paper"/);
  });
});

describe("Type", () => {
  it("is never set in capitals", () => {
    for (const file of ["style.css", "about.css"]) expect(css(file), file).not.toMatch(/text-transform:\s*uppercase/);
  });

  it("uses only the interface sizes, apart from the page's own text", () => {
    const sizes = new Set<number>();
    for (const file of ["style.css", "about.css"]) {
      for (const m of css(file).matchAll(/font(?:-size)?:[^;]*?\b(\d+)px/g)) sizes.add(Number(m[1]));
    }
    // Interface text is 11 to 15, window titles 24, the start screen's name 28.
    // The rest are the page's: code and help text 14, bold and italic in the
    // toolbar 16, the document's words 17.
    const allowed = new Set([11, 12, 13, 14, 15, 16, 17, 24, 28]);
    expect([...sizes].filter((s) => !allowed.has(s))).toEqual([]);
  });
});
