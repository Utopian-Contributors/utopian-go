/**
 * Rally's course: one closed lap laid out below as a list of pieces
 * (straights, corners, hills, bumps, chicanes, a loop, ramps and jumps), and
 * built from it the same way on the server and the page: a centreline
 * sampled every metre, each sample with the road's frame (which way is ahead,
 * up and right), and what is on the road there. The server needs only its
 * length, its checkpoints and where its coins are (the limits at the end); the
 * page (client/rally) drives and draws all of it. The rules are rally.ts.
 */
import { CHECKPOINTS, FLAT_OUT } from "./rally";

/* --------------------------------------------------------------- the layout */

/** The road's width, kerb to kerb, in metres. */
export const WIDTH = 13;
/** Metres between samples of the centreline. */
const DS = 1;

/**
 * One piece of the course. `pitch` is the road's slope at a point along it
 * (0…1), in radians; `turn` the degrees it bends right (negative, left) over
 * its length, eased in and out; `bank` how far it leans into the bend at its
 * middle. Coins are laid in rows, `[at, u, n, gap, h]`: `n` of them from
 * `at` metres in, `u` metres right of the middle, `gap` apart, `h` over the
 * road. A crate stands at `[at, u]`, a boost to collect at `[at, u]`; a boost
 * pad covers the road from `at` for 8 metres. `gap: [from, to]` (metres in)
 * has no road at all: the jump's gap.
 */
interface Piece {
  len: number;
  turn?: number;
  bank?: number;
  pitch?: (t: number) => number;
  loop?: { shift: number };
  gap?: [number, number];
  /** The bank leans in from nothing to this at the gap's lip, and stays there over it (radians, + right edge low). */
  twist?: number;
  coins?: [number, number, number, number, number][];
  crates?: [number, number][];
  boosts?: [number, number][];
  pads?: number[];
  start?: number;
}

const deg = Math.PI / 180;

const straight = (len: number, more: Partial<Piece> = {}): Piece => ({ len, ...more });
const bend = (len: number, turn: number, bank = 0, more: Partial<Piece> = {}): Piece => ({ len, turn, bank, ...more });
/** Rolling hills: `n` crests, the slope at most `a` degrees. */
const hills = (len: number, n: number, a: number, more: Partial<Piece> = {}): Piece => ({ len, pitch: (t) => a * deg * Math.sin(2 * Math.PI * n * t), ...more });
/** A climb (a > 0) or a descent: the slope rising to `a` degrees and back. */
const climb = (len: number, a: number, more: Partial<Piece> = {}): Piece => ({ len, pitch: (t) => a * deg * Math.sin(Math.PI * t), ...more });

/**
 * A ramp, a gap and a landing: the kicker curves up to `up` degrees at its
 * lip, the gap has no road, and the landing comes down from `down` degrees
 * to level. The road through the gap follows roughly the arc a car flies.
 */
function jump(kick: number, gap: number, land: number, up: number, down: number, more: Partial<Piece> = {}): Piece {
  const len = kick + gap + land;
  return {
    len,
    gap: [kick, kick + gap],
    pitch(t) {
      const x = t * len;
      if (x < kick) return (up * deg * (1 - Math.cos((Math.PI * x) / kick))) / 2;
      if (x < kick + gap) return (up + ((x - kick) / gap) * (-down - up)) * deg;
      return (-down * deg * (1 + Math.cos((Math.PI * (x - kick - gap)) / land))) / 2;
    },
    ...more,
  };
}

/** A loop: up, over on its roof, and down again, shifted sideways by `shift` metres so it comes out beside where it went in. */
const loop = (len: number, shift: number, more: Partial<Piece> = {}): Piece => ({
  len,
  pitch: (t) => 2 * Math.PI * (t - Math.sin(2 * Math.PI * t) / (2 * Math.PI)),
  loop: { shift },
  ...more,
});

/**
 * The course, from the start line, counter-clockwise. Where it ends, a
 * smooth bend of its own (RETURN) carries it back round to the line.
 */
