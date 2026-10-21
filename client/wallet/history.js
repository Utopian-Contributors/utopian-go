/**
 * History: what the wallet has done, newest first, a page at a time from
 * POST /api/history as the list scrolls. Opened from the button on the
 * Portfolio heading, it takes the left half's place (body.hist in
 * wallet.css) until Back.
 *
 * Amounts only, never dollars. What a trade was worth is its price at the
 * time, which nothing here knows; today's price would put a figure on it that
 * was never true.
 */
import { coinIcon } from "../js/coin.js";
import { $, el } from "../js/dom.js";
import { load } from "../js/lazy.js";
import { amount } from "../js/num.js";

const list = $("wl-hl");
const note = $("wl-hn");

const SOL_MINT = "So11111111111111111111111111111111111111112";

const TITLES = { send: "Sent", receive: "Received", swap: "Swapped", failed: "Failed", other: "Transaction" };

/** Enough to tell two apart at a glance, not to check one against: Send spells an address out in full. */
function short(address) {
  return `${address.slice(0, 4)}…${address.slice(-4)}`;
}

/** @param {import('../../src/types').ActivityMove} m */
function symbolOf(m) {
  return m.symbol || short(m.mint);
}

/**
 * A change, so it always says which way: + in, − out. A token we do not list
 * opens what the chain says about it. A control inside the row's link, so it
 * keeps its click to itself.
 */
function move(/** @type {import('../../src/types').ActivityMove} */ m) {
  const out = m.amount.startsWith("-");
  const sign = out ? "−" : "+";
  const a = amount(m.amount, m.decimals, m.price);
  const bare = (/** @type {string} */ s) => s.replace(/^-/, "");
  const span = el("span", {
    class: [out ? null : "up", m.symbol ? null : "wl-unk"].filter(Boolean).join(" ") || null,
    text: `${sign}${bare(a.text)} ${symbolOf(m)}`,
    title: m.symbol ? `${sign}${bare(a.title ?? a.text)} ${m.symbol}` : "What is this token?",
  });
  if (m.symbol) return span;
  const open = (/** @type {Event} */ e) => {
    e.preventDefault();
    e.stopPropagation();
    load("ks", "__keys").then(
      (k) => k.tokens([{ mint: m.mint, amount: m.amount, decimals: m.decimals }], { signed: true }),
      () => {},
    );
  };
  span.setAttribute("role", "button");
  span.tabIndex = 0;
  span.addEventListener("click", open);
  span.addEventListener("keydown", (e) => (e.key === "Enter" || e.key === " ") && open(e));
  return span;
}

const start = (/** @type {Date} */ d) => new Date(d.getFullYear(), d.getMonth(), d.getDate()).getTime();

/** Today, Yesterday, then the date; the year only once it is not this one. */
function dayOf(at) {
  const d = new Date(at);
  const now = new Date();
  const ago = Math.round((start(now) - start(d)) / 86_400_000);
  if (ago === 0) return "Today";
  if (ago === 1) return "Yesterday";
  return d.toLocaleDateString("en-US", {
    month: "short",
    day: "numeric",
    year: d.getFullYear() === now.getFullYear() ? undefined : "numeric",
  });
}

/** @param {import('../../src/types').Activity} a */
function line(a) {
  const parts = [];
  if (a.peer) parts.push(`${a.kind === "send" ? "To" : "From"} ${a.peerName ? `@${a.peerName}` : short(a.peer)}`);
  else if (a.kind === "swap" && a.moves.length === 2) parts.push(`${symbolOf(a.moves[0])} to ${symbolOf(a.moves[1])}`);
  else if (a.kind === "failed") parts.push("Did not go through");
  if (a.at) parts.push(new Date(a.at).toLocaleTimeString("en-US", { hour: "numeric", minute: "2-digit" }));
  return parts.join(" · ");
}

/**
 * What a swap was for. SOL is where every trade starts and ends, so it is the
 * other side: what came in, or failing that what went out. Two tokens neither
 * of them SOL read the same way, by what came in.
 * @param {import('../../src/types').Activity} a
 */
function traded(a) {
  if (a.kind !== "swap") return null;
  const other = a.moves.filter((m) => m.mint !== SOL_MINT);
  return other.find((m) => !m.amount.startsWith("-")) ?? other[0] ?? null;
}

