#!/usr/bin/env node
/**
 * Client build pipeline: readable source → minified public/
 *
 *   1. Bundle + minify JS with esbuild
 *   2. Minify CSS with lightningcss (esbuild fallback)
 *   3. Minify HTML with html-minifier-terser
 *   4. Copy static images
 *   5. Report dual budget (gzip hard / raw soft) — per file, not sum
 *
 * Budget strategy (see brand.md):
 *   - HARD:  each file gzip  < GZIP_BUDGET  — real transfer with compression
 *   - SOFT:  each file raw   < RAW_BUDGET   — parse/cache weight guardrail
 *   Soft overage warns; hard overage fails the build (exit 1).
 */
import * as esbuild from "esbuild";
import { minify as minifyHtml } from "html-minifier-terser";
import { createHash } from "crypto";
import {
  copyFileSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  writeFileSync,
  watch as fsWatch,
} from "fs";
import { gzipSync } from "zlib";
import path from "path";
import { fileURLToPath } from "url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const root = path.join(__dirname, "..");
const clientDir = path.join(root, "client");
const outDir = path.join(root, "public");

/** Per-file network budget (bytes, gzip). Hard fail if any payload file exceeds. */
const GZIP_BUDGET = 8_192; // 8 KiB per file
/** Per-file artifact guardrail (bytes, uncompressed). Soft — warns only. */
const RAW_BUDGET = 20_480; // 20 KiB per file

const STATIC_EXT = new Set([".png", ".svg", ".ico", ".webp", ".jpg", ".jpeg"]);
const PAYLOAD = ["index.html", "app.css", "app.js"];
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

async function buildCss() {
  const source = readFileSync(path.join(clientDir, "app.css"), "utf8");
  const min = await minifyCss(source);
  writeFileSync(path.join(outDir, "app.css"), min);
  return contentHash(min);
}

async function buildHtml(cssHash, jsHash) {
  let raw = readFileSync(path.join(clientDir, "index.html"), "utf8");
  // Fingerprint asset URLs so browsers/CDNs fetch the new build after deploy.
  raw = raw
    .replace(
      /href="\/app\.css"/,
      `href="/app.css?v=${cssHash}"`,
    )
    .replace(
      /src="\/app\.js"/,
      `src="/app.js?v=${jsHash}"`,
    );
  const min = await minifyHtml(raw, {
    collapseWhitespace: true,
    removeComments: true,
    removeRedundantAttributes: true,
    removeScriptTypeAttributes: true,
    removeStyleLinkTypeAttributes: true,
    minifyCSS: true,
    minifyJS: true,
    // Keep quotes — safer for attribute values
    removeAttributeQuotes: false,
    useShortDoctype: true,
  });
  writeFileSync(path.join(outDir, "index.html"), min);
}

function copyStatic() {
  for (const name of readdirSync(clientDir)) {
    const ext = path.extname(name).toLowerCase();
    if (!STATIC_EXT.has(ext)) continue;
    copyFileSync(path.join(clientDir, name), path.join(outDir, name));
  }
}

function fmt(n) {
  return String(n).padStart(6);
}

function reportSize() {
  let rawTotal = 0;
  let gzipTotal = 0;
  /** @type {string[]} */
  const gzipOver = [];
  /** @type {string[]} */
  const rawOver = [];

  console.log(
    `\nClient payload (budget is per file — gzip <${GZIP_BUDGET} hard, raw <${RAW_BUDGET} soft):`,
  );
  for (const f of PAYLOAD) {
    const buf = readFileSync(path.join(outDir, f));
    const gz = gzipSync(buf, { level: 9 }).length;
    rawTotal += buf.length;
    gzipTotal += gz;

    const gOk = gz < GZIP_BUDGET;
    const rOk = buf.length < RAW_BUDGET;
    if (!gOk) gzipOver.push(f);
    if (!rOk) rawOver.push(f);

    const tag = !gOk ? "OVER gzip" : !rOk ? "OVER raw" : "OK";
    console.log(
      `  ${f.padEnd(12)} ${fmt(buf.length)} B  (gzip ${fmt(gz)} B)  [${tag}]`,
    );
  }

  console.log(
    `  ${"TOTAL".padEnd(12)} ${fmt(rawTotal)} B  (gzip ${fmt(gzipTotal)} B)  (info only)`,
  );

  if (gzipOver.length) {
    console.log(
      `\n  ✗ Gzip budget exceeded (per file, hard): ${gzipOver.join(", ")}`,
    );
    console.log(`    Limit ${GZIP_BUDGET} B gzip each. Trim those assets.\n`);
    process.exitCode = 1;
  } else if (rawOver.length) {
    console.log(
      `\n  ⚠ Raw guardrail exceeded (per file, soft): ${rawOver.join(", ")}`,
    );
    console.log(
      `    Limit ${RAW_BUDGET} B raw each. Gzip still OK — prefer shrinking source.\n`,
    );
    process.exitCode = 0;
  } else {
    const worstHeadroom = Math.min(
      ...PAYLOAD.map((f) => {
        const gz = gzipSync(readFileSync(path.join(outDir, f)), {
          level: 9,
        }).length;
        return GZIP_BUDGET - gz;
      }),
    );
    console.log(
      `\n  ✓ Each file within budget (tightest gzip headroom ${worstHeadroom} B).\n`,
    );
    process.exitCode = 0;
  }
}

async function buildAssets() {
  copyStatic();
  // CSS + JS first so HTML can embed content hashes for cache busting.
  const [, cssHash] = await Promise.all([
    esbuild.build(jsOpts),
    buildCss(),
  ]);
  const jsHash = contentHash(readFileSync(path.join(outDir, "app.js")));
  await buildHtml(cssHash, jsHash);
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
