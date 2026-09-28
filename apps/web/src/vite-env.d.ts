/// <reference types="vite/client" />

interface ImportMetaEnv {
  readonly VITE_CHAIN_ID?: string;
  readonly VITE_API_URL?: string;
  readonly VITE_API_URL_MAINNET?: string;
  readonly VITE_API_URL_TESTNET?: string;
  readonly VITE_DEMO_PLAN_ID?: string;
  readonly VITE_DEMO_PLAN_ID_MAINNET?: string;
  readonly VITE_SITE_URL?: string;
  readonly VITE_PRIVY_APP_ID?: string;
  readonly VITE_WALLETCONNECT_PROJECT_ID?: string;
  readonly VITE_AURORA_API_KEY?: string;
}

interface ImportMeta {
  readonly env: ImportMetaEnv;
}
