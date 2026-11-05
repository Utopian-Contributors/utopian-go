/**
 * Pinball. One table drawn on a canvas, played with two buttons (or Z and /,
 * the arrow keys, Shift), and a leaderboard of each account's best game.
 *
 * The table is in its own units, W × H. Its art (art.js) is pixel art on a
 * grid half that size: what never moves is painted once per colour scheme,
 * and each frame copies it, draws what moves or lights over it, and scales
 * the result up without smoothing. The physics runs in fixed substeps so a
 * fast ball cannot pass through a rail.
 */
import { noZoom } from "../js/device.js";
import { onName, readName } from "../js/me.js";
import { AH, AW, paintFrame, paintStill, palette } from "./art.js";

const W = 400;
const H = 720;
/** The ball's radius. */
const R = 9;
const GRAVITY = 1100;
const STEPS = 8;
const MAX_V = 1900;
const BALLS = 3;

/** @param {string} id */
const $ = (id) => /** @type {HTMLElement} */ (document.getElementById(id));

const canvas = /** @type {HTMLCanvasElement} */ ($("pb-c"));
const ctx = /** @type {CanvasRenderingContext2D} */ (canvas.getContext("2d"));
const box = $("pb-t");
const ballOut = $("pb-bn");
const multOut = $("pb-x");
const scoreOut = $("pb-sc");
const msgOut = $("pb-msg");
const board = $("pb-lb");
const meOut = $("pb-me");

/* ---------- The table ---------- */

/**
 * @typedef {{ax: number, ay: number, bx: number, by: number, l2: number, tag?: string, e?: number}} Seg
 * @typedef {[number, number][]} Line
 */

/** @type {Seg[]} */
const segs = [];
/** Rails, drawn as chrome. */
/** @type {Line[]} */
const rails = [];

/**
 * @param {Line} pts
 * @param {{tag?: string, e?: number, draw?: boolean}} [o]
 */
function wall(pts, o = {}) {
  for (let i = 1; i < pts.length; i++) {
    const [ax, ay] = pts[i - 1];
    const [bx, by] = pts[i];
    segs.push({ ax, ay, bx, by, l2: (bx - ax) ** 2 + (by - ay) ** 2 || 1, tag: o.tag, e: o.e });
  }
  if (o.draw !== false) rails.push(pts);
}

/** Points along an arc, angles in radians, y down. */
function arc(cx, cy, r, a0, a1, n) {
  /** @type {Line} */
  const pts = [];
  for (let i = 0; i <= n; i++) {
    const a = a0 + ((a1 - a0) * i) / n;
    pts.push([cx + Math.cos(a) * r, cy + Math.sin(a) * r]);
  }
  return pts;
}

const LANE_X = 352;
const PLUNGE_X = 368;
const PLUNGER_Y = 702;

// The cabinet: left inlane, the left wall, the dome over the top, the right
// wall down the shooter lane.
wall([[116, 624], [16, 556], [16, 196], ...arc(200, 196, 184, Math.PI, Math.PI * 2, 36), [384, 196], [384, H + 40]]);
// The shooter lane's inner wall, and the right inlane off it.
wall([[LANE_X, H + 40], [LANE_X, 268]]);
wall([[252, 624], [LANE_X, 556]]);
// The gate at the top of the lane: a ball going up passes, one coming down is turned onto the table.
wall([[LANE_X, 268], [384, 232]], { tag: "gate", draw: false });
// The rollover lanes' guides.
for (const x of [124, 164, 204, 244]) wall([[x, 62], [x, 98]]);

/** Slingshots: three sides each, the one facing the table kicks. */
const SLINGS = [
  [[46, 470], [46, 534], [94, 566]],
  [[322, 470], [322, 534], [274, 566]],
];
for (const [a, b, c] of SLINGS) {
  wall([a, b, c], { draw: false });
  wall([c, a], { tag: "sling", draw: false });
}

