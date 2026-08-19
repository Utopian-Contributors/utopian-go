import { TokenRecord } from "../../types";

/** Lookup maps built by the store. Keys are pre-normalized. */
export interface TokenIndex {
  /** UPPERCASE symbol → mints sharing it. */
  bySymbol: Map<string, TokenRecord[]>;
  /** lowercase name → mints sharing it. */
  byName: Map<string, TokenRecord[]>;
  /**
   * Mint address → its record. Unlike the two above this cannot collide, and
   * matchTokens never reads it: it exists for the wallet page, which arrives
   * already knowing exactly which mints it holds and needs prices for them
   * rather than a search over them.
   */
  byMint: Map<string, TokenRecord>;
}

/**
 * Tickers that are also ordinary English. Searching "go" or "the" must return
 * the web, not a price card — so these only match with an explicit `$` prefix.
 */
const STOPWORD_SYMBOLS = new Set(
  ("a all am an and any are art be big book box boy buy by can cash cat do dog" +
    " eat end fair few first for fun game gas get go good gm hi home hot how i" +
    " id if in is it its life like live love low make man map me more moon my" +
    " new news no not now of off ok on one only or our out own pay play run see" +
    " so star the time to top try two up us use was we web who why win work you")
    .toUpperCase()
    .split(" "),
);

/**
 * Full names of majors that have no mint of their own, mapped to the ticker
 * their wrappers carry. Without this, "bitcoin" matches a memecoin whose symbol
 * is literally BITCOIN — the highest-traffic query in crypto landing on a
 * $0.009 joke token. `$bitcoin` still reaches that token; the bare word does not.
 */
const MAJOR_NAMES = new Map([
  ["BITCOIN", "BTC"],
  ["ETHEREUM", "ETH"],
  ["ETHER", "ETH"],
  // "SOLANA" is squatted by a $3M staked-SOL derivative; the query means SOL.
  ["SOLANA", "SOL"],
  ["TETHER", "USDT"],
]);

/** Trailing words people add to a ticker. "sol price" is a search for SOL. */
const TRAILING_QUALIFIERS = new Set([
  "price",
  "prices",
  "usd",
  "chart",
  "token",
  "coin",
  "crypto",
  "value",
]);

interface NormalizedQuery {
  /**
   * Candidate terms in priority order: the query as typed, then a
   * qualifier-stripped fallback. Order matters — stripping first would clip
   * "USD Coin" to "USD" and lose the exact name match.
   */
  terms: string[];
  /** True when the user wrote `$FOO` — an unambiguous ticker intent. */
  explicit: boolean;
}

/** Returns null for anything that cannot plausibly be a ticker or token name. */
export function normalizeQuery(raw: string): NormalizedQuery | null {
  let q = raw.trim().replace(/\s+/g, " ");
  if (!q || q.length > 48) return null;

  const explicit = q.startsWith("$");
  if (explicit) q = q.slice(1).trim();

  const words = q.split(" ");
  if (!words.length || words.length > 4) return null;

  const terms = [words.join(" ")];
  // "sol price" → also try "sol", but only after the full phrase misses.
  const last = words[words.length - 1].toLowerCase();
  if (words.length > 1 && TRAILING_QUALIFIERS.has(last)) {
    terms.push(words.slice(0, -1).join(" "));
  }

  const valid = terms.filter(
    // Single characters are never specific enough to price, and tickers are
    // word-ish — reject anything carrying URL or operator syntax.
    (t) => t.length >= 2 && /^[\w .\-]+$/.test(t),
  );
  return valid.length ? { terms: valid, explicit } : null;
}

/**
 * Rank collisions. Ticker reuse is rampant on Solana — a dozen mints answer to
 * "USDC" — so class leads, then verification, then depth of liquidity.
 *
 * A tokenized equity beats a memecoin outright regardless of liquidity: when
 * "apple" matches both Apple xStock and a memecoin called "dog with apple in
 * mouth", the equity is what the query meant.
 */
function rank(a: TokenRecord, b: TokenRecord): number {
  if (!a.equity !== !b.equity) return a.equity ? -1 : 1;
  if (a.verified !== b.verified) return a.verified ? -1 : 1;
  return b.liquidity - a.liquidity;
}

/**
 * Two mints whose prices agree this closely are the same underlying asset, not
 * a choice the user has to make. WBTC and cbBTC sit ~0.15% apart.
 */
