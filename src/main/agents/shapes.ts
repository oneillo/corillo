// The shapes agents' code shares: a document as agents see it, the host and the history's hooks the app supplies, a session, a call, and the refusals.
import type { AgentColour, Member, Pass, Unnamed } from "../../core/agents";
import type { Thread } from "../../core/comments";
import type { ChangeSpan } from "../../core/change-links";
import type { Version } from "../../core/versions";

/** A document open in Corillo, as agents need it. */
export interface AgentDoc {
  id: string;
  storeId: string;
  filePath: string;
  /** Paths it had before it was renamed or moved outside Corillo. */
  formerPaths?: Set<string>;
}

/** An agent on a document, as the window shows it. */
export interface AgentInfo {
  name: string;
  isDefault: boolean;
  editing: boolean;
  colour: AgentColour;
  /** It's waiting in Corillo for the person's review of this document, or working and will wait again (Send to Claude). */
  listening?: true;
  /** The person sent this document while it was busy: it gets it at its next wait, after finishing `after` (a document's name). */
  sent?: { after: string | null };
  /** Comments waiting for it that it has been shown, by any route: how many messages of each. */
  has?: Record<string, number>;
  /** Open comments it started under a name it no longer has (a new chat took it): they're still its (B3-R10). */
  started?: string[];
}

/** Asking the window to save the person's pending edits in a tab. */
export type FlushResult = "saved" | "conflict" | "unsaved" | "no-answer";

/** Word document or PDF. */
export type ExportKind = "docx" | "pdf";

export interface AgentHost {
  /** The open document at this path, if any. */
  find(filePath: string): AgentDoc | null;
  /** Open a document in a background tab. Throws an AgentError in plain words if it can't. */
  open(filePath: string): AgentDoc;
  openDocs(): AgentDoc[];
  /** The document in front in Corillo's window, if any. */
  front?(): AgentDoc | null;
  byStoreId(storeId: string): AgentDoc | null;
  /** The document's text as it is now on disk. */
  read(doc: AgentDoc): string;
  /** Write an agent's text to the file and show it in the tab. `from`: the file's text the agent's change was made from, as read. */
  write(doc: AgentDoc, text: string, from?: string): void;
  /**
   * The text an agent's edit is about to write: the tab can start reading it
   * while Corillo ties the edit to its comments, so it's shown sooner.
   */
  coming?(doc: AgentDoc, text: string): void;
  /** Write a new file (its folder is created if needed). */
  create(filePath: string, text: string): void;
  /** Save the person's pending edits in the document's tab; with lock, the tab stops taking edits first. */
  flush(doc: AgentDoc, lock: boolean): Promise<FlushResult>;
  /** Tell the window which agents are on a document. */
  announce(storeId: string, agents: AgentInfo[]): void;
  /** The document is back in the person's hands: light the tab's dot. */
  backToYou(storeId: string): void;
  /** An agent opened or created the document for the person to review (open_document, create_document). */
  forYou?(storeId: string, agentName: string): void;
  /**
   * The person sent the document to an agent and it didn't get it: the agent
   * stopped listening first ("stopped"), or the document couldn't be taken
   * for it ("failed"). The window says so (B2-01, B2-04).
   */
  sendLost?(storeId: string, agentName: string, why: "stopped" | "failed"): void;
  /** What's at a path on disk. */
  kindOf(filePath: string): "file" | "folder" | null;
  /** These web pictures wait for the person to show them in the document (roadmap Batch 18, the review's R18-3). Required, so no host can leave the guard out (G21-10). */
  picturesWait(doc: AgentDoc, addresses: string[]): void;
  /**
   * Export the document as it is on disk, with the person's export settings
   * for it, and show the person where it went. Throws in plain words if it can't.
   */
  exportDocument(doc: AgentDoc, kind: ExportKind, outputPath: string, agentName: string): Promise<{ outputPath: string; notes: string[] }>;
  /**
   * Where an export goes when the agent names no place: beside the document,
   * with its name, but for a copy made from a Word document a new name, never
   * that Word file (export.ts's exportSuggestion). Without it, beside the
   * document with its name.
   */
  exportPlace?(doc: AgentDoc, kind: ExportKind): string;
  /** Whether a file is the Word document this document was made from, which no export writes over (B5-01). */
  isMadeFrom?(doc: AgentDoc, filePath: string): boolean;
  /** An agent's pass on the document ended: tell the person what it did, so they can review it. */
  passEnded?(storeId: string, summary: PassSummary): void;
  /**
   * The agents connected now changed (newest connection first); left is the
   * name of one whose session just ended. `clients`: what each of those
   * sessions' tools call themselves, in the same order (the Connect screen's
   * rows, roadmap Batch 5, item 2).
   */
  connected?(names: string[], left?: string, clients?: string[]): void;
}

export interface PassEnd {
  agentName: string;
  /**
   * The comments the agent replied to, changed text for, or started for the
   * person during the pass, with its replies, and (for those it changed text
   * for) that change.
   */
  addressed: Thread[];
  /** What it changed that no comment asked for (with a request, what it changed for that). */
  other?: ChangeSpan[];
  /** What the person asked for in the agent's chat, as the agent gave it. */
  request?: string;
  /** The agent's note for the person about the pass (finish_editing's note). */
  note?: string;
  endedBy: "agent" | "person" | "session-ended";
}

