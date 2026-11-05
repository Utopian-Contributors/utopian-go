/**
 * The table: its layout, the physics that moves the balls over it, and the
 * rules that score what they hit.
 *
 * Units are the table's own, W × H, y down the table toward the player. The
 * renderer (render.js) reads everything here and draws it in 3D; nothing in
 * this file draws.
 *
 * The rules follow how a real table is built: shots light lamps, lamps change
 * what a shot is worth, and most of it decays if left alone.
 * - Ramp: each one climbs the temple ladder a rung (60 s each). The temple
 *   cashes in the rung reached: points, jackpot, the ball-save post, extra
 *   ball, multiball.
 * - G·O·! lanes: all three powers the mushrooms up a level (60 s). The
 *   flippers move the lit lanes, and on a launch a blinking lane is the skill shot.
 * - Drop targets: each bank cleared steps the multiplier, ×2 ×3 ×5 ×10.
 * - Stand-up targets: each bank lights something: kickback, spinner, extra ball.
 * - Spinner and orbit: points, combos with the ramp.
 * - Quests: one at a time, against the clock; each done fills the rank ring.
 * - Bonus: every switch adds to it, paid when the ball drains.
 */

export const W = 400;
export const H = 760;
export const R = 8.5;
/**
 * The feel of the table, scaled to the ball. A ball on a tilted table is
 * pulled down it at a steady rate; at this one it rolls the table's length
 * from rest in about a second and a half. Nothing moves faster than 200 ball
 * radii a second, and no step of the simulation moves a ball more than half
 * its radius, so however fast it goes it cannot pass through a wall.
 */
const GRAVITY = 620;
const MAX_V = R * 200;
const MAX_STEP = R / 2;

/** @typedef {[number, number]} Pt */

/* ---------- Layout ---------- */

/** @type {{ax:number, ay:number, bx:number, by:number, l2:number, tag?:string, e?:number, on?:() => boolean}[]} */
export const segs = [];
/** @type {{x:number, y:number, r:number, e?:number, on?:() => boolean}[]} */
export const posts = [];
/** Walls for the renderer, by kind. @type {{pts: Pt[], kind: string}[]} */
export const walls = [];

function wall(pts, o = {}) {
  for (let i = 1; i < pts.length; i++) {
    const [ax, ay] = pts[i - 1];
    const [bx, by] = pts[i];
    segs.push({ ax, ay, bx, by, l2: (bx - ax) ** 2 + (by - ay) ** 2 || 1, tag: o.tag, e: o.e, on: o.on });
  }
  if (o.kind) walls.push({ pts, kind: o.kind });
}

function post(x, y, r = 5, o = {}) {
  posts.push({ x, y, r, e: o.e, on: o.on });
}

export function arc(cx, cy, r, a0, a1, n) {
  /** @type {Pt[]} */
  const pts = [];
  for (let i = 0; i <= n; i++) {
    const a = a0 + ((a1 - a0) * i) / n;
    pts.push([cx + Math.cos(a) * r, cy + Math.sin(a) * r]);
  }
  return pts;
}

export const DOME = { x: 200, y: 190, r: 186 };
export const LANE_X = 354;
export const PLUNGE_X = 370;
export const PLUNGER_Y = H - 46;

// The left wall slants in at the foot of the orbit, so a ball coming down it
// is fed to the left inlane rather than lost.
wall([[50, 540], [14, 470], [14, DOME.y], ...arc(DOME.x, DOME.y, DOME.r, Math.PI, Math.PI * 2, 44), [386, DOME.y], [386, H + 60]], { kind: "cab" });
wall([[LANE_X, H + 60], [LANE_X, 250]], { kind: "lane" });
// A ball going up the lane passes the gate; one coming down is turned onto the table.
wall([[LANE_X, 250], [386, 218]], { tag: "gate" });

// The left orbit: a channel up the left side, the spinner across its mouth.
wall([[50, 206], [50, 420]], { kind: "wall" });
post(50, 206, 5);
post(50, 420, 5);

// The top lanes, G · O · !.
export const LANES_X = [150, 190, 230];
for (const x of [130, 170, 210, 250]) {
  wall([[x, 58], [x, 96]], { kind: "guide" });
  post(x, 58, 4);
}

// The left inlane's rail down to the flipper; on the right, a divider between
// the inlane and the outlane, the one way off the table that is not the middle.
// Each inlane rail runs on into the line of its flipper's top edge at rest, so
// a ball rolls off the rail onto the flipper with no notch to settle in.
wall([[50, 540], [50, 641.5], [116, 677.5]], { kind: "rail" });
post(50, 540, 6);
wall([[330, 540], [330, 641.5], [264, 677.5]], { kind: "rail" });
post(330, 540, 5);

