/**
 * A price line to scrub, as on a phone's stocks app: the line alone, and the
 * ranges under it. Under the pointer, a rule and a ring on the line follow
 * it, and the figure above reads that moment.
 *
 * Shared by the search card and the wallet page; its stylesheet is
 * chart.css, which build-client.mjs appends to both pages' sheets. Only
 * geometry is written here; colour, weight and inset are all stylesheet.
 */
import { el } from "./dom.js";
import { dollars, percent, tokenPrice } from "./num.js";

/** @typedef {import('../../src/types').PriceSeries} Series */

/** Every chart's ranges: the key the server knows, the button, and what a change across it says it is over. */
export const RANGES = [
  ["1h", "1H", "past hour"],
  ["24h", "24H", "past 24h"],
  ["1w", "1W", "past week"],
  ["1m", "1M", "past month"],
];

const HOUR = 3_600_000;
const DAY = 24 * HOUR;

/** @param {string} range */
export function since(range) {
  return RANGES.find(([key]) => key === range)?.[2] ?? "";
}

/** @param {number | null | undefined} v */
export function dirOf(v) {
  return v > 0 ? "up" : v < 0 ? "dn" : "";
}

/**
 * A token's day from the ticks its quote carries.
 * @param {{ ticks?: string, tickLo?: number, tickHi?: number, tickAt?: number }} t
 * @returns {Series | null}
 */
export function daySeries(t) {
  let raw = "";
  try {
    raw = atob(t.ticks || "");
  } catch {
    return null;
  }
  const { tickLo: lo, tickHi: hi } = t;
  if (raw.length < 2 || lo == null || hi == null) return null;
  const at = t.tickAt ?? Math.floor(Date.now() / HOUR) * HOUR;
  return { at, step: HOUR, v: [...raw].map((c) => lo + (c.charCodeAt(0) / 255) * (hi - lo)) };
}

/** Answers held for a minute, so flicking between ranges asks once. */
const fetched = new Map();

/**
 * A token's line across a range other than 24h. Null when there is no
 * history for it, or the server could not get one.
 * @param {string} mint
 * @param {string} range
 * @returns {Promise<Series | null>}
 */
export async function loadSeries(mint, range) {
  const key = `${range}:${mint}`;
  const hit = fetched.get(key);
  if (!hit || Date.now() - hit.at > 60_000) {
    const task = fetch(`/api/tokens/${encodeURIComponent(mint)}/chart?r=${range}`, { headers: { Accept: "application/json" } })
      .then((res) => (res.ok ? res.json() : null))
      .catch(() => null);
    fetched.set(key, { at: Date.now(), task });
    // A failure is asked again next time rather than remembered.
    task.then((s) => s || fetched.delete(key));
  }
  return fetched.get(key).task;
}

/**
 * When point `i` was: the moment its bucket closed, to the minute within a
 * day, with the weekday within a week, and with the date past that. The last
 * bucket is "now" while it is still open; a day's ticks are refreshed hourly,
 * and an hour later their last is an hour ago.
 * @param {{ at: number, step: number }} s
 * @param {number} n points in the line
 * @param {number} i
 */
export function when(s, n, i) {
  const close = s.at - (n - 2 - i) * s.step;
  if (close > Date.now()) return "now";
  const span = (n - 1) * s.step;
  return new Date(close).toLocaleString(
    undefined,
    span <= DAY
      ? { hour: "numeric", minute: "2-digit" }
      : span <= 7 * DAY
        ? { weekday: "short", hour: "numeric", minute: "2-digit" }
        : { month: "short", day: "numeric", hour: "numeric" },
  );
}

/**
 * A figure with its decimals a step back: "$58,834" then ".75". Only when
 * there is a whole part to lead — in "$0.00123" the decimals are the price.
 * @param {HTMLElement} node
 * @param {{ text: string, title?: string, label?: string }} shown
 */
