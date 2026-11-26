/**
 * Rally's day and night: how each is lit (the looks), the sky over it, the
 * street lamps along the course, and the country around it: two roads
 * outside the circuit, villages of houses along them whose windows light up
 * after dark, their own lamps, and traffic going both ways.
 *
 * Night is the device's dark mode. By day the sun is warm and low, the sky
 * a gradient to a hazy horizon; by night a moon, stars, the lamps' warm
 * pools on the road, and the car's own headlights.
 */
import { Geo, norm, rgb } from "./gl.js";
import { WALL_H, at, random } from "./scene.js";

/** @typedef {import("../../src/social/rallyTrack.ts").Track} Track */
/** @typedef {import("./gl.js").Look} Look */

/** By day: a warm, low sun; the sky's blue from above, the grass's bounce from below; haze at the horizon. */
export const DAY = /** @type {Look} */ ({
  sun: [0.5, 0.6, -0.42],
  sunCol: [0.82, 0.74, 0.6],
  sky: [0.44, 0.52, 0.64],
  ground: [0.3, 0.29, 0.22],
  fog: [0.74, 0.85, 0.95],
  near: 380,
  far: 1000,
  night: false,
  lamp: [0, 0, 0],
});

/** By night: a cool, dim moon, a dark-blue sky, fog closing in, and the lamps' sodium orange. */
export const NIGHT = /** @type {Look} */ ({
  sun: [-0.35, 0.75, 0.45],
  sunCol: [0.14, 0.18, 0.3],
  sky: [0.06, 0.08, 0.15],
  ground: [0.025, 0.025, 0.04],
  fog: [0.03, 0.045, 0.09],
  near: 140,
  far: 720,
  night: true,
  lamp: [1.0, 0.7, 0.38],
});

/** The store's cars: lit as in a studio, whatever the time of day, with no fog. */
export const STUDIO = /** @type {Look} */ ({
  sun: [0.4, 0.8, 0.6],
  sunCol: [0.75, 0.72, 0.68],
  sky: [0.5, 0.52, 0.56],
  ground: [0.28, 0.26, 0.26],
  fog: [0, 0, 0],
  near: 1e4,
  far: 1e5,
  night: false,
  lamp: [0, 0, 0],
});

/* ---------- The sky ---------- */

/**
 * The sky as a dome of radius 1, drawn around the camera before anything
 * else, unlit: a gradient from the horizon (the fog's colour, so the land
 * fades into it) to the zenith, and the sun or the moon and the stars.
 * @param {Look} look @param {number[]} zenith
 */
export function sky(look, zenith) {
  const g = new Geo();
  const horizon = look.fog;
  const rings = 12;
  const segs = 28;
  /** The colour at elevation e (-1…1). @param {number} e */
  const tone = (e) => {
    const t = Math.max(0, e) ** 0.55;
    return [0, 1, 2].map((k) => horizon[k] + (zenith[k] - horizon[k]) * t);
  };
  /** @param {number} e @param {number} a */
  const pt = (e, a) => {
    const c = Math.cos(e);
    return [Math.cos(a) * c, Math.sin(e), Math.sin(a) * c];
  };
  for (let i = 0; i < rings; i++) {
    const e0 = -0.3 + (i / rings) * (Math.PI / 2 + 0.3);
    const e1 = -0.3 + ((i + 1) / rings) * (Math.PI / 2 + 0.3);
    for (let j = 0; j < segs; j++) {
      const a0 = (j / segs) * Math.PI * 2;
      const a1 = ((j + 1) / segs) * Math.PI * 2;
      const p = [pt(e0, a0), pt(e0, a1), pt(e1, a1), pt(e1, a0)];
      const c = p.map((q) => tone(q[1]));
      shade(g, p[0], p[1], p[2], c[0], c[1], c[2]);
      shade(g, p[0], p[2], p[3], c[0], c[2], c[3]);
    }
  }
  // The sun, or the moon: a disc where the light comes from; the sun's in a glow fading into the sky.
  const dir = norm(look.sun);
  if (!look.night) disc(g, dir, 0.2, [0.99, 0.95, 0.82], tone(dir[1]));
  disc(g, dir, look.night ? 0.035 : 0.05, look.night ? rgb("#e9eefc") : rgb("#fff7e2"));
  if (look.night) {
    // Stars, scattered over the upper sky, a few bright.
    const rand = random(11);
    for (let k = 0; k < 420; k++) {
      const e = Math.asin(0.08 + rand() * 0.92);
      const a = rand() * Math.PI * 2;
      const b = 0.45 + rand() * 0.55;
      const c = [b, b, b * 1.05];
      disc(g, pt(e, a), 0.0025 + rand() * 0.003, c);
    }
  }
  return g;
}

