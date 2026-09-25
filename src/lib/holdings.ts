import {
  HELIUS_RPC_URL,
  TOKEN_PRICE_TIMEOUT_MS,
  TOKEN_TICKS_COUNT,
} from "../config";
import { Holding, Holdings } from "../types";
import { decodeTicks, encodeTicks } from "./tokens/ticks";
import { hasIcon } from "./tokens/icons";
import { lookupMints } from "./tokens/store";

/**
 * Everything one wallet holds, priced.
 *
 * Deliberately not a DAS call. Helius will answer this in a single
 * `searchAssets` with symbols and prices attached, which is tempting and
 * wrong for this site: those prices would come from a different source than
 * every other number on it, so the same token could read one value on a search
 * card and another on the wallet page. Plain `getTokenAccountsByOwner` gives us
 * the balances, and the token index we already keep in memory gives us the
 * prices — the same index the price cards and the buy dialog read. One source
 * of truth, and no third-party call beyond the one that reads the chain.
 *
 * It also costs less. The index is rebuilt hourly whatever happens, so pricing
 * a portfolio is a map lookup per mint rather than a request per mint.
 */

const WSOL_MINT = "So11111111111111111111111111111111111111112";
const TOKEN_PROGRAM = "TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA";
/** Token-2022. A separate program, so a separate call — its accounts are
 *  invisible to a query filtered on the original program id. */
const TOKEN_2022_PROGRAM = "TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb";

const LAMPORTS_PER_SOL = 1_000_000_000;

/**
 * Rows worth rendering. Well past what any real portfolio shows on one screen,
 * and a bound on the response either way — an address is caller-supplied, and
 * a wallet holding thousands of airdropped mints must not turn one request
 * into a megabyte.
 */
const MAX_ITEMS = 50;

/**
 * Below this a holding is dust, and dust is noise on a page whose whole job is
 * to be read at a glance. Counted rather than dropped, so the page can say so.
 */
const DUST_USD = 0.01;

/**
 * Balances move on every trade, so this is only about absorbing bursts — a
 * reload, or a second tab, shouldn't cost two round trips. Same reasoning,
 * shape and duration as lib/balances.ts.
 *
 * The duration is load-bearing rather than arbitrary. After a swap the wallet
 * page re-reads on a timer until the holdings actually change, because a
 * wallet resolves signAndSend when it has *broadcast* a transaction and the
 * chain has not necessarily settled it yet. Every one of those reads has to be
 * able to see new state, so the TTL must be shorter than the gap between them
 * — at 15s the middle polls were served the pre-trade answer out of this map
 * and the page sat there insisting nothing had happened.
 */
const CACHE_TTL_MS = 5_000;

/**
 * How much of a portfolio's value must have real price history before the
 * 24-hour line is worth drawing.
 *
 * Holdings with no series are carried flat, which keeps the total honest but
 * contributes nothing to the shape. Below this the line is mostly a straight
 * segment describing nothing, and drawing it would imply a day that was
 * measured rather than one that was mostly unknown.
 */
const MIN_SERIES_COVERAGE = 0.5;

/**
 * Hours in the portfolio series — the same window, and the same count, the
 * token cards' own sparklines use, so the two lines mean the same thing.
 */
const POINTS = TOKEN_TICKS_COUNT;

/**
 * The portfolio's day, as the client receives it.
 *
 * Six significant figures on the range is far more than two decimals of
 * dollars needs and keeps a sub-cent portfolio from collapsing to zero, while
 * costing about ten bytes each.
 */
function encodeSeries(series: number[]) {
  const { ticks, lo, hi } = encodeTicks(series);
  return {
    series: ticks,
    seriesLo: Number(lo.toPrecision(6)),
    seriesHi: Number(hi.toPrecision(6)),
    change24h: Number(((series[POINTS - 1] / series[0] - 1) * 100).toFixed(2)),
  };
}

/**
 * A token's closes as exactly POINTS values, oldest first.
 *
 * A mint too new for a full day comes back with fewer candles, and those are
 * the most *recent* hours — so they are right-aligned and the unknown earlier
 * ones hold at the oldest price we actually have, rather than inventing a move
 * into existence at the left edge of the chart.
 */
function align(closes: number[]): number[] {
  if (closes.length >= POINTS) return closes.slice(closes.length - POINTS);
  return [...new Array(POINTS - closes.length).fill(closes[0]), ...closes];
}