/** Stand-up targets on the left wall: hit all three for a bonus. */
const TARGETS = [312, 352, 392].map((y) => ({ y, lit: false }));
TARGETS.forEach((t, i) => wall([[16, t.y - 13], [24, t.y - 13], [24, t.y + 13], [16, t.y + 13]], { tag: `t${i}`, draw: false }));

/** Pop bumpers. */
const BUMPERS = [
  { x: 134, y: 196, r: 21, flash: 0 },
  { x: 234, y: 196, r: 21, flash: 0 },
  { x: 184, y: 266, r: 21, flash: 0 },
];

/** Rollovers at the top: G, O and !, lit as the ball rolls through. */
const ROLLS = [144, 184, 224].map((x, i) => ({ x, y: 84, ch: "GO!"[i], lit: false }));

/** The saucer in the middle: it holds the ball a moment and pays out. */
const SAUCER = { x: 184, y: 418 };
/** The ring of lights around it, one lit per five bumper hits. */
const RING = 12;

/**
 * The flippers. Angles in radians from +x, y down; a flipper rests pointing
 * down toward the middle and swings up while its button is held.
 */
const FLIP_LEN = 54;
const flippers = [
  { x: 122, y: 630, rest: 0.52, up: -0.46, a: 0.52, w: 0, on: false },
  { x: 246, y: 630, rest: Math.PI - 0.52, up: Math.PI + 0.46, a: Math.PI - 0.52, w: 0, on: false },
];

/* ---------- The game ---------- */

const ball = { x: PLUNGE_X, y: PLUNGER_Y - R, vx: 0, vy: 0 };

const game = {
  /** idle: waiting for a first press; play; over: between games. */
  state: "idle",
  ballNo: 1,
  score: 0,
  mult: 1,
  hits: 0,
  ring: 0,
  /** Seconds the saucer still holds the ball; 0 when it does not. */
  held: 0,
  /** Seconds before the saucer may take the ball again. */
  cool: 0,
  /** Seconds of ball save left: a drain while it runs gives the ball back. */
  save: 0,
  /** How far the plunger is drawn, 0 to 1. */
  pull: 0,
  pulling: false,
  /** Seconds the slingshots stay lit after a kick, per side. */
  sling: [0, 0],
  still: 0,
  msgUntil: 0,
};

/** @param {string} text @param {number} [secs] */
function say(text, secs = 2.2) {
  msgOut.textContent = text;
  game.msgUntil = secs ? performance.now() + secs * 1000 : Infinity;
}

/** @param {number} points */
function award(points) {
  game.score += points * game.mult;
  scoreOut.textContent = game.score.toLocaleString("en-US");
}

function paintCounters() {
  ballOut.textContent = String(game.ballNo);
  multOut.textContent = String(game.mult);
  scoreOut.textContent = game.score.toLocaleString("en-US");
}

function serve() {
  ball.x = PLUNGE_X;
  ball.y = PLUNGER_Y - R;
  ball.vx = 0;
  ball.vy = 0;
  game.held = 0;
  game.save = 0;
  game.still = 0;
}

function newGame() {
  game.state = "play";
  game.ballNo = 1;
  game.score = 0;
  game.mult = 1;
  game.hits = 0;
  game.ring = 0;
  for (const r of ROLLS) r.lit = false;
  for (const t of TARGETS) t.lit = false;
  document.body.classList.add("pb-on");
  serve();
  paintCounters();
  say("Hold a button, let go to launch", 4);
}

function inLane() {
  return ball.x > LANE_X && ball.y > 560;
}

function drain() {
  if (game.save > 0) {
    say("Ball saved");
    serve();
    return;
  }
  if (game.ballNo < BALLS) {
    game.ballNo++;
    game.mult = 1;
    paintCounters();
    say(`Ball ${game.ballNo}`);
    serve();
    return;
  }
  game.state = "over";
  document.body.classList.remove("pb-on");
  say(`Game over · ${game.score.toLocaleString("en-US")}`, 0);
  serve();
  postScore(game.score);
}

/* ---------- Sound: a few short blips, once a press has allowed audio ---------- */

