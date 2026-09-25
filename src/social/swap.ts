import {
  JUP_FEE_ACCOUNT_SOL,
  JUP_FEE_ACCOUNT_USDC,
  JUP_FEE_BPS,
  JUP_SWAP_ENDPOINT,
} from "../config";
import { base58Decode, signEd25519, solanaSeed } from "./keys";
import { SocialError } from "./limits";
import { rpc } from "./pay";

const SOL_MINT = "So11111111111111111111111111111111111111112";
const USDC_MINT = "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v";
export const MAX_SLIPPAGE_BPS = 300;

function shortvecAt(buf: Buffer, off: number): [number, number] {
  let value = 0;
  for (let size = 0; size < 3; size++) {
    const byte = buf[off + size];
    if (byte === undefined) break;
    value |= (byte & 0x7f) << (7 * size);
    if (!(byte & 0x80)) return [value, size + 1];
  }
  throw new Error("bad shortvec");
}

/**
 * Fill the one signature a transaction asks for, after checking that the
 * signer it asks for, and the fee payer, is `owner`.
 */
export function signTransaction(tx: Buffer, owner: Buffer, seed: Buffer): Buffer {
  const [count, len] = shortvecAt(tx, 0);
  if (count !== 1) throw new Error("expected exactly one signer");
  const message = tx.subarray(len + 64);
  // A v0 message starts with 0x80; a legacy one starts with its header.
  let off = message[0] & 0x80 ? 1 : 0;
  if (message[off] !== 1) throw new Error("expected exactly one signer");
  off += 3;
  const [keys, klen] = shortvecAt(message, off);
  off += klen;
  if (keys < 1 || !message.subarray(off, off + 32).equals(owner)) throw new Error("fee payer is not the owner");
  const out = Buffer.from(tx);
  signEd25519(seed, message).copy(out, len);
  return out;
}

async function jupiter(url: string, init?: RequestInit): Promise<Record<string, unknown>> {
  let res: Response;
  try {
    res = await fetch(url, { ...init, signal: AbortSignal.timeout(10_000) });
  } catch {
    throw new SocialError(502, "Jupiter did not answer. Try again.");
  }
  const body = (await res.json().catch(() => ({}))) as Record<string, unknown>;
  if (!res.ok) throw new SocialError(502, typeof body.error === "string" ? body.error : "No route for this trade.");
  return body;
}

/** The referral account that collects the fee: the SOL one if SOL is on either side, else USDC's. */
function feeAccount(input: string, output: string): string {
  if (JUP_FEE_BPS <= 0) return "";
  if (input === SOL_MINT || output === SOL_MINT) return JUP_FEE_ACCOUNT_SOL;
  if (input === USDC_MINT || output === USDC_MINT) return JUP_FEE_ACCOUNT_USDC;
  return "";
}

/**
 * Quote, build, sign and send a swap for an account's own wallet.
 *
 * The server asks Jupiter itself, for this owner, and signs only what came
 * back: a caller chooses the pair, the amount and the slippage, and nothing
 * else. Jupiter's transaction pays out to the owner's own token account.
 */
export async function swapFor(
  owner: string,
  phrase: string,
  p: { input: string; output: string; amount: string; slippageBps: number },
): Promise<{ signature: string; outAmount: string }> {
  const fee = feeAccount(p.input, p.output);
  const q = new URLSearchParams({
    inputMint: p.input,
    outputMint: p.output,
    amount: p.amount,
    slippageBps: String(p.slippageBps),
  });
  if (fee) q.set("platformFeeBps", String(JUP_FEE_BPS));
  const quote = await jupiter(`${JUP_SWAP_ENDPOINT}/quote?${q}`, { headers: { Accept: "application/json" } });
  const built = await jupiter(`${JUP_SWAP_ENDPOINT}/swap`, {
    method: "POST",
    headers: { "Content-Type": "application/json", Accept: "application/json" },
    body: JSON.stringify({
      quoteResponse: quote,
      userPublicKey: owner,
      wrapAndUnwrapSol: true,
      dynamicComputeUnitLimit: true,
      ...(fee ? { feeAccount: fee } : {}),
    }),
  });
  if (typeof built.swapTransaction !== "string") throw new SocialError(502, "Jupiter returned no transaction.");

  const seed = solanaSeed(phrase);
  let signed: Buffer;
  try {
    signed = signTransaction(Buffer.from(built.swapTransaction, "base64"), base58Decode(owner)!, seed);
  } catch {
    throw new SocialError(502, "Jupiter returned a transaction we will not sign.");
  } finally {
    seed.fill(0);
  }
  const signature = await rpc("sendTransaction", [
    signed.toString("base64"),
    { encoding: "base64", preflightCommitment: "confirmed", maxRetries: 3 },
  ]);
  if (typeof signature !== "string") throw new SocialError(502, "The transaction was not sent.");
  return { signature, outAmount: String(quote.outAmount ?? "") };
}
