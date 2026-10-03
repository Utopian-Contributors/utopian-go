/**
 * Places: every host someone left search for, as a honeycomb they can pan.
 * A host opens into its pages, by day, on an arc that scrolls; the host again
 * folds them back.
 */
import { el } from "../js/dom.js";
import { injectStyles } from "../js/ui.js";
import { readTrail, writeTrail } from "../js/trail.js";

const S = 96;
const GAP = 10;
const STEP = S + GAP;
const PAD = 24;
const DIRS = [[0, -1], [-1, 0], [-1, 1], [0, 1], [1, 0], [1, -1]];
// A page's pill: its height and widest. A day's heading: its height. The arc:
// the longest its radius gets. The day ticks: the least room between two.
const H = 40;
const W = 360;
const D = 24;
const ARC = 300;
const TICK = 8;

const CSS = `
.hv-on,.hv-on body{overflow:hidden}
.hv-on #tb{display:none}
#hv{position:fixed;inset:0;z-index:30;display:flex;flex-direction:column;background:var(--bg);color:var(--t)}
.hv-v{flex:1;display:grid;overflow:auto;overscroll-behavior:contain;overflow-anchor:none;scrollbar-width:none;cursor:grab}
.hv-v::-webkit-scrollbar{display:none}
.hv-l{position:relative;margin:auto}
.hv-c{position:absolute;display:flex;flex-direction:column;align-items:center;justify-content:center;gap:6px;width:${S}px;height:${S}px;padding:14px;border:0;border-radius:50%;background:var(--ch);color:var(--t);font:500 11px/1.25 var(--ff);text-align:center;text-decoration:none;cursor:pointer;user-select:none;-webkit-user-drag:none;transition:transform .15s}
.hv-c:hover{transform:scale(1.06)}
.hv-c:focus-visible{outline:2px solid var(--a);outline-offset:2px}
.hv-c span{display:-webkit-box;-webkit-box-orient:vertical;-webkit-line-clamp:4;overflow:hidden;overflow-wrap:break-word;hyphens:auto;max-width:100%}
.hv-p,.hv-d{left:0;top:0}
.hv-p{width:max-content;max-width:${W}px;height:${H}px;padding:0 16px;border-radius:999px;font-size:13px;transition:none}
.hv-p span{display:block;white-space:nowrap;text-overflow:ellipsis}
.hv-d{position:absolute;margin:0;padding:0 16px;color:var(--m);font:600 12px/${D}px var(--ff);white-space:nowrap}
.hv-t{position:absolute;right:16px;width:28px}
.hv-t button{position:absolute;right:0;width:28px;height:12px;margin-top:-6px;padding:0;border:0;background:none;cursor:pointer}
.hv-t button::before{content:"";position:absolute;top:5px;right:0;width:12px;height:2px;border-radius:1px;background:var(--m);opacity:.4;transition:width .15s,opacity .15s}
.hv-t .on::before{width:20px;opacity:1}
.hv-t span{position:absolute;top:50%;right:32px;padding:3px 10px;border-radius:999px;background:var(--ch);color:var(--t);font:600 12px/1.4 var(--ff);white-space:nowrap;transform:translateY(-50%);opacity:0;pointer-events:none;transition:opacity .15s}
.hv-t button:hover span,.hv-t button:focus-visible span{opacity:1}
.hv-t button:focus-visible{outline:2px solid var(--a);outline-offset:2px}
.hv-i{width:32px;height:32px;flex:none;border-radius:6px}
b.hv-i{display:grid;place-items:center;border-radius:50%;background:var(--go);color:var(--go-ink);font-size:16px}
.hv-bar{display:flex;justify-content:center;align-items:center;gap:20px;padding:12px 16px calc(12px + env(safe-area-inset-bottom))}
.hv-x{color:var(--dn)}
.ed .hv-c>*{animation:hv-j .25s infinite alternate}
.ed .hv-p>*{animation-name:hv-k}
.ed .hv-c::after{content:"\\00d7";position:absolute;top:4px;right:12px;display:grid;place-items:center;box-sizing:border-box;width:20px;height:20px;padding-bottom:2px;border-radius:50%;background:var(--t);color:var(--bg);font:700 14px/1 var(--ff)}
.ed .hv-p::after{top:-7px;right:10px}
@keyframes hv-j{from{transform:rotate(-2deg)}to{transform:rotate(2deg)}}
@keyframes hv-k{from{transform:rotate(-.6deg)}to{transform:rotate(.6deg)}}
@media (prefers-reduced-motion:reduce){.ed .hv-c>*{animation:none}}
`;

let root, view, layer, place, editing, done, opener, drag, moved, fit, rail, bend;
const still = matchMedia("(prefers-reduced-motion: reduce)");

