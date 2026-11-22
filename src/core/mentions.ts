// Naming an agent in a comment with @, the way people mention a colleague in
// Word, Google Docs or Slack. Plain rules, no window code, so they can be
// tested on their own: where an @ starts a name being typed, which names in a
// text are tags, which agents the list offers (connected to Corillo now or
// not), and the agents Corillo remembers between launches.

/** "@Name" in a text: from the @ up to the end of the name. */
export interface Tag {
  start: number;
  end: number;
  /** The agent's name as Corillo knows it (the text may be in other capitals). */
  name: string;
}

/** An agent the list offers. */
export interface Choice {
  name: string;
  /** Connected to Corillo right now (an agent on the document always is). */
  connected: boolean;
  /** The document's default agent. */
  isDefault: boolean;
}

/** An agent Corillo knows from any document: connected right now, or met before. */
export interface KnownAgent {
  name: string;
  connected: boolean;
}

/** Longest a name being typed after @ can be before the list stops looking. */
const MAX_QUERY = 40;

/** What can't come right before an @ that starts a name: letters, digits and the joiners of an email address. */
const BEFORE = /[\p{L}\p{N}_.+\-@/\\]/u;
/** What can't come right after a name: more of a word. */
const WORD = /[\p{L}\p{N}_@]/u;

const lower = (s: string) => s.toLocaleLowerCase();

/** An @ here can start a name: at the start, or after a space, a line break, a bracket or punctuation. */
function startsName(text: string, at: number): boolean {
  return text[at] === "@" && (at === 0 || !BEFORE.test(text[at - 1]));
}

/** The name ends here: the end of the text, a space or punctuation, not a longer word or an address. */
function endsName(text: string, end: number): boolean {
  const next = text[end];
  if (next === undefined) return true;
  if (WORD.test(next)) return false;
  // "@claude.com" or "@claude-code" is an address or another word, not Claude.
  if ((next === "." || next === "-") && end + 1 < text.length && WORD.test(text[end + 1])) return false;
  return true;
}

/**
 * Every tag in a text: an @ that starts a name (not one inside a word, like an
 * email address) followed by one of these names, in any capitals, and nothing
 * more of a word. Where names overlap ("Claude" and "Claude 2"), the longest wins.
 */
export function findTags(text: string, names: readonly string[]): Tag[] {
  const tags: Tag[] = [];
  if (!text.includes("@") || !names.length) return tags;
  const byLength = [...new Set(names.filter((n) => n.trim()))].sort((a, b) => b.length - a.length);
  const lowered = byLength.map(lower);
  for (let at = text.indexOf("@"); at >= 0; at = text.indexOf("@", at + 1)) {
    if (!startsName(text, at)) continue;
    for (let i = 0; i < byLength.length; i++) {
      const end = at + 1 + byLength[i].length;
      // Each name against the text right after this @, in small capitals: the
      // whole text in small capitals can be longer ("İ" becomes two characters).
      if (lower(text.slice(at + 1, end)) === lowered[i] && endsName(text, end)) {
        tags.push({ start: at, end, name: byLength[i] });
        at = end - 1;
        break;
      }
    }
  }
  return tags;
}

/** The different agents a text names, in the order they're first named. */
export function namedAgents(tags: readonly Tag[]): string[] {
  const out: string[] = [];
  for (const t of tags) if (!out.includes(t.name)) out.push(t.name);
  return out;
}

/**
 * The name being typed after an @ that ends at the caret, if there is one: the
 * @'s place and what's typed after it. An @ inside a word (an email address)
 * doesn't count, nor one on an earlier line.
 */
export function typingAt(text: string, caret: number): { start: number; query: string } | null {
  const lineStart = text.lastIndexOf("\n", caret - 1) + 1;
  for (let at = caret - 1; at >= lineStart && caret - at <= MAX_QUERY + 1; at--) {
    if (text[at] !== "@") continue;
    if (!startsName(text, at)) return null;
    return { start: at, query: text.slice(at + 1, caret) };
  }
  return null;
}

