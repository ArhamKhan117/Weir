import { MULTICALL3_ADDRESS, VAULT_ACCRUAL_GAS, mandateHubAbi, stablecoinAbi } from "@weir/shared";
import {
  decodeFunctionData,
  encodeAbiParameters,
  encodeErrorResult,
  encodeEventTopics,
  encodeFunctionResult,
  getAbiItem,
  getAddress,
  isAddressEqual,
  zeroAddress,
  type Address,
  type Hex,
  type Log,
} from "viem";
import { describe, expect, it } from "vitest";

import { silentLogger } from "../log.js";
import type { ApiDeployment } from "../network.js";
import { GAS_CEILING, GAS_FLOOR, gasLimitFor } from "./gas.js";
import { aggregate3Abi, type RelayCall } from "./policy.js";
import { RejectedOnChainError, Relayer, type RelayChain, type RelayReceipt } from "./relayer.js";
import type { InstallInput } from "./requests.js";
import { decodeRevert, findRevertData } from "./revert.js";
import { RelayService, TOKEN_SETTLEMENT_GAS, type StreamState } from "./service.js";

const hub = getAddress("0x00000000000000000000000000000000000000a1");
const asset = getAddress("0x00000000000000000000000000000000000000b1");
const vault = getAddress("0x00000000000000000000000000000000000000b2");
const payer = getAddress("0x00000000000000000000000000000000000000d1");
const merchant = getAddress("0x00000000000000000000000000000000000000e1");
const relayerAddress = getAddress("0x00000000000000000000000000000000000000f1");

const deployment: ApiDeployment = { startBlock: 0, hub, domainName: "Weir", assets: { tAUSD: asset }, savings: { tAUSD: vault } };

function revertWith(errorName: "NonceAlreadyUsed" | "InvalidSignature" | "ERC2612InvalidSigner"): Error {
  const data =
    errorName === "NonceAlreadyUsed"
      ? encodeErrorResult({ abi: mandateHubAbi, errorName, args: [payer, 5n] })
      : errorName === "InvalidSignature"
        ? encodeErrorResult({ abi: mandateHubAbi, errorName })
        : encodeErrorResult({ abi: stablecoinAbi, errorName, args: [merchant, payer] });
  // The shape viem produces: the revert data rides on a cause.
  return Object.assign(new Error("Execution reverted"), { cause: Object.assign(new Error("execution reverted"), { data }) });
}

function createdLog(mandateId: bigint): Log {
  const event = getAbiItem({ abi: mandateHubAbi, name: "MandateCreated" });
  const topics = encodeEventTopics({ abi: mandateHubAbi, eventName: "MandateCreated", args: { mandateId, payer, merchant } });
  const data = encodeAbiParameters(
    event.inputs.filter((input) => !input.indexed),
    [asset, zeroAddress, zeroAddress, 5n, 60, 1n, 5n, 50n, 2n ** 40n, `0x${"00".repeat(32)}`],
  );
  return { address: hub, topics, data, blockNumber: 1n, blockHash: `0x${"01".repeat(32)}`, logIndex: 0, transactionHash: `0x${"02".repeat(32)}`, transactionIndex: 0, removed: false } as Log;
}

class FakeChain implements RelayChain {
  readonly relayer = relayerAddress;
  readonly simulated: RelayCall[] = [];
  readonly sent: (RelayCall & { gas: bigint; nonce: number })[] = [];
  readonly allowances = new Map<string, bigint>();
  estimate = 100_000n;
  nonce = 7;
  nonceReads = 0;
  revert: ((call: RelayCall) => Error | undefined) | undefined;
  onSend: ((call: RelayCall) => void) | undefined;
  failSend = false;
  receiptDelayMs = 5;

