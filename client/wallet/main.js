/**
 * The wallet page. Left: every token, searched or list by list. Centre: what
 * you hold, by kind and by token, then the tokens looked at lately, then
 * Movers and New. Right: a drawer with the chosen token's line and market
 * data, opened by picking one and closed by its ×.
 *
 * The portfolio is the signed-in account's wallet; signed out, its place asks
 * them to log in, and everything else on the page is still anyone's.
 *
 * Each list and token has an address of its own: /wallet (Trending),
 * /wallet/<list>, /wallet/<token>. The server says which one this page was
 * opened at on <body> (data-c, data-t; src/seo.ts walletDoc), and a pick puts
 * its own in the address bar.
 */
import { $, el, nil } from "../js/dom.js";
import { accountsButton, authPath, loginPath, mountAccount } from "../js/acct.js";
import { noZoom } from "../js/device.js";
import { load } from "../js/lazy.js";
import { account as whoami } from "../js/me.js";
import { during } from "../js/progress.js";
import { mountPwa } from "../js/pwa.js";
import { UTCC } from "../js/utcc.js";
import { amount, dollars, fiat, percent, tokenPrice } from "../js/num.js";
import { onSession, readSession } from "../js/session.js";
import { openSwap, swapUrl } from "../js/swap.js";
import { dirOf, figure, lineChart, paintMove, rangeTabs, since, when } from "../js/chart.js";
import { mountBreakdown } from "./breakdown.js";
import { icon, mountPanel } from "./panel.js";
import { plainSwap } from "../js/plainswap.js";

plainSwap();

const total = $("wl-v");
const delta = $("wl-d");
const list = $("wl-l");
const note = $("wl-n");
const extra = $("wl-x");
const keys = $("wl-ph");
const topList = $("wl-tl");
const topNote = $("wl-tn");
const filter = /** @type {HTMLInputElement} */ ($("wl-q"));
const side = $("wl-s");
const chips = /** @type {HTMLButtonElement[]} */ ([...$("wl-cats").querySelectorAll("button")]);

const actions = $("wl-acts");
const portfolioBox = $("wl-pf");
const signIn = $("wl-in");
/** Re-asked once the login dialog signs someone in. */
let account = whoami();

async function owner() {
  return (await account)?.address || readSession()?.address || "";
}

/**
 * Re-reads after a trade. A wallet resolves once it has broadcast, not once
 * the chain has settled, and the server holds holdings for five seconds.
 */
const SETTLE_MS = [1500, 6000, 6000, 8000];

const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/** The last painted portfolio, so a re-read can tell whether anything moved. */
let shown = null;

/** Amounts only: prices move every few seconds and would end the wait at once. */
function signature(data) {
  return [
    ...(data.items ?? []).map((i) => `${i.mint}:${i.amount}`).sort(),
    data.unpriced ?? 0,
    data.more ?? 0,
  ].join("|");
}

/** @param {string | (string | Node)[]} text */
function setNote(text, kind) {
  const parts = [].concat(text || []);
  note.replaceChildren(...parts);
  note.className = `wl-n${kind ? ` ${kind}` : ""}`;
  note.hidden = !parts.length;
}

/** Everything below the total, cleared before each render. */
function reset() {
  list.replaceChildren();
  breakdown.clear();
  extra.replaceChildren();
  note.replaceChildren();
  note.className = "wl-n";
  note.hidden = false;
  total.classList.remove("is-wait");
}

/** The figure, and its move across the range on show. */
function paintFigures(data) {
  figure(total, { text: dollars(data.total) });
  const line = data.series;
  if (!line) return paintMove(delta, null, 0, dollars, "");
  paintMove(delta, data.change, line[line.length - 1] - line[0], dollars, since(shown.range));
}

/** Each line's dollars, oldest first: "total", then every kind with a line of its own. */
let lines = new Map();

const portfolio = lineChart($("wl-c"), (i) => {
  const now = view();
  if (!now) return;
  breakdown.at(i, lines);
  const line = lines.get(breakdown.picked || "total");
  if (i < 0 || !line) return paintFigures(now);
  figure(total, { text: dollars(line[i]) });
  const clock = { at: shown.seriesAt, step: shown.seriesStep };
  paintMove(delta, (line[i] / line[0] - 1) * 100, line[i] - line[0], dollars, when(clock, line.length, i));
});

/** The range the portfolio's line covers, asked of the server with every read. */
let range = "24h";

const ranges = rangeTabs(range, (next) => {
  range = next;
  void reread();
});
/**
 * The first paint (wallet.html) is a $0.00 portfolio in its final geometry,
 * shimmering, until the first read is painted over it in place: no rows
 * cleared ahead of it and no "Reading" note, so nothing moves twice.
 */
const firstPaint = () => document.body.classList.contains("wl-loading");
const firstPainted = () => document.body.classList.remove("wl-loading");
// The real range row in the placeholder's place, the same size, shown while that holds.
ranges.hidden = !firstPaint();
document.querySelector(".wl-sk-r")?.replaceWith(ranges);

