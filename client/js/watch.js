/**
 * The home watchlist's Edit button and empty slots: each fetches the menu
 * that chooses the three assets (client/watch/main.js) on its first tap and
 * opens it. Edit closes it again; a slot only ever opens it.
 *
 * The news section's Edit does the same for the menu that chooses its
 * topics, which rides in the same bundle (client/watch/news.js).
 */
import { load } from "./lazy.js";

/** @param {HTMLElement | null} section #hm-wl */
export function mountWatch(section) {
  if (!section) return;
  section.addEventListener("click", (e) => {
    const t = e.target instanceof Element ? e.target : null;
    const slot = !!t?.closest(".hm-add");
    if (!slot && !t?.closest("#hm-ed")) return;
    load("wl", "__wl").then((wl) => wl.toggle(section, slot), () => {});
  });
}

/** @param {HTMLElement | null} section #hm-ns */
export function mountNewsEdit(section) {
  section?.addEventListener("click", (e) => {
    if (!(e.target instanceof Element && e.target.closest("#hm-ne"))) return;
    load("wl", "__wl").then((wl) => wl.news(section), () => {});
  });
}