/** @param {number} n */
function spiral(n) {
  const out = [[0, 0]];
  for (let k = 1; out.length < n; k++) {
    let q = k;
    let r = 0;
    for (const [dq, dr] of DIRS)
      for (let s = 0; s < k; s++) {
        out.push([q, r]);
        q += dq;
        r += dr;
      }
  }
  return out.slice(0, n).map(([q, r]) => [STEP * (q + r / 2), STEP * r * 0.866]);
}

/**
 * @param {HTMLElement} node
 * @param {Keyframe[]} frames
 * @param {string} origin
 */
function play(node, frames, origin) {
  if (still.matches) return Promise.resolve();
  node.style.transformOrigin = origin;
  return node.animate(frames, { duration: 240, easing: "ease-in-out", fill: "forwards" }).finished;
}

/**
 * @param {HTMLElement[]} nodes
 * @param {number | null} focus cell to centre, or null to keep the scroll
 * @param {string} [from] transform the layer grows out of
 */
function mount(nodes, focus, from) {
  const pts = spiral(nodes.length);
  const x0 = -Math.max(...pts.map((p) => Math.abs(p[0])));
  const y0 = -Math.max(...pts.map((p) => Math.abs(p[1])));
  const next = el("div", { class: "hv-l" });
  next.style.width = `${S + 2 * (PAD - x0)}px`;
  next.style.height = `${S + 2 * (PAD - y0)}px`;
  nodes.forEach((n, i) => {
    n.style.left = `${pts[i][0] - x0 + PAD}px`;
    n.style.top = `${pts[i][1] - y0 + PAD}px`;
    next.append(n);
  });
  const left = view.scrollLeft;
  const top = view.scrollTop;
  layer.replaceWith(next);
  layer = next;
  if (focus == null) {
    view.scrollLeft = left;
    view.scrollTop = top;
    return;
  }
  const cx = pts[focus][0] - x0 + PAD + S / 2;
  const cy = pts[focus][1] - y0 + PAD + S / 2;
  view.scrollLeft = cx - view.clientWidth / 2;
  view.scrollTop = cy - view.clientHeight / 2;
  if (from) play(layer, [{ transform: from, opacity: 0 }, { transform: "none", opacity: 1 }], `${cx}px ${cy}px`);
}

/** @param {HTMLElement} cell */
function centre(cell) {
  return `${cell.offsetLeft + S / 2}px ${cell.offsetTop + S / 2}px`;
}

/**
 * "Today", or the day and month ("10. September"), with the year when it is
 * not this one.
 * @param {number} a
 */
function day(a) {
  const d = new Date(a);
  const now = new Date();
  if (d.toDateString() === now.toDateString()) return "Today";
  const year = d.getFullYear() === now.getFullYear() ? "" : ` ${d.getFullYear()}`;
  return `${d.getDate()}. ${d.toLocaleString("en", { month: "long" })}${year}`;
}

/** @param {{ h: string, i?: string }} p */
function face(p) {
  const letter = el("b", { class: "hv-i", "aria-hidden": "true", text: p.h.charAt(0).toUpperCase() });
  if (!p.i || !p.i.startsWith("https://")) return letter;
  const img = el("img", {
    class: "hv-i",
    src: p.i,
    alt: "",
    decoding: "async",
    draggable: "false",
    referrerpolicy: "no-referrer",
  });
  img.addEventListener("error", () => img.replaceWith(letter), { once: true });
  return img;
}

/**
 * @param {import('../js/trail.js').Place} p
 * @param {(cell: HTMLElement) => void} onPick
 */
function hostCell(p, onPick) {
  const cell = el("button", { type: "button", class: "hv-c hv-o", title: p.h, "aria-label": p.h }, face(p));
  cell.addEventListener("click", () => onPick(cell));
  return cell;
}

/**
 * @param {import('../js/trail.js').Place} p
 * @param {import('../js/trail.js').Page} page
 */
function pageCell(p, page) {
  const label = page.t || page.u.replace(/^https?:\/\/[^/]+/i, "") || "/";
  const cell = el("a", {
    class: "hv-c hv-p",
    href: page.u,
    target: "_blank",
    rel: "noopener",
    draggable: "false",
    title: page.t || page.u,
  }, el("span", { text: label }));
  cell.addEventListener("click", (e) => {
    if (!editing) return;
    e.preventDefault();
    forget(p.h, page.u);
  });
  return cell;
}

/**
 * @param {string | null} [h] host to centre on; undefined keeps the scroll
 * @param {string} [from]
 */
function showAll(h, from) {
  place = null;
  bend = null;
  rail?.remove();
  rail = null;
  const list = readTrail().sort((a, b) => b.p.length - a.p.length);
  if (!list.length) return close();
  const nodes = list.map((p) =>
    hostCell(p, (cell) => {
      if (editing) return forget(p.h);
      play(layer, [{ transform: "none", opacity: 1 }, { transform: "scale(3)", opacity: 0 }], centre(cell)).then(() =>
        showPlace(p.h, "scale(.3)"),
      );
    }),
  );
  const at = list.findIndex((p) => p.h === h);
  mount(nodes, h === undefined ? null : Math.max(at, 0), from);
}

