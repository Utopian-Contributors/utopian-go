/**
 * What every native <dialog> on the site shares with the money dialogs in
 * ui.js: iOS's sheet (js/ios-sheet.js). A navigation bar with the title in
 * the middle and a grey close button, a tap outside that dismisses it, and on
 * a phone a sheet that rises from the bottom and goes back down when it is
 * dragged by its bar.
 *
 * However it is closed (the X, a drag, the backdrop, Escape, or a caller's
 * own dialog.close()), it slides away first and closes after, so the `close`
 * event still means the dialog is gone.
 */
import { frame, hold, iosStyles, leave } from "./ios-sheet.js";

const native = {
  close: HTMLDialogElement.prototype.close,
  showModal: HTMLDialogElement.prototype.showModal,
};

/**
 * Frame a <dialog> as an iOS sheet. Call once, before showModal(). Its first
 * <h2> becomes the bar's title.
 *
 * @param {HTMLDialogElement} dialog
 * @param {{lead?: HTMLElement | null, close?: boolean, title?: string}} [opts]
 *   `close: false` for a step that must be finished: no X, no drag, no
 *   outside tap, and Escape does nothing.
 */
export function sheetDialog(dialog, opts = {}) {
  iosStyles();
  dialog.classList.add("dlg");
  const closable = opts.close !== false;
  /** @type {(() => void) | null} */
  let release = null;
  let leaving = false;

  dialog.showModal = function () {
    native.showModal.call(dialog);
    release ??= hold();
    // The bar comes first, so the browser would put focus on its X; the
    // dialog's own first control is what it focused before the bar was there.
    const first = /** @type {HTMLElement | null} */ (
      parts.body.querySelector("input:not([disabled]):not([hidden]), select, textarea, button:not([disabled]), a[href]")
    );
    first?.focus({ preventScroll: true });
  };
  dialog.close = function (value) {
    if (!dialog.open || leaving) return;
    leaving = true;
    leave(dialog).then(() => {
      leaving = false;
      native.close.call(dialog, value);
    });
  };
  dialog.addEventListener("close", () => {
    release?.();
    release = null;
  });
  // Escape: the same slide away as the X, or nothing for a step that must be finished.
  dialog.addEventListener("cancel", (e) => {
    e.preventDefault();
    if (closable) dialog.close();
  });

  const parts = frame(dialog, { ...opts, onDismiss: () => dialog.close() });
  if (!closable) return parts;

  // A tap on the backdrop lands on the dialog itself, outside its box. Both
  // ends of the press must be out there: a text selection dragged past the
  // edge also ends in a click on the dialog.
  const outside = (/** @type {MouseEvent} */ e) => {
    if (e.target !== dialog) return false;
    const r = dialog.getBoundingClientRect();
    return e.clientX < r.left || e.clientX > r.right || e.clientY < r.top || e.clientY > r.bottom;
  };
  let downOutside = false;
  dialog.addEventListener("pointerdown", (e) => (downOutside = outside(e)));
  dialog.addEventListener("click", (e) => {
    if (downOutside && outside(e)) dialog.close();
    downOutside = false;
  });
  return parts;
}

/**
 * Give a <dialog> the iOS sheet, its close button and the outside tap. Call
 * once, before showModal().
 *
 * @param {HTMLDialogElement} dialog
 * @param {{lead?: HTMLElement | null}} [opts]
 */
export function dismissible(dialog, opts) {
  return sheetDialog(dialog, opts);
}
