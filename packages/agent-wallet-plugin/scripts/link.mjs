#!/usr/bin/env node
/**
 * Adds this plugin to the MetaMask Agent Wallet CLI (`mm`) from the working tree.
 *
 *   pnpm --filter @weir/agent-wallet-plugin mm:link            # read-only commands and dry runs
 *   pnpm --filter @weir/agent-wallet-plugin mm:link --install  # every command, wallet included
 *   add --yes to accept the plugin's declared capabilities without the prompt
 *
 * Two facts about the CLI shape this script.
 *
 * The plugin's commands must extend the running CLI's own `PluginCommand`, and the CLI checks that
 * by class identity. The workspace install gives this package its own copy of the CLI for type
 * checking, so before `mm` loads the plugin, `node_modules/@metamask/agent-wallet` here is pointed
 * at the CLI that `mm` runs. `pnpm install` puts the copy back; run this again after it.
 *
 * `mm plugins link` loads the plugin in place but grants it no capability: the CLI only indexes
 * grants for installed plugins, so a linked plugin cannot read the wallet's address or ask it to
 * sign. `--install` adds it with `mm plugins install file:<dir>` instead, which shows the consent
 * screen for what the plugin declares and grants it on approval. Both leave the plugin running from
 * this directory, so a rebuild is picked up without adding it again.
 */

import { spawnSync } from "node:child_process";
import { accessSync, constants, existsSync, lstatSync, readFileSync, realpathSync, rmSync, symlinkSync } from "node:fs";
import { delimiter, dirname, join, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const args = new Set(process.argv.slice(2));
const mode = args.has("--install") ? "install" : "link";

function fail(message) {
  console.error(`mm:link: ${message}`);
  process.exit(1);
}

/**
 * `mm` on PATH, skipping `node_modules/.bin`: under `pnpm run` that comes first and holds this
 * workspace's own copy of the CLI, which is exactly the copy the plugin must not load.
 */
function findMm() {
  for (const dir of (process.env.PATH ?? "").split(delimiter)) {
    if (dir === "" || dir.includes(`${sep}node_modules${sep}.bin`)) continue;
    const candidate = join(dir, "mm");
    try {
      accessSync(candidate, constants.X_OK);
      return candidate;
    } catch {
      // Not here; keep looking.
    }
  }
  return undefined;
}

// 1. The CLI that `mm` runs.
const bin = process.env.MM_BIN ?? findMm();
if (bin === undefined) fail("`mm` is not on PATH. Install it with `npm i -g @metamask/agent-wallet` under Node 22.18 or later.");
const hostRoot = resolve(dirname(realpathSync(bin)), "..");
const hostPackage = JSON.parse(readFileSync(join(hostRoot, "package.json"), "utf8"));
if (hostPackage.name !== "@metamask/agent-wallet") fail(`${bin} is not the MetaMask Agent Wallet CLI`);
console.log(`mm:link: ${hostPackage.name}@${hostPackage.version} at ${hostRoot}`);

// 2. One CLI, not two: this package resolves @metamask/agent-wallet to the one `mm` runs. First,
// because `mm` loads an already linked plugin on every run, and with the copy in place it boots a
// second CLI inside the first.
const peer = join(root, "node_modules", "@metamask", "agent-wallet");
const current = existsSync(peer) ? realpathSync(peer) : undefined;
if (current !== realpathSync(hostRoot)) {
  if (existsSync(peer) || lstatSync(peer, { throwIfNoEntry: false })) rmSync(peer, { recursive: true, force: true });
  symlinkSync(hostRoot, peer, "dir");
  console.log(`mm:link: node_modules/@metamask/agent-wallet now points at ${hostRoot}`);
}

// 3. The Node it runs on, from its own version line.
const version = spawnSync(bin, ["--version"], { encoding: "utf8" }).stdout ?? "";
const node = /node-v(\d+)\.(\d+)/.exec(version);
if (node === null || Number(node[1]) < 22 || (Number(node[1]) === 22 && Number(node[2]) < 18)) {
  fail(`mm runs on Node ${node === null ? "unknown" : `${node[1]}.${node[2]}`}; it needs 22.18 or later. Switch with \`nvm use 22\`.`);
}

// 4. The plugin and the shared package it loads at run time, built.
for (const filter of ["@weir/shared", "@weir/agent-wallet-plugin"]) {
  const built = spawnSync("pnpm", ["--filter", filter, "build"], { cwd: root, stdio: "inherit" });
  if (built.status !== 0) fail(`building ${filter} failed`);
}

// 5. Add it to mm. The CLI shows its consent screen unless --yes accepts it here.
const accept = args.has("--yes") ? ["--accept-permissions"] : [];
const spec = mode === "install" ? `file:${root}` : root;
const added = spawnSync(bin, ["plugins", mode, spec, ...accept], { stdio: "inherit" });
if (added.status !== 0) fail(`mm plugins ${mode} failed`);
console.log(
  mode === "install"
    ? "mm:link: installed. Try `mm weir plan <link>`, `mm weir list`, `mm weir subscribe <link> --dry-run`."
    : "mm:link: linked, with no wallet access. Try `mm weir plan <link>` or `mm weir list --payer <address>`; add --install for the rest.",
);
