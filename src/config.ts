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

// —— Swap referral ——

/** Swap API V1. Keyless on lite-api; `api.jup.ag` would want an x-api-key. */
export const JUP_SWAP_ENDPOINT = "https://lite-api.jup.ag/swap/v1";

/**
 * Referral account from https://referral.jup.ag. Kept for provenance — the swap
 * itself never sends it, since V1 takes the derived token account instead.
 *
 * Both spellings are read because the deployed .env uses the single-r variant.
 */
export const JUP_REFERRAL_ACCOUNT =
  process.env.JUP_REFERAL_ACCOUNT || process.env.JUP_REFERRAL_ACCOUNT || "";

/**
 * Referral *token* accounts that collect our cut — Swap V1's `feeAccount`.
 *
 * Each is a PDA of ["referral_ata", referralAccount, mint] under REFER4Zg…,
 * created once from the referral dashboard. Jupiter charges the fee on
 * whichever side of the trade matches the account it is handed, so we need one
 * per quote token rather than one per tradable token:
 *
 *   buy  SOL → BONK, pass the SOL account  → fee taken on the input  (SOL)
 *   sell BONK → SOL, pass the SOL account  → fee taken on the output (SOL)
 *
 * Both verified by simulation: a 1 SOL buy credits exactly 2,000,000 lamports
 * at 20 bps, and the sell direction credits the same account on the way back.
 * The quote's `platformFee` field reports the amount in the output mint even
 * when the charge lands on the input — trust the simulated balance delta, not
 * that field.
 *
 * Empty disables fees for that side; the swap still works, unattributed.
 */
export const JUP_FEE_ACCOUNT_SOL =
  process.env.JUP_FEE_ACCOUNT_SOL || process.env.JUP_FEE_ACCOUNT || "";
export const JUP_FEE_ACCOUNT_USDC = process.env.JUP_FEE_ACCOUNT_USDC || "";

/**
 * Integrator fee in basis points, charged to the user on each swap.
 *
 * Bounded at 100 (1%) because this is real money taken from someone buying —
 * a fat-fingered env var should cost us revenue, not overcharge a user. Note
 * this is the classic Swap V1 path, which has none of Ultra's 50–255 floor.
 */
export const JUP_FEE_BPS = Math.min(
  100,
  Math.max(0, Number(process.env.JUP_FEE_BPS) || 20),
);

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