const COURSE: Piece[] = [
  straight(150, { start: 30, coins: [[60, 0, 5, 7, 1]], pads: [110] }),
  bend(170, -85, 9, { coins: [[40, -3.5, 6, 12, 1]] }),
  hills(300, 3, 5, { coins: [[30, 3, 3, 4, 1.4], [130, -3, 3, 4, 1.4], [230, 0, 3, 4, 1.4]] }),
  bend(110, 45, 6, { boosts: [[60, 4]] }),
  straight(60, { pads: [20] }),
  jump(40, 26, 60, 14, 12, { coins: [[48, 0, 4, 5, 3.2]] }),
  straight(50),
  // The chicane: left, right, left, a crate at each apex.
  bend(55, -40, 0, { crates: [[30, -4.2]] }),
  bend(80, 80, 0, { crates: [[42, 4.2]], coins: [[30, 0, 3, 6, 1]] }),
  bend(55, -40, 0, { crates: [[25, -4.2]] }),
  straight(40),
  hills(170, 8, 3.2, { coins: [[20, 3.5, 8, 18, 1]] }),
  bend(160, -150, 14, { coins: [[50, -4, 5, 12, 1]] }),
  straight(130, { pads: [40, 80], boosts: [[20, -3]] }),
  loop(130, 15, { coins: [[55, 0, 3, 8, 1]] }),
  straight(70, { coins: [[20, 0, 4, 8, 1]] }),
  bend(140, 70, 8),
  climb(230, 7, { coins: [[60, -3, 4, 10, 1], [160, 3, 4, 10, 1]], boosts: [[120, 0]] }),
  // Off the top: a jump that leans as it leaves, so the car rolls in the air.
  jump(34, 32, 80, 10, 15, { twist: 14 * deg, coins: [[38, 0, 5, 6, 3.6]] }),
  climb(120, -5),
  bend(200, -110, 10, { crates: [[140, 4.4]], coins: [[60, 3, 5, 12, 1]] }),
  straight(90, { pads: [50] }),
  bend(190, -95, 12, { coins: [[50, -3, 5, 12, 1]] }),
  straight(60),
];

/** The bend home, from wherever the course ends back to the line: its coins and pads, metres into it. */
const RETURN: Piece = {
  len: 0,
  coins: [[40, 0, 5, 9, 1], [320, -3.5, 6, 14, 1], [700, 3.5, 6, 14, 1], [1050, 0, 6, 10, 1]],
  boosts: [[560, 0]],
  pads: [480, 900],
};

/* ---------------------------------------------------------------- the build */

/** What the course is built into: every sample's place and frame, and what is on the road. */
export interface Track {
  /** Samples, one a metre; sample `i` is `i` metres from the start of the layout. */
  n: number;
  /** The lap's length in metres (n × DS). */
  len: number;
  ds: number;
  width: number;
  /** Positions, and the frame: T ahead, N up off the road, R to the right. */
  p: Float64Array;
  t: Float64Array;
  nrm: Float64Array;
  r: Float64Array;
  /** Per sample: 1 where there is road. */
  road: Uint8Array;
  /** Per sample: 1 on a boost pad. */
  pad: Uint8Array;
  /** Per sample: 1 in the loop. */
  inLoop: Uint8Array;
  /** Coins: `s` along the lap, `u` right of the middle, `h` over the road. */
  coins: { s: number; u: number; h: number }[];
  boosts: { s: number; u: number }[];
  crates: { s: number; u: number }[];
  /** Where the start line is, along the lap. */
  start: number;
  /** The ground's height: a little under the lowest of the road. */
  ground: number;
}

/** The yaw, pitch and bank of a piece at 0…1 along it, and its sideways shift so far (a loop's). */
function shape(piece: Piece, t: number) {
  const turn = piece.turn ?? 0;
  const yaw = turn * deg * (t - Math.sin(2 * Math.PI * t) / (2 * Math.PI));
  const pitch = piece.pitch ? piece.pitch(t) : 0;
  let bank = (Math.sign(turn) * (piece.bank ?? 0) * deg * (1 - Math.cos(2 * Math.PI * t))) / 2;
  if (piece.twist && piece.gap) {
    // The lean comes on over the kicker and holds over the gap; the landing straightens it out.
    const x = t * piece.len;
    const [a, b] = piece.gap;
    bank += x < a ? piece.twist * (x / a) : x < b ? piece.twist : piece.twist * Math.max(0, 1 - (x - b) / 20);
  }
  const shift = piece.loop ? piece.loop.shift * (t - Math.sin(2 * Math.PI * t) / (2 * Math.PI)) : 0;
  return { yaw, pitch, bank, shift };
}

