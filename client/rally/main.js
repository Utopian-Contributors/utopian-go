/**
 * Rally: the page around the course. One lap from a standing start, as fast
 * as it can be driven: the countdown, the race, and between races a sheet
 * with Race, the ghost, the store and the board.
 *
 * Every coin on the course is a credit, and finishing pays more. Credits buy
 * cars and badges in the store. Signed in, they are the account's bank
 * (src/social/rally.ts): each race is synced as it is driven (games/live.js),
 * its lap goes on the board and its credits into the bank. Signed out, or
 * with the server out of reach as the page opens, everything lives on this
 * device (localStorage `ug.rl`): the credits, the cars bought with them, the
 * best laps. Badges are an account's, so buying one takes signing in.
 *
 * The ghost is this device's best lap, recorded twenty times a second as it
 * was driven (`ug.rl.g`) and driven again, see-through, beside the car.
 *
 * A touch screen gets a stick and a gas pedal; a keyboard needs neither.
 */
import { CARS, FINISH_BONUS, carById, lapTime, priceOf } from "../../src/social/rally.ts";
import { buildTrack } from "../../src/social/rallyTrack.ts";
import { live } from "../games/live.js";
import { keepOffline } from "../games/offline.js";
import { hum, melody, noise, tone, wakeAudio } from "../games/sound.js";
import { tally } from "../games/tally.js";
import { busy } from "../js/busy.js";
import { noZoom } from "../js/device.js";
import { noStickyHover } from "../js/hover.js";
import { onName, readName } from "../js/me.js";
import { plainSwap } from "../js/plainswap.js";
import { MAX_BOOSTS, STEP, fire, pose, race, raceMs, roadAt, speed, step } from "./car.js";
import { IDENTITY, lookAt, mul, perspective, place, renderer } from "./gl.js";
import * as scene from "./scene.js";

/** @typedef {ReturnType<typeof race>} Race */

/** @param {string} id */
const $ = (id) => /** @type {HTMLElement} */ (document.getElementById(id));

const canvas = /** @type {HTMLCanvasElement} */ ($("rl-c"));
const stage = $("rl-st");
const msgOut = $("rl-msg");
const creditsOut = $("rl-cr");
const panel = $("rl-pn");
const pausePanel = $("rl-pz");
const ghostBox = /** @type {HTMLInputElement} */ ($("rl-gh"));
const fmt = (n) => n.toLocaleString("en-US");
const touch = matchMedia("(hover: none)").matches;
if (touch) document.body.classList.add("rl-touch");

/* ---------- What this device keeps ---------- */

const KEY = "ug.rl";
const GHOST_KEY = "ug.rl.g";
const BOARD_KEY = "ug.rlb";

/** @param {string} key @param {any} fallback */
function read(key, fallback) {
  try {
    const raw = localStorage.getItem(key);
    return raw ? JSON.parse(raw) : fallback;
  } catch {
    return fallback;
  }
}

/** @param {string} key @param {any} value */
function write(key, value) {
  try {
    localStorage.setItem(key, JSON.stringify(value));
  } catch {
    // Private mode or a full quota: it lasts as long as the page.
  }
}

/** @type {{credits: number, cars: string[], car: string, times: {ms: number, at: number}[], ghost: boolean}} */
const device = (() => {
  const raw = read(KEY, null) ?? {};
  return {
    credits: Math.max(0, Math.floor(Number(raw.credits) || 0)),
    cars: Array.isArray(raw.cars) ? raw.cars.filter((id) => carById(id)) : [],
    car: carById(raw.car) ? raw.car : CARS[0].id,
    times: Array.isArray(raw.times) ? raw.times.filter((t) => Number.isInteger(t?.ms) && t.ms > 0).slice(0, 5) : [],
    ghost: raw.ghost !== false,
  };
})();
const save = () => write(KEY, device);

/** The best lap recorded, to race against. @type {{ms: number, car: string, f: number[], splits: number[]} | null} */
let best = (() => {
  const g = read(GHOST_KEY, null);
  return g && Number.isInteger(g.ms) && Array.isArray(g.f) && Array.isArray(g.splits) ? g : null;
})();

/** Signed in and in reach: the account's bank. @type {{credits: number, items: string[]} | null} */
let bank = null;
/** The board, as last read. @type {{top: {name: string, ms: number}[], best: number, at: number} | null} */
let board = read(BOARD_KEY, null);
/** The account's races, synced as they are driven; null on the device's credits. @type {ReturnType<typeof live> | null} */
let synced = null;

const credits = () => (bank ? bank.credits : device.credits);
/** The cars that may be driven: the free one, the device's and the account's. */
const owned = (/** @type {string} */ id) => id === CARS[0].id || device.cars.includes(id) || !!bank?.items.includes(`car:${id}`);

/* ---------- The world ---------- */

const track = buildTrack();
const gfx = renderer(canvas);
const meshes = gfx && {
  road: gfx.mesh(scene.road(track)),
  ground: gfx.mesh(scene.ground(track)),
  coin: gfx.mesh(scene.coin()),
  can: gfx.mesh(scene.boostCan()),
  crate: gfx.mesh(scene.crate()),
  shadow: gfx.mesh(scene.shadow()),
  flame: gfx.mesh(scene.flame()),
  /** Each car's body and wheels, made the first time it is drawn. @type {Map<string, CarMeshes>} */
  cars: new Map(),
};

/** @typedef {{body: any, wheel: any, hubs: number[][]}} CarMeshes */

/**
 * A car's meshes in a renderer: its body in its paint, its body style's
 * wheel, and where the wheels go. Kept per renderer, as a mesh lives in the
 * context that made it.
 * @param {NonNullable<ReturnType<typeof renderer>>} r @param {Map<string, CarMeshes>} cache @param {string} id
 */
function carMeshes(r, cache, id) {
  let m = cache.get(id);
  if (!m) {
    const d = carById(id) ?? CARS[0];
    cache.set(id, (m = { body: r.mesh(scene.car(d)), wheel: r.mesh(scene.wheel(d)), hubs: scene.wheelsOf(d) }));
  }
  return m;
}

/** @param {string} id */
const carMesh = (id) => (gfx && meshes ? carMeshes(gfx, meshes.cars, id) : null);

/* ---------- Sound ---------- */

