// Send to Claude (roadmap Batch 2, item 1): which agent tools can wait for the
// person's review, what the panel's button and the cards say, and what Copy
// for Claude puts on the clipboard.
import { describe, expect, it } from "vitest";
import type { Thread } from "../../src/core/comments";
import { canWaitIn, handBackSentence } from "../../src/core/agents";
import { handBackFor, turnLabel, type AgentInfo } from "../../src/renderer/comment-format";
import { turnWords } from "../../src/renderer/turns";

const person = { kind: "person" } as const;
function thread(id: string, options: Partial<Thread> = {}): Thread {
  return { id, anchor: null, to: null, status: "open", messages: [{ id: `${id}-1`, author: person, body: "Shorter?", created: "" }], ...options };
}
const answered = (t: Thread): Thread => ({ ...t, messages: [...t.messages, { id: `${t.id}-2`, author: { kind: "agent", name: "Claude" }, body: "Done.", created: "" }] });
/** The person's turn: an agent spoke last. */
const yours = (t: Thread) => t.messages[t.messages.length - 1]?.author.kind === "agent";
const claude = (more: Partial<AgentInfo> = {}): AgentInfo => ({ name: "Claude", isDefault: true, editing: false, colour: "peach", ...more });

describe("which agent tools can wait for the review", () => {
  it("only Claude Code in a terminal: not Claude Desktop, not other tools, not Claude Code run with -p or in an editor", () => {
    expect(canWaitIn("claude-code")).toBe(true);
    expect(canWaitIn("claude-code", { CLAUDE_CODE_ENTRYPOINT: "cli" })).toBe(true);
    expect(canWaitIn("claude-ai")).toBe(false); // Claude Desktop cuts a call at 240 seconds
    expect(canWaitIn("codex-mcp-client")).toBe(false);
    expect(canWaitIn(undefined)).toBe(false);
    expect(canWaitIn("claude-code", { CLAUDE_CODE_ENTRYPOINT: "sdk-cli" })).toBe(false);
    expect(canWaitIn("claude-code", { CLAUDE_CODE_ENTRYPOINT: "claude-vscode" })).toBe(false);
    // Told to move long calls to the background, it can.
    expect(canWaitIn("claude-code", { CLAUDE_CODE_ENTRYPOINT: "sdk-cli", CLAUDE_AUTO_BACKGROUND_TASKS: "1" })).toBe(true);
  });
});

describe("Copy for Claude", () => {
  it("copies the hand-back sentence with the document's name, path and how many comments", () => {
    expect(handBackSentence("/Users/ana/Docs/Partner onboarding proposal.md", 2)).toBe(
      "There's feedback for you in Corillo on “Partner onboarding proposal.md” (/Users/ana/Docs/Partner onboarding proposal.md): 2 comments.",
    );
    expect(handBackSentence("/d/plan.md", 1)).toBe("There's feedback for you in Corillo on “plan.md” (/d/plan.md): 1 comment.");
    expect(handBackSentence("/d/plan.md", 0)).toBe("There's feedback for you in Corillo on “plan.md” (/d/plan.md).");
  });
});

describe("a card says whether its comment has reached the agent", () => {
  const t = thread("a");
  it("not sent yet, then sent; while sent and the agent busy, when it will start", () => {
    expect(turnLabel(t, [claude()], false)).toBe("For Claude, not sent yet");
    expect(turnLabel(t, [claude({ listening: true })], false)).toBe("For Claude, not sent yet");
    expect(turnLabel(t, [claude({ listening: true, sent: { after: "plan.md" } })], false)).toBe("Sent to Claude: it will start when it has finished plan.md");
    expect(turnLabel(t, [claude({ listening: true, sent: { after: null } })], false)).toBe("Sent to Claude");
    expect(turnLabel(t, [claude({ has: { a: 1 } })], false)).toBe("Sent to Claude");
    // The person added to it since: not sent again yet.
    const more = { ...t, messages: [...t.messages, { id: "a-2", author: person, body: "Or cut it.", created: "" }] };
    expect(turnLabel(more, [claude({ has: { a: 1 } })], false)).toBe("For Claude, not sent yet");
    // Added while the agent edits: it sees it in this pass.
    expect(turnLabel(t, [claude({ editing: true })], false)).toBe("Claude will see it in this pass");
    expect(turnLabel(t, [], false)).toBe("Not sent to an agent yet");
    expect(turnLabel(answered(t), [claude()], true)).toBe("Waiting for you");
  });
});

