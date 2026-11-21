/**
 * The home page's watchlist: three asset tiles, and the menu that chooses them.
 *
 * The server renders the three chosen tiles, priced (src/lib/tokens/ticker.ts),
 * from the "wl" cookie this writes: their mints, joined by dots.
 *
 * The menu is an iOS pull-down menu: frosted, rounded, rows with a leading
 * checkmark, opening out of the button's corner. Each row carries its token's
 * logo off its right edge, fading into the menu, as the tiles carry theirs.
 * At its top, the three on the watchlist now, so one can be let go without
 * hunting for it; under them every token the index ranks, busiest on Jupiter
 * first, a page at a time as the list is scrolled (/api/watch). A row brings
 * its price and its logo's colours, so the tile of one picked is drawn here,
 * as the server would have drawn it. Up to three are ticked; once three are,
 * the rest wait until one is unticked.
 *
 * Its own bundle, fetched on the first tap of Edit or of an empty slot
 * (js/watch.js), and published as a global as js/lazy.js expects.
 */
import { $, el } from "../js/dom.js";
import { readName } from "../js/me.js";
import { percent, tokenPrice } from "../js/num.js";

/** @typedef {import('../../src/types').TopToken} TopToken */

const SLOTS = 3;

const CHECK =
  '<svg viewBox="0 0 14 14" width="14" height="14" aria-hidden="true"><path d="M2 7.5 5.5 11 12 3" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/></svg>';

const CSS = `
.wl-m{position:absolute;z-index:50;right:0;width:260px;overflow:auto;
 overscroll-behavior:contain;border-radius:14px;background:rgba(246,246,248,.8);
 -webkit-backdrop-filter:blur(40px) saturate(1.8);backdrop-filter:blur(40px) saturate(1.8);
 box-shadow:0 0 0 .5px rgba(0,0,0,.1),0 14px 44px rgba(0,0,0,.22);transform-origin:top right;
 scrollbar-width:thin;scrollbar-color:var(--sep) transparent;animation:wl-in .36s var(--out)}
.wl-m.up{transform-origin:bottom right}
@keyframes wl-in{from{opacity:0;scale:.5}}
.wl-m p{margin:0;padding:11px 16px 9px;font-size:13px;line-height:1.2;color:var(--f)}
.wl-m .wl-h{padding:10px 16px 6px;border-top:8px solid rgba(var(--rgb),.06);font-weight:600}
.wl-o{position:relative;isolation:isolate;overflow:hidden;display:grid;grid-template-columns:22px 1fr;
 align-items:center;gap:4px;width:100%;min-height:52px;padding:0 64px 0 12px;border:0;
 border-top:.5px solid var(--sep);border-radius:0;background:none;color:var(--t);text-align:left;
 font:17px/1.15 var(--ff);letter-spacing:-.01em;cursor:pointer;--press:1}
.wl-h+div>.wl-o:first-child{border-top:0}
.wl-o:hover,.wl-o:focus-visible{background:var(--wash);outline:0}
.wl-o:active:not(:disabled){background:var(--wash2)}
.wl-o:disabled{cursor:default}
.wl-o:disabled>:not(img){opacity:.35}
.wl-o svg{visibility:hidden}
.wl-o[aria-checked=true] svg{visibility:visible}
.wl-o span{min-width:0;overflow:hidden;white-space:nowrap;text-overflow:ellipsis}
.wl-o small{display:block;margin-top:2px;overflow:hidden;font-size:13px;color:var(--f);letter-spacing:0;
 white-space:nowrap;text-overflow:ellipsis}
.wl-o img{position:absolute;z-index:-1;top:50%;right:-14px;width:72px;height:72px;margin-top:-36px;
 border-radius:50%;opacity:.85;pointer-events:none;
 -webkit-mask-image:linear-gradient(to left,#000 25%,transparent 90%);mask-image:linear-gradient(to left,#000 25%,transparent 90%)}
.wl-o:disabled img{opacity:.3}
.wl-m .wl-end{min-height:52px;padding:0 16px;display:flex;align-items:center;justify-content:center;
 border:0;border-top:.5px solid var(--sep);background:none;color:var(--f);font:15px var(--ff);width:100%}
@media (prefers-color-scheme:dark){.wl-m{background:rgba(38,38,40,.78);box-shadow:0 0 0 .5px rgba(255,255,255,.1),0 14px 44px rgba(0,0,0,.5)}}
@media (prefers-reduced-motion:reduce){.wl-m{animation:none}}
`;

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
      t.icon && el("img", { src: `/icon/${t.mint}`, alt: "", width: "64", height: "64", decoding: "async" }),
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
      t.icon && el("img", { src: `/icon/${t.mint}`, alt: "", loading: "lazy", decoding: "async" }),
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
    document.head.append(el("style", { text: CSS }));
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

  /**
   * Out of Edit's corner, downwards, unless there is more room above and too
   * little below for the whole menu, as an iOS menu flips near the screen's
   * foot; and no taller than the side it opens to, scrolling inside past that.
   * @param {HTMLElement} m
   */
  function place(m) {
    const at = edit.getBoundingClientRect();
    const box = section.getBoundingClientRect();
    const below = innerHeight - at.bottom - 16;
    const above = at.top - 16;
    // The list goes on, so it always wants the full height.
    const up = below < 420 && above > below;
    m.classList.toggle("up", up);
    m.style.maxHeight = `${Math.max(160, Math.min(420, up ? above : below))}px`;
    m.style.top = up ? "" : `${at.bottom - box.top + 6}px`;
    m.style.bottom = up ? `${box.bottom - at.top + 6}px` : "";
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
    if (e.key !== "ArrowDown" && e.key !== "ArrowUp") return;
    e.preventDefault();
    const live = rows().filter((r) => !r.disabled);
    const at = live.indexOf(/** @type {HTMLButtonElement} */ (document.activeElement));
    live[(at + (e.key === "ArrowDown" ? 1 : -1) + live.length) % live.length]?.focus();
  }

  return (onlyOpen) => (menu?.isConnected ? !onlyOpen && close() : open());
}

/** @type {((onlyOpen: boolean) => void) | undefined} */
let toggle;

window.__wl = {
  /**
   * @param {HTMLElement} section #hm-wl
   * @param {boolean} onlyOpen an empty slot's tap, which leaves an open menu open
   */
  toggle(section, onlyOpen) {
    (toggle ??= mount(section))(onlyOpen);
  },
};
