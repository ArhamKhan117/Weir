/**
 * Aurora's Intents widget, set up to deliver one thing: USDC on Monad, to one address. Loaded only
 * when the Add money dialog opens; its stylesheet is scoped to the widget's own `.sw` root.
 *
 * The destination is fixed three ways: the only target chain is Monad, the only target token is
 * Intents' Monad USDC, and the recipient is the Weir account, hidden so it cannot be edited. The
 * swap direction is locked, so the dialog can only ever bring money in.
 *
 * Swapping from a wallet connects it through Privy, the same prompt businesses sign in with, in
 * Weir's colours; the widget's EVM adapter then sends the deposit from it. Only EVM wallets
 * connect: anything else, on any chain, comes in through Top up's deposit address.
 */

import "@aurora-is-near/intents-swap-widget/styles.css";
import { Widget, WidgetConfigProvider, type EvmProvider, type Theme } from "@aurora-is-near/intents-swap-widget";
import { evm } from "@aurora-is-near/intents-swap-widget-evm";
import { PrivyProvider, useConnectWallet, useWallets } from "@privy-io/react-auth";
import { NETWORKS } from "@weir/shared";
import { useEffect, useMemo, useSyncExternalStore } from "react";
import type { Address } from "viem";
import { arbitrum, avalanche, base, bsc, gnosis, mainnet, optimism, polygon, scroll } from "viem/chains";

import { AURORA_API_KEY, PRIVY_APP_ID, TOP_UP_ASSETS, WALLETCONNECT_PROJECT_ID } from "../lib/config";

type Mode = "topup" | "swap";
type Scheme = "light" | "dark";

const MONAD_USDC = Object.values(TOP_UP_ASSETS).find((asset) => asset.symbol === "USDC");

/** Where a connected wallet can pay from: the EVM chains Intents takes deposits on. */
const WALLET_CHAINS = ["eth", "base", "arb", "op", "pol", "bsc", "avax", "gnosis", "scroll", "monad"] as const;
/** Dollars where people hold them, first in the token list. */
const PRIORITY_ASSETS = [
  ["base", "USDC"],
  ["arb", "USDC"],
  ["eth", "USDC"],
  ["op", "USDC"],
  ["pol", "USDC"],
  ["sol", "USDC"],
  ["eth", "USDT"],
  ["tron", "USDT"],
] as const;
const PRIVY_CHAINS = [base, mainnet, arbitrum, optimism, polygon, bsc, avalanche, gnosis, scroll, NETWORKS[143].chain];

/**
 * Weir's own colours, from tokens.css, so the widget reads as part of the page. The widget derives
 * its whole gray scale from `backgroundColor`, reversed in light mode: there the colour given is
 * the text, and the surfaces come out as its tints. A warm near-black lands them on Weir's paper
 * and line colours; pure white would make every gray white, text included.
 */
const THEMES: Record<Scheme, Theme> = {
  light: {
    colorScheme: "light",
    accentColor: "#0e6e64",
    backgroundColor: "#171614",
    successColor: "#1c7c47",
    warningColor: "#9a5a06",
    errorColor: "#b42318",
    stylePreset: "clean",
    borderRadius: "lg",
    showContainer: false,
  },
  dark: {
    colorScheme: "dark",
    accentColor: "#3cc9b4",
    backgroundColor: "#131920",
    successColor: "#4ccf85",
    warningColor: "#f0b35a",
    errorColor: "#f1766c",
    stylePreset: "clean",
    borderRadius: "lg",
    showContainer: false,
  },
};

const darkQuery = () => window.matchMedia("(prefers-color-scheme: dark)");

/** The scheme the page is showing: `data-theme` when set, else the system's. */
function useScheme(): Scheme {
  return useSyncExternalStore(
    (onChange) => {
      const query = darkQuery();
      query.addEventListener("change", onChange);
      const observer = new MutationObserver(onChange);
      observer.observe(document.documentElement, { attributes: true, attributeFilter: ["data-theme"] });
      return () => {
        query.removeEventListener("change", onChange);
        observer.disconnect();
      };
    },
    () => {
      const chosen = document.documentElement.dataset.theme;
      if (chosen === "light" || chosen === "dark") return chosen;
      return darkQuery().matches ? "dark" : "light";
    },
  );
}

/** The widget writes its theme onto `<body>` as custom properties; they go when it does. */
function useThemeCleanup(): void {
  useEffect(
    () => () => {
      const style = document.body.style;
      for (const name of Array.from(style)) {
        if (name.startsWith("--c-sw-") || name.startsWith("--r-sw-")) style.removeProperty(name);
      }
    },
    [],
  );
}

