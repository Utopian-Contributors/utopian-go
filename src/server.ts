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
import { renderFundPrices, renderHomeTicker } from "./lib/tokens/ticker";
import { apiRouter } from "./routes/api";

const app = express();
const publicDir = path.join(__dirname, "..", "public");
const indexPath = path.join(publicDir, "index.html");

// Nothing downstream reads it, and it is bytes on every response — including
// the ones that have to fit an initial congestion window.
app.disable("x-powered-by");

/** Slot in the built shell that the price strip is injected into. */
const TICKER_SLOT = '<div id="hm-tk"></div>';

/**
 * The body class the shell ships with, and what a query swaps it for.
 *
 * Every layout rule in app.css hangs off one of these two, so whichever the
 * page needs has to be in the document itself. app.js setting it is a round
 * trip too late: the header would paint in one geometry and jump to another.
 */
const HOME_SLOT = 'class="home"';
// `ld` is what app.js adds while a search is in flight: spinner in place of the
// arrow, tabs dimmed. Neither affects layout, but without it the shell paints
// the idle chrome and flips to loading a round trip later.
const RES_CLASS = 'class="res ld"';

/** Anchor for the query, so the field is filled at first paint. */
const INPUT_SLOT = 'id="q"';

/**
 * Elements the shell hides for the empty-field case, which a results URL is
 * not. Leaving them hidden let app.js reveal them a round trip later, and the
 * clear button and its divider take 49px out of the field's width when they
 * arrive — the query text reflows mid-read.
 */
const EMPTY_FIELD_ONLY = ['id="cl"', 'class="sf-sep"'];

/**
 * Drop the `hidden` attribute from the tag carrying `anchor`.
 *
 * Warns rather than throws: a shell that shifts is worse than one that does
 * not, but it still serves, and taking the site down over it would be a poor
 * trade. The build's collapseBooleanAttributes is what keeps `hidden`
 * spelled one way for this to find.
 */
function unhide(html: string, anchor: string): string {
  const escaped = anchor.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const tag = new RegExp(`(<[a-z]+[^>]*${escaped}[^>]*?)\\s+hidden(="[^"]*")?([^>]*>)`, "i");
  if (!tag.test(html)) {
    console.warn(`[shell] nothing hidden at ${anchor}; results pages may shift`);
    return html;
  }
  return html.replace(tag, "$1$3");
}

/**
 * The results-page shell, derived once from the home one at load.
 *
 * Only the query varies per request, so everything structural about the
 * variant is settled here rather than on the request path.
 */
function buildResShell(base: string): string {
  return EMPTY_FIELD_ONLY.reduce(unhide, base.replace(HOME_SLOT, RES_CLASS));
}

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

/** Same shell, pre-adjusted for a results URL. Derived in loadShell. */
let resShell = "";

type Variant = "home" | "res";

/**
 * The rendered shell, compressed once per variant per distinct rendering.
 *
 * A given variant only changes when the price strip does — at most once per
 * price TTL — so compressing per request would spend CPU rederiving identical
 * bytes. Keyed on the rendered HTML itself, so a price move replaces the entry
 * with no invalidation hook in the token store. One slot per variant, so
 * alternating home and results traffic doesn't evict on every request.
 *
 * Results pages carry the query in the markup, so only the home variant is
 * cacheable across requests; `res` still saves the repeat hit on one query.
 */
const encodedShell: Record<
  Variant,
  { html: string; br?: Buffer; gzip?: Buffer }
> = { home: { html: "" }, res: { html: "" } };

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

function shellBody(
  variant: Variant,
  html: string,
  enc: "br" | "gzip" | null,
): string | Buffer {
  if (!enc) return html;
  let entry = encodedShell[variant];
  if (entry.html !== html) entry = encodedShell[variant] = { html };
  const cached = entry[enc];
  if (cached) return cached;
  const out = encode(Buffer.from(html, "utf8"), enc);
  entry[enc] = out;
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
    resShell = buildResShell(shell);
  } catch {
    // Client not built yet; the request handler falls back to sendFile.
    shell = "";
    resShell = "";
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

  // A query means this URL renders as a results page. Saying so in the markup
  // is what lets it paint in its final geometry: the shell already carries the
  // loading chrome, and the variant is what shows it.
  const q = typeof req.query.q === "string" ? req.query.q.trim() : "";
  const variant: Variant = q ? "res" : "home";

  // Prices ride along in the shell itself — no second request, and they paint
  // before app.js has even been fetched. Rendered on both variants: the strip
  // is display:none off the home class, and clicking the wordmark home is a
  // client-side transition that never asks the server for fresh markup.
  // The strip carries the quote tokens' USD prices as well as its own cells —
  // the buy dialog converts with them, and they are already here.
  let html = (variant === "res" ? resShell : shell).replace(
    TICKER_SLOT,
    `<div id="hm-tk"${renderFundPrices()}>${renderHomeTicker()}</div>`,
  );
  if (variant === "res") {
    html = html.replace(INPUT_SLOT, `${INPUT_SLOT} value="${attr(q)}"`);
  }

  const enc = negotiate(req);
  res.setHeader("Vary", "Accept-Encoding");
  if (enc) res.setHeader("Content-Encoding", enc);
  // no-cache means revalidate, not don't-store: an unchanged strip answers 304
  // off the ETag and the inlined stylesheet costs a repeat visitor nothing.
  res.type("html").send(shellBody(variant, html, enc));
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
