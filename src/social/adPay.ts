import { randomBytes, randomInt } from "crypto";
import { ADS_PAY_TO, HELIUS_RPC_URL } from "../config";
import { lookupToken } from "../lib/tokens/store";
import { reloadAds } from "./ads";
import { type AdOrder, openOrders, payOrder, sweepAds } from "./db";
import { base58, base58Decode } from "./keys";
import { rpc, solanaPubkey } from "./pay";
import { TOKEN, associatedTokenAccount } from "./send";

/**
 * Advertising is paid by Solana Pay, in SOL or USDC, to ADS_PAY_TO. The
 * request carries a reference and the campaign's memo, but a wallet may send
 * neither: Phantom's scanner sends a plain transfer of the amount. So each
 * order's amount is its own as well, a few base units under a cent that no
 * other open order asks for. A loop reads every transfer into ADS_PAY_TO and
 * its USDC account, and credits the order it names: by reference, by memo, or
 * by its exact amount.
 *
 * SOL and USDC, because a wallet asked for a token it does not hold refuses the
 * request outright, and every wallet holds SOL. The SOL amount is fixed at
 * checkout, from the token index's price.
 */

export const USDC_MINT = "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v";
/** An order is looked for this long: every tick while one is fresh, every minute after. */
export const ORDER_OPEN_MS = 24 * 3600_000;
/** Also how long checking out again for the same budget shows the same code, before SOL's price has moved on. */
export const FRESH_MS = 15 * 60_000;
const TICK_MS = 5_000;
const SLOW_MS = 60_000;
const SWEEP_MS = 3600_000;
/** An order's own base units, on top of its price: under a cent, and under 0.00001 SOL. */
const MARK = 10_000;
/** A block's time and ours may disagree by this much. */
const SKEW_MS = 120_000;
/** Crockford's base32: no I, L, O or U to misread. */
const CODE = "0123456789ABCDEFGHJKMNPQRSTVWXYZ";

/** Whether checkout can work at all: somewhere to pay, and a way to see it arrive. */
export function adsPayable(): boolean {
  return !!HELIUS_RPC_URL && !!solanaPubkey(ADS_PAY_TO);
}

export function orderCodes(): { reference: string; memo: string } {
  let memo = "UG-";
  for (let i = 0; i < 8; i++) memo += CODE[randomInt(CODE.length)];
  return { reference: base58(randomBytes(32)), memo };
}

/** Base units as a decimal amount, without a float on the way. */
export function decimal(units: number, places: number): string {
  const text = String(units).padStart(places + 1, "0");
  const frac = text.slice(-places).replace(/0+$/, "");
  return frac ? `${text.slice(0, -places)}.${frac}` : text.slice(0, -places);
}

export function dollars(cents: number): string {
  return decimal(cents, 2);
}

/**
 * What an order asks for: USDC in millionths, and lamports at SOL's price now
 * (null without one), each with base units on top that no open order has.
 */
export function orderAmounts(
  cents: number,
  open: Pick<AdOrder, "usdc" | "lamports">[],
): { usdc: number; lamports: number | null } {
  const mark = (base: number, taken: Set<number | null>) => {
    for (let i = 0; i < 100; i++) {
      const amount = base + randomInt(1, MARK);
      if (!taken.has(amount)) return amount;
    }
    return base + randomInt(1, MARK);
  };
  const usdc = mark(cents * 10_000, new Set(open.map((o) => o.usdc)));
  const price = lookupToken("sol")?.price;
  if (!price || !Number.isFinite(price) || price <= 0) return { usdc, lamports: null };
  const lamports = Math.ceil((cents / 100 / price) * 1e5) * MARK;
  return { usdc, lamports: mark(lamports, new Set(open.map((o) => o.lamports))) };
}

/** The Solana Pay transfer request a QR code carries, in SOL or in USDC. */
export function payUrl(
  order: Pick<AdOrder, "usdc" | "lamports" | "reference" | "memo" | "payTo">,
  fund: "usdc" | "sol",
): string {
  const params = [
    ...(fund === "sol"
      ? [["amount", decimal(order.lamports ?? 0, 9)]]
      : [["amount", decimal(order.usdc, 6)], ["spl-token", USDC_MINT]]),
    ["reference", order.reference],
    ["label", "UtopianGO"],
    ["message", "UtopianGO ad"],
    ["memo", order.memo],
  ];
  return `solana:${order.payTo || ADS_PAY_TO}?${params.map(([k, v]) => `${k}=${encodeURIComponent(v)}`).join("&")}`;
}

type ParsedIx = { program?: string; parsed?: unknown };
type TokenBalance = { mint: string; owner?: string; uiTokenAmount: { amount: string } };
export type ParsedTx = {
  meta: {
    err: unknown;
    preBalances?: number[];
    postBalances?: number[];
    preTokenBalances?: TokenBalance[];
    postTokenBalances?: TokenBalance[];
    innerInstructions?: { instructions: ParsedIx[] }[];
  } | null;
  transaction: { message: { accountKeys?: ({ pubkey: string } | string)[]; instructions: ParsedIx[] } };
};

/** Money that arrived in `payTo`, with what the transaction said besides. */
export type Transfer = {
  signature: string;
  at: number;
  fund: "sol" | "usdc";
  received: number;
  payer: string;
  memos: string[];
  keys: Set<string>;
};

