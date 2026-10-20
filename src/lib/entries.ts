import { Activity, PriceSeries, TokenRecord } from "../types";
import { readTransactions, readTx } from "./history";
import { Held, readBook } from "./holdings";
import { daySeries } from "./tokens/history";
import { lookupMints } from "./tokens/store";

/**
 * What each holding cost, on average, across the past 24 hours: the price the
 * wallet page measures a position's day against.
 *
 * Held from before the day, a token entered at its price 24 hours ago, so a
 * position nobody touched today moves exactly as the market's 24h change
 * says. Bought today, it entered at what was paid for it: the other side of
 * the swap, priced at the hour it happened. Received, at the price it arrived
 * at. A sale or a send takes out the average rather than the price it went
 * at, so what is left keeps the entry it had.
 *
 * Only the day, for two reasons. Every token carries its day as hourly ticks
 * already, so pricing a trade at its hour is a lookup rather than a request;
 * a week back, each would be one more call to the chart API. And a day is one
 * call to Helius for nearly everyone, where a whole history can be hundreds.
 *
 * Nothing is kept, as nothing is in lib/history.ts: the day is read off the
 * chain when the page asks and forgotten a few seconds later.
 */

const DAY_MS = 86_400_000;

/** Whole transactions a call: as many as Helius returns at once. */
const PAGE = 100;

/**
 * Past this many pages in a day the wallet is a bot's, and no entry is given
 * rather than one walked from part of the day.
 */
const MAX_PAGES = 3;

/** A balance from before the day worth less than this did not enter at all. */
const DUST_USD = 0.01;

/**
 * What went out pays for what came in only when the two are worth about the
 * same. Past this either way it was not a trade but something with a side the
 * moves do not show, a deposit or a mint, and each token is entered at its own
 * price instead.
 */
const FAIR = 2;

/** Absorbs a reload or a second tab, as lib/holdings.ts does, and nothing longer. */
const CACHE_TTL_MS = 5_000;
const MAX_CACHED = 2_000;

/** Seven significant figures, as a chart's prices are given (lib/tokens/history.ts). */
function round(v: number): number {
  return Number(v.toPrecision(7));
}

/**
 * A token's price at `t`, off its day's hourly ticks, or today's past their
 * end. Each tick is the price as its hour closed, so within an hour it is the
 * line from the close before to this one.
 */
function priceAt(rec: TokenRecord, day: PriceSeries | null, t: number): number | undefined {
  if (!day) return undefined;
  const last = day.v.length - 1;
  const k = last - Math.round((day.at - Math.floor(t / day.step) * day.step) / day.step);
  if (k > last) return rec.price;
  if (k < 1) return day.v[0];
  const from = day.v[k - 1];
  return from + (day.v[k] - from) * ((t % day.step) / day.step);
}

/** Into a position, with what it cost (unknown when nothing could price it), or out of it. */
type Lot = { units: number; cost?: number };

/**
 * Each holding's average entry across the day, in USD per whole token, by
 * mint. `day` is the wallet's activity since `since`, oldest first. A mint is
 * left out when some part of its day cannot be priced. `lookup` is the token
 * index, unless a test brings its own.
 */
