/**
 * Shotgun: the page around the field. Between games, the wheel: spin it for a
 * gun to start with, credits, or a multiplier on the credits the next game
 * earns. Credits are the game's one count: the wheel pays them and costs them,
 * and the zombies pay them. The first spin before each game is free, and every spin
 * after it costs twice the last. Then the zombie waves (game.js), which pay
 * credits for every zombie shot; spent at the wheel, they arm the next game.
 *
 * Signed in, the credits are the account's bank (src/social/shotgun.ts): the
 * wheel is spun on the server, each game is synced as it is played
 * (games/live.js), and what a synced game earns is banked there, to spend on
 * Shotgun's badges in the Shop. Signed out, or with the server out of reach
 * as the page opens, everything lives on this device (localStorage `ug.sg`):
 * the credits, the kit the wheel has won for the next game, and the most one
 * game has earned. Like the other games it is offline first, and it never
 * needs an account.
 */
import { BADGE_PRICE, applyPrize, spinPrice } from "../../src/social/shotgun.ts";
import { live } from "../games/live.js";
import { tally } from "../games/tally.js";
import { keepOffline } from "../games/offline.js";
import { readName } from "../js/me.js";
import { tone, wakeAudio } from "../games/sound.js";
import { noZoom } from "../js/device.js";
import { plainSwap } from "../js/plainswap.js";
import { GUNS, STICK, TURRETS, canPlace, credits, draw, game, listen, newGame, placeTurret, scenery, settling, size, update } from "./game.js";
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
const liveOut = $("sg-lv");
const shopOut = $("sg-sh");

const fmt = (n) => n.toLocaleString("en-US");
const touch = matchMedia("(hover: none)").matches;

/* ---------- What this device keeps ---------- */

const KEY = "ug.sg";

/** @returns {Kit} */
const emptyKit = () => ({ gun: null, ammo: 0, mult: 1 });

