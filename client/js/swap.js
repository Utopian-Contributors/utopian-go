/**
 * Loader for the buy panel.
 *
 * The panel is a separate bundle so the shell stays inside one TCP init
 * window: visitors who never buy pay nothing for it, and the budget script
 * keeps reporting first-load honestly. The URL carries a content hash written
 * in at build time, so a deploy can't be served a stale panel from cache.
 */

/** Resolves to the loaded module's global, or rejects if the chunk won't load. */
let loading = null;

function loadPanel() {
  if (loading) return loading;

  const src = document.body.dataset.sw;
  loading = new Promise((resolve, reject) => {
    if (!src) return reject(new Error("no swap bundle configured"));
    const script = document.createElement("script");
    script.src = src;
    script.async = true;
    script.onload = () =>
      window.__swap ? resolve(window.__swap) : reject(new Error("swap bundle empty"));
    script.onerror = () => reject(new Error("swap bundle blocked"));
    document.head.append(script);
  }).catch((err) => {
    loading = null;
    throw err;
  });

  return loading;
}

/**
 * Open the buy dialog for a token.
 *
 * @param {{mint: string, symbol: string, decimals?: number, fallback: string}} token
 */
export async function openSwap(token) {
  const panel = await loadPanel();
  return panel.open(token);
}