/**
 * The figure, and the chart: the total's line alone, or with three kinds or
 * more, a line for each of them beside it, the picked one in front.
 */
function paintTotal() {
  const now = view() ?? { total: NaN };
  paintFigures(now);
  lines = new Map();
  if (shown?.series) lines.set("total", shown.series);
  for (const slice of shown?.slices ?? []) if (slice.series) lines.set(slice.kind, slice.series);
  // Nothing held, nothing to draw or to range over.
  ranges.hidden = !shown?.items?.length;
  if (ranges.hidden) portfolio.clear();
  else if (shown.slices && lines.has("total")) {
    portfolio.drawMany([...lines].map(([key, values]) => ({ key, values })), shown.seriesStep, breakdown.picked);
  } else if (now.series) {
    portfolio.draw({ at: shown.seriesAt, step: shown.seriesStep, v: now.series }, dirOf(now.change));
  } else portfolio.clear("Too little of this has a price history to draw.");
}

/**
 * The portfolio by kind. A pick brings that kind's line forward, puts its
 * worth and day where the total's were, and narrows the holdings to it.
 */
const breakdown = mountBreakdown($("wl-bk"), () => {
  paintTotal();
  paintRows();
});

/** What the figure shows: the whole portfolio, or the kind picked from its breakdown. */
function view() {
  const slice = shown?.slices?.find((s) => s.kind === breakdown.picked);
  if (!slice) return shown;
  const { usd, series, change } = slice;
  return { total: usd, series, change };
}

/** The holdings, or those of the kind picked. */
function paintRows() {
  const kind = breakdown.picked;
  list.replaceChildren(...(shown?.items ?? []).filter((h) => !kind || h.kind === kind).map(row));
}

/**
 * Buy or sell in the dialog the rest of the site trades in. With a label it is
 * the side panel's pill; without, a row's + or − mark (ic-plus / ic-minus).
 */
async function openTrade(h, mode) {
  try {
    await openSwap({
      mint: h.mint,
      symbol: h.symbol,
      decimals: h.decimals,
      price: h.price,
      fallback: swapUrl(h.mint),
      mode,
      onClose: (sent) => {
        if (sent) void settle();
      },
    });
  } catch {
    // The bundle would not load; Jupiter's own page is the floor.
    window.location.href = swapUrl(h.mint);
  }
}

function trade(h, mode, label) {
  const selling = mode === "sell";
  const title = `${selling ? "Sell" : "Buy"} ${h.symbol}`;
  return el("button", {
    class: label ? `wl-cta ${selling ? "tp-sell" : "tp-buy"}` : `wl-t${selling ? " wl-sell" : ""}`,
    type: "button",
    // The drawer's pills say just the act; the token is named beside them.
    text: label ? (selling ? "Sell" : "Buy") : null,
    title,
    "aria-label": title,
    "data-mint": h.mint,
    "data-sym": h.symbol,
    onclick: async (e) => {
      const button = e.currentTarget;
      button.disabled = true;
      await openTrade(h, mode);
      button.disabled = false;
      if (selling) paintSells();
    },
  });
}

/** Whether the portfolio on show holds any of this mint. */
function holds(mint) {
  if (portfolioBox.hidden) return false;
  return (shown?.items ?? []).some((h) => h.mint === mint && /[1-9]/.test(h.amount));
}

/** The drawer's Sell, live only for a token the wallet holds; re-run whenever the holdings are read. */
function paintSells() {
  for (const button of /** @type {NodeListOf<HTMLButtonElement>} */ (side.querySelectorAll(".tp-sell"))) {
    const held = holds(button.dataset.mint ?? "");
    button.disabled = !held;
    button.title = held ? button.getAttribute("aria-label") ?? "" : `You hold no ${button.dataset.sym}`;
  }
}

/** Every token a row has shown, so Swap can open on the one in the panel. */
const known = new Map();

const select = mountPanel(
  side,
  (t) => {
    // A linked token may be on neither list, and Swap opens on what the panel shows.
    if (!known.has(t.mint)) known.set(t.mint, t);
    const sell = trade(t, "sell", true);
    /** @type {HTMLButtonElement} */ (sell).disabled = !holds(t.mint);
    if (!holds(t.mint)) sell.title = `You hold no ${t.symbol}`;
    return el("div", { class: "tp-acts" }, trade(t, "buy", true), sell);
  },
  () => shut(),
);
let chosen = "";

/**
 * The drawer: shut until a token is picked, and shut again by its ×, which
 * also lets go of the token (its row unlit, the address back to the list's).
 * On a desktop it pushes the centre column aside (wallet.css body.wl-open).
 */
