import { MONAD_MAINNET_CHAIN_ID } from "@weir/shared";

import { CHAIN_ID, NETWORK_CHOICES, switchNetwork } from "../lib/config";

const LABELS: Readonly<Record<number, string>> = { [MONAD_MAINNET_CHAIN_ID]: "Mainnet" };

/**
 * Mainnet or Testnet. Each is a full deployment with its own API; choosing one reloads the app on
 * it. With only one network available the switch is a plain label.
 */
export function NetworkSwitch({ tabIndex }: { tabIndex?: number }) {
  if (NETWORK_CHOICES.length < 2) {
    return <span className="network-pill">{LABELS[CHAIN_ID] ?? "Testnet"}</span>;
  }
  return (
    <div className="network-switch" role="group" aria-label="Network">
      {NETWORK_CHOICES.map((id) => (
        <button
          key={id}
          type="button"
          aria-pressed={id === CHAIN_ID}
          tabIndex={tabIndex}
          onClick={() => switchNetwork(id)}
        >
          {LABELS[id] ?? "Testnet"}
        </button>
      ))}
    </div>
  );
}
