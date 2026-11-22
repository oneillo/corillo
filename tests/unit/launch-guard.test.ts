// Every Corillo a test starts is hidden, on a throwaway data folder, with a
// stand-in home (Batch 21, reader C: C21-1 and C21-T1; roadmap Batch 22,
// item 4). `launch()` in tests/e2e/helpers.ts starts every end-to-end test's
// Corillo, and `AgentSession.start` (tests/e2e/agent-session.ts) every
// pretend agent's connector, which starts a Corillo of its own when none is
// running. Each refuses a start that could reach the person's real data
// folder or home, and makes hidden and the stand-in home itself, so a test
// that forgets them can't show Corillo on his screen, touch his comments and
// history, or write his agent tools' settings.
//
// Nothing is started here: Playwright's launcher and Node's spawn are replaced
// by stand-ins that only record what they were asked to start.
import { afterEach, describe, expect, it, vi } from "vitest";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, symlinkSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import { PassThrough } from "node:stream";
import { EventEmitter } from "node:events";

type Env = Record<string, string | undefined>;
const asked = vi.hoisted(() => ({ launches: [] as { args?: string[]; env?: Env; executablePath?: string }[], spawns: [] as { args: string[]; env?: Env }[] }));

vi.mock("@playwright/test", () => {
  const app = {
    on: () => undefined,
    windows: () => [],
    process: () => ({ once: () => undefined }),
    close: async () => undefined,
  };
  return {
    _electron: {
      launch: async (options: { args?: string[]; env?: Env; executablePath?: string }) => {
        asked.launches.push(options);
        return app;
      },
    },
    expect: Object.assign(() => ({}), { soft: () => ({ toEqual: () => undefined }), poll: () => ({ toBe: async () => undefined }) }),
    test: { info: () => ({ testId: "guard" }) },
  };
});

// A stand-in connector: it answers `initialize` and nothing else.
vi.mock("node:child_process", async (original) => ({
  ...(await original<typeof import("node:child_process")>()),
  spawn: (_program: string, args: string[], options: { env?: Env }) => {
    asked.spawns.push({ args, env: options.env });
    const proc = Object.assign(new EventEmitter(), { stdout: new PassThrough(), stderr: new PassThrough(), stdin: new PassThrough() });
    proc.stdin.on("data", (chunk: Buffer) => {
      const message = JSON.parse(chunk.toString()) as { id?: number };
      if (message.id !== undefined) proc.stdout.write(JSON.stringify({ id: message.id, result: {} }) + "\n");
    });
    proc.stdin.on("finish", () => proc.emit("exit", 0));
    return proc;
  },
}));

import { launch, ONE_SCALE } from "../e2e/helpers";
import { AgentSession } from "../e2e/agent-session";

/** A new throwaway folder in this run's temporary folder. */
const throwaway = (prefix: string) => mkdtempSync(join(tmpdir(), prefix));
/** His real data folder and home, as a test that went wrong might name them. Never created or read here. */
const REAL_DATA = join(homedir(), "Library", "Application Support", "Corillo");

afterEach(() => {
  asked.launches.length = 0;
  asked.spawns.length = 0;
});

/** Start through launch(): what it was asked to start, or why it refused. */
async function started(options: Parameters<typeof launch>[0]): Promise<{ env?: Env; refused?: string }> {
  try {
    await launch(options);
  } catch (err) {
    return { refused: (err as Error).message };
  }
  expect(asked.launches).toHaveLength(1);
  return { env: asked.launches[0].env };
}

/** The stand-in home a start was given: a new, empty folder in the run's temporary folder, as both homes. */
function expectStandInHome(env: Env | undefined): string {
  const home = env?.CORILLO_HOME ?? "";
  expect(home.startsWith(tmpdir()), `the stand-in home ${home} is in the run's temporary folder`).toBe(true);
  expect(existsSync(home) && readdirSync(home)).toEqual([]);
  expect(env?.HOME).toBe(home);
  expect(home).not.toBe(homedir());
  return home;
}

