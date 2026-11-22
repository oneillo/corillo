// Where the running Corillo listens for agents: a local socket in an
// owner-only folder inside Corillo's data folder. Both the app and the agent
// connector work it out the same way, from the data folder.
import { createHash } from "node:crypto";
import * as fs from "node:fs";
import { homedir, userInfo } from "node:os";
import * as path from "node:path";

/** macOS refuses socket paths longer than 104 bytes (counting the end byte). */
const MAX_SOCKET_PATH = 103;

/** Corillo's data folder, as Electron chooses it for an app named Corillo. */
export function defaultDataFolder(platform: NodeJS.Platform = process.platform, env = process.env): string {
  if (env.CORILLO_USER_DATA) return env.CORILLO_USER_DATA;
  if (platform === "darwin") return path.join(homedir(), "Library", "Application Support", "Corillo");
  if (platform === "win32") return path.join(env.APPDATA ?? path.join(homedir(), "AppData", "Roaming"), "Corillo");
  return path.join(env.XDG_CONFIG_HOME ?? path.join(homedir(), ".config"), "Corillo");
}

/**
 * A socket in /tmp is only safe in a folder that's this user's own and that
 * nobody else can open: otherwise another user of the Mac could have put a
 * socket there first, and be sent an agent's documents. Why not, or null.
 */
export function socketFolderProblem(socketPath: string): string | null {
  const folder = path.dirname(socketPath);
  let stat: fs.Stats;
  try {
    stat = fs.lstatSync(folder);
  } catch {
    return null; // not there yet: Corillo makes it, as its own, when it starts
  }
  const mine = !process.getuid || stat.uid === process.getuid();
  if (stat.isDirectory() && mine && (stat.mode & 0o777) === 0o700) return null;
  return `Corillo's connection isn't safe to use: ${folder} isn't this Mac user's own private folder, so nothing was sent. Restarting the Mac clears it.`;
}

/** The socket for a data folder. Too long a path falls back to a short one in /tmp, kept apart per data folder. */
export function socketPathFor(dataFolder: string, platform: NodeJS.Platform = process.platform): string {
  const hash = createHash("sha256").update(path.resolve(dataFolder)).digest("hex").slice(0, 16);
  if (platform === "win32") return `\\\\.\\pipe\\corillo-${hash}`;
  const preferred = path.join(dataFolder, "sockets", "agents.sock");
  if (Buffer.byteLength(preferred) <= MAX_SOCKET_PATH) return preferred;
  let uid = "user";
  try {
    uid = String(userInfo().uid);
  } catch {
    // keep the generic folder name
  }
  return path.join("/tmp", `corillo-${uid}`, `${hash}.sock`);
}
