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
import { TokenIndex, matchToken } from "./match";

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
    };
    if (!Array.isArray(parsed.records) || !parsed.records.length) return false;
    // Snapshots written before checkedAt existed fall back to priceAt.
    for (const rec of parsed.records) {
      if (typeof rec.checkedAt !== "number") rec.checkedAt = rec.priceAt;
    }
    adopt(parsed.records);
    updatedAt = Number(parsed.updatedAt) || 0;
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
      JSON.stringify({ updatedAt, records }),
      "utf8",
    );
  } catch (err) {
    console.warn("[tokens] snapshot write failed:", err);
  }
}

// —— Refresh ——

async function refreshIndex(): Promise<void> {
  try {
    const list = await fetchTokenRecords();
    adopt(list);
    saveSnapshot();
    console.log(`[tokens] indexed ${list.length} mints`);
  } catch (err) {
    // Keep serving the previous index; a stale price beats a broken card.
    console.warn("[tokens] index refresh failed:", err);
  }
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
 * Resolve a query to a quote. Synchronous by design — it reads the in-memory
 * index and returns whatever price is already cached, then kicks off a live
 * refresh if that price is stale. The search response is never delayed; the
 * next search for the same token gets the fresher number.
 */
export function lookupToken(query: string): TokenQuote | null {
  const rec = matchToken(query, index);
  if (!rec) return null;

  const now = Date.now();
  if (now - rec.checkedAt > TOKEN_PRICE_TTL_MS) refreshPrice(rec);

  return {
    mint: rec.mint,
    symbol: rec.symbol,
    name: rec.name,
    price: rec.price,
    ...(rec.change24h != null ? { change24h: rec.change24h } : {}),
    ...(rec.mcap != null ? { mcap: rec.mcap } : {}),
    // `verified` stays server-side: it ranks ticker collisions but the card
    // doesn't display it, so shipping it would be dead bytes on every search.
    age: Math.max(0, Math.round((now - rec.priceAt) / 1000)),
  };
}

/** Load any snapshot, then refresh now and hourly thereafter. */
export function startTokenIndex(): void {
  if (loadSnapshot()) {
    const age = Math.round((Date.now() - updatedAt) / 60_000);
    console.log(`[tokens] loaded ${records.length} mints from snapshot (${age}m old)`);
  }

  void refreshIndex();
  const timer = setInterval(() => void refreshIndex(), TOKEN_INDEX_INTERVAL_MS);
  // Don't hold the process open for the index alone.
  timer.unref();
}
