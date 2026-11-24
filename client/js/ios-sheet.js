/**
 * iOS's sheet, the frame every dialog on the site is drawn in: a navigation
 * bar (grabber, title, a leading button, the close button) over a body that
 * scrolls, rising from the bottom of a phone and centred on anything wider.
 *
 * The two kinds of dialog both use it: a native <dialog> (js/sheet.js
 * dismissible) and the overlay js/ui.js draws the money dialogs in. Its own
 * module, depending on nothing but dom.js, so either can import it.
 *
 * What it adds beyond the look, for a thumb:
 *  - a drag down on the bar dismisses the sheet, and one that falls short
 *    springs back;
 *  - the page under it holds still;
 *  - it rises with the on-screen keyboard instead of sitting under it;
 *  - it leaves the way it came, sliding back down, before it is gone.
 */
import { el } from "./dom.js";
import CSS from "./ios-sheet.css";

const X =
  '<svg width="12" height="12" viewBox="0 0 12 12" aria-hidden="true"><path d="M2 2l8 8m0-8l-8 8" stroke="currentColor" stroke-width="2.2" stroke-linecap="round"/></svg>';
const BACK =
  '<svg width="12" height="20" viewBox="0 0 12 20" aria-hidden="true"><path d="M10 2 2 10l8 8" fill="none" stroke="currentColor" stroke-width="2.6" stroke-linecap="round" stroke-linejoin="round"/></svg>';

const PHONE = "(max-width: 620px)";

/** Add the sheet's styles once per page, ahead of any dialog's own. */
export function iosStyles() {
  if (document.getElementById("ios-css")) return;
  document.head.prepend(el("style", { id: "ios-css", text: CSS }));
}

/** How many sheets hold the page still; the last one out lets it go. */
let holds = 0;

function keyboard() {
  const vv = window.visualViewport;
  const kb = vv ? Math.max(0, window.innerHeight - vv.height - vv.offsetTop) : 0;
  document.documentElement.style.setProperty("--ios-kb", `${Math.round(kb)}px`);
}

/**
 * Hold the page still, and keep --ios-kb at the keyboard's height, while a
 * sheet is open. Returns the release.
 */
export function hold() {
  if (holds++ === 0) {
    document.documentElement.classList.add("ios-lock");
    window.visualViewport?.addEventListener("resize", keyboard);
    window.visualViewport?.addEventListener("scroll", keyboard);
    keyboard();
  }
  let held = true;
  return () => {
    if (!held) return;
    held = false;
    if (--holds > 0) return;
    document.documentElement.classList.remove("ios-lock");
    document.documentElement.style.removeProperty("--ios-kb");
    window.visualViewport?.removeEventListener("resize", keyboard);
    window.visualViewport?.removeEventListener("scroll", keyboard);
  };
}

/**
 * Play the sheet's exit on `node` (the sheet, or the overlay around it), then
 * resolve. Immediately when nothing is drawn to animate.
 *
 * @param {HTMLElement} node
 * @param {HTMLElement} [sheet] the sheet itself, when `node` is its overlay
 */
export function leave(node, sheet = node) {
  return new Promise((done) => {
    if (!node.isConnected || matchMedia("(prefers-reduced-motion: reduce)").matches) return done();
    node.setAttribute("data-leave", "");
    if (sheet !== node) sheet.setAttribute("data-leave", "");
    // Where it was dragged to is where it leaves from.
    const dragged = sheet.style.transform;
    if (dragged) {
      sheet.style.transition = "transform .22s cubic-bezier(.4,0,1,1)";
      sheet.style.animation = "none";
      requestAnimationFrame(() => (sheet.style.transform = "translateY(calc(100% + 24px))"));
    }
    let finished = false;
    const end = () => {
      if (finished) return;
      finished = true;
      node.removeAttribute("data-leave");
      sheet.removeAttribute("data-leave");
      sheet.style.transform = sheet.style.transition = sheet.style.animation = "";
      done();
    };
    sheet.addEventListener("animationend", end, { once: true });
    sheet.addEventListener("transitionend", end, { once: true });
    setTimeout(end, 320);
  });
}

/**
 * A drag down on `handle` moves `sheet` with the finger; let go far enough,
 * or fast enough, and `dismiss` runs. Phones only: a mouse has the X and the
 * backdrop.
 *
 * @param {HTMLElement} sheet
 * @param {HTMLElement} handle
 * @param {() => void} dismiss
 */
