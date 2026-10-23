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
 * The 24h shape of every indexed token, refreshed once per index rebuild, and
 * the one door to Jupiter's chart API — lib/tokens/history.ts asks through it
 * for the other ranges.
 *
 * The series is normalised to 24 bytes here and shipped as base64 — 32
 * characters, about 33 bytes gzipped onto a quote, against the four kilobytes
 * a drawn image of the same line would cost. The client scales those bytes to
 * whatever box it has, and reads prices back off them with the range.
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

/** The candle widths asked for, in ms. */
export const INTERVAL_MS = {
  "1_MINUTE": 60_000,
  "1_HOUR": 3_600_000,
  "4_HOUR": 14_400_000,
  "1_DAY": 86_400_000,
} as const;

export type Interval = keyof typeof INTERVAL_MS;

const TICKS_INTERVAL = TOKEN_TICKS_INTERVAL as Interval;

/**
 * Earliest moment the next request may leave, shared by every caller.
 *
 * The rate limit upstream is one budget for this server, so the pacing has to
 * be one budget too — six workers each politely spacing their own requests
 * would still add up to six times the intended rate.
 */
const GAP_MS = 1000 / TOKEN_TICKS_RPS;
let slot = 0;

/**
 * Callers waiting for a slot, in two lanes. Someone who has just asked for a
 * chart goes ahead of the hourly refresh, which nobody is watching and which
 * only finishes a few seconds later for it. Both lanes share the one rate.
 */
const lanes = { now: [] as Array<() => void>, later: [] as Array<() => void> };
let timer: NodeJS.Timeout | undefined;

/**
 * How many people may be waiting at once. Six a second clears this in ten
 * seconds; past it, a chart nobody will wait that long for is refused rather
 * than queued.
 */
const WAITING_MAX = 60;

/** The chart API is busy enough that a person's request was not queued. */
export class ChartsBusy extends Error {}

function release(): void {
  timer = undefined;
  // A 429 can push the slot back after this timer was set.
  if (Date.now() < slot) {
    timer = setTimeout(release, slot - Date.now());
    return;
  }
  const go = lanes.now.shift() ?? lanes.later.shift();
  if (!go) return;
  slot = Date.now() + GAP_MS;
  go();
  if (lanes.now.length || lanes.later.length) timer = setTimeout(release, GAP_MS);
}

/** Wait for this caller's slot. `urgent` is a person waiting on the answer. */
function pace(urgent: boolean): Promise<void> {
  if (urgent && lanes.now.length >= WAITING_MAX) return Promise.reject(new ChartsBusy());
  return new Promise((go) => {
    (urgent ? lanes.now : lanes.later).push(go);
    if (!timer) timer = setTimeout(release, Math.max(0, slot - Date.now()));
  });
}

export interface Candle {
  /** Epoch ms the candle began. */
  time: number;
  close: number;
}

/**
 * Up to `count` candles of `interval`, oldest first, ending at `to` (epoch
 * ms; now unless a past price is being asked for).
 *
 * Throws when the API fails or throttles: an empty answer means the token has
 * no trades, and the two must not look alike to a cache. A person waiting is
 * not made to sit through the refresh's backoff — one throttled answer and
 * they are told, while the refresh retries.
 */
export async function fetchCandles(
  mint: string,
  interval: Interval,
  count: number,
  urgent = false,
  to = Date.now(),
): Promise<Candle[]> {
  for (let attempt = 0; ; attempt += 1) {
    await pace(urgent);

    const url =
      `${JUP_CHART_ENDPOINT}/${encodeURIComponent(mint)}` +
      `?interval=${interval}` +
      `&candles=${count}` +
      `&to=${encodeURIComponent(new Date(to).toISOString())}`;

    const res = await fetch(url, {
      headers: { Accept: "application/json" },
      signal: AbortSignal.timeout(TOKEN_TICKS_TIMEOUT_MS),
    });

    if (res.status === 429) {
      // Hold the shared slot back rather than this one request: being
      // throttled says everything here is going too fast, and retrying alone
      // while five other workers keep pushing just fails again.
      slot = Math.max(slot, Date.now() + GAP_MS * 20 * (attempt + 1));
      if (urgent || attempt >= TOKEN_TICKS_RETRIES) throw new Error("charts 429");
      continue;
    }
    if (!res.ok) throw new Error(`charts ${res.status}`);

    const body = (await res.json()) as { candles?: Array<{ time?: unknown; close?: unknown }> };
    const candles: Candle[] = [];
    for (const candle of body.candles ?? []) {
      const time = Number(candle?.time) * 1000;
      const close = Number(candle?.close);
      // A zero or missing close would flatten the whole scale around it.
      if (Number.isFinite(time) && Number.isFinite(close) && close > 0) candles.push({ time, close });
    }
    return candles.sort((a, b) => a.time - b.time);
  }
}

