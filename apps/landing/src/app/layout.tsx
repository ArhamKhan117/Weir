import type { Metadata, Viewport } from "next";
import { Geist } from "next/font/google";
import type { ReactNode } from "react";
import "../index.css";

// Downloaded at build time and served from this site, so no page view reaches Google.
const geist = Geist({ subsets: ["latin"], weight: ["300", "400", "500", "600", "700"], variable: "--font-geist" });

export const metadata: Metadata = {
  title: "Weir",
  description:
    "Direct debit for digital dollars on Monad. Say yes once, with limits you set, keep the money until each charge is due, and stop any time.",
  icons: { icon: "/logo.svg" },
};

export const viewport: Viewport = {
  width: "device-width",
  initialScale: 1,
  themeColor: "#F4F0ED",
};

export default function RootLayout({ children }: { children: ReactNode }) {
  return (
    <html lang="en" className={geist.variable}>
      <head>
        {/* The hero paints these the moment the page opens; start them before the CSS asks. */}
        <link rel="preload" as="image" href="/media/hero-frame.avif" type="image/avif" />
        <link rel="preload" as="image" href="/media/hero-glow.avif" type="image/avif" />
      </head>
      <body>{children}</body>
    </html>
  );
}
