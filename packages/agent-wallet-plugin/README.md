# Weir for the MetaMask Agent Wallet

`mm weir` lets an agent holding a MetaMask Agent Wallet subscribe to paid services on Monad and manage them by signing alone.
Weir is direct debit for digital dollars: the payer signs a capped, expiring mandate, and the merchant is paid when each charge is due.
Every Weir action is an EIP-712 signature that the Weir API's relayer submits, so the wallet needs no MON and no gas service at all.

## Commands

| Command | What it does | Signs | Needs `mm login` |
| --- | --- | --- | --- |
| `mm weir plan <link or id>` | A plan's price, cadence, caps, term, asset and merchant, in plain words | nothing | no |
| `mm weir subscribe <link or id>` | Signs a permit and the mandate, and has the relayer install it | 2 signatures | yes |
| `mm weir list` | The wallet's mandates: standing, next charge, paid against the cap, totals | nothing | no |
| `mm weir stop <mandate id>` | Stops a mandate for good | 1 signature | yes |
| `mm weir pause <mandate id>` | Pauses a per-second stream | 1 signature | yes |
| `mm weir resume <mandate id>` | Resumes a paused stream | 1 signature | yes |
| `mm weir savings [--in <dollars> \| --out <dollars>]` | Balance and savings, and moves between them | 1 signature to move | yes |
| `mm weir faucet` | Test dollars on Monad Testnet | nothing | no |

`subscribe`, `stop`, `pause`, `resume` and `savings` take `--dry-run`, which prints the exact typed data the wallet would sign and the request that would carry it, and stops before signing.
`subscribe --from-savings` pays from the savings vault, so the money earns until each charge; `--manager <address>` names another key that may pause, resume and stop the mandate but never spend (the wallet itself by default, `none` for no manager).
Pause and resume apply to per-second streams only; asked of a periodic mandate, the command says so before anything is signed.
`list` takes `--payer <address>` to list another address, and `subscribe --dry-run` takes `--payer` to preview for one.

A checkout link is anything ending in `/c/<plan id>`; a plan id looks like `pln_5xjqdh77j4gflgvy`.

## Output

In a terminal the commands print sentences, with the next step as a hint.
With `--json`, or whenever stdout is not a terminal, they print `{ "ok": true, "data": ... }` with the full report: amounts in base units as decimal strings, times in unix seconds, and every sentence as well.
Failures carry a stable code and a hint, for example `HUB_REFUSED: the hub refused it: MandateExpired (the mandate has expired)`, `NOT_A_STREAM`, `INSUFFICIENT_FUNDS` or `CAPABILITY_MISSING`.

## Configuration

- `--api <url>` or `WEIR_API_URL`: the Weir API, `http://localhost:8790` by default.
  That is the Testnet API; the Mainnet one runs on `http://localhost:8792` (`pnpm api:mainnet`), and pointing the plugin there is all it takes to pay on Mainnet.
- `MONAD_RPC_URL`: the Monad RPC for chain reads (balances, allowances, permit nonces, a mandate's live state); the network's public RPC otherwise.
- `MONAD_CHAIN_ID`: optional guard.
  The chain always comes from the API's answers; an API on another chain than this one is refused rather than signed for.

## Adding it to `mm` from this repository

The CLI needs Node 22.18 or later, and plugins are a beta feature:

```bash
nvm use 22
mm config set experimentalPlugins true
mm config set experimentalAllowUnverifiedInstalls true
pnpm --filter @weir/agent-wallet-plugin mm:link --install
```

The script builds `@weir/shared` and the plugin, then adds the plugin to `mm` in place, so a rebuild is picked up without adding it again.
`mm` shows a consent screen for the capabilities the plugin declares (`wallet-read` for the address, `wallet-submit` for signing); `--yes` accepts it without the prompt.

Two things about the CLI decide how the plugin is added:

- Plugin commands must extend the running CLI's own `PluginCommand`, checked by class identity.
  This package keeps a copy of the CLI for type checking, so the script points `node_modules/@metamask/agent-wallet` at the CLI `mm` runs.
  `pnpm install` restores the copy; run the script again afterwards.
- `mm plugins link` (the script without `--install`) loads the plugin but grants it no capability, because the CLI only indexes grants for installed plugins.
  Linked, `plan`, `faucet --address`, `list --payer` and `subscribe --dry-run --payer` work; everything that touches the wallet answers `CAPABILITY_MISSING`.

Remove it with `mm plugins uninstall @weir/agent-wallet-plugin` (or `mm plugins unlink` when linked).
The CLI prints Node's `punycode` deprecation warning and a note about linked ESM modules on stderr; both are harmless.

## Signing

The plugin never holds a key.
Each signature is a `{ kind: "typed-data", chainId, typedData, intent }` request to the wallet executor the CLI hands a command with `wallet-submit`, so the wallet's policy applies: a server wallet in guard mode may ask for approval on a paired device, and the command waits for it.
The typed data is built exactly as Weir's web checkout builds it (`termsFor`, the EIP-2612 permit on top of the current allowance, the hub's domain from the checkout answer), from `@weir/shared`'s EIP-712 definitions.

## Tests

`pnpm test` from the repository root runs the unit tests: the typed data against the hub's type strings, the request bodies against the API's fields, parsing, output and errors, and the bridge to the host.

`src/live.test.ts` runs the whole loop against a live API on Monad Testnet with a fresh key standing in for the wallet: faucet, subscribe, savings in and out, a stream paused, resumed and stopped, and the subscription stopped, every signature through the same host bridge.
It spends faucet dollars and the relayer's gas, so it runs only when asked:

```bash
WEIR_LIVE_API=http://localhost:8790 pnpm vitest run packages/agent-wallet-plugin/src/live.test.ts
```