/** A triangle with a colour at each corner, facing in (unlit, so either way). @param {Geo} g */
function shade(g, a, b, c, ca, cb, cc) {
  for (const [p, col] of [[a, ca], [b, cb], [c, cc]]) g.v.push(p[0], p[1], p[2], 0, 1, 0, col[0], col[1], col[2]);
}

/**
 * A round disc on the dome at direction `d`, `r` across: its colour `col`
 * at the middle, `rim` at its edge (the same for a solid disc; the sky's, for
 * a glow that fades into it).
 * @param {Geo} g @param {number[]} d @param {number} r @param {number[]} col @param {number[]} [rim]
 */
function disc(g, d, r, col, rim = col) {
  const up = Math.abs(d[1]) < 0.9 ? [0, 1, 0] : [1, 0, 0];
  const u = norm([d[1] * up[2] - d[2] * up[1], d[2] * up[0] - d[0] * up[2], d[0] * up[1] - d[1] * up[0]]);
  const v = [d[1] * u[2] - d[2] * u[1], d[2] * u[0] - d[0] * u[2], d[0] * u[1] - d[1] * u[0]];
  const on = (/** @type {number} */ a) => [0, 1, 2].map((k) => d[k] * 0.99 + (u[k] * Math.cos(a) + v[k] * Math.sin(a)) * r);
  const mid = [d[0] * 0.99, d[1] * 0.99, d[2] * 0.99];
  const n = 14;
  for (let i = 0; i < n; i++) shade(g, mid, on((i / n) * Math.PI * 2), on(((i + 1) / n) * Math.PI * 2), col, rim, rim);
}

/* ---------- Street lamps ---------- */

/** A lamp: its post (lit as anything is), its head (shining at night), and where its light comes from. */
const POST = rgb("#3b4048");
const HEAD = rgb("#fff1c8");

/**
 * A street lamp standing at `base`, `h` tall, its arm reaching `reach`
 * along `toward` (level) to the head over the road. Adds the post to
 * `posts`, the head to `heads`, and returns where the light is.
 * @param {Geo} posts @param {Geo} heads @param {number[]} base @param {number[]} toward @param {number} h @param {number} reach
 */
function lamp(posts, heads, base, toward, h, reach) {
  const [x, y, z] = base;
  posts.box(x, y + h / 2, z, 0.22, h, 0.22, POST);
  const hx = x + toward[0] * reach;
  const hz = z + toward[2] * reach;
  // The arm, from the post's top out to the head.
  const mx = (x + hx) / 2;
  const mz = (z + hz) / 2;
  const along = Math.abs(toward[0]) > Math.abs(toward[2]);
  posts.box(mx, y + h - 0.1, mz, along ? reach : 0.12, 0.12, along ? 0.12 : reach, POST);
  posts.box(hx, y + h - 0.02, hz, 0.7, 0.16, 0.7, POST);
  heads.box(hx, y + h - 0.14, hz, 0.56, 0.08, 0.56, HEAD);
  return [hx, y + h - 0.6, hz];
}

/**
 * The course's street lamps: every 42 metres, sides taking turns, standing
 * in the barrier and leaning over the road. None on the loop, where there
 * is nowhere to stand one, nor near a jump, where there is no road under it.
 * @param {Track} tr
 */
export function streetLamps(tr) {
  const posts = new Geo();
  const heads = new Geo();
  /** @type {number[][]} */
  const lights = [];
  const hw = tr.width / 2;
  let side = 1;
  for (let i = 20; i < tr.n; i += 42) {
    let clear = true;
    for (let k = -40; k <= 40 && clear; k += 2) {
      const j = (i + k + tr.n) % tr.n;
      if (!tr.road[j] || tr.inLoop[j]) clear = false;
    }
    if (!clear) continue;
    const q = at(tr, i);
    // Only where the road is near level across: on a steep bank a post would lean.
    if (q.n[1] < 0.9) continue;
    const u = side * (hw + 0.55);
    const base = [q.p[0] + q.r[0] * u, q.p[1] + q.r[1] * u, q.p[2] + q.r[2] * u];
    const toward = norm([-q.r[0] * side, 0, -q.r[2] * side]);
    lights.push(lamp(posts, heads, base, toward, 7.2, 2.4));
    side = -side;
  }
  return { posts, heads, lights };
}

