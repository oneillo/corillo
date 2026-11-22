// The line in Corillo's log when an agent tool connects (roadmap Batch 20,
// item 2; R16-12): the name and version the tool gives itself, and the two
// settings of Claude Code that decide whether it can wait for the person's
// review (see canWaitIn), as the connector sees them. If a new release of the
// tool changes one, the log says so, instead of a wait that just doesn't work.
// All of it is outside text: each value is cut and cleaned by the connector
// before it's sent, and again by Corillo before it's written. Nothing in the
// line is read back, shown in the window or told to an agent.

/** The most characters a value keeps in the log. */
export const LOG_MOST = 100;

/** The most characters of a value looked at: one of nothing but characters left out isn't read to its end (the review of Batch 20, R20-7). */
export const LOOK_MOST = 1_000;

/** The settings the line reports, as the connector sees them. */
export const WATCHED_SETTINGS = ["CLAUDE_CODE_ENTRYPOINT", "CLAUDE_AUTO_BACKGROUND_TASKS"] as const;

/**
 * Left out of a value: control characters (C0, DEL, C1), the line and
 * paragraph separators, marks that turn text around or hide it (Unicode's
 * format characters), and half a character (a lone surrogate).
 */
const UNSAFE = /[\p{Cc}\p{Cf}\p{Cs}\p{Zl}\p{Zp}]/u;

/** A value as the log keeps it: its first 100 characters once the unsafe ones are out, of its first 1,000, or nothing if it isn't text. */
export function forLog(value: unknown): string | undefined {
  if (typeof value !== "string") return undefined;
  let out = "";
  let kept = 0;
  let looked = 0;
  for (const char of value) {
    if (++looked > LOOK_MOST) break;
    if (UNSAFE.test(char)) continue;
    out += char;
    if (++kept === LOG_MOST) break;
  }
  return out;
}

/** The connector's end: the watched settings it sees, each cut and cleaned; one that isn't set isn't there. */
export function settingsForLog(env: Record<string, string | undefined>): Record<string, string> {
  const seen: Record<string, string> = {};
  for (const name of WATCHED_SETTINGS) {
    const value = forLog(env[name]);
    if (value !== undefined) seen[name] = value;
  }
  return seen;
}

/** Whether a connector sent a plain object (not a list, not nothing). */
const isRecord = (from: unknown): from is object => typeof from === "object" && from !== null && !Array.isArray(from);

/** A field of something a connector sent, only if it is its own plain value (never a getter's, never inherited). */
function ownField(from: unknown, name: string): unknown {
  if (!isRecord(from)) return undefined;
  const field = Object.getOwnPropertyDescriptor(from, name);
  return field && "value" in field ? field.value : undefined;
}

/**
 * Corillo's end: the line, from the hello's client and settings, each value
 * cleaned and cut again (the connector isn't trusted). A connector from
 * before this line sends no settings: the line says so, rather than "not set"
 * (the review of Batch 20, R20-6).
 */
export function connectedLine(client: unknown, seen: unknown): string {
  const shown = (value: unknown, missing: string) => {
    const text = forLog(value);
    return text === undefined ? missing : JSON.stringify(text);
  };
  const settings = isRecord(seen)
    ? WATCHED_SETTINGS.map((name) => `${name} ${shown(ownField(seen, name), "not set")}`).join(", ")
    : "settings not reported (an older connector)";
  return `An agent tool connected: name ${shown(ownField(client, "name"), "not given")}, version ${shown(ownField(client, "version"), "not given")}; ${settings}.`;
}