/** A sample before its frame is worked out: where, which way, and whose. */
interface Raw {
  x: number;
  y: number;
  z: number;
  heading: number;
  pitch: number;
  bank: number;
  piece: number;
  at: number;
}

/** The pieces laid end to end from the origin, heading along +z. */
function layOut(): Raw[] {
  const out: Raw[] = [];
  let x = 0;
  let y = 0;
  let z = 0;
  let heading = 0;
  COURSE.forEach((piece, k) => {
    const steps = Math.max(1, Math.round(piece.len / DS));
    const step = piece.len / steps;
    let lastShift = 0;
    for (let i = 0; i < steps; i++) {
      const a = shape(piece, i / steps);
      out.push({ x, y, z, heading: heading + a.yaw, pitch: a.pitch, bank: a.bank, piece: k, at: (i / steps) * piece.len });
      // On along the middle of the step; a loop's shift moves everything after it sideways.
      const m = shape(piece, (i + 0.5) / steps);
      const h = heading + m.yaw;
      const cp = Math.cos(m.pitch);
      x += -Math.sin(h) * cp * step;
      y += Math.sin(m.pitch) * step;
      z += Math.cos(h) * cp * step;
      const shift = shape(piece, (i + 1) / steps).shift;
      x += -Math.cos(heading) * (shift - lastShift);
      z += -Math.sin(heading) * (shift - lastShift);
      lastShift = shift;
    }
    heading += (piece.turn ?? 0) * deg;
  });
  // Home: a cubic from the end, along its heading, to the line, along the start's; level at both ends.
  const end = { x, y, z };
  const ex = -Math.sin(heading);
  const ez = Math.cos(heading);
  const reach = Math.hypot(x, z) * 0.42;
  const c = [
    [x, z],
    [x + ex * reach, z + ez * reach],
    [0, -reach],
    [0, 0],
  ];
  const at = (t: number) => {
    const u = 1 - t;
    const w = [u * u * u, 3 * u * u * t, 3 * u * t * t, t * t * t];
    return [w.reduce((s, wi, i) => s + wi * c[i][0], 0), w.reduce((s, wi, i) => s + wi * c[i][1], 0)];
  };
  // Measured finely, then cut into metres.
  const fine: { t: number; d: number }[] = [{ t: 0, d: 0 }];
  let prev = at(0);
  for (let i = 1; i <= 4000; i++) {
    const q = at(i / 4000);
    fine.push({ t: i / 4000, d: fine[i - 1].d + Math.hypot(q[0] - prev[0], q[1] - prev[1]) });
    prev = q;
  }
  const total = fine[fine.length - 1].d;
  const steps = Math.round(total / DS);
  let j = 0;
  for (let i = 0; i < steps; i++) {
    const want = (i / steps) * total;
    while (fine[j + 1].d < want) j++;
    const t = fine[j].t + ((want - fine[j].d) / (fine[j + 1].d - fine[j].d || 1)) * (fine[j + 1].t - fine[j].t);
    const [px, pz] = at(t);
    const [qx, qz] = at(Math.min(1, t + 1e-4));
    const [ox, oz] = at(Math.max(0, t - 1e-4));
    const f = i / steps;
    // Height eased from the end's to nought; the slope from it.
    const ease = (v: number) => v * v * (3 - 2 * v);
    const py = end.y * (1 - ease(f));
    const slope = (-end.y * 6 * f * (1 - f)) / total;
    out.push({ x: px, y: py, z: pz, heading: Math.atan2(-(qx - ox), qz - oz), pitch: Math.atan(slope), bank: 0, piece: COURSE.length, at: f * total });
  }
  return out;
}

