/**
 * The home page's news menu: which topics the four cards are.
 *
 * The server renders the cards (src/lib/news.ts) from the "nw" cookie this
 * writes: the watched topics' slugs, joined by dots, at most four, their
 * cards first; the busiest topics on 40 Newsroom fill the places left. No
 * cookie is Auto: the four busiest, whatever they are now.
 *
 * The same pull-down menu as the watchlist's (watch/menu.js). At its top,
 * Auto, ticked while nothing is watched, and choosing it lets every watched
 * topic go; under it the topics watched now, so one can be let go without
 * hunting for it; under them every topic the menu offers, busiest first
 * (/api/news/topics). Up to four are ticked; once four are, the rest wait
 * until one is unticked, and unticking the last is Auto again.
 *
 * A change asks the server for the cards as it would now render them
 * (/api/news/cards) and swaps them in; a topic no one has watched before
 * costs it a request to 40 Newsroom, so the answer can take a moment, and
 * the old cards stay, dimmed, until it comes.
 */
import { $, el } from "../js/dom.js";
import { CHECK, place, style, walk } from "./menu.js";

/** @typedef {{ slug: string, name: string, kind: string, n: number }} NewsTopic */

const SLOTS = 4;
const COOKIE = "nw";

/** What 40 Newsroom files a topic under, as a row's second line says it. */
const KINDS = /** @type {Record<string, string>} */ ({ country: "Country", stock: "Stock", crypto: "Crypto", topic: "Topic" });

/** The watched topics, as the cookie names them. */
function readPicks() {
  const raw = document.cookie.split("; ").find((c) => c.startsWith(`${COOKIE}=`))?.slice(COOKIE.length + 1) ?? "";
  return [...new Set(decodeURIComponent(raw).split(".").filter((s) => /^[a-z0-9][a-z0-9-]*$/.test(s)))].slice(0, SLOTS);
}

/** @param {string[]} picks none for Auto */
function writePicks(picks) {
  document.cookie = picks.length
    ? `${COOKIE}=${picks.join(".")};path=/;max-age=31536000;samesite=lax`
    : `${COOKIE}=;path=/;max-age=0;samesite=lax`;
}

/**
 * @param {HTMLElement} section #hm-ns
 * @returns {() => void} opens the menu, or closes it if it is open
 */
