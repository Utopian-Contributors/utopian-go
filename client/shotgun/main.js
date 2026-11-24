/**
 * Shotgun: the page around the field. Between games, the wheel: spin it for a
 * gun to start with, credits, or a multiplier on the credits the next game
 * earns. Credits are the game's one count: the wheel pays them and costs them,
 * and the zombies pay them. The first spin before each game is free, and every spin
 * after it costs twice the last. Then the zombie waves (game.js), which pay
 * credits for every zombie shot; spent at the wheel, they arm the next game.
 *
 * Everything lives on this device (localStorage `ug.sg`): the credits, the
 * kit the wheel has won for the next game, and the most one game has earned. Like the other
 * games it is offline first, and it never needs an account.
 */
import { keepOffline } from "../games/offline.js";
import { tone, wakeAudio } from "../games/sound.js";
import { noZoom } from "../js/device.js";
import { plainSwap } from "../js/plainswap.js";
import { GUNS, STICK, canPlace, credits, draw, game, listen, newGame, placeTurret, scenery, settling, size, update } from "./game.js";
import { label, paintWheel, spin } from "./wheel.js";

/** @typedef {import("./game.js").Kit} Kit */

/** @param {string} id */
const $ = (id) => /** @type {HTMLElement} */ (document.getElementById(id));

const canvas = /** @type {HTMLCanvasElement} */ ($("sg-c"));
const ctx = /** @type {CanvasRenderingContext2D} */ (canvas.getContext("2d"));
const box = $("sg-t");
const wheelEl = /** @type {HTMLCanvasElement} */ ($("sg-wh"));
const spinBtn = /** @type {HTMLButtonElement} */ ($("sg-sp"));
const playBtn = /** @type {HTMLButtonElement} */ ($("sg-go"));
const kitOut = $("sg-kit");
const noteOut = $("sg-nt");
const msgOut = $("sg-msg");
const creditsOut = $("sg-cr");
const placeBtn = /** @type {HTMLButtonElement} */ ($("sg-pl"));

const fmt = (n) => n.toLocaleString("en-US");
const touch = matchMedia("(hover: none)").matches;

/* ---------- What this device keeps ---------- */

const KEY = "ug.sg";

/** @returns {Kit} */
const emptyKit = () => ({ gun: null, ammo: 0, mult: 1 });

/** @type {{credits: number, most: number, bestWave: number, spins: number, kit: Kit}} */
const saved = (() => {
  const fresh = { credits: 0, most: 0, bestWave: 0, spins: 0, kit: emptyKit() };
  try {
    const raw = JSON.parse(localStorage.getItem(KEY) || "null");
    if (!raw || typeof raw !== "object") return fresh;
    const kit = raw.kit && typeof raw.kit === "object" ? raw.kit : {};
    return {
      credits: Math.max(0, Math.floor(Number(raw.credits) || 0)),
      most: Math.max(0, Math.floor(Number(raw.most) || 0)),
      bestWave: Math.max(0, Math.floor(Number(raw.bestWave) || 0)),
      spins: Math.max(0, Math.floor(Number(raw.spins) || 0)),
      kit: {
        gun: kit.gun in GUNS && kit.gun !== "pistol" ? kit.gun : null,
        ammo: Math.max(0, Math.floor(Number(kit.ammo) || 0)),
        mult: Math.max(1, Number(kit.mult) || 1),
      },
    };
  } catch {
    return fresh;
  }
})();

function save() {
  try {
    localStorage.setItem(KEY, JSON.stringify(saved));
  } catch {
    // Private mode or a full quota: it lasts as long as the page.
  }
}

/** The next spin's price: the first before each game free, then 20, 40, 80… */
const cost = () => (saved.spins === 0 ? 0 : 20 * 2 ** (saved.spins - 1));

/* ---------- Sound ---------- */

