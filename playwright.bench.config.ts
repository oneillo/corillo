import { defineConfig } from "@playwright/test";

// The speed benchmark (npm run bench): one step at a time, so they don't slow each other.
export default defineConfig({
  testDir: "tests/bench",
  globalSetup: ["./tests/run-folder.ts", "./tests/bench/start.ts"],
  timeout: 900_000,
  workers: 1,
  reporter: [["list"]],
});
