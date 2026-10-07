import type { ReactNode } from "react";

import { APP_URL } from "../../app-url";

/** The videos pages' frame: the Weir mark home, a way into the app, and the page. */
export function VideoChrome({ children }: { children: ReactNode }) {
  return (
    <div className="min-h-screen bg-[#F4F0ED] text-[#18161B]">
      <header className="mx-auto flex w-full max-w-[1100px] items-center justify-between px-5 py-6">
        <a href="/" className="flex items-center gap-3 no-underline">
          <img src="/logo.svg" alt="" width={28} height={28} className="h-7 w-7" />
          <span className="text-[1.05rem] font-medium tracking-[0.06em]">WEIR</span>
        </a>
        <a href={APP_URL} className="rounded-full bg-[#18161B] px-5 py-2.5 text-[0.9rem] font-medium text-white no-underline transition-transform duration-200 hover:-translate-y-0.5">
          Open the app
        </a>
      </header>
      <main className="mx-auto w-full max-w-[1100px] px-5 pb-24">{children}</main>
    </div>
  );
}

export function DownloadIcon() {
  return (
    <svg viewBox="0 0 24 24" width={18} height={18} fill="none" stroke="currentColor" strokeWidth={2} strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <path d="M12 4v11m0 0l-4.5-4.5M12 15l4.5-4.5M5 19h14" />
    </svg>
  );
}
