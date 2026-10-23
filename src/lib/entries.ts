import { Activity, EntriesApiResponse, EntriesBasis, PriceSeries, TokenRecord } from "../types";
import { readTransactions, readTx } from "./history";
import { Held, readBook } from "./holdings";
import { daySeries, pastSeries } from "./tokens/history";
import { lookupMints } from "./tokens/store";

/**
 * What each holding cost, on average: the price the wallet page measures a
 * position against, so its row reads as the price now against the price it
 * was acquired at, however long ago that was.
 *
 * Bought, a token entered at what was paid for it: the other side of the
 * swap, priced at the hour it happened. Received, at the price it arrived
 * at. A sale or a send takes out the average rather than the price it went
 * at, so what is left keeps the entry it had, and a position sold down to
 * nothing starts again at its next buy.
 *
 * Read as little as can be. The first time, the wallet's past is read back
 * from now only until every holding has been traced to the last time it was
 * empty. What that leaves, the basis, goes back to the page, which keeps it
 * in its own browser with the answer: while the balances stay as they are it
 * asks nothing at all, and after a trade it hands the basis back, so only the
 * transactions since are read, one call to Helius. Prices inside the day
 * come off the hourly ticks every token carries; older ones off the chart
 * API, a call per token, held and shared by every wallet that traded it,
 * since a price in the past does not change.
 *
 * Nothing about the wallet is kept here, as nothing is in lib/history.ts: its
 * past is read off the chain when the page asks and forgotten a few seconds
 * later. The basis lives in the browser of whoever holds the wallet.
 */

/** Whole transactions a call: as many as Helius returns at once. */
const PAGE = 100;

/**
 * Past this many pages without reaching where a holding began, it is given
 * no entry rather than one walked from part of its past.
 */
const MAX_PAGES = 10;

/** A balance worth less than this is empty: where a position began. */
const DUST_USD = 0.01;

/**
 * Tokens one ask may fetch from the chart API, the most traded first; one
 * already held costs nothing. Each is a call on the budget every chart on the
 * site shares. Past this the rest wait for the next ask, and what they
 * bought goes without an entry until then.
 */
const PAST_MAX = 16;

/**
 * What went out pays for what came in only when the two are worth about the
 * same. Past this either way it was not a trade but something with a side the
 * moves do not show, a deposit or a mint, and each token is entered at its own
 * price instead.
 */
const FAIR = 2;

/**
 * Slots before the balances' own, about a minute, that the next ask reads
 * again: a transaction the index had not caught up with yet is counted
 * then, and those already counted are told apart by signature.
 */
const MARGIN_SLOTS = 150;

/** Its moves leave out the fees and rent paid (lib/history.ts), so its units drift from the balance. */
const SOL_MINT = "So11111111111111111111111111111111111111112";

/** Absorbs a reload or a second tab, as lib/holdings.ts does, and nothing longer. */
const CACHE_TTL_MS = 5_000;
const MAX_CACHED = 2_000;

/** Seven significant figures, as a chart's prices are given (lib/tokens/history.ts). */
function round(v: number): number {
  return Number(v.toPrecision(7));
}

/**
 * A price at `t` off a series, `after` past its end, and none before its
 * start. Each point is the price as its bucket closed, so within a bucket it
 * is the line from the close before to this one.
 */
function priceAt(s: PriceSeries, t: number, after: number): number | undefined {
  const last = s.v.length - 1;
  const k = last - Math.round((s.at - Math.floor(t / s.step) * s.step) / s.step);
  if (k > last) return after;
  if (k < 0) return undefined;
  if (k < 1) return s.v[0];
  const from = s.v[k - 1];
  return from + (s.v[k] - from) * ((t % s.step) / s.step);
}

/**
 * Where each of `held` began: the index in `past` (oldest first) of the move
 * that last filled it from empty, found by taking the moves back off what is
 * held now. Missing for a holding `past` does not reach back that far for.
 */
export function starts(held: Pick<Held, "rec" | "units">[], past: Activity[]): Map<string, number> {
  const left = new Map(held.map((h) => [h.rec.mint, { units: h.units, price: h.rec.price }]));
  const out = new Map<string, number>();
  for (let i = past.length - 1; i >= 0 && left.size; i -= 1) {
    for (const m of past[i].moves) {
      const h = left.get(m.mint);
      if (!h) continue;
      h.units -= Number(m.amount) / 10 ** m.decimals;
      if (h.units * h.price < DUST_USD) {
        out.set(m.mint, i);
        left.delete(m.mint);
      }
    }
  }
  return out;
}

