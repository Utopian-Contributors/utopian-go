#!/usr/bin/env node
/**
 * App icons: favicon.svg → the PNGs the web app manifest, iOS and browsers
 * without SVG favicons ask for.
 *
 * Run by hand (`npm run build:icons`), not on every client build — the same
 * arrangement as og-image.mjs. The output is checked in; `copyStatic` in
 * build-client.mjs ships it to public/.
 *
 * Everything is drawn from the favicon's own disc and frog, read out of the
 * SVG rather than repeated here, so the home-screen icon and the tab icon are
 * the same mark by construction. The daylight colours only: a manifest icon
 * has no colour scheme to follow, and the daylight disc is what stands in
 * wherever the SVG cannot.
 *
 *   favicon.png                 the favicon as it is, for browsers that take
 *                               no SVG icon. 64 is what index.html declares.
 *   icon-192.png, icon-512.png  the favicon as it is — the disc on a
 *                               transparent square. Chrome requires both
 *                               sizes before it will offer to install; desktop
 *                               windows and launchers draw these.
 *   icon-maskable.png           full bleed, for launchers that cut their own
 *                               shape out of the icon (Android's adaptive
 *                               icons). The disc's fill runs to the edges,
 *                               since the launcher's mask is the outline now.
 *   apple-touch-icon.png        the maskable drawing at 180. iOS fills any
 *                               transparency with black and rounds the corners
 *                               itself, so it needs the full-bleed version too.
 */
import sharp from "sharp";
import { readFileSync, writeFileSync } from "fs";
import path from "path";
import { fileURLToPath } from "url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const clientDir = path.join(__dirname, "..", "client");
const src = readFileSync(path.join(clientDir, "favicon.svg"), "utf8");

/**
 * The maskable safe zone: a centred circle 80% of the icon's width, which the
 * manifest spec guarantees survives any launcher's mask. The disc is drawn at
 * exactly that size, so the frog keeps the proportion it has in the favicon.
 */
const SAFE = 0.8;

/** @param {RegExp} re @param {string} what */
function grab(re, what) {
  const m = src.match(re);
  if (!m) throw new Error(`app-icons: no ${what} found in favicon.svg`);
  return m;
}

// The first rule is the daylight one; the dark override follows it inside the
// media query.
const [, disc] = grab(/circle\s*\{\s*fill:\s*(#[0-9a-f]{3,8})/i, "disc colour");
const [, viewBox] = grab(/viewBox="([^"]+)"/, "viewBox");
const [cx, cy, r] = grab(/<circle cx="([\d.]+)" cy="([\d.]+)" r="([\d.]+)"/, "disc")
  .slice(1)
  .map(Number);
// Its paths carry their own fills, so the group goes over as it is.
const [frog] = grab(/<g>[\s\S]*?<\/g>/, "frog");

/** The favicon, daylight only. */
function plain(size) {
  return (
    `<svg xmlns="http://www.w3.org/2000/svg" width="${size}" height="${size}" viewBox="${viewBox}">` +
    `<circle cx="${cx}" cy="${cy}" r="${r}" fill="${disc}"/>` +
    `${frog}</svg>`
  );
}

/** The disc's fill to every edge, with the disc's outer edge on the safe zone. */
function fullBleed(size) {
  const half = r / SAFE;
  const x = cx - half;
  const y = cy - half;
  return (
    `<svg xmlns="http://www.w3.org/2000/svg" width="${size}" height="${size}" viewBox="${x} ${y} ${2 * half} ${2 * half}">` +
    `<rect x="${x}" y="${y}" width="${2 * half}" height="${2 * half}" fill="${disc}"/>` +
    `${frog}</svg>`
  );
}

const ICONS = [
  ["favicon.png", plain(64)],
  ["icon-192.png", plain(192)],
  ["icon-512.png", plain(512)],
  ["icon-maskable.png", fullBleed(512)],
  ["apple-touch-icon.png", fullBleed(180)],
];

for (const [name, svg] of ICONS) {
  // Drawn at its final size rather than scaled: the SVG carries width and
  // height, so librsvg rasterises the frog's edges at the pixels they land on.
  const png = await sharp(Buffer.from(svg))
    .png({ palette: true, compressionLevel: 9, effort: 10 })
    .toBuffer();
  writeFileSync(path.join(clientDir, name), png);
  console.log(`${name.padEnd(22)} ${String(png.length).padStart(6)} B`);
}