/** Slingshots: the face toward the middle kicks. */
export const SLINGS = [
  [[82, 548], [82, 612], [118, 640]],
  [[298, 548], [298, 612], [262, 640]],
];
SLINGS.forEach(([a, b, c], i) => {
  wall([a, b, c], { kind: "sling" });
  wall([c, a], { tag: `s${i}` });
});

/**
 * The ramp. Its mouth faces down and left, toward the left flipper; a ball
 * through it fast enough is carried up and round the path, over the top of
 * the table, and set down in the left inlane.
 */
export const RAMP_MOUTH = { a: [282, 330], b: [318, 352], n: [0.52, -0.85] };
wall([[282, 330], [303, 296]], { kind: "lip" });
wall([[318, 352], [339, 318]], { kind: "lip" });
post(282, 330, 4);
post(318, 352, 4);
/** The ramp's centre line: x, y, height. */
export const RAMP_PATH = [
  [300, 341, 0],
  [318, 300, 8],
  [326, 230, 22],
  [314, 160, 34],
  [280, 112, 42],
  [222, 90, 46],
  [160, 92, 46],
  [106, 116, 44],
  [74, 168, 40],
  [66, 250, 34],
  [66, 350, 26],
  [66, 450, 16],
  [66, 530, 6],
  [66, 575, 0],
];
const rampLen = [];
{
  let s = 0;
  rampLen.push(0);
  for (let i = 1; i < RAMP_PATH.length; i++) {
    const [ax, ay, az] = RAMP_PATH[i - 1];
    const [bx, by, bz] = RAMP_PATH[i];
    s += Math.hypot(bx - ax, by - ay, bz - az);
    rampLen.push(s);
  }
}
export const RAMP_LENGTH = rampLen[rampLen.length - 1];

/** A point on the ramp at distance s along it. */
export function rampAt(s) {
  let i = 1;
  while (i < rampLen.length - 1 && rampLen[i] < s) i++;
  const t = Math.min(1, Math.max(0, (s - rampLen[i - 1]) / (rampLen[i] - rampLen[i - 1])));
  const a = RAMP_PATH[i - 1];
  const b = RAMP_PATH[i];
  return [a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t, a[2] + (b[2] - a[2]) * t];
}

/** Pop bumpers: mushrooms. */
export const BUMPERS = [
  { x: 150, y: 182, r: 20, flash: 0 },
  { x: 238, y: 176, r: 20, flash: 0 },
  { x: 196, y: 246, r: 20, flash: 0 },
];

/** Drop targets, right side: each bank cleared steps the multiplier. */
export const DROPS = [418, 444, 470].map((y) => ({ x: 338, y, up: true, h: 1 }));
DROPS.forEach((d, i) => wall([[d.x, d.y - 11], [d.x, d.y + 11]], { tag: `d${i}`, on: () => d.up }));

/** Stand-up targets on the orbit wall. */
export const STANDUPS = [282, 322, 362].map((y) => ({ x: 52, y, lit: false, flash: 0 }));
STANDUPS.forEach((t, i) => wall([[t.x + 2, t.y - 11], [t.x + 2, t.y + 11]], { tag: `t${i}` }));

/** The temple: a kickout that holds the ball and pays the ladder's rung. */
export const TEMPLE = { x: 190, y: 404 };

/** The spinner across the orbit's mouth. */
export const SPINNER = { x: 32, y: 384, a: 0, w: 0, turns: 0 };

/** The ball-save post between the flippers, up while lit. */
export const CENTER_POST = { x: 190, y: 744, r: 7, h: 0 };
post(CENTER_POST.x, CENTER_POST.y, CENTER_POST.r, { on: () => game.post, e: 0.4 });

export const FLIP_LEN = 58;
/**
 * How fast a flipper turns, radians a second: up through its whole swing in
 * 60 ms, back down in 90. A flipper takes time to swing, and a shot's speed
 * comes from how fast its tip is moving where it meets the ball.
 */
const FLIP_UP = 0.98 / 0.06;
const FLIP_DOWN = 0.98 / 0.09;
export const flippers = [
  { x: 118, y: 690, rest: 0.5, up: -0.48, a: 0.5, w: 0, on: false },
  { x: 262, y: 690, rest: Math.PI - 0.5, up: Math.PI + 0.48, a: Math.PI - 0.5, w: 0, on: false },
];

/* ---------- The game ---------- */

const MULTS = [1, 2, 3, 5, 10];
export const RANKS = ["Seedling", "Sprout", "Scout", "Explorer", "Ranger", "Tracker", "Pathfinder", "Chief", "Legend"];
/** The ladder's rungs, bottom up, as the temple pays them. */
export const RUNGS = ["Jackpot", "Ball save", "Extra ball", "Multiball"];

