import { Request, Response, Router } from "express";
import { fetchBalances, isPubkey } from "../lib/balances";
import { BraveApiError, braveImageSearch, braveSearch } from "../lib/brave";
import { lookupTokens } from "../lib/tokens/store";
import {
  BalancesApiResponse,
  ImageSearchApiResponse,
  SearchApiResponse,
} from "../types";

export const apiRouter = Router();

function apiError(err: unknown, query: string) {
  const message =
    err instanceof BraveApiError
      ? err.message
      : "Unexpected error while searching.";
  const status = err instanceof BraveApiError ? 502 : 500;
  return { message, status, query };
}

/** JSON web search API for client-side hydration. */
apiRouter.get("/api/search", async (req: Request, res: Response) => {
  const q = String(req.query.q ?? "").trim();

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
});

/** JSON image search API (Brave Images endpoint). */
apiRouter.get("/api/images", async (req: Request, res: Response) => {
  const q = String(req.query.q ?? "").trim();

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
});

/**
 * Fundable balances for one wallet. Read-only and scoped to two mints — it
 * exists so the browser never needs our RPC credentials.
 */
apiRouter.get("/api/balances", async (req: Request, res: Response) => {
  const owner = String(req.query.owner ?? "").trim();
  const mint = String(req.query.mint ?? "").trim();

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
});

/** Legacy /search?q= → SPA query string. */
apiRouter.get("/search", (req: Request, res: Response) => {
  const q = String(req.query.q ?? "").trim();
  res.redirect(302, q ? `/?q=${encodeURIComponent(q)}` : "/");
});
