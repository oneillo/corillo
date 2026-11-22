// Agents' changes and deleted comments' places in the open document
// (src/renderer/change-marks.ts), the comment service that keeps them
// (src/main/comment-service.ts), and the words around them on the panel.
import { describe, expect, it } from "vitest";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import * as path from "node:path";
import { EditorState, type Transaction } from "prosemirror-state";
import type { Node } from "prosemirror-model";
import { parseMarkdown } from "../../src/core/markdown";
import { anchorIn, textIndex } from "../../src/core/anchors";
import { OTHER, type ChangeSpan } from "../../src/core/change-links";
import type { Thread } from "../../src/core/comments";
import { commentPlugin, withRanges, type Range } from "../../src/renderer/comments";
import { anchorsOf, changeMarks, changePlugin, placeSpans, withChanges } from "../../src/renderer/change-marks";
import { turnLabel } from "../../src/renderer/comment-format";
import { CommentService } from "../../src/main/comment-service";
import { DocumentStore } from "../../src/main/store";
import { INSTRUCTIONS, TOOLS } from "../../src/mcp/tools";

function stateOf(md: string): EditorState {
  return EditorState.create({ doc: parseMarkdown(md).doc, plugins: [commentPlugin(), changePlugin()] });
}

function rangeOf(doc: Node, find: string): Range {
  let at = -1;
  doc.descendants((node, pos) => {
    if (at < 0 && node.isText && node.text!.includes(find)) at = pos + node.text!.indexOf(find);
  });
  return { from: at, to: at + find.length };
}

/** A span over these words, as Corillo stores it. */
function spanOf(state: EditorState, words: string, removed: string): ChangeSpan {
  const text = textIndex(state.doc).text;
  const at = text.indexOf(words);
  return { anchor: anchorIn(text, at, at + words.length), removed };
}

const apply = (state: EditorState, tr: Transaction) => state.apply(tr);
/** What's drawn: [class or widget, text]. */
function drawn(state: EditorState): string[] {
  return changeMarks(state)
    .decorations.find()
    .map((d) => {
      const spec = d as unknown as { type: { attrs?: { class: string }; toDOM?: unknown }; from: number; to: number };
      if (spec.type.attrs) return `${spec.type.attrs.class}:${state.doc.textBetween(d.from, d.to)}`;
      return `widget@${d.from}`;
    });
}

function withSpans(state: EditorState, owner: string, spans: ChangeSpan[]): EditorState {
  return apply(state, withChanges(state.tr, { type: "set", owner, spans: placeSpans(state.doc, spans) }));
}

describe("an agent's change in the open document", () => {
  const md = "We should hire three people this quarter.\n\nThe budget is tight.\n";

  it("is drawn only for the comment in focus, in its own class", () => {
    let state = stateOf(md);
    state = withSpans(state, "a", [spanOf(state, "three", "two")]);
    state = withSpans(state, "b", [spanOf(state, "tight", "small")]);
    expect(drawn(state)).toEqual([]);
    state = apply(state, withRanges(state.tr, { type: "add", id: "a", range: rangeOf(state.doc, "hire three"), shown: true }, { type: "active", id: "a" }));
    expect(drawn(state)).toEqual(["change-mark:three"]);
    state = apply(state, withChanges(state.tr, { type: "select", owner: OTHER }));
    expect(drawn(state)).toEqual([]);
  });

  it("shows what it said before beside the new words, until the text is edited", () => {
    let state = stateOf(md);
    state = withSpans(state, "a", [spanOf(state, "three", "two")]);
    state = apply(state, withChanges(state.tr, { type: "select", owner: "a" }, { type: "before", on: true }));
    expect(drawn(state)).toEqual([`widget@${rangeOf(state.doc, "three").from}`, "change-mark change-after:three"]);
    state = apply(state, state.tr.insertText("Next year, ", 1));
    expect(changeMarks(state).before).toBe(false);
    expect(drawn(state)).toEqual(["change-mark:three"]);
  });

  it("follows the person's edits, and reports where it is now (or that its words were deleted)", () => {
    let state = stateOf(md);
    state = withSpans(state, "a", [spanOf(state, "three", "two"), spanOf(state, "tight", "small")]);
    state = apply(state, state.tr.insertText("Next year, ", 1));
    const [three, tight] = changeMarks(state).spans.get("a")!;
    expect(state.doc.textBetween(three.from, three.to)).toBe("three");
    const r = rangeOf(state.doc, "tight");
    state = apply(state, state.tr.delete(r.from, r.to));
    expect(changeMarks(state).spans.get("a")![1].gone).toBe(true);
    const anchors = anchorsOf(state.doc, changeMarks(state).spans.get("a")!, 2);
    expect(anchors[0]).toMatchObject({ quote: "three" });
    expect(anchors[1]).toBe(false);
    expect(tight.index).toBe(1);
  });
});

