/**
 * The account picker: every account this browser is signed in to, a tap to
 * switch, Add Account, and Log Out. An iOS sheet, as iOS apps draw it: a
 * grouped background, inset rounded sections, avatar rows with hairlines that
 * start at the text, a checkmark on the account in use, the system blue and
 * red, Edit and Done to take an account off this device.
 *
 * The server holds the list (src/social/auth.ts readHeld), signed and
 * httpOnly, so this only asks for names and pictures and says which to use.
 * Part of the login bundle, which every page already fetches lazily.
 */
import { logOut } from "./acct.js";
import { busy } from "./busy.js";
import { el } from "./dom.js";
import { readName } from "./me.js";
import { dismissible } from "./sheet.js";
import { send } from "./signin.js";
import { injectStyles } from "./ui.js";

/* iOS's own colours, not the page's: the sheet is the system's, over any page.
   Light: systemGroupedBackground and its cells; dark: the elevated pair a
   sheet sits in. */
const CSS = `
.acs{--acs-bg:#f2f2f7;--acs-cell:#fff;--acs-press:#d1d1d6;--acs-hair:rgba(60,60,67,.29);--acs-ink:#000;--acs-sub:rgba(60,60,67,.6);
 --acs-fill:rgba(118,118,128,.12);--acs-tint:#007aff;--acs-red:#ff3b30;
 color:var(--acs-ink);font:400 17px/22px -apple-system,"SF Pro Text",system-ui,sans-serif;letter-spacing:-.43px;
 -webkit-font-smoothing:antialiased}
.acs.ios-sh{background:var(--acs-bg)}
@media (prefers-color-scheme:dark){.acs{--acs-bg:#1c1c1e;--acs-cell:#2c2c2e;--acs-press:#3a3a3c;--acs-hair:rgba(84,84,88,.65);
 --acs-ink:#fff;--acs-sub:rgba(235,235,245,.6);--acs-fill:rgba(118,118,128,.24);--acs-tint:#0a84ff;--acs-red:#ff453a}}
.acs .ios-tt{color:var(--acs-ink)}
.acs .ios-x{background:var(--acs-fill);color:var(--acs-sub)}
.acs-ed{min-height:44px;padding:0;border:0;background:none;color:var(--acs-tint);font:inherit;cursor:pointer}
.acs-ed[aria-pressed=true]{font-weight:600}
.acs-gp{margin:0;border-radius:22px;background:var(--acs-cell);overflow:hidden}
.acs-gp+.acs-gp{margin-top:20px}
.acs-r{position:relative;display:flex;align-items:center;gap:12px;box-sizing:border-box;width:100%;min-height:60px;
 margin:0;padding:8px 16px;border:0;background:none;color:inherit;font:inherit;letter-spacing:inherit;text-align:left;
 cursor:pointer;-webkit-tap-highlight-color:transparent;transition:background-color .2s}
.acs-r:active:not(:disabled){background:var(--acs-press);transition:none}
.acs-r:disabled{cursor:default}
.acs-r+.acs-r::before,.acs-w+.acs-w::before{content:"";position:absolute;top:0;right:0;left:68px;height:1px;
 background:var(--acs-hair);transform:scaleY(.5);transform-origin:top;transition:left .25s var(--out,ease)}
.acs[data-edit] .acs-w:has(.acs-mn)::before{left:106px}
.acs-w{position:relative;display:grid;grid-template-rows:1fr;transition:grid-template-rows .3s var(--out,ease),opacity .2s}
.acs-w>div{display:flex;align-items:center;min-height:0;overflow:hidden}
.acs-w[data-gone]{grid-template-rows:0fr;opacity:0}
.acs-w .acs-r{flex:1;min-width:0}
.acs-av{flex:none;display:grid;place-items:center;width:40px;height:40px;border-radius:50%;object-fit:cover;
 background:linear-gradient(#a5abb8,#858994);color:#fff;font:600 16px/1 -apple-system,system-ui,sans-serif;letter-spacing:0}
.acs-av.acs-add{background:var(--acs-fill);color:var(--acs-tint)}
.acs-tx{flex:1;min-width:0}
.acs-tx b,.acs-tx small{display:block;overflow:hidden;white-space:nowrap;text-overflow:ellipsis}
.acs-tx b{font-weight:400}
.acs-tx small{font-size:15px;line-height:20px;letter-spacing:-.23px;color:var(--acs-sub)}
.acs-ok{flex:none;color:var(--acs-tint)}
.acs-r[data-busy] .acs-ok{display:none}
.acs-sp{flex:none;width:18px;height:18px;border:2px solid var(--acs-hair);border-top-color:var(--acs-sub);border-radius:50%;
 animation:acs-spin .8s linear infinite}
@keyframes acs-spin{to{transform:rotate(1turn)}}
.acs-mn{flex:none;display:grid;place-items:center;width:0;height:22px;margin-left:0;padding:0;border:0;border-radius:50%;
 background:var(--acs-red);color:#fff;overflow:hidden;cursor:pointer;transition:width .25s var(--out,ease),margin .25s var(--out,ease),transform .25s}
.acs[data-edit] .acs-mn{width:22px;margin-left:16px}
.acs-mn[aria-expanded=true]{transform:rotate(-90deg)}
.acs-rm{flex:none;align-self:stretch;width:0;padding:0;border:0;background:var(--acs-red);color:#fff;font:inherit;
 letter-spacing:inherit;overflow:hidden;cursor:pointer;transition:width .25s var(--out,ease)}
.acs-rm[data-on]{width:92px}
.acs-add-t{color:var(--acs-tint)}
.acs-out{justify-content:center;min-height:50px;color:var(--acs-red)}
.acs-ft{margin:8px 16px 20px;font-size:13px;line-height:18px;letter-spacing:-.08px;color:var(--acs-sub)}
.acs-ft:empty{display:none}
.acs-ft:empty+.acs-gp{margin-top:20px}
`;

