/**
 * Rally's world, as meshes: the road (asphalt, kerbs, a dashed middle line,
 * boost pads, the chequered line), the barriers along it, the bank it runs
 * on down to the ground, the ground and its trees, the gantry over the start,
 * and the things on the road: coins, boosts, crates. Then a car in any of the
 * store's paints. Built once, from the course (src/social/rallyTrack.ts).
 */
import { Geo, rgb } from "./gl.js";

/** @typedef {import("../../src/social/rallyTrack.ts").Track} Track */
/** @typedef {import("../../src/social/rally.ts").CarDesign} CarDesign */

const C = {
  asphalt: rgb("#4a4e55"),
  asphalt2: rgb("#454950"),
  line: rgb("#f2f2ea"),
  kerbR: rgb("#e0322c"),
  kerbW: rgb("#f4f4f0"),
  wallA: rgb("#2f7fe0"),
  wallB: rgb("#f4f4f0"),
  wallTop: rgb("#d7dbe0"),
  bank: rgb("#7a6a4c"),
  under: rgb("#5d6168"),
  pad: rgb("#ff8a1f"),
  chevron: rgb("#ffe14a"),
  grass: rgb("#5d9a3f"),
  grass2: rgb("#64a145"),
  trunk: rgb("#7a5230"),
  leaf: rgb("#2f7a3a"),
  leaf2: rgb("#3d8c3f"),
  rock: rgb("#8d9096"),
  black: rgb("#1e2024"),
  white: rgb("#f7f7f2"),
  pillar: rgb("#c9ccd2"),
};

/** The barrier's height off the road, and how far outside the kerb it stands. */
export const WALL_H = 1.0;
const WALL_OUT = 0.35;
const WALL_T = 0.4;

/**
 * A sample's frame and place, as arrays, wrapping round the lap.
 * @param {Track} tr @param {number} i
 */
export function at(tr, i) {
  const k = ((i % tr.n) + tr.n) % tr.n;
  const o = k * 3;
  return {
    p: [tr.p[o], tr.p[o + 1], tr.p[o + 2]],
    t: [tr.t[o], tr.t[o + 1], tr.t[o + 2]],
    n: [tr.nrm[o], tr.nrm[o + 1], tr.nrm[o + 2]],
    r: [tr.r[o], tr.r[o + 1], tr.r[o + 2]],
  };
}

/** p + a·u + b·v. @param {number[]} p @param {number[]} u @param {number} a @param {number[]} [v] @param {number} [b] */
const off = (p, u, a, v = [0, 0, 0], b = 0) => [p[0] + u[0] * a + v[0] * b, p[1] + u[1] * a + v[1] * b, p[2] + u[2] * a + v[2] * b];

