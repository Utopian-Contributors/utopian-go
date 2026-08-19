/**
 * The wallet page: what you hold, what it is worth, and two ways to change it.
 *
 * Its own document and its own bundle, sharing only the account control and a
 * handful of helpers with the search shell. That is what keeps it cheap — none
 * of the search machinery is fetched to render a list of balances, and the
 * trade dialog arrives only if a position's buy or sell is actually pressed.
 *
 * The page needs no wallet interaction at all to do its job. An address is
 * enough to read a portfolio, the browser already remembered one, and
 * /api/holdings answers about whatever public address it is handed — so a
 * return visit paints real numbers without a single wallet prompt. Connecting
 * is only offered when there is no remembered address to work from.
 */
import { $, el } from "../js/dom.js";
import { mountAccount } from "../js/acct.js";
import { load } from "../js/lazy.js";
import { dollars, percent } from "../js/num.js";
import { onSession, readSession } from "../js/session.js";
import { openSwap, swapUrl } from "../js/swap.js";

const total = $("wl-v");
const delta = $("wl-d");
const chartBox = $("wl-c");
const caption = $("wl-cap");
const list = $("wl-l");
const note = $("wl-n");
const extra = $("wl-x");

/**
 * How long to keep re-reading after a trade, and how far apart.
 *
 * A wallet resolves signAndSend once it has *broadcast* a transaction, which
 * is not the same as the chain having settled it — so a single re-read a
 * moment later usually returns the pre-trade balances and reads as a trade
 * that did nothing. These gaps are all comfortably longer than the server's
 * five-second hold on a wallet's holdings, so every one of them can see new
 * state rather than being answered out of the same cache entry.
 */
const SETTLE_MS = [1500, 6000, 6000, 8000];

const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/** The last painted portfolio, so a re-read can tell whether anything moved. */
let shown = null;

/**
 * What a portfolio *is*, for the purpose of "has it changed yet".
 *
 * Amounts only. Prices move every few seconds and the totals with them, so
 * comparing dollars would call any two reads different and the wait would end
 * on the first poll whatever the chain had done.
 */
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

/**
 * The hovered hour, and the bytes behind the line currently drawn.
 *
 * Module state rather than a closure because the pointer handlers are bound
 * once, to a box that survives every repaint — a chart redrawn under a
 * stationary cursor has to keep answering about the point it is under.
 */
let bytes = [];
let hovered = -1;

/**
 * The portfolio's worth at one point on the line.
 *
 * The bytes are a shape scaled between two dollar figures the server sends
 * with them, so this is the inverse of that scaling and nothing more.
 */
function valueAt(i) {
  const lo = shown?.seriesLo;
  const hi = shown?.seriesHi;
  if (lo == null || hi == null || !bytes.length) return null;
  return lo + (bytes[i] / 255) * (hi - lo);
}

/**
 * The day's shape, as an SVG path.
 *
 * The bytes are a shape — one per hour, scaled so the day's low is 0 and its
 * high is 255 — so there is no arithmetic here beyond flipping the y axis. The
 * viewBox does the scaling, which is what lets the same line fill whatever
 * width the page turns out to have.
 *
 * @returns {boolean} whether anything was drawn
 */
function drawChart(series, dir) {
  let raw;
  try {
    raw = atob(series);
  } catch {
    // Not base64. Nothing to draw, and not worth breaking the page over.
    return false;
  }
  if (raw.length < 2) return false;
  bytes = [...raw].map((c) => c.charCodeAt(0));

  const pts = bytes.map((b, i) => `${i},${255 - b}`);
  const line = pts.join("L");
  const last = pts.length - 1;
  chartBox.className = `wl-c${dir ? ` ${dir}` : ""}`;
  // Every value interpolated here is a number this function computed: `last`
  // is a length, and `line` is built out of byte values.
  chartBox.innerHTML =
    `<svg viewBox="0 0 ${last} 255" preserveAspectRatio="none"` +
    ` aria-hidden="true"><linearGradient id="wlg" x2="0" y2="1">` +
    `<stop/><stop offset="1"/></linearGradient>` +
    `<path d="M${line}L${last},255L0,255Z" fill="url(#wlg)"/>` +
    `<path d="M${line}"/></svg>`;
  chartBox.append(dot);
  chartBox.hidden = false;
  return true;
}

/**
 * The marker, as an element rather than as SVG.
 *
 * The drawing is stretched to fill its box with `preserveAspectRatio="none"`,
 * which a stroked path survives — see the stylesheet — and a circle does not:
 * inside the viewBox it would be drawn as an ellipse as wide as the box is
 * wide. Positioned in the box's own coordinates instead, it stays round.
 */
const dot = el("span", { class: "wl-dot", hidden: true });

/** Move the marker onto point `i`, or hide it when there is none. */
function markDot(i) {
  if (i < 0 || !bytes.length) {
    dot.hidden = true;
    return;
  }
  dot.hidden = false;
  dot.style.left = `${(i / (bytes.length - 1)) * 100}%`;
  // Matching the stylesheet's 5px vertical inset on the drawing itself, so the
  // marker sits on the line rather than beside it.
  dot.style.top = `calc(5px + ${1 - bytes[i] / 255} * (100% - 10px))`;
}