/** @type {AudioContext | null} */
let audio = null;

/** @param {number} freq @param {number} [dur] @param {OscillatorType} [type] */
function blip(freq, dur = 0.06, type = "square") {
  if (!audio) return;
  const t = audio.currentTime;
  const osc = audio.createOscillator();
  const amp = audio.createGain();
  osc.type = type;
  osc.frequency.setValueAtTime(freq, t);
  osc.frequency.exponentialRampToValueAtTime(freq * 0.5, t + dur);
  amp.gain.setValueAtTime(0.06, t);
  amp.gain.exponentialRampToValueAtTime(0.0001, t + dur);
  osc.connect(amp).connect(audio.destination);
  osc.start(t);
  osc.stop(t + dur);
}

function wakeAudio() {
  if (audio) return;
  try {
    audio = new AudioContext();
  } catch {
    audio = null;
  }
}

/* ---------- Physics ---------- */

/**
 * Push the ball out of a segment it overlaps, with the segment's thickness
 * going from r0 at its start to r1 at its end. Returns the contact normal and
 * where along the segment it touched, or null when apart.
 *
 * @param {number} ax @param {number} ay @param {number} bx @param {number} by
 * @param {number} l2 @param {number} r0 @param {number} r1
 */
function touch(ax, ay, bx, by, l2, r0, r1) {
  const dx = bx - ax;
  const dy = by - ay;
  let t = ((ball.x - ax) * dx + (ball.y - ay) * dy) / l2;
  t = t < 0 ? 0 : t > 1 ? 1 : t;
  const px = ax + dx * t;
  const py = ay + dy * t;
  let nx = ball.x - px;
  let ny = ball.y - py;
  const reach = R + r0 + (r1 - r0) * t;
  const d2 = nx * nx + ny * ny;
  if (d2 >= reach * reach) return null;
  const d = Math.sqrt(d2) || 1e-6;
  nx /= d;
  ny /= d;
  ball.x = px + nx * reach;
  ball.y = py + ny * reach;
  return { nx, ny, px, py };
}

/** Reflect the ball's velocity off a surface moving at (sx, sy). */
function bounce(nx, ny, e, sx = 0, sy = 0) {
  const rx = ball.vx - sx;
  const ry = ball.vy - sy;
  const vn = rx * nx + ry * ny;
  if (vn >= 0) return 0;
  ball.vx -= (1 + e) * vn * nx;
  ball.vy -= (1 + e) * vn * ny;
  return -vn;
}

/** @param {number} nx @param {number} ny @param {number} speed */
function kick(nx, ny, speed) {
  const vn = ball.vx * nx + ball.vy * ny;
  if (vn < speed) {
    ball.vx += (speed - vn) * nx;
    ball.vy += (speed - vn) * ny;
  }
}

/** @param {Seg} s */
function hitSeg(s) {
  if (s.tag === "gate" && (ball.vy < 0 || ball.x < LANE_X - R)) return;
  const c = touch(s.ax, s.ay, s.bx, s.by, s.l2, 0, 0);
  if (!c) return;
  const speed = bounce(c.nx, c.ny, s.e ?? 0.45);
  if (s.tag === "sling") {
    if (speed > 60) {
      kick(c.nx, c.ny, 640);
      game.sling[s.ax < 184 ? 0 : 1] = 0.12;
      award(100);
      blip(520);
    }
  } else if (s.tag && s.tag[0] === "t" && speed > 40) {
    const target = TARGETS[Number(s.tag[1])];
    if (!target.lit) {
      target.lit = true;
      award(500);
      blip(880, 0.05);
      if (TARGETS.every((t) => t.lit)) {
        award(7500);
        say("Targets · 7,500");
        for (const t of TARGETS) t.lit = false;
      }
    }
  }
}

