/**
 * The account control in the top right: Login, or the wallet and a way out.
 *
 * Everything expensive about connecting a wallet — discovery, the chooser, the
 * dialog, the Wallet Standard itself — is in a bundle this module only fetches
 * when someone actually presses Login. What stays on the first-load path is a
 * localStorage read and two controls, which is what lets the header know who
 * you are without costing a request or a round trip.
 */
import { el } from "./dom.js";
import { load } from "./lazy.js";
import { clearSession, onSession, readSession, shortAddr } from "./session.js";

/** Where the address links to, and what the wallet page is. */
export const WALLET_PAGE = "/wallet";

/**
 * @param {HTMLElement} node the shell's #ac slot
 * @param {{self?: boolean}} [opts] `self` on the wallet page, where the link
 *   points at the page it is already on and says so rather than pretending to
 *   go somewhere.
 */
export function mountAccount(node, opts = {}) {
  let busy = false;

  function paint() {
    const saved = readSession();
    if (!saved) {
      node.replaceChildren(
        el("button", {
          class: "ac-b",
          type: "button",
          text: busy ? "…" : "Login",
          disabled: busy,
          onclick: login,
        }),
      );
      return;
    }

    node.replaceChildren(
      // A link on every page, including the one it points at — the same
      // bargain the wordmark makes on the home page. Underlined, because an
      // address that opens a page has to look like it does; `aria-current`
      // is what tells a screen reader it is already there.
      el("a", {
        class: "ac-a",
        href: WALLET_PAGE,
        text: shortAddr(saved.address),
        // The truncation is a fit-the-header decision, and it must not be the
        // only copy of a string people check character by character before
        // sending money.
        title: saved.address,
        "aria-label": `Wallet ${saved.address} — balance and holdings`,
        ...(opts.self ? { "aria-current": "page" } : {}),
      }),
      el("button", {
        class: "ac-b ac-out",
        type: "button",
        text: "Logout",
        onclick: logout,
      }),
    );
  }

  async function login() {
    if (busy) return;
    busy = true;
    paint();
    try {
      const panel = await load("cn", "__connect");
      await panel.start();
    } catch {
      // Bundle blocked, or the wallet refused. Either way the header goes back
      // to offering Login rather than sitting on a spinner.
    } finally {
      busy = false;
      paint();
    }
  }

  function logout() {
    // Forgetting the address is the part that lasts and the part we control,
    // so it happens first and unconditionally. Telling the wallet is a
    // courtesy, and only possible at all if the bundle that owns the wallet
    // object is already in memory — never worth a fetch of its own.
    clearSession();
    window.__connect?.off?.();
  }

  onSession(paint);
  paint();
}
