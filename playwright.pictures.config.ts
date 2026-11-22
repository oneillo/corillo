import { defineConfig } from "@playwright/test";

// Pictures of Corillo, taken hidden from a fixed sample document:
// npm run help-pictures retakes Help's pictures; npm run screens takes every
// state of the window, light and dark, wide and narrow, for a look over.
export default defineConfig({
  testDir: "tests/pictures",
  globalSetup: "./tests/run-folder.ts", // one folder for everything the run makes, removed when it ends
  timeout: 300_000,
  workers: 1,
  reporter: [["list"]],
});
