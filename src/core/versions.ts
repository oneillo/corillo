// A document's versions, as the window and agents see them. One editing pass
// is one version: the person's edits between other people's turns, an agent's
// whole pass, a change made outside Corillo, or a restore.
import type { Thread } from "./comments";
import type { ChangeSpan } from "./change-links";
import type { ChangeSummary } from "./change-summary";

export type VersionKind = "first" | "person" | "agent" | "outside" | "restored";

export interface Version {
  /** 1 for the first version, counting up. */
  n: number;
  kind: VersionKind;
  /** The agent whose pass this was. */
  agent?: string;
  /** For a restore: which version was brought back, and when that version was saved. */
  restoredFrom?: { n: number; saved: string };
  /** For the first version of a copy of a Word document: the Word file's name (roadmap Batch 5, item 1). */
  madeFrom?: string;
  /** When the version began and when it was last saved (ISO dates). */
  created: string;
  saved: string;
  /** Still being added to: the person's pass, or an agent's pass in progress. */
  open?: boolean;
  /**
   * For an agent's pass: the comments it addressed, as they were when it
   * finished, each on the words it was on when the pass began. The record
   * keeps every word, whatever happens to the comment later.
   */
  addressed?: Thread[];
  /** For an agent's pass: what it changed that no comment asked for (with a request, what it changed for that). */
  other?: ChangeSpan[];
  /** For an agent's pass: what the person asked for in the agent's chat, in their words where the agent had them. */
  request?: string;
  /** For an agent's pass: its note for the person, given as it finished (roadmap Batch 2, item 3). */
  note?: string;
  /** For an agent's pass: when it took the document, and when it finished (ISO dates; since 2026-11-10). */
  taken?: string;
  ended?: string;
  /**
   * For an agent's pass: it took the document from the person. True when the
   * person had worked on it since the pass before (edited it, or wrote,
   * edited or resolved a comment), or no agent had had it before; false when
   * they only read in between, so the two passes are one round, shown
   * together by Show changes (roadmap Batch 3, item 1). Missing in histories
   * from before 2026-11-10.
   */
  handedOver?: boolean;
}

/**
 * What Show changes shows: everything since the person last handed the
 * document over to an agent (roadmap Batch 3, item 1, decision D2).
 */
export interface SinceHandOver {
  /** The newest version, and its text. */
  n: number;
  saved: string;
  text: string;
  /** When an agent took the document from the person; null when no agent has had it yet. */
  at: string | null;
  /** The text as it was handed over; null with no hand-over, or when it can't be rebuilt. */
  base: string | null;
  /** What happened since, in order, each a run of versions: whether it was the person's own, and the text after it. The last is the text now. */
  steps: { yours: boolean; text: string }[];
  /** The agents who changed the text since, in order. */
  agents: string[];
  /** Another app changed the text since. */
  outside: boolean;
}

/**
 * Which version the person last handed over at: the newest agent's pass that
 * took the document from them (see Version.handedOver), or -1 when no agent
 * has had it. A history from before 2026-11-10 doesn't say: there, a pass
 * took it from the person unless the version before it (passing over any
 * change from another app) was another agent's.
 */
export function handOverIndex(versions: readonly Pick<Version, "kind" | "handedOver">[]): number {
  for (let i = versions.length - 1; i >= 0; i--) {
    const v = versions[i];
    if (v.kind !== "agent") continue;
    if (v.handedOver) return i;
    let j = i - 1;
    while (j >= 0 && versions[j].kind === "outside") j--;
    if (j < 0 || versions[j].kind !== "agent") return i;
  }
  return -1;
}

/** What the window asks for to show a version and what it changed. */
export interface VersionTexts {
  /** The version's text, or null if it can't be rebuilt (part of the history was damaged). */
  text: string | null;
  /** The version right before it, or null if there is none or it can't be rebuilt. */
  before: string | null;
  hasBefore: boolean;
}

/**
 * What a version's row in History says it changed (roadmap Batch 4, item 2):
 * the sections it touched, by their headings, in the order they come; and,
 * for a version that isn't an agent's (whose brief has its change lines), its
 * change line. Worked out the first time History shows the row; missing for
 * the first version, and until then.
 */
export interface RowStory {
  /** At most SECTIONS_KEPT (change-sections.ts). */
  sections?: string[];
  /** How many more sections it changed, not named. */
  moreSections?: number;
  change?: ChangeSummary;
}

/** A row's story asked for: one version, or several of the person's in a row shown as one (the first and the last of them). */
export type StoryAsk = number | { from: number; to: number };

/** A version as the History panel lists it: who made it and when, and what it changed in brief. */
export type VersionRow = Pick<Version, "n" | "kind" | "agent" | "restoredFrom" | "madeFrom" | "saved"> & RowStory;

/**
 * An agent's pass in the History list, compactly: the start of each comment
 * it answered and of its last reply there (enough for two lines in the
 * widest panel, with an ellipsis where there's more), and what it changed
 * for each; then what was asked in the chat, or "Other changes"; then the
 * start of the agent's note.
 */
export interface Brief {
  threads: { comment: string; reply?: string; change?: ChangeSummary }[];
  loose?: { request?: string; change?: ChangeSummary };
  note?: string;
}

/** What an agent's pass left with its version, whole: what the open version in History shows. */
export type Conversation = Pick<Version, "addressed" | "other" | "request" | "note">;

/** What the window has of a history, so only what's new is sent (see HistoryList). */
export interface HistoryKnown {
  stamp: string;
  /** How many versions it has. */
  count: number;
}

/**
 * The History panel's list: only what its rows show, never whole
 * conversations (each is asked for when its version is opened). Asked with
 * what the window already has, and the agents' feedback hasn't changed
 * since, only the versions from the window's newest on are sent, without
 * briefs: a save while the panel is open sends one row.
 */
