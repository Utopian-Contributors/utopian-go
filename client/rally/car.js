/**
 * Rally's car: how it drives, flies, lands and wrecks.
 *
 * On the road the car is held in the road's own terms: how far along the lap
 * (s), how far right of the middle (u), which way it points against the road
 * (psi) and its velocity along and across it. That is what lets it run round
 * the loop on its roof and over every crest: the road's frame carries it.
 * It stays on only while the road can push on it. Over a crest taken fast, at
 * the top of a loop taken slow, or off a jump's lip, it lets go and flies,
 * free in the world under gravity, turning as it was turning when it left.
 * The stick rolls and pitches it in the air.
 *
 * Coming down, it lands on the road if it is the right way up and not too
 * hard; on its roof, or too hard, it is totalled. So is hitting a barrier or
 * a crate fast. Off the course altogether (into a jump's gap, over a
 * barrier) it is put back where it left the road.
 *
 * Steps are fixed (STEP), so a lap is timed in whole steps and plays the same
 * whatever the screen's frame rate.
 */
import { CHECKPOINTS } from "../../src/social/rally.ts";
import { checkpointAt, fromStart } from "../../src/social/rallyTrack.ts";
import { WALL_H } from "./scene.js";

/** @typedef {import("../../src/social/rallyTrack.ts").Track} Track */

export const STEP = 1 / 120;

const G = 9.8;
/** Top speed under its own power on the flat, and boosting; in m/s. */
const VMAX = 47;
const VBOOST = 66;
const ACCEL = 17;
const BOOST_ACCEL = 26;
const BRAKE = 24;
const REVERSE = 12;
/** Tyres: how hard they can push sideways, in g. */
const GRIP = 1.55;
const WHEELBASE = 2.6;
/** Faster than these into a barrier, a crate, or the road from the air, and the car is totalled. m/s. */
const CRASH_WALL = 17;
const CRASH_CRATE = 15;
const CRASH_LAND = 24;
/** A boost lasts this long; a pad gives this much. Seconds. */
export const BOOST_TIME = 2.2;
const PAD_TIME = 1.1;
/** The most boosts carried. */
export const MAX_BOOSTS = 2;
/** The car's half width, and the half width of a crate plus the car's reach. */
const CAR_HALF = 0.95;
const CRATE_R = 2.1;

/**
 * The car as a box for touching things: half its width, half its height and
 * half its length, its middle MID over the origin under its wheels. Every
 * body style fits in it (client/rally/scene.js).
 */
const HALF = [0.95, 0.75, 2.3];
const MID = 0.75;

/** The car's middle. @param {{pos: number[], U: number[]}} r */
const middle = (r) => add(r.pos, scale(r.U, MID));

/**
 * How far the car's box reaches from its middle towards a surface facing
 * `n`, however the car is turned: its lowest corner, as `n` sees it.
 * @param {{F: number[], U: number[]}} r @param {number[]} n
 */
function reach(r, n) {
  const L = cross(r.U, r.F);
  return HALF[0] * Math.abs(dot(L, n)) + HALF[1] * Math.abs(dot(r.U, n)) + HALF[2] * Math.abs(dot(r.F, n));
}

/** @typedef {{gas: number, brake: number, steer: number, pitch: number}} Input */
/** @typedef {"coin" | "boost" | "pad" | "fire" | "wall" | "crate" | "land" | "air" | "crash" | "fell" | "checkpoint" | "finish"} Event */

/* ---------- Vectors ---------- */