/** What an agent's pass did, for the notice the person sees when it ends. */
export interface PassSummary {
  agent: string;
  /** How many comments it answered: replied on, or changed text for. */
  answered: number;
  /** It changed text no comment asked for, for a request made in the chat or not: the done line offers to show it (roadmap Batch 9, item 5). */
  other: boolean;
  /** What the person asked for in the agent's chat, if the agent said. */
  request?: string;
  endedBy: PassEnd["endedBy"];
  /**
   * The round found nothing addressed to it while comments wait for other
   * agents: how many, for whom (most first), and whether those agents have
   * them (roadmap Batch 3, item 3).
   */
  nothingFor?: { comments: number; agents: string[]; given: boolean };
}

/** Version history: one agent pass is one version, and agents can look back through it. */
export interface AgentHooks {
  beginPass(storeId: string, agentName: string): void | Promise<void>;
  /** The pass's version, if the history gives it back. */
  endPass(storeId: string, info: PassEnd): void | Version | null | Promise<void | Version | null>;
  /** The document's versions, oldest first. */
  versions(storeId: string): Version[];
  /** Version n's text, or null if it isn't there or can't be rebuilt. */
  versionText(storeId: string, n: number): string | null;
}

export const noHooks: AgentHooks = { beginPass() {}, endPass() {}, versions: () => [], versionText: () => null };

/** A refusal or problem, in words the agent can act on. */
export class AgentError extends Error {}

export interface ToolOutcome {
  text: string;
  isError: boolean;
}

export interface Session {
  id: string;
  baseName: string;
  /** What its agent tool calls itself ("claude-ai"). */
  client: string;
  /** Has commented, replied or taken a document: its name is fixed from now on. */
  settled: boolean;
  /** The text of each document as this agent last read it. */
  lastRead: Map<string, string>;
  /** For each document, how many messages of each comment this agent has been shown. */
  seen: Map<string, Map<string, number>>;
  /** For each document, the comments this agent started there: the person's answers come back to it while it's on it (B3-R10). */
  started: Map<string, Set<string>>;
  /**
   * Documents whose pass the person ended (Take over, or closing the tab),
   * until this agent takes them again: it's told once, and its edits are
   * refused without telling it to take the document. The newest few are kept.
   */
  ended: Map<string, Ended>;
  /** Documents whose notes files (context.md and the like) this agent has been pointed to. */
  pointed: Set<string>;
  /** Stops listening for a cancel of the take it just made (see call). */
  forgetTake?: () => void;
  /** Has finished a pass: it has been told how the person asks for more. */
  finished?: boolean;
  /** Its agent tool can wait for the person's review (see canWaitIn in core/agents.ts), as its connector said. */
  canWait: boolean;
  /** Named by a role it introduced itself with (Writer): it takes only its @ comments while another agent is on a document. */
  role: boolean;
  /** For each document, the versions its own passes made (the newest few): a round's catch-up tells its rounds from another session's of the same name. */
  rounds: Map<string, number[]>;
}

export interface Ended {
  how: "took" | "closed";
  /** The document's name and path then. */
  name: string;
  filePath: string;
  /** The agent hasn't been told yet. */
  untold: boolean;
}

export interface Call {
  session: Session;
  /** The agent was told in this call that the person ended its pass. */
  toldEnded?: boolean;
  /** Told first, whatever else the call returns. */
  notes: string[];
  /** The agent's tool cancelled the call (take_document heeds it). */
  signal?: AbortSignal;
  /** The document take_document took, if it took one just now. */
  took?: { key: string; pass: Pass };
}

export interface Looked {
  doc: AgentDoc;
  member: Member;
  /** Which comments with no @ are this agent's (roadmap Batch 3, item 3). */
  unnamed: Unnamed;
  label: string;
}

/** Work that runs after the call leaves the queue (an export), so it doesn't hold up everyone else. */
export class Later {
  constructor(readonly work: () => Promise<string>) {}
}

/** Another agent holds the document the agent wants to take. */
export class Held extends AgentError {
  constructor(
    readonly storeId: string,
    readonly holder: string,
    readonly label: string,
  ) {
    super(`${holder} is editing ${label}.`);
  }
}

/** How a pass ended, for an agent waiting to take the document: the agent finished (or left), or the person took it. */
export type Freed = "free" | "person" | "closed" | "timeout" | "cancelled";

/**
 * What happened since an agent's last round (sinceLastRound), written once
 * the take knows whether the text it gives is the changes since the agent's
 * last read (`given`), in at most `room` characters ("" if even its opening
 * doesn't fit).
 */
export type CatchUp = (given: boolean, room: number) => string;

/** The agent's tool cancelled its take_document: it isn't listening for the answer. */
export class Cancelled extends AgentError {
  constructor(label: string) {
    super(`Cancelled, so you're not editing ${label}.`);
  }
}
