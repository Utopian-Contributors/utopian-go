import { HELIUS_RPC_URL, TOKEN_PRICE_TIMEOUT_MS } from "../config";

/**
 * Where a sent transaction stands: landed, landed and reverted, or not seen yet.
 *
 * A browser wallet broadcasts a trade itself and hands back only a signature.
 * Whether it went through is a question for an RPC, and the RPC with a key is
 * ours — so the dialog asks here rather than being handed the Helius URL.
 */
export type TxStatus = { status: "confirmed" } | { status: "failed"; error: string } | { status: "pending" };

/** Base58, 64 bytes — 86 to 88 characters. */
const SIGNATURE = /^[1-9A-HJ-NP-Za-km-z]{80,90}$/;

export function isSignature(value: string): boolean {
  return SIGNATURE.test(value);
}

/** Jupiter's program errors worth saying in words; everything else is a revert. */
function explain(err: unknown): string {
  const text = JSON.stringify(err ?? "");
  // 6001 SlippageToleranceExceeded, the one a person can do something about.
  if (/"Custom":6001\b/.test(text)) return "The price moved past your slippage before the trade landed. Nothing was spent except the network fee.";
  if (/InsufficientFunds/.test(text)) return "Not enough SOL to pay the network fee.";
  return "The trade failed on chain. Nothing was spent except the network fee.";
}

export async function signatureStatus(signature: string): Promise<TxStatus> {
  if (!HELIUS_RPC_URL) throw new Error("HELIUS_RPC_URL is not configured");
  const res = await fetch(HELIUS_RPC_URL, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    signal: AbortSignal.timeout(TOKEN_PRICE_TIMEOUT_MS),
    body: JSON.stringify({
      jsonrpc: "2.0",
      id: 1,
      method: "getSignatureStatuses",
      params: [[signature], { searchTransactionHistory: false }],
    }),
  });
  if (!res.ok) throw new Error(`RPC responded ${res.status}`);
  const body = (await res.json()) as {
    result?: { value?: Array<{ err?: unknown; confirmationStatus?: string } | null> };
  };
  const s = body.result?.value?.[0];
  if (!s) return { status: "pending" };
  if (s.err) return { status: "failed", error: explain(s.err) };
  // "processed" can still be rolled back; confirmed is the first stage worth a checkmark.
  return s.confirmationStatus === "confirmed" || s.confirmationStatus === "finalized"
    ? { status: "confirmed" }
    : { status: "pending" };
}

/** Ask until the transaction lands, fails, or `timeoutMs` passes. */
export async function waitForSignature(signature: string, timeoutMs = 30_000): Promise<TxStatus> {
  const end = Date.now() + timeoutMs;
  for (;;) {
    const s = await signatureStatus(signature).catch((): TxStatus => ({ status: "pending" }));
    if (s.status !== "pending" || Date.now() > end) return s;
    await new Promise((r) => setTimeout(r, 1_000));
  }
}
