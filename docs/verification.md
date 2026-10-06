# Contract verification

Every Weir contract on Monad is source-verified, so anyone can read the exact code an address runs and rebuild it from this repository.
Monad documents two ways to verify a contract, and Weir uses both, plus the public Sourcify repository as a third, independent record.

| Method | Explorer | How |
| --- | --- | --- |
| Sourcify | [MonadVision](https://monadvision.com) | `forge verify-contract --verifier sourcify --verifier-url https://sourcify-api-monad.blockvision.org/` |
| Etherscan | [Monadscan](https://monadscan.com) | `forge verify-contract --verifier etherscan --etherscan-api-key <key>` |
| Sourcify | [sourcify.dev](https://sourcify.dev) | `forge verify-contract --verifier sourcify` |

An exact match means the compiled creation code and runtime code are byte for byte what is on chain, metadata included.
Constructor arguments are taken from each contract's own creation transaction, never retyped.
Last checked 2026-10-06 by `node --env-file=.env scripts/verify-contracts.mjs`, which submits every contract and writes this file from what the explorers answer.

## Monad Mainnet (143)

| Contract | Address | MonadVision | Monadscan | sourcify.dev |
| --- | --- | --- | --- | --- |
| `MandateHub` | [`0x184c…c6a0`](https://monadvision.com/address/0x184c6c26C1cB7f79885ED7c71e810E564CEec6a0) | Exact match | [Verified](https://monadscan.com/address/0x184c6c26C1cB7f79885ED7c71e810E564CEec6a0#code) | Exact match |
| `MandateCharger` | [`0xC555…Ff03`](https://monadvision.com/address/0xC555DBb7059B46fa4D3de4b6602E3c52cacCFf03) | Exact match | [Verified](https://monadscan.com/address/0xC555DBb7059B46fa4D3de4b6602E3c52cacCFf03#code) | Exact match |
| `SavingsRouter` | [`0x9eE6…0295`](https://monadvision.com/address/0x9eE63583406589Fc6701dF53182Ed4E59A180295) | Exact match | [Verified](https://monadscan.com/address/0x9eE63583406589Fc6701dF53182Ed4E59A180295#code) | Exact match |

## Monad Testnet (10143)

| Contract | Address | MonadVision | Monadscan | sourcify.dev |
| --- | --- | --- | --- | --- |
| `TestStablecoin` | [`0xf306…0Eb9`](https://testnet.monadvision.com/address/0xf3066908dABe11f2e72F6887D9943eeb621a0Eb9) | Exact match | [Verified](https://testnet.monadscan.com/address/0xf3066908dABe11f2e72F6887D9943eeb621a0Eb9#code) | Exact match |
| `TestSavingsVault` | [`0xe0cd…5B8d`](https://testnet.monadvision.com/address/0xe0cd535d298DAd5e228486a79A21176349825B8d) | Exact match | [Verified](https://testnet.monadscan.com/address/0xe0cd535d298DAd5e228486a79A21176349825B8d#code) | Exact match |
| `MandateHub` | [`0x08ca…0Bc1`](https://testnet.monadvision.com/address/0x08ca57f960D5D9A2b06475C6Ca4583eDa4680Bc1) | Exact match | [Verified](https://testnet.monadscan.com/address/0x08ca57f960D5D9A2b06475C6Ca4583eDa4680Bc1#code) | Exact match |
| `MandateCharger` | [`0xB433…9E03`](https://testnet.monadvision.com/address/0xB4333c519c9D5c300737824ca5792891DBBa9E03) | Exact match | [Verified](https://testnet.monadscan.com/address/0xB4333c519c9D5c300737824ca5792891DBBa9E03#code) | Exact match |
| `SavingsRouter` | [`0x41dC…A46E`](https://testnet.monadvision.com/address/0x41dC6AE1e9939ACFd73d64e114Ee48711AB4A46E) | Exact match | [Verified](https://testnet.monadscan.com/address/0x41dC6AE1e9939ACFd73d64e114Ee48711AB4A46E#code) | Exact match |

## Check it yourself

```bash
forge build
node --env-file=.env scripts/verify-contracts.mjs
MONAD_CHAIN_ID=143 forge script script/VerifyDeployment.s.sol:VerifyDeployment --rpc-url https://rpc.monad.xyz
MONAD_CHAIN_ID=10143 forge script script/VerifyDeployment.s.sol:VerifyDeployment --rpc-url https://testnet-rpc.monad.xyz
```

`VerifyDeployment` reads every recorded address on chain and checks the wiring: the hub's assets and domain, the charger's hub and Chainlink forwarders, and the router's routes.