function draggable(sheet, handle, dismiss) {
  /** @type {{id: number, y: number, t: number, dy: number, v: number} | null} */
  let drag = null;
  handle.addEventListener("pointerdown", (e) => {
    if (e.pointerType === "mouse" || !matchMedia(PHONE).matches) return;
    if (/** @type {Element} */ (e.target).closest("button, a, input, select, textarea")) return;
    drag = { id: e.pointerId, y: e.clientY, t: e.timeStamp, dy: 0, v: 0 };
    handle.setPointerCapture(e.pointerId);
    sheet.setAttribute("data-drag", "");
    sheet.removeAttribute("data-back");
  });
  handle.addEventListener("pointermove", (e) => {
    if (!drag || e.pointerId !== drag.id) return;
    const dy = e.clientY - drag.y;
    const dt = Math.max(1, e.timeStamp - drag.t);
    drag.v = (dy - drag.dy) / dt;
    drag.dy = dy;
    drag.t = e.timeStamp;
    // Up, it gives a little and no more, as a sheet at its full height does.
    const y = dy > 0 ? dy : -Math.sqrt(-dy) * 2;
    sheet.style.transform = `translateY(${y}px)`;
  });
  const up = (/** @type {PointerEvent} */ e) => {
    if (!drag || e.pointerId !== drag.id) return;
    const { dy, v } = drag;
    drag = null;
    sheet.removeAttribute("data-drag");
    if (e.type === "pointerup" && (dy > Math.min(140, sheet.offsetHeight * 0.3) || (v > 0.5 && dy > 24))) {
      dismiss();
      return;
    }
    sheet.setAttribute("data-back", "");
    sheet.style.transform = "";
    sheet.addEventListener("transitionend", () => sheet.removeAttribute("data-back"), { once: true });
  };
  handle.addEventListener("pointerup", up);
  handle.addEventListener("pointercancel", up);
}

/**
 * @typedef {{
 *   title?: string,
 *   titleId?: string,
 *   lead?: HTMLElement | null,
 *   close?: boolean,
 *   onDismiss: () => void,
 * }} FrameOpts
 *   `title`, or the sheet's first <h2>, is the bar's title; `lead` sits at its
 *   leading end; `close: false` leaves out the close button (a step that must
 *   be finished); `onDismiss` is what the close button and a drag do.
 */

/**
 * Turn `sheet` into an iOS sheet: its children, but for the title, go into a
 * body that scrolls, under a navigation bar.
 *
 * @param {HTMLElement} sheet
 * @param {FrameOpts} opts
 */
export function frame(sheet, opts) {
  iosStyles();
  sheet.classList.add("ios-sh");
  const h2 = /** @type {HTMLElement | null} */ (sheet.querySelector(":scope > h2"));
  const title = el("h2", { class: "ios-tt", id: opts.titleId || h2?.id || undefined, text: opts.title ?? h2?.textContent ?? "" });
  h2?.remove();
  const body = el("div", { class: "ios-bd" });
  body.append(...sheet.childNodes);
  const lead = el("div", { class: "ios-ld" });
  if (opts.lead) lead.append(opts.lead);
  const x =
    opts.close === false
      ? null
      : el("button", { type: "button", class: "ios-x", "aria-label": "Close", onclick: () => opts.onDismiss() });
  if (x) x.innerHTML = X;
  const head = el("div", { class: "ios-hd" }, el("span", { class: "ios-gr", "aria-hidden": "true" }), lead, title, x);
  sheet.append(head, body);
  if (opts.close !== false) draggable(sheet, head, opts.onDismiss);
  return {
    head,
    body,
    title,
    /** Change what leads the bar: a Back button for a step, or nothing. */
    setLead(/** @type {HTMLElement | null} */ node) {
      lead.replaceChildren(...(node ? [node] : []));
    },
    setTitle(/** @type {string} */ text) {
      title.textContent = text;
    },
  };
}

/** iOS's Back: a chevron and the word, in the bar's leading place. */
export function backButton(onclick, text = "Back") {
  const b = el("button", { type: "button", "aria-label": text, onclick });
  b.innerHTML = BACK;
  b.append(el("span", { text }));
  return b;
}