export function figure(node, shown) {
  const parts = /^(.*[1-9][\d,]*)(\.\d+)$/.exec(shown.text);
  node.replaceChildren(...(parts ? [parts[1], el("span", { class: "pc-fr", text: parts[2] })] : [shown.text]));
  node.title = shown.title || "";
  if (shown.label) node.setAttribute("aria-label", shown.label);
  else node.removeAttribute("aria-label");
}

/**
 * "+$1,204.60 · 2.10%", in the colour of its direction, then what it is over.
 * Hidden when there is no change to state.
 * @param {HTMLElement} node
 * @param {number | null | undefined} pct
 * @param {number} diff in the figure's own units
 * @param {(v: number) => string} money
 * @param {string} over
 */
export function paintMove(node, pct, diff, money, over) {
  node.hidden = pct == null || !Number.isFinite(pct);
  if (node.hidden) return;
  node.className = `pc-m ${dirOf(pct)}`;
  node.replaceChildren(
    `${diff < 0 ? "-" : "+"}${money(Math.abs(diff))} · ${percent(Math.abs(pct))}`,
    el("span", { text: over }),
  );
}

/**
 * The smallest move, as a fraction of price, that a line's full height may
 * show, so a calm stretch is drawn calm rather than magnified into noise.
 * Two percent across a day, as the server floors a day's ticks (MIN_SPAN in
 * src/lib/tokens/ticks.ts), and scaled from there by the square root of the
 * span, which is how far prices wander with time: a few tenths of a percent
 * across an hour, about eleven across a month.
 * @param {number} span ms
 */
function calm(span) {
  return 0.02 * Math.sqrt(Math.max(span, HOUR) / DAY);
}

/**
 * A smooth path through depths from the top (0 to 1), one unit apart and 1000
 * high. Monotone: each piece bends between its two points and never past
 * them, so a smoothed line still peaks where the price did, not above it.
 * @param {number[]} depths
 */
function curve(depths) {
  const y = depths.map((d) => d * 1000);
  const n = y.length;
  const run = y.slice(1).map((v, i) => v - y[i]);
  const slope = y.map((_, i) => {
    if (i === 0) return run[0];
    if (i === n - 1) return run[n - 2];
    const [a, b] = [run[i - 1], run[i]];
    return a * b <= 0 ? 0 : (2 * a * b) / (a + b);
  });
  const xy = (x, v) => `${+x.toFixed(2)},${Math.round(v)}`;
  let d = `M${xy(0, y[0])}`;
  for (let i = 0; i < n - 1; i += 1) {
    d += `C${xy(i + 1 / 3, y[i] + slope[i] / 3)} ${xy(i + 2 / 3, y[i + 1] - slope[i + 1] / 3)} ${xy(i + 1, y[i + 1])}`;
  }
  return d;
}

/**
 * One line, or several on one axis.
 * @param {HTMLElement} box
 * @param {((i: number) => void) | null} onPoint the point under the pointer,
 *   and -1 once it leaves; null for a line that is only looked at
 */
