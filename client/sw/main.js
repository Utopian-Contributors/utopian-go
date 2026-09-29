/**
 * The service worker: pages from the network, and a page of our own when there
 * is no network.
 *
 * It caches nothing, on purpose. The search shell is rendered per request with
 * live prices in it, and every document revalidates so that it never names a
 * bundle a deploy has since replaced — a cached copy served offline would show
 * yesterday's prices as if they were today's, and the page it loaded could not
 * search anyway. What an installed app needs from offline is to say so in its
 * own window, instead of a browser error page, and that takes no cache at all.
 *
 * Only navigations are answered here. Everything else passes straight through,
 * so the bundles, the API and every thumbnail are fetched exactly as they are
 * without a worker. Navigation preload starts the page's request while the
 * worker is still booting, so being in the path costs a navigation the worker's
 * startup only when that outlasts the network, not on top of it.
 *
 * Served from /sw.js with no content hash: the browser tells versions apart by
 * comparing the script byte for byte, and the URL has to stay put for that.
 * src/server.ts serves it no-cache.
 */

/**
 * Styled from the site's palette, light and dark. No script and no requests,
 * so it draws whatever is or is not reachable, and the policy below says so.
 */
const OFFLINE = `<!doctype html><html lang="en"><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1,maximum-scale=1,user-scalable=no">
<meta name="color-scheme" content="light dark"><title>Offline</title><style>
:root{--bg:#fffff6;--t:#202124;--f:#70757a;--a:#1a73e8}
@media (prefers-color-scheme:dark){:root{--bg:#282124;--t:#e8eaed;--f:#9aa0a6;--a:#8ab4f8}}
body{display:grid;place-items:center;min-height:100vh;min-height:100dvh;margin:0;padding:24px;
box-sizing:border-box;background:var(--bg);color:var(--t);font:15px/1.5 system-ui,Helvetica,Arial,sans-serif;text-align:center}
h1{margin:0 0 4px;font-size:20px;font-weight:600}p{margin:0 0 16px;color:var(--f)}
a{color:var(--a);font-weight:600;text-decoration:none}
</style><main><h1>You're offline</h1><p>UtopianGO needs a connection to search.</p>
<a href="">Try again</a></main>`;

function offline() {
  return new Response(OFFLINE, {
    // Honest about what this is, though nothing on screen shows it.
    status: 503,
    headers: {
      "Content-Type": "text/html; charset=utf-8",
      "Content-Security-Policy": "default-src 'none'; style-src 'unsafe-inline'",
    },
  });
}

// Nothing is cached, so there is no old version worth waiting on: take over
// the open pages the moment a new worker is ready.
self.addEventListener("install", () => self.skipWaiting());

self.addEventListener("activate", (event) => {
  event.waitUntil(
    Promise.all([self.clients.claim(), self.registration.navigationPreload?.enable()]),
  );
});

self.addEventListener("fetch", (event) => {
  if (event.request.mode !== "navigate") return;
  // preloadResponse is undefined where navigation preload is unsupported, and
  // settles to undefined where it is supported but not yet enabled.
  event.respondWith(
    Promise.resolve(event.preloadResponse)
      .then((preloaded) => preloaded || fetch(event.request))
      .catch(offline),
  );
});
