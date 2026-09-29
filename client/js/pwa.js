/**
 * The installable app: registers the service worker, and on a phone or tablet
 * offers the install panel.
 *
 * Every page's bundle calls mountPwa() once. The panel itself is install.js, a
 * lazy bundle, because only a phone that has not installed the app and has not
 * waved the panel away ever draws it — a desktop pays a user-agent check here
 * and nothing more.
 */
import { mobile } from "./device.js";
import { load } from "./lazy.js";

/** Set once the panel is dismissed or the app is installed. It stays away after either. */
const KEY = "ug.pwa";

/** How long after load the panel slides up, so it arrives after the page does rather than with it. */
const DELAY = 1500;

export function settle() {
  try {
    localStorage.setItem(KEY, "1");
  } catch {
    // Storage refused: the panel comes back next visit, which is all this costs.
  }
}

function settled() {
  try {
    return localStorage.getItem(KEY) === "1";
  } catch {
    // No storage means no way to remember a dismissal, and a panel that
    // cannot stay closed is worse than none.
    return true;
  }
}

/** Launched from the home screen rather than in a browser tab. */
function standalone() {
  return matchMedia("(display-mode: standalone)").matches || navigator.standalone === true;
}

export function mountPwa() {
  const offer = !standalone() && mobile() && !settled();

  /**
   * Chromium's own install prompt, held for the panel's Install button.
   * Deferring it also stops Chrome's mini-infobar from stacking a second
   * prompt on top of ours. Listened for from boot, because it can fire before
   * install.js has arrived, and only where the panel will show: everywhere
   * else the browser keeps its own default.
   * @type {Event | null}
   */
  let prompt = null;
  if (offer) {
    addEventListener("beforeinstallprompt", (e) => {
      e.preventDefault();
      prompt = e;
      window.ugInstall?.offer(e);
    });
  }

  // After load, so neither the worker nor the panel competes with first paint.
  addEventListener("load", () => {
    navigator.serviceWorker?.register("/sw.js").catch(() => {});
    if (!offer) return;
    setTimeout(() => {
      load("pw", "ugInstall")
        .then((panel) => panel.open(prompt))
        .catch(() => {});
    }, DELAY);
  });
}