export function mountNews(section) {
  const grid = /** @type {HTMLElement} */ ($("hm-nw"));
  const edit = /** @type {HTMLElement} */ ($("hm-ne"));

  let picks = readPicks();
  /** Every topic the menu has listed, by slug. */
  /** @type {Map<string, NewsTopic>} */
  const known = new Map();
  /** @type {HTMLElement | null} */
  let menu = null;
  const note = el("p", { id: "nw-n" });
  const autoRow = row({ slug: "", name: "Auto", kind: "", n: 0 }, "The busiest topics right now");
  /** The watched ones, redrawn on each change. */
  const mine = el("div");
  const list = el("div");
  const end = /** @type {HTMLButtonElement} */ (el("button", { type: "button", class: "wl-end", tabindex: "-1", text: "Loading…" }));
  let listed = false;
  let busy = false;
  /** Which change the cards on the page answer, so a slow answer to an older one is dropped. */
  let asked = 0;

  const rows = () => /** @type {HTMLButtonElement[]} */ ([...(menu?.querySelectorAll(".wl-o") ?? [])]);

  /** A topic's second line: what it is, and how busy. @param {NewsTopic} t */
  function about(t) {
    const kind = KINDS[t.kind] ?? "";
    const n = t.n ? `${t.n.toLocaleString("en-US")} ${t.n === 1 ? "story" : "stories"} today` : "";
    return [kind, n].filter(Boolean).join(" · ");
  }

  /**
   * A row: the check, the topic's name over what it is. Auto's slug is "".
   * @param {NewsTopic} t
   * @param {string} [sub]
   */
  function row(t, sub = about(t)) {
    const r = el(
      "button",
      { type: "button", class: "wl-o", role: "menuitemcheckbox", "data-s": t.slug, onclick: () => pick(t.slug) },
      el("span", { text: t.name }, sub && el("small", { text: sub })),
    );
    r.insertAdjacentHTML("afterbegin", CHECK);
    return r;
  }

  function paint() {
    const full = picks.length >= SLOTS;
    mine.replaceChildren(...picks.flatMap((s) => (known.has(s) ? [row(/** @type {NewsTopic} */ (known.get(s)))] : [])));
    for (const r of rows()) {
      const s = r.dataset.s ?? "";
      const on = s ? picks.includes(s) : !picks.length;
      r.setAttribute("aria-checked", String(on));
      r.disabled = full && !on && !!s;
    }
    note.textContent = !picks.length
      ? `Auto shows the ${SLOTS} busiest. Choose topics to watch`
      : full
        ? "Untick one to choose another"
        : `Choose ${SLOTS - picks.length} more, or the busiest fill in`;
  }

  /** Ticks or unticks a topic, or Auto, and shows the cards that makes. @param {string} slug "" for Auto */
  function pick(slug) {
    if (!slug) picks = [];
    else if (picks.includes(slug)) picks = picks.filter((s) => s !== slug);
    else if (picks.length < SLOTS) picks = [...picks, slug];
    else return;
    writePicks(picks);
    paint();
    void show();
  }

  /** The cards for the topics ticked now, as the server renders them, in place of these. */
  async function show() {
    const n = ++asked;
    grid.setAttribute("aria-busy", "true");
    try {
      const res = await fetch(`/api/news/cards?t=${picks.join(".")}`, { headers: { Accept: "application/json" } });
      if (!res.ok) throw new Error(String(res.status));
      /** @type {{ html: string }} */
      const body = await res.json();
      // The server's own markup, its headlines escaped there (src/lib/news.ts).
      if (n === asked) grid.innerHTML = body.html;
    } catch {
      // The old cards stay; the cookie is written, so the next load shows the choice.
    } finally {
      if (n === asked) grid.removeAttribute("aria-busy");
    }
  }

  /** The topics on offer, once; the end row says if it failed, and a tap on it tries again. */
  async function more() {
    if (busy || listed) return;
    busy = true;
    end.textContent = "Loading…";
    try {
      const res = await fetch(`/api/news/topics?t=${picks.join(".")}`, { headers: { Accept: "application/json" } });
      if (!res.ok) throw new Error(String(res.status));
      /** @type {{ topics: NewsTopic[] }} */
      const body = await res.json();
      for (const t of body.topics) known.set(t.slug, t);
      // Watched topics the server no longer offers or knows are not on the page either.
      picks = picks.filter((s) => known.has(s));
      list.replaceChildren(...body.topics.map((t) => row(t)));
      listed = true;
      end.remove();
      paint();
    } catch {
      end.textContent = "Couldn’t load. Tap to retry";
    } finally {
      busy = false;
    }
  }

  function build() {
    style();
    end.addEventListener("click", () => void more());
    return el(
      "div",
      { class: "wl-m nw", role: "menu", "aria-labelledby": "hm-ne", "aria-describedby": "nw-n" },
      note,
      el("div", null, autoRow),
      mine,
      el("p", { class: "wl-h", text: "Busiest on 40 Newsroom" }),
      list,
      end,
    );
  }

  function open() {
    if (menu?.isConnected) return;
    menu ??= build();
    paint();
    section.append(menu);
    place(menu, edit, section);
    edit.setAttribute("aria-expanded", "true");
    menu.scrollTop = 0;
    autoRow.focus({ preventScroll: true });
    document.addEventListener("pointerdown", outside, true);
    document.addEventListener("keydown", keys);
    void more();
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
    // Edit answers its own taps (js/watch.js).
    if (!menu?.contains(t) && !edit.contains(t)) close();
  }

  /** Escape closes; the arrows walk the rows that can be chosen. @param {KeyboardEvent} e */
  function keys(e) {
    if (e.key === "Escape") return close(true);
    if ((e.key === "ArrowDown" || e.key === "ArrowUp") && menu) walk(e, menu);
  }

  return () => (menu?.isConnected ? close() : open());
}
