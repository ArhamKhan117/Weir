import { type CSSProperties, useEffect, useRef } from "react";
import type { VideoSource } from "../media";

/**
 * A silent loop that costs nothing until it is nearly on screen, and stops while it is off it.
 *
 * `preload="none"` keeps every below-the-fold clip off the network on first load; the observer
 * starts one a little before it scrolls in and pauses it once it leaves, so only what is visible
 * decodes. With reduced motion asked for, the poster stands in and nothing plays.
 *
 * `muted` is also set through the ref: React does not always reflect the prop as an attribute, and
 * an unmuted video is blocked from autoplaying.
 */
export function LazyVideo({
  sources,
  poster,
  className,
  style,
}: {
  sources: VideoSource[];
  poster?: string;
  className?: string;
  style?: CSSProperties;
}) {
  const ref = useRef<HTMLVideoElement>(null);

  useEffect(() => {
    const video = ref.current;
    if (!video) return;
    video.muted = true;
    if (window.matchMedia("(prefers-reduced-motion: reduce)").matches) return;
    if (typeof IntersectionObserver === "undefined") {
      void video.play().catch(() => {});
      return;
    }
    const observer = new IntersectionObserver(
      ([entry]) => {
        if (entry?.isIntersecting) void video.play().catch(() => {});
        else video.pause();
      },
      { rootMargin: "300px 0px" },
    );
    observer.observe(video);
    return () => observer.disconnect();
  }, []);

  return (
    <video
      ref={ref}
      className={className}
      style={style}
      poster={poster}
      loop
      muted
      playsInline
      preload="none"
      aria-hidden
    >
      {sources.map((source) => (
        <source key={source.src} src={source.src} type={source.type} />
      ))}
    </video>
  );
}
