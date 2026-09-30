/**
 * The account control in the top right. Signed in: Wallet. Signed out: Log in,
 * which opens the one login dialog. Either way, then Get Social, to the
 * timeline. Connecting a wallet is not a header action; the trade dialog asks
 * for one when it needs to sign.
 */
import { el } from "./dom.js";
import { load } from "./lazy.js";
import { onName, readName } from "./me.js";

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
 * @param {HTMLElement} node the page's #ac slot
 * @param {{self?: boolean, onLogin?: () => void}} [opts] `self` on the wallet page, so the button
 *   says it is the current page; `onLogin` runs once the dialog has signed someone in.
 */
export function mountAccount(node, opts = {}) {
  function paint() {
    const name = readName();
    node.replaceChildren(
      name
        ? el("a", {
            class: "ac-w",
            href: WALLET_PAGE,
            text: "Wallet",
            ...(opts.self ? { "aria-current": "page" } : {}),
          })
        : el("button", {
            class: "ac-w ac-in",
            type: "button",
            text: LOGIN,
            onclick: () => openLogin(opts.onLogin),
          }),
      el(
        "a",
        { class: "ac-soc", href: "/social", "aria-label": "Get Social" },
        el("span", { class: "ac-soc-t", text: "Get Social" }),
      ),
    );
  }

  onName(paint);
  paint();
}
