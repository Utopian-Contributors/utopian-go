/**
 * Snake: the page around the board. The header (Back, the device's best, the
 * score), swipes and keys, sound, the message over the board, and the scores.
 * It is offline first: once loaded it plays with no network, and its scores
 * live on the device (../games/scores.js).
 *
 * The game itself is game.js (the rules) and render.js (how it is drawn).
 */
import { leaderboard } from "../games/board.js";
import { keepOffline } from "../games/offline.js";
import { scores } from "../games/scores.js";
import { tone, wakeAudio } from "../games/sound.js";
import { noZoom } from "../js/device.js";
import { COLS, ROWS, game, lay, newGame, step, stepMs, turn } from "./game.js";
import { dark, draw, fit, ready } from "./render.js";

/** @typedef {import("./game.js").Dir} Dir */

/** @param {string} id */
const $ = (id) => /** @type {HTMLElement} */ (document.getElementById(id));

const canvas = /** @type {HTMLCanvasElement} */ ($("sn-c"));
const ctx = /** @type {CanvasRenderingContext2D} */ (canvas.getContext("2d"));
const box = $("sn-t");
const bestOut = $("sn-bs");
const scoreOut = $("sn-sc");
const msgOut = $("sn-msg");
const playBtn = $("sn-go");

const fmt = (n) => n.toLocaleString("en-US");

/** A phone has no keys to name. */
const touch = matchMedia("(hover: none)").matches;
const HOW = touch ? "Swipe to play" : "Press an arrow key to play";
const AGAIN = touch ? "Swipe or tap to go on" : "Press an arrow key to go on";

/** How long the snake blinks after it dies. Nothing starts a new game until it stops, so a swipe still under way cannot. */
const DYING = 700;

/* ---------- Scores: this device's first, the shared board when the network answers ---------- */

const store = scores("ug.sn", "snake");
const finished = leaderboard(store, "/snake", {
  myList: $("sn-my"),
  myNote: $("sn-mn"),
  boardList: $("sn-lb"),
  meOut: $("sn-me"),
});

/* ---------- Messages and counters ---------- */

/** @param {string} text */
function say(text) {
  msgOut.textContent = text;
  msgOut.hidden = !text;
}

function paintCounters() {
  scoreOut.textContent = fmt(game.score);
  const best = store.best();
  bestOut.textContent = best ? `Best ${fmt(best)}` : "";
}

/* ---------- Sound ---------- */

const SOUNDS = {
  apple: () => tone(660, 0.08, "square", 990, 0.04),
  over: () => tone(240, 0.4, "sawtooth", 60, 0.06),
  best: () => [523, 659, 784, 1047].forEach((f, i) => tone(f, 0.14, "square", f, 0.04, i * 0.09)),
};

/* ---------- The loop: it runs only while something moves ---------- */

let raf = 0;
let last = 0;
/** Time owed to the next step. */
let owed = 0;
let paused = false;
/** While the snake blinks, when it stops. */
let dyingUntil = 0;

/** How far through its step the snake is, so it is drawn sliding between cells; all the way when nothing moves. */
const progress = () => (game.state === "play" ? Math.min(1, owed / stepMs()) : 1);

/** @param {boolean} [hide] */
const paint = (hide) => draw(ctx, progress(), hide);

/** @param {number} now */
function frame(now) {
  raf = 0;
  // A long frame slows the game rather than jumping the snake into its tail.
  const dt = Math.min(100, now - (last || now));
  last = now;
  if (game.state === "play" && !paused) {
    owed += dt;
    while (game.state === "play" && owed >= stepMs()) {
      owed -= stepMs();
      advance();
    }
    if (game.state === "play") paint();
  }
  if (dyingUntil) {
    if (now < dyingUntil) paint(Math.floor((dyingUntil - now) / 100) % 2 === 1);
    else settle();
  }
  if ((game.state === "play" && !paused) || dyingUntil) run();
}

function run() {
  if (!raf) raf = requestAnimationFrame(frame);
}

function advance() {
  const result = step();
  if (result === "move") return;
  paintCounters();
  if (result === "apple") {
    SOUNDS.apple();
    return;
  }
  // The score is safe before anything else happens, whatever comes next.
  const best = game.score > store.best();
  finished(game.score);
  paintCounters();
  (best ? SOUNDS.best : SOUNDS.over)();
  say(result === "full" ? "You filled the board!" : best ? "New best!" : "Game over");
  dyingUntil = result === "full" ? 0 : performance.now() + DYING;
  if (!dyingUntil) settle();
}

/** The blinking is over: back to the scores, and ready for another game. */
function settle() {
  dyingUntil = 0;
  paint();
  document.body.classList.remove("sn-on");
  playBtn.textContent = "Play again";
  playBtn.focus({ preventScroll: true });
}

/* ---------- Playing, pausing ---------- */