/** A name fits what's typed when it, or one of its words, starts with it, in any capitals. */
export function fits(name: string, query: string): boolean {
  const q = lower(query);
  if (!q) return true;
  const n = lower(name);
  return n.startsWith(q) || n.split(/\s+/).some((word) => word.startsWith(q));
}

/**
 * What the list offers, each name once: the agents connected to Corillo right
 * now first (this document's own first, its default agent at the top), then
 * the agents that aren't, most recently seen first, then any other agent this
 * document's comments name.
 */
export function mentionChoices(
  onDoc: readonly { name: string; isDefault: boolean }[],
  known: readonly KnownAgent[],
  named: readonly string[] = [],
): Choice[] {
  const choices: Choice[] = [];
  const seen = new Set<string>();
  const add = (name: string, connected: boolean, isDefault: boolean) => {
    const key = lower(name.trim());
    if (!key || seen.has(key)) return;
    seen.add(key);
    choices.push({ name, connected, isDefault });
  };
  for (const a of onDoc) if (a.isDefault) add(a.name, true, true);
  for (const a of onDoc) if (!a.isDefault) add(a.name, true, false);
  for (const k of known) if (k.connected) add(k.name, true, false);
  for (const k of known) if (!k.connected) add(k.name, false, false);
  for (const name of named) add(name, false, false);
  return choices;
}

/** The choices that fit what's typed after the @. */
export function filterChoices(choices: readonly Choice[], query: string): Choice[] {
  return choices.filter((c) => fits(c.name, query));
}

// Remembered between launches -----------------------------------------------------

/** An agent Corillo has seen, and when it last did (milliseconds since 1970). */
export interface Seen {
  name: string;
  at: number;
}

/** How many agents Corillo remembers: enough for anyone's agents, short enough to see at a glance. */
export const REMEMBERED = 12;
/** An agent not seen for this many days is forgotten. */
export const FORGET_AFTER_DAYS = 30;
const DAY = 24 * 60 * 60 * 1000;

/**
 * An agent's name without the number a document gave it: "Claude 2" is Claude
 * elsewhere. Given the other names known, the number goes only when the name
 * without it is one of them, since a document numbers an agent only when its
 * name is taken: an agent that calls itself "Reviewer 2" stays Reviewer 2.
 */
export function baseName(name: string, others?: readonly string[]): string {
  const m = /^(.+) (\d+)$/.exec(name.trim());
  if (!m || Number(m[2]) < 2) return name.trim();
  const key = lower(m[1]);
  return !others || others.some((o) => lower(o.trim()) === key) ? m[1] : name.trim();
}

/**
 * The remembered agents after seeing these ones now: most recently seen first,
 * each once, none not seen for FORGET_AFTER_DAYS, at most REMEMBERED.
 */
export function remember(known: readonly Seen[], names: readonly string[], now: number): Seen[] {
  const out: Seen[] = [];
  const keys = new Set<string>();
  const others = [...names, ...known.map((s) => s?.name).filter((n): n is string => typeof n === "string")];
  const add = (name: unknown, at: unknown) => {
    if (typeof name !== "string" || typeof at !== "number" || !Number.isFinite(at)) return;
    const base = baseName(name, others);
    const key = lower(base);
    if (!base || keys.has(key) || now - at > FORGET_AFTER_DAYS * DAY) return;
    keys.add(key);
    out.push({ name: base, at: Math.min(at, now) });
  };
  for (const name of names) add(name, now);
  for (const s of known) add(s?.name, s?.at);
  return out.sort((a, b) => b.at - a.at).slice(0, REMEMBERED);
}

/**
 * Every agent Corillo knows, for the list: those connected right now first, in
 * the order given, then the remembered ones that aren't, most recent first.
 */
export function knownAgents(seen: readonly Seen[], connected: readonly string[]): KnownAgent[] {
  const out: KnownAgent[] = [];
  const keys = new Set<string>();
  const add = (name: string, isConnected: boolean) => {
    const key = lower(name);
    if (!name || keys.has(key)) return;
    keys.add(key);
    out.push({ name, connected: isConnected });
  };
  const others = [...connected, ...seen.map((s) => s.name)];
  for (const name of connected) add(baseName(name, others), true);
  for (const s of seen) add(s.name, false);
  return out;
}