const QUESTS = [
  { key: "ramps", need: 3, text: "Climb the vine ramp" },
  { key: "bumpers", need: 15, text: "Pop the mushrooms" },
  { key: "spins", need: 25, text: "Spin the spinner" },
  { key: "drops", need: 3, text: "Knock down drop targets" },
  { key: "orbits", need: 2, text: "Run the orbit" },
  { key: "temple", need: 2, text: "Visit the temple" },
  { key: "lanes", need: 6, text: "Roll the G·O·! lanes" },
  { key: "targets", need: 6, text: "Hit the stand-up targets" },
];

/**
 * @typedef {{x:number, y:number, vx:number, vy:number, px:number, py:number, z:number,
 *   ramp:number, rampV:number, held:number, cool:number, lane:boolean, launched:boolean,
 *   still:number, sw:Set<string>, orbitT:number, auto:number}} Ball
 */

/** @type {Ball[]} */
export const balls = [];

export const game = {
  /** idle, play, over */
  state: "idle",
  score: 0,
  /** Balls still to play after this one. */
  left: 2,
  ballNo: 1,
  mult: 0,
  bonus: 0,
  jackpot: 100000,
  /** The temple ladder: rungs lit, and seconds until the top one goes out. */
  rung: 0,
  rungT: 0,
  /** Mushroom power, 0–3, and its clock. */
  power: 0,
  powerT: 0,
  lanes: [false, false, false],
  /** The lane blinking for a skill shot, or -1. */
  skill: -1,
  standRounds: 0,
  dropRounds: 0,
  dropReset: 0,
  spinnerLit: false,
  kickback: true,
  extraLit: false,
  post: false,
  /** Seconds of automatic ball save left. */
  save: 0,
  multiball: false,
  rank: 0,
  ring: 0,
  quest: /** @type {{key:string, need:number, have:number, text:string, t:number} | null} */ (null),
  questNo: 0,
  questWait: 0,
  combo: 0,
  pull: 0,
  pulling: false,
  sling: [0, 0],
  /** Lamp flashes the renderer reads: name → seconds left. */
  flash: /** @type {Record<string, number>} */ ({}),
  attract: 0,
};

/** What the page does with what happens here. */
const hooks = {
  say: (/** @type {string} */ _text, /** @type {number} */ _secs) => {},
  sound: (/** @type {string} */ _name) => {},
  change: () => {},
  over: (/** @type {number} */ _score) => {},
};

export function onEvents(h) {
  Object.assign(hooks, h);
}

function flash(name, secs = 0.6) {
  game.flash[name] = secs;
}

/** Points, times the multiplier; a share goes to the bonus and the jackpot. */
function award(points, bonus = true) {
  const scored = points * MULTS[game.mult];
  game.score += scored;
  if (bonus) game.bonus += Math.round(points / 100) * 10;
  game.jackpot = Math.min(5000000, game.jackpot + Math.round(points / 50) * 10);
  hooks.change();
  return scored;
}

const fmt = (n) => n.toLocaleString("en-US");

function newBall(lane = true) {
  /** @type {Ball} */
  const b = {
    x: PLUNGE_X,
    y: PLUNGER_Y - R,
    vx: 0,
    vy: 0,
    px: PLUNGE_X,
    py: PLUNGER_Y - R,
    z: 0,
    ramp: -1,
    rampV: 0,
    held: 0,
    cool: 0,
    lane,
    launched: false,
    still: 0,
    sw: new Set(),
    orbitT: 0,
    auto: 0,
  };
  balls.push(b);
  return b;
}

export function newGame() {
  Object.assign(game, {
    state: "play",
    score: 0,
    left: 2,
    ballNo: 1,
    jackpot: 100000,
    rank: 0,
    ring: 0,
    questNo: 0,
    quest: null,
    questWait: 0,
    kickback: true,
    extraLit: false,
  });
  resetBall();
  balls.length = 0;
  newBall();
  hooks.change();
  hooks.say("Hold a button to pull the plunger", 4);
}

/** What a ball starts with: the table's lamps back to their first state. */
function resetBall() {
  Object.assign(game, {
    mult: 0,
    bonus: 0,
    rung: 0,
    rungT: 0,
    power: 0,
    powerT: 0,
    lanes: [false, false, false],
    skill: Math.floor(Math.random() * 3),
    standRounds: 0,
    dropRounds: 0,
    spinnerLit: false,
    post: false,
    save: 0,
    multiball: false,
  });
  for (const d of DROPS) d.up = true;
  for (const t of STANDUPS) t.lit = false;
}

/* ---------- Quests and rank ---------- */

function startQuest() {
  const q = QUESTS[game.questNo % QUESTS.length];
  game.quest = { ...q, have: 0, t: 60 };
  hooks.say(`Quest: ${q.text} ×${q.need}`, 4);
}

