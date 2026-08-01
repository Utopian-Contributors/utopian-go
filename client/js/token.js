/**
 * Solana token price card — the answer, not a sidebar fact, so it sits above
 * the web results.
 */
import { el } from "./dom.js";
import { fiat, percent, tokenPrice } from "./num.js";
import { openSwap } from "./swap.js";

/** @typedef {import('../../src/types').TokenQuote} TokenQuote */

/** @param {string} mint */
function shortMint(mint) {
  return mint.length > 12 ? `${mint.slice(0, 4)}…${mint.slice(-4)}` : mint;
}

/** Wrapped SOL. Swapping SOL for SOL is not a trade, so the pair flips. */
const SOL_MINT = "So11111111111111111111111111111111111111112";
const USDC_MINT = "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v";

/**
 * What to fund the purchase with. SOL buys everything except itself.
 *
 * Both sides are needed as mints for the Plugin, which takes addresses rather
 * than symbols. The fallback URL keeps the symbol on the input side because
 * that is the form jup.ag's own referral examples use.
 *
 * @param {string} mint
 */
/**
 * Deeplink into Jupiter's hosted swap UI.
 *
 * The fallback the button degrades to, not the primary path — a normal click
 * opens our own dialog. It stays a real href so middle-click, cmd-click, no JS
 * and a blocked bundle all still reach a working swap. SOL cannot be bought
 * with SOL, so that one pair is funded with USDC.
 */
function swapUrl(mint) {
  const path =
    mint === SOL_MINT ? "USDC-SOL" : `SOL-${encodeURIComponent(mint)}`;
  return `https://jup.ag/swap/${path}`;
}

/**
 * Open the buy dialog on a plain click; leave every other gesture to the
 * browser.
 *
 * Modifier- and middle-clicks mean "open this elsewhere", so they keep the
 * href. So does a bundle that refuses to load — jup.ag is always the floor.
 *
 * @param {MouseEvent} e
 * @param {HTMLElement} link
 * @param {{mint: string, symbol: string, decimals?: number, fallback: string}} t
 */
async function buyClick(e, link, t) {
  if (e.metaKey || e.ctrlKey || e.shiftKey || e.altKey || e.button !== 0) return;
  e.preventDefault();

  link.classList.add("is-ld");
  link.setAttribute("aria-busy", "true");
  try {
    await openSwap(t);
  } catch {
    window.location.href = link.href;
  } finally {
    link.classList.remove("is-ld");
    link.removeAttribute("aria-busy");
  }
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

  // The trade action is the point of the card, so it sits above the metadata
  // rather than trailing it as one more small grey link.
  const href = swapUrl(t.mint);
  const target = {
    mint: t.mint,
    symbol: t.symbol,
    fallback: href,
    ...(t.decimals != null ? { decimals: t.decimals } : {}),
  };
  const buy = el("a", {
    class: "tk-buy",
    href,
    target: "_blank",
    rel: "noopener",
    text: `Buy ${t.symbol}`,
    onclick: (e) => buyClick(e, buy, target),
  });
  card.append(buy);

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
