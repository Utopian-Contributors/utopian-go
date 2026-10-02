/**
 * The account control in the top right. Signed in: Wallet. Signed out: Log in,
 * which opens the one login dialog. Either way, then Get Social, to the
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

/**
 * Open the login dialog from a page that fetches it lazily (data-lg).
 *
 * @param {() => void} [onDone]
 */
export async function openLogin(onDone) {
  try {
    (await load("lg", "__login")).open("login", onDone);
  } catch {
    // The bundle would not load; Social has the same dialog built in.
    location.href = "/social";
  }
}

/**
 * End the Social session, here and on every device it is signed in on, and
 * forget it in this browser. Throws if the server did not.
 */
export async function logOut() {
  const res = await fetch("/api/social/logout", {
    method: "POST",
    headers: { "Content-Type": "application/json", Accept: "application/json" },
    body: "{}",
  });
  if (!res.ok) {
    const data = await res.json().catch(() => ({}));
    throw new Error(data.error || "Could not log out.");
  }
  // Messenger's opened key (client/chat) is this device's, not the next person's.
  try {
    indexedDB.deleteDatabase("ug-chat");
  } catch {
    // Storage is off, so nothing was kept.
  }
  writeName("");
}

/**
 * Log out, as the header's button. `done` runs once it has signed them out, or
 * with the error if it could not. Its own export, so the pages without one
 * (search) do not carry it.
 *
 * @param {(err?: Error) => void} done
 */
export function logOutButton(done) {
  const out = el("button", {
    class: "ac-out",
    type: "button",
    text: "Log out",
    onclick: async () => {
      out.disabled = true;
      try {
        await logOut();
      } catch (err) {
        out.disabled = false;
        done(err);
        return;
      }
      done();
    },
  });
  return out;
}

/**
 * @param {HTMLElement} node the page's #ac slot
 * @param {{self?: () => HTMLElement, onLogin?: () => void}} [opts] `self` on the
 *   wallet page, where a Wallet button would only point at the page you are on:
 *   signed in, what it makes follows Get Social instead. `onLogin` runs once the
 *   dialog has signed someone in.
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
    node.replaceChildren(
      name
        ? el("a", { class: "ac-w", href: WALLET_PAGE, text: "Wallet" })
        : el("button", {
            class: "ac-w ac-in",
            type: "button",
            text: LOGIN,
            onclick: () => openLogin(opts.onLogin),
          }),
      social,
    );
  }

  onName(paint);
  paint();
}
