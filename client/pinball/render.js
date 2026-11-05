/**
 * The table in 3D: a cabinet seen from the player's end, as a camera in front
 * of and above it sees it.
 *
 * The playfield's artwork is painted flat, once, in table units (paintFloor),
 * then laid onto the floor in perspective row by row: every row of a flat
 * plane seen by a camera with no roll is a horizontal line on screen. Every
 * solid thing (walls, posts, slingshots, bumpers, flippers, targets, the
 * ramp, the balls) is built from projected faces, shaded by which way it
 * faces the light, and drawn far to near.
 *
 * What never moves is drawn once per size into three layers: the floor and
 * what stands on it, the ramp (balls pass under it), and the apron and glass
 * (balls drain behind them). Each frame adds what moves and what lights.
 */
import {
  BUMPERS,
  CENTER_POST,
  DOME,
  DROPS,
  FLIP_LEN,
  H,
  LANES_X,
  LANE_X,
  PLUNGER_Y,
  PLUNGE_X,
  R,
  RAMP_PATH,
  RANKS,
  SLINGS,
  SPINNER,
  STANDUPS,
  TEMPLE,
  W,
  arc,
  balls,
  flippers,
  game,
  posts,
  walls,
} from "./table.js";

/* ---------- Camera ---------- */

const CAM = [W / 2, H + 640, 1180];
const AIM = [W / 2, H * 0.47, 0];
const norm = (v) => {
  const l = Math.hypot(v[0], v[1], v[2]);
  return [v[0] / l, v[1] / l, v[2] / l];
};
const FWD = norm([AIM[0] - CAM[0], AIM[1] - CAM[1], AIM[2] - CAM[2]]);
const RIGHT = norm([-FWD[1], FWD[0], 0]);
const UP = [FWD[1] * RIGHT[2] - FWD[2] * RIGHT[1], FWD[2] * RIGHT[0] - FWD[0] * RIGHT[2], FWD[0] * RIGHT[1] - FWD[1] * RIGHT[0]];
/** Where the light comes from: above, behind the table's far end and to the left. */
const LIGHT = norm([-0.45, -0.55, 0.7]);

let F = 1;
let OX = 0;
let OY = 0;

/** Table point → screen x, y, and pixels per table unit there. */
function P(x, y, z = 0) {
  const vx = x - CAM[0];
  const vy = y - CAM[1];
  const vz = z - CAM[2];
  const zc = vx * FWD[0] + vy * FWD[1] + vz * FWD[2];
  const k = F / zc;
  return [OX + (vx * RIGHT[0] + vy * RIGHT[1] + vz * RIGHT[2]) * k, OY - (vx * UP[0] + vy * UP[1] + vz * UP[2]) * k, k];
}

/** The cabinet's extent: the floor art runs to here. */
const X0 = -16;
const X1 = W + 16;
const Y0 = -16;
const Y1 = H + 30;
const HC = 36;

/* ---------- Colour ---------- */

const rgbCache = new Map();
function rgb(hex) {
  let c = rgbCache.get(hex);
  if (!c) {
    c = [1, 3, 5].map((i) => parseInt(hex.slice(i, i + 2), 16));
    rgbCache.set(hex, c);
  }
  return c;
}
function shade(hex, k, a = 1) {
  const [r, g, b] = rgb(hex);
  const f = (v) => Math.max(0, Math.min(255, Math.round(v * k)));
  return `rgba(${f(r)},${f(g)},${f(b)},${a})`;
}

const GOLD = "#e3b04b";
const BRASS = "#c9a14a";
const CHROME = "#c6d0d4";
const WOOD = "#5a3519";
const STONE = "#6d6a58";
const JADE = "#27c28f";

/* ---------- Primitives ---------- */

/** @type {CanvasRenderingContext2D} */
let g;

function poly(pts) {
  g.beginPath();
  pts.forEach(([x, y, z], i) => {
    const [sx, sy] = P(x, y, z);
    if (i) g.lineTo(sx, sy);
    else g.moveTo(sx, sy);
  });
  g.closePath();
}

/**
 * One flat face, if it faces the camera, shaded by how squarely it faces the
 * light. Its outward side is the one away from `c`.
 */
function face(pts, color, c, alpha = 1) {
  const [a, b, d] = pts;
  const u = [b[0] - a[0], b[1] - a[1], b[2] - a[2]];
  const v = [d[0] - a[0], d[1] - a[1], d[2] - a[2]];
  let n = norm([u[1] * v[2] - u[2] * v[1], u[2] * v[0] - u[0] * v[2], u[0] * v[1] - u[1] * v[0]]);
  if (n[0] * (a[0] - c[0]) + n[1] * (a[1] - c[1]) + n[2] * (a[2] - c[2]) < 0) n = [-n[0], -n[1], -n[2]];
  if (n[0] * (CAM[0] - a[0]) + n[1] * (CAM[1] - a[1]) + n[2] * (CAM[2] - a[2]) <= 0) return;
  const lit = n[0] * LIGHT[0] + n[1] * LIGHT[1] + n[2] * LIGHT[2];
  poly(pts);
  g.fillStyle = shade(color, 0.5 + 0.6 * Math.max(-0.3, lit), alpha);
  g.fill();
}

/**
 * A solid with a flat top: the outline `pts` raised from z0 to z1. The side
 * faces take `side` (or `sideOf(i)` for edge i), the top `top`.
 */
function prism(pts, z0, z1, side, top, sideOf) {
  let cx = 0;
  let cy = 0;
  for (const [x, y] of pts) {
    cx += x / pts.length;
    cy += y / pts.length;
  }
  const c = [cx, cy, (z0 + z1) / 2];
  const n = pts.length;
  for (let i = 0; i < n; i++) {
    const [ax, ay] = pts[i];
    const [bx, by] = pts[(i + 1) % n];
    face(
      [
        [ax, ay, z0],
        [bx, by, z0],
        [bx, by, z1],
        [ax, ay, z1],
      ],
      (sideOf && sideOf(i)) || side,
      c,
    );
  }
  if (!top) return;
  poly(pts.map(([x, y]) => [x, y, z1]));
  g.fillStyle = typeof top === "function" ? top(pts, z1) : top;
  g.fill();
}

/** The ellipse a circle on the plane z makes on screen. */
function ellipse(x, y, z, r) {
  const [cx, , k] = P(x, y, z);
  const t = P(x, y - r, z)[1];
  const b = P(x, y + r, z)[1];
  g.beginPath();
  g.ellipse(cx, (t + b) / 2, Math.max(0.1, r * k), Math.max(0.1, (b - t) / 2), 0, 0, Math.PI * 2);
}

/**
 * An upright cylinder: its sides shaded round from the light, then its top.
 * @param {string[]} stops dark, lit, dark
 */
function cylinder(x, y, r, z0, z1, color, top) {
  const [lx, ly0] = P(x - r, y, z0);
  const [rx] = P(x + r, y, z0);
  const ly1 = P(x - r, y, z1)[1];
  const grad = g.createLinearGradient(lx, 0, rx, 0);
  grad.addColorStop(0, shade(color, 0.45));
  grad.addColorStop(0.3, shade(color, 1.25));
  grad.addColorStop(0.55, shade(color, 0.9));
  grad.addColorStop(1, shade(color, 0.35));
  g.fillStyle = grad;
  ellipse(x, y, z0, r);
  g.fill();
  g.fillRect(lx, ly1, rx - lx, ly0 - ly1);
  if (top === null) {
    ellipse(x, y, z1, r);
    g.fill();
    return;
  }
  ellipse(x, y, z1, r);
  g.fillStyle = top || shade(color, 1.1);
  g.fill();
}

