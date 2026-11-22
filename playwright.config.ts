import { defineConfig } from "@playwright/test";

export default defineConfig({
  testDir: "tests/e2e",
  // One folder for everything the run makes, removed when it ends.
  globalSetup: "./tests/run-folder.ts",
  timeout: 30_000,
  workers: 2,
  reporter: [["list"]],
});
