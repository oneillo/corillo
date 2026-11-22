// Looking back through a document's versions, for agents: list_versions, read_version and show_changes.
// The person's unsaved edits are saved first, so the newest version is up to date.
import type { Message, Thread } from "../../core/comments";
import { summaryText } from "../../core/change-summary";
import { describeChanges } from "../../core/describe-changes";
import { formatDate, relativeTime, versionLabel, type Version } from "../../core/versions";
import type { AgentService } from "./agent-service";
import { NO_ANSWER, VERSIONS_SHOWN, plural } from "./limits-and-words";
import { LONG, characterArg, lineArg, outlineAndStart, someLines } from "./long-documents";
import { AgentError, type Call, type FlushResult, type Looked } from "./shapes";

/** Lines after the first set in under it, so a long message stays inside its item. */
const indent = (text: string, by: string) => text.replace(/\r?\n/g, `\n${by}`);

/** The person's edits couldn't be saved first, so the newest version may not have them: say so. */
export function historyNote(this: AgentService, call: Call, flushed: FlushResult): void {
  if (flushed === "saved") return;
  const why =
    flushed === "no-answer"
      ? NO_ANSWER
      : flushed === "unsaved"
        ? "Corillo can't save this document right now, so the person may have edits that aren't saved yet."
        : "The person has edits that clash with a change made to the file outside Corillo, and hasn't chosen which to keep.";
  call.notes.push(`Note: ${why} ${flushed === "conflict" ? "The" : "If so, the"} newest version doesn't have them.`);
}

export function versionArg(this: AgentService, value: unknown, what: string): number | undefined {
  if (value === undefined || value === null || value === "") return undefined;
  const n = typeof value === "string" ? Number(value.trim().replace(/^v(ersion)?\s*/i, "")) : value;
  if (typeof n !== "number" || !Number.isInteger(n) || n < 1) {
    throw new AgentError(`Give ${what} as a version number from list_versions, such as 3.`);
  }
  return n;
}

export function versionsOf(this: AgentService, looked: Looked): Version[] {
  const versions = this.hooks.versions(looked.doc.storeId);
  if (!versions.length) throw new AgentError(`${looked.label} has no history yet.`);
  return versions;
}

export function findVersion(this: AgentService, versions: Version[], n: number, label: string): Version {
  const v = versions.find((x) => x.n === n);
  if (!v) throw new AgentError(`${label} has no version ${n}. Its versions are ${versions[0].n} to ${versions[versions.length - 1].n}.`);
  return v;
}

export function versionTextOf(this: AgentService, looked: Looked, v: Version): string {
  const text = this.hooks.versionText(looked.doc.storeId, v.n);
  if (text === null) throw new AgentError(`Version ${v.n} of ${looked.label} can't be read: part of its history was damaged.`);
  return text;
}

/** "Claude, 8 Nov, 14:02 (5 minutes ago)" */
export function whoAndWhen(this: AgentService, v: Version): string {
  const ago = relativeTime(v.saved);
  return `${versionLabel(v, "agent")}, ${formatDate(v.saved)}${ago && !ago.includes(":") ? ` (${ago.toLowerCase()})` : ""}`;
}

/**
 * A comment an agent's pass addressed, in full, as the pass left it: the
 * words it was on as the pass began, the comment, every message since the
 * thread's last appearance in the history (`before`, so a long thread isn't
 * repeated under every pass), and what the pass changed for it.
 */
export function addressedLines(this: AgentService, t: Thread, before: { n: number; ids: Set<string> } | undefined): string {
  const where = t.anchor ? `on "${indent(t.anchor.quote.trim(), "     ")}"` : "on the whole document";
  const who = (m: Message) => (m.author.kind === "agent" ? m.author.name : m.mention ? `Person (to ${m.mention})` : "Person");
  const line = (m: Message) => `    ${who(m)}: ${indent(m.body.trim(), "      ")}`;
  const [first, ...rest] = t.messages;
  const lines = [`  - ${where}`];
  if (first) lines.push(line(first));
  const since = before ? rest.filter((m) => !before.ids.has(m.id)) : rest;
  const skipped = rest.length - since.length;
  if (before && skipped) lines.push(`    (${plural(skipped, "earlier message")} in this thread: see version ${before.n})`);
  lines.push(...since.map(line));
  const changed = summaryText(t.change?.spans ?? []);
  if (changed) lines.push(`    Changed: ${changed}`);
  return lines.join("\n");
}

