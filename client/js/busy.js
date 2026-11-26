/**
 * A press that has to wait on the network shows it at once.
 *
 * On a slow connection a button that only answered when the server did looked
 * dead: you pressed, nothing moved, and you pressed again. busy() turns the
 * button into a spinner and starts the loading bar along the top
 * (progress.js) in the same frame as the press, ignores further presses until
 * the work is done, then gives the button back as it was.
 *
 * The spinner is a child element rather than ::after, which many buttons
 * already draw a mark with. The label and the marks stay in place, unseen,
 * so the button keeps its size; will-change makes the button the box the
 * spinner centres in, without moving the button as position would. Its CSS
 * comes with the first press, not the page's first paint.
 */
import { start } from "./progress.js";

const CSS =
  ".bsy{color:#0000!important;pointer-events:none;will-change:transform}" +
  ".bsy>*,.bsy:before,.bsy:after{visibility:hidden}" +
  ".bsy>.spn{visibility:visible;position:absolute;inset:0;margin:auto;width:1em;height:1em;" +
  "border:2px solid;border-right-color:#0000;border-radius:50%;animation:spn .6s linear infinite}" +
  "@keyframes spn{to{rotate:1turn}}";

/**
 * Show `button` busy and run `task`; a second press while it runs is ignored
 * and resolves undefined. Whatever `task` throws is thrown on, after the
 * button is itself again.
 *
 * @template T
 * @param {HTMLElement} button
 * @param {() => Promise<T> | T} task
 * @returns {Promise<T | undefined>}
 */
export async function busy(button, task) {
  if (button.classList.contains("bsy")) return;
  if (!document.getElementById("bsy")) document.head.append(Object.assign(document.createElement("style"), { id: "bsy", textContent: CSS }));
  const spin = document.createElement("i");
  spin.className = "spn";
  // In the label's colour, which the button gives up to hide its label.
  spin.style.color = getComputedStyle(button).color;
  button.classList.add("bsy");
  button.setAttribute("aria-busy", "true");
  button.append(spin);
  const finish = start();
  try {
    return await task();
  } finally {
    spin.remove();
    button.classList.remove("bsy");
    button.removeAttribute("aria-busy");
    finish();
  }
}
