/**
 * The games list and each game keep themselves offline the same way: register
 * the service worker, and on a first visit, when the page arrived before any
 * worker was in charge of it, hand the worker what it fetched (the same
 * `ugSeed` message client/offline sends). The worker's install also fetches
 * /games and every game's page and bundle (client/sw GAMES), so the rest open
 * offline too.
 */
export function keepOffline() {
  const sw = navigator.serviceWorker;
  if (!sw) return;
  const first = !sw.controller;
  sw.register("/sw.js").catch(() => {});
  if (!first) return;
  sw.ready.then((reg) => {
    const urls = performance
      .getEntriesByType("resource")
      .map((entry) => entry.name)
      .filter((name) => name.startsWith(location.origin) && !name.includes("/api/"));
    reg.active?.postMessage({ ugSeed: [location.href, ...urls], page: location.href });
  });
}
