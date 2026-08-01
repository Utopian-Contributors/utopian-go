/**
 * Solana token price card — the answer, not a sidebar fact, so it sits above
 * the web results.
 */
import { el } from "./dom.js";
import { fiat, percent, tokenPrice } from "./num.js";

/** @typedef {import('../../src/types').TokenQuote} TokenQuote */

/** @param {string} mint */
function shortMint(mint) {
  return mint.length > 12 ? `${mint.slice(0, 4)}…${mint.slice(-4)}` : mint;
}

/**
 * @param {TokenQuote} t
 * @param {boolean} [alt] Runner-up rather than the leading match.
 * @returns {HTMLElement}
 */
function tokenCard(t, alt) {
  const card = el("article", { class: alt ? "tk tk-alt" : "tk" });

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
  card.append(foot);

  return card;
}

/**
 * All matching tokens, best first, as one fragment.
 *
 * Stacked rather than laid out in a horizontal strip: a scroll row hides its
 * own contents behind a gesture desktop mice don't have, and these are
 * alternatives to compare, not a carousel to browse.
 *
 * Grouped in their own element so the alternatives sit tight against the leader
 * and the results list's wider gap falls after the whole set.
 *
 * @param {TokenQuote[]} list
 * @returns {HTMLElement}
 */
export function tokenCards(list) {
  const group = el("div", { class: "tkg" });
  list.forEach((t, i) => group.append(tokenCard(t, i > 0)));
  return group;
}
