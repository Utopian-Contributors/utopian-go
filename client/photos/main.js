/**
 * A post's photos, large, in a carousel: a modal <dialog> over the page with
 * one photo to a screen. The row is a scroller that snaps, so swiping on a
 * phone is the browser's own swipe, momentum and all; a mouse gets arrows and
 * the keyboard ← and →. The x, Escape, or a tap off the photo closes it.
 *
 * Its own bundle, fetched by social.js the first time a photo is tapped.
 */
import { el } from "../js/dom.js";
import { injectStyles } from "../js/ui.js";
import CSS from "./photos.css";

const svg = (d) =>
  `<svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" ` +
  `stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="${d}"/></svg>`;

/**
 * @param {string[]} srcs each photo's address, in the post's order
 * @param {number} at the one tapped
 */
function open(srcs, at) {
  injectStyles("pv-css", CSS);
  const many = srcs.length > 1;
  const row = el("div", { class: "pv-row" });
  srcs.forEach((src, i) =>
    row.append(
      el(
        "div",
        { class: "pv-slide" },
        el("img", {
          src,
          alt: many ? `Photo ${i + 1} of ${srcs.length}` : "Photo",
          // The one tapped first; the rest as they come into view.
          loading: i === at ? "eager" : "lazy",
          decoding: "async",
          draggable: "false",
        }),
      ),
    ),
  );
  const x = el("button", { type: "button", class: "pv-x", "aria-label": "Close" });
  x.innerHTML = svg("M6 6l12 12M18 6 6 18");
  const prev = el("button", { type: "button", class: "pv-go pv-prev", "aria-label": "Previous photo", hidden: !many });
  prev.innerHTML = svg("M15 5l-7 7 7 7");
  const next = el("button", { type: "button", class: "pv-go pv-next", "aria-label": "Next photo", hidden: !many });
  next.innerHTML = svg("M9 5l7 7-7 7");
  const count = el("div", { class: "pv-n", "aria-live": "polite", hidden: !many });
  const box = el("dialog", { class: "pv", "aria-label": "Photos", tabindex: "-1" }, row, prev, next, count, x);

  let index = at;
  const paint = () => {
    count.textContent = `${index + 1} / ${srcs.length}`;
    prev.disabled = index === 0;
    next.disabled = index === srcs.length - 1;
  };
  const go = (i, smooth = true) => {
    index = Math.max(0, Math.min(srcs.length - 1, i));
    row.scrollTo({ left: index * row.clientWidth, behavior: smooth ? "smooth" : "instant" });
    paint();
  };
  // Where a swipe settled, read off the row.
  row.addEventListener(
    "scroll",
    () => {
      const i = Math.round(row.scrollLeft / Math.max(1, row.clientWidth));
      if (i !== index) {
        index = i;
        paint();
      }
    },
    { passive: true },
  );
  prev.addEventListener("click", () => go(index - 1));
  next.addEventListener("click", () => go(index + 1));
  x.addEventListener("click", () => box.close());
  // Off the photo, on the dark around it, closes; on the photo does nothing.
  row.addEventListener("click", (e) => {
    if (!(e.target instanceof HTMLImageElement)) box.close();
  });
  // On the document, not the dialog: an arrow button that disables itself at
  // the end drops the focus, and the keys must work all the same.
  const keys = (e) => {
    if (e.key === "ArrowLeft") go(index - 1);
    else if (e.key === "ArrowRight") go(index + 1);
  };
  document.addEventListener("keydown", keys);
  box.addEventListener("close", () => document.removeEventListener("keydown", keys));
  // The page under it holds still while it is open, and comes back as it was.
  const root = document.documentElement;
  const was = root.style.overflow;
  root.style.overflow = "hidden";
  box.addEventListener("close", () => {
    root.style.overflow = was;
    box.remove();
  });
  // A rotated phone or a resized window keeps the same photo in view.
  const keep = () => go(index, false);
  addEventListener("resize", keep);
  box.addEventListener("close", () => removeEventListener("resize", keep));

  document.body.append(box);
  box.showModal();
  go(at, false);
  // The dialog, not its x: a ring around the x before anyone has tabbed to it
  // reads as a border. Escape, the arrows and Tab all work from here.
  box.focus({ preventScroll: true });
}

window.__photos = { open };