/** @type {ReturnType<typeof hum>} */
let engine = null;
const SOUNDS = {
  coin: () => {
    tone(1318, 0.06, "square", 1318, 0.025);
    tone(1975, 0.12, "square", 1975, 0.025, 0.05);
  },
  boost: () => [523, 784, 1047].forEach((f, i) => tone(f, 0.1, "triangle", f, 0.05, i * 0.05)),
  fire: () => {
    noise(0.7, 400, 3000, 0.25, 0, "bandpass", 0.8, 0.02);
    tone(120, 0.6, "sawtooth", 360, 0.04);
  },
  pad: () => noise(0.35, 600, 2600, 0.16, 0, "bandpass", 1),
  wall: () => {
    noise(0.12, 900, 300, 0.3, 0, "lowpass", 1);
    tone(90, 0.1, "triangle", 50, 0.08);
  },
  crate: () => {
    noise(0.12, 600, 200, 0.4, 0, "lowpass", 1.5);
    tone(130, 0.1, "triangle", 70, 0.08);
  },
  land: () => {
    noise(0.1, 500, 120, 0.25, 0, "lowpass", 1);
    tone(70, 0.12, "sine", 40, 0.12);
  },
  crash: () => {
    noise(1.1, 1600, 60, 0.7, 0, "lowpass", 0.7);
    tone(70, 0.8, "sine", 28, 0.2);
    noise(0.5, 4000, 1500, 0.2, 0.08, "bandpass", 2);
  },
  checkpoint: () => tone(1568, 0.08, "triangle", 1568, 0.04),
  fell: () => tone(500, 0.4, "triangle", 120, 0.05),
  beep: () => tone(660, 0.14, "square", 660, 0.04),
  go: () => tone(1320, 0.4, "square", 1320, 0.05),
  finish: () => melody([[3, 1], [7, 1], [10, 1], [15, 3], [null, 1], [12, 1], [15, 4]], 0.1, "square", 0.04),
  buy: () => [660, 880, 1175].forEach((f, i) => tone(f, 0.09, "square", f, 0.04, i * 0.06)),
  air: () => {},
};

/** The engine's note: through the gears as the speed climbs. @param {number} v @param {boolean} on */
function rev(v, on) {
  if (!engine) engine = hum();
  if (!engine) return;
  const span = 14;
  const gear = Math.min(4, Math.floor(Math.abs(v) / span));
  const rpm = (Math.abs(v) - gear * span) / span;
  engine.set(62 + gear * 10 + rpm * 85 + (input.gas ? 8 : 0), on ? 0.045 : 0);
}

/* ---------- Messages ---------- */

let msgUntil = 0;
/** @param {string} text @param {number} [secs] @param {boolean} [big] */
function say(text, secs = 1.6, big = false) {
  msgOut.textContent = text;
  msgOut.hidden = !text;
  msgOut.classList.toggle("big", big);
  // Restarted, so a repeated number still pops.
  if (big) {
    msgOut.style.animation = "none";
    void msgOut.offsetWidth;
    msgOut.style.animation = "";
  }
  msgUntil = performance.now() + secs * 1000;
}

/* ---------- The credits in the header ---------- */

let shown = -1;
const jolt = tally(/** @type {HTMLElement} */ (creditsOut));

function paintCredits() {
  const live = cur && phase !== "menu" ? cur.coins + (cur.finished ? FINISH_BONUS : 0) : 0;
  const to = credits() + (counted ? 0 : live);
  if (to === shown) return;
  if (shown >= 0 && to > shown) jolt(to - shown);
  shown = to;
  creditsOut.textContent = fmt(to);
}

/* ---------- The race ---------- */

/** "menu" between races; "count" the countdown; "race"; "done" after the line or a wreck, before the sheet. */
let phase = /** @type {"menu" | "count" | "race" | "done"} */ ("menu");
let paused = false;
/** @type {Race} */
let cur = race(track);
let countT = 0;
let acc = 0;
/** Whether the race's credits are in `credits()` already. */
let counted = false;
/** This race, recorded for a ghost: nine numbers twenty times a second, and the time at each checkpoint. */
let rec = /** @type {number[]} */ ([]);
let splits = /** @type {number[]} */ ([]);
/** The ghost being raced, if any. */
let ghost = /** @type {typeof best} */ (null);
let doneT = 0;

/** Line up on the grid and count down. */
function start() {
  if (!gfx) return;
  wakeAudio();
  cur = race(track);
  settle();
  phase = "count";
  paused = false;
  countT = 3;
  acc = 0;
  counted = false;
  rec = [];
  splits = [];
  ghost = device.ghost ? best : null;
  // Its car made now, not on the race's first frame.
  if (ghost) carMesh(ghost.car);
  document.body.classList.add("rl-on");
  closeSheets();
  pausePanel.hidden = true;
  $("rl-pa").hidden = false;
  paintBoosts();
  say("3", 0.95, true);
  SOUNDS.beep();
  paintCredits();
}

/** Go: the clock starts, and the race's session with it. */
function go() {
  phase = "race";
  say("GO!", 0.8, true);
  SOUNDS.go();
  synced?.begin(() => ({ k: cur.checkpoints, c: cur.coins, p: paused ? 1 : 0 }));
}

/** Record where the car is, for a ghost. */
function record() {
  const p = pose(cur);
  const r2 = (/** @type {number} */ x) => Math.round(x * 100) / 100;
  rec.push(r2(p.pos[0]), r2(p.pos[1]), r2(p.pos[2]), r2(p.F[0]), r2(p.F[1]), r2(p.F[2]), r2(p.U[0]), r2(p.U[1]), r2(p.U[2]));
}

/** What happened in the race since the last frame. */
function events() {
  for (const e of cur.events) {
    SOUNDS[e]?.();
    if (e === "coin") paintCredits();
    else if (e === "boost") {
      paintBoosts();
      say(cur.boosts >= MAX_BOOSTS ? "Boosts full" : "Boost collected", 1.1);
    } else if (e === "fire") paintBoosts();
    else if (e === "fell") say("Off the course", 1.5);
    else if (e === "checkpoint") {
      const ms = raceMs(cur);
      splits.push(ms);
      const was = best?.splits[cur.checkpoints - 1];
      if (was) {
        const d = ms - was;
        const sp = $("rl-sp");
        sp.textContent = `${d < 0 ? "−" : "+"}${(Math.abs(d) / 1000).toFixed(2)}`;
        sp.className = `rl-split ${d < 0 ? "ahead" : "behind"}`;
        splitUntil = performance.now() + 3000;
      }
    } else if (e === "finish") {
      splits.push(raceMs(cur));
      phase = "done";
      doneT = 2.6;
      const ms = raceMs(cur);
      const newBest = !best || ms < best.ms;
      say(`${lapTime(ms)}${newBest ? " · New best!" : ""}`, 2.6);
      paintCredits();
    } else if (e === "crash") {
      phase = "done";
      doneT = 2.4;
      say(`Totalled · ${cur.crashed}`, 2.4);
    }
  }
  cur.events.length = 0;
}

let splitUntil = 0;

