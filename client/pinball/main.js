/**
 * Pinball: the page around the table. The header (Back, the balls left, the
 * score), the two flipper buttons, the keys, sound, messages over the table,
 * and the scores. It is offline first: once loaded it plays with no network,
 * and its scores live on the device (../games/scores.js).
 *
 * The table itself is table.js (layout, physics, rules) and render.js (how
 * it is drawn, in 3D).
 */
import { leaderboard } from "../games/board.js";
import { keepOffline } from "../games/offline.js";
import { scores } from "../games/scores.js";
import { tone, wakeAudio } from "../games/sound.js";
import { noZoom } from "../js/device.js";
import { ASPECT, draw, fit } from "./render.js";
import { flip, game, newGame, onEvents, pull, update, waiting } from "./table.js";

/** @param {string} id */
const $ = (id) => /** @type {HTMLElement} */ (document.getElementById(id));

const canvas = /** @type {HTMLCanvasElement} */ ($("pb-c"));
const ctx = /** @type {CanvasRenderingContext2D} */ (canvas.getContext("2d"));
const box = $("pb-t");
const ballsOut = $("pb-bn");
const multOut = $("pb-x");
const scoreOut = $("pb-sc");
const msgOut = $("pb-msg");

const fmt = (n) => n.toLocaleString("en-US");

/* ---------- Scores: this device's first, the shared board when the network answers ---------- */

const finished = leaderboard(scores("ug.pb", "pinball"), "/pinball", {
  myList: $("pb-my"),
  myNote: $("pb-mn"),
  boardList: $("pb-lb"),
  meOut: $("pb-me"),
});

/* ---------- Messages and counters ---------- */

let msgUntil = 0;

/** @param {string} text @param {number} [secs] 0 keeps it up */
function say(text, secs = 2.5) {
  msgOut.textContent = text;
  msgOut.hidden = !text;
  msgUntil = secs ? performance.now() + secs * 1000 : Infinity;
}

const MULTS = [1, 2, 3, 5, 10];

function paintCounters() {
  scoreOut.textContent = fmt(game.score);
  // This ball and those still to come, as dots.
  const left = game.state === "play" ? game.left + 1 : game.state === "idle" ? 3 : 0;
  ballsOut.textContent = "●".repeat(Math.min(left, 6)) || "–";
  ballsOut.setAttribute("aria-label", `${left} ${left === 1 ? "ball" : "balls"} left`);
  multOut.textContent = `×${MULTS[game.mult]}`;
  multOut.hidden = game.mult === 0;
}

/* ---------- Sound ---------- */

/** @type {Record<string, () => void>} */
const SOUNDS = {
  flip: () => tone(160, 0.05, "triangle", 90, 0.06),
  bumper: () => tone(320 + Math.random() * 80, 0.09, "square", 160, 0.05),
  sling: () => tone(500, 0.06, "square", 250, 0.04),
  lane: () => tone(880, 0.08, "sine", 1320, 0.05),
  drop: () => tone(700, 0.07, "square", 350, 0.04),
  target: () => tone(990, 0.06, "triangle", 660, 0.05),
  spin: () => tone(1500, 0.03, "square", 1400, 0.02),
  ramp: () => [523, 659, 784].forEach((f, i) => tone(f, 0.12, "triangle", f, 0.05, i * 0.07)),
  orbit: () => tone(400, 0.35, "sawtooth", 1200, 0.03),
  sink: () => tone(220, 0.4, "triangle", 60, 0.07),
  kickout: () => tone(120, 0.2, "sawtooth", 300, 0.05),
  launch: () => tone(90, 0.3, "sawtooth", 400, 0.05),
  kickback: () => tone(140, 0.25, "square", 600, 0.05),
  skill: () => [784, 988, 1175, 1568].forEach((f, i) => tone(f, 0.12, "square", f, 0.04, i * 0.08)),
  quest: () => [523, 784, 1047].forEach((f, i) => tone(f, 0.18, "triangle", f, 0.06, i * 0.1)),
  rank: () => [392, 523, 659, 784, 1047].forEach((f, i) => tone(f, 0.2, "square", f, 0.04, i * 0.09)),
};

