// The version the connector tells an agent tool when it connects is
// package.json's, read from that one place however the connector is built
// (roadmap Batch 20, item 2; R16-14). Before, it was written a second time in
// src/mcp/tools.ts, and the first version bump would have left agents told the old one.
import { afterEach, describe, expect, it } from "vitest";
import { spawn, type ChildProcess } from "node:child_process";
import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { build, type Plugin } from "esbuild";
import { onLines } from "../../src/mcp/lines";
import { SERVER_VERSION } from "../../src/mcp/tools";
import { throwawayStart } from "../e2e/helpers";

const ROOT = join(import.meta.dirname, "..", "..");
const PACKAGE = join(ROOT, "package.json");
const ours = JSON.parse(readFileSync(PACKAGE, "utf8")) as { version: string };

/** package.json as the build reads it, with another version in it. */
const withVersion = (version: string): Plugin => ({
  name: "other-version",
  setup(b) {
    b.onLoad({ filter: /package\.json$/ }, (args) =>
      args.path === PACKAGE ? { contents: JSON.stringify({ ...ours, version }), loader: "json" } : undefined,
    );
  },
});

/** The connector, built the way scripts/build.mjs builds dist/mcp.cjs, into this run's own folder. */
async function buildConnector(plugins: Plugin[] = []): Promise<string> {
  const out = join(mkdtempSync(join(tmpdir(), "corillo-connector-")), "mcp.cjs");
  await build({ entryPoints: [join(ROOT, "src", "mcp", "server.ts")], outfile: out, bundle: true, platform: "node", format: "cjs", target: "node22", logLevel: "silent", plugins });
  return out;
}

let running: ChildProcess | null = null;
afterEach(() => {
  running?.kill();
  running = null;
});

/** What the connector answers an agent tool's first message. */
async function introduce(connector: string): Promise<{ serverInfo: { name: string; version: string } }> {
  // A data folder of its own: the connector never looks for the real Corillo, and isn't asked to start one.
  // Hidden, with a stand-in home: never his (Batch 24, item 6).
  const data = mkdtempSync(join(tmpdir(), "corillo-connector-data-"));
  const home = mkdtempSync(join(tmpdir(), "corillo-connector-home-"));
  const proc = spawn(process.execPath, [connector], { env: throwawayStart({ ...process.env, CORILLO_USER_DATA: data, CORILLO_HOME: home }), stdio: ["pipe", "pipe", "ignore"] });
  running = proc;
  const answer = new Promise<{ result: { serverInfo: { name: string; version: string } } }>((resolve) => onLines(proc.stdout!, (line) => resolve(JSON.parse(line))));
  proc.stdin!.write(JSON.stringify({ jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: "2025-06-18", clientInfo: { name: "a test", version: "1" } } }) + "\n");
  return (await answer).result;
}

describe("the connector's version", () => {
  it("is package.json's", () => {
    expect(SERVER_VERSION).toBe(ours.version);
  });

  it("is what the built connector tells an agent tool", async () => {
    const told = await introduce(await buildConnector());
    expect(told.serverInfo).toMatchObject({ name: "corillo", version: ours.version });
  });

  it("follows package.json when its version changes, with nothing else to change", async () => {
    const told = await introduce(await buildConnector([withVersion("9.8.7")]));
    expect(told.serverInfo.version).toBe("9.8.7");
  });

  it("carries only the version from package.json into the connector, not the rest of it", async () => {
    const code = readFileSync(await buildConnector(), "utf8");
    expect(code).not.toContain('"devDependencies"');
    expect(code).not.toContain(JSON.stringify((ours as unknown as { description: string }).description));
  });
});