/**
 * The loop's own lights, set into its road: studs down the middle and a
 * strip along each side, glowing by night (reflectors by day), and lights
 * hung inside it, so whoever is in the loop is lit all the way round. The
 * studs run a little before and after it, leading in and out.
 * @param {Track} tr
 */
export function loopLights(tr) {
  const glow = new Geo();
  /** @type {number[][]} */
  const lights = [];
  const stud = rgb("#d9f4ff");
  const strip = rgb("#8fe3ff");
  const hw = tr.width / 2;
  // Where the loop is, with 30 m either side of it.
  let first = -1;
  let last = -1;
  for (let i = 0; i < tr.n; i++) if (tr.inLoop[i]) {
    if (first < 0) first = i;
    last = i;
  }
  if (first < 0) return { glow, lights };
  /** A point on the road: `u` across, `lift` off it. @param {ReturnType<typeof at>} q @param {number} u @param {number} lift */
  const on = (q, u, lift) => [q.p[0] + q.r[0] * u + q.n[0] * lift, q.p[1] + q.r[1] * u + q.n[1] * lift, q.p[2] + q.r[2] * u + q.n[2] * lift];
  for (let i = first - 30; i < last + 30; i++) {
    const a = at(tr, i);
    const b = at(tr, i + 1);
    const ns = [a.n, a.n, b.n, b.n];
    // The side strips: one each side, inside the kerbs, unbroken.
    for (const side of [-1, 1]) {
      const u0 = side * (hw - 1.05);
      const u1 = side * (hw - 0.85);
      glow.quad(on(a, u0, 0.035), on(a, u1, 0.035), on(b, u1, 0.035), on(b, u0, 0.035), strip, ns);
    }
    // The studs down the middle: a metre long, one every three metres.
    if (i % 3 === 0) {
      const c = b;
      glow.quad(on(a, -0.18, 0.04), on(a, 0.18, 0.04), on(c, 0.18, 0.04), on(c, -0.18, 0.04), stud, [a.n, a.n, c.n, c.n]);
    }
  }
  // Lights inside the loop, every 18 m, five metres off the road towards its
  // middle, softer than a street lamp (the fourth number): it is lit all
  // the way round without glaring.
  for (let i = first; i <= last; i += 18) {
    const q = at(tr, i);
    lights.push([...on(q, 0, 5), 0.42]);
  }
  return { glow, lights };
}

/* ---------- The country around the course ---------- */

/** A straight road in the country: from (x0, z0) to (x1, z1). @typedef {{a: number[], b: number[], len: number, dir: number[], right: number[]}} Lane */

/**
 * Two roads outside the circuit, villages along them (houses whose windows
 * light up at night, and lamps), and the traffic using them. Laid out once,
 * from a seed, round wherever the course is.
 * @param {Track} tr
 */
