/**
 * The HTTP contract between the Weir API and its clients: the web app, the SDK and the keeper.
 *
 * Every amount crosses the wire as a decimal string of base units, never a JSON number, because a
 * number loses precision past 2^53 and a six-decimal dollar amount reaches that at nine billion
 * dollars. Every address is EIP-55 checksummed. Every time is unix seconds as a number.
 *
 * Errors are `{ error: { code, message } }` with an HTTP status; `code` is one of `ApiErrorCode`.
 */

import type { Address, Hex, MandateStanding, MandateStatus } from "./types.js";

/** Base units as a decimal string, for example `"9990000"` for $9.99. */
export type Units = string;

/*//////////////////////////////////////////////////////////////
                              PLANS
//////////////////////////////////////////////////////////////*/

/** How a plan bills. */
export type PlanMode = "periodic" | "streaming";

/**
 * A merchant's product, and the recipe for the mandate a payer installs from its checkout link.
 *
 * `id` is at most 32 bytes so it fits the mandate's `ref`, which is how charges on chain are tied
 * back to the plan: `ref = refFromString(plan.id)`.
 */
export interface Plan {
  id: string;
  merchant: MerchantPublic;
  name: string;
  description: string;
  asset: Address;
  assetSymbol: string;
  mode: PlanMode;
  /** Per period for `periodic`, per second for `streaming`. */
  amount: Units;
  /** Seconds between charges; `0` for `streaming`. */
  period: number;
  /** Days before the first charge. `0` charges at install. */
  trialDays: number;
  /** Ceiling on one charge. Equals `amount` for a periodic plan. */
  maxPerCharge: Units;
  /** Lifetime ceiling the payer is asked to authorize. */
  maxTotal: Units;
  /** Seconds the mandate lives, counted from install. */
  termSeconds: number;
  active: boolean;
  createdAt: number;
}

/** What a payer sees about a merchant. */
export interface MerchantPublic {
  id: string;
  name: string;
  /** Where charges are paid. */
  payoutAddress: Address;
  /** A `.nad` name for the payout address, when it has one. */
  nadName?: string;
}

export interface CreatePlanRequest {
  name: string;
  description: string;
  asset: Address;
  mode: PlanMode;
  amount: Units;
  period: number;
  trialDays: number;
  maxPerCharge: Units;
  maxTotal: Units;
  termSeconds: number;
}

/** `GET /v1/checkout/:planId`: everything a checkout page needs, public. */
export interface CheckoutResponse {
  plan: Plan;
  chainId: number;
  hub: Address;
  /** The hub's EIP-712 domain name. */
  domainName: string;
  /** A savings vault over the plan's asset, when the network has one the app offers. */
  savingsVault?: { address: Address; name: string; symbol: string; apyBps?: number };
}

/*//////////////////////////////////////////////////////////////
                              RELAY
//////////////////////////////////////////////////////////////*/

/** An EIP-2612 permit the payer signed for the hub; the relayer submits it. */
export interface SignedPermit {
  /** The token or vault share being permitted. */
  token: Address;
  owner: Address;
  value: Units;
  deadline: number;
  signature: Hex;
}

/** The mandate terms as signed, with amounts as strings. */
export interface WireTerms {
  merchant: Address;
  asset: Address;
  vault: Address;
  manager: Address;
  amount: Units;
  period: number;
  startAt: number;
  maxPerCharge: Units;
  maxTotal: Units;
  expiresAt: number;
  ref: Hex;
}

/** `POST /v1/relay/install`: optional permits, then the signed mandate, all in one transaction. */
export interface InstallRequest {
  /** On the token the mandate draws from: its asset, or for a mandate drawn from savings, the vault's shares. */
  permit?: SignedPermit;
  /**
   * Savings mandates only: a permit on the asset itself, the backup the hub pays from when the
   * vault cannot pay a charge. Without one, a charge the vault cannot pay fails instead.
   */
  backupPermit?: SignedPermit;
  payer: Address;
  terms: WireTerms;
  /** Decimal string: the nonce is 256 bits. */
  nonce: string;
  deadline: number;
  signature: Hex;
}

export interface InstallResponse {
  mandateId: string;
  transactions: { permit?: Hex; create: Hex };
  /**
   * True when the first charge went in the same transaction: a mandate that is one charge, due
   * now ("send now"), arrives with the install rather than waiting for a keeper.
   */
  charged?: boolean;
}