const SOUNDS = {
  pistol: () => tone(520, 0.07, "square", 180, 0.03),
  shotgun: () => tone(200, 0.18, "sawtooth", 50, 0.07),
  smg: () => tone(700, 0.04, "square", 300, 0.02),
  rifle: () => tone(900, 0.12, "sawtooth", 120, 0.05),
  kill: () => tone(160, 0.12, "triangle", 70, 0.05),
  boom: () => {
    tone(90, 0.5, "sawtooth", 30, 0.09);
    tone(60, 0.6, "square", 25, 0.05, 0.03);
  },
  hurt: () => tone(180, 0.15, "square", 90, 0.05),
  pickup: () => [660, 880, 1175].forEach((f, i) => tone(f, 0.09, "square", f, 0.04, i * 0.06)),
  wave: () => [392, 523].forEach((f, i) => tone(f, 0.16, "triangle", f, 0.05, i * 0.12)),
  over: () => tone(240, 0.6, "sawtooth", 50, 0.06),
  tick: () => tone(1400, 0.02, "square", 1200, 0.02),
  turret: () => tone(820, 0.05, "square", 420, 0.015),
  placed: () => [330, 494].forEach((f, i) => tone(f, 0.08, "triangle", f, 0.05, i * 0.07)),
  win: () => [523, 659, 784, 1047].forEach((f, i) => tone(f, 0.14, "square", f, 0.04, i * 0.08)),
};

/* ---------- The header, the message, the panel ---------- */

/** @param {string} text */
function say(text) {
  msgOut.textContent = text;
  msgOut.hidden = !text;
}

let sayTimer = 0;
/** A message that clears itself. @param {string} text @param {number} [ms] */
function flash(text, ms = 1600) {
  say(text);
  clearTimeout(sayTimer);
  sayTimer = window.setTimeout(() => {
    if (game.state === "play" && !paused) say("");
  }, ms);
}

function paintCounters() {
  const live = game.state === "play" ? credits() : 0;
  creditsOut.textContent = fmt(saved.credits + live);
}

/** The kit the wheel has won, as chips. */
function paintKit() {
  const { kit } = saved;
  /** @type {string[]} */
  const chips = [];
  if (kit.gun) chips.push(`${GUNS[kit.gun].name} · ${kit.ammo}`);
  if (kit.mult > 1) chips.push(`×${+kit.mult.toFixed(2)} credits`);
  kitOut.replaceChildren(
    ...(chips.length ? chips : ["Spin for a gun, credits or a multiplier"]).map((text) => {
      const li = document.createElement("li");
      li.textContent = text;
      if (!chips.length) li.className = "sg-none";
      return li;
    }),
  );
}

function paintButtons() {
  const price = cost();
  spinBtn.textContent = price ? `Spin · ${fmt(price)} credits` : "Spin · free";
  spinBtn.disabled = spinning || saved.credits < price;
  playBtn.disabled = spinning;
}

function paintPanel() {
  paintKit();
  paintButtons();
  paintCounters();
}

/* ---------- The wheel ---------- */

let spinning = false;

spinBtn.addEventListener("click", async () => {
  const price = cost();
  if (spinning || saved.credits < price) return;
  wakeAudio();
  saved.credits -= price;
  saved.spins++;
  save();
  spinning = true;
  noteOut.textContent = "";
  paintPanel();
  const prize = await spin(wheelEl, SOUNDS.tick);
  const { kit } = saved;
  if (prize.kind === "gun") {
    const ammo = GUNS[prize.gun].ammo * 2;
    kit.ammo = kit.gun === prize.gun ? kit.ammo + ammo : ammo;
    kit.gun = prize.gun;
    noteOut.textContent = `${prize.gun === "smg" ? "An" : "A"} ${GUNS[prize.gun].name}! You start the next game with it.`;
  } else if (prize.kind === "credits") {
    saved.credits += prize.n;
    noteOut.textContent = `${label(prize)} credits.`;
  } else {
    kit.mult = Math.round(kit.mult * prize.x * 100) / 100;
    noteOut.textContent = `${label(prize)} on the credits you earn next game.`;
  }
  save();
  spinning = false;
  (prize.kind === "gun" ? SOUNDS.win : SOUNDS.pickup)();
  paintPanel();
});

