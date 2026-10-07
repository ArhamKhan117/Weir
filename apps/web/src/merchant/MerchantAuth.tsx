/**
 * Who the business is: signed in with Privy (email, a passkey or a wallet), with a Privy embedded
 * wallet as the default payout address, so a business needs no crypto either. Payouts can go only
 * to a wallet linked to the account, which the API checks too; linking another is one Privy prompt.
 *
 * Without a Privy app id, development builds offer a local development sign-in instead, which the
 * API accepts only when it runs with development auth switched on. Production builds without Privy
 * say so plainly rather than offering anything.
 */

import { PrivyProvider, usePrivy, useWallets } from "@privy-io/react-auth";
import { createContext, useCallback, useContext, useMemo, useState, type ReactNode } from "react";
import { linkedEvmWallets, type LinkedAccountLike } from "@weir/shared";
import { getAddress, isAddressEqual, type Address, type Hex, type TypedDataDefinition } from "viem";
import { generatePrivateKey, privateKeyToAccount } from "viem/accounts";

import { DEV_MERCHANT_AUTH, NETWORK, PRIVY_APP_ID, WALLETCONNECT_PROJECT_ID } from "../lib/config";
import { walletTypedData } from "../lib/walletTypedData";

export interface MerchantAuth {
  mode: "privy" | "dev" | "unconfigured";
  ready: boolean;
  signedIn: boolean;
  /**
   * The wallets payouts may go to, the default first: the Privy embedded wallet and any linked
   * wallet, or the development address.
   */
  wallets: readonly PayoutWallet[];
  email: string | undefined;
  authorization(): Promise<string | undefined>;
  signIn(): void;
  signOut(): Promise<void>;
  /** Opens Privy's prompt to link another wallet; absent where there is nothing to link. */
  linkWallet?: () => void;
  /**
   * Has `address`, one of `wallets`, sign typed data: through Privy, which shows its own prompt for
   * the embedded wallet and asks a linked wallet's app otherwise. Absent where nothing can sign.
   */
  signTypedData?: (address: Address, typedData: TypedDataDefinition) => Promise<Hex>;
}

export interface PayoutWallet {
  address: Address;
  /** What the business would call it: "Weir wallet" for the embedded one, else the wallet's name. */
  label: string;
}

const WALLET_NAMES: Record<string, string> = {
  metamask: "MetaMask",
  coinbase_wallet: "Coinbase Wallet",
  base_account: "Base Account",
  rainbow: "Rainbow",
  rabby_wallet: "Rabby",
  phantom: "Phantom",
  wallet_connect: "WalletConnect",
  wallet_connect_v2: "WalletConnect",
};

/** Labels the payout wallets among Privy linked accounts, in the order the API ranks them. */
function payoutWallets(accounts: readonly LinkedAccountLike[]): PayoutWallet[] {
  const clientOf = new Map<string, string | undefined>();
  for (const account of accounts) {
    if (account.type === "wallet" && account.address !== undefined) clientOf.set(account.address.toLowerCase(), account.walletClientType);
  }
  return linkedEvmWallets(accounts).map((address) => {
    const client = clientOf.get(address.toLowerCase());
    const label = client === "privy" ? "Weir wallet" : (WALLET_NAMES[client ?? ""] ?? "Linked wallet");
    return { address, label };
  });
}

const Context = createContext<MerchantAuth | undefined>(undefined);

export function useMerchantAuth(): MerchantAuth {
  const auth = useContext(Context);
  if (auth === undefined) throw new Error("useMerchantAuth outside MerchantAuthProvider");
  return auth;
}

