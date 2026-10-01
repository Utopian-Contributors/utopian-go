/**
 * A token's logo, from the server's synced copy at /icon/<mint>.
 *
 * Every coin image goes through here so none can show a broken image. A mint
 * the index holds no logo for gets the plain coin straight away; one whose
 * logo is missing on the server (a 404) or fails to load gets it through the
 * image's error handler. The coin takes the same box as the logo, so rows
 * stay in line either way.
 */
import { el } from "./dom.js";

/**
 * @param {{ mint: string, icon?: boolean }} token `icon` is the index saying a logo was synced
 * @param {number} size the square it takes, in px
 * @param {string} cls the page's class for a logo; the plain coin gets it too
 * @param {string} coinCls added to the plain coin, which the page draws as a disc with "$"
 */
export function coinIcon(token, size, cls, coinCls) {
  const coin = () => el("span", { class: `${cls} ${coinCls}`, text: "$", "aria-hidden": "true" });
  if (!token.icon) return coin();
  const img = el("img", {
    class: cls,
    src: `/icon/${token.mint}`,
    alt: "",
    width: String(size),
    height: String(size),
    loading: "lazy",
    decoding: "async",
  });
  img.addEventListener("error", () => img.replaceWith(coin()), { once: true });
  return img;
}
