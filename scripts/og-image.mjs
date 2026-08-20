#!/usr/bin/env node
/**
 * Social card generator: wordmark → client/og.png
 *
 * Run by hand (`npm run build:og`), not on every client build — it shells out
 * to macOS `sips`, which no other build step needs. The output is checked in;
 * `copyStatic` in build-client.mjs ships it to public/.
 *
 * PNG rather than WebP, which this wrote until the card stopped rendering on
 * X. WebP is nominally on their supported list, but the file this produces is
 * lossless VP8L — a variant their card renderer does not reliably decode, and
 * a card that silently doesn't draw is worth more than the ~10 KB the smaller
 * format saves on an image no visitor to the site ever loads.
 *
 * The card is the wordmark's own shapes, in the wordmark's own green, over a
 * white-to-grey gradient. The mark is drawn at over half the card width, so it
 * survives the thumbnail a feed may shrink it to on size alone — which is what
 * buys the brand colour here, where a run of body text at this contrast would
 * not be legible.
 */
import { execFileSync } from "child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import path from "path";
import { fileURLToPath } from "url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const root = path.join(__dirname, "..");
const srcSvg = path.join(root, "client", "go-wordmark.svg");
const outPng = path.join(root, "client", "og.png");

/** Open Graph's canonical size — 1.91:1, what every platform crops toward. */
const W = 1200;
const H = 630;

/**
 * Ink bounds of the wordmark inside its 55×15 viewBox, measured off the shape
 * data: x 0.78→54.484 (bar's left edge to the 'o' of "go"), y 3.252→12.168
 * (the 'g' overshoots the bar's cap line at both ends). The viewBox itself
 * carries slack on every side, so centering on it would sit the mark
 * off-center.
 */
const INK = { x0: 0.78, y0: 3.252, x1: 54.484, y1: 12.168 };

/**
 * Mark width as a share of the card. Just over half leaves the margin the
 * rest of the UI runs on, and still reads at the ~500 px a feed renders.
 */
const MARK_RATIO = 0.55;

/** Rendered at 2× and downsampled, so glyph edges land on subpixels. */
const SCALE = 2;

/**
 * The wordmark's own green, read off client/go-wordmark.svg rather than
 * repeated as a literal — the card and the logo in the header are then the
 * same colour by construction, and stay that way through a rebrand.
 */
const INK_FILL = (() => {
  const m = readFileSync(srcSvg, "utf8").match(/fill="(#[0-9a-fA-F]{3,8})"/);
  if (!m) throw new Error("no fill colour found in go-wordmark.svg");
  return m[1];
})();

/**
 * Background ramp, top to bottom. Both ends come from the site's own neutrals
 * (--bg and the grey family around --ch/--b in client/app.css), so the card
 * reads as the same surface the page does.
 *
 * Drawn as a gradient rather than a flat fill because a social card is
 * composited onto the platform's own background: a card that is white edge to
 * edge dissolves into a light feed, and the ramp gives the bottom edge enough
 * tone to hold the card's shape.
 */
const BG_TOP = "#ffffff";
const BG_BOTTOM = "#e3e6e9";

/**
 * Pull the mark's shapes out of the wordmark rather than duplicating them.
 *
 * The source paints with a single fill on the root <svg>, so its shapes take
 * the colour of whatever group they land in. Stripping any fill a later edit
 * puts on a shape keeps that true, which is what lets the card recolour the
 * whole mark black by setting one attribute on the wrapping <g>.
 */
function markShapes() {
  const svg = readFileSync(srcSvg, "utf8");
  const shapes = svg
    .replace(/^[\s\S]*?<svg\b[^>]*>/, "")
    .replace(/<\/svg>[\s\S]*$/, "")
    .replace(/<!--[\s\S]*?-->/g, "")
    .replace(/\s*fill="[^"]*"/g, "")
    .trim();
  if (!/<(?:path|rect)\b/.test(shapes)) {
    throw new Error("no path/rect shapes found in go-wordmark.svg");
  }
  return shapes;
}

function buildSvg() {
  const inkW = INK.x1 - INK.x0;
  const inkH = INK.y1 - INK.y0;
  const s = (W * MARK_RATIO) / inkW;
  const tx = W / 2 - s * (INK.x0 + INK.x1) / 2;
  const ty = H / 2 - s * (INK.y0 + INK.y1) / 2;
  return (
    `<svg xmlns="http://www.w3.org/2000/svg" width="${W * SCALE}" height="${H * SCALE}"` +
    ` viewBox="0 0 ${W} ${H}">` +
    `<defs><linearGradient id="bg" x1="0" y1="0" x2="0" y2="1">` +
    `<stop offset="0" stop-color="${BG_TOP}"/>` +
    `<stop offset="1" stop-color="${BG_BOTTOM}"/>` +
    `</linearGradient></defs>` +
    `<rect width="${W}" height="${H}" fill="url(#bg)"/>` +
    `<g fill="${INK_FILL}" transform="translate(${tx.toFixed(3)} ${ty.toFixed(3)}) scale(${s.toFixed(5)})">` +
    markShapes() +
    `</g></svg>`
  );
}

const work = mkdtempSync(path.join(tmpdir(), "og-"));
try {
  const svgPath = path.join(work, "og.svg");
  writeFileSync(svgPath, buildSvg());

  // sips is the only rasterizer guaranteed present on macOS; it reads SVG and
  // writes PNG at the size the document declares (2× here).
  execFileSync("sips", ["-s", "format", "png", svgPath, "--out", outPng], {
    stdio: "ignore",
  });

  // Down to 1:1 as a second pass, so the glyph edges land on subpixels and
  // resample rather than being rasterized straight to the final grid. `-z`
  // takes height then width.
  execFileSync("sips", ["-z", String(H), String(W), outPng], { stdio: "ignore" });

  const bytes = readFileSync(outPng).length;
  console.log(`og.png  ${W}×${H}  ${bytes} B`);
} finally {
  rmSync(work, { recursive: true, force: true });
}
