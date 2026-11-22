// What an agent's change came to, in a few words (src/core/change-summary.ts):
// History's change line and what agents read in list_versions. Orlando,
// 2026-11-09: snippets like a lone comma or "it" tell him nothing.
import { describe, expect, it } from "vitest";
import { anchorIn } from "../../src/core/anchors";
import { changedPieces, type ChangeSpan } from "../../src/core/change-links";
import { countText, meaningful, summarizeChanges, summaryText, wholeWords } from "../../src/core/change-summary";

/** The places an agent's rewrite changed, as Corillo records them. */
function spansFor(before: string, after: string): ChangeSpan[] {
  return changedPieces(before, after).map((p) => ({ anchor: anchorIn(after, p.start, p.end), removed: p.removed }));
}

/** What a snippet shows, as one string: what went, then what came. */
const shown = (spans: ChangeSpan[], max?: number) =>
  summarizeChanges(spans, max).shown.map((s) => [s.removed, s.added].filter(Boolean).join(" > "));

const NIGHT = "The night falls over the quiet town and everyone sleeps soundly. A lamp burns in the window of the old house. Somewhere a dog barks twice.";
const GOTHIC = "The night falls over the quiet town, and the dark comes hungry. A lamp burns low in the window of the old, old house. Somewhere a dog howls twice.";
const DASH = String.fromCharCode(0x2014);

