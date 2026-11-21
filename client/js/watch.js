/**
 * The home watchlist's Edit button and empty slots: each fetches the menu
 * that chooses the three assets (client/watch/main.js) on its first tap and
 * opens it. Edit closes it again; a slot only ever opens it.
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
