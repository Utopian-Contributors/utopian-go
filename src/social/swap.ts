import {
  JUP_FEE_ACCOUNT_SOL,
  JUP_FEE_ACCOUNT_USDC,
  JUP_FEE_BPS,
  JUP_SWAP_ENDPOINT,
} from "../config";
import { JupiterBusy, jupFetch } from "../lib/jupiterGate";
import { waitForSignature } from "../lib/txStatus";
import { base58, base58Decode, signEd25519, solanaSeed } from "./keys";
import { SocialError } from "./limits";
import { rpc } from "./pay";
import { ATA_PROGRAM, SOL_MINT, SYSTEM, TOKEN, TOKEN_2022, associatedTokenAccount, mintInfo } from "./send";

const USDC_MINT = "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v";
export const MAX_SLIPPAGE_BPS = 300;

const JUPITER = base58Decode("JUP6LkbZbjS1jKKwapdHNy74zcZ3tLUZoi5QNyVTaV4")!;
const COMPUTE_BUDGET = base58Decode("ComputeBudget111111111111111111111111111111")!;

/**
 * What a swap may cost in SOL beyond the trade itself: the fee, a priority
 * fee, and rent for a token account the swap opens. Anything past this is
 * SOL leaving the wallet for a reason the trade does not explain.
 */
const SOL_OVERHEAD = 10_000_000n;
/** Priority fee ceiling: compute-unit price times limit, in lamports. */
const MAX_PRIORITY_LAMPORTS = 5_000_000n;

/**
 * What we ask Jupiter to tip validators, at most: 0.0003 SOL.
 *
 * Was "high" up to 0.002 SOL. Measured on a $2.43 trade, "high" came to
 * 471,690 lamports — 2.3% of the trade, paid on top of it — where "medium"
 * came to 30,866. A tip is a flat cost, so on the small trades this dialog
 * mostly sees it was the worst rate on the screen and the one not shown.
 */
const PRIORITY_MAX_LAMPORTS = 300_000;

/** Rent a token account holds while it exists, in lamports (165 bytes). */
const TOKEN_ACCOUNT_RENT = 2_039_280n;
/** The signature fee every transaction pays. */
const BASE_FEE = 5_000n;

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

export interface ParsedIx {
  program: Buffer;
  /** Indexes into the message's account list. */
  accounts: number[];
  data: Buffer;
}

export interface ParsedMessage {
  /** The keys written in the message itself; lookup-table keys are not resolved. */
  keys: Buffer[];
  instructions: ParsedIx[];
}

/** A legacy or v0 message, as far as signing decisions need it. */
export function parseMessage(message: Buffer): ParsedMessage {
  let off = message[0] & 0x80 ? 1 : 0;
  off += 3;
  const [keyCount, klen] = shortvecAt(message, off);
  off += klen;
  const keys: Buffer[] = [];
  for (let i = 0; i < keyCount; i++) {
    if (off + 32 > message.length) throw new Error("short message");
    keys.push(message.subarray(off, off + 32));
    off += 32;
  }
  off += 32; // blockhash
  const [ixCount, ilen] = shortvecAt(message, off);
  off += ilen;
  const instructions: ParsedIx[] = [];
  for (let i = 0; i < ixCount; i++) {
    const programIndex = message[off++];
    // Invoked programs are always static keys, never from a lookup table.
    if (programIndex === undefined || programIndex >= keys.length) throw new Error("program not in message");
    const [accCount, alen] = shortvecAt(message, off);
    off += alen;
    const accounts = [...message.subarray(off, off + accCount)];
    off += accCount;
    const [dataLen, dlen] = shortvecAt(message, off);
    off += dlen;
    if (off + dataLen > message.length) throw new Error("short message");
    instructions.push({ program: keys[programIndex], accounts, data: message.subarray(off, off + dataLen) });
    off += dataLen;
  }
  return { keys, instructions };
}

/** The key an instruction names at position `i`, or null when it comes from a lookup table. */
function keyAt(msg: ParsedMessage, ix: ParsedIx, i: number): Buffer | null {
  const index = ix.accounts[i];
  return index !== undefined && index < msg.keys.length ? msg.keys[index] : null;
}

function same(a: Buffer | null, b: Buffer): boolean {
  return !!a && a.equals(b);
}

/**
 * Every instruction a swap for `owner` may carry, checked one by one.
 *
 * Jupiter's program does the trade itself; what it pays out, and to whom, is
 * checked by simulation instead. Everything around it — compute budget,
 * wrapping SOL, opening the owner's token accounts — is the handful of forms
 * the swap API emits, and anything else (a transfer out, an approval, a new
 * authority) is refused before a signature exists.
 */