export default function TopUpWidget({ mode, recipient }: { mode: Mode; recipient: Address }) {
  const scheme = useScheme();
  useThemeCleanup();
  if (PRIVY_APP_ID === undefined) return <IntentsWidget mode={mode} recipient={recipient} scheme={scheme} />;
  return (
    <PrivyProvider
      appId={PRIVY_APP_ID}
      config={{
        // Connecting a wallet here signs nobody in and creates nothing.
        embeddedWallets: { ethereum: { createOnLogin: "off" }, solana: { createOnLogin: "off" } },
        defaultChain: base,
        supportedChains: PRIVY_CHAINS,
        ...(WALLETCONNECT_PROJECT_ID === undefined ? {} : { walletConnectCloudProjectId: WALLETCONNECT_PROJECT_ID }),
        appearance: {
          theme: scheme,
          accentColor: scheme === "dark" ? "#3cc9b4" : "#0e6e64",
          walletChainType: "ethereum-only",
          walletList: ["detected_ethereum_wallets", "metamask", "rabby_wallet", "rainbow", "coinbase_wallet", "wallet_connect"],
        },
      }}
    >
      <WalletIntentsWidget mode={mode} recipient={recipient} scheme={scheme} />
    </PrivyProvider>
  );
}

interface Connection {
  address: string;
  provider: EvmProvider;
  disconnect: () => void;
}

/** The widget with the wallet Privy connected, when one is. */
function WalletIntentsWidget({ mode, recipient, scheme }: { mode: Mode; recipient: Address; scheme: Scheme }) {
  const { connectWallet } = useConnectWallet();
  const { wallets } = useWallets();
  // Most recently connected first. No embedded wallet is ever created here, but skip one anyway.
  const wallet = wallets.find((candidate) => candidate.walletClientType !== "privy");
  const connection = useMemo<Connection | undefined>(
    () =>
      wallet === undefined
        ? undefined
        : { address: wallet.address, provider: () => wallet.getEthereumProvider(), disconnect: () => wallet.disconnect() },
    [wallet],
  );
  return (
    <IntentsWidget
      mode={mode}
      recipient={recipient}
      scheme={scheme}
      connection={connection}
      connect={() =>
        connectWallet({
          walletChainType: "ethereum-only",
          description: "Choose the wallet to pay from. Nothing moves until you confirm the swap in it.",
        })
      }
    />
  );
}

function IntentsWidget({
  mode,
  recipient,
  scheme,
  connection,
  connect,
}: {
  mode: Mode;
  recipient: Address;
  scheme: Scheme;
  connection?: Connection | undefined;
  connect?: () => void;
}) {
  if (AURORA_API_KEY === undefined || MONAD_USDC === undefined) return null;
  return (
    <WidgetConfigProvider
      // The widget themes its portalled token list once, on mount: a change of scheme remounts it.
      key={scheme}
      config={{
        apiKey: AURORA_API_KEY,
        sendAddress: recipient,
        hideSendAddress: true,
        allowedTargetChainsList: ["monad"],
        allowedTargetTokensList: [MONAD_USDC.intentsAssetId],
        defaultTargetToken: { symbol: "USDC", blockchain: "monad" },
        // Swap starts from the most common place a person already holds dollars. Top up starts
        // from nothing: given any default it selects the first token of its list instead, and the
        // person has to say what they are sending anyway.
        ...(mode === "swap" ? { defaultSourceToken: { symbol: "USDC", blockchain: "base" } } : {}),
        priorityAssets: PRIORITY_ASSETS,
        lockSwapDirection: true,
        // Top up is the deposit address; Swap is the connected wallet, so each tab does one thing.
        allowSwapWithExternalWallet: mode === "topup",
        attachWalletAddressToQuote: true,
        enableAccountAbstraction: false,
        enableAutoTokensSwitching: true,
        confidentialMode: "public",
        // One percent: wide enough for a volatile source token, and a stablecoin quote beats it.
        slippageTolerance: 100,
        showTransactionHistory: true,
        showConversionPreview: true,
        showProfileButton: connection !== undefined,
        connectedWallets: { default: connection?.address ?? null },
        walletSupportedChains: [...WALLET_CHAINS],
        plugins: { evm },
        ...(connection === undefined ? {} : { providers: { evm: connection.provider } }),
        ...(connect === undefined ? {} : { onWalletSignin: connect }),
        ...(connection === undefined ? {} : { onWalletSignout: connection.disconnect }),
      }}
      theme={THEMES[scheme]}
    >
      <Widget defaultMode={mode} />
    </WidgetConfigProvider>
  );
}
