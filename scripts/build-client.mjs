#!/usr/bin/env node
/**
 * Client build pipeline: readable source → minified public/
 *
 *   1. Bundle + minify JS with esbuild
 *   2. Minify CSS with lightningcss (esbuild fallback)
 *   3. Inline the CSS and the wordmark into the HTML, minify with html-minifier
 *   4. Copy static images
 *   5. Precompress everything the server serves compressed
 *   6. Report the budget against a TCP initial window
 *
 * Budget strategy (see brand.md):
 *   Only a document has to fit the *initial* window. Everything else is
 *   requested after the HTML has been parsed — and therefore after it has been
 *   ACKed — so it rides either a second connection with its own fresh window
 *   (HTTP/1.1) or one that slow start has already grown past ten segments
 *   (HTTP/2). Summing a document with its subresources measures a flight that
 *   never happens; each gets its own budget instead.
 *
 *   There are three documents. The search shell is one; the wallet page is a
 *   second, with its own stylesheet and its own bundle, because it shares
 *   almost nothing with search and serving it app.css to use a tenth of it
 *   would cost more than the whole page weighs. Social is a third, for the
 *   same reason, and its document is capped at 14KB gzip.
 */
import * as esbuild from "esbuild";
import { minify as minifyHtml } from "html-minifier-terser";
import { renderPdf } from "./legal-pdf.mjs";
import { createHash } from "crypto";
import {
  copyFileSync,
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
  watch as fsWatch,
} from "fs";
import { brotliCompressSync, constants, gzipSync } from "zlib";
import path from "path";
import { fileURLToPath } from "url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const root = path.join(__dirname, "..");
const clientDir = path.join(root, "client");
const outDir = path.join(root, "public");

/**
 * One TCP initial congestion window: 10 segments × 1460 B MSS (RFC 6928).
 * This much leaves the server before it has to wait for an ACK.
 */
const INIT_WINDOW = 14_600;

/**
 * The part of that window that is not ours to spend.
 *
 * HEADER_RESERVE — HTTP/1.1 response headers go on the wire uncompressed:
 * Date, ETag, Content-Type, Content-Encoding, Content-Length, Cache-Control,
 * Vary, Connection, Keep-Alive. ~300 B on this server's responses, rounded up.
 * HTTP/2 squeezes these with HPACK; budget the worse case.
 *
 * TICKER_RESERVE — the shell measured here still has an empty price strip.
 * renderHomeTicker fills it per request with three cells, and renderFundPrices
 * hangs the quote tokens' USD prices off the same tag for the buy dialog to
 * convert with: ~250 B raw and under 60 B once it compresses against the rest
 * of the document. Reserved with slack so a build that passes here also passes
 * on the wire.
 */
const HEADER_RESERVE = 350;
const TICKER_RESERVE = 300;

/**
 * What any one first-flight response may weigh.
 *
 * Derived rather than picked. A document goes out on a cold connection and gets
 * the whole ten segments; a bundle discovered while parsing that document goes
 * out on a connection whose window has already grown past ten (HTTP/2, after
 * the document was ACKed) or on a second connection with a fresh ten
 * (HTTP/1.1). Both land in one flight under the same ceiling, so both are
 * measured against the same number.
 *
 * app.js used to carry a hardcoded 8,192 here, inherited from an older model
 * that summed every asset into a single flight and therefore had to ration the
 * window between them. That model is gone — see the strategy note at the top —
 * but the number outlived it and had become a ceiling with no physics behind
 * it. The parse-weight guardrails below are what actually bound how much code
 * a page may carry; this bounds what it costs to deliver.
 */
const FLIGHT = INIT_WINDOW - HEADER_RESERVE;

/**
 * The pages, each with the document that must paint off the first flight and
 * the bundles that ride the second one.
 *
 * `raw` is a soft guardrail on parse and compile cost, not on transfer — a
 * budget that gzip alone cannot express, since the cheapest bytes to send are
 * often the most repetitive ones to parse.
 */
const PAGES = [
  {
    name: "Search",
    doc: {
      file: "index.html",
      // Less the strip the server injects per request; see TICKER_RESERVE.
      gzip: FLIGHT - TICKER_RESERVE,
      raw: 49_152, // soft: inlined CSS is cheap to parse, but not free
    },
    parallel: [{ file: "app.js", gzip: FLIGHT, raw: 24_576 }],
  },
  {
    name: "Wallet",
    doc: { file: "wallet.html", gzip: FLIGHT, raw: 32_768 },
    parallel: [{ file: "wallet.js", gzip: FLIGHT, raw: 16_384 }],
  },
  {
    name: "Social",
    // Same results layout as search, so the document inlines that stylesheet.
    // The 14KB cap is the gzip load. Raw is the parse weight, as on search.
    doc: { file: "social.html", gzip: Math.min(FLIGHT, 14 * 1024), raw: 49_152 },
    parallel: [{ file: "social.js", gzip: FLIGHT, raw: 24_576 }],
  },
];

