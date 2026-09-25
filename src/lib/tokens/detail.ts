import { JUP_TOKENS_ENDPOINT, TOKEN_PRICE_TIMEOUT_MS } from "../../config";
import { JupStats, JupToken, TokenDetail, TokenRecord, TokenWindow } from "../../types";
import { hasIcon } from "./icons";
import { lookupMints } from "./store";

const WSOL_MINT = "So11111111111111111111111111111111111111112";
const TTL_MS = 30_000;
const MAX_CACHED = 500;

const cache = new Map<string, { at: number; token: JupToken | null }>();
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
  const res = await fetch(`${JUP_TOKENS_ENDPOINT}/search?query=${encodeURIComponent(mint)}`, {
    headers: { Accept: "application/json" },
    signal: AbortSignal.timeout(TOKEN_PRICE_TIMEOUT_MS),
  });
  if (!res.ok) throw new Error(`Jupiter responded ${res.status}`);
  const body = (await res.json()) as unknown;
  return Array.isArray(body) ? ((body as JupToken[]).find((t) => t.id === mint) ?? null) : null;
}

/** Jupiter's market data for one mint, held for 30 s so a page of clicks is one upstream call each. */
async function marketData(mint: string): Promise<JupToken | null> {
  const hit = cache.get(mint);
  if (hit && Date.now() - hit.at < TTL_MS) return hit.token;
  let task = inFlight.get(mint);
  if (!task) {
    task = fetchJup(mint)
      .catch((err: unknown) => {
        console.warn(`[tokens] detail failed for ${mint}:`, err);
        return null;
      })
      .then((token) => {
        cache.delete(mint);
        cache.set(mint, { at: Date.now(), token });
        if (cache.size > MAX_CACHED) cache.delete(cache.keys().next().value!);
        return token;
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