function progress(key, n = 1) {
  const q = game.quest;
  if (!q || q.key !== key) return;
  q.have += n;
  if (q.have < q.need) return;
  const pay = award(50000 * (game.rank + 1), false);
  game.quest = null;
  game.questNo++;
  game.questWait = 5;
  game.ring += 4;
  flash("ring", 2);
  hooks.sound("quest");
  if (game.ring >= 12) {
    game.ring = 0;
    if (game.rank < RANKS.length - 1) game.rank++;
    award(100000 * game.rank, false);
    hooks.say(`Promoted to ${RANKS[game.rank]}!`, 4);
    hooks.sound("rank");
  } else {
    hooks.say(`Quest complete · ${fmt(pay)}`, 3);
  }
}

/* ---------- What the shots do ---------- */

function hitBumper() {
  award(500 * (game.power + 1));
  hooks.sound("bumper");
  progress("bumpers");
}

function hitSling(i) {
  game.sling[i] = 0.15;
  award(100);
  hooks.sound("sling");
}

function rollLane(i, ball) {
  if (game.skill >= 0 && ball.sw.has("plunge")) {
    if (game.skill === i) {
      award(25000, false);
      hooks.say("Skill shot · 25,000", 2.5);
      hooks.sound("skill");
    }
    game.skill = -1;
  }
  ball.sw.delete("plunge");
  progress("lanes");
  if (game.lanes[i]) {
    award(500);
    return;
  }
  game.lanes[i] = true;
  award(1000);
  hooks.sound("lane");
  if (game.lanes.every(Boolean)) {
    game.lanes = [false, false, false];
    flash("lanes", 1.5);
    award(10000);
    if (game.power < 3) game.power++;
    game.powerT = 60;
    hooks.say(`Mushrooms powered up · level ${game.power}`, 2.5);
  }
}

function hitDrop(i) {
  const d = DROPS[i];
  if (!d.up) return;
  d.up = false;
  award(750);
  hooks.sound("drop");
  if (DROPS.every((x) => !x.up)) {
    progress("drops");
    game.dropRounds++;
    if (game.mult < MULTS.length - 1) game.mult++;
    award(15000);
    flash("mult", 2);
    hooks.say(`Multiplier ×${MULTS[game.mult]}`, 2.5);
    game.dropReset = 1.4;
  }
}

function hitStandup(i) {
  const t = STANDUPS[i];
  t.flash = 0.3;
  progress("targets");
  if (t.lit) {
    award(250);
    return;
  }
  t.lit = true;
  award(500);
  hooks.sound("target");
  if (!STANDUPS.every((x) => x.lit)) return;
  for (const x of STANDUPS) x.lit = false;
  game.standRounds++;
  if (game.standRounds === 1) {
    award(25000);
    game.kickback = true;
    hooks.say("Kickback lit · 25,000", 2.5);
  } else if (game.standRounds === 2) {
    award(50000);
    game.spinnerLit = true;
    hooks.say("Spinner lit · 50,000", 2.5);
  } else {
    award(75000);
    game.extraLit = true;
    hooks.say("Extra ball lit · shoot the ramp", 3);
  }
}

function spin(turns) {
  for (let i = 0; i < turns; i++) {
    award(game.spinnerLit ? 1000 : 100);
    progress("spins");
  }
  if (turns) hooks.sound("spin");
}

function orbit() {
  const combo = game.combo > 0;
  award(combo ? 30000 : 10000);
  hooks.say(combo ? "Combo orbit · 30,000" : "Orbit · 10,000", 2);
  game.combo = 3;
  flash("orbit", 1.2);
  progress("orbits");
  hooks.sound("orbit");
}

function rampMade() {
  const combo = game.combo > 0;
  game.combo = 3;
  flash("ramp", 1.2);
  progress("ramps");
  hooks.sound("ramp");
  if (game.multiball) {
    const pay = award(game.jackpot, false);
    hooks.say(`JACKPOT · ${fmt(pay)}`, 3);
    flash("jackpot", 2);
    game.jackpot = 100000;
    return;
  }
  if (game.extraLit) {
    game.extraLit = false;
    game.left++;
    hooks.say("Extra ball!", 3);
    hooks.sound("rank");
    hooks.change();
  }
  if (game.rung < RUNGS.length) game.rung++;
  game.rungT = 60;
  award(combo ? 20000 : 5000);
  if (!game.extraLit) hooks.say(`${combo ? "Combo ramp" : "Ramp"} · temple lit for ${RUNGS[game.rung - 1].toLowerCase()}`, 2.5);
}

