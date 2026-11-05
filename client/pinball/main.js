/**
 * Pinball. One table drawn on a canvas, played with two buttons (or Z and /,
 * the arrow keys, Shift), and a leaderboard of each account's best game.
 *
 * The table is in its own units, W × H, and drawn scaled to fit. Its art that
 * never changes (the playfield, the rails, the slingshots) is painted once per
 * size into an offscreen canvas; each frame copies that and draws what moves
 * or lights over it. The physics runs in fixed substeps so a fast ball cannot
 * pass through a rail.
 */
import { noZoom } from "../js/device.js";
import { onName, readName } from "../js/me.js";

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

/** The playfield's art at the current size, painted once per resize. */
let still = document.createElement("canvas");
let scale = 1;
let dpr = 1;

/** The shape of the playfield, under the glass. */
function fieldPath(g) {
  g.beginPath();
  g.moveTo(16, H);
  g.lineTo(16, 196);
  g.arc(200, 196, 184, Math.PI, Math.PI * 2);
  g.lineTo(384, H);
  g.closePath();
}

/** A chrome rail along a line of points. */
function rail(g, pts, width = 6) {
  g.lineCap = "round";
  g.lineJoin = "round";
  const path = () => {
    g.beginPath();
    pts.forEach(([x, y], i) => (i ? g.lineTo(x, y) : g.moveTo(x, y)));
  };
  path();
  g.strokeStyle = "rgba(0,0,0,0.55)";
  g.lineWidth = width + 4;
  g.save();
  g.translate(2, 3);
  g.stroke();
  g.restore();
  g.strokeStyle = "#2d3a31";
  g.lineWidth = width + 2;
  g.stroke();
  g.strokeStyle = "#a9b8ad";
  g.lineWidth = width;
  g.stroke();
  g.strokeStyle = "rgba(255,255,255,0.75)";
  g.lineWidth = width / 3;
  g.save();
  g.translate(-0.8, -0.8);
  g.stroke();
  g.restore();
}

/** A small pseudo-random sequence, so the stars stand where they stood. */
function seeded(seed) {
  return () => ((seed = (seed * 16807) % 2147483647) / 2147483647);
}

