import { mkdirSync, readFileSync, writeFileSync } from "fs";
import path from "path";
import {
  TOKEN_INDEX_FILE,
  TOKEN_INDEX_INTERVAL_MS,
  TOKEN_PRICE_TTL_MS,
} from "../../config";
import { TokenQuote, TokenRecord, TopToken } from "../../types";
import { fetchPrice } from "./helius";
import { hasIcon, restoreIcons, syncIcons } from "./icons";
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
let index: TokenIndex = {
  bySymbol: new Map(),
  byName: new Map(),
  byMint: new Map(),
};
let updatedAt = 0;
/** Verified records by 24h volume, highest first. Volume only changes on a rebuild. */
let ranked: TokenRecord[] = [];

/** In-flight price refreshes, keyed by mint, so N searches cause one fetch. */
const inFlight = new Map<string, Promise<void>>();

function buildIndex(list: TokenRecord[]): TokenIndex {
  const bySymbol = new Map<string, TokenRecord[]>();
  const byName = new Map<string, TokenRecord[]>();
  const byMint = new Map<string, TokenRecord>();

  /** Push once — a record whose alias equals its own symbol must not double up. */
  const add = (map: Map<string, TokenRecord[]>, key: string, rec: TokenRecord) => {
    const bucket = map.get(key);
    if (!bucket) map.set(key, [rec]);
    else if (!bucket.includes(rec)) bucket.push(rec);
  };

  for (const rec of list) {
    byMint.set(rec.mint, rec);
    add(bySymbol, rec.symbol.toUpperCase(), rec);
    add(byName, rec.name.toLowerCase(), rec);
    // Aliases go into both maps; an equity's ticker alias competes with real
    // symbols, which is exactly what lets the ambiguity guard adjudicate it.
    for (const alias of rec.aliases ?? []) {
      add(bySymbol, alias.toUpperCase(), rec);
      add(byName, alias.toLowerCase(), rec);
    }
  }

  return { bySymbol, byName, byMint };
}

function adopt(list: TokenRecord[]): void {
  records = list;
  index = buildIndex(list);
  ranked = list
    .filter((r) => r.verified && (r.volume24h ?? 0) > 0)
    .sort((a, b) => (b.volume24h ?? 0) - (a.volume24h ?? 0));
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
    //
    // The range travels with the shape. tickLo/tickHi are what turn the bytes
    // back into prices, so a shape carried without them still draws a card and
    // no longer values a portfolio — decodeTicks refuses it, every holding is
    // held flat, and the wallet page's line disappears. And because the rebuild
    // saves its snapshot on the next line, dropping them here did not cost one
    // hour of chart: it wrote a rangeless index to disk that every later boot
    // loaded and every later rebuild carried forward.
    const prior = new Map(records.filter((r) => r.ticks).map((r) => [r.mint, r]));
    for (const rec of list) {
      const was = prior.get(rec.mint);
      if (!was) continue;
      rec.ticks = was.ticks;
      rec.tickLo = was.tickLo;
      rec.tickHi = was.tickHi;
    }

    adopt(list);
    saveSnapshot();
    console.log(`[tokens] indexed ${list.length} mints`);
  } catch (err) {
    // Keep serving the previous index; a stale price beats a broken card.
    console.warn("[tokens] index refresh failed:", err);
    return;
  }

  // Every indexed logo, busiest first, since the wallet page's filter can list any of them.
  void syncIcons([...records].sort((a, b) => (b.volume24h ?? 0) - (a.volume24h ?? 0)));

  // Outside the try on purpose: the line is decoration on top of a working
  // index, and the index is already adopted and saved by the time this runs.
  //
  // Freshness is a claim about the clock, so on its own it cannot see a shape
  // that arrived without its range — carried over from a snapshot written
  // before ranges were kept, say. Those are fresh and undecodable at the same
  // time, and left to the clock alone they are carried forward another hour
  // before anything re-encodes them. Re-encoding is the only way to acquire a
  // range, so a rangeless index is never fresh enough to skip.
  const ranged = records.some((r) => r.ticks && r.tickLo != null);
  if (ranged && ticksFresh()) return;
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

/**
 * Prices for mints the caller already knows the identity of.
 *
 * The inverse of lookupTokens: no matching, no ranking, no ambiguity to
 * adjudicate — a wallet's holdings arrive as mint addresses, and the only
 * question is what each one is worth. Mints the index does not carry are
 * absent from the result rather than guessed at, which is what lets the wallet
 * page count them instead of pricing them.
 *
 * Deliberately does not kick off per-mint refreshes the way lookupTokens does.
 * A portfolio can name fifty mints at once, and fifty on-demand price calls per
 * page load is a cost the hourly rebuild already covers.
 */
export function lookupMints(mints: string[]): Map<string, TokenRecord> {
  const out = new Map<string, TokenRecord>();
  for (const mint of mints) {
    const rec = index.byMint.get(mint);
    if (rec) out.set(mint, rec);
  }
  return out;
}

function toTop(rec: TokenRecord): TopToken {
  return {
    mint: rec.mint,
    symbol: rec.symbol,
    name: rec.name,
    price: rec.price,
    ...(rec.change24h != null ? { change24h: rec.change24h } : {}),
    ...(rec.decimals != null ? { decimals: rec.decimals } : {}),
    volume: rec.volume24h ?? 0,
    ...(hasIcon(rec.mint) ? { icon: true as const } : {}),
  };
}

/** The most-traded verified tokens, for the wallet page. */
export function topTokens(limit: number): TopToken[] {
  return ranked.slice(0, limit).map(toTop);
}

/**
 * The wallet page's filter: every indexed token whose mint, symbol or name
 * matches, closest first, then verified, then by volume.
 */
export function searchTokens(raw: string, limit: number): TopToken[] {
  const q = raw.trim().replace(/^\$/, "").toLowerCase();
  if (!q) return topTokens(limit);
  const hits: { rec: TokenRecord; rank: number }[] = [];
  for (const rec of records) {
    const sym = rec.symbol.toLowerCase();
    const name = rec.name.toLowerCase();
    const rank =
      rec.mint === raw.trim() || sym === q
        ? 0
        : sym.startsWith(q)
          ? 1
          : name.startsWith(q)
            ? 2
            : name.includes(q) || sym.includes(q)
              ? 3
              : -1;
    if (rank >= 0) hits.push({ rec, rank });
  }
  hits.sort(
    (a, b) =>
      a.rank - b.rank ||
      Number(b.rec.verified) - Number(a.rec.verified) ||
      (b.rec.volume24h ?? 0) - (a.rec.volume24h ?? 0) ||
      b.rec.liquidity - a.rec.liquidity,
  );
  return hits.slice(0, limit).map((hit) => toTop(hit.rec));
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
  restoreIcons();
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
