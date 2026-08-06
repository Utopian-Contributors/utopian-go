import compression from "compression";
import express from "express";
import { existsSync, readFileSync, watch } from "fs";
import path from "path";
import { brotliCompressSync, constants, gzipSync } from "zlib";
import {
  BRAVE_API_KEY,
  HELIUS_RPC_URL,
  JUP_FEE_ACCOUNT_SOL,
  JUP_FEE_ACCOUNT_USDC,
  JUP_FEE_BPS,
  PORT,
  SITE_URL,
} from "./config";
import { startTokenIndex } from "./lib/tokens/store";
import { renderHomeTicker } from "./lib/tokens/ticker";
import { apiRouter } from "./routes/api";

const app = express();
const publicDir = path.join(__dirname, "..", "public");
const indexPath = path.join(publicDir, "index.html");

// Nothing downstream reads it, and it is bytes on every response — including
// the ones that have to fit an initial congestion window.
app.disable("x-powered-by");

/** Slot in the built shell that the price strip is injected into. */
const TICKER_SLOT = '<div id="hm-tk"></div>';

/** Slot carrying the swap fee account to the client. */
const REF_SLOT = 'data-fa=""';

/** Root-relative social card URL, absolutised at boot when SITE_URL is set. */
const OG_SLOT = 'property="og:image" content="/og.webp"';

