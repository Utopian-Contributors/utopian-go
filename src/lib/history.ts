import { HELIUS_RPC_URL, TX_VERSION, UTCC_MINT } from "../config";
import { Activity, ActivityMove, HistoryPage, TokenRecord } from "../types";
import { hasIcon } from "./tokens/icons";
import { lookupMints } from "./tokens/store";

/**
 * What one wallet has done, read off the chain a page at a time.
 *
 * Nothing is kept. Each page is asked of Helius when someone opens or scrolls
 * the wallet page's History, and is gone a few seconds later: a server-side
 * record of who traded what would be exactly the record the privacy policy
 * says this site does not hold.
 *
 * `getTransactionsForAddress` rather than the standard signatures-then-
 * transactions pair, for one reason. A token sent to an account this wallet
 * already holds names only that token account, never the wallet, so the
 * standard index of the wallet's address does not have it. Helius's
 * `tokenAccounts` filter folds those in: without it, most $UTCC payments
 * received would be missing from the history of the people who received them.
 * It also returns whole transactions, so a page is one call rather than
 * twenty-one.
 *
 * Every figure is the wallet's net change per token, worked out from the
 * balances before and after, rather than from parsing instructions: what a
 * transaction meant to do matters less here than what it did to this wallet.
 */

const SOL_MINT = "So11111111111111111111111111111111111111112";

/**
 * Called by name whatever the index holds. $UTCC is the coin people pay each
 * other in on Social, and the index can be without it for an hour at a time:
 * it is one pinned lookup, and a rebuild drops a mint Jupiter gives no price.
 */
const NAMED = new Map([
  [SOL_MINT, "SOL"],
  [UTCC_MINT, "UTCC"],
]);

/** Transactions per page: a screen of the list and then some, about 80 KB from upstream. */
const PAGE = 20;

/** Whole transactions weigh more than a balance read; still bounded. */
const TIMEOUT_MS = 10_000;

/**
 * A transaction this wallet did not sign and that moved less than this is
 * left out. Unasked-for dust is how address poisoning plants a lookalike
 * sender in a history, and how most airdrop spam arrives.
 */
const DUST_USD = 0.01;

/** Absorbs a reopen or a second tab, as lib/holdings.ts does, and nothing longer. */
const CACHE_TTL_MS = 5_000;
const MAX_CACHED = 2_000;

/** Helius refused the cursor: the page it pointed at is not one it can resume. */
export class BadCursor extends Error {}

interface TokenBalance {
  accountIndex: number;
  mint: string;
  owner?: string;
  uiTokenAmount?: { amount?: string; decimals?: number };
}

export interface RawTx {
  blockTime?: number | null;
  transaction?: { signatures?: string[]; message?: { accountKeys?: string[] } };
  meta?: {
    err?: unknown;
    fee?: number;
    preBalances?: number[];
    postBalances?: number[];
    preTokenBalances?: TokenBalance[];
    postTokenBalances?: TokenBalance[];
    loadedAddresses?: { writable?: string[]; readonly?: string[] };
  } | null;
}

/** One token account in a transaction: whose, of what, and what it held either side. */
interface TokenAccount {
  mint: string;
  owner?: string;
  decimals: number;
  before: bigint;
  after: bigint;
}

function units(text: unknown): bigint {
  try {
    return BigInt(typeof text === "string" ? text : 0);
  } catch {
    return 0n;
  }
}

function lamports(list: number[] | undefined, i: number): bigint {
  const v = list?.[i];
  return typeof v === "number" && Number.isFinite(v) ? BigInt(Math.trunc(v)) : 0n;
}

/**
 * One transaction from `owner`'s side, or null when it is not worth a line.
 * `hidden` is told about the ones left out on purpose, so the page can say so.
 * `lookup` is the token index, unless a test brings its own.
 */
