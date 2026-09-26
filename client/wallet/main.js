/**
 * The wallet page. Left: what you hold, and the tokens you could add. Right:
 * the chosen token's line and market data.
 *
 * The portfolio is the signed-in account's wallet. A wallet connected in the
 * trade dialog stands in when nobody is signed in. /api/holdings answers about
 * any public address, so neither needs a wallet prompt to paint.
 */
import { $, el } from "../js/dom.js";
import { LOGIN, mountAccount, openLogin } from "../js/acct.js";
import { load } from "../js/lazy.js";
import { account as whoami } from "../js/me.js";
import { dollars, fiat, percent, tokenPrice } from "../js/num.js";
import { onSession, readSession } from "../js/session.js";
import { openSwap, swapUrl } from "../js/swap.js";
import { hoursAgo, lineChart, valueAt } from "./chart.js";
import { icon, mountPanel } from "./panel.js";

const total = $("wl-v");
const delta = $("wl-d");
const list = $("wl-l");
const note = $("wl-n");
const extra = $("wl-x");
const keys = $("wl-ph");
const topHead = $("wl-th");
const topList = $("wl-tl");
const topNote = $("wl-tn");
const filter = /** @type {HTMLInputElement} */ ($("wl-q"));
const side = $("wl-s");

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
    data.dust ?? 0,
    data.unpriced ?? 0,
    data.more ?? 0,
  ].join("|");
}

function setNote(text, kind) {
  note.textContent = text || "";
  note.className = `wl-n${kind ? ` ${kind}` : ""}`;
  note.hidden = !text;
}

/** Everything below the total, cleared before each render. */
function reset() {
  list.replaceChildren();
  extra.replaceChildren();
  note.replaceChildren();
  note.className = "wl-n";
  note.hidden = false;
  total.classList.remove("is-wait");
}

function dirOf(v) {
  return v > 0 ? "up" : v < 0 ? "dn" : "";
}

function paintFigures(data) {
  total.textContent = dollars(data.total);
  const move = data.change24h;
  delta.hidden = move == null || !data.series;
  if (delta.hidden) return;
  delta.className = `wl-d ${dirOf(move)}`;
  delta.textContent = `${percent(move, true)} 24h`;
}

const portfolio = lineChart($("wl-c"), "wlg", (i) => {
  if (!shown) return;
  const value = i < 0 ? null : valueAt(portfolio.bytes, i, shown.seriesLo, shown.seriesHi);
  if (value == null) return paintFigures(shown);
  total.textContent = dollars(value);
  const from = valueAt(portfolio.bytes, 0, shown.seriesLo, shown.seriesHi);
  const move = from ? (value / from - 1) * 100 : 0;
  delta.className = `wl-d ${dirOf(move)}`;
  delta.textContent = `${percent(move, true)} · ${hoursAgo(portfolio.bytes, i)}`;
});

function paintTotal(data) {
  paintFigures(data);
  if (data.change24h == null) portfolio.draw("", "");
  else portfolio.draw(data.series, dirOf(data.change24h));
}