/**
 * Whether `basis` and what came since account for every one of `held`:
 * begun since, given up on, or carried in it with the units it says, give or
 * take a tenth of a percent or a dime. Anything else, and the basis is
 * dropped for a full walk. SOL's units drift from its balance by design, and
 * are taken as they are.
 */
export function follows(held: Pick<Held, "rec" | "units">[], basis: EntriesBasis, since: Activity[]): boolean {
  const begun = starts(held, since);
  const far = new Set(basis.far);
  return held.every(({ rec, units }) => {
    if (begun.has(rec.mint) || far.has(rec.mint)) return true;
    const lot = basis.lots[rec.mint];
    if (!lot) return false;
    if (rec.mint === SOL_MINT) return true;
    let then = units;
    for (const a of since) for (const m of a.moves) if (m.mint === rec.mint) then -= Number(m.amount) / 10 ** m.decimals;
    const off = Math.abs(then - lot[0]);
    return off <= then * 1e-3 || off * rec.price <= 0.1;
  });
}

/** Into a position, with what it cost (unknown when nothing could price it), or out of it. */
type Lot = { units: number; cost?: number };

/** A walk's entries, and what the next ask may start from. */
export interface Walked {
  entries: Record<string, number>;
  lots: EntriesBasis["lots"];
  far: string[];
  /** False when a holding goes without an entry for a reason that may pass. */
  settled: boolean;
}

/**
 * Each holding's average entry, in USD per whole token, by mint, and the
 * positions behind them. `past` is the wallet's activity, oldest first, and
 * `seed` the positions it starts from. A holding `past` does not reach where
 * it began for is far when `cut` (the walk ran out, or the basis already
 * gave up on it), and otherwise does not add up yet: a transaction the index
 * is behind on. One whose cost cannot be priced is far, unless a price was
 * not asked for this time. `lookup` is the token index and `older` the chart
 * API, unless a test brings its own.
 */
export async function averageEntries(
  held: Pick<Held, "rec" | "units">[],
  past: Activity[],
  {
    seed = {},
    cut = false,
    lookup = lookupMints,
    older = pastSeries,
  }: {
    seed?: EntriesBasis["lots"];
    cut?: boolean;
    lookup?: (mints: string[]) => Map<string, TokenRecord>;
    older?: (mint: string, from: number, to: number, budget: { left: number }) => Promise<PriceSeries[] | null>;
  } = {},
): Promise<Walked> {
  const begun = starts(held, past);
  // Where each holding's moves start to count: where it began, or the first, carried in from the seed.
  const start = new Map(begun);
  const lots = new Map<string, Lot[]>();
  for (const { rec } of held) {
    const lot = seed[rec.mint];
    if (begun.has(rec.mint) || !lot) continue;
    start.set(rec.mint, 0);
    lots.set(rec.mint, [{ units: lot[0], cost: lot[1] }]);
  }
  /** Whether `past[i]` comes after one of the holdings began, so says something about its cost. */
  const counts = (i: number) => past[i].moves.some((m) => i >= (start.get(m.mint) ?? Infinity));

  const recs = lookup([...new Set(past.flatMap((a) => a.moves.map((m) => m.mint)))]);
  for (const h of held) recs.set(h.rec.mint, h.rec);
  const days = new Map<string, PriceSeries | null>();
  const dayOf = (rec: TokenRecord) => {
    if (!days.has(rec.mint)) days.set(rec.mint, daySeries(rec));
    return days.get(rec.mint) ?? null;
  };
  const inDay = (day: PriceSeries | null, t: number) => !!day && t >= day.at - (day.v.length - 1) * day.step;

  // What the ticks cannot price, by mint: the span of it to ask the chart API for.
  const spans = new Map<string, { from: number; to: number; n: number }>();
  past.forEach((a, i) => {
    if (!counts(i)) return;
    const at = a.at ?? Date.now();
    for (const m of a.moves) {
      const rec = recs.get(m.mint);
      if (!rec || inDay(dayOf(rec), at)) continue;
      const s = spans.get(m.mint);
      if (!s) spans.set(m.mint, { from: at, to: at, n: 1 });
      else {
        s.from = Math.min(s.from, at);
        s.to = Math.max(s.to, at);
        s.n += 1;
      }
    }
  });
  // Asked in order, so the budget goes to the most traded first.
  const budget = { left: PAST_MAX };
  const answers = await Promise.all(
    [...spans].sort((a, b) => b[1].n - a[1].n).map(async ([mint, s]) => [mint, await older(mint, s.from, s.to, budget)] as const),
  );
  /** Some price may come with the next ask: refused this time, or past the budget. */
  const short = answers.some(([, series]) => series == null);
  const pasts = new Map(answers.map(([mint, series]) => [mint, series ?? []]));

  const priceOf = (mint: string, t: number) => {
    const rec = recs.get(mint);
    if (!rec) return undefined;
    const day = dayOf(rec);
    if (day && inDay(day, t)) return priceAt(day, t, rec.price);
    for (const s of pasts.get(mint) ?? []) {
      const price = priceAt(s, t, s.v[s.v.length - 1]);
      if (price != null) return price;
    }
    return undefined;
  };

  past.forEach((a, i) => {
    if (!counts(i)) return;
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
    // One token in with no price of its own, as a token too new for the
    // chart API is, cost what was paid for it.
    const traded = paid > 0 && (got > 0 ? paid / got < FAIR && got / paid < FAIR : ins.length === 1);
    for (const l of legs) {
      if (i < (start.get(l.mint) ?? Infinity)) continue;
      let list = lots.get(l.mint);
      if (!list) lots.set(l.mint, (list = []));
      if (l.units < 0) list.push({ units: l.units });
      else list.push({ units: l.units, cost: traded ? (got > 0 ? (paid * l.worth!) / got : paid) : l.worth });
    }
  });

  const out: Walked = { entries: {}, lots: {}, far: [], settled: !short };
  for (const { rec } of held) {
    const list = lots.get(rec.mint);
    if (!list) {
      if (cut) out.far.push(rec.mint);
      else out.settled = false;
      continue;
    }
    let units = 0;
    let cost = 0;
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
    if (known && units > 0 && cost > 0) {
      out.entries[rec.mint] = round(cost / units);
      out.lots[rec.mint] = [round(units), round(cost)];
    } else if (known || short) out.settled = false;
    else out.far.push(rec.mint);
  }
  return out;
}