/** The race is over: its credits banked or kept, its lap kept, the sheet back. */
async function finish() {
  phase = "menu";
  document.body.classList.remove("rl-on");
  $("rl-pa").hidden = true;
  const r = cur;
  const ms = r.finished ? raceMs(r) : 0;
  const earned = r.coins + (r.finished ? FINISH_BONUS : 0);
  const newBest = r.finished && (!best || ms < best.ms);
  if (r.finished) {
    device.times.push({ ms, at: Date.now() });
    device.times.sort((a, b) => a.ms - b.ms || a.at - b.at);
    device.times = device.times.slice(0, 5);
    if (newBest) {
      best = { ms, car: device.car, f: rec, splits };
      write(GHOST_KEY, best);
    }
  }
  /** @type {string} */
  let line;
  const left = r.crashed === LEFT;
  const head = r.finished ? `<b>${lapTime(ms)}</b>${newBest ? "New best! · " : ""}` : left ? "<b>Race left</b>" : `<b>Totalled</b>${r.crashed ?? "Race over"} · `;
  if (synced) {
    const result = await synced.end(r.finished ? { k: r.checkpoints, c: r.coins, t: ms } : { k: r.checkpoints, c: r.coins });
    if (result?.bank) {
      bank = result.bank;
      board = { top: result.top ?? [], best: result.best ?? 0, at: Date.now() };
      write(BOARD_KEY, board);
      const place = r.finished && result.rank && result.rank <= 10 ? ` · #${result.rank} on the board` : "";
      line = `${head}+${fmt(result.earned)} credits${place}`;
    } else line = `${head}this race fell out of sync, so its ${fmt(earned)} credits weren’t banked`;
  } else {
    device.credits += earned;
    line = `${head}+${fmt(earned)} credits`;
  }
  counted = true;
  save();
  $("rl-rs").innerHTML = line;
  // The name is the start screen's; after a race the sheet leads with how it went.
  $("rl-h1").hidden = true;
  $("rl-go").textContent = "Race again";
  paintPanel();
  paintCredits();
  $("rl-go").focus({ preventScroll: true });
}

const LEFT = "Left the race";

/** Leave the race in progress: its coins still count, its time doesn't. */
async function abandon() {
  if (phase === "menu") return;
  if (phase === "count") {
    phase = "menu";
    document.body.classList.remove("rl-on");
    $("rl-pa").hidden = true;
    pausePanel.hidden = true;
    paused = false;
    cur = race(track);
    paintPanel();
    return;
  }
  cur.crashed = cur.crashed ?? LEFT;
  cur.finished = false;
  pausePanel.hidden = true;
  paused = false;
  await finish();
}

function pause() {
  if (phase !== "race" && phase !== "count") return;
  if (paused) return;
  paused = true;
  synced?.pause();
  pausePanel.hidden = false;
  release();
}

function resume() {
  if (!paused) return;
  paused = false;
  pausePanel.hidden = true;
  synced?.resume();
  last = 0;
}

/* ---------- Controls ---------- */

const input = { gas: 0, brake: 0, steer: 0, pitch: 0 };
/** @type {Set<string>} */
const held = new Set();
const stick = { x: 0, y: 0, id: -1 };
let pedal = false;
let pedalAt = 0;

/** What the keys, the stick and the pedal say together. */
function readInput() {
  const k = (/** @type {string[]} */ ...codes) => codes.some((c) => held.has(c));
  const up = k("ArrowUp", "KeyW");
  const down = k("ArrowDown", "KeyS");
  const left = k("ArrowLeft", "KeyA");
  const right = k("ArrowRight", "KeyD");
  const sx = Math.sign(stick.x) * Math.abs(stick.x) ** 1.4;
  input.steer = Math.max(-1, Math.min(1, (right ? 1 : 0) - (left ? 1 : 0) + sx));
  input.gas = up || pedal ? 1 : 0;
  input.brake = down ? 1 : Math.max(0, (stick.y - 0.4) / 0.6);
  // In the air, only the stick pushed well forward (nose down) or back (nose up) pitches:
  // gas and brake held over a jump, as they will be, never tip the car.
  const sy = Math.abs(stick.y) < 0.45 ? 0 : -(stick.y - Math.sign(stick.y) * 0.45) / 0.55;
  input.pitch = Math.max(-1, Math.min(1, sy));
  return input;
}

/** Everything let go, as when the page loses focus. */
function release() {
  held.clear();
  stick.x = stick.y = 0;
  stick.id = -1;
  pedal = false;
  $("rl-gs").classList.remove("on");
  $("rl-kn").style.transform = "";
}

function boost() {
  if (phase === "race" && !paused && fire(cur)) $("rl-gs").classList.add("boost");
}

window.addEventListener("keydown", (e) => {
  if (e.metaKey || e.ctrlKey || e.altKey) return;
  const inSheet = /** @type {Element} */ (e.target).closest?.(".rl-sheet, .rl-panel");
  if (e.code === "Escape" || e.code === "KeyP") {
    if (!$("rl-sh").hidden || !$("rl-lb").hidden) closeSheets();
    else if (paused) resume();
    else pause();
    e.preventDefault();
    return;
  }
  if (phase === "menu") {
    if (e.code === "Enter" && !inSheet) {
      e.preventDefault();
      start();
    }
    return;
  }
  if (e.code === "KeyR") {
    e.preventDefault();
    if (!e.repeat) restart();
    return;
  }
  if (e.code === "Space" || e.code === "ShiftLeft" || e.code === "ShiftRight") {
    e.preventDefault();
    if (!e.repeat) boost();
    return;
  }
  if (/^(Arrow|Key[WASD])/.test(e.code)) {
    e.preventDefault();
    held.add(e.code);
    wakeAudio();
  }
});
window.addEventListener("keyup", (e) => held.delete(e.code));
window.addEventListener("blur", () => {
  release();
  pause();
});
document.addEventListener("visibilitychange", () => {
  if (document.hidden) pause();
});

// The stick: wherever the thumb goes within its ring.
const stickEl = $("rl-sk");
const knob = $("rl-kn");
stickEl.addEventListener("pointerdown", (e) => {
  if (stick.id >= 0) return;
  e.preventDefault();
  wakeAudio();
  stick.id = e.pointerId;
  stickEl.setPointerCapture?.(e.pointerId);
  moveStick(e);
});
stickEl.addEventListener("pointermove", (e) => e.pointerId === stick.id && moveStick(e));
for (const type of ["pointerup", "pointercancel", "lostpointercapture"]) {
  stickEl.addEventListener(type, (e) => {
    if (/** @type {PointerEvent} */ (e).pointerId !== stick.id) return;
    stick.id = -1;
    stick.x = stick.y = 0;
    knob.style.transform = "";
  });
}
/** @param {PointerEvent} e */
function moveStick(e) {
  const r = stickEl.getBoundingClientRect();
  const reach = r.width * 0.36;
  let dx = (e.clientX - (r.left + r.width / 2)) / reach;
  let dy = (e.clientY - (r.top + r.height / 2)) / reach;
  const m = Math.hypot(dx, dy);
  if (m > 1) {
    dx /= m;
    dy /= m;
  }
  stick.x = Math.abs(dx) < 0.08 ? 0 : dx;
  stick.y = Math.abs(dy) < 0.15 ? 0 : dy;
  knob.style.transform = `translate(${dx * reach}px, ${dy * reach}px)`;
}

