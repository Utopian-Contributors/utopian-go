/**
 * Connecting a wallet, on its own — no trade attached.
 *
 * A separate bundle from the buy panel because the two are wanted at different
 * moments: the header's Login button and the wallet page both need to reach a
 * wallet, and neither should drag in a quote engine and a confirmation screen
 * to do it. What they share is the dialog, the chooser and the Wallet Standard
 * module itself, so the two screens are the same screen.
 */
import { renderPicker } from "../js/picker.js";
import { dialog } from "../js/ui.js";
import { connect, disconnect, wallets } from "../js/wallet.js";

/** The wallet this bundle last connected, so logout can be polite about it. */
let held = null;

/**
 * Ask for a wallet.
 *
 * @returns {Promise<boolean>} true once an address has been remembered
 */
function start() {
  const found = wallets();

  // Exactly one wallet is not a choice, and a dialog listing a single option
  // in front of the extension's own approval prompt is a click that asks
  // nothing. Straight through, then — unless it is declined, which is the one
  // case where there is something to say and the chooser is where to say it.
  if (found.length === 1) {
    return take(found[0]).then(
      (ok) => ok || choose(found, "Connection declined."),
    );
  }
  return choose(found);
}

/**
 * @param {any[]} found
 * @param {string} [note]
 * @returns {Promise<boolean>}
 */
function choose(found, note) {
  return new Promise((resolve) => {
    let picked = false;
    const { body, close } = dialog(
      found.length ? "Connect a wallet" : "No wallet found",
      // Dismissed — by Escape, the backdrop or the close button — without
      // choosing. Only settles the promise when the close was not ours.
      () => picked || resolve(false),
    );
    renderPicker(
      body,
      found,
      ({ wallet }) => {
        picked = true;
        held = wallet;
        close();
        resolve(true);
      },
      note,
    );
  });
}

/** Connect one wallet. `connect` is what writes the address down. */
async function take(wallet) {
  try {
    await connect(wallet);
    held = wallet;
    return true;
  } catch {
    return false;
  }
}

/** Courtesy disconnect on logout; see wallet.js for why it is only that. */
function off() {
  if (!held) return;
  const wallet = held;
  held = null;
  void disconnect(wallet);
}

window.__connect = { start, off };
