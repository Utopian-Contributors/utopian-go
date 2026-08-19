/**
 * Entry point for the buy panel, which lives in its own bundle. See lazy.js
 * for why, and for the content-hashed URL it is fetched from.
 */
import { load } from "./lazy.js";

/** Wrapped SOL. Swapping SOL for SOL is not a trade, so the pair flips. */
const SOL_MINT = "So11111111111111111111111111111111111111112";

/**
 * Deeplink into Jupiter's hosted swap UI.
 *
 * The floor the dialog degrades to, not the primary path — a normal click
 * opens our own. It stays a real URL so middle-click, cmd-click, no JS and a
 * blocked bundle all still reach a working swap. SOL cannot be bought with
 * SOL, so that one pair is funded with USDC.
 *
 * @param {string} mint
 */
export function swapUrl(mint) {
  const path =
    mint === SOL_MINT ? "USDC-SOL" : `SOL-${encodeURIComponent(mint)}`;
  return `https://jup.ag/swap/${path}`;
}

/**
 * Open the buy dialog for a token.
 *
 * @param {{mint: string, symbol: string, decimals?: number, fallback: string}} token
 */
export async function openSwap(token) {
  const panel = await load("sw", "__swap");
  return panel.open(token);
}