// The pedal: held for gas; tapped twice quickly, a boost.
const gasEl = $("rl-gs");
gasEl.addEventListener("pointerdown", (e) => {
  e.preventDefault();
  wakeAudio();
  gasEl.setPointerCapture?.(e.pointerId);
  const now = performance.now();
  if (now - pedalAt < 320) boost();
  pedalAt = now;
  pedal = true;
  gasEl.classList.add("on");
});
for (const type of ["pointerup", "pointercancel", "lostpointercapture"]) {
  gasEl.addEventListener(type, () => {
    pedal = false;
    gasEl.classList.remove("on", "boost");
  });
}
gasEl.addEventListener("contextmenu", (e) => e.preventDefault());
canvas.addEventListener("contextmenu", (e) => e.preventDefault());

/* ---------- The HUD ---------- */

const timeOut = $("rl-t");
const speedOut = $("rl-v");
const boostsEl = $("rl-bo");

function paintBoosts() {
  [...boostsEl.children].forEach((slot, i) => slot.classList.toggle("on", i < cur.boosts));
}

let lastHud = "";
function paintHud() {
  const t = lapTime(raceMs(cur));
  const v = String(Math.round(speed(cur) * 3.6));
  const key = `${t}|${v}|${cur.boostT > 0}`;
  if (key === lastHud) return;
  lastHud = key;
  timeOut.textContent = t;
  speedOut.textContent = v;
  boostsEl.classList.toggle("burn", cur.boostT > 0);
  if (performance.now() > splitUntil) $("rl-sp").textContent = "";
}

/* ---------- Drawing ---------- */

const SKY = [0.62, 0.82, 0.96];
const FAR = 1300;

/** @param {number[]} a @param {number[]} b @param {number} t */
const mix = (a, b, t) => [a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t, a[2] + (b[2] - a[2]) * t];
/** @param {number[]} a */
const unit = (a) => {
  const l = Math.hypot(a[0], a[1], a[2]) || 1;
  return [a[0] / l, a[1] / l, a[2] / l];
};
/** @param {number[]} a @param {number[]} b */
const cross = (a, b) => [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];
/** @param {number[]} a @param {number[]} b */
const dot = (a, b) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
/** @param {number[]} p @param {number[]} v @param {number} k */
const along = (p, v, k) => [p[0] + v[0] * k, p[1] + v[1] * k, p[2] + v[2] * k];
/** @param {number[]} a @param {number[]} b */
const sub = (a, b) => [a[0] - b[0], a[1] - b[1], a[2] - b[2]];
/** @param {number[]} v @param {number} k */
const scale = (v, k) => [v[0] * k, v[1] * k, v[2] * k];
/** How much of the way to go this frame, easing at `rate` a second, whatever the frame rate. @param {number} rate @param {number} dt */
const ease = (rate, dt) => 1 - Math.exp(-rate * dt);

/*
 * The car as drawn. Physics runs in fixed steps, and a frame takes one, two
 * or three of them as the display's timing falls; drawn at whole steps the
 * car would lurch against the camera, more the faster it goes. So it is
 * drawn between the last two steps, as far between as the time left over.
 */

/** @typedef {{pos: number[], F: number[], U: number[], s: number, u: number}} Snap */

/** @returns {Snap} */
function snap() {
  const p = pose(cur);
  return { pos: p.pos, F: p.F, U: p.U, s: cur.s, u: cur.u };
}

let before = snap();
let after = before;

/**
 * Where the body leans away from where physics has it, in the body's own
 * axes (left, up, ahead), easing back to nothing: a landing turns the car
 * square to the road in one step, and this lets the eye see it settle.
 */
const lean = { F: [0, 0, 1], U: [0, 1, 0] };
/** The body as last drawn, to lean from. */
let drawn = { pos: [0, 0, 0], F: [0, 0, 1], U: [0, 1, 0] };

/** Drawn where physics has it, with nothing to ease from: on the grid, or put back on the road. */
function settle() {
  before = after = snap();
  lean.F = [0, 0, 1];
  lean.U = [0, 1, 0];
  cam.snap = true;
}

/** The car's place this frame: between the last two steps, then leaned. @param {number} dt */
function body(dt) {
  const a = Math.max(0, Math.min(1, acc / STEP));
  const jump = Math.hypot(...sub(after.pos, before.pos)) > 8;
  const pos = jump ? after.pos : mix(before.pos, after.pos, a);
  let F = jump ? after.F : unit(mix(before.F, after.F, a));
  let U = jump ? after.U : unit(mix(before.U, after.U, a));
  U = unit(sub(U, scale(F, dot(U, F))));
  let ds = after.s - before.s;
  if (ds > track.len / 2) ds -= track.len;
  if (ds < -track.len / 2) ds += track.len;
  const s = jump ? after.s : before.s + ds * a;
  const u = jump ? after.u : before.u + (after.u - before.u) * a;
  // The lean, eased back to square.
  const k = ease(9, dt);
  lean.F = unit(mix(lean.F, [0, 0, 1], k));
  lean.U = unit(mix(lean.U, [0, 1, 0], k));
  const L = cross(U, F);
  /** @param {number[]} v */
  const out = (v) => [L[0] * v[0] + U[0] * v[1] + F[0] * v[2], L[1] * v[0] + U[1] * v[1] + F[1] * v[2], L[2] * v[0] + U[2] * v[1] + F[2] * v[2]];
  const bF = unit(out(lean.F));
  let bU = out(lean.U);
  bU = unit(sub(bU, scale(bF, dot(bU, bF))));
  drawn = { pos, F: bF, U: bU };
  return { pos, F: bF, U: bU, rawU: U, rawF: F, s, u };
}

/** Landed: the body keeps the angle it came down at, in the new frame, and eases from it. */
function landed() {
  const p = pose(cur);
  const L = cross(p.U, p.F);
  /** @param {number[]} v */
  const into = (v) => unit([dot(v, L), dot(v, p.U), dot(v, p.F)]);
  lean.F = into(drawn.F);
  lean.U = into(drawn.U);
  // The lean carries the turn from here: the step before is not blended in as well.
  before = { ...before, F: after.F, U: after.U };
}

/** The camera, eased after the car: its offset from the car rather than a place, so it keeps its distance at any speed. */
const cam = { eye: [0, 5, -10], off: [0, 3, -8], up: [0, 1, 0], back: [0, 0, 1], fov: 1.05, orbit: 0, snap: true };
/** Whether the camera has left the chase for circling a wreck. */
let wreckCam = false;

