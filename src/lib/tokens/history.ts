import { ChartRange, PriceSeries, TokenRecord } from "../../types";
import { ChartsBusy, INTERVAL_MS, Interval, decodeTicks, fetchCandles, onClock } from "./ticks";

/**
 * A token's price over the ranges a chart offers besides 24h, fetched when
 * someone asks for one.
 *
 * 24h needs nothing: every record already carries its day as hourly ticks,
 * refreshed for the whole index each hour. The other ranges are not worth
 * that — a thousand series an hour, three times over, for tokens most of
 * which nobody will chart — so they are asked for one mint at a time, kept
 * for about as long as their last bucket stays current, and shared by
 * everyone who looks.
 */

interface Window {
  interval: Interval;
  /** Buckets in the window. */
  count: number;
  /** How long an answer is served before it is asked for again. */
  ttl: number;
}

/**
 * About as many points as a chart a few hundred pixels wide can show apart,
 * each on the coarsest candle that still gives that many.
 */
const WINDOWS: Record<Exclude<ChartRange, "24h">, Window> = {
  "1h": { interval: "1_MINUTE", count: 60, ttl: 60_000 },
  "1w": { interval: "1_HOUR", count: 168, ttl: 10 * 60_000 },
  "1m": { interval: "4_HOUR", count: 180, ttl: 30 * 60_000 },
};

export const CHART_RANGES: readonly ChartRange[] = ["1h", "24h", "1w", "1m"];

export function isChartRange(v: unknown): v is ChartRange {
  return CHART_RANGES.includes(v as ChartRange);
}

/** The width of a range's buckets, in ms. */
export function stepOf(range: ChartRange): number {
  return range === "24h" ? INTERVAL_MS["1_HOUR"] : INTERVAL_MS[WINDOWS[range].interval];
}

/** Buckets in a range's window. */
export function countOf(range: ChartRange, day: number): number {
  return range === "24h" ? day : WINDOWS[range].count;
}

/** After a failed fetch, wait this long before asking upstream again. */
const RETRY_MS = 30_000;
/** Mints times ranges. A busy hour opens a few hundred. */
const MAX_CACHED = 2_000;

const cache = new Map<string, { at: number; series: PriceSeries | null; triedAt: number }>();
const inFlight = new Map<string, Promise<PriceSeries | null>>();

function remember(key: string, entry: { at: number; series: PriceSeries | null; triedAt: number }): void {
  cache.delete(key);
  cache.set(key, entry);
  if (cache.size > MAX_CACHED) cache.delete(cache.keys().next().value!);
}

/** Seven significant figures: a price to the cent up to $100,000, and a fraction of one below. */
function round(v: number): number {
  return Number(v.toPrecision(7));
}

/** The record's own day, read back out of its ticks. */
export function daySeries(rec: TokenRecord): PriceSeries | null {
  const v = decodeTicks(rec);
  if (!v) return null;
  const step = INTERVAL_MS["1_HOUR"];
  // A snapshot from before the hour was kept: the last refresh is within the hour.
  const at = rec.tickAt ?? Math.floor(Date.now() / step) * step;
  return { at, step, v: v.map(round) };
}

async function fetchSeries(mint: string, range: Exclude<ChartRange, "24h">): Promise<PriceSeries | null> {
  const { interval, count } = WINDOWS[range];
  const step = INTERVAL_MS[interval];
  const { at, closes } = onClock(await fetchCandles(mint, interval, count, true), step, count);
  return closes.length < 2 ? null : { at, step, v: closes.map(round) };
}

/**
 * The record's price across `range`, or null when it has too little history
 * for one, or the chart API could not be asked. A failure never replaces an
 * answer already held: a few minutes stale is still the right shape.
 */
export async function priceSeries(rec: TokenRecord, range: ChartRange): Promise<PriceSeries | null> {
  if (range === "24h") return daySeries(rec);
  const key = `${range}:${rec.mint}`;
  const now = Date.now();
  const hit = cache.get(key);
  if (hit && (now - hit.at < WINDOWS[range].ttl || now - hit.triedAt < RETRY_MS)) return hit.series;
  let task = inFlight.get(key);
  if (!task) {
    task = fetchSeries(rec.mint, range)
      .then((series) => {
        const at = Date.now();
        remember(key, { at, series, triedAt: at });
        return series;
      })
      .catch((err: unknown) => {
        if (!(err instanceof ChartsBusy)) console.warn(`[charts] ${range} failed for ${rec.mint}:`, err);
        const prior = cache.get(key);
        remember(key, { at: prior?.at ?? 0, series: prior?.series ?? null, triedAt: Date.now() });
        return prior?.series ?? null;
      })
      .finally(() => inFlight.delete(key));
    inFlight.set(key, task);
  }
  return task;
}
