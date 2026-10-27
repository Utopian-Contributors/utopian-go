/**
 * The wallet page. Left: what you hold, by kind and by token, and the tokens
 * you could add, list by list. Right: the chosen token's line and market data.
 *
 * The portfolio is the signed-in account's wallet. A wallet connected in the
 * trade dialog stands in when nobody is signed in. /api/holdings answers about
 * any public address, so neither needs a wallet prompt to paint.
 */
import { $, el } from "../js/dom.js";
import { LOGIN, logOutButton, mountAccount, openLogin } from "../js/acct.js";
import { noZoom } from "../js/device.js";
import { load } from "../js/lazy.js";
import { account as whoami } from "../js/me.js";
import { during } from "../js/progress.js";
import { mountPwa } from "../js/pwa.js";
import { UTCC } from "../js/utcc.js";
import { amount, dollars, percent, tokenPrice } from "../js/num.js";
import { onSession, readSession } from "../js/session.js";
import { openSwap, swapUrl } from "../js/swap.js";
import { KINDS } from "../js/kinds.js";
import { dirOf, figure, lineChart, paintMove, rangeTabs, since, when } from "../js/chart.js";
import { mountBreakdown } from "./breakdown.js";
import { mountHistory } from "./history.js";
import { icon, mountPanel } from "./panel.js";

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
const pfHead = $("wl-pf-h");
const chips = /** @type {HTMLButtonElement[]} */ ([...$("wl-cats").querySelectorAll("button")]);

const actions = $("wl-acts");
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
  paintHead();
  paintTotal();
  paintRows();
});

function paintHead() {
  const kind = shown ? breakdown.picked : "";
  pfHead.textContent = kind ? `Portfolio · ${KINDS[kind] ?? kind}` : "Portfolio";
}

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
    class: label ? "wl-cta tp-buy" : `wl-t${selling ? " wl-sell" : ""}`,
    type: "button",
    text: label ? title : null,
    title,
    "aria-label": title,
    onclick: async (e) => {
      const button = e.currentTarget;
      button.disabled = true;
      await openTrade(h, mode);
      button.disabled = false;
    },
  });
}

/** Every token a row has shown, so Swap can open on the one in the panel. */
const known = new Map();

const select = mountPanel(side, (t) => {
  // A linked token may be on neither list, and Swap opens on what the panel shows.
  if (!known.has(t.mint)) known.set(t.mint, t);
  return trade(t, "buy", true);
});
let chosen = "";

function choose(mint, scroll) {
  chosen = mint;
  for (const r of document.querySelectorAll(".wl-r")) {
    r.classList.toggle("on", /** @type {HTMLElement} */ (r).dataset.mint === mint);
  }
  void select(mint);
  if (!scroll || matchMedia("(min-width: 960px)").matches) return;
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

/** The first thing listed is shown until someone picks something. */
function chooseFirst(mint) {
  if (!chosen && mint) choose(mint, false);
}

/**
 * `/wallet?t=<mint>` opens on that token as though its row had been picked;
 * Social's Trending assets link here. A mint the index cannot answer for
 * leaves the usual first choice, with no error for a link nobody typed.
 */
async function openLinked() {
  const mint = new URLSearchParams(location.search).get("t");
  if (!mint) return;
  chosen = mint; // holds off chooseFirst while it loads
  const ok = await select(mint, true);
  if (chosen !== mint) return; // a row was picked meanwhile
  if (ok) return choose(mint, true);
  chosen = "";
  chooseFirst(/** @type {HTMLElement | null} */ (document.querySelector(".wl-r"))?.dataset.mint);
}

function ident(t) {
  known.set(t.mint, t);
  return el(
    "button",
    { class: "wl-id", type: "button", onclick: () => choose(t.mint, true) },
    icon(t),
    el("span", { class: "wl-sym", text: t.symbol }),
    el("span", { class: "wl-nm", text: t.name }),
  );
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
      // button a keyboard reaches, and Buy keeps its own click.
      onclick: (event) => {
        if (!event.target.closest(".wl-id, .wl-act")) choose(t.mint, true);
      },
    },
    ident(t),
    el(
      "span",
      { class: "wl-px" },
      el("span", { text: price.text, title: price.title }),
      move == null ? null : el("span", { class: `wl-d ${dirOf(move)}`, text: percent(move, true) }),
    ),
    el("span", { class: "wl-act" }, trade(t, "buy")),
  );
}

