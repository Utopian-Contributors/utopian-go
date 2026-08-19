/**
 * Loader for the bundles that are not part of first load.
 *
 * The buy panel and the wallet picker are separate bundles so the shell stays
 * inside one TCP initial window: visitors who never trade and never connect
 * pay nothing for either, and the budget script keeps reporting first load
 * honestly. Each URL carries a content hash written in at build time, so a
 * deploy cannot be served a stale bundle out of cache.
 *
 * One loader rather than one per bundle — two copies of this in app.js cost
 * more than the parameter does.
 */

/** In-flight or settled loads, keyed by bundle. */
const loads = new Map();

/**
 * @param {string} attr `document.body.dataset` key holding the URL
 * @param {string} global `window` property the bundle publishes itself on
 * @returns {Promise<any>} the bundle's global
 */
export function load(attr, global) {
  const held = loads.get(global);
  if (held) return held;

  const src = document.body.dataset[attr];
  const task = new Promise((resolve, reject) => {
    if (!src) return reject(new Error("bundle not configured"));
    const script = document.createElement("script");
    script.src = src;
    script.async = true;
    script.onload = () =>
      window[global] ? resolve(window[global]) : reject(new Error("bundle empty"));
    script.onerror = () => reject(new Error("bundle blocked"));
    document.head.append(script);
  }).catch((err) => {
    // A failed load must not be cached as a permanent verdict — a flaky
    // connection should cost one retry, not the feature for the whole session.
    loads.delete(global);
    throw err;
  });

  loads.set(global, task);
  return task;
}
