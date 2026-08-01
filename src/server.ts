import compression from "compression";
import express from "express";
import { readFileSync, watch } from "fs";
import path from "path";
import { BRAVE_API_KEY, HELIUS_RPC_URL, PORT } from "./config";
import { startTokenIndex } from "./lib/tokens/store";
import { renderHomeTicker } from "./lib/tokens/ticker";
import { apiRouter } from "./routes/api";

const app = express();
const publicDir = path.join(__dirname, "..", "public");
const indexPath = path.join(publicDir, "index.html");

/** Slot in the built shell that the price strip is injected into. */
const TICKER_SLOT = '<div id="hm-tk"></div>';

/**
 * The shell is held in memory and re-read only when it changes on disk, so
 * serving a page costs no filesystem syscall — just one string replace.
 */
let shell = "";

function loadShell() {
  try {
    shell = readFileSync(indexPath, "utf8");
  } catch {
    // Client not built yet; the request handler falls back to sendFile.
    shell = "";
  }
}

loadShell();
try {
  // Picks up client rebuilds in dev without polling on the request path.
  watch(indexPath, { persistent: false }, loadShell);
} catch {
  // Watch is best-effort — a missing file just means we fall back.
}

// gzip/brotli-negotiated compression — bandwidth budget is measured gzip.
app.use(compression());

// Built SPA assets (HTML/CSS/JS).
// HTML must not be cached long — it carries ?v= content hashes for CSS/JS.
// CSS/JS can be cached; new deploys change the query string in index.html.
app.use(
  express.static(publicDir, {
    index: false, // never serve cached index via static; use the handler below
    maxAge: process.env.NODE_ENV === "production" ? "7d" : 0,
    etag: true,
    setHeaders(res, filePath) {
      if (filePath.endsWith(`${path.sep}index.html`) || filePath.endsWith("/index.html")) {
        res.setHeader("Cache-Control", "no-cache");
      }
    },
  }),
);

app.use(apiRouter);

function sendIndex(res: express.Response, next: express.NextFunction) {
  res.setHeader("Cache-Control", "no-cache");

  if (!shell) {
    res.sendFile(indexPath, (err) => {
      if (err) next(err);
    });
    return;
  }

  // Prices ride along in the shell itself — no second request, and they paint
  // before app.js has even been fetched.
  res
    .type("html")
    .send(
      shell.replace(TICKER_SLOT, `<div id="hm-tk">${renderHomeTicker()}</div>`),
    );
}

app.get("/", (_req, res, next) => sendIndex(res, next));

// SPA deep-links: unknown non-API GETs fall back to the shell.
app.get("*", (req, res, next) => {
  if (req.path.startsWith("/api")) return next();
  sendIndex(res, next);
});

app.listen(PORT, () => {
  console.log(`utopian-go demo running at http://localhost:${PORT}`);
  if (!BRAVE_API_KEY) {
    console.log("Set BRAVE_API_KEY env var to get live results.");
  }
  if (!HELIUS_RPC_URL) {
    console.log("Set HELIUS_RPC_URL env var for live token price refresh.");
  }
  startTokenIndex();
});
