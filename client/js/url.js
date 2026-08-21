/** URL ↔ tab/query/language state (shareable SERP links). */
import { DEFAULT_LANG, currentLang } from "./lang.js";

/** @type {ReadonlyArray<[string, string]>} */
export const TABS = [
  ["web", "Web"],
  ["images", "Images"],
  ["news", "News"],
  ["videos", "Videos"],
  ["discussions", "Discussions"],
];

export const TAB_KEYS = new Set(TABS.map(([k]) => k));

/**
 * The language is returned raw rather than validated here: what counts as one
 * is the <option> list in the shell, which this module cannot see. setLang
 * measures it and falls back to English.
 *
 * @returns {{ q: string, t: string, lang: string }}
 */
export function readUrlState() {
  const params = new URLSearchParams(location.search);
  const q = (params.get("q") || "").trim();
  let t = params.get("t") || "web";
  if (!TAB_KEYS.has(t)) t = "web";
  return { q, t, lang: (params.get("lang") || "").trim() };
}

/**
 * @param {string} q
 * @param {string} [t]
 */
export function buildUrl(q, t = "web") {
  const params = new URLSearchParams();
  if (q) params.set("q", q);
  if (t && t !== "web") params.set("t", t);
  // Carried on the home URL too, not only on a SERP. This is the only place a
  // history entry records the language, and popstate reads it straight back —
  // a home entry that dropped it would be indistinguishable from one recorded
  // before the language was ever picked, and going back would land in English.
  const lang = currentLang();
  if (lang !== DEFAULT_LANG) params.set("lang", lang);
  const qs = params.toString();
  return qs ? `${location.pathname}?${qs}` : location.pathname;
}

/**
 * @param {string} q
 * @param {string} t
 * @param {"push" | "replace"} mode
 */
export function writeUrl(q, t, mode = "push") {
  const next = buildUrl(q, t);
  if (next === location.pathname + location.search) return;
  const fn = mode === "replace" ? history.replaceState : history.pushState;
  fn.call(history, { q, t }, "", next);
}

/**
 * The mint a deeplink asked to trade, read at module load and only then.
 *
 * A wallet's in-app browser opens us at `/?q=SYM&buy=<mint>`, and the first
 * thing the boot path does with a query is `writeUrl(…, "replace")` — which
 * rebuilds the URL out of `q` and `t` alone and drops every other parameter
 * with it. That happens a few hundred milliseconds in, so anything that waits
 * for a search to resolve before looking is reading a URL the app has already
 * rewritten. Module evaluation is the one point that is unconditionally
 * earlier: this file is imported before main.js runs a line.
 *
 * Deliberately only the mint, never an amount. This URL is handed to the
 * wallet's own domain on the way through and lands in its logs and ours; a
 * size in it would be a record of what someone was about to trade, tied to
 * their IP, written before they had agreed to anything. Which token a person
 * looked at is a fact about a token. How much they were about to spend is a
 * fact about them.
 */
let pendingBuy = (new URLSearchParams(location.search).get("buy") || "").trim();

/**
 * Claim the pending mint, if it is this one.
 *
 * Consuming rather than reading, because `paint()` runs again on every tab
 * switch and every continuation page. A mint that reopened the trade dialog on
 * each repaint would be a dialog nobody could close.
 *
 * No validation of the mint beyond this comparison: the only thing it is ever
 * matched against is the mint of a card the server has already returned, so a
 * junk value simply never matches and a crafted one can only name a token that
 * was on the page anyway.
 *
 * @param {string} mint
 * @returns {boolean} whether the deeplink named this mint
 */
export function takePendingBuy(mint) {
  if (!pendingBuy || pendingBuy !== mint) return false;
  pendingBuy = "";
  return true;
}