/** @param {number} dt */
function step(dt) {
  for (const f of flippers) {
    const prev = f.a;
    const goal = f.on ? f.up : f.rest;
    const turn = (f.on ? 30 : 16) * dt;
    const d = goal - f.a;
    f.a = Math.abs(d) <= turn ? goal : f.a + Math.sign(d) * turn;
    f.w = (f.a - prev) / dt;
  }

  if (game.held > 0) {
    game.held -= dt;
    ball.x = SAUCER.x;
    ball.y = SAUCER.y;
    if (game.held <= 0) {
      ball.vx = (Math.random() - 0.5) * 520;
      ball.vy = -720;
      game.cool = 0.6;
      blip(220, 0.18, "sawtooth");
    }
    return;
  }
  game.cool = Math.max(0, game.cool - dt);
  game.save = Math.max(0, game.save - dt);

  ball.vy += GRAVITY * dt;
  const v = Math.hypot(ball.vx, ball.vy);
  if (v > MAX_V) {
    ball.vx *= MAX_V / v;
    ball.vy *= MAX_V / v;
  }
  ball.x += ball.vx * dt;
  ball.y += ball.vy * dt;

  for (const s of segs) hitSeg(s);

  // The plunger's face, drawn back as it is pulled.
  if (ball.x > LANE_X) {
    const face = PLUNGER_Y + game.pull * 26;
    if (ball.y + R > face) {
      ball.y = face - R;
      if (ball.vy > 0) ball.vy = 0;
      ball.vx = 0;
      ball.x = PLUNGE_X;
    }
  }

  for (const b of BUMPERS) {
    const dx = ball.x - b.x;
    const dy = ball.y - b.y;
    const reach = R + b.r;
    const d2 = dx * dx + dy * dy;
    if (d2 >= reach * reach) continue;
    const d = Math.sqrt(d2) || 1e-6;
    const nx = dx / d;
    const ny = dy / d;
    ball.x = b.x + nx * reach;
    ball.y = b.y + ny * reach;
    bounce(nx, ny, 0.5);
    kick(nx, ny, 560);
    if (b.flash <= 0) {
      award(500);
      blip(330 + Math.random() * 60);
      game.hits++;
      if (game.hits % 5 === 0) litRing();
    }
    b.flash = 0.14;
  }

  for (const f of flippers) {
    const tx = f.x + Math.cos(f.a) * FLIP_LEN;
    const ty = f.y + Math.sin(f.a) * FLIP_LEN;
    const c = touch(f.x, f.y, tx, ty, FLIP_LEN * FLIP_LEN, 10, 6);
    if (!c) continue;
    // The flipper's own speed where the ball touched it: ω × r.
    const sx = -f.w * (c.py - f.y);
    const sy = f.w * (c.px - f.x);
    bounce(c.nx, c.ny, 0.3, sx, sy);
  }

  for (const r of ROLLS) {
    if (!r.lit && Math.abs(ball.x - r.x) < 10 && Math.abs(ball.y - r.y) < 12) {
      r.lit = true;
      award(1000);
      blip(660, 0.05);
      if (ROLLS.every((x) => x.lit)) {
        award(10000);
        say("G · O · ! · 10,000");
        for (const x of ROLLS) x.lit = false;
      }
    }
  }

  if (!game.cool && Math.hypot(ball.x - SAUCER.x, ball.y - SAUCER.y) < 10) {
    game.held = 1.1;
    award(5000);
    say(`Saucer · ${(5000 * game.mult).toLocaleString("en-US")}`);
    blip(110, 0.3, "triangle");
  }

  if (ball.y > H + 30) drain();
}

function litRing() {
  game.ring++;
  if (game.ring < RING) return;
  game.ring = 0;
  if (game.mult < 5) {
    game.mult++;
    paintCounters();
    say(`Multiplier × ${game.mult}`);
  } else {
    award(25000);
    say("Ring complete · 25,000");
  }
}

/* ---------- Drawing ---------- */

/** Each frame is drawn at art-pixel size here, then scaled up without smoothing. */
const buf = document.createElement("canvas");
buf.width = AW;
buf.height = AH;
const bctx = /** @type {CanvasRenderingContext2D} */ (buf.getContext("2d"));
let still = document.createElement("canvas");
let pal = palette();