export function averageEntries(
  held: Pick<Held, "rec" | "units">[],
  day: Activity[],
  since: number,
  lookup: (mints: string[]) => Map<string, TokenRecord> = lookupMints,
): Record<string, number> {
  const mine = new Set(held.map((h) => h.rec.mint));
  const recs = lookup([...new Set(day.flatMap((a) => a.moves.map((m) => m.mint)))]);
  for (const h of held) recs.set(h.rec.mint, h.rec);
  const days = new Map<string, PriceSeries | null>();
  const priceOf = (mint: string, t: number) => {
    const rec = recs.get(mint);
    if (!rec) return undefined;
    if (!days.has(mint)) days.set(mint, daySeries(rec));
    return priceAt(rec, days.get(mint) ?? null, t);
  };

  const lots = new Map<string, Lot[]>();
  for (const a of day) {
    const at = a.at ?? Date.now();
    const legs = a.moves.map((m) => {
      const units = Number(m.amount) / 10 ** m.decimals;
      const price = priceOf(m.mint, at);
      return { mint: m.mint, units, worth: price == null ? undefined : Math.abs(units) * price };
    });
    const outs = legs.filter((l) => l.units < 0);
    const ins = legs.filter((l) => l.units > 0);
    const paid = outs.every((l) => l.worth != null) ? outs.reduce((s, l) => s + l.worth!, 0) : 0;
    const got = ins.every((l) => l.worth != null) ? ins.reduce((s, l) => s + l.worth!, 0) : 0;
    // A swap: what went out paid for what came in, shared by each one's worth.
    const traded = paid > 0 && got > 0 && paid / got < FAIR && got / paid < FAIR;
    for (const l of legs) {
      if (!mine.has(l.mint)) continue;
      let list = lots.get(l.mint);
      if (!list) lots.set(l.mint, (list = []));
      if (l.units < 0) list.push({ units: l.units });
      else list.push({ units: l.units, cost: traded ? (paid * l.worth!) / got : l.worth });
    }
  }

  const out: Record<string, number> = {};
  for (const { rec, units: now } of held) {
    const list = lots.get(rec.mint) ?? [];
    const before = now - list.reduce((s, l) => s + l.units, 0);
    let units = 0;
    let cost = 0;
    if (before * rec.price >= DUST_USD) {
      // Jupiter's own 24h change, so a position untouched today reads exactly as the market does.
      const gone = rec.change24h != null ? 1 + rec.change24h / 100 : 0;
      const then = gone > 0 ? rec.price / gone : priceOf(rec.mint, since);
      if (!then || !(then > 0)) continue;
      units = before;
      cost = before * then;
    }
    let known = true;
    for (const lot of list) {
      if (lot.units > 0) {
        if (lot.cost == null) {
          known = false;
          break;
        }
        units += lot.units;
        cost += lot.cost;
      } else if (units > 0) {
        const left = Math.max(0, units + lot.units);
        cost *= left / units;
        units = left;
      }
    }
    if (known && units > 0 && cost > 0) out[rec.mint] = round(cost / units);
  }
  return out;
}

/** The wallet's day, oldest first; null when it ran past MAX_PAGES. */
async function readDay(owner: string, since: number): Promise<Activity[] | null> {
  const day: Activity[] = [];
  const hidden = { n: 0 };
  let after = "";
  for (let page = 0; page < MAX_PAGES; page += 1) {
    const { data, next } = await readTransactions(owner, { limit: PAGE, order: "asc", after, since });
    for (const t of data) {
      const a = readTx(owner, t, hidden);
      if (a) day.push(a);
    }
    if (!next) return day;
    after = next;
  }
  return null;
}

const cache = new Map<string, { at: number; value: Record<string, number> }>();
const inFlight = new Map<string, Promise<Record<string, number>>>();

/** Each of the holdings `owner`'s wallet page shows, against what it cost across the day. */
export async function fetchEntries(owner: string): Promise<Record<string, number>> {
  const now = Date.now();
  const hit = cache.get(owner);
  if (hit && now - hit.at < CACHE_TTL_MS) return hit.value;

  const pending = inFlight.get(owner);
  if (pending) return pending;

  const since = now - DAY_MS;
  const task = Promise.all([readBook(owner), readDay(owner, since)])
    .then(([book, day]) => {
      const shown = new Set(book.items.map((i) => i.mint));
      const value = day ? averageEntries(book.held.filter((h) => shown.has(h.rec.mint)), day, since) : {};
      // Past the cap is a flood, not a working set, as in lib/holdings.ts.
      if (cache.size >= MAX_CACHED) cache.clear();
      cache.set(owner, { at: Date.now(), value });
      return value;
    })
    .finally(() => inFlight.delete(owner));
  inFlight.set(owner, task);
  return task;
}
