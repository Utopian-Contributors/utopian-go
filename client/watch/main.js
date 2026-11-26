/**
 * The home page's watchlist: three asset tiles, and the menu that chooses them.
 *
 * The server renders the three chosen tiles, priced (src/lib/tokens/ticker.ts),
 * from the "wl" cookie this writes: their mints, joined by dots.
 *
 * The menu is an iOS pull-down menu (watch/menu.js). Each row carries its token's
 * logo off its right edge, fading into the menu, as the tiles carry theirs.
 * At its top, the three on the watchlist now, so one can be let go without
 * hunting for it; under them every token the index ranks, busiest on Jupiter
 * first, a page at a time as the list is scrolled (/api/watch). A row brings
 * its price and its logo's colours, so the tile of one picked is drawn here,
 * as the server would have drawn it. Up to three are ticked; once three are,
 * the rest wait until one is unticked.
 *
 * Its own bundle, fetched on the first tap of Edit or of an empty slot
 * (js/watch.js), and published as a global as js/lazy.js expects. The news
 * section's menu (watch/news.js) rides in it: the same menu, choosing topics.
 */
import { $, el } from "../js/dom.js";
import { readName } from "../js/me.js";
import { percent, tokenPrice } from "../js/num.js";
import { CHECK, place as placeAt, style, walk } from "./menu.js";
import { mountNews } from "./news.js";

/** @typedef {import('../../src/types').TopToken} TopToken */

const SLOTS = 3;

/** A symbol as a tile labels it: without the "$" some carry, in its own case, as ticker.ts does. */
const label = (/** @type {string} */ symbol) => symbol.replace(/^\$/, "");

/**
 * @param {HTMLElement} section #hm-wl
 * @returns {(onlyOpen: boolean) => void} opens the menu, or closes it if it is open and may be
 */
