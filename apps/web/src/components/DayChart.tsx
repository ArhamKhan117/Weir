import type { IndexedDay } from "@weir/shared";

import { money } from "../lib/format";

const WIDTH = 600;
const HEIGHT = 140;
const GAP = 4;

function dayLabel(date: string): string {
  return new Date(`${date}T00:00:00Z`).toLocaleDateString(undefined, { month: "short", day: "numeric", timeZone: "UTC" });
}

/**
 * Thirty days of volume as bars, today last and darkest. Each bar names its day and amount on
 * hover; the figures it draws come from Envio HyperIndex.
 */
export function DayChart({ days, label }: { days: readonly IndexedDay[]; label: string }) {
  const values = days.map((d) => Number(BigInt(d.volume)));
  const max = Math.max(...values, 1);
  const bar = (WIDTH - GAP * (days.length - 1)) / days.length;
  const first = days[0];
  const last = days.at(-1);
  return (
    <figure className="day-chart">
      <svg viewBox={`0 0 ${WIDTH} ${HEIGHT}`} preserveAspectRatio="none" role="img" aria-label={label}>
        {days.map((day, i) => {
          const value = values[i] ?? 0;
          const height = value === 0 ? 2 : Math.max(4, (value / max) * (HEIGHT - 8));
          return (
            <rect
              key={day.date}
              x={i * (bar + GAP)}
              y={HEIGHT - height}
              width={bar}
              height={height}
              rx={Math.min(3, bar / 2)}
              className={i === days.length - 1 ? "day-bar today" : value === 0 ? "day-bar quiet" : "day-bar"}
            >
              <title>{`${dayLabel(day.date)}: ${money(BigInt(day.volume))}, ${day.charges} ${day.charges === 1 ? "charge" : "charges"}`}</title>
            </rect>
          );
        })}
      </svg>
      <figcaption>
        <span>{first === undefined ? "" : dayLabel(first.date)}</span>
        <span>{last === undefined ? "" : "Today"}</span>
      </figcaption>
    </figure>
  );
}
