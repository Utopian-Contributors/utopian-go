/**
 * The cards under a post that calls out a ticker ($SOL): the coin's logo,
 * what it trades at now, and the profit since the post went up.
 *
 * Its own bundle, fetched by social.js the first time a post on screen calls
 * one out, so a timeline without any pays nothing for it. A post carries each
 * ticker's mint and its price when posted (src/social/callouts.ts); the price
 * now comes from /api/quotes, one request for every card drawn in the same
 * turn, so a page of posts asks once however many tickers it names.
 *
 * The composer draws the same cards under a draft, before it is posted, from
 * /api/callouts: the draft's tickers resolved as posting will resolve them.
 */
import { coinIcon } from "../js/coin.js";
import { el } from "../js/dom.js";
import { percent, tokenPrice } from "../js/num.js";
import { injectStyles } from "../js/ui.js";
import CSS from "./coins.css";

/** What /api/quotes takes in one request. */
const PER_ASK = 60;
/** A quote this young is drawn again without asking; the server holds its own for 30 s. */
const FRESH_MS = 30_000;

/** Prices now, by mint, and when they were read. */
const known = new Map();
/** Boxes waiting on the next request, with the tickers they hold. */
let queue = [];

/**
 * @param {{ mint: string, symbol: string, price: number }} call the ticker as it was posted
 * @param {{ mint: string, symbol: string, name: string, price: number, icon?: boolean }} token the index now
 * @param {boolean} [draft] under the composer: a preview, which opens nothing and was posted at no price yet
 */
function card(call, token, draft) {
  injectStyles("cc-css", CSS);
  const now = tokenPrice(token.price);
  const move = (token.price / call.price - 1) * 100;
  return el(
    draft ? "div" : "a",
    draft
      ? { class: "cc" }
      : {
          class: "cc",
          // By mint, not symbol: symbols collide, and the wallet page's chart answers for a mint.
          href: `/wallet?t=${encodeURIComponent(token.mint)}`,
          title: `${token.symbol} was ${tokenPrice(call.price).text} when this was posted`,
        },
    coinIcon(token, 32, "cc-ic", "cc-coin"),
    el("span", { class: "cc-id" }, el("b", { text: token.symbol }), el("small", { text: token.name })),
    el(
      "span",
      { class: "cc-q" },
      el("span", { text: now.text, "aria-label": now.label }),
      el("small", {}, "Profit ", el("i", { class: move > 0 ? "up" : move < 0 ? "dn" : "", text: percent(move, true) })),
    ),
  );
}

/** Each box's cards, or the box gone when the index no longer prices any of its tickers. */
function paint(box, coins) {
  const cards = coins.map((call) => known.has(call.mint) && card(call, known.get(call.mint).token)).filter(Boolean);
  if (cards.length) box.replaceChildren(...cards);
  else box.remove();
}

/** One request for every mint the waiting boxes need that is not already fresh, then every box. */
async function flush() {
  // A post drawn only for its buttons (social.js's react) is never put on the page.
  const batch = queue.filter(({ box }) => box.isConnected);
  queue = [];
  const now = Date.now();
  const want = [...new Set(batch.flatMap(({ coins }) => coins.map((c) => c.mint)))].filter(
    (mint) => !(now - (known.get(mint)?.at ?? 0) < FRESH_MS),
  );
  const asks = [];
  for (let i = 0; i < want.length; i += PER_ASK) {
    asks.push(
      fetch(`/api/quotes?m=${want.slice(i, i + PER_ASK).join(",")}`, { headers: { Accept: "application/json" } })
        .then((res) => (res.ok ? res.json() : { tokens: [] }))
        .then((data) => {
          for (const token of data.tokens) known.set(token.mint, { at: now, token });
        }),
    );
  }
  // A failed ask leaves a stale quote standing, or no card; the post above it reads the same either way.
  await Promise.allSettled(asks);
  for (const { box, coins } of batch) if (box.isConnected) paint(box, coins);
}

/**
 * Fill `box`, social.js's placeholder under a post, with its tickers' cards.
 * Every box handed over in the same turn shares one request.
 * @param {HTMLElement} box
 * @param {{ mint: string, symbol: string, price: number }[]} coins
 */
function fill(box, coins) {
  if (!queue.length) setTimeout(flush);
  queue.push({ box, coins });
}

/** Answers for drafts, by their tickers, so typing back to an earlier draft asks nothing. */
const drafts = new Map();

/**
 * What a draft's tickers come to: each card's quote now, and the mint each
 * ticker went to. A failed ask is not kept, so the next keystroke tries again.
 * @param {string[]} tickers as typed, in order
 * @returns {Promise<{ tokens: object[], named: Record<string, string> }>}
 */
function ask(tickers) {
  const key = tickers.join(",");
  if (!drafts.has(key)) {
    const answer = fetch(`/api/callouts?t=${encodeURIComponent(key)}`, { headers: { Accept: "application/json" } }).then(
      (res) => (res.ok ? res.json() : Promise.reject(new Error(String(res.status)))),
    );
    answer.catch(() => drafts.delete(key));
    drafts.set(key, answer);
  }
  return drafts.get(key);
}

window.__coins = { fill, ask, card };