function templeAward() {
  const rung = game.rung;
  progress("temple");
  game.rung = 0;
  game.rungT = 0;
  if (rung === 0) {
    hooks.say(`Temple · ${fmt(award(5000))}`, 2);
  } else if (rung === 1) {
    const pay = award(game.jackpot, false);
    hooks.say(`JACKPOT · ${fmt(pay)}`, 3);
    flash("jackpot", 2);
    game.jackpot = 100000;
  } else if (rung === 2) {
    game.post = true;
    award(25000);
    hooks.say("Ball save post is up", 2.5);
  } else if (rung === 3) {
    game.extraLit = true;
    award(50000);
    hooks.say("Extra ball lit · shoot the ramp", 3);
  } else {
    award(100000);
    startMultiball();
  }
}

function startMultiball() {
  game.multiball = true;
  game.save = 15;
  hooks.say("MULTIBALL! Ramp lights the jackpot", 4);
  hooks.sound("rank");
  for (let i = 0; i < 2; i++) {
    const b = newBall();
    b.auto = 0.4 + i * 1.2;
  }
}

function drained(b) {
  balls.splice(balls.indexOf(b), 1);
  if (game.state !== "play") return;
  if (game.save > 0 || game.post) {
    if (game.save > 0) game.save = 0;
    else game.post = false;
    hooks.say("Ball saved", 2);
    newBall().auto = 0.6;
    return;
  }
  if (balls.length) {
    if (balls.length === 1 && game.multiball) {
      game.multiball = false;
      hooks.say("Multiball over", 2);
    }
    return;
  }
  const bonus = game.bonus * MULTS[game.mult];
  game.score += bonus;
  if (game.left > 0) {
    game.left--;
    game.ballNo++;
    resetBall();
    newBall();
    hooks.say(`Bonus ${fmt(bonus)} · ball ${game.ballNo}`, 3);
    hooks.change();
    return;
  }
  game.state = "over";
  hooks.say(`Game over · ${fmt(game.score)}`, 0);
  hooks.change();
  hooks.over(game.score);
}

/* ---------- Controls ---------- */

/** A flipper button: the flipper, the lit lanes moving with it, and the plunger. */
export function flip(side, down) {
  const f = flippers[side];
  if (f.on === down) return;
  f.on = down;
  if (!down) return;
  hooks.sound("flip");
  // Lane change: the lit lanes move the way the flipper points.
  const l = game.lanes;
  game.lanes = side ? [l[2], l[0], l[1]] : [l[1], l[2], l[0]];
}

export function inLane(b) {
  return b.x > LANE_X && b.y > H - 140;
}

export function waiting() {
  return balls.find((b) => inLane(b) && !b.launched && !b.auto);
}

export function pull(on) {
  if (on) {
    if (waiting()) game.pulling = true;
    return;
  }
  if (!game.pulling) return;
  game.pulling = false;
  const b = waiting();
  if (b) launch(b, game.pull);
}

function launch(b, power, auto = false) {
  // ±10% of the shot is luck, as a real plunger's is.
  b.vy = -(1000 + 480 * power) * (1 + (Math.random() - 0.5) * 0.1);
  b.launched = true;
  b.sw.add("plunge");
  // The ball save runs from a plunge of the player's own, not from a ball it served back.
  if (!auto && !game.multiball && !b.sw.has("saved")) game.save = 10;
  if (game.questWait <= 0 && !game.quest && game.questNo === 0) game.questWait = 2;
  hooks.sound("launch");
}

/* ---------- Physics ---------- */

/** Push a ball out of a segment of thickness r0→r1; the contact, or null. */
function touch(b, ax, ay, bx, by, l2, r0, r1) {
  const dx = bx - ax;
  const dy = by - ay;
  let t = ((b.x - ax) * dx + (b.y - ay) * dy) / l2;
  t = t < 0 ? 0 : t > 1 ? 1 : t;
  const px = ax + dx * t;
  const py = ay + dy * t;
  let nx = b.x - px;
  let ny = b.y - py;
  const reach = R + r0 + (r1 - r0) * t;
  const d2 = nx * nx + ny * ny;
  if (d2 >= reach * reach) return null;
  const d = Math.sqrt(d2) || 1e-6;
  nx /= d;
  ny /= d;
  b.x = px + nx * reach;
  b.y = py + ny * reach;
  return { nx, ny, px, py };
}

/**
 * Rebound off a surface moving at (sx, sy): elasticity along the normal,
 * a little friction along it. Returns the speed of the impact.
 */
