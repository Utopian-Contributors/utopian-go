#!/usr/bin/env node
/**
 * App icons: go-favicon.svg → the PNGs the web app manifest and iOS ask for.
 *
 * Run by hand (`npm run build:icons`), not on every client build — the same
 * arrangement as og-image.mjs. The output is checked in; `copyStatic` in
 * build-client.mjs ships it to public/.
 *
 * Everything is drawn from the favicon's own disc and glyph, read out of the
 * SVG rather than repeated here, so the home-screen icon and the tab icon are
 * the same mark by construction. The daylight colours only: a manifest icon
 * has no colour scheme to follow, and go-favicon.png already settles that the
 * daylight disc is what stands in wherever the SVG cannot.
 *
 *   icon-192.png, icon-512.png  the favicon as it is — the disc and its ring on
 *                               a transparent square. Chrome requires both
 *                               sizes before it will offer to install; desktop
 *                               windows and launchers draw these.
 *   icon-maskable.png           full bleed, for launchers that cut their own
 *                               shape out of the icon (Android's adaptive
 *                               icons). The disc's fill runs to the edges and
 *                               the ring goes, since the launcher's mask is
 *                               the outline now.
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
const src = readFileSync(path.join(clientDir, "go-favicon.svg"), "utf8");

/**
 * The maskable safe zone: a centred circle 80% of the icon's width, which the
 * manifest spec guarantees survives any launcher's mask. The disc is drawn at
 * exactly that size, so the glyph keeps the proportion it has in the favicon.
 */
const SAFE = 0.8;

/** @param {RegExp} re @param {string} what */
function grab(re, what) {
  const m = src.match(re);
  if (!m) throw new Error(`app-icons: no ${what} found in go-favicon.svg`);
  return m;
}

// The first rule for each is the daylight one; the dark overrides follow it
// inside the media query.
const [, disc, ring] = grab(/circle\s*\{\s*fill:\s*(#[0-9a-f]{3,8});\s*stroke:\s*(#[0-9a-f]{3,8})/i, "disc colours");
const [, ink] = grab(/path\s*\{\s*fill:\s*(#[0-9a-f]{3,8})/i, "glyph colour");
const [, viewBox] = grab(/viewBox="([^"]+)"/, "viewBox");
const [cx, cy, r, stroke] = grab(
  /<circle cx="([\d.]+)" cy="([\d.]+)" r="([\d.]+)" stroke-width="([\d.]+)"/,
  "disc",
)
  .slice(1)
  .map(Number);
const [, glyph] = grab(/<path d="([^"]+)"/, "glyph path");

/** The favicon, daylight only. */
function plain(size) {
  return (
    `<svg xmlns="http://www.w3.org/2000/svg" width="${size}" height="${size}" viewBox="${viewBox}">` +
    `<circle cx="${cx}" cy="${cy}" r="${r}" fill="${disc}" stroke="${ring}" stroke-width="${stroke}"/>` +
    `<path d="${glyph}" fill="${ink}"/></svg>`
  );
}

/** The disc's fill to every edge, with the disc's outer edge on the safe zone. */
function fullBleed(size) {
  const half = (r + stroke / 2) / SAFE;
  const x = cx - half;
  const y = cy - half;
  return (
    `<svg xmlns="http://www.w3.org/2000/svg" width="${size}" height="${size}" viewBox="${x} ${y} ${2 * half} ${2 * half}">` +
    `<rect x="${x}" y="${y}" width="${2 * half}" height="${2 * half}" fill="${disc}"/>` +
    `<path d="${glyph}" fill="${ink}"/></svg>`
  );
}

const ICONS = [
  ["icon-192.png", plain(192)],
  ["icon-512.png", plain(512)],
  ["icon-maskable.png", fullBleed(512)],
  ["apple-touch-icon.png", fullBleed(180)],
];

for (const [name, svg] of ICONS) {
  // Drawn at its final size rather than scaled: the SVG carries width and
  // height, so librsvg rasterises the glyph's curves at the pixels they land on.
  const png = await sharp(Buffer.from(svg))
    .png({ palette: true, compressionLevel: 9, effort: 10 })
    .toBuffer();
  writeFileSync(path.join(clientDir, name), png);
  console.log(`${name.padEnd(22)} ${String(png.length).padStart(6)} B`);
}