/** A swap shows the token it traded, marked + bought or − sold; anything else, the tiles' mark. */
function glyph(/** @type {import('../../src/types').Activity} */ a) {
  const m = traded(a);
  if (!m) return el("span", { class: `wl-hg ${a.kind}`, "aria-hidden": "true" });
  const out = m.amount.startsWith("-");
  return el(
    "span",
    { class: "wl-hg tok", "aria-hidden": "true" },
    coinIcon(m, 34, "wl-ic", "wl-coin"),
    el("span", { class: `wl-hpm${out ? " out" : ""}`, text: out ? "−" : "+" }),
  );
}

/** @param {import('../../src/types').Activity} a */
function row(a) {
  return el(
    "a",
    { class: "wl-hr", href: `https://solscan.io/tx/${a.signature}`, target: "_blank", rel: "noopener" },
    glyph(a),
    el(
      "span",
      { class: "wl-hw" },
      el("span", { class: "wl-ht", text: TITLES[a.kind] ?? TITLES.other }),
      el("span", { class: "wl-hsub", text: line(a) }),
    ),
    el("span", { class: "wl-hm" }, ...a.moves.map(move)),
  );
}

/**
 * @param {() => Element | null} root what the list scrolls with: the left
 *   half on a desktop, the page on a phone (as the token lists)
 */
export function mountHistory(root) {
  /** Bumped by every open and close, so a page that lands late is dropped. */
  let run = 0;
  let owner = "";
  /** Where the next page starts; empty once there is none. */
  let after = "";
  let busy = false;
  /** Left out so far, across pages, for the line at the end. */
  let hidden = 0;
  /** The day heading last written, so a page that goes on with it adds none. */
  let day = "";
  /** Sits after the last row while there is more, and asks for it when scrolled near. */
  const end = el("div", { "aria-hidden": "true" });
  /** @type {IntersectionObserver | null} */
  let pager = null;

  function say(text, retry) {
    note.replaceChildren(text);
    if (retry) note.append(" ", el("button", { class: "wl-b", type: "button", text: "Try again", onclick: retry }));
    note.className = `wl-n${retry ? " err" : ""}`;
    note.hidden = !text;
  }

  function watch() {
    pager?.unobserve(end);
    if (!after) return end.remove();
    list.append(end);
    // Reports at once when the end is already near, so a short page asks for the next by itself.
    pager?.observe(end);
  }

  function rewatch() {
    pager?.disconnect();
    pager = new IntersectionObserver((seen) => seen.some((e) => e.isIntersecting) && void page(), {
      root: root(),
      rootMargin: "0px 0px 600px 0px",
    });
    if (end.isConnected) pager.observe(end);
  }

  async function page() {
    if (busy) return;
    busy = true;
    const id = run;
    const first = !list.firstChild;
    if (first) say("Reading history…");
    try {
      const res = await fetch("/api/history", {
        method: "POST",
        headers: { "Content-Type": "application/json", Accept: "application/json" },
        body: JSON.stringify({ owner, after }),
      });
      const data = await res.json().catch(() => null);
      if (id !== run) return;
      if (!res.ok || !data || data.error) throw new Error(data?.error || "");

      hidden += data.hidden ?? 0;
      const rows = [];
      for (const a of data.items) {
        const d = a.at ? dayOf(a.at) : day;
        if (d && d !== day) rows.push(el("h3", { class: "wl-k wl-day", text: (day = d) }));
        rows.push(row(a));
      }
      list.append(...rows);
      after = data.after ?? "";
      watch();

      if (after) say("");
      else if (!list.querySelector(".wl-hr")) {
        say(hidden ? `Nothing to show: ${left()}.` : "Nothing has happened in this wallet yet.");
      } else say(hidden ? `Not shown: ${left()}.` : "");
    } catch (err) {
      if (id !== run) return;
      // Still the page that failed: Try again asks for the same one.
      pager?.unobserve(end);
      say(err instanceof Error && err.message ? err.message : "Could not read this wallet's history.", () => {
        say("");
        void page();
      });
    } finally {
      if (id === run) busy = false;
    }
  }

  function left() {
    return `${hidden} transaction${hidden > 1 ? "s" : ""} worth under a cent, or only of tokens we do not list`;
  }

  return {
    /** @param {string} address */
    open(address) {
      run += 1;
      owner = address;
      after = "";
      busy = false;
      hidden = 0;
      day = "";
      list.replaceChildren();
      rewatch();
      void page();
    },
    close() {
      run += 1;
      pager?.disconnect();
      pager = null;
      end.remove();
    },
    /** The scroller changed (a desktop narrowed to a phone, or back): watch the end against the new one. */
    rewatch() {
      if (pager) rewatch();
    },
  };
}