function shut() {
  if (phone.matches) {
    if (history.state?.wlDeep) history.back();
    else shallow();
    return;
  }
  document.body.classList.remove("wl-open");
  chosen = "";
  for (const r of document.querySelectorAll(".wl-r.on, .wl-rc.on")) r.classList.remove("on");
  const on = chips.find((chip) => chip.dataset.c === cat);
  setAddress(cat === "trending" ? "/wallet" : `/wallet/${cat}`, `${on?.firstChild?.textContent ?? "Trending"} | UtopianGO Wallet`);
}

/** Open a token in the drawer: its own address, and a card in Recently viewed. */
function choose(mint) {
  chosen = mint;
  for (const r of document.querySelectorAll(".wl-r, .wl-rc")) {
    r.classList.toggle("on", /** @type {HTMLElement} */ (r).dataset.mint === mint);
  }
  document.body.classList.add("wl-open");
  void select(mint).then((data) => {
    if (!data || chosen !== mint) return;
    if (data.path) setAddress(data.path, data.title);
    remember(data);
  });
  if (matchMedia("(min-width: 960px)").matches) return;
  // On a phone the panel replaces the lists (wallet.css); stacked a little
  // wider, it sits below them.
  if (phone.matches) {
    if (!document.body.classList.contains("deep")) history.pushState({ wlDeep: true }, "");
    document.body.classList.add("deep");
    window.scrollTo(0, 0);
  } else {
    document.body.classList.add("deep");
    side.scrollIntoView({ behavior: "smooth" });
  }
}

/**
 * Put an address in the bar, in place of the one there: a pick is not a
 * step back to retrace, and on a phone the step (into the panel) was already
 * pushed by choose. The title goes with it.
 */
function setAddress(path, title) {
  if (location.pathname + location.search !== path) history.replaceState(history.state, "", path);
  if (title) document.title = title;
}

/** Where wallet.css shows the lists and the panel one at a time; header.css's Back breakpoint. */
const phone = matchMedia("(max-width: 900px)");

/** Back to the lists, onto the row that was open. */
function shallow() {
  document.body.classList.remove("deep");
  const on = document.querySelector(".wl-r.on");
  (on || $("wl")).scrollIntoView({ block: "center" });
}

// The phone's own back gesture leaves the panel the same way the header's Back
// does, and History the way its own Back does.
window.addEventListener("popstate", () => {
  if (document.body.classList.contains("deep")) shallow();
  if (!history.state?.wlHist) closeHistory();
});

$("bk").addEventListener("click", () => {
  if (history.state?.wlDeep) history.back();
  else shallow();
});

/**
 * A token's address (/wallet/bonk) opens on it as though its row had been
 * picked; Social's Trending assets link here. The server named its mint on
 * <body>. One the index cannot answer for leaves the usual first choice.
 */
async function openLinked() {
  const mint = document.body.dataset.t;
  if (!mint) return;
  const ok = await select(mint, true);
  if (ok && !chosen) choose(mint);
}

function ident(t) {
  known.set(t.mint, t);
  return el(
    "button",
    { class: "wl-id", type: "button", onclick: () => choose(t.mint) },
    el("span", { class: "wl-sym", text: t.symbol }),
    el("span", { class: "wl-nm", text: t.name }),
  );
}

/**
 * A row's logo, drawn big off its right edge (wallet.css .wl-lg), as the home
 * watchlist's menu draws its rows. None for a token with no logo, or whose
 * logo will not load: the row reads the same without it.
 */
function logo(t) {
  if (!t.icon) return null;
  const img = el("img", { class: "wl-lg", src: `/icon/big/${t.mint}`, alt: "", loading: "lazy", decoding: "async" });
  img.addEventListener("error", () => img.remove(), { once: true });
  return img;
}

/**
 * Each holding's average entry (/api/entries), by mint: what was paid for it,
 * and what its row's profit is measured against. Read once per set of
 * balances, so another range, or a re-read with nothing moved, does not ask
 * again, and kept across loads (KEPT below).
 */
let entries = new Map();
/** The balances `entries` were read for, as signature() has them. */
let entriesFor = "";
let entriesRun = 0;

/**
 * A holding's profit: its price now against what was paid for it. Blank, but
 * keeping its line so nothing moves when it lands, until the entries are read
 * or where there is none to give.
 * @param {HTMLElement} node
 * @param {import('../../src/types').Holding} h
 */
function paintEntry(node, h) {
  const entry = entries.get(h.mint);
  const units = Number(h.amount) / 10 ** h.decimals;
  if (!entry || !units) {
    node.className = "wl-d";
    node.textContent = "\u00a0";
    node.removeAttribute("title");
    return;
  }
  const pct = (h.price / entry - 1) * 100;
  const diff = h.usd - entry * units;
  const paid = tokenPrice(entry);
  node.className = `wl-d ${dirOf(pct)}`;
  node.textContent = `${diff < 0 ? "-" : "+"}${dollars(Math.abs(diff))} · ${percent(Math.abs(pct))}`;
  node.title = `Against an average entry of ${paid.title ?? paid.text}`;
}