/** What a read through the wallet's past brought back. */
interface Read {
  /** Oldest first. */
  past: Activity[];
  /** The signatures counted within MARGIN_SLOTS of the end, for the next ask to tell apart. */
  recent: string[];
  /** MAX_PAGES ran out before the read was done. */
  cut: boolean;
}

/**
 * `owner`'s successful transactions up to slot `through`, newest first. From
 * a basis, all of them since it, less what it already counted; without one,
 * back only until every one of `held` has been traced to where it began.
 */
async function readPast(
  owner: string,
  held: Pick<Held, "rec" | "units">[],
  through: number | undefined,
  basis?: EntriesBasis,
): Promise<Read> {
  const past: Activity[] = [];
  const recent: string[] = [];
  const counted = new Set(basis?.recent);
  const hidden = { n: 0 };
  const slots = {
    ...(basis ? { gt: Math.max(0, basis.slot - MARGIN_SLOTS) } : {}),
    ...(through ? { lte: through } : {}),
  };
  let after = "";
  for (let page = 0; page < MAX_PAGES; page += 1) {
    const { data, next } = await readTransactions(owner, {
      limit: PAGE,
      order: "desc",
      after,
      succeeded: true,
      ...(Object.keys(slots).length ? { slots } : {}),
    });
    const read: Activity[] = [];
    for (const t of data) {
      const signature = t.transaction?.signatures?.[0];
      // Read again next time, unless its signature says it is in already.
      const late = through != null && (t.slot == null || t.slot > through - MARGIN_SLOTS);
      if (signature && counted.has(signature)) {
        if (late) recent.push(signature);
        continue;
      }
      const a = readTx(owner, t, hidden);
      if (!a) continue;
      read.push(a);
      if (late) recent.push(a.signature);
    }
    past.unshift(...read.reverse());
    if (!next || (!basis && starts(held, past).size === held.length)) return { past, recent, cut: false };
    after = next;
  }
  return { past, recent, cut: true };
}

