/**
 * Tiny DOM helpers. Keep source readable; esbuild minifies identifiers.
 */

/** @param {string} id */
export function $(id) {
  const node = document.getElementById(id);
  if (!node) throw new Error(`#${id} missing`);
  return node;
}

/**
 * Create an element with optional props and children.
 * Props: class, text, on* listeners, booleans (disabled/hidden), or attributes.
 * @param {string} tag
 * @param {Record<string, unknown> | null} [props]
 * @param {...(Node | string | null | undefined | false)} kids
 */
export function el(tag, props, ...kids) {
  const node = document.createElement(tag);
  if (props) {
    for (const [key, val] of Object.entries(props)) {
      if (val == null || val === false) continue;
      if (key === "class") node.className = /** @type {string} */ (val);
      else if (key === "text") node.textContent = /** @type {string} */ (val);
      else if (key.startsWith("on") && typeof val === "function") {
        node.addEventListener(
          key.slice(2).toLowerCase(),
          /** @type {EventListener} */ (val),
        );
      } else if (key === "disabled" || key === "hidden") {
        // @ts-ignore dynamic boolean props
        node[key] = true;
      } else {
        node.setAttribute(key, val === true ? "" : String(val));
      }
    }
  }
  for (const kid of kids) {
    if (kid != null && kid !== false) node.append(kid);
  }
  return node;
}

/** @param {boolean} on */
export function setLoading(on) {
  document.body.classList.toggle("ld", on);
  /** @type {HTMLButtonElement} */ ($("go")).disabled = on;
}

/**
 * One block mirrors a real `.r` card line for line: site name, url path,
 * title, then two snippet lines. Bare <i> keeps the markup cheap; widths and
 * heights live in CSS next to the rules they imitate.
 *
 * Read out of the shell rather than written here. index.html ships this markup
 * so a /?q= URL paints the skeleton a round trip before this bundle lands, and
 * a second copy would only be a chance for the two to drift — at which point
 * the hand-off from shipped markup to rendered markup moves the page, which is
 * the whole thing the shipped markup exists to avoid.
 *
 * Read eagerly, and it has to be: showSkeleton("images") replaces #sk's
 * children with the image grid, so a lazy read taken after an images search
 * would capture that grid as the web skeleton.
 *
 * Optional, and it has to be that too: this module is imported by the wallet
 * page and the wallet picker, neither of which has a #sk — and `$` throws on a
 * missing id, so an eager `$("sk")` here failed those bundles at import time,
 * before a line of their own code ran. Nothing is masked by the fallback: the
 * only page that needs a skeleton is the shell, and build-client.mjs hard-fails
 * if #sk is ever missing from it.
 */
const WEB_SKEL = document.getElementById("sk")?.innerHTML ?? "";

/**
 * Tile shapes (height / width) for the image skeleton, in the mix a real result
 * set comes back in: mostly landscape around 2:3–3:4, the odd square or
 * portrait. Fixed order, so the placeholder never reshuffles mid-wait; each
 * column starts at a different point in it so no two run in step.
 * @type {ReadonlyArray<number>}
 */
const IMAGE_SKEL_RATIOS = [
  0.67, 0.75, 0.56, 1.33, 0.66, 0.8, 0.62, 0.75, 1, 0.68, 0.56, 0.75, 1.5,
  0.67, 0.6, 0.71,
];

/** Same breakpoint as the phone rules in app.css and render.js. */
const PHONE = "(max-width: 620px)";

/**
 * A full screen of placeholder tiles in the real grid's own columns: six (two
 * on a phone), each filled past the bottom of the viewport. #sk.is-ig clips
 * it at the viewport edge, so the page reads as images continuing below.
 * @param {HTMLElement} sk
 */
function imageSkeleton(sk) {
  const n = matchMedia(PHONE).matches ? 2 : 6;
  const top = Math.max(0, sk.getBoundingClientRect().top);
  const tall = Math.max(320, innerHeight - top);
  sk.style.height = `${tall}px`;
  // Column width before layout: #sk may not be full-width yet when this runs,
  // so measure against the window and err narrow — an extra tile below the
  // clip costs nothing, a short column shows a gap.
  const colW = Math.max(80, (Math.min(innerWidth, 1440) - 32) / n - 12);
  const grid = el("div", { class: "ig ig-sk", "aria-hidden": "true" });
  for (let c = 0; c < n; c++) {
    const col = el("div", { class: "ig-col" });
    let h = 0;
    for (let i = c * 5; h < tall; i++) {
      const r = IMAGE_SKEL_RATIOS[i % IMAGE_SKEL_RATIOS.length];
      const cell = el("div", { class: "ig-sk-cell" });
      cell.style.setProperty("--r", String(r));
      col.append(cell);
      h += colW * r + 12;
    }
    grid.append(col);
  }
  sk.replaceChildren(grid);
}