/**
 * Fetched on interaction, never on first paint. Reported, not budgeted: the
 * buy panel only loads once someone presses Buy and the wallet picker only
 * once someone presses Login, so counting either against a first-load window
 * would be measuring bytes nobody waits for. The install panel is the one
 * that arrives unasked, but only on a phone, and only after load; the rail
 * is its opposite, only on a wide screen, and only after the timeline is drawn.
 */
const LAZY = ["swap.js", "connect.js", "qr.js", "keys.js", "chat.js", "rec.js", "rail.js", "avatar.js", "login.js", "hive.js", "install.js"];

/**
 * The legal documents: readable HTML under client/legal/, published as the
 * PDFs the footer links to. Source name → built file and /Title.
 */
const LEGAL = [
  { src: "terms.html", out: "terms.pdf", title: "Utopian Contributors LLC — Terms of Service" },
  { src: "privacy.html", out: "privacy.pdf", title: "Utopian Contributors LLC — Privacy Policy" },
];

/**
 * What a document may weigh.
 *
 * Not a first-load budget — nobody fetches these until they click the footer,
 * by which point the connection's window has long since grown past ten
 * segments. It is a ceiling on drift: the base-14 fonts are what keep these
 * near 5 KB, and anything that quietly starts embedding a face would land here
 * an order of magnitude heavier.
 */
const LEGAL_MAX = 14_336;

/**
 * Requested on first load but never render-blocking, and already compressed as
 * far as they go. Listed so the accounting is honest about total first-load
 * bytes, not budgeted, since no paint waits on them.
 *
 * The two banners are one line item between them, not two. They are the home
 * page's wordmark by day and by night, declared as a prefers-color-scheme pair
 * of background images in app.css, so a visitor fetches exactly one of them —
 * and only on the home page, where the mark is large enough to carry a scene.
 *
 * The favicons are the same kind of pair: a browser that takes SVG icons
 * fetches the SVG, which follows the theme, and only the rest fetch the PNG.
 *
 * The service worker is registered after load, and Chromium reads the
 * manifest on its own schedule to decide whether to offer an install. The app
 * icons the manifest names are not listed: only installing fetches them.
 */
const STATIC_FIRST_LOAD = [
  "go-favicon.svg",
  "go-favicon.png",
  "banner-light.webp",
  "banner-dark.webp",
  "sw.js",
  "manifest.webmanifest",
];

/** Copied from client/ as they are: images, and the web app manifest. */
const STATIC_EXT = new Set([".png", ".svg", ".ico", ".webp", ".jpg", ".jpeg", ".webmanifest"]);

/**
 * Extensions the server looks for a precompressed sibling of. Kept in sync
 * with PRECOMPRESSED_EXT in src/server.ts.
 */
const PRECOMPRESS_EXT = new Set([".js", ".css", ".svg"]);

/**
 * Documents precompressed by name rather than by extension.
 *
 * index.html is deliberately absent: it is never served as a file. The server
 * holds it in memory, renders the price strip and the body class into it per
 * request, and compresses the result itself — a .br sibling of the unrendered
 * shell would be a copy with no prices and no referral accounts sitting in
 * public/ waiting for something to serve it by mistake. The wallet page has no
 * per-request content at all, so for it the file *is* the response.
 */
const PRECOMPRESS_HTML = ["wallet.html", "social.html"];

const watch = process.argv.includes("--watch");

mkdirSync(outDir, { recursive: true });

const jsOpts = {
  entryPoints: [path.join(clientDir, "js", "main.js")],
  outfile: path.join(outDir, "app.js"),
  bundle: true,
  minify: true,
  minifyWhitespace: true,
  minifyIdentifiers: true,
  minifySyntax: true,
  treeShaking: true,
  target: ["es2020"],
  format: "iife",
  legalComments: "none",
  logLevel: watch ? "error" : "info",
};

/** The buy panel, built as its own bundle so app.js never carries it. */
const swapOpts = {
  ...jsOpts,
  entryPoints: [path.join(clientDir, "swap", "main.js")],
  outfile: path.join(outDir, "swap.js"),
};

/**
 * The wallet picker. Its own bundle rather than part of app.js because most
 * visitors never press Login, and rather than part of swap.js because the
 * wallet page needs it without needing a quote engine.
 */
const connectOpts = {
  ...jsOpts,
  entryPoints: [path.join(clientDir, "connect", "main.js")],
  outfile: path.join(outDir, "connect.js"),
};

/**
 * The QR encoder. Its own bundle rather than part of swap.js because the code
 * only exists for the crossing a page cannot make by itself — a desktop screen
 * to a phone's camera — and everyone trading on the device they are already
 * holding never draws one. See client/qr/main.js.
 */