/** The answer to hand back, with the basis for the next ask when the balances said what slot they were. */
function answer(w: Walked, slot: number | undefined, recent: string[]): EntriesApiResponse {
  const basis: EntriesBasis | undefined = slot
    ? { slot, lots: w.lots, ...(w.far.length ? { far: w.far } : {}), ...(recent.length ? { recent } : {}) }
    : undefined;
  return { entries: w.entries, settled: w.settled, ...(basis ? { basis } : {}) };
}

async function walk(
  owner: string,
  held: Pick<Held, "rec" | "units">[],
  through: number | undefined,
  basis?: EntriesBasis,
): Promise<EntriesApiResponse> {
  if (!held.length) return answer({ entries: {}, lots: {}, far: [], settled: true }, through, []);
  if (basis && through && basis.slot <= through) {
    const since = await readPast(owner, held, through, basis);
    // More since than a walk reads: the newest of them are what a walk from scratch would read anyway.
    if (since.cut) return answer(await averageEntries(held, since.past, { cut: true }), through, since.recent);
    if (follows(held, basis, since.past)) {
      return answer(await averageEntries(held, since.past, { seed: basis.lots, cut: true }), through, since.recent);
    }
  }
  const read = await readPast(owner, held, through);
  return answer(await averageEntries(held, read.past, { cut: read.cut }), through, read.recent);
}

const BASE58 = /^[1-9A-HJ-NP-Za-km-z]+$/;

/** At most this many of each in a basis: a page shows fifty holdings (lib/holdings.ts). */
const BASIS_MAX = 64;

function isKey(v: unknown, min: number, max: number): v is string {
  return typeof v === "string" && v.length >= min && v.length <= max && BASE58.test(v);
}

function keys(v: unknown, min: number, max: number): string[] | null {
  if (v === undefined) return [];
  return Array.isArray(v) && v.length <= BASIS_MAX && v.every((k) => isKey(k, min, max)) ? v : null;
}

/**
 * A basis as the page sent it back, or nothing when it is not one. It only
 * ever describes the sender's own browser's view of a wallet back to it, so
 * one made up misleads nobody else, and follows() sends one that no longer
 * adds up back to a full walk.
 */
export function readBasis(v: unknown): EntriesBasis | undefined {
  if (!v || typeof v !== "object") return undefined;
  const { slot, lots, far, recent } = v as Record<string, unknown>;
  if (typeof slot !== "number" || !Number.isSafeInteger(slot) || slot <= 0) return undefined;
  if (!lots || typeof lots !== "object" || Array.isArray(lots)) return undefined;
  const list = Object.entries(lots);
  if (list.length > BASIS_MAX) return undefined;
  const out: EntriesBasis["lots"] = {};
  for (const [mint, lot] of list) {
    if (!isKey(mint, 32, 44) || !Array.isArray(lot) || lot.length !== 2) return undefined;
    const [units, cost] = lot as unknown[];
    const fine = (n: unknown) => typeof n === "number" && Number.isFinite(n) && n > 0;
    if (!fine(units) || !fine(cost)) return undefined;
    out[mint] = [units as number, cost as number];
  }
  const gaveUp = keys(far, 32, 44);
  const counted = keys(recent, 64, 90);
  if (!gaveUp || !counted) return undefined;
  return { slot, lots: out, ...(gaveUp.length ? { far: gaveUp } : {}), ...(counted.length ? { recent: counted } : {}) };
}

const cache = new Map<string, { at: number; value: EntriesApiResponse }>();
const inFlight = new Map<string, Promise<EntriesApiResponse>>();

/**
 * Each of the holdings `owner`'s wallet page shows, against what it cost,
 * and the basis to hand back next time: worked on from `basis` while it
 * still adds up, otherwise from a walk back through the wallet's past.
 */
export async function fetchEntries(owner: string, basis?: EntriesBasis): Promise<EntriesApiResponse> {
  const hit = cache.get(owner);
  if (hit && Date.now() - hit.at < CACHE_TTL_MS) return hit.value;

  const pending = inFlight.get(owner);
  if (pending) return pending;

  const task = readBook(owner)
    .then((book) => {
      const shown = new Set(book.items.map((i) => i.mint));
      return walk(owner, book.held.filter((h) => shown.has(h.rec.mint)), book.slot, basis);
    })
    .then((value) => {
      // Past the cap is a flood, not a working set, as in lib/holdings.ts.
      if (cache.size >= MAX_CACHED) cache.clear();
      cache.set(owner, { at: Date.now(), value });
      return value;
    })
    .finally(() => inFlight.delete(owner));
  inFlight.set(owner, task);
  return task;
}
