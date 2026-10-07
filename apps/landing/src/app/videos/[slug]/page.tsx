import type { Metadata } from "next";
import { notFound } from "next/navigation";

import { FILMS, filmBySlug } from "../../../videos";
import { DownloadIcon, VideoChrome } from "../chrome";

const SITE = "https://weirpay.vercel.app";

export function generateStaticParams() {
  return FILMS.map((film) => ({ slug: film.slug }));
}

export async function generateMetadata({ params }: { params: Promise<{ slug: string }> }): Promise<Metadata> {
  const film = filmBySlug((await params).slug);
  if (film === undefined) return {};
  return {
    title: `${film.title} | Weir`,
    description: film.summary,
    openGraph: {
      title: film.title,
      description: film.summary,
      type: "video.other",
      images: [{ url: `${SITE}${film.poster}`, width: 1920, height: 1080 }],
      videos: [{ url: `${SITE}${film.file}`, type: "video/mp4", width: 1920, height: 1080 }],
    },
    twitter: { card: "summary_large_image", title: film.title, description: film.summary, images: [`${SITE}${film.poster}`] },
  };
}

export default async function FilmPage({ params }: { params: Promise<{ slug: string }> }) {
  const film = filmBySlug((await params).slug);
  if (film === undefined) notFound();
  return (
    <VideoChrome>
      <div className="mt-6 overflow-hidden rounded-[24px] bg-black shadow-[0_30px_80px_rgba(40,30,60,0.18)]">
        {/* Plays on arrival, muted as browsers require; the controls unmute it. */}
        <video src={film.file} poster={film.poster} controls autoPlay muted playsInline preload="auto" className="block aspect-video w-full" />
      </div>
      <div className="mt-8 flex flex-col gap-6 md:flex-row md:items-start md:justify-between">
        <div className="max-w-[680px]">
          <p className="text-[0.8rem] font-medium uppercase tracking-[0.22em] text-[#0E6E64]">
            {film.kind} &middot; {film.length}
          </p>
          <h1 className="mt-2 text-[clamp(2rem,5vw,3rem)] font-normal leading-[1.08] tracking-[-0.03em]">{film.title}</h1>
          <p className="mt-3 text-[1.02rem] leading-[1.65] text-[#6E6870]">{film.summary}</p>
        </div>
        <div className="flex shrink-0 flex-wrap gap-3">
          <a href={film.file} download className="inline-flex items-center gap-2 rounded-full bg-[#18161B] px-6 py-3 text-[0.95rem] font-medium text-white no-underline">
            <DownloadIcon /> Download mp4 ({film.size})
          </a>
          <a href="/videos" className="rounded-full border border-[#E2DCD7] bg-white px-6 py-3 text-[0.95rem] font-medium text-[#18161B] no-underline">
            All videos
          </a>
        </div>
      </div>
    </VideoChrome>
  );
}
