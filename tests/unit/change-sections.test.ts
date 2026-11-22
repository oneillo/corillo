// History's rows name the sections each version touched, from the headings
// the parser finds, and say what it changed (roadmap Batch 4, item 2, L-10).
import { describe, expect, it } from "vitest";
import { SECTIONS_KEPT, START, storyOf } from "../../src/core/change-sections";
import { parseMarkdown } from "../../src/core/markdown";
import { sectionAt, sectionsOf } from "../../src/core/sections";

const DOC = `# Help desk proposal

Intro words before any section.

## 1. Executive summary

We should hire two people.

## 2. The problem

The queue grows every week.

### 2.1 Who answers

Nobody can see who already answered.

#### A detail heading

Deep words here.

## 3. Proposed approach

One shared inbox for everyone.
`;

describe("the sections a version touched", () => {
  it("names the section of each change, in the order they come in the document", () => {
    const after = DOC.replace("hire two people", "hire three people").replace("One shared inbox", "A single shared inbox");
    expect(storyOf(DOC, after).sections).toEqual(["1. Executive summary", "3. Proposed approach"]);
  });

  it("names a level 3 heading's section, and goes past deeper headings to the level 3 one above", () => {
    expect(storyOf(DOC, DOC.replace("already answered", "already replied")).sections).toEqual(["2.1 Who answers"]);
    expect(storyOf(DOC, DOC.replace("Deep words here.", "Deep words changed here.")).sections).toEqual(["2.1 Who answers"]);
  });

  it("a change before the first section heading is in the title's section; with no heading above it, at the start", () => {
    expect(storyOf(DOC, DOC.replace("Intro words", "Opening words")).sections).toEqual(["Help desk proposal"]);
    const plain = "Before the heading.\n\n## Budget\n\nTight.\n";
    expect(storyOf(plain, plain.replace("Before", "Ahead of")).sections).toEqual([START]);
  });

  it("a document with no headings names no sections, but still says what changed", () => {
    const story = storyOf("The budget is tight.\n", "The budget is very tight.\n");
    expect(story.sections).toEqual([]);
    expect(story.change.total).toBe(1);
  });

  it("a renamed heading is named as it is now", () => {
    expect(storyOf(DOC, DOC.replace("## 2. The problem", "## 2. The real problem")).sections).toEqual(["2. The real problem"]);
  });

  it("a section taken out whole is named, though it's gone", () => {
    const after = DOC.replace("## 3. Proposed approach\n\nOne shared inbox for everyone.\n", "");
    expect(storyOf(DOC, after.trimEnd() + "\n").sections).toEqual(["3. Proposed approach"]);
  });

  it("a new section is named by its own heading", () => {
    const after = `${DOC}\n## 4. Risks\n\nThe budget may not stretch.\n`;
    expect(storyOf(DOC, after).sections).toEqual(["4. Risks"]);
  });

  it("two sections merged into one name both: where the words are now, and the heading that went", () => {
    const after = DOC.replace("The queue grows every week.\n\n### 2.1 Who answers\n\nNobody", "The queue grows every week, and nobody");
    expect(storyOf(DOC, after).sections).toEqual(["2. The problem", "2.1 Who answers"]);
  });

  it("a change across two sections names both", () => {
    const after = DOC.replace("hire two people.\n\n## 2. The problem\n\nThe queue grows", "hire two people now.\n\n## 2. The problem\n\nThe line grows");
    expect(storyOf(DOC, after).sections).toEqual(["1. Executive summary", "2. The problem"]);
  });

  it("a heading's words are as the page shows them, without Markdown signs", () => {
    const doc = "## The **big** `idea`\n\nWords.\n";
    expect(storyOf(doc, doc.replace("Words.", "More words.")).sections).toEqual(["The big idea"]);
  });

  it("a heading-like line inside a code block is not a section: only the parser's headings count", () => {
    const doc = "## Real\n\n```\n## Not a heading\n```\n\nAfter the code.\n";
    expect(storyOf(doc, doc.replace("After the code.", "After the code block.")).sections).toEqual(["Real"]);
  });

  it("only empty lines changed: nothing touched", () => {
    expect(storyOf(DOC, DOC.replace("\n\nWe should", "\n\n\nWe should")).sections).toEqual([]);
  });
});