/** A wall along a line: a slab `t` thick and `h` tall, split so each piece sorts on its own. */
function ribbon(pts, t, h, side, top, out) {
  for (let i = 1; i < pts.length; i++) {
    const [ax, ay] = pts[i - 1];
    const [bx, by] = pts[i];
    const l = Math.hypot(bx - ax, by - ay);
    const pieces = Math.max(1, Math.ceil(l / 40));
    for (let k = 0; k < pieces; k++) {
      const x0 = ax + ((bx - ax) * k) / pieces;
      const y0 = ay + ((by - ay) * k) / pieces;
      const x1 = ax + ((bx - ax) * (k + 1)) / pieces;
      const y1 = ay + ((by - ay) * (k + 1)) / pieces;
      const nx = (-(by - ay) / l) * (t / 2);
      const ny = ((bx - ax) / l) * (t / 2);
      const ex = ((bx - ax) / l) * (t / 2);
      const ey = ((by - ay) / l) * (t / 2);
      const quad = [
        [x0 + nx - ex, y0 + ny - ey],
        [x1 + nx + ex, y1 + ny + ey],
        [x1 - nx + ex, y1 - ny + ey],
        [x0 - nx - ex, y0 - ny - ey],
      ];
      out.push({ d: depth((x0 + x1) / 2, (y0 + y1) / 2), draw: () => prism(quad, 0, h, side, top) });
    }
  }
}

/** Draw order: far before near, and toward the walls before the middle. */
function depth(x, y) {
  return y - Math.abs(x - W / 2) * 0.15;
}

/* ---------- The lamps ---------- */

const blink = (rate = 4) => Math.floor(performance.now() / (1000 / rate)) % 2 === 0;

/**
 * Every insert lamp under the playfield: where, what colour, its shape, the
 * words printed on it or beside it, and when it is lit.
 * @type {{x:number, y:number, r:number, c:string, shape?:string, a?:number, text?:string, label?:string, lx?:number, ly?:number, on:() => boolean}[]}
 */
const LAMPS = [];

const AMBER = "#ffb02e";
const RED = "#ff4434";
const GREEN = "#5cff6a";
const BLUE = "#46b8ff";
const PINK = "#ff5ad2";
const ORANGE = "#ff7a1a";
const WHITE = "#fff4c8";
const VIOLET = "#b46aff";

LANES_X.forEach((x, i) =>
  LAMPS.push({
    x,
    y: 78,
    r: 9,
    c: AMBER,
    text: "GO!"[i],
    on: () => game.lanes[i] || (game.skill === i && blink(6)) || (!!game.flash.lanes && blink(8)),
  }),
);
[164, 196, 228].forEach((x, i) =>
  LAMPS.push({ x, y: i === 1 ? 124 : 128, r: 5, c: GREEN, on: () => game.power > i || (game.state !== "play" && attract(i, 3)) }),
);
// The temple ladder, bottom rung first, pointing up at the temple.
const RUNG_COLOURS = [GOLD, BLUE, GREEN, PINK];
const RUNG_TEXT = ["JACKPOT", "BALL SAVE", "EXTRA BALL", "MULTIBALL"];
for (let i = 0; i < 4; i++) {
  LAMPS.push({
    x: 190,
    y: 548 - i * 26,
    r: 11,
    c: RUNG_COLOURS[i],
    shape: "arrow",
    a: -Math.PI / 2,
    label: RUNG_TEXT[i],
    lx: 206,
    ly: 548 - i * 26,
    on: () => game.rung > i && (game.rung - 1 > i || game.rungT > 10 || blink(3)),
  });
}
["2×", "3×", "5×", "10×"].forEach((text, i) =>
  LAMPS.push({ x: 148 + i * 28, y: 590, r: 10, c: ORANGE, text, on: () => game.mult > i || (!!game.flash.mult && blink(8)) }),
);
LAMPS.push({ x: 190, y: 636, r: 10, c: RED, label: "SHOOT AGAIN", lx: 190, ly: 656, on: () => (game.save > 0 && (game.save > 3 || blink(5))) || game.post });
LAMPS.push({ x: 190, y: 612, r: 6, c: GREEN, label: "", on: () => game.extraLit && blink(3) });
for (let i = 0; i < 12; i++) {
  const a = (i / 12) * Math.PI * 2 - Math.PI / 2;
  LAMPS.push({
    x: TEMPLE.x + Math.cos(a) * 40,
    y: TEMPLE.y + Math.sin(a) * 40,
    r: 4.5,
    c: JADE_LAMP(),
    on: () => i < game.ring || (!!game.flash.ring && blink(8)) || (game.state !== "play" && attract(i, 12)),
  });
}
function JADE_LAMP() {
  return "#3cffb4";
}
RANKS.forEach((_, i) => {
  const a = Math.PI * (1.12 + (i / (RANKS.length - 1)) * 0.76);
  LAMPS.push({ x: TEMPLE.x + Math.cos(a) * 58, y: TEMPLE.y + Math.sin(a) * 58, r: 4, c: WHITE, on: () => i <= game.rank });
});
STANDUPS.forEach((t) => LAMPS.push({ x: 72, y: t.y, r: 5, c: PINK, on: () => t.lit }));
DROPS.forEach((d) => LAMPS.push({ x: 318, y: d.y, r: 5, c: ORANGE, on: () => !d.up }));
LAMPS.push({ x: 342, y: 604, r: 8, c: RED, shape: "arrow", a: -Math.PI / 2, on: () => game.kickback });
LAMPS.push({ x: 32, y: 432, r: 6, c: BLUE, on: () => game.spinnerLit });
LAMPS.push({ x: 32, y: 470, r: 10, c: BLUE, shape: "arrow", a: -Math.PI / 2, on: () => !!game.flash.orbit || (game.combo > 0 && blink(5)) });
LAMPS.push({ x: 270, y: 388, r: 11, c: GREEN, shape: "arrow", a: Math.atan2(-0.85, 0.52), on: () => !!game.flash.ramp || (game.rung < 4 && blink(1.2)) });
LAMPS.push({ x: 254, y: 414, r: 10, c: GOLD, shape: "arrow", a: Math.atan2(-0.85, 0.52), on: () => (game.multiball || game.extraLit) && blink(5) });
LAMPS.push({ x: 66, y: 614, r: 5, c: WHITE, on: () => !!game.flash.inL });
LAMPS.push({ x: 314, y: 614, r: 5, c: WHITE, on: () => !!game.flash.inR });
LAMPS.push({ x: 342, y: 660, r: 5, c: WHITE, on: () => !!game.flash.outR || !!game.flash.kick });
// Chase lights round the dome.
for (let i = 0; i < 13; i++) {
  const a = Math.PI + 0.32 + (i / 12) * (Math.PI - 0.64);
  LAMPS.push({
    x: DOME.x + Math.cos(a) * 166,
    y: DOME.y + Math.sin(a) * 166,
    r: 4,
    c: i % 2 ? AMBER : WHITE,
    on: () => {
      const speed = game.save > 0 || game.multiball ? 16 : 5;
      return Math.floor(performance.now() / (1000 / speed)) % 13 === i || (game.multiball && blink(6));
    },
  });
}

/** A lamp's turn in the attract show between games. */
function attract(i, n) {
  return Math.floor(game.attract * 6) % n === i;
}

function lampShape(l, z = 0) {
  if (l.shape === "arrow") {
    const ca = Math.cos(l.a ?? 0);
    const sa = Math.sin(l.a ?? 0);
    const r = l.r;
    const pts = [
      [r, 0],
      [-r * 0.2, -r * 0.85],
      [-r * 0.2, -r * 0.35],
      [-r, -r * 0.35],
      [-r, r * 0.35],
      [-r * 0.2, r * 0.35],
      [-r * 0.2, r * 0.85],
    ].map(([x, y]) => [l.x + x * ca - y * sa, l.y + x * sa + y * ca, z]);
    poly(pts);
  } else ellipse(l.x, l.y, z, l.r);
}