describe("a comment whose words were deleted", () => {
  const md = "Keep this paragraph.\n\nDrop this paragraph.\n\nAnd this one stays.\n";

  it("keeps an empty line where they were, drawn and never in the document; it goes when they come back", () => {
    let state = stateOf(md);
    const r = rangeOf(state.doc, "Drop this paragraph.");
    state = apply(state, withRanges(state.tr, { type: "add", id: "c", range: r, shown: true }));
    const before = state;
    state = apply(state, state.tr.delete(r.from, r.to));
    const gap = changeMarks(state).gaps.get("c")!;
    expect(gap.text).toBe("Drop this paragraph.");
    expect(drawn(state)).toEqual([`widget@${gap.pos}`]);
    expect(state.doc.textContent).toBe("Keep this paragraph.And this one stays.");
    // The words back (as Undo does), and the comment on them again: no gap.
    state = apply(before, withRanges(before.tr, { type: "add", id: "c", range: r, shown: true }));
    expect(changeMarks(state).gaps.size).toBe(0);
  });

  it("sits at the end of the paragraph before, so the next paragraph (and its line number) stays where it was", () => {
    let state = stateOf(md);
    const start = (words: string) => rangeOf(state.doc, words).from;
    state = apply(state, withChanges(state.tr, { type: "gap", id: "c", gap: { pos: start("And this one stays."), text: "Gone." } }));
    expect(drawn(state)).toEqual([`widget@${rangeOf(state.doc, "Drop this paragraph.").to}`]);
    // At the very start of the document there's no paragraph before: it goes at the start of the first.
    state = apply(state, withChanges(state.tr, { type: "gap", id: "c", gap: { pos: start("Keep this paragraph."), text: "Gone." } }));
    expect(drawn(state)).toEqual([`widget@${start("Keep this paragraph.")}`]);
  });

  it("isn't kept for a resolved comment or the comment being written", () => {
    let state = stateOf(md);
    const r = rangeOf(state.doc, "Drop this paragraph.");
    state = apply(state, withRanges(state.tr, { type: "add", id: "c", range: r, shown: false }));
    state = apply(state, state.tr.delete(r.from, r.to));
    expect(changeMarks(state).gaps.size).toBe(0);
  });
});

describe("keeping changes with the comments", () => {
  const thread = (id: string, text: string, spans: ChangeSpan[]): Thread => ({
    id,
    anchor: anchorIn(text, 0, 4),
    to: null,
    status: "open",
    messages: [],
    change: { round: 2, agent: "Claude", at: "2026-11-09T10:00:00.000Z", spans },
  });

  it("stores where the person's edits moved them, ignoring a report about an older round", () => {
    const data = mkdtempSync(path.join(tmpdir(), "corillo-changes-"));
    const service = new CommentService(new DocumentStore(data), () => {});
    const text = "We hire three people.";
    const span = { anchor: anchorIn(text, 8, 13), removed: "two" };
    service.updateChanges("doc", () => [thread("a", text, [span])]);
    const moved = anchorIn("Now we hire three people.", 12, 17);
    service.setChangeAnchors("doc", { threads: { a: { round: 1, anchors: [moved] } } });
    expect(service.threads("doc")[0].change!.spans[0].anchor.offset).toBe(8);
    service.setChangeAnchors("doc", { threads: { a: { round: 2, anchors: [moved] } } });
    expect(service.threads("doc")[0].change!.spans[0].anchor.offset).toBe(12);
    // Kept in the data folder.
    const again = new CommentService(new DocumentStore(data), () => {});
    expect(again.threads("doc")[0].change!.round).toBe(2);
    expect(again.threads("doc")[0].change!.spans[0].anchor.offset).toBe(12);
  });

  it("keeps a deleted comment's place, and clears it when its words are found again", () => {
    const data = mkdtempSync(path.join(tmpdir(), "corillo-changes-"));
    const service = new CommentService(new DocumentStore(data), () => {});
    const t = service.add("doc", { kind: "person" }, "Cut this.", anchorIn("Keep. Drop. Stay.", 6, 11), null);
    const place = anchorIn("Keep.  Stay.", 6, 6);
    service.setAnchors("doc", { [t.id]: { gap: place } });
    expect(service.threads("doc")[0]).toMatchObject({ gap: place, detached: true });
    service.setAnchors("doc", { [t.id]: "detached" });
    expect(service.threads("doc")[0].gap).toEqual(place);
    service.setAnchors("doc", { [t.id]: anchorIn("Keep. Drop. Stay.", 6, 11) });
    expect(service.threads("doc")[0].gap).toBeUndefined();
    expect(service.threads("doc")[0].detached).toBeUndefined();
  });
});

describe("whose turn a comment is", () => {
  const base: Thread = { id: "t", anchor: null, to: null, status: "open", messages: [{ id: "m", author: { kind: "person" }, body: "Hi", created: "" }] };
  const agents = [{ name: "Claude", isDefault: true }, { name: "Writer", isDefault: false }];

  // Never "Waiting for Claude" before Claude knows (roadmap Batch 2, item 1): until it's sent, the card says so.
  it("is the person's once an agent answered, otherwise the agent it's for, not sent yet", () => {
    expect(turnLabel(base, agents, true)).toBe("Waiting for you");
    expect(turnLabel(base, agents, false)).toBe("For Claude, not sent yet");
    expect(turnLabel({ ...base, to: "Writer" }, agents, false)).toBe("For Writer, not sent yet");
    expect(turnLabel(base, [], false)).toBe("Not sent to an agent yet");
    expect(turnLabel({ ...base, status: "resolved" }, agents, true)).toBeNull();
  });
});

describe("what agents are told", () => {
  it("to tie each edit to its comments, and to give a request made in the chat", () => {
    expect(INSTRUCTIONS).toContain("comment_ids");
    expect(INSTRUCTIONS).toContain("as request on take_document");
    const tool = (name: string) => TOOLS.find((t) => t.name === name)!;
    expect(Object.keys(tool("edit_document").inputSchema.properties)).toContain("comment_ids");
    expect(Object.keys(tool("replace_document").inputSchema.properties)).toContain("comment_ids");
    expect(Object.keys(tool("take_document").inputSchema.properties)).toContain("request");
    expect(Object.keys(tool("finish_editing").inputSchema.properties)).toContain("request");
  });
});
