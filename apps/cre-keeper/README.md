# @weir/cre-keeper

**A Chainlink CRE workflow, `weir-charger`, that charges due mandates with no server in the loop.**
A cron trigger fires on a Decentralized Oracle Network, the workflow reads `MandateHub` through the CRE EVM client, decides which mandates are due, and writes one DON-signed report to `MandateCharger`, which charges them.
Everything it reads and writes is on chain; it needs no API, no keeper process and no secret.

## How a tick works

1. **Head.** One Multicall3 `aggregate3` call at the last finalized block reads Multicall3's block number and timestamp and the hub's `nextMandateId`.
2. **Pages.** Ids `1 .. nextMandateId - 1` are read in pages of `pageSize`, one `aggregate3` call per page with `getMandate`, `isChargeable` and `quoteCharge` for each id, every page pinned to the head's block number.
   Reads go through `EVMClient.callContract` from the DON-mode runtime, so the capability returns only a result the nodes agree on, and pinning every read to one finalized block is what lets them agree.
3. **Decide** (`src/tick.ts`, the off-chain keeper's rules, against the chain's clock at that block):
   a periodic mandate is due when the hub says it is chargeable;
   a stream is due when it is chargeable and its quote reaches `streamMinCharge`, or has reached what one charge may take (`maxPerCharge`, or what `maxTotal` has left), or its checkpoint is `streamMaxAgeSeconds` old, or it is within two schedule intervals of `expiresAt`.
   The batch is healthy mandates first, then past-due ones, each oldest first, capped at `maxBatch`; the rest lead the next tick.
4. **Write.** If anything is due, `runtime.report` signs `abi.encode(uint256[] ids)` and `EVMClient.writeReport` sends it to `MandateCharger` with a gas limit of 200,000 plus `gasPerMandate` per mandate (150,000 by default, 550,000 in the Mainnet config, where a charge from a Morpho vault measured about 470,000 with its interest accrual), capped at CRE's 10,000,000. `maxBatch` may be at most what that ceiling carries.
   The forwarder calls `onReport`, the charger charges each id (one failure never stops the rest) and emits `ReportCharged(workflowId, forwarder, attempted, charged)`.
   If nothing is due, the tick logs that and writes nothing.

A read that fails, or a report whose transaction or `onReport` did not succeed, fails the execution with the reason; the next trigger starts over.

## Layout

```
project.yaml               RPC per target (staging-settings: Monad Testnet, production-settings: Mainnet)
src/                       SDK-free, tested under Node by the root vitest config
  tick.ts                  due rules, ordering, paging, gas, and the tick over three ports
  hub.ts                   the Multicall3 reads and the report, as bytes (viem)
  config.ts                config validation, exposed as the Standard Schema the SDK's Runner takes
weir-charger/              the CRE workflow folder
  workflow.yaml            workflow name, entry and config per target
  config.json              staging: Monad Testnet, every 30 seconds
  config.production.json   production: Monad Mainnet, every 5 minutes
  main.ts, workflow.ts     Runner, cron trigger, EVMClient ports
  package.json, bun.lock   the SDK the CRE CLI compiles with (bun), plus cre-setup
  tsconfig.json            the CRE compiler's own config (its TypeScript is older than the workspace's)
```

## Simulate

Needs the CRE CLI (v1.30.0 or later for Monad Testnet), Bun, `cre login` once, and `CRE_ETH_PRIVATE_KEY` in the repository's `.env` (64 hex characters without `0x`; the account pays the simulated report's gas, so fund it with Testnet MON before broadcasting).

```bash
pnpm install                                  # from the repository root
pnpm --filter @weir/cre-keeper setup          # bun install in weir-charger/, once
cd apps/cre-keeper
cre workflow simulate weir-charger --target staging-settings --env ../../.env --non-interactive --trigger-index 0 --broadcast
rm -f weir-charger/.cre_build_tmp.js
```

The simulator compiles `weir-charger/main.ts` to WebAssembly, runs the cron trigger once, reads Monad Testnet through `project.yaml`'s RPC, and with `--broadcast` sends the report through the MockKeystoneForwarder `0xB9F79d863261869B234c481D1f9A7af84AeAd192`, which `MandateCharger` on Testnet accepts.
Without `--broadcast` the write is simulated and nothing is sent.
The CLI leaves its 800 KB bundle at `weir-charger/.cre_build_tmp.js`, which the repository's ESLint would then lint; `pnpm --filter @weir/cre-keeper simulate [--broadcast]` runs the same command and removes it.

