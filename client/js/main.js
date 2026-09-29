/**
 * utopian-go SPA — entry point.
 *
 * Home (centered search) ↔ results (tabs + list + knowledge panel).
 * Source is modular; `scripts/build-client.mjs` bundles + minifies to public/.
 */
import { $, clearResults, el, hideSkeleton, setLoading, setStatus, showSkeleton } from "./dom.js";
import { mountAccount } from "./acct.js";
import { noZoom } from "./device.js";
import { readUrlState, writeUrl } from "./url.js";
import { langParam, mountLang, setLang } from "./lang.js";
import { createRenderer } from "./render.js";
import { paintSaved } from "./saved.js";
import { readTrail, record } from "./trail.js";
import { load } from "./lazy.js";
import { host } from "./text.js";

/** @typedef {import('../../src/types').SearchApiResponse} SearchApiResponse */

/** @type {import('./render.js').ViewState} */
const state = {
  data: null,
  images: null,
  imagesQuery: "",
  tab: "web",
  lastQuery: "",
  requestId: 0,
  activeController: null,
  /** Pages of web results appended below the first one, by Brave's offset. */
  offset: 0,
  /** Whether the server says the next page is worth asking for. */
  more: false,
  /** A continuation page is in flight; only ever one at a time. */
  feeding: false,
  people: [],
};

const form = /** @type {HTMLFormElement} */ ($("f"));
const input = /** @type {HTMLInputElement} */ ($("q"));
const clearBtn = /** @type {HTMLButtonElement} */ ($("cl"));
const clearSep = /** @type {HTMLElement} */ (
  form.querySelector(".sf-sep")
);
const logo = $("lg");

const ui = createRenderer(state);

/** Show clear + divider only when the field has content. */
function syncClearButton() {
  const show = input.value.length > 0;
  clearBtn.hidden = !show;
  clearSep.hidden = !show;
}

// —— Boot ——

// The body class is not set here: the server ships it on the shell, because
// every layout rule hangs off it and this bundle arrives a round trip after
// first paint. Setting it here made the whole header jump into place.

// Before anything else on the boot path: it is a localStorage read and two
// buttons, and the corner of the page it fills is otherwise empty until it
// runs. Nothing here fetches, and nothing here waits on a search.
mountAccount($("ac"));
paintSaved();
noZoom();

const hiveBtn = el("button", { type: "button", class: "hvb", "aria-label": "Places", title: "Places" });
$("hm-tk").append(hiveBtn);
paintHiveBtn();
hiveBtn.addEventListener("click", () => {
  load("hv", "ugHive")
    .then((hive) => hive.open(hiveBtn, paintHiveBtn))
    .catch(() => {});
});

function paintHiveBtn() {
  hiveBtn.hidden = !readTrail().length;
}

/** @param {string} h */
function iconFor(h) {
  const d = state.data;
  if (!d) return;
  for (const list of [d.results, d.news, d.videos, d.discussions])
    for (const r of list || [])
      if (r.meta_url?.favicon && host(r.url) === h) return r.meta_url.favicon;
}

/** @param {MouseEvent} e */
function trailClick(e) {
  if (e.type === "auxclick" && e.button !== 1) return;
  const a = e.target instanceof Element ? e.target.closest("a[href]") : null;
  if (!(a instanceof HTMLAnchorElement) || a.hostname === location.hostname) return;
  if (a.closest("#hv.ed")) return;
  if (a.protocol !== "https:" && a.protocol !== "http:") return;
  const url = new URL(a.href);
  const title = (a.textContent || a.title || "").replace(/\s+/g, " ").trim();
  record(url, title, iconFor(url.hostname.replace(/^www\./, "")));
}
document.addEventListener("click", trailClick, true);
document.addEventListener("auxclick", trailClick, true);

logo.addEventListener("click", (e) => {
  e.preventDefault();
  goHome();
});

form.addEventListener("submit", (e) => {
  e.preventDefault();
  const q = input.value.trim();
  if (q) runSearch(q, true, { keepTab: true });
  else goHome();
});

input.addEventListener("input", syncClearButton);

clearBtn.addEventListener("click", () => {
  input.value = "";
  syncClearButton();
  input.focus();
  // Stay on the current SERP if already searching; only clear the field.
  // Empty submit would go home — intentional field clear only.
});

window.addEventListener("popstate", () => {
  const { q, t, lang } = readUrlState();
  // The URL is what the history entry preserved, the stored preference is not
  // part of it: going back to a search made in German has to land in German,
  // and back past it to one made before that has to leave it again.
  const relanguaged = setLang(lang);
  input.value = q;
  syncClearButton();
  state.tab = t;
  if (q) {
    if (state.data && state.lastQuery === q && !relanguaged) {
      ui.ensureTabAvailable();
      ui.renderTabs();
      ui.paint();
    } else {
      runSearch(q, false, { keepTab: true });
    }
  } else {
    goHome();
  }
});

window.addEventListener("resize", ui.syncSideMax);
window.addEventListener("scroll", ui.syncSideMax, { passive: true });

{
  const { q, t, lang } = readUrlState();
  // Before the boot search, because it settles the language that search asks
  // for. Nothing in it waits on the network — a localStorage read and a value
  // assigned to a <select> the shell has already shipped.
  mountLang(lang, relanguage);
  if (q) {
    input.value = q;
    state.tab = t;
    runSearch(q, false, { keepTab: true });
  }
  syncClearButton();
}