export function lineChart(box, onPoint) {
  const base = box.className;
  /** Every line drawn, the one in front last, as each point's depth from the top. */
  let lines = /** @type {{ key: string, depths: number[] }[]} */ ([]);
  let count = 0;
  let hovered = -1;
  // DOM rings, not SVG circles: the drawing is stretched, and a circle in it would be too.
  let dots = /** @type {HTMLElement[]} */ ([]);
  const rule = el("span", { class: "pc-rule", hidden: true });

  /** The rule and the rings onto point i, or away for -1. */
  function mark(i) {
    rule.hidden = i < 0;
    const left = `calc(var(--pc-side) + ${i / (count - 1)} * (100% - 2 * var(--pc-side)))`;
    rule.style.left = left;
    dots.forEach((dot, k) => {
      dot.hidden = i < 0;
      if (i < 0) return;
      dot.style.left = left;
      dot.style.top = `calc(var(--pc-pad) + ${lines[k].depths[i]} * (100% - 2 * var(--pc-pad)))`;
    });
  }

  function move(e) {
    if (count < 2) return;
    const rect = box.getBoundingClientRect();
    // The drawing is inset from the box's sides (chart.css); the pointer is read against it.
    const side = parseFloat(getComputedStyle(box).getPropertyValue("--pc-side")) || 0;
    const width = rect.width - 2 * side;
    if (width <= 0) return;
    const frac = Math.min(1, Math.max(0, (e.clientX - rect.left - side) / width));
    const i = Math.round(frac * (count - 1));
    if (i === hovered) return;
    hovered = i;
    mark(i);
    onPoint?.(i);
  }

  function end() {
    if (hovered < 0) return;
    hovered = -1;
    mark(-1);
    onPoint?.(-1);
  }

  if (onPoint) {
    box.addEventListener("pointermove", move);
    box.addEventListener("pointerdown", move);
    box.addEventListener("pointerleave", end);
    box.addEventListener("pointercancel", end);
    box.addEventListener("pointerup", (e) => e.pointerType !== "mouse" && end());
  }

  /** Fill the box: the drawing, the rule, a ring per line. */
  function show(next, cls, paths) {
    lines = next;
    count = next[0].depths.length;
    hovered = -1;
    box.className = `${base}${cls ? ` ${cls}` : ""}`;
    box.removeAttribute("aria-busy");
    box.hidden = false;
    // Every value in the drawing is a number or a class name computed here.
    box.innerHTML = `<svg viewBox="0 0 ${count - 1} 1000" preserveAspectRatio="none" aria-hidden="true">${paths}</svg>`;
    dots = lines.map((line) => el("span", { class: `pc-dot${line.key ? ` k-${line.key}` : ""}`, hidden: true }));
    box.append(rule, ...dots);
    mark(-1);
  }

  return {
    /** A line at a time; drawn when there is one, so the box keeps its place. */
    busy() {
      box.setAttribute("aria-busy", "true");
    },
    /**
     * Nothing to draw. With a note, the box keeps its height and says why;
     * without one, it goes.
     * @param {string} [note]
     */
    clear(note) {
      lines = [];
      count = 0;
      box.className = base;
      box.removeAttribute("aria-busy");
      box.hidden = !note;
      box.replaceChildren(...(note ? [el("p", { class: "pc-note", text: note })] : []));
    },
    /**
     * One line.
     * @param {Series} s
     * @param {string} dir the direction class, shared with the figure's move
     */
    draw(s, dir) {
      const values = s.v;
      if (values.length < 2) return this.clear();
      let lo = Math.min(...values);
      let hi = Math.max(...values);
      const floor = ((lo + hi) / 2) * calm((values.length - 1) * s.step);
      if (hi - lo < floor) {
        const pad = (floor - (hi - lo)) / 2;
        lo -= pad;
        hi += pad;
      }
      const depths = values.map((v) => (hi > lo ? (hi - v) / (hi - lo) : 0.5));
      show([{ key: "", depths }], dir, `<path d="${curve(depths)}"/>`);
    },
    /**
     * Several lines on one axis, each as its change since its first point.
     * Their sizes differ by orders of magnitude, and on one dollar axis
     * everything but the largest would be drawn flat; as a change, a small
     * part of a portfolio moves as visibly as the whole of it does.
     * @param {{ key: string, values: number[] }[]} list positive values, oldest first, all one length
     * @param {number} step ms between points
     * @param {string} picked the key drawn over the others, which step back; none, when empty
     */
    drawMany(list, step, picked) {
      const n = list[0]?.values.length ?? 0;
      if (n < 2) return this.clear();
      const change = list.map(({ values }) => values.map((v) => (v / values[0] - 1) * 100));
      let lo = Math.min(0, ...change.flat());
      let hi = Math.max(0, ...change.flat());
      const floor = calm((n - 1) * step) * 100;
      if (hi - lo < floor) {
        const pad = (floor - (hi - lo)) / 2;
        lo -= pad;
        hi += pad;
      }
      const depth = (pct) => (hi - pct) / (hi - lo);
      const front = picked || "total";
      // The line in front goes last, so it is drawn over the rest.
      const order = list
        .map(({ key }, k) => ({ key: key.replace(/[^a-z]/g, ""), depths: change[k].map(depth) }))
        .sort((a, b) => Number(a.key === front) - Number(b.key === front));
      if (picked) box.dataset.pick = picked;
      else delete box.dataset.pick;
      show(
        order,
        "many",
        `<path class="z" d="M0,${Math.round(depth(0) * 1000)}H${n - 1}"/>` +
          order.map((line) => `<path class="k-${line.key}${line.key === picked ? " on" : ""}" d="${curve(line.depths)}"/>`).join(""),
      );
    },
  };
}