/**
 * Where the camera is and looks: behind the car and over it, its up the
 * road's (so the loop turns the world over), level on a bank, the world's
 * while the car flies. Between races it circles the car slowly; a wreck, it
 * circles from above.
 * @param {number} dt @param {ReturnType<typeof body>} p
 */
function aim(dt, p) {
  if (phase === "menu" && !cur.crashed) {
    cam.orbit += dt * 0.25;
    const side = cross(p.U, p.F);
    const dir = unit(along(scale(p.F, Math.cos(cam.orbit)), side, Math.sin(cam.orbit)));
    cam.eye = along(along(p.pos, dir, -9), p.U, 3.2);
    cam.up = p.U;
    cam.fov = 1.0;
    cam.snap = true;
    return along(p.pos, p.U, 0.9);
  }
  // Totalled: circle the wreck slowly from above, the world's way up, never under the road or the ground.
  if (cur.crashed) {
    if (!wreckCam) {
      wreckCam = true;
      cam.orbit = Math.atan2(cam.eye[2] - p.pos[2], cam.eye[0] - p.pos[0]);
    }
    cam.orbit += dt * 0.35;
    const lift = Math.max(p.pos[1] + 4.5, track.ground + 3);
    const want = [p.pos[0] + Math.cos(cam.orbit) * 10, lift, p.pos[2] + Math.sin(cam.orbit) * 10];
    cam.eye = mix(cam.eye, want, ease(3, dt));
    cam.eye[1] = Math.max(cam.eye[1], track.ground + 2, p.pos[1] + 1.5);
    cam.up = unit(mix(cam.up, [0, 1, 0], ease(4, dt)));
    return along(p.pos, [0, 1, 0], 0.6);
  }
  wreckCam = false;
  // Where the car is against the road under it: across, and how high over it.
  const under = roadAt(track, p.s);
  const rel = sub(p.pos, under.p);
  const across = dot(rel, under.r);
  const over = Math.max(0, dot(rel, under.n));
  // Over the course, on the road or a hop or a jump above it, the camera
  // follows the road; only a car flying clear of it is followed straight.
  const onCourse = Math.abs(across) < track.width;
  const roadUp = onCourse ? under.n : p.rawU;
  // On a bank the horizon stays level; up a wall of the loop it turns with the road.
  const level = Math.max(0, roadUp[1]) ** 2 * 2.5;
  const wantUp = onCourse || cur.mode === "ground" ? unit([roadUp[0], roadUp[1] + level, roadUp[2]]) : unit(mix(cam.up, [0, 1, 0], 0.5));
  // Behind: the way the car points on the road, the way it is going in the air; squared to the camera's up.
  let back = p.rawF;
  if (cur.mode !== "ground" && Math.hypot(cur.vel[0], cur.vel[2]) > 3) back = unit(cur.vel);
  // A few metres back along the road's own curve (so inside the loop the
  // camera stays inside it), rising with the car as it leaves the road.
  let want;
  if (onCourse) {
    const q = roadAt(track, p.s - 7.6);
    want = along(along(q.p, q.r, across * 0.8), q.n, 2.9 + over * 0.85);
  } else want = along(along(p.pos, unit(along(back, wantUp, -dot(back, wantUp))), -7.6), wantUp, 2.9);
  if (cam.snap) {
    cam.up = wantUp;
    cam.back = back;
    cam.off = sub(want, p.pos);
    cam.snap = false;
  }
  cam.up = unit(mix(cam.up, wantUp, ease(5, dt)));
  cam.back = unit(mix(cam.back, back, ease(7, dt)));
  cam.off = mix(cam.off, sub(want, p.pos), ease(8, dt));
  cam.eye = along(p.pos, cam.off, 1);
  const v = speed(cur);
  cam.fov += (0.98 + Math.min(0.32, v / 200) + (cur.boostT > 0 ? 0.08 : 0) - cam.fov) * ease(2.5, dt);
  const ahead = unit(along(cam.back, cam.up, -dot(cam.back, cam.up)));
  return along(along(p.pos, cam.up, 1.3), ahead, 3);
}

let width = 1;
let height = 1;

/**
 * The coins, boosts and crates where they stand: worked out once, as the
 * course never moves. Each coin's frame is the road's under it.
 */
const coinAt = track.coins.map((c) => {
  const q = roadAt(track, c.s);
  return { pos: along(along(q.p, q.r, c.u), q.n, c.h), t: q.t, n: q.n, r: q.r, spin: c.s * 0.1 };
});
const canAt = track.boosts.map((b) => {
  const q = roadAt(track, b.s);
  return { pos: along(along(q.p, q.r, b.u), q.n, 1.1), n: q.n, left: cross(q.n, q.t), t: q.t };
});
const crateAt = track.crates.map((c) => {
  const q = roadAt(track, c.s);
  return place(cross(q.n, q.t), q.n, q.t, along(q.p, q.r, c.u));
});

/** One placement, filled for each thing drawn: nothing new made a frame for the collector to sweep. */
const M = new Float32Array(16);
const WHITE = [1, 1, 1, 1];

/** @param {number} dt */
function draw(dt) {
  if (!gfx || !meshes) return;
  const p = body(dt);
  const target = aim(dt, p);
  // Upright screens see as much across as a wide one would.
  const aspect = width / height;
  const fovy = Math.min(1.45, Math.max(cam.fov, 2 * Math.atan(Math.tan(0.62) / aspect)));
  const proj = perspective(fovy, aspect, 0.3, FAR);
  const view = lookAt(cam.eye, target, cam.up);
  gfx.begin(width, height, mul(proj, view), cam.eye, SKY, FAR * 0.75);
  gfx.draw(meshes.ground, IDENTITY);
  gfx.draw(meshes.road, IDENTITY);
  const t = performance.now() / 1000;
  const ex = cam.eye[0];
  const ez = cam.eye[2];
  const near = (/** @type {number[]} */ q) => Math.abs(q[0] - ex) + Math.abs(q[2] - ez) < 500;
  // Coins spinning about the road's up; boosts bobbing; crates still.
  for (let k = 0; k < coinAt.length; k++) {
    const c = coinAt[k];
    if (cur.taken[k] || !near(c.pos)) continue;
    const a = t * 3 + c.spin;
    const co = Math.cos(a);
    const si = Math.sin(a);
    const F = [c.t[0] * co + c.r[0] * si, c.t[1] * co + c.r[1] * si, c.t[2] * co + c.r[2] * si];
    gfx.draw(meshes.coin, place(cross(c.n, F), c.n, F, c.pos, 1, M), WHITE, 0.25);
  }
  for (let k = 0; k < canAt.length; k++) {
    const b = canAt[k];
    if (cur.cans[k] || !near(b.pos)) continue;
    gfx.draw(meshes.can, place(b.left, b.n, b.t, along(b.pos, b.n, Math.sin(t * 3 + k) * 0.2), 1, M), WHITE, 0.35);
  }
  for (const m of crateAt) if (near([m[12], 0, m[14]])) gfx.draw(meshes.crate, m);
  // The car, its wheels, its flames, and its shadow on the road.
  drawCar(device.car, p.pos, p.F, p.U, cur.steer, WHITE);
  if (cur.boostT > 0 && !cur.crashed) {
    const L = cross(p.U, p.F);
    for (const x of [-0.45, 0.45]) {
      const flick = 0.75 + Math.random() * 0.5;
      gfx.draw(meshes.flame, place(scale(L, flick), scale(p.U, flick), scale(p.F, flick), along(along(along(p.pos, p.F, -2.05), p.U, 0.5), L, x), 1, M), WHITE, 1.1);
    }
  }
  if (cur.mode === "ground") gfx.draw(meshes.shadow, place(cross(p.rawU, p.rawF), p.rawU, p.rawF, along(p.pos, p.rawU, 0.05), 1, M), SHADE);
  // The ghost, see-through, where the best lap was at this time.
  // Not on the grid, where it would sit inside the car: it fades in once the race is GHOST_IN seconds old.
  const secs = raceMs(cur) / 1000 + Math.max(0, Math.min(1, acc / STEP)) * STEP;
  const show = Math.max(0, Math.min(1, (secs - GHOST_IN) / GHOST_FADE));
  if (ghost && phase !== "menu" && show > 0) {
    const g = ghostAt(secs);
    GHOST_TINT[3] = 0.5 * show;
    if (g) drawCar(ghost.car, g.pos, g.F, g.U, 0, GHOST_TINT, GHOST);
  }
}