`--limits` defaults to CRE's production limits, and two of them shape this workflow: an execution may make 15 chain reads (one head and at most 14 pages, 2,800 ids at the default page size; a larger hub is read a rotating slice per tick), and a cron may fire at most every 30 seconds.
A full 200-id page, about 134 KB of calldata, passes the simulator with those limits on.

### A recorded run

Against the current Testnet deployment, on 6 October 2026: a $9.99 monthly subscription (mandate 4) was set up through the app's checkout with no keeper running, and the command above charged it.

```
[USER LOG] weir charger: hub 0x08ca57f960D5D9A2b06475C6Ca4583eDa4680Bc1 at finalized block 68531720 (time 1791242772): 4 mandate(s)
[USER LOG] weir charger: read 4; due 1; waiting: none; finished: 1 cancelled, 2 expired
[USER LOG] weir charger: mandate 4 due (periodic), quote 9990000
[USER LOG] weir charger: writing a report for [4] to 0xB4333c519c9D5c300737824ca5792891DBBa9E03 with a gas limit of 350000
[USER LOG] weir charger: report transaction 0xf7d3e292f358091c430e860fe5b581573b81cad91fe1b77556018f025cdd7989: success, onReport success, fee 35700000000000000 wei
```

[The transaction](https://testnet.monadvision.com/tx/0xf7d3e292f358091c430e860fe5b581573b81cad91fe1b77556018f025cdd7989) (block 68531726) went through the simulation forwarder `0xB9F79d86…d192` and carries the hub's `Charged(4, …, 9990000)` and the charger's `ReportCharged(0x1111…1111, 0xB9F79d86…d192, 1, 1)`; the workflow id is the simulator's placeholder.
An earlier trace measured `onReport` at 166,201 gas for a charge from a savings vault and 108,858 for one from the payer's balance.

## Configuration

`weir-charger/config.json` and `config.production.json`, validated at startup; an unknown key is refused rather than ignored.

| Key | Default | Meaning |
| --- | --- | --- |
| `schedule` | `0 */5 * * * *` | cron, seconds first; must fire at a steady interval of at least 30 seconds, which sets the near-expiry window |
| `chainSelectorName` | | `monad-testnet` or `monad-mainnet` |
| `hub`, `charger` | | `MandateHub` and `MandateCharger`; the zero address is refused |
| `pageSize` | `200` | ids per page read, up to 500 |
| `maxBatch` | `50` | mandates per report, up to 65, which is what the 10M gas ceiling carries |
| `streamMinCharge` | `10000` | base units a stream must accrue before it is charged (number or decimal string) |
| `streamMaxAgeSeconds` | `3600` | a stream is charged at this age whatever it has accrued |

`src/config.test.ts` checks `config.json` against the Testnet entry in `packages/shared/src/deployments.json`.
`config.production.json` names the Mainnet hub and charger from the same record, and the test checks it does; a zero address there would make the production target refuse to start.

## Check

```bash
node_modules/.bin/vitest run apps/cre-keeper        # from the repository root
pnpm --filter @weir/cre-keeper typecheck             # both tsconfigs
node_modules/.bin/eslint apps/cre-keeper
```

`src/hub.test.ts` pins every ABI fragment against the ABIs generated from the Foundry build, so a contract change that moves a selector or an output fails here before it fails on chain.
`main.ts` and `workflow.ts` load the SDK's runtime, which exists only inside the WebAssembly build, so they are type-checked and simulated rather than unit-tested.

## Running it on the DON

Simulation needs only `cre login`.
Deploying needs deploy access for the organization (`cre account access`), a linked workflow owner key (`cre account link-key`), the production config filled in, and then `cre workflow deploy weir-charger --target production-settings`.
The network's `KeystoneForwarder` is `0x76c9cf548b4179F8901cda1f8623568b58215E62` on Monad Mainnet and `0xF8344CFd5c43616a4366C34E3EEE75af79a74482` on Testnet; each network's `MandateCharger` fixes that network's forwarder and simulation forwarder at deployment and accepts reports from no one else.