export function checkSwapInstructions(msg: ParsedMessage, owner: Buffer): bigint {
  const wsolAta = associatedTokenAccount(owner, base58Decode(SOL_MINT)!, TOKEN);
  let unitPrice = 0n;
  let unitLimit = 200_000n;
  for (const ix of msg.instructions) {
    const p = ix.program;
    if (p.equals(JUPITER)) continue;
    if (p.equals(COMPUTE_BUDGET)) {
      if (ix.data[0] === 2 && ix.data.length >= 5) unitLimit = BigInt(ix.data.readUInt32LE(1));
      else if (ix.data[0] === 3 && ix.data.length >= 9) unitPrice = ix.data.readBigUInt64LE(1);
      else throw new Error("compute budget instruction");
      continue;
    }
    if (p.equals(SYSTEM)) {
      // Funding the owner's own wrapped-SOL account, and nothing else.
      if (ix.data.length !== 12 || ix.data.readUInt32LE(0) !== 2) throw new Error("system instruction");
      if (!same(keyAt(msg, ix, 0), owner) || !same(keyAt(msg, ix, 1), wsolAta)) throw new Error("system transfer");
      continue;
    }
    if (p.equals(TOKEN) || p.equals(TOKEN_2022)) {
      if (ix.data[0] === 17) continue; // SyncNative
      // CloseAccount, paying the rent back to the owner, on the owner's authority.
      if (ix.data[0] === 9 && same(keyAt(msg, ix, 1), owner) && same(keyAt(msg, ix, 2), owner)) continue;
      throw new Error("token instruction");
    }
    if (p.equals(ATA_PROGRAM)) {
      // Create or CreateIdempotent, for an account the owner holds.
      if (ix.data.length > 1 || (ix.data.length === 1 && ix.data[0] > 1)) throw new Error("ata instruction");
      if (!same(keyAt(msg, ix, 2), owner)) throw new Error("ata for someone else");
      continue;
    }
    throw new Error("program not allowed");
  }
  const priority = (unitPrice * unitLimit) / 1_000_000n;
  if (priority > MAX_PRIORITY_LAMPORTS) throw new Error("priority fee");
  return priority;
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
    res = await jupFetch(url, init ?? {}, "trade", { timeoutMs: 10_000 });
  } catch (err) {
    if (err instanceof JupiterBusy) throw new SocialError(503, err.message);
    throw new SocialError(502, "Jupiter did not answer. Try again.");
  }
  const body = (await res.json().catch(() => ({}))) as Record<string, unknown>;
  if (res.status === 429) throw new SocialError(503, "Jupiter is busy. Try again in a minute.");
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
 * The least the reviewed trade promised: what the person saw, less the
 * slippage they accepted. Nothing the server sends may pay out below it.
 */
export function reviewedFloor(quotedOut: bigint, slippageBps: number): bigint {
  return (quotedOut * BigInt(10_000 - slippageBps)) / 10_000n;
}

/**
 * The slippage to build with so that Jupiter's on-chain minimum is at least
 * `floor` for a fresh quote of `out`: the requested slippage, narrowed when
 * the price has moved against the person since they reviewed it.
 */
export function slippageFor(out: bigint, floor: bigint, requested: number): number {
  if (out <= 0n || out < floor) return -1;
  const room = Number(((out - floor) * 10_000n) / out);
  return Math.min(requested, room);
}

interface Watched {
  address: string;
  kind: "lamports" | "token";
}

function tokenAmount(data: Buffer): bigint {
  return data.length >= 72 ? data.readBigUInt64LE(64) : 0n;
}

function readAccount(acc: unknown, kind: Watched["kind"]): bigint {
  const a = acc as { lamports?: number; data?: [string, string] } | null;
  if (!a) return 0n;
  if (kind === "lamports") return BigInt(a.lamports ?? 0);
  return tokenAmount(Buffer.from(a.data?.[0] ?? "", "base64"));
}

/** Lamports as SOL, rounded up to four places so a requirement is never understated. */
function sol(lamports: bigint, up = false): string {
  const n = Number(lamports) / 1e9;
  const r = (up ? Math.ceil(n * 1e4) : Math.floor(n * 1e4)) / 1e4;
  return r.toLocaleString("en-US", { maximumFractionDigits: 4 });
}

