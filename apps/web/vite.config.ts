import { fileURLToPath } from "node:url";

import react from "@vitejs/plugin-react";
import { defineConfig, type Plugin } from "vite";
import { nodePolyfills } from "vite-plugin-node-polyfills";

/**
 * In development the API runs beside the dev server; proxying `/v1` and `/health` makes it
 * same-origin, so the browser needs no CORS answer from it. A deployed build points at the API with
 * `VITE_API_URL` instead.
 *
 * Each network has its own API: Testnet's on 8790 (`pnpm api`) and Mainnet's on 8792
 * (`pnpm api:mainnet`). `/testnet/...` and `/mainnet/...` reach them by name, which is how the app
 * talks to whichever network the visitor chose. Bare `/v1` and `/health` reach `WEIR_API_TARGET`.
 */
const API_TARGET = process.env.WEIR_API_TARGET ?? "http://127.0.0.1:8790";
const API_TARGETS = {
  testnet: process.env.WEIR_API_TARGET_TESTNET ?? "http://127.0.0.1:8790",
  mainnet: process.env.WEIR_API_TARGET_MAINNET ?? "http://127.0.0.1:8792",
};
const byNetwork = Object.fromEntries(
  Object.entries(API_TARGETS).map(([slug, target]) => [
    `/${slug}/`,
    { target, changeOrigin: true, rewrite: (path: string) => path.slice(slug.length + 1) },
  ]),
);

/**
 * The polyfills plugin injects imports of its shims into every module that reads `Buffer`,
 * `process` or `global`, including the workspace's own packages, which do not depend on the plugin
 * and so cannot resolve it themselves. Resolving the shims here gives every importer the same file.
 */
const shim = (name: string) => fileURLToPath(import.meta.resolve(`vite-plugin-node-polyfills/shims/${name}`));
const SHIM_ALIASES = Object.fromEntries(
  ["buffer", "global", "process"].map((name) => [`vite-plugin-node-polyfills/shims/${name}`, shim(name)]),
);

/**
 * The polyfills plugin's inject step also runs in development, on every module that mentions
 * `Buffer`, `global` or `process`, and that includes Vite's pre-bundled dependencies, which already
 * had the globals injected when they were bundled. One of those is the Intents widget, a single
 * 50 MB file: re-parsing it to inject again exhausts the dev server's heap and kills it the moment
 * Add money opens. Skipping the pre-bundled files changes nothing else.
 */
function skipPrebundled(plugins: Plugin[]): Plugin[] {
  return plugins.map((plugin) => {
    const transform = plugin.transform;
    if (plugin.name !== "vite-plugin-node-polyfills:inject" || typeof transform !== "function") return plugin;
    return {
      ...plugin,
      transform(code, id, options) {
        if (id.includes("/node_modules/.vite/")) return undefined;
        return transform.call(this, code, id, options);
      },
    };
  });
}

export default defineConfig({
  plugins: [
    react(),
    // The Intents widget's NEAR and TON dependencies were written for Node: they import `crypto`
    // and read `Buffer`, `process` and `global` as they load. This gives each module that does a
    // browser version of what it asks for, and leaves every other module alone. All of them sit
    // behind the Add money dialog's lazy import.
    ...skipPrebundled(
      nodePolyfills({ include: ["buffer", "crypto", "process"], globals: { Buffer: true, global: true, process: true } }) as Plugin[],
    ),
  ],
  resolve: { alias: SHIM_ALIASES },
  server: {
    port: 5173,
    proxy: {
      "/v1": { target: API_TARGET, changeOrigin: true },
      "/health": { target: API_TARGET, changeOrigin: true },
      ...byNetwork,
    },
  },
  build: {
    outDir: "dist",
    sourcemap: true,
  },
});