/** The rows on show, each with its profit, once the entries land. */
function paintEntries() {
  for (const r of list.querySelectorAll(".wl-own")) {
    const h = shown?.items?.find((i) => i.mint === /** @type {HTMLElement} */ (r).dataset.mint);
    const move = /** @type {HTMLElement | null} */ (r.querySelector(".wl-d"));
    if (h && move) paintEntry(move, h);
  }
}

/**
 * The last answer, kept in this browser: the entries for one set of
 * balances, and the basis the next is worked out from (src/lib/entries.ts).
 * A load with nothing moved asks nothing, and one after a trade has only the
 * trade read off the chain. One wallet's at a time; another's replaces it.
 */
const KEPT = "ug.entries";

/**
 * How long an answer that may yet change is used before asking again: about
 * as long as the index takes to catch up with a trade, or the chart API to
 * have room again. One that cannot change is used until the balances move.
 */
const UNSETTLED_MS = 60_000;

/** What was kept for `who`. localStorage throws where it is unavailable, as lang.js says. */
function recall(who) {
  try {
    const kept = JSON.parse(localStorage.getItem(KEPT) || "null");
    return kept?.owner === who ? kept : null;
  } catch {
    return null;
  }
}

function keep(value) {
  try {
    localStorage.setItem(KEPT, JSON.stringify(value));
  } catch {
    // Not kept: the next load asks from scratch.
  }
}

/** POSTed, as the holdings are. A failure leaves the rows without a profit, and the next paint asks again. */
async function readEntries(data) {
  const id = ++entriesRun;
  const sig = signature(data);
  entriesFor = sig;
  try {
    const who = await owner();
    const kept = recall(who);
    if (id !== entriesRun) return;
    if (kept?.for === sig && kept.entries && (kept.until == null || Date.now() < kept.until)) {
      entries = new Map(Object.entries(kept.entries));
      paintEntries();
      return;
    }
    const res = await fetch("/api/entries", {
      method: "POST",
      headers: { "Content-Type": "application/json", Accept: "application/json" },
      body: JSON.stringify({ owner: who, ...(kept?.basis ? { basis: kept.basis } : {}) }),
    });
    const body = await res.json().catch(() => null);
    if (id !== entriesRun) return;
    if (!res.ok || !body?.entries) throw new Error(body?.error || `entries ${res.status}`);
    entries = new Map(Object.entries(body.entries));
    keep({
      owner: who,
      for: sig,
      ...(body.settled ? {} : { until: Date.now() + UNSETTLED_MS }),
      entries: body.entries,
      basis: body.basis ?? kept?.basis,
    });
    paintEntries();
  } catch {
    if (id === entriesRun) entriesFor = "";
  }
}

/** @param {import('../../src/types').Holding} h */
function row(h) {
  const held = amount(h.amount, h.decimals, h.price);
  const move = el("span", { class: "wl-d" });
  paintEntry(move, h);
  return el(
    "div",
    { class: `wl-r wl-own${h.mint === chosen ? " on" : ""}`, "data-mint": h.mint },
    logo(h),
    ident(h),
    el("span", {
      class: "wl-amt",
      text: held.text,
      title: `${held.title ?? held.text} ${h.symbol}`,
      "aria-label": held.label ? `${held.label} ${h.symbol}` : null,
    }),
    el("span", { class: "wl-usd", text: dollars(h.usd) }),
    move,
    el("span", { class: "wl-act" }, trade(h, "buy"), trade(h, "sell")),
  );
}

/** @param {import('../../src/types').TopToken} t */
function topRow(t) {
  const price = tokenPrice(t.price);
  const move = t.change24h;
  return el(
    "div",
    {
      class: `wl-r wl-tr${t.mint === chosen ? " on" : ""}`,
      "data-mint": t.mint,
      // The whole row picks the token, not just its name; the name stays the
      // button a keyboard reaches. Buy and Sell are the drawer's.
      onclick: (event) => {
        if (!event.target.closest(".wl-id")) choose(t.mint);
      },
    },
    logo(t),
    ident(t),
    el(
      "span",
      { class: "wl-px" },
      el("span", { text: price.text, title: price.title }),
      move == null ? null : el("span", { class: `wl-d ${dirOf(move)}`, text: percent(move, true) }),
    ),
  );
}

let searchRun = 0;

/** The list on show: Trending, or one kind. Its address picks it (data-c); the buttons after that. */
let cat = (() => {
  const asked = document.body.dataset.c;
  return chips.some((chip) => chip.dataset.c === asked) ? asked : "trending";
})();
/** Where the list's next page starts; empty once there is none, and while searching. */
let after = "";
let paging = false;
/** Sits after the last row while there is more, and asks for it when scrolled near. */
const end = el("div", { "aria-hidden": "true" });

function press(key) {
  for (const chip of chips) chip.setAttribute("aria-pressed", String(chip.dataset.c === key));
}

