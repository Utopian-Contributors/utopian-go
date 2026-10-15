/**
 * Solana token price card — the answer, not a sidebar fact, so it sits above
 * the web results.
 */
import { daySeries, dirOf, lineChart, priceChart } from "./chart.js";
import { el } from "./dom.js";
import { fiat, percent, tokenPrice } from "./num.js";
import { openSwap, swapUrl } from "./swap.js";
import { takePendingBuy } from "./url.js";

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

/**
 * A runner-up's day: the line alone, nothing to scrub. Its card has room for
 * the price and the move, not for the readout and the ranges the leader
 * carries, so it says what the line says and leaves it there.
 *
 * The box is stretched by the row and contributes no height of its own, so
 * the card is sized by its text and the drawing takes whatever that comes to
 * — which is why the chart is drawn rather than fetched.
 *
 * @param {TokenQuote} t
 * @param {string} dir Direction class, shared with the percentage.
 * @returns {HTMLElement | null}
 */
function sparkline(t, dir) {
  const day = daySeries(t);
  if (!day) return null;
  const box = el("div", { class: "pc tk-c" });
  lineChart(box, null).draw(day, dir);
  return box;
}

/**
 * The leading match: the price as the figure, its move, the line to scrub
 * and the ranges under it, with Buy beside the name. Laid out down the card
 * rather than beside the facts, so the line has the card's whole width at
 * any width, phones included.
 *
 * @param {TokenQuote} t
 * @param {HTMLElement} card
 * @param {HTMLElement} head
 * @param {HTMLElement} buy
 * @param {HTMLElement} foot
 */
function leadCard(t, card, head, buy, foot) {
  head.append(buy);
  const fig = el("div", { class: "tk-px" });
  const move = el("span", { class: "pc-m", hidden: true });
  const box = el("div", { class: "pc" });
  const ranges = priceChart(t, fig, move, box);
  const body = el("div", { class: "tk-b" }, fig, move);
  // No line for a mint too new to have a day of history — the card is
  // complete without one, so nothing takes its place.
  if (ranges) body.append(box, ranges);
  body.append(foot);
  card.append(body);
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

  // The trade action is the point of the card: beside the name on the
  // leader, above the metadata on a runner-up, never trailing as one more
  // small grey link.
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

  // The far end of the QR code and the wallet links in swap/main.js. Both carry
  // ?buy=<mint> for exactly this: the phone that scanned or tapped lands on the
  // trade itself, not on a search page with the trade one click further on.
  // Every field the dialog needs is already assembled above, so this costs a
  // comparison rather than a second lookup.
  //
  // A bundle that will not load leaves the card and its Buy button standing,
  // which is the same floor every other entry point degrades to.
  if (takePendingBuy(t.mint)) openSwap(target).catch(() => {});

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
  if (!alt) {
    leadCard(t, card, head, buy, foot);
    return card;
  }

  // A runner-up: the facts, and its day beside them.
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
  const dir = dirOf(t.change24h);
  if (t.change24h != null) {
    row.append(
      el("span", {
        class: `tk-ch${dir ? ` ${dir}` : ""}`,
        text: `${percent(t.change24h, true)} 24h`,
      }),
    );
  }

  const grid = el("div", { class: "tk-g" });
  grid.append(el("div", { class: "tk-b" }, row, buy, foot));
  const chart = sparkline(t, dir);
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
