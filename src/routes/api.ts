import express, { NextFunction, Request, Response, Router } from "express";
import { fetchBalances, isPubkey } from "../lib/balances";
import { fetchHoldings } from "../lib/holdings";
import { BraveApiError, braveImageSearch, braveSearch } from "../lib/brave";
import { asString } from "../lib/query";
import { rateLimit } from "../lib/rateLimit";
import { lookupTokens } from "../lib/tokens/store";
import {
  BalancesApiResponse,
  HoldingsApiResponse,
  ImageSearchApiResponse,
  SearchApiResponse,
} from "../types";

export const apiRouter = Router();

/**
 * JSON bodies, for the endpoints whose arguments must not be in a URL.
 *
 * A query string is written to the hosting provider's access log next to the
 * caller's IP address. That is a reasonable place for a search term — the
 * privacy policy says so — and a bad place for a wallet address, which turns a
 * request log into a record of who holds what. Same for the mint and amount
 * someone is pricing before they have agreed to anything. Those arguments
 * travel in a body instead, which is not logged.
 *
 * 1 KB is far more than either endpoint's arguments need, and a body parser
 * with no limit is a memory-exhaustion endpoint of its own.
 */
const jsonBody = express.json({ limit: "1kb" });

/** Parse a JSON body, answering 400 rather than falling through to a stack trace. */
function readJson(req: Request, res: Response, next: NextFunction) {
  jsonBody(req, res, (err?: unknown) => {
    if (err) {
      res.status(400).json({ error: "Malformed request." });
      return;
    }
    next();
  });
}

/**
 * Every limit here is per *egress IP*, not per person.
 *
 * That distinction sets the numbers. An office, a university, a phone carrier's
 * CGNAT pool and a VPN exit all arrive as one address, so a ceiling tuned to
 * one enthusiastic user throttles a building. These are therefore set well
 * above any single session's appetite and aimed only at the shape they exist to
 * stop: a script pulling continuously to burn a metered quota.
 *
 * Search and images get separate buckets rather than sharing one. Opening the
 * Images tab spends a call on each — a shared bucket would silently charge one
 * user action twice and halve the effective ceiling.
 */
const searchLimit = rateLimit({ perMinute: 120, burst: 40 });
const imagesLimit = rateLimit({ perMinute: 120, burst: 40 });

/**
 * Balances is chattier by design — the dialog refetches on connect, on every
 * currency flip, and on each direction flip — and a throttle here degrades a
 * live swap rather than a search, so it gets the most room. Each call is still
 * one batched Helius request against our key, which is why it has a ceiling
 * at all.
 */
const balancesLimit = rateLimit({ perMinute: 180, burst: 60 });

/**
 * Holdings is the opposite shape: one request per visit to the wallet page,
 * answered from a 15s cache, and each miss is a three-call batch against our
 * Helius key. So it gets a tighter bucket than balances — nothing legitimate
 * asks for a portfolio in a loop, and the endpoint takes a caller-supplied
 * address, which makes it the cheapest thing on this server to point a script at.
 */
const holdingsLimit = rateLimit({ perMinute: 60, burst: 20 });

/**
 * Route an async handler's rejection to Express instead of into the void.
 *
 * Express 4 predates async handlers: it catches a synchronous throw and knows
 * nothing about a returned promise, so a rejection inside one reaches no error
 * middleware and never answers the request. The socket then just hangs until
 * the client gives up, and the process-level handler in server.ts logs a
 * rejection with no request attached to it.
 *
 * `asString` closes the one place this was reachable from outside; this closes
 * the shape of the bug, so the next handler someone writes cannot reintroduce
 * it by awaiting something new.
 */
function wrap(
  handler: (req: Request, res: Response) => Promise<unknown>,
): (req: Request, res: Response, next: NextFunction) => void {
  return (req, res, next) => {
    Promise.resolve(handler(req, res)).catch(next);
  };
}

function apiError(err: unknown, query: string) {
  const message =
    err instanceof BraveApiError
      ? err.message
      : "Unexpected error while searching.";
  const status = err instanceof BraveApiError ? 502 : 500;
  return { message, status, query };
}

