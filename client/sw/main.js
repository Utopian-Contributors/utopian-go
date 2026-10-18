/**
 * The service worker: the network first, and the last copy of whatever the
 * app has seen when there is no network.
 *
 * Offline, the app opens on its last synced state: the page as it was last
 * fetched, the bundles it names, and the API answers it last read (the
 * timeline, a profile, the wallet's balances, a search's results). Over it,
 * client/offline says there is no connection and offers Retry; closing that
 * leaves the old state to read, with the logo greyed so it is never mistaken
 * for live.
 *
 * Three caches, each by a different rule:
 *
 *  - Pages: network first, always. Every document revalidates so it never
 *    names a bundle a deploy has replaced, and a live page carries live
 *    prices. The copy is only for when the network fails. Each is kept under
 *    its own URL and under its section's shell (/, /social, /wallet), so a
 *    social or wallet route never visited still opens on the right page.
 *    The three shells, and the bundles they name, are fetched when the worker
 *    installs, so there is always an app to open offline.
 *  - Assets with ?v=: cache first. The query is the content hash, so a cached
 *    copy is the file itself, for good. Same-origin assets without one (an
 *    icon, a banner) go network first like pages.
 *  - API: network first. A GET that succeeds is kept; one that fails is
 *    answered from the copy, and the page that asked is told it is offline.
 *
 * What is stored is this device's own state: on a logout, or a 401 that says
 * the session is gone, the API copies go with it.
 *
 * Only this origin's GETs are touched. Jupiter and every result thumbnail
 * from the open web pass straight through, as does a request made with
 * `cache: "no-store"`, which is how client/offline asks whether the network
 * is back without the answer coming from here.
 *
 * Served from /sw.js with no content hash: the browser tells versions apart by
 * comparing the script byte for byte, and the URL has to stay put for that.
 * src/server.ts serves it no-cache.
 */

const PAGES = "ug-pages-1";
const ASSETS = "ug-assets-1";
const API = "ug-api-1";
const KEEP = { [PAGES]: 40, [ASSETS]: 400, [API]: 150 };

/** The app's three documents: kept from the moment a worker installs, so offline always has one to open. */
const SHELLS = ["/", "/social", "/wallet"];

/** Set on a page served from the cache, so client/offline knows at once. */
const MARK = '<meta name="ug-offline" content="';

/**
 * The page for when nothing at all was ever cached for this address. The same
 * words and button client/offline shows; no script, so Retry is a reload.
 */
const OFFLINE = `<!doctype html><html lang="en"><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1,maximum-scale=1,user-scalable=no">
<meta name="color-scheme" content="light dark"><title>Offline</title><style>
:root{--bg:#fffff6;--f:#70757a;--buy:#188038;--ink:#fff}
@media (prefers-color-scheme:dark){:root{--bg:#282124;--f:#9aa0a6;--buy:#81c995;--ink:#202124}}
body{display:grid;place-items:center;min-height:100vh;min-height:100dvh;margin:0;padding:24px;
box-sizing:border-box;background:var(--bg);font:16px/1.5 system-ui,Helvetica,Arial,sans-serif;text-align:center}
p{max-width:340px;margin:0 0 24px;color:var(--f)}
a{display:inline-block;padding:12px 32px;border-radius:999px;background:var(--buy);color:var(--ink);
font-weight:600;text-decoration:none}
</style><main><p>UtopianGo is an Ultra-efficient App to Access the Internet, but we couldn’t make a Connection happen</p>
<a href="">Retry</a></main>`;

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

/**
 * The shell a page falls back to when its own address was never cached. Social
 * and the wallet are one document whatever the route, so any of their pages
 * is their shell; a search's results are not the home page, so only "/" is.
 */
function shellOf(url) {
  const p = url.pathname;
  if (p === "/social" || p.startsWith("/social/")) return "/social";
  if (p === "/wallet" || p.startsWith("/wallet/")) return "/wallet";
  return "/";
}

/** Keep a page under its own address and, where it is one, as its section's shell. */
function keepPage(url, response) {
  const own = url.pathname + url.search;
  const shell = shellOf(url);
  return Promise.all([
    keep(PAGES, own, response.clone()),
    shell === own || shell === "/" ? null : keep(PAGES, shell, response.clone()),
  ]);
}

/** Copies are matched by address alone: one seeded from a page has none of a live request's headers. */
const ANY = { ignoreVary: true };

/**
 * Keep a copy, stamped with when it was fetched, and hold the cache to its
 * size by letting the oldest go. Deleting first moves a refreshed entry to the
 * back of the line, since a cache lists its keys in the order they went in.
 */
async function keep(name, key, response) {
  const headers = new Headers(response.headers);
  headers.set("ug-at", String(Date.now()));
  const copy = new Response(await response.blob(), { status: response.status, statusText: response.statusText, headers });
  const cache = await caches.open(name);
  await cache.delete(key);
  await cache.put(key, copy);
  const keys = await cache.keys();
  await Promise.all(keys.slice(0, Math.max(0, keys.length - KEEP[name])).map((old) => cache.delete(old)));
}