/** @param {CanvasRenderingContext2D} g */
function paintStill(g) {
  // The cabinet's wood around the dome.
  g.fillStyle = "#0b140e";
  g.fillRect(0, 0, W, H);

  g.save();
  fieldPath(g);
  g.clip();
  const field = g.createRadialGradient(184, 380, 20, 184, 380, 480);
  field.addColorStop(0, "#176b2c");
  field.addColorStop(0.45, "#0b3a19");
  field.addColorStop(1, "#03140a");
  g.fillStyle = field;
  g.fillRect(0, 0, W, H);

  // Nebulae.
  for (const [x, y, r, c] of [
    [70, 150, 120, "rgba(0,170,150,0.22)"],
    [320, 330, 140, "rgba(60,195,22,0.2)"],
    [90, 470, 110, "rgba(150,255,90,0.12)"],
    [300, 90, 90, "rgba(200,255,160,0.12)"],
  ]) {
    const n = g.createRadialGradient(x, y, 0, x, y, r);
    n.addColorStop(0, c);
    n.addColorStop(1, "rgba(0,0,0,0)");
    g.fillStyle = n;
    g.fillRect(x - r, y - r, r * 2, r * 2);
  }

  // Stars.
  const rnd = seeded(7);
  for (let i = 0; i < 160; i++) {
    const x = rnd() * W;
    const y = rnd() * H;
    const s = rnd();
    g.fillStyle = `rgba(230,255,220,${0.25 + s * 0.6})`;
    g.fillRect(x, y, s > 0.9 ? 2 : 1, s > 0.9 ? 2 : 1);
  }

  // Energy lines out from the saucer, like cracks of light under the glass.
  g.strokeStyle = "rgba(140,255,110,0.16)";
  g.lineWidth = 1;
  for (let i = 0; i < 14; i++) {
    let x = SAUCER.x;
    let y = SAUCER.y;
    const a0 = (i / 14) * Math.PI * 2;
    g.beginPath();
    g.moveTo(x, y);
    for (let k = 0; k < 7; k++) {
      const a = a0 + (rnd() - 0.5) * 0.9;
      x += Math.cos(a) * 26;
      y += Math.sin(a) * 26;
      g.lineTo(x, y);
    }
    g.stroke();
  }

  // The starburst between the flippers.
  g.save();
  g.translate(184, 720);
  const burst = g.createRadialGradient(0, 0, 4, 0, 0, 120);
  burst.addColorStop(0, "#c8ff9e");
  burst.addColorStop(0.5, "#3cc316");
  burst.addColorStop(1, "rgba(20,92,8,0)");
  g.fillStyle = burst;
  g.beginPath();
  for (let i = 0; i <= 12; i++) {
    const a = Math.PI + (i / 12) * Math.PI;
    const r = i % 2 ? 46 : 120;
    g.lineTo(Math.cos(a) * r, Math.sin(a) * r);
  }
  g.fill();
  g.restore();

  // The shooter lane: a darker metal channel.
  const lane = g.createLinearGradient(LANE_X, 0, 384, 0);
  lane.addColorStop(0, "#0c1a10");
  lane.addColorStop(0.5, "#1e3324");
  lane.addColorStop(1, "#0c1a10");
  g.fillStyle = lane;
  g.fillRect(LANE_X, 250, 384 - LANE_X, H);

  // Inlane arrows, pointing up the table.
  g.fillStyle = "rgba(157,255,110,0.35)";
  for (const [x, y] of [[60, 600], [308, 600], [184, 520], [184, 345]]) {
    g.beginPath();
    g.moveTo(x, y - 8);
    g.lineTo(x + 7, y + 4);
    g.lineTo(x - 7, y + 4);
    g.fill();
  }

  // Lettering.
  g.fillStyle = "rgba(60,195,22,0.75)";
  g.font = "italic 800 13px system-ui, sans-serif";
  g.fillText("UTOPIAN", 26, 700);
  g.textAlign = "right";
  g.fillText("GO", 342, 700);
  g.textAlign = "center";
  g.fillStyle = "rgba(200,255,170,0.12)";
  g.font = "italic 900 64px system-ui, sans-serif";
  g.fillText("GO", 184, 520 + 22);
  g.restore();

  // The saucer's hole and its rim.
  const hole = g.createRadialGradient(SAUCER.x, SAUCER.y - 3, 1, SAUCER.x, SAUCER.y, 14);
  hole.addColorStop(0, "#000");
  hole.addColorStop(0.7, "#071209");
  hole.addColorStop(1, "#4e6455");
  g.fillStyle = hole;
  g.beginPath();
  g.arc(SAUCER.x, SAUCER.y, 14, 0, Math.PI * 2);
  g.fill();
  g.strokeStyle = "#b9c8bd";
  g.lineWidth = 2;
  g.stroke();

  // Slingshots: green plastic, a white rubber band on the kicking face.
  for (const pts of SLINGS) {
    const [a, b, c] = pts;
    const plastic = g.createLinearGradient(a[0], a[1], c[0], c[1]);
    plastic.addColorStop(0, "#7cf04a");
    plastic.addColorStop(1, "#1d7a0b");
    g.fillStyle = plastic;
    g.beginPath();
    g.moveTo(a[0], a[1]);
    g.lineTo(b[0], b[1]);
    g.lineTo(c[0], c[1]);
    g.closePath();
    g.fill();
    rail(g, [a, b, c, a], 4);
  }

  // Stand-up target housings.
  for (const t of TARGETS) {
    g.fillStyle = "#2d3a31";
    g.fillRect(14, t.y - 15, 12, 30);
  }

  for (const pts of rails) rail(g, pts);
  // Posts at the top of the rollover guides.
  for (const x of [124, 164, 204, 244]) {
    const post = g.createRadialGradient(x - 1, 61, 0.5, x, 62, 5);
    post.addColorStop(0, "#fff");
    post.addColorStop(1, "#5e6b63");
    g.fillStyle = post;
    g.beginPath();
    g.arc(x, 62, 5, 0, Math.PI * 2);
    g.fill();
  }
}