/* ---------- The floor's artwork ---------- */

const TS = 2;
let floorArt = /** @type {HTMLCanvasElement | null} */ (null);

function seeded(seed) {
  return () => ((seed = (seed * 16807) % 2147483647) / 2147483647);
}

/** A leaf: a pointed blade with a lit midrib and veins. */
function leaf(f, x, y, len, ang, w, c1, c2) {
  f.save();
  f.translate(x, y);
  f.rotate(ang);
  const grad = f.createLinearGradient(0, -w, 0, w);
  grad.addColorStop(0, c2);
  grad.addColorStop(0.5, c1);
  grad.addColorStop(1, c2);
  f.fillStyle = grad;
  f.beginPath();
  f.moveTo(0, 0);
  f.bezierCurveTo(len * 0.25, -w, len * 0.7, -w * 0.8, len, 0);
  f.bezierCurveTo(len * 0.7, w * 0.8, len * 0.25, w, 0, 0);
  f.fill();
  f.strokeStyle = "rgba(220,255,200,0.18)";
  f.lineWidth = 0.8;
  f.beginPath();
  f.moveTo(0, 0);
  f.lineTo(len * 0.95, 0);
  for (let i = 1; i < 7; i++) {
    const vx = (len * i) / 8;
    const vw = w * 0.75 * Math.sin((Math.PI * i) / 8);
    f.moveTo(vx, 0);
    f.lineTo(vx + len * 0.08, -vw);
    f.moveTo(vx, 0);
    f.lineTo(vx + len * 0.08, vw);
  }
  f.stroke();
  f.restore();
}

/** A fern frond: leaflets either side of a curving spine. */
function frond(f, x, y, len, ang, c1, c2, rnd) {
  let a = ang;
  const bend = (rnd() - 0.5) * 0.03;
  let px = x;
  let py = y;
  f.strokeStyle = c2;
  f.lineWidth = 1.2;
  for (let i = 0; i < len; i += 3) {
    const nx = px + Math.cos(a) * 3;
    const ny = py + Math.sin(a) * 3;
    f.beginPath();
    f.moveTo(px, py);
    f.lineTo(nx, ny);
    f.stroke();
    const l = (1 - i / len) * len * 0.28 + 2;
    leaf(f, nx, ny, l, a - 1.1, l * 0.22, c1, c2);
    leaf(f, nx, ny, l, a + 1.1, l * 0.22, c1, c2);
    px = nx;
    py = ny;
    a += bend;
  }
}

function text(f, s, x, y, size, color, o = {}) {
  f.save();
  f.translate(x, y);
  if (o.rot) f.rotate(o.rot);
  f.font = `${o.weight ?? 800} ${size}px ${o.italic ? "italic " : ""}system-ui, -apple-system, "Segoe UI", sans-serif`;
  f.textAlign = o.align ?? "center";
  f.textBaseline = "middle";
  if (o.shadow) {
    f.fillStyle = o.shadow;
    f.fillText(s, 1, 1.2);
  }
  f.fillStyle = color;
  f.fillText(s, 0, 0);
  f.restore();
}