/* ---------- The game ---------- */

let raf = 0;
let last = 0;
let paused = false;

listen((type, data) => {
  if (type === "shot") SOUNDS[/** @type {keyof typeof SOUNDS} */ (data)]?.();
  else if (type === "kill") SOUNDS.kill();
  else if (type === "boom") SOUNDS.boom();
  else if (type === "hurt") SOUNDS.hurt();
  else if (type === "turret") {
    SOUNDS.pickup();
    flash(touch ? "Turret! Tap Place turret, then where it goes" : "Turret! Press E, then click where it goes", 2600);
    paintPlace();
  } else if (type === "placed") {
    SOUNDS.placed();
    paintPlace();
  } else if (type === "spent") flash("A turret ran out of rounds");
  else if (type === "pickup") {
    SOUNDS.pickup();
    flash(`${GUNS[/** @type {import("./game.js").GunId} */ (data)].name}!`);
  } else if (type === "empty") flash("Out of ammo: back to the pistol");
  else if (type === "wave") {
    SOUNDS.wave();
    flash(data === 2 ? "Wave 2 · guns unlocked: shoot a crate" : data === 3 ? "Wave 3 · here come the blue ones" : `Wave ${data}`, 2200);
  } else if (type === "cleared") flash(`Wave ${data.wave} cleared · +${fmt(data.bonus)} credits`, 2200);
  else if (type === "over") finish();
  else if (type === "earn") paintCounters();
});

/** @param {number} now */
function frame(now) {
  raf = 0;
  const dt = Math.min(0.05, (now - (last || now)) / 1000);
  last = now;
  if (!paused) update(dt);
  paint();
  if ((game.state === "play" && !paused) || settling()) run();
}

function run() {
  if (!raf) raf = requestAnimationFrame(frame);
}

function paint() {
  const u = Math.min(canvas.width, canvas.height) / 100;
  draw(ctx, canvas.width, canvas.height, u);
}

function start() {
  if (spinning) return;
  wakeAudio();
  newGame(saved.kit);
  // The kit is spent on this game, and the wheel's prices start over.
  saved.kit = emptyKit();
  saved.spins = 0;
  save();
  paused = false;
  document.body.classList.add("sg-on");
  held.clear();
  walker = shooter = -1;
  stopPlacing();
  say(touch ? "Left thumb walks · other finger shoots" : "WASD or arrows walk · hold the mouse to shoot");
  clearTimeout(sayTimer);
  sayTimer = window.setTimeout(() => game.state === "play" && !paused && say(""), 3200);
  last = 0;
  paintCounters();
  run();
}

function finish() {
  stopPlacing();
  const earned = credits();
  saved.credits += earned;
  const best = earned > saved.most;
  if (best) saved.most = earned;
  if (game.wave > saved.bestWave) saved.bestWave = game.wave;
  save();
  SOUNDS.over();
  clearTimeout(sayTimer);
  say(best ? "New best!" : "The zombies got you");
  const mult = game.mult > 1 ? ` (×${+game.mult.toFixed(2)})` : "";
  noteOut.textContent = `Wave ${game.wave} · +${fmt(earned)} credits${mult}`;
  window.setTimeout(() => {
    document.body.classList.remove("sg-on");
    paintPanel();
    paintBest();
    playBtn.textContent = "Play again";
    playBtn.focus({ preventScroll: true });
  }, 900);
}

function paintBest() {
  $("sg-bs").textContent = saved.most ? `Most in a game ${fmt(saved.most)} · best wave ${saved.bestWave}` : "";
}

