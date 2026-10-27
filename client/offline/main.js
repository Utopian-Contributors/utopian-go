/**
 * Offline: a page over the app that says the connection failed, with Retry,
 * and a grey logo for as long as what is on screen is not live.
 *
 * Every document loads this, deferred and after its own bundle, so none of the
 * pages' first-flight budgets carries it. The service worker (client/sw) does
 * the keeping; this is what the person sees of it:
 *
 *  - A page the worker served from its cache arrives marked with
 *    <meta name="ug-offline" content="<when it was fetched>" data-etag>.
 *  - A live page whose API calls start failing, or hanging, is told by the
 *    worker, which answers them from the cache and posts { ug: "offline",
 *    url, etag }; and { ug: "online", changed } if the network answers after
 *    all, with whether that answer holds anything the copy did not.
 *  - And the browser's own offline event, for the case it does know about.
 *
 * Any of them puts the panel up. Its x takes it down and leaves the last
 * synced state to read underneath, for the rest of that outage: closed once,
 * it stays closed on every page until the connection is back. The logo stays
 * grey meanwhile, so that state is never mistaken for live. Retry asks the
 * network directly (no-store, which the worker lets through) and reloads once
 * it answers.
 *
 * When the connection comes back by itself, Update is offered only if what
 * is on screen is actually out of date. Every copy shown has a tag, the hash
 * of the state it holds (src/state.ts); the server is asked about each by its
 * tag alone, and answers 304 and nothing more when the state is the same. One
 * 200 is a difference, and gets the Update button rather than a reload nobody
 * asked for: floating over the content, on top of the bottom tabs on a
 * phone, under the search field on a wide screen.
 *
 * It also seeds the cache. A first visit runs before the worker is in charge,
 * and the first after an update under the old one, so nothing it fetched
 * went through the worker now in charge; that worker is handed the list, and
 * the next visit can open offline.
 */

import { createElement } from "skeu-icons";
import CloudDownload from "skeu-icons/icons/cloud-download";
import Close from "skeu-icons/icons/x";

const CSS = `
body.ug-off .lg-mark{fill:var(--f)}
body.ug-off .lg::after{filter:grayscale(1)}
.ugo{position:fixed;inset:0;display:grid;place-items:center;box-sizing:border-box;width:100%;height:100%;
 max-width:none;max-height:none;margin:0;padding:72px 24px;border:0;border-radius:0;
 background:var(--bg);color:var(--t);text-align:center;font-family:var(--ff);animation:ugo-in .2s ease-out}
.ugo::backdrop{background:transparent}
@keyframes ugo-in{from{opacity:0}}
.ugo p{max-width:360px;margin:0 0 28px;color:var(--f);font-size:18px;line-height:1.5}
.ugo-r{min-width:180px;padding:15px 36px;border:0;border-radius:999px;background:var(--buy);
 color:var(--buy-ink);font:600 17px/1 var(--ff);cursor:pointer}
.ugo-r:disabled{opacity:.7;cursor:progress}
.ugo-r:focus-visible,.ugo-x:focus-visible{outline:2px solid var(--buy);outline-offset:3px}
.ugo small{display:block;margin-top:18px;color:var(--f);font-size:13px}
.ugo-x{position:absolute;top:max(12px,env(safe-area-inset-top));right:12px;display:grid;place-items:center;
 width:44px;height:44px;border:0;border-radius:50%;background:none;color:var(--f);cursor:pointer}
.ugo-x:hover{background:rgba(127,127,127,.14)}
.ugu{position:fixed;z-index:65;display:inline-flex;align-items:center;gap:8px;padding:12px 22px 12px 18px;
 border:0;border-radius:999px;background:var(--buy);color:var(--buy-ink);font:600 15px/1 var(--ff);
 box-shadow:0 6px 24px rgba(0,0,0,.22);transform:translateX(-50%);cursor:pointer;animation:ugu-in .25s ease-out}
.ugu:focus-visible{outline:2px solid var(--buy);outline-offset:3px}
@keyframes ugu-in{from{opacity:0;translate:0 8px}}
@media (prefers-reduced-motion:reduce){.ugo,.ugu{animation:none}}
`;

/** Set by the panel's x, for the tab: the outage it was closed for is not over until the network answers. */
const SHUT = "ug.off.x";