async function tokens(query) {
  const res = await fetch(`/api/tokens?${new URLSearchParams(query)}`, { headers: { Accept: "application/json" } });
  const data = await res.json();
  if (!res.ok) throw new Error(data.error);
  return data;
}

/** The chosen list's first page with an empty field; otherwise the whole index, closest first. */
async function paintTop() {
  const q = filter.value.trim();
  const id = ++searchRun;
  watch("");
  // A search is of everything, so no list is pressed while one is showing.
  press(q ? "" : cat);
  try {
    const data = await tokens(q ? { q } : { c: cat });
    if (id !== searchRun) return;
    const rows = data.tokens ?? [];
    // Each list's length in its chip. One with nothing on it today is not
    // offered, unless it is the one asked for.
    if (data.counts) {
      for (const chip of chips) {
        const n = data.counts[chip.dataset.c] ?? 0;
        /** @type {HTMLElement} */ (chip.lastElementChild).textContent = n.toLocaleString("en-US");
        chip.hidden = !n && chip.dataset.c !== cat;
      }
    }
    topList.replaceChildren(...rows.map(topRow));
    topNote.hidden = rows.length > 0;
    topNote.replaceChildren(
      q
        ? nil("ic-swap", "No token by that name", "Check the spelling, or try its ticker instead.")
        : cat === "trending"
          ? nil("ic-up", "Nothing is trending right now", "Tokens show up here as their trading picks up. Check back soon.")
          : nil("ic-swap", "Nothing on this list right now", "Tokens join it as they qualify. Try another list meanwhile."),
    );
    watch(q ? "" : data.after);
  } catch {
    if (id !== searchRun) return;
    topNote.hidden = false;
    topNote.textContent = "Could not load tokens.";
  }
}

/** The next page of the list on show, onto the end of it. */
async function paintMore() {
  if (!after || paging) return;
  const id = searchRun;
  paging = true;
  try {
    const data = await tokens({ c: cat, after });
    if (id !== searchRun) return;
    end.before(...data.tokens.map(topRow));
    watch(data.after);
  } catch {
    // Asked again in a moment, if the end is still where it was.
    setTimeout(() => id === searchRun && watch(after), 3000);
  } finally {
    paging = false;
  }
}

/**
 * Where the list scrolls: with the left column on a desktop (wallet.css), with
 * the page on a phone. The watcher has to be told which, so it can ask for
 * the next page a screenful ahead rather than once the end is on screen.
 * History scrolls with the centre column.
 */
const desk = matchMedia("(min-width: 960px)");
const column = /** @type {HTMLElement} */ (document.querySelector(".wl-main"));
const bar = $("wl-bar");
const barHead = /** @type {HTMLElement} */ (bar.querySelector(".wl-tb"));
// The field and lists frost over the rows once any have scrolled under them (wallet.css).
bar.addEventListener("scroll", () => barHead.classList.toggle("up", bar.scrollTop > 0), { passive: true });
let pager = watcher();

function watcher() {
  const next = new IntersectionObserver(
    (seen) => {
      if (seen.some((e) => e.isIntersecting)) void paintMore();
    },
    { root: desk.matches ? bar : null, rootMargin: "0px 0px 600px 0px" },
  );
  if (end.isConnected) next.observe(end);
  return next;
}

desk.addEventListener("change", () => {
  pager.disconnect();
  pager = watcher();
  past?.rewatch();
});

/**
 * History, in the left half's place. Its Back, or the phone's own, puts the
 * portfolio back where it was scrolled to. Offered for whichever wallet the
 * portfolio is showing.
 */
const historyButton = $("wl-hb");
const historyView = $("wl-hs");
/** History's list (wallet/history.js), in the dialogs bundle, fetched on the first press. */
let past = null;
/** Where the page was scrolled before History took its place. */
let historyFrom = 0;

async function openHistory() {
  const address = await owner();
  if (!address || document.body.classList.contains("hist")) return;
  try {
    past ??= (await load("ks", "__keys")).history(() => (desk.matches ? column : null));
  } catch {
    return setNote("Could not open History. Try again.", "err");
  }
  if (document.body.classList.contains("hist")) return;
  historyFrom = desk.matches ? column.scrollTop : window.scrollY;
  document.body.classList.add("hist");
  historyView.hidden = false;
  history.pushState({ wlHist: true }, "");
  if (desk.matches) column.scrollTop = 0;
  else window.scrollTo(0, 0);
  $("wl-hx").focus();
  past.open(address);
}

function closeHistory() {
  if (!document.body.classList.contains("hist")) return;
  past?.close();
  document.body.classList.remove("hist");
  historyView.hidden = true;
  if (desk.matches) column.scrollTop = historyFrom;
  else window.scrollTo(0, historyFrom);
  historyButton.focus({ preventScroll: true });
}