const SAME_ASSET_SPREAD = 0.02;

/**
 * Depth margin at which the leader stops being one candidate among several and
 * simply becomes the answer.
 *
 * This is the original single-winner guard, and it is load-bearing for a reason
 * that is easy to lose: wrapper aliasing puts foreign mints under a major's
 * ticker. "Gate Wrapped SOL" registers the alias "SOL", so the SOL bucket holds
 * both SOL and gtSOL — both verified, prices drifting a few percent apart. That
 * drift is a data artifact, not a choice worth offering, and rendering a second
 * "SOL" card at a different price is how someone buys the wrong thing.
 */
const DOMINANT_LIQUIDITY_RATIO = 3;

/**
 * How thin an alternative may be relative to the leader before it stops being a
 * market worth offering. Bounds the third card, which the dominance gate above
 * only constrains transitively.
 */
const MIN_RELATIVE_LIQUIDITY = 0.05;

/** Most cards we stack. Past three it stops reading as an answer. */
export const MAX_CANDIDATES = 3;

/**
 * Narrow a ranked bucket to the mints that are genuinely *alternatives* to the
 * leader, rather than everything that happened to share a lookup key.
 *
 * Ambiguity has to be earned. The leader is returned alone unless no candidate
 * dominates it on depth, which keeps the old single-winner behaviour for every
 * query that had a clear answer and only opens the stack for the ties that used
 * to render nothing at all.
 *
 * Past that gate, two filters shape the shortlist:
 *
 *  - Class. `rank` puts equities first, then verified, so once a candidate
 *    drops a class every candidate after it does too — hence `break`, not
 *    `continue`. This is what stops "apple" from stacking three dog memecoins
 *    under Apple xStock: a wrong price beside a familiar ticker is worse than
 *    no price.
 *
 *  - Price. Wrappers of the same underlying quote the same number. Two cards
 *    reading $118,204 and $118,381 are a duplicate, not a choice.
 *
 * Depth then bounds the tail: `rank` already sorted by liquidity, so the floor
 * check can `break` too.
 */
function alternatives(candidates: TokenRecord[], limit: number): TokenRecord[] {
  const sorted = [...candidates].sort(rank);
  const [top, runner] = sorted;
  if (!top) return [];
  if (!runner) return [top];
  // Decisive depth means the query has an answer, not a shortlist.
  if (top.liquidity >= runner.liquidity * DOMINANT_LIQUIDITY_RATIO) return [top];

  const out = [top];
  const floor = top.liquidity * MIN_RELATIVE_LIQUIDITY;

  for (const rec of sorted.slice(1)) {
    if (out.length >= limit) break;
    if (!rec.equity !== !top.equity) break;
    if (rec.verified !== top.verified) break;
    if (rec.liquidity < floor) break;
    const duplicate = out.some(
      (kept) =>
        Math.abs(kept.price - rec.price) / Math.max(kept.price, rec.price) <=
        SAME_ASSET_SPREAD,
    );
    if (!duplicate) out.push(rec);
  }

  return out;
}

/**
 * Resolve a search query to the tokens worth showing, best first. Empty means
 * render no card at all.
 *
 * Symbol matches outrank name matches — people type tickers to mean tickers —
 * and a bucket that produces any match wins outright, so a name collision never
 * gets stacked under a symbol hit.
 */
export function matchTokens(
  raw: string,
  index: TokenIndex,
  limit: number = MAX_CANDIDATES,
): TokenRecord[] {
  const q = normalizeQuery(raw);
  if (!q || limit < 1) return [];

  for (const term of q.terms) {
    let symbolKey = term.toUpperCase();
    if (!q.explicit && STOPWORD_SYMBOLS.has(symbolKey)) continue;
    // "bitcoin" means BTC, not the token that claimed the ticker. An explicit
    // `$bitcoin` opts out and gets the literal symbol.
    if (!q.explicit) symbolKey = MAJOR_NAMES.get(symbolKey) ?? symbolKey;

    const bySymbol = index.bySymbol.get(symbolKey);
    if (bySymbol?.length) return alternatives(bySymbol, limit);

    const byName = index.byName.get(term.toLowerCase());
    if (byName?.length) return alternatives(byName, limit);
  }

  return [];
}
