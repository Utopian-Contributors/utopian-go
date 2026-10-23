export interface MetaUrl {
  netloc?: string;
  path?: string;
}

export interface Profile {
  name?: string;
  url?: string;
}

export interface Thumbnail {
  src: string;
}

export interface ClusterLink {
  title: string;
  url: string;
  description?: string;
}

export interface WebResult {
  title: string;
  url: string;
  description: string;
  profile?: Profile;
  meta_url?: MetaUrl;
  cluster?: ClusterLink[];
  age?: string;
}

export interface Infobox {
  title: string;
  description?: string;
  long_desc?: string;
  category?: string;
  thumbnail?: string;
  /** [label, value]; a multi-value row is newline-joined, one value per line. */
  attributes?: [string, string][];
  profiles?: Profile[];
}

export interface FaqItem {
  question: string;
  answer: string;
}

export interface NewsItem {
  title: string;
  url: string;
  description?: string;
  age?: string;
  meta_url?: MetaUrl;
}

export interface VideoItem {
  title: string;
  url: string;
  description?: string;
  meta_url?: MetaUrl;
  thumbnail?: Thumbnail;
}

export interface DiscussionItem {
  title: string;
  url: string;
  description?: string;
  meta_url?: MetaUrl;
}

export interface ImageItem {
  title: string;
  /** Page the image was found on */
  url: string;
  source?: string;
  /** Brave CDN thumbnail */
  thumbnail?: string;
  /** Original / full image URL when available */
  image?: string;
  width?: number;
  height?: number;
}

/**
 * A priced Solana token, as sent to the client. Rides along on the search
 * response — a separate endpoint would cost an extra round trip, which is the
 * whole budget on a bad link.
 */
export interface TokenQuote {
  mint: string;
  symbol: string;
  name: string;
  /** USD price of one token. */
  price: number;
  /** 24h price change, percent. */
  change24h?: number;
  /** Market cap, USD. */
  mcap?: number;
  /**
   * Mint decimals. Only needed to render the quoted output amount, which
   * Jupiter returns in base units — swapping itself never needs it, since the
   * amount we send is denominated in the input mint. Absent on records from a
   * snapshot written before this field existed; the UI drops the preview line
   * rather than guessing a scale.
   */
  decimals?: number;
  /**
   * 24 hourly closes as base64, one byte each, scaled so the day's low is 0
   * and its high is 255. 32 characters, which is what makes a chart
   * affordable on every response.
   */
  ticks?: string;
  /**
   * The price range `ticks` was scaled against, so that scrubbing the card's
   * line can read each hour back out as a price. Accurate to 1/255th of the
   * day's range — a fraction of a cent on anything that trades near a dollar.
   */
  tickLo?: number;
  tickHi?: number;
  /** Epoch ms the last tick's hour began; the hours before it follow one apart. */
  tickAt?: number;
}

/**
 * What a token is, read off Jupiter's tags (lib/tokens/jupiter.ts). One per
 * token, so the wallet page's breakdown adds up to its total.
 */
export type TokenKind = "majors" | "stocks" | "rwas" | "memes" | "defi" | "stables" | "other";

/**
 * The wallet page's lists: Trending, which cuts across kinds, then each kind
 * worth browsing. Stablecoins are not, and neither is the unsorted rest.
 */
export type TokenList = "trending" | Exclude<TokenKind, "stables" | "other">;

/** Server-side index entry. Superset of TokenQuote; never sent whole. */
export interface TokenRecord {
  mint: string;
  symbol: string;
  name: string;
  price: number;
  change24h?: number;
  mcap?: number;
  decimals?: number;
  liquidity: number;
  verified: boolean;
  /** Tokenized equity / ETF (xStocks and friends). Outranks memecoins. */
  equity?: boolean;
  /**
   * A stablecoin, or a yield-bearing receipt (Jupiter Lend's jlUSDC and the
   * like): money parked, not an asset people are trading into. Kept out of
   * Social's Trending assets.
   */
  stable?: true;
  /**
   * What it is, from its tags. Absent on a record from a snapshot written
   * before kinds were kept; kindOf (lib/tokens/store.ts) answers for those.
   */
  kind?: TokenKind;
  /**
   * Extra lookup keys. Tokenized equities trade as "AAPLx" / "Apple xStock",
   * but people search "AAPL" and "apple" — without aliases they are indexed
   * and unreachable.
   */
  aliases?: string[];
  /**
   * The token's 24h shape, encoded as for TokenQuote. Absent on a mint too
   * new — or too closed, for a tokenized equity over a weekend — to have a
   * day of candles behind it.
   */
  ticks?: string;
  /**
   * The price range `ticks` was scaled against, so the shape can be read back
   * as prices: by the wallet page's portfolio series, and by a scrubbed line
   * on a card. Absent on records restored from a snapshot written before
   * they were kept.
   */
  tickLo?: number;
  tickHi?: number;
  /** Epoch ms the last tick's hour began. Absent on snapshots written before it was kept. */
  tickAt?: number;
  /** 24h traded volume, USD, buys plus sells. */
  volume24h?: number;
  /** Where Jupiter says the logo lives. Server-side only; the client gets /icon/<mint>. */
  icon?: string;
  /** Epoch ms the price itself was sourced — drives the age shown to users. */
  priceAt: number;
  /**
   * Epoch ms we last asked for a fresher price, successful or not. Separate
   * from priceAt so a failed lookup backs off without making a stale price
   * look new.
   */
  checkedAt: number;
}

