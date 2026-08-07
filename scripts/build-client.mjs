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
 *   Only the shell has to fit the *initial* window. Everything else is
 *   requested after the HTML has been parsed — and therefore after it has been
 *   ACKed — so it rides either a second connection with its own fresh window
 *   (HTTP/1.1) or one that slow start has already grown past ten segments
 *   (HTTP/2). Summing the shell with its subresources measures a flight that
 *   never happens; each gets its own budget instead.
 */
import * as esbuild from "esbuild";
import { minify as minifyHtml } from "html-minifier-terser";
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
 * renderHomeTicker fills it per request with three cells, ~200 B raw and ~100 B
 * once it compresses against the rest of the document. Reserved with slack so a
 * build that passes here also passes on the wire.
 */
const HEADER_RESERVE = 350;
const TICKER_RESERVE = 300;

/** What the shell may weigh compressed, and its parse-weight guardrail. */
const SHELL = {
  file: "index.html",
  gzip: INIT_WINDOW - HEADER_RESERVE - TICKER_RESERVE,
  raw: 49_152, // soft: inlined CSS is cheap to parse, but not free
};

/**
 * Fetched once the shell is parsed. Each rides its own initial window, so each
 * is checked alone — never summed against the shell.
 */
const PARALLEL = [
  { file: "app.js", gzip: 8_192, raw: 24_576 },
];

/**
 * Fetched on interaction, never on first paint. Reported, not budgeted: the
 * buy panel only loads once someone presses Buy, and counting it against a
 * first-load window would be measuring bytes nobody waits for.
 */
const LAZY = ["swap.js"];

/**
 * Where the static documents' source and built fragments live.
 *
 * They are fragments, not pages: src/server.ts renders each into the shell at
 * boot, so a document page reuses the shell's header and its inlined
 * stylesheet rather than carrying a second copy of either.
 */
const LEGAL_DIR = "legal";

/**
 * Requested on first load but never render-blocking, and already compressed as
 * far as they go. Listed so the accounting is honest about total first-load
 * bytes, not budgeted, since no paint waits on them.
 */
const STATIC_FIRST_LOAD = ["go-favicon.png"];

const STATIC_EXT = new Set([".png", ".svg", ".ico", ".webp", ".jpg", ".jpeg"]);

/**
 * Extensions the server looks for a precompressed sibling of. Kept in sync
 * with PRECOMPRESSED in src/server.ts.
 */
const PRECOMPRESS_EXT = new Set([".js", ".css", ".svg"]);

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