/** Hours before now, as the axis has no room to label itself. */
function whenLabel(i) {
  const back = bytes.length - 1 - i;
  return back === 0 ? "now" : `${back}h ago`;
}

/**
 * Read the line at the cursor.
 *
 * The chart is 24 points wide and a few hundred pixels across, so the nearest
 * point is what the cursor means — interpolating between hours would invent
 * figures the server never computed.
 */
function onScrub(e) {
  if (!bytes.length) return;
  const box = chartBox.getBoundingClientRect();
  if (!box.width) return;
  const frac = Math.min(1, Math.max(0, (e.clientX - box.left) / box.width));
  const i = Math.round(frac * (bytes.length - 1));
  if (i === hovered) return;
  hovered = i;
  markDot(i);

  const value = valueAt(i);
  if (value == null) return;
  total.textContent = dollars(value);
  const from = valueAt(0);
  const move = from ? (value / from - 1) * 100 : 0;
  const dir = move > 0 ? "up" : move < 0 ? "dn" : "";
  delta.className = `wl-d${dir ? ` ${dir}` : ""}`;
  delta.textContent = `${percent(move, true)} · ${whenLabel(i)}`;
}

/** Back to the live figures the page is actually about. */
function endScrub() {
  if (hovered < 0) return;
  hovered = -1;
  markDot(-1);
  if (shown) paintTotal(shown);
}

chartBox.addEventListener("pointermove", onScrub);
chartBox.addEventListener("pointerleave", endScrub);
// A touch that ends without leaving the box would otherwise leave the header
// stuck on whatever hour the finger lifted over.
chartBox.addEventListener("pointercancel", endScrub);
chartBox.addEventListener("pointerup", endScrub);

/** The headline figure, the day's move, and the line under both. */
function paintTotal(data) {
  total.textContent = dollars(data.total);

  const move = data.change24h;
  if (move == null || !data.series) {
    delta.hidden = true;
    chartBox.hidden = true;
    caption.hidden = true;
    bytes = [];
    return;
  }

  const dir = move > 0 ? "up" : move < 0 ? "dn" : "";
  delta.hidden = false;
  delta.className = `wl-d${dir ? ` ${dir}` : ""}`;
  delta.textContent = `${percent(move, true)} 24h`;

  const drawn = drawChart(data.series, dir);
  caption.hidden = !drawn;
  if (drawn) {
    caption.textContent =
      "Last 24 hours — today's holdings at each hour's price, not a record of" +
      " what you held.";
  }
}

/**
 * Buy or sell one position, in the dialog the rest of the site trades in.
 *
 * @param {import('../../src/types').Holding} h
 * @param {"buy" | "sell"} mode
 */
function trade(h, mode) {
  const selling = mode === "sell";
  const label = `${selling ? "Sell" : "Buy"} ${h.symbol}`;
  return el("button", {
    class: `wl-t${selling ? " wl-sell" : ""}`,
    type: "button",
    text: selling ? "−" : "+",
    title: label,
    "aria-label": label,
    onclick: async (e) => {
      const button = e.currentTarget;
      button.disabled = true;
      try {
        await openSwap({
          mint: h.mint,
          symbol: h.symbol,
          decimals: h.decimals,
          // What the dialog values this side of the trade in dollars with.
          price: h.price,
          fallback: swapUrl(h.mint),
          mode,
          // Only when something was actually broadcast — closing a dialog
          // nobody traded in has nothing to wait for.
          onClose: (sent) => {
            if (sent) void settle();
          },
        });
      } catch {
        // The bundle would not load. Jupiter's own UI is the floor, the same
        // one the price card's Buy button falls back to.
        window.location.href = swapUrl(h.mint);
      } finally {
        button.disabled = false;
      }
    },
  });
}

/**
 * A row: what it is, what it is worth, and the two controls.
 *
 * The identity is a link to the token's own card, which is where the price,
 * the day's shape and the market data already live. `$` prefixes the ticker so
 * the matcher reads it as an unambiguous symbol rather than as an English
 * word — without it a holding in a token called GO searches the web for "go".
 *
 * Worth in dollars is the only figure on the line. The token balance used to
 * sit beside it and is deliberately gone: this page is read down its values,
 * and a count of tokens is a second number in a different unit for every row —
 * one nobody can compare against the row above it, or against the total at the
 * top, which is stated in dollars. The exact balance is a wallet's job to
 * report; whoever needs it opens theirs. h.amount is still read — signature()
 * watches it to tell a settled trade from an unchanged one — just not shown.
 *
 * @param {import('../../src/types').Holding} h
 */
function row(h) {
  return el(
    "div",
    { class: "wl-r" },
    el(
      "a",
      { class: "wl-id", href: `/?q=${encodeURIComponent(`$${h.symbol}`)}` },
      el("span", { class: "wl-sym", text: h.symbol }),
      el("span", { class: "wl-nm", text: h.name }),
    ),
    el("span", { class: "wl-usd", text: dollars(h.usd) }),
    el("span", { class: "wl-act" }, trade(h, "buy"), trade(h, "sell")),
  );
}

