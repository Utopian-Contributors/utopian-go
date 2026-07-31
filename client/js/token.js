/**
 * Solana token price card — the answer, not a sidebar fact, so it sits above
 * the web results.
 */
import { el } from "./dom.js";
import { fiat, percent, tokenPrice } from "./num.js";

/** @typedef {import('../../src/types').TokenQuote} TokenQuote */

/** @param {number} seconds */
function freshness(seconds) {
  if (seconds < 90) return `${seconds}s ago`;
  if (seconds < 5400) return `${Math.round(seconds / 60)}m ago`;
  return `${Math.round(seconds / 3600)}h ago`;
}

/** @param {string} mint */
function shortMint(mint) {
  return mint.length > 12 ? `${mint.slice(0, 4)}…${mint.slice(-4)}` : mint;
}

/**
 * @param {TokenQuote} t
 * @returns {HTMLElement}
 */
export function tokenCard(t) {
  const card = el("article", { class: "tk" });

  const head = el("div", { class: "tk-h" });
  head.append(el("span", { class: "tk-sym", text: t.symbol }));
  if (t.name && t.name !== t.symbol) {
    head.append(el("span", { class: "tk-nm", text: t.name }));
  }
  card.append(head);

  const row = el("div", { class: "tk-r" });
  const price = tokenPrice(t.price);
  row.append(
    el("span", {
      class: "tk-px",
      text: price.text,
      // Abbreviated or subscripted displays keep the exact value reachable.
      ...(price.title ? { title: price.title } : {}),
      ...(price.label ? { "aria-label": price.label } : {}),
    }),
  );

  if (t.change24h != null) {
    const dir = t.change24h > 0 ? "up" : t.change24h < 0 ? "dn" : "";
    row.append(
      el("span", {
        class: `tk-ch${dir ? ` ${dir}` : ""}`,
        text: `${percent(t.change24h, true)} 24h`,
      }),
    );
  }
  card.append(row);

  const foot = el("div", { class: "tk-f" });
  if (t.mcap != null) {
    foot.append(el("span", { text: `Mkt cap ${fiat(t.mcap)}` }));
  }
  foot.append(
    el("a", {
      href: `https://solscan.io/token/${encodeURIComponent(t.mint)}`,
      target: "_blank",
      rel: "noopener",
      title: t.mint,
      text: shortMint(t.mint),
    }),
  );
  foot.append(
    el("span", {
      class: "tk-ag",
      title: `Price sourced ${t.age}s ago`,
      text: freshness(t.age),
    }),
  );
  card.append(foot);

  return card;
}