historyButton.addEventListener("click", () => void openHistory());
$("wl-hx").addEventListener("click", () => {
  if (history.state?.wlHist) history.back();
  else closeHistory();
});

/**
 * Put the end marker after the last row and watch it, or take it away once
 * there is nothing after. Observing reports straight away, so a page too short
 * to scroll asks for the next one by itself.
 */
function watch(cursor) {
  after = cursor || "";
  pager.unobserve(end);
  if (!after) return end.remove();
  topList.append(end);
  pager.observe(end);
}

/**
 * Back up to the list's first row when it has scrolled up out of sight, so a
 * new list starts at its top; left alone when the list is already in view.
 * Under the page's own sticky header on a phone; at the top of the left half
 * on a desktop.
 */
function toListTop() {
  const floor = desk.matches ? bar.getBoundingClientRect().top : $("chrome").getBoundingClientRect().bottom;
  const over = /** @type {HTMLElement} */ (topList.parentElement).getBoundingClientRect().top - floor;
  if (over >= 0) return;
  if (desk.matches) bar.scrollTop += over;
  else window.scrollBy(0, over);
}

/** A linked list may be off the end of a phone's row of them; bring it into view. */
function showCat() {
  press(cat);
  const on = chips.find((chip) => chip.dataset.c === cat);
  const row = on?.parentElement;
  if (on && row) row.scrollLeft += on.getBoundingClientRect().left - row.getBoundingClientRect().left - 16;
}

for (const chip of chips) {
  chip.addEventListener("click", () => {
    cat = chip.dataset.c;
    filter.value = "";
    // The list's own address (src/seo.ts walletListPath), named for it.
    setAddress(cat === "trending" ? "/wallet" : `/wallet/${cat}`, `${chip.firstChild?.textContent ?? ""} | UtopianGO Wallet`);
    toListTop();
    void paintTop();
  });
}

let typing = 0;
filter.addEventListener("input", () => {
  clearTimeout(typing);
  typing = setTimeout(paintTop, 180);
});

/**
 * Receive, send and swap: the signed-in account's own wallet only. The account
 * is read on each click, not once: Log out and Log in can change it under a
 * page that wired these for someone else.
 */
let wired = false;
async function paintActions() {
  const me = await account;
  actions.hidden = !me;
  if (!me || wired) return;
  wired = true;
  const dialogs = () => load("ks", "__keys");
  for (const button of actions.querySelectorAll("button")) {
    button.addEventListener("click", async () => {
      const me = await account;
      if (!me) return;
      button.disabled = true;
      try {
        const act = button.dataset.act;
        // Swap is UTCC's, from SOL: "Trade UTCC". Any other token trades from its own row.
        if (act === "swap") await openTrade(UTCC, "buy");
        else if (act === "receive") (await dialogs()).receive(me);
        else (await dialogs()).send(me, shown?.items ?? [], () => void settle());
      } catch {
        setNote("Could not open that. Try again.", "err");
      } finally {
        button.disabled = false;
      }
    });
  }
}

/** Only a Social account has a phrase here; a connected wallet keeps its own. */
async function paintKeys() {
  const me = await account;
  if (!me) {
    keys.hidden = true;
    keys.replaceChildren();
    return;
  }
  const button = el("button", {
    class: "wl-b",
    type: "button",
    text: "Show recovery phrase",
    onclick: async () => {
      button.disabled = true;
      try {
        (await load("ks", "__keys")).open(me);
      } catch {
        setNote("Could not open the recovery phrase.", "err");
      } finally {
        button.disabled = false;
      }
    },
  });
  // The placeholder's marks off, now that it holds the account.
  keys.classList.remove("wl-sk");
  keys.removeAttribute("aria-hidden");
  keys.replaceChildren(
    el("span", { class: "wl-k", text: `@${me.name}` }),
    el("span", { class: "wl-ka", text: me.address, title: me.address }),
    button,
  );
  keys.hidden = false;
}

/**
 * What the page left out, said plainly, so a filtered list does not read as
 * everything. The tokens with no price open what the chain says about them.
 */
function omitted(data) {
  const parts = [];
  if (data.more) parts.push(`${data.more} smaller holding${data.more > 1 ? "s" : ""}`);
  if (data.unpriced) {
    const what = `${data.unpriced} token${data.unpriced > 1 ? "s" : ""} we hold no price for`;
    const list = data.unknown ?? [];
    parts.push(
      list.length
        ? el("button", {
            class: "wl-unk",
            type: "button",
            text: what,
            onclick: () => openTokens(list, { total: data.unpriced }),
          })
        : what,
    );
  }
  if (!parts.length) return "";
  return ["Not shown: ", ...parts.flatMap((p, i) => (i ? [", ", p] : [p])), "."];
}

/** Tokens we do not list, in the dialogs bundle (keys/main.js). */
async function openTokens(list, opts) {
  try {
    (await load("ks", "__keys")).tokens(list, opts);
  } catch {
    setNote("Could not open the token details.", "err");
  }
}

