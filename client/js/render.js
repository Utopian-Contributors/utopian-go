/**
 * SERP rendering: tabs, web/news/video/discussion lists, images, knowledge panel.
 */
import {
  $,
  clearResults,
  crossfadeImageSkeleton,
  el,
  hideSkeleton,
  setLoading,
  setStatus,
  showSkeleton,
} from "./dom.js";
import { appendSanitized, host, plainText } from "./text.js";
import { TABS, writeUrl } from "./url.js";
import { cite, resultCard, snippet, titleLink, videoThumb } from "./pieces.js";
import { tokenCards } from "./token.js";

/** @typedef {import('../../src/types').SearchApiResponse} SearchApiResponse */
/** @typedef {import('../../src/types').ImageItem} ImageItem */
/** @typedef {import('../../src/types').WebResult} WebResult */
/** @typedef {import('../../src/types').NewsItem} NewsItem */
/** @typedef {import('../../src/types').VideoItem} VideoItem */
/** @typedef {import('../../src/types').DiscussionItem} DiscussionItem */
/** @typedef {import('../../src/types').FaqItem} FaqItem */

/**
 * Mutable view model owned by main.js and passed into paint helpers.
 * @typedef {{
 *   data: SearchApiResponse | null,
 *   images: ImageItem[] | null,
 *   imagesQuery: string,
 *   selectedImage: ImageItem | null,
 *   tab: string,
 *   lastQuery: string,
 *   requestId: number,
 *   activeController: AbortController | null,
 * }} ViewState
 */

/** Image tile cell — must stay in sync with `.ig-item` sizing in app.css. */
const TILE_MAX_W = 220;
const TILE_MAX_H = 160;

