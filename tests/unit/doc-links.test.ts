// The check that the window opens only links that are in its document: the
// document's saved text read the way the window reads it, and a link as the
// window holds it (just typed, or read back from the file) in the same form.
import { describe, expect, it } from "vitest";
import { linkKey, linksIn, notesIn } from "../../src/main/doc-links";
import { findObsidian } from "../../src/core/obsidian";

describe("links in a document", () => {
  // Typed a moment ago, the window holds a link as written; the saved text has it percent-encoded (R-SH-2).
  it("a link with spaces, accents, a bar or brackets is found in the saved text however the window writes it", () => {
    const saved = [
      "[Plan](Q3%20plan.md)",
      "[Café](Caf%C3%A9.md)",
      "[Wiki](https://fr.wikipedia.org/wiki/Caf%C3%A9)",
      "[Odd](<notes (draft) a|b.md>)",
      "[Site](https://café.example/menu)",
    ].join("\n\n");
    const links = linksIn(`${saved}\n`);
    for (const typed of [
      "Q3 plan.md",
      "Q3%20plan.md",
      "Café.md",
      "Caf%C3%A9.md",
      "https://fr.wikipedia.org/wiki/Café",
      "notes (draft) a|b.md",
      "https://café.example/menu",
    ]) {
      expect(links.has(linkKey(typed)), typed).toBe(true);
    }
    expect(links.has(linkKey("Q4 plan.md"))).toBe(false);
    expect(links.has(linkKey("javascript:alert(1)"))).toBe(false);
  });

  it("a file: address is text, not a link, as the window reads it when the document opens", () => {
    expect(linksIn("[Notes](file:///Users/me/notes.md)\n").size).toBe(0);
  });

  // The window finds [[links]] one paragraph at a time, so a %% in one paragraph doesn't hide a link in the next (R-MAIN-6).
  it("a note link between two stray %% in other paragraphs is found, as the window finds it", () => {
    const text = "Sales were up 50%% this year.\n\nSee [[Plan]] for more.\n\nMaybe 10%% more next year.\n";
    expect(findObsidian(text).some((f) => f.kind === "link")).toBe(false); // the whole file at once: hidden in a %% comment
    expect(notesIn(text)).toEqual(new Set(["Plan"]));
    expect(notesIn("Hidden %%[[Secret]]%% here, shown ![[Chart]].\n\n`[[Code]]`\n")).toEqual(new Set(["Chart"]));
  });
});
