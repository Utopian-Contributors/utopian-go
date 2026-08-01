import { HELIUS_RPC_URL, TOKEN_PRICE_TIMEOUT_MS } from "../config";
import { Balances } from "../types";

/**
 * Spendable balances for the tokens we let people fund a swap with.
 *
 * Proxied rather than called from the browser because the Helius URL carries
 * our key — publishing it to every visitor would hand out our RPC quota. The
 * client only ever learns two numbers about its own wallet.
 */

const USDC_MINT = "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v";
const WSOL_MINT = "So11111111111111111111111111111111111111112";

const isNativeSol = (mint: string) => mint === WSOL_MINT;

/** Base58, 32 bytes. Rejects anything that isn't shaped like a pubkey. */
const PUBKEY = /^[1-9A-HJ-NP-Za-km-z]{32,44}$/;

export function isPubkey(value: string): boolean {
  return PUBKEY.test(value);
}

/**
 * Balances move on every trade, so this is only about absorbing bursts — a
 * wallet reopening the dialog twice in a row shouldn't cost two round trips.
 */
const CACHE_TTL_MS = 5_000;
const cache = new Map<string, { at: number; value: Balances }>();

interface RpcReply {
  id?: number;
  result?: unknown;
  error?: { message?: string };
}

/** Sum every token account a wallet holds for one mint. */
function sumTokenAccounts(result: unknown): bigint | null {
  const value = (
    result as
      | {
          value?: Array<{
            account?: {
              data?: {
                parsed?: { info?: { tokenAmount?: { amount?: string } } };
              };
            };
          }>;
        }
      | undefined
  )?.value;
  if (!Array.isArray(value)) return null;

  let total = 0n;
  for (const entry of value) {
    const raw = entry?.account?.data?.parsed?.info?.tokenAmount?.amount;
    if (raw) total += BigInt(raw);
  }
  return total;
}

/**
 * @param owner wallet address
 * @param mint optional extra mint to report, for sizing a sell
 */
export async function fetchBalances(
  owner: string,
  mint?: string,
): Promise<Balances> {
  if (!HELIUS_RPC_URL) return {};

  const cacheKey = mint ? `${owner}:${mint}` : owner;
  const hit = cache.get(cacheKey);
  if (hit && Date.now() - hit.at < CACHE_TTL_MS) return hit.value;

  // One batched request: native lamports, USDC, and the traded mint if asked.
  const calls: unknown[] = [
    { jsonrpc: "2.0", id: 1, method: "getBalance", params: [owner] },
    {
      jsonrpc: "2.0",
      id: 2,
      method: "getTokenAccountsByOwner",
      params: [owner, { mint: USDC_MINT }, { encoding: "jsonParsed" }],
    },
  ];
  // Wrapped SOL would double-count against the native balance, and a USDC
  // request here would duplicate call 2.
  const wantsToken = !!mint && mint !== USDC_MINT && !isNativeSol(mint);
  if (wantsToken) {
    calls.push({
      jsonrpc: "2.0",
      id: 3,
      method: "getTokenAccountsByOwner",
      params: [owner, { mint }, { encoding: "jsonParsed" }],
    });
  }

  const res = await fetch(HELIUS_RPC_URL, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    signal: AbortSignal.timeout(TOKEN_PRICE_TIMEOUT_MS),
    body: JSON.stringify(calls),
  });
  if (!res.ok) {
    const text = await res.text().catch(() => "");
    throw new Error(`RPC responded ${res.status}${text ? `: ${text.slice(0, 200)}` : ""}`);
  }

  const body = (await res.json()) as RpcReply[];
  const replies = Array.isArray(body) ? body : [];
  const byId = new Map(replies.map((r) => [r.id, r]));

  const solResult = byId.get(1)?.result as { value?: number } | undefined;
  const sol = Number(solResult?.value);
  // A wallet can hold several accounts for one mint; the total is what matters.
  const usdc = sumTokenAccounts(byId.get(2)?.result);
  const token = wantsToken ? sumTokenAccounts(byId.get(3)?.result) : null;

  // Base units as strings: lamport counts exceed what JSON numbers hold safely
  // once a wallet is large, and this is a number people compare against.
  const value: Balances = {
    ...(Number.isFinite(sol) ? { sol: String(sol) } : {}),
    ...(usdc != null ? { usdc: usdc.toString() } : {}),
    // Selling native SOL spends the native balance, not a token account.
    ...(mint && isNativeSol(mint) && Number.isFinite(sol)
      ? { token: String(sol) }
      : {}),
    ...(token != null ? { token: token.toString() } : {}),
    ...(mint === USDC_MINT && usdc != null ? { token: usdc.toString() } : {}),
  };

  cache.set(cacheKey, { at: Date.now(), value });
  return value;
}