function paintFloor() {
  const c = document.createElement("canvas");
  c.width = (X1 - X0) * TS;
  c.height = (Y1 - Y0) * TS;
  const f = /** @type {CanvasRenderingContext2D} */ (c.getContext("2d"));
  f.setTransform(TS, 0, 0, TS, -X0 * TS, -Y0 * TS);
  const rnd = seeded(19);

  // The ground: deep forest green under a canopy of shadow.
  const base = f.createRadialGradient(190, 420, 30, 190, 420, 560);
  base.addColorStop(0, "#1c6a4a");
  base.addColorStop(0.45, "#0f4232");
  base.addColorStop(1, "#05181a");
  f.fillStyle = base;
  f.fillRect(X0, Y0, X1 - X0, Y1 - Y0);
  for (let i = 0; i < 2600; i++) {
    f.fillStyle = rnd() < 0.5 ? "rgba(0,0,0,0.12)" : "rgba(160,255,200,0.05)";
    f.fillRect(X0 + rnd() * (X1 - X0), Y0 + rnd() * (Y1 - Y0), 1.5, 1.5);
  }

  // Canopy light from above.
  for (const [x, y, r, col] of [
    [110, 160, 170, "rgba(120,255,190,0.12)"],
    [300, 300, 160, "rgba(60,200,255,0.08)"],
    [190, 640, 180, "rgba(255,210,90,0.08)"],
    [70, 500, 120, "rgba(150,255,120,0.07)"],
  ]) {
    const n = f.createRadialGradient(x, y, 0, x, y, r);
    n.addColorStop(0, col);
    n.addColorStop(1, "rgba(0,0,0,0)");
    f.fillStyle = n;
    f.fillRect(x - r, y - r, r * 2, r * 2);
  }

  // Leaves, back to front: dark shapes in the deep, bright ones at the edges.
  for (let i = 0; i < 70; i++) {
    const edge = rnd();
    const x = edge < 0.5 ? 20 + rnd() * 70 : 280 + rnd() * 70;
    const y = 100 + rnd() * 600;
    leaf(f, x, y, 30 + rnd() * 50, (edge < 0.5 ? -0.6 : Math.PI + 0.6) + (rnd() - 0.5) * 1.6, 8 + rnd() * 10, "rgba(20,90,50,0.55)", "rgba(5,40,25,0.55)");
  }
  for (let i = 0; i < 12; i++) {
    const left = i % 2 === 0;
    frond(f, left ? 18 + rnd() * 20 : 336 + rnd() * 16, 120 + rnd() * 560, 60 + rnd() * 50, left ? -0.9 + rnd() * 0.4 : Math.PI + 0.9 - rnd() * 0.4, "rgba(40,140,70,0.7)", "rgba(10,60,30,0.8)", rnd);
  }

  // The orbit lane and the shooter lane, painted in.
  f.fillStyle = "rgba(0,0,0,0.28)";
  f.fillRect(14, 80, 36, 390);
  for (let y = 200; y < 460; y += 26) {
    f.fillStyle = "rgba(70,184,255,0.18)";
    f.beginPath();
    f.moveTo(32, y);
    f.lineTo(44, y + 10);
    f.lineTo(40, y + 12);
    f.lineTo(32, y + 5);
    f.lineTo(24, y + 12);
    f.lineTo(20, y + 10);
    f.fill();
  }
  const lane = f.createLinearGradient(LANE_X, 0, 386, 0);
  lane.addColorStop(0, "#2a170c");
  lane.addColorStop(0.5, "#5a3519");
  lane.addColorStop(1, "#2a170c");
  f.fillStyle = lane;
  f.fillRect(LANE_X, 230, 386 - LANE_X, Y1);
  f.strokeStyle = "rgba(0,0,0,0.35)";
  f.lineWidth = 1;
  for (let y = 250; y < H; y += 22) {
    f.beginPath();
    f.moveTo(LANE_X, y);
    f.lineTo(386, y);
    f.stroke();
  }
  text(f, "LAUNCH", 370, 520, 9, "rgba(255,210,120,0.55)", { rot: -Math.PI / 2, weight: 900 });

  // The top lanes' floor.
  for (const x of LANES_X) {
    f.fillStyle = "rgba(0,0,0,0.3)";
    f.fillRect(x - 20, 56, 40, 42);
  }

  // Glowing roots from the temple, like light through cracks in the ground.
  for (let i = 0; i < 18; i++) {
    let x = TEMPLE.x;
    let y = TEMPLE.y;
    const a0 = (i / 18) * Math.PI * 2;
    const pts = [[x, y]];
    for (let k = 0; k < 9; k++) {
      const a = a0 + (rnd() - 0.5) * 1.1;
      x += Math.cos(a) * (16 + rnd() * 16);
      y += Math.sin(a) * (16 + rnd() * 16);
      pts.push([x, y]);
    }
    for (const [wd, col] of [
      [6, "rgba(60,255,170,0.07)"],
      [2.5, "rgba(90,255,190,0.18)"],
      [0.8, "rgba(200,255,230,0.45)"],
    ]) {
      f.strokeStyle = col;
      f.lineWidth = wd;
      f.lineJoin = "round";
      f.beginPath();
      pts.forEach(([px, py], j) => (j ? f.lineTo(px, py) : f.moveTo(px, py)));
      f.stroke();
    }
  }

  // The temple medallion: carved stone rings, glyphs and gold.
  const tx = TEMPLE.x;
  const ty = TEMPLE.y;
  const ring = f.createRadialGradient(tx - 10, ty - 12, 10, tx, ty, 70);
  ring.addColorStop(0, "#8a866e");
  ring.addColorStop(0.7, "#57543f");
  ring.addColorStop(1, "#2c2a1e");
  f.fillStyle = ring;
  f.beginPath();
  f.arc(tx, ty, 68, 0, Math.PI * 2);
  f.fill();
  f.strokeStyle = GOLD;
  f.lineWidth = 2;
  f.stroke();
  f.lineWidth = 1;
  for (let i = 0; i < 48; i++) {
    const a = (i / 48) * Math.PI * 2;
    const r0 = i % 4 ? 62 : 58;
    f.strokeStyle = "rgba(20,18,10,0.6)";
    f.beginPath();
    f.moveTo(tx + Math.cos(a) * r0, ty + Math.sin(a) * r0);
    f.lineTo(tx + Math.cos(a) * 66, ty + Math.sin(a) * 66);
    f.stroke();
  }
  const inner = f.createRadialGradient(tx, ty, 4, tx, ty, 48);
  inner.addColorStop(0, "#5affd0");
  inner.addColorStop(0.35, "#108a68");
  inner.addColorStop(1, "#06302a");
  f.fillStyle = inner;
  f.beginPath();
  f.arc(tx, ty, 48, 0, Math.PI * 2);
  f.fill();
  f.strokeStyle = "rgba(227,176,75,0.8)";
  f.lineWidth = 1.5;
  f.stroke();
  f.beginPath();
  f.arc(tx, ty, 30, 0, Math.PI * 2);
  f.stroke();
  text(f, "TEMPLE", tx, ty + 22, 7, "rgba(255,230,160,0.8)", { weight: 900 });

  // The starburst between the flippers, and the river beyond the drain.
  f.save();
  f.translate(190, 760);
  const burst = f.createRadialGradient(0, 0, 6, 0, 0, 150);
  burst.addColorStop(0, "#fff0b0");
  burst.addColorStop(0.45, "#e3a032");
  burst.addColorStop(1, "rgba(120,60,10,0)");
  f.fillStyle = burst;
  f.beginPath();
  for (let i = 0; i <= 16; i++) {
    const a = Math.PI + (i / 16) * Math.PI;
    const r = i % 2 ? 60 : 150;
    f.lineTo(Math.cos(a) * r, Math.sin(a) * r);
  }
  f.fill();
  f.restore();
  const river = f.createLinearGradient(0, 720, 0, Y1);
  river.addColorStop(0, "rgba(20,120,130,0)");
  river.addColorStop(0.3, "#0e6670");
  river.addColorStop(1, "#063038");
  f.fillStyle = river;
  f.fillRect(14, 720, LANE_X - 14, Y1 - 720);

  // The ramp's shadow on the floor.
  f.strokeStyle = "rgba(0,0,0,0.35)";
  f.lineWidth = 34;
  f.lineCap = "round";
  f.lineJoin = "round";
  f.beginPath();
  RAMP_PATH.forEach(([x, y, z], i) => (i ? f.lineTo(x + z * 0.35, y + z * 0.45) : f.moveTo(x, y)));
  f.stroke();

  // Shadows the walls cast.
  f.strokeStyle = "rgba(0,0,0,0.3)";
  for (const w of walls) {
    f.lineWidth = w.kind === "cab" ? 22 : 9;
    f.beginPath();
    w.pts.forEach(([x, y], i) => (i ? f.lineTo(x + 6, y + 8) : f.moveTo(x + 6, y + 8)));
    f.stroke();
  }
  for (const s of SLINGS) {
    f.fillStyle = "rgba(0,0,0,0.3)";
    f.beginPath();
    s.forEach(([x, y]) => f.lineTo(x + 7, y + 9));
    f.fill();
  }

  // Drop target slots.
  for (const d of DROPS) {
    f.fillStyle = "#0a0a08";
    f.fillRect(d.x - 4, d.y - 11, 8, 22);
  }

  // The lamps' lenses, dark, in their bezels, and the words beside them.
  for (const l of LAMPS) {
    f.save();
    const path = () => {
      f.beginPath();
      if (l.shape === "arrow") {
        const ca = Math.cos(l.a ?? 0);
        const sa = Math.sin(l.a ?? 0);
        const r = l.r;
        [
          [r, 0],
          [-r * 0.2, -r * 0.85],
          [-r * 0.2, -r * 0.35],
          [-r, -r * 0.35],
          [-r, r * 0.35],
          [-r * 0.2, r * 0.35],
          [-r * 0.2, r * 0.85],
        ].forEach(([x, y], i) => (i ? f.lineTo : f.moveTo).call(f, l.x + x * ca - y * sa, l.y + x * sa + y * ca));
        f.closePath();
      } else f.arc(l.x, l.y, l.r, 0, Math.PI * 2);
    };
    path();
    f.lineWidth = 2.2;
    f.strokeStyle = "rgba(10,10,6,0.9)";
    f.stroke();
    const lens = f.createRadialGradient(l.x - l.r * 0.3, l.y - l.r * 0.3, 0, l.x, l.y, l.r * 1.1);
    lens.addColorStop(0, shade(l.c, 0.55));
    lens.addColorStop(1, shade(l.c, 0.18));
    f.fillStyle = lens;
    f.fill();
    f.lineWidth = 0.8;
    f.strokeStyle = "rgba(255,240,200,0.35)";
    f.stroke();
    if (l.text) text(f, l.text, l.x, l.y + 0.5, l.r * 0.9, "rgba(0,0,0,0.65)", { weight: 900 });
    if (l.label) text(f, l.label, l.lx ?? l.x, l.ly ?? l.y + l.r + 7, 6.5, "rgba(255,236,190,0.75)", { align: l.lx && l.lx !== l.x ? "left" : "center", weight: 900 });
    f.restore();
  }
  text(f, "POWER", 196, 140, 6, "rgba(160,255,170,0.6)", { weight: 900 });
  text(f, "KICK", 342, 622, 6, "rgba(255,190,170,0.8)", { weight: 900 });
  text(f, "ORBIT", 32, 490, 6.5, "rgba(160,220,255,0.75)", { weight: 900 });
  text(f, "SPIN", 32, 444, 6, "rgba(160,220,255,0.75)", { weight: 900 });
  text(f, "EXTRA", 206, 612, 6, "rgba(180,255,180,0.75)", { weight: 900, align: "left" });
  text(f, "RAMP", 238, 380, 7, "rgba(180,255,180,0.8)", { weight: 900, rot: Math.atan2(-0.85, 0.52) + Math.PI / 2 });
  text(f, "RANK", TEMPLE.x, TEMPLE.y - 70, 6.5, "rgba(255,240,200,0.7)", { weight: 900 });

  // The maker's marks along the bottom.
  text(f, "UTOPIAN", 24, 712, 10, "#ff5a3a", { align: "left", italic: true, weight: 900, shadow: "rgba(0,0,0,0.6)" });
  text(f, "GO", 346, 712, 10, "#ff5a3a", { align: "right", italic: true, weight: 900, shadow: "rgba(0,0,0,0.6)" });
  text(f, "GO", 190, 690, 34, "rgba(255,230,150,0.16)", { italic: true, weight: 900 });

  return c;
}

