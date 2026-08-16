import { mkdirSync, readFileSync, writeFileSync } from "fs";
import path from "path";
import {
  TOKEN_INDEX_FILE,
  TOKEN_INDEX_INTERVAL_MS,
  TOKEN_PRICE_TTL_MS,
} from "../../config";
import { TokenQuote, TokenRecord } from "../../types";
import { fetchPrice } from "./helius";
import { fetchTokenRecords } from "./jupiter";
import { MAX_CANDIDATES, TokenIndex, matchTokens } from "./match";
import {
  refreshTicks,
  restoreTicks,
  ticksFresh,
  ticksUpdatedAt,
} from "./ticks";

/**
 * The token index: built hourly from Jupiter, refreshed per-mint from Helius on
 * demand, and queried synchronously so a search never waits on it.
 */

let records: TokenRecord[] = [];
let index: TokenIndex = { bySymbol: new Map(), byName: new Map() };
let updatedAt = 0;

/** In-flight price refreshes, keyed by mint, so N searches cause one fetch. */
const inFlight = new Map<string, Promise<void>>();

function buildIndex(list: TokenRecord[]): TokenIndex {
  const bySymbol = new Map<string, TokenRecord[]>();
  const byName = new Map<string, TokenRecord[]>();

  /** Push once — a record whose alias equals its own symbol must not double up. */
  const add = (map: Map<string, TokenRecord[]>, key: string, rec: TokenRecord) => {
    const bucket = map.get(key);
    if (!bucket) map.set(key, [rec]);
    else if (!bucket.includes(rec)) bucket.push(rec);
  };

  for (const rec of list) {
    add(bySymbol, rec.symbol.toUpperCase(), rec);
    add(byName, rec.name.toLowerCase(), rec);
    // Aliases go into both maps; an equity's ticker alias competes with real
    // symbols, which is exactly what lets the ambiguity guard adjudicate it.
    for (const alias of rec.aliases ?? []) {
      add(bySymbol, alias.toUpperCase(), rec);
      add(byName, alias.toLowerCase(), rec);
    }
  }

  return { bySymbol, byName };
}

function adopt(list: TokenRecord[]): void {
  records = list;
  index = buildIndex(list);
  updatedAt = Date.now();
}

// —— Disk snapshot ——

function loadSnapshot(): boolean {
  try {
    const raw = readFileSync(TOKEN_INDEX_FILE, "utf8");
    const parsed = JSON.parse(raw) as {
      updatedAt?: number;
      records?: TokenRecord[];
      ticksAt?: number;
    };
    if (!Array.isArray(parsed.records) || !parsed.records.length) return false;
    // Snapshots written before checkedAt existed fall back to priceAt.
    for (const rec of parsed.records) {
      if (typeof rec.checkedAt !== "number") rec.checkedAt = rec.priceAt;
    }
    adopt(parsed.records);
    updatedAt = Number(parsed.updatedAt) || 0;
    // Ticks outlive a restart: they came down with the snapshot, and pulling a
    // thousand series again every time the dev server respawns would be rude
    // to an endpoint that costs us nothing.
    restoreTicks(parsed.ticksAt);
    return true;
  } catch {
    // Missing or corrupt snapshot is normal on a fresh box — rebuild instead.
    return false;
  }
}

function saveSnapshot(): void {
  try {
    mkdirSync(path.dirname(TOKEN_INDEX_FILE), { recursive: true });
    writeFileSync(
      TOKEN_INDEX_FILE,
      JSON.stringify({ updatedAt, ticksAt: ticksUpdatedAt(), records }),
      "utf8",
    );
  } catch (err) {
    console.warn("[tokens] snapshot write failed:", err);
  }
}

// —— Refresh ——

/**
 * Fraction of the previous index a rebuild must reach to be believed.
 *
 * fetchTokenRecords succeeds if *any* source answered, which is the right call
 * for resilience and the wrong one for adoption: when the verified list — much
 * the largest — times out and the small ones do not, the rebuild returns a
 * genuine but tiny index. Adopting it drops most of the site's price cards, and
 * saveSnapshot then writes that over the good copy, so a restart cannot recover
 * either. A rebuild this much smaller than what we already hold is treated as a
 * partial fetch rather than as news about the market.
 */
const MIN_REBUILD_RATIO = 0.5;

async function refreshIndex(): Promise<void> {
  try {
    const list = await fetchTokenRecords();

    if (records.length && list.length < records.length * MIN_REBUILD_RATIO) {
      console.warn(
        `[tokens] rebuild returned ${list.length} mints against ${records.length} held;` +
          " treating as a partial fetch and keeping the current index",
      );
      return;
    }

    // A rebuild replaces every record object, but last hour's shapes are still
    // last hour's shapes — carry them across so cards keep their line while
    // the refresh below runs, rather than losing it for a few minutes an hour.
    const ticks = new Map(
      records.filter((r) => r.ticks).map((r) => [r.mint, r.ticks!]),
    );
    for (const rec of list) {
      const carried = ticks.get(rec.mint);
      if (carried) rec.ticks = carried;
    }

    adopt(list);
    saveSnapshot();
    console.log(`[tokens] indexed ${list.length} mints`);
  } catch (err) {
    // Keep serving the previous index; a stale price beats a broken card.
    console.warn("[tokens] index refresh failed:", err);
    return;
  }

  // Outside the try on purpose: the line is decoration on top of a working
  // index, and the index is already adopted and saved by the time this runs.
  if (ticksFresh()) return;
  await refreshTicks(records);
  saveSnapshot();
}

