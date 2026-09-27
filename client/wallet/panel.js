/**
 * The right half of the wallet page: one token's line and market data.
 * Everything comes from /api/tokens/<mint>, which only answers for indexed mints.
 */
import { el } from "../js/dom.js";
import { fiat, percent, tokenPrice } from "../js/num.js";
import { hoursAgo, lineChart, valueAt } from "./chart.js";

const WINDOWS = ["5m", "1h", "6h", "24h"];
const LINKS = [
  ["website", "Website"],
  ["twitter", "X"],
  ["telegram", "Telegram"],
  ["discord", "Discord"],
];

/** A plain gray coin, for a token with no logo or one that fails to load. */
function coin() {
  return el("span", { class: "wl-ic wl-coin", text: "$", "aria-hidden": "true" });
}

/** The synced thumbnail, or a coin the same size so the tickers stay in line. */
export function icon(t, size = 20) {
  if (!t.icon) return coin();
  const img = el("img", {
    class: "wl-ic",
    src: `/icon/${t.mint}`,
    alt: "",
    width: String(size),
    height: String(size),
    loading: "lazy",
    decoding: "async",
  });
  img.addEventListener("error", () => img.replaceWith(coin()), { once: true });
  return img;
}

function dirOf(v) {
  return v > 0 ? "up" : v < 0 ? "dn" : "";
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
 */
export function mountPanel(box, buy) {
  let run = 0;
  let current = "";

  function render(d) {
    const price = el("strong", { class: "tp-v" });
    const move = el("span", { class: "wl-d" });
    const chartBox = el("div", { class: "wl-c tp-c" });
    const body = el("div", { class: "tp-st" });
    const day = d.windows?.["24h"]?.change;

    function paintPrice(value, change, label) {
      const p = tokenPrice(value);
      price.textContent = p.text;
      price.title = p.title || "";
      move.hidden = change == null;
      move.className = `wl-d ${dirOf(change)}`;
      move.textContent = `${percent(change, true)} ${label}`;
    }

    const line = lineChart(chartBox, "tpg", (i) => {
      const at = i < 0 ? null : valueAt(line.bytes, i, d.tickLo, d.tickHi);
      if (at == null) return paintPrice(d.price, day, "24h");
      const from = valueAt(line.bytes, 0, d.tickLo, d.tickHi);
      paintPrice(at, from ? (at / from - 1) * 100 : 0, `· ${hoursAgo(line.bytes, i)}`);
    });

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

    box.replaceChildren(
      ...[
        el(
          "div",
          { class: "tp-h" },
          icon(d, 32),
          el("div", { class: "tp-t" }, el("strong", { text: d.symbol }), el("span", { class: "wl-nm", text: d.name })),
          buy(d),
        ),
        links.length ? el("div", { class: "tp-lk" }, ...links) : null,
        el("div", { class: "wl-vr" }, price, move),
        chartBox,
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
    paintPrice(d.price, day, "24h");
    line.draw(d.ticks, dirOf(day));
    body.replaceChildren(...stats(d.windows?.["24h"]));
  }

  /** Show one token. A newer choice wins over a slower answer. */
  return async function select(mint) {
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
    } catch (err) {
      if (id !== run) return;
      current = "";
      box.replaceChildren(el("p", { class: "wl-n err", text: err.message || "Could not load this token." }));
    } finally {
      if (id === run) box.removeAttribute("aria-busy");
    }
  };
}
