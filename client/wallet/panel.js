/**
 * The wallet page's drawer: one token's line and market data.
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

/** What a link's tile says under its name: where it goes, without the scheme or a trailing slash. */
function where(key, href) {
  const url = new URL(href);
  const host = url.hostname.replace(/^www\./, "");
  const path = url.pathname.replace(/\/+$/, "");
  if (key === "twitter" && /^\/\w+$/.test(path)) return `@${path.slice(1)}`;
  return host + path;
}

/**
 * A link as a tile like the home page's: X on X's mark, the others on their
 * site's icon (/api/tokens/<mint>/links/<key>, read from the site by the
 * server), each big off the corner and faded into the tile, which takes the
 * icon's colour once the server has read it.
 */
function linkTile(d, key, label) {
  const href = d.links[key];
  const mark = el("img", {
    src: key === "twitter" ? "/ic-x.svg" : `/api/tokens/${encodeURIComponent(d.mint)}/links/${key}`,
    alt: "",
    width: 160,
    height: 160,
    loading: "lazy",
    decoding: "async",
  });
  mark.addEventListener("error", () => mark.remove(), { once: true });
  const tile = el(
    "a",
    { class: `tp-lt tp-lt-${key}`, href, target: "_blank", rel: "noopener noreferrer nofollow" },
    mark,
    el("strong", { text: label }),
    el("span", { text: where(key, href) }),
  );
  const tint = d.linkTints?.[key];
  if (tint) paint(tile, tint);
  else if (key !== "twitter") {
    // The panel came before the server had read this icon's colours (a site
    // it had never fetched): by the time the icon has drawn, it has them.
    const url = `/api/tokens/${encodeURIComponent(d.mint)}/links/${key}/tint`;
    mark.addEventListener(
      "load",
      () => fetch(url).then((r) => (r.ok ? r.json() : null)).then((j) => j?.tint && paint(tile, j.tint), () => {}),
      { once: true },
    );
  }
  return tile;
}

/** As properties, not a style attribute: the tint is the server's text. */
function paint(tile, tint) {
  for (const m of tint.matchAll(/(--hi|--lo):(#[0-9a-f]{6})/g)) tile.style.setProperty(m[1], m[2]);
}

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
 * @param {(t: any) => HTMLElement} buy the page's Buy and Sell buttons for a token
 * @param {() => void} close puts the card away (the page's right column, wallet.css)
 */
export function mountPanel(box, buy, close) {
  let run = 0;
  let current = "";
  /** The answer for `current`, in flight or painted, so asking again for it resolves the same. */
  let pending = Promise.resolve(undefined);

  /** The token's mark and names, and the × that puts the card away. */
  function head(t) {
    return el(
      "div",
      { class: "tp-h" },
      icon(t, 32),
      el("div", { class: "tp-t" }, el("strong", { text: t.symbol }), el("span", { class: "wl-nm", text: t.name })),
      el("button", { class: "tp-x", type: "button", title: "Close", "aria-label": "Close", onclick: close }),
    );
  }

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
      linkTile(d, key, label),
    );
    const sol = d.priceSol == null ? null : tokenPrice(d.priceSol);

    // Buy and Sell under the line, two equal halves (wallet.css), where the thumb is once the price
    // has been read (wallet.css). One of the two is ever shown, so it is not
    // read out twice.

    // The drawer's contents, which on a desktop scroll in the right column (wallet.css).
    const card = el("div", { class: "tp-card" });
    box.replaceChildren(card);
    card.replaceChildren(
      ...[
        head(d),
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
        links.length ? el("div", { class: "tp-ls", role: "group", "aria-label": "Links" }, ...links) : null,
      ].filter(Boolean),
    );
    body.replaceChildren(...stats(d.windows?.["24h"]));
  }

  /**
   * What the row that was picked knows, drawn at the press while the rest is
   * read: the token's name, price and Buy, and the line's room, empty. On a
   * phone the panel takes the lists' place, so without it a slow answer left
   * the screen blank, or showing the last token, until it came.
   */
  function sketch(t) {
    box.replaceChildren(
      el(
        "div",
        { class: "tp-card" },
        head(t),
        el("strong", { class: "wl-v", text: tokenPrice(t.price).text }),
        el("div", { class: "pc tp-c" }),
        el("div", { class: "tp-bm" }, buy(t)),
      ),
    );
  }

  /**
   * Show one token. A newer choice wins over a slower answer. Resolves to
   * what it painted (its `path` and `title` are the token's wallet address
   * and that page's title, src/routes/api.ts); `quiet` leaves the panel as it
   * was when it cannot. `seed`, the token as a list showed it, is drawn
   * straight away.
   */
  return function select(mint, quiet = false, seed = null) {
    if (mint === current) return pending;
    current = mint;
    if (seed && !quiet) sketch(seed);
    pending = load(mint, quiet);
    return pending;
  };

  async function load(mint, quiet) {
    const id = ++run;
    box.setAttribute("aria-busy", "true");
    try {
      const res = await fetch(`/api/tokens/${encodeURIComponent(mint)}`, { headers: { Accept: "application/json" } });
      const data = await res.json();
      if (id !== run) return;
      if (!res.ok) throw new Error(data.error || "Could not load this token.");
      render(data);
      return data;
    } catch (err) {
      if (id !== run) return;
      current = "";
      if (!quiet) box.replaceChildren(el("p", { class: "wl-n err", text: err.message || "Could not load this token." }));
    } finally {
      if (id === run) box.removeAttribute("aria-busy");
    }
  }
}