/** @param {number[]} a @param {number[]} b */
const dot = (a, b) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
/** @param {number[]} a @param {number[]} b */
const cross = (a, b) => [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];
/** @param {number[]} a @param {number} k */
const scale = (a, k) => [a[0] * k, a[1] * k, a[2] * k];
/** @param {number[]} a @param {number[]} b */
const add = (a, b) => [a[0] + b[0], a[1] + b[1], a[2] + b[2]];
/** @param {number[]} a @param {number[]} b */
const sub = (a, b) => [a[0] - b[0], a[1] - b[1], a[2] - b[2]];
/** @param {number[]} a */
const unit = (a) => scale(a, 1 / (Math.hypot(a[0], a[1], a[2]) || 1));
/** `v` turned about `axis` (a unit vector) by `angle`. @param {number[]} v @param {number[]} axis @param {number} angle */
function turn(v, axis, angle) {
  const c = Math.cos(angle);
  const s = Math.sin(angle);
  const k = dot(axis, v) * (1 - c);
  const x = cross(axis, v);
  return [v[0] * c + x[0] * s + axis[0] * k, v[1] * c + x[1] * s + axis[1] * k, v[2] * c + x[2] * s + axis[2] * k];
}

/* ---------- The road at a point ---------- */

/**
 * The road at `s` metres along: its place and frame, interpolated between
 * samples, how fast it bends right (kh) and up into the car (kv) per metre,
 * and what is on it.
 * @param {Track} tr @param {number} s
 */
export function roadAt(tr, s) {
  const x = (((s / tr.ds) % tr.n) + tr.n) % tr.n;
  const i = Math.floor(x);
  const j = (i + 1) % tr.n;
  const f = x - i;
  /** @param {Float64Array} a */
  const lerp = (a) => [a[i * 3] + (a[j * 3] - a[i * 3]) * f, a[i * 3 + 1] + (a[j * 3 + 1] - a[i * 3 + 1]) * f, a[i * 3 + 2] + (a[j * 3 + 2] - a[i * 3 + 2]) * f];
  const t = unit(lerp(tr.t));
  const n = unit(lerp(tr.nrm));
  const r = unit(lerp(tr.r));
  const dt = [(tr.t[j * 3] - tr.t[i * 3]) / tr.ds, (tr.t[j * 3 + 1] - tr.t[i * 3 + 1]) / tr.ds, (tr.t[j * 3 + 2] - tr.t[i * 3 + 2]) / tr.ds];
  return { p: lerp(tr.p), t, n, r, kh: dot(dt, r), kv: dot(dt, n), road: !!tr.road[i] && !!tr.road[j], pad: !!tr.pad[i], i };
}

/**
 * Where a point in the world is against the road near `hint`: s along, u
 * right, h above. Searches `back` metres behind and `ahead` in front.
 * @param {Track} tr @param {number[]} p @param {number} hint @param {number} back @param {number} ahead
 */
function project(tr, p, hint, back, ahead) {
  const i0 = Math.round(hint / tr.ds);
  let best = i0;
  let bestD = Infinity;
  for (let k = -back; k <= ahead; k++) {
    const i = (((i0 + k) % tr.n) + tr.n) % tr.n;
    const dx = p[0] - tr.p[i * 3];
    const dy = p[1] - tr.p[i * 3 + 1];
    const dz = p[2] - tr.p[i * 3 + 2];
    const d = dx * dx + dy * dy + dz * dz;
    if (d < bestD) {
      bestD = d;
      best = i0 + k;
    }
  }
  // Then along the road from that sample, to where p is square across it.
  let s = best * tr.ds;
  for (let it = 0; it < 2; it++) {
    const q = roadAt(tr, s);
    s += Math.max(-tr.ds, Math.min(tr.ds, dot(sub(p, q.p), q.t)));
  }
  const q = roadAt(tr, s);
  const d = sub(p, q.p);
  return { s, u: dot(d, q.r), h: dot(d, q.n), q };
}

/* ---------- The race ---------- */

/** The difference a to b round the lap, the short way. @param {Track} tr @param {number} a @param {number} b */
const along = (tr, a, b) => {
  let d = (b - a) % tr.len;
  if (d > tr.len / 2) d -= tr.len;
  if (d < -tr.len / 2) d += tr.len;
  return d;
};