/** A seeded random, so the trees grow in the same places every visit. @param {number} seed */
function random(seed) {
  let s = seed >>> 0;
  return () => {
    s = (s + 0x6d2b79f5) >>> 0;
    let t = s;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/**
 * The road and everything built along it, as one mesh.
 * @param {Track} tr
 */
export function road(tr) {
  const g = new Geo();
  const hw = tr.width / 2;
  // Every two metres: as smooth as the eye needs, at half the triangles.
  for (let i = 0; i < tr.n; i += 2) {
    const j = (i + 2) % tr.n;
    if (!tr.road[i] || !tr.road[j] || !tr.road[(i + 1) % tr.n]) continue;
    const a = at(tr, i);
    const b = at(tr, j);
    const s = i * tr.ds;
    // The surface: asphalt in long bands, orange on a pad.
    const col = tr.pad[i] ? C.pad : Math.floor(s / 24) % 2 ? C.asphalt : C.asphalt2;
    const aL = off(a.p, a.r, -hw);
    const aR = off(a.p, a.r, hw);
    const bL = off(b.p, b.r, -hw);
    const bR = off(b.p, b.r, hw);
    g.quad(aL, aR, bR, bL, col, [a.n, a.n, b.n, b.n]);
    const lift = 0.03;
    // Chevrons on a pad, pointing on.
    if (tr.pad[i] && !tr.pad[(i - 2 + tr.n) % tr.n] && i + 7 < tr.n) {
      for (let c = 0; c < 3; c++) {
        const q = at(tr, i + 1 + c * 2);
        const tip = off(q.p, q.t, 2.2, q.n, lift);
        g.tri(off(q.p, q.r, -3, q.n, lift), tip, off(q.p, q.r, 0, q.n, lift), C.chevron, [q.n, q.n, q.n]);
        g.tri(off(q.p, q.r, 0, q.n, lift), tip, off(q.p, q.r, 3, q.n, lift), C.chevron, [q.n, q.n, q.n]);
      }
    }
    // The dashed middle line.
    if (!tr.pad[i] && Math.floor(s / 4) % 2 === 0) {
      g.quad(off(a.p, a.r, -0.12, a.n, 0.02), off(a.p, a.r, 0.12, a.n, 0.02), off(b.p, b.r, 0.12, b.n, 0.02), off(b.p, b.r, -0.12, b.n, 0.02), C.line, [a.n, a.n, b.n, b.n]);
    }
    // The chequered line, two rows deep.
    const fromStart = (((s - tr.start) % tr.len) + tr.len) % tr.len;
    if (fromStart < 4) {
      const row = Math.floor(fromStart / 2);
      for (let c = 0; c < 13; c++) {
        const u0 = -hw + c;
        g.quad(off(a.p, a.r, u0, a.n, 0.025), off(a.p, a.r, u0 + 1, a.n, 0.025), off(b.p, b.r, u0 + 1, b.n, 0.025), off(b.p, b.r, u0, b.n, 0.025), (c + row) % 2 ? C.black : C.white, [a.n, a.n, b.n, b.n]);
      }
    }
    // Kerbs, red and white, just inside each edge.
    const kerb = Math.floor(s / 4) % 2 ? C.kerbR : C.kerbW;
    for (const side of [-1, 1]) {
      const e0 = side * hw;
      const e1 = side * (hw - 0.8);
      g.quad(off(a.p, a.r, e1, a.n, 0.04), off(a.p, a.r, e0, a.n, 0.04), off(b.p, b.r, e0, b.n, 0.04), off(b.p, b.r, e1, b.n, 0.04), kerb, [a.n, a.n, b.n, b.n]);
    }
    // The barriers: a face to the road, a top, a face outward; painted in panels.
    const wall = Math.floor(s / 4) % 2 ? C.wallA : C.wallB;
    for (const side of [-1, 1]) {
      const w0 = side * (hw + WALL_OUT);
      const w1 = side * (hw + WALL_OUT + WALL_T);
      const a0 = off(a.p, a.r, w0);
      const b0 = off(b.p, b.r, w0);
      const a1 = off(a.p, a.r, w1);
      const b1 = off(b.p, b.r, w1);
      const up = (/** @type {number[]} */ p, /** @type {number[]} */ n) => off(p, n, WALL_H);
      g.quad(a0, b0, up(b0, b.n), up(a0, a.n), wall);
      g.quad(up(a0, a.n), up(b0, b.n), up(b1, b.n), up(a1, a.n), C.wallTop);
      g.quad(a1, up(a1, a.n), up(b1, b.n), b1, wall);
      // The verge between the kerb and the barrier, and the road's edge.
      g.quad(off(a.p, a.r, side * hw), off(b.p, b.r, side * hw), b0, a0, C.under);
    }
    // Under the road: the slab's underside where it is lifted, else a bank down to the ground.
    if (tr.inLoop[i]) {
      const d = 0.6;
      const uL = off(a.p, a.r, -hw - WALL_OUT - WALL_T, a.n, -d);
      const uR = off(a.p, a.r, hw + WALL_OUT + WALL_T, a.n, -d);
      const vL = off(b.p, b.r, -hw - WALL_OUT - WALL_T, b.n, -d);
      const vR = off(b.p, b.r, hw + WALL_OUT + WALL_T, b.n, -d);
      g.quad(uL, vL, vR, uR, C.under);
      g.quad(off(a.p, a.r, -hw - WALL_OUT - WALL_T), off(b.p, b.r, -hw - WALL_OUT - WALL_T), vL, uL, C.under);
      g.quad(off(a.p, a.r, hw + WALL_OUT + WALL_T), uR, vR, off(b.p, b.r, hw + WALL_OUT + WALL_T), C.under);
    } else {
      for (const side of [-1, 1]) {
        const ea = off(a.p, a.r, side * (hw + WALL_OUT + WALL_T));
        const eb = off(b.p, b.r, side * (hw + WALL_OUT + WALL_T));
        // Down to the ground, splayed out by half the drop.
        const da = Math.max(0, ea[1] - tr.ground);
        const db = Math.max(0, eb[1] - tr.ground);
        const fa = [ea[0] + a.r[0] * side * da * 0.5, tr.ground, ea[2] + a.r[2] * side * da * 0.5];
        const fb = [eb[0] + b.r[0] * side * db * 0.5, tr.ground, eb[2] + b.r[2] * side * db * 0.5];
        g.quad(ea, eb, fb, fa, C.bank);
      }
    }
    // Where the road stops (a jump's lip) or starts again (its landing): a face down to the ground.
    const lip = !tr.road[(j + 1) % tr.n] || !tr.road[(j + 2) % tr.n];
    const back = !tr.road[(i - 1 + tr.n) % tr.n] || !tr.road[(i - 2 + tr.n) % tr.n];
    if (lip || back) {
      const q = lip ? b : a;
      const L = off(q.p, q.r, -hw - WALL_OUT - WALL_T);
      const R = off(q.p, q.r, hw + WALL_OUT + WALL_T);
      g.quad(L, R, [R[0], tr.ground, R[2]], [L[0], tr.ground, L[2]], C.bank);
    }
  }
  gantry(g, tr);
  return g;
}

/** The gantry over the start line: two posts and a chequered beam. @param {Geo} g @param {Track} tr */
function gantry(g, tr) {
  const a = at(tr, Math.round(tr.start / tr.ds));
  const hw = tr.width / 2 + WALL_OUT + WALL_T + 0.6;
  const up = 6.5;
  for (const side of [-1, 1]) {
    const p = off(a.p, a.r, side * hw);
    g.box(p[0], p[1] + up / 2, p[2], 0.6, up, 0.6, C.pillar);
  }
  // The beam, as squares across, two rows high, facing both ways.
  const n = 16;
  for (let c = 0; c < n; c++) {
    for (let row = 0; row < 2; row++) {
      const u0 = -hw + (c / n) * 2 * hw;
      const u1 = -hw + ((c + 1) / n) * 2 * hw;
      const y0 = up - 1.6 + row * 0.8;
      const col = (c + row) % 2 ? C.black : C.white;
      const p0 = off(a.p, a.r, u0, [0, 1, 0], y0);
      const p1 = off(a.p, a.r, u1, [0, 1, 0], y0);
      const p2 = off(a.p, a.r, u1, [0, 1, 0], y0 + 0.8);
      const p3 = off(a.p, a.r, u0, [0, 1, 0], y0 + 0.8);
      g.quad(p0, p1, p2, p3, col);
    }
  }
}

/**
 * The ground, in big squares of two greens out to the fog, and trees and
 * rocks scattered over it clear of the road.
 * @param {Track} tr
 */
export function ground(tr) {
  const g = new Geo();
  let x0 = Infinity;
  let x1 = -Infinity;
  let z0 = Infinity;
  let z1 = -Infinity;
  for (let i = 0; i < tr.n; i++) {
    x0 = Math.min(x0, tr.p[i * 3]);
    x1 = Math.max(x1, tr.p[i * 3]);
    z0 = Math.min(z0, tr.p[i * 3 + 2]);
    z1 = Math.max(z1, tr.p[i * 3 + 2]);
  }
  const pad = 700;
  const tile = 50;
  const y = tr.ground;
  const ax = Math.floor((x0 - pad) / tile);
  const bx = Math.ceil((x1 + pad) / tile);
  const az = Math.floor((z0 - pad) / tile);
  const bz = Math.ceil((z1 + pad) / tile);
  for (let i = ax; i < bx; i++)
    for (let k = az; k < bz; k++) {
      const col = (i + k) % 2 ? C.grass : C.grass2;
      g.quad([i * tile, y, k * tile], [i * tile, y, (k + 1) * tile], [(i + 1) * tile, y, (k + 1) * tile], [(i + 1) * tile, y, k * tile], col);
    }
  // Far beyond, one big square to the horizon.
  const F = 6000;
  g.quad([x0 - F, y - 0.05, z0 - F], [x0 - F, y - 0.05, z1 + F], [x1 + F, y - 0.05, z1 + F], [x1 + F, y - 0.05, z0 - F], C.grass);

  // Where the road is, coarsely, so nothing grows on it.
  /** @type {Map<string, number[][]>} */
  const cells = new Map();
  const cell = 40;
  for (let i = 0; i < tr.n; i += 4) {
    const key = `${Math.floor(tr.p[i * 3] / cell)},${Math.floor(tr.p[i * 3 + 2] / cell)}`;
    let list = cells.get(key);
    if (!list) cells.set(key, (list = []));
    list.push([tr.p[i * 3], tr.p[i * 3 + 2]]);
  }
  /** @param {number} x @param {number} z */
  const clear = (x, z) => {
    const cx = Math.floor(x / cell);
    const cz = Math.floor(z / cell);
    for (let dx = -1; dx <= 1; dx++)
      for (let dz = -1; dz <= 1; dz++)
        for (const [px, pz] of cells.get(`${cx + dx},${cz + dz}`) ?? []) if (Math.hypot(px - x, pz - z) < 30) return false;
    return true;
  };
  const rand = random(7);
  let trees = 0;
  for (let tries = 0; tries < 6000 && trees < 650; tries++) {
    const x = x0 - 300 + rand() * (x1 - x0 + 600);
    const z = z0 - 300 + rand() * (z1 - z0 + 600);
    if (!clear(x, z)) continue;
    trees++;
    if (rand() < 0.18) {
      const s = 1 + rand() * 2.5;
      g.box(x, y + s * 0.35, z, s * 1.6, s * 0.9, s * 1.3, C.rock, { top: 0.6 });
      continue;
    }
    const h = 7 + rand() * 9;
    const r = h * 0.28;
    g.box(x, y + h * 0.15, z, 0.7, h * 0.3, 0.7, C.trunk);
    cone(g, x, y + h * 0.22, z, r, h * 0.55, rand() < 0.5 ? C.leaf : C.leaf2);
    cone(g, x, y + h * 0.5, z, r * 0.75, h * 0.5, C.leaf2);
  }
  return g;
}

/** A six-sided cone standing on (x, y, z). @param {Geo} g @param {number} x @param {number} y @param {number} z @param {number} r @param {number} h @param {number[]} col */
function cone(g, x, y, z, r, h, col) {
  const top = [x, y + h, z];
  for (let i = 0; i < 6; i++) {
    const a0 = (i / 6) * Math.PI * 2;
    const a1 = ((i + 1) / 6) * Math.PI * 2;
    const p0 = [x + Math.cos(a0) * r, y, z + Math.sin(a0) * r];
    const p1 = [x + Math.cos(a1) * r, y, z + Math.sin(a1) * r];
    g.tri(p0, top, p1, col);
    g.tri(p1, [x, y, z], p0, col);
  }
}

/** A coin, standing, facing along +z. */
export function coin() {
  const g = new Geo();
  g.prism("z", 0, 0, 0, 0.6, 0.16, 10, rgb("#e8a817"), rgb("#ffd447"));
  return g;
}

/** A boost to collect: a blue canister with white ends. */
export function boostCan() {
  const g = new Geo();
  g.prism("y", 0, 0, 0, 0.42, 1.0, 8, rgb("#1f9cf0"), rgb("#e8f8ff"));
  g.prism("y", 0, 0.62, 0, 0.18, 0.24, 6, rgb("#e8f8ff"));
  return g;
}

/** A wooden crate, a metre and a half each way, sitting on its base. */
export function crate() {
  const g = new Geo();
  g.box(0, 0.8, 0, 1.6, 1.6, 1.6, rgb("#a8743a"));
  // Darker slats across each face.
  for (const y of [0.35, 1.25]) g.box(0, y, 0, 1.66, 0.18, 1.66, rgb("#7d5226"));
  return g;
}

/** A soft dark patch under the car. */
export function shadow() {
  const g = new Geo();
  const k = [0, 0, 0];
  g.quad([-1.05, 0, -2.2], [1.05, 0, -2.2], [1.05, 0, 2.2], [-1.05, 0, 2.2], k);
  return g;
}

/* ---------- The cars ---------- */

/*
 * Each car is a body style and a paint. The styles follow what defines
 * their kind of car:
 *
 * - rally: a WRC hatchback. Short and tall, wide arches, a roof scoop, a
 *   big wing off the end of the roof, mud flaps and a pod of spot lamps.
 * - coupe: a sports coupe. Long bonnet, the cabin set back, a fastback roof
 *   running down into a ducktail.
 * - gt: a GT3 racer. Widebody arches with louvres, a deep splitter with
 *   dive planes, and a wing standing high on swan-neck posts.
 * - hyper: a hypercar. Cab-forward, the canopy one arc from the nose to the
 *   tail, intakes on its shoulders and sides, a full-width wing over a deep
 *   diffuser.
 * - lmp: a Le Mans prototype. A low nose, the fenders standing proud of a
 *   narrow tub, a bubble canopy, a shark fin down the spine to a
 *   balance-beam wing.
 *
 * Bodies are lofted: cross-sections at stations along the car (`z`, from
 * the tail at about -2.3 to the nose at about +2.4), each a sill, a belt line,
 * the shoulder and the crown (above or, for the prototype's channel between
 * its fenders, below the shoulder), joined face to face. +x is the car's
 * left, +y up, +z ahead; the origin is on the road under its middle.
 */

/** @typedef {[number, number, number, number, number, number, number, number?]} Station z, sill half-width, sill y, belt half-width, belt y, shoulder half-width, shoulder y, crown (+/-) */

/**
 * A lofted body: the stations joined, with a stripe down the crown and the
 * sill and underside in `low`. The nose and tail are closed.
 * @param {Geo} g @param {Station[]} st @param {{side: number[], top: number[], stripe: number[], low: number[]}} c @param {number} stripe half its width
 */
function loft(g, st, c, stripe) {
  /** @param {Station} q */
  const ring = ([z, wb, y0, w1, y1, wt, y2, crown = 0.03]) => {
    const sw = Math.min(stripe, wt * 0.85);
    return [
      [wb, y0, z],
      [w1, y1, z],
      [wt, y2, z],
      [sw, y2 + crown, z],
      [-sw, y2 + crown, z],
      [-wt, y2, z],
      [-w1, y1, z],
      [-wb, y0, z],
    ];
  };
  // The colour of each face round the section: lower flank, upper flank, shoulder, stripe, shoulder, upper flank, lower flank, floor.
  const faces = [c.side, c.side, c.top, c.stripe, c.top, c.side, c.side, c.low];
  const rings = st.map(ring);
  for (let i = 0; i + 1 < rings.length; i++) {
    const a = rings[i];
    const b = rings[i + 1];
    for (let e = 0; e < 8; e++) {
      const f = (e + 1) % 8;
      g.quad(a[e], b[e], b[f], a[f], faces[e]);
    }
  }
  for (const [r, nose] of [[rings[0], false], [rings[rings.length - 1], true]]) {
    const mid = [0, r.reduce((t, p) => t + p[1], 0) / 8, r[0][2]];
    for (let e = 0; e < 8; e++) g.tri(mid, r[e], r[(e + 1) % 8], nose ? c.side : c.side);
  }
}

/**
 * A lofted body's measurements, for seating parts on it: the height of its
 * top at (x, z), and how far out its side is at height y, at z. Between
 * stations the loft runs straight, so these do too.
 * @param {Station[]} st @param {number} stripe the loft's
 */
function measure(st, stripe) {
  // Every station with its crown, as loft() reads one left out.
  const full = st.map((q) => (q.length > 7 ? q : [...q, 0.03]));
  /** The station the body has at z, between the two either side. @param {number} z */
  const at = (z) => {
    let i = 0;
    while (i < full.length - 2 && full[i + 1][0] < z) i++;
    const a = full[i];
    const b = full[i + 1];
    const t = Math.max(0, Math.min(1, (z - a[0]) / (b[0] - a[0])));
    return a.map((v, k) => /** @type {number} */ (v) + (/** @type {number} */ (b[k]) - /** @type {number} */ (v)) * t);
  };
  return {
    /** @param {number} x @param {number} z */
    top(x, z) {
      const [, , , w1, y1, wt, y2, crown] = at(z);
      const sw = Math.min(stripe, wt * 0.85);
      const ax = Math.abs(x);
      if (ax <= sw) return y2 + crown;
      if (ax <= wt) return y2 + crown * (1 - (ax - sw) / (wt - sw));
      if (ax <= w1) return y2 - ((ax - wt) / (w1 - wt)) * (y2 - y1);
      return y1;
    },
    /** @param {number} y @param {number} z */
    side(y, z) {
      const [, wb, y0, w1, y1, wt, y2] = at(z);
      if (y <= y1) return wb + (w1 - wb) * Math.max(0, (y - y0) / (y1 - y0));
      return w1 + (wt - w1) * Math.min(1, (y - y1) / (y2 - y1));
    },
  };
}

/** @typedef {[number, number, number, number, number]} Pane z, base half-width, base y, roof half-width, roof y */

/** A canopy's roof height at z, between its stations. @param {Pane[]} st @param {number} z */
function roofAt(st, z) {
  // Its stations run from the nose back.
  let i = 0;
  while (i < st.length - 2 && st[i + 1][0] > z) i++;
  const a = st[i];
  const b = st[i + 1];
  const t = Math.max(0, Math.min(1, (z - a[0]) / (b[0] - a[0])));
  return a[4] + (b[4] - a[4]) * t;
}

/**
 * A canopy: glass round its sides and at both ends, the roof between in
 * `roof` with the stripe down it. The first and last spans are the
 * windscreen and the back window, glass all over. Its lower edge is tucked a
 * little into the body under it, so no gap shows between them.
 * @param {Geo} g @param {Pane[]} st @param {number[]} glass @param {number[]} roof @param {number[]} stripe @param {ReturnType<typeof measure>} body
 */
function canopy(g, st, glass, roof, stripe, body) {
  /** @param {Pane} q */
  const ring = ([z, wb, base, wt, yt]) => {
    const yb = Math.min(base, body.top(wb, z) - 0.03);
    const sw = Math.min(0.22, wt * 0.5);
    return [
      [wb, yb, z],
      [wt, yt, z],
      [sw, yt + 0.02, z],
      [-sw, yt + 0.02, z],
      [-wt, yt, z],
      [-wb, yb, z],
    ];
  };
  const rings = st.map(ring);
  for (let i = 0; i + 1 < rings.length; i++) {
    const a = rings[i];
    const b = rings[i + 1];
    const end = i === 0 || i === rings.length - 2;
    const faces = [glass, end ? glass : roof, end ? glass : stripe, end ? glass : roof, glass];
    for (let e = 0; e < 5; e++) g.quad(a[e], b[e], b[e + 1], a[e + 1], faces[e]);
  }
  for (const r of [rings[0], rings[rings.length - 1]]) {
    const mid = [0, (r[0][1] + r[2][1]) / 2, r[0][2]];
    for (let e = 0; e < 5; e++) g.tri(mid, r[e], r[e + 1], glass);
  }
}

/** A slab from four corners in the car's side view (z, y), `w` across, centred on x. @param {Geo} g @param {number} x @param {number} w @param {number[][]} zy @param {number[]} col */
function slab(g, x, w, zy, col) {
  const L = zy.map(([z, y]) => [x + w / 2, y, z]);
  const R = zy.map(([z, y]) => [x - w / 2, y, z]);
  g.quad(L[0], L[1], L[2], L[3], col);
  g.quad(R[3], R[2], R[1], R[0], col);
  for (let i = 0; i < 4; i++) {
    const j = (i + 1) % 4;
    g.quad(L[i], R[i], R[j], L[j], col);
  }
}

/**
 * Each body style's wheels: how far out (x), how big, how wide, and where
 * along (the fronts, then the backs).
 */
export const WHEELBASE = {
  rally: { x: 0.86, r: 0.37, w: 0.32, front: 1.3, back: -1.32 },
  coupe: { x: 0.84, r: 0.37, w: 0.3, front: 1.42, back: -1.42 },
  gt: { x: 0.9, r: 0.39, w: 0.36, front: 1.38, back: -1.45 },
  hyper: { x: 0.88, r: 0.39, w: 0.36, front: 1.45, back: -1.5 },
  lmp: { x: 0.88, r: 0.38, w: 0.36, front: 1.55, back: -1.55 },
};

/** Where each wheel's hub is on a car: left front, right front, left back, right back. @param {CarDesign} d */
export function wheelsOf(d) {
  const w = WHEELBASE[d.shape] ?? WHEELBASE.rally;
  return [
    [w.x, w.r, w.front],
    [-w.x, w.r, w.front],
    [w.x, w.r, w.back],
    [-w.x, w.r, w.back],
  ];
}

/**
 * A car in a paint, without its wheels (they turn, so are drawn apart).
 * @param {CarDesign} d
 */
export function car(d) {
  const g = new Geo();
  const body = rgb(d.body);
  const stripe = rgb(d.stripe);
  const roof = rgb(d.roof);
  const glass = rgb("#1b2633");
  const dark = rgb("#1c1e22");
  const carbon = rgb("#2a2d33");
  const lamp = rgb("#fff6cf");
  const red = rgb("#ff2d2d");
  const yellow = rgb("#ffd447");
  const white = rgb("#f6f6f2");
  const paint = { side: body, top: body, stripe, low: dark };
  /** A round-cornered number board on each door, at z. @param {number} z @param {number} x @param {number} y */
  const roundel = (z, x, y) => {
    g.box(x, y, z, 0.02, 0.36, 0.5, white);
    g.box(-x, y, z, 0.02, 0.36, 0.5, white);
  };
  /** Headlamps at the nose: two slanted bars. @param {number} z @param {number} x @param {number} y @param {number} w */
  const lamps = (z, x, y, w = 0.34) => {
    for (const s of [-1, 1]) g.box(s * x, y, z, w, 0.07, 0.12, lamp);
  };
  /** The rear lights: a bar across, or a pair. @param {number} z @param {number} y @param {number} w */
  const tail = (z, y, w) => g.box(0, y, z, w, 0.07, 0.04, red);

  switch (d.shape) {
    case "coupe": {
      const st = /** @type {Station[]} */ ([
        [-2.3, 0.8, 0.3, 0.88, 0.56, 0.76, 0.78],
        [-1.75, 0.88, 0.28, 0.95, 0.58, 0.85, 0.83],
        [-0.8, 0.86, 0.27, 0.93, 0.56, 0.82, 0.78],
        [0.5, 0.85, 0.26, 0.92, 0.54, 0.8, 0.73],
        [1.6, 0.85, 0.24, 0.92, 0.5, 0.8, 0.66],
        [2.15, 0.78, 0.22, 0.84, 0.42, 0.7, 0.54],
        [2.38, 0.6, 0.22, 0.66, 0.34, 0.5, 0.42],
      ]);
      loft(g, st, paint, 0.24);
      const m = measure(st, 0.24);
      canopy(g, [
        [0.75, 0.72, 0.7, 0.52, 0.74],
        [0.15, 0.74, 0.75, 0.56, 1.2],
        [-0.65, 0.72, 0.78, 0.55, 1.19],
        [-1.65, 0.66, 0.8, 0.3, 0.86],
        [-1.95, 0.6, 0.8, 0.1, 0.8],
      ], glass, roof, stripe, m);
      // The ducktail.
      slab(g, 0, 1.5, [[-2.3, 0.78], [-2.0, 0.8], [-2.05, 0.9], [-2.35, 0.9]], body);
      lamps(2.3, 0.5, 0.48);
      tail(-2.31, 0.66, 1.4);
      g.box(0, 0.2, 2.3, 1.4, 0.06, 0.25, carbon);
      break;
    }
    case "gt": {
      const st = /** @type {Station[]} */ ([
        [-2.35, 0.88, 0.28, 0.96, 0.58, 0.84, 0.86],
        [-1.85, 0.98, 0.25, 1.04, 0.58, 0.94, 0.9],
        [-1.05, 0.95, 0.24, 1.0, 0.56, 0.86, 0.86],
        [0.3, 0.92, 0.22, 0.97, 0.53, 0.82, 0.78],
        [1.25, 0.98, 0.2, 1.04, 0.52, 0.92, 0.72],
        [1.95, 0.9, 0.18, 0.96, 0.44, 0.82, 0.58],
        [2.42, 0.74, 0.16, 0.8, 0.32, 0.64, 0.42],
      ]);
      loft(g, st, paint, 0.26);
      const m = measure(st, 0.26);
      canopy(g, [
        [0.95, 0.72, 0.74, 0.55, 0.78],
        [0.35, 0.74, 0.79, 0.58, 1.24],
        [-0.6, 0.74, 0.84, 0.6, 1.27],
        [-1.4, 0.72, 0.87, 0.48, 1.0],
        [-1.9, 0.66, 0.89, 0.28, 0.91],
      ], glass, roof, stripe, m);
      // Splitter and dive planes; louvres on the front arches; the diffuser.
      g.box(0, 0.16, 2.35, 1.95, 0.05, 0.5, carbon);
      for (const s of [-1, 1]) {
        g.box(s * 0.92, 0.36, 2.15, 0.22, 0.03, 0.3, carbon);
        // Laid on the arch's top.
        for (let k = 0; k < 3; k++) g.box(s * 0.8, m.top(0.8, 1.15 + k * 0.17) + 0.005, 1.15 + k * 0.17, 0.32, 0.02, 0.08, dark);
      }
      slab(g, 0, 1.8, [[-2.4, 0.18], [-2.1, 0.18], [-2.1, 0.32], [-2.45, 0.42]], carbon);
      // The wing, high on swan necks.
      for (const s of [-1, 1]) slab(g, s * 0.45, 0.06, [[-1.85, m.top(0.45, -1.85) - 0.03], [-1.95, m.top(0.45, -1.95) - 0.03], [-2.12, 1.42], [-2.02, 1.42]], carbon);
      slab(g, 0, 2.0, [[-1.85, 1.4], [-2.4, 1.46], [-2.42, 1.52], [-1.88, 1.47]], stripe);
      for (const s of [-1, 1]) g.box(s * 1.0, 1.4, -2.13, 0.03, 0.3, 0.62, carbon);
      lamps(2.32, 0.55, 0.5);
      tail(-2.36, 0.72, 1.5);
      roundel(-0.3, m.side(0.62, -0.3) + 0.005, 0.62);
      break;
    }
    case "hyper": {
      const st = /** @type {Station[]} */ ([
        [-2.38, 0.86, 0.3, 0.95, 0.55, 0.82, 0.74],
        [-1.95, 0.94, 0.26, 1.02, 0.56, 0.92, 0.86],
        [-1.0, 0.94, 0.24, 1.02, 0.55, 0.9, 0.9],
        [0.15, 0.9, 0.22, 0.98, 0.5, 0.82, 0.72],
        [1.25, 0.9, 0.2, 0.97, 0.45, 0.86, 0.62],
        [1.95, 0.82, 0.18, 0.87, 0.38, 0.72, 0.48],
        [2.42, 0.62, 0.17, 0.66, 0.28, 0.5, 0.34],
      ]);
      loft(g, st, paint, 0.2);
      const m = measure(st, 0.2);
      // Cab-forward, one arc from the windscreen to the tail.
      canopy(g, [
        [1.35, 0.52, 0.6, 0.06, 0.62],
        [0.8, 0.62, 0.67, 0.45, 1.05],
        [0.0, 0.64, 0.71, 0.5, 1.16],
        [-0.8, 0.6, 0.8, 0.42, 1.1],
        [-1.6, 0.44, 0.86, 0.2, 0.92],
        [-2.05, 0.3, 0.82, 0.04, 0.84],
      ], glass, roof, stripe, m);
      // Intakes on the shoulders and the flanks.
      for (const s of [-1, 1]) {
        g.box(s * 0.78, m.top(0.78, -0.75), -0.75, 0.24, 0.05, 0.6, dark);
        // Let into the flank: as far out as the side is at the intake's middle.
        slab(g, s * (m.side(0.4, -0.2) - 0.005), 0.04, [[0.2, 0.3], [-0.6, 0.3], [-0.6, 0.5], [0.0, 0.48]], dark);
      }
      // Splitter, diffuser, and the wing across the whole tail.
      g.box(0, 0.16, 2.3, 1.6, 0.04, 0.45, carbon);
      slab(g, 0, 1.75, [[-2.4, 0.2], [-2.05, 0.2], [-2.05, 0.3], [-2.48, 0.45]], carbon);
      slab(g, 0, 2.02, [[-1.95, 1.02], [-2.42, 1.08], [-2.43, 1.13], [-1.97, 1.07]], d.wing ? stripe : body);
      // End plates standing on the flanks, down to the belt line.
      for (const s of [-1, 1]) slab(g, s * (m.side(0.56, -2.15) - 0.02), 0.05, [[-1.9, 0.5], [-2.36, 0.5], [-2.43, 1.13], [-1.95, 1.07]], body);
      lamps(2.3, 0.52, 0.42, 0.3);
      tail(-2.39, 0.66, 1.65);
      break;
    }
    case "lmp": {
      // A low tub with fenders standing proud of it: the crown runs below the shoulders.
      const st = /** @type {Station[]} */ ([
        [-2.42, 0.86, 0.28, 0.95, 0.48, 0.9, 0.76, -0.18],
        [-1.6, 0.95, 0.24, 1.0, 0.5, 0.96, 0.9, -0.3],
        [-0.85, 0.95, 0.22, 1.0, 0.48, 0.92, 0.7, -0.14],
        [0.4, 0.9, 0.2, 0.98, 0.45, 0.9, 0.64, -0.16],
        [1.45, 0.9, 0.18, 0.98, 0.45, 0.92, 0.78, -0.36],
        [2.1, 0.85, 0.16, 0.92, 0.35, 0.84, 0.55, -0.28],
        [2.5, 0.7, 0.15, 0.74, 0.24, 0.6, 0.32, -0.12],
      ]);
      loft(g, st, paint, 0.44);
      const m = measure(st, 0.44);
      canopy(g, [
        [1.1, 0.4, 0.5, 0.05, 0.56],
        [0.6, 0.46, 0.56, 0.36, 1.02],
        [-0.2, 0.48, 0.6, 0.4, 1.1],
        [-0.85, 0.44, 0.62, 0.28, 1.04],
        [-1.15, 0.36, 0.62, 0.05, 0.9],
      ], glass, roof, stripe, m);
      // Balance-beam wing on tall end plates, standing on the rear fenders' flanks.
      slab(g, 0, 2.0, [[-2.05, 1.18], [-2.48, 1.23], [-2.5, 1.28], [-2.08, 1.24]], carbon);
      for (const s of [-1, 1]) slab(g, s * (m.side(0.5, -2.2) - 0.02), 0.05, [[-1.9, 0.5], [-2.42, 0.5], [-2.5, 1.3], [-2.05, 1.27]], body);
      g.box(0, 0.15, 2.4, 1.85, 0.04, 0.4, carbon);
      slab(g, 0, 1.7, [[-2.42, 0.18], [-2.05, 0.18], [-2.05, 0.28], [-2.5, 0.42]], carbon);
      // Louvres over the front fenders.
      for (const s of [-1, 1]) for (let k = 0; k < 4; k++) g.box(s * 0.75, m.top(0.75, 1.2 + k * 0.13) + 0.005, 1.2 + k * 0.13, 0.26, 0.02, 0.06, dark);
      lamps(2.38, 0.6, 0.42, 0.26);
      tail(-2.43, 0.62, 1.6);
      roundel(0.3, m.side(0.55, 0.3) + 0.005, 0.55);
      break;
    }
    default: {
      // rally: the WRC hatch.
      const st = /** @type {Station[]} */ ([
        [-2.08, 0.86, 0.32, 0.94, 0.62, 0.84, 0.92],
        [-1.6, 0.95, 0.3, 1.0, 0.62, 0.9, 0.95],
        [-0.4, 0.9, 0.3, 0.96, 0.6, 0.86, 0.92],
        [0.9, 0.95, 0.28, 1.0, 0.6, 0.9, 0.86],
        [1.6, 0.9, 0.28, 0.95, 0.55, 0.85, 0.78],
        [2.08, 0.8, 0.28, 0.85, 0.45, 0.74, 0.62],
      ]);
      loft(g, st, paint, 0.24);
      const m = measure(st, 0.24);
      const cab = /** @type {Pane[]} */ ([
        [1.0, 0.78, 0.84, 0.62, 0.9],
        [0.45, 0.8, 0.88, 0.66, 1.42],
        [-1.25, 0.8, 0.92, 0.68, 1.48],
        [-1.78, 0.78, 0.94, 0.64, 1.36],
        [-2.04, 0.74, 0.92, 0.58, 0.98],
      ]);
      canopy(g, cab, glass, roof, stripe, m);
      // The roof scoop, sat on the roof.
      const sc = (/** @type {number} */ z) => roofAt(cab, z) - 0.01;
      slab(g, 0, 0.36, [[0.2, sc(0.2)], [-0.25, sc(-0.25)], [-0.25, sc(-0.25) + 0.13], [0.1, sc(0.1) + 0.09]], roof);
      g.box(0, sc(-0.25) + 0.08, -0.25, 0.3, 0.08, 0.02, dark);
      // The wing off the end of the roof, on plates standing along the roof's edges and down the back window.
      slab(g, 0, 1.4, [[-1.7, 1.46], [-2.2, 1.44], [-2.22, 1.5], [-1.72, 1.52]], stripe);
      for (const s of [-1, 1]) slab(g, s * 0.62, 0.04, [[-1.6, roofAt(cab, -1.6) - 0.02], [-2.0, roofAt(cab, -2.0) - 0.02], [-2.22, 1.55], [-1.72, 1.56]], body);
      // Mud flaps behind each wheel, a pod of spot lamps on the bonnet, the lights.
      for (const z of [0.82, -1.82]) for (const s of [-1, 1]) g.box(s * 0.84, 0.24, z, 0.32, 0.3, 0.02, z > 0 ? dark : white);
      // Sat on the front of the bonnet.
      for (let k = 0; k < 4; k++) g.prism("z", -0.48 + k * 0.32, m.top(-0.48 + k * 0.32, 1.98) + 0.09, 1.98, 0.1, 0.06, 8, dark, yellow);
      lamps(2.06, 0.55, 0.52, 0.3);
      tail(-2.09, 0.78, 1.5);
      roundel(-0.15, m.side(0.6, -0.15) + 0.005, 0.6);
      break;
    }
  }
  return g;
}

/** One wheel of a body style, centred on its hub, the axle along x: tyre, rim and hub. @param {CarDesign} d */
export function wheel(d) {
  const w = WHEELBASE[d.shape] ?? WHEELBASE.rally;
  const g = new Geo();
  g.prism("x", 0, 0, 0, w.r, w.w, 14, rgb("#17181b"), rgb("#17181b"));
  // The rim, set a hair proud of the tyre on each face, and its hub.
  g.prism("x", 0, 0, 0, w.r * 0.66, w.w + 0.012, 10, rgb("#8f969f"), rgb("#c3c9d1"));
  g.prism("x", 0, 0, 0, w.r * 0.2, w.w + 0.02, 6, rgb("#5a6068"), rgb("#2a2d33"));
  return g;
}

/** A boost's flame: a cone pointing back along -z from the origin, yellow at its root. */
export function flame() {
  const g = new Geo();
  const n = 7;
  const r = 0.24;
  const tip = [0, 0, -1.3];
  for (let i = 0; i < n; i++) {
    const a0 = (i / n) * Math.PI * 2;
    const a1 = ((i + 1) / n) * Math.PI * 2;
    const p0 = [Math.cos(a0) * r, Math.sin(a0) * r, 0];
    const p1 = [Math.cos(a1) * r, Math.sin(a1) * r, 0];
    g.tri(p0, p1, tip, rgb("#ff7a1a"));
    g.tri(p1, p0, [0, 0, 0.05], rgb("#ffe066"));
  }
  return g;
}
