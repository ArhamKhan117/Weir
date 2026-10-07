/**
 * The JSON a wallet's `eth_signTypedData_v4` expects. A wallet hashes the domain with whatever
 * `EIP712Domain` type the payload declares, and viem's `serializeTypedData` declares none, so a
 * wallet given it signs an empty domain and the signature recovers to a stranger. This adds the
 * domain's type the way viem's own `signTypedData` does before it asks a wallet.
 */

import { getTypesForEIP712Domain, serializeTypedData, type TypedDataDefinition } from "viem";

export function walletTypedData(typedData: TypedDataDefinition): string {
  const domain = typedData.domain ?? {};
  const types = { EIP712Domain: getTypesForEIP712Domain({ domain }), ...typedData.types };
  // The added type is outside the definition's generic shape, though it is exactly what a wallet reads.
  return serializeTypedData({ ...typedData, domain, types } as unknown as TypedDataDefinition);
}
