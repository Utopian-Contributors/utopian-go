/**
 * Solana token price card — the answer, not a sidebar fact, so it sits above
 * the web results.
 */
import { el } from "./dom.js";
import { fiat, percent, tokenPrice } from "./num.js";
import { openSwap, swapUrl } from "./swap.js";

/** @typedef {import('../../src/types').TokenQuote} TokenQuote */

/** @param {string} mint */
function shortMint(mint) {
  return mint.length > 12 ? `${mint.slice(0, 4)}…${mint.slice(-4)}` : mint;
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

/** Gradient ids have to be unique within the document. */
let chartSeq = 0;

/**
 * The 24h line.
 *
 * SVG rather than an image because the card's height is whatever its text
 * needs, and only a vector can take that height without being stretched or
 * cropped to fit it. `preserveAspectRatio="none"` lets the drawing fill the
 * box exactly, and the stroke opts back out of that scaling in CSS so the
 * line keeps one weight whatever shape the box turns out to be.
 *
 * Only geometry is written here — stroke, fill, the gradient's colours and
 * the room kept above and below the line are all stylesheet, which is both
 * fewer bytes in the bundle and the reason the line is the same --go / --dn
 * as the percentage beside it in either theme.
 *
 * @param {TokenQuote} t
 * @param {string} dir Direction class, shared with the percentage.
 * @returns {HTMLElement | null}
 */
function tokenChart(t, dir) {
  // x is the hour, y is the byte flipped. No scaling arithmetic — that is
  // what the viewBox is for.
  const pts = [...atob(t.ticks)].map((c, i) => `${i},${255 - c.charCodeAt(0)}`);
  if (pts.length < 2) return null;

  const line = pts.join("L");
  const last = pts.length - 1;
  const id = `tkc${(chartSeq += 1)}`;

  const box = el("div", { class: `tk-c${dir ? ` ${dir}` : ""}` });
  // Every value interpolated below is a number this function computed, or the
  // id it just minted.
  box.innerHTML =
    `<svg viewBox="0 0 ${last} 255" preserveAspectRatio="none"` +
    ` aria-hidden="true"><linearGradient id="${id}" x2="0" y2="1">` +
    `<stop/><stop offset="1"/></linearGradient>` +
    `<path d="M${line}L${last},255L0,255Z" fill="url(#${id})"/>` +
    `<path d="M${line}"/></svg>`;
  return box;
}

/**
 * @param {TokenQuote} t
 * @param {boolean} [alt] Runner-up rather than the leading match.
 * @returns {HTMLElement}
 */
function tokenCard(t, alt) {
  const card = el("article", { class: alt ? "tk tk-alt" : "tk" });

  // Naming the token spans the card. Inside the grid its width became the
  // facts column's floor, and a token with a company for a name left the
  // chart nothing to draw in.
  const head = el("div", { class: "tk-h" });
  head.append(el("span", { class: "tk-sym", text: t.symbol }));
  if (t.name && t.name !== t.symbol) {
    head.append(el("span", { class: "tk-nm", text: t.name }));
  }
  card.append(head);

  // The stack of facts, unchanged — it just shares the row with the chart now.
  const body = el("div", { class: "tk-b" });

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

  // One direction for the whole card: the number and the line are the same
  // claim, so they read it off the same expression.
  const dir =
    t.change24h == null ? "" : t.change24h > 0 ? "up" : t.change24h < 0 ? "dn" : "";

  if (t.change24h != null) {
    row.append(
      el("span", {
        class: `tk-ch${dir ? ` ${dir}` : ""}`,
        text: `${percent(t.change24h, true)} 24h`,
      }),
    );
  }
  body.append(row);

  // The trade action is the point of the card, so it sits above the metadata
  // rather than trailing it as one more small grey link.
  const href = swapUrl(t.mint);
  const target = {
    mint: t.mint,
    symbol: t.symbol,
    fallback: href,
    ...(t.decimals != null ? { decimals: t.decimals } : {}),
    // What the buy dialog converts this side of a trade into dollars with.
    ...(Number.isFinite(t.price) ? { price: t.price } : {}),
  };
  const buy = el("a", {
    class: "tk-buy",
    href,
    target: "_blank",
    rel: "noopener",
    text: `Buy ${t.symbol}`,
    onclick: (e) => buyClick(e, buy, target),
  });
  body.append(buy);

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
  body.append(foot);

  const grid = el("div", { class: "tk-g" });
  grid.append(body);
  // No line for a mint too new to have a day of history — the card is
  // complete without one, so nothing takes its place.
  const chart = t.ticks ? tokenChart(t, dir) : null;
  if (chart) grid.append(chart);
  card.append(grid);

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
