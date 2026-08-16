import { NextFunction, Request, Response } from "express";

/**
 * Per-IP token bucket, in process.
 *
 * Written by hand rather than pulled in, for the same reason the rest of this
 * app is: express and compression are the only two runtime dependencies, and a
 * limiter is forty lines. It is also the right shape for a single-process
 * deployment — a shared store would only matter across replicas, and there are
 * none.
 *
 * What it is actually defending: /api/search and /api/images spend a metered
 * Brave subscription on every call, and /api/balances spends Helius RPC credits
 * and holds our key. All three are anonymous GETs, so without this one client
 * can drain a paid quota — the failure is a bill and an outage for everyone
 * else, not a compromise, which is why the limits below are set to be invisible
 * to a person and obvious to a script.
 *
 * A bucket refills continuously rather than resetting on a window boundary, so
 * ordinary bursty use — typing a query, switching to Images, opening the buy
 * dialog — never trips it, while a sustained flood settles at the refill rate.
 */

interface Bucket {
  /** Tokens remaining, fractional between refills. */
  tokens: number;
  /** When `tokens` was last brought up to date. */
  at: number;
}

export interface RateLimitOptions {
  /** Sustained requests per minute once the burst allowance is spent. */
  perMinute: number;
  /** Requests allowed back to back from cold. */
  burst: number;
}

/**
 * Ceiling on tracked clients.
 *
 * The map is keyed by remote address, which an attacker behind a wide IPv6
 * allocation can vary freely — so the limiter must not become the memory leak
 * it exists to prevent.
 */
const MAX_CLIENTS = 20_000;

/**
 * Make room, without ever handing back an allowance.
 *
 * The obvious eviction — clear the map when it fills — is exactly wrong here:
 * forgetting a bucket *is* refilling it, so a flood of fresh keys would let the
 * flooder wipe its own throttle, and everyone else's, on demand. So eviction is
 * restricted to buckets that hold nothing worth remembering:
 *
 *  1. Buckets refilled to full. These are indistinguishable from absent ones —
 *     a client at `burst` tokens gets the same answer whether or not we kept it.
 *  2. Failing that, admit nothing new. A key we never store is a key that never
 *     grows the map, and the request is refused rather than waved through.
 *
 * The result is that being over the cap can cost a *new* client its first
 * request, but can never restore a throttled one.
 */
function evictSpent(buckets: Map<string, Bucket>, now: number, refillPerMs: number, burst: number): void {
  for (const [key, bucket] of buckets) {
    const tokens = bucket.tokens + (now - bucket.at) * refillPerMs;
    if (tokens >= burst) buckets.delete(key);
  }
}

/**
 * @param options sustained rate and burst allowance
 * @returns express middleware answering 429 once a client is over
 */
export function rateLimit({ perMinute, burst }: RateLimitOptions) {
  const buckets = new Map<string, Bucket>();
  const refillPerMs = perMinute / 60_000;

  return function limiter(req: Request, res: Response, next: NextFunction) {
    // `trust proxy` is set in server.ts, so this is the client rather than
    // Railway's edge. The fallback keeps a socket with no address from
    // collapsing every such request into one shared bucket named "undefined".
    const key = req.ip || req.socket.remoteAddress || "unknown";
    const now = Date.now();

    let bucket = buckets.get(key);
    if (!bucket) {
      if (buckets.size >= MAX_CLIENTS) {
        evictSpent(buckets, now, refillPerMs, burst);
        // Still full: every tracked client is mid-throttle, so this is a flood
        // of fresh keys. Refuse rather than grow — see evictSpent.
        if (buckets.size >= MAX_CLIENTS) {
          res.setHeader("Retry-After", "60");
          res.status(429).json({ error: "Too many requests. Try again shortly." });
          return;
        }
      }
      bucket = { tokens: burst, at: now };
      buckets.set(key, bucket);
    } else {
      bucket.tokens = Math.min(burst, bucket.tokens + (now - bucket.at) * refillPerMs);
      bucket.at = now;
    }

    if (bucket.tokens < 1) {
      const waitMs = Math.ceil((1 - bucket.tokens) / refillPerMs);
      res.setHeader("Retry-After", String(Math.ceil(waitMs / 1000)));
      // No body detail: the limit is not a secret, but neither is it something
      // a client needs to read to back off correctly.
      res.status(429).json({ error: "Too many requests. Try again shortly." });
      return;
    }

    bucket.tokens -= 1;
    next();
  };
}