/**
 * Candles onto the clock: `count` buckets of `step` ms, the last the one now
 * falls in, each holding the close of the latest candle at or before it.
 *
 * Jupiter only returns candles in which something traded, so for a thin token
 * "the last sixty minutes" comes back as sixty trades spread over days. Read
 * off the clock instead, a quiet stretch is the flat line it was, and the
 * time under a scrubbed point is the time it says. Buckets before the first
 * candle are left out, so a token too new for the window draws what it has.
 */
export function onClock(
  candles: Candle[],
  step: number,
  count: number,
  now = Date.now(),
): { at: number; closes: number[] } {
  const at = Math.floor(now / step) * step;
  const closes: number[] = [];
  let next = 0;
  let close: number | undefined;
  for (let k = count - 1; k >= 0; k -= 1) {
    const open = at - k * step;
    while (next < candles.length && candles[next].time <= open) close = candles[next++].close;
    if (close != null) closes.push(close);
  }
  return { at, closes };
}

/**
 * Closes to one byte per point, base64, plus the range they were scaled by.
 *
 * The bytes are all the *client* ever gets: the card never labels the line, so
 * shipping the prices again would be shipping numbers nobody reads. The range
 * is returned for the server's own use — the wallet page values a portfolio
 * back over the same 24 hours, and lo/hi are what turn a shape back into the
 * prices it was made from. Two numbers per record against re-fetching a
 * thousand series, and accurate to 1/255th of the day's range either way.
 */
export function encodeTicks(closes: number[]): {
  ticks: string;
  lo: number;
  hi: number;
} {
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
  return { ticks: bytes.toString("base64"), lo, hi };
}

/**
 * The inverse: a record's shape back into approximate hourly closes.
 *
 * Lossy by exactly one byte of the day's range, which on an ordinary day is a
 * few thousandths of a percent of price — far below anything a summed
 * portfolio figure is read to. Null when the record has no series, or came
 * from a snapshot written before the range was kept, in which case the caller
 * has to treat that holding as having no history rather than guess one.
 */
export function decodeTicks(rec: TokenRecord): number[] | null {
  if (!rec.ticks || rec.tickLo == null || rec.tickHi == null) return null;
  const bytes = Buffer.from(rec.ticks, "base64");
  if (bytes.length < 2) return null;
  const span = rec.tickHi - rec.tickLo;
  const out: number[] = [];
  for (const b of bytes) out.push(rec.tickLo + (b / 255) * span);
  return out;
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

  const started = Date.now();
  let ok = 0;
  let cursor = 0;

  const worker = async () => {
    while (cursor < records.length) {
      const rec = records[cursor++];
      try {
        const candles = await fetchCandles(rec.mint, TICKS_INTERVAL, TOKEN_TICKS_COUNT);
        const { at, closes } = onClock(candles, INTERVAL_MS[TICKS_INTERVAL], TOKEN_TICKS_COUNT);
        if (closes.length < TOKEN_TICKS_MIN_POINTS) continue;
        const encoded = encodeTicks(closes);
        rec.ticks = encoded.ticks;
        // Kept beside the shape so a chart can read prices back out of it
        // without a second trip to the chart API, and say when each was.
        rec.tickLo = encoded.lo;
        rec.tickHi = encoded.hi;
        rec.tickAt = at;
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
