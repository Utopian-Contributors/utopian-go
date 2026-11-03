/**
 * The login page, /login and /register. Signed out, the home page's Wallet
 * and Social send you here (src/pages.ts homeNav), and once you are in, on to
 * the page you were going to: its ?next=.
 *
 * A new account is two steps on this page: the account, then its passkey.
 * Every account must have one before it can do anything (src/social/guard.ts),
 * so the second step has no way on but a passkey or Log out. A login or a
 * recovery that lands on an account without one takes the same step, and a
 * browser that cannot make a passkey is told so before it makes an account
 * it could not use.
 *
 * Every mode's markup ships in the document (client/auth.html), in the mode
 * the server rendered for the URL; this binds it, and moves between them.
 */
import { logOut } from "../js/acct.js";
import { noZoom } from "../js/device.js";
import { $ } from "../js/dom.js";
import { NO_PASSKEY, canPasskey, enrol, register, why } from "../js/passkey.js";
import { during } from "../js/progress.js";
import { passkeyLogIn, send, submit } from "../js/signin.js";

/** Each mode's title, the tab's as well as the heading's. */
const TITLES = { login: "Log in", register: "Create account", recover: "Recover account", key: "Add a passkey" };

/**
 * Where to go once signed in: ?next=, if it is a page on this site other than
 * this one; home if not. The rule nextPath in src/pages.ts goes by.
 */
function onwardPath() {
  const raw = new URLSearchParams(location.search).get("next") || "";
  if (raw.length > 512 || !/^\/(?!\/)[!-[\]-~]*$/.test(raw) || /^\/(login|register)(?:[/?#]|$)/.test(raw)) return "/";
  return raw;
}

const body = document.body;
const form = $("au-f");
const user = /** @type {HTMLInputElement} */ ($("au-u"));
const pass = /** @type {HTMLInputElement} */ ($("au-p"));
const again = /** @type {HTMLInputElement} */ ($("au-p2"));
const phrase = /** @type {HTMLTextAreaElement} */ ($("au-r"));
const terms = /** @type {HTMLInputElement} */ ($("au-a"));
const keyRow = $("au-kp");
const keyPass = /** @type {HTMLInputElement} */ ($("au-sp"));
const err = $("au-e");
const go = /** @type {HTMLButtonElement} */ ($("au-go"));
const key = /** @type {HTMLButtonElement} */ ($("au-k"));

/** The passkey step's account, and the challenge signing in handed it, until that is spent. */
let setup = { name: "", opt: null };
/** Pressed and not yet answered, or on the way to the next page: nothing more to press. */
let busy = false;

const mode = () => body.dataset.m;

/** The submit button is off while busy, and where a passkey is needed but cannot be made. */
function paintButtons() {
  const m = mode();
  go.disabled = key.disabled = busy || ((m === "register" || m === "key") && !canPasskey());
}

/** @param {"login" | "register" | "recover" | "key"} next */
function show(next) {
  body.dataset.m = next;
  document.title = TITLES[next];
  // Disabled as well as hidden: a hidden required field would still block the form.
  user.disabled = next !== "login" && next !== "register";
  phrase.disabled = next !== "recover";
  pass.disabled = next === "key";
  again.disabled = terms.disabled = next !== "register";
  pass.autocomplete = next === "login" ? "current-password" : "new-password";
  // The password only once the challenge is spent (see addPasskey).
  keyRow.hidden = keyPass.disabled = next !== "key" || !!setup.opt;
  for (const [id, on] of [["au-s1", next === "register"], ["au-s2", next === "key"]]) {
    if (on) $(id).setAttribute("aria-current", "step");
    else $(id).removeAttribute("aria-current");
  }
  err.textContent = (next === "register" || next === "key") && !canPasskey() ? NO_PASSKEY : "";
  paintButtons();
}

/** What the mode leads with, once someone has moved to it. */
function focusFirst() {
  const m = mode();
  if (m === "recover") phrase.focus();
  else if (m === "key") (keyRow.hidden ? go : keyPass).focus();
  else user.focus();
}

function onward() {
  busy = true;
  paintButtons();
  location.replace(onwardPath());
}

/**
 * Every way in ends the same: on to the next page, or first to the passkey an
 * account without one must add, with the challenge the server answered with.
 */
async function attempt(task) {
  err.textContent = "";
  busy = true;
  paintButtons();
  try {
    const data = await during(task());
    pass.value = again.value = phrase.value = "";
    if (!data?.passkeySetup) return onward();
    setup = { name: data.name, opt: data.passkeySetup };
    busy = false;
    show("key");
    focusFirst();
  } catch (cause) {
    busy = false;
    paintButtons();
    err.textContent = why(cause);
  }
}

async function addPasskey() {
  err.textContent = "";
  busy = true;
  paintButtons();
  try {
    if (setup.opt) await enrol(setup.name, setup.opt, send);
    else await register(setup.name, keyPass.value, send);
    keyPass.value = "";
    onward();
  } catch (cause) {
    busy = false;
    // A prompt closed leaves the challenge unused; anything the server
    // refused may have spent it, so the password asks for a fresh one.
    if (cause.name !== "NotAllowedError" && setup.opt) {
      setup.opt = null;
      show("key");
      keyPass.focus();
    }
    paintButtons();
    err.textContent = why(cause);
  }
}

form.addEventListener("submit", (e) => {
  e.preventDefault();
  if (busy) return;
  if (mode() === "key") return void addPasskey();
  const m = /** @type {"login" | "register" | "recover"} */ (mode());
  attempt(() =>
    submit(m, {
      username: user.value,
      password: pass.value,
      again: again.value,
      phrase: phrase.value,
      terms: terms.checked,
    }),
  );
});

key.addEventListener("click", () => {
  if (!busy) attempt(passkeyLogIn);
});

/**
 * Log in and Create account are each other's URL, so each is its own entry
 * in history; the page moves between them in place. A plain click only: one
 * meant for a new tab goes there.
 */
for (const link of /** @type {HTMLAnchorElement[]} */ ([$("au-tr"), $("au-tl")])) {
  link.addEventListener("click", (e) => {
    if (e.button || e.metaKey || e.ctrlKey || e.shiftKey || e.altKey) return;
    e.preventDefault();
    history.pushState(null, "", link.href);
    show(link.id === "au-tr" ? "register" : "login");
    focusFirst();
  });
}

// The passkey step stays put: signed in by then, the way back is Log out.
window.addEventListener("popstate", () => {
  if (mode() !== "key") show(location.pathname === "/register" ? "register" : "login");
});

$("au-fg").addEventListener("click", () => {
  show("recover");
  focusFirst();
});

$("au-bk").addEventListener("click", () => {
  show("login");
  focusFirst();
});

$("au-out").addEventListener("click", async (e) => {
  const out = /** @type {HTMLButtonElement} */ (e.currentTarget);
  out.disabled = true;
  try {
    await logOut();
  } catch {
    // Still signed in, which the reload finds and goes on past this page.
  }
  location.reload();
});

show(location.pathname.startsWith("/register") ? "register" : "login");
// Not on a touchscreen, where a focused field would put the keyboard over the page.
if (matchMedia("(hover: hover)").matches) user.focus();
noZoom();
