/**
 * Dialog shell and styles for the buy flow.
 *
 * Styles live in this bundle rather than app.css so a visitor who never buys
 * downloads none of them. Every colour reads from the shell's existing custom
 * properties, so light and dark come for free.
 */
import { el } from "../js/dom.js";

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

.swx-pane{background:var(--bg);border:1px solid var(--b);border-radius:12px;
 padding:10px 12px}
.swx-lbl{display:flex;justify-content:space-between;align-items:center;
 font-size:12px;color:var(--f);margin-bottom:6px}
.swx-bal{background:none;border:0;color:var(--f);font-size:12px;cursor:pointer;
 padding:0;font-family:var(--ff)}
.swx-bal:hover{color:var(--a)}
.swx-body{display:flex;align-items:center;gap:10px}
.swx-amt{flex:1;min-width:0;border:0;background:none;outline:none;text-align:right;
 font:500 22px/1.2 var(--ff);color:var(--t);font-variant-numeric:tabular-nums}
.swx-amt::placeholder{color:var(--b)}
.swx-recv{flex:1;text-align:right;font:500 22px/1.2 var(--t);color:var(--t);
 font-family:var(--ff);font-variant-numeric:tabular-nums;
 overflow:hidden;text-overflow:ellipsis}
.swx-recv.dim{color:var(--f)}

.swx-seg{display:flex;gap:4px;background:var(--ch);border-radius:999px;padding:3px}
.swx-seg button{border:0;background:none;border-radius:999px;padding:5px 12px;
 font:600 13px/1.2 var(--ff);color:var(--f);cursor:pointer}
.swx-seg button.on{background:var(--pn);color:var(--t);
 box-shadow:0 1px 2px rgba(0,0,0,.14)}
.swx-lock{display:inline-flex;align-items:center;gap:6px;padding:5px 12px;
 border-radius:999px;background:var(--ch);font:600 13px/1.2 var(--ff);color:var(--t)}

.swx-arrow{display:flex;justify-content:center;margin:-7px 0;position:relative;
 z-index:1}
.swx-flip{width:28px;height:28px;border-radius:50%;background:var(--pn);
 border:1px solid var(--b);color:var(--f);font-size:12px;display:flex;
 align-items:center;justify-content:center;cursor:pointer;padding:0;
 transition:transform .18s,border-color .18s,color .18s}
.swx-flip:hover{border-color:var(--a);color:var(--a)}
.swx-flip.up{transform:rotate(180deg)}

/*
 * Direction is carried by colour as well as by the label: green to acquire,
 * an orange-red to exit. Both hold >4.5:1 against white in either theme, so
 * the fill can stay fixed rather than flipping with the palette.
 */
.swx-go{width:100%;margin-top:12px;border:0;border-radius:999px;padding:12px;
 background:#167c3c;color:#fff;font:600 15px/1.2 var(--ff);cursor:pointer;
 transition:background .18s}
.swx-go.sell{background:#c2410c}
.swx-go:hover:not(:disabled){filter:brightness(1.1)}
.swx-go:disabled{opacity:.55;cursor:not-allowed}
.swx-go.busy{cursor:progress}
.swx-note{margin-top:9px;font-size:12px;color:var(--f);min-height:16px;
 text-align:center}
.swx-note.err{color:var(--dn)}
.swx-note.ok{color:var(--go)}
.swx-note a{color:var(--a);text-decoration:underline}

.swx-w{display:flex;flex-direction:column;gap:8px}
.swx-w button{display:flex;align-items:center;gap:10px;width:100%;padding:10px 12px;
 border:1px solid var(--b);border-radius:12px;background:var(--bg);cursor:pointer;
 font:600 14px/1.2 var(--ff);color:var(--t)}
.swx-w button:hover{border-color:var(--a)}
.swx-w img{width:22px;height:22px;border-radius:6px}
.swx-acct{font-size:12px;color:var(--f);font-variant-numeric:tabular-nums}
@media (max-width:520px){.swx{align-items:flex-end;padding:0}
 .swx-d{max-width:none;border-radius:16px 16px 0 0;border-bottom:0}}
`;

export function injectStyles() {
  if (document.getElementById("swx-css")) return;
  document.head.append(el("style", { id: "swx-css", text: CSS }));
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
  injectStyles();

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

  const panel = el(
    "div",
    { class: "swx-d", role: "document" },
    el("div", { class: "swx-h" }, el("div", { class: "swx-t", text: title }), closeBtn),
    body,
  );

  const root = el(
    "div",
    { class: "swx", role: "dialog", "aria-modal": "true", "aria-label": title },
    el("div", { class: "swx-bd", onclick: close }),
    panel,
  );

  document.addEventListener("keydown", onKey);
  document.body.append(root);
  return { body, close, panel };
}