function mount(section) {
  const grid = /** @type {HTMLElement} */ ($("hm-tk"));
  const edit = /** @type {HTMLElement} */ ($("hm-ed"));

  /** Every token a row has been drawn for, by mint: what a picked one's tile is drawn from. */
  /** @type {Map<string, TopToken>} */
  const known = new Map();

  /** @type {HTMLElement | null} */
  let menu = null;
  /** The three at the top, redrawn each time the menu opens. */
  const mine = el("div");
  /** The ranked list, kept across openings, and where it goes on from. */
  const list = el("div");
  const end = /** @type {HTMLButtonElement} */ (el("button", { type: "button", class: "wl-end", tabindex: "-1", text: "Loading…" }));
  const note = el("p", { id: "wl-n" });
  /** Where the next page starts; "" before the first, null after the last. */
  /** @type {string | null} */
  let after = "";
  let busy = false;

  /** @returns {HTMLAnchorElement[]} the tiles, in the row's order */
  const tiles = () => /** @type {HTMLAnchorElement[]} */ ([...grid.querySelectorAll(".hm-a")]);
  const chosen = () => tiles().map((a) => a.dataset.m ?? "");
  const rows = () => /** @type {HTMLButtonElement[]} */ ([...(menu?.querySelectorAll(".wl-o") ?? [])]);

  /** A tile for a token, the markup src/lib/tokens/ticker.ts writes. @param {TopToken} t */
  function tile(t) {
    const to = `/wallet?t=${t.mint}`;
    const href = readName() ? to : `/login?next=${encodeURIComponent(to).replace(/%2F/gi, "/")}`;
    const a = el(
      "a",
      { class: "hm-t hm-a", href, "data-to": to, "data-m": t.mint, "data-n": t.name, style: t.tint },
      t.icon && el("img", { src: `/icon/big/${t.mint}`, alt: "", width: "96", height: "96", decoding: "async" }),
      el("b", { text: label(t.symbol) }),
      // Whole dollars from $1,000 up, as the server writes them: a third of a
      // phone's width has no room for a bitcoin's cents.
      el("span", { text: t.price >= 1000 ? `$${Math.round(t.price).toLocaleString("en-US")}` : tokenPrice(t.price).text }),
      t.change24h != null &&
        el("i", { class: t.change24h > 0 ? "up" : t.change24h < 0 ? "dn" : "", text: percent(t.change24h, true) }),
    );
    return a;
  }

  /** Shows these tiles in this order and an empty slot for each one short. @param {string[]} mints */
  function lay(mints) {
    const have = new Map(tiles().map((a) => [a.dataset.m, a]));
    const shown = mints.flatMap((m) => {
      const old = have.get(m);
      const t = known.get(m);
      return old ? [old] : t ? [tile(t)] : [];
    });
    grid.replaceChildren(
      ...shown,
      ...Array.from({ length: SLOTS - shown.length }, () =>
        el("button", { type: "button", class: "hm-add", "aria-label": "Add an asset" }),
      ),
    );
  }

  function paint() {
    const mints = chosen();
    const full = mints.length >= SLOTS;
    for (const row of rows()) {
      const on = mints.includes(row.dataset.m ?? "");
      row.setAttribute("aria-checked", String(on));
      row.disabled = full && !on;
    }
    note.textContent = full ? "Untick one to choose another" : `Choose ${SLOTS - mints.length} more`;
  }

  function pick(/** @type {string} */ mint) {
    const mints = chosen();
    const at = mints.indexOf(mint);
    if (at >= 0) mints.splice(at, 1);
    else if (mints.length < SLOTS) mints.push(mint);
    else return;
    lay(mints);
    document.cookie = `wl=${mints.join(".")};path=/;max-age=31536000;samesite=lax`;
    paint();
  }

  /** A row: the check, the name over its symbol, the logo. @param {{ mint: string, symbol: string, name: string, icon?: unknown }} t */
  function row(t) {
    const r = el(
      "button",
      { type: "button", class: "wl-o", role: "menuitemcheckbox", "data-m": t.mint, onclick: () => pick(t.mint) },
      t.icon && el("img", { src: `/icon/big/${t.mint}`, alt: "", loading: "lazy", decoding: "async" }),
      el("span", { text: t.name || label(t.symbol) }, el("small", { text: label(t.symbol) })),
    );
    r.insertAdjacentHTML("afterbegin", CHECK);
    return r;
  }

  /** The next page of the ranked list, appended; the end row says when there is no more, or that it failed. */
  async function more() {
    if (busy || after == null) return;
    busy = true;
    end.textContent = "Loading…";
    try {
      const res = await fetch(`/api/watch${after ? `?after=${encodeURIComponent(after)}` : ""}`, {
        headers: { Accept: "application/json" },
      });
      if (!res.ok) throw new Error(String(res.status));
      /** @type {import('../../src/types').TokenPage} */
      const page = await res.json();
      for (const t of page.tokens) known.set(t.mint, t);
      list.append(...page.tokens.map(row));
      after = page.after ?? null;
      if (after == null) end.remove();
      paint();
    } catch {
      end.textContent = "Couldn’t load. Tap to retry";
    } finally {
      busy = false;
    }
    // A short page can leave the end in view, where the observer will not fire again.
    if (after != null && menu && end.getBoundingClientRect().top < menu.getBoundingClientRect().bottom + 200) void more();
  }

  function build() {
    style();
    end.addEventListener("click", () => void more());
    const m = el(
      "div",
      { class: "wl-m", role: "menu", "aria-labelledby": "hm-ed", "aria-describedby": "wl-n" },
      note,
      mine,
      el("p", { class: "wl-h", text: "Busiest on Jupiter" }),
      list,
      end,
    );
    // Infinite scroll: the next page is asked for as the end row nears the menu's foot.
    new IntersectionObserver((seen) => seen.some((e) => e.isIntersecting) && void more(), {
      root: m,
      rootMargin: "0px 0px 200px",
    }).observe(end);
    return m;
  }

  function open() {
    if (menu?.isConnected) return;
    menu ??= build();
    mine.replaceChildren(
      ...tiles().map((a) =>
        row({ mint: a.dataset.m ?? "", symbol: a.querySelector("b")?.textContent ?? "", name: a.dataset.n ?? "", icon: !!a.querySelector("img") }),
      ),
    );
    paint();
    section.append(menu);
    place(menu);
    edit.setAttribute("aria-expanded", "true");
    menu.scrollTop = 0;
    rows().find((r) => !r.disabled)?.focus({ preventScroll: true });
    document.addEventListener("pointerdown", outside, true);
    document.addEventListener("keydown", keys);
    void more();
  }

  /** Out of Edit's corner. The list goes on, so it always wants the full height. @param {HTMLElement} m */
  function place(m) {
    placeAt(m, edit, section);
  }

  function close(refocus = false) {
    if (!menu?.isConnected) return;
    menu.remove();
    edit.setAttribute("aria-expanded", "false");
    document.removeEventListener("pointerdown", outside, true);
    document.removeEventListener("keydown", keys);
    if (refocus) edit.focus();
  }

  /** @param {PointerEvent} e */
  function outside(e) {
    const t = /** @type {Node} */ (e.target);
    // Edit and the empty slots answer their own taps (js/watch.js).
    if (!menu?.contains(t) && !edit.contains(t) && !(t instanceof Element && t.closest(".hm-add"))) close();
  }

  /** Escape closes; the arrows walk the rows that can be chosen. @param {KeyboardEvent} e */
  function keys(e) {
    if (e.key === "Escape") return close(true);
    if ((e.key === "ArrowDown" || e.key === "ArrowUp") && menu) walk(e, menu);
  }

  return (onlyOpen) => (menu?.isConnected ? !onlyOpen && close() : open());
}

/** @type {((onlyOpen: boolean) => void) | undefined} */
let toggle;
/** @type {(() => void) | undefined} */
let news;

window.__wl = {
  /**
   * @param {HTMLElement} section #hm-wl
   * @param {boolean} onlyOpen an empty slot's tap, which leaves an open menu open
   */
  toggle(section, onlyOpen) {
    (toggle ??= mount(section))(onlyOpen);
  },
  /** @param {HTMLElement} section #hm-ns */
  news(section) {
    (news ??= mountNews(section))();
  },
};
