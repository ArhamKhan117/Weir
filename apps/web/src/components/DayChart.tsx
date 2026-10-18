import type { IndexedDay } from "@weir/shared";

import { money } from "../lib/format";

const WIDTH = 600;
const HEIGHT = 140;
const GAP = 4;

function dayLabel(date: string): string {
  return new Date(`${date}T00:00:00Z`).toLocaleDateString(undefined, { month: "short", day: "numeric", timeZone: "UTC" });
}

function dayTitle(day: IndexedDay): string {
  const charges = `${money(BigInt(day.volume))}, ${day.charges} ${day.charges === 1 ? "charge" : "charges"}`;
  if (BigInt(day.meteredVolume) === 0n) return `${dayLabel(day.date)}: ${charges}`;
  return `${dayLabel(day.date)}: ${charges}; pay per request ${money(BigInt(day.meteredVolume))}`;
}

/**
 * Thirty days of volume as bars, today last and darkest. Mandate charges fill each bar from the
 * bottom and pay-per-request settlements sit on top in a lighter shade, with a key when there are
 * any. Each bar names its day and amounts on hover; the figures come from Envio HyperIndex.
 */
export function DayChart({ days, label }: { days: readonly IndexedDay[]; label: string }) {
  const charged = days.map((d) => Number(BigInt(d.volume)));
  const metered = days.map((d) => Number(BigInt(d.meteredVolume)));
  const max = Math.max(...days.map((_, i) => (charged[i] ?? 0) + (metered[i] ?? 0)), 1);
  const anyMetered = metered.some((value) => value > 0);
  const bar = (WIDTH - GAP * (days.length - 1)) / days.length;
  const first = days[0];
  const last = days.at(-1);
  return (
    <figure className="day-chart">
      <svg viewBox={`0 0 ${WIDTH} ${HEIGHT}`} preserveAspectRatio="none" role="img" aria-label={label}>
        {days.map((day, i) => {
          const fromCharges = charged[i] ?? 0;
          const fromMeters = metered[i] ?? 0;
          const total = fromCharges + fromMeters;
          const height = total === 0 ? 2 : Math.max(4, (total / max) * (HEIGHT - 8));
          // The metered share of the bar, at least visible when there is any.
          const top = fromMeters === 0 ? 0 : Math.min(height, Math.max(3, (fromMeters / total) * height));
          const today = i === days.length - 1;
          const x = i * (bar + GAP);
          const radius = Math.min(3, bar / 2);
          return (
            <g key={day.date} className="day-group">
              <title>{dayTitle(day)}</title>
              {total === 0 || fromCharges > 0 ? (
                <rect
                  x={x}
                  y={HEIGHT - height}
                  width={bar}
                  height={height}
                  rx={radius}
                  className={today ? "day-bar today" : total === 0 ? "day-bar quiet" : "day-bar"}
                />
              ) : null}
              {top > 0 ? (
                <rect x={x} y={HEIGHT - height} width={bar} height={top} rx={radius} className={today ? "day-bar metered today" : "day-bar metered"} />
              ) : null}
            </g>
          );
        })}
      </svg>
      <figcaption>
        <span>{first === undefined ? "" : dayLabel(first.date)}</span>
        {anyMetered ? (
          <span className="day-key" aria-hidden="true">
            <span className="day-key-swatch" />
            Subscriptions
            <span className="day-key-swatch metered" />
            Pay per request
          </span>
        ) : null}
        <span>{last === undefined ? "" : "Today"}</span>
      </figcaption>
    </figure>
  );
}
