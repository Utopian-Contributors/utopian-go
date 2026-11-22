/**
 * What someone wears after their name (src/social/shop.ts): their badge, then
 * their status's fruit, as small pictures. `mark` is the server's "badge
 * status" (MARK in src/social/db.ts); absent, it draws nothing.
 */
import { STATUSES, badgeSrc } from "../../src/social/shop.ts";
import { el } from "./dom.js";

/** @param {string} name @param {string | undefined} mark */
export function marks(name, mark) {
  const [badge, status] = (mark || "").split(" ");
  const words = status && STATUSES[status];
  return [
    badge ? el("img", { class: "wear", src: badgeSrc(name, badge), alt: "", width: "16", height: "16" }) : null,
    words ? el("img", { class: "wear", src: `/st-${status}.svg`, alt: words, title: words, width: "16", height: "16" }) : null,
  ];
}

/** The status along the foot of a profile picture (renderSide; the server draws the card without it). */
export function statusPill(status) {
  const words = status && STATUSES[status];
  return words ? el("span", { class: "stp" }, el("img", { src: `/st-${status}.svg`, alt: "", width: "18", height: "18" }), words) : null;
}
