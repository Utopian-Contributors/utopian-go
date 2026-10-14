/**
 * A 24-hour line, one byte an hour, that reads back the hour under the pointer.
 * Used for the token in the side panel and for the portfolio, which draws a
 * line per kind beside its total once it holds three kinds or more.
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

/** A line through depths from the top (0 to 1), one unit wide per point and 1000 high. */
function path(depths) {
  return depths.map((y, i) => `${i},${Math.round(y * 1000)}`).join("L");
}

/**
 * Smallest change, in points of percent, that the full height of a chart of
 * several lines may represent: a calm day drawn calm, not magnified into
 * noise. The server floors a single line the same way (MIN_SPAN in
 * src/lib/tokens/ticks.ts).
 */
const MIN_SPAN = 2;

/**
 * One line, or several on one axis. Reads back the point under the pointer
 * either way.
 * @param {HTMLElement} box
 * @param {string} gid the gradient's id, unique on the page
 * @param {(i: number) => void} onPoint the hovered point, and -1 when the pointer leaves
 */
export function lineChart(box, gid, onPoint) {
  const base = box.className;
  let bytes = [];
  /** Every line drawn, as each point's depth from the top. */
  let lines = /** @type {{ key: string, depths: number[] }[]} */ ([]);
  let count = 0;
  let hovered = -1;
  // DOM dots, not SVG circles: the drawing is stretched, and a circle in it would be too.
  let dots = /** @type {HTMLElement[]} */ ([]);
  /** The hovered hour, across every line, when there is more than one. */
  const rule = el("span", { class: "wl-rule", hidden: true });

  function mark(i) {
    rule.hidden = i < 0 || lines.length < 2;
    const left = `${(i / (count - 1)) * 100}%`;
    rule.style.left = left;
    dots.forEach((dot, k) => {
      dot.hidden = i < 0;
      if (i < 0) return;
      dot.style.left = left;
      // The stylesheet insets the drawing 5px top and bottom.
      dot.style.top = `calc(5px + ${lines[k].depths[i]} * (100% - 10px))`;
    });
  }

  function move(e) {
    if (count < 2) return;
    const rect = box.getBoundingClientRect();
    if (!rect.width) return;
    const frac = Math.min(1, Math.max(0, (e.clientX - rect.left) / rect.width));
    const i = Math.round(frac * (count - 1));
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

  /** Fill the box: the drawing, the rule, a dot per line. */
  function show(svg, cls) {
    hovered = -1;
    box.className = `${base}${cls ? ` ${cls}` : ""}`;
    // Every value in the drawing is a number or a class name computed here.
    box.innerHTML = svg;
    dots = lines.map((line) => el("span", { class: `wl-dot${line.key ? ` k-${line.key}` : ""}`, hidden: true }));
    box.append(rule, ...dots);
    mark(-1);
  }

  function clear() {
    bytes = [];
    lines = [];
    count = 0;
    box.hidden = true;
    return false;
  }

  return {
    /** @returns {number[]} */
    get bytes() {
      return bytes;
    },
    /** @returns {boolean} whether anything was drawn */
    draw(series, dir) {
      const next = decode(series);
      if (!next) return clear();
      bytes = next;
      count = bytes.length;
      lines = [{ key: "", depths: bytes.map((b) => 1 - b / 255) }];
      box.hidden = false;
      delete box.dataset.pick;
      const line = path(lines[0].depths);
      const last = count - 1;
      show(
        `<svg viewBox="0 0 ${last} 1000" preserveAspectRatio="none" aria-hidden="true">` +
          `<linearGradient id="${gid}" x2="0" y2="1"><stop/><stop offset="1"/></linearGradient>` +
          `<path d="M${line}L${last},1000L0,1000Z" fill="url(#${gid})"/>` +
          `<path d="M${line}"/></svg>`,
        dir,
      );
      return true;
    },
    /**
     * Several lines on one axis, each as its change since its first point.
     * Their sizes differ by orders of magnitude, and on one dollar axis
     * everything but the largest would be drawn flat; as a change, a small
     * part of a portfolio moves as visibly as the whole of it does.
     * @param {{ key: string, values: number[] }[]} list positive values, oldest first, all one length
     * @param {string} picked the key drawn over the others, which step back; none, when empty
     * @returns {boolean} whether anything was drawn
     */
    drawMany(list, picked) {
      count = list[0]?.values.length ?? 0;
      if (count < 2) return clear();
      bytes = [];
      const change = list.map(({ values }) => values.map((v) => (v / values[0] - 1) * 100));
      let lo = Math.min(0, ...change.flat());
      let hi = Math.max(0, ...change.flat());
      if (hi - lo < MIN_SPAN) {
        const pad = (MIN_SPAN - (hi - lo)) / 2;
        lo -= pad;
        hi += pad;
      }
      const depth = (pct) => (hi - pct) / (hi - lo);
      lines = list.map(({ key }, k) => ({ key: key.replace(/[^a-z]/g, ""), depths: change[k].map(depth) }));
      box.hidden = false;
      if (picked) box.dataset.pick = picked;
      else delete box.dataset.pick;
      // The picked line goes last, so it is drawn over the rest.
      const order = [...lines].sort((a, b) => Number(a.key === picked) - Number(b.key === picked));
      show(
        `<svg viewBox="0 0 ${count - 1} 1000" preserveAspectRatio="none" aria-hidden="true">` +
          `<path class="z" d="M0,${Math.round(depth(0) * 1000)}H${count - 1}"/>` +
          order.map((line) => `<path class="k-${line.key}${line.key === picked ? " on" : ""}" d="M${path(line.depths)}"/>`).join("") +
          `</svg>`,
        "many",
      );
      return true;
    },
  };
}
