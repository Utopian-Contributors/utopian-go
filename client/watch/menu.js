/**
 * What the home page's two pull-down menus share: the watchlist's
 * (watch/main.js) and the news topics' (watch/news.js). An iOS pull-down
 * menu: frosted, rounded, rows with a leading checkmark, opening out of its
 * button's corner.
 */
import { el } from "../js/dom.js";

export const CHECK =
  '<svg viewBox="0 0 14 14" width="14" height="14" aria-hidden="true"><path d="M2 7.5 5.5 11 12 3" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/></svg>';

const CSS = `
.wl-m{position:absolute;z-index:50;right:0;width:260px;overflow:auto;
 overscroll-behavior:contain;border-radius:14px;background:rgba(246,246,248,.8);
 -webkit-backdrop-filter:blur(40px) saturate(1.8);backdrop-filter:blur(40px) saturate(1.8);
 box-shadow:0 0 0 .5px rgba(0,0,0,.1),0 14px 44px rgba(0,0,0,.22);transform-origin:top right;
 scrollbar-width:thin;scrollbar-color:var(--sep) transparent;animation:wl-in .36s var(--out)}
.wl-m.up{transform-origin:bottom right}
@keyframes wl-in{from{opacity:0;scale:.5}}
.wl-m p{margin:0;padding:11px 16px 9px;font-size:13px;line-height:1.2;color:var(--f)}
.wl-m .wl-h{padding:10px 16px 6px;border-top:8px solid rgba(var(--rgb),.06);font-weight:600}
.wl-o{position:relative;isolation:isolate;overflow:hidden;display:grid;grid-template-columns:22px 1fr;
 align-items:center;gap:4px;width:100%;min-height:52px;padding:0 64px 0 12px;border:0;
 border-top:.5px solid var(--sep);border-radius:0;background:none;color:var(--t);text-align:left;
 font:17px/1.15 var(--ff);letter-spacing:-.01em;cursor:pointer;--press:1}
.wl-h+div>.wl-o:first-child{border-top:0}
.wl-o:hover,.wl-o:focus-visible{background:var(--wash);outline:0}
.wl-o:active:not(:disabled){background:var(--wash2)}
.wl-o:disabled{cursor:default}
.wl-o:disabled>:not(img){opacity:.35}
.wl-o svg{visibility:hidden}
.wl-o[aria-checked=true] svg{visibility:visible}
.wl-o span{min-width:0;overflow:hidden;white-space:nowrap;text-overflow:ellipsis}
.wl-o small{display:block;margin-top:2px;overflow:hidden;font-size:13px;color:var(--f);letter-spacing:0;
 white-space:nowrap;text-overflow:ellipsis}
.wl-o img{position:absolute;z-index:-1;top:50%;right:-14px;width:72px;height:72px;margin-top:-36px;
 border-radius:50%;opacity:.85;pointer-events:none;
 -webkit-mask-image:linear-gradient(to left,#000 25%,transparent 90%);mask-image:linear-gradient(to left,#000 25%,transparent 90%)}
.wl-o:disabled img{opacity:.3}
.wl-m .wl-end{min-height:52px;padding:0 16px;display:flex;align-items:center;justify-content:center;
 border:0;border-top:.5px solid var(--sep);background:none;color:var(--f);font:15px var(--ff);width:100%}
.wl-m.nw .wl-o{padding-right:16px}
#hm-nw{transition:opacity .2s}
#hm-nw[aria-busy=true]{opacity:.55}
@media (prefers-color-scheme:dark){.wl-m{background:rgba(38,38,40,.78);box-shadow:0 0 0 .5px rgba(255,255,255,.1),0 14px 44px rgba(0,0,0,.5)}}
@media (prefers-reduced-motion:reduce){.wl-m{animation:none}}
`;

let styled = false;

/** The menus' stylesheet, once, whichever opens first. */
export function style() {
  if (styled) return;
  styled = true;
  document.head.append(el("style", { text: CSS }));
}

/**
 * Out of the button's corner, downwards, unless there is more room above and
 * too little below for the whole menu, as an iOS menu flips near the screen's
 * foot; and no taller than the side it opens to, scrolling inside past that.
 * @param {HTMLElement} m the menu
 * @param {HTMLElement} button what opened it
 * @param {HTMLElement} section what it is placed in
 * @param {number} tall the height it would like
 */
export function place(m, button, section, tall = 420) {
  const at = button.getBoundingClientRect();
  const box = section.getBoundingClientRect();
  const below = innerHeight - at.bottom - 16;
  const above = at.top - 16;
  const up = below < tall && above > below;
  m.classList.toggle("up", up);
  m.style.maxHeight = `${Math.max(160, Math.min(tall, up ? above : below))}px`;
  m.style.top = up ? "" : `${at.bottom - box.top + 6}px`;
  m.style.bottom = up ? `${box.bottom - at.top + 6}px` : "";
}

/**
 * The arrows walk a menu's rows that can be chosen, round from either end.
 * @param {KeyboardEvent} e
 * @param {HTMLElement} m
 */
export function walk(e, m) {
  e.preventDefault();
  const live = /** @type {HTMLButtonElement[]} */ ([...m.querySelectorAll(".wl-o")]).filter((r) => !r.disabled);
  const at = live.indexOf(/** @type {HTMLButtonElement} */ (document.activeElement));
  live[(at + (e.key === "ArrowDown" ? 1 : -1) + live.length) % live.length]?.focus();
}