/** A race on `tr`, on the grid behind the line. @param {Track} tr */
export function race(tr) {
  const s = tr.start - 4;
  return {
    tr,
    /** @type {"ground" | "air" | "wreck"} */
    mode: "ground",
    s,
    u: 0,
    psi: 0,
    vt: 0,
    vr: 0,
    yaw: 0,
    // In the air (and as last placed): the world position, velocity, and the car's frame.
    pos: [0, 0, 0],
    vel: [0, 0, 0],
    F: [0, 0, 1],
    U: [0, 1, 0],
    spin: [0, 0, 0],
    /** Where it last left the road, and how far round it was, for putting it back. */
    left: s,
    leftProgress: -4,
    airTime: 0,
    /** How far round the lap from the line, counting back for going backwards. */
    progress: -4,
    checkpoints: 0,
    taken: new Uint8Array(tr.coins.length),
    coins: 0,
    cans: new Uint8Array(tr.boosts.length),
    boosts: 0,
    boostT: 0,
    steps: 0,
    finished: false,
    /** Why it was totalled, once it is. @type {string | null} */
    crashed: null,
    wheelSpin: 0,
    steer: 0,
    /** What happened since the page last looked. @type {Event[]} */
    events: [],
  };
}

/** @typedef {ReturnType<typeof race>} Race */

/** The race's time so far, in milliseconds. @param {Race} r */
export const raceMs = (r) => Math.round(r.steps * STEP * 1000);

/** Fire a boost, when one is carried and none is burning. @param {Race} r */
export function fire(r) {
  if (r.boosts < 1 || r.boostT > 0.3 || r.crashed || r.finished) return false;
  r.boosts--;
  r.boostT = BOOST_TIME;
  r.events.push("fire");
  return true;
}

/** Where the car is and which way it faces, for drawing and the ghost. @param {Race} r */
export function pose(r) {
  if (r.mode !== "ground") return { pos: r.pos, F: r.F, U: r.U };
  const q = roadAt(r.tr, r.s);
  const c = Math.cos(r.psi);
  const sn = Math.sin(r.psi);
  const F = add(scale(q.t, c), scale(q.r, sn));
  return { pos: add(q.p, scale(q.r, r.u)), F, U: q.n };
}

/** The car's speed, m/s. @param {Race} r */
export const speed = (r) => (r.mode === "ground" ? Math.hypot(r.vt, r.vr) : Math.hypot(r.vel[0], r.vel[1], r.vel[2]));

/**
 * One step of the race.
 * @param {Race} r @param {Input} input
 */
export function step(r, input) {
  const dt = STEP;
  if (r.mode === "wreck") {
    wreck(r, dt);
    return;
  }
  if (r.finished) {
    // Over the line: off the power, rolling to a stop.
    input = { gas: 0, brake: 0.4, steer: 0, pitch: 0 };
  } else r.steps++;
  r.boostT = Math.max(0, r.boostT - dt);
  r.steer += (input.steer - r.steer) * Math.min(1, dt * 12);
  if (r.mode === "ground") ground(r, input, dt);
  else air(r, input, dt);
  if (r.mode === "wreck") return;
  pickUp(r);
  lap(r);
}