const qrOpts = {
  ...jsOpts,
  entryPoints: [path.join(clientDir, "qr", "main.js")],
  outfile: path.join(outDir, "qr.js"),
};

/** The wallet page's recovery-phrase dialog. */
const keysOpts = {
  ...jsOpts,
  entryPoints: [path.join(clientDir, "keys", "main.js")],
  outfile: path.join(outDir, "keys.js"),
};

/**
 * The Log in dialog, for search and the wallet page: fetched the first time
 * someone presses Log in. Social bundles the same module into social.js.
 */
const loginOpts = {
  ...jsOpts,
  entryPoints: [path.join(clientDir, "login", "main.js")],
  outfile: path.join(outDir, "login.js"),
};

/** Places, the honeycomb of links left search for: fetched on its button. */
const hiveOpts = {
  ...jsOpts,
  entryPoints: [path.join(clientDir, "hive", "main.js")],
  outfile: path.join(outDir, "hive.js"),
};

/** The install panel, fetched on phones only; see client/js/pwa.js. */
const installOpts = {
  ...jsOpts,
  entryPoints: [path.join(clientDir, "install", "main.js")],
  outfile: path.join(outDir, "install.js"),
};

/**
 * The service worker. At a fixed URL with no ?v=, unlike every other bundle:
 * the browser finds a new version by fetching this same address and comparing
 * bytes, and a worker's URL also sets how much of the site it controls.
 */
const swOpts = {
  ...jsOpts,
  entryPoints: [path.join(clientDir, "sw", "main.js")],
  outfile: path.join(outDir, "sw.js"),
};

/** The wallet page's own bundle. Shares helpers with app.js, not bytes. */
const walletOpts = {
  ...jsOpts,
  entryPoints: [path.join(clientDir, "wallet", "main.js")],
  outfile: path.join(outDir, "wallet.js"),
};

/** Messenger, fetched by social.js on /social/c only. */
const chatOpts = {
  ...jsOpts,
  entryPoints: [path.join(clientDir, "chat", "main.js")],
  outfile: path.join(outDir, "chat.js"),
};

/**
 * The voice memo recorder, fetched by social.js the first time someone
 * presses the composer's microphone. It brings its own few rules, so neither
 * the document nor social.js carries a dialog most visitors never open.
 */
const recOpts = {
  ...jsOpts,
  entryPoints: [path.join(clientDir, "rec", "main.js")],
  outfile: path.join(outDir, "rec.js"),
};

/**
 * The desktop timeline's right column, fetched by social.js only on a screen
 * wide enough to show it. It brings its own rules, as the recorder does, so
 * a phone pays nothing for a column it never draws.
 */
const railOpts = {
  ...jsOpts,
  entryPoints: [path.join(clientDir, "rail", "main.js")],
  outfile: path.join(outDir, "rail.js"),
};

/**
 * The background under a profile photo, fetched by social.js when someone
 * picks one. Its gradient is src/social/backdrop.ts, the same file the server
 * draws a new account's picture with, bundled across rather than copied.
 */
const avatarOpts = {
  ...jsOpts,
  entryPoints: [path.join(clientDir, "avatar", "main.js")],
  outfile: path.join(outDir, "avatar.js"),
};

/** Social's own bundle. It shares nothing with search or the wallet page. */
const socialOpts = {
  ...jsOpts,
  entryPoints: [path.join(clientDir, "social", "main.js")],
  outfile: path.join(outDir, "social.js"),
};

/**
 * Drop the selectors that name a class or id this page never writes.
 *
 * `names` is every word in the page's built bundle and markup, which is a
 * superset of the classes and ids it can produce: esbuild keeps string
 * literals intact, so a class assembled in code still appears as its parts.
 * Only top-level compounds are judged. Anything inside :not() or :has() is
 * left alone, so a rule is removed only when it provably cannot match.
 *
 * @param {Set<string>} names
 */
function pruneVisitor(names) {
  const possible = (selector) =>
    selector.every((c) => !((c.type === "class" || c.type === "id") && !names.has(c.name)));
  return {
    Rule: {
      style(rule) {
        const selectors = rule.value.selectors.filter(possible);
        if (!selectors.length) return [];
        // Untouched rules are not handed back: lightningcss cannot always
        // re-read a rule it serialised, and there is nothing to change.
        if (selectors.length === rule.value.selectors.length) return undefined;
        rule.value.selectors = selectors;
        return rule;
      },
    },
  };
}

/**
 * @param {string} source
 * @param {Set<string>} [names] prune to these class and id names
 * @returns {Promise<string>}
 */