  /** A bundle answers per part, the way Multicall3's `aggregate3` does with every part allowed to fail. */
  async call(call: RelayCall): Promise<Hex> {
    this.simulated.push(call);
    if (isAddressEqual(call.to, MULTICALL3_ADDRESS)) {
      const [parts] = decodeFunctionData({ abi: aggregate3Abi, data: call.data }).args;
      const results = parts.map((part) => {
        const error = this.revert?.({ to: part.target, data: part.callData });
        return { success: error === undefined, returnData: error === undefined ? ("0x" as Hex) : (findRevertData(error) ?? "0x") };
      });
      return encodeFunctionResult({ abi: aggregate3Abi, functionName: "aggregate3", result: results });
    }
    const error = this.revert?.(call);
    if (error !== undefined) throw error;
    return "0x";
  }
  async estimateGas(call: RelayCall): Promise<bigint> {
    this.simulated.push(call);
    const error = this.revert?.(call);
    if (error !== undefined) throw error;
    return this.estimate;
  }
  async allowance(token: Address, owner: Address, spender: Address): Promise<bigint> {
    return this.allowances.get(`${token}:${owner}:${spender}`) ?? 0n;
  }
  async pendingNonce(): Promise<number> {
    this.nonceReads += 1;
    return this.nonce;
  }
  async send(call: RelayCall & { gas: bigint; nonce: number }): Promise<Hex> {
    if (this.failSend) throw new Error("nonce too low");
    this.sent.push(call);
    this.onSend?.(call);
    return `0x${this.sent.length.toString(16).padStart(64, "0")}`;
  }
  async waitForReceipt(hash: Hex): Promise<RelayReceipt> {
    await new Promise((resolve) => setTimeout(resolve, this.receiptDelayMs));
    const index = Number.parseInt(hash.slice(2), 16) - 1;
    const call = this.sent[index];
    const inner = (target: Address, data: Hex) =>
      isAddressEqual(target, hub) && decodeFunctionData({ abi: mandateHubAbi, data }).functionName === "createMandateWithSig";
    const creates =
      call !== undefined &&
      (isAddressEqual(call.to, MULTICALL3_ADDRESS)
        ? decodeFunctionData({ abi: aggregate3Abi, data: call.data }).args[0].some((part) => inner(part.target, part.callData))
        : inner(call.to, call.data));
    return { status: "success", logs: creates ? [createdLog(42n)] : [], gasUsed: call?.gas ?? 0n };
  }
}

function setup(options: { bundles?: boolean } = {}) {
  const chain = new FakeChain();
  const relayer = new Relayer(
    chain,
    {
      hub,
      ...(options.bundles === true ? { multicall: MULTICALL3_ADDRESS } : {}),
      permitTokens: [asset, vault],
      faucet: { token: asset, maxAmount: 10n },
    },
    silentLogger,
  );
  const service = new RelayService(relayer, chain, deployment, silentLogger);
  return { chain, relayer, service };
}

const NOW = Math.floor(Date.now() / 1000);
const install = (permitToken?: Address, termsVault: Address = zeroAddress): InstallInput => ({
  ...(permitToken === undefined
    ? {}
    : { permit: { token: permitToken, owner: payer, value: 60n, deadline: NOW + 600, signature: `0x${"11".repeat(32)}${"22".repeat(32)}1b` } }),
  payer,
  terms: {
    merchant,
    asset,
    vault: termsVault,
    manager: zeroAddress,
    amount: 5n,
    period: 60,
    startAt: 0n,
    maxPerCharge: 5n,
    maxTotal: 60n,
    expiresAt: BigInt(NOW + 86_400),
    ref: `0x${"00".repeat(32)}`,
  },
  nonce: 1n,
  deadline: NOW + 600,
  signature: `0x${"33".repeat(65)}`,
});

/** `input` with a backup permit on its asset, signed by `owner` (the payer unless given). */
const withBackup = (input: InstallInput, token: Address = asset, owner: Address = payer): InstallInput => ({
  ...input,
  backupPermit: { token, owner, value: 60n, deadline: NOW + 600, signature: `0x${"44".repeat(32)}${"55".repeat(32)}1c` },
});

describe("the gas margin", () => {
  it("states the estimate plus 5% and 5,000, rounded up", () => {
    expect(gasLimitFor(100_000n)).toBe(110_000n);
    expect(gasLimitFor(200_001n)).toBe(215_002n);
  });

  it("never states less than a transaction's floor or more than Monad's per-transaction cap", () => {
    expect(gasLimitFor(0n)).toBe(GAS_FLOOR);
    expect(gasLimitFor(29_000_000n)).toBe(GAS_CEILING);
  });

  it("is what the relayer sends", async () => {
    const { chain, service } = setup();
    chain.estimate = 180_000n;
    await service.install(install());
    expect(chain.sent.map((tx) => tx.gas)).toEqual([194_000n]);
  });
});