/**
 * Refresh one mint's price in the background. Deliberately not awaited by the
 * request path: the caller already has a usable price, and blocking a search on
 * a third-party RPC is exactly the latency this app exists to avoid.
 */
function refreshPrice(rec: TokenRecord): void {
  if (inFlight.has(rec.mint)) return;

  const task = (async () => {
    try {
      const price = await fetchPrice(rec.mint);
      if (price != null) {
        rec.price = price;
        rec.priceAt = Date.now();
      }
      // No live quote (unverified mint, no Helius URL, or no feed): leave
      // priceAt alone. Only checkedAt moves, so the age we show stays truthful
      // about the price we are actually serving.
    } catch (err) {
      console.warn(`[tokens] price refresh failed for ${rec.symbol}:`, err);
    } finally {
      // Back off for a full TTL either way — a failing mint must not re-ask on
      // every search.
      rec.checkedAt = Date.now();
      inFlight.delete(rec.mint);
    }
  })();

  inFlight.set(rec.mint, task);
}

// —— Public API ——

/**
 * Project the index entry down to what the client is allowed to see.
 *
 * `verified`, `liquidity` and price age stay server-side. Age in particular is
 * withheld deliberately: publishing it would let anyone read our refresh
 * cadence off the API, and suppressing it only in the UI would not have hidden
 * it.
 */
function toQuote(rec: TokenRecord): TokenQuote {
  return {
    mint: rec.mint,
    symbol: rec.symbol,
    name: rec.name,
    price: rec.price,
    ...(rec.change24h != null ? { change24h: rec.change24h } : {}),
    ...(rec.mcap != null ? { mcap: rec.mcap } : {}),
    ...(rec.decimals != null ? { decimals: rec.decimals } : {}),
    ...(rec.ticks ? { ticks: rec.ticks } : {}),
  };
}

/**
 * Resolve a query to the quotes worth rendering, best first.
 *
 * Synchronous by design — it reads the in-memory index and returns whatever
 * prices are already cached, then kicks off live refreshes for the stale ones.
 * The search response is never delayed; the next search for the same tokens
 * gets the fresher numbers. Every card shown gets refreshed, not just the
 * leader: a stale price on the second card is exactly as wrong as on the first.
 */
export function lookupTokens(
  query: string,
  limit: number = MAX_CANDIDATES,
): TokenQuote[] {
  const recs = matchTokens(query, index, limit);
  const now = Date.now();

  for (const rec of recs) {
    if (now - rec.checkedAt > TOKEN_PRICE_TTL_MS) refreshPrice(rec);
  }

  return recs.map(toQuote);
}

/** Single best quote, for callers that render exactly one cell. */
export function lookupToken(query: string): TokenQuote | null {
  return lookupTokens(query, 1)[0] ?? null;
}

/**
 * Retry schedule for a cold start with nothing to serve.
 *
 * The hourly cadence is right for keeping a working index fresh and badly wrong
 * for acquiring one: a container that boots while Jupiter is briefly unreachable
 * has no snapshot and no records, so every price card and the entire home strip
 * are blank — and the next attempt is an hour away. These back off from seconds
 * to minutes, so a blip costs a moment rather than the rest of the hour, and a
 * genuine outage is not hammered. Only used while the index is *empty*; once
 * anything is held, a stale price beats a retry storm and the hourly job resumes.
 */
const COLD_RETRY_MS = [5_000, 15_000, 60_000, 300_000];

/** Load any snapshot, then refresh now and hourly thereafter. */
export function startTokenIndex(): void {
  if (loadSnapshot()) {
    const age = Math.round((Date.now() - updatedAt) / 60_000);
    console.log(`[tokens] loaded ${records.length} mints from snapshot (${age}m old)`);
  }

  const timer = setInterval(() => void refreshIndex(), TOKEN_INDEX_INTERVAL_MS);
  // Don't hold the process open for the index alone.
  timer.unref();

  void (async () => {
    await refreshIndex();
    for (const delay of COLD_RETRY_MS) {
      if (records.length) return;
      console.warn(
        `[tokens] index still empty; retrying in ${Math.round(delay / 1000)}s` +
          " (no prices are being served until it fills)",
      );
      await new Promise((resolve) => {
        const t = setTimeout(resolve, delay);
        t.unref();
      });
      await refreshIndex();
    }
    if (!records.length) {
      console.error(
        "[tokens] index empty after every cold-start retry; falling back to the" +
          " hourly schedule. Search works; price cards and the home strip do not.",
      );
    }
  })();
}
