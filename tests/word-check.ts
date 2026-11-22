// For tests: a look inside a Word file Corillo exported, standing in a
// little for opening it in real Word. It lists what's wrong:
//
// - one of Corillo's own styles (callouts, quotes inside quotes, diagrams)
//   used but defined with no formatting of its own, as Pandoc makes up a
//   style the template lacks, so the words would look plain;
// - with Corillo's own style file, any style used that it doesn't define (a
//   person's template is theirs: Pandoc refers to its usual styles whether
//   the template has them or not, and Word shows those as plain text);
// - a picture whose file isn't in the Word file or isn't a picture;
// - anything in the Word file's pictures folder that no picture uses;
// - with Corillo's own style file, space before or after plain text (the
//   space is the file's empty lines, each an empty paragraph: Orlando,
//   2026-11-09), or an empty line's mark left in the words;
// - an empty line under a heading that isn't kept with the next paragraph:
//   Word keeps a heading with the paragraph after it, so if that's an empty
//   line not kept with the text, the heading can end a page alone.
import { execFileSync } from "node:child_process";

/**
 * Whether these bytes start as a picture Word shows does (PNG, JPEG, GIF,
 * BMP, TIFF, EMF, WMF or SVG), judged here rather than by Corillo's own
 * check, so a check of Corillo's that let too much through can't pass this too.
 */
function isPicture(b: Buffer): boolean {
  const starts = (...bytes: number[]) => bytes.every((x, i) => b[i] === x);
  if (starts(0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a)) return true; // PNG
  if (starts(0xff, 0xd8, 0xff)) return true; // JPEG
  if (/^GIF8[79]a/.test(b.toString("latin1", 0, 6))) return true;
  if (starts(0x42, 0x4d) && b.length > 26) return true; // BMP
  if (starts(0x49, 0x49, 0x2a, 0x00) || starts(0x4d, 0x4d, 0x00, 0x2a)) return true; // TIFF
  if (starts(0x01, 0x00, 0x00, 0x00) && b.toString("latin1", 40, 44) === " EMF") return true;
  if (starts(0xd7, 0xcd, 0xc6, 0x9a)) return true; // WMF
  return /^\s*(<\?xml[^>]*>\s*)?(<!--[\s\S]*?-->\s*|<!DOCTYPE[^>]*>\s*)*<svg[\s>]/i.test(b.toString("utf8", 0, 4096));
}

const CORILLO_STYLES = /^(Callout (Sky|Mint|Ochre|Rose|Lilac|Stone)|Block Text [23]|Diagram)$/;

function entries(file: string): string[] {
  return execFileSync("unzip", ["-Z1", file], { encoding: "utf8" }).trim().split("\n");
}

function read(file: string, entry: string): Buffer {
  // unzip reads its name as a pattern: brackets need escaping.
  return execFileSync("unzip", ["-p", file, entry.replace(/[[\]]/g, "\\$&")], { maxBuffer: 64 * 1024 * 1024 });
}

const decode = (s: string) => s.replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&quot;/g, '"').replace(/&apos;/g, "'").replace(/&amp;/g, "&");

