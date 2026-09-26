/**
 * The Log in dialog: log in, create an account, or recover one.
 *
 * One implementation for every page. Social bundles it; search and the wallet
 * page fetch it as login.js the first time someone presses Log in. It builds
 * its own markup and injects its own styles, so it looks the same whichever
 * page opened it — every colour comes from the page's custom properties.
 */
import { LOGIN } from "./acct.js";
import { el } from "./dom.js";
import { writeName } from "./me.js";
import { b64u, needPasskey, u8, why } from "./passkey.js";
import { dismissible } from "./sheet.js";
import { injectStyles } from "./ui.js";

const CSS = `
.lgd{width:min(360px,calc(100% - 32px));padding:18px;border:1px solid var(--b);
 border-radius:12px;background:var(--pn);color:var(--t);font:14px/1.5 var(--ff)}
.lgd::backdrop{background:rgb(0 0 0/40%)}
.lgd h2{margin:0;font-size:18px}
.lgd label{display:block;margin-top:14px;font-size:13px;color:var(--m)}
.lgd input,.lgd textarea{box-sizing:border-box;width:100%;margin-top:4px;padding:8px 10px;
 border:1px solid var(--b);border-radius:8px;background:var(--bg);font:inherit;color:inherit;outline:0}
.lgd input:focus,.lgd textarea:focus{box-shadow:0 1px 6px rgba(0,0,0,.18)}
.lgd textarea{resize:none}
.lgd-h{margin:4px 0 0;font-size:12px;line-height:1.4;color:var(--f)}
.lgd-e{margin:8px 0 0;color:var(--dn)}
.lgd-e:empty{display:none}
.lgd-go{display:block;width:100%;margin-top:12px;border:0;border-radius:999px;background:var(--buy);
 color:var(--buy-ink);font:600 13px/1 var(--ff);padding:7px 12px;cursor:pointer}
.lgd-go:hover:not(:disabled){filter:brightness(1.08)}
.lgd-t{background:none;color:var(--go);border:0;padding:8px 0;font:600 13px/1 var(--ff);cursor:pointer}
.lgd-t:hover{color:var(--buy)}
.lgd button:disabled{opacity:.55;cursor:default}
.lgd-or{margin:16px 0 0;text-align:center;font-size:13px;color:var(--f)}
.lgd-f{display:flex;justify-content:space-between;align-items:center;margin-top:8px}
`;

/** "login", "register" or "recover". */
let mode = "login";
/** @type {HTMLDialogElement | null} */
let dialog = null;
/** Called once someone is signed in. */
let done = () => {};
/** @type {Record<string, any>} */
let $ = {};