export function readTx(
  owner: string,
  t: RawTx,
  hidden: { n: number },
  lookup: (mints: string[]) => Map<string, TokenRecord> = lookupMints,
): Activity | null {
  const meta = t.meta;
  const signature = t.transaction?.signatures?.[0];
  if (!meta || !signature) return null;

  const keys = [
    ...(t.transaction?.message?.accountKeys ?? []),
    ...(meta.loadedAddresses?.writable ?? []),
    ...(meta.loadedAddresses?.readonly ?? []),
  ];
  const at = typeof t.blockTime === "number" ? t.blockTime * 1000 : null;
  // The fee payer signs first. The server signs every swap and send an account
  // here makes, so for those this is the wallet itself.
  const signed = keys[0] === owner;
  const fee = BigInt(Math.trunc(meta.fee ?? 0));

  if (meta.err) {
    // Someone else's failure is not this wallet's news.
    return signed ? { signature, at, kind: "failed", moves: [] } : null;
  }

  const accounts = new Map<number, TokenAccount>();
  const sides: [TokenBalance[] | undefined, "before" | "after"][] = [
    [meta.preTokenBalances, "before"],
    [meta.postTokenBalances, "after"],
  ];
  for (const [list, side] of sides) {
    for (const b of list ?? []) {
      let a = accounts.get(b.accountIndex);
      if (!a) {
        a = { mint: b.mint, owner: b.owner, decimals: b.uiTokenAmount?.decimals ?? 0, before: 0n, after: 0n };
        accounts.set(b.accountIndex, a);
      }
      a[side] = units(b.uiTokenAmount?.amount);
      a.owner ??= b.owner;
    }
  }

  const net = new Map<string, { decimals: number; amount: bigint }>();
  const add = (mint: string, decimals: number, amount: bigint) => {
    const had = net.get(mint);
    if (had) had.amount += amount;
    else net.set(mint, { decimals, amount });
  };

  // SOL: the wallet's own lamports, and any wrapped SOL it holds, as one
  // token, the way the portfolio shows them. What this wallet paid to do it
  // is put back, so a token sent reads as that token alone: the fee, and the
  // rent of any token account it opened. Rent is the lamports such an account
  // holds beyond its wrapped SOL, and it comes back when one of this wallet's
  // own is closed.
  const me = keys.indexOf(owner);
  let sol = me >= 0 ? lamports(meta.postBalances, me) - lamports(meta.preBalances, me) : 0n;
  if (signed) sol += fee;
  for (const [i, a] of accounts) {
    const wrapped = a.mint === SOL_MINT;
    const mine = a.owner === owner;
    if (mine && wrapped) sol += a.after - a.before;
    else if (mine) add(a.mint, a.decimals, a.after - a.before);
    const pre = lamports(meta.preBalances, i);
    const post = lamports(meta.postBalances, i);
    if (signed && pre === 0n && post > 0n) sol += post - (wrapped ? a.after : 0n);
    else if (mine && pre > 0n && post === 0n) sol -= pre - (wrapped ? a.before : 0n);
  }
  add(SOL_MINT, 9, sol);

  const known = lookup([...net.keys()]);
  const moves: ActivityMove[] = [];
  let worth = 0;
  /** A named token moved with no price to weigh it by. */
  let unweighed = false;
  for (const [mint, { decimals, amount }] of net) {
    if (amount === 0n) continue;
    const rec = known.get(mint);
    const named = NAMED.get(mint);
    // A token the index does not carry, sent unasked: spam until shown otherwise.
    if (!rec && !named && !signed) continue;
    const price = rec && Number.isFinite(rec.price) && rec.price > 0 ? rec.price : undefined;
    if (price) worth += (Math.abs(Number(amount)) / 10 ** decimals) * price;
    else if (named) unweighed = true;
    moves.push({
      mint,
      symbol: named ?? rec?.symbol ?? "",
      decimals,
      amount: amount.toString(),
      ...(price ? { price } : {}),
      ...(hasIcon(mint) ? { icon: true as const } : {}),
    });
  }

  // A payment in $UTCC while the index has no price for it is shown, not
  // taken for dust: missing someone's payment is worse than showing spam.
  if (!signed && worth < DUST_USD && !unweighed) {
    hidden.n += 1;
    return null;
  }

  // What went out first, then what came in: "SOL for USDC" reads that way.
  moves.sort((a, b) => Number(b.amount.startsWith("-")) - Number(a.amount.startsWith("-")));
  const outs = moves.filter((m) => m.amount.startsWith("-")).length;
  const ins = moves.length - outs;
  const kind: Activity["kind"] = outs && ins ? "swap" : outs ? "send" : ins ? "receive" : "other";

  const out: Activity = { signature, at, kind, moves };
  if (moves.length === 1 && (kind === "send" || kind === "receive")) {
    const peer = peerOf(owner, keys, meta, accounts, moves[0].mint, kind === "send", me);
    if (peer) out.peer = peer;
  }
  return out;
}

/**
 * The wallet on the other end of a one-token send or receipt: whichever moved
 * the most of that token the other way. For SOL that is a plain account, not a
 * token account (whose lamports are rent), with the fee taken off its payer.
 */