export interface HistoryList {
  /** The versions from index `from` on, oldest first (from 0: every version). */
  versions: VersionRow[];
  from: number;
  /** With every version (from 0): each agent's pass's brief, by version. */
  briefs?: Record<number, Brief>;
  /** Changes when the history's feedback does; given back to ask for only what's new. */
  stamp: string;
  /** The agent holding the document, if one is mid-pass. */
  holder: string | null;
}

export type RestoreResult = { ok: true; text: string; same: boolean } | { ok: false; reason: string };

// How a date is written: in the Mac's own language and region (a test can name one).
const FORMATS = {
  time: { hour: "numeric", minute: "2-digit" }, // "7:55 PM" as the Mac writes it, not "07:55 PM"; "19:55" where the region uses 24 hours
  day: { day: "numeric", month: "short" },
  dayAndYear: { day: "numeric", month: "short", year: "numeric" },
  weekday: { weekday: "long" },
} satisfies Record<string, Intl.DateTimeFormatOptions>;
const made = new Map<string, Intl.DateTimeFormat>();

function written(d: Date, kind: keyof typeof FORMATS, locale?: string): string {
  const key = `${kind} ${locale ?? ""}`;
  let format = made.get(key);
  if (!format) made.set(key, (format = new Intl.DateTimeFormat(locale, FORMATS[kind])));
  return format.format(d);
}

/** "Nov 8, 7:55 PM", with the year when it isn't this year. */
export function formatDate(iso: string, now = Date.now(), locale?: string): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return "an earlier time";
  const day = written(d, d.getFullYear() === new Date(now).getFullYear() ? "day" : "dayAndYear", locale);
  return `${day}, ${written(d, "time", locale)}`;
}

const sameDay = (a: Date, b: Date) =>
  a.getFullYear() === b.getFullYear() && a.getMonth() === b.getMonth() && a.getDate() === b.getDate();

/**
 * When, the one way the window says it, on a comment's card and on a version
 * in History alike: "Just now", "5 min ago", "2 hours ago", "Yesterday, 7:55 PM",
 * "Monday, 7:55 PM", then the date. Minutes and hours are rounded down, so
 * it never says more time has passed than has.
 */
export function relativeTime(iso: string, now: number | Date = Date.now(), locale?: string): string {
  const then = new Date(iso);
  if (Number.isNaN(then.getTime())) return "";
  const at = typeof now === "number" ? now : now.getTime();
  const minutes = Math.floor(Math.max(0, at - then.getTime()) / 60_000);
  if (minutes < 1) return "Just now";
  if (minutes < 60) return `${minutes} min ago`;
  const today = new Date(at);
  if (sameDay(then, today)) {
    const hours = Math.floor(minutes / 60);
    return hours === 1 ? "1 hour ago" : `${hours} hours ago`;
  }
  const time = written(then, "time", locale);
  const yesterday = new Date(today.getFullYear(), today.getMonth(), today.getDate() - 1);
  if (sameDay(then, yesterday)) return `Yesterday, ${time}`;
  const weekAgo = new Date(today.getFullYear(), today.getMonth(), today.getDate() - 6);
  if (then >= weekAgo) return `${written(then, "weekday", locale)}, ${time}`;
  return formatDate(iso, at, locale);
}

/**
 * When the document was handed over, in the middle of a sentence ("since you
 * handed it over at 10:42 AM"): "at 10:42 AM" today, then "yesterday at 7:55
 * PM", "on Monday at 7:55 PM" within the week, then "on Nov 3 at 7:55 PM".
 */
export function handedOverAt(iso: string, now: number | Date = Date.now(), locale?: string): string {
  const then = new Date(iso);
  if (Number.isNaN(then.getTime())) return "earlier";
  const today = new Date(typeof now === "number" ? now : now.getTime());
  const time = written(then, "time", locale);
  if (sameDay(then, today)) return `at ${time}`;
  if (sameDay(then, new Date(today.getFullYear(), today.getMonth(), today.getDate() - 1))) return `yesterday at ${time}`;
  if (then >= new Date(today.getFullYear(), today.getMonth(), today.getDate() - 6) && then < today) return `on ${written(then, "weekday", locale)} at ${time}`;
  return `on ${written(then, then.getFullYear() === today.getFullYear() ? "day" : "dayAndYear", locale)} at ${time}`;
}

/** A time from relativeTime, in the middle of a sentence: "(Claude, just now)", "(Claude, Nov 3, 7:55 PM)". */
export function inSentence(when: string): string {
  return when.replace(/^(Just now|Yesterday)/, (word) => word.toLowerCase());
}

/** The full date and time, for a tooltip: "November 9, 2026 at 7:55 PM". */
export function fullTime(iso: string): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return "";
  return d.toLocaleString(undefined, { dateStyle: "long", timeStyle: "short" });
}

/**
 * Who made a version, in a word or two. The window speaks to the person
 * ("You"); agents read about the person in the third person.
 */
export function versionLabel(v: VersionRow, reader: "person" | "agent" = "person"): string {
  switch (v.kind) {
    case "first":
      return v.madeFrom ? `Made from ${v.madeFrom}` : "First version";
    case "person":
      return reader === "person" ? "You" : "The person";
    case "agent":
      return v.agent || "Agent";
    case "outside":
      return "Changed outside Corillo";
    case "restored": {
      const from = v.restoredFrom ? formatDate(v.restoredFrom.saved) : "an earlier time";
      return reader === "person"
        ? `Restored version from ${from}`
        : `The person restored version ${v.restoredFrom?.n ?? "?"} (from ${from})`;
    }
  }
}
