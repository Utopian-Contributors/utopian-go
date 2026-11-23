#!/usr/bin/env node
/**
 * The app's coloured marks: client/ic-*.svg, each one an icon out of the
 * skeu-icons package, written out as a file of its own. Snake's apple is one
 * too, read into its bundle (client/snake/render.js) rather than fetched.
 *
 * Run by hand (`npm run build:skeu`), not on every client build — the same
 * arrangement as app-icons.mjs, which it runs afterwards so the wallet and
 * social pages' PNG tab icons follow their drawings. The output is checked in;
 * `copyStatic` in build-client.mjs ships it to public/.
 *
 * Files rather than the package's createIcons(): the marks are stylesheet
 * backgrounds (`--ic: url(...)`), <img>s and favicons, none of which can hold
 * an inline <svg>, and as files they cost the pages no script. A file is its
 * own document, so the package's gradient ids cannot meet another copy's and
 * need none of the per-instance renaming createElement() does.
 *
 * One mark is not the package's and not this script's: client/ic-flippers.svg,
 * Pinball's on the games list. The package has no flipper, so it is drawn by
 * hand in the package's manner (a top-lit gradient, a darker edge, a gloss)
 * and checked in as it is; this script leaves it alone.
 *
 * Nor are the badges won at the games (src/social/shop.ts GAME_BADGES):
 * bd-sn1…5.svg, five snakes coiled up, glossy, their heads raised, and bd-pb1…5.svg, five
 * mushrooms after the pinball table's bumpers. The package has neither, so
 * they too are drawn by hand in its manner and checked in.
 */
import { writeFileSync } from "fs";
import path from "path";
import { fileURLToPath } from "url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const clientDir = path.join(__dirname, "..", "client");

/** Each file the app points at, and the skeu-icons name drawn into it. */
const MARKS = {
  "ic-add": "user-plus",
  "ic-apple": "apple",
  "ic-audio": "audio-lines",
  "ic-bell": "bell",
  "ic-cash": "banknote",
  "ic-chat": "message-circle",
  "ic-clock": "clock",
  "ic-close": "x",
  "ic-done": "circle-check",
  "ic-down": "arrow-down",
  "ic-edit": "pencil",
  "ic-failed": "circle-alert",
  "ic-friend": "user-check",
  "ic-home": "house",
  "ic-image": "image",
  "ic-games": "gamepad-2",
  "ic-link": "link",
  "ic-minus": "minus",
  "ic-more": "ellipsis",
  "ic-next": "chevron-right",
  "ic-pause": "pause",
  "ic-person": "user",
  "ic-play": "play",
  "ic-plus": "plus",
  "ic-prev": "chevron-left",
  "ic-receive": "download",
  "ic-remove": "circle-x",
  "ic-save": "save",
  "ic-saved": "save-check",
  "ic-send": "upload",
  "ic-shop": "store",
  "ic-social": "users",
  "ic-swap": "arrow-right-left",
  "ic-up": "chevron-up",
  "ic-wallet": "wallet",
  "ic-wand": "wand-sparkles",
};

/** @param {string} value */
const escape = (value) => value.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/"/g, "&quot;");

/**
 * An IconNode — [tag, attrs, children?] all the way down — as markup.
 * @param {[string, Record<string, string>, any[]?][]} node
 * @returns {string}
 */
function markup(node) {
  return node
    .map(([tag, attrs, children]) => {
      const open = tag + Object.entries(attrs).map(([k, v]) => ` ${k}="${escape(String(v))}"`).join("");
      return children ? `<${open}>${markup(children)}</${tag}>` : `<${open}/>`;
    })
    .join("");
}

/**
 * The Shop's badges and statuses (src/social/shop.ts): bd-<colour>.svg, the
 * package's badge-check in each colour, and st-<fruit>.svg, a fruit. Where the
 * package has no such fruit, one it has is painted over: a colour of the
 * drawing for another, so the shading stays the package's.
 */