/** The SOL and the USDC a successful transaction left `payTo` holding more of. */
export function transfersIn(signature: string, at: number, tx: ParsedTx | null, payTo: string): Transfer[] {
  if (!tx?.meta || tx.meta.err) return [];
  const keys = (tx.transaction.message.accountKeys ?? []).map((k) => (typeof k === "string" ? k : k.pubkey));
  const memos = [...tx.transaction.message.instructions, ...(tx.meta.innerInstructions ?? []).flatMap((i) => i.instructions)]
    .filter((ix) => ix.program === "spl-memo" && typeof ix.parsed === "string")
    .map((ix) => String(ix.parsed));
  const held = (list: TokenBalance[] | undefined) =>
    (list ?? []).filter((b) => b.mint === USDC_MINT && b.owner === payTo).reduce((sum, b) => sum + Number(b.uiTokenAmount.amount), 0);
  const i = keys.indexOf(payTo);
  const moved: [Transfer["fund"], number][] = [
    ["sol", i < 0 ? 0 : (tx.meta.postBalances?.[i] ?? 0) - (tx.meta.preBalances?.[i] ?? 0)],
    ["usdc", held(tx.meta.postTokenBalances) - held(tx.meta.preTokenBalances)],
  ];
  return moved
    .filter(([, received]) => received > 0)
    .map(([fund, received]) => ({ signature, at, fund, received, payer: keys[0] ?? "", memos, keys: new Set(keys) }));
}

/**
 * The open order a transfer pays: the one whose reference it carries; else,
 * of its campaign's by memo, the one asking exactly this, or the oldest it
 * covers; else the oldest asking exactly this. Null when it names none.
 */
export function matchTransfer(
  t: Transfer,
  open: AdOrder[],
): { order: AdOrder; matched: "reference" | "memo" | "amount" } | null {
  const asks = (o: AdOrder) => (t.fund === "sol" ? o.lamports : o.usdc);
  const covers = (o: AdOrder) => (asks(o) ?? Infinity) <= t.received;
  const timely = (o: AdOrder) => o.at <= t.at + SKEW_MS && t.at - o.at <= ORDER_OPEN_MS;
  const oldest = [...open].sort((a, b) => a.at - b.at);
  const byReference = oldest.find((o) => t.keys.has(o.reference) && covers(o));
  if (byReference) return { order: byReference, matched: "reference" };
  const byMemo = oldest.filter((o) => t.memos.includes(o.memo) && covers(o) && timely(o));
  if (byMemo.length) return { order: byMemo.find((o) => asks(o) === t.received) ?? byMemo[0], matched: "memo" };
  const byAmount = oldest.find((o) => asks(o) === t.received && timely(o));
  return byAmount ? { order: byAmount, matched: "amount" } : null;
}

/** The newest signature handled, per watched address. */
const cursors = new Map<string, string>();
let usdcAccount = "";
let lastLook = 0;
let busy = false;
let swept = 0;

/**
 * Read what arrived at `address` since the cursor, oldest first, and credit
 * what pays an open order. The cursor moves past each transaction once it is
 * handled, so an RPC that fails mid-way is picked up where it stopped.
 */
async function scan(address: string, since: number, open: AdOrder[]): Promise<boolean> {
  const until = cursors.get(address);
  const found = (await rpc("getSignaturesForAddress", [
    address,
    { limit: 100, commitment: "confirmed", ...(until ? { until } : {}) },
  ])) as { signature: string; err: unknown; blockTime: number | null }[];
  let paid = false;
  for (const entry of [...(found ?? [])].reverse()) {
    const at = (entry.blockTime ?? 0) * 1000;
    if (!entry.err && at >= since - SKEW_MS) {
      const tx = (await rpc("getTransaction", [
        entry.signature,
        { encoding: "jsonParsed", commitment: "confirmed", maxSupportedTransactionVersion: 0 },
      ])) as ParsedTx | null;
      for (const t of transfersIn(entry.signature, at, tx, ADS_PAY_TO)) {
        const hit = matchTransfer(t, open);
        const proof = { signature: t.signature, fund: t.fund, received: t.received, payer: t.payer };
        if (hit && (await payOrder(hit.order.id, { ...proof, matched: hit.matched }, Date.now()))) {
          open.splice(open.indexOf(hit.order), 1);
          paid = true;
        } else if (!hit) {
          console.log(`[ads] payment matches no order: ${t.signature} ${t.fund} ${t.received}`);
        }
      }
    }
    cursors.set(address, entry.signature);
  }
  return paid;
}

async function tick(): Promise<void> {
  if (busy) return;
  busy = true;
  const now = Date.now();
  try {
    if (now - swept > SWEEP_MS) {
      swept = now;
      await sweepAds(now - 2 * ORDER_OPEN_MS);
    }
    const open = await openOrders(now - ORDER_OPEN_MS);
    if (!open.length || (!open.some((o) => now - o.at < FRESH_MS) && now - lastLook < SLOW_MS)) return;
    lastLook = now;
    const since = Math.min(...open.map((o) => o.at));
    let paid = false;
    for (const address of [ADS_PAY_TO, usdcAccount]) {
      if (await scan(address, since, open)) paid = true;
    }
    if (paid) await reloadAds();
  } catch (err) {
    console.error("[ads] payments:", err instanceof Error ? err.message : err);
  } finally {
    busy = false;
  }
}

export function startAdPayments(): void {
  if (!adsPayable()) {
    console.log("Set ADS_PAY_TO (a Solana address) and HELIUS_RPC_URL to take payment for ads.");
    return;
  }
  // A USDC transfer moves into the payee's token account, and need not name the payee itself.
  usdcAccount = base58(associatedTokenAccount(base58Decode(ADS_PAY_TO)!, base58Decode(USDC_MINT)!, TOKEN));
  setInterval(tick, TICK_MS).unref();
}
