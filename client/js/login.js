/**
 * The passkey step: the dialog that holds an account with no passkey until it
 * adds one, which every account must have before it can do anything
 * (src/social/guard.ts). Logging in and creating an account are pages,
 * /login and /register (client/auth); this is for an account that is already
 * signed in, from before passkeys were required or after a recovery took its
 * one, wherever it turns up.
 *
 * Every page fetches it as login.js when it finds itself signed in to such an
 * account. It builds its own markup and injects its own styles, so it looks
 * the same whichever page opened it: every colour comes from the page's
 * custom properties.
 */
import { logOut } from "./acct.js";
import { busy } from "./busy.js";
import { el } from "./dom.js";
import { NO_PASSKEY, canPasskey, enrol, register, why } from "./passkey.js";
import { send } from "./signin.js";
import { sheetDialog } from "./sheet.js";
import { injectStyles } from "./ui.js";

/* The rest is the iOS sheet's own (js/ios-sheet.css): the frame, the grouped
   field, the buttons. */
const CSS = `
.lgd-h{margin:0;font-size:15px;line-height:20px;color:var(--m)}
.lgd .ios-gp{margin-top:16px}
.lgd-e{margin:8px 16px 0;font-size:13px;color:var(--dn)}
.lgd-e:empty{display:none}
.lgd .ios-btn.lgd-t{color:var(--dn)}
`;

/** The passkey step's dialog, built the first time it is needed. */
let setup = null;
/** Who it is for, the challenge it may use, and what to do once it is done. */
let setupFor = { name: "", opt: null, done: () => {} };

function buildSetup() {
  injectStyles("lgd-css", CSS);
  const pass = el("input", {
    id: "lgd-sp",
    type: "password",
    autocomplete: "current-password",
    required: true,
    minlength: "8",
    maxlength: "128",
  });
  const passRow = el("div", { class: "ios-gp" }, el("div", { class: "ios-fr" }, el("label", { for: "lgd-sp", text: "Password" }), pass));
  const err = el("p", { class: "lgd-e", role: "alert" });
  const go = el("button", { type: "submit", class: "ios-btn", text: "Create passkey" });
  /** In place of the password and the button, on a browser that cannot make one. */
  const unable = el("p", { class: "lgd-e", role: "alert", text: NO_PASSKEY });
  const form = el(
    "form",
    {},
    el("p", {
      class: "lgd-h",
      text: "Every account has one. It signs you in, confirms every trade and send, and shows your recovery phrase. It stays on this device, opened by your face, fingerprint or screen lock.",
    }),
    passRow,
    unable,
    err,
    go,
  );
  const out = el("button", { type: "button", class: "ios-btn ios-2 lgd-t", text: "Log Out" });
  const d = /** @type {HTMLDialogElement} */ (
    el("dialog", { class: "lgd", "aria-labelledby": "lgd-st" }, el("h2", { id: "lgd-st", text: "Add a passkey" }), form, out)
  );
  // No X, no drag, no outside tap, no Escape: a passkey or Log out are the ways on.
  sheetDialog(d, { close: false });

  /**
   * With the challenge from signing in, the passkey is all; without, or once
   * it is spent, the password comes first. A browser that cannot make a
   * passkey gets neither, only the reason and Log out.
   */
  const paint = () => {
    const able = canPasskey();
    unable.hidden = able;
    go.hidden = !able;
    passRow.hidden = pass.disabled = !able || !!setupFor.opt;
    err.textContent = "";
    return able;
  };
  form.addEventListener("submit", async (e) => {
    e.preventDefault();
    err.textContent = "";
    try {
      await busy(go, () => (setupFor.opt ? enrol(setupFor.name, setupFor.opt, send) : register(setupFor.name, pass.value, send)));
      pass.value = "";
      d.close();
      setupFor.done();
    } catch (cause) {
      // A prompt closed leaves the challenge unused; anything the server
      // refused may have spent it, so the password asks for a fresh one.
      if (cause.name !== "NotAllowedError" && setupFor.opt) {
        setupFor.opt = null;
        paint();
      }
      err.textContent = why(cause);
    }
  });
  // Still signed in should it fail, and still held here; the reload says which.
  out.addEventListener("click", () =>
    busy(out, logOut)
      .catch(() => {})
      .then(() => location.reload()),
  );
  document.body.append(d);
  return { dialog: d, paint, pass };
}

/**
 * Ask for the passkey an account must have. `opt` is the challenge sign-up,
 * login or recovery just answered with, so only the passkey is asked for;
 * without one, as for a session from before passkeys were required, the
 * password comes first. Opened once however many callers ask.
 *
 * @param {string} name
 * @param {{challenge: string, uid: string} | null} [opt]
 * @param {() => void} [onDone] called once the passkey is on the account
 */
export function setupPasskey(name, opt = null, onDone = () => {}) {
  if (setup?.dialog.open) return;
  setup ??= buildSetup();
  setupFor = { name, opt, done: onDone };
  const able = setup.paint();
  setup.dialog.showModal();
  if (able && !opt) setup.pass.focus();
}