/** Build the course: every sample, its frame, and what is on the road there. */
export function buildTrack(): Track {
  const raw = layOut();
  const n = raw.length;
  const p = new Float64Array(n * 3);
  const t = new Float64Array(n * 3);
  const nrm = new Float64Array(n * 3);
  const r = new Float64Array(n * 3);
  const road = new Uint8Array(n);
  const pad = new Uint8Array(n);
  const inLoop = new Uint8Array(n);
  let low = Infinity;
  const pieces = [...COURSE, RETURN];
  const first: number[] = pieces.map(() => -1);
  raw.forEach((q, i) => {
    if (first[q.piece] < 0) first[q.piece] = i;
    p[i * 3] = q.x;
    p[i * 3 + 1] = q.y;
    p[i * 3 + 2] = q.z;
    // Ahead; right, level; up = right × ahead; then both leaned by the bank about ahead.
    const cp = Math.cos(q.pitch);
    const tx = -Math.sin(q.heading) * cp;
    const ty = Math.sin(q.pitch);
    const tz = Math.cos(q.heading) * cp;
    const rx0 = -Math.cos(q.heading);
    const rz0 = -Math.sin(q.heading);
    const nx0 = -rz0 * ty;
    const ny0 = rz0 * tx - rx0 * tz;
    const nz0 = rx0 * ty;
    const cb = Math.cos(q.bank);
    const sb = Math.sin(q.bank);
    t.set([tx, ty, tz], i * 3);
    // + bank tips up towards the right, so the right edge sits low.
    nrm.set([nx0 * cb + rx0 * sb, ny0 * cb, nz0 * cb + rz0 * sb], i * 3);
    r.set([rx0 * cb - nx0 * sb, -ny0 * sb, rz0 * cb - nz0 * sb], i * 3);
    const piece = pieces[q.piece];
    road[i] = piece.gap && q.at >= piece.gap[0] && q.at < piece.gap[1] ? 0 : 1;
    inLoop[i] = piece.loop ? 1 : 0;
    if (!piece.loop) low = Math.min(low, q.y);
  });
  const coins: Track["coins"] = [];
  const boosts: Track["boosts"] = [];
  const crates: Track["crates"] = [];
  let start = 0;
  pieces.forEach((piece, k) => {
    const s0 = first[k] * DS;
    for (const [from, u, count, gap, h] of piece.coins ?? []) for (let c = 0; c < count; c++) coins.push({ s: s0 + from + c * gap, u, h });
    for (const [x, u] of piece.boosts ?? []) boosts.push({ s: s0 + x, u });
    for (const [x, u] of piece.crates ?? []) crates.push({ s: s0 + x, u });
    for (const x of piece.pads ?? []) for (let d = 0; d < 8; d++) pad[(Math.round((s0 + x) / DS) + d) % n] = 1;
    if (piece.start !== undefined) start = s0 + piece.start;
  });
  return { n, len: n * DS, ds: DS, width: WIDTH, p, t, nrm, r, road, pad, inLoop, coins, boosts, crates, start, ground: low - 1.2 };
}

/* ------------------------------------------------- what a synced race may be */

/** The lap, built once for the rules below. */
let built: Track | null = null;
const course = () => (built ??= buildTrack());

/** How far along the lap from the start line `s` is, 0…len. */
export function fromStart(track: Track, s: number): number {
  return (((s - track.start) % track.len) + track.len) % track.len;
}

/** The distance from the start line to checkpoint `k` (1…CHECKPOINTS); the last is the whole lap. */
export function checkpointAt(len: number, k: number): number {
  return (len * k) / CHECKPOINTS;
}

/** Every coin on the course: the most a lap can collect. */
export const coinCount = () => course().coins.length;

/**
 * The most coins a race can have collected with `k` checkpoints passed:
 * those before the next one (every one, past the last).
 */
export function coinsBefore(k: number): number {
  const track = course();
  if (k >= CHECKPOINTS) return track.coins.length;
  const limit = checkpointAt(track.len, k + 1);
  return track.coins.filter((coin) => fromStart(track, coin.s) < limit).length;
}

/** The least time, in milliseconds, in which `k` checkpoints can be passed from a standing start. */
export function reachMs(k: number): number {
  return (checkpointAt(course().len, Math.min(k, CHECKPOINTS)) / FLAT_OUT) * 1000;
}

/** The lap's length, in metres. */
export const lapLength = () => course().len;
