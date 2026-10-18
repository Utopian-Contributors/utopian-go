/**
 * Offline: a page over the app that says the connection failed, with Retry,
 * and a grey logo for as long as what is on screen is not live.
 *
 * Every document loads this, deferred and after its own bundle, so none of the
 * pages' first-flight budgets carries it. The service worker (client/sw) does
 * the keeping; this is what the person sees of it:
 *
 *  - A page the worker served from its cache arrives marked with
 *    <meta name="ug-offline" content="<when it was fetched>">.
 *  - A live page whose API calls start failing is told by the worker, which
 *    answers them from the cache and posts { ug: "offline" }.
 *  - And the browser's own offline event, for the case it does know about.
 *
 * Any of them puts the panel up. Its x takes it down and leaves the last
 * synced state to read underneath; the logo stays grey so that state is never
 * mistaken for live. Retry asks the network directly (no-store, which the
 * worker lets through) and reloads once it answers; so does the connection
 * coming back by itself, on a page that is only the worker's copy.
 *
 * It also seeds the cache. A first visit runs before the worker is in charge,
 * so nothing it fetched went through the worker; once the worker is ready, it
 * is handed the list, and the next visit can open offline.
 */

const CSS = `
body.ug-off .lg-mark{fill:var(--f)}
body.ug-off .lg::after{filter:grayscale(1)}
.ugo{position:fixed;inset:0;z-index:70;display:grid;place-items:center;padding:72px 24px;
 background:var(--bg);text-align:center;font-family:var(--ff);animation:ugo-in .2s ease-out}
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
@media (prefers-reduced-motion:reduce){.ugo{animation:none}}
`;

const X =
  '<svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" ' +
  'stroke-linecap="round" aria-hidden="true"><path d="M6 6l12 12M18 6 6 18"/></svg>';

const meta = document.querySelector('meta[name="ug-offline"]');
/** This page is the worker's copy, not the network's, so it stays grey until a reload. */
const stale = Boolean(meta);
const since = Number(meta?.content) || 0;

/** @type {HTMLElement | null} */
let panel = null;
/** Closed by its x: it stays closed until the connection comes back and goes again. */
let dismissed = false;

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

function close() {
  panel?.remove();
  panel = null;
}

function onKey(e) {
  if (e.key === "Escape" && panel) {
    dismissed = true;
    close();
  }
}

function open() {
  if (panel || dismissed) return;
  if (!document.getElementById("ugo-css")) {
    const style = document.createElement("style");
    style.id = "ugo-css";
    style.textContent = CSS;
    document.head.append(style);
  }
  panel = document.createElement("div");
  panel.className = "ugo";
  panel.setAttribute("role", "alertdialog");
  panel.setAttribute("aria-modal", "true");
  panel.setAttribute("aria-labelledby", "ugo-t");

  const x = document.createElement("button");
  x.type = "button";
  x.className = "ugo-x";
  x.setAttribute("aria-label", "Close, and show what was last synced");
  x.innerHTML = X;
  x.addEventListener("click", () => {
    dismissed = true;
    close();
  });

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
  retry.focus({ preventScroll: true });
}

function goOffline() {
  document.body.classList.add("ug-off");
  open();
}

/**
 * The connection is back. A page that is the worker's copy is reloaded, since
 * all it has to show is old; a live page only lost its connection for a
 * while, so it keeps what is on it and just loses the panel and the grey.
 */
async function backOnline() {
  if (!(await reachable())) return;
  if (stale) return location.reload();
  dismissed = false;
  close();
  document.body.classList.remove("ug-off");
}

addEventListener("keydown", onKey);
addEventListener("offline", goOffline);
addEventListener("online", backOnline);
navigator.serviceWorker?.addEventListener("message", (e) => {
  if (e.data?.ug === "offline") goOffline();
});
if (stale || navigator.onLine === false) goOffline();

// Seed the cache with what this page fetched before the worker was in charge.
if (navigator.serviceWorker && !navigator.serviceWorker.controller && !stale) {
  addEventListener("load", () => {
    navigator.serviceWorker.ready.then((reg) => {
      const urls = performance
        .getEntriesByType("resource")
        .map((entry) => entry.name)
        .filter((name) => name.startsWith(location.origin));
      reg.active?.postMessage({ ugSeed: [location.href, ...urls], page: location.href });
    });
  });
}
