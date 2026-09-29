import { useEffect, useRef } from "react";

const RADIUS = 260;

/**
 * A second image revealed in a soft circle that follows the cursor, as on the marketing site: the
 * hero's glow over its photograph, the flooded tile over the still one. `image` is one of the
 * `.img-*` classes in pages.css, which carry the AVIF and WebP pair.
 *
 * Only pointers that hover get it; on touch the layer stays hidden, since there is no cursor to
 * follow. Nothing runs while the element is off screen.
 */
export function Spotlight({ image, radius = RADIUS }: { image: string; radius?: number }) {
  const layer = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const el = layer.current;
    if (el === null || !window.matchMedia("(hover: hover)").matches) return;

    const size = radius * 2;
    const canvas = document.createElement("canvas");
    canvas.width = size;
    canvas.height = size;
    const context = canvas.getContext("2d");
    if (context === null) return;
    const gradient = context.createRadialGradient(radius, radius, 0, radius, radius, radius);
    gradient.addColorStop(0, "rgba(255,255,255,1)");
    gradient.addColorStop(0.4, "rgba(255,255,255,1)");
    gradient.addColorStop(0.6, "rgba(255,255,255,0.75)");
    gradient.addColorStop(0.75, "rgba(255,255,255,0.4)");
    gradient.addColorStop(0.88, "rgba(255,255,255,0.12)");
    gradient.addColorStop(1, "rgba(255,255,255,0)");
    context.fillStyle = gradient;
    context.fillRect(0, 0, size, size);
    const mask = `url(${canvas.toDataURL()})`;
    el.style.setProperty("mask-image", mask);
    el.style.setProperty("-webkit-mask-image", mask);
    el.style.setProperty("mask-repeat", "no-repeat");
    el.style.setProperty("-webkit-mask-repeat", "no-repeat");
    el.style.opacity = "1";

    // Starts far off the layer, so nothing shows until the cursor arrives.
    const target = { x: -size * 2, y: -size * 2 };
    const smooth = { ...target };
    let frame = 0;
    let visible = false;

    const onMove = (event: MouseEvent) => {
      const rect = el.getBoundingClientRect();
      target.x = event.clientX - rect.left;
      target.y = event.clientY - rect.top;
    };
    const tick = () => {
      smooth.x += (target.x - smooth.x) * 0.1;
      smooth.y += (target.y - smooth.y) * 0.1;
      const position = `${smooth.x - radius}px ${smooth.y - radius}px`;
      el.style.setProperty("mask-position", position);
      el.style.setProperty("-webkit-mask-position", position);
      frame = visible ? requestAnimationFrame(tick) : 0;
    };
    const observer = new IntersectionObserver(([entry]) => {
      visible = entry?.isIntersecting ?? false;
      if (visible && frame === 0) frame = requestAnimationFrame(tick);
    });
    observer.observe(el);
    window.addEventListener("mousemove", onMove);
    return () => {
      observer.disconnect();
      window.removeEventListener("mousemove", onMove);
      cancelAnimationFrame(frame);
    };
  }, [radius]);

  return <div ref={layer} className={`spotlight ${image}`} aria-hidden="true" />;
}