function shut(on) {
  try {
    if (on) sessionStorage.setItem(SHUT, "1");
    else sessionStorage.removeItem(SHUT);
  } catch {
    // No storage: the panel comes back on the next page, which is all this costs.
  }
}

function isShut() {
  try {
    return sessionStorage.getItem(SHUT) === "1";
  } catch {
    return false;
  }
}

const meta = document.querySelector('meta[name="ug-offline"]');
/** This page is the worker's copy, not the network's, so it stays grey until a reload. */
const stale = Boolean(meta);
const since = Number(meta?.content) || 0;

/** @type {HTMLElement | null} */
let panel = null;
/** @type {HTMLElement | null} */
let update = null;
/** Every copy on screen, address to tag: what to ask the server about once the network is back. */
const copies = new Map();
if (stale && meta.dataset.etag) copies.set(location.href, meta.dataset.etag);
/** The worker already saw an answer that differs from a copy on screen. */
let changed = false;

function ago(at) {
  const min = Math.round((Date.now() - at) / 60000);
  if (min < 1) return "just now";
  if (min < 60) return `${min} min ago`;
  const h = Math.round(min / 60);
  if (h < 24) return `${h} h ago`;
  return new Date(at).toLocaleDateString();
}

/** Whether the network answers, asked past the worker so its cache cannot answer instead. */
async function reachable() {
  const stop = new AbortController();
  const timer = setTimeout(() => stop.abort(), 8000);
  try {
    const res = await fetch("/manifest.webmanifest", { method: "HEAD", cache: "no-store", signal: stop.signal });
    return res.ok;
  } catch {
    return false;
  } finally {
    clearTimeout(timer);
  }
}

/** Once, the first time anything here is drawn: the panel, the grey logo or Update. */
function styles() {
  if (document.getElementById("ugo-css")) return;
  const style = document.createElement("style");
  style.id = "ugo-css";
  style.textContent = CSS;
  document.head.append(style);
}

function close() {
  panel?.close();
  panel?.remove();
  panel = null;
}

function dismiss() {
  shut(true);
  close();
}

function open() {
  if (panel || isShut()) return;
  // A modal <dialog>, for the top layer: the login dialog and every other
  // sheet on the site are modal dialogs too, and a plain element under one of
  // them would have its x and Retry out of reach.
  panel = document.createElement("dialog");
  panel.className = "ugo";
  panel.setAttribute("role", "alertdialog");
  panel.setAttribute("aria-labelledby", "ugo-t");
  // Escape closes it the way the x does.
  panel.addEventListener("cancel", (e) => {
    e.preventDefault();
    dismiss();
  });

  const x = document.createElement("button");
  x.type = "button";
  x.className = "ugo-x";
  x.setAttribute("aria-label", "Close, and show what was last synced");
  // The app's marks drawn into the page, not its client/ic-*.svg files: this
  // shows when the network is gone, and a file never fetched would not come.
  x.append(createElement(Close, { size: 16 }));
  x.addEventListener("click", dismiss);

  const text = document.createElement("p");
  text.id = "ugo-t";
  text.textContent =
    "UtopianGo is an Ultra-efficient App to Access the Internet, but we couldn’t make a Connection happen";

  const retry = document.createElement("button");
  retry.type = "button";
  retry.className = "ugo-r";
  retry.textContent = "Retry";
  retry.addEventListener("click", async () => {
    retry.disabled = true;
    retry.textContent = "Connecting…";
    if (await reachable()) return location.reload();
    retry.textContent = "Still offline";
    setTimeout(() => {
      retry.textContent = "Retry";
      retry.disabled = false;
    }, 1500);
  });

  const box = document.createElement("div");
  box.append(text, retry);
  if (since) {
    const note = document.createElement("small");
    note.textContent = `Last synced ${ago(since)}`;
    box.append(note);
  }
  panel.append(x, box);
  document.body.append(panel);
  panel.showModal();
  retry.focus({ preventScroll: true });
}

/**
 * Where Update floats. A phone with Social's bottom tabs: just above them. A
 * phone without: as far off the bottom edge. A wide screen: under the search
 * field, centred on it, or near the top once the field has scrolled away.
 */
