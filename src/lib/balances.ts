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

/**
 * Ceiling on cached wallets.
 *
 * The key is a caller-supplied address that only has to *look* like a pubkey —
 * isPubkey checks base58 shape, not that the account exists — so an anonymous
 * caller can mint unlimited distinct keys. Without a bound the five-second
 * cache is a permanent record of every address ever asked about, which is both
 * a slow memory leak and a store of wallet addresses this app has no business
 * keeping. Entries are only ever useful for CACHE_TTL_MS, so the sweep below
 * discards on age first and only clears wholesale if that frees nothing.
 */
const MAX_CACHED_WALLETS = 5_000;
const cache = new Map<string, { at: number; value: Balances }>();

/** In-flight lookups, so a burst for one wallet costs one RPC round trip. */
const inFlight = new Map<string, Promise<Balances>>();

function sweepCache(now: number): void {
  for (const [key, entry] of cache) {
    if (now - entry.at >= CACHE_TTL_MS) cache.delete(key);
  }
  // Everything is younger than the TTL and we are still at the cap: this is a
  // flood, not a working set. Drop it all rather than grow.
  if (cache.size >= MAX_CACHED_WALLETS) cache.clear();
}

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
  // No RPC configured is a deployment fault, not an empty wallet. Returning {}
  // let the dialog read "we looked and found nothing" — which switches off the
  // affordability check without saying so, and the first the user hears of it
  // is a transaction their wallet cannot fund. Thrown so the route answers 502
  // and the client marks the balance unknown.
  if (!HELIUS_RPC_URL) throw new Error("HELIUS_RPC_URL is not configured");

  const cacheKey = mint ? `${owner}:${mint}` : owner;
  const hit = cache.get(cacheKey);
  if (hit && Date.now() - hit.at < CACHE_TTL_MS) return hit.value;

  // Concurrent callers asking the same question share one answer. Without this
  // the cache only collapses requests that arrive after the first has landed,
  // which is precisely the case a flood does not produce.
  const pending = inFlight.get(cacheKey);
  if (pending) return pending;

  const task = lookup(owner, mint, cacheKey).finally(() => {
    inFlight.delete(cacheKey);
  });
  inFlight.set(cacheKey, task);
  return task;
}

async function lookup(
  owner: string,
  mint: string | undefined,
  cacheKey: string,
): Promise<Balances> {
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

  const now = Date.now();
  if (cache.size >= MAX_CACHED_WALLETS) sweepCache(now);
  cache.set(cacheKey, { at: now, value });
  return value;
}
