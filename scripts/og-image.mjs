#!/usr/bin/env node
/**
 * Social card generator: wordmark → client/og.webp
 *
 * Run by hand (`npm run build:og`), not on every client build — it shells out
 * to macOS `sips` and `cwebp`, which no other build step needs. The output is
 * checked in; `copyStatic` in build-client.mjs ships it to public/.
 *
 * The card is a stripped version of the wordmark: same paths as
 * client/go-wordmark.svg, but the green "go" flattened to black on white. A
 * social card is composited over whatever chrome the platform draws around it,
 * at whatever size the feed decides — one high-contrast mark survives that
 * better than a two-color one shrunk to a thumbnail.
 */
import { execFileSync } from "child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import path from "path";
import { fileURLToPath } from "url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const root = path.join(__dirname, "..");
const srcSvg = path.join(root, "client", "go-wordmark.svg");
const outWebp = path.join(root, "client", "og.webp");

/** Open Graph's canonical size — 1.91:1, what every platform crops toward. */
const W = 1200;
const H = 630;

/**
 * Ink bounds of the wordmark inside its 55×15 viewBox, measured off the path
 * data: x 0.775→54.484 ('u' stem to the 'o' of "go"), y 3.252→14.076 (top of
 * the 'g' to the 'p' descender). The viewBox itself carries slack on every
 * side, so centering on it would sit the mark off-center.
 */
const INK = { x0: 0.7752, y0: 3.252, x1: 54.484, y1: 14.076 };

/**
 * Mark width as a share of the card. Just over half leaves the margin the
 * rest of the UI runs on, and still reads at the ~500 px a feed renders.
 */
const MARK_RATIO = 0.55;

/** Rendered at 2× and downsampled, so glyph edges land on subpixels. */
const SCALE = 2;

/** Pull the two glyph paths out of the wordmark rather than duplicating them. */
function wordmarkPaths() {
  const svg = readFileSync(srcSvg, "utf8");
  const ds = [...svg.matchAll(/\sd="([^"]+)"/g)].map((m) => m[1]);
  if (ds.length !== 2) {
    throw new Error(`expected 2 paths in go-wordmark.svg, found ${ds.length}`);
  }
  return ds;
}

function buildSvg() {
  const inkW = INK.x1 - INK.x0;
  const inkH = INK.y1 - INK.y0;
  const s = (W * MARK_RATIO) / inkW;
  const tx = W / 2 - s * (INK.x0 + INK.x1) / 2;
  const ty = H / 2 - s * (INK.y0 + INK.y1) / 2;
  const paths = wordmarkPaths()
    .map((d) => `<path d="${d}" fill="#000"/>`)
    .join("");

  return (
    `<svg xmlns="http://www.w3.org/2000/svg" width="${W * SCALE}" height="${H * SCALE}"` +
    ` viewBox="0 0 ${W} ${H}">` +
    `<rect width="${W}" height="${H}" fill="#fff"/>` +
    `<g transform="translate(${tx.toFixed(3)} ${ty.toFixed(3)}) scale(${s.toFixed(5)})">` +
    paths +
    `</g></svg>`
  );
}

const work = mkdtempSync(path.join(tmpdir(), "og-"));
try {
  const svgPath = path.join(work, "og.svg");
  const pngPath = path.join(work, "og.png");
  writeFileSync(svgPath, buildSvg());

  // sips is the only rasterizer guaranteed present on macOS; it reads SVG and
  // writes PNG at the size the document declares (2× here).
  execFileSync("sips", ["-s", "format", "png", svgPath, "--out", pngPath], {
    stdio: "ignore",
  });

  // Lossless: the card is two flat tones and hard edges, exactly what lossy
  // WebP rings around, and it still compresses to a few KB.
  execFileSync(
    "cwebp",
    ["-lossless", "-z", "9", "-resize", String(W), String(H), pngPath, "-o", outWebp],
    { stdio: "ignore" },
  );

  const bytes = readFileSync(outWebp).length;
  console.log(`og.webp  ${W}×${H}  ${bytes} B`);
} finally {
  rmSync(work, { recursive: true, force: true });
}