/** @param {Race} r @param {Input} input @param {number} dt */
function ground(r, input, dt) {
  const tr = r.tr;
  const q = roadAt(tr, r.s);
  if (!q.road) {
    takeOff(r, q);
    air(r, input, dt);
    return;
  }
  const c = Math.cos(r.psi);
  const sn = Math.sin(r.psi);
  const fwd = add(scale(q.t, c), scale(q.r, sn));
  const right = sub(scale(q.r, c), scale(q.t, sn));
  // How hard the road pushes up on the car: gravity into it, and the push that bends its path.
  const press = G * q.n[1] + r.vt * r.vt * q.kv;
  if (press < -0.5) {
    takeOff(r, q);
    air(r, input, dt);
    return;
  }
  const grip = Math.max(0, press);
  // Along the car and across it.
  let vf = r.vt * c + r.vr * sn;
  let vl = -r.vt * sn + r.vr * c;
  // Power, brakes, and the hill.
  const boosting = r.boostT > 0;
  const top = boosting ? VBOOST : VMAX;
  let a = -G * fwd[1];
  if (boosting) a += BOOST_ACCEL * Math.max(0, 1 - vf / VBOOST) + 4;
  if (input.gas > 0) a += vf < 0 ? BRAKE * input.gas : input.gas * ACCEL * Math.max(0, 1 - vf / top);
  if (input.brake > 0) a -= vf > 0.5 ? BRAKE * input.brake : input.gas > 0 ? 0 : vf > -REVERSE ? 9 * input.brake : 0;
  // Rolling and air.
  a -= Math.sign(vf) * (0.6 + 0.0009 * vf * vf) + (input.gas || boosting ? 0 : 0.9 * Math.sign(vf));
  if (vf > top) a -= (vf - top) * 1.5;
  const vfBefore = vf;
  vf += a * dt;
  // Coasting to a stop does not run on backwards.
  if (!input.brake && !input.gas && Math.sign(vf) !== Math.sign(vfBefore) && Math.abs(G * fwd[1]) < 1.6) vf = 0;
  // Sideways: the road's lean pulls, the tyres hold up to their grip, then slide.
  vl += -G * right[1] * dt;
  const hold = GRIP * grip * dt + 0.6 * dt;
  vl -= Math.max(-hold, Math.min(hold, vl));
  // Steering: less lock the faster it goes, and never turning harder than the tyres allow.
  const lock = (0.58 * r.steer) / (1 + Math.abs(vf) / 17);
  let yaw = (vf * Math.tan(lock)) / WHEELBASE;
  const most = (1.25 * GRIP * Math.max(grip, 2)) / Math.max(4, Math.abs(vf));
  yaw = Math.max(-most, Math.min(most, yaw));
  r.yaw += (yaw - r.yaw) * Math.min(1, dt * 10);
  // Back into the road's terms, then turned.
  r.vt = vf * c - vl * sn;
  r.vr = vf * sn + vl * c;
  r.psi += r.yaw * dt;
  r.wheelSpin += (vf * dt) / 0.37;
  // On along the road: a bend's inside is shorter.
  const ds = (r.vt * dt) / Math.max(0.3, 1 - q.kh * r.u);
  r.s += ds;
  r.u += r.vr * dt;
  r.progress += ds;
  // The road turns under the car: the car keeps its way in the world.
  const bendBy = q.kh * ds;
  r.psi -= bendBy;
  const cb = Math.cos(bendBy);
  const sb = Math.sin(bendBy);
  const vt = r.vt * cb + r.vr * sb;
  r.vr = -r.vt * sb + r.vr * cb;
  r.vt = vt;
  r.psi = Math.atan2(Math.sin(r.psi), Math.cos(r.psi));
  if (q.pad && !r.crashed) {
    if (r.boostT < PAD_TIME) r.events.push("pad");
    r.boostT = Math.max(r.boostT, PAD_TIME);
  }
  walls(r);
  crates(r);
}

/** The barriers either side: a scrape and a bounce, or a wreck. @param {Race} r */
function walls(r) {
  const edge = r.tr.width / 2 - CAR_HALF + 0.3;
  if (Math.abs(r.u) <= edge) return;
  const side = Math.sign(r.u);
  const into = r.vr * side;
  r.u = side * edge;
  if (into <= 0) return;
  if (into > CRASH_WALL) {
    total(r, "Into the barrier too fast", side);
    return;
  }
  r.vr = -side * into * 0.25;
  r.vt *= 1 - Math.min(0.35, into * 0.025);
  r.psi *= 0.6;
  if (into > 2) r.events.push("wall");
}

