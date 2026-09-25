/**
 * The account control in the top right: Wallet, then the signed-in Social
 * name linking to that profile, or Get Social. Connecting a wallet is no
 * longer a header action; the trade dialog asks for one when it needs to sign.
 */
import { el } from "./dom.js";
import { onName, readName } from "./me.js";

/** Where the Wallet button goes, and what the wallet page is. */
export const WALLET_PAGE = "/wallet";

/**
 * @param {HTMLElement} node the page's #ac slot
 * @param {{self?: boolean}} [opts] `self` on the wallet page, so the button says it is the current page.
 */
export function mountAccount(node, opts = {}) {
  function paint() {
    const name = readName();
    node.replaceChildren(
      el("a", {
        class: "ac-w",
        href: WALLET_PAGE,
        text: "Wallet",
        ...(opts.self ? { "aria-current": "page" } : {}),
      }),
      name
        ? el("a", { class: "ac-me", href: `/social/u/${name}`, text: name, title: "My Profile" })
        : el(
            "a",
            { class: "ac-soc", href: "/social", "aria-label": "Get Social" },
            el("span", { class: "ac-soc-t", text: "Get Social" }),
          ),
    );
  }

  onName(paint);
  paint();
}
