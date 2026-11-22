// Tests of the packaged app (release/Corillo.app). Run with `npm run test:package`.
import { defineConfig } from "@playwright/test";

export default defineConfig({
  testDir: "tests/package",
  globalSetup: "./tests/run-folder.ts", // one folder for everything the run makes, removed when it ends
  timeout: 60_000,
  workers: 1,
  reporter: [["list"]],
});