/**
 * What the page left out, said plainly.
 *
 * The alternative — showing a filtered list with no remark — reads as a claim
 * that this is everything, which for a wallet full of airdropped mints is the
 * one thing it is not.
 */
function omitted(data) {
  const parts = [];
  if (data.more) parts.push(`${data.more} smaller holding${data.more > 1 ? "s" : ""}`);
  if (data.dust) parts.push(`${data.dust} worth under a cent`);
  if (data.unpriced) {
    parts.push(
      `${data.unpriced} token${data.unpriced > 1 ? "s" : ""} we hold no price for`,
    );
  }
  if (!parts.length) return "";
  return `Not shown: ${parts.join(", ")}.`;
}

function paint(data) {
  reset();
  shown = data;
  // A repaint under a resting cursor redraws the line; the marker's old point
  // belongs to a series that no longer exists.
  hovered = -1;
  markDot(-1);
  paintTotal(data);

  if (!data.items.length) {
    setNote(
      data.unpriced ? omitted(data) : "This wallet holds nothing we can price.",
    );
    return;
  }

  list.append(...data.items.map(row));
  setNote(omitted(data));
}

/** The logged-out state: an offer, not an error. */
function offer() {
  reset();
  shown = null;
  paintTotal({ total: NaN });
  total.textContent = "—";
  setNote("Connect a wallet to see what it holds.");
  const cta = el("button", {
    class: "wl-cta",
    type: "button",
    text: "Connect wallet",
    onclick: async () => {
      cta.disabled = true;
      try {
        const panel = await load("cn", "__connect");
        await panel.start();
      } catch {
        setNote("Could not open the wallet picker.", "err");
      } finally {
        cta.disabled = false;
      }
    },
  });
  extra.append(cta);
}

/**
 * One read of the portfolio. Throws on anything that is not an answer.
 *
 * POSTed rather than queried, for the same reason /api/balances is: a wallet
 * address in a query string is written to the hosting provider's request log
 * beside the caller's IP.
 */
async function readHoldings(owner) {
  const res = await fetch("/api/holdings", {
    method: "POST",
    headers: { "Content-Type": "application/json", Accept: "application/json" },
    body: JSON.stringify({ owner }),
  });
  const data = await res.json().catch(() => null);
  if (!res.ok || !data || data.error) {
    throw new Error(data?.error || `holdings ${res.status}`);
  }
  return data;
}

/**
 * Guards against a stale reply painting over a newer one.
 *
 * Shared by the plain read and the post-trade wait, so either cancels the
 * other: a manual retry, a logout, or a second trade all take over cleanly
 * rather than racing a timer nobody can see.
 */
let run = 0;

async function refresh() {
  const saved = readSession();
  if (!saved) return offer();

  const id = ++run;
  // Clears the retry control along with everything else, which is the point:
  // it is rebuilt by whichever state comes next, so it can neither pile up nor
  // sit there during a lookup that is already in flight.
  reset();
  setNote("Reading your wallet…");

  try {
    const data = await readHoldings(saved.address);
    if (id !== run) return;
    paint(data);
  } catch (err) {
    if (id !== run) return;
    reset();
    // The total keeps its dash rather than falling to zero: a lookup that did
    // not happen must never be shown as a portfolio that is empty.
    total.textContent = "—";
    setNote(err?.message || "Could not read this wallet.", "err");
    extra.append(
      el("button", {
        class: "wl-b",
        type: "button",
        text: "Try again",
        onclick: refresh,
      }),
    );
  }
}

/**
 * Wait for a broadcast trade to actually reach the balances, then repaint.
 *
 * The wallet told us it sent something; the chain has not necessarily agreed
 * yet. So the page says so and keeps asking, stopping the moment the holdings
 * differ from the ones on screen — which is the only reliable signal available
 * here, since this app holds no RPC of its own to watch a signature with.
 *
 * The figures already on screen stay up throughout. They are stale by exactly
 * one trade, and a stale number that is labelled as settling beats an empty
 * space or a spinner where someone's balance used to be.
 */
async function settle() {
  const saved = readSession();
  if (!saved) return;

  const id = ++run;
  const before = shown ? signature(shown) : "";
  total.classList.add("is-wait");
  setNote("Trade sent — waiting for it to reach your balance…");

  for (const ms of SETTLE_MS) {
    await wait(ms);
    if (id !== run) return;

    let data;
    try {
      data = await readHoldings(saved.address);
    } catch {
      // A refused or throttled read is not evidence about the trade; wait for
      // the next slot rather than giving up on it.
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
  // Not an error, and not a claim the trade failed — only that we stopped
  // watching. The transaction may still land; the link in the dialog is how
  // anyone checks, and reloading picks up whatever settled since.
  setNote(
    "Trade sent, but your balance has not changed yet. It can take a moment —" +
      " reload to check again.",
  );
}

mountAccount($("ac"), { self: true });
// Logging in or out from the header repaints the page under it, so the two
// never disagree about whose wallet this is.
onSession(refresh);
refresh();