export function country(tr) {
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
  const y = tr.ground + 0.04;
  /** @param {number[]} a @param {number[]} b @returns {Lane} */
  const lane = (a, b) => {
    const len = Math.hypot(b[0] - a[0], b[1] - a[1]);
    const dir = [(b[0] - a[0]) / len, 0, (b[1] - a[1]) / len];
    return { a, b, len, dir, right: [-dir[2], 0, dir[0]] };
  };
  // One down the west side, one across the north, crossing at the corner.
  const roads = [lane([x0 - 150, z0 - 400], [x0 - 150, z1 + 420]), lane([x0 - 420, z1 + 170], [x1 + 400, z1 + 170])];

  const asphalt = rgb("#3e4147");
  const line = rgb("#e8e6dc");
  const ground = new Geo();
  for (const r of roads) {
    const w = 4;
    /** @param {number} t @param {number} u */
    const p = (t, u, lift = 0) => [r.a[0] + r.dir[0] * t + r.right[0] * u, y + lift, r.a[1] + r.dir[2] * t + r.right[2] * u];
    ground.quad(p(0, -w), p(0, w), p(r.len, w), p(r.len, -w), asphalt);
    for (let t = 0; t < r.len; t += 9) ground.quad(p(t, -0.1, 0.01), p(t, 0.1, 0.01), p(t + 4, 0.1, 0.01), p(t + 4, -0.1, 0.01), line);
    for (const u of [-w + 0.3, w - 0.3]) ground.quad(p(0, u - 0.07, 0.01), p(0, u + 0.07, 0.01), p(r.len, u + 0.07, 0.01), p(r.len, u - 0.07, 0.01), line);
  }

  // The villages: a stretch of each road with houses on both sides, set back, facing it.
  const houses = new Geo();
  const lit = new Geo();
  const unlit = new Geo();
  const posts = new Geo();
  const heads = new Geo();
  /** @type {number[][]} */
  const lights = [];
  /** Where the houses stand, for keeping trees off them. @type {number[][]} */
  const plots = [];
  const rand = random(23);
  const WALLS = ["#f2e6d0", "#e8d2b8", "#dfe6ea", "#f4dccd", "#e9e4c4", "#d8e0cf"].map(rgb);
  const ROOFS = ["#9c4a36", "#7d4630", "#5b5f66", "#8a3a2e"].map(rgb);
  const villages = [
    [roads[0], 0.3],
    [roads[0], 0.72],
    [roads[1], 0.25],
    [roads[1], 0.62],
  ];
  for (const [r, share] of villages) {
    const mid = r.len * /** @type {number} */ (share);
    let lampSide = 1;
    for (let t = mid - 130; t < mid + 130; t += 22 + rand() * 12) {
      for (const side of [-1, 1]) {
        if (rand() < 0.15) continue;
        const w = 7 + rand() * 4;
        const d = 7 + rand() * 3;
        const floors = rand() < 0.4 ? 2 : 1;
        const set = 9 + d / 2 + rand() * 4;
        const cx = r.a[0] + r.dir[0] * t + r.right[0] * side * set;
        const cz = r.a[1] + r.dir[2] * t + r.right[2] * side * set;
        // It faces the road: its front towards the road's middle.
        const face = [-r.right[0] * side, 0, -r.right[2] * side];
        house(houses, lit, unlit, [cx, y, cz], face, w, d, floors, WALLS[Math.floor(rand() * WALLS.length)], ROOFS[Math.floor(rand() * ROOFS.length)], rand);
        plots.push([cx, cz]);
      }
      // A lamp every other gap, sides taking turns.
      if (rand() < 0.55) {
        const u = lampSide * 5.4;
        const base = [r.a[0] + r.dir[0] * t + r.right[0] * u, y, r.a[1] + r.dir[2] * t + r.right[2] * u];
        lights.push(lamp(posts, heads, base, [-r.right[0] * lampSide, 0, -r.right[2] * lampSide], 6.2, 1.6));
        lampSide = -lampSide;
      }
    }
  }

  /** Whether a tree at (x, z) would stand on a road or in a village. @param {number} x @param {number} z */
  const taken = (x, z) => {
    for (const r of roads) {
      const dx = x - r.a[0];
      const dz = z - r.a[1];
      const t = dx * r.dir[0] + dz * r.dir[2];
      const u = dx * r.right[0] + dz * r.right[2];
      if (t > -20 && t < r.len + 20 && Math.abs(u) < 16) return true;
    }
    return plots.some(([px, pz]) => Math.hypot(px - x, pz - z) < 16);
  };

  // The traffic: cars each way on each road, spread out, at a steady country pace.
  /** @type {{road: Lane, t: number, speed: number, dir: number, kind: number}[]} */
  const traffic = [];
  for (const r of roads) {
    for (let k = 0; k < 7; k++) traffic.push({ road: r, t: rand() * r.len, speed: 11 + rand() * 7, dir: k % 2 ? 1 : -1, kind: Math.floor(rand() * 4) });
  }
  return { ground, houses, lit, unlit, posts, heads, lights, taken, traffic, y };
}

/**
 * A house at `base` (its middle on the ground), its front towards `face`:
 * walls, a pitched roof, a door, and windows on every side, some of them
 * lit in the evening (`lit`), the rest dark (`unlit`).
 * @param {Geo} g @param {Geo} lit @param {Geo} unlit @param {number[]} base @param {number[]} face
 * @param {number} w @param {number} d @param {number} floors @param {number[]} wall @param {number[]} roof @param {() => number} rand
 */
