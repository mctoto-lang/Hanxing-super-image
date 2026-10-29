"use client";

import { type ClassValue, clsx } from "clsx";
import { ArrowUpRight } from "lucide-react";
import { animate, motion, useMotionValue, useTransform } from "motion/react";
import {
  type ChangeEvent,
  type PointerEvent,
  type SyntheticEvent,
  useCallback,
  useEffect,
  useId,
  useState,
  useSyncExternalStore,
} from "react";
import { twMerge } from "tailwind-merge";

function cn(...inputs: ClassValue[]) {
  return twMerge(clsx(inputs));
}

const REDUCED_MOTION = "(prefers-reduced-motion: reduce)";
const reducesMotion = () => !!window.matchMedia?.(REDUCED_MOTION).matches;
/** Follows the setting while mounted (Motion's own hook reads it once). */
function watchMotion(change: () => void) {
  const query = window.matchMedia?.(REDUCED_MOTION);
  query?.addEventListener("change", change);
  return () => query?.removeEventListener("change", change);
}

export type KpiTileProps = {
  /** What is measured, e.g. "Revenue"; also the tile's accessible name. */
  label: string;
  /** The current value; leave it out (or pass NaN) when there is no data. */
  value?: number;
  /** Formats the value and the points. Default: en-US, up to one decimal. */
  format?: (value: number) => string;
  /** Change in percent (4.2), and what it is measured against ("vs last week"). */
  delta?: number;
  deltaLabel?: string;
  /** Latency, churn, errors: a drop is the good news. */
  lowerIsBetter?: boolean;
  /** Recent values, oldest first (the sparkline), and their names ("Oct 13"), shown and read. */
  trend?: readonly number[];
  trendLabels?: readonly string[];
  /** Mark every point of the line with a dot (e.g. a fixed set of daily nodes). */
  showPoints?: boolean;
  /** Points from this index on are future bookings (e.g. pickup days still ahead):
   *  hollow dots, not joined by the line, left out of the value scale. */
  futureFrom?: number;
  /** New values keep coming: the newest point pulses. */
  live?: boolean;
  /** Skeletons while the first numbers load. */
  loading?: boolean;
  className?: string;
};

/** Direction and meaning of a change: growth is good news, unless lower is better. */
export function deltaTone(delta: number, lowerIsBetter = false) {
  const direction = delta > 0 ? "up" : delta < 0 ? "down" : "flat";
  const tone = (direction === "up") === lowerIsBetter ? "negative" : "positive";
  return { direction, tone: direction === "flat" ? "neutral" : tone } as const;
}

/** Theme roles only: good news in `primary`, bad news in `destructive` (text, tint). */
const TONES = {
  negative: ["text-destructive", "bg-destructive/10"],
  neutral: ["text-muted-foreground", "bg-muted"],
  positive: ["text-primary", "bg-primary/10"],
} as const;
const TURN = { down: "rotate-90", flat: "rotate-45", up: "rotate-0" } as const;
const WORD = { down: "Down", flat: "No change", up: "Up" } as const;

const [W, H, PAD] = [100, 40, 3]; // the drawing's own box, stretched to the tile's width
const EASE = [0.22, 1, 0.36, 1] as const;
const INSTANT = { duration: 0 } as const;
/** Tweens, not springs (roll, morph, draw): a value that moves on never trails behind the next. */
const tween = (duration: number) => ({ duration, ease: EASE });
const [ROLL, MORPH, DRAW] = [0.6, 0.5, 0.9].map(tween);
const SKELETON =
  "block animate-pulse rounded-md bg-muted motion-reduce:animate-none";
const VALUE =
  "font-semibold text-2xl text-foreground tabular-nums leading-none tracking-tight sm:text-3xl";
const TILE =
  "flex min-w-0 flex-col gap-3 rounded-xl border border-border bg-card p-4 text-card-foreground shadow-xs";
const LABEL = "truncate font-medium text-muted-foreground text-sm";
const BADGE =
  "inline-flex items-center gap-0.5 rounded-full px-1.5 py-0.5 font-medium text-foreground text-xs tabular-nums";
const ARROW =
  "size-3.5 transition-transform duration-500 motion-reduce:transition-none";
const SPARK =
  "relative min-h-14 flex-1 rounded-sm has-[:focus-visible]:outline-hidden has-[:focus-visible]:ring-2 has-[:focus-visible]:ring-ring has-[:focus-visible]:ring-offset-2 has-[:focus-visible]:ring-offset-card";
const CAPTION = "-mt-1.5 min-h-4 truncate text-muted-foreground text-xs";
const PING =
  "absolute inset-0 animate-ping rounded-full bg-current motion-reduce:hidden";
const DOT =
  "pointer-events-none absolute size-2 -translate-x-1/2 -translate-y-1/2 rounded-full bg-current motion-reduce:transition-none";
const decimal = new Intl.NumberFormat("en-US", { maximumFractionDigits: 1 });

type Point = { label: string; value: number; x: number; y: number; future: boolean };

