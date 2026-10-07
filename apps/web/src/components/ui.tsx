import type { MandateStanding } from "@weir/shared";
import type { ComponentProps, ReactNode } from "react";

type Variant = "primary" | "secondary" | "ghost" | "danger";
type Size = "sm" | "md" | "lg";

export function Button({
  variant = "primary",
  size = "md",
  block = false,
  loading = false,
  children,
  className,
  disabled,
  ...rest
}: ComponentProps<"button"> & {
  variant?: Variant;
  size?: Size;
  block?: boolean;
  loading?: boolean;
}) {
  const classes = ["btn", `btn-${variant}`, size === "md" ? "" : `btn-${size}`, block ? "btn-block" : "", className ?? ""]
    .filter(Boolean)
    .join(" ");
  return (
    <button className={classes} disabled={disabled || loading} aria-busy={loading || undefined} {...rest}>
      {loading ? <span className="spinner" aria-hidden="true" /> : null}
      {children}
    </button>
  );
}

export function Alert({ tone = "neutral", children }: { tone?: "neutral" | "negative" | "caution" | "positive"; children: ReactNode }) {
  return (
    <div className={`alert${tone === "neutral" ? "" : ` alert-${tone}`}`} role={tone === "negative" ? "alert" : "status"}>
      {children}
    </div>
  );
}

const STANDING_TONE: Record<MandateStanding, string> = {
  Active: "badge-positive",
  Paused: "badge-caution",
  "Past due": "badge-negative",
  Cancelled: "",
  Expired: "",
  Completed: "badge-accent",
};

export function StandingBadge({ standing }: { standing: MandateStanding }) {
  return <span className={`badge ${STANDING_TONE[standing]}`}>{standing}</span>;
}

export function Skeleton({ width = "100%", height = 16 }: { width?: number | string; height?: number }) {
  return <span className="skeleton" style={{ display: "block", width, height }} aria-hidden="true" />;
}

export function CheckIcon({ size = 20 }: { size?: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="none" aria-hidden="true">
      <path d="M5 12.5l4.2 4.2L19 7" stroke="currentColor" strokeWidth="2.4" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  );
}

export function PasskeyIcon({ size = 20 }: { size?: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="none" aria-hidden="true">
      <circle cx="9" cy="8" r="4" stroke="currentColor" strokeWidth="2" />
      <path d="M2.5 20c.6-3.6 3.3-5.5 6.5-5.5 1.1 0 2.1.2 3 .7" stroke="currentColor" strokeWidth="2" strokeLinecap="round" />
      <circle cx="17.5" cy="14.5" r="2.5" stroke="currentColor" strokeWidth="2" />
      <path d="M17.5 17v4.5m0-2h1.8" stroke="currentColor" strokeWidth="2" strokeLinecap="round" />
    </svg>
  );
}

export function LockIcon({ size = 16 }: { size?: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="none" aria-hidden="true">
      <rect x="4.5" y="10.5" width="15" height="10" rx="2.5" stroke="currentColor" strokeWidth="2" />
      <path d="M8 10.5V7.5a4 4 0 0 1 8 0v3" stroke="currentColor" strokeWidth="2" strokeLinecap="round" />
    </svg>
  );
}