// Review of Batch 4, B4-R03: History, the outline and the status bar name the
// same section for the same place, since they read the headings the same way
// (sectionsOf). An empty heading, or one holding only a picture, isn't a
// section in any of them: what follows it is in the section above.
describe("History names the section the outline and the status bar name", () => {
  const CASES: Record<string, string> = {
    "an empty heading": "# Intro\n\nOne.\n\n##\n\nTwo.\n",
    "a heading holding only a picture": "# Intro\n\nOne.\n\n## ![Chart](chart.png)\n\nTwo.\n",
    "a heading with a picture and words": "# Intro\n\nOne.\n\n## ![Icon](icon.png) Budget\n\nTwo.\n",
    "headings with the same words": "# A\n\n## Notes\n\nOne.\n\n# B\n\n## Notes\n\nTwo.\n",
    "a fourth-level heading": "# Intro\n\nOne.\n\n#### Deep\n\nTwo.\n",
    "setext headings": "Title\n=====\n\nOne.\n\nSub part\n--------\n\nTwo.\n",
    "front matter and code": "---\ntitle: Plan\n---\n\n# Real\n\n```\n# not a heading\n```\n\nTwo.\n",
    "formatting and spacing in a heading": "# Intro\n\n## The **big**   `idea`\n\nTwo.\n",
  };
  for (const [what, before] of Object.entries(CASES)) {
    it(what, () => {
      const after = before.replace("Two.", "Two more.");
      const doc = parseMarkdown(after).doc;
      let pos = -1;
      doc.descendants((node, p) => {
        if (node.isText && node.text!.startsWith("Two more.")) pos = p;
      });
      const sections = sectionsOf(doc);
      const at = sectionAt(sections, pos);
      expect(at).toBeGreaterThanOrEqual(0);
      expect(storyOf(before, after).sections).toEqual([sections[at].text]);
    });
  }
});

// Review of Batch 4, B4-R04: a pass over the whole document named every
// section, kept them all for up to 2,000 rows and sent them to the window,
// which showed two lines of them and cut the rest without a word. A row keeps
// the first few, in the order they come, and how many more there are.
describe("a version that changed many sections", () => {
  it("keeps the first few sections' names, in the order they come, and how many more there are", () => {
    const doc = Array.from({ length: 300 }, (_, i) => `## Part ${i + 1}\n\nWords ${i + 1}.\n`).join("\n");
    const story = storyOf(doc, doc.replace(/Words (\d+)\./g, "Words $1, changed."));
    expect(story.sections).toEqual(["Part 1", "Part 2", "Part 3", "Part 4", "Part 5", "Part 6"]);
    expect(story.sections).toHaveLength(SECTIONS_KEPT);
    expect(story.moreSections).toBe(294);
  });

  it("a few sections: all named, with nothing more to say", () => {
    const doc = Array.from({ length: SECTIONS_KEPT }, (_, i) => `## Part ${i + 1}\n\nWords ${i + 1}.\n`).join("\n");
    const story = storyOf(doc, doc.replace(/Words (\d+)\./g, "Words $1, changed."));
    expect(story.sections).toHaveLength(SECTIONS_KEPT);
    expect(story.moreSections).toBeUndefined();
  });
});

describe("what a version changed, as a line", () => {
  it("is the change line agents' changes have: whole words, the biggest places, every place counted", () => {
    const after = DOC.replace("hire two people", "hire three people").replace("every week", "every single week").replace("everyone.", "everyone!");
    const { change } = storyOf(DOC, after);
    expect(change.total).toBe(3);
    // A lone "!" says nothing on its own: counted, not shown.
    expect(change.shown).toEqual([
      { removed: "two", added: "three" },
      { removed: "", added: "single" },
    ]);
  });

  it("nothing changed: nothing to say", () => {
    expect(storyOf(DOC, DOC)).toEqual({ sections: [], change: { total: 0, shown: [] } });
  });

  // Batch 6: History's pictures showed a row reading ". Ana will bring the
  // slides". A sentence put in after a full stop is the same change as one put
  // in before it, with the full stop moved; the row starts where its words do.
  it("a sentence added after another starts at its first word, not at the full stop before it", () => {
    const before = `# Next steps

Ana will set up the trial account and invite the first five volunteers.

We'll report back with the numbers and what the volunteers said.
`;
    const after = before.replace("volunteers.", "volunteers. She'll start this week.").replace("said.", "said. Ana will bring the slides.");
    expect(storyOf(before, after).change.shown).toEqual([
      { removed: "", added: "She'll start this week." },
      { removed: "", added: "Ana will bring the slides." },
    ]);
    // Taken out again, the same.
    expect(storyOf(after, before).change.shown).toEqual([
      { removed: "She'll start this week.", added: "" },
      { removed: "Ana will bring the slides.", added: "" },
    ]);
  });
});
