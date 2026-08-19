/**
 * The remembered wallet.
 *
 * One address in localStorage and nothing else — no token, no signature, no
 * server-side session. That is the whole point: an address is public
 * information the moment it signs anything, so remembering it locally gives
 * away nothing that the chain does not already publish, and it buys back the
 * thing people actually resent about connecting a wallet, which is doing it
 * again on every visit.
 *
 * What it deliberately is not is proof of anything. Nothing here can sign, and
 * the server is never told "this visitor is that wallet" on the strength of a
 * localStorage entry — /api/holdings answers about whatever public address it
 * is handed, exactly as a block explorer does. Signing still needs the wallet
 * to re-authorise, which `restore()` in wallet.js asks it to do silently.
 */

/** Short key: this string is in every read, and reads are on the boot path. */
const KEY = "ug.w";

/**
 * In-memory mirror, and the only copy when storage is unavailable.
 *
 * Two questions wear the same name. "Who is connected right now" is answered
 * by this; "who should still be connected on the next visit" is answered by
 * localStorage. They agree almost always, and the case that separates them is
 * the one this exists for: in a private window the write silently fails, so
 * reading back from storage returned null and the header went on offering
 * Login to someone whose wallet had just approved the connection. The session
 * does not outlive the page there, which is a real limitation; claiming there
 * was no session at all was a wrong answer.
 *
 * On `window`, and it has to be. Each bundle is a separate esbuild entry
 * point, so app.js, connect.js, swap.js and the wallet page each carry their
 * own copy of this module — a module-level `let` would give every one of them
 * a private mirror. The connect bundle would then write a session the header,
 * holding a different copy, could not see. With storage working the
 * localStorage write happens to bridge them, so that fails only where the
 * mirror is the sole record: precisely the case it was added for. `window` is
 * the one thing the bundles genuinely share, which is why the bundles
 * themselves are already published there as __swap and __connect.
 */
const MIRROR = "__ugw";

/** @returns {{address: string, wallet: string} | null} */
function mirrored() {
  return window[MIRROR] ?? null;
}

/**
 * localStorage throws rather than returning null when it is unavailable —
 * Safari's private mode, a storage-blocked iframe, a filled quota. None of
 * those are worth a broken header, so every access in this module is a no-op
 * on failure and the site falls back to what it did before: logged out.
 *
 * @returns {{address: string, wallet: string} | null}
 */
function fromStorage() {
  try {
    const raw = localStorage.getItem(KEY);
    if (!raw) return null;
    const { a, n } = JSON.parse(raw);
    if (typeof a !== "string" || !a) return null;
    return { address: a, wallet: typeof n === "string" ? n : "" };
  } catch {
    // Absent, unreadable, or written by a version that shaped it differently.
    return null;
  }
}

/** @returns {{address: string, wallet: string} | null} */
export function readSession() {
  return mirrored() ?? fromStorage();
}

/**
 * @param {string} address
 * @param {string} [wallet] Wallet Standard name, so a reconnect can pick the
 *   same extension out of several without asking again.
 */
export function writeSession(address, wallet) {
  window[MIRROR] = { address, wallet: wallet || "" };
  try {
    localStorage.setItem(KEY, JSON.stringify({ a: address, n: wallet || "" }));
  } catch {
    // Not storable — the session still works for this page via the mirror, it
    // won't survive a reload. Better than refusing to connect at all.
  }
  announce();
}

export function clearSession() {
  window[MIRROR] = null;
  try {
    localStorage.removeItem(KEY);
  } catch {
    // Nothing to do: if it cannot be removed it could not have been written.
  }
  announce();
}

/** 4…4, the form every Solana explorer uses. Short enough to sit in a header. */
export function shortAddr(a) {
  return a.length > 12 ? `${a.slice(0, 4)}…${a.slice(-4)}` : a;
}

/**
 * Session changes, as an event.
 *
 * Two writers exist — the header's own Login/Logout, and the lazily-loaded
 * connect and swap bundles — and the header has to repaint for all of them
 * without holding a reference to any. A window event is the cheapest way for
 * code that may not be loaded yet to reach code that already is.
 */
const EVENT = "ug:w";

function announce() {
  window.dispatchEvent(new Event(EVENT));
}

/**
 * `storage` fires in every *other* tab on this origin, so logging out in one
 * window logs out the rest instead of leaving them claiming a wallet the user
 * has already dropped.
 *
 * One listener rather than one per subscriber, because it has to do more than
 * notify: the mirror shadows storage by design, so a tab that did not hear
 * about the change would keep answering a stale one. It is re-read here and
 * then announced through the same event as a local change, which leaves
 * subscribers with exactly one thing to handle.
 */
const SYNCING = "__ugs";

if (!window[SYNCING]) {
  // Once per page, not once per bundle. Every bundle carries its own copy of
  // this module, so without the guard a single cross-tab logout is announced
  // as many times as there are bundles loaded — and on the wallet page each
  // announcement costs a holdings request.
  window[SYNCING] = true;
  window.addEventListener("storage", (e) => {
    if (e.key !== KEY && e.key != null) return;
    window[MIRROR] = fromStorage();
    announce();
  });
}

/** @param {() => void} fn */
export function onSession(fn) {
  window.addEventListener(EVENT, fn);
}