/** @param {Dir} dir */
function start(dir) {
  if (dyingUntil) return;
  wakeAudio();
  newGame(dir);
  document.body.classList.add("sn-on");
  // The first step is due at once, so the snake sets off with the swipe.
  owed = stepMs();
  last = 0;
  paused = false;
  say("");
  paintCounters();
  paint();
  run();
}

function pause() {
  if (game.state !== "play" || paused) return;
  paused = true;
  say(`Paused. ${AGAIN}`);
}

function resume() {
  if (!paused) return;
  paused = false;
  last = 0;
  say("");
  run();
}

/** A direction, from a swipe or a key: it starts a game, goes on with one, or turns. @param {Dir} dir */
function steer(dir) {
  wakeAudio();
  if (game.state !== "play") {
    start(dir);
    return;
  }
  resume();
  turn(dir);
}

playBtn.addEventListener("click", () => {
  if (game.state !== "play") start("up");
});

/* ---------- Keys ---------- */

/** @type {Record<string, Dir>} */
const KEYS = {
  ArrowUp: "up",
  ArrowDown: "down",
  ArrowLeft: "left",
  ArrowRight: "right",
  KeyW: "up",
  KeyS: "down",
  KeyA: "left",
  KeyD: "right",
};

window.addEventListener("keydown", (e) => {
  if (e.metaKey || e.ctrlKey || e.altKey) return;
  const dir = KEYS[e.code];
  if (dir) {
    e.preventDefault();
    // A key still held from the last game must not start the next.
    if (!e.repeat) steer(dir);
    return;
  }
  if (e.code !== "Space" && e.code !== "KeyP" && e.code !== "Enter") return;
  // On a link or a button these keys are that control's own.
  if (e.code !== "KeyP" && /** @type {Element} */ (e.target).closest?.("a, button")) return;
  e.preventDefault();
  if (e.repeat) return;
  if (game.state !== "play") {
    if (e.code !== "KeyP") start("up");
  } else if (paused) resume();
  else pause();
});

/* ---------- Swipes ---------- */

/** How far a finger goes, in CSS pixels, before it counts as a turn. */
const SWIPE = 20;

/** Near a phone's edge a swipe is the browser's own, going back; a game in play keeps it. */
const EDGE = 24;

let swipeId = -1;
let swipeX = 0;
let swipeY = 0;

window.addEventListener("pointerdown", (e) => {
  // The lists scroll, and the links and buttons are for pressing.
  if (/** @type {Element} */ (e.target).closest?.("a, button, .sn-lists")) return;
  swipeId = e.pointerId;
  swipeX = e.clientX;
  swipeY = e.clientY;
  if (paused) resume();
});

window.addEventListener("pointermove", (e) => {
  if (e.pointerId !== swipeId) return;
  const dx = e.clientX - swipeX;
  const dy = e.clientY - swipeY;
  if (Math.max(Math.abs(dx), Math.abs(dy)) < SWIPE) return;
  steer(Math.abs(dx) > Math.abs(dy) ? (dx > 0 ? "right" : "left") : dy > 0 ? "down" : "up");
  // Measured on from here, so one long stroke can turn again without lifting.
  swipeX = e.clientX;
  swipeY = e.clientY;
});

for (const type of ["pointerup", "pointercancel"]) {
  window.addEventListener(type, (e) => {
    if (e.pointerId === swipeId) swipeId = -1;
  });
}

window.addEventListener(
  "touchstart",
  (e) => {
    const x = e.touches[0]?.clientX ?? EDGE;
    if (game.state === "play" && (x < EDGE || x > innerWidth - EDGE)) e.preventDefault();
  },
  { passive: false },
);

/* ---------- Page ---------- */

/** The canvas at the box's size in device pixels; the board fills as much of it as it can. */
function resize() {
  const dpr = Math.min(3, window.devicePixelRatio || 1);
  const w = Math.round(box.clientWidth * dpr);
  const h = Math.round(box.clientHeight * dpr);
  if (!w || !h || (w === canvas.width && h === canvas.height)) return;
  canvas.width = w;
  canvas.height = h;
  fit(w, h);
  paint();
}

dark.addEventListener("change", () => paint());
ready.then(() => paint());

// Nobody is watching: a game waits for them to come back.
window.addEventListener("blur", pause);
document.addEventListener("visibilitychange", () => {
  if (document.hidden) pause();
});

/** Back: where the visitor came from on this site, else the games list. */
$("sn-bk").addEventListener("click", () => {
  if (history.length > 1 && document.referrer.startsWith(location.origin)) history.back();
  else location.href = "/games";
});

/* ---------- Start ---------- */

noZoom();
document.documentElement.style.setProperty("--sn-ar", String(COLS / ROWS));
lay();
new ResizeObserver(resize).observe(box);
resize();
paintCounters();
say(HOW);
keepOffline();