/** The ghost's one colour: a pale, icy blue; and how see-through it is. */
const GHOST = [0.62, 0.86, 1, 0.85];
const GHOST_TINT = [1, 1, 1, 0.5];
/** The ghost shows from this far into the race, fading in over the next. Seconds. */
const GHOST_IN = 2;
const GHOST_FADE = 0.8;
const SHADE = [1, 1, 1, 0.32];

/**
 * @param {string} id @param {number[]} pos @param {number[]} F @param {number[]} U @param {number} steer @param {number[]} tint @param {number[]} [flat]
 */
function drawCar(id, pos, F, U, steer, tint, flat) {
  if (!gfx || !meshes) return;
  const m = carMesh(id);
  if (!m) return;
  drawCarIn(gfx, m, pos, F, U, steer, tint, flat);
}

/**
 * A car's body and its four wheels, the fronts turned by `steer`.
 * @param {NonNullable<ReturnType<typeof renderer>>} r @param {CarMeshes} m
 * @param {number[]} pos @param {number[]} F @param {number[]} U @param {number} steer @param {number[]} tint @param {number[]} [flat]
 */
function drawCarIn(r, m, pos, F, U, steer, tint, flat) {
  const L = cross(U, F);
  const glow = flat ? 0.35 : 0;
  r.draw(m.body, place(L, U, F, pos, 1, M), tint, glow, flat);
  const a = -steer * 0.45;
  const turned = unit(along(scale(F, Math.cos(a)), L, Math.sin(a)));
  const turnedL = cross(U, turned);
  for (let i = 0; i < 4; i++) {
    const [x, y, z] = m.hubs[i];
    const at = [pos[0] + L[0] * x + U[0] * y + F[0] * z, pos[1] + L[1] * x + U[1] * y + F[1] * z, pos[2] + L[2] * x + U[2] * y + F[2] * z];
    r.draw(m.wheel, i < 2 ? place(turnedL, U, turned, at, 1, M) : place(L, U, F, at, 1, M), tint, glow, flat);
  }
}

/** The ghost's place at `secs` into its lap, between its frames. @param {number} secs */
function ghostAt(secs) {
  if (!ghost) return null;
  const f = ghost.f;
  const count = f.length / 9;
  const x = Math.min(count - 1, secs * 20);
  const i = Math.floor(x);
  const j = Math.min(count - 1, i + 1);
  const k = x - i;
  /** @param {number} o */
  const v = (o) => [f[i * 9 + o] + (f[j * 9 + o] - f[i * 9 + o]) * k, f[i * 9 + o + 1] + (f[j * 9 + o + 1] - f[i * 9 + o + 1]) * k, f[i * 9 + o + 2] + (f[j * 9 + o + 2] - f[i * 9 + o + 2]) * k];
  return { pos: v(0), F: unit(v(3)), U: unit(v(6)) };
}

/* ---------- The loop ---------- */

let last = 0;
let recAcc = 0;

/*
 * The canvas's resolution follows what the device can draw: a frame that
 * keeps missing the display's beat costs pixels, a device with time to spare
 * gets them back, never past the screen's own.
 */
let quality = 1;
let slowAvg = 1 / 60;
let judged = 0;

/** @param {number} dt @param {number} now */
function judge(dt, now) {
  slowAvg += (dt - slowAvg) * 0.05;
  if (now - judged < 1500) return;
  judged = now;
  const was = quality;
  if (slowAvg > 1 / 48 && quality > 0.55) quality = Math.max(0.55, quality - 0.15);
  else if (slowAvg < 1 / 58 && quality < 1) quality = Math.min(1, quality + 0.1);
  if (quality !== was) resize();
}

/** @param {number} now */
function frame(now) {
  requestAnimationFrame(frame);
  const dt = Math.min(0.25, (now - (last || now)) / 1000);
  last = now;
  if (dt > 0) judge(dt, now);
  if (!paused) {
    if (phase === "count") {
      const was = Math.ceil(countT);
      countT -= dt;
      const now2 = Math.ceil(countT);
      if (countT <= 0) go();
      else if (now2 !== was) {
        say(String(now2), 0.95, true);
        SOUNDS.beep();
      }
    }
    if (phase === "race" || phase === "done") {
      acc += dt;
      const inp = readInput();
      // Up to 30 steps a frame (a quarter second): a slow device runs the race behind, not wrong.
      for (let n = 0; acc >= STEP && n < 30; n++) {
        acc -= STEP;
        before = after;
        step(cur, inp);
        after = snap();
        if (phase === "race" && !cur.finished && !cur.crashed) {
          recAcc += STEP;
          if (recAcc >= 0.05 - 1e-9) {
            recAcc -= 0.05;
            record();
          }
        }
        if (cur.events.length) {
          if (cur.events.includes("land")) landed();
          if (cur.events.includes("fell")) settle();
          events();
        }
      }
      if (acc > STEP) acc = STEP;
      if (phase === "done") {
        doneT -= dt;
        if (doneT <= 0) finish();
      }
      paintHud();
    } else {
      // Standing on the grid, or a menu: drawn where it is.
      before = after = snap();
      acc = 0;
    }
  }
  if (now > msgUntil && !msgOut.hidden) msgOut.hidden = true;
  rev(speed(cur), (phase === "race" || phase === "count" || phase === "done") && !paused && !cur.crashed);
  draw(dt);
}