function pause() {
  if (game.state !== "play" || paused) return;
  paused = true;
  game.firing = false;
  game.mx = game.my = 0;
  game.stick = null;
  walker = shooter = -1;
  held.clear();
  say(touch ? "Paused · tap to go on" : "Paused · click or press Space to go on");
}

function resume() {
  if (!paused) return;
  paused = false;
  say("");
  last = 0;
  run();
}

playBtn.addEventListener("click", start);

/* ---------- Turrets ---------- */

/** While on, the next press on the field puts a carried turret there instead of shooting. */
let placing = false;
/** Where the mouse last was over the field, in units, for the turret's preview. */
let lastMouse = /** @type {{x: number, y: number} | null} */ (null);

function paintPlace() {
  placeBtn.hidden = game.state !== "play" || game.carry < 1;
  placeBtn.classList.toggle("on", placing);
  const n = game.carry > 1 ? ` ×${game.carry}` : "";
  placeBtn.textContent = placing ? "Cancel" : `Place turret${n}${touch ? "" : " (E)"}`;
}

function startPlacing() {
  if (game.state !== "play" || game.carry < 1) return;
  placing = true;
  game.firing = false;
  shooter = -1;
  game.ghost = touch ? null : lastMouse || { x: game.px, y: game.py - 12 };
  say(touch ? "Tap where the turret goes" : "Click where the turret goes · Esc to cancel");
  paintPlace();
}

function stopPlacing() {
  placing = false;
  game.ghost = null;
  paintPlace();
}

placeBtn.addEventListener("click", () => {
  wakeAudio();
  if (placing) {
    stopPlacing();
    say("");
  } else startPlacing();
});

/** Put the turret down where the press was, or say why not. @param {PointerEvent} e */
function placeAt(e) {
  const p = toWorld(e);
  if (placeTurret(p.x, p.y)) {
    stopPlacing();
    say("");
  } else if (!canPlace(p.x, p.y)) {
    game.ghost = p;
    flash("It can't go there", 1200);
  }
}

/* ---------- Walking, aiming and shooting ---------- */

/** A point on the page in the field's units. @param {PointerEvent} e */
function toWorld(e) {
  const rect = canvas.getBoundingClientRect();
  const per = Math.min(rect.width, rect.height) / 100;
  return { x: (e.clientX - rect.left - rect.width / 2) / per, y: (e.clientY - rect.top - rect.height / 2) / per };
}

/** Aim from where the player stands at a point on the page. @param {PointerEvent} e */
function aimAt(e) {
  const p = toWorld(e);
  game.aim = Math.atan2(p.y - game.py, p.x - game.px);
}

let shooter = -1;
/** The finger on the thumb-stick: one that went down on the field's left part, on a touch screen. */
let walker = -1;

canvas.addEventListener("pointerdown", (e) => {
  if (game.state !== "play") return;
  wakeAudio();
  if (paused) {
    resume();
    return;
  }
  if (placing) {
    placeAt(e);
    return;
  }
  canvas.setPointerCapture?.(e.pointerId);
  const rect = canvas.getBoundingClientRect();
  if (e.pointerType !== "mouse" && walker < 0 && e.clientX - rect.left < rect.width * 0.4) {
    walker = e.pointerId;
    const p = toWorld(e);
    game.stick = { x: p.x, y: p.y, dx: 0, dy: 0 };
    return;
  }
  if (shooter >= 0) return;
  shooter = e.pointerId;
  aimAt(e);
  game.firing = true;
});