/** @returns {Promise<string>} */
async function minifyCss(source) {
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
    });
    return code.toString("utf8");
  } catch {
    // Fallback if lightningcss native binary is unavailable
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

async function buildCss() {
  const source = readFileSync(path.join(clientDir, "app.css"), "utf8");
  return minifyCss(source);
}

async function buildHtml(css, jsHash, swapHash) {
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
  // The panel is fetched by JS, not a tag, so its hash rides in an attribute.
  raw = replaceOnce(
    raw,
    /data-sw="\/swap\.js"/,
    `data-sw="/swap.js?v=${swapHash}"`,
    "swap.js attribute",
  );

  const min = await minifyHtml(raw, {
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

  // src/server.ts matches this exact string to render /terms and /privacy into
  // the shell. How it comes out is the minifier's decision, not the source's,
  // so check the built form — a miss serves those pages blank, and nothing at
  // runtime would notice.
  const docSlot = '<main id="dc" hidden></main>';
  if (!min.includes(docSlot)) {
    throw new Error(
      `build: the document slot did not survive minification as ${docSlot} — ` +
        `src/server.ts matches it verbatim and /terms would render empty`,
    );
  }

  writeFileSync(path.join(outDir, "index.html"), min);
}

/**
 * Minify the document fragments into public/legal/.
 *
 * No budget of their own: a document page is one flight like any other, but
 * nobody is waiting on a search when they open it, and truncating a legal
 * clause to save a round trip would be the wrong trade in both directions.
 * reportSize prints their weight so the accounting is still honest.
 */
async function buildLegal() {
  const src = path.join(clientDir, LEGAL_DIR);
  if (!existsSync(src)) return;
  const dest = path.join(outDir, LEGAL_DIR);
  mkdirSync(dest, { recursive: true });

  for (const name of readdirSync(src)) {
    if (path.extname(name).toLowerCase() !== ".html") continue;
    const min = await minifyHtml(readFileSync(path.join(src, name), "utf8"), {
      collapseWhitespace: true,
      removeComments: true,
      collapseBooleanAttributes: true,
      removeRedundantAttributes: true,
      removeAttributeQuotes: false,
    });
    writeFileSync(path.join(dest, name), min);
  }
}

/** Built document fragments, relative to public/. */
function legalFiles() {
  const dir = path.join(outDir, LEGAL_DIR);
  if (!existsSync(dir)) return [];
  return readdirSync(dir)
    .filter((n) => path.extname(n).toLowerCase() === ".html")
    .map((n) => `${LEGAL_DIR}/${n}`)
    .sort();
}

function copyStatic() {
  for (const name of readdirSync(clientDir)) {
    const ext = path.extname(name).toLowerCase();
    if (!STATIC_EXT.has(ext)) continue;
    copyFileSync(path.join(clientDir, name), path.join(outDir, name));
  }
  // The stylesheet lives in the shell now; drop any file an older build left.
  for (const stale of ["app.css", "app.css.br", "app.css.gz"]) {
    rmSync(path.join(outDir, stale), { force: true });
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
    if (!PRECOMPRESS_EXT.has(path.extname(name).toLowerCase())) continue;
    const buf = readFileSync(path.join(outDir, name));
    for (const [ext, compress] of [[".br", brotli], [".gz", gzip]]) {
      const out = compress(buf);
      const dest = path.join(outDir, name + ext);
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
    `  ${file.padEnd(14)} ${fmt(m.raw)} B  ` +
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

  const shell = check(SHELL);

  console.log(
    `\nShell — must fit one TCP initial window (${INIT_WINDOW} B = 10 × 1460 MSS,` +
      ` RFC 6928)\n` +
      `  less ${HEADER_RESERVE} B response headers and ${TICKER_RESERVE} B` +
      ` server-injected price strip → ${SHELL.gzip} B for the document:`,
  );
  console.log(shell.line);
  console.log(
    `  ${"headroom".padEnd(14)} ${fmt(SHELL.gzip - shell.m.gzip)} B gzip,` +
      ` ${fmt(SHELL.gzip - shell.m.br)} B brotli`,
  );

  console.log(
    `\nParallel — requested after the shell parses, so each gets its own` +
      ` window (HTTP/1.1: a\n` +
      `  second connection; HTTP/2: one slow start has already grown).` +
      ` Budgeted per file:`,
  );
  for (const entry of PARALLEL) console.log(check(entry).line);
  for (const file of STATIC_FIRST_LOAD) {
    if (!existsSync(path.join(outDir, file))) continue;
    console.log(row(file, measure(file), "not render-blocking"));
  }

  const rows = LAZY.filter((f) => existsSync(path.join(outDir, f)));
  if (rows.length) {
    console.log(`\nLazy — fetched on interaction, outside any first-load budget:`);
    for (const file of rows) console.log(row(file, measure(file)));
  }

  const docs = legalFiles();
  if (docs.length) {
    console.log(
      `\nDocuments — rendered into the shell at boot for /terms and /privacy.` +
        ` Reported,\n  not budgeted: nobody is waiting on a search behind one.`,
    );
    for (const file of docs) console.log(row(file, measure(file)));
  }

  if (hard.length) {
    console.log(`\n  ✗ Over budget: ${hard.join(", ")}`);
    console.log(
      `    ${hard.length === 1 && hard[0].startsWith("index.html")
        ? "The shell no longer fits one initial window — every cold load pays an\n" +
          "    extra round trip before first paint."
        : "Trim before shipping."}\n`,
    );
    process.exitCode = 1;
    return;
  }

  if (soft.length) {
    console.log(`\n  ⚠ Raw guardrail exceeded (soft): ${soft.join(", ")}`);
    console.log(`    Compressed sizes are fine — prefer shrinking the source.\n`);
  }

  console.log(`\n  ✓ Shell paints off the first flight; no subresource blocks it.\n`);
  process.exitCode = 0;
}

async function buildAssets() {
  copyStatic();
  // CSS and JS first: the shell inlines the one and fingerprints the other.
  const [, , css] = await Promise.all([
    esbuild.build(jsOpts),
    esbuild.build(swapOpts),
    buildCss(),
  ]);
  const jsHash = contentHash(readFileSync(path.join(outDir, "app.js")));
  const swapHash = contentHash(readFileSync(path.join(outDir, "swap.js")));
  await Promise.all([buildHtml(css, jsHash, swapHash), buildLegal()]);
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

  console.log("Watching client/ …");
} else {
  await buildOnce();
}
