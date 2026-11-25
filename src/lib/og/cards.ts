/**
 * The wallet's share cards, drawn per request: /og/wallet/<mint>.png for a
 * token and /og/wallet/<list>.png for a list (src/seo.ts names them in each
 * wallet address's head).
 *
 * A token's card is its logo, name, price, day's move and day's line on a
 * ground in the logo's own colour (readTint, as the home watchlist's tiles);
 * a list's card is the list's top five as the wallet draws its rows, on the
 * wallet's brown. Everything is paths and pixels, no <text> (lib/og/font.ts
 * says why), composited by sharp, which the server already runs for logos.
 *
 * A card is a few tens of milliseconds and is kept for a quarter of an hour:
 * long enough that a link going round is drawn once, short enough that the
 * price on it is about today's.
 */
import { readFileSync } from "fs";
import path from "path";
import sharp, { type OverlayOptions } from "sharp";
import { bigIconFile, tintOf } from "../tokens/icons";
import { daySeries } from "../tokens/history";
import { listTokens } from "../tokens/store";
import { change } from "../tokens/ticker";
import type { TokenList, TokenRecord, TopToken } from "../../types";
import { loadFont, type Font } from "./font";

export const CARD_W = 1200;
export const CARD_H = 630;
/** How long a drawn card is served from memory, and how long a client may keep it. */
export const CARD_TTL_MS = 15 * 60_000;
const MAX_HELD = 300;

const ROOT = path.join(__dirname, "..", "..", "..");
let fonts: { bold: Font; medium: Font } | null = null;
let wordmarkShapes = "";

function bold(): Font {
  return (fonts ??= {
    bold: loadFont(path.join(ROOT, "assets", "fonts", "Inter-Bold.ttf")),
    medium: loadFont(path.join(ROOT, "assets", "fonts", "Inter-Medium.ttf")),
  }).bold;
}

function medium(): Font {
  bold();
  return fonts!.medium;
}

/** The wordmark's shapes, uncoloured (as scripts/og-cards.mjs reads them). */
function wordmark(x: number, y: number, width: number, opacity = 1): string {
  wordmarkShapes ||= readFileSync(path.join(ROOT, "client", "go-wordmark.svg"), "utf8")
    .replace(/^[\s\S]*?<svg\b[^>]*>/, "")
    .replace(/<\/svg>[\s\S]*$/, "")
    .replace(/<!--[\s\S]*?-->/g, "")
    .replace(/\s*fill="[^"]*"/g, "")
    .trim();
  // Ink bounds in its 55×15 viewBox (scripts/og-image.mjs INK).
  const s = width / (54.484 - 0.78);
  return `<g fill="#fff" fill-opacity="${opacity}" transform="translate(${(x - s * 0.78).toFixed(2)} ${(y - s * 3.252).toFixed(2)}) scale(${s.toFixed(4)})">${wordmarkShapes}</g>`;
}

// —— Type ——

/** Drops what the font cannot draw (emoji, mostly) and the space it leaves. */
function drawable(font: Font, text: string): string {
  return Array.from(text.normalize("NFC"))
    .filter((ch) => font.covers(ch))
    .join("")
    .replace(/\s+/g, " ")
    .trim();
}

/** `text` cut to `max` px wide, with an ellipsis where it was cut. */
function fit(font: Font, text: string, size: number, max: number, track = 0): string {
  if (font.width(text, size, track) <= max) return text;
  const cs = Array.from(text);
  while (cs.length > 1 && font.width(cs.join("").trimEnd() + "…", size, track) > max) cs.pop();
  return cs.join("").trimEnd() + "…";
}

/** The largest size from `from` down to `min` at which `text` fits `max`. */
function sizeToFit(font: Font, text: string, from: number, min: number, max: number, track = 0): number {
  const w = font.width(text, from, track);
  return w <= max ? from : Math.max(min, Math.floor((from * max) / w));
}

