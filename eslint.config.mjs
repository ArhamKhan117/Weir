import js from "@eslint/js";
import tseslint from "typescript-eslint";

export default tseslint.config(
  {
    ignores: [
      "**/dist/**",
      "**/node_modules/**",
      // Vendored dependencies and Foundry build artifacts are not ours to lint.
      "lib/**",
      "out/**",
      "cache/**",
      "broadcast/**",
      // Gitignored runtime state (keeper cursors) is not source.
      ".state/**",
      // The CRE CLI's build of the workflow, left beside its entry file.
      "**/.cre_build_tmp.js",
      "**/.workflow-temp-*",
      // Envio codegen output: the types it writes, and the shim that references them.
      "apps/envio-indexer/.envio/**",
      "apps/envio-indexer/envio-env.d.ts",
      // Next.js build output, and the type shim it writes and owns.
      "**/.next/**",
      "**/next-env.d.ts",
    ],
  },
  js.configs.recommended,
  ...tseslint.configs.recommended,
  {
    // The service worker runs in the browser's worker scope, not in a page or in Node.
    files: ["apps/web/public/sw.js"],
    languageOptions: {
      sourceType: "script",
      globals: { self: "readonly", URL: "readonly" },
    },
  },
  {
    // Plain Node scripts: TypeScript files get their globals from @types/node, these do not.
    files: ["**/*.mjs"],
    languageOptions: {
      globals: { process: "readonly", console: "readonly", fetch: "readonly", URL: "readonly" },
    },
  },
  {
    // The landing's media renderer hands functions to Playwright, which runs them in the page.
    files: ["apps/landing/media-src/*.mjs"],
    languageOptions: {
      globals: { document: "readonly", window: "readonly" },
    },
  },
);