const CHECK =
  '<svg width="18" height="18" viewBox="0 0 24 24" aria-hidden="true"><path d="M4.5 12.8l4.8 4.7L19.5 6.5" fill="none" stroke="currentColor" stroke-width="2.6" stroke-linecap="round" stroke-linejoin="round"/></svg>';
const PLUS =
  '<svg width="18" height="18" viewBox="0 0 24 24" aria-hidden="true"><path d="M12 5v14M5 12h14" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round"/></svg>';
const MINUS =
  '<svg width="12" height="12" viewBox="0 0 12 12" aria-hidden="true"><path d="M2 6h8" stroke="currentColor" stroke-width="2.2" stroke-linecap="round"/></svg>';

/**
 * @typedef {{name: string, avatarRev: number, active: boolean}} Account
 * @typedef {{
 *   onSwitch?: (name: string) => void,
 *   onLoggedOut?: () => void,
 *   addAccount?: () => void,
 * }} Opts
 *   `onSwitch` once another account is the active one (also after Log Out,
 *   when another account takes over); `onLoggedOut` once nobody is;
 *   `addAccount` goes to the login page (client/auth), which comes back to
 *   the page signed in to the new account.
 */

/** @type {HTMLDialogElement | null} */
let dialog = null;
/** @type {Record<string, any>} */
let $ = {};
/** @type {Opts} */
let opts = {};
/** @type {Account[]} */
let list = [];
let max = 6;
/** Bumped per open, so a slow answer for an earlier open is not painted. */
let gen = 0;

/** The picture, or iOS's monogram: initials on the grey-blue disc Contacts draws. */
function avatar(a) {
  if (a.avatarRev) {
    return el("img", {
      class: "acs-av",
      src: `/social/t/${a.name}?v=${a.avatarRev}`,
      alt: "",
      width: "40",
      height: "40",
      decoding: "async",
    });
  }
  return el("span", { class: "acs-av", "aria-hidden": "true", text: a.name.replace(/_/g, "").slice(0, 2).toUpperCase() });
}

function icon(svg, cls) {
  const s = el("span", { class: cls, "aria-hidden": "true" });
  s.innerHTML = svg;
  return s;
}

function build() {
  injectStyles("acs-css", CSS);
  $.edit = el("button", { type: "button", class: "acs-ed", text: "Edit", "aria-pressed": "false", hidden: true });
  $.list = el("div", { class: "acs-gp", role: "list" });
  $.add = el(
    "button",
    { type: "button", class: "acs-r" },
    icon(PLUS, "acs-av acs-add"),
    el("span", { class: "acs-tx" }, el("b", { class: "acs-add-t", text: "Add Account" })),
  );
  $.out = el("button", { type: "button", class: "acs-r acs-out" });
  $.foot = el("p", { class: "acs-ft", role: "status" });
  const d = /** @type {HTMLDialogElement} */ (
    el(
      "dialog",
      { class: "acs", "aria-labelledby": "acs-t" },
      el("h2", { id: "acs-t", text: "Accounts" }),
      $.list,
      el("div", { class: "acs-gp" }, $.add),
      $.foot,
      el("div", { class: "acs-gp" }, $.out),
    )
  );
  dismissible(d, { lead: $.edit });
  d.addEventListener("close", () => editing(false));

  $.edit.addEventListener("click", () => editing(!d.hasAttribute("data-edit")));
  $.add.addEventListener("click", () => {
    if (!opts.addAccount) return;
    d.close();
    opts.addAccount();
  });
  $.out.addEventListener("click", async () => {
    // A second press while the first is out: busy() would answer undefined, which reads as nobody left.
    if ($.out.hasAttribute("aria-busy")) return;
    let next = null;
    try {
      next = await busy($.out, logOut);
    } catch (cause) {
      $.foot.textContent = cause.message;
      return;
    }
    d.close();
    if (next) opts.onSwitch?.(next);
    else opts.onLoggedOut?.();
  });
  document.body.append(d);
  return d;
}