function paint(data) {
  reset();
  firstPainted();
  shown = data;
  paintSells();
  // New balances: last read's entries are for what was held then.
  const moved = signature(data) !== entriesFor;
  if (moved) entries = new Map();
  breakdown.paint(data);
  paintTotal();

  if (!data.items.length) {
    setNote(
      data.unpriced
        ? nil("ic-wallet", "Nothing we can price", omitted(data))
        : nil("ic-wallet", "This wallet is empty", "Tokens you receive or buy show up here with their value. Press Receive for your address."),
    );
    return;
  }

  paintRows();
  if (moved) void readEntries(data);
  setNote(omitted(data));
}

/**
 * Whose portfolio, if anyone's: signed out, the sign-in prompt stands in its
 * place, its links coming back to this address once someone is in. The
 * server ships the right one for the cookie it saw (src/pages.ts); this is
 * for a session that began or ended with the page open.
 */
function showPortfolio(yes) {
  portfolioBox.hidden = !yes;
  signIn.hidden = yes;
  paintSells();
  if (yes) return;
  firstPainted();
  historyButton.hidden = true;
  const here = location.pathname + location.search;
  $("wl-in-l").setAttribute("href", loginPath(here));
  $("wl-in-r").setAttribute("href", authPath("/register", here));
}

/** POSTed so the address stays out of request logs. Throws on anything that is not an answer. */
async function readHoldings(address) {
  const res = await fetch("/api/holdings", {
    method: "POST",
    headers: { "Content-Type": "application/json", Accept: "application/json" },
    body: JSON.stringify({ owner: address, range }),
  });
  const data = await res.json().catch(() => null);
  if (!res.ok || !data || data.error) {
    throw new Error(data?.error || `holdings ${res.status}`);
  }
  return data;
}

/** Shared by the plain read and the post-trade wait, so either cancels the other. */
let run = 0;

async function refresh() {
  const id = ++run;
  const address = await owner();
  if (id !== run) return;
  showPortfolio(!!address);
  if (!address) return;

  historyButton.hidden = false;
  // The first read paints over the shimmering placeholder; later ones start from clear.
  if (!firstPaint()) {
    reset();
    setNote("Reading your wallet…");
  }

  try {
    // Under the loading bar along the top (client/js/progress.js), as Social's pages load.
    const data = await during(readHoldings(address));
    if (id !== run) return;
    paint(data);
  } catch (err) {
    if (id !== run) return;
    reset();
    firstPainted();
    portfolio.clear();
    ranges.hidden = true;
    // A lookup that did not happen must never read as an empty portfolio.
    total.textContent = "—";
    setNote(err?.message || "Could not read this wallet.", "err");
    extra.append(el("button", { class: "wl-b", type: "button", text: "Try again", onclick: refresh }));
  }
}

/**
 * Another range picked: the page stays as it is, its line let down, until the
 * new one lands. A failed read puts the old line back and says so.
 */
async function reread() {
  const id = ++run;
  const address = await owner();
  if (id !== run || !address) return;
  portfolio.busy();
  try {
    const data = await readHoldings(address);
    if (id === run) paint(data);
  } catch {
    if (id !== run) return;
    paintTotal();
    setNote("Could not load that range. Try again.", "err");
  }
}

/**
 * Wait for a broadcast trade to reach the balances, then repaint. The old
 * figures stay up, marked as settling, rather than blanking.
 */
async function settle() {
  const address = await owner();
  if (!address) return;

  const id = ++run;
  const before = shown ? signature(shown) : "";
  total.classList.add("is-wait");
  setNote("Trade sent — waiting for it to reach your balance…");

  for (const ms of SETTLE_MS) {
    await wait(ms);
    if (id !== run) return;

    let data;
    try {
      data = await readHoldings(address);
    } catch {
      continue;
    }
    if (id !== run) return;

    if (signature(data) !== before) {
      paint(data);
      return;
    }
  }

  if (id !== run) return;
  total.classList.remove("is-wait");
  setNote("Trade sent, but your balance has not changed yet. It can take a moment — reload to check again.");
}

/* —— Recently viewed ——
   Every token opened in the drawer, newest first, as a card under the
   portfolio. Kept in this browser only: a convenience, not a record. */

const SEEN = "ug.wl.seen";
const SEEN_MAX = 12;
const seenBox = $("wl-rv");
const seenList = $("wl-rvl");

/** @returns {import('../../src/types').TopToken[]} */
function recallSeen() {
  try {
    const kept = JSON.parse(localStorage.getItem(SEEN) || "[]");
    return Array.isArray(kept) ? kept.filter((t) => t && typeof t.mint === "string").slice(0, SEEN_MAX) : [];
  } catch {
    return [];
  }
}

function keepSeen(list) {
  try {
    if (list.length) localStorage.setItem(SEEN, JSON.stringify(list));
    else localStorage.removeItem(SEEN);
  } catch {
    // Not kept: the cards last as long as the page.
  }
}