describe("the change line", () => {
  it("counts every place but shows only the ones with real words: never a lone comma or a short word", () => {
    // ", old" put into "the old house" is one place, not a comma and a word apart.
    const spans = spansFor(NIGHT, GOTHIC);
    expect(spans.length).toBe(5);
    const summary = summarizeChanges(spans);
    expect(summary.total).toBe(5);
    expect(shown(spans)).toEqual(["everyone sleeps soundly > the dark comes hungry", "barks > howls"]);
    expect(countText(summary)).toBe("Changed 5 places, including");
  });

  it("shows the biggest places, in the order they come in the document", () => {
    const before = "One fox. Two hens. Three geese walked slowly home. Four ducks. Five swans swam far across the lake.";
    const after = "One wolf. Two hens. Three geese ran home. Four ducks. Five swans flew away over the hills and the lake.";
    const spans = spansFor(before, after);
    expect(spans.length).toBe(3);
    expect(shown(spans, 2)).toEqual(["walked slowly > ran", "swam far across > flew away over the hills and"]);
    expect(countText(summarizeChanges(spans, 2))).toBe("Changed 3 places, including");
  });

  it("says only how many places changed when none has a word worth showing", () => {
    const spans = spansFor("Wait. Go now and see", "Wait, go now, and see it");
    expect(summarizeChanges(spans).shown).toEqual([]);
    expect(countText(summarizeChanges(spans))).toBe(`Changed ${spans.length} places (punctuation or short words)`);
    expect(countText(summarizeChanges(spansFor("Go now", "Go now.")))).toBe("Changed 1 place (punctuation or short words)");
  });

  it("shows every place, with no count, when all of them are worth showing", () => {
    const spans = spansFor("We hire two people.", "We hire three people.");
    expect(shown(spans)).toEqual(["two > three"]);
    expect(countText(summarizeChanges(spans))).toBeNull();
  });

  it("shows a change inside a word as the whole word, before and after", () => {
    const after = "The hungry night.";
    expect(wholeWords({ anchor: anchorIn(after, 8, 10), removed: "er" })).toEqual({ removed: "hunger", added: "hungry" });
    // Letters only taken out of a word.
    const shorter = "The hung night.";
    expect(wholeWords({ anchor: anchorIn(shorter, 8, 8), removed: "ry" })).toEqual({ removed: "hungry", added: "hung" });
    // A comma after a word isn't part of it.
    const comma = "The night, falls.";
    expect(wholeWords({ anchor: anchorIn(comma, 9, 10), removed: "" })).toEqual({ removed: "", added: "," });
  });

  it("keeps numbers, which matter even when short", () => {
    expect(shown(spansFor("We need 40 chairs.", "We need 45 chairs."))).toEqual(["40 > 45"]);
    expect(meaningful("7")).toBe(true);
  });

  it("knows what's worth reading: two words, a long word or a number; not punctuation or one short word", () => {
    for (const text of ["dark comes", "howls", "1,840", "of the"]) expect(meaningful(text), text).toBe(true);
    for (const text of [",", "it", "the", "a", DASH, ".", "", "old,"]) expect(meaningful(text), text).toBe(false);
  });

  it("cuts a long place at a space, never inside a word", () => {
    const long = "the dark comes hungry over every roof and chimney and steeple of the sleeping town tonight";
    const spans = spansFor("Calm.", `Calm. ${long}`);
    const [snippet] = summarizeChanges(spans).shown;
    expect(snippet.added.endsWith("…")).toBe(true);
    expect(snippet.added.length).toBeLessThanOrEqual(61);
    expect(long.startsWith(snippet.added.slice(0, -1))).toBe(true);
    expect(long[snippet.added.length - 1]).toBe(" ");
  });

  it("over many rewrites, never shows a snippet with only punctuation, a lone short word or part of a word, and always counts every place", () => {
    const words = ["night", "it", "dark", ",", "the", "a", "old", "hungry", "comes", ";", "house", "of", "and", "13", "window", "!"];
    let seed = 7;
    const random = () => (seed = (seed * 16807) % 2147483647) / 2147483647;
    const sentence = (n: number) =>
      Array.from({ length: n }, () => words[Math.floor(random() * words.length)])
        .join(" ")
        .replace(/ ([,;!])/g, "$1");
    for (let round = 0; round < 300; round++) {
      const before = sentence(20 + Math.floor(random() * 20));
      const after = before
        .split(" ")
        .map((w) => (random() < 0.25 ? sentence(1 + Math.floor(random() * 3)) : w))
        .join(" ");
      const spans = spansFor(before, after);
      const summary = summarizeChanges(spans);
      expect(summary.total).toBe(spans.length);
      expect(summary.shown.length).toBeLessThanOrEqual(Math.min(3, spans.length));
      for (const s of summary.shown) {
        expect(meaningful(s.removed) || meaningful(s.added), `${before} -> ${after}: ${JSON.stringify(s)}`).toBe(true);
        for (const [part, text] of [
          [s.removed, before],
          [s.added, after],
        ]) {
          if (!part) continue;
          // Whole words: somewhere in its text the part starts and ends where words do.
          const clean = part.replace(/…$/, "");
          const letter = (c: string | undefined) => !!c && /[\p{L}\p{N}]/u.test(c);
          const places: number[] = [];
          for (let at = text.indexOf(clean); at >= 0; at = text.indexOf(clean, at + 1)) places.push(at);
          const whole = places.some(
            (at) =>
              !(letter(text[at - 1]) && letter(clean[0])) &&
              (part.endsWith("…") || !(letter(text[at + clean.length]) && letter(clean[clean.length - 1]))),
          );
          expect(whole, `"${clean}" as whole words in "${text}"`).toBe(true);
        }
      }
      const count = countText(summary);
      if (summary.shown.length < summary.total) expect(count).toContain(`Changed ${summary.total} place`);
      else expect(count).toBeNull();
    }
  });
});

describe("for agents", () => {
  it("writes each place as [-old-]{+new+}, with the count when some aren't shown", () => {
    expect(summaryText(spansFor("We hire two people.", "We hire three people."))).toBe("[-two-]{+three+}");
    expect(summaryText(spansFor(NIGHT, GOTHIC))).toBe(
      "5 places, including [-everyone sleeps soundly-]{+the dark comes hungry+}; [-barks-]{+howls+}",
    );
    expect(summaryText(spansFor("Go now", "Go now."))).toBe("1 place (punctuation or short words)");
    expect(summaryText([])).toBe("");
  });
});
