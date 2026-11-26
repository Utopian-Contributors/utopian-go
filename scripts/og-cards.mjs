#!/usr/bin/env node
/**
 * Social cards for the pages that are not the home page: client/og-<page>.png
 *
 * Run by hand (`npm run build:cards`), like og-image.mjs, and checked in;
 * copyStatic in build-client.mjs ships them to public/. A link to /snake
 * posted anywhere used to unfurl as nothing at all, since only the home page
 * named a card.
 *
 * Each card is the page as its tile on the games list draws it: the tile's
 * two shades as the ground (client/games.css --hi/--lo), its mark drawn
 * large, its name and its line from the list, and the wordmark in white so
 * the card still says whose it is once a feed has cropped it. Rasterised by
 * sharp, which the server already depends on, so unlike og-image.mjs this
 * needs no macOS tool.
 */
import { readFileSync } from "fs";
import path from "path";
import sharp from "sharp";
import { fileURLToPath } from "url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const client = path.join(__dirname, "..", "client");

/** Open Graph's canonical size, as og-image.mjs. */
const W = 1200;
const H = 630;

/** Ink bounds of the wordmark in its 55×15 viewBox (og-image.mjs INK). */
const INK = { x0: 0.78, y0: 3.252, x1: 54.484, y1: 12.168 };

/** The text the cards set in: the same stack the pages use, as librsvg resolves it. */
const FONT = "-apple-system, 'SF Pro Display', 'Helvetica Neue', Helvetica, Arial, sans-serif";

/**
 * The cards: the file each is written to, its shades, its words, and the
 * marks drawn in its corner. Names and lines are the games list's
 * (client/games.html) so a card and the tile it was shared from agree.
 */
const CARDS = [
  {
    out: "og-games.png",
    hi: "#d8443c",
    lo: "#7e1a17",
    title: "Games",
    line: "Slots, pinball, snake and more",
    // One mark a game: Fruit Slots' pattern is a ground, not a mark, so it is a cherry here.
    marks: ["st-cherry.svg", "ic-flippers.svg", "ic-apple.svg", "ic-shell.svg"],
  },
  { out: "og-slots.png", hi: "#b98cff", lo: "#5a2bb0", title: "Fruit Slots", line: "Hit 1,000 to win a fruit status", marks: ["slots-fruit.svg"] },
  { out: "og-pinball.png", hi: "#4cc488", lo: "#0f5c3b", title: "Pinball", line: "Flippers, ramps and multiball", marks: ["ic-flippers.svg"] },
  { out: "og-snake.png", hi: "#ffc75a", lo: "#c9681a", title: "Snake", line: "Eat, grow, mind your tail", marks: ["ic-apple.svg"] },
  { out: "og-shotgun.png", hi: "#8592a6", lo: "#2c3442", title: "Shotgun", line: "Spin the wheel, hold off the waves", marks: ["ic-shell.svg"] },
  { out: "og-rally.png", hi: "#5cb8ff", lo: "#1c5aa8", title: "Rally", line: "Jumps, a loop and your ghost", marks: ["ic-car.svg"] },
];

function esc(s) {
  return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

/** The wordmark's shapes, uncoloured, as og-image.mjs markShapes takes them. */
function wordmark() {
  return readFileSync(path.join(client, "go-wordmark.svg"), "utf8")
    .replace(/^[\s\S]*?<svg\b[^>]*>/, "")
    .replace(/<\/svg>[\s\S]*$/, "")
    .replace(/<!--[\s\S]*?-->/g, "")
    .replace(/\s*fill="[^"]*"/g, "")
    .trim();
}

/**
 * A mark as a nested <svg> at (x, y), `edge` wide. Gradient ids are prefixed
 * per placement, so two marks that both define "skeu-…-b" cannot paint with
 * each other's.
 */
function mark(file, x, y, edge, n) {
  const src = readFileSync(path.join(client, file), "utf8");
  const viewBox = src.match(/viewBox="([^"]+)"/)?.[1] ?? "0 0 32 32";
  const inner = src
    .replace(/^[\s\S]*?<svg\b[^>]*>/, "")
    .replace(/<\/svg>\s*$/, "")
    .replace(/id="([^"]+)"/g, `id="m${n}-$1"`)
    .replace(/url\(#([^)]+)\)/g, `url(#m${n}-$1)`)
    .replace(/href="#([^"]+)"/g, `href="#m${n}-$1"`);
  return `<svg x="${x}" y="${y}" width="${edge}" height="${edge}" viewBox="${viewBox}">${inner}</svg>`;
}

function svg(card) {
  // The marks: one large in the right half, or the games list's four in a 2×2.
  let art = "";
  if (card.marks.length === 1) art = mark(card.marks[0], 700, 95, 440, 0);
  else card.marks.forEach((m, i) => (art += mark(m, 730 + (i % 2) * 230, 75 + Math.floor(i / 2) * 250, 200, i)));

  const s = 300 / (INK.x1 - INK.x0);
  const wm = `<g fill="#ffffff" transform="translate(${(80 - s * INK.x0).toFixed(2)} ${(520 - s * INK.y0).toFixed(2)}) scale(${s.toFixed(4)})">${wordmark()}</g>`;
  const size = card.title.length > 10 ? 96 : 120;
  return Buffer.from(
    `<svg xmlns="http://www.w3.org/2000/svg" width="${W}" height="${H}" viewBox="0 0 ${W} ${H}">` +
      `<defs><linearGradient id="bg" x1="0" y1="0" x2="1" y2="1">` +
      `<stop offset="0" stop-color="${card.hi}"/><stop offset="1" stop-color="${card.lo}"/></linearGradient></defs>` +
      `<rect width="${W}" height="${H}" fill="url(#bg)"/>` +
      art +
      `<text x="80" y="${size === 120 ? 300 : 290}" font-family="${FONT}" font-size="${size}" font-weight="700" fill="#ffffff" letter-spacing="-2">${esc(card.title)}</text>` +
      `<text x="82" y="370" font-family="${FONT}" font-size="38" font-weight="500" fill="#ffffff" fill-opacity=".82">${esc(card.line)}</text>` +
      wm +
      `</svg>`,
  );
}

for (const card of CARDS) {
  const out = path.join(client, card.out);
  // Drawn at 2× and brought down, so edges land on subpixels (og-image.mjs SCALE).
  await sharp(svg(card), { density: 144 }).resize(W, H).png({ compressionLevel: 9, palette: false }).toFile(out);
  console.log(`${card.out}  ${W}×${H}  ${readFileSync(out).length} B`);
}