/**
 * Wallet balances for the tokens that can fund a swap, in base units as
 * strings — lamport counts outgrow JSON's safe integer range.
 */
export interface Balances {
  sol?: string;
  usdc?: string;
  /** The traded mint, when one was asked for — used to size a sell. */
  token?: string;
}

export interface BalancesApiResponse extends Balances {
  error?: string;
  /** Cause of a failure, development only. */
  detail?: string;
}

/**
 * One line of a portfolio: what is held, and what it is worth.
 *
 * `amount` stays a base-unit string for the same reason balances do — a large
 * holding of a nine-decimal mint outgrows JSON's safe integer range, and this
 * is a number people check against their wallet. `usd` is a display value
 * computed server-side, so every row on the page is valued by the same index
 * at the same instant rather than by whatever each client rounded to.
 */
export interface Holding {
  mint: string;
  symbol: string;
  name: string;
  /** Base units, summed across every token account for this mint. */
  amount: string;
  decimals: number;
  /** USD price of one token, from the same index the price cards read. */
  price: number;
  /** amount x price, in dollars. */
  usd: number;
  /** 24h price change, percent. */
  change24h?: number;
  /** A thumbnail is served at /icon/<mint>. */
  icon?: true;
  /** Which line of the breakdown it counts towards. */
  kind: TokenKind;
}

/**
 * How far back a chart looks. 24h is drawn from the hourly ticks every token
 * already carries; the others are fetched for a token when someone asks for
 * one (lib/tokens/history.ts).
 */
export type ChartRange = "1h" | "24h" | "1w" | "1m";

/**
 * A price line on the clock: `v` oldest first, `step` ms apart, the last
 * taken in the bucket that began at `at`. A token too new for the range has
 * fewer points, not invented ones.
 */
export interface PriceSeries {
  at: number;
  step: number;
  v: number[];
}

/** One line of the wallet page's breakdown: everything held of one kind. */
export interface PortfolioSlice {
  kind: TokenKind;
  /** USD, dust included, so the slices add up to Holdings.total. */
  usd: number;
  /** As Holdings.series, for this kind alone. */
  series?: number[];
  change?: number;
}

/** One row of the wallet page's lists. */
export interface TopToken {
  mint: string;
  symbol: string;
  name: string;
  price: number;
  change24h?: number;
  decimals?: number;
  /** 24h traded volume, USD. */
  volume: number;
  icon?: true;
}

/** One page of a wallet page list. */
export interface TokenPage {
  tokens: TopToken[];
  /** Everything on the list, not just this page. */
  total: number;
  /** Where the next page starts; absent on the last. */
  after?: string;
  /** Every list's length, on the first page only, so empty lists can go unoffered. */
  counts?: Record<TokenList, number>;
}

/** Social's rail: the top of Trending, and how long the whole of it is. */
export interface RailAssets {
  count: number;
  tokens: TopToken[];
}

export interface TokenWindow {
  change?: number;
  buyVolume?: number;
  sellVolume?: number;
  buys?: number;
  sells?: number;
  traders?: number;
}

/**
 * The wallet page's side panel for one indexed token. Market data comes from
 * Jupiter and may be missing; the price and the line come from the index.
 */
export interface TokenDetail {
  mint: string;
  symbol: string;
  name: string;
  price: number;
  decimals?: number;
  priceSol?: number;
  liquidity?: number;
  fdv?: number;
  mcap?: number;
  holders?: number;
  /** As TokenQuote's. */
  ticks?: string;
  tickLo?: number;
  tickHi?: number;
  tickAt?: number;
  icon?: true;
  /** https only. */
  links: { website?: string; twitter?: string; telegram?: string; discord?: string };
  windows: { "5m"?: TokenWindow; "1h"?: TokenWindow; "6h"?: TokenWindow; "24h"?: TokenWindow };
}

