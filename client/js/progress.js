/**
 * The loading bar: 2px along the top of the screen, a green that runs across
 * it (base.css .ptr). It creeps on while something loads, fills when it has,
 * and goes. Social's pull to refresh draws it under the finger first.
 *
 * Loads overlap: each start() is matched by its own finish, and the bar fills
 * only when the last one is done. A page that paints it before its script
 * runs (social.html) hands it over: start() takes it from where it got to.
 */

/** How the bar gets to its width: with the finger, creeping while loading, or quickly to the end. */
const EASE = { pull: "none", load: "width 6s cubic-bezier(0.1, 0.7, 0.2, 1)", done: "width 0.25s ease-out" };

/** @type {HTMLElement | null} */
let bar = null;
let open = 0;

function set(width, how) {
  if (!bar) {
    bar = document.querySelector(".ptr");
    if (bar) {
      // Painted by the page: hold it where its own animation has it, then take over.
      const now = bar.getBoundingClientRect().width;
      bar.classList.remove("boot");
      bar.style.width = `${now}px`;
    } else {
      bar = document.createElement("div");
      bar.className = "ptr";
      document.body.append(bar);
    }
    void bar.offsetWidth;
  }
  bar.style.transition = EASE[how];
  bar.style.opacity = "1";
  bar.style.width = `${width}%`;
}

/** Fade it out and remove it, after `delay` ms. */
function drop(delay) {
  const gone = bar;
  bar = null;
  if (!gone) return;
  setTimeout(() => {
    gone.style.transition = "opacity 0.3s";
    gone.style.opacity = "0";
    setTimeout(() => gone.remove(), 300);
  }, delay);
}

/** Under a finger: `share` of the way, 0 to 100, following it exactly. */
export function pull(share) {
  set(share, "pull");
}

/** A pull let go short of loading anything. */
export function cancel() {
  if (!open) drop(0);
}

/**
 * Something started loading. Returns its finish, to call once it is done,
 * however it ended.
 */
export function start() {
  open += 1;
  set(90, "load");
  let finished = false;
  return () => {
    if (finished) return;
    finished = true;
    open -= 1;
    if (open) return;
    set(100, "done");
    drop(250);
  };
}

/** Load `task` under the bar, and hand back its result. */
export async function during(task) {
  const finish = start();
  try {
    return await task;
  } finally {
    finish();
  }
}