/**
 * Ceiling on cached wallets. The key only has to *look* like a pubkey, so an
 * anonymous caller can mint unlimited distinct keys; without a bound the cache
 * is a permanent record of every address ever asked about. See the same guard
 * in lib/balances.ts for the full reasoning.
 */
const MAX_CACHED_WALLETS = 2_000;

const cache = new Map<string, { at: number; value: Holdings }>();
const inFlight = new Map<string, Promise<Holdings>>();

function sweepCache(now: number): void {
  for (const [key, entry] of cache) {
    if (now - entry.at >= CACHE_TTL_MS) cache.delete(key);
  }
  // Everything younger than the TTL and still at the cap: a flood, not a
  // working set. Drop it all rather than grow.
  if (cache.size >= MAX_CACHED_WALLETS) cache.clear();
}

interface RpcReply {
  id?: number;
  result?: unknown;
  error?: { message?: string };
}

interface ParsedTokenAccount {
  account?: {
    data?: {
      parsed?: {
        info?: {
          mint?: string;
          tokenAmount?: { amount?: string; decimals?: number };
        };
      };
    };
  };
}

/**
 * Sum a program's token accounts into `totals`, keyed by mint.
 *
 * A wallet can hold several accounts for one mint — an ATA plus whatever an
 * airdrop or an old client created — and a portfolio that listed them
 * separately would show the same token three times and let none of the rows
 * agree with the wallet's own display.
 */
function collect(
  result: unknown,
  totals: Map<string, { amount: bigint; decimals: number }>,
): void {
  const value = (result as { value?: ParsedTokenAccount[] } | undefined)?.value;
  if (!Array.isArray(value)) return;

  for (const entry of value) {
    const info = entry?.account?.data?.parsed?.info;
    const mint = info?.mint;
    const raw = info?.tokenAmount?.amount;
    const decimals = info?.tokenAmount?.decimals;
    if (!mint || !raw || typeof decimals !== "number") continue;

    let amount: bigint;
    try {
      amount = BigInt(raw);
    } catch {
      continue;
    }
    if (amount === 0n) continue;

    const held = totals.get(mint);
    if (held) held.amount += amount;
    else totals.set(mint, { amount, decimals });
  }
}

/** Base units → a JS number of whole tokens, for pricing only. */
function toUnits(amount: bigint, decimals: number): number {
  return Number(amount) / 10 ** decimals;
}

export async function fetchHoldings(owner: string): Promise<Holdings> {
  // No RPC configured is a deployment fault, not an empty wallet — the same
  // distinction lib/balances.ts draws, and for the same reason: reporting an
  // empty portfolio would be a confident lie about someone's money.
  if (!HELIUS_RPC_URL) throw new Error("HELIUS_RPC_URL is not configured");

  const hit = cache.get(owner);
  if (hit && Date.now() - hit.at < CACHE_TTL_MS) return hit.value;

  // Concurrent callers asking the same question share one answer; the cache
  // alone only collapses requests arriving after the first has landed, which
  // is precisely the case a burst does not produce.
  const pending = inFlight.get(owner);
  if (pending) return pending;

  const task = lookup(owner).finally(() => {
    inFlight.delete(owner);
  });
  inFlight.set(owner, task);
  return task;
}

