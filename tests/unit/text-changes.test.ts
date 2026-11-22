import { describe, expect, it } from "vitest";
import { applyEdits, asItReads, catchUp, diffLines, formatHunks } from "../../src/core/text-changes";
import { applyPlaced, placeEdits } from "../../src/core/change-links";

/** Apply a diff's hunks to the old text, the way an agent would. */
function patch(before: string, diff: string): string {
  const lines = before.split("\n");
  const hunks = diff.split(/^(?=@@ )/m);
  let shift = 0;
  for (const h of hunks) {
    const [header, ...body] = h.replace(/\n$/, "").split("\n");
    const m = /^@@ -(\d+),(\d+) \+(\d+),(\d+) @@$/.exec(header)!;
    const oldStart = Number(m[1]);
    const oldCount = Number(m[2]);
    const removed = body.filter((l) => l.startsWith("-")).map((l) => l.slice(1));
    const added = body.filter((l) => l.startsWith("+")).map((l) => l.slice(1));
    expect(removed).toHaveLength(oldCount);
    const at = (oldCount === 0 ? oldStart : oldStart - 1) + shift;
    expect(lines.slice(at, at + oldCount)).toEqual(removed);
    lines.splice(at, oldCount, ...added);
    shift += added.length - removed.length;
  }
  return lines.join("\n");
}

describe("what changed since an agent's last read", () => {
  const before = "# Plan\n\nIntro.\n\nWe hire two people.\n\n## Budget\n\nTight.\n";

  it("nothing changed: the agent is told so, and gets no text", () => {
    expect(catchUp(before, before)).toEqual({ kind: "same" });
  });

  it("a changed line comes as a small unified diff with line numbers", () => {
    const long = before + "\nMore text that stays the same, as most of a document does between reads.\n".repeat(5);
    const after = long.replace("We hire two people.", "We hire three people.");
    const c = catchUp(long, after);
    expect(c).toEqual({ kind: "changes", diff: "@@ -5,1 +5,1 @@\n-We hire two people.\n+We hire three people." });
  });

  it("in a short document, the whole text is about as cheap as the changes, so it's sent whole", () => {
    expect(catchUp(before, before.replace("two", "three"))).toEqual({ kind: "whole" });
  });

  it("added and removed lines are numbered the way unified diffs number them", () => {
    const after = "# Plan\n\nIntro.\n\nNew paragraph.\n\nWe hire two people.\n\n## Budget\n";
    const hunks = diffLines(before, after)!;
    const diff = formatHunks(hunks);
    expect(diff).toContain("@@ -4,0 +5,2 @@\n+New paragraph.\n+");
    expect(diff).toContain("-Tight.");
    expect(patch(before, diff)).toBe(after);
  });

  it("applying the diff to the old text always gives the new text", () => {
    const cases: [string, string][] = [
      ["a\nb\nc\nd\ne\n", "a\nc\nd\nx\ne\ny\n"],
      ["", "one\ntwo\n"],
      ["one\ntwo\n", ""],
      ["same\nsame\nsame\n", "same\nother\nsame\nsame\n"],
      ["x\n".repeat(40), "x\n".repeat(20) + "changed\n" + "x\n".repeat(19)],
    ];
    for (const [a, b] of cases) expect(patch(a, formatHunks(diffLines(a, b)!))).toBe(b);
  });

  it("when most of the text changed, the agent gets the whole text instead", () => {
    expect(catchUp("one\ntwo\nthree\n", "uno\ndos\ntres\n")).toEqual({ kind: "whole" });
  });

  it("very many scattered changes give up on the diff rather than take long", () => {
    const a = Array.from({ length: 400 }, (_, i) => `line ${i}`).join("\n");
    const b = Array.from({ length: 400 }, (_, i) => (i % 2 ? `changed ${i}` : `line ${i}`)).join("\n");
    expect(diffLines(a, b, 100)).toBeNull();
  });

  // R-AG-8: with lines only added (or only taken out), the limit wasn't looked at.
  it("gives up on the diff past the limit when lines were only added or only taken out", () => {
    const base = "# Plan\n\nIntro.\n";
    const more = Array.from({ length: 3000 }, (_, i) => `Added line ${i}.`).join("\n") + "\n";
    expect(diffLines(base, base + more)).toBeNull();
    expect(diffLines(base + more, base)).toBeNull();
    expect(diffLines(base, base + "One more.\n")).not.toBeNull();
  });
});

