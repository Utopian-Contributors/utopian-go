/**
 * No hover on a screen without a pointer.
 *
 * A tap sets :hover on what it touched and leaves it there until the next tap
 * lands somewhere else, so on a phone a row stayed lit after the finger had
 * gone. This takes every :hover selector out of the page's sheets when the
 * device cannot hover, and out of each sheet a bundle injects into <head>
 * later: the same as writing every hover rule under `@media (hover: hover)`,
 * without the ~100 B of wrappers the first-paint sheets of search and Social
 * had no room for (scripts/build-client.mjs PAGES). A laptop with a
 * touchscreen hovers with its mouse and keeps them all.
 *
 * Every sheet is the page's own, inlined or injected; one from another origin
 * would throw on cssRules.
 */

/** @param {CSSStyleSheet | CSSGroupingRule} parent */
function strip(parent) {
  const rules = parent.cssRules;
  for (let i = rules.length; i--; ) {
    const rule = /** @type {CSSStyleRule & CSSGroupingRule} */ (rules[i]);
    if (rule.cssRules) strip(rule);
    if (!rule.selectorText?.includes(":hover")) continue;
    // `.a:hover, .a:focus-visible` keeps its :focus-visible. A comma inside :not(…) is not a split.
    const rest = rule.selectorText.split(/,(?![^(]*\))/).filter((s) => !s.includes(":hover"));
    if (rest[0]) rule.selectorText = rest.join();
    else parent.deleteRule(i);
  }
}

export function noStickyHover() {
  if (matchMedia("(hover:hover)").matches) return;
  for (const sheet of document.styleSheets) strip(sheet);
  new MutationObserver(() => {
    for (const sheet of document.styleSheets) strip(sheet);
  }).observe(document.head, { childList: true });
}
