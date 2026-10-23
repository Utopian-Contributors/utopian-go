import express, { NextFunction, Request, Response, Router } from "express";
import { fetchBalances, isPubkey } from "../lib/balances";
import { fetchEntries, readBasis } from "../lib/entries";
import { BadCursor, fetchHistory } from "../lib/history";
import { fetchHoldings } from "../lib/holdings";
import { isTicker, resolveTickers } from "../social/callouts";
import { namesOf } from "../social/db";
import { BRAVE_MAX_OFFSET, TOKEN_TOP_COUNT } from "../config";
import { BraveApiError, braveImageSearch, braveSearch } from "../lib/brave";
import { DEFAULT_LANG, isLanguage } from "../lib/lang";
import { asString } from "../lib/query";
import { rateLimit } from "../lib/rateLimit";
import { isSignature, signatureStatus } from "../lib/txStatus";
import { MAX_ASSETS, fetchAssets } from "../lib/tokens/asset";
import { tokenDetail } from "../lib/tokens/detail";
import { isChartRange, priceSeries } from "../lib/tokens/history";
import {
  isTokenList,
  listCounts,
  listTokens,
  lookupMints,
  lookupTokens,
  quoteMints,
  searchTokens,
  topTokens,
} from "../lib/tokens/store";
import {
  AssetsApiResponse,
  BalancesApiResponse,
  EntriesApiResponse,
  HistoryApiResponse,
  HistoryPage,
  HoldingsApiResponse,
  ImageSearchApiResponse,
  SearchApiResponse,
  TokenPage,
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

/** /api/assets's list of mints: fifty addresses are about 2.5 KB. */
const listBody = express.json({ limit: "4kb" });

/** /api/entries's basis: a position for each of fifty holdings, under 4 KB, and the mints given up on. */
const basisBody = express.json({ limit: "8kb" });

/** Parse a JSON body, answering 400 rather than falling through to a stack trace. */
function parseWith(parser: typeof jsonBody) {
  return (req: Request, res: Response, next: NextFunction) => {
    parser(req, res, (err?: unknown) => {
      if (err) {
        res.status(400).json({ error: "Malformed request." });
        return;
      }
      next();
    });
  };
}

const readJson = parseWith(jsonBody);
const readList = parseWith(listBody);
const readBasisBody = parseWith(basisBody);

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
 * The trade dialog polls this about once a second while a transaction lands,
 * and gives up after a minute — so 120 a minute covers two trades at once.
 */
const txLimit = rateLimit({ perMinute: 120, burst: 40 });

/**
 * Holdings is the opposite shape: one request per visit to the wallet page,
 * answered from a 15s cache, and each miss is a three-call batch against our
 * Helius key. So it gets a tighter bucket than balances — nothing legitimate
 * asks for a portfolio in a loop, and the endpoint takes a caller-supplied
 * address, which makes it the cheapest thing on this server to point a script at.
 */
const holdingsLimit = rateLimit({ perMinute: 60, burst: 20 });

/**
 * History is a page per scroll, and each is Helius's heaviest kind of call
 * against our key. Ten at once covers a quick scroll back; past that, a page
 * every three seconds is faster than anyone reads one.
 */
const historyLimit = rateLimit({ perMinute: 20, burst: 10 });

/**
 * Entries are asked once per portfolio the wallet page paints with new
 * balances: a visit, and again after each trade. Each miss reads the day's
 * history, Helius's heaviest call, so the bucket is History's size again.
 */
const entriesLimit = rateLimit({ perMinute: 30, burst: 10 });

/**
 * Asked when someone opens a token the index does not carry, one batch per
 * opening; the cache absorbs a reopen. Each miss is one Helius call.
 */
const assetsLimit = rateLimit({ perMinute: 30, burst: 10 });

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

/**
 * The page the caller asked for, clamped to one Brave will answer.
 *
 * Caller-supplied and therefore not trusted with the upstream URL: "abc",
 * "-1" and "500" all have to become a page number here, because past the
 * ceiling Brave answers 422 and this server renders that to the visitor as
 * "Brave API responded 422" — an upstream complaint about our own URL.
 */
function readOffset(value: unknown): number {
  const n = Math.floor(Number(asString(value)));
  if (!Number.isFinite(n) || n <= 0) return 0;
  return Math.min(n, BRAVE_MAX_OFFSET);
}

/**
 * The result language the caller asked for, or English.
 *
 * Same reasoning as readOffset above, and the same refusal to forward what it
 * was handed: `search_lang`, `country` and `ui_lang` are all closed enums
 * upstream, and a code Brave does not know is a 422 that this server renders
 * to the visitor as "Brave API responded 422" — a complaint about a URL we
 * built. So an unrecognised code is answered with the default rather than
 * passed on. That also makes the footer's <option> list free to drift from
 * lib/lang.ts without breaking a search: the worst case is English.
 */
function readLang(value: unknown): string {
  const code = asString(value).trim();
  return isLanguage(code) ? code : DEFAULT_LANG;
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
  const offset = readOffset(req.query.offset);
  const lang = readLang(req.query.lang);

  if (!q) {
    const body: SearchApiResponse = { query: "", results: [] };
    res.json(body);
    return;
  }

  // Resolved from the in-memory index — synchronous, so the prices ride along
  // on this response instead of costing a second round trip.
  //
  // First page only. The price card answers the query, and the query does not
  // change as someone scrolls — repeating it forty results down would be a
  // second answer to a question already answered, on a response whose whole
  // point is to be small.
  const tokens = offset === 0 ? lookupTokens(q) : [];

  try {
    const body = await braveSearch(q, offset, lang);
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
  const lang = readLang(req.query.lang);

  if (!q) {
    const body: ImageSearchApiResponse = { query: "", images: [] };
    res.json(body);
    return;
  }

  try {
    res.json(await braveImageSearch(q, lang));
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
 * Whether a sent transaction has landed, for a wallet that broadcast it itself.
 *
 * POST for the same reason as the two routes around it: a signature names a
 * wallet as surely as its address does.
 */
apiRouter.post(
  "/api/tx",
  txLimit,
  readJson,
  wrap(async (req: Request, res: Response) => {
    const signature = asString(req.body?.signature).trim();
    if (!isSignature(signature)) {
      res.status(400).json({ error: "Invalid signature." });
      return;
    }
    try {
      res.json(await signatureStatus(signature));
    } catch (err) {
      console.warn("[tx] status lookup failed:", err);
      res.status(502).json({ error: "Could not read the transaction." });
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
    const range = asString(req.body?.range) || "24h";

    if (!isPubkey(owner)) {
      const body: HoldingsApiResponse = { error: "Invalid wallet address." };
      res.status(400).json(body);
      return;
    }
    if (!isChartRange(range)) {
      const body: HoldingsApiResponse = { error: "No such range." };
      res.status(400).json(body);
      return;
    }

    try {
      res.json(await fetchHoldings(owner, range));
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

/**
 * A page of one wallet's history: sends, receipts and swaps, newest first.
 *
 * POST, and as public, for the reasons /api/holdings is: the address stays
 * out of the request log, and everything returned is on-chain data any
 * explorer shows for any address. `after` is the last page's cursor.
 */
apiRouter.post(
  "/api/history",
  historyLimit,
  readJson,
  wrap(async (req: Request, res: Response) => {
    const owner = asString(req.body?.owner).trim();
    const after = asString(req.body?.after);

    if (!isPubkey(owner)) {
      const body: HistoryApiResponse = { error: "Invalid wallet address." };
      res.status(400).json(body);
      return;
    }
    if (after && !/^[\w:.=+/-]{1,256}$/.test(after)) {
      const body: HistoryApiResponse = { error: "No such page." };
      res.status(400).json(body);
      return;
    }

    let page: HistoryPage;
    try {
      page = await fetchHistory(owner, after);
    } catch (err) {
      if (err instanceof BadCursor) {
        const body: HistoryApiResponse = { error: "No such page." };
        res.status(400).json(body);
        return;
      }
      console.warn("[history] lookup failed:", err);
      // As with holdings: a failed read must never pass for an empty history.
      const body: HistoryApiResponse = {
        error: "Could not read this wallet's history.",
        ...(process.env.NODE_ENV === "production"
          ? {}
          : { detail: err instanceof Error ? err.message : String(err) }),
      };
      res.status(502).json(body);
      return;
    }

    // Who's who among the other ends, where they are accounts here. A name is
    // a nicety: without the database the addresses still stand.
    const peers = [...new Set(page.items.map((i) => i.peer).filter((p): p is string => !!p))];
    let names = new Map<string, string>();
    try {
      names = await namesOf(peers);
    } catch (err) {
      console.warn("[history] names unavailable:", err instanceof Error ? err.message : err);
    }
    const body: HistoryApiResponse = {
      ...page,
      items: page.items.map((i) => {
        const peerName = i.peer && names.get(i.peer);
        return peerName ? { ...i, peerName } : i;
      }),
    };
    res.json(body);
  }),
);

/**
 * What each holding cost, on average, for the wallet page to read each
 * position's profit against, worked on from the basis the page kept from its
 * last ask when it sends one. POST, and as public, for the reasons
 * /api/holdings is.
 */
apiRouter.post(
  "/api/entries",
  entriesLimit,
  readBasisBody,
  wrap(async (req: Request, res: Response) => {
    const owner = asString(req.body?.owner).trim();
    if (!isPubkey(owner)) {
      const body: EntriesApiResponse = { error: "Invalid wallet address." };
      res.status(400).json(body);
      return;
    }
    try {
      // A basis that is not one is a walk from scratch, not a refusal.
      const body: EntriesApiResponse = await fetchEntries(owner, readBasis(req.body?.basis));
      res.json(body);
    } catch (err) {
      console.warn("[entries] lookup failed:", err);
      // No entries at all, rather than an empty set the page would take for a wallet with none.
      const body: EntriesApiResponse = {
        error: "Could not read what this wallet paid.",
        ...(process.env.NODE_ENV === "production"
          ? {}
          : { detail: err instanceof Error ? err.message : String(err) }),
      };
      res.status(502).json(body);
    }
  }),
);

/**
 * What the chain says about mints the index does not carry: the wallet page's
 * unidentified tokens. POST, though nothing here is private on its own: the
 * set of spam one wallet was sent is enough to pick that wallet out.
 */
apiRouter.post(
  "/api/assets",
  assetsLimit,
  readList,
  wrap(async (req: Request, res: Response) => {
    const raw: unknown = req.body?.mints;
    const mints = Array.isArray(raw) ? [...new Set(raw.map(asString))] : [];
    if (!mints.length || mints.length > MAX_ASSETS || !mints.every(isPubkey)) {
      const body: AssetsApiResponse = { error: "Invalid token list." };
      res.status(400).json(body);
      return;
    }
    try {
      const body: AssetsApiResponse = { assets: await fetchAssets(mints) };
      res.json(body);
    } catch (err) {
      console.warn("[assets] lookup failed:", err);
      const body: AssetsApiResponse = {
        error: "Could not read these tokens.",
        ...(process.env.NODE_ENV === "production"
          ? {}
          : { detail: err instanceof Error ? err.message : String(err) }),
      };
      res.status(502).json(body);
    }
  }),
);

/** The same list for everyone, read from memory, so it may be cached for a minute. */
apiRouter.get("/api/tokens/top", (_req: Request, res: Response) => {
  res.setHeader("Cache-Control", "public, max-age=60");
  res.json({ tokens: topTokens(TOKEN_TOP_COUNT) });
});

/**
 * The wallet page's lists (`c`, Trending when absent), a page at a time from
 * `after`; or with `q`, a search of the whole index. Memory only; nothing
 * upstream is asked.
 */
apiRouter.get("/api/tokens", searchLimit, (req: Request, res: Response) => {
  const q = asString(req.query.q).slice(0, 64);
  if (q.trim()) {
    res.setHeader("Cache-Control", "public, max-age=60");
    res.json({ tokens: searchTokens(q, TOKEN_TOP_COUNT) });
    return;
  }
  const key = asString(req.query.c) || "trending";
  if (!isTokenList(key)) {
    res.status(400).json({ error: "No such list." });
    return;
  }
  const after = asString(req.query.after).slice(0, 128);
  const page: TokenPage = listTokens(key, after, TOKEN_TOP_COUNT);
  if (!after) page.counts = listCounts();
  res.setHeader("Cache-Control", "public, max-age=60");
  res.json(page);
});

/** A timeline page names at most 20 posts' three tickers. */
const MAX_QUOTES = 60;

/**
 * The prices now of the tickers posts call out (`m`, mints joined by commas),
 * for their cards: one request per page of posts. Memory only; a stale mint is
 * refreshed behind the answer, for whoever asks next.
 */
apiRouter.get("/api/quotes", searchLimit, (req: Request, res: Response) => {
  const mints = asString(req.query.m).split(",").filter(isPubkey);
  if (!mints.length || mints.length > MAX_QUOTES) {
    res.status(400).json({ error: "Invalid mints." });
    return;
  }
  res.setHeader("Cache-Control", "public, max-age=30");
  res.json({ tokens: quoteMints(mints) });
});

/** A 256-character draft names at most this many tickers worth asking about. */
const MAX_DRAFT_TICKERS = 20;

/**
 * The composer's preview of a draft's ticker cards (`t`, its tickers joined by
 * commas, never its words): resolved exactly as posting will resolve them,
 * with each card's quote now, and the mint each ticker went to, which is what
 * the composer colours.
 */
apiRouter.get("/api/callouts", searchLimit, (req: Request, res: Response) => {
  const tickers = asString(req.query.t).split(",").filter(isTicker);
  if (!tickers.length || tickers.length > MAX_DRAFT_TICKERS) {
    res.status(400).json({ error: "Invalid tickers." });
    return;
  }
  const { calls, named } = resolveTickers(tickers);
  res.setHeader("Cache-Control", "public, max-age=30");
  res.json({ tokens: quoteMints(calls.map((c) => c.mint)), named });
});

/** Every row click on the wallet page is one of these; each mint reaches Jupiter at most every 30 s. */
const detailLimit = rateLimit({ perMinute: 120, burst: 40 });

apiRouter.get(
  "/api/tokens/:mint",
  detailLimit,
  wrap(async (req: Request, res: Response) => {
    const mint = req.params.mint;
    if (!isPubkey(mint)) {
      res.status(400).json({ error: "Invalid mint." });
      return;
    }
    const detail = await tokenDetail(mint);
    if (!detail) {
      res.status(404).json({ error: "We don't index that token." });
      return;
    }
    res.setHeader("Cache-Control", "public, max-age=30");
    res.json(detail);
  }),
);

/**
 * A chart's range other than 24h, which every quote already carries. Each
 * mint and range reaches Jupiter at most once a minute, shared by everyone;
 * the bucket is for whoever clicks through every range of every token.
 */
const chartLimit = rateLimit({ perMinute: 120, burst: 40 });

apiRouter.get(
  "/api/tokens/:mint/chart",
  chartLimit,
  wrap(async (req: Request, res: Response) => {
    const mint = req.params.mint;
    const range = asString(req.query.r);
    if (!isPubkey(mint) || !isChartRange(range)) {
      res.status(400).json({ error: "Invalid chart." });
      return;
    }
    const rec = lookupMints([mint]).get(mint);
    if (!rec) {
      res.status(404).json({ error: "We don't index that token." });
      return;
    }
    const series = await priceSeries(rec, range);
    if (!series) {
      res.status(503).json({ error: "No price history for this range right now." });
      return;
    }
    res.setHeader("Cache-Control", "public, max-age=60");
    res.json(series);
  }),
);

/** Legacy /search?q= → SPA query string. */
apiRouter.get("/search", (req: Request, res: Response) => {
  const q = asString(req.query.q).trim();
  res.redirect(302, q ? `/?q=${encodeURIComponent(q)}` : "/");
});
