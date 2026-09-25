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
import { iconFile } from "./lib/tokens/icons";
import { startTokenIndex } from "./lib/tokens/store";
import { renderFundPrices, renderHomeTicker } from "./lib/tokens/ticker";
import { apiRouter } from "./routes/api";
import { ensureSchema } from "./social/db";
import { sendAvatar, sendPostPhoto, socialRouter } from "./social/routes";

const app = express();
const publicDir = path.join(__dirname, "..", "public");
const indexPath = path.join(publicDir, "index.html");

/**
 * The wallet page's canonical URL, and the file behind it.
 *
 * Extensionless, so it reads as a page rather than as a download, and mapped
 * onto the built file by a rewrite rather than by a handler of its own. That
 * rewrite happens before the precompressed-sibling middleware below, so the
 * page is served straight out of the build's quality-11 brotli — no template,
 * no per-request compression, and no in-memory copy for this process to hold.
 *
 * It can be a plain file precisely because the server does not know whose
 * wallet it is: there is no cookie and no session, the address lives in the
 * browser, and every figure on the page is fetched by the bundle afterwards.
 */
const WALLET_PATH = "/wallet";
const WALLET_FILE = "/wallet.html";

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

/** Root-relative social card URL, absolutised against SITE_URL at boot. */
const OG_SLOT = 'property="og:image" content="/og.png"';

/**
 * Attribute-value escape.
 *
 * `$` is escaped alongside the four HTML characters because every caller feeds
 * the result to String.prototype.replace, whose *replacement string* reads
 * `$&`, `` $` ``, `$'` and `$$` as substitution patterns — expanded by the
 * engine after this function has run, so they can smuggle in characters it
 * never saw. `$&` alone expands to the matched slot text, and every slot here
 * contains a double quote: enough to close the attribute the value is supposed
 * to be trapped inside and let the rest of it be parsed as markup.
 *
 * `replaceSlot` below already passes a function replacer, which disables that
 * expansion outright. This is the second lock on the same door: the two are
 * independent, and either one alone closes the hole.
 */
function attr(value: string): string {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/\$/g, "&#36;");
}

/**
 * Substitute one slot in the shell, with `$` expansion disabled.
 *
 * A function replacer is handed to `replace` verbatim — no `$&` / `` $` `` /
 * `$'` interpretation — so the replacement means exactly what it says however
 * the value was built. Use this for every slot, not only the ones carrying
 * user input: the difference between a safe slot and an unsafe one is not
 * something the next edit should have to rediscover.
 */
function replaceSlot(html: string, slot: string, value: string): string {
  return html.replace(slot, () => value);
}

/**
 * Longest query reflected into the shell.
 *
 * Not a validation rule — the search itself takes whatever is typed, and
 * matchTokens applies its own 48-character limit. This bounds one specific
 * cost: the shell is brotli'd at quality 11 on the request thread, and the
 * `res` variant's cache slot is keyed on the rendered HTML, so a query nobody
 * has sent before pays that compression in full. Capping the reflected copy
 * keeps the work per request flat no matter how long a URL someone constructs.
 * Longer queries still search; only the value pre-filled into the field is
 * clipped, and nothing at this length was going to be read out of it anyway.
 */
const MAX_REFLECTED_QUERY = 256;

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

/**
 * Brotli quality per variant, which is really a question of who pays.
 *
 * `home` renders identically for everyone until a price moves, so its one cache
 * slot answers essentially every home request — quality 11 is paid about once
 * per price TTL and amortises to nothing. That is the number the build's budget
 * is measured against, so the home page keeps the ratio the budget assumes.
 *
 * `res` carries the query in its markup, so a query nobody has sent before is a
 * cache miss by construction: an anonymous caller picks how often this runs
 * simply by varying ?q=. On this shell, measured:
 *
 *   quality 11 → 5,144 B in 14.90 ms
 *   quality  5 → 5,689 B in  0.19 ms
 *
 * 545 bytes against 78x the CPU, on a synchronous call holding the only thread
 * this process has. Eight concurrent connections varying the query were enough
 * to push an unrelated static request from 1.5 ms to ~250 ms — which starves
 * /api/balances mid-swap and the rate limiter along with it, since neither can
 * be scheduled while brotli holds the loop. The bytes are the cheaper thing to
 * give up, and a results page is already waiting on a search round trip.
 */
const QUALITY: Record<Variant, number> = { home: 11, res: 5 };