const CHECK = { "#b4f296": 0, "#45b230": 1, "#23801a": 2, "#1f6e17": 3 };
const CHECKS = {
  blue: ["#a8d4ff", "#2f86e8", "#1557b0", "#124a96"],
  green: ["#b4f296", "#45b230", "#23801a", "#1f6e17"],
  red: ["#ffa8a0", "#e53935", "#a51d1d", "#7f1414"],
  orange: ["#ffd29a", "#f5891a", "#c25a06", "#9a4504"],
  yellow: ["#fff3a0", "#f2c40f", "#b88a00", "#8a6800"],
  purple: ["#dcc2ff", "#8a4ad6", "#5a24a0", "#46187e"],
  pink: ["#ffc2dc", "#f0609a", "#c22a68", "#9a1f52"],
  black: ["#8a8f98", "#3a3f47", "#15181c", "#000000"],
  white: ["#ffffff", "#f1f3f6", "#c9cfd8", "#8f98a4", "#2a2f36"],
};
const FRUITS = {
  vanilla: ["ice-cream-cone", { "#ffe0ec": "#fffaf0", "#ff95ba": "#f6e7bd", "#d9507f": "#d4ad62", "#a3305a": "#9a7a3a" }],
  mango: ["apple", { "#ff8f85": "#ffd36b", "#e53935": "#f5a01a", "#a51d1d": "#c0620a", "#7f1414": "#8a4006" }],
  banana: ["banana", {}],
  cherry: ["cherry", {}],
  grape: ["grape", {}],
  orange: ["citrus", {}],
  peach: ["apple", { "#ff8f85": "#ffd2b8", "#e53935": "#ff9a72", "#a51d1d": "#e0603e", "#7f1414": "#a3401f" }],
  avocado: ["avocado", {}],
  apple: ["apple", {}],
  lime: [
    "citrus",
    {
      "#ffc46b": "#c8f08a", "#e2700f": "#4a9a1a", "#ffe2a0": "#e8ffc8", "#ffb02e": "#9ad84a",
      "#f08a12": "#6cbf2a", "#9a4a0a": "#2e6a0e", "#fff6e2": "#f4ffe8", "#e8a24a": "#8ac84a",
    },
  ],
};

/** The drawing with each colour `swap` names put in place of its own. */
function paint(node, swap) {
  return node.map(([tag, attrs, children]) => [
    tag,
    Object.fromEntries(
      Object.entries(attrs).map(([k, v]) => [
        k,
        swap.tick && k === "stroke" && attrs["stroke-width"] === "3.6" ? swap.tick : (swap[String(v).toLowerCase()] ?? v),
      ]),
    ),
    children && paint(children, swap),
  ]);
}

const drawings = { ...MARKS };
const painted = {};
for (const [colour, [light, mid, dark, edge, tick]] of Object.entries(CHECKS)) {
  const swap = Object.fromEntries(Object.entries(CHECK).map(([from, i]) => [from, [light, mid, dark, edge][i]]));
  // White needs a dark tick to be seen; the tick is the one stroke 3.6 wide.
  if (tick) swap.tick = tick;
  drawings[`bd-${colour}`] = "badge-check";
  painted[`bd-${colour}`] = swap;
}
for (const [fruit, [name, swap]] of Object.entries(FRUITS)) {
  drawings[`st-${fruit}`] = name;
  painted[`st-${fruit}`] = swap;
}

for (const [file, name] of Object.entries(drawings)) {
  const { default: icon } = await import(`skeu-icons/icons/${name}`);
  // The root the old drawings had: no size of its own, so a stylesheet or an
  // <img> sizes it, and app-icons.mjs can still give it one.
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 32 32">${markup(paint(icon, painted[file] ?? {}))}</svg>\n`;
  writeFileSync(path.join(clientDir, `${file}.svg`), svg);
  console.log(`${`${file}.svg`.padEnd(16)} ${name.padEnd(18)} ${String(svg.length).padStart(5)} B`);
}