const CROSSFADE_MS = 280;

/**
 * Show loading placeholder: web result cards or image-grid tiles.
 * Reuses an existing image skeleton DOM so we don’t rebuild (and reflow) it.
 * @param {"web" | "images"} [kind]
 */
export function showSkeleton(kind = "web") {
  const sk = $("sk");
  sk.hidden = false;
  sk.classList.remove("is-crossfade", "is-out");
  if (kind === "images") {
    // Already showing the same grid — keep it (avoids a mid-load rebuild)
    if (sk.classList.contains("is-ig") && sk.querySelector(".ig-sk")) {
      sk.classList.add("is-ig");
      return;
    }
    sk.className = "is-ig";
    imageSkeleton(sk);
  } else {
    sk.className = "";
    sk.style.height = "";
    sk.innerHTML = WEB_SKEL;
  }
}

export function hideSkeleton() {
  const sk = $("sk");
  sk.hidden = true;
  sk.classList.remove("is-ig", "is-crossfade", "is-out");
  sk.style.height = "";
  const col = sk.parentElement;
  if (col) col.style.minHeight = "";
}

/**
 * Crossfade image skeleton → painted grid (no hard cut / empty flash).
 * Call after painting the real `.ig` into #rs (grid should have .ig-reveal).
 * @param {HTMLElement | null} grid
 */
export function crossfadeImageSkeleton(grid) {
  const sk = $("sk");
  const col = sk.parentElement;
  const reduce =
    typeof matchMedia === "function" &&
    matchMedia("(prefers-reduced-motion: reduce)").matches;

  // No active image skeleton — just show the grid
  if (sk.hidden || !sk.classList.contains("is-ig")) {
    grid?.classList.add("is-in");
    grid?.classList.remove("ig-reveal");
    return;
  }

  if (reduce) {
    hideSkeleton();
    grid?.classList.add("is-in");
    grid?.classList.remove("ig-reveal");
    return;
  }

  // Hold column height so making the skeleton absolute doesn’t collapse layout
  if (col) col.style.minHeight = `${Math.max(sk.offsetHeight, 120)}px`;

  sk.classList.add("is-crossfade");
  // Double rAF: ensure the grid is painted at opacity 0 before transitioning
  requestAnimationFrame(() => {
    requestAnimationFrame(() => {
      sk.classList.add("is-out");
      grid?.classList.add("is-in");
    });
  });

  let done = false;
  const finish = () => {
    if (done) return;
    done = true;
    hideSkeleton();
    grid?.classList.remove("ig-reveal");
    // leave .is-in off once fully shown (opacity default 1)
    grid?.classList.remove("is-in");
  };

  sk.addEventListener("transitionend", finish, { once: true });
  setTimeout(finish, CROSSFADE_MS + 80);
}

/**
 * @param {string} text
 * @param {boolean} [isError]
 */
export function setStatus(text, isError = false) {
  const status = $("st");
  if (!text) {
    status.hidden = true;
    status.textContent = "";
    status.className = "";
    return;
  }
  status.hidden = false;
  status.textContent = text;
  status.className = isError ? "err" : "";
}

export function clearResults() {
  $("rs").replaceChildren();
  setStatus("");
}

/**
 * nil()'s rules, added to the document the first time one is drawn rather
 * than inlined into every page: most visits never see an empty list, and
 * Social's document sits at its guardrail. The mark is grey at low opacity,
 * so it sits quietly on either theme's ground rather than reading as a
 * button; the title and line are flex items, so they need no display:block.
 */
const NIL_CSS =
  ".nil{display:flex;flex-direction:column;align-items:center;gap:6px;margin:0 auto;padding:56px 24px;max-width:340px;" +
  "text-align:center;color:var(--f);font-size:14px;line-height:1.45}" +
  '.nil:before{content:"";width:88px;height:88px;margin-bottom:12px;background:var(--nil) center/contain no-repeat;' +
  "opacity:.16;filter:grayscale(1)}" +
  ".nil-t{color:var(--t);font-size:17px}";

/**
 * Where a list would be when there is nothing on it: the section's mark,
 * faded into the page behind the words, what is empty, and why. Spans
 * throughout, so it can stand in a <p>, an <li> or a <div>.
 * @param {string} icon a client/ic-*.svg, without the extension
 * @param {string} title
 * @param {string | (string | Node)[]} [why]
 */
export function nil(icon, title, why) {
  if (!document.getElementById("nil-css")) document.head.append(el("style", { id: "nil-css", text: NIL_CSS }));
  return el(
    "span",
    { class: "nil", role: "status", style: `--nil:url(/${icon}.svg)` },
    el("b", { class: "nil-t", text: title }),
    why && why.length ? el("span", {}, ...[].concat(why)) : null,
  );
}
