// Batch 23, item 2 (the wider round-trip tests found it): typing into a task
// with no words ("- [ ]") wrote the words straight after the box, "- [ ]Z",
// which Markdown reads as a plain bullet holding "[ ]Z", not a task. The
// safety net caught it and wrote the list another way, so nothing was lost,
// but the writer itself was wrong: the line it keeps from the file now has a
// space after the box before the words typed.
//
// Each case is a made-up document: opened, typed in, saved.
import { describe, expect, it } from "vitest";
import { EditorState } from "prosemirror-state";
import { parseMarkdown, serializeMarkdown } from "../../src/core/markdown";
import { checkSave } from "../../src/core/write-check";

/** Open the file, type `typed` into its paragraph number `which` (from 0), save through the safety net. */
function typedAndSaved(file: string, typed: string, which = 0) {
  const { doc, source } = parseMarkdown(file);
  const ends: number[] = [];
  doc.descendants((n, pos) => {
    if (n.type.name === "paragraph") ends.push(pos + n.nodeSize - 1);
    return true;
  });
  const state = EditorState.create({ doc });
  const page = state.apply(state.tr.insertText(typed, ends[which])).doc;
  const written = serializeMarkdown(page, source);
  const net = checkSave(page, source);
  const back = parseMarkdown(written).doc;
  return { page, written, net, back };
}

describe("typing into a task with no words", () => {
  for (const [file, saved] of [
    ["- [ ]\n", "- [ ] Z\n"],
    ["- [ ] \n", "- [ ] Z\n"],
    ["- [x]\n", "- [x] Z\n"],
    ["> - [ ]\n", "> - [ ] Z\n"],
  ] as const) {
    it(`${JSON.stringify(file)} is saved as ${JSON.stringify(saved)}, still a task, with no repair`, () => {
      const { page, written, net, back } = typedAndSaved(file, "Z");
      expect(written).toBe(saved);
      expect(net).toEqual({ ok: true, text: saved, repaired: 0 });
      expect(back.eq(page), written).toBe(true);
    });
  }

  it("a sign typed there is kept as text: \"- [ ]\" then \"#\"", () => {
    const { page, written, net, back } = typedAndSaved("- [ ]\n", "#");
    expect(written).toBe("- [ ] \\#\n");
    expect(net.ok && net.repaired).toBe(0);
    expect(back.eq(page), written).toBe(true);
  });

  it("the empty task among others, the rest of the list as the file had it", () => {
    const file = "- [x] done\n- [ ]\n- [ ] later\n";
    const { written, net } = typedAndSaved(file, "now", 1);
    expect(written).toBe("- [x] done\n- [ ] now\n- [ ] later\n");
    expect(net.ok && net.repaired).toBe(0);
  });
});
