import { lookupToken } from "../lib/tokens/store";
import type { TokenQuote } from "../types";

/**
 * Tickers called out in a post: `$SOL` in the text puts SOL's card under it,
 * with the price it had when the post went up, so the card can say how it has
 * done since.
 *
 * Only the mint and that price are kept on the post. What it trades at now is
 * read from the token index whenever the card is drawn (GET /api/quotes), so a
 * timeline's state does not move every time a price does.
 */

/** Cards under one post. Past three it stops reading as a post. */
export const MAX_CALLOUTS = 3;

/** One ticker on a post, as the index named it when the post went up. */
export interface Callout {
  mint: string;
  symbol: string;
  /** USD, at the moment of posting. */
  price: number;
  /**
   * The tickers in the text that came to this mint, in upper case: the ones
   * the post draws in blue. Not always the symbol: `$AAPL` is Apple xStock,
   * whose symbol is AAPLx.
   */
  tickers: string[];
}

/**
 * `$` and a ticker: a letter, then letters or digits, twelve in all at most.
 * A letter first so an amount ($5, $100k) is never read as one, and nothing
 * word-like on either side, so a `$` inside a word or `$$` is not either.
 */
const TICKER = /(?<![\w$])\$([A-Za-z][A-Za-z0-9]{1,11})(?!\w)/g;

/** The tickers a text names, as written, in order, repeats and all. */
export function tickersIn(text: string): string[] {
  return [...text.matchAll(TICKER)].map((match) => match[1]);
}

/** Tickers as a draft names them, which is all the composer sends: a post's words stay out of URLs. */
export function isTicker(raw: string): boolean {
  return /^[A-Za-z][A-Za-z0-9]{1,11}$/.test(raw);
}

/**
 * Tickers to callouts, in the order they are named, each mint once, three at
 * most; and the mint each ticker went to, so a draft can colour exactly the
 * tickers its cards came from.
 *
 * `$X` resolves exactly as a search for `$X` does: the explicit `$` lets a
 * ticker that is also a word through ($GO, $ME), and a ticker several mints
 * share goes to the one search would put first. A ticker the index does not
 * know, or holds no price for, is left as text. Nothing past the third card is
 * looked up.
 *
 * @param quote the index; tests hand in their own
 */
export function resolveTickers(
  tickers: string[],
  quote: (query: string) => TokenQuote | null = lookupToken,
): { calls: Callout[]; named: Record<string, string> } {
  const calls: Callout[] = [];
  // A Map, not an object: these keys are typed by whoever wrote the post.
  const named = new Map<string, string>();
  for (const ticker of tickers) {
    const key = ticker.toUpperCase();
    if (named.has(key)) continue;
    if (calls.length >= MAX_CALLOUTS) break;
    const hit = quote(`$${ticker}`);
    if (!hit || !Number.isFinite(hit.price) || hit.price <= 0) continue;
    named.set(key, hit.mint);
    const call = calls.find((c) => c.mint === hit.mint);
    if (call) call.tickers.push(key);
    else calls.push({ mint: hit.mint, symbol: hit.symbol, price: hit.price, tickers: [key] });
  }
  return { calls, named: Object.fromEntries(named) };
}

/** The tickers a post calls out, priced as of now. */
export function calloutsIn(text: string, quote?: (query: string) => TokenQuote | null): Callout[] {
  return resolveTickers(tickersIn(text), quote).calls;
}
