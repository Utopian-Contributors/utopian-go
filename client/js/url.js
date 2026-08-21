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