let seen = recallSeen();

/**
 * A token as a card: Recently viewed's, Movers' and New's. `meta`, when
 * given, is a quiet last line: the volume, or the age.
 * @param {import('../../src/types').TopToken} t
 * @param {string} [meta]
 */
function tokenCard(t, meta) {
  const price = tokenPrice(t.price);
  const move = t.change24h;
  return el(
    "button",
    {
      class: `wl-rc${t.mint === chosen ? " on" : ""}`,
      type: "button",
      "data-mint": t.mint,
      title: t.name,
      onclick: () => choose(t.mint),
    },
    icon(t, 28),
    el("span", { class: "wl-rc-s", text: t.symbol }),
    el("span", { class: "wl-rc-p", text: price.text }),
    el("span", { class: `wl-d ${dirOf(move)}`, text: move == null ? "\u00a0" : percent(move, true) }),
    meta ? el("span", { class: "wl-rc-m", text: meta }) : null,
  );
}

function paintSeen() {
  seenBox.hidden = !seen.length;
  seenList.replaceChildren(...seen.map((t) => tokenCard(t)));
  edges();
}

/** Each card row's blurred end (wallet.css .wl-rvw), off once there is nothing more past it. */
const rowsOfCards = /** @type {HTMLElement[]} */ ([...document.querySelectorAll(".wl-rvl")]);
function edges() {
  for (const row of rowsOfCards) {
    row.parentElement?.classList.toggle("end", row.scrollLeft + row.clientWidth >= row.scrollWidth - 2);
  }
}
for (const row of rowsOfCards) {
  row.addEventListener("scroll", edges, { passive: true });
  row.after(el("i", { class: "wl-fz", "aria-hidden": "true" }, el("i", {}), el("i", {}), el("i", {}), el("i", {})));
}
addEventListener("resize", edges, { passive: true });

/** A token opened: to the front of the row, once. */
function remember(d) {
  const t = {
    mint: d.mint,
    symbol: d.symbol,
    name: d.name,
    price: d.price,
    ...(d.windows?.["24h"]?.change != null ? { change24h: d.windows["24h"].change } : {}),
    ...(d.icon ? { icon: true } : {}),
  };
  seen = [t, ...seen.filter((s) => s.mint !== t.mint)].slice(0, SEEN_MAX);
  keepSeen(seen);
  paintSeen();
  seenList.scrollLeft = 0;
}

/** The kept cards' prices are as of their last view; today's replace them. */
async function freshenSeen() {
  if (!seen.length) return;
  try {
    const res = await fetch(`/api/quotes?m=${seen.map((t) => t.mint).join(",")}`, { headers: { Accept: "application/json" } });
    if (!res.ok) return;
    const now = new Map(((await res.json()).tokens ?? []).map((t) => [t.mint, t]));
    seen = seen.map((t) => {
      const q = now.get(t.mint);
      return q ? { ...t, price: q.price, change24h: q.change24h, icon: q.icon } : t;
    });
    keepSeen(seen);
    paintSeen();
  } catch {
    // The kept prices stand.
  }
}

$("wl-rvx").addEventListener("click", () => {
  seen = [];
  keepSeen(seen);
  paintSeen();
});

/* —— Movers and New —— */

/** How long a market has been open, in its largest whole unit. */
function age(at) {
  const m = Math.max(0, (Date.now() - at) / 60_000);
  if (m < 60) return `${Math.max(1, Math.floor(m))}m`;
  if (m < 48 * 60) return `${Math.floor(m / 60)}h`;
  if (m < 60 * 24 * 60) return `${Math.floor(m / 1440)}d`;
  if (m < 365 * 24 * 60) return `${Math.floor(m / 43_200)}mo`;
  return `${Math.floor(m / 525_600)}y`;
}

async function paintFeatured(key, box, meta) {
  try {
    const res = await fetch(`/api/tokens/featured?s=${key}`, { headers: { Accept: "application/json" } });
    const data = await res.json();
    if (!res.ok) throw new Error(data.error);
    const rows = data.tokens ?? [];
    box.replaceChildren(
      ...(rows.length ? rows.map((t) => tokenCard(t, meta(t))) : [el("p", { class: "wl-n", text: "Nothing here right now." })]),
    );
  } catch {
    box.replaceChildren(el("p", { class: "wl-n", text: "Could not load these." }));
  }
  edges();
}

paintSeen();
void freshenSeen();
void paintFeatured("movers", $("wl-mv"), (t) => `${fiat(t.volume)} vol`);
void paintFeatured("new", $("wl-nw"), (t) => (t.bornAt ? `${age(t.bornAt)} old` : ""));

mountAccount($("ac"), {
  self: () => accountsButton(),
});
noZoom();
mountPwa();
onSession(refresh);
void openLinked();
refresh();
showCat();
paintTop();
paintKeys();
paintActions();