export function wordFileProblems(file: string): string[] {
  const problems: string[] = [];
  const all = entries(file);
  const text = (entry: string) => (all.includes(entry) ? read(file, entry).toString("utf8") : "");

  // Styles.
  const styles = text("word/styles.xml");
  const defined = new Map<string, { name: string; body: string }>();
  for (const m of styles.matchAll(/<w:style\b[^>]*\bw:styleId="([^"]+)"[^>]*>([\s\S]*?)<\/w:style>/g)) {
    defined.set(m[1], { name: decode(/<w:name w:val="([^"]*)"/.exec(m[2])?.[1] ?? ""), body: m[2] });
  }
  const parts = all.filter((e) => /^word\/(document|footnotes|endnotes|header\d*|footer\d*)\.xml$/.test(e));
  const used = new Set<string>();
  for (const part of parts) for (const m of text(part).matchAll(/<w:(?:pStyle|rStyle) w:val="([^"]+)"/g)) used.add(m[1]);
  const corillos = [...defined.values()].some((d) => d.name === "Callout Sky" && /<w:pPr>/.test(d.body));
  for (const id of used) {
    const style = defined.get(id);
    if (!style) {
      if (corillos) problems.push(`style ${id} is used but not defined`);
    } else if (CORILLO_STYLES.test(style.name) && !/<w:pPr>|<w:rPr>/.test(style.body)) {
      problems.push(`style ${style.name} is used but has no formatting`);
    }
  }

  // Plain text has no space of its own around it; empty lines are empty paragraphs, their marks gone.
  if (corillos) {
    const defaults = /<w:pPrDefault>[\s\S]*?<\/w:pPrDefault>/.exec(styles)?.[0] ?? "";
    const spaceOf = (id: string, seen = 0): string => {
      const style = defined.get(id);
      const own = style && /<w:spacing ([^>]*)\/>/.exec(style.body)?.[1];
      if (own) return own;
      const based = style && /<w:basedOn w:val="([^"]+)"/.exec(style.body)?.[1];
      return based && seen < 10 ? spaceOf(based, seen + 1) : (/<w:spacing ([^>]*)\/>/.exec(defaults)?.[1] ?? "");
    };
    for (const id of ["BodyText", "FirstParagraph", "Compact"]) {
      const space = spaceOf(id);
      for (const side of ["before", "after"]) {
        if (Number(new RegExp(`w:${side}="(\\d+)"`).exec(space)?.[1] ?? 0) > 0) problems.push(`${defined.get(id)?.name ?? id} has space ${side} it`);
      }
    }
  }
  if (/corillo blank/.test(text("word/document.xml"))) problems.push("an empty line's mark is left in the words");

  // A heading stays with its first words, through however many empty lines sit between.
  const keepOf = (pPr: string): boolean | undefined => {
    const keep = /<w:keepNext(?: w:val="([^"]*)")?\s*\/>/.exec(pPr);
    return keep ? !["0", "false", "off"].includes(keep[1] ?? "") : undefined;
  };
  const styleKeeps = (id: string, seen = 0): boolean => {
    const style = defined.get(id);
    const own = style && keepOf(/<w:pPr>([\s\S]*?)<\/w:pPr>/.exec(style.body)?.[1] ?? "");
    if (own !== undefined) return own;
    const based = style && /<w:basedOn w:val="([^"]+)"/.exec(style.body)?.[1];
    return based && seen < 10 ? styleKeeps(based, seen + 1) : false;
  };
  const paragraphs = [...text("word/document.xml").matchAll(/<w:p\b[^>]*?\/>|<w:p\b[^>]*>([\s\S]*?)<\/w:p>/g)].map(([, body = ""]) => {
    const pPr = /^\s*<w:pPr>([\s\S]*?)<\/w:pPr>/.exec(body)?.[1] ?? "";
    const style = /<w:pStyle w:val="([^"]+)"/.exec(pPr)?.[1] ?? "";
    return {
      words: decode([...body.matchAll(/<w:t\b[^>]*>([^<]*)<\/w:t>/g)].map((m) => m[1]).join("")),
      empty: !/<w:t\b[^>]*>[^<]|<w:drawing\b|<w:pict\b|<w:object\b/.test(body),
      heading: /^heading [1-9]$/i.test(defined.get(style)?.name ?? "") || /^Heading[1-9]$/.test(style),
      kept: keepOf(pPr) ?? (style ? styleKeeps(style) : false),
    };
  });
  paragraphs.forEach((p, i) => {
    if (!p.heading) return;
    for (let j = i + 1; j < paragraphs.length && paragraphs[j].empty; j++) {
      if (!paragraphs[j].kept) {
        problems.push(`the empty line under the heading "${p.words}" isn't kept with the text after it`);
        return;
      }
    }
  });

  // Pictures: each one's file is there and is a picture, and nothing else is in word/media.
  const media = new Set(all.filter((e) => e.startsWith("word/media/") && !e.endsWith("/")));
  const pictured = new Set<string>();
  for (const rels of all.filter((e) => /^word\/_rels\/.+\.rels$/.test(e))) {
    for (const m of text(rels).matchAll(/<Relationship\b[^>]*>/g)) {
      const rel = m[0];
      if (!/Type="[^"]*\/image"/.test(rel) || /TargetMode="External"/.test(rel)) continue;
      const target = decode(/Target="([^"]+)"/.exec(rel)?.[1] ?? "");
      const entry = target.startsWith("/") ? target.slice(1) : `word/${target}`;
      pictured.add(entry);
      if (!media.has(entry) && !all.includes(entry)) problems.push(`picture ${target} is missing from the Word file`);
      else if (!isPicture(read(file, entry))) problems.push(`picture ${target} isn't a picture`);
    }
  }
  for (const entry of media) if (!pictured.has(entry)) problems.push(`${entry} is in the Word file but no picture uses it`);
  return problems;
}
