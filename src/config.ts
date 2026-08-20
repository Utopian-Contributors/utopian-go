import path from "path";

export const PORT = Number(process.env.PORT) || 3000;

/** Canonical public origin. The fallback when the env var is unset. */
const DEFAULT_SITE_URL = "https://utopiango.com";

/**
 * Public origin. Only used to absolutise the social card URL: crawlers are
 * inconsistent about resolving a relative `og:image` against the page, and X
 * in particular just shows no card at all.
 *
 * Defaulted rather than left empty. It was empty, and the deploy never set it
 * — so production shipped `content="/og.png"` and every link posted to X went
 * out bare. Nothing here is per-deploy secret: there is one canonical origin,
 * so it belongs in the code, and the env var stays for staging hosts that need
 * to point the tag at themselves. A dev build naming the production card is
 * harmless — no crawler ever reads a page served off localhost.
 */
export const SITE_URL = (process.env.SITE_URL || DEFAULT_SITE_URL).replace(/\/+$/, "");
export const BRAVE_API_KEY = process.env.BRAVE_API_KEY || "";

/**
 * How long a search may wait on Brave.
 *
 * Every other outbound call in this app is bounded; this one was not, and an
 * unbounded fetch on the request path is how a slow upstream turns into a
 * queue of held-open sockets rather than into an error page. Well past Brave's
 * normal latency, so a timeout means something is actually wrong — and api.ts
 * already renders that as a 502 with the token card still attached.
 */
export const BRAVE_TIMEOUT_MS = 8_000;
export const BRAVE_ENDPOINT = "https://api.search.brave.com/res/v1/web/search";
export const BRAVE_IMAGES_ENDPOINT =
  "https://api.search.brave.com/res/v1/images/search";

/**
 * Web results per request, and the last page Brave will serve.
 *
 * Upstream caps `count` at 20 and `offset` at 9, so at this page size the feed
 * can reach 100 results before there is nothing left to ask for. Ten rather
 * than twenty because it is the step the scroll pays for: a continuation page
 * carries results and nothing else (see normalize in lib/brave.ts), which puts
 * one at a few hundred bytes on the wire instead of a second full response.
 *
 * The images endpoint takes no offset at all, which is why the feed is a
 * web-tab feature rather than a whole-SERP one.
 */
export const BRAVE_PAGE_SIZE = 10;
export const BRAVE_MAX_OFFSET = 9;

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

// —— 24h ticks ——

/**
 * Jupiter's chart data API — the candle series behind the line on a token
 * card. Separate host from the token index, keyless the same way.
 */
export const JUP_CHART_ENDPOINT = "https://datapi.jup.ag/v2/charts";

/**
 * 24 hourly candles is exactly a day, and about as many points as a line a
 * few hundred pixels wide can show apart. Finer would cost bytes on every
 * search response to draw detail nobody can see.
 */
export const TOKEN_TICKS_INTERVAL = "1_HOUR";
export const TOKEN_TICKS_COUNT = 24;

/**
 * Below half a day there is no day to draw. Brand-new mints, and tokenized
 * equities over a closed weekend, come back with a handful of candles; those
 * cards go out without a line rather than with one implying a history the
 * token doesn't have.
 */
export const TOKEN_TICKS_MIN_POINTS = 12;

/**
 * How stale a set of ticks has to be before an index rebuild refetches it.
 * Just under the index interval, so the hourly rebuild always refreshes but a
 * process restart — which also rebuilds the index — reuses the snapshot
 * instead of re-fetching a thousand series.
 */
export const TOKEN_TICKS_TTL_MS = 3_300_000;

/**
 * Series fetches per second, paced evenly rather than fired in a burst.
 *
 * The endpoint sits behind a burst limiter: a few hundred requests as fast as
 * the connection allows earns a 429 for the rest of the minute, which is how
 * a refresh ends up covering fifty tokens instead of every token. Measured
 * clean at 8/s sustained, so 6 leaves room and still walks the whole index in
 * about four minutes — a rounding error against an hourly job.
 */
export const TOKEN_TICKS_RPS = 6;

/**
 * Workers pulling from the queue. Only has to be deep enough that the pacing
 * above stays the constraint rather than round-trip latency.
 */
export const TOKEN_TICKS_CONCURRENCY = 6;

/** Attempts at a throttled series before giving up on it this hour. */
export const TOKEN_TICKS_RETRIES = 3;

/** One slow series must not stall the refresh behind it. */
export const TOKEN_TICKS_TIMEOUT_MS = 8_000;

// —— Swap referral ——

/**
 * Swap API V1. Keyless on lite-api; `api.jup.ag` would want an x-api-key.
 *
 * Keyless means shared: this host answers on a per-IP budget, and the hourly
 * token index (SOURCES in lib/tokens/jupiter.ts) spends from the same one. So
 * nothing on the request path may call it per visitor — a proxy in front of
 * this endpoint would put every visitor's traffic on the server's single IP and
 * starve the index, which is what every price card on the site is built from.
 * The browser calls it directly, once a wallet is connected, on its own budget.
 */
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
export const JUP_FEE_BPS = (() => {
  const raw = process.env.JUP_FEE_BPS;
  // `Number(raw) || 20` reads an explicit "0" as absent, because 0 is falsy —
  // so turning the fee off for a promotion or a compliance request silently
  // kept charging 20 bps, and the boot log agreed with the env var while the
  // swap disagreed with both. Absent and unparseable fall back; a real number,
  // including zero, is honoured.
  if (raw == null || raw.trim() === "") return 20;
  const parsed = Number(raw);
  if (!Number.isFinite(parsed)) return 20;
  return Math.min(100, Math.max(0, parsed));
})();

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

/**
 * Mints indexed by hand, whatever their depth.
 *
 * The floor above is aimed at tokens that would hijack a query they have no
 * claim to. A ticker nobody else uses, on the site the project itself runs,
 * hijacks nothing — so this is a named exemption rather than a lower floor,
 * which would let every thin memecoin through with it.
 *
 * These are also fetched individually: the hourly index is built from
 * Jupiter's verified, lst and top-traded lists, and a mint this small is in
 * none of them. See SOURCES in lib/tokens/jupiter.ts.
 */
export const TOKEN_PINNED_MINTS = new Set([
  // $UTCC — Utopian Contributor Coin, this project's own token.
  "HGTXnhgyast5fJKhMcE4VgyeEVWhYKEsHxpZtpjhrYqA",
]);
