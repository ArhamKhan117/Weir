import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    include: ["test/**/*.test.ts"],
    environment: "node",
    // The test indexer starts the real runtime; the first run of a file compiles the handlers.
    testTimeout: 30_000,
  },
});