function bounce(b, nx, ny, e, sx = 0, sy = 0, smooth = 0.96) {
  const rx = b.vx - sx;
  const ry = b.vy - sy;
  const vn = rx * nx + ry * ny;
  if (vn >= 0) return 0;
  // Along the surface the ball keeps its speed; into it, it comes back at e
  // of what it hit with. A real impact also loses a little along the
  // surface; a ball merely rolling against it, pressed there by the slope,
  // loses nothing, which is what lets it roll smoothly down a rail.
  const keep = vn < -40 ? smooth : 1;
  const tx = rx - vn * nx;
  const ty = ry - vn * ny;
  b.vx = sx + tx * keep - vn * e * nx;
  b.vy = sy + ty * keep - vn * e * ny;
  return -vn;
}

/** An active surface's kick: only past a threshold, then up to `speed` along the normal. */
function kick(b, nx, ny, speed) {
  const vn = b.vx * nx + b.vy * ny;
  if (vn < speed) {
    b.vx += (speed - vn) * nx;
    b.vy += (speed - vn) * ny;
  }
}

/** Fire `fn` once as a ball enters a zone, again only after it has left. */
function zone(b, name, inside, fn) {
  if (inside) {
    if (!b.sw.has(name)) {
      b.sw.add(name);
      fn();
    }
  } else b.sw.delete(name);
}

function crossed(b, ax, ay, bx, by) {
  const side = (x, y) => (bx - ax) * (y - ay) - (by - ay) * (x - ax);
  const s0 = side(b.px, b.py);
  const s1 = side(b.x, b.y);
  if (s0 * s1 > 0) return false;
  const dx = bx - ax;
  const dy = by - ay;
  const t = ((b.x - ax) * dx + (b.y - ay) * dy) / (dx * dx + dy * dy);
  return t >= -0.05 && t <= 1.05;
}