/**
 * Buy or sell in the dialog the rest of the site trades in. With a label it is
 * the side panel's pill; without, a row's round + or −.
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
    text: label ? title : selling ? "−" : "+",
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

const select = mountPanel(side, (t) => trade(t, "buy", true));
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

// The phone's own back gesture leaves the panel the same way the header's Back does.
window.addEventListener("popstate", () => {
  if (document.body.classList.contains("deep")) shallow();
});

$("bk").addEventListener("click", () => {
  if (history.state?.wlDeep) history.back();
  else shallow();
});

/** The first thing listed is shown until someone picks something. */
function chooseFirst(mint) {
  if (!chosen && mint) choose(mint, false);
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

/** @param {import('../../src/types').Holding} h */
function row(h) {
  return el(
    "div",
    { class: `wl-r${h.mint === chosen ? " on" : ""}`, "data-mint": h.mint },
    ident(h),
    el("span", { class: "wl-usd", text: dollars(h.usd) }),
    el("span", { class: "wl-act" }, trade(h, "buy"), trade(h, "sell")),
  );
}

/** @param {import('../../src/types').TopToken} t */
function topRow(t) {
  const price = tokenPrice(t.price);
  const move = t.change24h;
  return el(
    "div",
    { class: `wl-r wl-tr${t.mint === chosen ? " on" : ""}`, "data-mint": t.mint },
    ident(t),
    el(
      "span",
      { class: "wl-px" },
      el("span", { text: price.text, title: price.title }),
      move == null ? null : el("span", { class: `wl-d ${dirOf(move)}`, text: percent(move, true) }),
    ),
    el("span", { class: "wl-vol", text: t.volume ? fiat(t.volume) : "", title: "24h volume" }),
    el("span", { class: "wl-act" }, trade(t, "buy")),
  );
}

let searchRun = 0;

/** Trending with an empty field; otherwise the whole index, closest first. */
async function paintTop() {
  const q = filter.value.trim();
  const id = ++searchRun;
  try {
    const res = await fetch(`/api/tokens${q ? `?q=${encodeURIComponent(q)}` : ""}`, {
      headers: { Accept: "application/json" },
    });
    const data = await res.json();
    if (id !== searchRun) return;
    if (!res.ok) throw new Error(data.error);
    const tokens = data.tokens ?? [];
    topHead.textContent = q ? "Results" : "Trending";
    topList.replaceChildren(...tokens.map(topRow));
    topNote.hidden = tokens.length > 0;
    topNote.textContent = q ? "No token by that name." : "Nothing is trending right now.";
    if (!q) chooseFirst(tokens[0]?.mint);
  } catch {
    if (id !== searchRun) return;
    topNote.hidden = false;
    topNote.textContent = "Could not load tokens.";
  }
}

let typing = 0;
filter.addEventListener("input", () => {
  clearTimeout(typing);
  typing = setTimeout(paintTop, 180);
});

/** Receive, send and swap: the signed-in account's own wallet only. */
let wired = false;
async function paintActions() {
  const me = await account;
  if (!me || wired) return;
  wired = true;
  const dialogs = () => load("ks", "__keys");
  for (const button of actions.querySelectorAll("button")) {
    button.addEventListener("click", async () => {
      button.disabled = true;
      try {
        const act = button.dataset.act;
        if (act === "swap") await openTrade(known.get(chosen) ?? { mint: SOL, symbol: "SOL", decimals: 9 }, "buy");
        else if (act === "receive") (await dialogs()).receive(me);
        else (await dialogs()).send(me, shown?.items ?? [], () => void settle());
      } catch {
        setNote("Could not open that. Try again.", "err");
      } finally {
        button.disabled = false;
      }
    });
  }
  actions.hidden = false;
}

const SOL = "So11111111111111111111111111111111111111112";

/** Only a Social account has a phrase here; a connected wallet keeps its own. */
async function paintKeys() {
  const me = await account;
  if (!me) return;
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
  keys.replaceChildren(
    el("span", { class: "wl-k", text: `@${me.name}` }),
    el("span", { class: "wl-ka", text: me.address, title: me.address }),
    button,
  );
  keys.hidden = false;
}

/** What the page left out, said plainly, so a filtered list does not read as everything. */
function omitted(data) {
  const parts = [];
  if (data.more) parts.push(`${data.more} smaller holding${data.more > 1 ? "s" : ""}`);
  if (data.dust) parts.push(`${data.dust} worth under a cent`);
  if (data.unpriced) {
    parts.push(`${data.unpriced} token${data.unpriced > 1 ? "s" : ""} we hold no price for`);
  }
  return parts.length ? `Not shown: ${parts.join(", ")}.` : "";
}

function paint(data) {
  reset();
  shown = data;
  paintTotal(data);

  if (!data.items.length) {
    setNote(data.unpriced ? omitted(data) : "This wallet holds nothing we can price.");
    return;
  }

  list.append(...data.items.map(row));
  setNote(omitted(data));
  chooseFirst(data.items[0].mint);
}

/** Nobody signed in: an offer, not an error. */
function offer() {
  reset();
  shown = null;
  paintTotal({ total: NaN });
  total.textContent = "—";
  setNote("Log in to see your wallet.");
  extra.append(el("button", { class: "ac-go", type: "button", text: LOGIN, onclick: () => openLogin(signedIn) }));
}

/** The dialog has signed someone in: ask the server who, and paint their wallet. */
function signedIn() {
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
    body: JSON.stringify({ owner: address }),
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

  reset();
  setNote("Reading your wallet…");

  try {
    const data = await readHoldings(address);
    if (id !== run) return;
    paint(data);
  } catch (err) {
    if (id !== run) return;
    reset();
    // A lookup that did not happen must never read as an empty portfolio.
    total.textContent = "—";
    setNote(err?.message || "Could not read this wallet.", "err");
    extra.append(el("button", { class: "wl-b", type: "button", text: "Try again", onclick: refresh }));
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

mountAccount($("ac"), { self: true, onLogin: signedIn });
onSession(refresh);
refresh();
paintTop();
paintKeys();
paintActions();
