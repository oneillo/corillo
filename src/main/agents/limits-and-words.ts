// How much agents are given at once and how long they wait, and the sentences more than one of their tools tells them.
import { DONT_CALL_AGAIN } from "../../core/waiting-words";

/** Versions of its own passes a session remembers per document, and how many documents it remembers them for. */
export const ROUNDS_KEPT = 20;

/** Passes the person ended that a session remembers (see Session.ended). */
export const ENDED_KEPT = 20;

/** Versions listed unless the agent asks for all of them. */
export const VERSIONS_SHOWN = 20;

/** The most versions since an agent's last round that a take goes through, and the longest change it shows (A-8). */
export const CATCH_UP_VERSIONS = 20;
export const CATCH_UP_DIFF = 4_000;
/** The comments of that round a take names; list_versions gives them all. */
export const ROUND_COMMENTS = 8;
/**
 * The most a take answers, in characters, all told (B1-04): agent tools set
 * aside a longer answer (Claude Code keeps one over 50,000 characters in a
 * file and shows the agent its start), and a few notes may follow it. Filled
 * in order: the comments (every one, shortened if need be), the text, then
 * the catch-up.
 */
export const TAKE = 45_000;
/** Kept for the text, at the least, when the comments are many: enough for a long document's outline and start to begin. */
export const TAKE_TEXT = 6_000;
/** Kept for the catch-up's opening when there is one: who did what since, without the change itself. */
export const TAKE_CATCH_UP = 1_500;

/**
 * How long take_document waits for another agent to finish. Under a minute,
 * because some agent tools give up on a tool call after one.
 */
export const WAIT_MS = 45_000;

/** The window didn't answer the request to save the person's edits. */
export const NO_ANSWER = "Corillo's window didn't answer in time, so the person may have edits that aren't saved yet.";
/** After opening a document for the person: tell them, and how they hand it back (person quick win 2). */
export const READY = "Tell the person in the chat that it's ready for their review, and that when they've finished commenting they can tell you here.";
/** The same, for an agent that can wait for the review in Corillo (roadmap Batch 2, item 1). */
export const READY_WAIT =
  "Tell the person in the chat that it's ready for their review, then call wait_for_review and end your turn: they send it back to you from Corillo when they've finished.";
/**
 * How long an agent that was sent a document and has finished with it has to
 * wait again before it stops listening. Finishing tells it to, at once.
 */
export const GRACE_MS = 3 * 60_000;
/** What wait_for_review answers, besides a document sent. Each ends the wait quietly: said once, never called again. */
export const WAIT_CANT =
  "Corillo can't wait for the person's review in this app: the call would be cut off. Tell them in the chat that when they've finished commenting they can tell you here. Don't call wait_for_review again in this chat.";
export const waitStopped = (names: string) =>
  `Stopped listening for the person's review of ${names}. Say once in the chat that you've stopped listening; ${DONT_CALL_AGAIN}`;
export const waitClosed = (name: string) => `The person closed ${name} in Corillo, so you've stopped listening for their review. Say so once in the chat; ${DONT_CALL_AGAIN}`;
/** Where people often keep a document's context, in the folder beside it. */
export const NOTES_FILES = ["context.md", "brief.md", "README.md"];
export const plural = (n: number, one: string, many = `${one}s`) => `${n} ${n === 1 ? one : many}`;
export const clip = (s: string, max = 160) => (s.length > max ? `${s.slice(0, max - 1)}…` : s);
/**
 * Longer than this, a comment's words are cut short for the agent, which is
 * told so and where they end. Cut at 160, a comment on three list items read
 * as one on the first, and the agent answered only that (Orlando, 2026-11-11).
 */
export const QUOTE = 600;

/**
 * An edit the safety net held back: its splice would have changed the text
 * outside what it found (a fault in Corillo, never the agent's edit). Says
 * which words would have gone, and how to make the change anyway.
 */
export function spliceRefused(lost: string[]): string {
  const words = [...new Set(lost)];
  const named = words.slice(0, 10).map((w) => `"${w}"`).join(", ") + (words.length > 10 ? ` and ${words.length - 10} more` : "");
  const what = words.length
    ? `Corillo would also have taken out words outside the text you asked to find: ${named}`
    : "Corillo would also have changed the text around what you asked to find";
  return `Nothing was changed: ${what}. That's a fault in Corillo, not in your edit. Make the change with replace_document instead (read_document first, so you start from the latest text), and tell the person in the chat.`;
}
