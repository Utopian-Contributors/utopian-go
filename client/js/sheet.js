/**
 * What every native <dialog> on the site shares with the trade dialog in
 * ui.js: a round X in the top right corner, a tap outside that dismisses it,
 * and on a phone a sheet docked to the bottom edge of the screen.
 */
import { el } from "./dom.js";
import { X_ICON, injectStyles } from "./ui.js";

const CSS = `
dialog.dlg{position:fixed}
.dlg-x{position:absolute;top:12px;right:12px;display:grid;place-items:center;width:30px;height:30px;
 padding:0;border:0;border-radius:50%;background:rgba(127,127,127,.16);color:var(--t);cursor:pointer}
.dlg-x:hover{background:rgba(127,127,127,.28)}
.dlg-x svg{display:block}
dialog.dlg h2{margin-right:36px}
@media (max-width:620px){dialog.dlg{width:100%;max-width:none;max-height:calc(100% - 24px);
 margin:auto 0 0;border-bottom:0;border-radius:16px 16px 0 0}}
`;

/**
 * Give a <dialog> the X and the outside tap. Call once, before showModal().
 *
 * @param {HTMLDialogElement} dialog
 */
export function dismissible(dialog) {
  injectStyles("dlg-css", CSS);
  dialog.classList.add("dlg");
  const x = el("button", { type: "button", class: "dlg-x", "aria-label": "Close", onclick: () => dialog.close() });
  x.innerHTML = X_ICON;
  // Last, so showModal() still focuses the dialog's own first control.
  dialog.append(x);

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
}