/** The crates on the road. @param {Race} r */
function crates(r) {
  const tr = r.tr;
  for (const box of tr.crates) {
    const ds = along(tr, box.s, r.s);
    if (Math.abs(ds) > CRATE_R + 2) continue;
    const du = r.u - box.u;
    const d = Math.hypot(ds, du);
    if (d >= CRATE_R) continue;
    const ns = ds / (d || 1);
    const nu = du / (d || 1);
    const into = -(r.vt * ns + r.vr * nu);
    // Pushed out to its edge.
    r.s += ns * (CRATE_R - d);
    r.u += nu * (CRATE_R - d);
    if (into <= 0) continue;
    if (into > CRASH_CRATE) {
      total(r, "Hit a crate too fast", 0);
      return;
    }
    r.vt += ns * into * 1.3;
    r.vr += nu * into * 1.3;
    r.events.push("crate");
  }
}

/**
 * Off the road into the air: the world velocity it had, and the turning it
 * had from the road bending under it.
 * @param {Race} r @param {ReturnType<typeof roadAt>} q
 */
function takeOff(r, q) {
  const p = pose(r);
  r.pos = p.pos;
  r.F = p.F;
  r.U = p.U;
  r.vel = add(scale(q.t, r.vt), scale(q.r, r.vr));
  // The frame a little further on, the difference over the time to get there, as a spin.
  const ahead = roadAt(r.tr, r.s + Math.max(0.5, r.vt * STEP * 4));
  const h = Math.max(0.5, r.vt * STEP * 4) / Math.max(1, Math.abs(r.vt));
  const w = add(add(cross(q.t, sub(ahead.t, q.t)), cross(q.n, sub(ahead.n, q.n))), cross(q.r, sub(ahead.r, q.r)));
  r.spin = add(scale(w, 0.5 / h), scale(q.n, r.yaw));
  r.mode = "air";
  r.airTime = 0;
  r.left = r.s;
  r.leftProgress = r.progress;
  r.events.push("air");
}

/** @param {Race} r @param {Input} input @param {number} dt */
function air(r, input, dt) {
  const tr = r.tr;
  r.airTime += dt;
  r.vel[1] -= G * dt;
  if (r.boostT > 0) r.vel = add(r.vel, scale(r.F, BOOST_ACCEL * 0.8 * dt));
  // The drag of the air, a little.
  r.vel = scale(r.vel, 1 - 0.0004 * Math.hypot(r.vel[0], r.vel[1], r.vel[2]) * dt);
  const prev = r.pos;
  r.pos = add(r.pos, scale(r.vel, dt));
  airControl(r, input, dt);
  const w = Math.hypot(r.spin[0], r.spin[1], r.spin[2]);
  if (w > 1e-6) {
    const axis = scale(r.spin, 1 / w);
    r.F = unit(turn(r.F, axis, w * dt));
    r.U = turn(r.U, axis, w * dt);
    // Kept square to F.
    r.U = unit(sub(r.U, scale(r.F, dot(r.U, r.F))));
  }
  r.wheelSpin += 0.2;

  const at = project(tr, r.pos, r.s, 90, 90);
  const moved = along(tr, r.s, at.s);
  r.s = at.s;
  r.progress += moved;
  const hw = tr.width / 2;
  // The barriers, while it is low enough to meet them.
  if (at.q.road && Math.abs(at.u) > hw - CAR_HALF + 0.3 && Math.abs(at.u) < hw + 1.2 && at.h < WALL_H + 0.4 && at.h > -0.6) {
    const side = Math.sign(at.u);
    const into = dot(r.vel, at.q.r) * side;
    if (into > 0) {
      if (into > CRASH_WALL) {
        total(r, "Into the barrier too fast", side);
        return;
      }
      r.vel = sub(r.vel, scale(at.q.r, into * side * 1.25));
      r.pos = add(r.pos, scale(at.q.r, -side * (Math.abs(at.u) - (hw - CAR_HALF + 0.3))));
      r.events.push("wall");
    }
  }
  // Down on the road: whatever part of the car meets it first, its wheels or its roof.
  const into = -dot(r.vel, at.q.n);
  const clear = at.h + MID * dot(r.U, at.q.n) - reach(r, at.q.n);
  if (at.q.road && Math.abs(at.u) <= hw && clear < 0.05 && clear > -1.5 && into > 0) {
    // Rested on the road at once, so nothing of it is ever drawn inside it.
    if (clear < 0) r.pos = add(r.pos, scale(at.q.n, -clear));
    land(r, at, into);
    return;
  }
  // Off the course: down on the bank beyond the barriers or on the ground,
  // whichever part of it lands, or gone too long. (Over the road, the road
  // is for landing on, above.)
  const low = middle(r)[1] - reach(r, [0, 1, 0]);
  const beyond = !at.q.road || Math.abs(at.u) > tr.width / 2 + 0.8;
  if (low < Math.max(tr.ground, beyond ? (floorUnder(tr, at) ?? -Infinity) : -Infinity) + 0.05 || r.airTime > 8 || (prev[1] > r.pos[1] && at.h < -6 && !at.q.road && r.pos[1] < tr.ground + 2)) {
    respawn(r);
  }
}