function text(font: Font, s: string, x: number, y: number, size: number, fill: string, opts: { track?: number; anchor?: "end"; opacity?: number } = {}): string {
  const track = opts.track ?? 0;
  const x0 = opts.anchor === "end" ? x - font.width(s, size, track) : x;
  return `<path d="${font.path(s, x0, y, size, track)}" fill="${fill}"${opts.opacity != null ? ` fill-opacity="${opts.opacity}"` : ""}/>`;
}

/** Words wrapped to `max` px, at most `lines` of them, the last cut if it must be. */
function wrap(font: Font, s: string, size: number, max: number, lines: number): string[] {
  const out: string[] = [];
  let line = "";
  for (const word of s.split(" ")) {
    const next = line ? `${line} ${word}` : word;
    if (font.width(next, size) <= max || !line) line = next;
    else {
      out.push(line);
      line = word;
    }
  }
  if (line) out.push(line);
  if (out.length > lines) {
    const kept = out.slice(0, lines);
    kept[lines - 1] = fit(font, `${kept[lines - 1]} ${out.slice(lines).join(" ")}`, size, max);
    return kept;
  }
  return out;
}

// —— Figures, as the wallet writes them ——

/** A price to four significant figures below a dollar, cents above. */
export function cardPrice(v: number): string {
  if (!Number.isFinite(v) || v <= 0) return "";
  if (v >= 1) return `$${v.toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
  const zeros = Math.max(0, -Math.floor(Math.log10(v)) - 1);
  return `$${v.toFixed(Math.min(20, zeros + 4)).replace(/0+$/, "")}`;
}

function compactUsd(v: number | undefined): string {
  if (v == null || !Number.isFinite(v) || v <= 0) return "";
  if (v < 1000) return `$${v.toFixed(2)}`;
  return `$${new Intl.NumberFormat("en-US", { notation: "compact", maximumFractionDigits: 1 }).format(v)}`;
}

// —— Grounds ——

const WALLET_TINT = { hi: "#c98a4f", lo: "#5e3618" };
const GRAPHITE = { hi: "#6e6e76", lo: "#2a2a2f" };

function parseTint(t: string | null): { hi: string; lo: string } | null {
  const m = t?.match(/--hi:(#[0-9a-f]{6});--lo:(#[0-9a-f]{6})/i);
  return m ? { hi: m[1], lo: m[2] } : null;
}

/** Hex `a` taken `t` of the way to `b`. */
function mix(a: string, b: string, t: number): string {
  const ch = (h: string, i: number) => parseInt(h.slice(1 + 2 * i, 3 + 2 * i), 16);
  return `#${[0, 1, 2]
    .map((i) => Math.round(ch(a, i) + (ch(b, i) - ch(a, i)) * t)
      .toString(16)
      .padStart(2, "0"))
    .join("")}`;
}

/**
 * The tile's two shades, run corner to corner, both taken down a little so
 * white type holds even where a logo's colour is a yellow.
 */
function ground(tint: { hi: string; lo: string }): string {
  return (
    `<defs><linearGradient id="bg" x1="0" y1="0" x2="1" y2="1">` +
    `<stop offset="0" stop-color="${mix(tint.hi, tint.lo, 0.3)}"/><stop offset="1" stop-color="${mix(tint.lo, "#000000", 0.35)}"/></linearGradient>` +
    `<linearGradient id="fade" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="#fff" stop-opacity=".26"/><stop offset="1" stop-color="#fff" stop-opacity="0"/></linearGradient></defs>` +
    `<rect width="${CARD_W}" height="${CARD_H}" fill="url(#bg)"/>`
  );
}

// —— Logos ——

/** A logo as a round PNG `edge` px across, or null when none is on disk. */
async function roundLogo(mint: string, edge: number): Promise<Buffer | null> {
  const file = bigIconFile(mint);
  if (!file) return null;
  try {
    const mask = Buffer.from(`<svg xmlns="http://www.w3.org/2000/svg" width="${edge}" height="${edge}"><circle cx="${edge / 2}" cy="${edge / 2}" r="${edge / 2}"/></svg>`);
    return await sharp(file)
      .resize(edge, edge, { fit: "cover" })
      .ensureAlpha()
      .composite([{ input: mask, blend: "dest-in" }])
      .png()
      .toBuffer();
  } catch {
    return null;
  }
}