export async function listVersions(this: AgentService, call: Call, args: Record<string, unknown>): Promise<string> {
  const looked = this.look(call, args);
  this.historyNote(call, (await this.latest(looked.doc)).flushed);
  const versions = this.versionsOf(looked);
  const newest = versions[versions.length - 1];
  // For each pass's comments, the version that last listed the same thread, and the messages it had then.
  const lastSeen = new Map<string, { n: number; ids: Set<string> }>();
  const before = new Map<Version, Map<string, { n: number; ids: Set<string> }>>();
  for (const v of versions) {
    const mine = new Map<string, { n: number; ids: Set<string> }>();
    for (const t of v.addressed ?? []) {
      const seen = lastSeen.get(t.id);
      if (seen) mine.set(t.id, seen);
      lastSeen.set(t.id, { n: v.n, ids: new Set(t.messages.map((m) => m.id)) });
    }
    before.set(v, mine);
  }
  const shown = (args.all === true ? versions : versions.slice(-VERSIONS_SHOWN)).slice().reverse();
  const lines = shown.map((v) => {
    let line = `Version ${v.n}${v === newest ? " (current)" : ""}: ${this.whoAndWhen(v)}`;
    if (v.kind === "agent" && v.addressed?.length) {
      // Started in this pass: only agents have written on it, and no earlier pass listed it.
      const started = v.addressed.filter((t) => t.messages.every((m) => m.author.kind === "agent") && !before.get(v)?.has(t.id));
      const answered = v.addressed.filter((t) => !started.includes(t));
      const lines = (ts: Thread[]) => ts.map((t) => this.addressedLines(t, before.get(v)?.get(t.id))).join("\n");
      if (answered.length) line += `. Addressed ${plural(answered.length, "comment")}:\n${lines(answered)}`;
      if (started.length) line += `${answered.length ? "\n " : "."} Started ${plural(started.length, "comment")}:\n${lines(started)}`;
    }
    if (v.request) line += `\n  Asked in chat: "${indent(v.request.trim(), "    ")}"`;
    const other = summaryText(v.other ?? []);
    if (other) line += v.request ? `\n    Changed: ${other}` : `\n  Changes not tied to a comment: ${other}`;
    if (v.note) line += `\n  Note to the person: "${indent(v.note.trim(), "    ")}"`;
    return line;
  });
  const older = versions.length - shown.length;
  const more = older > 0 ? `\n\n${plural(older, "older version")} not shown; set all to true to list ${older === 1 ? "it" : "them"}.` : "";
  return `${looked.label} has ${plural(versions.length, "version")}, newest first:\n\n${lines.join("\n")}${more}\n\nread_version gives a version's text; show_changes shows what it changed.`;
}

export async function readVersion(this: AgentService, call: Call, args: Record<string, unknown>): Promise<string> {
  const looked = this.look(call, args);
  const n = this.versionArg(args.version, "version");
  if (n === undefined) throw new AgentError("Give the version's number, as list_versions shows it.");
  this.historyNote(call, (await this.latest(looked.doc)).flushed);
  const versions = this.versionsOf(looked);
  const v = this.findVersion(versions, n, looked.label);
  const from = lineArg(args.from_line, "from_line");
  const to = lineArg(args.to_line, "to_line");
  const at = characterArg(args);
  const text = this.versionTextOf(looked, v);
  // Part of it, by lines; a long version comes as its outline and its start, as read_document gives a long document.
  if (from !== undefined || to !== undefined) return someLines(`version ${n} of ${looked.label}`, text, from ?? 1, to, `Version ${n} of ${looked.label}`, at);
  const current = v === versions[versions.length - 1] ? " It's the current version." : "";
  if (text.length > LONG) return outlineAndStart(`Version ${n} of ${looked.label} (${this.whoAndWhen(v)})`, text, "read_version", current);
  return `The whole text of version ${n} of ${looked.label} (${this.whoAndWhen(v)}) follows.${current}\n\n${text}`;
}

export async function showChanges(this: AgentService, call: Call, args: Record<string, unknown>): Promise<string> {
  const looked = this.look(call, args);
  const asked = this.versionArg(args.version, "version");
  const other = this.versionArg(args.compared_with, "compared_with");
  this.historyNote(call, (await this.latest(looked.doc)).flushed);
  const versions = this.versionsOf(looked);
  const v = asked === undefined ? versions[versions.length - 1] : this.findVersion(versions, asked, looked.label);
  let before: Version;
  let after: Version;
  let header: string;
  if (other !== undefined) {
    const o = this.findVersion(versions, other, looked.label);
    if (o.n === v.n) throw new AgentError("Give two different versions to compare.");
    [before, after] = o.n < v.n ? [o, v] : [v, o];
    header = `Changes to ${looked.label} from version ${before.n} (${this.whoAndWhen(before)}) to version ${after.n} (${this.whoAndWhen(after)}).`;
  } else {
    const i = versions.indexOf(v);
    if (i === 0) {
      return `Version ${v.n} of ${looked.label} is its first version (${this.whoAndWhen(v)}), so there's nothing earlier to compare it with. read_version gives its text.`;
    }
    [before, after] = [versions[i - 1], v];
    header = `What version ${after.n} of ${looked.label} (${this.whoAndWhen(after)}) changed, compared with version ${before.n} (${versionLabel(before, "agent")}).`;
  }
  const changes = describeChanges(this.versionTextOf(looked, before), this.versionTextOf(looked, after));
  return `${header} In a changed passage, [-text-] was taken out and {+text+} was put in.\n\n${changes}`;
}
