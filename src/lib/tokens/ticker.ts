import { lookupToken } from "./store";

/**
 * Home-page price strip, rendered server-side into index.html.
 *
 * The home page otherwise issues no requests at all, so fetching these would
 * cost a whole extra round trip on the most-visited page — and a client-side
 * render would cost one anyway, since app.js only arrives on the second trip.
 * Baking the markup into the shell means prices are on screen at first paint,
 * with zero requests and zero client JS.
 */

/** Display label → the query the matcher already knows how to resolve. */
const STRIP = [
  { label: "BTC", query: "btc" },
  { label: "ETH", query: "eth" },
  { label: "SOL", query: "sol" },
];

/**
 * Compact USD price, following the same tiers as the client formatter for
 * values at or above $1 — which is all these majors ever are. Sub-dollar
 * values fall back to 3 significant digits rather than zero-subscript, since
 * nothing on this strip can reach that range.
 */
function price(v: number): string {
  const a = Math.abs(v);
  if (!Number.isFinite(a) || a <= 0) return "--";
  if (a >= 1000) {
    return `$${a.toLocaleString("en-US", {
      minimumFractionDigits: 2,
      maximumFractionDigits: 2,
    })}`;
  }
  if (a >= 100) return `$${a.toFixed(0)}`;
  if (a >= 1) return `$${a.toFixed(1)}`;
  return `$${Number(a.toPrecision(3))}`;
}

/** Signed 24h change. Zero is never signed. */
function change(v: number): string {
  const a = Math.abs(v);
  if (a === 0) return "0.00%";
  const sign = v < 0 ? "-" : "+";
  const core = a >= 100 ? a.toFixed(1) : a.toFixed(2);
  if (Number(core) === 0) return `${sign}<0.01%`;
  return `${sign}${core}%`;
}

/**
 * Markup for the strip. Every value is produced by Number formatting against a
 * fixed label set, so there is no untrusted text to escape.
 */
export function renderHomeTicker(): string {
  const cells: string[] = [];

  for (const { label, query } of STRIP) {
    const quote = lookupToken(query);
    // Index not warm yet, or no confident match — drop the cell rather than
    // render a placeholder that shifts when it fills in.
    if (!quote) continue;

    const delta =
      quote.change24h != null
        ? `<i class="${quote.change24h > 0 ? "up" : quote.change24h < 0 ? "dn" : ""}">${change(quote.change24h)}</i>`
        : "";

    cells.push(
      `<a href="/?q=${label.toLowerCase()}"><b>${label}</b>${price(quote.price)}${delta}</a>`,
    );
  }

  return cells.join("");
}