describe("revert decoding", () => {
  it("names the hub's and the token's custom errors", () => {
    expect(decodeRevert(revertWith("NonceAlreadyUsed"))?.name).toBe("NonceAlreadyUsed");
    expect(decodeRevert(revertWith("NonceAlreadyUsed"))?.detail).toMatch(/^NonceAlreadyUsed\(0x0+d1, 5\): /i);
    expect(decodeRevert(revertWith("ERC2612InvalidSigner"))?.name).toBe("ERC2612InvalidSigner");
  });

  it("tells a revert from a node that did not answer", () => {
    expect(decodeRevert(new Error("fetch failed"))).toBeUndefined();
    expect(decodeRevert(new Error("execution reverted"))?.name).toBe("unknown");
  });
});

describe("the relayer", () => {
  it("answers a simulated revert with its name and sends nothing", async () => {
    const { chain, service } = setup();
    chain.revert = () => revertWith("InvalidSignature");
    const error = await service.install(install(asset)).catch((caught: unknown) => caught);
    expect(error).toBeInstanceOf(RejectedOnChainError);
    expect((error as RejectedOnChainError).revert.name).toBe("InvalidSignature");
    expect(chain.sent).toHaveLength(0);
  });

  it("admits an install only after its signature simulates, and sends nothing when refused", async () => {
    const { chain, service } = setup();
    const admitted: string[] = [];
    chain.revert = () => revertWith("InvalidSignature");
    await expect(service.install(install(asset), () => admitted.push("bad"))).rejects.toThrow(/InvalidSignature/);
    chain.revert = undefined;
    await expect(
      service.install(install(asset), () => {
        throw new Error("rate limited");
      }),
    ).rejects.toThrow(/rate limited/);
    expect(admitted).toEqual([]);
    expect(chain.sent).toHaveLength(0);
  });

  it("simulates the mandate before spending gas on the permit", async () => {
    const { chain, service } = setup();
    chain.revert = (call) =>
      isAddressEqual(call.to, hub) ? revertWith("NonceAlreadyUsed") : undefined;
    await expect(service.install(install(asset))).rejects.toThrow(/NonceAlreadyUsed/);
    expect(chain.sent).toHaveLength(0);
  });

  it("serializes sends so concurrent requests never share a nonce", async () => {
    const { chain, service } = setup();
    let inFlight = 0;
    let maxInFlight = 0;
    chain.onSend = () => {
      inFlight += 1;
      maxInFlight = Math.max(maxInFlight, inFlight);
      setTimeout(() => (inFlight -= 1), chain.receiptDelayMs);
    };
    const results = await Promise.all([1n, 2n, 3n, 4n].map((nonce) => service.install({ ...install(), nonce })));
    expect(results.map((result) => result.mandateId)).toEqual(["42", "42", "42", "42"]);
    expect(chain.sent.map((tx) => tx.nonce)).toEqual([7, 8, 9, 10]);
    expect(chain.nonceReads).toBe(1);
    expect(maxInFlight).toBe(1);
  });

  it("re-reads the nonce from the chain after a failed send", async () => {
    const { chain, service } = setup();
    await service.install(install());
    chain.failSend = true;
    await expect(service.install(install())).rejects.toThrow(/nonce too low/);
    chain.failSend = false;
    chain.nonce = 20;
    await service.install(install());
    expect(chain.sent.map((tx) => tx.nonce)).toEqual([7, 20]);
    expect(chain.nonceReads).toBe(2);
  });
});

