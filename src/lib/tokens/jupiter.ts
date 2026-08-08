import {
  JUP_TOKENS_ENDPOINT,
  TOKEN_INDEX_TIMEOUT_MS,
  TOKEN_MIN_LIQUIDITY_USD,
  TOKEN_PINNED_MINTS,
} from "../../config";
import { JupToken, TokenRecord } from "../../types";

/**
 * Hourly index source. Jupiter is the identity + ranking layer: it answers
 * "which mint does this ticker mean", which a Solana RPC cannot. Prices ride
 * along for free, giving every indexed token a warm price with zero extra
 * network cost — the lazy Helius refresh only ever improves on it.
 */

/**
 * Trusted sets first, then liquid movers — later pulls fill gaps, never
 * override. `lst` covers liquid-staking tokens (JitoSOL, mSOL, bSOL …), which
 * are trusted assets people search by name but that the verified tag misses.
 */
const SOURCES = [
  `${JUP_TOKENS_ENDPOINT}/tag?query=verified`,
  `${JUP_TOKENS_ENDPOINT}/tag?query=lst`,
  `${JUP_TOKENS_ENDPOINT}/toptraded/24h`,
  // Pinned mints, one lookup each. They are pinned precisely because no list
  // above carries them, so these are pure gap-fillers and go last.
  ...[...TOKEN_PINNED_MINTS].map(
    (mint) => `${JUP_TOKENS_ENDPOINT}/search?query=${encodeURIComponent(mint)}`,
  ),
];

async function fetchList(url: string): Promise<JupToken[]> {
  const res = await fetch(url, {
    headers: { Accept: "application/json" },
    signal: AbortSignal.timeout(TOKEN_INDEX_TIMEOUT_MS),
  });
  if (!res.ok) throw new Error(`Jupiter responded ${res.status} for ${url}`);
  const body = (await res.json()) as unknown;
  // V2 returns a bare array; tolerate a wrapped shape if that ever changes.
  if (Array.isArray(body)) return body as JupToken[];
  const tokens = (body as { tokens?: unknown })?.tokens;
  return Array.isArray(tokens) ? (tokens as JupToken[]) : [];
}

/** Jupiter tags that mark a mint as a tokenized equity / RWA. */
const EQUITY_TAGS = new Set(["stocks", "xstocks", "equities"]);

/**
 * Issuer wrappers appended to the underlying company's name. Each tokenizer
 * brands its mints differently, and none of those brands is what a person
 * types.
 */
const ISSUER_SUFFIX =
  /(\s+xstocks?|\s*-\s*backpack securities|\s*\(ondo tokenized\))$/i;

/**
 * Tokenized stocks are listed under their wrapper's identity — symbol "AAPLx",
 * name "Apple xStock". Nobody searches that. Register the underlying ticker and
 * company name as extra keys so "AAPL", "tesla" and "spacex" resolve.
 */
function equityAliases(symbol: string, name: string): string[] {
  const out: string[] = [];
  // AAPLx → AAPL. Only the lowercase wrapper suffix, never a capital X
  // (SPCX is its own ticker, not SPC + wrapper).
  if (symbol.length > 2 && symbol.endsWith("x")) out.push(symbol.slice(0, -1));
  // MUon → MU (Ondo appends a lowercase "on").
  if (symbol.length > 3 && symbol.endsWith("on")) out.push(symbol.slice(0, -2));
  // "Apple xStock" / "SpaceX - Backpack Securities" → "Apple" / "SpaceX"
  const base = name.replace(ISSUER_SUFFIX, "").trim();
  if (base && base.toLowerCase() !== name.toLowerCase()) out.push(base);
  return out;
}

/**
 * Wrapper prefix on a bridged asset's name: "Wrapped BTC", "Coinbase Wrapped
 * BTC", "OKX Wrapped BTC". Deliberately excludes "Staked" — JitoSOL is not SOL
 * and trades at its own price, so it must not inherit SOL's identity.
 */
const WRAPPER_PREFIX = /^(?:[\w.]+\s+)?wrapped\s+/i;

/**
 * Bitcoin has no mint on Solana — it exists only as WBTC, cbBTC, LBTC and
 * friends. Strip the wrapper and the bridge marker so the underlying ticker
 * ("BTC") and plain name ("Ether") become reachable keys.
 */
function wrappedAlias(name: string): string | null {
  const unbridged = name.replace(/\s*\([^)]*\)\s*$/, "").trim();
  const core = unbridged.replace(WRAPPER_PREFIX, "").trim();
  if (!core || core.toLowerCase() === name.toLowerCase()) return null;
  return core;
}

function toRecord(t: JupToken, now: number): TokenRecord | null {
  const mint = String(t.id ?? "").trim();
  const symbol = String(t.symbol ?? "").trim();
  const name = String(t.name ?? "").trim();
  const price = Number(t.usdPrice);
  if (!mint || !symbol || !Number.isFinite(price) || price <= 0) return null;

  const isEquity = (t.tags ?? []).some((tag) => EQUITY_TAGS.has(tag));
  const liquidity = Number(t.liquidity) || 0;
  // Tokenized RWAs are issuer-priced and admitted at any depth, and a pinned
  // mint was named by hand; everything else has to show a real market before
  // it can claim a price card.
  const exempt = isEquity || TOKEN_PINNED_MINTS.has(mint);
  if (!exempt && liquidity < TOKEN_MIN_LIQUIDITY_USD) return null;

  const verified = t.isVerified === true;
  const change24h = Number(t.stats24h?.priceChange);
  const mcap = Number(t.mcap);
  const decimals = Number(t.decimals);
  const aliases = isEquity
    ? equityAliases(symbol, name || symbol)
    : [wrappedAlias(name || symbol)].filter((a): a is string => !!a);

  return {
    mint,
    symbol,
    name: name || symbol,
    price,
    ...(Number.isFinite(change24h) ? { change24h } : {}),
    ...(Number.isFinite(mcap) && mcap > 0 ? { mcap } : {}),
    ...(Number.isInteger(decimals) && decimals >= 0 ? { decimals } : {}),
    liquidity,
    verified,
    ...(isEquity ? { equity: true } : {}),
    ...(aliases.length ? { aliases } : {}),
    priceAt: now,
    checkedAt: now,
  };
}

/**
 * Pull every source and dedupe by mint. A partial result beats none: if one
 * source fails we still index the other rather than leaving the index empty.
 */
export async function fetchTokenRecords(): Promise<TokenRecord[]> {
  const now = Date.now();
  const settled = await Promise.allSettled(SOURCES.map(fetchList));

  const byMint = new Map<string, TokenRecord>();
  let ok = 0;

  for (const result of settled) {
    if (result.status !== "fulfilled") {
      console.warn("[tokens] index source failed:", result.reason);
      continue;
    }
    ok += 1;
    for (const raw of result.value) {
      const rec = toRecord(raw, now);
      if (!rec) continue;
      const prev = byMint.get(rec.mint);
      // First source wins on identity; keep the deeper liquidity reading.
      if (!prev) byMint.set(rec.mint, rec);
      else if (rec.liquidity > prev.liquidity) prev.liquidity = rec.liquidity;
    }
  }

  if (!ok) throw new Error("all Jupiter index sources failed");
  return [...byMint.values()];
}