/* ---------- Layers drawn once per size ---------- */

let still = document.createElement("canvas");
let rampLayer = document.createElement("canvas");
let front = document.createElement("canvas");

function layer(w, h) {
  const c = document.createElement("canvas");
  c.width = w;
  c.height = h;
  return c;
}

/** The floor laid into perspective, a screen row at a time. */
function warpFloor() {
  floorArt ??= paintFloor();
  const top = P(W / 2, Y0)[1];
  const bottom = P(W / 2, Y1)[1];
  /** The table y that falls on screen row sy. */
  const yAt = (sy) => {
    let lo = Y0;
    let hi = Y1;
    for (let i = 0; i < 26; i++) {
      const mid = (lo + hi) / 2;
      if (P(W / 2, mid)[1] < sy) lo = mid;
      else hi = mid;
    }
    return (lo + hi) / 2;
  };
  for (let sy = Math.floor(top); sy < Math.ceil(bottom); sy++) {
    const y = yAt(sy + 0.5);
    const y2 = yAt(sy + 1.5);
    const [xl] = P(X0, y);
    const [xr] = P(X1, y);
    g.drawImage(floorArt, 0, (y - Y0) * TS, floorArt.width, Math.max(1, (y2 - y) * TS), xl, sy, xr - xl, 1.2);
  }
}

/** The cabinet top: the rails' and the dome corners' upper faces. */
function cabTop(pts) {
  poly(pts.map(([x, y]) => [x, y, HC]));
  const [, y0] = P(0, Y0, HC);
  const [, y1] = P(0, Y1, HC);
  const grad = g.createLinearGradient(0, y0, 0, y1);
  grad.addColorStop(0, "#2b1a0e");
  grad.addColorStop(0.5, "#4a2c16");
  grad.addColorStop(1, "#24150b");
  g.fillStyle = grad;
  g.fill();
}

function paintStill() {
  warpFloor();
  /** @type {{d:number, draw:() => void}[]} */
  const items = [];

  for (const wl of walls) {
    // Nothing stands past the cabinet's front edge.
    const w = { kind: wl.kind, pts: wl.pts.map(([x, y]) => [x, Math.min(y, Y1)]) };
    if (w.kind === "cab") {
      // The inner faces of the cabinet, carved wood, a gold trim along the top.
      for (let i = 1; i < w.pts.length; i++) {
        const [ax, ay] = w.pts[i - 1];
        const [bx, by] = w.pts[i];
        const mx = (ax + bx) / 2;
        const my = (ay + by) / 2;
        items.push({
          d: depth(mx, my) - 400,
          draw: () => {
            face(
              [
                [ax, ay, 0],
                [bx, by, 0],
                [bx, by, HC],
                [ax, ay, HC],
              ],
              "#6b3f1c",
              [W / 2, Math.min(my + 200, 400), HC / 2],
            );
          },
        });
      }
    } else if (w.kind === "lane") ribbon(w.pts, 7, 28, "#7a4a22", BRASS, items);
    else if (w.kind === "wall") ribbon(w.pts, 7, 26, STONE, "#8f8a70", items);
    else if (w.kind === "lip") ribbon(w.pts, 5, 18, "#3a8a5a", "#9fe6b8", items);
    else ribbon(w.pts, 3.5, 16, CHROME, "#eef4f6", items);
  }
  for (const p of posts) {
    if (p.on) continue;
    items.push({
      d: depth(p.x, p.y),
      draw: () => {
        cylinder(p.x, p.y, p.r, 0, 22, BRASS, "#f5dc94");
        cylinder(p.x, p.y, p.r + 1.6, 8, 13, "#1d1d1d", "#333");
      },
    });
  }
  SLINGS.forEach((s) => {
    items.push({
      d: depth(s[0][0], 580),
      draw: () => {
        prism(s, 0, 20, "#3d3a30", (pts, z) => {
          const [a, , c] = pts.map(([x, y]) => P(x, y, z));
          const grad = g.createLinearGradient(a[0], a[1], c[0], c[1]);
          grad.addColorStop(0, "#5cf0b0");
          grad.addColorStop(0.5, "#1f9c6c");
          grad.addColorStop(1, "#0d5a3e");
          return grad;
        }, (i) => (i === 2 ? "#f2f6ee" : null));
        // A gold rim, and a leaf printed on the plastic.
        poly(s.map(([x, y]) => [x, y, 20]));
        g.strokeStyle = GOLD;
        g.lineWidth = Math.max(1, F * 0.0018);
        g.stroke();
      },
    });
  });
  // Spinner brackets.
  for (const x of [14, 50]) items.push({ d: depth(x, SPINNER.y), draw: () => cylinder(x === 14 ? 17 : 47, SPINNER.y, 2.5, 0, 24, CHROME) });
  // The temple's stone rim.
  items.push({
    d: depth(TEMPLE.x, TEMPLE.y),
    draw: () => {
      cylinder(TEMPLE.x, TEMPLE.y, 16, 0, 5, STONE, "#8f8a70");
      ellipse(TEMPLE.x, TEMPLE.y, 5, 11);
      const [cx, cy, k] = P(TEMPLE.x, TEMPLE.y, 5);
      const hole = g.createRadialGradient(cx, cy - 3 * k, 0, cx, cy, 12 * k);
      hole.addColorStop(0, "#000");
      hole.addColorStop(0.8, "#0a0a06");
      hole.addColorStop(1, "#3a3628");
      g.fillStyle = hole;
      g.fill();
    },
  });
  items.sort((a, b) => a.d - b.d).forEach((i) => i.draw());

  // The cabinet's top surfaces and its trim.
  cabTop([
    [X0, Y0],
    [X1, Y0],
    [X1, DOME.y],
    [386, DOME.y],
    ...arc(DOME.x, DOME.y, DOME.r, Math.PI * 2, Math.PI, 44),
    [14, DOME.y],
    [X0, DOME.y],
  ]);
  cabTop([
    [X0, DOME.y],
    [14, DOME.y],
    [14, Y1],
    [X0, Y1],
  ]);
  cabTop([
    [386, DOME.y],
    [X1, DOME.y],
    [X1, Y1],
    [386, Y1],
  ]);
  const cab = walls.find((w) => w.kind === "cab");
  if (cab) {
    poly(cab.pts.map(([x, y]) => [x, y, HC]));
    g.strokeStyle = GOLD;
    g.lineWidth = Math.max(1.5, F * 0.0022);
    g.beginPath();
    cab.pts.forEach(([x, y], i) => {
      const [sx, sy] = P(x, Math.min(y, Y1), HC);
      if (i) g.lineTo(sx, sy);
      else g.moveTo(sx, sy);
    });
    g.stroke();
  }
  decor();
}