/** `POST /v1/relay/action`: a cancel, pause or resume signed by the payer or the manager. */
export interface ActionRequest {
  mandateId: string;
  action: "cancel" | "pause" | "resume";
  signer: Address;
  nonce: string;
  deadline: number;
  signature: Hex;
}

/** `POST /v1/relay/manager`: a new manager key signed by the payer. */
export interface SetManagerRequest {
  mandateId: string;
  manager: Address;
  nonce: string;
  deadline: number;
  signature: Hex;
}

export interface RelayResponse {
  transaction: Hex;
}

/**
 * `POST /v1/relay/savings`: move a payer's dollars into their savings vault, or back out, on an
 * EIP-2612 permit to the savings router, which the relayer submits. A deposit's permit is on the
 * asset for `amount`; a withdrawal's is on the vault's shares for `maxShares`, the most the
 * withdrawal may burn. Either way the money only ever moves within the owner's own account.
 */
export interface SavingsRequest {
  direction: "deposit" | "withdraw";
  owner: Address;
  asset: Address;
  /** Base units of the asset moved. */
  amount: string;
  /** Withdrawals only: the shares the permit allows the router to burn. */
  maxShares?: string;
  deadline: number;
  /** The owner's permit signature, 65 bytes. */
  signature: Hex;
}

/*//////////////////////////////////////////////////////////////
                           FAMILY SUPPORT
//////////////////////////////////////////////////////////////*/

/** Seconds between contributions a support circle may ask for: every week, or every month. */
export const SUPPORT_PERIODS = { week: 604_800, month: 2_592_000 } as const;

/**
 * One person, and the family and friends who each pay them on a schedule. Every contribution is
 * its own mandate paying the recipient directly; the circle only names them and adds them up.
 */
export interface SupportCircle {
  id: string;
  /** Who is supported. Every contribution is paid straight to this address. */
  recipient: Address;
  /** Who it is for, as their supporters know them: "Mum". */
  name: string;
  /** What the money is for. */
  note: string;
  /** The recipient's local currency (ISO 4217, one of `LOCAL_CURRENCIES`), or "" for none. */
  currency: string;
  asset: Address;
  assetSymbol: string;
  /** Seconds between contributions: one of `SUPPORT_PERIODS`. */
  period: number;
  /** Base units hoped for each period from everyone together; "0" for no goal. */
  goal: Units;
  createdAt: number;
}

/**
 * `POST /v1/support`: a circle, signed by its recipient with `supportCircleTypedData`, so nobody
 * can open a circle that pays someone else.
 */
export interface CreateSupportRequest {
  recipient: Address;
  name: string;
  note: string;
  currency: string;
  asset: Address;
  period: number;
  goal: Units;
  nonce: string;
  deadline: number;
  signature: Hex;
}

export interface Supporter {
  mandateId: string;
  payer: Address;
  /** The name the supporter gave, when they gave one. */
  name?: string;
  amount: Units;
  /** A single contribution ("send now") rather than one every period. */
  once: boolean;
  standing: MandateStanding;
  totalCharged: Units;
  since: number;
}

/** `GET /v1/support/:id`: the circle, who supports it, and what arrives. */
export interface SupportResponse {
  circle: SupportCircle;
  chainId: number;
  hub: Address;
  domainName: string;
  supporters: Supporter[];
  /** Base units the supporters still giving send each period, together. */
  committedPerPeriod: Units;
  /** Base units received so far, from everyone. */
  received: Units;
  /** Where a supporter's money can earn until each contribution, as at checkout. */
  savingsVault?: { address: Address; name: string; symbol: string; apyBps?: number };
}

/** `GET /v1/recipients/:address/support`: the circles a person has opened. */
export interface SupportListResponse {
  circles: SupportCircle[];
}

/**
 * `PUT /v1/support/:id/supporters/:mandateId/name`: the name a supporter shows the recipient,
 * signed with `supporterNameTypedData` by the mandate's payer or its manager (the session key).
 */
export interface SupporterNameRequest {
  name: string;
  signer: Address;
  deadline: number;
  signature: Hex;
}

/*//////////////////////////////////////////////////////////////
                           PUSH REMINDERS
//////////////////////////////////////////////////////////////*/

/** `GET /v1/push/key`: the server's VAPID public key, which a browser subscribes with. */
export interface PushKeyResponse {
  publicKey: string;
}