/** What stands in for a missing logo: its first letter on a disc. */
function letterDisc(symbol: string, cx: number, cy: number, edge: number): string {
  const ch = drawable(bold(), symbol).charAt(0).toUpperCase() || "?";
  const size = edge * 0.46;
  const w = bold().width(ch, size);
  return (
    `<circle cx="${cx}" cy="${cy}" r="${edge / 2}" fill="#fff" fill-opacity=".16"/>` +
    text(bold(), ch, cx - w / 2, cy + size * 0.36, size, "#fff")
  );
}

/** A hairline round a logo, so a black or white one keeps its edge on any ground. */
function ring(cx: number, cy: number, edge: number): string {
  return `<circle cx="${cx}" cy="${cy}" r="${edge / 2 - 1}" fill="none" stroke="#fff" stroke-opacity=".22" stroke-width="2"/>`;
}

// —— The day's line ——

function dayLine(rec: TokenRecord, top: number, bottom: number): string {
  const v = daySeries(rec)?.v.filter((p) => Number.isFinite(p) && p > 0);
  if (!v || v.length < 2) return "";
  // At least a hundredth of the price top to bottom, centred: a stablecoin's
  // day is a flat line, not its fractions of a cent drawn as cliffs.
  const min = Math.min(...v);
  const max = Math.max(...v);
  const span = Math.max(max - min, ((max + min) / 2) * 0.01) || 1;
  const lo = (max + min) / 2 - span / 2;
  const pts = v.map((p, i) => `${((i / (v.length - 1)) * CARD_W).toFixed(1)},${(bottom - ((p - lo) / span) * (bottom - top)).toFixed(1)}`);
  const line = pts.join(" ");
  return (
    `<polygon points="0,${CARD_H} ${line} ${CARD_W},${CARD_H}" fill="url(#fade)"/>` +
    `<polyline points="${line}" fill="none" stroke="#fff" stroke-width="6" stroke-linejoin="round" stroke-linecap="round"/>`
  );
}

const UP = "#30d158";
const DOWN = "#ff453a";

/** The day's move as a pill: green, red or grey, with its arrow. Returns the svg and its width. */
function movePill(pct: number | undefined, x: number, y: number, size: number): [string, number] {
  if (pct == null || !Number.isFinite(pct)) return ["", 0];
  const up = pct > 0;
  const flat = Math.abs(pct) < 0.005;
  const arrow = flat ? "" : up ? "▲ " : "▼ ";
  const label = `${bold().covers(arrow) ? arrow : flat ? "" : up ? "+" : "-"}${change(Math.abs(pct)).replace(/^\+/, "")}`;
  const padX = size * 0.5;
  const h = size * 1.5;
  const w = bold().width(label, size) + 2 * padX;
  const fill = flat ? "#8e8e93" : up ? "#248a3d" : "#d70015";
  return [
    `<rect x="${x}" y="${y - h / 2}" width="${w.toFixed(1)}" height="${h}" rx="${h / 2}" fill="${fill}"/>` + text(bold(), label, x + padX, y + size * 0.36, size, "#fff"),
    w,
  ];
}

// —— The cards ——

const LOGO = 168;
const PAD = 72;

