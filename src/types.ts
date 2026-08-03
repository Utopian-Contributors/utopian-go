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
  error?: string;
}

export interface ImageSearchApiResponse {
  query: string;
  images: ImageItem[];
  error?: string;
}

/** Loose Brave response shapes (fields we read only). */
export interface BraveSearchResponse {
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
