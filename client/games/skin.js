/**
 * The badge the player wears, which the games draw themselves in: a snake
 * badge colours the snake, a mushroom badge the pinball bumpers
 * (src/social/shop.ts SNAKE_SKINS, MUSHROOM_SKINS). Kept on the device, so a
 * game played offline wears it too; set whenever a game's board is read
 * fresh (scores.js), and cleared when that read finds no one signed in.
 */
const KEY = "ug.bd";
const EVENT = "ug:badge";

/** The badge worn, as last read; "" for none. */
export function worn() {
  try {
    return localStorage.getItem(KEY) || "";
  } catch {
    return "";
  }
}

/** @param {string} badge */
export function keepWorn(badge) {
  if (badge === worn()) return;
  try {
    if (badge) localStorage.setItem(KEY, badge);
    else localStorage.removeItem(KEY);
  } catch {
    // Storage refused: worn for this visit only, below.
  }
  window.dispatchEvent(new CustomEvent(EVENT, { detail: badge }));
}

/** Call `fn` with the badge whenever it changes. @param {(badge: string) => void} fn */
export function onWorn(fn) {
  window.addEventListener(EVENT, (e) => fn(/** @type {CustomEvent} */ (e).detail));
}