function place() {
  if (!update) return;
  const tabs = document.querySelector("body.soc #tb");
  const field = document.querySelector("form.sf");
  update.style.top = update.style.bottom = "";
  if (matchMedia("(max-width: 900px)").matches) {
    const above = tabs ? innerHeight - tabs.getBoundingClientRect().top : 0;
    update.style.bottom = `${above + 16}px`;
    update.style.left = "50%";
  } else if (field) {
    const box = field.getBoundingClientRect();
    update.style.top = `${Math.max(12, box.bottom + 12)}px`;
    update.style.left = `${box.left + box.width / 2}px`;
  } else {
    update.style.top = "16px";
    update.style.left = "50%";
  }
}

function offerUpdate() {
  if (update) return;
  styles();
  update = document.createElement("button");
  update.type = "button";
  update.className = "ugu";
  update.append(createElement(CloudDownload, { size: 20 }), "Update");
  update.addEventListener("click", () => location.reload());
  document.body.append(update);
  place();
}

addEventListener("resize", place);
addEventListener("scroll", place, { passive: true });

/**
 * While offline, ask now and then whether the network is back. A phone that
 * lost its Wi-Fi often hangs rather than fails, and recovers without any
 * "online" event; a page left open would otherwise stay grey until tapped.
 */
const PROBE_EVERY = 15000;
let probing = 0;
function probe() {
  if (probing) return;
  probing = setTimeout(async () => {
    probing = 0;
    if (!document.body.classList.contains("ug-off")) return;
    if (await reachable()) backOnline();
    else probe();
  }, PROBE_EVERY);
}

function goOffline() {
  styles();
  probe();
  document.body.classList.add("ug-off");
  update?.remove();
  update = null;
  open();
}

/** The state half of an ETag (src/state.ts): no W/, no quotes, no ad. */
const stateOf = (tag) => (tag || "").replace(/^W\//, "").replace(/"/g, "").split(".")[0];

/**
 * Whether any copy on screen is out of date, asked by tag alone: a 304 and no
 * body for each that still holds. X-UG-Check takes the request past the
 * worker, and tells the server it is a check, so it never carries an ad.
 * Unanswered counts as unchanged: the next check, or a tap, settles it.
 */
async function outOfDate() {
  const asks = [...copies].map(async ([url, etag]) => {
    const stop = new AbortController();
    const timer = setTimeout(() => stop.abort(), 8000);
    try {
      const res = await fetch(url, {
        headers: { "X-UG-Check": "1", "If-None-Match": etag },
        credentials: "same-origin",
        signal: stop.signal,
      });
      return res.status === 200 && stateOf(res.headers.get("etag")) !== stateOf(etag);
    } catch {
      return false;
    } finally {
      clearTimeout(timer);
    }
  });
  return (await Promise.all(asks)).some(Boolean);
}

/**
 * The connection is back: the panel goes, and with it the grey, and the next
 * outage gets its panel again. Update only if something on screen is out of
 * date; a page whose copies all still hold is as good as live.
 */
let settling = null;
function backOnline() {
  settling ||= (async () => {
    try {
      if (!(await reachable())) return;
      shut(false);
      close();
      document.body.classList.remove("ug-off");
      if (changed || (await outOfDate())) offerUpdate();
      copies.clear();
      changed = false;
    } finally {
      settling = null;
    }
  })();
  return settling;
}

addEventListener("offline", goOffline);
addEventListener("online", backOnline);
navigator.serviceWorker?.addEventListener("message", (e) => {
  const said = e.data || {};
  if (said.ug === "online") {
    if (said.changed) changed = true;
    return void backOnline();
  }
  if (said.ug !== "offline") return;
  if (said.url && said.etag) copies.set(said.url, said.etag);
  goOffline();
});
if (stale || navigator.onLine === false) goOffline();
// A live page means the network answered, so whatever outage the x closed the panel for is over.
else shut(false);

/** Hand the worker in charge everything this page fetched, for it to keep. */
function seed() {
  navigator.serviceWorker.ready.then((reg) => {
    const urls = performance
      .getEntriesByType("resource")
      .map((entry) => entry.name)
      .filter((name) => name.startsWith(location.origin));
    reg.active?.postMessage({ ugSeed: [location.href, ...urls], page: location.href });
  });
}

// Seed the cache with what this page fetched before the worker in charge
// saw it: on a first visit there is no worker yet, and on the first visit
// after an update the old one served the page and the new one takes it over.
if (navigator.serviceWorker && !stale) {
  if (!navigator.serviceWorker.controller) addEventListener("load", seed);
  navigator.serviceWorker.addEventListener("controllerchange", seed);
}
