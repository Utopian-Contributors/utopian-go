/**
 * The score, large, at the head of the board on a desktop, and what it does
 * when it changes: what came on (or off) rises (or drops) from beside it and
 * fades, and the number lifts and settles. Snake, Pinball and Slots each draw
 * the card in their own stylesheet (.gm-score, .gm-num, .gm-delta).
 *
 * Changes that come close together, as a pinball's spinner's do, run into the
 * one figure rather than a figure a frame: it grows and starts its fade again.
 */
const reduce = matchMedia("(prefers-reduced-motion: reduce)");

/** How soon after the last change a new one joins its figure, in ms. */
const JOIN = 400;

/**
 * @param {HTMLElement} num the large number
 * @returns {(delta: number, dur?: number) => void} take a change of `delta`,
 *   the number counting to it over `dur` ms
 */
export function tally(num) {
  /** @type {HTMLElement | null} */
  let chip = null;
  let sum = 0;
  let at = 0;
  /** @type {Animation | null} */
  let lift = null;

  return (delta, dur = 0) => {
    // Only where the card shows (a desktop), and only with motion.
    if (!delta || reduce.matches || !num.offsetParent) return;
    const now = performance.now();
    const join = chip?.isConnected && now - at < JOIN && Math.sign(sum) === Math.sign(delta);
    sum = join ? sum + delta : delta;
    at = now;
    const up = sum > 0;

    chip?.remove();
    chip = document.createElement("span");
    chip.className = `gm-delta ${up ? "up" : "down"}`;
    chip.setAttribute("aria-hidden", "true");
    chip.textContent = `${up ? "+" : "−"}${Math.abs(sum).toLocaleString("en-US")}`;
    const mine = chip;
    chip.addEventListener("animationend", () => mine.remove());
    num.parentElement?.append(chip);

    lift?.cancel();
    lift = num.animate(
      [
        { transform: "none" },
        {
          transform: `translateY(${up ? -8 : 5}px) scale(${up ? 1.1 : 0.96})`,
          color: up ? "var(--go)" : "var(--f)",
          offset: 0.3,
        },
        { transform: "none" },
      ],
      { duration: Math.max(500, dur + 250), easing: "cubic-bezier(0.3, 1.4, 0.5, 1)" },
    );
  };
}
