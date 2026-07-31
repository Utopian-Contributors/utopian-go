import path from "path";

export const PORT = Number(process.env.PORT) || 3000;
export const BRAVE_API_KEY = process.env.BRAVE_API_KEY || "";
export const BRAVE_ENDPOINT = "https://api.search.brave.com/res/v1/web/search";
export const BRAVE_IMAGES_ENDPOINT =
  "https://api.search.brave.com/res/v1/images/search";

// —— Solana token index ——

/**
 * Helius RPC URL (DAS-enabled). Used for live per-token price refresh via
 * `getAsset` + `showFungible`. Empty = index prices only, no live refresh.
 */
export const HELIUS_RPC_URL = process.env.HELIUS_RPC_URL || "";

/**
 * Jupiter Tokens V2. `lite-api` is the keyless free tier; `api.jup.ag` would
 * need an x-api-key header. Supplies the hourly identity + ranking index.
 */
export const JUP_TOKENS_ENDPOINT = "https://lite-api.jup.ag/tokens/v2";

/** Full index rebuild cadence. */
export const TOKEN_INDEX_INTERVAL_MS = 3_600_000;

/**
 * Per-mint price freshness. Helius caches prices ~10min upstream, so anything
 * below that is a soft floor — this only bounds how often we ask.
 */
export const TOKEN_PRICE_TTL_MS = 60_000;

/** Live price fetches are best-effort; never let one hang a search. */
export const TOKEN_PRICE_TIMEOUT_MS = 4_000;

/** Index fetches are larger; give them more room but still bound them. */
export const TOKEN_INDEX_TIMEOUT_MS = 20_000;

/** Disk snapshot so a restart doesn't cold-start the index. */
export const TOKEN_INDEX_FILE = path.join(process.cwd(), ".cache", "tokens.json");

/**
 * Liquidity floor for everything that isn't a tokenized real-world asset.
 *
 * A price card implies a real market, and a thin memecoin whose name collides
 * with an English word ("Bankcoin", "Bitcoin Pizza") would otherwise hijack
 * ordinary searches. Tokenized equities are exempt: their price comes from an
 * issuer tracking the underlying, not from AMM depth, so a quiet order book
 * doesn't make the quote wrong.
 */
export const TOKEN_MIN_LIQUIDITY_USD = 25_000;
