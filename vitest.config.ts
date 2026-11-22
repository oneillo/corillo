import { defineConfig } from "vitest/config";

export default defineConfig({
  // One folder for everything the run makes, removed when it ends.
  test: { include: ["tests/unit/**/*.test.ts"], globalSetup: ["./tests/run-folder.ts"] },
});
