/**
 * utopian-go SPA — entry point.
 *
 * Home (centered search) ↔ results (tabs + list + knowledge panel).
 * Source is modular; `scripts/build-client.mjs` bundles + minifies to public/.
 */
import { $, clearResults, hideSkeleton, setLoading, setStatus, showSkeleton } from "./dom.js";
import { readUrlState, writeUrl } from "./url.js";
import { createRenderer } from "./render.js";

/** @typedef {import('../../src/types').SearchApiResponse} SearchApiResponse */
/** @typedef {import('../../src/types').ImageItem} ImageItem */

/** @type {import('./render.js').ViewState} */
const state = {
  data: null,
  images: null,
  imagesQuery: "",
  /** @type {ImageItem | null} */
  selectedImage: null,
  tab: "web",
  lastQuery: "",
  requestId: 0,
  activeController: null,
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

document.body.className = "home";

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
  const { q, t } = readUrlState();
  input.value = q;
  syncClearButton();
  state.tab = t;
  if (q) {
    if (state.data && state.lastQuery === q) {
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
  const { q, t } = readUrlState();
  if (q) {
    input.value = q;
    state.tab = t;
    runSearch(q, false, { keepTab: true });
  }
  syncClearButton();
}

// —— Navigation ——

function goHome() {
  state.activeController?.abort();
  state.requestId += 1;
  state.data = null;
  state.images = null;
  state.imagesQuery = "";
  state.selectedImage = null;
  state.lastQuery = "";
  state.tab = "web";
  document.body.className = "home";
  setLoading(false);
  clearResults();
  setStatus("");
  $("sd").hidden = true;
  $("sd").replaceChildren();
  $("tb").hidden = true;
  writeUrl("", "web", "push");
}

/**
 * @param {string} query
 * @param {boolean} pushState
 * @param {{ keepTab?: boolean }} [opts]
 */
async function runSearch(query, pushState, opts = {}) {
  const id = ++state.requestId;
  state.activeController?.abort();
  state.activeController = new AbortController();

  if (!opts.keepTab) state.tab = "web";
  if (pushState) writeUrl(query, state.tab, "push");

  // Set query first so tabs can render immediately (disabled until results)
  state.lastQuery = query;
  if (state.imagesQuery !== query) {
    state.images = null;
    state.imagesQuery = "";
    state.selectedImage = null;
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
    const res = await fetch(`/api/search?q=${encodeURIComponent(query)}`, {
      headers: { Accept: "application/json" },
      signal: state.activeController.signal,
    });
    /** @type {SearchApiResponse} */
    const json = await res.json();
    if (id !== state.requestId) return;

    if (json.error) {
      setLoading(false);
      hideSkeleton();
      setStatus(json.error, true);
      if (!onImages) ui.clearSide();
      ui.renderTabs();
      return;
    }

    state.data = json;
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