/** On the cabinet's top: a treehouse over the lane, a ruin in the far corner. */
function decor() {
  // Ruined pillars, top left.
  cylinder(30, 30, 10, HC, HC + 34, STONE, "#9a957a");
  cylinder(30, 30, 12, HC + 34, HC + 39, STONE, "#a8a386");
  cylinder(62, 8, 9, HC, HC + 22, STONE, "#9a957a");
  prism(
    [
      [40, 52],
      [70, 44],
      [74, 56],
      [44, 64],
    ],
    HC,
    HC + 8,
    STONE,
    "#8f8a70",
  );
  // The treehouse, top right.
  const hx = [344, 384];
  const hy = [6, 40];
  prism(
    [
      [hx[0] - 6, hy[0] - 4],
      [hx[1] + 6, hy[0] - 4],
      [hx[1] + 6, hy[1] + 6],
      [hx[0] - 6, hy[1] + 6],
    ],
    HC,
    HC + 4,
    WOOD,
    "#8a5a2b",
  );
  prism(
    [
      [hx[0], hy[0]],
      [hx[1], hy[0]],
      [hx[1], hy[1]],
      [hx[0], hy[1]],
    ],
    HC + 4,
    HC + 30,
    "#7a4a22",
    null,
  );
  // A lit window on the front.
  poly([
    [352, hy[1] + 0.1, HC + 12],
    [362, hy[1] + 0.1, HC + 12],
    [362, hy[1] + 0.1, HC + 22],
    [352, hy[1] + 0.1, HC + 22],
  ]);
  g.fillStyle = "#ffcf5a";
  g.fill();
  poly([
    [368, hy[1] + 0.1, HC + 4],
    [377, hy[1] + 0.1, HC + 4],
    [377, hy[1] + 0.1, HC + 22],
    [368, hy[1] + 0.1, HC + 22],
  ]);
  g.fillStyle = "#2a170c";
  g.fill();
  // The thatched roof.
  const apex = [(hx[0] + hx[1]) / 2, (hy[0] + hy[1]) / 2, HC + 52];
  const eaves = [
    [hx[0] - 6, hy[0] - 6, HC + 30],
    [hx[1] + 6, hy[0] - 6, HC + 30],
    [hx[1] + 6, hy[1] + 6, HC + 30],
    [hx[0] - 6, hy[1] + 6, HC + 30],
  ];
  const c = [apex[0], apex[1], HC + 36];
  for (let i = 0; i < 4; i++) face([eaves[i], eaves[(i + 1) % 4], apex], "#c79a45", c);
}

/** The ramp: clear green plastic between two chrome wire rails, on legs. */
function paintRamp() {
  const half = 15;
  const edges = RAMP_PATH.map(([x, y, z], i) => {
    const [px, py] = RAMP_PATH[Math.max(0, i - 1)];
    const [nx, ny] = RAMP_PATH[Math.min(RAMP_PATH.length - 1, i + 1)];
    const dx = nx - px;
    const dy = ny - py;
    const l = Math.hypot(dx, dy) || 1;
    return { x, y, z, ox: (-dy / l) * half, oy: (dx / l) * half };
  });
  // Legs where it stands high enough to need them.
  for (let i = 2; i < edges.length - 1; i += 2) {
    const e = edges[i];
    if (e.z < 10) continue;
    for (const s of [-1, 1]) {
      const [x0, y0] = P(e.x + e.ox * s, e.y + e.oy * s, 0);
      const [x1, y1] = P(e.x + e.ox * s, e.y + e.oy * s, e.z);
      g.strokeStyle = "rgba(190,200,205,0.85)";
      g.lineWidth = Math.max(1.5, F * 0.0025);
      g.beginPath();
      g.moveTo(x0, y0);
      g.lineTo(x1, y1);
      g.stroke();
    }
  }
  for (let i = 1; i < edges.length; i++) {
    const a = edges[i - 1];
    const b = edges[i];
    poly([
      [a.x + a.ox, a.y + a.oy, a.z],
      [b.x + b.ox, b.y + b.oy, b.z],
      [b.x - b.ox, b.y - b.oy, b.z],
      [a.x - a.ox, a.y - a.oy, a.z],
    ]);
    g.fillStyle = `rgba(70,${200 + (i % 2) * 20},140,0.38)`;
    g.fill();
  }
  // The rails, a little above the plastic, each a tube: dark, then lit along its top.
  for (const s of [-1, 1]) {
    for (const [wd, col] of [
      [3.2, "rgba(40,50,55,0.95)"],
      [2, CHROME],
      [0.8, "rgba(255,255,255,0.9)"],
    ]) {
      g.strokeStyle = col;
      g.lineWidth = Math.max(0.8, wd * F * 0.0012);
      g.lineJoin = "round";
      g.beginPath();
      edges.forEach((e, i) => {
        const [sx, sy] = P(e.x + e.ox * s, e.y + e.oy * s, e.z + 9);
        if (i) g.lineTo(sx, sy);
        else g.moveTo(sx, sy);
      });
      g.stroke();
    }
  }
  // Its sides: clear plastic walls up to the rails.
  for (let i = 1; i < edges.length; i++) {
    const a = edges[i - 1];
    const b = edges[i];
    for (const s of [-1, 1]) {
      poly([
        [a.x + a.ox * s, a.y + a.oy * s, a.z],
        [b.x + b.ox * s, b.y + b.oy * s, b.z],
        [b.x + b.ox * s, b.y + b.oy * s, b.z + 9],
        [a.x + a.ox * s, a.y + a.oy * s, a.z + 9],
      ]);
      g.fillStyle = "rgba(150,255,200,0.12)";
      g.fill();
    }
  }
  // A sign over the top: VINE RAMP.
  const [sx, sy, k] = P(196, 88, 62);
  g.save();
  g.translate(sx, sy);
  g.font = `italic 900 ${Math.max(8, 15 * k)}px system-ui, sans-serif`;
  g.textAlign = "center";
  g.lineWidth = 3 * k;
  g.strokeStyle = "#0a2a14";
  g.strokeText("VINE RAMP", 0, 0);
  g.fillStyle = "#9dff6e";
  g.fillText("VINE RAMP", 0, 0);
  g.restore();
}

/** The apron below the flippers, the cabinet's front, and the glass over it all. */
function paintFront(w, h) {
  prism(
    [
      [14, H - 10],
      [LANE_X, H - 10],
      [LANE_X, Y1],
      [14, Y1],
    ],
    0,
    22,
    "#4a2c16",
    (pts, z) => {
      const [a] = pts.map(([x, y]) => P(x, y, z));
      const grad = g.createLinearGradient(0, a[1], 0, P(0, Y1, z)[1]);
      grad.addColorStop(0, "#6b3f1c");
      grad.addColorStop(1, "#2b1a0e");
      return grad;
    },
  );
  poly([
    [14, H - 10, 22],
    [LANE_X, H - 10, 22],
  ]);
  g.strokeStyle = GOLD;
  g.lineWidth = Math.max(1.5, F * 0.0022);
  g.stroke();
  const [px, py, k] = P(184, H + 10, 22);
  g.save();
  g.translate(px, py);
  g.scale(1, 0.55);
  g.font = `italic 900 ${Math.max(9, 20 * k)}px system-ui, sans-serif`;
  g.textAlign = "center";
  g.textBaseline = "middle";
  g.fillStyle = "#e3b04b";
  g.fillText("GO PINBALL", 0, 0);
  g.restore();
  // The front of the cabinet.
  face(
    [
      [X0, Y1, 0],
      [X1, Y1, 0],
      [X1, Y1, HC],
      [X0, Y1, HC],
    ],
    "#2b1a0e",
    [W / 2, Y1 - 10, HC / 2],
  );
  // Glass: a long soft reflection across the top of it.
  const [ax, ay] = P(X0, Y0, HC);
  const [bx, by] = P(X1, Y1, 0);
  const glare = g.createLinearGradient(ax, ay, bx, by);
  glare.addColorStop(0, "rgba(255,255,255,0.08)");
  glare.addColorStop(0.35, "rgba(255,255,255,0)");
  glare.addColorStop(0.42, "rgba(255,255,255,0.05)");
  glare.addColorStop(0.5, "rgba(255,255,255,0)");
  g.fillStyle = glare;
  poly([
    [X0, Y0, HC],
    [X1, Y0, HC],
    [X1, Y1, HC],
    [X0, Y1, HC],
  ]);
  g.fill();
}

/* ---------- Each frame ---------- */

