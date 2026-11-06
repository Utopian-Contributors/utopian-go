/**
 * Games: the list of games is static markup, and this is all its script does.
 * It keeps the page offline, the same way pinball/main.js does: it registers
 * the service worker, and on a first visit, when the page arrived before any
 * worker was in charge of it, hands the worker what it fetched (the same
 * `ugSeed` message client/offline sends). The worker's install also fetches
 * /games and every game's page and bundle (client/sw GAMES), so the games
 * listed here open offline too.
 */
const sw = navigator.serviceWorker;
if (sw) {
  const first = !sw.controller;
  sw.register("/sw.js").catch(() => {});
  if (first) {
    sw.ready.then((reg) => {
      const urls = performance
        .getEntriesByType("resource")
        .map((entry) => entry.name)
        .filter((name) => name.startsWith(location.origin) && !name.includes("/api/"));
      reg.active?.postMessage({ ugSeed: [location.href, ...urls], page: location.href });
    });
  }
}
