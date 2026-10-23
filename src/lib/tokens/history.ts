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

/** Hourly candles one call brings back: about twelve weeks. */
const PAST_HOURS = 2_000;
/** Daily ones before those, which reach back past anything held here. */
const PAST_DAYS = 2_000;
/**
 * Mints whose past is held. A series is up to a few thousand numbers, so
 * this is a fraction of the chart cache's bound.
 */
const PAST_MAX_CACHED = 500;

/**
 * A price newer than a held past is read off its last point for this long,
 * rather than the whole past asked for again: the case of a token the index
 * carries no day for, traded within the hour.
 */
const PAST_FRESH_MS = 10 * 60_000;

/** A mint's past as fetched: asked back to `from`, at `to`; `failed` when the last ask was refused. */
interface Past {
  from: number;
  to: number;
  failed?: number;
  series: PriceSeries[];
}

const past = new Map<string, Past>();
const pastInFlight = new Map<string, Promise<PriceSeries[] | null>>();

function rememberPast(mint: string, entry: Past): void {
  past.delete(mint);
  past.set(mint, entry);
  if (past.size > PAST_MAX_CACHED) past.delete(past.keys().next().value!);
}

/** Candles of `interval` onto the clock from `from` up to `to`, `max` at most. */
async function pastOn(mint: string, interval: Interval, from: number, to: number, max: number): Promise<PriceSeries | null> {
  const step = INTERVAL_MS[interval];
  const count = Math.min(max, Math.ceil((to - from) / step) + 2);
  const { at, closes } = onClock(await fetchCandles(mint, interval, count, true, to), step, count, to);
  return closes.length ? { at, step, v: closes.map(round) } : null;
}

async function fetchPast(mint: string, from: number): Promise<PriceSeries[]> {
  const now = Date.now();
  const hourly = await pastOn(mint, "1_HOUR", from, now, PAST_HOURS);
  const reach = now - PAST_HOURS * INTERVAL_MS["1_HOUR"];
  const daily = from < reach ? await pastOn(mint, "1_DAY", from, reach, PAST_DAYS) : null;
  return [hourly, daily].filter((s): s is PriceSeries => s != null);
}

/**
 * A token's price from `from` up to `to`, for what a wallet paid for it
 * (lib/entries.ts): hourly across the last twelve weeks, finest first, and
 * daily before that when `from` reaches further. A past that has happened
 * does not change, so an answer is kept for as long as it reaches far enough
 * back and there is room, and shared by every wallet that traded the token.
 *
 * Empty when there is no history that far. Null when the chart API could not
 * be asked, or `budget`, the tokens one wallet may still have fetched, has
 * run out: an answer that may yet come, where empty is one that will not. A
 * token already held, or on its way, costs nothing from it.
 */
export async function pastSeries(
  mint: string,
  from: number,
  to: number,
  budget?: { left: number },
): Promise<PriceSeries[] | null> {
  const now = Date.now();
  const hit = past.get(mint);
  if (hit && hit.from <= from && (hit.to >= to || now - hit.to < PAST_FRESH_MS)) return hit.series;
  if (hit?.failed && now - hit.failed < RETRY_MS) return null;
  let task = pastInFlight.get(mint);
  if (!task) {
    if (budget && budget.left-- <= 0) return null;
    // Never less far back than already held, so wallets that traded the
    // same token at different times do not take turns pushing each other out.
    const back = Math.min(from, hit?.from ?? from);
    task = fetchPast(mint, back)
      .then((series) => {
        rememberPast(mint, { from: back, to: now, series });
        return series;
      })
      .catch((err: unknown) => {
        if (!(err instanceof ChartsBusy)) console.warn(`[charts] past failed for ${mint}:`, err);
        const prior = past.get(mint);
        rememberPast(mint, { from: prior?.from ?? Infinity, to: prior?.to ?? 0, failed: Date.now(), series: prior?.series ?? [] });
        return null;
      })
      .finally(() => pastInFlight.delete(mint));
    pastInFlight.set(mint, task);
  }
  return task;
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
