/**
 * A 24-hour line, one byte an hour, that reads back the hour under the pointer.
 * Used for the portfolio and for the token in the side panel.
 */
import { el } from "../js/dom.js";

/** Base64 bytes to numbers, or null when there is nothing to draw. */
export function decode(series) {
  try {
    const raw = atob(series || "");
    return raw.length < 2 ? null : [...raw].map((c) => c.charCodeAt(0));
  } catch {
    return null;
  }
}

/** The value at point i, scaled back between the range the bytes were packed against. */
export function valueAt(bytes, i, lo, hi) {
  if (lo == null || hi == null || !bytes.length) return null;
  return lo + (bytes[i] / 255) * (hi - lo);
}

export function hoursAgo(bytes, i) {
  const back = bytes.length - 1 - i;
  return back === 0 ? "now" : `${back}h ago`;
}

/**
 * @param {HTMLElement} box
 * @param {string} gid the gradient's id, unique on the page
 * @param {(i: number) => void} onPoint the hovered point, and -1 when the pointer leaves
 */
export function lineChart(box, gid, onPoint) {
  const base = box.className;
  let bytes = [];
  let hovered = -1;
  // A DOM dot, not an SVG circle: the drawing is stretched, and a circle in it would be too.
  const dot = el("span", { class: "wl-dot", hidden: true });

  function mark(i) {
    dot.hidden = i < 0;
    if (i < 0) return;
    dot.style.left = `${(i / (bytes.length - 1)) * 100}%`;
    // The stylesheet insets the drawing 5px top and bottom.
    dot.style.top = `calc(5px + ${1 - bytes[i] / 255} * (100% - 10px))`;
  }

  function move(e) {
    if (!bytes.length) return;
    const rect = box.getBoundingClientRect();
    if (!rect.width) return;
    const frac = Math.min(1, Math.max(0, (e.clientX - rect.left) / rect.width));
    const i = Math.round(frac * (bytes.length - 1));
    if (i === hovered) return;
    hovered = i;
    mark(i);
    onPoint(i);
  }

  function end() {
    if (hovered < 0) return;
    hovered = -1;
    mark(-1);
    onPoint(-1);
  }

  box.addEventListener("pointermove", move);
  box.addEventListener("pointerleave", end);
  box.addEventListener("pointercancel", end);
  box.addEventListener("pointerup", end);

  return {
    /** @returns {number[]} */
    get bytes() {
      return bytes;
    },
    /** @returns {boolean} whether anything was drawn */
    draw(series, dir) {
      const next = decode(series);
      hovered = -1;
      box.hidden = !next;
      if (!next) {
        bytes = [];
        return false;
      }
      bytes = next;
      const line = bytes.map((b, i) => `${i},${255 - b}`).join("L");
      const last = bytes.length - 1;
      box.className = `${base}${dir ? ` ${dir}` : ""}`;
      // Every value here is a number computed in this function.
      box.innerHTML =
        `<svg viewBox="0 0 ${last} 255" preserveAspectRatio="none" aria-hidden="true">` +
        `<linearGradient id="${gid}" x2="0" y2="1"><stop/><stop offset="1"/></linearGradient>` +
        `<path d="M${line}L${last},255L0,255Z" fill="url(#${gid})"/>` +
        `<path d="M${line}"/></svg>`;
      mark(-1);
      box.append(dot);
      return true;
    },
  };
}