async function drawToken(rec: TokenRecord): Promise<Buffer> {
  const [logo, tint] = await Promise.all([roundLogo(rec.mint, LOGO), tintOf(rec.mint)]);
  const nameRaw = drawable(bold(), rec.name) || drawable(bold(), rec.symbol) || `${rec.mint.slice(0, 4)}…${rec.mint.slice(-4)}`;
  const symbol = drawable(medium(), rec.symbol);

  const cx = PAD + LOGO / 2;
  const cy = PAD + LOGO / 2;
  const nameX = PAD + LOGO + 36;
  const wmW = 150;
  const nameMax = CARD_W - nameX - PAD - wmW - 40;
  const nameSize = sizeToFit(bold(), nameRaw, 68, 48, nameMax, -0.02);
  const name = fit(bold(), nameRaw, nameSize, nameMax, -0.02);

  const price = cardPrice(rec.price) || "No price yet";
  const priceSize = sizeToFit(bold(), price, 136, 72, CARD_W - 2 * PAD, -0.03);

  const [pill, pillW] = movePill(rec.change24h, PAD, 428, 38);
  const cap = compactUsd(rec.mcap);
  const vol = compactUsd(rec.volume24h);
  const facts = [cap && `${cap} market cap`, vol && `${vol} traded today`].filter(Boolean) as string[];
  const factsX = PAD + (pillW ? pillW + 24 : 0);
  let factLine = "";
  while (facts.length) {
    factLine = facts.join("  ·  ");
    if (medium().width(factLine, 36) <= CARD_W - PAD - factsX) break;
    facts.pop();
    factLine = "";
  }

  const svg =
    `<svg xmlns="http://www.w3.org/2000/svg" width="${CARD_W}" height="${CARD_H}" viewBox="0 0 ${CARD_W} ${CARD_H}">` +
    ground(parseTint(tint) ?? (logo ? GRAPHITE : WALLET_TINT)) +
    dayLine(rec, 470, 590) +
    (logo ? "" : letterDisc(rec.symbol, cx, cy, LOGO)) +
    text(bold(), name, nameX, PAD + 84, nameSize, "#fff", { track: -0.02 }) +
    (symbol ? text(medium(), fit(medium(), `${symbol} · Solana`, 38, nameMax), nameX, PAD + 140, 38, "#fff", { opacity: 0.72 }) : "") +
    wordmark(CARD_W - PAD - wmW, PAD + 14, wmW, 0.92) +
    text(bold(), price, PAD - 4, 360, priceSize, "#fff", { track: -0.03 }) +
    pill +
    (factLine ? text(medium(), factLine, factsX, 428 + 13, 36, "#fff", { opacity: 0.78 }) : "") +
    `</svg>`;

  const base = sharp(Buffer.from(svg));
  const layers = logo ? [{ input: logo, left: PAD, top: PAD }] : [];
  // The ring is drawn over the logo, so it goes on last.
  if (logo) layers.push({ input: Buffer.from(`<svg xmlns="http://www.w3.org/2000/svg" width="${LOGO}" height="${LOGO}">${ring(LOGO / 2, LOGO / 2, LOGO)}</svg>`), left: PAD, top: PAD });
  return base.composite(layers).png({ compressionLevel: 8 }).toBuffer();
}

const LIST_NAME: Record<TokenList, string> = {
  trending: "Wallet",
  stocks: "Tokenized Stocks",
  memes: "Memecoins",
  rwas: "Real-World Assets",
  majors: "Majors",
  defi: "DeFi",
};

const LIST_LINE: Record<TokenList, string> = {
  trending: "Every Solana token, priced, charted and tradable",
  stocks: "Shares of listed companies, as Solana tokens",
  memes: "Solana's memecoins, busiest first",
  rwas: "Gold, treasuries and other real-world assets on Solana",
  majors: "SOL and the biggest names on Solana",
  defi: "The tokens of Solana's DeFi protocols",
};

const ROWS = 5;
const PANEL = { x: 616, y: 60, w: 524, h: 510 };
const ROW_LOGO = 64;