function editing(on) {
  if (!dialog) return;
  dialog.toggleAttribute("data-edit", on);
  $.edit.textContent = on ? "Done" : "Edit";
  $.edit.setAttribute("aria-pressed", String(on));
  for (const b of dialog.querySelectorAll(".acs-mn")) {
    b.setAttribute("aria-expanded", "false");
    /** @type {HTMLButtonElement} */ (b).tabIndex = on ? 0 : -1;
  }
  for (const b of dialog.querySelectorAll(".acs-rm")) b.removeAttribute("data-on");
}

async function switchTo(a, row) {
  if (a.active) return dialog?.close();
  for (const r of $.list.querySelectorAll(".acs-r")) /** @type {HTMLButtonElement} */ (r).disabled = true;
  row.dataset.busy = "";
  row.append(el("span", { class: "acs-sp", "aria-label": "Switching" }));
  $.foot.textContent = "";
  try {
    const data = await send("/api/social/switch", { name: a.name });
    opts.onSwitch?.(data.name);
  } catch (cause) {
    $.foot.textContent = cause.message;
    await load(gen);
  }
}

async function forget(a, wrap) {
  wrap.dataset.gone = "";
  try {
    await send("/api/social/accounts/forget", { name: a.name });
  } catch (cause) {
    delete wrap.dataset.gone;
    $.foot.textContent = cause.message;
    return;
  }
  list = list.filter((x) => x.name !== a.name);
  setTimeout(() => {
    wrap.remove();
    paintChrome();
  }, 300);
}

/** One account's row: Edit gives the ones not in use a minus, and the minus a Remove. */
function row(a) {
  const r = el(
    "button",
    { type: "button", class: "acs-r", role: "listitem", "aria-current": a.active ? "true" : undefined },
    avatar(a),
    el(
      "span",
      { class: "acs-tx" },
      el("b", { text: a.name }),
      el("small", { text: a.active ? "Using now" : "Signed in" }),
    ),
    a.active ? icon(CHECK, "acs-ok") : null,
  );
  r.addEventListener("click", () => {
    if (dialog?.hasAttribute("data-edit")) return;
    switchTo(a, r);
  });
  if (a.active) return el("div", { class: "acs-w" }, el("div", {}, r));
  const minus = el("button", {
    type: "button",
    class: "acs-mn",
    "aria-label": `Remove ${a.name} from this device`,
    "aria-expanded": "false",
    tabindex: "-1",
  });
  minus.innerHTML = MINUS;
  const remove = el("button", { type: "button", class: "acs-rm", text: "Remove", tabindex: "-1" });
  const wrap = el("div", { class: "acs-w" }, el("div", {}, minus, r, remove));
  minus.addEventListener("click", () => {
    const on = !remove.hasAttribute("data-on");
    remove.toggleAttribute("data-on", on);
    remove.tabIndex = on ? 0 : -1;
    minus.setAttribute("aria-expanded", String(on));
    if (on) remove.focus();
  });
  remove.addEventListener("click", () => forget(a, wrap));
  return wrap;
}

/** What depends on the list as a whole: Edit, the Log Out line, the cap, the footnote. */
function paintChrome() {
  const me = list.find((a) => a.active);
  const others = list.filter((a) => !a.active).length;
  $.edit.hidden = others === 0;
  if (!others) editing(false);
  $.out.textContent = me ? `Log Out ${me.name}` : "Log Out";
  $.out.disabled = !me;
  const full = list.length >= max;
  $.add.disabled = full;
  $.add.style.opacity = full ? ".4" : "";
  $.foot.textContent = full
    ? `You can keep up to ${max} accounts on this device. Remove one to add another.`
    : others
      ? "Switch without logging in again. Trades and sends still ask for that account's passkey."
      : "";
}

async function load(g) {
  try {
    const res = await fetch("/api/social/accounts", { headers: { Accept: "application/json" }, cache: "no-store" });
    if (!res.ok) throw new Error();
    const data = await res.json();
    if (g !== gen) return;
    list = data.accounts || [];
    max = data.max || max;
  } catch {
    if (g !== gen) return;
    $.foot.textContent = navigator.onLine === false ? "You're offline." : "Could not load your accounts.";
    return;
  }
  $.list.replaceChildren(...list.map(row));
  $.list.hidden = !list.length;
  paintChrome();
}

/**
 * Open the picker.
 *
 * @param {Opts} [o]
 */
export function openAccounts(o = {}) {
  opts = o;
  dialog ??= build();
  const g = ++gen;
  $.foot.textContent = "";
  $.out.disabled = false;
  // The remembered name paints the first row at once; the server's answer
  // fills in the rest a moment later, at the same row height.
  const name = readName();
  list = name ? [{ name, avatarRev: 0, active: true }] : [];
  $.list.replaceChildren(
    ...list.map((a) => {
      const w = row(a);
      w.querySelector(".acs-av")?.replaceWith(el("span", { class: "acs-av", style: "background:var(--acs-fill)" }));
      return w;
    }),
  );
  $.list.hidden = !list.length;
  paintChrome();
  $.foot.textContent = "";
  if (!dialog.open) dialog.showModal();
  load(g);
}