/** What the art reads off the table and the game. */
const scene = { ball, flippers, BUMPERS, ROLLS, TARGETS, SLINGS, SAUCER, RING, game, rails, FLIP_LEN, LANE_X, PLUNGE_X, PLUNGER_Y, showBall: true };

/** The art that never moves, for the scheme the page is in. */
function repaint() {
  pal = palette();
  still = document.createElement("canvas");
  still.width = AW;
  still.height = AH;
  paintStill(/** @type {CanvasRenderingContext2D} */ (still.getContext("2d")), pal, scene);
}

/** @param {number} now */
function draw(now) {
  scene.showBall = game.state !== "over" || inLane();
  paintFrame(bctx, still, pal, scene, now);
  ctx.imageSmoothingEnabled = false;
  ctx.drawImage(buf, 0, 0, canvas.width, canvas.height);
}

/**
 * Size the canvas to its box. Whole device pixels per art pixel where that
 * loses little, so every pixel of the art is drawn the same size; where it
 * would shrink the table by more than a tenth, as near as fits instead.
 */
function fit() {
  const dpr = Math.min(3, window.devicePixelRatio || 1);
  // Less the frame round the glass.
  const w = (box.clientWidth - 18) * dpr;
  const h = (box.clientHeight - 18) * dpr;
  const exact = Math.max(0.5, Math.min(w / AW, h / AH));
  const whole = Math.floor(exact);
  const k = whole >= 1 && whole / exact > 0.9 ? whole : exact;
  canvas.width = Math.round(AW * k);
  canvas.height = Math.round(AH * k);
  canvas.style.width = `${canvas.width / dpr}px`;
  canvas.style.height = `${canvas.height / dpr}px`;
  draw(performance.now());
}

/* ---------- The loop ---------- */

let last = 0;
let raf = 0;

/** @param {number} now */
function frame(now) {
  raf = requestAnimationFrame(frame);
  const dt = Math.min(1 / 30, (now - (last || now)) / 1000);
  last = now;

  if (game.pulling) game.pull = Math.min(1, game.pull + dt / 0.8);
  else if (game.pull > 0) game.pull = Math.max(0, game.pull - dt * 8);

  if (game.state === "play") {
    const sub = dt / STEPS;
    for (let i = 0; i < STEPS; i++) step(sub);
    for (const b of BUMPERS) b.flash -= dt;
    game.sling[0] -= dt;
    game.sling[1] -= dt;
    // A ball that has come to rest anywhere but the lane or the saucer gets a nudge.
    if (!inLane() && !game.held && Math.hypot(ball.vx, ball.vy) < 15) {
      game.still += dt;
      if (game.still > 2.5) {
        ball.vy = -320;
        ball.vx = (Math.random() - 0.5) * 300;
        game.still = 0;
      }
    } else game.still = 0;
  } else {
    // Between games the flippers still answer, for the feel of them.
    for (let i = 0; i < STEPS; i++) {
      for (const f of flippers) {
        const goal = f.on ? f.up : f.rest;
        const turn = (f.on ? 30 : 16) * (dt / STEPS);
        const d = goal - f.a;
        f.a = Math.abs(d) <= turn ? goal : f.a + Math.sign(d) * turn;
      }
    }
  }

  if (now > game.msgUntil) {
    say(game.state === "play" ? (inLane() ? "Hold a button, let go to launch" : "") : "Press a button to start", 0);
  }

  draw(now);
}

/* ---------- Controls ---------- */

/**
 * @param {0 | 1} side
 * @param {boolean} down
 */
function press(side, down) {
  wakeAudio();
  const f = flippers[side];
  if (f.on === down) return;
  f.on = down;
  buttons[side].classList.toggle("on", down);
  if (down) blip(140, 0.04, "triangle");

  if (down && game.state !== "play") {
    newGame();
    return;
  }
  if (game.state !== "play") return;
  const anyDown = flippers[0].on || flippers[1].on;
  if (down && inLane() && !game.pulling) game.pulling = true;
  if (!anyDown && game.pulling) launch();
}

