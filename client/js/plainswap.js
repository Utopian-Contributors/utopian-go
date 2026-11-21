/**
 * Leaving one of a section's pages: no view transition. Each section's header
 * carries the name a home tile's flood is drawn into (base.css), so from one
 * section to another the browser would morph one header into the other, two
 * bars of different colours, contents and heights. A page that is not the home
 * page swaps at once instead, the way an app switches tabs; only a tile's tap
 * (js/tilezoom.js) draws its colour into the header.
 */
export function plainSwap() {
  window.addEventListener("pageswap", (e) => e.viewTransition?.skipTransition());
}