/**
 * A different language for the query already on screen.
 *
 * Re-runs the search rather than repainting it: the language is a parameter of
 * the Brave request, not of the page built from it, so there is nothing here
 * to translate — there is only a different search to make. The images grid
 * goes with it, or the Images tab would answer in the language before last.
 *
 * Replaces the history entry rather than pushing one. It is the same query,
 * and a push would put a back button between someone and the page they were
 * reading a moment ago.
 */
function relanguage() {
  const q = state.lastQuery;
  if (!q) {
    // Home: no search to redo, but the URL still records the choice so a
    // later back-navigation to this entry restores it.
    writeUrl("", "web", "replace");
    return;
  }
  state.images = null;
  state.imagesQuery = "";
  runSearch(q, false, { keepTab: true });
}

// —— Navigation ——

function goHome() {
  window.ugHive?.close(true);
  state.activeController?.abort();
  state.requestId += 1;
  state.data = null;
  state.images = null;
  state.imagesQuery = "";
  state.lastQuery = "";
  state.tab = "web";
  state.offset = 0;
  state.more = false;
  state.feeding = false;
  // Home paints nothing, so neither of these is torn down by a later paint()
  // the way every other exit from a results page is.
  ui.closeImage();
  ui.stopFeed();
  document.body.className = "home";
  setLoading(false);
  clearResults();
  setStatus("");
  $("sd").hidden = true;
  $("sd").replaceChildren();
  $("tb").hidden = true;
  paintSaved();
  paintHiveBtn();
  writeUrl("", "web", "push");
}

/**
 * @param {string} query
 * @param {boolean} pushState
 * @param {{ keepTab?: boolean }} [opts]
 */
async function runSearch(query, pushState, opts = {}) {
  window.ugHive?.close(true);
  const id = ++state.requestId;
  state.activeController?.abort();
  state.activeController = new AbortController();

  if (!opts.keepTab) state.tab = "web";
  if (pushState) writeUrl(query, state.tab, "push");

  // Set query first so tabs can render immediately (disabled until results)
  state.lastQuery = query;
  // A new query starts at its own first page, whatever the last one reached.
  state.offset = 0;
  state.more = false;
  // A continuation for the *previous* query may still be in flight. It drops
  // itself on arrival (loadMore checks requestId), but the flag it set has to
  // come off here or this search's feed waits on a page it will never use.
  state.feeding = false;
  // Open over the *previous* query's grid — only reachable via back/forward,
  // since the dialog covers the search field while it is up.
  ui.closeImage();
  if (state.imagesQuery !== query) {
    state.images = null;
    state.imagesQuery = "";
  }

  state.people = [];
  const who = query.replace(/^@/, "").toLowerCase();
  if (/^[a-z0-9_]{3,16}$/.test(who)) {
    fetch(`/api/social/people?q=${who}`, { signal: state.activeController.signal })
      .then((res) => res.json())
      .then((json) => {
        if (id !== state.requestId || !json.people?.length) return;
        state.people = json.people;
        if (!document.body.classList.contains("ld")) ui.paintPeople();
      })
      .catch(() => {});
  }

  document.body.className = "res";
  setLoading(true);
  const onImages = state.tab === "images";
  // Keep one stable loading chrome for this tab — do not swap layouts mid-flight
  showSkeleton(onImages ? "images" : "web");
  clearResults();
  setStatus("");
  // Nav is part of the results chrome from the first paint — disabled while ld
  ui.renderTabs();
  // clearSide() forces two columns; images stay full-width solo the whole time
  if (onImages) {
    $("mn").classList.add("solo");
    $("sd").hidden = true;
    $("sd").replaceChildren();
  } else {
    ui.clearSide();
  }

  try {
    const res = await fetch(`/api/search?q=${encodeURIComponent(query)}${langParam()}`, {
      headers: { Accept: "application/json" },
      signal: state.activeController.signal,
    });
    /** @type {SearchApiResponse} */
    const json = await res.json();
    if (id !== state.requestId) return;

    if (json.error) {
      setLoading(false);
      hideSkeleton();
      if (!onImages) ui.clearSide();
      ui.renderTabs();
      // Quotes ride along on the same response and survive a web-search
      // failure. Checking a price on a flaky connection is precisely the case
      // the server keeps them for, so paint them instead of dropping them.
      if (json.tokens?.length && state.tab === "web") {
        state.data = json;
        ui.paint();
      }
      // After paint(), never before: it clears the results pane via
      // clearResults(), which resets the status line with it.
      setStatus(json.error, true);
      return;
    }

    state.data = json;
    // Whether there is a page two. The feed reads this and nothing else.
    state.more = !!json.more;
    ui.ensureTabAvailable();
    if (!pushState) writeUrl(query, state.tab, "replace");
    // Images still loading → keep body.ld so tabs stay disabled through paint()
    if (state.tab !== "images") setLoading(false);
    ui.renderTabs();
    // Images tab still needs /api/images — leave the grid skeleton up until then.
    if (state.tab !== "images") hideSkeleton();
    ui.paint();
  } catch (err) {
    if (/** @type {Error} */ (err)?.name === "AbortError" || id !== state.requestId)
      return;
    hideSkeleton();
    setLoading(false);
    setStatus("Something went wrong.", true);
    if (!onImages) ui.clearSide();
    ui.renderTabs();
  }
}
