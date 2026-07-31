import { HELIUS_RPC_URL, TOKEN_PRICE_TIMEOUT_MS } from "../../config";
import { HeliusAssetResponse } from "../../types";

/**
 * Live price via Helius' DAS extension to the Solana RPC.
 *
 * A stock RPC has no notion of price — it serves accounts, not markets. Helius
 * layers `token_info.price_info` onto `getAsset`, which is what makes "read the
 * price off the RPC URL" actually work. Two limits worth knowing:
 *   - price_info is populated for verified tokens; others come back bare
 *   - Helius caches upstream (~10min), so this is fresh-ish, not tick data
 */
export async function fetchPrice(mint: string): Promise<number | null> {
  if (!HELIUS_RPC_URL) return null;

  const res = await fetch(HELIUS_RPC_URL, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    signal: AbortSignal.timeout(TOKEN_PRICE_TIMEOUT_MS),
    body: JSON.stringify({
      jsonrpc: "2.0",
      id: "price",
      method: "getAsset",
      params: { id: mint, displayOptions: { showFungible: true } },
    }),
  });

  if (!res.ok) throw new Error(`Helius responded ${res.status}`);

  const body = (await res.json()) as HeliusAssetResponse;
  if (body.error) throw new Error(body.error.message || "Helius RPC error");

  const info = body.result?.token_info?.price_info;
  // Only trust USD quotes; a non-USD currency would silently mis-scale the card.
  if (info?.currency && info.currency.toUpperCase() !== "USDC") {
    if (info.currency.toUpperCase() !== "USD") return null;
  }

  const price = Number(info?.price_per_token);
  return Number.isFinite(price) && price > 0 ? price : null;
}
