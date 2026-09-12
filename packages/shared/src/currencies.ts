/**
 * The local currencies a family support circle can show its dollars in, and where each rate comes
 * from. Chainlink publishes a handful of fiat rates on Monad Mainnet; those are read from the
 * chain, and every other currency comes from a public market rate. A circle stores only the code.
 */

import type { Address } from "viem";

export interface LocalCurrency {
  /** ISO 4217. */
  readonly code: string;
  readonly name: string;
  /** Where it is spent, as a person sending money would say it. */
  readonly country: string;
  /** Regional-indicator flag. */
  readonly flag: string;
}

/** The corridors families send along most, then the currencies Chainlink reads on Monad. */
export const LOCAL_CURRENCIES: readonly LocalCurrency[] = [
  { code: "PKR", name: "Pakistani rupee", country: "Pakistan", flag: "🇵🇰" },
  { code: "INR", name: "Indian rupee", country: "India", flag: "🇮🇳" },
  { code: "NGN", name: "Nigerian naira", country: "Nigeria", flag: "🇳🇬" },
  { code: "PHP", name: "Philippine peso", country: "Philippines", flag: "🇵🇭" },
  { code: "MXN", name: "Mexican peso", country: "Mexico", flag: "🇲🇽" },
  { code: "BDT", name: "Bangladeshi taka", country: "Bangladesh", flag: "🇧🇩" },
  { code: "EGP", name: "Egyptian pound", country: "Egypt", flag: "🇪🇬" },
  { code: "KES", name: "Kenyan shilling", country: "Kenya", flag: "🇰🇪" },
  { code: "GHS", name: "Ghanaian cedi", country: "Ghana", flag: "🇬🇭" },
  { code: "VND", name: "Vietnamese dong", country: "Vietnam", flag: "🇻🇳" },
  { code: "IDR", name: "Indonesian rupiah", country: "Indonesia", flag: "🇮🇩" },
  { code: "NPR", name: "Nepalese rupee", country: "Nepal", flag: "🇳🇵" },
  { code: "LKR", name: "Sri Lankan rupee", country: "Sri Lanka", flag: "🇱🇰" },
  { code: "MAD", name: "Moroccan dirham", country: "Morocco", flag: "🇲🇦" },
  { code: "TRY", name: "Turkish lira", country: "Türkiye", flag: "🇹🇷" },
  { code: "BRL", name: "Brazilian real", country: "Brazil", flag: "🇧🇷" },
  { code: "COP", name: "Colombian peso", country: "Colombia", flag: "🇨🇴" },
  { code: "ARS", name: "Argentine peso", country: "Argentina", flag: "🇦🇷" },
  { code: "UAH", name: "Ukrainian hryvnia", country: "Ukraine", flag: "🇺🇦" },
  { code: "ZAR", name: "South African rand", country: "South Africa", flag: "🇿🇦" },
  { code: "EUR", name: "Euro", country: "Euro area", flag: "🇪🇺" },
  { code: "GBP", name: "Pound sterling", country: "United Kingdom", flag: "🇬🇧" },
  { code: "CAD", name: "Canadian dollar", country: "Canada", flag: "🇨🇦" },
  { code: "CHF", name: "Swiss franc", country: "Switzerland", flag: "🇨🇭" },
  { code: "JPY", name: "Japanese yen", country: "Japan", flag: "🇯🇵" },
];

export function localCurrency(code: string): LocalCurrency | undefined {
  return LOCAL_CURRENCIES.find((currency) => currency.code === code);
}

/**
 * Chainlink's fiat feeds on Monad Mainnet, each quoting one unit of the currency in US dollars
 * (EUR / USD and so on), from Chainlink's own feed directory.
 */
export const CHAINLINK_FIAT_FEEDS: Readonly<Record<string, Address>> = {
  EUR: "0x00D7E359c8CE46168eFDD4D65b708fFb16c4b99a",
  GBP: "0x1ffC8B75a16FFfbd7879F042B580F7607Dcf5C30",
  CAD: "0x3293eA5650E9f8c4091642b7EB1C46CFEe5197cA",
  CHF: "0x6DBa7f3A7B5B7c1079337104caD14D19150F6B8d",
  JPY: "0xF64664Ea54cE47eCC7a1816C49d1Bc6deF828927",
};