describe("C21-1: launch(), where every end-to-end test starts Corillo", () => {
  it("refuses a start with no data folder, even when the test gives no settings at all", async () => {
    // What a new test might write: the scale is there (tests/unit/launch-scale.test.ts checks that), the settings aren't.
    for (const options of [{ args: [ONE_SCALE, "."] }, { args: [ONE_SCALE, "."], env: { ...process.env, CORILLO_HIDDEN: "1" } }]) {
      const { refused } = await started(options);
      expect(refused).toMatch(/throwaway data folder/);
    }
    expect(asked.launches).toEqual([]);
  });

  it("refuses a data folder outside the temporary folder: his own, a relative one, one reached through a link, the temporary folder itself", async () => {
    const linkTo = join(throwaway("corillo-links-"), "data");
    symlinkSync(homedir(), linkTo);
    for (const data of [REAL_DATA, "data", join(linkTo, "made-up-data"), linkTo, "/private/tmp", ""]) {
      const { refused } = await started({ args: [ONE_SCALE, "."], env: { ...process.env, CORILLO_USER_DATA: data, CORILLO_HIDDEN: "1" } });
      expect(refused, data).toMatch(/throwaway data folder/);
    }
    expect(asked.launches).toEqual([]);
  });

  it("starts hidden whatever the test's settings say", async () => {
    for (const hidden of [undefined, "0", ""]) {
      asked.launches.length = 0;
      const { env } = await started({ args: [ONE_SCALE, "."], env: { ...process.env, CORILLO_USER_DATA: throwaway("corillo-data-"), CORILLO_HIDDEN: hidden } as Record<string, string> });
      expect(env?.CORILLO_HIDDEN, String(hidden)).toBe("1");
    }
  });

  it("gives Corillo a stand-in home when the test gives none, as the agent tools' home and as HOME", async () => {
    const data = throwaway("corillo-data-");
    const { env } = await started({ args: [ONE_SCALE, "."], env: { ...process.env, CORILLO_USER_DATA: data, CORILLO_HIDDEN: "1" } });
    expectStandInHome(env);
    expect(env?.CORILLO_USER_DATA).toBe(data);
  });

  it("keeps a stand-in home the test made, for HOME too, and refuses his real home", async () => {
    const home = throwaway("corillo-home-");
    const { env } = await started({ args: [ONE_SCALE, "."], env: { ...process.env, CORILLO_USER_DATA: throwaway("corillo-data-"), CORILLO_HOME: home } });
    expect([env?.CORILLO_HOME, env?.HOME]).toEqual([home, home]);
    for (const real of [homedir(), join(homedir(), "Documents")]) {
      asked.launches.length = 0;
      const { refused } = await started({ args: [ONE_SCALE, "."], env: { ...process.env, CORILLO_USER_DATA: throwaway("corillo-data-"), CORILLO_HOME: real } });
      expect(refused, real).toMatch(/stand-in home/);
      expect(asked.launches).toEqual([]);
    }
  });

  it("starts only this checkout's Corillo, never another program such as the installed app", async () => {
    const { refused } = await started({
      executablePath: "/Applications/Corillo.app/Contents/MacOS/Corillo",
      args: [ONE_SCALE, "."],
      env: { ...process.env, CORILLO_USER_DATA: throwaway("corillo-data-"), CORILLO_HIDDEN: "1" },
    });
    expect(refused).toMatch(/this checkout/);
    expect(asked.launches).toEqual([]);
  });
});

describe("C21-T1: AgentSession.start, a pretend agent's connector, which starts a Corillo of its own when none runs", () => {
  it("refuses a data folder outside the temporary folder", async () => {
    for (const data of [REAL_DATA, "", "data"]) {
      await expect(AgentSession.start(data), data).rejects.toThrow(/throwaway data folder/);
    }
    expect(asked.spawns).toEqual([]);
  });

  it("starts hidden, with a stand-in home, whatever the agent tool's settings say", async () => {
    const data = throwaway("corillo-data-");
    const { session } = await AgentSession.start(data, "claude-code", { env: { CORILLO_HIDDEN: "0", HOME: homedir() } });
    await session.stop();
    const env = asked.spawns[0]?.env;
    expect(env?.CORILLO_HIDDEN).toBe("1");
    expect(env?.CORILLO_USER_DATA).toBe(data);
    expectStandInHome(env);
  });

  it("keeps a stand-in home the test gives, and refuses his real one", async () => {
    const home = throwaway("corillo-home-");
    mkdirSync(join(home, ".claude"));
    const { session } = await AgentSession.start(throwaway("corillo-data-"), "claude-code", { env: { CORILLO_HOME: home } });
    await session.stop();
    expect([asked.spawns[0]?.env?.CORILLO_HOME, asked.spawns[0]?.env?.HOME]).toEqual([home, home]);
    await expect(AgentSession.start(throwaway("corillo-data-"), "claude-code", { env: { CORILLO_HOME: homedir() } })).rejects.toThrow(/stand-in home/);
    expect(asked.spawns).toHaveLength(1);
  });
});
