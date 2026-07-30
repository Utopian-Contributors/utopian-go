/**
 * Shared SERP building blocks (cite, title, snippet, video thumb).
 */
import { el } from "./dom.js";
import { appendSanitized, displayPath, formatAge, host, plainText } from "./text.js";

/** Stagger entrance animation delay step (ms). */
export const STAGGER_MS = 32;

/** @param {{ url?: string, profile?: { name?: string }, meta_url?: { netloc?: string, path?: string } }} item */
export function cite(item) {
  return el(
    "div",
    { class: "ci" },
    el("div", {
      class: "sn",
      text: plainText(item.profile?.name || item.meta_url?.netloc || host(item.url)),
    }),
    el("div", { class: "up", text: plainText(displayPath(item)) }),
  );
}

/** @param {{ title?: string, url?: string }} item */
export function titleLink(item) {
  return el(
    "h3",
    null,
    el("a", {
      href: item.url || "#",
      target: "_blank",
      rel: "noopener",
      text: plainText(item.title || item.url || "Untitled"),
    }),
  );
}

/** @param {{ description?: string, age?: string }} item */
export function snippet(item) {
  const raw = String(item.description || "").trim();
  if (!raw) return document.createDocumentFragment();

  const p = el("p", { class: "s" });
  if (item.age) {
    p.append(
      el("span", { class: "ag", text: `${formatAge(item.age)} — ` }),
    );
  }
  appendSanitized(p, raw);
  return p;
}

function noPreviewEl() {
  return el("div", {
    class: "vr-ph",
    "aria-hidden": "true",
    text: "No preview",
  });
}

/** @param {string | null | undefined} src */
export function videoThumb(src) {
  if (!src) return noPreviewEl();
  const img = el("img", { src, alt: "", loading: "lazy" });
  img.addEventListener(
    "error",
    () => {
      img.replaceWith(noPreviewEl());
    },
    { once: true },
  );
  return img;
}

/**
 * Result card shell with stagger index.
 * @param {number} i
 * @param {...(Node | string | null | undefined | false)} kids
 */
export function resultCard(i, ...kids) {
  const card = el("article", { class: "r" }, ...kids);
  card.style.setProperty("--i", String(i * STAGGER_MS));
  return card;
}