onEvents({
  say,
  sound: (name) => SOUNDS[name]?.(),
  change: paintCounters,
  over: (score) => {
    document.body.classList.remove("pb-on");
    finished(score);
  },
});

/* ---------- The loop ---------- */

let last = 0;
let raf = 0;

/** @param {number} now */
function frame(now) {
  raf = requestAnimationFrame(frame);
  const dt = Math.min(1 / 30, (now - (last || now)) / 1000);
  last = now;
  update(dt);
  if (now > msgUntil) {
    if (game.state !== "play") say("Press a button to play", 0);
    else if (waiting()) say("Hold a button, let go to launch", 0);
    else if (game.quest) say(`${game.quest.text} ${game.quest.have}/${game.quest.need} · ${Math.ceil(game.quest.t)}s`, 0.25);
    else say("", 0);
  }
  draw(ctx);
}

/** The canvas at the box's size in device pixels; the table fills as much of it as it can. */
function resize() {
  const dpr = Math.min(2.5, window.devicePixelRatio || 1);
  const w = Math.round(box.clientWidth * dpr);
  const h = Math.round(box.clientHeight * dpr);
  if (!w || !h || (w === canvas.width && h === canvas.height)) return;
  canvas.width = w;
  canvas.height = h;
  fit(w, h);
  draw(ctx);
}

/* ---------- Controls ---------- */

const buttons = [$("pb-l"), $("pb-r")];

/**
 * @param {0 | 1} side
 * @param {boolean} down
 */
function press(side, down) {
  wakeAudio();
  buttons[side].classList.toggle("on", down);
  if (down && game.state !== "play") {
    document.body.classList.add("pb-on");
    newGame();
    return;
  }
  flip(side, down);
  if (down) pull(true);
  else if (!buttons[0].classList.contains("on") && !buttons[1].classList.contains("on")) pull(false);
}

buttons.forEach((b, i) => {
  const side = /** @type {0 | 1} */ (i);
  b.addEventListener("pointerdown", (e) => {
    e.preventDefault();
    b.setPointerCapture?.(e.pointerId);
    press(side, true);
  });
  for (const type of ["pointerup", "pointercancel", "lostpointercapture"]) {
    b.addEventListener(type, () => b.classList.contains("on") && press(side, false));
  }
  b.addEventListener("contextmenu", (e) => e.preventDefault());
});

/** @type {Record<string, 0 | 1 | 2>} */
const KEYS = { KeyZ: 0, ArrowLeft: 0, ShiftLeft: 0, Slash: 1, ArrowRight: 1, ShiftRight: 1, Space: 2, ArrowDown: 2, Enter: 2 };

/** @param {KeyboardEvent} e @param {boolean} down */
function key(e, down) {
  const k = KEYS[e.code];
  if (k === undefined || e.metaKey || e.ctrlKey || e.altKey) return;
  e.preventDefault();
  if (e.repeat) return;
  if (k < 2) {
    press(/** @type {0 | 1} */ (k), down);
    return;
  }
  wakeAudio();
  if (down && game.state !== "play") {
    document.body.classList.add("pb-on");
    newGame();
  } else pull(down);
}

window.addEventListener("keydown", (e) => key(e, true));
window.addEventListener("keyup", (e) => key(e, false));
// A button held as the page lost focus would otherwise stay held.
window.addEventListener("blur", () => {
  for (const side of /** @type {const} */ ([0, 1])) if (buttons[side].classList.contains("on")) press(side, false);
  pull(false);
});

document.addEventListener("visibilitychange", () => {
  if (document.hidden) {
    cancelAnimationFrame(raf);
    raf = 0;
  } else if (!raf) {
    last = 0;
    raf = requestAnimationFrame(frame);
  }
});

/** Back: where the visitor came from on this site, else the games list. */
$("pb-bk").addEventListener("click", () => {
  if (history.length > 1 && document.referrer.startsWith(location.origin)) history.back();
  else location.href = "/games";
});

/* ---------- Start ---------- */

noZoom();
document.documentElement.style.setProperty("--pb-ar", String(ASPECT));
new ResizeObserver(resize).observe(box);
resize();
paintCounters();
say("Press a button to play", 0);
raf = requestAnimationFrame(frame);
keepOffline();
