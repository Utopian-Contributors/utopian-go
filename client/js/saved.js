/**
 * Links kept for later, and the two buttons on a result card.
 *
 * Kept in localStorage and nowhere else: the server never learns what anyone
 * saved. Only the fields a card is drawn from are stored, so a saved result
 * paints on the home page exactly as it did in the list it came from.
 */
import { el } from "./dom.js";
import { cite, resultCard, snippet, titleLink } from "./pieces.js";
import { safeUrl } from "./text.js";

const KEY = "bm";

const ICONS = {
  comment: '<path d="M5 4h14a1 1 0 0 1 1 1v10a1 1 0 0 1-1 1H9l-5 4V5a1 1 0 0 1 1-1z"/>',
  save: '<path d="M7 4h10a1 1 0 0 1 1 1v15l-6-4-6 4V5a1 1 0 0 1 1-1z"/>',
  remove: '<path d="M6 6l12 12M18 6 6 18"/>',
};

/** @typedef {{ url: string, title?: string, description?: string, profile?: { name?: string }, meta_url?: { netloc?: string, path?: string } }} Saved */

/** @returns {Saved[]} */
function read() {
  try {
    const list = JSON.parse(localStorage.getItem(KEY) || "[]");
    return Array.isArray(list) ? list : [];
  } catch {
    return [];
  }
}

/** @param {Saved[]} list */
function write(list) {
  try {
    localStorage.setItem(KEY, JSON.stringify(list));
  } catch {}
}

/**
 * @param {"a" | "button"} tag
 * @param {keyof typeof ICONS} kind
 * @param {string} label
 * @param {Record<string, unknown>} [props]
 */
function iconButton(tag, kind, label, props) {
  const node = el(tag, { class: "ra-b", "aria-label": label, title: label, ...props });
  node.innerHTML = `<svg width="18" height="18" viewBox="0 0 24 24" aria-hidden="true">${ICONS[kind]}</svg>`;
  return node;
}

/** @param {Saved} item */
function pick(item) {
  return {
    url: item.url,
    title: item.title,
    description: item.description,
    profile: item.profile?.name ? { name: item.profile.name } : undefined,
    meta_url: item.meta_url
      ? { netloc: item.meta_url.netloc, path: item.meta_url.path }
      : undefined,
  };
}

/**
 * Comment and Save, pinned to the card's top right corner.
 * @param {Saved} item
 */
export function resultActions(item) {
  const url = safeUrl(item.url);
  if (!url) return null;
  const save = iconButton("button", "save", "Save for later", { type: "button" });
  const sync = () => {
    const on = read().some((s) => s.url === url);
    save.classList.toggle("on", on);
    save.setAttribute("aria-pressed", String(on));
  };
  sync();
  save.addEventListener("click", () => {
    const list = read();
    const at = list.findIndex((s) => s.url === url);
    if (at >= 0) list.splice(at, 1);
    else list.unshift(pick({ ...item, url }));
    write(list);
    sync();
  });
  return el(
    "div",
    { class: "ra" },
    iconButton("a", "comment", "Comment", {
      href: `/social?text=${encodeURIComponent(url)}`,
    }),
    save,
  );
}

/** The saved list under the home page's first screen. */
export function paintSaved() {
  let box = document.getElementById("bm");
  if (!box) {
    box = el("section", { id: "bm", class: "rs", "aria-label": "Saved" });
    document.getElementById("mn")?.before(box);
  }
  const list = read();
  box.hidden = !list.length;
  box.replaceChildren(
    ...list.map((item, i) => {
      const remove = iconButton("button", "remove", "Remove", { type: "button" });
      const card = resultCard(
        i,
        cite(item),
        titleLink(item),
        snippet(item),
        el("div", { class: "ra" }, remove),
      );
      remove.addEventListener("click", () => {
        const rest = read().filter((s) => s.url !== item.url);
        write(rest);
        card.remove();
        box.hidden = !rest.length;
      });
      return card;
    }),
  );
}
