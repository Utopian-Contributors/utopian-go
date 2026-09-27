/**
 * Jupiter Swap V1 — quote, build, and the byte plumbing between them.
 *
 * Two keyless calls. `/quote` prices the route, `/swap` returns a base64
 * transaction ready for a wallet to sign. Jupiter's own examples decode that
 * with @solana/web3.js only because they run in Node against a private key; a
 * browser wallet takes the bytes directly.
 */

/**
 * Only ever reached once a wallet is connected.
 *
 * Before that the dialog prices itself from the index figures the page already
 * carries — see `estimate` in main.js — so opening it tells Jupiter nothing
 * about a visitor who has agreed to nothing. Once connected, Jupiter is a party
 * to the trade regardless: it builds the very transaction the wallet signs.
 */
const ENDPOINT = "https://lite-api.jup.ag/swap/v1";

/** base64 → bytes, for the transaction Jupiter builds. */
export function fromBase64(b64) {
  const bin = atob(b64);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

const B58 = "123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz";

/** Signature bytes → the base58 string an explorer URL wants. */
export function toBase58(bytes) {
  let n = 0n;
  for (const b of bytes) n = n * 256n + BigInt(b);
  let out = "";
  while (n > 0n) {
    out = B58[Number(n % 58n)] + out;
    n /= 58n;
  }
  for (const b of bytes) {
    if (b !== 0) break;
    out = "1" + out;
  }
  return out;
}

/** Jupiter reports failures as 200-with-`error` as often as by status code. */
async function json(res) {
  const body = await res.json().catch(() => null);
  if (!res.ok || body?.error) {
    throw new Error(body?.error || `Jupiter responded ${res.status}`);
  }
  return body;
}

/**
 * Price a swap. `amount` is in the *input* mint's base units, which is why the
 * output token's decimals are never needed to trade — only to display.
 *
 * @param {{input: string, output: string, amount: string, slippageBps: number,
 *          feeBps: number, signal?: AbortSignal}} p
 */
export async function quote(p) {
  const q = new URLSearchParams({
    inputMint: p.input,
    outputMint: p.output,
    amount: p.amount,
    slippageBps: String(p.slippageBps),
  });
  // Only ask for a fee when there is an account to receive it — Jupiter rejects
  // the pair where one is present without the other.
  if (p.feeBps > 0) q.set("platformFeeBps", String(p.feeBps));

  return json(
    await fetch(`${ENDPOINT}/quote?${q}`, {
      headers: { Accept: "application/json" },
      signal: p.signal,
    }),
  );
}

/**
 * Turn a quote into a signable transaction.
 *
 * @param {{quote: any, taker: string, feeAccount?: string}} p
 * @returns {Promise<Uint8Array>}
 */
export async function build(p) {
  const body = await json(
    await fetch(`${ENDPOINT}/swap`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        quoteResponse: p.quote,
        userPublicKey: p.taker,
        // Unwraps leftover wSOL back to SOL so a failed or partial route does
        // not strand the user's funds in a token account they never asked for.
        wrapAndUnwrapSol: true,
        dynamicComputeUnitLimit: true,
        // Left unset, Jupiter tipped next to nothing and a busy network dropped
        // the trade; "high" cost 2% of a small one. Medium, capped at 0.0003
        // SOL, matches what the server path asks for.
        prioritizationFeeLamports: {
          priorityLevelWithMaxLamports: { priorityLevel: "medium", maxLamports: 300_000 },
        },
        ...(p.feeAccount ? { feeAccount: p.feeAccount } : {}),
      }),
    }),
  );
  if (!body.swapTransaction) throw new Error("Jupiter returned no transaction");
  return fromBase64(body.swapTransaction);
}