async function send(path, body) {
  const res = await fetch(path, {
    method: "POST",
    headers: { "Content-Type": "application/json", Accept: "application/json" },
    body: JSON.stringify(body || {}),
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.error || "Something went wrong.");
  if (data.name) writeName(data.name);
  return data;
}

/** A node shown only in the listed modes. */
function only(modes, node) {
  node.dataset.m = modes;
  return node;
}

/** One line of copy per mode, only one of which is visible at a time. */
function per(tag, props, texts) {
  return Object.entries(texts).map(([m, text]) => only(m, el(tag, { ...props, text })));
}

/**
 * Sign in with a passkey. With a username the password came first and `opt.id`
 * names the one key that may answer; without, the authenticator names the
 * account itself.
 */
async function passkey(opt, username) {
  needPasskey();
  const cred = await navigator.credentials.get({
    publicKey: {
      challenge: u8(opt.challenge),
      rpId: location.hostname,
      allowCredentials: opt.id ? [{ type: "public-key", id: u8(opt.id) }] : undefined,
      userVerification: "required",
      timeout: 60_000,
    },
  });
  if (!cred) throw new Error("Passkey was cancelled.");
  const response = /** @type {AuthenticatorAssertionResponse} */ (cred.response);
  await send("/api/social/login/passkey", {
    ...(username ? { username } : { id: cred.id }),
    challenge: opt.challenge,
    clientData: b64u(response.clientDataJSON),
    authenticatorData: b64u(response.authenticatorData),
    signature: b64u(response.signature),
  });
}

/** Every way into an account ends the same: the dialog shuts and the page is told. */
async function signIn(button, task) {
  $.err.textContent = "";
  button.disabled = true;
  try {
    await task();
    $.pass.value = $.phrase.value = "";
    dialog?.close();
    done();
  } catch (cause) {
    $.err.textContent = why(cause);
  } finally {
    button.disabled = false;
  }
}

function build() {
  injectStyles("lgd-css", CSS);
  const hint = (m, text) => only(m, el("p", { class: "lgd-h", text }));
  $.user = el("input", {
    id: "lgd-u",
    name: "username",
    required: true,
    maxlength: "16",
    autocomplete: "username",
    autocapitalize: "off",
    spellcheck: "false",
  });
  $.phrase = el("textarea", {
    id: "lgd-r",
    rows: "3",
    required: true,
    autocomplete: "off",
    autocapitalize: "off",
    spellcheck: "false",
  });
  $.pass = el("input", {
    id: "lgd-p",
    name: "password",
    type: "password",
    required: true,
    minlength: "8",
    maxlength: "128",
  });
  $.err = el("p", { class: "lgd-e", role: "alert" });
  $.go = el(
    "button",
    { type: "submit", class: "lgd-go" },
    ...per("span", {}, { login: LOGIN, register: "Create account", recover: "Recover account" }),
  );
  $.key = el("button", {
    type: "button",
    class: "lgd-go",
    text: "Use a passkey",
    onclick: () => signIn($.key, async () => passkey(await send("/api/social/passkey/login"))),
  });

  const form = el(
    "form",
    {},
    el("h2", { id: "lgd-t" }, ...per("span", {}, { login: LOGIN, register: "Create account", recover: "Recover account" })),
    hint("login", "Use the username and password for your account."),
    hint("register", "Pick a username. It cannot be changed later."),
    hint(
      "recover",
      "Enter the 12-word recovery phrase from your profile and a new password. This removes any passkey and signs out your other devices.",
    ),
    only(
      "login register",
      el(
        "div",
        {},
        el("label", { for: "lgd-u", text: "Username" }),
        $.user,
        hint("register", "3–16 letters, numbers, or _."),
      ),
    ),
    only("recover", el("div", {}, el("label", { for: "lgd-r", text: "Recovery phrase" }), $.phrase)),
    el("label", { for: "lgd-p" }, ...per("span", {}, { "login register": "Password", recover: "New password" })),
    $.pass,
    hint("register recover", "At least 8 characters."),
    only("login", el("button", { type: "button", class: "lgd-t", text: "Forgot password?", onclick: () => open("recover") })),
    $.err,
    $.go,
  );
  form.addEventListener("submit", (e) => {
    e.preventDefault();
    signIn($.go, async () => {
      if (mode === "recover") return send("/api/social/recover", { phrase: $.phrase.value, password: $.pass.value });
      const data = await send(mode === "register" ? "/api/social/register" : "/api/social/login", {
        username: $.user.value,
        password: $.pass.value,
      });
      if (data.passkey) await passkey(data.passkey, $.user.value.trim().toLowerCase());
    });
  });

  const d = /** @type {HTMLDialogElement} */ (
    el(
      "dialog",
      { class: "lgd", "aria-labelledby": "lgd-t" },
      form,
      only("login", el("div", {}, el("p", { class: "lgd-or", text: "or" }), $.key)),
      el(
        "div",
        { class: "lgd-f" },
        el(
          "button",
          { type: "button", class: "lgd-t", onclick: () => open(mode === "login" ? "register" : "login") },
          ...per("span", {}, { login: "Create account", register: "I have an account", recover: "Back to log in" }),
        ),
      ),
    )
  );
  dismissible(d);
  document.body.append(d);
  return d;
}

/**
 * Open the dialog, or switch the open one to another mode.
 *
 * @param {"login" | "register" | "recover"} [next]
 * @param {() => void} [onDone] called once signed in; the header already knows by then
 */
export function open(next = "login", onDone) {
  if (!dialog) dialog = build();
  if (onDone) done = onDone;
  mode = next;
  for (const node of dialog.querySelectorAll("[data-m]")) {
    /** @type {HTMLElement} */ (node).hidden = !(/** @type {HTMLElement} */ (node).dataset.m.split(" ").includes(mode));
  }
  // Disabled as well as hidden: a hidden required field would still block the form.
  $.user.disabled = mode === "recover";
  $.phrase.disabled = mode !== "recover";
  $.pass.autocomplete = mode === "login" ? "current-password" : "new-password";
  $.err.textContent = "";
  if (!dialog.open) dialog.showModal();
  (mode === "recover" ? $.phrase : $.user).focus();
}