/** Attribute-value escape. The value is operator-supplied via env. */
function attr(value: string): string {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

/**
 * The shell is held in memory and re-read only when it changes on disk, so
 * serving a page costs no filesystem syscall — just one string replace.
 */
let shell = "";

/**
 * The rendered shell, compressed once per distinct rendering.
 *
 * The document only changes when the price strip does — at most once per price
 * TTL — so compressing per request would spend CPU rederiving identical bytes.
 * Keyed on the rendered HTML itself: when prices move the string differs and
 * the entry is replaced, which needs no invalidation hook in the token store.
 */
let encodedShell: { html: string; br?: Buffer; gzip?: Buffer } = { html: "" };

/**
 * Is this encoding acceptable to the client? Handles the `q=0` form, which
 * means "explicitly not this one" rather than the absence the name suggests.
 */
function accepts(header: string, enc: string): boolean {
  return header.split(",").some((part) => {
    const [name, ...params] = part.trim().split(";");
    if (name.toLowerCase() !== enc) return false;
    return !params.some((p) => p.replace(/\s+/g, "") === "q=0");
  });
}

/** Best encoding we can serve this client, or null to send it plain. */
function negotiate(req: express.Request): "br" | "gzip" | null {
  const header = String(req.headers["accept-encoding"] ?? "");
  if (accepts(header, "br")) return "br";
  if (accepts(header, "gzip")) return "gzip";
  return null;
}

/** Compress at the ratio the build's budget assumes, not compression()'s q4. */
function encode(raw: Buffer, enc: "br" | "gzip"): Buffer {
  if (enc === "gzip") return gzipSync(raw, { level: 9 });
  return brotliCompressSync(raw, {
    params: {
      [constants.BROTLI_PARAM_QUALITY]: 11,
      [constants.BROTLI_PARAM_SIZE_HINT]: raw.length,
    },
  });
}

function shellBody(html: string, enc: "br" | "gzip" | null): string | Buffer {
  if (!enc) return html;
  if (encodedShell.html !== html) encodedShell = { html };
  const cached = encodedShell[enc];
  if (cached) return cached;
  const out = encode(Buffer.from(html, "utf8"), enc);
  encodedShell[enc] = out;
  return out;
}

function loadShell() {
  try {
    shell = readFileSync(indexPath, "utf8");
    // Referral config is deploy-time constant, so it is baked in here rather
    // than repeated on every quote in every search response.
    if (JUP_FEE_ACCOUNT_SOL || JUP_FEE_ACCOUNT_USDC) {
      shell = shell.replace(
        REF_SLOT,
        `data-fa-sol="${attr(JUP_FEE_ACCOUNT_SOL)}"` +
          ` data-fa-usdc="${attr(JUP_FEE_ACCOUNT_USDC)}"` +
          ` data-fee="${JUP_FEE_BPS}"`,
      );
    }
    // Same reasoning: the origin is deploy-time constant, so the card URL is
    // resolved once here rather than per request off the Host header.
    if (SITE_URL) {
      shell = shell.replace(
        OG_SLOT,
        `property="og:image" content="${attr(SITE_URL)}/og.webp"`,
      );
    }
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

// Negotiated compression for everything generated per request (API JSON).
// Static assets are served precompressed below, and the shell brings its own.
app.use(compression());

/** Extensions the build writes .br/.gz siblings for. Sync with build-client.mjs. */
const PRECOMPRESSED_EXT = new Set([".js", ".css", ".svg"]);

/**
 * Hand over the build's precompressed files rather than compressing per request.
 *
 * compression() negotiates brotli and then compresses at quality 4 — the value
 * it hardcodes — which on this project's assets is not reliably better than
 * gzip -9. The build already emitted quality-11 siblings, so serve those: a
 * better ratio, no per-request CPU, and the sizes the build reports become the
 * sizes that actually go on the wire.
 */
app.use((req, res, next) => {
  if (req.method !== "GET" && req.method !== "HEAD") return next();
  const ext = path.extname(req.path).toLowerCase();
  if (!PRECOMPRESSED_EXT.has(ext)) return next();

  const enc = negotiate(req);
  if (!enc) return next();

  const sibling = req.path + (enc === "br" ? ".br" : ".gz");
  const file = path.join(publicDir, sibling);
  // req.path arrives percent-decoded, so a traversal attempt survives the join.
  if (!file.startsWith(publicDir + path.sep) || !existsSync(file)) return next();

  res.setHeader("Content-Encoding", enc);
  res.setHeader("Vary", "Accept-Encoding");
  // Set before handing off: send() only guesses a Content-Type when none is
  // present, so this keeps it from typing the response off the .br/.gz suffix.
  res.type(ext);
  // express.static reads the path off req.url, so point it at the sibling.
  req.url = sibling;
  next();
});

// Built SPA assets. The stylesheet is inlined in the shell, so what is left
// here is JS and images. HTML must not be cached long — it carries the ?v=
// content hashes; JS can be, since a deploy changes those query strings.
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

function sendIndex(
  req: express.Request,
  res: express.Response,
  next: express.NextFunction,
) {
  res.setHeader("Cache-Control", "no-cache");

  if (!shell) {
    res.sendFile(indexPath, (err) => {
      if (err) next(err);
    });
    return;
  }

  // Prices ride along in the shell itself — no second request, and they paint
  // before app.js has even been fetched.
  const html = shell.replace(
    TICKER_SLOT,
    `<div id="hm-tk">${renderHomeTicker()}</div>`,
  );

  const enc = negotiate(req);
  res.setHeader("Vary", "Accept-Encoding");
  if (enc) res.setHeader("Content-Encoding", enc);
  // no-cache means revalidate, not don't-store: an unchanged strip answers 304
  // off the ETag and the inlined stylesheet costs a repeat visitor nothing.
  res.type("html").send(shellBody(html, enc));
}

app.get("/", (req, res, next) => sendIndex(req, res, next));

// SPA deep-links: unknown non-API GETs fall back to the shell.
app.get("*", (req, res, next) => {
  if (req.path.startsWith("/api")) return next();
  sendIndex(req, res, next);
});

app.listen(PORT, () => {
  console.log(`utopian-go demo running at http://localhost:${PORT}`);
  if (!BRAVE_API_KEY) {
    console.log("Set BRAVE_API_KEY env var to get live results.");
  }
  if (!HELIUS_RPC_URL) {
    console.log("Set HELIUS_RPC_URL env var for live token price refresh.");
  }
  const sides = [
    JUP_FEE_ACCOUNT_SOL && "SOL",
    JUP_FEE_ACCOUNT_USDC && "USDC",
  ].filter(Boolean);
  if (!sides.length) {
    console.log(
      "Set JUP_FEE_ACCOUNT_SOL / JUP_FEE_ACCOUNT_USDC (referral token accounts " +
        "from https://referral.jup.ag) to earn on swaps; trading works either way.",
    );
  } else {
    console.log(
      `[swap] fees at ${JUP_FEE_BPS} bps on ${sides.join(" + ")} side(s)`,
    );
  }
  startTokenIndex();
});
