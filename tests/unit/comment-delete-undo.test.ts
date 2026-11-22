// Delete deletes at once, and Undo straight after brings it back (roadmap
// Batch 9, item 4: "I also don't want to have to confirm a delete."). What
// Corillo keeps for that: only the last message the person deleted, put back
// where it was, once.
import { beforeEach, describe, expect, it } from "vitest";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import * as path from "node:path";
import { CommentService } from "../../src/main/comment-service";
import { DocumentStore } from "../../src/main/store";
import type { Author, Thread } from "../../src/core/comments";

const YOU: Author = { kind: "person" };
const CLAUDE: Author = { kind: "agent", name: "Claude" };
const DOC = "plan";
const on = (quote: string, offset: number) => ({ quote, prefix: "", suffix: "", offset });

let comments: CommentService;
let first: Thread;
let second: Thread;
let third: Thread;

beforeEach(() => {
  comments = new CommentService(new DocumentStore(mkdtempSync(path.join(tmpdir(), "corillo-undelete-"))), () => {});
  first = comments.add(DOC, YOU, "Make it three.", on("two people", 10), null);
  second = comments.add(DOC, YOU, "By how much?", on("tight", 40), null);
  third = comments.add(DOC, YOU, "Overall: shorter.", null, null);
});

const bodies = () => comments.threads(DOC).map((t) => t.messages.map((m) => m.body));

describe("bringing back what was just deleted", () => {
  it("a whole comment comes back as it was, in its place in the list, with its replies", () => {
    comments.reply(DOC, second.id, CLAUDE, "About 10%.");
    comments.reply(DOC, second.id, YOU, "Say so, then.");
    const before = comments.threads(DOC);
    comments.remove(DOC, second.id, second.messages[0].id, YOU);
    expect(comments.threads(DOC).map((t) => t.id)).toEqual(expect.not.arrayContaining([second.id]));
    comments.restore(DOC, second.id, second.messages[0].id, YOU);
    expect(comments.threads(DOC)).toEqual(before);
  });

  it("a reply comes back after the message it followed, keeping what came since", () => {
    comments.reply(DOC, first.id, YOU, "Or four.");
    const withReplies = comments.reply(DOC, first.id, YOU, "Or five.");
    const middle = withReplies.messages[1];
    comments.remove(DOC, first.id, middle.id, YOU);
    expect(bodies()[0]).toEqual(["Make it three.", "Or five."]);
    comments.restore(DOC, first.id, middle.id, YOU);
    expect(bodies()[0]).toEqual(["Make it three.", "Or four.", "Or five."]);
    expect(comments.threads(DOC)[0].messages[1]).toEqual(middle);
  });

  it("only once, and only the very last delete: an older one can't be brought back", () => {
    comments.remove(DOC, first.id, first.messages[0].id, YOU);
    comments.remove(DOC, third.id, third.messages[0].id, YOU);
    expect(() => comments.restore(DOC, first.id, first.messages[0].id, YOU)).toThrow("That comment can't be brought back now.");
    comments.restore(DOC, third.id, third.messages[0].id, YOU);
    expect(() => comments.restore(DOC, third.id, third.messages[0].id, YOU)).toThrow("That comment can't be brought back now.");
    expect(bodies()).toEqual([["By how much?"], ["Overall: shorter."]]);
  });

  it("only the person can bring one back, and nothing is kept once the document is let go", () => {
    comments.remove(DOC, second.id, second.messages[0].id, YOU);
    expect(() => comments.restore(DOC, second.id, second.messages[0].id, CLAUDE)).toThrow("Only you can bring back a comment you deleted.");
    expect(comments.sizes().deleted).toBe(1);
    comments.forget(DOC);
    expect(comments.sizes().deleted).toBe(0);
    expect(() => comments.restore(DOC, second.id, second.messages[0].id, YOU)).toThrow("That comment can't be brought back now.");
  });
});
