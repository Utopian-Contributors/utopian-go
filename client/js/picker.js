/**
 * "Which wallet?", as one implementation.
 *
 * Asked from two places — the Login button, and the buy panel when a trade
 * needs a wallet it has not got — and there is no reason for them to be two
 * screens. The buy panel renders this into the dialog it already has open;
 * the login bundle opens a dialog for it. Same markup either way.
 */
import { el } from "./dom.js";
import { connect } from "./wallet.js";

/**
 * Fill a dialog body with the chooser.
 *
 * @param {HTMLElement} body dialog body to render into
 * @param {any[]} found wallets, from wallets()
 * @param {(session: {wallet: any, account: any}) => void} onPicked
 * @param {string} [note] opening message, e.g. why the last attempt failed
 */
export function renderPicker(body, found, onPicked, note) {
  body.replaceChildren();
  const msg = el("div", { class: `swx-note${note ? " err" : ""}`, text: note || "" });

  if (!found.length) {
    msg.className = "swx-note err";
    msg.textContent =
      "No Solana wallet detected. Install Phantom, Solflare or Backpack, then reload this page.";
    body.append(msg);
    return;
  }

  const list = el("div", { class: "swx-w" });
  for (const wallet of found) {
    const row = el("button", { type: "button" });
    // Data URIs only. Wallet Standard supplies the icon inline, and this is a
    // pre-connect screen — an extension offering a remote URL instead would
    // make the browser fetch it, which is exactly the third-party contact the
    // dialog otherwise no longer makes before a wallet is chosen.
    if (/^data:image\//i.test(wallet.icon ?? "")) {
      row.append(el("img", { src: wallet.icon, alt: "" }));
    }
    row.append(el("span", { text: wallet.name }));
    row.addEventListener("click", async () => {
      row.disabled = true;
      msg.textContent = "";
      msg.className = "swx-note";
      try {
        // connect() is what writes the address down, so a wallet chosen here
        // is remembered whichever screen asked the question.
        onPicked({ wallet, account: await connect(wallet) });
      } catch (err) {
        row.disabled = false;
        msg.textContent = err?.message || "Connection declined.";
        msg.className = "swx-note err";
      }
    });
    list.append(row);
  }

  body.append(
    el("div", { class: "swx-lbl" }, el("span", { text: "Choose a wallet" })),
    list,
    msg,
  );
}
