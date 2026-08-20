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
   * and its high is 255. Shape only — the prices behind it are deliberately
   * not recoverable, because nothing on the card reads a value off the line.
   * 32 characters, which is what makes a chart affordable on every response.
   */
  ticks?: string;
}

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
   * as prices. Server-side only — never projected into a TokenQuote, because
   * nothing the client draws is labelled with a value off the line. The wallet
   * page's portfolio series is what needs them. Absent on records restored
   * from a snapshot written before they were kept.
   */
  tickLo?: number;
  tickHi?: number;
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
  /**
   * What these holdings were worth over the last 24 hours, one byte an hour,
   * encoded exactly as a token's own sparkline is.
   *
   * Read it for what it is: today's balances priced at each hour's price. It
   * is not a record of what the wallet held — we have no transaction history
   * and do not want one — so a position opened an hour ago appears across the
   * whole day. What it does answer is the question people actually have when
   * they open this page: which way did the market move what I am holding.
   *
   * Absent when too little of the portfolio has price history behind it for a
   * line to mean anything.
   */
  series?: string;
  /**
   * The dollar range `series` was scaled against, low and high.
   *
   * A token card ships its shape without a range on purpose — nothing there is
   * labelled with a value read off the line. Here something is: hovering the
   * chart reads the portfolio's worth at that hour back out of it, so the two
   * numbers that turn a byte into dollars have to come with it. Twenty bytes,
   * against a second endpoint for the same information.
   */
  seriesLo?: number;
  seriesHi?: number;
  /** Change across `series`, percent. Present whenever `series` is. */
  change24h?: number;
  /** Priced rows past the display cap. */
  more?: number;
  /** Priced rows worth less than a cent. */
  dust?: number;
  /** Mints the token index carries no price for — almost always airdrop spam. */
  unpriced?: number;
}

export interface HoldingsApiResponse extends Partial<Holdings> {
  error?: string;
  /** Cause of a failure, development only. */
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
export interface JupToken {
  id?: string;
  symbol?: string;
  name?: string;
  decimals?: number;
  usdPrice?: number;
  mcap?: number;
  liquidity?: number;
  isVerified?: boolean;
  tags?: string[];
  stats24h?: { priceChange?: number };
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