function drawLamps() {
  g.save();
  g.globalCompositeOperation = "lighter";
  for (const l of LAMPS) {
    if (!l.on()) continue;
    const [cx, cy, k] = P(l.x, l.y, 0.2);
    lampShape(l, 0.2);
    const core = g.createRadialGradient(cx, cy, 0, cx, cy, l.r * k * 1.2);
    core.addColorStop(0, "#ffffff");
    core.addColorStop(0.35, l.c);
    core.addColorStop(1, shade(l.c, 0.8));
    g.fillStyle = core;
    g.fill();
    const glow = g.createRadialGradient(cx, cy, 0, cx, cy, l.r * k * 3);
    glow.addColorStop(0, shade(l.c, 1, 0.45));
    glow.addColorStop(1, shade(l.c, 1, 0));
    g.fillStyle = glow;
    g.fillRect(cx - l.r * k * 3, cy - l.r * k * 3, l.r * k * 6, l.r * k * 6);
  }
  if (game.quest) {
    const [cx, cy, k] = P(TEMPLE.x, TEMPLE.y, 0);
    const pulse = 0.25 + 0.15 * Math.sin(performance.now() / 200);
    const glow = g.createRadialGradient(cx, cy, 0, cx, cy, 50 * k);
    glow.addColorStop(0, `rgba(90,255,200,${pulse})`);
    glow.addColorStop(1, "rgba(90,255,200,0)");
    g.fillStyle = glow;
    g.fillRect(cx - 50 * k, cy - 50 * k, 100 * k, 100 * k);
  }
  g.restore();
}

/** A pop bumper: a mushroom, brass skirt, white stem, a domed cap that flares when struck. */
function bumper(b) {
  const lit = b.flash > 0;
  const powered = game.power;
  cylinder(b.x, b.y, b.r + 4, 0, 4, BRASS, "#f2d78a");
  cylinder(b.x, b.y, b.r - 4, 4, 16, "#e8e2cc", null);
  const capCol = lit ? "#fff27a" : ["#d8352a", "#e8641e", "#e0a21e", "#c22fd8"][powered];
  cylinder(b.x, b.y, b.r + 1, 16, 21, capCol, null);
  ellipse(b.x, b.y, 21, b.r + 1);
  const [cx, cy, k] = P(b.x, b.y, 21);
  const dome = g.createRadialGradient(cx - b.r * k * 0.35, cy - b.r * k * 0.25, 0, cx, cy, b.r * k * 1.1);
  dome.addColorStop(0, "#ffffff");
  dome.addColorStop(0.25, shade(capCol, 1.3));
  dome.addColorStop(1, shade(capCol, 0.55));
  g.fillStyle = dome;
  g.fill();
  // White spots on the cap.
  g.fillStyle = "rgba(255,250,235,0.9)";
  for (const [dx, dy, r] of [
    [-7, -5, 3],
    [6, -7, 2.5],
    [-2, 6, 3],
    [8, 4, 2],
    [-9, 3, 2],
  ]) {
    ellipse(b.x + dx, b.y + dy, 21.5, r);
    g.fill();
  }
  if (lit) {
    g.save();
    g.globalCompositeOperation = "lighter";
    const glow = g.createRadialGradient(cx, cy, 0, cx, cy, b.r * k * 3);
    glow.addColorStop(0, "rgba(255,240,150,0.6)");
    glow.addColorStop(1, "rgba(255,240,150,0)");
    g.fillStyle = glow;
    g.fillRect(cx - b.r * k * 3, cy - b.r * k * 3, b.r * k * 6, b.r * k * 6);
    g.restore();
  }
}

function dropTarget(d) {
  if (d.h < 0.03) return;
  const z = 24 * d.h;
  prism(
    [
      [d.x - 3, d.y - 10],
      [d.x + 3, d.y - 10],
      [d.x + 3, d.y + 10],
      [d.x - 3, d.y + 10],
    ],
    0,
    z,
    "#ff7a1a",
    "#ffb15a",
    (i) => (i === 3 ? "#ff8a2a" : null),
  );
  // A white star on its face.
  const [sx, sy, k] = P(d.x - 3.2, d.y, z * 0.55);
  g.fillStyle = "#fff6e0";
  g.beginPath();
  for (let i = 0; i < 10; i++) {
    const a = -Math.PI / 2 + (i * Math.PI) / 5;
    const r = (i % 2 ? 2.2 : 5) * k;
    g.lineTo(sx + Math.cos(a) * r * 0.45, sy + Math.sin(a) * r);
  }
  g.fill();
}

function standup(t) {
  const lit = t.flash > 0 || t.lit;
  prism(
    [
      [t.x - 2, t.y - 10],
      [t.x + 4, t.y - 10],
      [t.x + 4, t.y + 10],
      [t.x - 2, t.y + 10],
    ],
    0,
    20,
    lit ? "#ff7ae0" : "#c0309a",
    lit ? "#ffc4f0" : "#e060c0",
  );
}

function spinnerFlag() {
  const s = SPINNER;
  const a = s.a;
  const zc = 15;
  const hgt = 11;
  const pts = [
    [18, s.y + Math.sin(a) * hgt, zc - Math.cos(a) * hgt],
    [46, s.y + Math.sin(a) * hgt, zc - Math.cos(a) * hgt],
    [46, s.y, zc],
    [18, s.y, zc],
  ];
  poly(pts);
  const facing = Math.cos(a) > 0;
  g.fillStyle = facing ? "#d8e2e6" : "#7a8a90";
  g.fill();
  g.strokeStyle = "#2a3236";
  g.lineWidth = 1;
  g.stroke();
  if (facing && Math.abs(Math.sin(a)) < 0.7) {
    const [cx, cy, k] = P(32, s.y + Math.sin(a) * hgt * 0.5, zc - Math.cos(a) * hgt * 0.5);
    g.fillStyle = "#1f7a35";
    g.font = `900 ${Math.max(6, 8 * k)}px system-ui, sans-serif`;
    g.textAlign = "center";
    g.textBaseline = "middle";
    g.fillText("GO", cx, cy);
  }
  // The axle.
  const [ax, ay] = P(17, s.y, zc);
  const [bx, by] = P(47, s.y, zc);
  g.strokeStyle = CHROME;
  g.lineWidth = Math.max(1, F * 0.002);
  g.beginPath();
  g.moveTo(ax, ay);
  g.lineTo(bx, by);
  g.stroke();
}

