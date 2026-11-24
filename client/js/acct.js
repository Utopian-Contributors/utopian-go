/**
 * The account control in the top right. Signed in: Wallet. Signed out: Log in,
 * to the login page and back to this one. Either way, then Get Social, to the
 * timeline. On the wallet page itself, signed in, Wallet would only point at
 * the page you are on, so it is Get Social and then Log out. Connecting a
 * wallet is not a header action; the trade dialog asks for one when it needs
 * to sign.
 */
import { el } from "./dom.js";
import { load } from "./lazy.js";
import { onName, readName, writeName } from "./me.js";

/** Where the Wallet button goes, and what the wallet page is. */
export const WALLET_PAGE = "/wallet";

/** The one label for logging in, on every button that opens the login dialog. */
export const LOGIN = "Log in";

/** The page someone is on, as a ?next= names it. */
export function here() {
  return location.pathname + location.search;
}

/**
 * `page` (/login or /register), going on to `to` once someone is in. As
 * src/pages.ts authPath writes it. `add` is Add Account: the login page shown
 * to someone already signed in, who would otherwise be sent straight on.
 *
 * @param {"/login" | "/register"} page
 * @param {string} [to]
 * @param {boolean} [add]
 */
export function authPath(page, to = here(), add = false) {
  const q = [];
  if (to !== "/") q.push(`next=${encodeURIComponent(to).replace(/%2F/gi, "/")}`);
  if (add) q.push("add=1");
  return q.length ? `${page}?${q.join("&")}` : page;
}

/** The login page, going on to `to` once someone is in. */
export function loginPath(to = here()) {
  return authPath("/login", to);
}

/**
 * Go to the login page, or with `register` the sign-up page, and come back
 * to `to` (this page, unless said) once someone is in.
 *
 * @param {string} [to]
 * @param {boolean} [register]
 */
export function goLogIn(to = here(), register = false) {
  location.assign(authPath(register ? "/register" : "/login", to));
}

/**
 * End the Social session, here and on every device it is signed in on, and
 * forget it in this browser. Another account this browser holds (the account
 * picker, js/accounts.js) carries on in its place: its name is the answer,
 * null when nobody is signed in now. Throws if the server did not.
 *
 * @returns {Promise<string | null>}
 */
export async function logOut() {
  const res = await fetch("/api/social/logout", {
    method: "POST",
    headers: { "Content-Type": "application/json", Accept: "application/json" },
    body: "{}",
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.error || "Could not log out.");
  // Messenger keeps its opened key in tab memory now (client/chat); this is the
  // store earlier versions wrote it to, gone for whoever uses the device next.
  try {
    indexedDB.deleteDatabase("ug-chat");
  } catch {
    // Storage is off, so nothing was kept.
  }
  writeName(data.name || "");
  return data.name || null;
}

/**
 * Open the account picker (js/accounts.js, in the login bundle): switch,
 * add an account, or log out. A switch, an added account or a log out that
 * another account carries on from all start the page again as `onSwitch`
 * says (a reload by default), so nothing on it still belongs to the account
 * it was drawn for; a log out that leaves nobody runs `onLoggedOut`.
 *
 * @param {{onSwitch?: (name: string) => void, onLoggedOut?: () => void}} [o]
 */
export async function openAccounts(o = {}) {
  try {
    const login = await load("lg", "__login");
    login.accounts({
      onSwitch: o.onSwitch ?? (() => location.reload()),
      onLoggedOut: o.onLoggedOut ?? (() => location.replace("/")),
      addAccount: () => location.assign(authPath("/login", here(), true)),
    });
  } catch {
    // The bundle would not load; the next press tries again (js/lazy.js).
  }
}

/** The header's Accounts button, where a page has one (Social and the wallet page). */
export const ACCOUNTS = "Accounts";

/**
 * The header's Accounts button, for a page that builds its header (the
 * wallet page). Social's is in its document.
 *
 * @param {Parameters<typeof openAccounts>[0]} [o]
 */
export function accountsButton(o) {
  return el("button", { class: "ac-sw", type: "button", text: ACCOUNTS, onclick: () => openAccounts(o) });
}

/**
 * @param {HTMLElement} node the page's #ac slot
 * @param {{self?: () => HTMLElement, loginAlone?: boolean}} [opts]
 *   `self` on the wallet page, where a Wallet button would only point at the
 *   page you are on: signed in, what it makes follows Get Social instead.
 *   `loginAlone` on search: signed out, Log in is the whole control, with no
 *   Get Social.
 */
export function mountAccount(node, opts = {}) {
  function paint() {
    const name = readName();
    const social = el(
      "a",
      { class: "ac-soc", href: "/social", "aria-label": "Get Social" },
      el("span", { class: "ac-soc-t", text: "Get Social" }),
    );
    if (name && opts.self) {
      node.replaceChildren(social, opts.self());
      return;
    }
    if (name) {
      node.replaceChildren(el("a", { class: "ac-w", href: WALLET_PAGE, text: "Wallet" }), social);
      return;
    }
    const login = el("a", { class: "ac-w ac-in", href: loginPath(), text: LOGIN });
    if (opts.loginAlone) node.replaceChildren(login);
    else node.replaceChildren(login, social);
  }

  onName(paint);
  paint();
}

/**
 * The home page's Wallet and Social rows: straight to their page signed in,
 * by the login page signed out. The server points them from the session
 * cookie (src/pages.ts homeNav), which is the truth as the page arrives; this
 * follows the session as it changes after, here or in another tab, or while
 * the page sat in the back cache.
 *
 * @param {HTMLElement} node #hm-nv
 */
export function mountHomeNav(node) {
  function paint() {
    const signed = !!readName();
    for (const a of /** @type {NodeListOf<HTMLAnchorElement>} */ (node.querySelectorAll("a[data-to]"))) {
      const to = /** @type {string} */ (a.dataset.to);
      a.setAttribute("href", signed ? to : loginPath(to));
    }
  }

  onName(paint);
  window.addEventListener("pageshow", (e) => e.persisted && paint());
}