/* ---------- Between races: the sheet ---------- */

function paintPanel() {
  const fastest = Math.min(best?.ms ?? Infinity, bank && board?.best ? board.best : Infinity);
  const bits = [];
  if (Number.isFinite(fastest)) bits.push(`Best lap ${lapTime(fastest)}`);
  if (board?.top?.[0]) bits.push(`Record ${lapTime(board.top[0].ms)} by ${board.top[0].name}`);
  $("rl-be").textContent = bits.join(" · ");
  ghostBox.checked = device.ghost;
  ghostBox.disabled = !best;
  const label = /** @type {HTMLElement} */ (ghostBox.nextElementSibling);
  label.innerHTML = best ? `Race against your ghost <small>Your best lap, ${lapTime(best.ms)}</small>` : "Race against your ghost <small>Finish a lap to set one</small>";
  $("rl-ky").innerHTML = touch
    ? "Stick steers, pull it back to brake · Hold the pedal for gas, tap it twice to boost"
    : "<kbd>↑</kbd> gas · <kbd>↓</kbd> brake · <kbd>←</kbd><kbd>→</kbd> steer · <kbd>Space</kbd> boost · <kbd>R</kbd> restart · <kbd>Esc</kbd> pause";
}

ghostBox.addEventListener("change", () => {
  device.ghost = ghostBox.checked;
  save();
});

/** A press responds at once: the countdown starts before anything else. */
$("rl-go").addEventListener("click", start);
$("rl-pa").addEventListener("click", pause);
$("rl-re").addEventListener("click", resume);
$("rl-rs2").addEventListener("click", restart);
$("rl-qt").addEventListener("click", abandon);

/** Start the lap again: the race left counts its coins, as a quit does, then the grid. */
async function restart() {
  if (phase === "menu") return;
  if (phase === "count") {
    pausePanel.hidden = true;
    paused = false;
    start();
    return;
  }
  await abandon();
  start();
}

/* ---------- The store ---------- */

const storeEl = $("rl-sh");
const boardEl = $("rl-lb");

function closeSheets() {
  storeEl.hidden = boardEl.hidden = true;
}

for (const x of document.querySelectorAll("[data-close]")) x.addEventListener("click", closeSheets);
$("rl-so").addEventListener("click", () => {
  paintStore();
  storeEl.hidden = false;
});
$("rl-bd").addEventListener("click", () => {
  paintBoard();
  boardEl.hidden = false;
  loadBoard();
});

/* ---------- The cars in the store, in 3D ---------- */

/*
 * Each car is shown as it is on the course: drawn in 3D by a renderer of its
 * own on one small canvas off the page, and copied into each tile's canvas.
 * One WebGL context for all of them, rather than one a tile. A tile's car
 * stands at three-quarters and turns while the pointer is over it (or it has
 * the keyboard's focus); on a touch screen the car being driven turns.
 */
const shelf = document.createElement("canvas");
const shelfGfx = renderer(shelf, true);
/** @type {Map<string, CarMeshes>} */
const shelfCars = new Map();
const shelfShadow = shelfGfx && shelfGfx.mesh(scene.shadow());
/** The angle each tile's car stands at, and those turning. @type {Map<string, {angle: number, canvas: HTMLCanvasElement, turning: boolean}>} */
const shown3d = new Map();
const REST = -0.65;
let shelfRaf = 0;
let shelfLast = 0;

/** Draw one tile's car at its angle. @param {string} id */
function paintTile(id) {
  const t = shown3d.get(id);
  if (!t || !shelfGfx || !shelfShadow) return;
  const c = t.canvas;
  const w = c.width;
  const h = c.height;
  if (!w || !h) return;
  if (shelf.width !== w || shelf.height !== h) {
    shelf.width = w;
    shelf.height = h;
  }
  // The camera circles the car at a little over its height, looking at its middle.
  const eye = [Math.sin(t.angle) * 5.6, 1.9, Math.cos(t.angle) * 5.6];
  const vp = mul(perspective(0.55, w / h, 0.5, 60), lookAt(eye, [0, 0.62, 0], [0, 1, 0]));
  shelfGfx.begin(w, h, vp, eye, [0, 0, 0], 1e5);
  shelfGfx.draw(shelfShadow, place([1.12, 0, 0], [0, 1, 0], [0, 0, 1.1], [0, 0.01, 0], 1, M), SHADE);
  drawCarIn(shelfGfx, carMeshes(shelfGfx, shelfCars, id), [0, 0, 0], [0, 0, 1], [0, 1, 0], 0, WHITE);
  const ctx = c.getContext("2d");
  if (!ctx) return;
  ctx.clearRect(0, 0, w, h);
  ctx.drawImage(shelf, 0, 0);
}

/** Turn the turning cars, and settle the rest back to three-quarters. @param {number} now */
function turnShelf(now) {
  shelfRaf = 0;
  const dt = Math.min(0.05, (now - (shelfLast || now)) / 1000);
  shelfLast = now;
  let moving = false;
  for (const [id, t] of shown3d) {
    if (t.turning) t.angle += dt * 1.3;
    else {
      // Back the shorter way round to rest.
      const off = Math.atan2(Math.sin(t.angle - REST), Math.cos(t.angle - REST));
      if (Math.abs(off) < 0.002) continue;
      t.angle -= off * Math.min(1, dt * 6);
    }
    moving = true;
    paintTile(id);
  }
  if (moving && !storeEl.hidden) shelfRaf = requestAnimationFrame(turnShelf);
  else shelfLast = 0;
}

const spin = () => {
  if (!shelfRaf) shelfRaf = requestAnimationFrame(turnShelf);
};

/**
 * A tile's canvas for car `id`: sized to the tile in device pixels, drawn
 * at once, turning while hovered or focused.
 * @param {string} id @param {HTMLElement} tile
 */
function carCanvas(id, tile) {
  const c = document.createElement("canvas");
  c.className = "rl-car3d";
  c.setAttribute("aria-hidden", "true");
  const was = shown3d.get(id);
  const t = { angle: was?.angle ?? REST, canvas: c, turning: touch && device.car === id };
  shown3d.set(id, t);
  const on = () => {
    t.turning = true;
    spin();
  };
  const off = () => {
    t.turning = touch && device.car === id;
    spin();
  };
  tile.addEventListener("pointerenter", (e) => e.pointerType === "mouse" && on());
  tile.addEventListener("pointerleave", (e) => e.pointerType === "mouse" && off());
  tile.addEventListener("focus", on);
  tile.addEventListener("blur", off);
  requestAnimationFrame(() => {
    const dpr = Math.min(2, window.devicePixelRatio || 1);
    c.width = Math.round(c.clientWidth * dpr);
    c.height = Math.round(c.clientHeight * dpr);
    paintTile(id);
    if (t.turning) spin();
  });
  return c;
}

