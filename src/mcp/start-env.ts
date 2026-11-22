// What Corillo starts with when the connector has to start it: what any app
// opened from the Finder or the Dock has (the person's home folder, where
// programs are found, the temporary folder and Chromium's own setting for it
// on the Mac, language and region), and Corillo's own settings (CORILLO_...).
// Not the rest of the agent tool's surroundings: its keys and settings (API
// keys, NODE_OPTIONS and the like) aren't Corillo's, and would make Corillo,
// and the exports it runs, behave differently depending on who started it.

const KEPT = new Set(["HOME", "PATH", "TMPDIR", "MAC_CHROMIUM_TMPDIR", "LANG", "USER", "LOGNAME", "SHELL", "__CF_USER_TEXT_ENCODING"]);

/** The folder Corillo works from: where the Mac starts an app opened from the Finder or the Dock. */
export const START_FOLDER = "/";

export function startEnv(env: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  const out: NodeJS.ProcessEnv = {};
  for (const [name, value] of Object.entries(env)) {
    if (value !== undefined && (KEPT.has(name) || name.startsWith("LC_") || name.startsWith("CORILLO_"))) out[name] = value;
  }
  return out;
}