/** JSON web search API for client-side hydration. */
apiRouter.get("/api/search", searchLimit, wrap(async (req: Request, res: Response) => {
  const q = asString(req.query.q).trim();

  if (!q) {
    const body: SearchApiResponse = { query: "", results: [] };
    res.json(body);
    return;
  }

  // Resolved from the in-memory index — synchronous, so the prices ride along
  // on this response instead of costing a second round trip.
  const tokens = lookupTokens(q);

  try {
    const body = await braveSearch(q);
    if (tokens.length) body.tokens = tokens;
    res.json(body);
  } catch (err) {
    const { message, status, query } = apiError(err, q);
    // A price is still worth serving when web results are not — checking a
    // token on a bad link is the case this exists for.
    const body: SearchApiResponse = {
      query,
      results: [],
      ...(tokens.length ? { tokens } : {}),
      error: message,
    };
    res.status(status).json(body);
  }
}));

/** JSON image search API (Brave Images endpoint). */
apiRouter.get("/api/images", imagesLimit, wrap(async (req: Request, res: Response) => {
  const q = asString(req.query.q).trim();

  if (!q) {
    const body: ImageSearchApiResponse = { query: "", images: [] };
    res.json(body);
    return;
  }

  try {
    res.json(await braveImageSearch(q));
  } catch (err) {
    const { message, status, query } = apiError(err, q);
    const body: ImageSearchApiResponse = {
      query,
      images: [],
      error: message,
    };
    res.status(status).json(body);
  }
}));

/**
 * Fundable balances for one wallet. Read-only and scoped to two mints — it
 * exists so the browser never needs our RPC credentials.
 *
 * POST rather than GET because the argument is a wallet address. A query string
 * lands in the hosting provider's request log beside the caller's IP, which
 * would quietly turn an access log into a record tying an address to a person —
 * the one thing section 9.6 of the privacy policy says this site does not keep.
 * Nothing about the lookup itself changed; only where its arguments travel.
 */
apiRouter.post(
  "/api/balances",
  balancesLimit,
  readJson,
  wrap(async (req: Request, res: Response) => {
    const owner = asString(req.body?.owner).trim();
    const mint = asString(req.body?.mint).trim();

    if (!isPubkey(owner)) {
      const body: BalancesApiResponse = { error: "Invalid wallet address." };
      res.status(400).json(body);
      return;
    }
    if (mint && !isPubkey(mint)) {
      const body: BalancesApiResponse = { error: "Invalid mint address." };
      res.status(400).json(body);
      return;
    }

    try {
      res.json(await fetchBalances(owner, mint || undefined));
    } catch (err) {
      console.warn("[balances] lookup failed:", err);
      // The dialog treats this as "unknown", not "zero" — it still lets someone
      // type an amount, and Jupiter rejects it later if they can't cover it.
      const body: BalancesApiResponse = {
        error: "Could not read balances.",
        // Outside production the cause is worth having in the response; a
        // silent 502 is the hardest kind of failure to chase from the browser.
        ...(process.env.NODE_ENV === "production"
          ? {}
          : { detail: err instanceof Error ? err.message : String(err) }),
      };
      res.status(502).json(body);
    }
  }),
);

/**
 * Everything one wallet holds, priced from our own token index.
 *
 * POST for the same reason /api/balances is: the argument is a wallet address,
 * and a query string is written to the hosting provider's request log next to
 * the caller's IP. A GET here would turn an access log into a record of which
 * address was looked at from which connection — which is exactly what section
 * 9.6 of the privacy policy says this site does not keep.
 *
 * Note what this does *not* assert: that the caller owns the address. It
 * cannot, and does not try to — every figure it returns is public on-chain
 * data that any explorer will show for any address. The wallet page asks about
 * the address the browser remembered; the endpoint answers about whatever
 * address it is handed.
 */
apiRouter.post(
  "/api/holdings",
  holdingsLimit,
  readJson,
  wrap(async (req: Request, res: Response) => {
    const owner = asString(req.body?.owner).trim();

    if (!isPubkey(owner)) {
      const body: HoldingsApiResponse = { error: "Invalid wallet address." };
      res.status(400).json(body);
      return;
    }

    try {
      res.json(await fetchHoldings(owner));
    } catch (err) {
      console.warn("[holdings] lookup failed:", err);
      // The page says "could not read" rather than rendering an empty
      // portfolio: zero holdings and a failed lookup look identical in a
      // response body and could not be less alike to the person reading it.
      const body: HoldingsApiResponse = {
        error: "Could not read this wallet.",
        ...(process.env.NODE_ENV === "production"
          ? {}
          : { detail: err instanceof Error ? err.message : String(err) }),
      };
      res.status(502).json(body);
    }
  }),
);

/** Legacy /search?q= → SPA query string. */
apiRouter.get("/search", (req: Request, res: Response) => {
  const q = asString(req.query.q).trim();
  res.redirect(302, q ? `/?q=${encodeURIComponent(q)}` : "/");
});