function peerOf(
  owner: string,
  keys: string[],
  meta: NonNullable<RawTx["meta"]>,
  accounts: Map<number, TokenAccount>,
  mint: string,
  sent: boolean,
  me: number,
): string | undefined {
  let best: string | undefined;
  let size = 0n;
  const offer = (who: string | undefined, delta: bigint) => {
    const toward = sent ? delta : -delta;
    if (who && who !== owner && toward > size) {
      best = who;
      size = toward;
    }
  };
  if (mint === SOL_MINT) {
    keys.forEach((key, i) => {
      if (i === me || accounts.has(i)) return;
      let delta = lamports(meta.postBalances, i) - lamports(meta.preBalances, i);
      if (i === 0) delta += BigInt(Math.trunc(meta.fee ?? 0));
      offer(key, delta);
    });
  } else {
    for (const a of accounts.values()) if (a.mint === mint) offer(a.owner, a.after - a.before);
  }
  return best;
}

interface RpcReply {
  result?: { data?: RawTx[]; paginationToken?: string | null };
  error?: { message?: string };
}

/**
 * One call's worth of `owner`'s whole transactions: newest first for the
 * History list, or oldest first from `since` (epoch ms) for a walk through
 * the day (lib/entries.ts). `next` asks for the page after; absent on a short
 * page, which is the last one whatever else came with it.
 */
export async function readTransactions(
  owner: string,
  opts: { limit: number; order: "asc" | "desc"; after?: string; since?: number },
): Promise<{ data: RawTx[]; next?: string }> {
  // No RPC is a deployment fault, and an empty history would be a confident lie.
  if (!HELIUS_RPC_URL) throw new Error("HELIUS_RPC_URL is not configured");

  const res = await fetch(HELIUS_RPC_URL, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    signal: AbortSignal.timeout(TIMEOUT_MS),
    body: JSON.stringify({
      jsonrpc: "2.0",
      id: 1,
      method: "getTransactionsForAddress",
      params: [
        owner,
        {
          transactionDetails: "full",
          sortOrder: opts.order,
          limit: opts.limit,
          encoding: "json",
          maxSupportedTransactionVersion: TX_VERSION,
          // A trade made a moment ago is in the history when the page is opened.
          commitment: "confirmed",
          filters: {
            tokenAccounts: "balanceChanged",
            // A failure moved nothing, so a walk through the day skips them upstream.
            ...(opts.since != null ? { blockTime: { gte: Math.floor(opts.since / 1000) }, status: "succeeded" } : {}),
          },
          ...(opts.after ? { paginationToken: opts.after } : {}),
        },
      ],
    }),
  });
  if (!res.ok) {
    const text = await res.text().catch(() => "");
    throw new Error(`RPC responded ${res.status}${text ? `: ${text.slice(0, 200)}` : ""}`);
  }
  const body = (await res.json()) as RpcReply;
  if (body.error) {
    const message = body.error.message || "";
    if (/pagination/i.test(message)) throw new BadCursor(message);
    throw new Error(`RPC error: ${message.slice(0, 200)}`);
  }

  const data = Array.isArray(body.result?.data) ? body.result.data : [];
  const next = data.length === opts.limit ? body.result?.paginationToken : null;
  return { data, ...(next ? { next } : {}) };
}

async function readPage(owner: string, after: string): Promise<HistoryPage> {
  const { data, next } = await readTransactions(owner, { limit: PAGE, order: "desc", after });
  const hidden = { n: 0 };
  const items: Activity[] = [];
  for (const t of data) {
    const item = readTx(owner, t, hidden);
    if (item) items.push(item);
  }
  return { items, ...(next ? { after: next } : {}), ...(hidden.n ? { hidden: hidden.n } : {}) };
}

const cache = new Map<string, { at: number; value: HistoryPage }>();
const inFlight = new Map<string, Promise<HistoryPage>>();

/** A page of `owner`'s history: the newest, or the one `after` points at. */
export async function fetchHistory(owner: string, after = ""): Promise<HistoryPage> {
  const key = `${owner}|${after}`;
  const now = Date.now();
  const hit = cache.get(key);
  if (hit && now - hit.at < CACHE_TTL_MS) return hit.value;

  const pending = inFlight.get(key);
  if (pending) return pending;

  const task = readPage(owner, after)
    .then((value) => {
      // Past the cap is a flood, not a working set, as in lib/holdings.ts.
      if (cache.size >= MAX_CACHED) cache.clear();
      cache.set(key, { at: Date.now(), value });
      return value;
    })
    .finally(() => inFlight.delete(key));
  inFlight.set(key, task);
  return task;
}