canvas.addEventListener("pointermove", (e) => {
  if (game.state !== "play") return;
  if (e.pointerId === walker && game.stick) {
    const p = toWorld(e);
    let dx = (p.x - game.stick.x) / STICK;
    let dy = (p.y - game.stick.y) / STICK;
    const m = Math.hypot(dx, dy);
    if (m > 1) {
      // Past its reach, the ring follows the thumb.
      game.stick.x += (dx - dx / m) * STICK;
      game.stick.y += (dy - dy / m) * STICK;
      dx /= m;
      dy /= m;
    }
    game.stick.dx = dx;
    game.stick.dy = dy;
    // A little give at the middle, so a resting thumb stands still.
    const live = m > 0.18;
    game.mx = live ? dx : 0;
    game.my = live ? dy : 0;
    return;
  }
  if (e.pointerType === "mouse") {
    lastMouse = toWorld(e);
    if (placing) game.ghost = lastMouse;
  }
  // A mouse aims as it moves; a finger only while it is down.
  if (e.pointerType === "mouse" || e.pointerId === shooter) aimAt(e);
});

for (const type of ["pointerup", "pointercancel", "lostpointercapture"]) {
  canvas.addEventListener(type, (e) => {
    const id = /** @type {PointerEvent} */ (e).pointerId;
    if (id === walker) {
      walker = -1;
      game.stick = null;
      keyWalk();
    }
    if (id === shooter) {
      shooter = -1;
      game.firing = false;
    }
  });
}

canvas.addEventListener("contextmenu", (e) => e.preventDefault());

/** The keys that walk, and which way. @type {Record<string, [number, number]>} */
const WALKS = {
  KeyW: [0, -1],
  ArrowUp: [0, -1],
  KeyS: [0, 1],
  ArrowDown: [0, 1],
  KeyA: [-1, 0],
  ArrowLeft: [-1, 0],
  KeyD: [1, 0],
  ArrowRight: [1, 0],
};
/** @type {Set<string>} */
const held = new Set();

/** The walk the held keys add up to. */
function keyWalk() {
  if (walker >= 0) return;
  let x = 0;
  let y = 0;
  for (const code of held) {
    x += WALKS[code][0];
    y += WALKS[code][1];
  }
  game.mx = Math.sign(x);
  game.my = Math.sign(y);
}

window.addEventListener("keyup", (e) => {
  if (held.delete(e.code)) keyWalk();
});

window.addEventListener("keydown", (e) => {
  if (e.metaKey || e.ctrlKey || e.altKey) return;
  if (WALKS[e.code]) {
    if (game.state !== "play") return;
    e.preventDefault();
    held.add(e.code);
    keyWalk();
    if (paused) resume();
    return;
  }
  if (game.state === "play" && (e.code === "KeyE" || (e.code === "Escape" && placing))) {
    e.preventDefault();
    if (e.repeat) return;
    if (placing) {
      stopPlacing();
      say("");
    } else startPlacing();
    return;
  }
  if (e.code !== "Space" && e.code !== "KeyP" && e.code !== "Enter") return;
  if (e.code !== "KeyP" && /** @type {Element} */ (e.target).closest?.("a, button")) return;
  if (game.state !== "play") return;
  e.preventDefault();
  if (e.repeat) return;
  if (paused) resume();
  else pause();
});

window.addEventListener("blur", () => {
  held.clear();
  keyWalk();
  pause();
});
document.addEventListener("visibilitychange", () => {
  if (document.hidden) pause();
});

/* ---------- Page ---------- */

function resize() {
  const dpr = Math.min(3, window.devicePixelRatio || 1);
  const w = Math.round(box.clientWidth * dpr);
  const h = Math.round(box.clientHeight * dpr);
  if (!w || !h || (w === canvas.width && h === canvas.height)) return;
  canvas.width = w;
  canvas.height = h;
  const short = Math.min(w, h);
  size((w / short) * 50, (h / short) * 50);
  scenery();
  paint();
}

/** Back: where the visitor came from on this site, else the games list. */
$("sg-bk").addEventListener("click", () => {
  if (history.length > 1 && document.referrer.startsWith(location.origin)) history.back();
  else location.href = "/games";
});

noZoom();
new ResizeObserver(resize).observe(box);
resize();
new ResizeObserver(() => paintWheel(wheelEl)).observe(wheelEl);
paintWheel(wheelEl);
paintPanel();
paintBest();
keepOffline();
plainSwap();