/**
 * A priced portfolio. The counts are the honest part: this page shows what it
 * can value and says how much it left out, rather than presenting a filtered
 * list as if it were everything.
 */
export interface Holdings {
  /** Rows worth showing, largest first. */
  items: Holding[];
  /** USD across everything held, including the rows omitted below. */
  total: number;
  /** The window `series` and the slices' lines cover. */
  range: ChartRange;
  /** The clock those lines are on, as PriceSeries' `at` and `step`. */
  seriesAt: number;
  seriesStep: number;
  /**
   * What these holdings were worth across `range`, in dollars, oldest first;
   * the last point is `total`.
   *
   * Read it for what it is: today's balances priced at each moment's price.
   * It is not a record of what the wallet held — the line is drawn from
   * today's balances, never from the wallet's history (see History below) —
   * so a position opened an hour ago appears across the whole window. What it does answer is the question people
   * actually have when they open this page: which way did the market move
   * what I am holding.
   *
   * Absent when too little of the portfolio has price history behind it for a
   * line to mean anything.
   */
  series?: number[];
  /** Change across `series`, percent. Present whenever `series` is. */
  change?: number;
  /** The total by kind, largest first. Only when there are three kinds or more. */
  slices?: PortfolioSlice[];
  /** Priced rows past the display cap. */
  more?: number;
  /** Priced rows worth less than a cent. */
  dust?: number;
  /** Mints the token index carries no price for — almost always airdrop spam. */
  unpriced?: number;
  /** Those mints and how much of each, the first fifty, so the page can name what it can. */
  unknown?: UnknownHolding[];
}

/** A held token the index carries no price for. */
export interface UnknownHolding {
  mint: string;
  /** Base units, as Holding's. */
  amount: string;
  decimals: number;
}

/**
 * What the chain says about a mint the index does not carry (lib/tokens/asset.ts).
 * The name and logo are its creator's own say-so, and any field may be missing.
 */
export interface TokenAsset {
  mint: string;
  name?: string;
  symbol?: string;
  /** https, for the browser to fetch itself: never synced to /icon/. */
  image?: string;
  decimals?: number;
  /** Base units. */
  supply?: string;
}

export interface AssetsApiResponse {
  assets?: TokenAsset[];
  error?: string;
  detail?: string;
}

export interface HoldingsApiResponse extends Partial<Holdings> {
  error?: string;
  /** Cause of a failure, development only. */
  detail?: string;
}

/** One token's net change in a transaction, from the wallet's side. */
export interface ActivityMove {
  mint: string;
  /** Empty for a mint the token index does not carry. */
  symbol: string;
  decimals: number;
  /** Base units, signed: "-1500000" left the wallet. A string for the reason Holding's is. */
  amount: string;
  /** Today's price, for how many places the amount is worth showing. Never a value at the time. */
  price?: number;
  /** A thumbnail is served at /icon/<mint>. */
  icon?: true;
}

/**
 * One transaction, as the wallet saw it: what came in and what went out.
 * The network fee and the rent of a token account it opened are not moves;
 * they are what doing it cost, not what was done.
 */
export interface Activity {
  signature: string;
  /** Unix ms, from the block. Null for the rare block with no time. */
  at: number | null;
  /** In and out is a swap; out only a send; in only a receipt. Other moved nothing. */
  kind: "swap" | "send" | "receive" | "other" | "failed";
  moves: ActivityMove[];
  /** The other wallet, for a send or receipt of one token. */
  peer?: string;
  /** Its Social username, when it is an account here. */
  peerName?: string;
}

/**
 * A page of a wallet's history, newest first.
 *
 * Transactions this wallet did not sign and that moved under a cent, or moved
 * only tokens the index does not carry, are left out and counted: that is how
 * airdrop spam and address poisoning arrive, and a lookalike address sitting
 * in someone's history is how the second one works.
 */
export interface HistoryPage {
  items: Activity[];
  /** Asks for the next page. Absent on the last. */
  after?: string;
  hidden?: number;
}

export interface HistoryApiResponse extends Partial<HistoryPage> {
  error?: string;
  detail?: string;
}

/**
 * What a wallet's entries were worked out from (lib/entries.ts), kept by the
 * wallet page in its own browser and handed back with the next ask, so what
 * came before is not read off the chain again: every transaction up to
 * `slot`, as the positions it left.
 */
export interface EntriesBasis {
  /** The slot the balances were read at. */
  slot: number;
  /** Each priced holding as it stood then: units, and what they cost in USD. */
  lots: Record<string, [number, number]>;
  /** Holdings with no entry that asking again would not give: begun before any walk reaches, or never priced. */
  far?: string[];
  /** Transactions counted from the last stretch before `slot`, which the next ask reads again in case the index was behind. */
  recent?: string[];
}

