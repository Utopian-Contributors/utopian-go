/** URL ↔ tab/query state (shareable SERP links). */

/** @type {ReadonlyArray<[string, string]>} */
export const TABS = [
  ["web", "Web"],
  ["images", "Images"],
  ["news", "News"],
  ["videos", "Videos"],
  ["discussions", "Discussions"],
];

export const TAB_KEYS = new Set(TABS.map(([k]) => k));

/** @returns {{ q: string, t: string }} */
export function readUrlState() {
  const params = new URLSearchParams(location.search);
  const q = (params.get("q") || "").trim();
  let t = params.get("t") || "web";
  if (!TAB_KEYS.has(t)) t = "web";
  return { q, t };
}

/**
 * @param {string} q
 * @param {string} [t]
 */
export function buildUrl(q, t = "web") {
  const params = new URLSearchParams();
  if (q) params.set("q", q);
  if (t && t !== "web") params.set("t", t);
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
