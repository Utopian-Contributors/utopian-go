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
 *    With a copy in hand the request carries its tag, and an unchanged
 *    answer is a 304 with no body: the copy is the answer (src/state.ts).
 *
 * Every copy keeps its ETag, the hash of the state it holds. When the network
 * comes back, client/offline asks the server about each copy it showed by tag
 * alone, and offers Update only where the state has moved.
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
:root{--bg:#fffff6;--f:#70757a;--buy:#3cc316;--ink:#0b2b06}
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
  const tag = (response.headers.get("etag") || "").replace(/"/g, "&quot;");
  const mark = `${MARK}${response.headers.get("ug-at") || ""}" data-etag="${tag}">`;
  return new Response(html.replace(/<head>/i, (head) => head + mark), {
    headers: { "Content-Type": "text/html; charset=utf-8" },
  });
}

/**
 * How long the network gets before a copy is shown instead, when there is
 * one. A phone that has just lost its Wi-Fi rarely fails a request outright:
 * it hangs, often until the system gives up a minute or more later, and a
 * worker that waits that long on every tap is an app that has stopped. Past
 * this, the copy goes up and the request carries on behind it, so a network
 * that was only slow still refreshes the cache, and the page hears it is
 * back. With no copy there is nothing better to show, so it waits as long as
 * the network takes.
 */
const PATIENCE = { page: 3500, api: 4000, asset: 3000 };

/**
 * A request that gives up after a while. A hung request holds one of the six
 * connections a browser allows a site, and six of them would queue everything
 * after, even once the network is back. Not for pages: a navigation's request
 * is the browser's own, and is not rebuilt here.
 */
const GIVE_UP = 20000;
function fetchFor(request) {
  const stop = new AbortController();
  const timer = setTimeout(() => stop.abort(), GIVE_UP);
  return fetch(request, { signal: stop.signal }).finally(() => clearTimeout(timer));
}

/** The network's answer, or a rejection once `ms` have passed; Infinity waits for good. */
function within(fetching, ms) {
  if (ms === Infinity) return fetching;
  let timer;
  const late = new Promise((_, reject) => {
    timer = setTimeout(() => reject(new Error("slow")), ms);
  });
  return Promise.race([fetching, late]).finally(() => clearTimeout(timer));
}

/**
 * Until when the network counts as down: set by a request that ran out of
 * patience, cleared by any answer at all. Meanwhile a copy is shown at once,
 * so only the first tap after the connection goes waits; every request still
 * goes out behind it, and the first to come back ends the wait.
 */
let downUntil = 0;
const DOWN_FOR = 30000;

/** The device already knows it has no network, or one just stalled: no point waiting on it. */
const offlineNow = () => self.navigator.onLine === false || Date.now() < downUntil;

/** Tell a page something: that it is reading a copy ("offline"), or that the network answered after all ("online"). */
/**
 * Tell a page something: that it is reading a copy, { ug: "offline" } with
 * the copy's address and tag when it is one worth checking later; or that the
 * network answered after all, { ug: "online", changed } with whether that
 * answer says anything the copy did not.
 */
function tell(event, id, message) {
  event.waitUntil(self.clients.get(id).then((client) => client?.postMessage(message)));
}

/** The state half of an ETag (src/state.ts): no W/, no quotes, no ad. */
const stateOf = (tag) => (tag || "").replace(/^W\//, "").replace(/"/g, "").split(".")[0];

/** Whether an answer holds anything its copy does not, going by their tags alone. */
function differs(response, hit) {
  const a = stateOf(response.headers.get("etag"));
  return !a || a !== stateOf(hit.headers.get("etag"));
}

/** Answers that are the copy itself, confirmed by a 304: nothing changed. */
const confirmed = new WeakSet();

/**
 * Race the network against a copy. `fetching` is the request already on its
 * way, `keepIt` files a good answer. A copy that wins is returned; the
 * network's answer, if it ever comes, is still kept, and the page told.
 */
async function race(event, fetching, hit, ms, keepIt, clientId, judge = (r) => !confirmed.has(r) && differs(r, hit)) {
  // Filed first, so the clone is taken before the page starts reading the body.
  const kept = fetching.then((response) => {
    downUntil = 0;
    return keepIt(response);
  }, () => {});
  event.waitUntil(kept);
  // The copy goes up instead of the network's answer; if that answer comes
  // after all, the page is told the network is back.
  const copy = () => {
    event.waitUntil(
      fetching.then(
        (response) => response.ok && tell(event, clientId, { ug: "online", changed: judge(response) }),
        () => {},
      ),
    );
    return null;
  };
  if (hit && offlineNow()) return copy();
  try {
    return await within(fetching, hit ? ms : Infinity);
  } catch (cause) {
    if (!hit) throw cause;
    if (cause?.message === "slow") downUntil = Date.now() + DOWN_FOR;
    return copy();
  }
}

/** A page's copy: its own, then its section's shell, then any shell. */
async function pageCopy(url) {
  const cache = await caches.open(PAGES);
  // A working app to move around in beats a page with nothing on it but Retry.
  for (const key of [url.pathname + url.search, shellOf(url), ...SHELLS]) {
    const hit = await cache.match(key, ANY);
    if (hit) return hit;
  }
  return null;
}

async function page(event) {
  const url = new URL(event.request.url);
  const hit = await pageCopy(url);
  // preloadResponse is undefined where navigation preload is unsupported,
  // and settles to undefined where it is supported but not yet enabled.
  const fetching = Promise.resolve(event.preloadResponse).then((pre) => pre || fetch(event.request));
  try {
    const response = await race(
      event,
      fetching,
      hit,
      PATIENCE.page,
      (r) => r.status === 200 && keepPage(url, r),
      event.resultingClientId,
    );
    if (response) return response;
  } catch {
    // No copy, and no network: the page that says so.
    return offline();
  }
  return stale(hit);
}

async function api(event) {
  const hit = await caches.match(event.request, { ...ANY, cacheName: API });
  const tag = hit?.headers.get("etag");
  // With a copy, ask with its tag: the server answers 304 and no body when the
  // copy still says what it would (src/state.ts), and the copy is the answer.
  let request = event.request;
  let spare = null;
  if (tag) {
    const headers = new Headers(request.headers);
    headers.set("If-None-Match", tag);
    request = new Request(request, { headers });
    spare = hit.clone();
  }
  const fetching = fetchFor(request).then((r) => {
    if (r.status !== 304 || !spare) return r;
    confirmed.add(spare);
    return spare;
  });
  const response = await race(
    event,
    fetching,
    hit,
    PATIENCE.api,
    (r) => {
      if (r.status === 200) return keep(API, event.request, r.clone());
      // The session is gone, and this device's copy of the account with it.
      if (r.status === 401) return caches.delete(API);
    },
    event.clientId,
  );
  if (response) return response;
  tell(event, event.clientId, { ug: "offline", url: event.request.url, etag: tag });
  return hit;
}

async function asset(event, hashed) {
  const hit = await caches.match(event.request, { ...ANY, cacheName: ASSETS });
  // A hashed copy is the file itself, for good.
  if (hashed && hit) return hit;
  const response = await race(
    event,
    fetchFor(event.request),
    hit,
    PATIENCE.asset,
    // 200 only: a 206 (a voice memo, played in ranges) is a slice, and a cache refuses one.
    (r) => r.status === 200 && keep(ASSETS, event.request, r.clone()),
    event.clientId,
    // A picture or an icon is not what Update is for.
    () => false,
  );
  if (response) return response;
  tell(event, event.clientId, { ug: "offline" });
  return hit;
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
  // A check from client/offline goes to the server and only the server.
  if (url.origin !== self.location.origin || request.cache === "no-store" || request.headers.has("x-ug-check")) return;
  if (request.method !== "GET") {
    // Logging out takes this device's copies of the account with it.
    if (url.pathname === "/api/social/logout") event.waitUntil(caches.delete(API));
    // A write passes straight to the server, but its answer says the network
    // is up. The page's next read shows what was just saved, and must not be
    // handed the copy from before it because a stalled request still has the
    // network counted as down.
    if (url.pathname.startsWith("/api/")) {
      event.respondWith(
        fetch(request).then((response) => {
          downUntil = 0;
          return response;
        }),
      );
    }
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