/**
 * What each holding on the wallet page cost, on average (lib/entries.ts): USD
 * per whole token, by mint, from what was paid for it whenever it was bought.
 * The page reads each position's profit against it. A mint is missing when
 * its past could not be priced, or reaches back further than is walked.
 * `settled` when nothing is missing for a reason that may pass, so the page
 * may keep the answer for as long as the balances stay as they are.
 */
export interface EntriesApiResponse {
  entries?: Record<string, number>;
  basis?: EntriesBasis;
  settled?: boolean;
  error?: string;
  detail?: string;
}

export interface SearchApiResponse {
  query: string;
  results: WebResult[];
  infobox?: Infobox;
  faq?: FaqItem[];
  news?: NewsItem[];
  videos?: VideoItem[];
  discussions?: DiscussionItem[];
  /**
   * Matching tokens, best first, capped server-side. Ambiguous tickers are
   * common on Solana — a dozen mints answer to "USDC" — and showing the
   * plausible ones beats silently picking or silently dropping.
   */
  tokens?: TokenQuote[];
  /**
   * Whether asking for the next page will return anything.
   *
   * Read from Brave's `more_results_available`, and additionally false once
   * the feed has reached the last page Brave will serve. The client scrolls on
   * this flag alone, so it has to mean "there is another page to fetch" rather
   * than "more results exist somewhere" — the two part company at the ceiling.
   */
  more?: boolean;
  error?: string;
}

export interface ImageSearchApiResponse {
  query: string;
  images: ImageItem[];
  error?: string;
}

/** Loose Brave response shapes (fields we read only). */
export interface BraveSearchResponse {
  query?: {
    /**
     * Brave's own "is there a page after this one". Documented as the thing to
     * check rather than incrementing `offset` until a page comes back empty,
     * which spends a metered call to discover the end of the results.
     */
    more_results_available?: boolean;
  };
  web?: {
    results?: Array<{
      title?: string;
      url?: string;
      description?: string;
      profile?: { name?: string };
      meta_url?: {
        netloc?: string;
        path?: string;
      };
      cluster?: Array<{
        title?: string;
        url?: string;
        description?: string;
      }>;
      page_age?: string;
      age?: string;
    }>;
  };
  infobox?: {
    results?: Array<{
      title?: string;
      description?: string;
      long_desc?: string;
      category?: string;
      /** Values may be null for section-header rows (e.g. "Denominations"). */
      attributes?: Array<[string, string | null | undefined] | unknown[]>;
      profiles?: Array<{ name?: string; url?: string }>;
      images?: Array<{ src?: string }>;
      thumbnail?: { src?: string };
    }>;
  };
  faq?: {
    results?: Array<{ question?: string; answer?: string }>;
  };
  news?: {
    results?: Array<{
      title?: string;
      url?: string;
      description?: string;
      page_age?: string;
      meta_url?: { netloc?: string };
    }>;
  };
  videos?: {
    results?: Array<{
      title?: string;
      url?: string;
      description?: string;
      meta_url?: { netloc?: string };
      thumbnail?: { src?: string };
    }>;
  };
  discussions?: {
    results?: Array<{
      title?: string;
      url?: string;
      description?: string;
      meta_url?: { netloc?: string };
    }>;
  };
}

/** Loose Jupiter Tokens V2 entry (fields we read only). */
/** One trading window of a Jupiter token. */
export interface JupStats {
  priceChange?: number;
  buyVolume?: number;
  sellVolume?: number;
  numBuys?: number;
  numSells?: number;
  numTraders?: number;
}

export interface JupToken {
  id?: string;
  symbol?: string;
  name?: string;
  decimals?: number;
  usdPrice?: number;
  mcap?: number;
  fdv?: number;
  liquidity?: number;
  holderCount?: number;
  isVerified?: boolean;
  tags?: string[];
  icon?: string;
  website?: string;
  twitter?: string;
  telegram?: string;
  discord?: string;
  stats5m?: JupStats;
  stats1h?: JupStats;
  stats6h?: JupStats;
  stats24h?: JupStats;
}

/** Loose Helius DAS `getAsset` response (fields we read only). */
export interface HeliusAssetResponse {
  result?: {
    token_info?: {
      price_info?: { price_per_token?: number; currency?: string };
    };
  };
  error?: { message?: string };
}

/** Loose Brave image search response. */
export interface BraveImageSearchResponse {
  results?: Array<{
    title?: string;
    url?: string;
    source?: string;
    thumbnail?: { src?: string; width?: number; height?: number };
    properties?: {
      url?: string;
      width?: number;
      height?: number;
    };
    meta_url?: { netloc?: string };
  }>;
}