async function lookup(owner: string): Promise<Holdings> {
  const calls = [
    { jsonrpc: "2.0", id: 1, method: "getBalance", params: [owner] },
    {
      jsonrpc: "2.0",
      id: 2,
      method: "getTokenAccountsByOwner",
      params: [owner, { programId: TOKEN_PROGRAM }, { encoding: "jsonParsed" }],
    },
    {
      jsonrpc: "2.0",
      id: 3,
      method: "getTokenAccountsByOwner",
      params: [owner, { programId: TOKEN_2022_PROGRAM }, { encoding: "jsonParsed" }],
    },
  ];

  const res = await fetch(HELIUS_RPC_URL, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    signal: AbortSignal.timeout(TOKEN_PRICE_TIMEOUT_MS),
    body: JSON.stringify(calls),
  });
  if (!res.ok) {
    const text = await res.text().catch(() => "");
    throw new Error(
      `RPC responded ${res.status}${text ? `: ${text.slice(0, 200)}` : ""}`,
    );
  }

  const body = (await res.json()) as RpcReply[];
  const replies = Array.isArray(body) ? body : [];
  const byId = new Map(replies.map((r) => [r.id, r]));

  const totals = new Map<string, { amount: bigint; decimals: number }>();
  collect(byId.get(2)?.result, totals);
  collect(byId.get(3)?.result, totals);

  // Native SOL is not a token account, so it arrives on its own call — and it
  // is presented as just another row, because to the person reading the page
  // it is just another thing they hold. Wrapped SOL, which *is* a token
  // account, is folded into the same row: the wallet spends them
  // interchangeably and two SOL lines would only invite the question of which
  // one is real.
  const lamports = Number(
    (byId.get(1)?.result as { value?: number } | undefined)?.value,
  );
  let sol = Number.isFinite(lamports) ? BigInt(Math.trunc(lamports)) : 0n;
  const wrapped = totals.get(WSOL_MINT);
  if (wrapped) {
    sol += wrapped.amount;
    totals.delete(WSOL_MINT);
  }
  if (sol > 0n) totals.set(WSOL_MINT, { amount: sol, decimals: 9 });

  // One map lookup per mint against the index already in memory. Prices are
  // deliberately not refreshed per-mint here the way a search refreshes the
  // cards it shows: a portfolio can hold fifty mints, and fifty on-demand RPC
  // price calls per page load is a cost the hourly rebuild already covers.
  const priced = lookupMints([...totals.keys()]);

  const items: Holding[] = [];
  let unpriced = 0;
  let dust = 0;
  let total = 0;

  // The portfolio's own 24 hours, accumulated across every priced holding —
  // dust included, because it counts towards the total the line has to end on.
  const series: number[] = new Array(POINTS).fill(0);
  /** USD whose movement the series actually knows about. */
  let covered = 0;

  for (const [mint, { amount, decimals }] of totals) {
    const rec = priced.get(mint);
    // Not in the index means no price we are willing to state. The index is
    // Jupiter's verified, LST and top-traded lists above a liquidity floor, so
    // what falls out here is overwhelmingly airdropped spam — counted, so the
    // page can say a number rather than silently showing a short list.
    if (!rec || !Number.isFinite(rec.price) || rec.price <= 0) {
      unpriced += 1;
      continue;
    }

    // The mint's own decimals win over the index's: the index carries metadata,
    // the chain carries the scale the balance is actually denominated in.
    const scale = typeof decimals === "number" ? decimals : (rec.decimals ?? 0);
    const usd = toUnits(amount, scale) * rec.price;
    if (!Number.isFinite(usd)) {
      unpriced += 1;
      continue;
    }

    total += usd;

    const closes = decodeTicks(rec);
    if (closes) {
      covered += usd;
      const units = toUnits(amount, scale);
      const hourly = align(closes);
      for (let i = 0; i < POINTS; i += 1) series[i] += units * hourly[i];
    } else {
      // No history for this mint. Held flat rather than dropped: its value is
      // part of the total the line ends on, and omitting it would draw a
      // portfolio smaller than the number printed above it.
      for (let i = 0; i < POINTS; i += 1) series[i] += usd;
    }

    if (usd < DUST_USD) {
      dust += 1;
      continue;
    }

    items.push({
      mint,
      symbol: rec.symbol,
      name: rec.name,
      amount: amount.toString(),
      decimals: scale,
      price: rec.price,
      usd,
      ...(rec.change24h != null ? { change24h: rec.change24h } : {}),
      ...(hasIcon(mint) ? { icon: true as const } : {}),
    });
  }

  // Largest first: a portfolio is read top-down and the top is what matters.
  items.sort((a, b) => b.usd - a.usd);
  const shown = items.slice(0, MAX_ITEMS);

  // A line is only drawn when enough of the value behind it actually moved.
  const drawable =
    total > 0 && series[0] > 0 && covered / total >= MIN_SERIES_COVERAGE;

  const value: Holdings = {
    items: shown,
    total,
    ...(drawable ? encodeSeries(series) : {}),
    ...(items.length > shown.length ? { more: items.length - shown.length } : {}),
    ...(dust ? { dust } : {}),
    ...(unpriced ? { unpriced } : {}),
  };

  const now = Date.now();
  if (cache.size >= MAX_CACHED_WALLETS) sweepCache(now);
  cache.set(owner, { at: now, value });
  return value;
}

export { LAMPORTS_PER_SOL };