/** A lamp under the glass: dim, or lit with a glow. */
function lamp(g, x, y, r, on, color = "125,255,74") {
  const grad = g.createRadialGradient(x - r / 3, y - r / 3, 0, x, y, on ? r * 2.2 : r);
  if (on) {
    grad.addColorStop(0, "#fff");
    grad.addColorStop(0.3, `rgb(${color})`);
    grad.addColorStop(0.46, `rgba(${color},0.45)`);
    grad.addColorStop(1, `rgba(${color},0)`);
  } else {
    grad.addColorStop(0, "#3c5e40");
    grad.addColorStop(1, "#0a1d0e");
  }
  g.fillStyle = grad;
  g.beginPath();
  g.arc(x, y, on ? r * 2.2 : r, 0, Math.PI * 2);
  g.fill();
}

function draw(now) {
  const g = ctx;
  g.setTransform(1, 0, 0, 1, 0, 0);
  g.drawImage(still, 0, 0);
  g.setTransform(scale * dpr, 0, 0, scale * dpr, 0, 0);

  const blink = Math.floor(now / 260) % 2 === 0;

  // The ring round the saucer.
  for (let i = 0; i < RING; i++) {
    const a = (i / RING) * Math.PI * 2 - Math.PI / 2;
    lamp(g, SAUCER.x + Math.cos(a) * 40, SAUCER.y + Math.sin(a) * 40, 5, i < game.ring || (game.held > 0 && blink));
  }
  // Rollovers.
  g.font = "800 11px system-ui, sans-serif";
  g.textAlign = "center";
  g.textBaseline = "middle";
  for (const r of ROLLS) {
    lamp(g, r.x, r.y, 8, r.lit, "157,255,110");
    g.fillStyle = r.lit ? "#0b3a05" : "#9fdc86";
    g.fillText(r.ch, r.x, r.y + 0.5);
  }
  // Targets.
  for (const t of TARGETS) {
    g.fillStyle = t.lit ? "#c8ff9e" : "#2b7a14";
    g.fillRect(17, t.y - 12, 7, 24);
    g.fillStyle = "rgba(255,255,255,0.5)";
    g.fillRect(17, t.y - 12, 2, 24);
    lamp(g, 40, t.y, 4, t.lit);
  }
  // Slingshots light when they kick.
  SLINGS.forEach(([a, b, c], i) => {
    if (game.sling[i] <= 0) return;
    g.strokeStyle = "rgba(220,255,200,0.9)";
    g.lineWidth = 4;
    g.beginPath();
    g.moveTo(c[0], c[1]);
    g.lineTo(a[0], a[1]);
    g.stroke();
  });

  // Bumpers: a chrome skirt, a domed green cap, white when struck.
  for (const b of BUMPERS) {
    g.fillStyle = "rgba(0,0,0,0.45)";
    g.beginPath();
    g.arc(b.x + 3, b.y + 5, b.r + 2, 0, Math.PI * 2);
    g.fill();
    const skirt = g.createRadialGradient(b.x - 6, b.y - 8, 2, b.x, b.y, b.r + 2);
    skirt.addColorStop(0, "#ffffff");
    skirt.addColorStop(0.6, "#a3b2a8");
    skirt.addColorStop(1, "#3a463f");
    g.fillStyle = skirt;
    g.beginPath();
    g.arc(b.x, b.y, b.r + 1, 0, Math.PI * 2);
    g.fill();
    const lit = b.flash > 0;
    const cap = g.createRadialGradient(b.x - 4, b.y - 6, 1, b.x, b.y, b.r * 0.8);
    cap.addColorStop(0, lit ? "#ffffff" : "#d6ffb8");
    cap.addColorStop(0.45, lit ? "#c8ff9e" : "#3cc316");
    cap.addColorStop(1, lit ? "#3cc316" : "#145c08");
    g.fillStyle = cap;
    g.beginPath();
    g.arc(b.x, b.y, b.r * 0.72, 0, Math.PI * 2);
    g.fill();
    g.fillStyle = lit ? "#145c08" : "rgba(255,255,255,0.9)";
    g.beginPath();
    for (let i = 0; i < 10; i++) {
      const a = -Math.PI / 2 + (i * Math.PI) / 5;
      const r = i % 2 ? 2.6 : 6.5;
      g.lineTo(b.x + Math.cos(a) * r, b.y + Math.sin(a) * r);
    }
    g.fill();
    if (lit) lamp(g, b.x, b.y, b.r, true, "200,255,160");
  }

  // The plunger: a spring and a knob, drawn back as it is pulled.
  const face = PLUNGER_Y + game.pull * 26;
  g.strokeStyle = "#8d9b91";
  g.lineWidth = 2;
  g.beginPath();
  const coils = 7;
  for (let i = 0; i <= coils * 2; i++) {
    const y = face + 6 + ((H - face - 6) * i) / (coils * 2);
    g.lineTo(i % 2 ? PLUNGE_X + 9 : PLUNGE_X - 9, y);
  }
  g.stroke();
  const knob = g.createLinearGradient(PLUNGE_X - 13, 0, PLUNGE_X + 13, 0);
  knob.addColorStop(0, "#145c08");
  knob.addColorStop(0.4, "#9dff6e");
  knob.addColorStop(1, "#145c08");
  g.fillStyle = knob;
  g.fillRect(PLUNGE_X - 13, face, 26, 8);

  // Flippers: ivory plastic with a green rubber edge.
  for (const f of flippers) {
    g.save();
    g.translate(f.x, f.y);
    g.rotate(f.a);
    g.fillStyle = "rgba(0,0,0,0.4)";
    capsule(g, 3, 5);
    g.fill();
    const body = g.createLinearGradient(0, -10, 0, 10);
    body.addColorStop(0, "#fffdf2");
    body.addColorStop(0.6, "#e3ddc4");
    body.addColorStop(1, "#a9a28a");
    g.fillStyle = body;
    capsule(g, 0, 0);
    g.fill();
    g.strokeStyle = "#2fa312";
    g.lineWidth = 3;
    g.stroke();
    g.fillStyle = "#b9c8bd";
    g.beginPath();
    g.arc(0, 0, 3.5, 0, Math.PI * 2);
    g.fill();
    g.restore();
  }

  // The ball, chrome, its highlight fixed to the light above the table.
  if (game.state !== "over" || inLane()) {
    g.fillStyle = "rgba(0,0,0,0.4)";
    g.beginPath();
    g.arc(ball.x + 2.5, ball.y + 4, R, 0, Math.PI * 2);
    g.fill();
    const chrome = g.createRadialGradient(ball.x - 3, ball.y - 4, 0.5, ball.x, ball.y, R);
    chrome.addColorStop(0, "#ffffff");
    chrome.addColorStop(0.35, "#d8e2dc");
    chrome.addColorStop(0.75, "#6c7a71");
    chrome.addColorStop(1, "#1d2621");
    g.fillStyle = chrome;
    g.beginPath();
    g.arc(ball.x, ball.y, R, 0, Math.PI * 2);
    g.fill();
  }
}