/**
 * The ranges, as a row of buttons with the one on show pressed.
 * @param {string} on
 * @param {(range: string) => void} pick
 */
export function rangeTabs(on, pick) {
  const row = el("div", { class: "pc-r", role: "group", "aria-label": "Chart range" });
  for (const [key, label] of RANGES) {
    row.append(
      el("button", {
        type: "button",
        "aria-pressed": String(key === on),
        "aria-label": since(key),
        text: label,
        onclick: (e) => {
          const button = /** @type {HTMLElement} */ (e.currentTarget);
          if (button.getAttribute("aria-pressed") === "true") return;
          for (const other of row.children) other.setAttribute("aria-pressed", String(other === button));
          pick(key);
        },
      }),
    );
  }
  return row;
}

/**
 * A token's figure, its move, its line and its ranges, wired together: a
 * range picked draws that range, and the line scrubbed reads its moment into
 * the figure and the move. The ranges are returned for the caller to place.
 *
 * 24h at rest states the 24h change every other figure on the site states.
 * Everything else, and every scrubbed moment, is read off the line on show.
 *
 * @param {{ mint: string, price: number, change24h?: number, ticks?: string, tickLo?: number, tickHi?: number, tickAt?: number }} t
 * @param {HTMLElement} fig
 * @param {HTMLElement} move
 * @param {HTMLElement} box
 * @returns {HTMLElement | null} the ranges, or null when the token has no day to start from
 */
export function priceChart(t, fig, move, box) {
  const day = daySeries(t);
  // To the cent for anything priced from a dollar up, where the compact three
  // figures of a card would read a scrubbed $102.84 as "$103" all the way
  // along the line; below a dollar, as every price is. Chosen once per token,
  // so the figure and its move never change notation mid-scrub.
  const cents = Math.abs(t.price) >= 1;
  const price = (v) => (cents ? { text: dollars(v) } : tokenPrice(v));
  const money = (v) => price(v).text;
  let range = "24h";
  let shown = day;
  let run = 0;

  function paint(value, pct, diff, over) {
    figure(fig, price(value));
    paintMove(move, pct, diff, money, over);
    return pct;
  }

  /** The figure as it stands, and the move across the range on show, which it returns. */
  function rest() {
    if (range === "24h" && t.change24h != null) {
      const c = t.change24h;
      return paint(t.price, c, t.price - t.price / (1 + c / 100), since(range));
    }
    if (!shown) return paint(t.price, null, 0, "");
    const [first, last] = [shown.v[0], shown.v[shown.v.length - 1]];
    return paint(t.price, (last / first - 1) * 100, last - first, since(range));
  }

  const line = lineChart(box, (i) => {
    if (i < 0 || !shown) return void rest();
    const [first, at] = [shown.v[0], shown.v[i]];
    paint(at, (at / first - 1) * 100, at - first, when(shown, shown.v.length, i));
  });

  function drawShown() {
    const dir = dirOf(rest());
    if (shown) line.draw(shown, dir);
    else line.clear("No price history for this range yet.");
  }

  drawShown();
  if (!day) return null;
  return rangeTabs(range, async (next) => {
    range = next;
    const id = ++run;
    if (next === "24h") {
      shown = day;
      return drawShown();
    }
    line.busy();
    const s = await loadSeries(t.mint, next);
    if (id !== run) return;
    shown = s;
    drawShown();
  });
}
