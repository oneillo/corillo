// Where a closed document stands, for its card on the start screen (roadmap
// Batch 4, item 3): what waits for the person in its Comments panel, and the
// person's comments for an agent that haven't been handed over.
//
// Only what Corillo keeps on disk can be told of a document that isn't open.
// No agent is editing it or waiting for its review (an agent works only on an
// open document, and closing its tab or quitting ends its pass and its wait),
// and "3 to read" (what's new since the document opened) starts afresh when
// it opens. So the card says what the document's own comment cards will say
// once it's open: "Waiting for you", "For Claude, not sent yet". An agent
// still connected stays on the document after its tab closes, so a comment
// with no @ is for it, as inside. Plain logic and a read of the data folder,
// no Electron, so the tests run it as it is.
import { waitingForPerson, type PassNote, type Thread } from "../core/comments";
// The Comments panel's own rules for whom a comment is for, and its kinds of cards.
import { agentFor, type AgentInfo, type Waiting } from "../renderer/comment-format";

export interface Standing {
  /** The cards waiting for the person, by kind: comments an agent answered, and agents' notes. */
  waiting: Required<Waiting>;
  /** The person's open comments not handed over, by the agent each is for ("" for none named). */
  notSent: Record<string, number>;
}

/** A document's records as they are on disk. */
export interface DocRecords {
  threads: Thread[];
  notes: PassNote[];
}

/**
 * Where a document stands, from its comments and the agents' notes waiting
 * for the person; null when there's nothing to say. A document no agent has
 * been on says nothing about the person's own comments, unless one names an
 * agent. `agents`: those on it now.
 */
export function standingOf(threads: Thread[], notes: PassNote[], agents: AgentInfo[] = []): Standing | null {
  const waiting = {
    comments: threads.filter(waitingForPerson).length,
    notes: notes.length,
  };
  const touched = agents.length > 0 || notes.length > 0 || threads.some((t) => t.messages.some((m) => m.author.kind === "agent"));
  const notSent: Record<string, number> = {};
  for (const t of threads) {
    if (t.status !== "open" || !t.messages.length || waitingForPerson(t)) continue;
    const name = agentFor(t, agents) ?? "";
    if (!name && !touched) continue;
    notSent[name] = (notSent[name] ?? 0) + 1;
  }
  const any = waiting.comments || waiting.notes || Object.keys(notSent).length;
  return any ? { waiting, notSent } : null;
}

/** What the start screen reads from Corillo's data folder: never changing it, never setting a file aside. */
export interface RecordsReader {
  /** The document last known at each path: its record's id, or null. */
  knownAt(paths: string[]): ({ id: string } | null)[];
  /** Its records, or null if they can't be read right now. */
  peek(id: string): Promise<DocRecords | null>;
}

/** Where each of these documents stands, all read at once; null for one with nothing to say or whose records can't be read. `agentsOn`: the agents on a document, by its record's id. */
export async function readStandings(paths: string[], records: RecordsReader, agentsOn: (id: string) => AgentInfo[] = () => []): Promise<(Standing | null)[]> {
  let known: ({ id: string } | null)[];
  try {
    known = records.knownAt(paths);
  } catch {
    return paths.map(() => null);
  }
  return Promise.all(
    known.map(async (k) => {
      if (!k) return null;
      const r = await records.peek(k.id).catch(() => null);
      return r ? standingOf(r.threads, r.notes, agentsOn(k.id)) : null;
    }),
  );
}
