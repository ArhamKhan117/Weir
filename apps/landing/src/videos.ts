/**
 * Every video the site hosts, served from `public/videos`, each with its own page at /videos/<slug>
 * that plays it and offers the file for download. Add a film here and drop its mp4 and a poster
 * (a 1920x1080 jpg) in `public/videos`.
 */

export interface Film {
  slug: string;
  title: string;
  summary: string;
  kind: string;
  /** m:ss */
  length: string;
  /** Rounded, for the download button. */
  size: string;
  file: string;
  poster: string;
}

export const FILMS: Film[] = [
  {
    slug: "weir-launch",
    title: "Weir in 30 seconds",
    summary:
      "The launch film: why stablecoins need a direct debit, what a Weir mandate is, and the product live on Monad Mainnet, from checkout to family support to AI agents billed by the second.",
    kind: "Launch film",
    length: "0:30",
    size: "24 MB",
    file: "/videos/weir-launch.mp4",
    poster: "/videos/weir-launch.jpg",
  },
  {
    slug: "weir-agora",
    title: "Weir for Agora: cross-border payments",
    summary:
      "Passkey onboarding, an AUSD balance, and AUSD sent across borders that settles in the same transaction, live on Monad Mainnet.",
    kind: "Bounty demo",
    length: "1:30",
    size: "12 MB",
    file: "/videos/weir-agora.mp4",
    poster: "/videos/weir-agora.jpg",
  },
  {
    slug: "weir-envio",
    title: "Weir for Envio",
    summary:
      "Data flowing end to end: a payment on Monad, picked up by our multichain HyperIndex indexer and its GraphQL endpoint, then shown in the app and the business dashboard.",
    kind: "Bounty demo",
    length: "1:23",
    size: "11 MB",
    file: "/videos/weir-envio.mp4",
    poster: "/videos/weir-envio.jpg",
  },
  {
    slug: "weir-aurora",
    title: "Weir for Aurora Intents",
    summary:
      "Add money from any chain: Aurora's Intents widget inside Weir, giving a deposit address that lands as USDC on Monad in the payer's own account.",
    kind: "Bounty demo",
    length: "1:25",
    size: "9 MB",
    file: "/videos/weir-aurora.mp4",
    poster: "/videos/weir-aurora.jpg",
  },
  {
    slug: "weir-cre",
    title: "Weir for Chainlink CRE",
    summary:
      "A real CRE CLI simulation with broadcast: the workflow reads every mandate with consensus reads, finds one due, and charges it through a signed report.",
    kind: "Bounty demo",
    length: "1:33",
    size: "11 MB",
    file: "/videos/weir-cre.mp4",
    poster: "/videos/weir-cre.jpg",
  },
  {
    slug: "weir-privy",
    title: "Weir for Privy",
    summary:
      "Business sign-in with Privy, embedded payout wallets the API verifies, and gas-free payouts signed by the Privy wallet.",
    kind: "Bounty demo",
    length: "1:34",
    size: "10 MB",
    file: "/videos/weir-privy.mp4",
    poster: "/videos/weir-privy.jpg",
  },
  {
    slug: "weir-mera-ux",
    title: "Weir for Mera: passkey UX",
    summary:
      "Mera as the whole account layer: one-tap accounts, one-tap yes, no prompts for pause and stop, and the same passkey bringing the same account back.",
    kind: "Bounty demo",
    length: "1:08",
    size: "8 MB",
    file: "/videos/weir-mera-ux.mp4",
    poster: "/videos/weir-mera-ux.jpg",
  },
  {
    slug: "weir-mera-keys",
    title: "Weir for Mera: one passkey, many keys",
    summary:
      "An owner key for money and a session key that proves who you are to Weir's API: supporter names and push reminders, signed without a prompt.",
    kind: "Bounty demo",
    length: "1:25",
    size: "13 MB",
    file: "/videos/weir-mera-keys.mp4",
    poster: "/videos/weir-mera-keys.jpg",
  },
];

/** The longer films, hosted on YouTube. */
export const ELSEWHERE = [
  { title: "Technical demo", summary: "Every flow running live on Monad Mainnet, with each transaction opened on Monadscan.", length: "5:37", href: "https://youtu.be/Tde4Ke2Cj1s" },
  { title: "Pitch", summary: "What Weir is, the problem it solves, who it is for, and who is building it.", length: "3:13", href: "https://youtu.be/Z6H05yJ8i5A" },
];

export function filmBySlug(slug: string): Film | undefined {
  return FILMS.find((film) => film.slug === slug);
}