/** A flipper's outline about its pivot: round at both ends, narrower at the tip. */
function capsule(g, ox, oy) {
  const r0 = 10;
  const r1 = 6;
  const k = Math.asin((r0 - r1) / FLIP_LEN);
  g.beginPath();
  g.arc(ox, oy, r0, Math.PI / 2 + k, Math.PI * 1.5 - k);
  g.arc(ox + FLIP_LEN, oy, r1, -Math.PI / 2 - k, Math.PI / 2 + k);
  g.closePath();
}

function fit() {
  const w = box.clientWidth;
  const h = box.clientHeight;
  // The frame's border is 5px each side.
  scale = Math.max(0.2, Math.min((w - 10) / W, (h - 10) / H));
  dpr = Math.min(2, window.devicePixelRatio || 1);
  const cw = Math.round(W * scale);
  const ch = Math.round(H * scale);
  canvas.style.width = `${cw}px`;
  canvas.style.height = `${ch}px`;
  canvas.width = Math.round(cw * dpr);
  canvas.height = Math.round(ch * dpr);
  still = document.createElement("canvas");
  still.width = canvas.width;
  still.height = canvas.height;
  const g = /** @type {CanvasRenderingContext2D} */ (still.getContext("2d"));
  g.setTransform(scale * dpr, 0, 0, scale * dpr, 0, 0);
  paintStill(g);
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
new ResizeObserver(fit).observe(box);
fit();
paintCounters();
say("Press a button to start", 0);
raf = requestAnimationFrame(frame);
loadBoard();
onName(loadBoard);
