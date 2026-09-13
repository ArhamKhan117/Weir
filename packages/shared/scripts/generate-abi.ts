/**
 * Regenerate `src/abi.ts` from the Foundry build output.
 *
 *   forge build
 *   pnpm --filter @weir/shared gen:abi
 *   pnpm --filter @weir/shared gen:abi -- --check   # verify, do not write
 *
 * The generated file is committed. Importing `out/**.json` directly would be fewer moving
 * parts, but `out/` is gitignored, so a clean checkout could not typecheck or build without
 * running `forge build` first, which couples every TypeScript consumer to a Solidity
 * toolchain. The cost of committing instead is drift: the file can fall behind the contracts.
 * `--check` exists so CI fails on that drift rather than at decode time.
 */

import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

/** Repo root, from `packages/shared/scripts/`. */
const repoRoot = new URL("../../../", import.meta.url);

/** Each export and the artifact it comes from. */
const ARTIFACTS = [
  { name: "mandateHubAbi", path: "out/MandateHub.sol/MandateHub.json" },
  { name: "mandateChargerAbi", path: "out/MandateCharger.sol/MandateCharger.json" },
  { name: "savingsRouterAbi", path: "out/SavingsRouter.sol/SavingsRouter.json" },
  // The test stablecoin is ERC-20 plus EIP-2612 `permit` plus a faucet `mint`, a superset of
  // what the hub's clients call on USDC and AUSD.
  { name: "stablecoinAbi", path: "out/TestStablecoin.sol/TestStablecoin.json" },
] as const;

interface FoundryArtifact {
  abi: unknown[];
}

function readAbi(relativePath: string): unknown[] {
  const absolute = fileURLToPath(new URL(relativePath, repoRoot));
  if (!existsSync(absolute)) throw new Error(`${relativePath} is missing. Run \`forge build\` first.`);

  const parsed = JSON.parse(readFileSync(absolute, "utf8")) as FoundryArtifact;
  if (!Array.isArray(parsed.abi)) throw new Error(`${relativePath} has no abi array`);
  return parsed.abi;
}

function typeName(exportName: string): string {
  return exportName.charAt(0).toUpperCase() + exportName.slice(1);
}

function render(): string {
  const header = [
    "/**",
    " * Contract ABIs, generated from the Foundry artifacts:",
    ...ARTIFACTS.map(({ name, path }) => ` *   ${name.padEnd(18)} ${path}`),
    " *",
    " * Generated file, do not edit. Run `pnpm --filter @weir/shared gen:abi` after",
    " * `forge build` to refresh it; scripts/generate-abi.ts says why it is committed.",
    " *",
    " * Exported `as const` so viem infers literal types. Without it `decodeErrorResult` and",
    " * `parseEventLogs` fall back to `unknown`, which is most of the reason to have a typed ABI.",
    " */",
  ].join("\n");

  const body = ARTIFACTS.map(({ name, path }) => {
    const abi = JSON.stringify(readAbi(path), null, 2);
    return `export const ${name} = ${abi} as const;\n\nexport type ${typeName(name)} = typeof ${name};`;
  }).join("\n\n");

  return `${header}\n\n${body}\n`;
}

function main(): void {
  const checkOnly = process.argv.includes("--check");
  const target = fileURLToPath(new URL("../src/abi.ts", import.meta.url));
  const rendered = render();

  if (checkOnly) {
    const current = existsSync(target) ? readFileSync(target, "utf8") : "";
    if (current !== rendered) {
      throw new Error("src/abi.ts is stale. Run `pnpm --filter @weir/shared gen:abi`.");
    }
    console.log("src/abi.ts matches the Foundry artifacts");
    return;
  }

  writeFileSync(target, rendered);
  console.log(`Wrote src/abi.ts (${ARTIFACTS.map(({ name }) => name).join(", ")})`);
}

try {
  main();
} catch (error: unknown) {
  console.error(error instanceof Error ? error.message : error);
  process.exitCode = 1;
}