let searchRun = 0;

/** The list on show: Trending, or one kind. `?c=` picks it; the buttons pick it after that. */
let cat = (() => {
  const asked = new URLSearchParams(location.search).get("c");
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
    topNote.textContent = q
      ? "No token by that name."
      : cat === "trending"
        ? "Nothing is trending right now."
        : "Nothing on this list right now.";
    if (!q) chooseFirst(rows[0]?.mint);
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
 * Where the list scrolls: with the left half on a desktop (wallet.css), with
 * the page on a phone. The watcher has to be told which, so it can ask for
 * the next page a screenful ahead rather than once the end is on screen.
 */
const desk = matchMedia("(min-width: 960px)");
const column = /** @type {HTMLElement} */ (document.querySelector(".wl-main"));
let pager = watcher();

function watcher() {
  const next = new IntersectionObserver(
    (seen) => {
      if (seen.some((e) => e.isIntersecting)) void paintMore();
    },
    { root: desk.matches ? column : null, rootMargin: "0px 0px 600px 0px" },
  );
  if (end.isConnected) next.observe(end);
  return next;
}

desk.addEventListener("change", () => {
  pager.disconnect();
  pager = watcher();
  past.rewatch();
});

/**
 * History, in the left half's place. Its Back, or the phone's own, puts the
 * portfolio back where it was scrolled to. Offered for whichever wallet the
 * portfolio is showing.
 */
const historyButton = $("wl-hb");
const historyView = $("wl-hs");
const past = mountHistory(() => (desk.matches ? column : null));
/** Where the page was scrolled before History took its place. */
let historyFrom = 0;

async function openHistory() {
  const address = await owner();
  if (!address || document.body.classList.contains("hist")) return;
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
  past.close();
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
  const floor = desk.matches ? column.getBoundingClientRect().top : $("chrome").getBoundingClientRect().bottom;
  const over = /** @type {HTMLElement} */ (topList.parentElement).getBoundingClientRect().top - floor;
  if (over >= 0) return;
  if (desk.matches) column.scrollTop += over;
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
    const url = new URL(location.href);
    if (cat === "trending") url.searchParams.delete("c");
    else url.searchParams.set("c", cat);
    history.replaceState(history.state, "", url);
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
  // New balances: last read's entries are for what was held then.
  const moved = signature(data) !== entriesFor;
  if (moved) entries = new Map();
  breakdown.paint(data);
  paintHead();
  paintTotal();

  if (!data.items.length) {
    setNote(data.unpriced ? omitted(data) : "This wallet holds nothing we can price.");
    return;
  }

  paintRows();
  if (moved) void readEntries(data);
  setNote(omitted(data));
  chooseFirst(data.items[0].mint);
}

/** Nobody signed in: an offer, not an error. */
function offer() {
  reset();
  firstPainted();
  shown = null;
  historyButton.hidden = true;
  paintHead();
  paintTotal();
  total.textContent = "—";
  setNote("Log in to see your wallet.");
  extra.append(el("button", { class: "ac-go", type: "button", text: LOGIN, onclick: () => openLogin(switched) }));
}

/**
 * The dialog has signed someone in, or Log out has signed them out: ask the
 * server who, and paint their wallet or the offer to log in.
 */
function switched() {
  // Someone else's history is not the one on show.
  closeHistory();
  // Nor are someone else's entries, whatever their balances.
  entriesFor = "";
  window.__ugme = null;
  account = whoami();
  refresh();
  paintKeys();
  paintActions();
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
  if (!address) return offer();

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

mountAccount($("ac"), {
  self: () => logOutButton((err) => (err ? setNote(err.message, "err") : switched())),
  onLogin: switched,
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
