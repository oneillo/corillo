// Agents on documents: what each is called, which comments are meant for
// which agent (those with no @ included), and who holds a document to edit.
// Plain rules, no app or window code, so they can be tested on their own.
import type { Thread } from "./comments";

// Names ------------------------------------------------------------------------

/** Known agent tools, by what they call themselves when they connect. */
const KNOWN_CLIENTS: [RegExp, string][] = [
  [/claude/i, "Claude"],
  [/codex/i, "Codex"],
  [/cursor/i, "Cursor"],
  [/gemini/i, "Gemini"],
  [/copilot|visual studio code|vs ?code/i, "Copilot"],
];

const MAX_NAME = 32;
/** Words a shortened name doesn't end on: "Copywriter for" reads as cut off. */
const LINKING_WORDS = new Set(["for", "of", "the", "and", "to", "a", "an"]);

/** A name fit to show on comments: one line, no odd characters, not too long. */
export function cleanName(raw: string): string {
  const name = raw
    .replace(/[\u0000-\u001f\u007f]/g, " ")
    .replace(/[<>{}[\]"`\\|]/g, "")
    .replace(/\s+/g, " ")
    .trim();
  return shortened(name);
}

/**
 * A long name, cut at the last whole word that fits, without a trailing
 * "for", "of", "the" and the like, or a comma or dash ("Senior Marketing
 * Copywriter for Brand Launches" is "Senior Marketing Copywriter"). A first
 * word too long to fit is cut where the room ends.
 */
function shortened(name: string): string {
  if (name.length <= MAX_NAME) return name;
  const kept: string[] = [];
  for (const word of name.split(" ")) {
    if ([...kept, word].join(" ").length > MAX_NAME) break;
    kept.push(word);
  }
  const tidy = () => kept.join(" ").replace(/[\s,;:&+/-]+$/, "");
  while (kept.length && (LINKING_WORDS.has(kept[kept.length - 1].toLowerCase()) || !tidy())) kept.pop();
  return tidy() || name.slice(0, MAX_NAME).trim();
}

/** The name an agent gets from the tool it runs in ("Agent" if nothing is known). */
export function nameForClient(clientName: string | undefined | null): string {
  const raw = (clientName ?? "").trim();
  if (!raw) return "Agent";
  for (const [pattern, name] of KNOWN_CLIENTS) if (pattern.test(raw)) return name;
  // Otherwise tidy what the tool calls itself: "acme-mcp-client" becomes "Acme".
  const words = raw
    .replace(/[-_.]+/g, " ")
    .replace(/\b(mcp|client|cli|app)\b/gi, " ")
    .split(/\s+/)
    .filter(Boolean)
    .map((w) => w[0].toUpperCase() + w.slice(1));
  return cleanName(words.join(" ")) || "Agent";
}

/**
 * The agent tools the Connect screen lists (src/main/agent-tools.ts), by what
 * their sessions call themselves when they connect: the first that fits.
 */
const TOOL_CLIENTS: [RegExp, string][] = [
  [/claude[-_ ]?code/i, "claude-code"],
  [/claude/i, "claude-desktop"], // "claude-ai"
  [/codex|chatgpt/i, "codex"],
  [/cursor/i, "cursor"],
  [/gemini/i, "gemini"],
  [/copilot[-_ ]?cli/i, "copilot-cli"],
  [/visual studio code|vs ?code|copilot/i, "vscode"],
];

/**
 * Which of those tools a session runs in, or null for another: so a tool's
 * row can say it's connected once one of its sessions reaches Corillo
 * (roadmap Batch 5, item 2, P-5). Claude Code and Claude Desktop are both
 * "Claude" on comments, but two rows here.
 */
export function toolForClient(clientName: string | undefined | null): string | null {
  const raw = (clientName ?? "").trim();
  if (!raw) return null;
  return TOOL_CLIENTS.find(([pattern]) => pattern.test(raw))?.[1] ?? null;
}

/**
 * Whether an agent tool can wait in Corillo for the person's review: keep a
 * wait_for_review call open, at no cost, until they press Send (roadmap
 * Batch 2, item 1). Only Claude Code in a terminal: its interactive sessions
 * move a call still running after two minutes to the background, and wake on
 * its answer. Run with -p, from an SDK or in an editor's panel, it doesn't
 * (unless CLAUDE_AUTO_BACKGROUND_TASKS is set), and a held call would block
 * the agent; Claude Desktop cuts any call at 240 seconds
 * (found in a trial with real agents, roadmap Batch 1). `env` is the connector's: the agent
 * tool's own settings.
 */
export function canWaitIn(clientName: string | undefined | null, env: Record<string, string | undefined> = {}): boolean {
  if (!/claude[-_ ]?code/i.test(clientName ?? "")) return false;
  if (/^(1|true|yes)$/i.test(env.CLAUDE_AUTO_BACKGROUND_TASKS ?? "")) return true;
  const entry = env.CLAUDE_CODE_ENTRYPOINT ?? "";
  return entry === "" || entry === "cli";
}

/**
 * What Copy for Claude puts on the clipboard, for the person to paste in
 * their agent's chat: enough for a new chat to find the document.
 */
export function handBackSentence(filePath: string, comments: number): string {
  const name = filePath.slice(filePath.lastIndexOf("/") + 1);
  const count = comments > 0 ? `: ${comments} ${comments === 1 ? "comment" : "comments"}` : "";
  return `There's feedback for you in Corillo on “${name}” (${filePath})${count}.`;
}

/** Why a name a custom agent asked for can't be used, or null if it can. */
export function nameProblem(name: string): string | null {
  if (!name) return "A name needs at least one letter.";
  if (/^(person|you|me)$/i.test(name)) return `"${name}" is kept for the person. Choose your role's name, such as Writer.`;
  return null;
}

/** The base name, numbered from the second agent with the same name: Claude, Claude 2, Claude 3. */
export function numberedName(base: string, taken: string[]): string {
  if (!taken.includes(base)) return base;
  for (let n = 2; ; n++) if (!taken.includes(`${base} ${n}`)) return `${base} ${n}`;
}

// Colours ----------------------------------------------------------------------
// Pastel façade colours from Old San Juan, one per agent on a document. The
// window shows them with the CSS variables --agent-<colour> (light and dark in
// style.css), on comment cards and in the editing notice alike. This is the
// only place colours are chosen, so an agent looks the same everywhere.

export const AGENT_COLOURS = ["peach", "sky", "mint", "lilac", "ochre", "rose"] as const;
export type AgentColour = (typeof AGENT_COLOURS)[number];

const PREFERRED: Record<string, number> = { Claude: 0, Codex: 1, Cursor: 2, Gemini: 3, Copilot: 5 };

function splitNumber(name: string): { base: string; n: number } {
  const m = /^(.*) (\d+)$/.exec(name);
  return m ? { base: m[1], n: Number(m[2]) } : { base: name, n: 1 };
}

/** The colour an agent's name prefers, so the same agent keeps its colour from document to document. */
export function agentColour(name: string): AgentColour {
  const { base, n } = splitNumber(name);
  let start = PREFERRED[base];
  if (start === undefined) {
    let hash = 0;
    for (const ch of base) hash = (hash * 31 + ch.charCodeAt(0)) >>> 0;
    start = hash % AGENT_COLOURS.length;
  }
  return AGENT_COLOURS[(start + n - 1) % AGENT_COLOURS.length];
}

/** The name's own colour, or the next one nobody is using (its own if all are taken). */
export function pickColour(name: string, used: Iterable<string>): AgentColour {
  const taken = new Set(used);
  const first = AGENT_COLOURS.indexOf(agentColour(name));
  for (let i = 0; i < AGENT_COLOURS.length; i++) {
    const c = AGENT_COLOURS[(first + i) % AGENT_COLOURS.length];
    if (!taken.has(c)) return c;
  }
  return AGENT_COLOURS[first];
}

export const isAgentColour = (c: unknown): c is AgentColour => (AGENT_COLOURS as readonly unknown[]).includes(c);

/**
 * A colour for every agent named on a document. Agents that already have one
 * (those connected now: the app gave it to them when they arrived) keep it;
 * the rest, in order, get their own colour or the next free one.
 */
export function agentColours(names: string[], given: Iterable<[string, string]> = []): Map<string, AgentColour> {
  const out = new Map<string, AgentColour>();
  for (const [name, colour] of given) if (isAgentColour(colour)) out.set(name, colour);
  for (const name of names) if (!out.has(name)) out.set(name, pickColour(name, out.values()));
  return out;
}

// Who's on a document ------------------------------------------------------------

export interface Member {
  sessionId: string;
  name: string;
  colour: AgentColour;
  /** Named by a role it introduced itself with (Writer), not by its tool. */
  role: boolean;
  /** When it last joined or took the document, as a count: the higher, the more recent. */
  active: number;
}

/** Whether a session is in a round on a document (editing it, waiting for the review, or working on comments it was given). */
export type InRound = (sessionId: string) => boolean;

/** Closed documents an agent still connected is kept on, the ones closed last: more than the start screen shows. */
export const CLOSED_KEPT = 20;

/**
 * Every agent session that has looked at each document while Corillo is open,
 * under the name it has there. Which comments with no @ each one gets is
 * worked out per comment (see pickedUpBy), not by who looked first. A
 * session stays on a document after its tab closes (the start screen says
 * whom its comments are for), on the CLOSED_KEPT closed last.
 */
export class Roster {
  private docs = new Map<string, Member[]>();
  private clock = 0;
  /** Documents whose tabs are closed, the one closed last at the end. */
  private shut: string[] = [];

  private colourFor(members: Member[], name: string, except?: string): AgentColour {
    return pickColour(
      name,
      members.filter((m) => m.sessionId !== except).map((m) => m.colour),
    );
  }

  /**
   * A session looks at a document: it joins under its name (numbered if
   * needed). A new chat shows as plain "Claude" when no other Claude is in a
   * round (roadmap Batch 3, item 3): the session that had the name, idle
   * since an earlier chat, is numbered instead, each name keeping its colour.
   * Without `inRound`, every other session counts as in a round.
   */
  look(key: string, sessionId: string, baseName: string, role = false, inRound?: InRound): Member {
    let members = this.docs.get(key);
    if (!members) {
      members = [];
      this.docs.set(key, members);
    }
    this.opened(key); // looked at: it's open
    let m = members.find((x) => x.sessionId === sessionId);
    if (!m) {
      const name = numberedName(baseName, members.map((x) => x.name));
      m = { sessionId, name, colour: this.colourFor(members, name), role, active: ++this.clock };
      members.push(m);
      if (inRound) this.plain(key, sessionId, inRound);
    }
    return m;
  }

  /**
   * A session on the document, numbered, takes its plain name when the
   * session that has it isn't in a round; that one is numbered instead. The
   * names' colours go with them. True if it was renamed.
   */
  plain(key: string, sessionId: string, inRound: InRound): boolean {
    const members = this.docs.get(key) ?? [];
    const m = members.find((x) => x.sessionId === sessionId);
    if (!m) return false;
    const { base, n } = splitNumber(m.name);
    if (n === 1 && m.name === base) return false;
    const holder = members.find((x) => x.name === base);
    if (!holder || inRound(holder.sessionId)) return false;
    [m.name, holder.name] = [holder.name, m.name];
    [m.colour, holder.colour] = [holder.colour, m.colour];
    return true;
  }

  /** The session joined or took the document just now. */
  touch(key: string, sessionId: string): void {
    const m = this.member(key, sessionId);
    if (m) m.active = ++this.clock;
  }

  /** What a session would be called on a document, without joining it. */
  prospect(key: string, sessionId: string, baseName: string, inRound?: InRound): { name: string } {
    const members = this.docs.get(key) ?? [];
    const m = members.find((x) => x.sessionId === sessionId);
    if (m) return { name: m.name };
    const holder = members.find((x) => x.name === baseName);
    if (holder && inRound && !inRound(holder.sessionId)) return { name: baseName };
    return { name: numberedName(baseName, members.map((x) => x.name)) };
  }

  member(key: string, sessionId: string): Member | undefined {
    return this.docs.get(key)?.find((x) => x.sessionId === sessionId);
  }

  members(key: string): Member[] {
    return [...(this.docs.get(key) ?? [])];
  }

  /** How many documents it keeps, for the leak checks. */
  get size(): number {
    return this.docs.size;
  }

  /** The document's tab closed: kept while it's among the CLOSED_KEPT closed last (roadmap Batch 6). The documents let go of. */
  closed(key: string): string[] {
    if (!this.docs.has(key)) return [];
    this.shut = [...this.shut.filter((k) => k !== key), key];
    const dropped = this.shut.splice(0, Math.max(0, this.shut.length - CLOSED_KEPT));
    for (const old of dropped) this.docs.delete(old);
    return dropped;
  }

  /** The document is open again. */
  opened(key: string): void {
    if (this.shut.includes(key)) this.shut = this.shut.filter((k) => k !== key);
  }

  /** Documents this session is on. */
  docsOf(sessionId: string): string[] {
    return [...this.docs].filter(([, members]) => members.some((m) => m.sessionId === sessionId)).map(([k]) => k);
  }

  /** A session ended: it leaves every document. */
  leave(sessionId: string): string[] {
    const affected = this.docsOf(sessionId);
    for (const key of affected) {
      const members = this.docs.get(key)!.filter((m) => m.sessionId !== sessionId);
      if (members.length) this.docs.set(key, members);
      else {
        this.docs.delete(key); // nobody left on it: nothing to keep
        this.opened(key);
      }
    }
    return affected;
  }

  /** A session takes a new base name (a custom agent introducing itself): a role's name. */
  rename(sessionId: string, baseName: string): string[] {
    const affected = this.docsOf(sessionId);
    for (const key of affected) {
      const members = this.docs.get(key)!;
      const m = members.find((x) => x.sessionId === sessionId)!;
      m.name = numberedName(baseName, members.filter((x) => x !== m).map((x) => x.name));
      m.colour = this.colourFor(members, m.name, sessionId);
      m.role = true;
    }
    return affected;
  }
}

// Which comments are for which agent ----------------------------------------------

/**
 * Whether comments with no @ are this agent's: for one comment (a function),
 * or for all of them (true or false). A function also says whether a comment
 * an agent started is this agent's (the session that started it, while it's
 * there: roadmap Batch 6, B3-R10); true or false leave that to the name it
 * was started under.
 */
export type Unnamed = boolean | ((thread: Thread) => boolean);

const takesUnnamed = (unnamed: Unnamed, thread: Thread) => (typeof unnamed === "function" ? unnamed(thread) : unnamed);

/** Where the person's last message on a comment is (-1 if they wrote none). */
function lastFromPerson(thread: Thread): number {
  for (let i = thread.messages.length - 1; i >= 0; i--) if (thread.messages[i].author.kind === "person") return i;
  return -1;
}

/**
 * Comments with no @ (roadmap Batch 3, item 3; decision D3): each goes to
 * the first agent that picks comments up after the person last wrote on it,
 * and stays with it until the person writes on it again. `shown` says how
 * many of its messages a session has been shown. The session it went to, of
 * `sessions`, or null while nobody has it.
 */
export function pickedUpBy(thread: Thread, sessions: string[], shown: (sessionId: string) => number): string | null {
  const last = lastFromPerson(thread);
  return sessions.find((s) => shown(s) > last) ?? null;
}

/**
 * Whether an agent picks up comments with no @ that nobody has yet: any
 * agent, except that one with a role name (Writer) takes only its @ comments
 * while an agent without one is on the document (D3). So "@Writer" keeps
 * meaning Writer, and a comment is never left with nobody to take it.
 */
export function picksUpUnnamed(role: boolean, others: { role: boolean }[]): boolean {
  return !role || others.every((o) => o.role);
}

/** Directed at this agent, or at nobody in particular and this agent's to take (see Unnamed). */
export function addressedTo(thread: Thread, name: string, unnamed: Unnamed): boolean {
  return thread.to === name || (thread.to === null && takesUnnamed(unnamed, thread));
}

/** This agent started the comment (agents' comments are always to the person). */
export function startedBy(thread: Thread, name: string): boolean {
  const first = thread.messages[0]?.author;
  return !!first && first.kind === "agent" && first.name === name;
}

/**
 * The agent may reply here: the comment is addressed to it, or it started it
 * and the person hasn't handed it to another agent (with @ in a reply).
 */
export function mayReply(thread: Thread, name: string, unnamed: Unnamed): boolean {
  if (thread.to === "person") return typeof unnamed === "function" ? unnamed(thread) : startedBy(thread, name);
  return addressedTo(thread, name, unnamed);
}

/** Open, for this agent, and the person spoke last: it's this agent's turn to answer. */
export function waitingFor(thread: Thread, name: string, unnamed: Unnamed): boolean {
  if (thread.status !== "open" || !mayReply(thread, name, unnamed)) return false;
  return thread.messages[thread.messages.length - 1]?.author.kind === "person";
}

/** Open, addressed to this agent, and already answered: now it's the person's turn. */
export function answeredBy(thread: Thread, name: string, unnamed: Unnamed): boolean {
  return thread.status === "open" && addressedTo(thread, name, unnamed) && !waitingFor(thread, name, unnamed);
}

// Taking turns ---------------------------------------------------------------------

export interface Pass {
  sessionId: string;
  name: string;
  /** Comments the agent replied to during this pass. */
  replied: Set<string>;
  /** Comments the agent started for the person during this pass. */
  started: Set<string>;
  /** The agent's last change didn't go through; its replies and finishing wait until it's made or the agent reads again. */
  editFailed: boolean;
  /** Comments still waiting that finishing has already pointed out, with how many messages each had then. */
  pointedOut: Map<string, number>;
  /** The note it gave with finish_editing, for the person (roadmap Batch 2, item 3); kept if that finish was turned back. */
  note?: string;
  /** How many comments waited for it when it took the document (roadmap Batch 3, item 3: a round that found none says so). */
  found?: number;
}

/** Who holds each document to edit. Only one at a time; the others read, comment and wait. */
export class Turns {
  private passes = new Map<string, Pass>();

  holder(key: string): Pass | undefined {
    return this.passes.get(key);
  }

  take(key: string, sessionId: string, name: string): { ok: true; pass: Pass; already: boolean } | { ok: false; heldBy: string } {
    const current = this.passes.get(key);
    if (current) {
      if (current.sessionId === sessionId) return { ok: true, pass: current, already: true };
      return { ok: false, heldBy: current.name };
    }
    const pass: Pass = { sessionId, name, replied: new Set(), started: new Set(), editFailed: false, pointedOut: new Map() };
    this.passes.set(key, pass);
    return { ok: true, pass, already: false };
  }

  holds(key: string, sessionId: string): boolean {
    return this.passes.get(key)?.sessionId === sessionId;
  }

  /** End the pass on a document, whoever holds it. */
  end(key: string): Pass | undefined {
    const pass = this.passes.get(key);
    this.passes.delete(key);
    return pass;
  }

  /** Documents a session holds. */
  heldBy(sessionId: string): string[] {
    return [...this.passes].filter(([, p]) => p.sessionId === sessionId).map(([k]) => k);
  }
}
