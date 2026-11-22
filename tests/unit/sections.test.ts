// The outline (roadmap Batch 4, item 1): a document's headings to three
// levels, which section a place in the text is in, the open comments in each,
// and the sections others changed since the person handed the document over.
// (Done ticks, and their tests, went in roadmap Batch 9, item 9.)
import { describe, expect, it } from "vitest";
import { parseMarkdown } from "../../src/core/markdown";
import { changedSince, countIn, sectionAt, sectionsOf, sectionsTouched } from "../../src/core/sections";
import type { SinceHandOver } from "../../src/core/versions";

const doc = (text: string) => parseMarkdown(text).doc;

const PLAN = [
  "---",
  "title: Plan",
  "---",
  "",
  "Some words before any heading.",
  "",
  "# 1. Summary",
  "",
  "We should hire two people.",
  "",
  "## 1.1 Who",
  "",
  "```",
  "# not a heading, it's code",
  "```",
  "",
  "#### A small heading inside 1.1",
  "",
  "### 1.1.1 Detail",
  "",
  "Detail words.",
  "",
  "## 1.2 When",
  "",
  "In the spring.",
  "",
].join("\n");

describe("the outline's sections", () => {
  it("lists the headings to three levels, as written, never a # in code or front matter", () => {
    const sections = sectionsOf(doc(PLAN));
    expect(sections.map((s) => [s.level, s.text])).toEqual([
      [1, "1. Summary"],
      [2, "1.1 Who"],
      [3, "1.1.1 Detail"],
      [2, "1.2 When"],
    ]);
  });

  it("a section runs from its heading to the next heading listed; a fourth-level heading is inside it", () => {
    const d = doc(PLAN);
    const sections = sectionsOf(d);
    for (let i = 0; i < sections.length - 1; i++) expect(sections[i].to).toBe(sections[i + 1].from);
    expect(sections.at(-1)!.to).toBe(d.content.size);
    const small = d.textContent.indexOf("A small heading");
    expect(small).toBeGreaterThan(-1);
    let pos = -1;
    d.descendants((node, p) => {
      if (node.isText && node.text!.startsWith("A small heading")) pos = p;
    });
    expect(sectionAt(sections, pos)).toBe(1); // 1.1 Who
  });

  it("words before the first heading are in no section", () => {
    const d = doc(PLAN);
    let pos = -1;
    d.descendants((node, p) => {
      if (node.isText && node.text!.startsWith("Some words")) pos = p;
    });
    expect(sectionAt(sectionsOf(d), pos)).toBe(-1);
  });

  it("an empty heading isn't listed, and headings with the same words each have their own key", () => {
    const sections = sectionsOf(doc("# Notes\n\nA\n\n#\n\n## Notes\n\nB\n\n## Notes\n\nC\n"));
    expect(sections.map((s) => s.text)).toEqual(["Notes", "Notes", "Notes"]);
    expect(new Set(sections.map((s) => s.key)).size).toBe(3);
    expect(sections[0].key).toBe("Notes");
  });

  it("a heading's words are as shown: formatting and spacing don't change its key", () => {
    const [a] = sectionsOf(doc("## The **budget**   plan\n"));
    const [b] = sectionsOf(doc("## The budget plan\n"));
    expect(a.text).toBe("The budget plan");
    expect(a.key).toBe(b.key);
  });

  it("counts places by section, and finds every section a stretch of text touches", () => {
    const d = doc(PLAN);
    const sections = sectionsOf(d);
    const at = (words: string) => {
      let pos = -1;
      d.descendants((node, p) => {
        if (pos < 0 && node.isText && node.text!.includes(words)) pos = p + node.text!.indexOf(words);
      });
      return pos;
    };
    expect(countIn(sections, [at("hire two"), at("Detail words"), at("Detail words"), at("Some words"), at("spring")])).toEqual([1, 0, 2, 1]);
    expect([...sectionsTouched(sections, [{ start: at("hire two"), end: at("Detail words") }])].sort()).toEqual([0, 1, 2]);
    expect([...sectionsTouched(sections, [{ start: at("spring"), end: at("spring") }])]).toEqual([3]);
    expect([...sectionsTouched(sections, [{ start: at("Some words"), end: at("Some words") + 2 }])]).toEqual([]);
  });
});

describe("the sections others changed since the person handed it over", () => {
  const BASE = "# A\n\nAlpha words here.\n\n## B\n\nBeta words here.\n\n## C\n\nGamma words here.\n";
  const facts = (steps: { yours: boolean; text: string }[], base: string | null = BASE, agents = ["Claude"]): SinceHandOver => ({
    n: 3,
    saved: "",
    text: steps.length ? steps.at(-1)!.text : (base ?? ""),
    at: base === null && !steps.length ? null : "2026-11-10T10:00:00Z",
    base,
    steps,
    agents,
    outside: false,
  });

  it("lights the sections an agent changed, by their heading", () => {
    const agent = BASE.replace("Beta words", "Beta and more words");
    expect([...changedSince(facts([{ yours: false, text: agent }]), parseMarkdown)]).toEqual(["B"]);
  });

  it("leaves out what the person changed themselves since", () => {
    const agent = BASE.replace("Beta words", "Beta and more words");
    const mine = agent.replace("Gamma words", "Gamma and my words");
    expect([...changedSince(facts([{ yours: false, text: agent }, { yours: true, text: mine }]), parseMarkdown)]).toEqual(["B"]);
  });

  it("a section added by an agent is lit, and so is the one a section was taken out of", () => {
    const added = BASE + "\n## D\n\nDelta words here.\n";
    expect([...changedSince(facts([{ yours: false, text: added }]), parseMarkdown)]).toEqual(["D"]);
    const cut = BASE.replace("## B\n\nBeta words here.\n\n", "");
    expect([...changedSince(facts([{ yours: false, text: cut }]), parseMarkdown)]).toEqual(["A"]);
  });

  it("nothing is lit before anything was handed over, or when no one else changed it", () => {
    expect(changedSince(facts([], null, []), parseMarkdown).size).toBe(0);
    expect(changedSince(facts([{ yours: true, text: BASE.replace("Alpha", "My alpha") }], BASE, []), parseMarkdown).size).toBe(0);
  });
});
