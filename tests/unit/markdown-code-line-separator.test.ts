// Batch 21, S21-5: the Markdown family's finding on a line separator in bold code
// (review/batch-21/seams.md). markdown-inline.ts gives the line separator
// (U+2028) and the paragraph separator (U+2029) stand-ins while a paragraph
// is written, because the patterns that move spaces outside bold and italic
// stop at them and drop what follows. Code is left out of that
// (withLineMarks: "Code is written as it is"), but code that is also bold,
// italic or struck still goes through those patterns (writtenOrder). With a
// space beside the separator, the words after it are dropped, and the safety
// net then refuses every save of the document.
//
// Each asserts the right behaviour.
import { describe, expect, it } from "vitest";
import { schema } from "../../src/core/schema";
import { parseMarkdown, serializeMarkdown } from "../../src/core/markdown";
import { checkSave } from "../../src/core/write-check";

// (Made from its number, so no character that can't be seen is in this file.)
const LS = String.fromCharCode(0x2028);

const boldCode = (text: string) =>
  schema.node("doc", null, [
    schema.node("paragraph", null, [schema.text("x "), schema.text(text, [schema.marks.strong.create(), schema.marks.code.create()]), schema.text(" y")]),
  ]);

describe("bold code holding a line separator (U+2028) beside a space", () => {
  it("control: without the space, every word is written", () => {
    const out = serializeMarkdown(boldCode(`a${LS}b`), parseMarkdown("").source);
    expect(parseMarkdown(out).doc.textContent).toContain("b");
  });

  it("keeps the words after the separator", () => {
    const out = serializeMarkdown(boldCode(`a ${LS}b`), parseMarkdown("").source);
    expect(parseMarkdown(out).doc.textContent).toContain("b");
  });

  it("can be saved", () => {
    const check = checkSave(boldCode(`a ${LS}b`), parseMarkdown("").source);
    expect(check.ok ? "saved" : `refused, would lose ${JSON.stringify(check.lost)}`).toBe("saved");
  });
});
