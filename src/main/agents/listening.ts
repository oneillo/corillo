// Agents waiting in Corillo for the person's review (roadmap Batch 2, item 1).
// An agent that can wait calls wait_for_review and Corillo holds the call
// until the person presses Send on one of its documents: no model turn, no
// tokens meanwhile. The agent stays a listener while it works on what was
// sent, so a Send for its other documents is kept and handed over at its next
// wait. Plain state and one timer each; the agent service decides when.

/** How a held wait ends: a document was sent, or the agent stopped listening (and why, in words for it). */
export type Woken = { sent: string } | { ended: string };

export interface Listener {
  readonly sessionId: string;
  /** The documents it listens on, by store id. */
  docs: Set<string>;
  /** Its wait_for_review call, held until a document is sent; null while it works. */
  held: ((woken: Woken) => void) | null;
  /** Documents sent while it was busy, oldest first: each is handed over at its next wait. */
  queued: string[];
  /** Of those, the ones sent while comments waited for it: let go once none does (B3-R05). */
  forComments: Set<string>;
  /** The document being handed over to it right now (taken for it), if any. */
  waking: string | null;
  /** Runs while it neither waits nor works: when it runs out, it stops listening. */
  grace: ReturnType<typeof setTimeout> | null;
}

export class Listeners {
  private all = new Map<string, Listener>();

  /** `graceOver` hears of a listener whose grace ran out. */
  constructor(
    private graceMs: number,
    private graceOver: (sessionId: string) => void,
  ) {}

  get(sessionId: string): Listener | undefined {
    return this.all.get(sessionId);
  }

  /** The listeners on a document, in the order they started listening. */
  on(storeId: string): Listener[] {
    return [...this.all.values()].filter((l) => l.docs.has(storeId));
  }

  /**
   * A session listens on these documents (with `add`, as well as those it
   * had). A document the person sent it meanwhile stays, whatever it names:
   * a Send is never let go without a word (B2-01).
   */
  listen(sessionId: string, docs: string[], add = false): Listener {
    let l = this.all.get(sessionId);
    if (!l) {
      l = { sessionId, docs: new Set(), held: null, queued: [], forComments: new Set(), waking: null, grace: null };
      this.all.set(sessionId, l);
    }
    if (!add) l.docs = new Set(l.queued);
    for (const d of docs) l.docs.add(d);
    this.stopGrace(l);
    return l;
  }

  /** Hand a document to the listener's held call. */
  wake(l: Listener, storeId: string): void {
    const held = l.held!;
    l.held = null;
    l.waking = storeId;
    held({ sent: storeId });
  }

  /** It isn't waiting or working: it has a little while to wait again. */
  startGrace(l: Listener): void {
    if (l.grace || this.all.get(l.sessionId) !== l) return;
    l.grace = setTimeout(() => {
      l.grace = null;
      this.graceOver(l.sessionId);
    }, this.graceMs);
  }

  stopGrace(l: Listener): void {
    if (l.grace) clearTimeout(l.grace);
    l.grace = null;
  }

  /**
   * The session stops listening; its held call, if any, is told why. The
   * documents it listened on, and those the person had sent it that it never got.
   */
  stop(sessionId: string, why: string): { docs: string[]; lost: string[] } {
    const l = this.all.get(sessionId);
    if (!l) return { docs: [], lost: [] };
    this.all.delete(sessionId);
    this.stopGrace(l);
    const held = l.held;
    l.held = null;
    held?.({ ended: why });
    return { docs: [...l.docs], lost: l.queued };
  }

  /** Every session, for Corillo quitting. */
  sessions(): string[] {
    return [...this.all.keys()];
  }

  /** How many listen now, for the leak checks (each has at most one timer). */
  get size(): number {
    return this.all.size;
  }
}