/** Items waiting for a second tap to be bought. @type {string | null} */
let confirming = null;

function paintStore() {
  const have = credits();
  $("rl-cs").replaceChildren(
    ...CARS.map((d) => {
      const li = document.createElement("li");
      const b = document.createElement("button");
      b.type = "button";
      b.className = "rl-item";
      const mine = owned(d.id);
      const driving = device.car === d.id;
      if (driving) b.classList.add("sel");
      const status = driving ? "Driving" : mine ? "Tap to drive" : confirming === `car:${d.id}` ? "Tap again to buy" : `${fmt(d.price)} credits`;
      const cls = !mine && have >= d.price ? "can" : !mine ? "lock" : "";
      const name = document.createElement("span");
      name.textContent = d.name;
      const small = document.createElement("small");
      small.className = cls;
      small.textContent = status;
      b.append(shelfGfx ? carCanvas(d.id, b) : "", name, small);
      b.addEventListener("click", () => pickCar(d.id, b));
      li.append(b);
      return li;
    }),
  );
}

/** @param {string} id @param {HTMLElement} b */
function pickCar(id, b) {
  if (owned(id)) {
    device.car = id;
    confirming = null;
    save();
    paintStore();
    return;
  }
  buy(`car:${id}`, b);
}

/**
 * Buy `item`: a second tap does it. On the account's credits when signed in,
 * else (a car only) on the device's.
 * @param {string} item @param {HTMLElement} b
 */
async function buy(item, b) {
  const price = priceOf(item);
  if (price === null) return;
  if (credits() < price) {
    say(`${fmt(price - credits())} more credits needed`, 1.6);
    return;
  }
  if (confirming !== item) {
    confirming = item;
    paintStore();
    return;
  }
  confirming = null;
  if (bank) {
    await busy(b, async () => {
      try {
        const res = await fetch("/api/social/rally/buy", {
          method: "POST",
          headers: { "Content-Type": "application/json", Accept: "application/json" },
          body: JSON.stringify({ item }),
          credentials: "same-origin",
          cache: "no-store",
        });
        const data = await res.json().catch(() => ({}));
        if (!res.ok) throw new Error(data.error || "That didn’t go through.");
        bank = data.bank;
        bought(item);
      } catch (err) {
        say(navigator.onLine ? /** @type {Error} */ (err).message : "You’re offline: buying needs a connection.", 2.4);
      }
    });
  } else if (item.startsWith("car:")) {
    device.credits -= price;
    device.cars.push(item.slice(4));
    save();
    bought(item);
  }
  paintStore();
  paintCredits();
}

/** @param {string} item */
function bought(item) {
  SOUNDS.buy();
  if (item.startsWith("car:")) {
    device.car = item.slice(4);
    save();
    say(`${carById(device.car)?.name} is yours`, 1.8);
  } else say("Badge unlocked · wear it from the Shop", 2.2);
}

/* ---------- The board ---------- */

/** @param {HTMLElement} list @param {{name?: string, ms: number, at?: number}[]} rows @param {string} [me] */
function paintList(list, rows, me) {
  list.replaceChildren(
    ...rows.map((row) => {
      const li = document.createElement("li");
      if (me && row.name === me) li.className = "me";
      const name = document.createElement("span");
      name.textContent = row.name ?? new Date(row.at ?? 0).toLocaleDateString(undefined, { month: "short", day: "numeric" });
      const time = document.createElement("b");
      time.textContent = lapTime(row.ms);
      li.append(name, time);
      return li;
    }),
  );
}

let boardLive = false;
function paintBoard() {
  paintList($("rl-my"), device.times);
  $("rl-mn").textContent = device.times.length ? "" : "Your laps are kept on this device.";
  const me = readName();
  paintList($("rl-all"), (board?.top ?? []).slice(0, 10), me ?? undefined);
  const note = $("rl-an");
  if (!me) {
    note.innerHTML = `<a href="/login?next=/rally">Log in</a> to put your laps on the board.`;
  } else if (!board) note.textContent = "The board shows once you are online.";
  else if (!boardLive) note.textContent = `As of ${new Date(board.at).toLocaleString(undefined, { dateStyle: "medium", timeStyle: "short" })}.`;
  else note.textContent = board.top.length ? "Only races driven in sync count." : "No laps on the board yet.";
}

/**
 * The board and, signed in, the bank. With the bank in, the credits are the
 * account's and the races are synced from here on.
 */
async function loadBoard() {
  try {
    const res = await fetch("/api/social/rally", { cache: "no-store", credentials: "same-origin", headers: { Accept: "application/json" } });
    // With no network the worker answers from its last copy, and says so (client/sw).
    const copy = Number(res.headers.get("ug-at"));
    const data = await res.json();
    if (!res.ok) return;
    board = { top: Array.isArray(data.top) ? data.top : [], best: Number(data.best) || 0, at: copy || Date.now() };
    write(BOARD_KEY, board);
    boardLive = !copy;
    if (!copy && data.signed && data.bank && phase === "menu") {
      bank = data.bank;
      if (!synced) synced = live("rally", $("rl-lv"));
    } else if (!copy && !data.signed) bank = null;
  } catch {
    // Offline: the board as last kept, the device's credits.
  }
  paintPanel();
  paintCredits();
  if (!boardEl.hidden) paintBoard();
  if (!storeEl.hidden) paintStore();
}

onName(() => {
  if (phase === "menu") loadBoard();
});

/* ---------- Page ---------- */

/** The most pixels a frame is drawn at, however large and sharp the screen: past this, sharper costs smoothness. */
const MAX_PIXELS = 2_400_000;

function resize() {
  const cw = stage.clientWidth || 1;
  const ch = stage.clientHeight || 1;
  let dpr = Math.min(touch ? 2 : 2.5, window.devicePixelRatio || 1) * quality;
  dpr = Math.min(dpr, Math.sqrt(MAX_PIXELS / (cw * ch)));
  width = Math.max(1, Math.round(cw * dpr));
  height = Math.max(1, Math.round(ch * dpr));
  if (canvas.width !== width || canvas.height !== height) {
    canvas.width = width;
    canvas.height = height;
  }
}

/** Back: where the visitor came from on this site, else the games list. */
$("rl-bk").addEventListener("click", () => {
  if (history.length > 1 && document.referrer.startsWith(location.origin)) history.back();
  else location.href = "/games";
});

noZoom();
new ResizeObserver(resize).observe(stage);
resize();
paintPanel();
paintCredits();
paintBoosts();
if (!gfx) {
  $("rl-rs").textContent = "This browser can’t draw the course: Rally needs WebGL.";
  /** @type {HTMLButtonElement} */ ($("rl-go")).disabled = true;
} else requestAnimationFrame(frame);
loadBoard();
keepOffline();
plainSwap();
noStickyHover();