/**
 * `POST /v1/push/subscriptions`: a browser that wants `payer`'s reminders, signed with
 * `pushSubscriptionTypedData` by the payer or by the session key managing their payments, so
 * nobody can have someone else's reminders sent to them.
 */
export interface PushSubscribeRequest {
  payer: Address;
  signer: Address;
  subscription: { endpoint: string; keys: { p256dh: string; auth: string } };
  deadline: number;
  signature: Hex;
}

/** `DELETE /v1/push/subscriptions`: stop sending to this browser. */
export interface PushUnsubscribeRequest {
  endpoint: string;
}

/*//////////////////////////////////////////////////////////////
                            PRIVATE NOTES
//////////////////////////////////////////////////////////////*/

/**
 * A payer's private notes, as the API holds them: one AES-GCM sealed blob per locker, both
 * base64url. The key and the locker come from a passkey PRF namespace of their own, so the server
 * can neither read the notes nor tell whose they are. `GET` and `PUT /v1/notes` carry the locker as
 * `Authorization: Locker <64 hex>`.
 */
export interface SealedNotes {
  /** 12 bytes. */
  nonce: string;
  ciphertext: string;
  /** Unix seconds; set by the server. */
  updatedAt: number;
}

/** `PUT /v1/notes`: replaces the locker's blob. */
export type SaveNotesRequest = Omit<SealedNotes, "updatedAt">;

/** `GET /v1/savings`: the savings vault offered for each asset that has one. */
export interface SavingsResponse {
  /** The router that moves money in and out on the payer's signature; absent where there is none. */
  router?: Address;
  vaults: {
    asset: Address;
    assetSymbol: string;
    address: Address;
    name: string;
    symbol: string;
    /** Known only where the rate is fixed in the vault's code, as on Testnet. */
    apyBps?: number;
  }[];
}

/** `POST /v1/faucet` (Testnet only): test dollars for a new account. */
export interface FaucetRequest {
  address: Address;
}

export interface FaucetResponse {
  transaction: Hex;
  amount: Units;
  asset: Address;
}

/*//////////////////////////////////////////////////////////////
                          MANDATES, CHARGES
//////////////////////////////////////////////////////////////*/

/** A mandate as the indexer knows it, joined to its plan when its `ref` names one. */
export interface MandateView {
  id: string;
  payer: Address;
  merchant: Address;
  asset: Address;
  assetSymbol: string;
  vault: Address;
  manager: Address;
  amount: Units;
  period: number;
  nextChargeAt: number;
  maxPerCharge: Units;
  maxTotal: Units;
  totalCharged: Units;
  expiresAt: number;
  pausedAt: number;
  status: MandateStatus;
  /** Derived for display: see `standingOf`. */
  standing: MandateStanding;
  ref: Hex;
  plan?: Pick<Plan, "id" | "name" | "description" | "mode"> & { merchantName: string };
  /** The family support circle it contributes to, when its `ref` names one that it pays. */
  support?: { id: string; name: string };
  createdAt: number;
  createdTx: Hex;
}

/** One charge attempt that reached the chain. */
export interface ChargeView {
  mandateId: string;
  kind: "charged" | "failed";
  /** Base units moved, or required for a failure. */
  amount: Units;
  /** For `failed`: 1 balance, 2 allowance, 3 the pull could not complete. */
  reason?: number;
  merchant: Address;
  payer: Address;
  asset: Address;
  timestamp: number;
  blockNumber: number;
  transaction: Hex;
}

/** `GET /v1/payers/:address`: a payer's mandates and recent charges. */
export interface PayerResponse {
  mandates: MandateView[];
  charges: ChargeView[];
}

/*//////////////////////////////////////////////////////////////
                              MERCHANT
//////////////////////////////////////////////////////////////*/

/**
 * `POST /v1/merchant/payout`: a business sends what it has been paid on from a wallet it holds (its
 * Privy wallet, or one it linked), on that wallet's permit to the relayer, which pays the fee.
 */
export interface PayoutRequest {
  /** A wallet the business has proven it controls. */
  owner: Address;
  asset: Address;
  amount: Units;
  to: Address;
  /** The permit's deadline, unix seconds. */
  deadline: number;
  /** EIP-2612 permit from `owner` to the relayer for exactly `amount`. */
  signature: Hex;
}

/** `GET /v1/merchant/payout`: whom a payout's permit names as spender. */
export interface PayoutInfo {
  spender: Address;
}