async function drawList(list: TokenList): Promise<Buffer> {
  const rows: TopToken[] = listTokens(list, "", ROWS).tokens;
  const logos = await Promise.all(rows.map((t) => roundLogo(t.mint, ROW_LOGO)));

  const title = LIST_NAME[list];
  const titleSize = sizeToFit(bold(), title, 112, 64, PANEL.x - 2 * PAD + 20, -0.03);
  const titleLines = bold().width(title, titleSize, -0.03) > PANEL.x - 2 * PAD + 20 ? wrap(bold(), title, 76, PANEL.x - 2 * PAD, 2) : [title];
  const tSize = titleLines.length > 1 ? 76 : titleSize;
  let y = titleLines.length > 1 ? 190 : 230;
  let body = "";
  for (const l of titleLines) {
    body += text(bold(), l, PAD - 4, y, tSize, "#fff", { track: -0.03 });
    y += tSize * 1.02;
  }
  y += 26;
  for (const l of wrap(medium(), LIST_LINE[list], 36, PANEL.x - 2 * PAD, 3)) {
    body += text(medium(), l, PAD, y, 36, "#fff", { opacity: 0.82 });
    y += 48;
  }

  let panel = "";
  const layers: OverlayOptions[] = [];
  if (rows.length) {
    const rowH = PANEL.h / ROWS;
    panel += `<rect x="${PANEL.x}" y="${PANEL.y}" width="${PANEL.w}" height="${PANEL.h}" rx="36" fill="#000" fill-opacity=".24"/>`;
    const left = PANEL.x + 32;
    const right = PANEL.x + PANEL.w - 32;
    rows.forEach((t, i) => {
      const cy = PANEL.y + rowH * i + rowH / 2;
      if (i) panel += `<rect x="${left}" y="${(PANEL.y + rowH * i).toFixed(1)}" width="${right - left}" height="1.5" fill="#fff" fill-opacity=".1"/>`;
      const logo = logos[i];
      if (logo) layers.push({ input: logo, left, top: Math.round(cy - ROW_LOGO / 2) });
      else panel += letterDisc(t.symbol, left + ROW_LOGO / 2, cy, ROW_LOGO);
      const price = cardPrice(t.price);
      const priceW = price ? bold().width(price, 32) : 0;
      const textX = left + ROW_LOGO + 20;
      const room = right - textX - Math.max(priceW, 110) - 20;
      const sym = drawable(bold(), t.symbol) || t.mint.slice(0, 4);
      panel += text(bold(), fit(bold(), sym, 32, room), textX, cy - 4, 32, "#fff");
      const nm = drawable(medium(), t.name);
      if (nm) panel += text(medium(), fit(medium(), nm, 24, room), textX, cy + 28, 24, "#fff", { opacity: 0.62 });
      if (price) panel += text(bold(), price, right, cy - 4, 32, "#fff", { anchor: "end" });
      if (t.change24h != null && Number.isFinite(t.change24h)) {
        const c = t.change24h;
        const flat = Math.abs(c) < 0.005;
        panel += text(medium(), change(c), right, cy + 28, 24, flat ? "#c7c7cc" : c > 0 ? "#4cd964" : "#ff6961", { anchor: "end" });
      }
      if (logo) layers.push({ input: Buffer.from(`<svg xmlns="http://www.w3.org/2000/svg" width="${ROW_LOGO}" height="${ROW_LOGO}">${ring(ROW_LOGO / 2, ROW_LOGO / 2, ROW_LOGO)}</svg>`), left, top: Math.round(cy - ROW_LOGO / 2) });
    });
  }

  const svg =
    `<svg xmlns="http://www.w3.org/2000/svg" width="${CARD_W}" height="${CARD_H}" viewBox="0 0 ${CARD_W} ${CARD_H}">` +
    ground(WALLET_TINT) +
    body +
    wordmark(PAD, 520, 260) +
    panel +
    `</svg>`;
  return sharp(Buffer.from(svg)).composite(layers).png({ compressionLevel: 8 }).toBuffer();
}

// —— Kept for a while, drawn once however many ask at the same moment ——

const held = new Map<string, { at: number; png: Promise<Buffer> }>();

function keep(key: string, draw: () => Promise<Buffer>): Promise<Buffer> {
  const now = Date.now();
  const hit = held.get(key);
  if (hit && now - hit.at < CARD_TTL_MS) return hit.png;
  const png = draw();
  held.set(key, { at: now, png });
  png.catch(() => held.delete(key));
  if (held.size > MAX_HELD) held.delete(held.keys().next().value!);
  return png;
}

export function tokenCard(rec: TokenRecord): Promise<Buffer> {
  return keep(rec.mint, () => drawToken(rec));
}

export function listCard(list: TokenList): Promise<Buffer> {
  return keep(`list:${list}`, () => drawList(list));
}