describe("the Comments panel's button", () => {
  it("Send to Claude when Claude is waiting for the review and something waits for it", () => {
    expect(handBackFor([thread("a"), thread("b")], [claude({ listening: true })], yours)).toEqual({ kind: "send", agent: "Claude", comments: 2 });
    // Nothing new for it: there's nothing to send yet.
    expect(handBackFor([answered(thread("a"))], [claude({ listening: true })], yours)).toEqual({ kind: "listening", agent: "Claude" });
    expect(handBackFor([thread("a")], [claude({ listening: true, has: { a: 1 } })], yours)).toEqual({ kind: "listening", agent: "Claude" });
    // Sent while it was busy.
    expect(handBackFor([thread("a")], [claude({ listening: true, sent: { after: "notes.md" } })], yours)).toEqual({
      kind: "sent",
      agent: "Claude",
      after: "notes.md",
    });
  });

  it("goes to the agent the comments are for, when two are waiting", () => {
    const writer: AgentInfo = { name: "Writer", isDefault: false, editing: false, colour: "sky", listening: true };
    expect(handBackFor([thread("a", { to: "Writer" })], [claude({ listening: true }), writer], yours)).toEqual({ kind: "send", agent: "Writer", comments: 1 });
  });

  it("Copy for Claude where no agent is waiting, with the agent the comments are for", () => {
    expect(handBackFor([thread("a")], [claude()], yours)).toEqual({ kind: "copy", agent: "Claude", comments: 1 });
    expect(handBackFor([thread("a"), thread("b")], [], yours)).toEqual({ kind: "copy", agent: "Claude", comments: 2 });
    expect(handBackFor([thread("a", { to: "Writer" })], [claude()], yours)).toEqual({ kind: "copy", agent: "Writer", comments: 1 });
    // Already given to it (it looked when told in the chat): nothing to copy.
    expect(handBackFor([thread("a")], [claude({ has: { a: 1 } })], yours)).toBeNull();
  });

  it("nothing while an agent edits, or with nothing for an agent and nobody waiting", () => {
    expect(handBackFor([thread("a")], [claude({ listening: true, editing: true })], yours)).toBeNull();
    expect(handBackFor([answered(thread("a"))], [claude()], yours)).toBeNull();
    expect(handBackFor([thread("a", { status: "resolved" })], [], yours)).toBeNull();
    expect(handBackFor([], [], yours)).toBeNull();
  });
});

describe("the status bar while an agent waits for the review", () => {
  it("says who is waiting, and what's left to read", () => {
    expect(turnWords({ agent: null, listening: ["Claude"] }, 0).text).toBe("Claude is waiting for your review");
    expect(turnWords({ agent: null, listening: ["Claude"] }, 3).text).toBe("Claude is waiting for your review · 3 to read");
    expect(turnWords({ agent: null, listening: ["Claude", "Writer"] }, 0).text).toBe("Claude and Writer are waiting for your review");
    expect(turnWords({ agent: null, listening: ["Claude"] }, 0).title).toBe(
      "It's your turn: Claude is waiting for your review. When you've finished, press Send to Claude in the Comments panel.",
    );
    // Two waiting: the tooltip names the button as the panel shows it (B2-07).
    expect(turnWords({ agent: null, listening: ["Claude", "Writer"] }, 0, "Writer").title).toBe(
      "It's your turn: Claude and Writer are waiting for your review. When you've finished, press Send to Writer in the Comments panel.",
    );
    // As before otherwise.
    expect(turnWords({ agent: null }, 0).text).toBe("With you");
    expect(turnWords({ agent: null }, 2).text).toBe("With you · 2 to read");
    expect(turnWords({ agent: { name: "Claude", isDefault: true, editing: true, colour: "peach" } }, 0).text).toBe("Claude is editing");
  });
});