/**
 * Say why a simulation failed, in the terms someone can act on.
 *
 * By far the usual cause is a wallet with too little SOL for the network fee,
 * which the chain reports as anything from AccountNotFound (a wallet that has
 * never held SOL) to a failed transfer deep in the route. "This trade would
 * fail" is true of all of them and useful for none.
 */
export function simulationError(
  err: unknown,
  logs: string[],
  funds: { have: bigint; need: bigint; spendsSol: boolean },
): SocialError {
  const text = JSON.stringify(err);
  const joined = logs.join("\n");
  const lamportsShort =
    /AccountNotFound|InsufficientFundsForFee|InsufficientFundsForRent/.test(text) ||
    /insufficient lamports/i.test(joined) ||
    funds.have < funds.need;
  if (lamportsShort) {
    const need = sol(funds.need, true);
    const have = sol(funds.have);
    return new SocialError(
      400,
      funds.spendsSol
        ? `Not enough SOL. This trade needs about ${need} SOL including network fees, and the wallet has ${have} SOL. Try a smaller amount.`
        : `Not enough SOL for network fees. Trading needs about ${need} SOL in this wallet, and it has ${have} SOL. Add a little SOL and try again.`,
      { needsSol: true },
    );
  }
  // Jupiter's 6001, SlippageToleranceExceeded: the price already moved.
  if (/0x1771\b/.test(joined) || /"Custom":6001\b/.test(text)) {
    return new SocialError(409, "The price moved. Review the trade again.", { requote: true });
  }
  if (/insufficient funds/i.test(joined)) {
    return new SocialError(400, "Not enough of this token in the wallet for that amount.");
  }
  console.warn("[swap] simulation failed:", text, logs.slice(-5));
  return new SocialError(400, "This trade would fail right now. Try again in a moment.");
}

/**
 * Run the signed transaction without sending it, and refuse unless the
 * owner's balances move the way the trade says: at most `amount` of the
 * input leaves, at least `floor` of the output arrives, and SOL beyond the
 * trade drops by no more than fees and rent.
 */
async function simulateSwap(
  signed: Buffer,
  owner: Buffer,
  p: { input: string; output: string; amount: bigint; floor: bigint; priority: bigint },
): Promise<void> {
  const watched: Watched[] = [{ address: base58(owner), kind: "lamports" }];
  const tokenSide = async (mint: string) => {
    const key = base58Decode(mint)!;
    const { program } = await mintInfo(key);
    return base58(associatedTokenAccount(owner, key, program));
  };
  const inAta = p.input === SOL_MINT ? null : await tokenSide(p.input);
  const outAta = p.output === SOL_MINT ? null : await tokenSide(p.output);
  if (inAta) watched.push({ address: inAta, kind: "token" });
  if (outAta) watched.push({ address: outAta, kind: "token" });
  const addresses = watched.map((w) => w.address);

  const before = (await rpc("getMultipleAccounts", [addresses, { encoding: "base64", commitment: "processed" }])) as {
    value?: unknown[];
  };
  const sim = (await rpc("simulateTransaction", [
    signed.toString("base64"),
    {
      encoding: "base64",
      sigVerify: false,
      replaceRecentBlockhash: false,
      commitment: "processed",
      accounts: { encoding: "base64", addresses },
    },
  ])) as { value?: { err?: unknown; accounts?: unknown[]; logs?: string[] } };
  if (!sim?.value) throw new SocialError(502, "Could not check this trade. Try again.");
  const pre = watched.map((w, i) => readAccount(before?.value?.[i] ?? null, w.kind));
  if (sim.value.err) {
    // What the trade takes in SOL before any of it comes back: the fees, the
    // SOL being spent, and rent for each token account it opens. Wrapped SOL
    // is opened and closed in the same transaction, but its rent still has to
    // be there to open it.
    const outMissing = !!outAta && !before?.value?.[watched.length - 1];
    const need =
      BASE_FEE +
      p.priority +
      (p.input === SOL_MINT ? p.amount : 0n) +
      (p.input === SOL_MINT || p.output === SOL_MINT ? TOKEN_ACCOUNT_RENT : 0n) +
      (outMissing ? TOKEN_ACCOUNT_RENT : 0n);
    throw simulationError(sim.value.err, sim.value.logs ?? [], { have: pre[0], need, spendsSol: p.input === SOL_MINT });
  }
  const post = watched.map((w, i) => readAccount(sim.value!.accounts?.[i] ?? null, w.kind));

  const sol = post[0] - pre[0];
  const refuse = () => {
    throw new SocialError(502, "Jupiter returned a transaction we will not sign.");
  };
  if (p.input === SOL_MINT && sol < -(p.amount + SOL_OVERHEAD)) refuse();
  if (p.output === SOL_MINT && sol < p.floor - SOL_OVERHEAD) refuse();
  if (p.input !== SOL_MINT && p.output !== SOL_MINT && sol < -SOL_OVERHEAD) refuse();
  let i = 1;
  if (inAta) {
    if (pre[i] - post[i] > p.amount) refuse();
    i++;
  }
  if (outAta && post[i] - pre[i] < p.floor) refuse();
}

