/**
 * A token's USD price as of the last minute, or null.
 *
 * Our server answers it from Jupiter's market data, the same figure the
 * wallet's token panel shows, and writes it back into its index. The price a
 * card or a holding carries is the index's, up to an hour old, and a thin coin
 * can move by half in that time. No part of the request is about the visitor.
 *
 * `fresh` skips the browser's copy (the server lets it keep one for 30 s), for
 * a screen about to say something that a stale price would make untrue.
 *
 * @param {string} mint
 * @param {boolean} [fresh]
 */
export async function livePrice(mint, fresh = false) {
  try {
    const res = await fetch(`/api/tokens/${encodeURIComponent(mint)}`, {
      headers: { Accept: "application/json" },
      cache: fresh ? "no-cache" : "default",
    });
    if (!res.ok) return null;
    const n = Number((await res.json())?.price);
    return Number.isFinite(n) && n > 0 ? n : null;
  } catch {
    return null;
  }
}