async function minifyCss(source, names) {
  try {
    const { transform } = await import("lightningcss");
    const { code } = transform({
      filename: "app.css",
      code: Buffer.from(source),
      minify: true,
      targets: {
        chrome: 90 << 16,
        firefox: 90 << 16,
        safari: (14 << 16) | (1 << 8),
      },
      visitor: names ? pruneVisitor(names) : undefined,
    });
    return code.toString("utf8");
  } catch (err) {
    // Fallback if lightningcss native binary is unavailable. Said out loud,
    // because the fallback cannot prune and the page would silently grow.
    console.warn(`[css] lightningcss failed, using esbuild: ${err.message}`);
    const result = await esbuild.transform(source, {
      loader: "css",
      minify: true,
      target: ["chrome90", "firefox90", "safari14"],
    });
    return result.code;
  }
}

/** Short content hash for cache-busting query params. */
function contentHash(buf) {
  return createHash("sha256").update(buf).digest("hex").slice(0, 8);
}

/**
 * Substitute exactly one match, or fail the build.
 *
 * Every caller here is rewriting a tag that first paint depends on. A pattern
 * that quietly stops matching would ship a page that still works but costs the
 * round trip we removed — the kind of regression no test catches.
 */
function replaceOnce(source, pattern, value, what) {
  if (!pattern.test(source)) {
    throw new Error(`build: no ${what} to replace in index.html (${pattern})`);
  }
  return source.replace(pattern, () => value);
}

/**
 * Guard the two places the shell duplicates the client's own rendering.
 *
 * The shell ships the results-page loading chrome so a /?q= URL paints it a
 * round trip before app.js lands. That only buys anything while the shipped
 * markup and the markup the bundle renders are identical — the moment they
 * differ, the hand-off moves the page, which is exactly the shift the shipped
 * markup exists to prevent. Nothing at runtime would notice, so check here.
 */
