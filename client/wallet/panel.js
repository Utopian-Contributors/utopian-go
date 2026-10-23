/**
 * The right half of the wallet page: one token's line and market data.
 * Everything comes from /api/tokens/<mint>, which only answers for indexed
 * mints; a range of the line other than 24h, from the chart beside it.
 */
import { dirOf, priceChart } from "../js/chart.js";
import { coinIcon } from "../js/coin.js";
import { el } from "../js/dom.js";
import { fiat, percent, tokenPrice } from "../js/num.js";

const WINDOWS = ["5m", "1h", "6h", "24h"];
const LINKS = [
  ["website", "Website"],
  ["twitter", "X"],
  ["telegram", "Telegram"],
  ["discord", "Discord"],
];

/** The synced thumbnail, or a coin the same size so the tickers stay in line. */
export function icon(t, size = 20) {
  return coinIcon(t, size, "wl-ic", "wl-coin");
}

function count(n) {
  if (n == null) return "--";
  return n < 10_000 ? n.toLocaleString("en-US") : fiat(n).slice(1);
}

function cell(label, value, title) {
  return el(
    "div",
    { class: "tp-cell" },
    el("span", { class: "wl-k", text: label }),
    el("strong", { text: value, ...(title ? { title } : {}) }),
  );
}

/** Two figures and a bar split between them, green for the buying side. */
function split(left, right, a, b, fmt) {
  const bar = el("div", { class: "tp-bar" });
  if (a || b) {
    const buy = el("i", {});
    const sell = el("i", {});
    buy.style.flexGrow = String(Number(a) || 0);
    sell.style.flexGrow = String(Number(b) || 0);
    bar.append(buy, sell);
  }
  return el(
    "div",
    {},
    el("div", { class: "tp-two" }, el("span", { class: "wl-k", text: left }), el("span", { class: "wl-k", text: right })),
    el("div", { class: "tp-two" }, el("strong", { text: fmt(a) }), el("strong", { text: fmt(b) })),
    bar,
  );
}

function stats(w) {
  const vol = (w?.buyVolume ?? 0) + (w?.sellVolume ?? 0);
  const txns = w?.buys != null && w?.sells != null ? w.buys + w.sells : null;
  const usd = (v) => (v == null ? "--" : fiat(v));
  return [
    el(
      "div",
      { class: "tp-l" },
      el("div", {}, el("span", { class: "wl-k", text: "Txns" }), el("strong", { text: count(txns) })),
      el("div", {}, el("span", { class: "wl-k", text: "Volume" }), el("strong", { text: w?.buyVolume == null ? "--" : fiat(vol) })),
      el("div", {}, el("span", { class: "wl-k", text: "Traders" }), el("strong", { text: count(w?.traders) })),
    ),
    el(
      "div",
      { class: "tp-r" },
      split("Buys", "Sells", w?.buys, w?.sells, count),
      split("Buy vol", "Sell vol", w?.buyVolume, w?.sellVolume, usd),
    ),
  ];
}

/**
 * @param {HTMLElement} box
 * @param {(t: any) => HTMLElement} buy the page's buy button for a token
 * @param {HTMLElement} [title] the header's slot beside Back, named on phones
 */
export function mountPanel(box, buy, title) {
  let run = 0;
  let current = "";

  function render(d) {
    const price = el("strong", { class: "wl-v" });
    const move = el("span", { class: "pc-m", hidden: true });
    const chartBox = el("div", { class: "pc tp-c" });
    const body = el("div", { class: "tp-st" });
    const ranges = priceChart({ ...d, change24h: d.windows?.["24h"]?.change }, price, move, chartBox);

    const tabs = WINDOWS.map((key) => {
      const change = d.windows?.[key]?.change;
      return el(
        "button",
        {
          type: "button",
          "aria-pressed": String(key === "24h"),
          onclick: (e) => {
            for (const t of tabs) t.setAttribute("aria-pressed", String(t === e.currentTarget));
            body.replaceChildren(...stats(d.windows?.[key]));
          },
        },
        el("span", { text: key.toUpperCase() }),
        el("strong", { class: `wl-d ${dirOf(change)}`, text: change == null ? "--" : percent(change) }),
      );
    });

    const links = LINKS.filter(([key]) => /^https:\/\//.test(d.links?.[key] || "")).map(([key, label]) =>
      el("a", { href: d.links[key], target: "_blank", rel: "noopener noreferrer nofollow", text: label }),
    );
    const sol = d.priceSol == null ? null : tokenPrice(d.priceSol);
    const name = () =>
      el("div", { class: "tp-t" }, el("strong", { text: d.symbol }), el("span", { class: "wl-nm", text: d.name }));

    // On a phone the name moves up beside Back and Buy drops under the line,
    // where the thumb is once the price has been read (wallet.css). One of
    // each pair is ever shown, so neither is read out twice.
    title?.replaceChildren(icon(d, 28), name());

    box.replaceChildren(
      ...[
        el(
          "div",
          { class: "tp-h" },
          icon(d, 32),
          name(),
          buy(d),
        ),
        links.length ? el("div", { class: "tp-lk" }, ...links) : null,
        price,
        move,
        ranges && chartBox,
        ranges,
        el("div", { class: "tp-bm" }, buy(d)),
        el(
          "div",
          { class: "tp-g" },
          cell("Price USD", tokenPrice(d.price).text, tokenPrice(d.price).title),
          cell("Price", sol ? `${sol.text.slice(1)} SOL` : "--", sol?.title?.slice(1)),
          cell("Liquidity", d.liquidity == null ? "--" : fiat(d.liquidity)),
          cell("FDV", d.fdv == null ? "--" : fiat(d.fdv)),
          cell("Mkt cap", d.mcap == null ? "--" : fiat(d.mcap)),
          cell("Holders", count(d.holders)),
        ),
        el("div", { class: "tp-tabs" }, ...tabs),
        body,
      ].filter(Boolean),
    );
    body.replaceChildren(...stats(d.windows?.["24h"]));
  }

  /**
   * Show one token. A newer choice wins over a slower answer. Resolves true
   * once it has painted; `quiet` leaves the panel as it was when it cannot.
   */
  return async function select(mint, quiet = false) {
    if (mint === current) return;
    current = mint;
    const id = ++run;
    box.setAttribute("aria-busy", "true");
    try {
      const res = await fetch(`/api/tokens/${encodeURIComponent(mint)}`, { headers: { Accept: "application/json" } });
      const data = await res.json();
      if (id !== run) return;
      if (!res.ok) throw new Error(data.error || "Could not load this token.");
      render(data);
      return true;
    } catch (err) {
      if (id !== run) return;
      current = "";
      if (!quiet) title?.replaceChildren();
      if (!quiet) box.replaceChildren(el("p", { class: "wl-n err", text: err.message || "Could not load this token." }));
    } finally {
      if (id === run) box.removeAttribute("aria-busy");
    }
  };
}