/** @type {{credits: number, most: number, bestWave: number, spins: number, kit: Kit}} */
const device = (() => {
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

/** The credits in play: the device's, or, once the account's bank has loaded, the bank. */
let saved = device;
/** The account's games, synced as they are played; null on the device's credits. @type {ReturnType<typeof live> | null} */
let synced = null;

function save() {
  if (saved !== device) return;
  try {
    localStorage.setItem(KEY, JSON.stringify(saved));
  } catch {
    // Private mode or a full quota: it lasts as long as the page.
  }
}

/** The next spin's price: the first before each game free, then 20, 40, 80… */
const cost = () => spinPrice(saved.spins);

/**
 * Signed in, the account's bank: its credits from here on, and its games
 * synced. Out of reach, the page plays on the device's credits.
 */
async function loadBank() {
  if (!readName()) return;
  try {
    const res = await fetch("/api/social/shotgun", { cache: "no-store", credentials: "same-origin", headers: { Accept: "application/json" } });
    const data = await res.json();
    if (!res.ok || !data.signed || !data.bank) return;
    if (game.state === "play" || spinning) return;
    saved = data.bank;
    shown = -1;
    liveOut.hidden = false;
    synced = live("shotgun", liveOut);
    paintPanel();
    paintBest();
  } catch {
    // Offline: the device's credits.
  }
}

/** POST to the account's Shotgun, its answer or its refusal (with the bank as it is, when it says). */
async function post(path, body) {
  const res = await fetch(`/api/social/shotgun/${path}`, {
    method: "POST",
    headers: { "Content-Type": "application/json", Accept: "application/json" },
    body: JSON.stringify(body),
    cache: "no-store",
    credentials: "same-origin",
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw Object.assign(new Error(data.error || "That didn’t go through."), { bank: data.bank });
  return data;
}

/* ---------- Sound ---------- */

/** When a sound that would play every frame last played. */
const lastAt = { laser: 0, mini: 0 };
/** @param {keyof typeof lastAt} k @param {number} ms whether it has been that long */
const due = (k, ms) => {
  const now = performance.now();
  if (now - lastAt[k] < ms) return false;
  lastAt[k] = now;
  return true;
};
const SOUNDS = {
  pistol: () => tone(520, 0.07, "square", 180, 0.03),
  shotgun: () => tone(200, 0.18, "sawtooth", 50, 0.07),
  smg: () => tone(700, 0.04, "square", 300, 0.02),
  rifle: () => tone(900, 0.12, "sawtooth", 120, 0.05),
  minigun: () => tone(560, 0.03, "square", 260, 0.015),
  railgun: () => {
    tone(2200, 0.32, "sawtooth", 160, 0.05);
    tone(90, 0.3, "square", 40, 0.04);
  },
  rocket: () => tone(140, 0.35, "sawtooth", 420, 0.05),
  // The cell going live, then a hum while the beam burns.
  laser: () => tone(300, 0.25, "sawtooth", 1400, 0.05),
  lase: () => due("laser", 110) && tone(1300 + Math.random() * 120, 0.12, "sawtooth", 1250, 0.012),
  turretMini: () => due("mini", 70) && tone(620, 0.03, "square", 300, 0.012),
  dome: () => [520, 260].forEach((f, i) => tone(f, 0.2, "triangle", f * 0.6, 0.05, i * 0.1)),
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

/** The credits as drawn, counting towards what they are; and the change shown beside them (games/tally.js), as Snake, Pinball and Slots show theirs. */
let shown = -1;
let target = -1;
let counting = 0;
const jolt = tally(creditsOut);
const reduceMotion = matchMedia("(prefers-reduced-motion: reduce)");

function paintCounters() {
  const live = game.state === "play" ? credits() : 0;
  const to = saved.credits + live;
  if (to === target) return;
  const from = shown < 0 ? to : shown;
  target = to;
  cancelAnimationFrame(counting);
  // The first paint, and the bank loading in, are no change to celebrate.
  const quiet = shown < 0;
  const dur = quiet || reduceMotion.matches || Math.abs(to - from) < 2 ? 0 : Math.min(900, 250 + Math.abs(to - from) * 4);
  if (!quiet && to !== from) jolt(to - from, dur);
  const t0 = performance.now();
  const step = (/** @type {number} */ now) => {
    const t = dur ? Math.min(1, (now - t0) / dur) : 1;
    shown = Math.round(from + (to - from) * (1 - (1 - t) ** 3));
    creditsOut.textContent = fmt(shown);
    if (t < 1) counting = requestAnimationFrame(step);
  };
  if (dur) counting = requestAnimationFrame(step);
  else step(t0);
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
  spinning = true;
  noteOut.textContent = "";
  paintPanel();
  /** @type {import("../../src/social/shotgun.ts").Prize} */
  let prize;
  if (synced) {
    // The account's wheel: the server says where it stops, and the bank after.
    let out;
    try {
      out = await post("spin", { n: saved.spins });
    } catch (err) {
      const bank = /** @type {any} */ (err).bank;
      if (bank) saved = bank;
      noteOut.textContent = navigator.onLine ? /** @type {Error} */ (err).message : "You’re offline: the wheel needs a connection.";
      spinning = false;
      paintPanel();
      return;
    }
    // Shown spent while it turns; the prize lands with it.
    saved = { ...saved, credits: saved.credits - price };
    paintCounters();
    prize = await spin(wheelEl, SOUNDS.tick, out.segment);
    saved = out.bank;
  } else {
    saved.credits -= price;
    saved.spins++;
    save();
    paintCounters();
    prize = await spin(wheelEl, SOUNDS.tick);
    Object.assign(saved, applyPrize(saved, prize));
    save();
  }
  if (prize.kind === "gun") noteOut.textContent = `${prize.gun === "smg" ? "An" : "A"} ${GUNS[prize.gun].name}! You start the next game with it.`;
  else if (prize.kind === "credits") noteOut.textContent = `${label(prize)} credits.`;
  else noteOut.textContent = `${label(prize)} on the credits you earn next game.`;
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
  else if (type === "lase") SOUNDS.lase();
  else if (type === "dome") {
    SOUNDS.dome();
    flash("A dome went down");
  } else if (type === "turret") {
    SOUNDS.pickup();
    const name = TURRETS[/** @type {import("./game.js").TurretKind} */ (data)].name;
    flash(touch ? `${name}! Tap Place, then where it goes` : `${name}! Press E, then click where it goes`, 2600);
    paintPlace();
  } else if (type === "placed") {
    SOUNDS.placed();
    paintPlace();
  } else if (type === "spent") flash(data === "bio" ? "The gas has cleared" : "A turret ran out of rounds");
  else if (type === "heal") {
    SOUNDS.pickup();
    flash("Health refilled");
  }
  else if (type === "pickup") {
    SOUNDS.pickup();
    flash(`${GUNS[/** @type {import("./game.js").GunId} */ (data)].name}!`);
  } else if (type === "empty") flash("Out of ammo: back to the pistol");
  else if (type === "wave") {
    SOUNDS.wave();
    const fresh = [...Object.values(GUNS), ...Object.values(TURRETS)].find((g) => g.from === data && data > 2);
    flash(
      data === 2 ? "Wave 2 · guns unlocked: shoot a crate" : data === 3 ? "Wave 3 · here come the blue ones" : fresh ? `Wave ${data} · ${fresh.name} unlocked: find its crate` : `Wave ${data}`,
      2600,
    );
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
  // The account's: synced from here, the wave and the credits before the multiplier.
  synced?.begin(() => ({ w: game.wave, e: game.earned }));
  paused = false;
  document.body.classList.add("sg-on");
  held.clear();
  walker = shooter = aimer = -1;
  placePads();
  stopPlacing();
  say(touch ? "Left thumb walks · right thumb aims and shoots" : "WASD or arrows walk · hold the mouse to shoot");
  clearTimeout(sayTimer);
  sayTimer = window.setTimeout(() => game.state === "play" && !paused && say(""), 3200);
  last = 0;
  paintCounters();
  run();
}

async function finish() {
  stopPlacing();
  const earned = credits();
  const best = earned > saved.most;
  SOUNDS.over();
  clearTimeout(sayTimer);
  say(best ? "New best!" : "The zombies got you");
  const mult = game.mult > 1 ? ` (×${+game.mult.toFixed(2)})` : "";
  const ended = Date.now();
  if (synced) {
    // Banked by the server, if the game stayed in sync from start to end.
    const result = await synced.end({ w: game.wave, e: game.earned });
    if (result?.bank) {
      saved = result.bank;
      noteOut.textContent = `Wave ${game.wave} · +${fmt(result.banked)} credits${mult}`;
    } else {
      noteOut.textContent = `Wave ${game.wave} · this game fell out of sync, so its ${fmt(earned)} credits weren’t banked`;
    }
  } else {
    saved.credits += earned;
    if (best) saved.most = earned;
    if (game.wave > saved.bestWave) saved.bestWave = game.wave;
    save();
    noteOut.textContent = `Wave ${game.wave} · +${fmt(earned)} credits${mult}`;
  }
  window.setTimeout(() => {
    document.body.classList.remove("sg-on");
    paintPanel();
    paintBest();
    playBtn.textContent = "Play again";
    playBtn.focus({ preventScroll: true });
  }, Math.max(0, 900 - (Date.now() - ended)));
}

function paintBest() {
  $("sg-bs").textContent = saved.most ? `Most in a game ${fmt(saved.most)} · best wave ${saved.bestWave}` : "";
  // What the credits are for: the Shop's badges, bought from the account's bank.
  const link = document.createElement("a");
  if (synced) {
    const left = BADGE_PRICE - saved.credits;
    link.href = "/social/shop";
    link.textContent = left > 0 ? `${fmt(left)} more for a Shotgun badge` : "Spend 10,000 on a badge in the Shop";
  } else if (readName()) {
    // Signed in, but the bank was out of reach as the page opened.
    shopOut.textContent = "Offline: these credits are this device’s";
    return;
  } else {
    link.href = "/login?next=/shotgun";
    link.textContent = "Log in to bank credits for Shop badges";
  }
  shopOut.replaceChildren(link);
}

function pause() {
  if (game.state !== "play" || paused) return;
  paused = true;
  synced?.pause();
  game.firing = false;
  game.mx = game.my = 0;
  walker = shooter = aimer = -1;
  placePads();
  held.clear();
  say(touch ? "Paused · tap to go on" : "Paused · click or press Space to go on");
}

function resume() {
  if (!paused) return;
  paused = false;
  synced?.resume();
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
  placeBtn.hidden = game.state !== "play" || game.carry.length < 1;
  placeBtn.classList.toggle("on", placing);
  const next = game.carry[0];
  const name = next && next !== "sentry" ? TURRETS[next].name.toLowerCase() : "turret";
  const n = game.carry.length > 1 ? ` ×${game.carry.length}` : "";
  placeBtn.textContent = placing ? "Cancel" : `Place ${name}${n}${touch ? "" : " (E)"}`;
}

function startPlacing() {
  if (game.state !== "play" || game.carry.length < 1) return;
  placing = true;
  game.firing = false;
  shooter = aimer = -1;
  if (game.aimStick) game.aimStick.dx = game.aimStick.dy = 0;
  game.firing = false;
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

/** The mouse button held down to shoot. */
let shooter = -1;
/** The thumb on the walking stick, the bottom left one on a touch screen. */
let walker = -1;
/** The thumb on the aiming stick, the bottom right one. */
let aimer = -1;

/**
 * On a touch screen the two sticks stand still low on the field, in from its
 * sides and high enough to leave Place turret free under the right one, clear
 * of the health bar and a phone's home indicator: walking on the left,
 * aiming and shooting on the right. Set again whenever the field changes
 * size; a stick let go has its knob back in the middle.
 */
function placePads() {
  if (!touch) return;
  const per = box.clientHeight / (2 * game.hh) || 1;
  const side = 52 / per + STICK;
  const y = game.hh - (96 + game.inset / Math.min(3, window.devicePixelRatio || 1)) / per - STICK;
  game.pads = [
    { x: -game.hw + side, y },
    { x: game.hw - side, y },
  ];
  if (game.state !== "play") return;
  game.stick = { ...game.pads[0], dx: 0, dy: 0 };
  game.aimStick = { ...game.pads[1], dx: 0, dy: 0 };
}

/**
 * Move a thumb-stick's knob towards where the finger is, and say how far it
 * is pushed (0…1).
 * @param {{x: number, y: number, dx: number, dy: number}} stick @param {PointerEvent} e
 */
function push(stick, e) {
  const p = toWorld(e);
  let dx = (p.x - stick.x) / STICK;
  let dy = (p.y - stick.y) / STICK;
  const m = Math.hypot(dx, dy);
  // The stick stays put; the knob goes no further than its ring.
  if (m > 1) {
    dx /= m;
    dy /= m;
  }
  stick.dx = dx;
  stick.dy = dy;
  return Math.min(m, 1);
}

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
  if (e.pointerType !== "mouse") {
    // Two sticks, fixed: the one on the touch's side takes it if it lands
    // near enough, the left walking, the right aiming and, pushed, shooting.
    const p = toWorld(e);
    const left = e.clientX - rect.left < rect.width / 2;
    const s = left ? game.stick : game.aimStick;
    if (!s || Math.hypot(p.x - s.x, p.y - s.y) > STICK * 2.6) return;
    if (left) {
      if (walker >= 0) return;
      walker = e.pointerId;
    } else {
      if (aimer >= 0) return;
      aimer = e.pointerId;
    }
    move(e);
    return;
  }
  if (shooter >= 0) return;
  shooter = e.pointerId;
  aimAt(e);
  game.firing = true;
});

canvas.addEventListener("pointermove", move);

/** A pointer moved: a stick's thumb pushes it, a mouse aims. @param {PointerEvent} e */
function move(e) {
  if (game.state !== "play") return;
  if (e.pointerId === walker && game.stick) {
    const m = push(game.stick, e);
    // A little give at the middle, so a resting thumb stands still.
    const live = m > 0.18;
    game.mx = live ? game.stick.dx : 0;
    game.my = live ? game.stick.dy : 0;
    return;
  }
  if (e.pointerId === aimer && game.aimStick) {
    const s = game.aimStick;
    const m = push(s, e);
    // The gun turns as soon as the stick leans, and fires once it is pushed.
    if (m > 0.18) game.aim = Math.atan2(s.dy, s.dx);
    game.firing = m > 0.45;
    return;
  }
  if (e.pointerType === "mouse") {
    lastMouse = toWorld(e);
    if (placing) game.ghost = lastMouse;
  }
  // A mouse aims as it moves.
  if (e.pointerType === "mouse") aimAt(e);
}

for (const type of ["pointerup", "pointercancel", "lostpointercapture"]) {
  canvas.addEventListener(type, (e) => {
    const id = /** @type {PointerEvent} */ (e).pointerId;
    if (id === walker) {
      walker = -1;
      if (game.stick) game.stick.dx = game.stick.dy = 0;
      keyWalk();
    }
    if (id === shooter) {
      shooter = -1;
      game.firing = false;
    }
    if (id === aimer) {
      aimer = -1;
      if (game.aimStick) game.aimStick.dx = game.aimStick.dy = 0;
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

/** Measures the bottom safe area (env() is only readable through a style). */
const safe = document.createElement("div");
safe.style.cssText = "position:fixed;left:0;bottom:0;width:0;height:env(safe-area-inset-bottom,0px);visibility:hidden;pointer-events:none";
document.body.append(safe);

function resize() {
  const dpr = Math.min(3, window.devicePixelRatio || 1);
  game.inset = safe.offsetHeight * dpr;
  const w = Math.round(box.clientWidth * dpr);
  const h = Math.round(box.clientHeight * dpr);
  if (!w || !h || (w === canvas.width && h === canvas.height)) return;
  canvas.width = w;
  canvas.height = h;
  const short = Math.min(w, h);
  size((w / short) * 50, (h / short) * 50);
  placePads();
  // Between games, barrels laid for the old shape may sit on a stick.
  if (game.state === "idle") game.barrels = [];
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
loadBank();
keepOffline();
plainSwap();
