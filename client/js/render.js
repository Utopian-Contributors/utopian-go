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
import { appendSanitized, host, plainText, safeUrl } from "./text.js";
import { TABS, writeUrl } from "./url.js";
import { langParam } from "./lang.js";
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
 *   tab: string,
 *   lastQuery: string,
 *   requestId: number,
 *   activeController: AbortController | null,
 *   offset: number,
 *   more: boolean,
 *   feeding: boolean,
 *   people: {name: string, bio: string, loc: string, avatarRev: number}[],
 * }} ViewState
 */

/** Image tile cell — must stay in sync with `.ig-item` sizing in app.css. */
const TILE_MAX_W = 220;
const TILE_MAX_H = 160;

/**
 * How far below the viewport the next page starts loading.
 *
 * A result card runs about 110px, so ten of them is roughly one screen:
 * fetching a screen ahead means the results are usually already there when the
 * reader arrives, and no earlier than that — every page is a metered Brave
 * call, and a margin of several screens would spend the whole pagination
 * allowance on someone who stopped reading at the third result.
 */
const FEED_AHEAD_PX = 800;

/** @param {ViewState} state */
export function createRenderer(state) {
  const results = $("rs");
  const side = $("sd");
  const sideCol = $("sc");
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
    // clearResults() emptied #rs, taking the feed marker out of the tree with
    // it. Drop the observation too, so nothing is left watching a detached
    // node while this paint decides whether the feed applies at all.
    feedWatch?.disconnect();
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
      paintPeople();
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
      !state.data?.tokens?.length &&
      !state.people.length
    ) {
      setStatus("No results.");
    }

    // Arms the feed under the web list, or tears it down on the tabs that
    // have nothing behind their first page.
    syncFeed();

    // Keep sticky chrome height + side max in sync after layout changes
    syncSideMax();
  }

  function paintPeople() {
    if (state.tab !== "web" || !state.people.length) return;
    results.prepend(
      el(
        "div",
        { class: "ppg" },
        ...state.people.map((p) =>
          el(
            "a",
            { class: "pp", href: `/social/u/${p.name}` },
            p.avatarRev ? el("img", { src: `/social/t/${p.name}?v=${p.avatarRev}`, alt: "", width: "40" }) : null,
            el("b", { text: p.name }),
            el("span", { text: p.bio || p.loc }),
          ),
        ),
      ),
    );
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
            href: safeUrl(c.url) || "#",
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

  /* —— Infinite feed —— */

  /** @type {IntersectionObserver | null} */
  let feedWatch = null;
  /** The marker under the last result: spinner, then trigger, then epitaph. */
  let feedMark = null;

  /**
   * Arm the feed under the web results, or tear it down.
   *
   * Called after every paint, so it is the one place that decides whether this
   * view paginates at all. Web tab only — and that is the shape of the API
   * rather than a choice: Brave paginates web results with `offset`, its image
   * endpoint takes no offset at any count, and news, videos and discussions
   * arrive complete on the first response with nothing behind them to ask for.
   */
  function syncFeed() {
    feedWatch?.disconnect();
    if (state.tab !== "web") return stopFeed();

    const done = !state.more;
    // Ended without the reader ever having scrolled for it. A first page that
    // fits on one screen does not need a footnote saying it was the only one.
    if (done && !state.offset) return stopFeed();

    if (!feedMark) feedMark = el("div", { class: "fd" });
    // Appending a node already in the tree moves it, so the marker follows the
    // results down rather than blinking out and back between pages.
    results.append(feedMark);

    if (done) {
      feedMark.className = "fd is-end";
      feedMark.textContent = "End of results";
      return;
    }

    feedMark.className = "fd";
    feedMark.textContent = "";
    // An observer rather than a scroll listener: the browser reports the
    // crossing itself, so a flick down the page costs one callback instead of
    // one per frame spent measuring against a scroll position.
    if (!feedWatch) {
      feedWatch = new IntersectionObserver(
        (entries) => {
          if (entries.some((e) => e.isIntersecting)) loadMore();
        },
        { rootMargin: `${FEED_AHEAD_PX}px 0px` },
      );
    }
    feedWatch.observe(feedMark);
  }

  /** Take the feed down entirely — no marker, nothing observed. */
  function stopFeed() {
    feedWatch?.disconnect();
    feedMark?.remove();
    feedMark = null;
  }

  /**
   * Fetch and append the page after the one showing.
   *
   * One page at a time, and only one in flight: the marker stays on screen for
   * as long as the request takes, and every further crossing while it sits
   * there would spend another metered Brave call on the page already coming.
   */
  async function loadMore() {
    if (state.feeding || !state.more) return;
    state.feeding = true;
    feedWatch?.disconnect();
    if (feedMark) feedMark.className = "fd is-on";

    const q = state.lastQuery || state.data?.query || "";
    const next = state.offset + 1;
    // Deliberately not on state.activeController: that one belongs to the
    // search itself, and borrowing it here would let a scroll abort the search
    // that is still painting the page. The id below does the same job from the
    // other end — a page whose query has been replaced is dropped on arrival
    // rather than cancelled in flight.
    const id = state.requestId;

    try {
      const res = await fetch(
        `/api/search?q=${encodeURIComponent(q)}&offset=${next}${langParam()}`,
        { headers: { Accept: "application/json" } },
      );
      /** @type {SearchApiResponse} */
      const json = await res.json();
      // A new search landed while this was out. Its results are the page's
      // now, and appending to them would interleave two queries.
      if (id !== state.requestId || state.tab !== "web") return;

      if (json.error || !json.results?.length) {
        // Brave answered, with nothing. Whatever the reason, there is no page
        // after a page that came back empty.
        state.more = false;
      } else {
        state.offset = next;
        state.more = !!json.more;
        // Appended to the model too, not just to the DOM: going back to this
        // SERP repaints from state.data, and a reader who scrolled to result
        // sixty should not land back on the first ten.
        if (state.data) {
          state.data.results = (state.data.results || []).concat(json.results);
        }
        paintWeb(json.results);
      }
    } catch {
      // A dropped connection is not the end of the results, but it is the end
      // of scrolling for them: re-firing on every crossing would hammer a
      // connection that has already shown it is failing.
      state.more = false;
    } finally {
      state.feeding = false;
      // Moves the marker below what was just painted, and either re-observes
      // it or turns it into the end-of-results line.
      syncFeed();
    }
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

    closeImage();
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
      const res = await fetch(`/api/images?q=${encodeURIComponent(q)}${langParam()}`, {
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
   * The image grid — one layout, the full width of the page.
   *
   * It used to have a second: clicking a tile collapsed the grid into the left
   * column and opened the picture in the right one. The detail is a dialog
   * over the page now, so a click no longer relays the grid out from under the
   * pointer that clicked it, and every tile stays exactly where it was put.
   * @param {{ crossfade?: boolean }} [opts]
   */
  function paintImagesView(opts = {}) {
    // Don’t call clearResults() — it also clears status. Only swap the grid.
    results.replaceChildren();
    main.classList.add("solo");
    side.hidden = true;
    side.replaceChildren();

    const items = state.images || [];
    if (!items.length) {
      hideSkeleton();
      setStatus("No results.");
      return;
    }

    const grid = paintImageGrid(items, {
      soft: !!opts.crossfade,
      reveal: !!opts.crossfade,
    });
    if (opts.crossfade) crossfadeImageSkeleton(grid);
    else hideSkeleton();
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
   * @param {ImageItem[]} items
   * @param {{ soft?: boolean, reveal?: boolean }} [opts]
   *   soft — no per-tile stagger (used when crossfading from skeleton)
   *   reveal — start at opacity 0 for crossfade
   * @returns {HTMLElement | null}
   */
  function paintImageGrid(items, opts = {}) {
    const classes = ["ig"];
    if (opts.soft) classes.push("ig-soft");
    if (opts.reveal) classes.push("ig-reveal");

    const grid = el("div", { class: classes.join(" ") });
    let shown = 0;

    for (const item of items) {
      const src = safeUrl(item.thumbnail) || safeUrl(item.image);
      if (!src) continue;

      const btn = el("button", {
        type: "button",
        class: "ig-item",
        title: plainText(item.title || item.source || "Image"),
        onclick: () => openImage(item, btn),
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

  /* —— Image dialog —— */

  /** The open dialog, or null when there isn't one. */
  let imageBox = null;
  /** The tile that opened it, so focus goes back where it came from. */
  let imageOpener = null;

  /**
   * Open one image over the page: the picture centred in the viewport, what is
   * known about it along the bottom of the screen, and a close control in the
   * top right corner. Clicking the backdrop closes it, as does Escape.
   *
   * A fixed overlay rather than a <dialog>. showModal() wants Safari 15.4, and
   * this project builds for Safari 14.1 (see the targets in
   * scripts/build-client.mjs), so the element would take the image viewer away
   * from browsers the rest of the site still serves — in exchange for a
   * backdrop and a key handler that are a dozen lines to write.
   *
   * @param {ImageItem} item
   * @param {HTMLElement} opener the tile clicked, refocused on close
   */
  function openImage(item, opener) {
    closeImage();
    imageOpener = opener;

    const full = safeUrl(item.image) || safeUrl(item.thumbnail);
    const thumb = safeUrl(item.thumbnail) || safeUrl(item.image);
    const label = plainText(item.title || item.source || "Image");

    const box = el("div", {
      class: "lb",
      role: "dialog",
      "aria-modal": "true",
      "aria-label": label,
      // The picture, the metadata bar and the close button are its only
      // children, so "the event landed on the overlay itself" is precisely
      // "the pointer went down outside the dialog's content".
      onclick: (e) => {
        if (e.target === box) closeImage();
      },
    });

    const shut = el("button", {
      type: "button",
      class: "lb-x",
      "aria-label": "Close image",
      text: "\u00d7",
      onclick: closeImage,
    });

    if (full) {
      const img = el("img", { class: "lb-img", src: full, alt: label });
      // The grid is built from Brave's thumbnails; the full size lives on
      // whichever site the crawler found it on, and that one may well refuse
      // us. Falling back keeps a dead original from opening an empty dialog.
      if (thumb && thumb !== full) {
        img.addEventListener(
          "error",
          () => {
            img.src = thumb;
          },
          { once: true },
        );
      }
      box.append(img);
    }

    box.append(shut, imageMeta(item));
    document.body.append(box);
    // Holds the page still underneath: a modal that scrolls the results behind
    // it loses the reader's place in the grid they came from.
    document.body.classList.add("lb-on");
    imageBox = box;
    // Focus moves in, so Escape and Tab belong to the dialog rather than to
    // the grid still sitting behind it.
    shut.focus();
  }

  function closeImage() {
    if (!imageBox) return;
    imageBox.remove();
    imageBox = null;
    document.body.classList.remove("lb-on");
    imageOpener?.focus();
    imageOpener = null;
  }

  /**
   * The bar along the bottom of the screen: what the picture is, where it came
   * from, and how to get to either.
   *
   * A line of text rather than the label/value table the side panel used. The
   * table had a row per fact because it had a whole column to fill; along the
   * foot of a photo the same three facts read as one sentence, and the picture
   * keeps the height they would have taken.
   * @param {ImageItem} item
   */
  function imageMeta(item) {
    const bar = el("div", { class: "lb-meta" });
    if (item.title) bar.append(el("h2", { text: plainText(item.title) }));

    const facts = [
      plainText(item.source || (item.url ? host(item.url) : "")),
      item.width && item.height ? `${item.width} \u00d7 ${item.height}` : "",
    ].filter(Boolean);
    if (facts.length) {
      bar.append(el("p", { class: "c", text: facts.join(" \u00b7 ") }));
    }

    const links = el("div", { class: "pf" });
    for (const [text, raw] of [
      ["Visit page", item.url],
      ["Open image", item.image || item.thumbnail],
    ]) {
      const href = safeUrl(raw);
      if (href) {
        links.append(
          el("a", { href, target: "_blank", rel: "noopener", text }),
        );
      }
    }
    if (links.childNodes.length) bar.append(links);
    return bar;
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
      // src is withheld until the panel is expanded. Hiding the element with
      // display:none would not stop the fetch — only an absent src does.
      more.append(
        el("img", {
          class: "ph",
          "data-src": safeUrl(box.thumbnail),
          alt: "",
          loading: "lazy",
        }),
      );
    }

    if (box?.attributes?.length) {
      fold = true;
      const table = el("table", { class: "at" });
      for (const [k, v] of box.attributes) {
        // "Developer (s)" → "Developer(s)"; a real parenthetical keeps its space
        const key = plainText(k).replace(/\s+\((s|es|e|n|en|r|in|innen)\)/gi, "($1)");
        // A multi-value row arrives newline-joined — split before plainText,
        // which collapses every run of whitespace and would fuse the values.
        const lines = String(v)
          .split("\n")
          .map((line) => plainText(line))
          // Defensive: drop empty / literal "null" lines if an old API response slips through
          .filter((line) => line && !/^(null|undefined)$/i.test(line));
        if (!key || !lines.length) continue;

        const td = el("td");
        if (lines.length === 1 && /^https?:\/\//i.test(lines[0])) {
          td.append(
            el("a", {
              href: lines[0],
              target: "_blank",
              rel: "noopener",
              text: lines[0],
            }),
          );
        } else {
          // Rendered as separate lines by `white-space: pre-line` on .at td
          td.textContent = lines.join("\n");
        }
        table.append(el("tr", null, el("th", { text: key }), td));
      }
      if (table.childNodes.length) more.append(table);
    }

    if (box?.profiles?.length) {
      fold = true;
      const wrap = el("div", { class: "pf" });
      for (const p of box.profiles) {
        const href = safeUrl(p.url);
        if (!href) continue;
        wrap.append(
          el("a", {
            href,
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
      // Collapsed by default: the panel's extras cost nothing until asked for.
      panel.append(more);
      const btn = el("button", {
        type: "button",
        class: "pn-more",
        text: "See more",
        "aria-expanded": "false",
        onclick: () => {
          const open = panel.classList.toggle("is-open");
          if (open) hydrateDeferredImages(panel);
          btn.textContent = open ? "See less" : "See more";
          btn.setAttribute("aria-expanded", String(open));
          syncSideMax();
        },
      });
      panel.append(btn);
    }

    side.append(panel);
    syncSideMax();
  }

  /**
   * Promote deferred `data-src` images to real requests. Called on first
   * expand, so a collapsed knowledge panel never costs a byte of image traffic
   * (and never hits a third-party CDN) on page load.
   * @param {HTMLElement} root
   */
  function hydrateDeferredImages(root) {
    for (const img of root.querySelectorAll("img[data-src]")) {
      const src = img.getAttribute("data-src");
      if (!src) continue;
      // Re-checked on promotion as well as on write: this reads an attribute
      // back out of the DOM, so the check belongs where the value becomes a
      // request rather than only where it was first put there.
      const url = safeUrl(src);
      img.removeAttribute("data-src");
      if (url) img.setAttribute("src", url);
    }
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
    // Whatever sits below the panel inside the pinned column — the footer and
    // its margin. The cap has to leave room for it: measured against the
    // viewport alone, a tall panel pushes the footer below the fold, and being
    // pinned there means it never comes back up.
    const below = Math.max(
      0,
      Math.round(
        sideCol.getBoundingClientRect().bottom -
          side.getBoundingClientRect().bottom,
      ),
    );
    const max = Math.max(
      160,
      Math.round(window.innerHeight - Math.max(0, top) - 8 - below),
    );
    document.documentElement.style.setProperty("--side-max", `${max}px`);
  }

  // Escape closes the image dialog. No tab or state check in front of it —
  // closeImage() returns on its own when there is nothing open, which is one
  // condition instead of three that have to keep agreeing with each other.
  window.addEventListener("keydown", (e) => {
    if (e.key === "Escape") return closeImage();

    // Keep Tab inside the dialog while it is up. A <dialog> would do this for
    // us, and not using one (see openImage) is what leaves it to be written:
    // an overlay only covers the page visually, so without this the next Tab
    // walks into the grid behind it, focusing links nobody can see and cannot
    // scroll to. Three stops at most, so the whole trap is its two edges.
    if (e.key !== "Tab" || !imageBox) return;
    const stops = imageBox.querySelectorAll("button, a[href]");
    if (!stops.length) return;
    const last = stops.length - 1;
    const edge = e.shiftKey ? stops[0] : stops[last];
    if (document.activeElement === edge || !imageBox.contains(document.activeElement)) {
      e.preventDefault();
      stops[e.shiftKey ? last : 0].focus();
    }
  });

  return {
    ensureTabAvailable,
    renderTabs,
    paint,
    paintPeople,
    clearSide,
    syncSideMax,
    closeImage,
    stopFeed,
  };
}
