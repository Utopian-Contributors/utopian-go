import {
  JUP_CHART_ENDPOINT,
  TOKEN_TICKS_CONCURRENCY,
  TOKEN_TICKS_COUNT,
  TOKEN_TICKS_INTERVAL,
  TOKEN_TICKS_MIN_POINTS,
  TOKEN_TICKS_RETRIES,
  TOKEN_TICKS_RPS,
  TOKEN_TICKS_TIMEOUT_MS,
  TOKEN_TICKS_TTL_MS,
} from "../../config";
import { TokenRecord } from "../../types";

/**
 * The 24h shape of every indexed token, refreshed once per index rebuild.
 *
 * A sparkline needs a shape, not prices: nothing on the card is labelled with
 * a value read off the line. So the series is normalised to 24 bytes here and
 * shipped as base64 — 32 characters, about 33 bytes gzipped onto a quote,
 * against the four kilobytes a drawn image of the same line would cost. The
 * client scales those bytes to whatever box it has.
 *
 * Normalising server-side also keeps the scale decisions in one place, where
 * the flat-day floor below can be explained rather than reimplemented in the
 * browser.
 */

/**
 * Smallest move, as a fraction of price, that the full height may represent.
 *
 * Without a floor the scale is pure min-to-max, and a stablecoin that spent
 * the day within three hundredths of a percent of a dollar comes out looking
 * like a seismograph — the picture is all noise, magnified about a thousand
 * times. Two percent is well below an ordinary crypto day, so nothing that
 * actually moved is flattened, and everything that didn't reads as the flat
 * line it was.
 */
const MIN_SPAN = 0.02;

let updatedAt = 0;
let running = false;

export function ticksUpdatedAt(): number {
  return updatedAt;
}

/** True while the last refresh is recent enough that another would be waste. */
export function ticksFresh(): boolean {
  return !!updatedAt && Date.now() - updatedAt < TOKEN_TICKS_TTL_MS;
}

/** Adopt the timestamp a snapshot was written with. */
export function restoreTicks(at: unknown): void {
  updatedAt = Number(at) || 0;
}

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

/**
 * Earliest moment the next request may leave, shared across workers.
 *
 * The rate limit upstream is one budget for the whole refresh, so the pacing
 * has to be one budget too — six workers each politely spacing their own
 * requests would still add up to six times the intended rate.
 */
const GAP_MS = 1000 / TOKEN_TICKS_RPS;
let slot = 0;

/** Claim the next slot, waiting for it if it hasn't come round yet. */
async function pace(): Promise<void> {
  const now = Date.now();
  const at = Math.max(now, slot);
  slot = at + GAP_MS;
  if (at > now) await sleep(at - now);
}

/** 24h of closes, oldest first. Empty when there is no usable series. */
async function fetchSeries(mint: string): Promise<number[]> {
  for (let attempt = 0; ; attempt += 1) {
    await pace();

    const url =
      `${JUP_CHART_ENDPOINT}/${encodeURIComponent(mint)}` +
      `?interval=${TOKEN_TICKS_INTERVAL}` +
      `&candles=${TOKEN_TICKS_COUNT}` +
      `&to=${encodeURIComponent(new Date().toISOString())}`;

    const res = await fetch(url, {
      headers: { Accept: "application/json" },
      signal: AbortSignal.timeout(TOKEN_TICKS_TIMEOUT_MS),
    });

    if (res.status === 429) {
      if (attempt >= TOKEN_TICKS_RETRIES) return [];
      // Hold the shared slot back rather than this one request: being
      // throttled says the whole refresh is going too fast, and retrying alone
      // while five other workers keep pushing just fails again.
      slot = Math.max(slot, Date.now() + GAP_MS * 20 * (attempt + 1));
      continue;
    }
    if (!res.ok) return [];

    const body = (await res.json()) as { candles?: Array<{ close?: unknown }> };
    const closes: number[] = [];
    for (const candle of body.candles ?? []) {
      const close = Number(candle?.close);
      // A zero or missing close would flatten the whole scale around it.
      if (Number.isFinite(close) && close > 0) closes.push(close);
    }
    return closes;
  }
}

/**
 * Closes to one byte per point, base64.
 *
 * The range is thrown away deliberately — the card never labels the line, so
 * shipping the prices again would be shipping numbers nobody reads. What
 * survives is the shape, at 1/255th of its own range, which is finer than the
 * hundred-odd pixels of height it gets drawn into.
 */
export function encodeTicks(closes: number[]): string {
  let lo = Infinity;
  let hi = -Infinity;
  for (const v of closes) {
    if (v < lo) lo = v;
    if (v > hi) hi = v;
  }

  // Widen a too-narrow range around its own middle, so a day that barely moved
  // arrives as a line near the centre instead of as noise. Prices are
  // positive, so this also guarantees a non-zero span to divide by.
  const mid = (lo + hi) / 2;
  const minSpan = mid * MIN_SPAN;
  if (hi - lo < minSpan) {
    lo = mid - minSpan / 2;
    hi = mid + minSpan / 2;
  }

  const span = hi - lo;
  const bytes = Buffer.alloc(closes.length);
  for (let i = 0; i < closes.length; i += 1) {
    bytes[i] = Math.round(((closes[i] - lo) / span) * 255);
  }
  return bytes.toString("base64");
}

/**
 * Refresh every record's ticks in place.
 *
 * Each record is independent — there is no set to swap atomically, so a
 * refresh that dies half way just leaves the rest of the index on last hour's
 * shapes. Records are only ever given a series or left alone; a mint that
 * fails keeps whatever it had rather than losing its line for an hour.
 */
export async function refreshTicks(
  records: ReadonlyArray<TokenRecord>,
): Promise<void> {
  if (running) return;
  running = true;
  slot = 0;

  const started = Date.now();
  let ok = 0;
  let cursor = 0;

  const worker = async () => {
    while (cursor < records.length) {
      const rec = records[cursor++];
      try {
        const closes = await fetchSeries(rec.mint);
        if (closes.length < TOKEN_TICKS_MIN_POINTS) continue;
        rec.ticks = encodeTicks(closes);
        ok += 1;
      } catch {
        // One token's line is not worth a log line each hour; the card simply
        // renders with whatever it had.
      }
    }
  };

  try {
    await Promise.all(
      Array.from({ length: TOKEN_TICKS_CONCURRENCY }, () => worker()),
    );
    updatedAt = Date.now();
    // Both halves, because a refresh that quietly covers a tenth of the index
    // still looks like a success from the outside.
    console.log(
      `[ticks] ${ok} of ${records.length} series` +
        ` in ${Math.round((Date.now() - started) / 1000)}s`,
    );
  } finally {
    running = false;
  }
}