export function MerchantAuthProvider({ children }: { children: ReactNode }) {
  if (DEV_MERCHANT_AUTH) return <DevAuth>{children}</DevAuth>;
  if (PRIVY_APP_ID !== undefined) {
    return (
      <PrivyProvider
        appId={PRIVY_APP_ID}
        config={{
          // Only methods the Privy app has switched on: asking for one it has not fails the login.
          loginMethods: ["email", "passkey", "wallet"],
          embeddedWallets: {
            ethereum: { createOnLogin: "users-without-wallets" },
            solana: { createOnLogin: "off" },
          },
          defaultChain: NETWORK.chain,
          supportedChains: [NETWORK.chain],
          ...(WALLETCONNECT_PROJECT_ID === undefined ? {} : { walletConnectCloudProjectId: WALLETCONNECT_PROJECT_ID }),
          appearance: {
            accentColor: "#0e6e64",
            landingHeader: "Sign in to Weir for businesses",
            showWalletLoginFirst: false,
            walletChainType: "ethereum-only",
            // Wallets a business holds itself. Coinbase's defaults to a smart wallet, which exists
            // per chain and may not exist on Monad to move what it is paid.
            walletList: ["detected_ethereum_wallets", "metamask", "rabby_wallet", "rainbow", "wallet_connect"],
          },
        }}
      >
        <PrivyAuth>{children}</PrivyAuth>
      </PrivyProvider>
    );
  }
  return <Context.Provider value={UNCONFIGURED}>{children}</Context.Provider>;
}

const UNCONFIGURED: MerchantAuth = {
  mode: "unconfigured",
  ready: true,
  signedIn: false,
  wallets: [],
  email: undefined,
  authorization: async () => undefined,
  signIn: () => undefined,
  signOut: async () => undefined,
};

function PrivyAuth({ children }: { children: ReactNode }) {
  const privy = usePrivy();
  const { wallets: connected } = useWallets();
  const accounts = privy.user?.linkedAccounts;
  const wallets = useMemo(() => payoutWallets(accounts ?? []), [accounts]);
  const value = useMemo<MerchantAuth>(
    () => ({
      mode: "privy",
      ready: privy.ready,
      signedIn: privy.ready && privy.authenticated,
      wallets,
      email: privy.user?.email?.address,
      authorization: async () => {
        const token = await privy.getAccessToken();
        return token === null ? undefined : `Bearer ${token}`;
      },
      signIn: () => privy.login(),
      signOut: () => privy.logout(),
      linkWallet: () => privy.linkWallet({ walletChainType: "ethereum-only" }),
      signTypedData: async (address, typedData) => {
        const wallet = connected.find((w) => isAddressEqual(w.address as Address, address));
        if (wallet === undefined) throw new Error("That wallet is not connected in this browser. Connect it, then try again.");
        // A wallet app checks the domain's chain against its own; the embedded wallet follows any.
        if (wallet.walletClientType !== "privy") await wallet.switchChain(NETWORK.chain.id);
        const provider = await wallet.getEthereumProvider();
        return (await provider.request({ method: "eth_signTypedData_v4", params: [wallet.address, walletTypedData(typedData)] })) as Hex;
      },
    }),
    [privy, wallets, connected],
  );
  return <Context.Provider value={value}>{children}</Context.Provider>;
}

const DEV_KEY = "weir.dev-merchant-key";

function DevAuth({ children }: { children: ReactNode }) {
  // A development business's payout key, kept in this browser so it can pay its earnings out on
  // Testnet. Development builds only: production signs in with Privy.
  const [key, setKey] = useState<Hex | undefined>(() => {
    try {
      const stored = window.localStorage.getItem(DEV_KEY);
      return stored === null ? undefined : (stored as Hex);
    } catch {
      return undefined;
    }
  });
  const account = useMemo(() => (key === undefined ? undefined : privateKeyToAccount(key)), [key]);
  const address = account === undefined ? undefined : getAddress(account.address);

  const signIn = useCallback(() => {
    const next = generatePrivateKey();
    window.localStorage.setItem(DEV_KEY, next);
    setKey(next);
  }, []);

  const value = useMemo<MerchantAuth>(
    () => ({
      mode: "dev",
      ready: true,
      signedIn: address !== undefined,
      wallets: address === undefined ? [] : [{ address, label: "Development address" }],
      email: undefined,
      authorization: async () => (address === undefined ? undefined : `Dev ${address}`),
      signIn,
      signOut: async () => {
        window.localStorage.removeItem(DEV_KEY);
        setKey(undefined);
      },
      ...(account === undefined ? {} : { signTypedData: async (_address: Address, typedData: TypedDataDefinition) => account.signTypedData(typedData) }),
    }),
    [address, account, signIn],
  );
  return <Context.Provider value={value}>{children}</Context.Provider>;
}
