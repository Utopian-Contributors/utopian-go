/**
 * A search on this site, drawn under a post that links to one: the query, the
 * tabs that found something (Web, Images, News, Videos, Discussions) and the
 * first few results of the one picked, with a way through to the whole page.
 *
 * Its own bundle, fetched by social.js the first time a post or a draft links
 * to a search, so a timeline without one pays nothing for it. Every search is
 * a metered Brave call, so a post's box asks only once it comes near the
 * screen, Images only when that tab is opened, and each query once a page
 * however many posts link to it.
 */
import { daySeries, dirOf } from "../js/chart.js";
import { coinIcon } from "../js/coin.js";
import { el } from "../js/dom.js";
import { percent, tokenPrice } from "../js/num.js";
import { cite, resultCard, snippet, titleLink, videoThumb } from "../js/pieces.js";
import { plainText, safeUrl } from "../js/text.js";
import { injectStyles } from "../js/ui.js";
import CSS from "./serp.css";

/** The search page's tabs (client/js/url.js TABS), here so this bundle carries no language control. */
const TABS = [
  ["web", "Web"],
  ["images", "Images"],
  ["news", "News"],
  ["videos", "Videos"],
  ["discussions", "Discussions"],
];
/** Results shown under a post; the rest are a tap away on the search page. */
const SHOWN = 3;
const SHOWN_IMAGES = 6;
/** Price rows above a post's web results; the search page shows the rest. */
const SHOWN_TOKENS = 2;
const SVG = "http://www.w3.org/2000/svg";

/** Answers by query and language, in flight or settled, for every box on the page. */
const asked = new Map();

/** @param {string} path @param {{q: string, lang: string}} found */
function ask(path, found) {
  const key = `${path}|${found.lang}|${found.q}`;
  let task = asked.get(key);
  if (!task) {
    const lang = found.lang ? `&lang=${encodeURIComponent(found.lang)}` : "";
    task = fetch(`${path}?q=${encodeURIComponent(found.q)}${lang}`, { headers: { Accept: "application/json" } })
      .then((res) => res.json())
      .then((json) => {
        if (json.error) throw new Error(json.error);
        return json;
      });
    // A failure is worth one more try later, not the box for the whole visit.
    task.catch(() => asked.delete(key));
    asked.set(key, task);
  }
  return task;
}

/** The search page for this query, on this tab. */
function pageFor(found, tab) {
  const params = new URLSearchParams({ q: found.q });
  if (tab !== "web") params.set("t", tab);
  if (found.lang) params.set("lang", found.lang);
  return `/?${params}`;
}

/** Grey bars where the results will be, while they come. */
function skeleton() {
  return el("div", { class: "se-sk", "aria-hidden": "true" }, el("i"), el("i"), el("i"));
}

/**
 * A token's day as a line, from the hourly ticks its quote carries. Drawn
 * here, not with chart.js's lineChart: that one is styled by chart.css, which
 * the social page does not load, and a post has no room to scrub a line.
 */
function sparkline(t, dir) {
  const day = daySeries(t);
  if (!day) return null;
  const lo = Math.min(...day.v);
  const span = Math.max(...day.v) - lo || 1;
  const step = 100 / (day.v.length - 1);
  const svg = document.createElementNS(SVG, "svg");
  svg.setAttribute("class", `se-spark ${dir}`);
  svg.setAttribute("viewBox", "0 0 100 30");
  svg.setAttribute("preserveAspectRatio", "none");
  svg.setAttribute("aria-hidden", "true");
  const line = document.createElementNS(SVG, "polyline");
  line.setAttribute("points", day.v.map((v, i) => `${(i * step).toFixed(2)},${(28 - ((v - lo) / span) * 26).toFixed(2)}`).join(" "));
  line.setAttribute("vector-effect", "non-scaling-stroke");
  svg.append(line);
  return svg;
}

/**
 * A ticker or a stock the query named, as the search page's price card says
 * it: the logo, the symbol over the name, the day's line, the price and its
 * move. It opens the token's chart, as a $ticker in a post does.
 */
function tokenRow(t) {
  const price = tokenPrice(t.price);
  const dir = dirOf(t.change24h);
  return el(
    "a",
    { class: "se-tk", href: `/wallet?t=${encodeURIComponent(t.mint)}`, title: `${t.name} (${t.symbol})` },
    // A search's quotes do not say whether a logo was synced; /icon/<mint> answers 404 when not, and the coin takes its place.
    coinIcon({ mint: t.mint, icon: true }, 32, "se-ic", "se-coin"),
    el("span", { class: "se-id" }, el("b", { text: t.symbol }), el("small", { text: t.name })),
    sparkline(t, dir),
    el(
      "span",
      { class: "se-px" },
      el("b", { text: price.text, "aria-label": price.label || price.text }),
      el("small", { class: dir, text: t.change24h == null ? "" : `${percent(t.change24h, true)} 24h` }),
    ),
  );
}