describe("exact find-and-replace edits", () => {
  const text = "# Plan\n\nWe hire **two** people.\n\nThe budget is tight.\nThe budget is fixed.\n";

  it("replaces text that appears exactly once", () => {
    const r = applyEdits(text, [{ find: "**two**", replace: "**three**" }]);
    expect(r).toMatchObject({ ok: true, text: text.replace("**two**", "**three**") });
  });

  it("applies several edits together, each against the text as it was", () => {
    const r = applyEdits(text, [
      { find: "is fixed.", replace: "is set." },
      { find: "# Plan", replace: "# Hiring plan" },
    ]);
    expect(r).toMatchObject({ ok: true, text: "# Hiring plan\n\nWe hire **two** people.\n\nThe budget is tight.\nThe budget is set.\n" });
  });

  it("refuses text that appears more than once, saying where, and changes nothing", () => {
    const r = applyEdits(text, [{ find: "The budget", replace: "Our budget" }]);
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.error).toContain("appears 2 times (lines 5, 6)");
      expect(r.error).toContain("Nothing was changed.");
    }
  });

  it("refuses text that isn't there, and points out a near miss in spacing or capitals", () => {
    const r = applyEdits(text, [{ find: "we hire  **two**\npeople", replace: "x" }]);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toContain("nearly matches at line 3");
    const none = applyEdits(text, [{ find: "Not in it", replace: "x" }]);
    expect(none.ok).toBe(false);
    if (!none.ok) expect(none.error).toContain("isn't in the document");
  });

  it("if any edit fails, none are made", () => {
    const r = applyEdits(text, [
      { find: "# Plan", replace: "# New" },
      { find: "missing", replace: "x" },
    ]);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toMatch(/^Edit 2:/);
  });

  it("refuses overlapping edits and empty finds", () => {
    const overlap = applyEdits(text, [
      { find: "We hire **two**", replace: "a" },
      { find: "**two** people", replace: "b" },
    ]);
    expect(overlap.ok).toBe(false);
    if (!overlap.ok) expect(overlap.error).toContain("Edits 1 and 2 overlap");
    const empty = applyEdits(text, [{ find: "", replace: "x" }]);
    expect(empty.ok).toBe(false);
  });

  it("works on a document with Windows line endings when the edit uses plain line breaks", () => {
    const crlf = "One.\r\nTwo.\r\n";
    expect(applyEdits(crlf, [{ find: "One.\nTwo.", replace: "One.\nThree." }])).toMatchObject({ ok: true, text: "One.\r\nThree.\r\n" });
  });

  it("with all, changes every match (a name used throughout), and still refuses text that isn't there", () => {
    const r = applyEdits(text, [
      { find: "The budget", replace: "Our budget", all: true },
      { find: "# Plan", replace: "# Hiring plan" },
    ]);
    expect(r).toMatchObject({ ok: true, text: "# Hiring plan\n\nWe hire **two** people.\n\nOur budget is tight.\nOur budget is fixed.\n" });
    if (r.ok) expect(r.placed.map((p) => p.edit)).toEqual([2, 1, 1]);
    // Matches that run into each other count once: "aaaa" holds "aa" twice, not three times.
    expect(applyEdits("aaaa", [{ find: "aa", replace: "b", all: true }])).toMatchObject({ ok: true, text: "bb" });
    const none = applyEdits(text, [{ find: "Not in it", replace: "x", all: true }]);
    expect(none.ok).toBe(false);
    const twice = applyEdits(text, [{ find: "The budget", replace: "x" }]);
    if (!twice.ok) expect(twice.error).toContain("or set all to true to change every one");
  });

  it("shows each change as it now reads, with a little of what's around it, so the agent can check it", () => {
    const r = applyEdits(text, [{ find: "is fixed.", replace: "is set." }, { find: "**two**", replace: "**three**" }]);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    // In the order they come in the document, easier to check than the order they were given (roadmap Batch 1, item 3).
    expect(asItReads(r.text, r.placed)).toBe('line 3: "We hire **three** people."\nline 6: "The budget is set."');
    // Many matches: the first two, then how many more.
    const many = applyEdits("a b\na b\na b\na b\n", [{ find: "a", replace: "c", all: true }]);
    if (many.ok) expect(asItReads(many.text, many.placed)).toBe('line 1: "c b"\nline 2: "c b"\n(and 2 more like it)');
    // A long replacement is shortened in the middle; long lines are cut around the change.
    const long = "x".repeat(100) + " old " + "y".repeat(100);
    const big = applyEdits(long, [{ find: "old", replace: "n".repeat(300) }]);
    if (big.ok) expect(asItReads(big.text, big.placed)).toBe(`line 1: "…${"x".repeat(49)} ${"n".repeat(80)} [...] ${"n".repeat(80)} ${"y".repeat(49)}…"`);
  });
});

describe("a document with both kinds of line ends", () => {
  // Some lines end Windows style (CRLF), some not: an edit across a plain line
  // break used to be turned into CRLF and reported as not in the document.
  const text = "# Plan\r\n\r\nFirst line.\nSecond line.\r\nThird line.\n";

  it("an edit across either kind of line break matches, and keeps the line ends it found", () => {
    const plain = applyEdits(text, [{ find: "First line.\nSecond", replace: "First line, longer.\nSecond" }]);
    expect(plain).toMatchObject({ ok: true, text: "# Plan\r\n\r\nFirst line, longer.\nSecond line.\r\nThird line.\n" });
    const windows = applyEdits(text, [{ find: "Second line.\nThird", replace: "Second line.\nNew line.\nThird" }]);
    expect(windows).toMatchObject({ ok: true, text: "# Plan\r\n\r\nFirst line.\nSecond line.\r\nNew line.\r\nThird line.\n" });
  });

  it("is placed the same way for the comment links", () => {
    const edits = [{ find: "First line.\nSecond", replace: "One.\nTwo" }, { find: "line.\nThird", replace: "line.\nLast" }];
    const result = applyEdits(text, edits);
    expect(result.ok).toBe(true);
    expect(applyPlaced(text, placeEdits(text, edits))).toBe(result.ok ? result.text : "");
  });
});
