/**
 * Which EIP-712 domain a token's `permit` signs under, so a payer's signature is one the token
 * accepts.
 *
 * The known stablecoins' domains are recorded, since they do not implement ERC-5267. Anything else
 * is asked: `eip712Domain()` (ERC-5267) says which fields its domain carries. A token that does not
 * answer it is accepted only when its `DOMAIN_SEPARATOR()` is the domain of the chain and the token
 * alone, which is a Morpho vault's. Anything else is refused rather than guessed, since a wrong
 * guess only surfaces as a relay that fails.
 */

import { MAINNET_AUSD, MAINNET_USDC, TESTNET_USDC, type PermitDomain } from "@weir/shared";
import { domainSeparator, parseAbi, type Address } from "viem";

import { client } from "./chain";
import { CHAIN_ID } from "./config";

const KNOWN: Record<string, PermitDomain> = Object.fromEntries(
  [MAINNET_USDC, MAINNET_AUSD, TESTNET_USDC].map((asset) => [asset.address.toLowerCase(), asset.permit]),
);

const domainAbi = parseAbi([
  "function eip712Domain() view returns (bytes1 fields, string name, string version, uint256 chainId, address verifyingContract, bytes32 salt, uint256[] extensions)",
  "function DOMAIN_SEPARATOR() view returns (bytes32)",
]);

/** ERC-5267's field bits. */
const NAME = 0x01;
const VERSION = 0x02;
const CHAIN_AND_CONTRACT = 0x04 | 0x08;
const SALT = 0x10;

const cache = new Map<string, Promise<PermitDomain>>();

export function permitDomainFor(token: Address): Promise<PermitDomain> {
  const key = token.toLowerCase();
  const known = KNOWN[key];
  if (known !== undefined) return Promise.resolve(known);
  let domain = cache.get(key);
  if (domain === undefined) {
    domain = readDomain(token);
    domain.catch(() => cache.delete(key));
    cache.set(key, domain);
  }
  return domain;
}

async function readDomain(token: Address): Promise<PermitDomain> {
  const declared = await client
    .readContract({ address: token, abi: domainAbi, functionName: "eip712Domain" })
    .then(([fields, name, version]) => ({ fields: Number(fields), name, version }))
    .catch(() => undefined);

  if (declared !== undefined) {
    if ((declared.fields & SALT) !== 0 || (declared.fields & CHAIN_AND_CONTRACT) !== CHAIN_AND_CONTRACT) {
      throw new Error(`${token} signs permits under a domain Weir does not support`);
    }
    return {
      ...((declared.fields & NAME) !== 0 ? { name: declared.name } : {}),
      ...((declared.fields & VERSION) !== 0 ? { version: declared.version } : {}),
    };
  }

  const separator = await client.readContract({ address: token, abi: domainAbi, functionName: "DOMAIN_SEPARATOR" });
  if (separator === domainSeparator({ domain: { chainId: CHAIN_ID, verifyingContract: token } })) return {};
  throw new Error(`Could not tell how ${token} signs permits`);
}