/** Let the plunger go: the further it was drawn, the harder the shot. */
function launch() {
  game.pulling = false;
  if (inLane() && ball.y > PLUNGER_Y - R - 30) {
    ball.vy = -(1250 + 650 * game.pull);
    game.save = 6;
    blip(90, 0.25, "sawtooth");
  }
}

const buttons = [$("pb-l"), $("pb-r")];
buttons.forEach((b, i) => {
  const side = /** @type {0 | 1} */ (i);
  b.addEventListener("pointerdown", (e) => {
    e.preventDefault();
    b.setPointerCapture?.(e.pointerId);
    press(side, true);
  });
  for (const type of ["pointerup", "pointercancel", "lostpointercapture"]) {
    b.addEventListener(type, () => press(side, false));
  }
  b.addEventListener("contextmenu", (e) => e.preventDefault());
});

/** @type {Record<string, 0 | 1 | 2>} */
const KEYS = {
  KeyZ: 0,
  ArrowLeft: 0,
  ShiftLeft: 0,
  Slash: 1,
  ArrowRight: 1,
  ShiftRight: 1,
  Space: 2,
  ArrowDown: 2,
  Enter: 2,
};

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
  if (down && game.state !== "play") newGame();
  else if (down && inLane()) game.pulling = true;
  else if (!down && game.pulling) launch();
}

window.addEventListener("keydown", (e) => key(e, true));
window.addEventListener("keyup", (e) => key(e, false));
// A button held as the page lost focus would otherwise stay held.
window.addEventListener("blur", () => {
  press(0, false);
  press(1, false);
  game.pulling = false;
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

/* ---------- The leaderboard ---------- */

const API = "/api/social/pinball";

/** @param {{top?: {name: string, score: number}[], best?: number} | null} data */
function paintBoard(data) {
  const me = readName();
  const top = data?.top ?? [];
  board.replaceChildren(
    ...top.map((row) => {
      const li = document.createElement("li");
      if (row.name === me) li.className = "me";
      const name = document.createElement("span");
      name.textContent = row.name;
      const score = document.createElement("b");
      score.textContent = row.score.toLocaleString("en-US");
      li.append(name, score);
      return li;
    }),
  );
  if (!data) meOut.textContent = "The leaderboard is unavailable right now.";
  else if (!top.length && me) meOut.textContent = "No games yet. Be the first.";
  else if (me) meOut.textContent = data.best ? `Your best: ${data.best.toLocaleString("en-US")}` : "";
  else loginLine(top.length ? "" : "No games yet. ");
}

/** @param {string} lead */
function loginLine(lead) {
  meOut.textContent = lead;
  const a = document.createElement("a");
  a.href = "/login?next=/pinball";
  a.textContent = "Log in";
  meOut.append(a, " to put your score on the board.");
}

async function loadBoard() {
  try {
    const res = await fetch(API, { headers: { Accept: "application/json" } });
    paintBoard(res.ok ? await res.json() : null);
  } catch {
    paintBoard(null);
  }
}

/** @param {number} score */
async function postScore(score) {
  if (!readName()) {
    loginLine("");
    return;
  }
  try {
    const res = await fetch(API, {
      method: "POST",
      headers: { "Content-Type": "application/json", Accept: "application/json" },
      body: JSON.stringify({ score }),
    });
    if (res.status === 401 || res.status === 403) {
      loginLine("");
      return;
    }
    paintBoard(res.ok ? await res.json() : null);
  } catch {
    paintBoard(null);
  }
}

/* ---------- Start ---------- */

noZoom();
repaint();
matchMedia("(prefers-color-scheme: dark)").addEventListener?.("change", repaint);
new ResizeObserver(fit).observe(box);
fit();
paintCounters();
say("Press a button to start", 0);
raf = requestAnimationFrame(frame);
loadBoard();
onName(loadBoard);
