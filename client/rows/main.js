/**
 * The wallet page's Movers and New rows: a page of cards more each time a row
 * nears its end. Its own bundle because both rows sit below the fold, and
 * their paging kept wallet.js over its first-flight guardrail; the page asks
 * for it with load("rw", "__rows") as it starts, and the cards follow a
 * request later. The cards themselves stay in wallet/main.js, which knows
 * which token is open, and come in through `card`.
 *
 * Published as a global rather than imported, because js/lazy.js fetches
 * bundles as plain scripts.
 */
import { el } from "../js/dom.js";

/** Cards added to a featured row at a time, the server's page (FEATURED_PAGE). */
const FEATURED_PAGE = 20;

/** How long a market has been open, in its largest whole unit. */
function age(at) {
  const m = Math.max(0, (Date.now() - at) / 60_000);
  if (m < 60) return `${Math.max(1, Math.floor(m))}m`;
  if (m < 48 * 60) return `${Math.floor(m / 60)}h`;
  if (m < 60 * 24 * 60) return `${Math.floor(m / 1440)}d`;
  if (m < 365 * 24 * 60) return `${Math.floor(m / 43_200)}mo`;
  return `${Math.floor(m / 525_600)}y`;
}

/**
 * Movers or New: a page more each time the row comes within a screen of its
 * end, to the most the server gives (100); past that, it runs on from its
 * first card again, lap after lap. A row that fits whole does not repeat.
 *
 * @param {string} key the server's name for the row
 * @param {HTMLElement} box
 * @param {(t: import('../../src/types').TopToken) => HTMLElement} card
 * @param {() => void} edges repaints the rows' blurred ends
 */
function featuredRow(key, box, card, edges) {
  /** @type {import('../../src/types').TopToken[]} */
  const got = [];
  let more = true;
  let busy = false;
  let shown = 0;

  /** One page more, fetched or a lap's; whether the row grew. */
  async function grow() {
    if (more) {
      const res = await fetch(`/api/tokens/featured?s=${key}&o=${got.length}`, { headers: { Accept: "application/json" } });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error);
      const rows = data.tokens ?? [];
      more = Boolean(data.more) && rows.length > 0;
      if (!rows.length) {
        if (!got.length) box.replaceChildren(el("p", { class: "wl-n", text: "Nothing here right now." }));
        return false;
      }
      // The first page over whatever the row said while it was empty.
      if (got.length) box.append(...rows.map(card));
      else box.replaceChildren(...rows.map(card));
      got.push(...rows);
      shown += rows.length;
      return true;
    }
    if (!got.length || box.scrollWidth <= box.clientWidth) return false;
    const lap = Array.from({ length: FEATURED_PAGE }, (_, i) => got[(shown + i) % got.length]);
    box.append(...lap.map(card));
    shown += lap.length;
    return true;
  }

  async function near() {
    if (busy || box.scrollLeft + box.clientWidth < box.scrollWidth - box.clientWidth) return;
    busy = true;
    let grew = false;
    try {
      grew = await grow();
    } catch {
      // On the next scroll, again; with nothing in the row yet, say so.
      if (!got.length) box.replaceChildren(el("p", { class: "wl-n", text: "Could not load these." }));
    }
    busy = false;
    edges();
    if (grew) void near();
  }

  box.addEventListener("scroll", () => void near(), { passive: true });
  void near();
}

window.__rows = { featured: featuredRow, age };
