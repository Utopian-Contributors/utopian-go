/**
 * Places someone left search for, kept in localStorage and nowhere else.
 *
 * One entry per host, newest first, each holding its pages newest first.
 */

const KEY = "tr";
const HOSTS = 120;
const PAGES = 60;

/** @typedef {{ u: string, t: string, a: number }} Page */
/** @typedef {{ h: string, i?: string, a: number, p: Page[] }} Place */

/** @returns {Place[]} */
export function readTrail() {
  try {
    const list = JSON.parse(localStorage.getItem(KEY) || "[]");
    return Array.isArray(list) ? list : [];
  } catch {
    return [];
  }
}

/** @param {Place[]} list */
export function writeTrail(list) {
  try {
    if (list.length) localStorage.setItem(KEY, JSON.stringify(list));
    else localStorage.removeItem(KEY);
  } catch {}
}

/**
 * @param {URL} url
 * @param {string} title
 * @param {string} [icon]
 */
export function record(url, title, icon) {
  const h = url.hostname.replace(/^www\./, "");
  const u = url.href;
  const a = Date.now();
  const list = readTrail();
  const at = list.findIndex((p) => p.h === h);
  const place = at >= 0 ? list.splice(at, 1)[0] : { h, a, p: [] };
  place.a = a;
  if (icon) place.i = icon;
  const old = place.p.findIndex((p) => p.u === u);
  const page = old >= 0 ? place.p.splice(old, 1)[0] : { u, t: "", a };
  page.a = a;
  if (title) page.t = title.slice(0, 120);
  place.p.unshift(page);
  place.p.length = Math.min(place.p.length, PAGES);
  list.unshift(place);
  list.length = Math.min(list.length, HOSTS);
  writeTrail(list);
}
