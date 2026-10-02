#!/usr/bin/env node
/**
 * App icons: go-favicon.svg → the PNGs the web app manifest, iOS and browsers
 * without SVG favicons ask for.
 *
 * Run by hand (`npm run build:icons`), not on every client build — the same
 * arrangement as og-image.mjs. The output is checked in; `copyStatic` in
 * build-client.mjs ships it to public/.
 *
 * The letters are read out of the favicon's SVG rather than repeated here, so
 * the home-screen icon and the tab icon are the same mark by construction. The
 * daylight colours only: a manifest icon has no colour scheme to follow, and
 * the daylight letters are what stand in wherever the SVG cannot.
 *
 *   go-favicon.png              the favicon as it is, the bare letters, for
 *                               browsers that take no SVG icon. 64 is what
 *                               index.html declares.
 *   icon-192.png, icon-512.png  the letters on a white disc, on a transparent
 *                               square. Chrome requires both
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
const src = readFileSync(path.join(clientDir, "go-favicon.svg"), "utf8");

/**
 * The maskable safe zone: a centred circle 80% of the icon's width, which the
 * manifest spec guarantees survives any launcher's mask. The disc is drawn at
 * exactly that size, so the letters keep the proportion they have on it.
 */
const SAFE = 0.8;

/**
 * The disc the app icons set the letters on. The favicon has none — a tab
 * shows the bare letters — but a launcher or a home screen wants a tile, and
 * iOS fills any transparency with black. It is the field surface every input
 * on the site has (the field tokens in app.css), and the letters span 78% of
 * it, as they did when the favicon had it too.
 */
const DISC = "#fff";
const SPAN = 0.78;

/** @param {RegExp} re @param {string} what */
function grab(re, what) {
  const m = src.match(re);
  if (!m) throw new Error(`app-icons: no ${what} found in go-favicon.svg`);
  return m;
}

// The first rule is the daylight one; the dark override follows it inside the
// media query.
const [, ink] = grab(/path\s*\{\s*fill:\s*(#[0-9a-f]{3,8})/i, "glyph colour");
const [, viewBox] = grab(/viewBox="([^"]+)"/, "viewBox");
const [, glyph] = grab(/<path d="([^"]+)"/, "glyph path");

// The favicon's view is the square on the letters' width, centred on them.
const [vx, vy, side] = viewBox.split(/\s+/).map(Number);
const cx = vx + side / 2;
const cy = vy + side / 2;
const r = side / 2 / SPAN;

/** The favicon, daylight only. */
function bare(size) {
  return (
    `<svg xmlns="http://www.w3.org/2000/svg" width="${size}" height="${size}" viewBox="${viewBox}">` +
    `<path d="${glyph}" fill="${ink}"/></svg>`
  );
}

/** The letters on the disc, on a transparent square. */
function onDisc(size) {
  return (
    `<svg xmlns="http://www.w3.org/2000/svg" width="${size}" height="${size}" viewBox="${cx - r} ${cy - r} ${2 * r} ${2 * r}">` +
    `<circle cx="${cx}" cy="${cy}" r="${r}" fill="${DISC}"/>` +
    `<path d="${glyph}" fill="${ink}"/></svg>`
  );
}

/** The disc's fill to every edge, with the disc's outer edge on the safe zone. */
function fullBleed(size) {
  const half = r / SAFE;
  const x = cx - half;
  const y = cy - half;
  return (
    `<svg xmlns="http://www.w3.org/2000/svg" width="${size}" height="${size}" viewBox="${x} ${y} ${2 * half} ${2 * half}">` +
    `<rect x="${x}" y="${y}" width="${2 * half}" height="${2 * half}" fill="${DISC}"/>` +
    `<path d="${glyph}" fill="${ink}"/></svg>`
  );
}

const ICONS = [
  ["go-favicon.png", bare(64)],
  ["icon-192.png", onDisc(192)],
  ["icon-512.png", onDisc(512)],
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
