// Runs that leave nothing behind: when the test is over, the app is closed
// and the folders it used are removed (the document's, the data folder, the
// stand-in home folder), so test runs don't fill the disk.
import { test } from "@playwright/test";
import { rmSync } from "node:fs";
import type { Running } from "./helpers";

/** Call once at the top of a spec file; `keep` each run its tests start. */
export function tidyRuns(): { keep(run: Running): Running } {
  const runs: Running[] = [];
  test.afterEach(async () => {
    for (const run of runs.splice(0)) {
      const home = await run.app.evaluate(() => process.env.CORILLO_HOME).catch(() => undefined);
      // Quit outright: a test may end with words in a comment box, and closing would ask about them.
      await run.app.evaluate(({ app }) => setTimeout(() => app.exit(0), 10)).catch(() => undefined);
      await run.app.close().catch(() => undefined);
      for (const dir of [run.folder, run.dataDir, home]) if (dir) rmSync(dir, { recursive: true, force: true });
    }
  });
  return {
    keep(run) {
      runs.push(run);
      return run;
    },
  };
}