/** A cached page, marked as one so the page can say it is offline and since when. */
async function stale(response) {
  const html = await response.text();
  const mark = `${MARK}${response.headers.get("ug-at") || ""}">`;
  return new Response(html.replace(/<head>/i, (head) => head + mark), {
    headers: { "Content-Type": "text/html; charset=utf-8" },
  });
}

async function page(event) {
  const url = new URL(event.request.url);
  try {
    // preloadResponse is undefined where navigation preload is unsupported,
    // and settles to undefined where it is supported but not yet enabled.
    const response = (await event.preloadResponse) || (await fetch(event.request));
    if (response.status === 200) event.waitUntil(keepPage(url, response));
    return response;
  } catch {
    const cache = await caches.open(PAGES);
    // Its own copy, then its section's shell, then any shell: a working app
    // to move around in beats a page with nothing on it but Retry.
    for (const key of [url.pathname + url.search, shellOf(url), ...SHELLS]) {
      const hit = await cache.match(key, ANY);
      if (hit) return stale(hit);
    }
    return offline();
  }
}

/** Tell the page behind a request that it is reading a copy. */
function tell(event) {
  event.waitUntil(
    self.clients.get(event.clientId).then((client) => client?.postMessage({ ug: "offline" })),
  );
}

async function api(event) {
  try {
    const response = await fetch(event.request);
    if (response.status === 200) event.waitUntil(keep(API, event.request, response.clone()));
    else if (response.status === 401) event.waitUntil(caches.delete(API));
    return response;
  } catch (cause) {
    const hit = await caches.match(event.request, { ...ANY, cacheName: API });
    if (!hit) throw cause;
    tell(event);
    return hit;
  }
}

async function asset(event, hashed) {
  if (hashed) {
    const hit = await caches.match(event.request, { ...ANY, cacheName: ASSETS });
    if (hit) return hit;
  }
  try {
    const response = await fetch(event.request);
    // 200 only: a 206 (a voice memo, played in ranges) is a slice, and a cache refuses one.
    if (response.status === 200) event.waitUntil(keep(ASSETS, event.request, response.clone()));
    return response;
  } catch (cause) {
    const hit = await caches.match(event.request, { ...ANY, cacheName: ASSETS });
    if (!hit) throw cause;
    tell(event);
    return hit;
  }
}

/**
 * Fetch the shells and the bundles each names in a <script src>, so the app
 * opens offline even where nothing was ever visited through this worker: an
 * upgrade from a worker that kept nothing, say, whose last pages it never saw.
 * Best effort: an install while offline keeps whatever it got.
 */
async function precache() {
  await Promise.all(
    SHELLS.map(async (path) => {
      try {
        const response = await fetch(path, { credentials: "same-origin" });
        if (response.status !== 200) return;
        const html = await response.clone().text();
        await keep(PAGES, path, response);
        const scripts = [...html.matchAll(/<script\b[^>]*\bsrc="(\/[^"]+)"/g)].map((m) => m[1]);
        await Promise.all(
          scripts.map(async (src) => {
            if (await caches.match(src, { ...ANY, cacheName: ASSETS })) return;
            const bundle = await fetch(src);
            if (bundle.status === 200) await keep(ASSETS, src, bundle);
          }),
        );
      } catch {
        // Offline mid-install: the next visit fills it in.
      }
    }),
  );
}

self.addEventListener("install", (event) => {
  self.skipWaiting();
  event.waitUntil(precache());
});

self.addEventListener("activate", (event) => {
  event.waitUntil(
    Promise.all([
      self.clients.claim(),
      self.registration.navigationPreload?.enable(),
      // Caches a past version named and this one does not.
      caches.keys().then((names) => Promise.all(names.filter((n) => !(n in KEEP)).map((n) => caches.delete(n)))),
    ]),
  );
});

self.addEventListener("fetch", (event) => {
  const request = event.request;
  const url = new URL(request.url);
  if (url.origin !== self.location.origin || request.cache === "no-store") return;
  if (request.method !== "GET") {
    // Logging out takes this device's copies of the account with it.
    if (url.pathname === "/api/social/logout") event.waitUntil(caches.delete(API));
    return;
  }
  if (request.mode === "navigate") event.respondWith(page(event));
  else if (url.pathname.startsWith("/api/")) event.respondWith(api(event));
  else if (url.pathname !== "/sw.js") event.respondWith(asset(event, url.searchParams.has("v")));
});

/**
 * client/offline, on a page loaded before this worker was in charge: the
 * addresses that page already fetched, so the first visit is enough for the
 * next one to open offline.
 */
self.addEventListener("message", (event) => {
  const urls = event.data?.ugSeed;
  if (!Array.isArray(urls)) return;
  event.waitUntil(
    Promise.all(
      urls.slice(0, 100).map(async (href) => {
        const url = new URL(href, self.location.origin);
        if (url.origin !== self.location.origin || url.pathname === "/sw.js") return;
        try {
          const response = await fetch(url, { credentials: "same-origin" });
          if (response.status !== 200) return;
          if (url.href === event.data.page) await keepPage(url, response);
          else if (url.pathname.startsWith("/api/")) await keep(API, url.href, response);
          else await keep(ASSETS, url.href, response);
        } catch {
          // Gone offline mid-seed: whatever made it in is still worth having.
        }
      }),
    ),
  );
});