function stepBall(b, dt) {
  if (b.auto > 0) {
    b.auto -= dt;
    if (b.auto <= 0) launch(b, 0.6 + Math.random() * 0.3, true);
    return;
  }
  if (b.ramp >= 0) {
    // On the ramp: slowed by the climb, carried by the drop.
    const [, , z0] = rampAt(b.ramp);
    b.ramp += b.rampV * dt;
    const [x, y, z] = rampAt(b.ramp);
    b.rampV = Math.max(300, b.rampV - (z - z0) * 16 * dt * 60);
    b.x = x;
    b.y = y;
    b.z = z;
    if (b.ramp >= RAMP_LENGTH) {
      b.ramp = -1;
      b.z = 0;
      b.vx = 0;
      b.vy = 260;
      rampMade();
    }
    return;
  }
  if (b.held > 0) {
    b.held -= dt;
    b.x = TEMPLE.x;
    b.y = TEMPLE.y;
    if (b.held <= 0) {
      b.vx = (Math.random() < 0.5 ? -1 : 1) * (80 + Math.random() * 60);
      b.vy = 300;
      b.cool = 0.6;
      hooks.sound("kickout");
    }
    return;
  }
  b.cool = Math.max(0, b.cool - dt);
  b.px = b.x;
  b.py = b.y;
  b.vy += GRAVITY * dt;
  const v = Math.hypot(b.vx, b.vy);
  if (v > MAX_V) {
    b.vx *= MAX_V / v;
    b.vy *= MAX_V / v;
  }
  b.x += b.vx * dt;
  b.y += b.vy * dt;

  // The ramp's mouth: in fast enough and up it goes; too slow and it rolls back out.
  const m = RAMP_MOUTH;
  if (crossed(b, m.a[0], m.a[1], m.b[0], m.b[1])) {
    const vin = b.vx * m.n[0] + b.vy * m.n[1];
    if (vin > 0) {
      if (vin > 320) {
        b.ramp = 0;
        b.rampV = Math.min(800, Math.hypot(b.vx, b.vy));
        return;
      }
      b.x = b.px;
      b.y = b.py;
      b.vx -= 1.3 * vin * m.n[0];
      b.vy -= 1.3 * vin * m.n[1];
    }
  }

  for (const s of segs) {
    if (s.on && !s.on()) continue;
    if (s.tag === "gate" && (b.vy < 0 || b.x < LANE_X - R)) continue;
    const c = touch(b, s.ax, s.ay, s.bx, s.by, s.l2, 0, 0);
    if (!c) continue;
    const speed = bounce(b, c.nx, c.ny, s.e ?? 0.5);
    const tag = s.tag;
    if (!tag || speed < 40) continue;
    if (tag[0] === "s" && speed > 70) {
      kick(b, c.nx, c.ny, 470);
      hitSling(Number(tag[1]));
    } else if (tag[0] === "d" && c.nx < 0) hitDrop(Number(tag[1]));
    else if (tag[0] === "t" && c.nx > 0) hitStandup(Number(tag[1]));
  }

  for (const p of posts) {
    if (p.on && !p.on()) continue;
    const dx = b.x - p.x;
    const dy = b.y - p.y;
    const reach = R + p.r;
    const d2 = dx * dx + dy * dy;
    if (d2 >= reach * reach) continue;
    const d = Math.sqrt(d2) || 1e-6;
    b.x = p.x + (dx / d) * reach;
    b.y = p.y + (dy / d) * reach;
    bounce(b, dx / d, dy / d, p.e ?? 0.5);
  }

  for (const bm of BUMPERS) {
    const dx = b.x - bm.x;
    const dy = b.y - bm.y;
    const reach = R + bm.r;
    const d2 = dx * dx + dy * dy;
    if (d2 >= reach * reach) continue;
    const d = Math.sqrt(d2) || 1e-6;
    const nx = dx / d;
    const ny = dy / d;
    b.x = bm.x + nx * reach;
    b.y = bm.y + ny * reach;
    const speed = bounce(b, nx, ny, 0.5);
    if (speed > 30 || bm.flash <= 0) {
      kick(b, nx, ny, 420);
      if (bm.flash <= 0) hitBumper();
      bm.flash = 0.15;
    }
  }

  for (const f of flippers) {
    const tx = f.x + Math.cos(f.a) * FLIP_LEN;
    const ty = f.y + Math.sin(f.a) * FLIP_LEN;
    const c = touch(b, f.x, f.y, tx, ty, FLIP_LEN * FLIP_LEN, 10, 6);
    if (!c) continue;
    bounce(b, c.nx, c.ny, 0.35, -f.w * (c.py - f.y), f.w * (c.px - f.x), 0.99);
  }

  // The plunger's face.
  if (b.x > LANE_X) {
    const face = PLUNGER_Y + game.pull * 28;
    if (b.y + R > face) {
      b.y = face - R;
      if (b.vy > 0) b.vy = 0;
      b.vx = 0;
      b.x = PLUNGE_X;
      if (b.launched && !game.pulling) {
        b.launched = false;
        b.sw.delete("plunge");
      }
    }
  }

  // Switches.
  LANES_X.forEach((x, i) => zone(b, `l${i}`, Math.abs(b.x - x) < 11 && b.y > 66 && b.y < 90, () => rollLane(i, b)));
  zone(b, "inL", b.x > 50 && b.x < 82 && b.y > 600 && b.y < 630, () => {
    award(1000);
    flash("inL", 1);
  });
  zone(b, "inR", b.x > 298 && b.x < 330 && b.y > 600 && b.y < 630, () => {
    award(1000);
    flash("inR", 1);
  });
  zone(b, "outR", b.x > 330 && b.x < LANE_X && b.y > 640 && b.y < 670, () => {
    award(2000);
    flash("outR", 1);
  });
  // The kickback, at the foot of the outlane.
  if (game.kickback && b.x > 330 && b.x < LANE_X && b.y > 690) {
    b.vy = -920;
    b.vx = -10;
    game.kickback = false;
    flash("kick", 1);
    hooks.say("Kickback!", 2);
    hooks.sound("kickback");
  }
  // The spinner: a ball through it sets it turning by how fast it went.
  if (b.x < 50 && crossed(b, 14, SPINNER.y, 50, SPINNER.y)) {
    SPINNER.w = Math.min(60, Math.abs(b.vy) / 18) * Math.sign(-b.vy || 1);
    if (b.vy < 0) b.orbitT = 2.5;
  }
  if (b.orbitT > 0) {
    b.orbitT -= dt;
    if (b.x > 300 && b.y < 210) {
      b.orbitT = 0;
      orbit();
    }
  }
  // The temple.
  if (!b.cool && Math.hypot(b.x - TEMPLE.x, b.y - TEMPLE.y) < 9) {
    b.held = 1.5;
    b.vx = 0;
    b.vy = 0;
    hooks.sound("sink");
    templeAward();
  }
  if (b.sw.has("plunge") && b.y < 300 && b.x < LANE_X - 20 && b.y > 120) {
    // Missed the lanes: the skill shot is gone.
    b.sw.delete("plunge");
    game.skill = -1;
  }

  // A ball at rest anywhere but on a flipper or the plunger is stuck: after
  // half a second it is tossed up at a random angle, gently; one that will not
  // come free after twenty tries is taken off and served again.
  const held = inLane(b) || (b.y > 620 && flippers.some((f) => Math.hypot(b.x - f.x, b.y - f.y) < FLIP_LEN + 14));
  if (!held && Math.hypot(b.vx, b.vy) < 10) {
    b.still += dt;
    if (b.still > 0.5) {
      b.still = 0;
      b.stuck = (b.stuck || 0) + 1;
      if (b.stuck > 20) {
        balls.splice(balls.indexOf(b), 1);
        newBall().auto = 0.6;
        return;
      }
      const a = -Math.PI / 2 + (Math.random() - 0.5) * Math.PI;
      b.vx = Math.cos(a) * 160;
      b.vy = Math.sin(a) * 160;
    }
  } else {
    b.still = 0;
    if (Math.hypot(b.vx, b.vy) > 200) b.stuck = 0;
  }

  if (b.y > H + 30) drained(b);
}

