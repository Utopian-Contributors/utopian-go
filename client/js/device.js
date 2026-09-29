/**
 * What kind of device this is, for the few things that differ by it: the
 * install panel, and zoom on iOS.
 */

/** iPhone, iPad, iPod. iPadOS asks for desktop sites and says Macintosh, but has a touchscreen. */
export function ios() {
  const ua = navigator.userAgent;
  return /iPhone|iPad|iPod/.test(ua) || (/Macintosh/.test(ua) && navigator.maxTouchPoints > 1);
}

/** Phones and tablets. */
export function mobile() {
  return ios() || /Android/.test(navigator.userAgent);
}

/**
 * No zoom on iOS, by any gesture.
 *
 * The documents' viewport tag (maximum-scale=1, user-scalable=no) is the
 * whole job everywhere else, and on iOS it still stops the zoom onto a field
 * that takes focus. But since iOS 10 WebKit ignores it for gestures, so a
 * pinch and a double-tap have to be refused here: Safari's own gesture events
 * for the pinch, and touch-action for the double-tap. Neither touches
 * scrolling, which is why this does not cancel touchmove as well — a
 * non-passive touchmove listener on the document makes every scroll wait on
 * the main thread.
 */
export function noZoom() {
  if (!ios()) return;
  document.documentElement.style.touchAction = "manipulation";
  const refuse = (/** @type {Event} */ e) => e.preventDefault();
  document.addEventListener("gesturestart", refuse, { passive: false });
  document.addEventListener("gesturechange", refuse, { passive: false });
}
