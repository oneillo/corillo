// Whose turn it is on a document, in the words its tab's dot, the tab's
// tooltip, screen readers and the Window menu all use (roadmap Batch 2, item
// 2): "Claude is editing", "Back from Writer: 3 to read", "Opened for you by
// Claude", "With you".

/** What's new to read on a document back with the person: the cards with something new (the status bar's count). */
export interface ToRead {
  cards: number;
}

/** Whose turn it is on a document, as its tab shows it. */
export type TabTurn =
  /** An agent is editing it: a small coquí in the agent's colour, hopping now and then (roadmap Batch 9, item 13). */
  | { kind: "editing"; agent: string; colour: string }
  /**
   * Waiting for the person: back from an agent's pass, or opened for them by
   * an agent, and not looked at yet. A filled dot in that agent's colour.
   */
  | { kind: "back"; agent: string | null; colour: string | null; opened: boolean; toRead: ToRead }
  /** An agent has worked on it, and the person has looked since: no dot. */
  | { kind: "with-you" };

/** "3 to read", or "" with nothing new. */
export function toReadWords(what: ToRead): string {
  return what.cards > 0 ? `${what.cards} to read` : "";
}

export function turnWords(turn: TabTurn): string {
  if (turn.kind === "editing") return `${turn.agent} is editing`;
  if (turn.kind === "with-you") return "With you";
  const who = turn.opened ? (turn.agent ? `Opened for you by ${turn.agent}` : "Opened for you") : turn.agent ? `Back from ${turn.agent}` : "Back with you";
  const count = toReadWords(turn.toRead);
  return count ? `${who}: ${count}` : who;
}