function list(items, video) {
  return items.slice(0, SHOWN).map((item, i) =>
    video
      ? resultCard(i, el("div", { class: "vr" }, videoThumb(item.thumbnail?.src), el("div", null, cite(item), titleLink(item))))
      : resultCard(i, cite(item), titleLink(item), snippet(item)),
  );
}

function images(items) {
  const shown = items.filter((item) => safeUrl(item.thumbnail)).slice(0, SHOWN_IMAGES);
  if (!shown.length) return [el("p", { class: "se-none", text: "No images found." })];
  return [
    el(
      "div",
      { class: "se-ig" },
      ...shown.map((item) => {
        const img = el("img", { src: safeUrl(item.thumbnail), alt: plainText(item.title || ""), loading: "lazy" });
        img.addEventListener("error", () => img.parentElement?.remove(), { once: true });
        return el("a", { href: safeUrl(item.url) || "#", target: "_blank", rel: "noopener", title: plainText(item.title || "") }, img);
      }),
    ),
  ];
}

/** Calls `go` once, when `box` first comes within a screen of view. */
function whenNear(box, go) {
  if (!("IntersectionObserver" in window)) return go();
  const watch = new IntersectionObserver(
    (entries) => {
      if (!entries.some((e) => e.isIntersecting)) return;
      watch.disconnect();
      go();
    },
    { rootMargin: "400px 0px" },
  );
  watch.observe(box);
}

/**
 * Fills social.js's empty `box` with the search `found` names
 * ({q, t, lang}). A search that finds nothing, or fails, takes the box away
 * and leaves the link.
 */
function fill(box, found) {
  injectStyles("se-css", CSS);
  const tabs = el("div", { class: "se-tb", role: "tablist", "aria-label": "Result type" });
  const shown = el("div", { class: "se-rs" }, skeleton());
  const all = el("a", { class: "se-all", href: pageFor(found, "web"), text: "See all results" });
  box.replaceChildren(
    el(
      "a",
      { class: "se-q", href: pageFor(found, "web"), title: `Search for ${found.q}` },
      el("span", { class: "se-go", text: "Search" }),
      el("b", { text: found.q }),
    ),
    tabs,
    shown,
    all,
  );

  whenNear(box, () =>
    ask("/api/search", found).then((data) => {
      const tokens = (data.tokens || []).slice(0, SHOWN_TOKENS);
      const count = {
        // The price cards lead the search page's Web tab; a query that is only a ticker still has one.
        web: (data.results?.length || 0) + tokens.length,
        news: data.news?.length || 0,
        videos: data.videos?.length || 0,
        discussions: data.discussions?.length || 0,
      };
      const any = count.web + count.news + count.videos + count.discussions > 0;
      if (!any) return box.remove();
      // Images come from their own call, so the tab shows whenever the search found anything.
      const open = TABS.filter(([key]) => key === "images" || count[key] > 0);
      let on = open.some(([key]) => key === found.t) ? found.t : open[0][0];
      // A later tap wins over an Images answer still on its way.
      let turn = 0;

      function paint() {
        const mine = ++turn;
        all.href = pageFor(found, on);
        for (const button of tabs.children) {
          const is = button.dataset.k === on;
          button.classList.toggle("on", is);
          button.setAttribute("aria-selected", String(is));
        }
        if (on === "web") return shown.replaceChildren(...tokens.map(tokenRow), ...list(data.results || [], false));
        if (on === "videos") return shown.replaceChildren(...list(data.videos, true));
        if (on !== "images") return shown.replaceChildren(...list(data[on], false));
        shown.replaceChildren(skeleton());
        ask("/api/images", found).then(
          (got) => mine === turn && shown.replaceChildren(...images(got.images || [])),
          () => mine === turn && shown.replaceChildren(el("p", { class: "se-none", text: "Images could not be loaded." })),
        );
      }

      tabs.replaceChildren(
        ...open.map(([key, label]) =>
          el("button", {
            type: "button",
            class: "tab",
            role: "tab",
            "data-k": key,
            text: label,
            onclick: () => {
              if (on === key) return;
              on = key;
              paint();
            },
          }),
        ),
      );
      paint();
    }, () => box.remove()),
  );
}

window.__serp = { fill };