/** How fast steering turns the car about the world's up in the air, and the stick pitches it, at most; rad/s. */
const AIR_YAW = 0.55;
const AIR_PITCH = 1.6;
/** How far steering leans the car into its turn in the air, in radians, and how briskly it gets there. */
const AIR_LEAN = 0.35;
const AIR_LEAN_RATE = 2.5;
/** With the stick left alone, how briskly a roll comes back to level: slowly, so a leaning jump still rolls. */
const AIR_LEVEL = 0.9;
/** How quickly the car's turning in the air comes round to what is asked of it, a second. */
const AIR_GRIP = 4;
/** How hard the nose is drawn to the way the car is going, with the stick left alone. */
const AIR_SETTLE = 2.2;

/**
 * The car's turning in the air. Steering turns it, slowly, about the
 * world's up, and leans it into the turn, never further than AIR_LEAN, so
 * holding the stick through a long jump turns the car and never tumbles it.
 * Left alone, a roll comes back towards level, slowly enough that the leaning
 * jump still rolls the car and steering against it brings it back sooner.
 * The stick pushed well forward or back pitches it; left alone, the nose
 * settles towards the way the car is going, so it comes down clean.
 * @param {Race} r @param {Input} input @param {number} dt
 */
function airControl(r, input, dt) {
  const L = cross(r.U, r.F);
  const up = [0, 1, 0];
  const k = Math.min(1, AIR_GRIP * dt);
  // + about up turns the nose left (towards +x, the car's left): right steering turns it the other way.
  if (r.steer) r.spin = add(r.spin, scale(up, (-r.steer * AIR_YAW - dot(r.spin, up)) * k));
  // How far it is rolled right (its left side up), and the lean it should have.
  const roll = Math.asin(Math.max(-1, Math.min(1, dot(L, up))));
  const rate = r.steer ? (r.steer * AIR_LEAN - roll) * AIR_LEAN_RATE : -roll * AIR_LEVEL;
  // Only while it is the right way up enough to tell left from right.
  if (r.U[1] > -0.2) r.spin = add(r.spin, scale(r.F, (rate - dot(r.spin, r.F)) * k * (r.steer ? 1 : 0.5)));
  if (input.pitch) r.spin = add(r.spin, scale(L, (input.pitch * AIR_PITCH - dot(r.spin, L)) * k));
  else {
    // The nose towards the way it is going: + about L pitches it down.
    const v = unit(r.vel);
    r.spin = add(r.spin, scale(L, -dot(v, r.U) * AIR_SETTLE * dt));
  }
  r.spin = scale(r.spin, 1 - Math.min(1, 0.3 * dt));
}

/**
 * Touching down: on its wheels, or on its roof, or too hard.
 * @param {Race} r @param {ReturnType<typeof project>} at @param {number} into
 */