/**
 * A host's pages, newest first under a heading for each day, on an arc around
 * the host's right side. The arc grows with them to a radius of ARC, a third
 * of a circle at most; past that the list scrolls through it with the host
 * held in the middle, and a page leaving either end fades. A tick for each day
 * down the right edge then shows where the list goes, the days in sight marked.
 * @param {string} h
 * @param {string} [from]
 */
function showPlace(h, from) {
  const p = readTrail().find((x) => x.h === h);
  if (!p) return showAll(null);
  place = h;
  const head = hostCell(p, (cell) => {
    if (editing) return forget(h);
    play(layer, [{ transform: "none", opacity: 1 }, { transform: "scale(.3)", opacity: 0 }], centre(cell)).then(() =>
      showAll(h, "scale(3)"),
    );
  });
  head.classList.add("hv-f");
  head.setAttribute("aria-expanded", "true");
  /** @type {HTMLElement[]} */
  const items = [];
  /** @type {string[]} */
  const days = [];
  /** @type {number[]} the day each item is under */
  const of = [];
  for (const page of p.p) {
    if (!/^https?:\/\//i.test(page.u)) continue;
    const d = day(page.a);
    if (d !== days[days.length - 1]) {
      days.push(d);
      items.push(el("h3", { class: "hv-d", text: d }));
      of.push(days.length - 1);
    }
    items.push(pageCell(p, page));
    of.push(days.length - 1);
  }
  const top = from ? 0 : view.scrollTop;
  const next = el("div", { class: "hv-l" }, head, ...items);
  layer.replaceWith(next);
  layer = next;
  rail?.remove();
  rail = null;

  const vw = view.clientWidth;
  const vh = view.clientHeight;
  const hs = items.map((n) => n.offsetHeight);
  const ws = items.map((n) => n.offsetWidth);
  /** @type {number[]} */
  const ys = [];
  let len = 0;
  for (const x of hs) {
    ys.push(len);
    len += x + GAP;
  }
  len = Math.max(0, len - GAP);
  const near = S / 2 + GAP;
  const r = Math.min(ARC, (vh - 2 * PAD) / Math.sqrt(3), Math.max(near, len / Math.sqrt(3)));
  const a = (r * Math.sqrt(3)) / 2;
  const fits = len <= 2 * a + 1;
  const y0 = vh / 2 - (fits ? len / 2 : a);
  const cx = Math.max(PAD + S / 2, (vw + S / 2 - r - Math.max(0, ...ws)) / 2);
  layer.style.width = `${vw}px`;
  layer.style.height = `${fits ? vh : len + vh - 2 * a}px`;
  head.style.left = `${cx - S / 2}px`;
  // Focus scrolls a page onto the arc, not merely onto the screen.
  for (const n of items) n.style.scrollMarginBlock = `${vh / 2 - a}px`;

  if (!fits) {
    const at = days.map((_, g) => ys[of.indexOf(g)]);
    const pos = at.map((y) => (y / len) * 2 * a);
    for (let g = 1; g < pos.length; g++) pos[g] = Math.max(pos[g], pos[g - 1] + TICK);
    for (let g = pos.length - 1; g >= 0; g--)
      pos[g] = Math.max(0, Math.min(pos[g], g + 1 < pos.length ? pos[g + 1] - TICK : 2 * a));
    rail = el("nav", { class: "hv-t", "aria-label": "Days" },
      ...days.map((d, g) => {
        const tick = el("button", { type: "button" }, el("span", { text: d }));
        tick.style.top = `${pos[g]}px`;
        tick.addEventListener("click", () => view.scrollTo({ top: at[g], behavior: still.matches ? "auto" : "smooth" }));
        return tick;
      }),
    );
    rail.style.top = `${vh / 2 - a}px`;
    rail.style.height = `${2 * a}px`;
    root.append(rail);
  }

  bend = () => {
    const st = view.scrollTop;
    head.style.top = `${st + vh / 2 - S / 2}px`;
    /** @type {Set<number>} */
    const seen = new Set();
    items.forEach((n, i) => {
      const dy = Math.abs(y0 + ys[i] + hs[i] / 2 - st - vh / 2);
      const c = Math.min(dy, a);
      const out = Math.max(0, dy - a) / (H + GAP);
      const x = Math.max(Math.sqrt(r * r - c * c), Math.sqrt(Math.max(0, near ** 2 - Math.max(0, c - hs[i] / 2) ** 2)));
      n.style.transform = `translate(${cx + x}px,${y0 + ys[i]}px)`;
      n.style.opacity = out ? `${Math.max(0, 1 - out)}` : "";
      n.style.pointerEvents = out > 0.5 ? "none" : "";
      if (!out) seen.add(of[i]);
    });
    rail?.querySelectorAll("button").forEach((tick, g) => tick.classList.toggle("on", seen.has(g)));
  };
  view.scrollTop = top;
  bend();
  if (from) play(layer, [{ transform: from, opacity: 0 }, { transform: "none", opacity: 1 }], `${cx}px ${vh / 2}px`);
}

/**
 * @param {string} h
 * @param {string} [u] one page, or the whole host
 */
function forget(h, u) {
  const list = readTrail();
  const at = list.findIndex((p) => p.h === h);
  if (at < 0) return;
  if (u) list[at].p = list[at].p.filter((page) => page.u !== u);
  if (!u || !list[at].p.length) list.splice(at, 1);
  writeTrail(list);
  if (place && list.some((p) => p.h === place)) showPlace(place);
  else showAll(place || undefined);
}

/** @param {boolean} on */
function setEditing(on) {
  editing = on;
  root.classList.toggle("ed", on);
  root.querySelector(".hv-e").textContent = on ? "Done" : "Edit";
  /** @type {HTMLElement} */ (root.querySelector(".hv-x")).hidden = !on;
}

/** @param {PointerEvent} e */
function onDown(e) {
  if (e.pointerType !== "mouse" || e.button) return;
  drag = { x: e.clientX, y: e.clientY, l: view.scrollLeft, t: view.scrollTop };
  moved = false;
}

/** @param {PointerEvent} e */
function onMove(e) {
  if (!drag) return;
  const dx = e.clientX - drag.x;
  const dy = e.clientY - drag.y;
  if (!moved && Math.hypot(dx, dy) < 6) return;
  moved = true;
  view.scrollLeft = drag.l - dx;
  view.scrollTop = drag.t - dy;
}

function onUp() {
  drag = null;
}

/** @param {MouseEvent} e */
function onClick(e) {
  if (!moved) return;
  moved = false;
  e.preventDefault();
  e.stopPropagation();
}

/** @param {KeyboardEvent} e */
function onKey(e) {
  if (e.key === "Escape") close();
}

/** The arc is laid out for the view it opened in. */
function onResize() {
  if (place) showPlace(place);
}

/** @param {boolean} [quiet] the page is already going somewhere else */
function close(quiet) {
  if (!root) return;
  root.remove();
  root = null;
  rail = null;
  bend = null;
  fit.disconnect();
  document.documentElement.classList.remove("hv-on");
  removeEventListener("pointermove", onMove);
  removeEventListener("pointerup", onUp);
  removeEventListener("click", onClick, true);
  removeEventListener("keydown", onKey);
  removeEventListener("resize", onResize);
  done?.();
  if (quiet === true) return;
  document.body.className = "home";
  opener?.focus();
}

/**
 * @param {HTMLElement} btn
 * @param {() => void} [onDone]
 */
function open(btn, onDone) {
  if (root) return;
  opener = btn;
  done = onDone;
  editing = false;
  injectStyles("hv-s", CSS);
  layer = el("div", { class: "hv-l" });
  view = el("div", { class: "hv-v" }, layer);
  const edit = el("button", { type: "button", class: "ac-b hv-e", text: "Edit" });
  const clear = el("button", { type: "button", class: "ac-b hv-x", text: "Clear all", hidden: true });
  const back = el("button", { type: "button", class: "ac-b", text: "Close" });
  root = el("div", { id: "hv", role: "dialog", "aria-modal": "true", "aria-label": "Places" },
    view,
    el("div", { class: "hv-bar" }, clear, back, edit),
  );
  edit.addEventListener("click", () => setEditing(!editing));
  clear.addEventListener("click", () => {
    if (!confirm("Forget every place?")) return;
    writeTrail([]);
    close();
  });
  back.addEventListener("click", () => close());
  view.addEventListener("pointerdown", onDown);
  view.addEventListener("scroll", () => bend?.());
  addEventListener("pointermove", onMove);
  addEventListener("pointerup", onUp);
  addEventListener("click", onClick, true);
  addEventListener("keydown", onKey);
  addEventListener("resize", onResize);
  document.documentElement.classList.add("hv-on");
  document.body.className = "res";
  const chrome = document.getElementById("chrome");
  fit = new ResizeObserver(() => {
    root.style.top = `${chrome.offsetHeight}px`;
  });
  fit.observe(chrome);
  root.style.top = `${chrome.offsetHeight}px`;
  document.body.append(root);
  showAll(null, "scale(.85)");
  /** @type {HTMLElement | null} */ (layer.firstElementChild)?.focus({ preventScroll: true });
}

window.ugHive = { open, close };