/** Compress at the ratio the build's budget assumes, not compression()'s q4. */
function encode(raw: Buffer, enc: "br" | "gzip", quality: number): Buffer {
  if (enc === "gzip") return gzipSync(raw, { level: 9 });
  return brotliCompressSync(raw, {
    params: {
      [constants.BROTLI_PARAM_QUALITY]: quality,
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
  const out = encode(Buffer.from(html, "utf8"), enc, QUALITY[variant]);
  entry[enc] = out;
  return out;
}

function loadShell() {
  try {
    shell = readFileSync(indexPath, "utf8");
    // Referral config is deploy-time constant, so it is baked in here rather
    // than repeated on every quote in every search response.
    if (JUP_FEE_ACCOUNT_SOL || JUP_FEE_ACCOUNT_USDC) {
      shell = replaceSlot(
        shell,
        REF_SLOT,
        `data-fa-sol="${attr(JUP_FEE_ACCOUNT_SOL)}"` +
          ` data-fa-usdc="${attr(JUP_FEE_ACCOUNT_USDC)}"` +
          ` data-fee="${JUP_FEE_BPS}"`,
      );
    }
    // Same reasoning: the origin is deploy-time constant, so the card URL is
    // resolved once here rather than per request off the Host header.
    if (SITE_URL) {
      shell = replaceSlot(
        shell,
        OG_SLOT,
        `property="og:image" content="${attr(SITE_URL)}/og.png"`,
      );
    }
    resShell = buildResShell(shell);
  } catch (err) {
    // Client not built yet; the request handler falls back to sendFile.
    //
    // Said out loud rather than swallowed. The fallback is quiet by design and
    // indistinguishable from a healthy server at a glance — the page still
    // paints, and every static asset it names is still there — but what it
    // serves is the *unrendered* shell: no price strip, no fund prices for the
    // trade dialog to convert its dollars with, no referral accounts, and
    // `class="home"` on results URLs. On an unbuilt tree that is expected and
    // this line is the answer to "why is the page bare"; mid-run it means a
    // read lost a race with the build replacing the file, and without the line
    // there is nothing at all to connect a missing ticker strip to its cause.
    console.warn("[shell] load failed — serving the unrendered shell:", err);
    shell = "";
    resShell = "";
  }
}

loadShell();
try {
  // Picks up client rebuilds in dev without polling on the request path.
  //
  // The directory, not the file. A build does not write index.html in place, it
  // replaces it — and a watch bound to the file follows the old inode, so after
  // the first rebuild it is watching something nobody will ever write to again.
  // That is what turns one unlucky read during the swap into a permanent
  // condition: the shell latches empty, and the event that would have refilled
  // it can no longer arrive. The directory's own inode survives the swap, so
  // every subsequent write is another chance to recover.
  //
  // The .br/.gz siblings are written just after index.html itself and match the
  // prefix on purpose. Re-reading a file that has not changed costs one 20 KB
  // read, and those events land once the document is fully in place — which is
  // exactly the moment a read that lost the race would now succeed.
  watch(publicDir, { persistent: false }, (_event, filename) => {
    if (!filename || path.basename(String(filename)).startsWith("index.html")) {
      loadShell();
    }
  });
} catch {
  // Watch is best-effort — a missing directory just means we fall back.
}

/**
 * Content-Security-Policy, written against what the page actually loads.
 *
 * Every directive here is a claim about this site, not a template:
 *
 *  - `script-src 'self'` — the shell carries no inline script (the build emits
 *    one `<script src>`, and the buy panel is loaded by setting `.src`), so
 *    inline execution can be forbidden outright. That is what makes an
 *    injected event-handler attribute inert rather than fatal, which matters
 *    more here than on most sites: script in this origin can rewrite the swap
 *    dialog around a connected wallet.
 *  - `style-src 'unsafe-inline'` — the build inlines app.css into the shell to
 *    keep first paint inside one round trip, and swap/ui.js injects the dialog's
 *    stylesheet as a `<style>` element. Both are ours, and neither can be
 *    hashed without giving up the inlining.
 *  - `img-src https:` — results carry thumbnails from Brave and from whatever
 *    publisher a result points at. The host set is the open web, so it cannot
 *    be enumerated; `data:` covers wallet icons, which arrive as data URIs.
 *    `blob:` is only the post composer's preview of a picture this page just
 *    compressed. That address is created here; markup cannot name one.
 *  - `connect-src` — /api/* on this origin, plus Jupiter's keyless swap API,
 *    which the browser calls directly for quotes and to build a transaction.
 *  - `base-uri 'none'` — without it, one injected `<base>` tag repoints every
 *    relative script URL, including /app.js and the swap bundle.
 *  - `frame-ancestors 'none'` — nothing embeds this, and a framed page that can
 *    reach a wallet-signing flow is a clickjacking target.
 */
const CSP = [
  "default-src 'self'",
  "script-src 'self'",
  "style-src 'self' 'unsafe-inline'",
  "img-src 'self' blob: data: https:",
  "connect-src 'self' https://lite-api.jup.ag",
  "font-src 'self'",
  "form-action 'self'",
  "frame-ancestors 'none'",
  "base-uri 'none'",
  "object-src 'none'",
].join("; ");

/**
 * Railway terminates TLS in front of us, so the protocol and the client IP are
 * only knowable from its forwarding headers. Trusting exactly one hop is what
 * makes `req.protocol` and `req.ip` mean what they say — the rate limiter keys
 * on the latter, and would otherwise bucket the entire internet under the
 * proxy's address.
 */
app.set("trust proxy", 1);

app.use((req, res, next) => {
  res.setHeader("Content-Security-Policy", CSP);
  // frame-ancestors covers modern browsers; this covers the rest.
  res.setHeader("X-Frame-Options", "DENY");
  res.setHeader("X-Content-Type-Options", "nosniff");
  // The query is in the URL, so the default of sending the full path to
  // same-origin destinations is fine — but no result site, and no image host a
  // result pulls from, has any business learning what was searched for.
  res.setHeader("Referrer-Policy", "strict-origin-when-cross-origin");
  res.setHeader("Permissions-Policy", "geolocation=(), camera=(), microphone=(), payment=()");
  if (req.secure) {
    res.setHeader(
      "Strict-Transport-Security",
      "max-age=31536000; includeSubDomains",
    );
  }
  next();
});

/**
 * URL canonicalisation, ahead of everything that reads the URL.
 *
 * Ordering is the whole point. The precompressed-sibling middleware below
 * rewrites `req.url` to point at a `.br` or `.gz` file, and a route matching on
 * the original path would never fire afterwards — so both redirects and the
 * `/wallet` rewrite have to be settled first, while the URL still says what the
 * visitor asked for.
 */
app.get("/index.html", (req, res) => {
  const qs = req.originalUrl.slice(req.path.length);
  res.redirect(308, `/${qs}`);
});

// One address for the page. `/wallet.html` would otherwise be served directly
// by express.static, giving the same document two URLs to drift between.
app.get(WALLET_FILE, (req, res) => {
  const qs = req.originalUrl.slice(req.path.length);
  res.redirect(308, `${WALLET_PATH}${qs}`);
});

app.get(WALLET_PATH, (req, _res, next) => {
  // express.static and the precompressed lookup both read the path off
  // req.url, so pointing it at the built file is all this takes.
  req.url = WALLET_FILE + req.originalUrl.slice(req.path.length);
  next();
});

/**
 * Social is one static document, same as the wallet page.
 *
 * Timeline, friends and a profile are the same file. The script reads the
 * path, and who is logged in lives in a cookie, so the HTML never varies and
 * can be handed out precompressed. Avatars and post pictures are the
 * exception: they are bytes on disk, and they have to be answered before the
 * rewrite below turns every other /social URL into that document.
 */
app.get("/social.html", (req, res) => {
  const qs = req.originalUrl.slice(req.path.length);
  res.redirect(308, `/social${qs}`);
});

app.get("/icon/:mint", (req, res) => {
  const file = iconFile(req.params.mint);
  if (!file) {
    res.status(404).type("text").send("Not found.");
    return;
  }
  res.setHeader("Cache-Control", "public, max-age=86400");
  res.type("webp").sendFile(file);
});

app.get("/social/a/:name", sendAvatar);
app.get("/social/t/:name", sendAvatar);
app.get("/social/i/:id/:n", sendPostPhoto);

app.use((req, _res, next) => {
  if (req.method !== "GET" && req.method !== "HEAD") return next();
  const p = req.path;
  if (p !== "/social" && !p.startsWith("/social/")) return next();
  if (p.startsWith("/social/a/") || p.startsWith("/social/t/") || p.startsWith("/social/i/")) return next();
  req.url = "/social.html" + req.originalUrl.slice(p.length);
  next();
});

// Negotiated compression for everything generated per request (API JSON).
// Static assets are served precompressed below, and the shell brings its own.
app.use(compression());

/**
 * Extensions the build writes .br/.gz siblings for. Sync with build-client.mjs.
 *
 * `.html` is here for the wallet page, which is a plain file. The shell is not
 * reachable through this path at all — `/` is answered by sendIndex and
 * `/index.html` is redirected above — so the only document that can match is
 * one the build actually precompressed.
 */
const PRECOMPRESSED_EXT = new Set([".js", ".css", ".svg", ".html"]);

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

/**
 * `/index.html` is the shell's other name, and must render like it.
 *
 * `index: false` below stops express.static answering `/` with the file, but an
 * explicit request for `/index.html` still matches it directly — and that file
 * is the *unrendered* shell: no price strip, no fund prices, and no referral
 * accounts, so a swap started from that URL earns nothing and the confirmation
 * screen has no prices to state dollars with. Redirected rather than rendered,
 * so the two URLs cannot drift and there is one canonical address for the page.
 */

// Built SPA assets. The stylesheet is inlined in the shell, so what is left
// here is JS and images. HTML must not be cached long — it carries the ?v=
// content hashes; JS can be, since a deploy changes those query strings.
app.use(
  express.static(publicDir, {
    index: false, // never serve cached index via static; use the handler below
    maxAge: process.env.NODE_ENV === "production" ? "7d" : 0,
    etag: true,
    setHeaders(res, filePath) {
      // Documents must revalidate. Both carry `?v=` content hashes for the
      // bundles they load, so a copy cached for a week goes on asking for the
      // build it was deployed with long after that build is gone — and for the
      // wallet page that means a working document quietly fetching two 404s.
      // JS and images are safe to cache hard precisely because a deploy changes
      // those query strings.
      // The precompressed lookup above rewrites req.url to a `.br`/`.gz`
      // sibling, so what arrives here is `wallet.html.br` rather than
      // `wallet.html`. Matching the bare name alone silently missed every
      // compressed response — which is every real one.
      const name = path.basename(filePath).replace(/\.(br|gz)$/, "");
      if (name === "index.html" || name === "wallet.html" || name === "social.html") {
        res.setHeader("Cache-Control", "no-cache");
      }
    },
  }),
);

app.use("/api/social", socialRouter);
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
  const raw = typeof req.query.q === "string" ? req.query.q.trim() : "";
  // slice() counts UTF-16 units, so a cut can land between the two halves of an
  // astral character — an emoji, or most of CJK's extensions — and leave a lone
  // high surrogate that encodes as U+FFFD. Drop it: a clipped query should end
  // one character early, not with a replacement glyph in the search box.
  const q = raw.slice(0, MAX_REFLECTED_QUERY).replace(/[\uD800-\uDBFF]$/, "");
  const variant: Variant = q ? "res" : "home";

  // Prices ride along in the shell itself — no second request, and they paint
  // before app.js has even been fetched. Rendered on both variants: the strip
  // is display:none off the home class, and clicking the wordmark home is a
  // client-side transition that never asks the server for fresh markup.
  // The strip carries the quote tokens' USD prices as well as its own cells —
  // the buy dialog converts with them, and they are already here.
  let html = replaceSlot(
    variant === "res" ? resShell : shell,
    TICKER_SLOT,
    `<div id="hm-tk"${renderFundPrices()}>${renderHomeTicker()}</div>`,
  );
  if (variant === "res") {
    html = replaceSlot(html, INPUT_SLOT, `${INPUT_SLOT} value="${attr(q)}"`);
  }

  const enc = negotiate(req);
  res.setHeader("Vary", "Accept-Encoding");
  if (enc) res.setHeader("Content-Encoding", enc);
  // no-cache means revalidate, not don't-store: an unchanged strip answers 304
  // off the ETag and the inlined stylesheet costs a repeat visitor nothing.
  res.type("html").send(shellBody(variant, html, enc));
}

app.get("/", (req, res, next) => sendIndex(req, res, next));

/**
 * Liveness probe.
 *
 * Deliberately not a readiness probe: it reports that the process is up and
 * answering, not that the token index is warm. The site serves search and the
 * whole shell without an index, so gating traffic on one would refuse requests
 * this app can perfectly well answer.
 */
app.get("/healthz", (_req, res) => {
  res.type("text").send("ok");
});

// SPA deep-links: unknown non-API GETs fall back to the shell.
app.get("*", (req, res, next) => {
  if (req.path.startsWith("/api")) return next();
  sendIndex(req, res, next);
});

/**
 * Unmatched /api routes answer JSON, not Express's HTML error page.
 *
 * Everything under /api is consumed by `fetch` and parsed as JSON, so an HTML
 * body is read by the client as a parse error rather than as the 404 it is —
 * the caller learns "something broke" instead of "no such endpoint".
 */
app.use("/api", (_req, res) => {
  res.status(404).json({ error: "Not found." });
});

/**
 * Last-resort error handler.
 *
 * Express only routes here what it catches, which is sync throws and explicit
 * next(err) — async rejections never arrive (see lib/query.ts for the one that
 * mattered). Its job is to make sure that whatever does arrive leaves as the
 * right content type and without a stack trace: the default handler prints one
 * into the response body outside production, and this server's own error paths
 * are all JSON.
 */
app.use((err: unknown, req: express.Request, res: express.Response, _next: express.NextFunction) => {
  console.error(`[error] ${req.method} ${req.path}:`, err);
  if (res.headersSent) return;
  if (req.path.startsWith("/api")) {
    res.status(500).json({ error: "Unexpected error." });
    return;
  }
  res.status(500).type("text").send("Something went wrong.");
});

const server = app.listen(PORT, () => {
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

// Social's tables, made ready ahead of the first request. Search never waits
// on this; if the database is down, only /api/social answers 503.
ensureSchema().catch((err) => console.error("[social] database:", err));

/**
 * Idle-connection timeouts, ordered against the proxy in front of us.
 *
 * Railway keeps upstream connections pooled. If it reuses one at the same
 * moment Node decides that connection has been idle too long, the request goes
 * out onto a socket that is already closing and the visitor gets a 502 that
 * nothing in this process ever sees. The fix is ordering, not duration: our
 * keep-alive must outlive the proxy's, so the proxy is always the side that
 * retires a connection. 65s is the usual number for exactly this reason, and
 * headersTimeout must exceed it or it becomes the earlier deadline instead.
 */
server.keepAliveTimeout = 65_000;
server.headersTimeout = 70_000;

/**
 * Shut down on the signal Railway actually sends.
 *
 * A redeploy SIGTERMs the old container while requests are still in flight, and
 * with no handler Node exits within ~90ms — measured — cutting live responses
 * mid-body. `server.close` stops accepting new connections and lets the ones in
 * progress finish, which is the difference between a deploy nobody notices and
 * a burst of truncated searches and failed balance lookups.
 *
 * The timer is the backstop: a keep-alive connection can hold close() open
 * indefinitely, and a deploy that hangs is worse than one that drops a straggler.
 * It is unref'd so it never itself keeps the process alive.
 */
let shuttingDown = false;

function shutdown(signal: string) {
  if (shuttingDown) return;
  shuttingDown = true;
  console.log(`[shutdown] ${signal} received; finishing in-flight requests`);

  const force = setTimeout(() => {
    console.warn("[shutdown] timed out; exiting with requests still open");
    process.exit(1);
  }, 10_000);
  force.unref();

  server.close((err) => {
    if (err) {
      console.error("[shutdown] close failed:", err);
      process.exit(1);
    }
    console.log("[shutdown] clean");
    process.exit(0);
  });
  // Idle keep-alive sockets are not "in flight" and would otherwise hold the
  // close open for the full grace period on every deploy.
  server.closeIdleConnections?.();
}

process.on("SIGTERM", () => shutdown("SIGTERM"));
process.on("SIGINT", () => shutdown("SIGINT"));

/**
 * Last line of defence for a single-process app.
 *
 * Node's default for an unhandled rejection is to terminate, so without this a
 * bug on any one request path takes the whole site down silently — the operator
 * gets a container restart and no explanation. Logging and staying up is the
 * right trade here: this process holds no cross-request state that a stray
 * rejection can corrupt, and every route already answers its own errors.
 *
 * An uncaught exception is a different bet. The process may genuinely be in an
 * unknown state, so it is logged and then handed to the same graceful path —
 * finish what is in flight, then let the platform restart us clean.
 */
process.on("unhandledRejection", (reason) => {
  console.error("[fatal] unhandled rejection:", reason);
});

process.on("uncaughtException", (err) => {
  console.error("[fatal] uncaught exception:", err);
  shutdown("uncaughtException");
});
