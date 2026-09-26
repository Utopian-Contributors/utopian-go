import { JUP_LITE_BURST, JUP_LITE_PER_MIN, JUP_LITE_TRADE_RESERVE } from "../config";

/**
 * One request budget for everything this server asks lite-api.jup.ag.
 *
 * The keyless tier limits by IP, and every caller here shares the server's
 * IP: the hourly index, the wallet page's detail panel, and trades signed for
 * Social accounts. Each had its own pacing, or none, so together they could
 * run past the limit, and then all of them fail, trades included.
 *
 * So the budget is a single token bucket with a floor kept for trades. A
 * detail lookup is decoration and gives up the moment the bucket is down to
 * that floor; the index can wait for a token; a trade takes whatever is left.
 * A 429 from Jupiter stops everything until its Retry-After has passed,
 * because asking again inside that window only extends it.
 */

export type JupPriority = "trade" | "index" | "detail";

const refillPerMs = JUP_LITE_PER_MIN / 60_000;
let tokens = JUP_LITE_BURST;
let at = Date.now();
let pausedUntil = 0;

function refill(now: number): void {
  tokens = Math.min(JUP_LITE_BURST, tokens + (now - at) * refillPerMs);
  at = now;
}

/** The tokens a caller of this priority must leave behind. */
function floor(priority: JupPriority): number {
  return priority === "trade" ? 0 : JUP_LITE_TRADE_RESERVE;
}

/** Take one request's worth now, or say no. */
export function tryTake(priority: JupPriority): boolean {
  const now = Date.now();
  if (now < pausedUntil) return false;
  refill(now);
  if (tokens - 1 < floor(priority)) return false;
  tokens -= 1;
  return true;
}

/** Milliseconds until `tryTake(priority)` could next succeed. */
function waitFor(priority: JupPriority): number {
  const now = Date.now();
  if (now < pausedUntil) return pausedUntil - now;
  refill(now);
  const need = floor(priority) + 1 - tokens;
  return need <= 0 ? 0 : Math.ceil(need / refillPerMs);
}

export class JupiterBusy extends Error {
  constructor() {
    super("Jupiter is busy. Try again in a minute.");
  }
}

/** Jupiter said 429: nobody asks again until it says we may. */
function backOff(res: Response): void {
  const header = Number(res.headers.get("retry-after"));
  const ms = Number.isFinite(header) && header > 0 ? header * 1000 : 60_000;
  pausedUntil = Math.max(pausedUntil, Date.now() + Math.min(ms, 10 * 60_000));
  console.warn(`[jupiter] 429, pausing ${Math.round(ms / 1000)}s`);
}

/**
 * fetch() against lite-api, inside the budget.
 *
 * `index` may wait for a token, up to `maxWaitMs`. `trade` and `detail` do
 * not wait: a person is watching, and a refusal they can retry beats a
 * spinner. The timeout starts once the request actually leaves.
 * Throws JupiterBusy when there is no token to spend.
 */
export async function jupFetch(
  url: string,
  init: RequestInit,
  priority: JupPriority,
  opts: { timeoutMs: number; maxWaitMs?: number },
): Promise<Response> {
  const deadline = Date.now() + (opts.maxWaitMs ?? 0);
  while (!tryTake(priority)) {
    const wait = waitFor(priority);
    if (Date.now() + wait > deadline) throw new JupiterBusy();
    await new Promise((resolve) => setTimeout(resolve, Math.max(wait, 50)));
  }
  const res = await fetch(url, { ...init, signal: AbortSignal.timeout(opts.timeoutMs) });
  if (res.status === 429) backOff(res);
  return res;
}