/** The finite values with their labels, in the W × H box, scaled to their own range.
 *  Points from `futureFrom` on are future bookings: they keep their slot on the x axis
 *  but stay out of the value range — the line stops before them. */
function placePoints(trend: readonly number[], labels?: readonly string[], futureFrom?: number) {
  const kept = trend.flatMap((value, index) =>
    Number.isFinite(value)
      ? [{ label: labels?.[index] ?? "", value, future: index >= (futureFrom ?? trend.length) }]
      : []
  );
  const past = kept.filter((point) => !point.future);
  const scale = past.length ? past : kept;
  const min = Math.min(...scale.map((point) => point.value));
  const span = Math.max(...scale.map((point) => point.value)) - min;
  // x slots spread over every point, so a stopped line still leaves room for the future ones
  const step = (W - PAD * 2) / Math.max(kept.length - 1, 1);
  const yOf = (value: number) =>
    span ? H - PAD - ((value - min) / span) * (H - PAD * 2) : H / 2;
  return kept.map(
    ({ label, value, future }, index): Point => ({
      label: label || `${index + 1} of ${kept.length}`,
      value,
      x: PAD + index * step,
      // A flat line sits in the middle; a booked future value clamps into the box.
      y: future ? Math.min(Math.max(yOf(value), PAD), H - PAD) : yOf(value),
      future,
    })
  );
}

/** Where a point is, in percent of the box: a dot over the stretched drawing stays round. */
const spot = (point: Point) => ({
  left: `${(point.x / W) * 100}%`,
  top: `${(point.y / H) * 100}%`,
});

/**
 * A compact KPI: the value, rolling to each new one, its change and a sparkline. Under a pointer,
 * or with the arrow keys on the line, a point's value and label take the headline's place.
 */
