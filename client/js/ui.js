/**
 * The modal, and the wallet chooser that is the only thing some of them hold.
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

/**
 * The dialog shell, the chooser, and the note line under it — everything
 * shared by every dialog this app opens. The trade form's own controls are a
 * separate sheet in swap/ui.js, so the login bundle does not carry the styling
 * for an amount field it will never render.
 */
const CSS = `
.swx{position:fixed;inset:0;z-index:60;display:flex;align-items:center;
 justify-content:center;padding:16px}
.swx-bd{position:absolute;inset:0;background:rgba(0,0,0,.55);
 backdrop-filter:blur(2px);animation:swx-in .15s both}
.swx-d{position:relative;width:100%;max-width:400px;background:var(--pn);
 border:1px solid var(--b);border-radius:16px;padding:16px;
 box-shadow:0 16px 48px rgba(0,0,0,.35);animation:swx-up .18s both}
@keyframes swx-in{from{opacity:0}}
@keyframes swx-up{from{opacity:0;transform:translateY(8px)}}
.swx-h{display:flex;align-items:center;justify-content:space-between;
 margin-bottom:14px}
.swx-t{font-size:15px;font-weight:600;color:var(--t)}
.swx-x{border:0;background:none;color:var(--f);font-size:20px;line-height:1;
 cursor:pointer;padding:2px 6px;border-radius:6px}
.swx-x:hover{background:var(--hover);color:var(--t)}
.swx-lbl{display:flex;justify-content:space-between;align-items:center;
 font-size:12px;color:var(--f);margin-bottom:6px}

.swx-note{margin-top:9px;font-size:12px;color:var(--f);min-height:16px;
 text-align:center}
.swx-note.err{color:var(--dn)}
.swx-note.ok{color:var(--go)}
.swx-note a{color:var(--a);text-decoration:underline}

.swx-w{display:flex;flex-direction:column;gap:8px}
.swx-w button{display:flex;align-items:center;gap:10px;width:100%;padding:10px 12px;
 border:1px solid var(--b);border-radius:12px;background:var(--bg);cursor:pointer;
 font:600 14px/1.2 var(--ff);color:var(--t)}
.swx-w button:hover:not(:disabled){border-color:var(--a)}
.swx-w button:disabled{opacity:.6;cursor:progress}
.swx-w img{width:22px;height:22px;border-radius:6px}
@media (max-width:520px){.swx{align-items:flex-end;padding:0}
 .swx-d{max-width:none;border-radius:16px 16px 0 0;border-bottom:0}}
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
 * Mount a modal and return handles to its body plus a closer.
 *
 * Escape and backdrop both dismiss, and focus is restored to whatever opened
 * it — a dialog that traps you or loses your place is worse than no dialog.
 *
 * @param {string} title
 * @param {() => void} [onClose]
 */
export function dialog(title, onClose) {
  injectStyles("swx-css", CSS);

  const opener = document.activeElement;
  const body = el("div");
  const close = () => {
    document.removeEventListener("keydown", onKey);
    root.remove();
    if (opener instanceof HTMLElement) opener.focus();
    onClose?.();
  };
  const onKey = (e) => {
    if (e.key === "Escape") close();
  };

  const closeBtn = el("button", {
    class: "swx-x",
    type: "button",
    "aria-label": "Close",
    text: "×",
    onclick: close,
  });

  const heading = el("div", { class: "swx-t", text: title });

  const panel = el(
    "div",
    { class: "swx-d", role: "document" },
    el("div", { class: "swx-h" }, heading, closeBtn),
    body,
  );

  const root = el(
    "div",
    { class: "swx", role: "dialog", "aria-modal": "true", "aria-label": title },
    el("div", { class: "swx-bd", onclick: close }),
    panel,
  );

  /** Retitle in place — the dialog's screens are steps, not separate dialogs. */
  const setTitle = (next) => {
    heading.textContent = next;
    root.setAttribute("aria-label", next);
  };

  document.addEventListener("keydown", onKey);
  document.body.append(root);
  return { body, close, panel, setTitle };
}
