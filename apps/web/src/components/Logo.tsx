/**
 * The Weir mark: water running evenly over a crest. Three even ripples above a straight line,
 * the steady, capped flow a mandate allows.
 */
export function Mark({ size = 28 }: { size?: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 32 32" aria-hidden="true">
      <rect width="32" height="32" rx="9" fill="var(--accent)" />
      <g fill="none" stroke="var(--accent-ink)" strokeWidth="2.2" strokeLinecap="round">
        <path d="M7.5 10.5c1.6 0 1.6 1.6 3.2 1.6s1.6-1.6 3.2-1.6 1.6 1.6 3.2 1.6 1.6-1.6 3.2-1.6 1.6 1.6 3.2 1.6" />
        <path d="M7.5 15.5c1.6 0 1.6 1.6 3.2 1.6s1.6-1.6 3.2-1.6 1.6 1.6 3.2 1.6 1.6-1.6 3.2-1.6 1.6 1.6 3.2 1.6" opacity="0.7" />
        <path d="M7.5 22.5h17" />
      </g>
    </svg>
  );
}

export function Wordmark() {
  return (
    <span className="brand">
      <Mark />
      Weir
    </span>
  );
}
