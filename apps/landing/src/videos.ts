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
];

/** The longer films, hosted on YouTube. */
export const ELSEWHERE = [
  { title: "Technical demo", summary: "Every flow running live on Monad Mainnet, with each transaction opened on Monadscan.", length: "5:37", href: "https://youtu.be/Tde4Ke2Cj1s" },
  { title: "Pitch", summary: "What Weir is, the problem it solves, who it is for, and who is building it.", length: "3:13", href: "https://youtu.be/Z6H05yJ8i5A" },
];

export function filmBySlug(slug: string): Film | undefined {
  return FILMS.find((film) => film.slug === slug);
}