function house(g, lit, unlit, base, face, w, d, floors, wall, roof, rand) {
  const side = [face[2], 0, -face[0]];
  const h = 2.9 * floors;
  /** A point in the house's own terms: across, up, out the front. @param {number} x @param {number} y @param {number} z */
  const P = (x, y, z) => [base[0] + side[0] * x + face[0] * z, base[1] + y, base[2] + side[2] * x + face[2] * z];
  const hw = w / 2;
  const hd = d / 2;
  // Walls.
  g.quad(P(-hw, 0, hd), P(hw, 0, hd), P(hw, h, hd), P(-hw, h, hd), wall);
  g.quad(P(hw, 0, -hd), P(-hw, 0, -hd), P(-hw, h, -hd), P(hw, h, -hd), wall);
  g.quad(P(hw, 0, hd), P(hw, 0, -hd), P(hw, h, -hd), P(hw, h, hd), wall);
  g.quad(P(-hw, 0, -hd), P(-hw, 0, hd), P(-hw, h, hd), P(-hw, h, -hd), wall);
  // The roof: its ridge across the house, eaves a little out, gables in the wall's colour.
  const rh = 2.2;
  const e = 0.4;
  g.quad(P(-hw - e, h - 0.1, hd + e), P(hw + e, h - 0.1, hd + e), P(hw + e, h + rh, 0), P(-hw - e, h + rh, 0), roof);
  g.quad(P(hw + e, h - 0.1, -hd - e), P(-hw - e, h - 0.1, -hd - e), P(-hw - e, h + rh, 0), P(hw + e, h + rh, 0), roof);
  g.tri(P(hw, h, hd), P(hw, h, -hd), P(hw, h + rh, 0), wall);
  g.tri(P(-hw, h, -hd), P(-hw, h, hd), P(-hw, h + rh, 0), wall);
  // The door, in the front.
  const door = rgb("#5a3a28");
  g.quad(P(-0.5, 0, hd + 0.02), P(0.5, 0, hd + 0.02), P(0.5, 2.1, hd + 0.02), P(-0.5, 2.1, hd + 0.02), door);
  // Windows: on each wall, each floor, a little proud of it.
  const glass = rgb("#ffd27a");
  const dark = rgb("#1d2533");
  /** A window centred at (x, y) on the wall whose outward normal is n, at distance off. */
  const pane = (/** @type {number} */ cx, /** @type {number} */ cy, /** @type {"front" | "back" | "left" | "right"} */ wallOf) => {
    const g2 = rand() < 0.6 ? lit : unlit;
    const col = g2 === lit ? glass : dark;
    const ww = 0.55;
    const wh = 0.6;
    if (wallOf === "front") g2.quad(P(cx - ww, cy - wh, hd + 0.03), P(cx + ww, cy - wh, hd + 0.03), P(cx + ww, cy + wh, hd + 0.03), P(cx - ww, cy + wh, hd + 0.03), col);
    else if (wallOf === "back") g2.quad(P(cx + ww, cy - wh, -hd - 0.03), P(cx - ww, cy - wh, -hd - 0.03), P(cx - ww, cy + wh, -hd - 0.03), P(cx + ww, cy + wh, -hd - 0.03), col);
    else {
      const s = wallOf === "right" ? 1 : -1;
      g2.quad(P(s * (hw + 0.03), cy - wh, cx - ww), P(s * (hw + 0.03), cy - wh, cx + ww), P(s * (hw + 0.03), cy + wh, cx + ww), P(s * (hw + 0.03), cy + wh, cx - ww), col);
    }
  };
  for (let f = 0; f < floors; f++) {
    const cy = 1.5 + f * 2.9;
    for (let x = -hw + 1.4; x <= hw - 1.4; x += 2.3) {
      if (f === 0 && Math.abs(x) < 1.2) continue;
      pane(x, cy, "front");
      pane(x, cy, "back");
    }
    for (let z = -hd + 1.6; z <= hd - 1.6; z += 2.6) {
      pane(z, cy, "left");
      pane(z, cy, "right");
    }
  }
}

/** The traffic's paints: plain road cars, each a body style the store has, in ordinary colours. */
export const TRAFFIC = [
  { id: "t0", name: "", price: 0, shape: "coupe", body: "#c9ccd2", stripe: "#c9ccd2", roof: "#c9ccd2" },
  { id: "t1", name: "", price: 0, shape: "rally", body: "#3a5a8c", stripe: "#3a5a8c", roof: "#3a5a8c" },
  { id: "t2", name: "", price: 0, shape: "coupe", body: "#8c2a2a", stripe: "#8c2a2a", roof: "#8c2a2a" },
  { id: "t3", name: "", price: 0, shape: "rally", body: "#e8e4da", stripe: "#e8e4da", roof: "#e8e4da" },
];

/** Where a car of the traffic is at `secs`: its place and the way it points. @param {ReturnType<typeof country>["traffic"][number]} c @param {number} secs @param {number} y */
export function trafficAt(c, secs, y) {
  const r = c.road;
  const t = ((((c.t + c.dir * c.speed * secs) % r.len) + r.len) % r.len);
  // Driving on the right: its lane is to its right of the middle.
  const u = c.dir * 1.9;
  const pos = [r.a[0] + r.dir[0] * t + r.right[0] * u, y, r.a[1] + r.dir[2] * t + r.right[2] * u];
  const F = [r.dir[0] * c.dir, 0, r.dir[2] * c.dir];
  return { pos, F };
}

export { WALL_H };
