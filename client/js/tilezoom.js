/**
 * The home page's tiles open the way an iPhone app opens from its icon: the
 * tile grows to fill the screen, its word and mark fading as it goes and its
 * gradient settling into the look of the header of the page it opens
 * (base.css --fill-*). The copy that grows carries the header's
 * view-transition name, so where the browser does cross-document view
 * transitions it draws the colour straight up into that header, over the new
 * page (base.css). The page loads the moment the colour reaches the edges.
 *
 * A copy grows rather than the tile itself, so the grid under it never moves,
 * and the copy is dropped if the page comes back from the back-forward cache.
 * A modified click, or a visitor who asked for less motion, just follows the
 * link.
 *
 * @param {HTMLElement | null} node #hm-nv
 */
export function mountTileZoom(node) {
  if (!node) return;
  node.addEventListener("click", (e) => {
    const tile = /** @type {HTMLElement | null} */ (e.target instanceof Element ? e.target.closest("a.hm-t") : null);
    if (!tile || e.defaultPrevented || e.button !== 0 || e.metaKey || e.ctrlKey || e.shiftKey || e.altKey) return;
    if (typeof tile.animate !== "function" || matchMedia("(prefers-reduced-motion: reduce)").matches) return;
    e.preventDefault();
    const href = /** @type {HTMLAnchorElement} */ (tile).href;
    const r = tile.getBoundingClientRect();
    const copy = /** @type {HTMLElement} */ (tile.cloneNode(true));
    copy.classList.add("hm-zoom");
    copy.removeAttribute("href");
    copy.setAttribute("aria-hidden", "true");
    copy.style.viewTransitionName = "hd";
    tile.after(copy);
    const timing = { duration: 240, easing: "cubic-bezier(0.32, 0.72, 0, 1)", fill: /** @type {const} */ ("forwards") };
    for (const part of copy.children) part.animate([{ opacity: 1 }, { opacity: 0 }], { ...timing, duration: 150 });
    // The header's own look, over the tile's gradient by the end.
    const fill = document.createElement("i");
    fill.className = "hm-fill";
    copy.append(fill);
    fill.animate([{ opacity: 0 }, { opacity: 1 }], timing);
    const go = () => location.assign(href);
    copy
      .animate(
        [
          { top: `${r.top}px`, left: `${r.left}px`, width: `${r.width}px`, height: `${r.height}px`, borderRadius: "18px" },
          { top: "0px", left: "0px", width: `${innerWidth}px`, height: `${innerHeight}px`, borderRadius: "0px" },
        ],
        timing,
      )
      .finished.then(go, go);
  });
  window.addEventListener("pageshow", (e) => {
    if (e.persisted) for (const copy of node.querySelectorAll(".hm-zoom")) copy.remove();
  });
}