/** Two balls meeting: equal masses, so they trade their speeds along the line between them. */
function collideBalls() {
  for (let i = 0; i < balls.length; i++) {
    for (let j = i + 1; j < balls.length; j++) {
      const a = balls[i];
      const b = balls[j];
      if (a.ramp >= 0 || b.ramp >= 0 || a.held > 0 || b.held > 0) continue;
      const dx = b.x - a.x;
      const dy = b.y - a.y;
      const d = Math.hypot(dx, dy);
      if (d >= R * 2 || d === 0) continue;
      const nx = dx / d;
      const ny = dy / d;
      const push = (R * 2 - d) / 2;
      a.x -= nx * push;
      a.y -= ny * push;
      b.x += nx * push;
      b.y += ny * push;
      const rel = (a.vx - b.vx) * nx + (a.vy - b.vy) * ny;
      if (rel <= 0) continue;
      a.vx -= rel * nx * 0.95;
      a.vy -= rel * ny * 0.95;
      b.vx += rel * nx * 0.95;
      b.vy += rel * ny * 0.95;
    }
  }
}

/** One frame of the table, `dt` seconds. */
export function update(dt) {
  if (game.pulling) game.pull = Math.min(1, game.pull + dt / 0.9);
  else if (game.pull > 0) game.pull = Math.max(0, game.pull - dt * 8);

  // As many steps as keep every ball, and every flipper's tip, to half a
  // ball radius per step.
  let fastest = 0;
  for (const b of balls) fastest = Math.max(fastest, Math.hypot(b.vx, b.vy), b.rampV || 0);
  const steps = Math.min(48, Math.max(4, Math.ceil((Math.max(fastest, FLIP_UP * FLIP_LEN) * dt) / MAX_STEP)));
  const sub = dt / steps;
  for (let k = 0; k < steps; k++) {
    for (const f of flippers) {
      const prev = f.a;
      const goal = f.on ? f.up : f.rest;
      const turn = (f.on ? FLIP_UP : FLIP_DOWN) * sub;
      const d = goal - f.a;
      f.a = Math.abs(d) <= turn ? goal : f.a + Math.sign(d) * turn;
      f.w = (f.a - prev) / sub;
    }
    if (game.state === "play") {
      for (const b of [...balls]) stepBall(b, sub);
      collideBalls();
    }
  }

  // The spinner turns down, paying for each turn it makes.
  if (SPINNER.w) {
    const before = Math.floor(Math.abs(SPINNER.a) / (Math.PI * 2));
    SPINNER.a += SPINNER.w * dt;
    SPINNER.w *= Math.pow(0.35, dt);
    if (Math.abs(SPINNER.w) < 0.6) {
      SPINNER.w = 0;
      SPINNER.a = 0;
    }
    const after = Math.floor(Math.abs(SPINNER.a) / (Math.PI * 2));
    if (game.state === "play") spin(Math.max(0, after - before));
  }

  for (const bm of BUMPERS) bm.flash -= dt;
  for (const t of STANDUPS) t.flash -= dt;
  game.sling[0] -= dt;
  game.sling[1] -= dt;
  for (const k in game.flash) if ((game.flash[k] -= dt) <= 0) delete game.flash[k];
  for (const d of DROPS) d.h += ((d.up ? 1 : 0) - d.h) * Math.min(1, dt * 16);
  CENTER_POST.h += ((game.post || game.save > 0 ? 1 : 0) - CENTER_POST.h) * Math.min(1, dt * 10);
  game.attract += dt;
  if (game.state !== "play") return;

  if (game.dropReset > 0 && (game.dropReset -= dt) <= 0) for (const d of DROPS) d.up = true;
  if (game.save > 0) game.save = Math.max(0, game.save - dt);
  if (game.combo > 0) game.combo -= dt;
  if (game.rungT > 0 && (game.rungT -= dt) <= 0 && game.rung > 0) {
    game.rung--;
    if (game.rung) game.rungT = 60;
  }
  if (game.powerT > 0 && (game.powerT -= dt) <= 0 && game.power > 0) {
    game.power--;
    if (game.power) game.powerT = 60;
  }
  if (game.quest && (game.quest.t -= dt) <= 0) {
    hooks.say("Quest failed · try the next", 2.5);
    game.quest = null;
    game.questNo++;
    game.questWait = 4;
  }
  if (!game.quest && game.questWait > 0 && (game.questWait -= dt) <= 0) startQuest();
}
