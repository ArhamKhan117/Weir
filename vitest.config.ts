import { fileURLToPath } from "node:url";
import { defineConfig } from "vitest/config";

const fromRoot = (relative: string) => fileURLToPath(new URL(relative, import.meta.url));

// Tests resolve workspace packages to their sources so the suite runs without a
// prior build. Published resolution goes through each package's `exports` map.
export default defineConfig({
  resolve: {
    alias: {
      // The subpath must precede the bare specifier: alias matching is prefix-based, so
      // the bare entry would otherwise rewrite `@weir/shared/fs` to `…/index.ts/fs`.
      "@weir/shared/fs": fromRoot("./packages/shared/src/fs.ts"),
      "@weir/shared": fromRoot("./packages/shared/src/index.ts"),
    },
  },
  test: {
    include: ["{packages,apps}/*/src/**/*.test.{ts,tsx}"],
    environment: "node",
  },
});
