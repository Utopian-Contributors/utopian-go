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
 */
const WEB_SKEL =
  `<div class="sk"><i></i><i></i><i></i><i></i><i></i></div>`.repeat(3);

/** Every real tile is capped by the 220px width before it hits the 160px height. */
const IMAGE_SKEL_W = 220;

/**
 * Heights sampled from an actual result set: 19 of 20 tiles come back 220 wide,
 * with heights clustered 110–160. Matching that distribution — rather than the
 * scattered widths we used to draw — means the grid barely moves when real
 * images replace the placeholders. Fixed order, so it never reshuffles mid-wait.
 * @type {ReadonlyArray<number>}
 */
const IMAGE_SKEL_HEIGHTS = [
  124, 147, 133, 124, 140, 116, 147, 124, 131, 143, 124, 160, 133, 124, 147,
  110, 140, 134, 144, 123,
];

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
    const grid = el("div", { class: "ig ig-sk", "aria-hidden": "true" });
    for (const h of IMAGE_SKEL_HEIGHTS) {
      const cell = el("div", { class: "ig-sk-cell" });
      cell.style.width = `${IMAGE_SKEL_W}px`;
      cell.style.height = `${h}px`;
      grid.append(cell);
    }
    sk.replaceChildren(grid);
  } else {
    sk.className = "";
    sk.innerHTML = WEB_SKEL;
  }
}

export function hideSkeleton() {
  const sk = $("sk");
  sk.hidden = true;
  sk.classList.remove("is-ig", "is-crossfade", "is-out");
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
