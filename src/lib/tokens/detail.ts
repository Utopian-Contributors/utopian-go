import { JUP_TOKENS_ENDPOINT, TOKEN_PRICE_TIMEOUT_MS } from "../../config";
import { JupStats, JupToken, TokenDetail, TokenRecord, TokenWindow } from "../../types";
import { JupiterBusy, jupFetch } from "../jupiterGate";
import { hasIcon } from "./icons";
import { lookupMints } from "./store";

const WSOL_MINT = "So11111111111111111111111111111111111111112";
/** Market stats this recent are served as they are. */
const FRESH_MS = 60_000;
/** After a failed or refused refresh, wait this long before asking again. */
const RETRY_MS = 30_000;
const MAX_CACHED = 500;

/**
 * Last good answer per mint. A failure never replaces one: stale stats are
 * still the right shape, and the price and the line come from the index.
 */
const cache = new Map<string, { at: number; token: JupToken | null; triedAt: number }>();
const inFlight = new Map<string, Promise<JupToken | null>>();

function num(v: unknown): number | undefined {
  const n = Number(v);
  return v != null && Number.isFinite(n) ? n : undefined;
}

function https(v: unknown): string | undefined {
  if (typeof v !== "string" || v.length > 300) return undefined;
  try {
    return new URL(v).protocol === "https:" ? v : undefined;
  } catch {
    return undefined;
  }
}

function toWindow(s: JupStats | undefined): TokenWindow | undefined {
  if (!s) return undefined;
  return {
    change: num(s.priceChange),
    buyVolume: num(s.buyVolume),
    sellVolume: num(s.sellVolume),
    buys: num(s.numBuys),
    sells: num(s.numSells),
    traders: num(s.numTraders),
  };
}

async function fetchJup(mint: string): Promise<JupToken | null> {
  const res = await jupFetch(
    `${JUP_TOKENS_ENDPOINT}/search?query=${encodeURIComponent(mint)}`,
    { headers: { Accept: "application/json" } },
    "detail",
    { timeoutMs: TOKEN_PRICE_TIMEOUT_MS },
  );
  if (!res.ok) throw new Error(`Jupiter responded ${res.status}`);
  const body = (await res.json()) as unknown;
  return Array.isArray(body) ? ((body as JupToken[]).find((t) => t.id === mint) ?? null) : null;
}

function remember(mint: string, entry: { at: number; token: JupToken | null; triedAt: number }): void {
  cache.delete(mint);
  cache.set(mint, entry);
  if (cache.size > MAX_CACHED) cache.delete(cache.keys().next().value!);
}

/**
 * Jupiter's market data for one mint, fetched only when a panel asks for it.
 *
 * Fresh for a minute. Past that it is refreshed if the shared lite-api budget
 * has room above what trades need; otherwise, or when Jupiter fails, the last
 * answer is served. A mint nobody opens is never asked about.
 */
async function marketData(mint: string): Promise<JupToken | null> {
  const now = Date.now();
  const hit = cache.get(mint);
  if (hit && (now - hit.at < FRESH_MS || now - hit.triedAt < RETRY_MS)) return hit.token;
  let task = inFlight.get(mint);
  if (!task) {
    task = fetchJup(mint)
      .then((token) => {
        const at = Date.now();
        remember(mint, { at, token, triedAt: at });
        return token;
      })
      .catch((err: unknown) => {
        if (!(err instanceof JupiterBusy)) console.warn(`[tokens] detail failed for ${mint}:`, err);
        const prior = cache.get(mint);
        remember(mint, { at: prior?.at ?? 0, token: prior?.token ?? null, triedAt: Date.now() });
        return prior?.token ?? null;
      })
      .finally(() => inFlight.delete(mint));
    inFlight.set(mint, task);
  }
  return task;
}

/** Null when the mint is not in the index: this is not a proxy for arbitrary Jupiter lookups. */
export async function tokenDetail(mint: string): Promise<TokenDetail | null> {
  const found = lookupMints([mint, WSOL_MINT]);
  const rec: TokenRecord | undefined = found.get(mint);
  if (!rec) return null;
  const sol = found.get(WSOL_MINT)?.price;
  const jup = await marketData(mint);
  const price = num(jup?.usdPrice) ?? rec.price;
  const windows: TokenDetail["windows"] = {
    "5m": toWindow(jup?.stats5m),
    "1h": toWindow(jup?.stats1h),
    "6h": toWindow(jup?.stats6h),
    "24h": toWindow(jup?.stats24h) ?? (rec.change24h != null ? { change: rec.change24h } : undefined),
  };
  return {
    mint,
    symbol: rec.symbol,
    name: rec.name,
    price,
    decimals: rec.decimals,
    priceSol: sol ? price / sol : undefined,
    liquidity: num(jup?.liquidity) ?? rec.liquidity,
    fdv: num(jup?.fdv),
    mcap: num(jup?.mcap) ?? rec.mcap,
    holders: num(jup?.holderCount),
    ticks: rec.ticks,
    tickLo: rec.tickLo,
    tickHi: rec.tickHi,
    ...(hasIcon(mint) ? { icon: true as const } : {}),
    links: {
      website: https(jup?.website),
      twitter: https(jup?.twitter),
      telegram: https(jup?.telegram),
      discord: https(jup?.discord),
    },
    windows,
  };
}