export function KpiTile({
  label,
  value,
  format = decimal.format,
  delta,
  deltaLabel,
  lowerIsBetter = false,
  trend = [],
  trendLabels,
  showPoints = false,
  futureFrom,
  live = false,
  loading = false,
  className,
}: KpiTileProps) {
  // The server cannot know it: hydration starts with motion, then follows the setting.
  const reduced = useSyncExternalStore(watchMotion, reducesMotion, () => false);
  const id = useId();
  const [active, setActive] = useState(null as number | null);
  const points = placePoints(trend, trendLabels, futureFrom);
  const last = points.length - 1;
  if (active !== null && (loading || last < 1)) {
    setActive(null); // nothing left to pick from: a day picked before is forgotten
  }
  const at = active === null || last < 1 ? null : Math.min(active, last);
  const point = at === null ? undefined : points[at];
  const past = points.filter((p) => !p.future);
  const end = past[past.length - 1];
  const isEmpty = value === undefined || !Number.isFinite(value);
  const hasDelta = delta !== undefined && Number.isFinite(delta) && !isEmpty;
  const { direction, tone } = deltaTone(hasDelta ? delta : 0, lowerIsBetter);
  const [toneText, toneTint] = TONES[tone];

  // The headline, a picked day or else the rolling value, is one MotionValue: one subscription.
  const target = isEmpty ? 0 : value;
  const shown = useMotionValue(target);
  const text = useTransform(() => {
    const now = format(shown.get());
    return point ? format(point.value) : isEmpty ? "—" : now;
  });
  useEffect(() => {
    const roll = animate(shown, target, reduced ? INSTANT : ROLL);
    return () => roll.stop();
  }, [reduced, shown, target]);

  const pick = useCallback(
    (event: PointerEvent<SVGSVGElement>) => {
      const box = event.currentTarget.getBoundingClientRect();
      const x = ((event.clientX - box.left) / Math.max(box.width, 1)) * W;
      const index = Math.round(((x - PAD) / (W - PAD * 2)) * last);
      setActive(last < 1 ? null : Math.min(Math.max(index, 0), last));
    },
    [last]
  );
  // A day stays while the pointer is on the tile or the focus on the line; Escape ends it (1.4.13).
  const letGo = useCallback((event: SyntheticEvent) => {
    const other = event.type === "blur" ? ":hover" : ":focus-within";
    const tile = event.currentTarget.closest("article");
    return tile?.matches(other) || setActive(null);
  }, []);
  const onRange = useCallback(
    (event: ChangeEvent<HTMLInputElement>) =>
      setActive(Number(event.target.value)),
    []
  );
  const onFocus = useCallback(() => setActive((now) => now ?? last), [last]);
  useEffect(() => {
    const dismiss = ({ key }: globalThis.KeyboardEvent) =>
      key === "Escape" && setActive(null);
    document.addEventListener("keydown", dismiss);
    return () => document.removeEventListener("keydown", dismiss);
  }, []);

  // The line (and its area) walk the past points only; a future booking is a dot, not a bend.
  const line = past.map((p, i) => `${i ? "L" : "M"}${p.x} ${p.y}`).join(" ");
  const area = end ? `${line} L${end.x} ${H} L${PAD} ${H} Z` : "";
  const read = point ?? end;

  return (
    <article
      aria-busy={loading || undefined}
      aria-labelledby={`${id}-label`}
      className={cn(TILE, className)}
      data-slot="kpi-tile"
      onPointerLeave={letGo}
    >
      <p className={LABEL} id={`${id}-label`}>
        {label}
      </p>
      {loading ? (
        ["h-8 w-28", "h-3 w-20", "h-10"].map((size) => (
          <span
            className={cn(SKELETON, size)}
            data-slot="kpi-skeleton"
            key={size}
          />
        ))
      ) : (
        <>
          <div className="flex flex-wrap items-baseline gap-x-2 gap-y-1">
            <motion.span
              aria-hidden="true"
              className={cn(
                VALUE,
                isEmpty && !point && "text-muted-foreground"
              )}
              data-slot="kpi-value"
            >
              {text}
            </motion.span>
            {isEmpty ? null : <span className="sr-only">{format(value)}</span>}
            {hasDelta ? (
              <span
                className={cn(BADGE, toneTint)}
                data-direction={direction}
                data-slot="kpi-delta"
                data-tone={tone}
              >
                <span className="sr-only">{`${WORD[direction]} `}</span>
                <ArrowUpRight
                  aria-hidden="true"
                  className={cn(ARROW, toneText, TURN[direction])}
                />
                {`${Math.abs(delta).toFixed(1)}%`}
              </span>
            ) : null}
          </div>
          <p className={CAPTION} data-slot="kpi-caption">
            {point ? point.label : isEmpty ? "No data yet" : deltaLabel}
          </p>
          <div
            className={cn(SPARK, hasDelta ? toneText : "text-primary")}
            data-slot="kpi-sparkline"
          >
            <svg
              aria-hidden="true"
              // absolute: an in-flow svg would contribute its viewBox aspect ratio
              // (width ÷ 2.5) as intrinsic min height, pinning the tile tall.
              className="absolute inset-0 block size-full touch-pan-y overflow-visible"
              onPointerDown={pick}
              onPointerMove={pick}
              preserveAspectRatio="none"
              viewBox={`0 0 ${W} ${H}`}
            >
              <defs>
                <linearGradient id={`${id}-fill`} x1="0" x2="0" y1="0" y2="1">
                  <stop offset="0" stopColor="currentColor" stopOpacity={0.2} />
                  <stop offset="1" stopColor="currentColor" stopOpacity={0} />
                </linearGradient>
                <clipPath id={`${id}-clip`}>
                  <motion.rect
                    animate={{ width: W + PAD * 2 }}
                    data-slot="kpi-sweep"
                    height={H + PAD * 2}
                    initial={{ width: 0 }}
                    key={String(reduced)}
                    transition={reduced ? INSTANT : DRAW}
                    x={-PAD}
                    y={-PAD}
                  />
                </clipPath>
              </defs>
              {past.length < 2 ? (
                <path
                  className="stroke-current opacity-50 [stroke-dasharray:3_4]"
                  d={`M${PAD} ${H / 2} H${W - PAD}`}
                  vectorEffect="non-scaling-stroke"
                />
              ) : (
                // New values of as many points morph the line; another count draws it anew.
                <g clipPath={`url(#${id}-clip)`}>
                  <motion.path
                    animate={{ d: area }}
                    fill={`url(#${id}-fill)`}
                    initial={false}
                    key={`area-${points.length}-${reduced}`}
                    transition={reduced ? INSTANT : MORPH}
                  />
                  <motion.path
                    animate={{ d: line }}
                    data-slot="kpi-line"
                    fill="none"
                    initial={false}
                    key={`line-${points.length}-${reduced}`}
                    stroke="currentColor"
                    strokeLinecap="round"
                    strokeLinejoin="round"
                    strokeWidth={2}
                    transition={reduced ? INSTANT : MORPH}
                    vectorEffect="non-scaling-stroke"
                  />
                </g>
              )}
            </svg>
            {showPoints
              ? points.map((p, i) =>
                  // The picked point wears the bigger dot below; a future booking is hollow.
                  i === at ? null : p.future ? (
                    <span
                      className={cn(DOT, "size-1.5 border border-current bg-card opacity-50")}
                      key={i}
                      style={spot(p)}
                    />
                  ) : (
                    <span className={cn(DOT, "size-1.5")} key={i} style={spot(p)} />
                  ),
                )
              : null}
            {live && points.length > 1 && end ? (
              <span
                className={cn(DOT, "transition-[left,top] duration-500")}
                style={spot(end)}
              >
                <span className={PING} data-slot="kpi-pulse" />
              </span>
            ) : null}
            {point ? (
              <span
                className={cn(
                  DOT,
                  "size-2.5",
                  point.future ? "border-2 border-current bg-card" : "border-2 border-card",
                )}
                data-slot="kpi-point"
                style={spot(point)}
              />
            ) : null}
            {points.length > 1 && read ? (
              <input
                aria-label={`${label} trend`}
                aria-valuetext={`${read.label}: ${format(read.value)}`}
                className="sr-only"
                max={last}
                onBlur={letGo}
                onChange={onRange}
                onFocus={onFocus}
                type="range"
                value={at ?? last}
              />
            ) : null}
          </div>
        </>
      )}
    </article>
  );
}

export default KpiTile;
