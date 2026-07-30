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