/** A flipper: ivory plastic on a green rubber edge, a chrome bolt at the pivot. */
function flipper(f) {
  const n = 18;
  const r0 = 10;
  const r1 = 6;
  const ca = Math.cos(f.a);
  const sa = Math.sin(f.a);
  const k = Math.asin((r0 - r1) / FLIP_LEN);
  /** @type {[number, number][]} */
  const outline = [];
  for (let i = 0; i <= n; i++) {
    const t = Math.PI / 2 + k + (i / n) * (Math.PI - 2 * k);
    outline.push([Math.cos(t) * r0, Math.sin(t) * r0]);
  }
  for (let i = 0; i <= n; i++) {
    const t = -Math.PI / 2 - k + (i / n) * (Math.PI + 2 * k);
    outline.push([FLIP_LEN + Math.cos(t) * r1, Math.sin(t) * r1]);
  }
  const pts = outline.map(([x, y]) => [f.x + x * ca - y * sa, f.y + x * sa + y * ca]);
  // Shadow.
  g.fillStyle = "rgba(0,0,0,0.35)";
  poly(pts.map(([x, y]) => [x + 5, y + 7, 0]));
  g.fill();
  // Sides: the rubber, as a hull of the bottom and top outlines.
  const bottom = pts.map(([x, y]) => P(x, y, 0));
  const topPts = pts.map(([x, y]) => P(x, y, 13));
  g.fillStyle = "#1c8a2e";
  g.beginPath();
  for (let i = 0; i < pts.length; i++) {
    const j = (i + 1) % pts.length;
    g.moveTo(bottom[i][0], bottom[i][1]);
    g.lineTo(bottom[j][0], bottom[j][1]);
    g.lineTo(topPts[j][0], topPts[j][1]);
    g.lineTo(topPts[i][0], topPts[i][1]);
    g.closePath();
  }
  g.fill();
  g.strokeStyle = "rgba(0,40,10,0.5)";
  g.lineWidth = 0.6;
  g.stroke();
  // The top.
  g.beginPath();
  topPts.forEach(([x, y], i) => (i ? g.lineTo(x, y) : g.moveTo(x, y)));
  g.closePath();
  const [ax, ay] = P(f.x, f.y, 13);
  const [bx, by] = P(f.x + ca * FLIP_LEN, f.y + sa * FLIP_LEN, 13);
  const top = g.createLinearGradient(ax, ay - 8, bx, by + 8);
  top.addColorStop(0, "#ffffff");
  top.addColorStop(0.5, "#f1ead2");
  top.addColorStop(1, "#c9c0a0");
  g.fillStyle = top;
  g.fill();
  // A green stripe down its length.
  const [sx0, sy0] = P(f.x + ca * 12, f.y + sa * 12, 13.1);
  const [sx1, sy1] = P(f.x + ca * (FLIP_LEN - 6), f.y + sa * (FLIP_LEN - 6), 13.1);
  g.strokeStyle = "#3cc316";
  g.lineWidth = Math.max(1.5, F * 0.004);
  g.lineCap = "round";
  g.beginPath();
  g.moveTo(sx0, sy0);
  g.lineTo(sx1, sy1);
  g.stroke();
  cylinder(f.x, f.y, 3.5, 13, 15, CHROME, "#ffffff");
}

function plunger() {
  const face = PLUNGER_Y + game.pull * 28;
  // The spring.
  g.strokeStyle = "#b8c2c6";
  g.lineWidth = Math.max(1, F * 0.0025);
  g.beginPath();
  const coils = 9;
  for (let i = 0; i <= coils * 2; i++) {
    const y = face + 8 + ((Y1 - 4 - face - 8) * i) / (coils * 2);
    const [sx, sy] = P(PLUNGE_X + (i % 2 ? 7 : -7), y, 7);
    if (i) g.lineTo(sx, sy);
    else g.moveTo(sx, sy);
  }
  g.stroke();
  prism(
    [
      [PLUNGE_X - 12, face],
      [PLUNGE_X + 12, face],
      [PLUNGE_X + 12, face + 8],
      [PLUNGE_X - 12, face + 8],
    ],
    0,
    14,
    "#c22f22",
    "#ff6a50",
  );
}

/** A ball: polished steel, its shadow on the floor, the room's lights in it. */
function ball(b) {
  const z = b.held > 0 ? -2 : b.z;
  if (b.held <= 0) {
    ellipse(b.x + 3 + z * 0.35, b.y + 5 + z * 0.45, 0, R * 0.95);
    g.fillStyle = "rgba(0,0,0,0.4)";
    g.fill();
  }
  const [cx, cy, k] = P(b.x, b.y, z + R);
  const r = R * k;
  const steel = g.createRadialGradient(cx - r * 0.35, cy - r * 0.4, r * 0.05, cx, cy, r);
  steel.addColorStop(0, "#ffffff");
  steel.addColorStop(0.25, "#e2e8ea");
  steel.addColorStop(0.6, "#7d8a90");
  steel.addColorStop(0.85, "#3a4448");
  steel.addColorStop(1, "#1a2024");
  g.fillStyle = steel;
  g.beginPath();
  g.arc(cx, cy, r, 0, Math.PI * 2);
  g.fill();
  // The playfield's green in its lower half, a window of light in its upper.
  g.fillStyle = "rgba(60,200,120,0.25)";
  g.beginPath();
  g.ellipse(cx, cy + r * 0.45, r * 0.75, r * 0.35, 0, 0, Math.PI * 2);
  g.fill();
  g.fillStyle = "rgba(255,255,255,0.85)";
  g.beginPath();
  g.ellipse(cx - r * 0.3, cy - r * 0.45, r * 0.25, r * 0.13, -0.5, 0, Math.PI * 2);
  g.fill();
}

/* ---------- The renderer ---------- */

let width = 0;
let height = 0;

/** The table's shape on screen at unit scale, for fitting it to a box. */
function extent() {
  F = 1;
  OX = 0;
  OY = 0;
  let minX = Infinity;
  let maxX = -Infinity;
  let minY = Infinity;
  let maxY = -Infinity;
  for (const [x, y, z] of [
    [X0, Y0, HC + 50],
    [X1, Y0, HC + 50],
    [X0, Y1, HC],
    [X1, Y1, HC],
    [X0, Y1, 0],
    [X1, Y1, 0],
  ]) {
    const [sx, sy] = P(x, y, z);
    minX = Math.min(minX, sx);
    maxX = Math.max(maxX, sx);
    minY = Math.min(minY, sy);
    maxY = Math.max(maxY, sy);
  }
  return { minX, maxX, minY, maxY };
}

/** Width over height of the table as drawn: the page sizes its box to this. */
export const ASPECT = (() => {
  const e = extent();
  return (e.maxX - e.minX) / (e.maxY - e.minY);
})();

/**
 * Size the drawing to a canvas of w × h device pixels: as large as fits,
 * the front edge as wide as it can be.
 */
export function fit(w, h) {
  width = w;
  height = h;
  const e = extent();
  F = Math.min(w / (e.maxX - e.minX), h / (e.maxY - e.minY));
  OX = w / 2 - ((e.minX + e.maxX) / 2) * F;
  OY = h / 2 - ((e.minY + e.maxY) / 2) * F;
  still = layer(w, h);
  g = /** @type {CanvasRenderingContext2D} */ (still.getContext("2d"));
  paintStill();
  rampLayer = layer(w, h);
  g = /** @type {CanvasRenderingContext2D} */ (rampLayer.getContext("2d"));
  paintRamp();
  front = layer(w, h);
  g = /** @type {CanvasRenderingContext2D} */ (front.getContext("2d"));
  paintFront(w, h);
}

/** @param {CanvasRenderingContext2D} ctx */
export function draw(ctx) {
  g = ctx;
  g.clearRect(0, 0, width, height);
  g.drawImage(still, 0, 0);
  drawLamps();

  /** @type {{d:number, draw:() => void}[]} */
  const items = [];
  for (const b of BUMPERS) items.push({ d: depth(b.x, b.y), draw: () => bumper(b) });
  for (const d of DROPS) items.push({ d: depth(d.x, d.y), draw: () => dropTarget(d) });
  for (const t of STANDUPS) items.push({ d: depth(t.x, t.y) + 1, draw: () => standup(t) });
  items.push({ d: depth(32, SPINNER.y) + 1, draw: spinnerFlag });
  for (const f of flippers) items.push({ d: depth(f.x, f.y + 10), draw: () => flipper(f) });
  if (CENTER_POST.h > 0.02) {
    items.push({
      d: depth(CENTER_POST.x, CENTER_POST.y),
      draw: () => cylinder(CENTER_POST.x, CENTER_POST.y, CENTER_POST.r, 0, 22 * CENTER_POST.h, "#c22f22", "#ff8a6a"),
    });
  }
  items.push({ d: depth(PLUNGE_X, PLUNGER_Y), draw: plunger });
  for (const b of balls) if (b.ramp < 0) items.push({ d: depth(b.x, b.y) + 2, draw: () => ball(b) });
  items.sort((a, b) => a.d - b.d).forEach((i) => i.draw());

  g.drawImage(rampLayer, 0, 0);
  for (const b of balls) if (b.ramp >= 0) ball(b);
  g.drawImage(front, 0, 0);
}
