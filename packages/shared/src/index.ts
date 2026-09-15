/**
 * Public surface of the shared package: the type model, Monad networks and assets, the EIP-712
 * typed data the hub verifies, dollar arithmetic, the fail-fast environment loader, and the
 * contract ABIs generated from the Foundry build.
 *
 * `./fs.js` is deliberately absent from this barrel. It imports `node:fs`, and the web app
 * imports this barrel into a browser bundle; node-only helpers are reached through the
 * `@weir/shared/fs` subpath instead.
 */

export * from "./types.js";
export * from "./chains.js";
export * from "./eip712.js";
export * from "./money.js";
export * from "./config.js";
export * from "./abi.js";
export * from "./deployments.js";
export * from "./api.js";
export * from "./wallets.js";
export * from "./currencies.js";