export interface PayoutResponse {
  /** The transfer to `to`. */
  transaction: Hex;
  /** The permit, when it had to be submitted first. */
  permit?: Hex;
  /** Whom the permit names as spender: the relayer. */
  spender: Address;
}

/*//////////////////////////////////////////////////////////////
                     ANALYTICS (ENVIO HYPERINDEX)
//////////////////////////////////////////////////////////////*/

/** One UTC day of activity, as Envio HyperIndex aggregates it. */
export interface IndexedDay {
  /** YYYY-MM-DD. */
  date: string;
  /** Base units charged that day. */
  volume: Units;
  charges: number;
  newMandates: number;
}

export type ChargeTrigger = "Cre" | "Keeper" | "Direct" | "Settlement";

/**
 * `GET /v1/merchant/analytics`: the signed-in business's revenue across every wallet it is paid
 * to, from the Envio HyperIndex project indexing the hub and the charger.
 */
export interface MerchantAnalytics {
  chainId: number;
  mrr: Units;
  revenue: Units;
  customers: number;
  activeCustomers: number;
  charges: number;
  failures: number;
  /** The last 30 days, oldest first, every day present. */
  days: IndexedDay[];
  /** What sent its charges: a Chainlink CRE report, the keeper, a direct call, or a stream settling. */
  triggers: { trigger: ChargeTrigger; charges: number; volume: Units }[];
}

/** One network's totals, from Envio HyperIndex. */
export interface NetworkStats {
  chainId: number;
  mandates: number;
  liveMandates: number;
  payers: number;
  merchants: number;
  charges: number;
  volume: Units;
  mrr: Units;
  /** Chainlink CRE reports the charger has received. */
  reports: number;
  days: IndexedDay[];
}

/** `GET /v1/stats`: every network the index holds. */
export interface StatsResponse {
  networks: NetworkStats[];
}

/** The signed-in merchant's own record. */
export interface MerchantProfile extends MerchantPublic {
  createdAt: number;
  webhookUrl?: string;
}

export interface UpdateMerchantRequest {
  name?: string;
  payoutAddress?: Address;
  webhookUrl?: string | null;
}

/** `GET /v1/merchant/overview`. Figures are per asset symbol. */
export interface MerchantOverview {
  profile: MerchantProfile;
  plans: Plan[];
  mandates: MandateView[];
  charges: ChargeView[];
  stats: {
    activeMandates: number;
    pastDue: number;
    /** Monthly recurring revenue from active periodic mandates, per asset symbol. */
    mrr: Record<string, Units>;
    /** Collected in the last 30 days, per asset symbol. */
    collected30d: Record<string, Units>;
  };
}

/*//////////////////////////////////////////////////////////////
                               ERRORS
//////////////////////////////////////////////////////////////*/

export type ApiErrorCode =
  | "bad_request"
  | "unauthorized"
  | "not_found"
  | "rate_limited"
  | "rejected_on_chain"
  | "not_configured"
  | "internal";

export interface ApiError {
  error: { code: ApiErrorCode; message: string };
}

/** The API's routes, so no client spells one by hand. */
export const API_ROUTES = {
  checkout: (planId: string) => `/v1/checkout/${encodeURIComponent(planId)}`,
  install: "/v1/relay/install",
  action: "/v1/relay/action",
  setManager: "/v1/relay/manager",
  savings: "/v1/relay/savings",
  savingsVaults: "/v1/savings",
  pushKey: "/v1/push/key",
  pushSubscriptions: "/v1/push/subscriptions",
  notes: "/v1/notes",
  support: "/v1/support",
  supportCircle: (id: string) => `/v1/support/${encodeURIComponent(id)}`,
  supportFor: (recipient: string) => `/v1/recipients/${recipient}/support`,
  supporterName: (id: string, mandateId: string) =>
    `/v1/support/${encodeURIComponent(id)}/supporters/${encodeURIComponent(mandateId)}/name`,
  faucet: "/v1/faucet",
  payer: (address: string) => `/v1/payers/${address}`,
  merchantOverview: "/v1/merchant/overview",
  merchant: "/v1/merchant",
  plans: "/v1/merchant/plans",
  plan: (planId: string) => `/v1/merchant/plans/${encodeURIComponent(planId)}`,
  health: "/health",
  payout: "/v1/merchant/payout",
  merchantAnalytics: "/v1/merchant/analytics",
  stats: "/v1/stats",
} as const;