function land(r, at, into) {
  const q = at.q;
  const up = dot(r.U, q.n);
  if (up < 0.25) {
    total(r, up < -0.3 ? "Landed on the roof" : "Rolled it", 0);
    return;
  }
  if (into > CRASH_LAND) {
    total(r, "Came down too hard", 0);
    return;
  }
  r.mode = "ground";
  r.s = at.s;
  r.u = at.u;
  r.vt = dot(r.vel, q.t);
  r.vr = dot(r.vel, q.r);
  const f = sub(r.F, scale(q.n, dot(r.F, q.n)));
  r.psi = Math.atan2(dot(f, q.r), dot(f, q.t));
  r.yaw = dot(r.spin, q.n);
  // A bad landing costs speed: crooked, or nose first.
  const crooked = Math.max(0, 0.95 - up) + Math.max(0, Math.abs(Math.sin(r.psi)) - 0.3);
  const keep = 1 - Math.min(0.5, crooked * 0.8 + into * 0.008);
  r.vt *= keep;
  r.vr *= keep;
  r.events.push("land");
}

/**
 * Back on the road, pointing on: a run-up's length before where it left, so
 * a jump it fell short of can be taken again at speed.
 * @param {Race} r
 */
function respawn(r) {
  r.mode = "ground";
  let back = 12;
  // Behind any gap's kicker, with straight road to gather speed on.
  for (let d = 0; d <= 140; d += 2) if (!roadAt(r.tr, r.left - d).road) back = d + 130;
  r.s = r.left - back;
  r.progress = r.leftProgress - back;
  r.u = 0;
  r.psi = 0;
  r.yaw = 0;
  r.vt = 14;
  r.vr = 0;
  r.boostT = 0;
  r.events.push("fell");
}

/** Totalled: the race is over, and the car tumbles to a stop. @param {Race} r @param {string} why @param {number} side */
function total(r, why, side) {
  if (r.mode === "ground") {
    const p = pose(r);
    const q = roadAt(r.tr, r.s);
    r.pos = add(p.pos, scale(q.n, 0.2));
    r.F = p.F;
    r.U = p.U;
    r.vel = add(add(scale(q.t, r.vt * 0.5), scale(q.r, -side * 3)), scale(q.n, 6));
    r.spin = add(scale(r.F, (side || 1) * -4), scale(q.n, 2.5));
  }
  r.crashed = why;
  r.mode = "wreck";
  r.events.push("crash");
}

/**
 * How high the solid world is under a point beside the road at `at`: the
 * road itself out to its barriers, then the bank it sits on, falling away
 * two metres for every one out (scene.js splays it so) down to the ground.
 * Where the road there faces down (the loop's roof) or is a jump's gap, only
 * the ground. Null where nothing is under the point but the ground.
 * @param {Track} tr @param {ReturnType<typeof project>} at
 */
function floorUnder(tr, at) {
  const q = at.q;
  if (!q.road || q.n[1] < 0.3) return null;
  const edge = tr.width / 2 + 0.8;
  const out = Math.max(0, Math.abs(at.u) - edge);
  // The road's height across, at u (clamped to its edge), then down the bank.
  const across = Math.max(-edge, Math.min(edge, at.u));
  const y = q.p[1] + q.r[1] * across - out * 2;
  return y > tr.ground ? y : null;
}

/**
 * A wreck tumbling and bouncing to a stop, on whatever is under it: the
 * road, the bank, the ground. It rests on whichever corner of it is lowest,
 * so on its roof or its side it lies on the road, never through it.
 * @param {Race} r @param {number} dt
 */