describe("permits in an install", () => {
  it("submits the permit first, to the token, with the hub as spender, and returns the mandate id", async () => {
    const { chain, service } = setup();
    const result = await service.install(install(asset));
    expect(result.mandateId).toBe("42");
    expect(result.transactions.permit).toBeDefined();
    expect(chain.sent.map((tx) => tx.to)).toEqual([asset, hub]);
    const permit = decodeFunctionData({ abi: stablecoinAbi, data: chain.sent[0]?.data ?? "0x" });
    expect(permit.functionName).toBe("permit");
    expect(permit.args?.[1]).toBe(hub);
    expect(permit.args?.[4]).toBe(27);
  });

  it("skips a permit whose allowance is already sufficient", async () => {
    const { chain, service } = setup();
    chain.allowances.set(`${asset}:${payer}:${hub}`, 60n);
    const result = await service.install(install(asset));
    expect(result.transactions.permit).toBeUndefined();
    expect(chain.sent.map((tx) => tx.to)).toEqual([hub]);
  });

  it("carries on when the permit was front-run between the read and the send", async () => {
    const { chain, service } = setup();
    chain.revert = (call) => {
      if (!isAddressEqual(call.to, asset)) return undefined;
      // Someone else's copy of the permit landed first: the allowance is there now.
      chain.allowances.set(`${asset}:${payer}:${hub}`, 60n);
      return revertWith("ERC2612InvalidSigner");
    };
    const result = await service.install(install(asset));
    expect(result.transactions.permit).toBeUndefined();
    expect(result.mandateId).toBe("42");
  });

  it("refuses a permit that is not the payer's, not on the token the mandate draws, or off the list", async () => {
    const { service } = setup();
    const notPayers = install(asset);
    if (notPayers.permit !== undefined) notPayers.permit.owner = merchant;
    await expect(service.install(notPayers)).rejects.toThrow(/permit.owner must be the payer/);
    await expect(service.install(install(vault))).rejects.toThrow(/permit.token must be terms.asset/);
    await expect(service.install(install(asset, vault))).rejects.toThrow(/permit.token must be terms.vault/);
    await expect(service.install(install(merchant))).rejects.toThrow(/not an accepted asset or a known savings vault/);
  });

  it("permits the vault's shares for a mandate drawn from savings", async () => {
    const { chain, service } = setup();
    await service.install(install(vault, vault));
    expect(chain.sent.map((tx) => tx.to)).toEqual([vault, hub]);
  });

  it("submits a savings mandate's backup permit on its asset after the vault's, then the mandate", async () => {
    const { chain, service } = setup();
    await service.install(withBackup(install(vault, vault)));
    expect(chain.sent.map((tx) => tx.to)).toEqual([vault, asset, hub]);
  });

  it("refuses a backup permit on a direct mandate, on anything but the asset, or not the payer's", async () => {
    const { chain, service } = setup();
    await expect(service.install(withBackup(install(asset)))).rejects.toThrow(/only for a mandate drawn from savings/);
    await expect(service.install(withBackup(install(vault, vault), vault))).rejects.toThrow(/backupPermit.token must be terms.asset/);
    await expect(service.install(withBackup(install(vault, vault), asset, merchant))).rejects.toThrow(/backupPermit.owner must be the payer/);
    expect(chain.sent).toHaveLength(0);
  });
});

describe("bundled installs", () => {
  const parts = (call: RelayCall) => decodeFunctionData({ abi: aggregate3Abi, data: call.data }).args[0];

  it("sends the permit and the mandate as one transaction through Multicall3", async () => {
    const { chain, service } = setup({ bundles: true });
    const result = await service.install(install(asset));

    expect(chain.sent).toHaveLength(1);
    const [sent] = chain.sent;
    expect(sent?.to).toBe(MULTICALL3_ADDRESS);
    const [permitPart, createPart] = parts(sent as RelayCall);
    expect(permitPart?.target).toBe(asset);
    expect(permitPart?.allowFailure).toBe(true);
    expect(decodeFunctionData({ abi: stablecoinAbi, data: permitPart?.callData ?? "0x" }).functionName).toBe("permit");
    expect(createPart?.target).toBe(hub);
    expect(createPart?.allowFailure).toBe(false);

    expect(result.mandateId).toBe("42");
    expect(result.transactions.permit).toBe(result.transactions.create);
  });

  it("bundles a savings mandate's vault permit, its backup permit and the mandate as one transaction", async () => {
    const { chain, service } = setup({ bundles: true });
    const result = await service.install(withBackup(install(vault, vault)));

    expect(chain.sent).toHaveLength(1);
    const bundled = parts(chain.sent[0] as RelayCall);
    expect(bundled.map((part) => part.target)).toEqual([vault, asset, hub]);
    expect(bundled.map((part) => part.allowFailure)).toEqual([true, true, false]);
    expect(result.transactions.permit).toBe(result.transactions.create);
  });

  it("leaves out a backup permit someone already submitted, and keeps the rest of the bundle", async () => {
    const { chain, service } = setup({ bundles: true });
    chain.revert = (call) => (isAddressEqual(call.to, asset) ? revertWith("ERC2612InvalidSigner") : undefined);
    chain.allowances.set(`${asset}:${payer}:${hub}`, 60n);

    await service.install(withBackup(install(vault, vault)));
    expect(parts(chain.sent[0] as RelayCall).map((part) => part.target)).toEqual([vault, hub]);
  });

  it("refuses a backup permit that fails when its allowance is not already there", async () => {
    const { chain, service } = setup({ bundles: true });
    chain.revert = (call) => (isAddressEqual(call.to, asset) ? revertWith("ERC2612InvalidSigner") : undefined);

    await expect(service.install(withBackup(install(vault, vault)))).rejects.toThrow(/ERC2612InvalidSigner/);
    expect(chain.sent).toHaveLength(0);
  });

  it("refuses by name, and sends nothing, when the mandate would revert", async () => {
    const { chain, service } = setup({ bundles: true });
    chain.revert = (call) => (isAddressEqual(call.to, hub) ? revertWith("InvalidSignature") : undefined);

    await expect(service.install(install(asset))).rejects.toThrow(/InvalidSignature/);
    expect(chain.sent).toHaveLength(0);
  });

  it("refuses a permit that fails when the allowance does not already cover it", async () => {
    const { chain, service } = setup({ bundles: true });
    chain.revert = (call) => (isAddressEqual(call.to, asset) ? revertWith("ERC2612InvalidSigner") : undefined);

    await expect(service.install(install(asset))).rejects.toThrow(/ERC2612InvalidSigner/);
    expect(chain.sent).toHaveLength(0);
  });

  it("carries on when the permit fails because someone already submitted it", async () => {
    const { chain, service } = setup({ bundles: true });
    chain.revert = (call) => (isAddressEqual(call.to, asset) ? revertWith("ERC2612InvalidSigner") : undefined);
    chain.allowances.set(`${asset}:${payer}:${hub}`, 60n);

    const result = await service.install(install(asset));
    expect(result.mandateId).toBe("42");
    expect(chain.sent).toHaveLength(1);
  });

  it("admits the install only after the bundle has been inspected and estimated, together", async () => {
    const { chain, service } = setup({ bundles: true });
    const order: string[] = [];
    chain.onSend = () => order.push("sent");
    await service.install(install(asset), () => {
      order.push(`admitted after ${chain.simulated.length} read`);
    });
    expect(order).toEqual(["admitted after 2 read", "sent"]);
  });

  it("sends a mandate with no permit as a single call to the hub", async () => {
    const { chain, service } = setup({ bundles: true });
    await service.install(install());
    expect(chain.sent).toHaveLength(1);
    expect(chain.sent[0]?.to).toBe(hub);
  });
});