/** @param {ViewState} state */
export function createRenderer(state) {
  const results = $("rs");
  const side = $("sd");
  const tabsEl = $("tb");
  const main = $("mn");

  function tabAvailability() {
    const d = state.data;
    const busy = document.body.classList.contains("ld");
    // While loading, treat the active surface as “available” for highlighting only;
    // buttons stay disabled via `busy` in renderTabs.
    return {
      web: !!d || (busy && state.tab === "web"),
      images: !!state.lastQuery,
      news: !!d?.news?.length,
      videos: !!d?.videos?.length,
      discussions: !!d?.discussions?.length,
    };
  }

  function ensureTabAvailable() {
    // Don’t bounce the active tab during load (data may not be ready yet)
    if (document.body.classList.contains("ld")) return;
    const available = tabAvailability();
    if (!available[state.tab]) state.tab = "web";
  }

  function renderTabs() {
    // Show nav as soon as we have a query (including first load) — not only after results
    if (!state.data && !state.lastQuery) return;

    const available = tabAvailability();
    ensureTabAvailable();
    const busy = document.body.classList.contains("ld");

    tabsEl.hidden = false;
    tabsEl.setAttribute("aria-busy", busy ? "true" : "false");
    tabsEl.replaceChildren();

    for (const [key, label] of TABS) {
      const btn = el("button", {
        type: "button",
        class: "tab" + (state.tab === key ? " on" : ""),
        text: label,
        // Loading: every tab disabled. Idle: only tabs with results enabled.
        disabled: busy || !available[key],
        onclick: () => {
          if (document.body.classList.contains("ld")) return;
          if (state.tab === key || !available[key]) return;
          state.tab = key;
          if (key !== "images") state.selectedImage = null;
          writeUrl(state.lastQuery || state.data?.query || "", state.tab, "push");
          renderTabs();
          paint();
        },
      });
      tabsEl.append(btn);
    }
  }

  function clearSide() {
    main.classList.remove("solo");
    side.hidden = false;
    side.replaceChildren();
  }

  function paint() {
    clearResults();
    if (!state.data && state.tab !== "images") return;

    if (state.tab === "images") {
      loadAndPaintImages();
      return;
    }

    main.classList.remove("solo");
    side.hidden = false;

    if (state.tab === "web") {
      // Price answers the query — it leads, above the organic results.
      const tokens = state.data?.tokens;
      if (tokens?.length) results.append(tokenCards(tokens));
      paintWeb(state.data?.results || []);
      paintSide();
    } else if (state.tab === "news") {
      paintList(state.data?.news || [], false);
      clearSide();
    } else if (state.tab === "videos") {
      paintList(state.data?.videos || [], true);
      clearSide();
    } else {
      paintList(state.data?.discussions || [], false);
      clearSide();
    }

    if (
      state.tab === "web" &&
      !(state.data?.results || []).length &&
      !state.data?.infobox &&
      !state.data?.tokens?.length
    ) {
      setStatus("No results.");
    }

    // Keep sticky chrome height + side max in sync after layout changes
    syncSideMax();
  }

  /** @param {WebResult[]} items */
  function paintWeb(items) {
    const frag = document.createDocumentFragment();
    items.forEach((item, i) => {
      const card = resultCard(i, cite(item), titleLink(item), snippet(item));
      if (item.cluster?.length) {
        const sl = el("div", { class: "sl" });
        for (const c of item.cluster) {
          const a = el("a", {
            href: c.url,
            target: "_blank",
            rel: "noopener",
            text: plainText(c.title),
          });
          if (c.description) {
            const sub = el("i");
            appendSanitized(sub, c.description);
            a.append(sub);
          }
          sl.append(a);
        }
        card.append(sl);
      }
      frag.append(card);
    });
    results.append(frag);
  }

  /**
   * @param {Array<NewsItem | VideoItem | DiscussionItem>} items
   * @param {boolean} isVideo
   */
  function paintList(items, isVideo) {
    const frag = document.createDocumentFragment();
    items.forEach((item, i) => {
      if (isVideo) {
        const thumb = "thumbnail" in item ? item.thumbnail?.src : null;
        const body = el("div", null, cite(item), titleLink(item), snippet(item));
        frag.append(
          resultCard(i, el("div", { class: "vr" }, videoThumb(thumb), body)),
        );
      } else {
        frag.append(resultCard(i, cite(item), titleLink(item), snippet(item)));
      }
    });
    results.append(frag);
    if (!items.length) setStatus("No results.");
  }

  async function loadAndPaintImages() {
    const q = state.lastQuery || state.data?.query || "";
    if (!q) {
      setStatus("No results.");
      return;
    }

    if (state.images && state.imagesQuery === q) {
      setLoading(false);
      renderTabs();
      paintImagesView();
      return;
    }

    state.selectedImage = null;
    // Reuse skeleton if runSearch already put it up (no rebuild / reflow)
    showSkeleton("images");
    setLoading(true);
    renderTabs(); // refresh disabled state while busy
    setStatus("");
    // Stay solo the entire load — never flash the two-column shell
    main.classList.add("solo");
    side.hidden = true;
    side.replaceChildren();
    // Keep skeleton; only clear the results pane
    results.replaceChildren();

    const id = ++state.requestId;
    state.activeController?.abort();
    state.activeController = new AbortController();

    try {
      const res = await fetch(`/api/images?q=${encodeURIComponent(q)}`, {
        headers: { Accept: "application/json" },
        signal: state.activeController.signal,
      });
      /** @type {import('../../src/types').ImageSearchApiResponse} */
      const json = await res.json();
      if (id !== state.requestId || state.tab !== "images") return;

      setLoading(false);
      renderTabs();

      if (json.error) {
        hideSkeleton();
        setStatus(json.error, true);
        return;
      }

      state.images = json.images || [];
      state.imagesQuery = q;
      // Soft crossfade skeleton → real grid (no hard cut)
      paintImagesView({ crossfade: true });
    } catch (err) {
      if (/** @type {Error} */ (err)?.name === "AbortError" || id !== state.requestId)
        return;
      hideSkeleton();
      setLoading(false);
      renderTabs();
      setStatus("Something went wrong.", true);
    }
  }

  /**
   * Layout: full grid, or collapsed grid + right-hand detail.
   * @param {{ crossfade?: boolean }} [opts]
   */
  function paintImagesView(opts = {}) {
    // Don’t call clearResults() — it also clears status. Only swap the grid.
    results.replaceChildren();
    const items = state.images || [];
    if (!items.length) {
      hideSkeleton();
      main.classList.add("solo");
      side.hidden = true;
      side.replaceChildren();
      setStatus("No results.");
      return;
    }

    const selected = state.selectedImage;
    /** @type {HTMLElement | null} */
    let grid = null;
    if (selected) {
      main.classList.remove("solo");
      side.hidden = false;
      grid = paintImageGrid(items, selected, { soft: true });
      paintImageDetail(selected);
      hideSkeleton();
    } else {
      main.classList.add("solo");
      side.hidden = true;
      side.replaceChildren();
      grid = paintImageGrid(items, null, {
        soft: !!opts.crossfade,
        reveal: !!opts.crossfade,
      });
      if (opts.crossfade) crossfadeImageSkeleton(grid);
      else hideSkeleton();
    }
    syncSideMax();
  }

  /**
   * Tile box, computed before a single byte of image data arrives.
   *
   * The grid can only be stable if every tile knows its final size up front.
   * Brave gives us intrinsic dimensions, so we scale them into the 220x160
   * cell ourselves rather than letting `max-width`/`auto` resolve on decode —
   * which is what made each arriving image reflow everything after it.
   * @param {ImageItem} item
   * @returns {[number, number]}
   */
  function tileBox(item) {
    const w = Number(item.width);
    const h = Number(item.height);
    // No dimensions from the API: reserve a typical 4:3 cell so the tile still
    // holds its place. Slight crop beats a collapsing grid.
    if (!w || !h) return [200, 150];
    // Never upscale — small thumbnails keep their intrinsic size, as before.
    const scale = Math.min(TILE_MAX_W / w, TILE_MAX_H / h, 1);
    return [
      Math.max(1, Math.round(w * scale)),
      Math.max(1, Math.round(h * scale)),
    ];
  }

  /**
   * @param {ImageItem} item
   * @param {ImageItem | null} selected
   */
  function sameImage(item, selected) {
    if (!selected) return false;
    return (
      item === selected ||
      ((item.image || item.thumbnail || "") ===
        (selected.image || selected.thumbnail || "") &&
        item.url === selected.url)
    );
  }

  /**
   * @param {ImageItem[]} items
   * @param {ImageItem | null} selected
   * @param {{ soft?: boolean, reveal?: boolean }} [opts]
   *   soft — no per-tile stagger (used when crossfading from skeleton)
   *   reveal — start at opacity 0 for crossfade
   * @returns {HTMLElement | null}
   */
  function paintImageGrid(items, selected, opts = {}) {
    const classes = ["ig"];
    if (selected) classes.push("is-open");
    if (opts.soft) classes.push("ig-soft");
    if (opts.reveal) classes.push("ig-reveal");

    const grid = el("div", { class: classes.join(" ") });
    let shown = 0;

    for (const item of items) {
      const src = item.thumbnail || item.image;
      if (!src) continue;

      const on = sameImage(item, selected);
      const btn = el("button", {
        type: "button",
        class: "ig-item" + (on ? " on" : ""),
        title: plainText(item.title || item.source || "Image"),
        onclick: () => {
          // Toggle: click again closes the detail panel
          state.selectedImage = on ? null : item;
          paintImagesView();
        },
      });
      // Final geometry now, so nothing below this tile ever moves again.
      const [boxW, boxH] = tileBox(item);
      btn.style.width = `${boxW}px`;
      btn.style.height = `${boxH}px`;

      const img = el("img", {
        src,
        alt: plainText(item.title || "Image result"),
        // Eager: primary content; the tile already reserved its space.
        loading: "eager",
        decoding: "async",
        width: boxW,
        height: boxH,
      });

      // Each image fades in on its own decode. Tying the reveal to the actual
      // load event — rather than a fixed stagger — means you never watch an
      // empty box animate in and then pop when the pixels arrive.
      const reveal = () => img.classList.add("is-in");
      if (img.complete && img.naturalWidth) reveal();
      else img.addEventListener("load", reveal, { once: true });

      img.addEventListener(
        "error",
        () => {
          // Keep the reserved box. Removing a tile reflows every tile after it,
          // and a dead thumbnail can arrive seconds late — measured as the
          // single largest layout shift on this view. Leave a neutral cell.
          btn.classList.add("is-broken");
          img.remove();
          if (!grid.querySelector(".ig-item:not(.is-broken)")) {
            setStatus("No results.");
          }
        },
        { once: true },
      );

      btn.append(
        img,
        el("div", {
          class: "ig-cap",
          text: plainText(item.source || item.title || ""),
        }),
      );
      grid.append(btn);
      shown += 1;
    }

    if (!shown) {
      setStatus("No results.");
      return null;
    }
    results.append(grid);
    return grid;
  }

  /** @param {ImageItem} item */
  function paintImageDetail(item) {
    side.replaceChildren();

    const panel = el("div", { class: "pn pn-img" });
    const full = item.image || item.thumbnail || "";
    const thumb = item.thumbnail || item.image || "";

    panel.append(
      el("button", {
        type: "button",
        class: "pn-close",
        text: "Close",
        "aria-label": "Close image detail",
        onclick: () => {
          state.selectedImage = null;
          paintImagesView();
        },
      }),
    );

    if (full) {
      const img = el("img", {
        class: "ph-lg",
        src: full,
        alt: plainText(item.title || "Selected image"),
      });
      // Fall back to thumbnail if full-size fails
      if (thumb && thumb !== full) {
        img.addEventListener(
          "error",
          () => {
            img.src = thumb;
          },
          { once: true },
        );
      }
      panel.append(img);
    }

    if (item.title) {
      panel.append(el("h2", { text: plainText(item.title) }));
    }

    const sourceLabel =
      item.source || (item.url ? host(item.url) : "") || "";
    if (sourceLabel) {
      panel.append(el("p", { class: "c", text: plainText(sourceLabel) }));
    }

    // Metadata table: dimensions, page, image URL
    const rows = /** @type {[string, string, string?][]} */ ([]);
    if (item.width && item.height) {
      rows.push(["Size", `${item.width} × ${item.height}`]);
    } else if (item.width) {
      rows.push(["Width", String(item.width)]);
    } else if (item.height) {
      rows.push(["Height", String(item.height)]);
    }
    if (item.url) {
      rows.push(["Page", plainText(host(item.url) || item.url), item.url]);
    }
    if (item.image) {
      rows.push(["Image", plainText(host(item.image) || "Original"), item.image]);
    } else if (item.thumbnail && item.thumbnail !== item.image) {
      rows.push([
        "Image",
        plainText(host(item.thumbnail) || "Thumbnail"),
        item.thumbnail,
      ]);
    }

    if (rows.length) {
      const table = el("table", { class: "at" });
      for (const [k, v, href] of rows) {
        const td = el("td");
        if (href) {
          td.append(
            el("a", {
              href,
              target: "_blank",
              rel: "noopener",
              text: v,
            }),
          );
        } else {
          td.textContent = v;
        }
        table.append(el("tr", null, el("th", { text: k }), td));
      }
      panel.append(table);
    }

    const actions = el("div", { class: "pf" });
    if (item.url) {
      actions.append(
        el("a", {
          href: item.url,
          target: "_blank",
          rel: "noopener",
          text: "Visit page",
        }),
      );
    }
    if (item.image || item.thumbnail) {
      actions.append(
        el("a", {
          href: item.image || item.thumbnail || "#",
          target: "_blank",
          rel: "noopener",
          text: "Open image",
        }),
      );
    }
    if (actions.childNodes.length) panel.append(actions);

    side.append(panel);
  }

  function paintSide() {
    const box = state.data?.infobox;
    const faq = state.data?.faq;

    main.classList.remove("solo");
    side.hidden = false;
    side.replaceChildren();

    if (!box && !faq?.length) return;

    const panel = el("div", { class: "pn" });
    const desc = box?.long_desc || box?.description || "";
    const hasPrimary = !!(box && (box.title || box.category || desc));
    const hasExtras = !!(
      box?.thumbnail ||
      box?.attributes?.length ||
      box?.profiles?.length ||
      desc.length > 160
    );
    const hasFaq = !!faq?.length;

    if (hasFaq && !hasPrimary && !hasExtras) {
      panel.append(buildFaqSection(faq, true));
      side.append(panel);
      syncSideMax();
      return;
    }

    if (hasPrimary) {
      if (box.title) panel.append(el("h2", { text: plainText(box.title) }));
      if (box.category) {
        panel.append(el("p", { class: "c", text: plainText(box.category) }));
      }
      if (desc) {
        panel.append(el("p", { class: "ld", text: plainText(desc) }));
      }
    }

    const more = el("div", { class: "pn-x" });
    let fold = desc.length > 160;
    if (fold) panel.classList.add("pn-clip");

    if (box?.thumbnail) {
      fold = true;
      more.append(
        el("img", {
          class: "ph",
          src: box.thumbnail,
          alt: "",
          loading: "lazy",
        }),
      );
    }

    if (box?.attributes?.length) {
      fold = true;
      const table = el("table", { class: "at" });
      for (const [k, v] of box.attributes) {
        const key = plainText(k).replace(/\s+\(/g, "(");
        const val = plainText(v);
        // Defensive: skip empty / literal "null" rows if an old API response slips through
        if (!key || !val || /^(null|undefined)$/i.test(val)) continue;

        const td = el("td");
        if (/^https?:\/\//i.test(val)) {
          td.append(
            el("a", {
              href: val,
              target: "_blank",
              rel: "noopener",
              text: val,
            }),
          );
        } else {
          td.textContent = val;
        }
        table.append(el("tr", null, el("th", { text: key }), td));
      }
      if (table.childNodes.length) more.append(table);
    }

    if (box?.profiles?.length) {
      fold = true;
      const wrap = el("div", { class: "pf" });
      for (const p of box.profiles) {
        if (!p.url) continue;
        wrap.append(
          el("a", {
            href: p.url,
            target: "_blank",
            rel: "noopener",
            text: plainText(p.name || p.url),
          }),
        );
      }
      more.append(wrap);
    }

    if (hasFaq) {
      fold = true;
      more.append(buildFaqSection(faq, false));
    }

    if (fold) {
      // Expanded by default; user can still collapse via See less
      panel.classList.add("is-open");
      panel.append(more);
      const btn = el("button", {
        type: "button",
        class: "pn-more",
        text: "See less",
        onclick: () => {
          const open = panel.classList.toggle("is-open");
          btn.textContent = open ? "See less" : "See more";
          syncSideMax();
        },
      });
      panel.append(btn);
    }

    side.append(panel);
    syncSideMax();
  }

  /**
   * @param {FaqItem[]} items
   * @param {boolean} solo
   */
  function buildFaqSection(items, solo) {
    const section = el("div", { class: "fq" + (solo ? " fq-solo" : "") });
    section.append(el("h3", { text: "People also ask" }));
    for (const item of items) {
      section.append(
        el(
          "details",
          null,
          el("summary", { text: plainText(item.question) }),
          el("p", { text: plainText(item.answer) }),
        ),
      );
    }
    return section;
  }

  function syncSideMax() {
    const chrome = document.getElementById("chrome");
    if (chrome && document.body.classList.contains("res")) {
      const h = Math.round(chrome.getBoundingClientRect().height);
      document.documentElement.style.setProperty("--chrome-h", `${h}px`);
    } else {
      document.documentElement.style.removeProperty("--chrome-h");
    }

    if (side.hidden || window.matchMedia("(max-width: 900px)").matches) {
      document.documentElement.style.removeProperty("--side-max");
      return;
    }
    const top = side.getBoundingClientRect().top;
    const max = Math.max(
      160,
      Math.round(window.innerHeight - Math.max(0, top) - 8),
    );
    document.documentElement.style.setProperty("--side-max", `${max}px`);
  }

  // Escape closes the image detail panel
  window.addEventListener("keydown", (e) => {
    if (e.key !== "Escape" || !state.selectedImage || state.tab !== "images")
      return;
    state.selectedImage = null;
    paintImagesView();
  });

  return {
    ensureTabAvailable,
    renderTabs,
    paint,
    clearSide,
    syncSideMax,
  };
}