function wreck(r, dt) {
  const tr = r.tr;
  r.vel[1] -= G * dt;
  r.pos = add(r.pos, scale(r.vel, dt));
  const w = Math.hypot(r.spin[0], r.spin[1], r.spin[2]);
  if (w > 1e-6) {
    const axis = scale(r.spin, 1 / w);
    r.F = unit(turn(r.F, axis, w * dt));
    r.U = unit(turn(r.U, axis, w * dt));
    r.U = unit(sub(r.U, scale(r.F, dot(r.U, r.F))));
  }
  const at = project(tr, middle(r), r.s, 40, 40);
  r.s = at.s;
  const q = at.q;
  // Each corner of the car against what is under that corner: the road's
  // plane across its width, the bank falling away beyond its barriers, the
  // ground. A car on its side over the road's edge rests on both.
  const road = q.road && q.n[1] > 0.3;
  const edge = tr.width / 2 + 0.8;
  const L = cross(r.U, r.F);
  let depth = 0;
  let pushRoad = false;
  /** The corner it rests on (the deepest), for gravity to tip it over. */
  let rest = null;
  for (const x of [-HALF[0], HALF[0]]) {
    for (const y of [0, 2 * HALF[1]]) {
      for (const z of [-HALF[2], HALF[2]]) {
        const c = add(add(add(r.pos, scale(L, x)), scale(r.U, y)), scale(r.F, z));
        const d = sub(c, q.p);
        const u = dot(d, q.r);
        const h = dot(d, q.n);
        let into = tr.ground - c[1];
        if (road && h > -3) {
          // Over the road: its plane. Beyond it: the bank, two down for one out.
          const floor = Math.abs(u) <= edge ? 0 : -(Math.abs(u) - edge) * 2;
          if (Math.abs(u) <= edge && floor - h > into) pushRoad = true;
          into = Math.max(into, floor - h);
        }
        if (into > depth) rest = c;
        depth = Math.max(depth, into);
      }
    }
  }
  if (depth > 0) {
    const n = pushRoad ? q.n : [0, 1, 0];
    r.pos = add(r.pos, scale(n, depth));
    const hit = dot(r.vel, n);
    if (hit < 0) r.vel = sub(r.vel, scale(n, hit * 1.35));
    // Scraping along: slowed hard, its tumbling too.
    r.vel = scale(r.vel, 1 - Math.min(1, 3 * dt));
    r.spin = scale(r.spin, 1 - Math.min(1, 2.5 * dt));
    // Resting on one corner, its weight turns it about that corner: a car
    // stood on its nose or balanced on an edge topples and lies down.
    if (rest) r.spin = add(r.spin, scale(cross(sub(rest, middle(r)), [0, -G, 0]), -0.35 * dt));
  }
  // Whatever happened above, never under the ground.
  const sunk = tr.ground - (middle(r)[1] - reach(r, [0, 1, 0]));
  if (sunk > 0) r.pos[1] += sunk;
}

/** Coins and boosts the car passes through. @param {Race} r */
function pickUp(r) {
  const tr = r.tr;
  let u = r.u;
  let h = 0;
  if (r.mode === "air") {
    const at = project(tr, r.pos, r.s, 3, 3);
    u = at.u;
    h = at.h;
  }
  tr.coins.forEach((coin, k) => {
    if (r.taken[k]) return;
    if (Math.abs(along(tr, coin.s, r.s)) < 2.4 && Math.abs(coin.u - u) < 1.9 && Math.abs(coin.h - (h + 0.7)) < 1.7) {
      r.taken[k] = 1;
      r.coins++;
      r.events.push("coin");
    }
  });
  tr.boosts.forEach((can, k) => {
    if (r.cans[k] || r.boosts >= MAX_BOOSTS) return;
    if (Math.abs(along(tr, can.s, r.s)) < 2.4 && Math.abs(can.u - u) < 2 && h < 2.5) {
      r.cans[k] = 1;
      r.boosts++;
      r.events.push("boost");
    }
  });
}

/** Checkpoints passed in order, and the line. @param {Race} r */
function lap(r) {
  if (r.finished || r.crashed) return;
  const len = r.tr.len;
  while (r.checkpoints < CHECKPOINTS && r.progress >= checkpointAt(len, r.checkpoints + 1)) {
    r.checkpoints++;
    if (r.checkpoints === CHECKPOINTS) {
      r.finished = true;
      r.events.push("finish");
    } else r.events.push("checkpoint");
  }
}

/** How far round the lap the car is, 0…1, for the ghost's gap. @param {Race} r */
export const share = (r) => Math.max(0, r.progress) / r.tr.len;

export { fromStart };
