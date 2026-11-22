// How a document's name reads where the person sees it (roadmap Batch 5,
// item 2, person quick win 9): without ".md", as Word shows "Offsite notes"
// for "Offsite notes.docx". And the request the blank page's Copy button puts
// on the clipboard (P-8), naming the document and its folder.
import { describe, expect, it } from "vitest";
import { draftRequest, MARKDOWN_NAMED, newDocumentName, OPENS_AS_MARKDOWN, OPENS_WHEN_DROPPED, shownName } from "../../src/core/doc-names";

describe("A document's name, where the person sees it", () => {
  it("leaves out the Markdown ending, in any capitals", () => {
    expect(shownName("Offsite notes.md")).toBe("Offsite notes");
    expect(shownName("plan.MD")).toBe("plan");
    expect(shownName("Q3 plan.markdown")).toBe("Q3 plan");
    expect(shownName("notes.mdown")).toBe("notes");
  });

  it("keeps the rest of the name whole, dots included", () => {
    expect(shownName("v1.2 plan.md")).toBe("v1.2 plan");
    expect(shownName("plan.md.md")).toBe("plan.md");
  });

  it("keeps other endings, which tell a file of another kind apart", () => {
    expect(shownName("notes.txt")).toBe("notes.txt");
    expect(shownName("Offsite notes.docx")).toBe("Offsite notes.docx");
    expect(shownName("README")).toBe("README");
  });

  it("never leaves a name empty", () => {
    expect(shownName(".md")).toBe(".md");
    expect(shownName(" .md")).toBe(" .md");
  });
});

describe("The request a blank document's Copy button puts on the clipboard", () => {
  it("names the document as the person sees it, and its folder, with room to go on", () => {
    expect(draftRequest("Q4 brief.md", "Documents")).toBe(`Write a first draft of "Q4 brief" in Corillo (it's in Documents). `);
    expect(draftRequest("Offsite.md", "Documents › Work")).toBe(`Write a first draft of "Offsite" in Corillo (it's in Documents › Work). `);
  });
});

describe("The file New Document makes for the name the person typed (B5-05)", () => {
  it("is always a Markdown file: .md added to a name with no ending, or with a dot in it", () => {
    expect(newDocumentName("Plan")).toBe("Plan.md");
    expect(newDocumentName("Notes 11.11")).toBe("Notes 11.11.md");
    expect(newDocumentName("v1.2 plan")).toBe("v1.2 plan.md");
  });

  it("takes off a Word or other app's ending first, so no empty Word file is ever made", () => {
    expect(newDocumentName("Plan.docx")).toBe("Plan.md");
    expect(newDocumentName("Q4 brief.DOCX")).toBe("Q4 brief.md");
    expect(newDocumentName("Old.doc")).toBe("Old.md");
    expect(newDocumentName("Letter.dotx")).toBe("Letter.md");
    expect(newDocumentName("Notes.rtf")).toBe("Notes.md");
    expect(newDocumentName("Notes.pages")).toBe("Notes.md");
    expect(newDocumentName("Brief.pdf")).toBe("Brief.md");
  });

  it("keeps a Markdown or text ending as typed", () => {
    expect(newDocumentName("Plan.md")).toBe("Plan.md");
    expect(newDocumentName("Plan.markdown")).toBe("Plan.markdown");
    expect(newDocumentName("notes.txt")).toBe("notes.txt");
  });
});

describe("Markdown's endings, each set named once (G21-13)", () => {
  const takes = (set: RegExp) => ["a.md", "a.MARKDOWN", "a.mdown", "a.txt", "a.docx", "a.doc", "a.pdf"].filter((n) => set.test(n));

  it("Corillo opens Markdown's endings and plain text", () => {
    expect(takes(OPENS_AS_MARKDOWN)).toEqual(["a.md", "a.MARKDOWN", "a.mdown", "a.txt"]);
  });

  it("an agent's new document, or a note link opened in Corillo, ends in .md or .markdown", () => {
    expect(takes(MARKDOWN_NAMED)).toEqual(["a.md", "a.MARKDOWN"]);
  });

  it("dropping on the window opens those, and Word documents", () => {
    expect(takes(OPENS_WHEN_DROPPED)).toEqual(["a.md", "a.MARKDOWN", "a.mdown", "a.txt", "a.docx", "a.doc"]);
  });

  it("a name is shown without Markdown's own endings, and keeps .txt", () => {
    expect(["a.md", "a.MARKDOWN", "a.mdown", "a.txt"].map(shownName)).toEqual(["a", "a", "a", "a.txt"]);
  });
});
