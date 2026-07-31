import { TokenRecord } from "../../types";

/** Lookup maps built by the store. Keys are pre-normalized. */
export interface TokenIndex {
  /** UPPERCASE symbol → mints sharing it. */
  bySymbol: Map<string, TokenRecord[]>;
  /** lowercase name → mints sharing it. */
  byName: Map<string, TokenRecord[]>;
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
  /** Query with `$` and trailing qualifiers removed. */
  term: string;
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
  // Strip one trailing qualifier: "bonk token" → "bonk".
  if (words.length > 1) {
    const last = words[words.length - 1].toLowerCase();
    if (TRAILING_QUALIFIERS.has(last)) words.pop();
  }
  if (!words.length || words.length > 4) return null;

  const term = words.join(" ");
  // Single characters are never specific enough to price.
  if (term.length < 2) return null;
  // Tickers and names are word-ish; reject anything with URL/operator syntax.
  if (!/^[\w .\-]+$/.test(term)) return null;

  return { term, explicit };
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
 * Pick a winner only when it is clearly the winner. Showing the wrong token's
 * price under a familiar ticker is a worse failure than showing nothing, so an
 * unresolved tie yields null.
 */
function decide(candidates: TokenRecord[]): TokenRecord | null {
  if (!candidates.length) return null;
  const sorted = [...candidates].sort(rank);
  const [top, runner] = sorted;
  if (!runner) return top;
  // A tokenized equity outranks anything that isn't one.
  if (!top.equity !== !runner.equity) return top;
  // A verified mint always beats an unverified one.
  if (top.verified !== runner.verified) return top;
  // Same tier: demand a decisive liquidity margin.
  return top.liquidity >= runner.liquidity * 3 ? top : null;
}

/**
 * Resolve a search query to a single token, or null to render no card.
 * Symbol matches outrank name matches — people type tickers to mean tickers.
 */
export function matchToken(
  raw: string,
  index: TokenIndex,
): TokenRecord | null {
  const q = normalizeQuery(raw);
  if (!q) return null;

  const symbolKey = q.term.toUpperCase();
  if (!q.explicit && STOPWORD_SYMBOLS.has(symbolKey)) return null;

  const bySymbol = index.bySymbol.get(symbolKey);
  if (bySymbol?.length) return decide(bySymbol);

  const byName = index.byName.get(q.term.toLowerCase());
  if (byName?.length) return decide(byName);

  return null;
}
