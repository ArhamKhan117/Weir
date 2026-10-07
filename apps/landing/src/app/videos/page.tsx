import type { Metadata } from "next";

import { ELSEWHERE, FILMS } from "../../videos";
import { DownloadIcon, VideoChrome } from "./chrome";

export const metadata: Metadata = {
  title: "Weir videos",
  description: "Films of Weir, direct debit for digital dollars on Monad: the launch film, the technical demo and the pitch.",
};

export default function Videos() {
  return (
    <VideoChrome>
      <p className="mt-10 text-[0.8rem] font-medium uppercase tracking-[0.24em] text-[#0E6E64]">Videos</p>
      <h1 className="mt-3 text-[clamp(2.4rem,7vw,4rem)] font-normal leading-[1.05] tracking-[-0.03em]">Weir, on film</h1>
      <p className="mt-4 max-w-[640px] text-[1.05rem] leading-[1.6] text-[#6E6870]">
        Watch them here, share the link, or download the files. Everything shown runs live on Monad Mainnet.
      </p>

      <div className="mt-12 grid grid-cols-1 gap-8 md:grid-cols-2">
        {FILMS.map((film) => (
          <article key={film.slug} id={film.slug} className="overflow-hidden rounded-[24px] bg-white shadow-[0_20px_50px_rgba(40,30,60,0.08)]">
            <a href={`/videos/${film.slug}`} className="group relative block aspect-video overflow-hidden bg-[#E9E4E0]">
              <img src={film.poster} alt="" className="h-full w-full object-cover transition-transform duration-500 group-hover:scale-[1.03]" />
              <span className="absolute bottom-3 left-3 flex items-center">
                <span className="flex h-12 w-12 items-center justify-center rounded-full bg-[#18161B]/85 text-white shadow-lg">
                  <svg viewBox="0 0 24 24" width={22} height={22} fill="currentColor" aria-hidden="true"><path d="M8 5.5v13l11-6.5z" /></svg>
                </span>
              </span>
              <span className="absolute bottom-3 right-3 rounded-full bg-[#18161B]/80 px-3 py-1 text-[0.8rem] text-white">{film.length}</span>
            </a>
            <div className="p-6">
              <p className="text-[0.75rem] font-medium uppercase tracking-[0.2em] text-[#0E6E64]">{film.kind}</p>
              <h2 className="mt-2 text-[1.5rem] font-medium tracking-[-0.02em]">{film.title}</h2>
              <p className="mt-2 text-[0.95rem] leading-[1.6] text-[#6E6870]">{film.summary}</p>
              <div className="mt-5 flex flex-wrap gap-3">
                <a href={`/videos/${film.slug}`} className="rounded-full bg-[#18161B] px-5 py-2.5 text-[0.9rem] font-medium text-white no-underline">
                  Watch
                </a>
                <a href={film.file} download className="inline-flex items-center gap-2 rounded-full border border-[#E2DCD7] bg-white px-5 py-2.5 text-[0.9rem] font-medium text-[#18161B] no-underline">
                  <DownloadIcon /> Download ({film.size})
                </a>
              </div>
            </div>
          </article>
        ))}
      </div>

      <h2 className="mt-16 text-[1.4rem] font-medium tracking-[-0.02em]">On YouTube</h2>
      <div className="mt-5 grid grid-cols-1 gap-4 md:grid-cols-2">
        {ELSEWHERE.map((film) => (
          <a key={film.href} href={film.href} target="_blank" rel="noreferrer" className="flex items-start justify-between gap-6 rounded-[20px] bg-white p-6 no-underline shadow-[0_12px_30px_rgba(40,30,60,0.06)] transition-transform duration-200 hover:-translate-y-0.5">
            <span>
              <span className="block text-[1.15rem] font-medium text-[#18161B]">{film.title}</span>
              <span className="mt-1 block text-[0.92rem] leading-[1.55] text-[#6E6870]">{film.summary}</span>
            </span>
            <span className="shrink-0 rounded-full bg-[#F4F0ED] px-3 py-1 text-[0.8rem] text-[#6E6870]">{film.length}</span>
          </a>
        ))}
      </div>
    </VideoChrome>
  );
}
