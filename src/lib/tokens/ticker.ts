import { authPath } from "../../pages";
import { TopToken } from "../../types";
import { iconTint, tintsOf } from "./icons";
import { lookupToken, quoteMints } from "./store";

/**
 * The home page's watchlist tiles, rendered server-side into index.html.
 *
 * The home page otherwise issues no requests at all, so fetching these would
 * cost a whole extra round trip on the most-visited page — and a client-side
 * render would cost one anyway, since app.js only arrives on the second trip.
 * Baking the markup into the shell means prices are on screen at first paint,
 * with zero requests and zero client JS.
 *
 * Which three show is a cookie the menu writes (client/watch/main.js), mints
 * joined by dots, so the next visit paints them. The menu offers every token
 * the index ranks, busiest on Jupiter first (/api/watch), and draws the tile
 * of one picked from it itself, the same markup as here.
 */

/** How many tiles the row holds. */
export const WATCH_SLOTS = 3;

/** The row as it stands for anyone who has not chosen: what these find. */
const DEFAULT_WATCH = ["btc", "eth", "sol"];

/** The cookie the menu keeps the choice in: mints, joined by dots. */
export const WATCH_COOKIE = "wl";

const MINT = /^[1-9A-HJ-NP-Za-km-z]{32,44}$/;

/** The mints a cookie names, well-formed ones only, once each, at most three, in its order; the default without one. */
export function watchKeys(raw: string | null): string[] {
  if (raw == null) return DEFAULT_WATCH.map((q) => lookupToken(q)?.mint ?? "").filter(Boolean);
  return [...new Set(raw.split(".").filter((m) => MINT.test(m)))].slice(0, WATCH_SLOTS);
}

/** A symbol as a tile labels it: Jupiter's, without the "$" some carry. Its own case: cbBTC is not CBBTC. */
function label(symbol: string): string {
  return symbol.replace(/^\$/, "");
}

/** Symbols are Jupiter's, so anyone's who listed a token: escaped. */
function esc(s: string): string {
  return s.replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`);
}

const SUBSCRIPTS = "₀₁₂₃₄₅₆₇₈₉";

/**
 * A price as client/js/num.js tokenPrice writes it, but whole dollars from
 * $1,000 up: a third of a phone's width has no room for a bitcoin's cents,
 * and nobody reads a home-screen tile for them.
 */
function price(v: number): string {
  const a = Math.abs(v);
  if (!Number.isFinite(a) || a <= 0) return "--";
  if (a >= 1000) return `$${Math.round(a).toLocaleString("en-US")}`;
  if (a >= 100) return `$${a.toFixed(0)}`;
  if (a >= 1) return `$${a.toFixed(1)}`;
  const zeros = Math.max(0, -Math.floor(Math.log10(a)) - 1);
  if (zeros < 3) return `$${Number(a.toPrecision(3)).toFixed(Math.min(8, zeros + 3))}`;
  // 0.00000206 → $0.0₅20, two significant digits, as num.js does.
  const digits = String(Math.round(a * 10 ** (zeros + 2))).slice(0, 2);
  const sub = [...String(zeros)].map((d) => SUBSCRIPTS[Number(d)]).join("");
  return `$0.0${sub}${digits}`;
}

/** Signed 24h change. Zero is never signed. */
export function change(v: number): string {
  const a = Math.abs(v);
  if (a === 0) return "0.00%";
  const sign = v < 0 ? "-" : "+";
  const core = a >= 100 ? a.toFixed(1) : a.toFixed(2);
  if (Number(core) === 0) return `${sign}<0.01%`;
  return `${sign}${core}%`;
}

/**
 * Markup for the chosen tiles, in their order, and an empty slot for each one
 * short of three (a mint the index has dropped leaves one). Each goes to the
 * wallet page open on its token (/wallet?t=), by the login page for anyone
 * signed out. Numbers are our own formatting, a mint is base58 and a tint is
 * hex; the symbol is escaped.
 */
export function renderHomeTicker(mints: string[], signed: boolean): string {
  const quotes = new Map(quoteMints(mints).map((t) => [t.mint, t]));
  const tiles = mints.flatMap((m) => {
    const t = quotes.get(m);
    return t ? [tile(t, signed)] : [];
  });
  const empty = '<button class="hm-add" type="button" aria-label="Add an asset"></button>';
  return tiles.join("") + empty.repeat(Math.max(0, WATCH_SLOTS - tiles.length));
}

function tile(t: TopToken, signed: boolean): string {
  const to = `/wallet?t=${t.mint}`;
  const c = t.change24h;
  const delta = c != null ? `<i class="${c > 0 ? "up" : c < 0 ? "dn" : ""}">${change(c)}</i>` : "";
  const tint = t.icon ? iconTint(t.mint) : null;
  return (
    `<a class="hm-t hm-a" href="${signed ? to : authPath("/login", to)}" data-to="${to}" data-m="${t.mint}" data-n="${esc(t.name)}"` +
    `${tint ? ` style="${tint}"` : ""}>` +
    (t.icon ? `<img src="/icon/big/${t.mint}" alt="" width="96" height="96" decoding="async">` : "") +
    `<b>${esc(label(t.symbol))}</b><span>${price(t.price)}</span>${delta}</a>`
  );
}

/**
 * The same tiles, once their logos' colours have been read. iconTint answers
 * only from what it has already read, so a render that did not wait went out
 * graphite whenever it was the first to ask for a mint since a restart, or a
 * mint nobody had chosen yet; the next load then had it.
 */
export async function renderHomeTickerReady(mints: string[], signed: boolean): Promise<string> {
  await tintsOf(mints);
  return renderHomeTicker(mints, signed);
}

/**
 * Reads the tiles' colours off their logos ahead of the first visitor, who
 * would otherwise get graphite tiles while they are read. Tried again as the
 * index and its thumbnails arrive after a cold boot; a colour already read
 * costs nothing.
 */
export function warmHomeTiles(): void {
  for (const ms of [2_000, 15_000, 60_000, 300_000]) {
    setTimeout(() => {
      for (const mint of watchKeys(null)) iconTint(mint);
    }, ms).unref();
  }
}

/** The tokens the buy dialog can spend or receive on the non-token side. */
const FUND_KEYS = ["sol", "usdc"];

/**
 * USD prices for those two, as data attributes on the strip's own tag.
 *
 * The buy dialog states every figure in dollars, and one side of any trade it
 * makes is always SOL or USDC — so it needs their prices to convert. Carried
 * on markup that is already re-rendered per request rather than fetched: a
 * round trip for two numbers, opened over a page that already has them, is
 * not a trade this project makes.
 *
 * Values are our own formatting of a number, so nothing here needs escaping.
 */
export function renderFundPrices(): string {
  let out = "";
  for (const key of FUND_KEYS) {
    const quote = lookupToken(key);
    if (!quote || !Number.isFinite(quote.price) || quote.price <= 0) continue;
    // Six significant figures — far more than two decimals of dollars needs,
    // and enough that a sub-cent token doesn't convert through a zero.
    out += ` data-${key}-usd="${Number(quote.price.toPrecision(6))}"`;
  }
  return out;
}