/**
 * Quote, build, check, sign and send a swap for an account's own wallet.
 *
 * The server asks Jupiter itself, for this owner. A caller chooses the pair,
 * the amount, the slippage, and states the output it reviewed; a fresh quote
 * below that, less the slippage, is refused rather than traded. What Jupiter
 * sends back is signed only if every instruction is one a swap needs and a
 * simulation shows the owner receiving at least that floor.
 */
export async function swapFor(
  owner: string,
  phrase: string,
  p: { input: string; output: string; amount: string; slippageBps: number; quotedOut: bigint },
): Promise<{ signature: string; outAmount: string; confirmed: boolean }> {
  const fee = feeAccount(p.input, p.output);
  const q = new URLSearchParams({
    inputMint: p.input,
    outputMint: p.output,
    amount: p.amount,
    slippageBps: String(p.slippageBps),
  });
  if (fee) q.set("platformFeeBps", String(JUP_FEE_BPS));
  const quote = await jupiter(`${JUP_SWAP_ENDPOINT}/quote?${q}`, { headers: { Accept: "application/json" } });

  const floor = reviewedFloor(p.quotedOut, p.slippageBps);
  const out = /^\d{1,30}$/.test(String(quote.outAmount ?? "")) ? BigInt(String(quote.outAmount)) : 0n;
  const slippage = slippageFor(out, floor, p.slippageBps);
  if (slippage < 0) throw new SocialError(409, "The price moved. Review the trade again.", { requote: true });
  // Jupiter's program enforces outAmount less slippageBps on chain. Narrowing
  // it here keeps that minimum at or above what the person agreed to.
  quote.slippageBps = slippage;
  quote.otherAmountThreshold = ((out * BigInt(10_000 - slippage)) / 10_000n).toString();

  const built = await jupiter(`${JUP_SWAP_ENDPOINT}/swap`, {
    method: "POST",
    headers: { "Content-Type": "application/json", Accept: "application/json" },
    body: JSON.stringify({
      quoteResponse: quote,
      userPublicKey: owner,
      wrapAndUnwrapSol: true,
      dynamicComputeUnitLimit: true,
      // Under MAX_PRIORITY_LAMPORTS, which the check below enforces anyway.
      prioritizationFeeLamports: {
        priorityLevelWithMaxLamports: { priorityLevel: "medium", maxLamports: PRIORITY_MAX_LAMPORTS },
      },
      ...(fee ? { feeAccount: fee } : {}),
    }),
  });
  if (typeof built.swapTransaction !== "string") throw new SocialError(502, "Jupiter returned no transaction.");

  const ownerKey = base58Decode(owner)!;
  const raw = Buffer.from(built.swapTransaction, "base64");
  const seed = solanaSeed(phrase);
  let signed: Buffer;
  let priority: bigint;
  try {
    const [, len] = shortvecAt(raw, 0);
    priority = checkSwapInstructions(parseMessage(raw.subarray(len + 64)), ownerKey);
    signed = signTransaction(raw, ownerKey, seed);
  } catch {
    throw new SocialError(502, "Jupiter returned a transaction we will not sign.");
  } finally {
    seed.fill(0);
  }
  await simulateSwap(signed, ownerKey, { input: p.input, output: p.output, amount: BigInt(p.amount), floor, priority });
  const signature = await rpc("sendTransaction", [
    signed.toString("base64"),
    { encoding: "base64", preflightCommitment: "confirmed", maxRetries: 3 },
  ]);
  if (typeof signature !== "string") throw new SocialError(502, "The transaction was not sent.");
  // Answer once it has landed, so "done" on the screen means done on chain.
  // Past the wait it is still in flight rather than failed; the client says so.
  const landed = await waitForSignature(signature);
  if (landed.status === "failed") throw new SocialError(400, landed.error, { signature });
  return { signature, outAmount: out.toString(), confirmed: landed.status === "confirmed" };
}