function verifyLoadingChrome(html) {
  // Read as source, not imported: url.js is browser ESM in a CJS package, and
  // a build step has no business executing client code to look at a list.
  const urlSrc = readFileSync(path.join(clientDir, "js", "url.js"), "utf8");
  const tabs = urlSrc.match(/export const TABS[^=]*=\s*\[([\s\S]*?)\];/);
  if (!tabs) throw new Error("build: no TABS array found in client/js/url.js");

  const shipped = [
    ...html.matchAll(/<button type="button" class="tab[^"]*" disabled>([^<]+)<\/button>/g),
  ].map((m) => m[1]);
  const rendered = [
    ...tabs[1].matchAll(/\[\s*"[^"]*"\s*,\s*"([^"]*)"\s*\]/g),
  ].map((m) => m[1]);
  if (shipped.join("|") !== rendered.join("|")) {
    throw new Error(
      `build: the shell's tab bar ${JSON.stringify(shipped)} no longer matches ` +
        `TABS ${JSON.stringify(rendered)} in client/js/url.js — a results page ` +
        `would shift when render.js rebuilds the nav`,
    );
  }

  // dom.js reads WEB_SKEL out of #sk, so an empty one leaves it with nothing
  // to re-render after an images search.
  if (!/<div class="sk">/.test(html)) {
    throw new Error(
      "build: the shell has no skeleton blocks in #sk — dom.js sources " +
        "WEB_SKEL from there and would render an empty skeleton",
    );
  }
}

/**
 * The wordmark, as markup rather than a request.
 *
 * As an <img> it was a second round trip that the header's first paint waited
 * on; inlined it arrives with the document. Coordinates are rounded to 2 dp on
 * the way in — the source carries 4, which across a 55-unit viewBox drawn at
 * most 188 px wide is 0.017 px of precision at the very worst. The source file
 * keeps its full precision: scripts/og-image.mjs measures ink bounds off it.
 */
function inlineWordmark() {
  const svg = readFileSync(path.join(clientDir, "go-wordmark.svg"), "utf8")
    .replace(/-?\d*\.\d+/g, (n) => String(Number(Number(n).toFixed(2))))
    .replace(/\s+/g, " ")
    .replace(/>\s+</g, "><")
    // Implied by the HTML parser for inline SVG; only needed in an XML document.
    .replace(/\s*xmlns="[^"]*"/, "")
    .trim();

  // The enclosing <a> already carries the accessible name, so announcing the
  // mark again would just read the same words twice.
  return svg.replace(/^<svg /, '<svg class="lg-mark" aria-hidden="true" ');
}

/**
 * A page's stylesheet, plus the header's and the account control's.
 *
 * header.css and acct.css are appended to every page's sheet rather than
 * living in any one of them, because every page wears the same header and a
 * second copy of its rules is a second chance for it to look different
 * depending on where you are standing. It is also what lets the wallet page
 * have the search header without inlining the rest of app.css.
 * Concatenated at build time rather than fetched as a second file: it is a few
 * hundred bytes, and both stylesheets are inlined into their document anyway.
 *
 * @param {string} name page stylesheet under client/
 */
async function buildCss(name) {
  return minifyCss(
    readFileSync(path.join(clientDir, name), "utf8") +
      readFileSync(path.join(clientDir, "header.css"), "utf8") +
      readFileSync(path.join(clientDir, "acct.css"), "utf8"),
  );
}

/**
 * Social's sheet: the search sheet's layout, then its own rules, pruned.
 *
 * Social reuses the results layout — header, tabs, the two columns, the
 * panel, the footer — so it builds on app.css rather than keeping a copy that
 * would drift. Most of app.css is search's own (results, token card, images,
 * lightbox, the home banner), and inlining it would put about 3KB of gzip on
 * every social load for rules that cannot match. Pruning against what the
 * page actually writes keeps the one source and drops the dead weight. It
 * runs after social.js and chat.js are built, since those bundles are the
 * list of names. Messenger's rules ride in this document, not in its bundle:
 * a few hundred bytes of gzip, and no second request before it can paint.
 */
async function buildSocialCss() {
  const words = (text) => text.match(/[A-Za-z_][\w-]*/g) ?? [];
  const names = new Set([
    ...words(readFileSync(path.join(outDir, "social.js"), "utf8")),
    ...words(readFileSync(path.join(outDir, "chat.js"), "utf8")),
    ...words(readFileSync(path.join(clientDir, "social.html"), "utf8")),
  ]);
  return minifyCss(
    ["app.css", "header.css", "acct.css", "social.css"]
      .map((name) => readFileSync(path.join(clientDir, name), "utf8"))
      .join(""),
    names,
  );
}

async function buildHtml(css, jsHash, swapHash, connectHash, qrHash, loginHash, hiveHash, installHash) {
  let raw = readFileSync(path.join(clientDir, "index.html"), "utf8");
  verifyLoadingChrome(raw);

  // The stylesheet was the only render-blocking subresource, and the browser
  // could not even discover it until the HTML had been parsed — a guaranteed
  // round trip before first paint whatever the file weighed. Inlined, the
  // shell paints off the first flight with nothing else in hand.
  raw = replaceOnce(
    raw,
    /<link rel="stylesheet" href="\/app\.css"\s*\/?>/,
    `<style>${css}</style>`,
    "stylesheet link",
  );
  raw = replaceOnce(
    raw,
    /<img\b[^>]*class="lg-mark"[^>]*\/>/,
    inlineWordmark(),
    "wordmark img",
  );
  // Fingerprint asset URLs so browsers/CDNs fetch the new build after deploy.
  raw = replaceOnce(
    raw,
    /src="\/app\.js"/,
    `src="/app.js?v=${jsHash}"`,
    "app.js src",
  );
  // These are fetched by JS, not by a tag, so their hashes ride in attributes.
  raw = replaceOnce(
    raw,
    /data-sw="\/swap\.js"/,
    `data-sw="/swap.js?v=${swapHash}"`,
    "swap.js attribute",
  );
  raw = replaceOnce(
    raw,
    /data-cn="\/connect\.js"/,
    `data-cn="/connect.js?v=${connectHash}"`,
    "connect.js attribute",
  );
  raw = replaceOnce(
    raw,
    /data-qr="\/qr\.js"/,
    `data-qr="/qr.js?v=${qrHash}"`,
    "qr.js attribute",
  );
  raw = replaceOnce(
    raw,
    /data-lg="\/login\.js"/,
    `data-lg="/login.js?v=${loginHash}"`,
    "login.js attribute",
  );
  raw = replaceOnce(
    raw,
    /data-hv="\/hive\.js"/,
    `data-hv="/hive.js?v=${hiveHash}"`,
    "hive.js attribute",
  );
  raw = replaceOnce(
    raw,
    /data-pw="\/install\.js"/,
    `data-pw="/install.js?v=${installHash}"`,
    "install.js attribute",
  );

  writeFileSync(path.join(outDir, "index.html"), await minifyDoc(raw));
}

/** One HTML minifier configuration, so the two documents cannot drift. */
function minifyDoc(raw) {
  return minifyHtml(raw, {
    collapseWhitespace: true,
    removeComments: true,
    removeRedundantAttributes: true,
    removeScriptTypeAttributes: true,
    // Smaller, and it gives the server one spelling of `hidden`/`disabled` to
    // match when it adjusts the shell's initial state per request.
    collapseBooleanAttributes: true,
    removeStyleLinkTypeAttributes: true,
    // lightningcss already minified the inlined CSS against explicit browser
    // targets. Running clean-css over its output would only risk lowering
    // syntax it understands better than clean-css does.
    minifyCSS: false,
    minifyJS: true,
    // Keep quotes — safer for attribute values
    removeAttributeQuotes: false,
    useShortDoctype: true,
  });
}

/**
 * The wallet page, built the same way the shell is and for the same reason:
 * its stylesheet is inlined so the page paints off the first flight, and its
 * two bundle URLs are fingerprinted so a deploy cannot be served stale ones.
 *
 * Unlike the shell it is never rendered per request — it carries no
 * server-side state, because the server does not know whose wallet it is. That
 * is what lets it be a plain precompressed file rather than a template.
 */
async function buildWalletHtml(css, walletHash, connectHash, swapHash, qrHash, keysHash, loginHash, installHash) {
  let raw = readFileSync(path.join(clientDir, "wallet.html"), "utf8");

  raw = replaceOnce(
    raw,
    /<link rel="stylesheet" href="\/wallet\.css"\s*\/?>/,
    `<style>${css}</style>`,
    "wallet stylesheet link",
  );
  raw = replaceOnce(
    raw,
    /<img\b[^>]*class="lg-mark"[^>]*\/>/,
    inlineWordmark(),
    "wallet wordmark img",
  );
  raw = replaceOnce(
    raw,
    /src="\/wallet\.js"/,
    `src="/wallet.js?v=${walletHash}"`,
    "wallet.js src",
  );
  raw = replaceOnce(
    raw,
    /data-cn="\/connect\.js"/,
    `data-cn="/connect.js?v=${connectHash}"`,
    "wallet connect.js attribute",
  );
  // Positions carry buy and sell controls, so this page opens the same trade
  // dialog the price cards do.
  raw = replaceOnce(
    raw,
    /data-sw="\/swap\.js"/,
    `data-sw="/swap.js?v=${swapHash}"`,
    "wallet swap.js attribute",
  );
  raw = replaceOnce(
    raw,
    /data-qr="\/qr\.js"/,
    `data-qr="/qr.js?v=${qrHash}"`,
    "wallet qr.js attribute",
  );
  raw = replaceOnce(
    raw,
    /data-ks="\/keys\.js"/,
    `data-ks="/keys.js?v=${keysHash}"`,
    "wallet keys.js attribute",
  );
  raw = replaceOnce(
    raw,
    /data-lg="\/login\.js"/,
    `data-lg="/login.js?v=${loginHash}"`,
    "wallet login.js attribute",
  );
  raw = replaceOnce(
    raw,
    /data-pw="\/install\.js"/,
    `data-pw="/install.js?v=${installHash}"`,
    "wallet install.js attribute",
  );

  writeFileSync(path.join(outDir, "wallet.html"), await minifyDoc(raw));
}

/**
 * Social's document: its pruned sheet inlined (see buildSocialCss), and the
 * wordmark inlined for the same reason it is on the other two documents: the
 * header should not wait on a second request.
 */
async function buildSocialHtml(css, socialHash, qrHash, chatHash, recHash, railHash, avatarHash, installHash) {
  let raw = readFileSync(path.join(clientDir, "social.html"), "utf8");
  raw = replaceOnce(
    raw,
    /<link rel="stylesheet" href="\/social\.css"\s*\/?>/,
    `<style>${css}</style>`,
    "social stylesheet link",
  );
  raw = replaceOnce(
    raw,
    /<img\b[^>]*class="lg-mark"[^>]*\/>/,
    inlineWordmark(),
    "social wordmark img",
  );
  raw = replaceOnce(
    raw,
    /src="\/social\.js"/,
    `src="/social.js?v=${socialHash}"`,
    "social.js src",
  );
  raw = replaceOnce(
    raw,
    /data-qr="\/qr\.js"/,
    `data-qr="/qr.js?v=${qrHash}"`,
    "social qr.js attribute",
  );
  raw = replaceOnce(
    raw,
    /data-ch="\/chat\.js"/,
    `data-ch="/chat.js?v=${chatHash}"`,
    "social chat.js attribute",
  );
  raw = replaceOnce(
    raw,
    /data-rc="\/rec\.js"/,
    `data-rc="/rec.js?v=${recHash}"`,
    "social rec.js attribute",
  );
  raw = replaceOnce(
    raw,
    /data-rl="\/rail\.js"/,
    `data-rl="/rail.js?v=${railHash}"`,
    "social rail.js attribute",
  );
  raw = replaceOnce(
    raw,
    /data-av="\/avatar\.js"/,
    `data-av="/avatar.js?v=${avatarHash}"`,
    "social avatar.js attribute",
  );
  raw = replaceOnce(
    raw,
    /data-pw="\/install\.js"/,
    `data-pw="/install.js?v=${installHash}"`,
    "social install.js attribute",
  );
  writeFileSync(path.join(outDir, "social.html"), await minifyDoc(raw));
}

/** Typeset the legal documents into public/ as PDFs. */
function buildLegal() {
  for (const doc of LEGAL) {
    const src = path.join(clientDir, "legal", doc.src);
    if (!existsSync(src)) continue;
    writeFileSync(
      path.join(outDir, doc.out),
      renderPdf(readFileSync(src, "utf8"), doc.title),
    );
  }
}

/** Built documents, relative to public/. */
function legalFiles() {
  return LEGAL.map((d) => d.out).filter((f) => existsSync(path.join(outDir, f)));
}

function copyStatic() {
  for (const name of readdirSync(clientDir)) {
    const ext = path.extname(name).toLowerCase();
    if (!STATIC_EXT.has(ext)) continue;
    copyFileSync(path.join(clientDir, name), path.join(outDir, name));
  }
  // Both stylesheets live inside their document now; drop anything an older
  // build left behind, so nothing can be served a copy the page does not use.
  for (const base of ["app.css", "wallet.css"]) {
    for (const stale of [base, `${base}.br`, `${base}.gz`]) {
      rmSync(path.join(outDir, stale), { force: true });
    }
  }
}

function brotli(buf) {
  return brotliCompressSync(buf, {
    params: {
      [constants.BROTLI_PARAM_QUALITY]: 11,
      [constants.BROTLI_PARAM_SIZE_HINT]: buf.length,
    },
  });
}

function gzip(buf) {
  return gzipSync(buf, { level: 9 });
}

/**
 * Write .br/.gz siblings for everything the server serves compressed.
 *
 * Doing it here rather than per request is what makes the numbers below the
 * numbers that actually go on the wire: compression() negotiates brotli and
 * then hardcodes quality 4, which on this project's CSS came out *worse* than
 * gzip -9. Quality 11 costs nothing at build time and the server just hands
 * the bytes over.
 */
function precompress() {
  for (const name of readdirSync(outDir)) {
    const ext = path.extname(name).toLowerCase();
    if (!PRECOMPRESS_EXT.has(ext) && !PRECOMPRESS_HTML.includes(name)) continue;
    const buf = readFileSync(path.join(outDir, name));
    for (const [suffix, compress] of [[".br", brotli], [".gz", gzip]]) {
      const out = compress(buf);
      const dest = path.join(outDir, name + suffix);
      // A sibling larger than the source would only cost the client bytes.
      if (out.length < buf.length) writeFileSync(dest, out);
      else rmSync(dest, { force: true });
    }
  }
}

function fmt(n) {
  return String(n).padStart(6);
}

/** raw/gzip/brotli for one built file. */
function measure(file) {
  const buf = readFileSync(path.join(outDir, file));
  return { raw: buf.length, gzip: gzip(buf).length, br: brotli(buf).length };
}

function row(file, m, tag) {
  return (
    `  ${file.padEnd(17)} ${fmt(m.raw)} B  ` +
    `(gzip ${fmt(m.gzip)} B, br ${fmt(m.br)} B)` +
    (tag ? `  [${tag}]` : "")
  );
}

function reportSize() {
  /** @type {string[]} */
  const hard = [];
  /** @type {string[]} */
  const soft = [];

  /** Checks one entry against its budgets and returns its printable row. */
  function check(entry) {
    const m = measure(entry.file);
    const gOk = m.gzip <= entry.gzip;
    const rOk = m.raw <= entry.raw;
    if (!gOk) hard.push(`${entry.file} (${m.gzip} B gzip > ${entry.gzip} B)`);
    if (!rOk) soft.push(`${entry.file} (${m.raw} B raw > ${entry.raw} B)`);
    return { m, line: row(entry.file, m, !gOk ? "OVER" : !rOk ? "OVER raw" : "OK") };
  }

  console.log(
    `\nEvery first-flight response must fit one TCP initial window` +
      ` (${INIT_WINDOW} B = 10 ×\n` +
      `  1460 MSS, RFC 6928), less ${HEADER_RESERVE} B of response headers` +
      ` → ${FLIGHT} B each. A bundle\n` +
      `  is discovered only once its document has been parsed and therefore` +
      ` ACKed, so it\n` +
      `  rides a second connection's fresh window or a grown one — never the` +
      ` document's.`,
  );

  for (const page of PAGES) {
    if (!existsSync(path.join(outDir, page.doc.file))) continue;

    const doc = check(page.doc);
    const reserved =
      page.doc.gzip === FLIGHT
        ? ""
        : `, less ${FLIGHT - page.doc.gzip} B of server-injected markup`;
    console.log(`\n${page.name} — document (${page.doc.gzip} B${reserved}):`);
    console.log(doc.line);
    console.log(
      `  ${"headroom".padEnd(14)} ${fmt(page.doc.gzip - doc.m.gzip)} B gzip,` +
        ` ${fmt(page.doc.gzip - doc.m.br)} B brotli`,
    );

    const bundles = page.parallel.filter((e) =>
      existsSync(path.join(outDir, e.file)),
    );
    if (!bundles.length) continue;
    console.log(`  fetched in parallel, each budgeted alone:`);
    for (const entry of bundles) console.log(check(entry).line);
  }

  const statics = STATIC_FIRST_LOAD.filter((f) =>
    existsSync(path.join(outDir, f)),
  );
  if (statics.length) {
    console.log(`\nAlso on first load, but nothing waits on it:`);
    for (const file of statics) {
      console.log(row(file, measure(file), "not render-blocking"));
    }
  }

  const rows = LAZY.filter((f) => existsSync(path.join(outDir, f)));
  if (rows.length) {
    console.log(`\nLazy — fetched on interaction, outside any first-load budget:`);
    for (const file of rows) console.log(row(file, measure(file)));
  }

  const docs = legalFiles();
  if (docs.length) {
    console.log(
      `\nDocuments — PDFs the footer links to, fetched only when clicked, and` +
        ` already\n  compressed. Capped at ${LEGAL_MAX} B each:`,
    );
    for (const file of docs) {
      const m = measure(file);
      const ok = m.raw <= LEGAL_MAX;
      if (!ok) hard.push(`${file} (${m.raw} B > ${LEGAL_MAX} B)`);
      console.log(row(file, m, ok ? "OK" : "OVER"));
    }
  }

  if (hard.length) {
    const docs = PAGES.map((pg) => pg.doc.file);
    const overDoc = hard.filter((h) => docs.some((d) => h.startsWith(d)));
    console.log(`\n  ✗ Over budget: ${hard.join(", ")}`);
    console.log(
      `    ${overDoc.length === hard.length
        ? "A document no longer fits one initial window — every cold load of it\n" +
          "    pays an extra round trip before first paint."
        : "Trim before shipping."}\n`,
    );
    process.exitCode = 1;
    return;
  }

  if (soft.length) {
    console.log(`\n  ⚠ Raw guardrail exceeded (soft): ${soft.join(", ")}`);
    console.log(`    Compressed sizes are fine — prefer shrinking the source.\n`);
  }

  console.log(
    `\n  ✓ Every document paints off its first flight; no subresource blocks one.\n`,
  );
  process.exitCode = 0;
}

async function buildAssets() {
  copyStatic();
  // CSS and JS first: each document inlines a stylesheet and fingerprints the
  // bundles it names.
  const [, , , , , , , , , , , , , socialCss, css, walletCss] = await Promise.all([
    esbuild.build(installOpts),
    esbuild.build(swOpts),
    esbuild.build(jsOpts),
    esbuild.build(keysOpts),
    esbuild.build(loginOpts),
    esbuild.build(swapOpts),
    esbuild.build(connectOpts),
    esbuild.build(qrOpts),
    esbuild.build(hiveOpts),
    esbuild.build(walletOpts),
    esbuild.build(recOpts),
    esbuild.build(railOpts),
    esbuild.build(avatarOpts),
    Promise.all([esbuild.build(socialOpts), esbuild.build(chatOpts)]).then(buildSocialCss),
    buildCss("app.css"),
    buildCss("wallet.css"),
  ]);

  const hash = (file) => contentHash(readFileSync(path.join(outDir, file)));
  const connectHash = hash("connect.js");
  const swapHash = hash("swap.js");
  const qrHash = hash("qr.js");
  const loginHash = hash("login.js");
  const installHash = hash("install.js");

  await Promise.all([
    buildHtml(css, hash("app.js"), swapHash, connectHash, qrHash, loginHash, hash("hive.js"), installHash),
    buildWalletHtml(walletCss, hash("wallet.js"), connectHash, swapHash, qrHash, hash("keys.js"), loginHash, installHash),
    buildSocialHtml(socialCss, hash("social.js"), qrHash, hash("chat.js"), hash("rec.js"), hash("rail.js"), hash("avatar.js"), installHash),
  ]);
  buildLegal();
  precompress();
}

async function buildOnce() {
  await buildAssets();
  reportSize();
}

async function rebuildAll() {
  try {
    await buildAssets();
    reportSize();
  } catch (err) {
    console.error(err);
  }
}

if (watch) {
  // Initial build, then watch client/ for changes.
  await buildOnce();

  let timer = null;
  const schedule = () => {
    clearTimeout(timer);
    timer = setTimeout(rebuildAll, 40);
  };

  fsWatch(clientDir, { recursive: true }, (_event, filename) => {
    if (!filename) return;
    // Ignore editor swap/temp files
    if (filename.endsWith("~") || filename.endsWith(".swp")) return;
    console.log(`[watch] ${filename}`);
    schedule();
  });
  // The one source file a bundle takes from the server's side (see avatarOpts).
  fsWatch(path.join(root, "src", "social", "backdrop.ts"), () => {
    console.log("[watch] src/social/backdrop.ts");
    schedule();
  });

  console.log("Watching client/ …");
} else {
  await buildOnce();
}