describe("pausing and stopping a stream", () => {
  const action = (kind: "pause" | "cancel" | "resume") => ({
    mandateId: 3n,
    action: kind,
    signer: payer,
    nonce: 1n,
    deadline: NOW + 600,
    signature: `0x${"33".repeat(65)}` as const,
  });
  const serviceWith = (stream: StreamState) => {
    const { chain, relayer } = setup();
    const service = new RelayService(relayer, chain, deployment, silentLogger, async () => stream, 200_000n);
    return { chain, service };
  };
  const stream = { streaming: true, paused: false, fromVault: false, quote: 0n };

  it("allows for the settlement a stream started this second will owe by the time it lands", async () => {
    const { chain, service } = serviceWith(stream);
    await service.action(action("pause"));
    const plain = setup();
    await plain.service.action(action("pause"));
    expect(chain.sent[0]!.gas - plain.chain.sent[0]!.gas).toBeGreaterThanOrEqual(TOKEN_SETTLEMENT_GAS);
  });

  it("allows more when the stream draws from a vault", async () => {
    const token = serviceWith(stream);
    const vaulted = serviceWith({ ...stream, fromVault: true });
    await token.service.action(action("cancel"));
    await vaulted.service.action(action("cancel"));
    expect(vaulted.chain.sent[0]!.gas - token.chain.sent[0]!.gas).toBeGreaterThanOrEqual(200_000n - TOKEN_SETTLEMENT_GAS);
  });

  it("allows for the vault's interest accrual whenever a stream settles from savings", async () => {
    const plain = setup();
    await plain.service.action(action("pause"));
    const { chain, service } = serviceWith({ ...stream, fromVault: true, quote: 5n });
    await service.action(action("pause"));
    expect(chain.sent[0]!.gas - plain.chain.sent[0]!.gas).toBeGreaterThanOrEqual(VAULT_ACCRUAL_GAS);
  });

  it("adds nothing when the estimate already saw the settlement, for a resume, or for a periodic mandate", async () => {
    const plain = setup();
    await plain.service.action(action("pause"));
    const base = plain.chain.sent[0]!.gas;
    for (const [state, kind] of [
      [{ ...stream, quote: 5n }, "pause"],
      [stream, "resume"],
      [{ ...stream, streaming: false }, "cancel"],
      [{ ...stream, paused: true }, "cancel"],
    ] as const) {
      const { chain, service } = serviceWith(state);
      await service.action(action(kind));
      expect(chain.sent[0]!.gas).toBe(base);
    }
  });
});
