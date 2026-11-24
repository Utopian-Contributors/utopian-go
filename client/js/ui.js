/**
 * The modal, and the wallet chooser that is the only thing some of them hold.
 * Every one is drawn as iOS's sheet (js/ios-sheet.js).
 *
 * Lives under js/ rather than swap/ because two different bundles open one: the
 * buy panel, and the Login button in the header. They are the same dialog on
 * purpose — same width, same corner radius, same way of dismissing — so a
 * chooser that appears over a trade and one that appears over the header are
 * not two designs a reader has to reconcile.
 *
 * Styles are injected rather than shipped in a stylesheet, so a visitor who
 * never opens a dialog downloads none of them. Every colour reads from the
 * page's existing custom properties, so light and dark come for free.
 */
import { el } from "./dom.js";
import { frame, hold, iosStyles, leave } from "./ios-sheet.js";

/**
 * The wallet chooser and the note line under a form: what every money dialog
 * shares inside its sheet. The sheet itself is js/ios-sheet.js. The trade
 * form's own controls are a separate sheet in swap/form.css, so the login
 * bundle does not carry the styling for an amount field it will never render.
 */
const CSS = `
.swx-lbl{display:flex;justify-content:space-between;align-items:center;
 font-size:13px;color:var(--f);margin-bottom:6px}
.swx-note{margin-top:10px;font-size:13px;line-height:18px;color:var(--f);min-height:18px;
 text-align:center}
.swx-note.err{color:var(--dn)}
.swx-note.ok{color:var(--go)}
.swx-note a{color:var(--a);text-decoration:underline}
.swx-w{display:flex;flex-direction:column;border-radius:18px;background:var(--wash);overflow:hidden}
.swx-w button{position:relative;display:flex;align-items:center;gap:12px;width:100%;min-height:56px;padding:0 16px;
 border:0;background:none;cursor:pointer;font:400 17px/22px var(--ff);color:var(--t);text-align:left;
 -webkit-tap-highlight-color:transparent}
.swx-w button+button::before{content:"";position:absolute;top:0;right:0;left:58px;height:1px;
 background:var(--sep);transform:scaleY(.5);transform-origin:top}
.swx-w button:hover:not(:disabled),.swx-w button:active:not(:disabled){background:var(--wash)}
.swx-w button:disabled{opacity:.6;cursor:progress}
.swx-w img{width:30px;height:30px;border-radius:8px}
`;

/**
 * Add a stylesheet once per page.
 *
 * Keyed by id so two bundles asking for the same sheet get one copy — the buy
 * panel and the login bundle both inject the base sheet, and only the first
 * one to open a dialog actually adds it.
 *
 * @param {string} id
 * @param {string} css
 */
export function injectStyles(id, css) {
  if (document.getElementById(id)) return;
  document.head.append(el("style", { id, text: css }));
}

/**
 * Mount a modal, an iOS sheet (js/ios-sheet.js), and return handles to its
 * body plus a closer.
 *
 * Escape, the backdrop, the X and a drag down on the bar all dismiss, and
 * focus is restored to whatever opened it: a dialog that traps you or loses
 * your place is worse than no dialog. `setLead` puts a Back button (or
 * anything) at the bar's leading end for a step, and takes it away with null.
 *
 * @param {string} title
 * @param {() => void} [onClose]
 */
export function dialog(title, onClose) {
  iosStyles();
  injectStyles("swx-css", CSS);

  const opener = document.activeElement;
  let closed = false;
  const release = hold();
  const close = () => {
    if (closed) return;
    closed = true;
    document.removeEventListener("keydown", onKey);
    leave(root, panel).then(() => {
      root.remove();
      release();
      if (opener instanceof HTMLElement) opener.focus({ preventScroll: true });
    });
    onClose?.();
  };
  const onKey = (e) => {
    if (e.key === "Escape") close();
  };

  const panel = el("div", { class: "swx-d", role: "document" });
  const parts = frame(panel, { title, onDismiss: close });

  const root = el(
    "div",
    { class: "swx ios-ov", role: "dialog", "aria-modal": "true", "aria-label": title },
    el("div", { class: "swx-bd ios-bg", onclick: close }),
    panel,
  );

  /** Retitle in place: the dialog's screens are steps, not separate dialogs. */
  const setTitle = (next) => {
    parts.setTitle(next);
    root.setAttribute("aria-label", next);
  };

  document.addEventListener("keydown", onKey);
  document.body.append(root);
  return { body: parts.body, close, panel, setTitle, setLead: parts.setLead };
}
