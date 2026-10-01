import { HELIUS_RPC_URL } from "../config";
import { SocialError } from "./limits";
import { base58Decode } from "./keys";

export function solanaPubkey(text: string): Buffer | null {
  const raw = base58Decode(text.trim());
  return raw && raw.length === 32 ? raw : null;
}

export async function rpc(method: string, params: unknown[]): Promise<unknown> {
  if (!HELIUS_RPC_URL) throw new SocialError(503, "Payments are not available.");
  let body: { result?: unknown; error?: { message?: string } };
  try {
    const res = await fetch(HELIUS_RPC_URL, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }),
      signal: AbortSignal.timeout(12_000),
    });
    body = (await res.json()) as { result?: unknown; error?: { message?: string } };
  } catch {
    throw new SocialError(503, "Payments are not available.");
  }
  if (body.error) {
    const message = body.error.message || "";
    if (/rent/i.test(message)) {
      throw new SocialError(
        400,
        "Every Solana account must keep about 0.001 SOL. Send more SOL, or leave more in this wallet.",
      );
    }
    if (/insufficient/i.test(message)) throw new SocialError(400, "Not enough SOL in this wallet.");
    throw new SocialError(400, "The transaction was not sent.");
  }
  return body.result;
}
