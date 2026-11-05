/**
 * The table's pixel art, after the home page's rainforest (client/home-*.webp):
 * ferns and vines, a waterfall, a treehouse whose ladder is the shooter lane,
 * a river where the ball drains, mushrooms for bumpers and fireflies for lamps.
 * By day it is the sunlit frame's greens; after dark, the night frame's, with
 * the mushrooms and the water glowing.
 *
 * Everything is drawn on a grid of art pixels, each 2 × 2 table units, out of
 * square fills only, so the edges are as hard as the scene's. The page scales
 * the grid up by whole device pixels (main.js fit).
 */

/** Table units per art pixel. */
export const PX = 2;
export const AW = 200;
export const AH = 360;

const DAY = {
  sky: ["#c4e69a", "#a3d677", "#80c159", "#62a944", "#4b9136", "#3a7a2c", "#2d6524"],
  shaft: "rgba(255,255,210,0.18)",
  fol: ["#0f3512", "#1d5a1a", "#2f8a24", "#58b532", "#9bdc58"],
  stem: "#1a4a16",
  wood: ["#2a170c", "#5a3519", "#8a5a2b", "#c4924f"],
  bark: ["#2b2116", "#3e3020"],
  rock: ["#2f3a2c", "#56654f", "#8a9a7c"],
  straw: ["#7a5a22", "#b98d3a", "#e2c06a"],
  water: ["#16615c", "#22958c", "#4fcab7", "#d6fff4"],
  cap: ["#5e160c", "#c8341e", "#ef6a45", "#fff1dc"],
  capHit: ["#7a5a10", "#ffd54a", "#fff3a0", "#ffffff"],
  lamp: ["#3d3a1c", "#6b6420", "#ffd54a", "#fff7c2"],
  bloom: ["#7a2f86", "#c45ad6", "#f1b3f7"],
  bud: "#2f8a24",
  red: ["#8e2414", "#e0482a"],
  ball: ["#1b201e", "#6e7a76", "#b8c3bf", "#ffffff"],
  frog: ["#1f5a14", "#4ea82a", "#a6e070"],
  fly: "#fff59a",
  glow: "rgba(255,230,120,",
  night: false,
};

const NIGHT = {
  sky: ["#174a3b", "#134235", "#10392e", "#0d3127", "#0b2a21", "#09231b", "#071c16"],
  shaft: "",
  fol: ["#04120a", "#0b2a16", "#145026", "#22783a", "#3fae5a"],
  stem: "#0a2614",
  wood: ["#170c06", "#3a2210", "#5e3b1c", "#8a6034"],
  bark: ["#140f0a", "#211910"],
  rock: ["#121a14", "#25332a", "#3d5244"],
  straw: ["#4a3614", "#7a5c24", "#a8853e"],
  water: ["#06302e", "#0e6a62", "#2fd3b8", "#c9fff3"],
  cap: ["#0d5a4c", "#2fd3b0", "#7dffe0", "#e6fff9"],
  capHit: ["#2fd3b0", "#9dfff0", "#e6fff9", "#ffffff"],
  lamp: ["#1f2a14", "#36421c", "#d8ff6a", "#f6ffd0"],
  bloom: ["#5a2a7a", "#b06ae0", "#f0c8ff"],
  bud: "#145026",
  red: ["#5e1430", "#c0306a"],
  ball: ["#0e1311", "#5e6a66", "#a9b4b0", "#ffffff"],
  frog: ["#0e3a10", "#2f7a20", "#7fc95a"],
  fly: "#e8ff8a",
  glow: "rgba(150,255,200,",
  night: true,
};

/** The palette for the scheme the page is in. */
export function palette() {
  return matchMedia("(prefers-color-scheme: dark)").matches ? NIGHT : DAY;
}

/** A small pseudo-random sequence, so every leaf grows where it grew. */
function seeded(seed) {
  return () => ((seed = (seed * 16807) % 2147483647) / 2147483647);
}

const BAYER = [0, 8, 2, 10, 12, 4, 14, 6, 3, 11, 1, 9, 15, 7, 13, 5];
const bayer = (x, y) => (BAYER[(y & 3) * 4 + (x & 3)] + 0.5) / 16;

/* ---------- Pixel primitives, all in art pixels ---------- */

/** @type {CanvasRenderingContext2D} */
let g;

function dot(x, y, c) {
  g.fillStyle = c;
  g.fillRect(Math.round(x), Math.round(y), 1, 1);
}

function rect(x, y, w, h, c) {
  g.fillStyle = c;
  g.fillRect(Math.round(x), Math.round(y), w, h);
}

function disc(cx, cy, r, c) {
  g.fillStyle = c;
  const x0 = Math.round(cx);
  const y0 = Math.round(cy);
  const n = Math.ceil(r);
  for (let dy = -n; dy <= n; dy++) {
    const w = Math.floor(Math.sqrt(Math.max(0, r * r - dy * dy)) + 0.35);
    if (r * r - dy * dy < 0) continue;
    g.fillRect(x0 - w, y0 + dy, w * 2 + 1, 1);
  }
}

/** A thick line through points, its radius going from r0 to r1. */
function stroke(pts, r0, c, r1 = r0) {
  let total = 0;
  for (let i = 1; i < pts.length; i++) total += Math.hypot(pts[i][0] - pts[i - 1][0], pts[i][1] - pts[i - 1][1]);
  let run = 0;
  for (let i = 1; i < pts.length; i++) {
    const [ax, ay] = pts[i - 1];
    const [bx, by] = pts[i];
    const len = Math.hypot(bx - ax, by - ay);
    const n = Math.max(1, Math.ceil(len * 1.5));
    for (let k = 0; k <= n; k++) {
      const t = (run + (len * k) / n) / (total || 1);
      const r = r0 + (r1 - r0) * t;
      const x = ax + ((bx - ax) * k) / n;
      const y = ay + ((by - ay) * k) / n;
      if (r < 0.7) dot(x, y, c);
      else disc(x, y, r, c);
    }
    run += len;
  }
}

/** Fill a polygon, row by row. */
function poly(pts, c, shade) {
  const ys = pts.map((p) => p[1]);
  const top = Math.floor(Math.min(...ys));
  const bottom = Math.ceil(Math.max(...ys));
  for (let y = top; y <= bottom; y++) {
    const yc = y + 0.5;
    const xs = [];
    for (let i = 0; i < pts.length; i++) {
      const [ax, ay] = pts[i];
      const [bx, by] = pts[(i + 1) % pts.length];
      if (ay <= yc !== by <= yc) xs.push(ax + ((yc - ay) / (by - ay)) * (bx - ax));
    }
    xs.sort((a, b) => a - b);
    for (let i = 0; i + 1 < xs.length; i += 2) {
      const x0 = Math.round(xs[i]);
      const x1 = Math.round(xs[i + 1]);
      if (!shade) rect(x0, y, x1 - x0, 1, c);
      else for (let x = x0; x < x1; x++) dot(x, y, shade(x, y));
    }
  }
}

/** Table units to art pixels. */
const a = (pts) => pts.map(([x, y]) => [x / PX, y / PX]);

/** A 3 × 5 glyph for the few letters the table spells. */
const FONT = {
  G: "111100101101111",
  O: "111101101101111",
  "!": "010010010000010",
};

function glyph(ch, x, y, c) {
  const bits = FONT[ch];
  for (let i = 0; i < 15; i++) if (bits[i] === "1") dot(x + (i % 3), y + Math.floor(i / 3), c);
}

/* ---------- The scene ---------- */

/** Where the table is, in table units: inside the dome and the walls, left of the lane. */
function inField(x, y) {
  if (x < 16 || x > 352) return false;
  if (y < 196) return (x - 200) ** 2 + (y - 196) ** 2 <= 184 * 184;
  return true;
}

/** The corners under the inlanes, beside the flippers: no ball reaches them. */
function deadZone(x, y) {
  if (x < 118 && y > 556 + (x - 16) * 0.68) return true;
  if (x > 250 && y > 556 + (352 - x) * 0.68) return true;
  return false;
}

/** A fern frond: a curving stem and leaflets either side, shorter toward the tip. */
function fern(x, y, ang, len, pal, rnd) {
  let dir = ang;
  const bend = (rnd() - 0.5) * 0.08;
  let px = x;
  let py = y;
  for (let i = 0; i < len; i++) {
    px += Math.cos(dir);
    py += Math.sin(dir);
    dir += bend;
    dot(px, py, pal.stem);
    if (i % 2) continue;
    const l = Math.max(1, Math.round((1 - i / len) * len * 0.38));
    for (const side of [-1, 1]) {
      const la = dir + side * 1.05;
      for (let k = 1; k <= l; k++) {
        const c = k === l ? pal.fol[4] : side < 0 ? pal.fol[3] : pal.fol[2];
        dot(px + Math.cos(la) * k, py + Math.sin(la) * k, c);
      }
    }
  }
}

/** A red bromeliad: a fan of spiky leaves. */
function bromeliad(x, y, pal) {
  for (let i = -3; i <= 3; i++) {
    const la = -Math.PI / 2 + i * 0.32;
    for (let k = 1; k < 7 - Math.abs(i); k++) dot(x + Math.cos(la) * k, y + Math.sin(la) * k, k > 3 ? pal.red[1] : pal.red[0]);
  }
}

/** A spike of small flowers. */
function spike(x, y, pal) {
  for (let k = 0; k < 6; k++) {
    dot(x, y - k, pal.stem);
    if (k > 1) {
      dot(x - 1, y - k, pal.bloom[k % 2]);
      dot(x + 1, y - k - 1, pal.bloom[(k + 1) % 2]);
    }
  }
}

/** A wooden log along a rail. */
function log(pts, r, pal) {
  stroke(pts, r + 1, pal.wood[0]);
  stroke(pts, r, pal.wood[1]);
  stroke(
    pts.map(([x, y]) => [x - 0.6, y - 0.8]),
    Math.max(0.5, r - 1),
    pal.wood[2],
  );
  stroke(
    pts.map(([x, y]) => [x - 1, y - 1.4]),
    0.5,
    pal.wood[3],
  );
}

/**
 * The art that never moves, into `ctx` at art-pixel scale.
 *
 * @param {CanvasRenderingContext2D} ctx
 * @param {any} pal
 * @param {any} S the table (main.js)
 */
export function paintStill(ctx, pal, S) {
  g = ctx;
  const rnd = seeded(11);

  // The jungle the table is cut into.
  rect(0, 0, AW, AH, pal.fol[0]);
  for (let i = 0; i < 260; i++) {
    const x = rnd() * AW;
    const y = rnd() * AH;
    fern(x, y, -Math.PI / 2 + (rnd() - 0.5) * 2.6, 8 + rnd() * 18, pal, rnd);
  }
  for (let i = 0; i < 26; i++) bromeliad(rnd() * AW, rnd() * AH, pal);
  for (let i = 0; i < 26; i++) spike(rnd() * AW, rnd() * AH, pal);

  // The playfield, a dithered fall from canopy light to the forest floor.
  const field = g.getImageData(0, 0, AW, AH);
  const out = field.data;
  const rgb = (hex) => [1, 3, 5].map((i) => parseInt(hex.slice(i, i + 2), 16));
  const sky = pal.sky.map(rgb);
  const water = pal.water.map(rgb);
  for (let y = 0; y < AH; y++) {
    for (let x = 0; x < AW; x++) {
      const tx = (x + 0.5) * PX;
      const ty = (y + 0.5) * PX;
      if (!inField(tx, ty) || (deadZone(tx, ty) && ty < 676)) continue;
      let c;
      if (ty >= 676) {
        // The river along the bottom: darker where it is deeper.
        const t = (ty - 676) / 44;
        c = water[t + bayer(x, y) * 0.6 > 0.7 ? 0 : 1];
      } else {
        const t = (y / AH) * (sky.length - 1);
        const i = Math.floor(t);
        c = sky[Math.min(sky.length - 1, t - i > bayer(x, y) ? i + 1 : i)];
        // Moss: a speckle a shade either side.
        const n = rnd();
        if (n < 0.05) c = sky[Math.min(sky.length - 1, i + 1)];
        else if (n < 0.08) c = sky[Math.max(0, i - 1)];
      }
      const o = (y * AW + x) * 4;
      out[o] = c[0];
      out[o + 1] = c[1];
      out[o + 2] = c[2];
      out[o + 3] = 255;
    }
  }
  const layer = document.createElement("canvas");
  layer.width = AW;
  layer.height = AH;
  /** @type {CanvasRenderingContext2D} */ (layer.getContext("2d")).putImageData(field, 0, 0);
  g.drawImage(layer, 0, 0);

  // Shafts of sunlight through the canopy, by day.
  if (pal.shaft) {
    for (const [x0, w] of [[40, 10], [78, 6], [128, 12]]) {
      for (let y = 30; y < 300; y++) {
        for (let x = 0; x < w; x++) {
          const px = x0 + x + y * 0.45;
          if ((x + y) % 2 === 0 && inField(px * PX, y * PX)) dot(px, y, pal.shaft);
        }
      }
    }
  }

  // Vines hanging from the dome's left side, with leaves.
  for (const [tx, len] of [[34, 70], [52, 40], [70, 92], [100, 30], [300, 36], [326, 58]]) {
    const top = 196 - Math.sqrt(184 * 184 - (tx - 200) ** 2);
    const x = tx / PX;
    for (let k = 2; k < len / PX; k++) {
      const vx = x + Math.sin(k * 0.35) * 0.8;
      const vy = top / PX + k;
      dot(vx, vy, pal.stem);
      if (k % 4 === 0) {
        dot(vx + 1, vy, pal.fol[3]);
        dot(vx + 2, vy - 1, pal.fol[4]);
      } else if (k % 4 === 2) {
        dot(vx - 1, vy, pal.fol[2]);
        dot(vx - 2, vy - 1, pal.fol[3]);
      }
    }
  }

  // Ferns crowding the banks of the river, and the corners by the flippers.
  for (let i = 0; i < 26; i++) {
    const left = i % 2 === 0;
    const x = left ? 8 + rnd() * 48 : 128 + rnd() * 48;
    const y = 300 + rnd() * 40;
    if (!deadZone(x * PX, y * PX)) continue;
    fern(x, y, -Math.PI / 2 + (left ? 0.5 : -0.5) + (rnd() - 0.5), 8 + rnd() * 10, pal, rnd);
  }
  bromeliad(20, 322, pal);
  spike(46, 330, pal);
  bromeliad(170, 318, pal);

  // A wooden sign by the river: GO.
  rect(14, 300, 2, 14, pal.wood[1]);
  rect(8, 294, 14, 9, pal.wood[0]);
  rect(9, 295, 12, 7, pal.wood[2]);
  rect(9, 295, 12, 1, pal.wood[3]);
  glyph("G", 10, 296, pal.wood[0]);
  glyph("O", 16, 296, pal.wood[0]);

  // The shooter lane: a tree's bark, the treehouse ladder up it.
  const lx = S.LANE_X / PX;
  rect(lx, 125, AW - lx, AH - 125, pal.bark[0]);
  for (let y = 126; y < AH; y += 3) dot(lx + 2 + ((y * 7) % 11), y, pal.bark[1]);
  for (let y = 140; y < AH; y += 9) rect(lx + 1, y, AW - lx - 2, 2, pal.wood[1]);

  // Moss arrows up the table.
  for (const [tx, ty] of [[60, 600], [308, 600], [184, 520], [184, 345]]) {
    const x = Math.round(tx / PX);
    const y = Math.round(ty / PX);
    for (let k = 0; k < 4; k++) rect(x - k, y - 3 + k, k * 2 + 1, 1, pal.fol[4]);
  }

  // The waterfall's rock face, behind the water main.js animates.
  for (let x = 12; x < 30; x++) {
    const top = Math.ceil((196 - Math.sqrt(184 * 184 - (x * PX - 200) ** 2)) / PX) + 3;
    rect(x, top, 1, 150 - top, pal.fol[1]);
  }

  // The saucer: a hollow stump, mossy at the rim.
  const sx = S.SAUCER.x / PX;
  const sy = S.SAUCER.y / PX;
  disc(sx, sy, 8, pal.wood[0]);
  disc(sx, sy, 7, pal.wood[2]);
  disc(sx, sy, 5.5, pal.wood[1]);
  disc(sx, sy, 4.5, pal.bark[0]);
  disc(sx, sy + 1, 3.5, "#000");
  for (let i = 0; i < 10; i++) {
    const an = rnd() * Math.PI * 2;
    dot(sx + Math.cos(an) * 7, sy + Math.sin(an) * 7, pal.fol[3]);
  }

  // Slingshots: mossy boulders, a vine stretched along the face that kicks.
  for (const tri of S.SLINGS) {
    const pts = a(tri);
    const top = Math.min(...pts.map((p) => p[1]));
    poly(pts, null, (x, y) => {
      // Moss on the upper part, bare stone shading darker below.
      const t = (y - top) / 48 + bayer(x, y) * 0.5;
      return t < 0.45 ? (bayer(x, y) > 0.5 ? pal.fol[3] : pal.fol[2]) : t < 0.9 ? pal.rock[2] : pal.rock[1];
    });
    stroke([...pts, pts[0]], 1, pal.rock[0]);
  }

  // Stand-up targets: wooden plates on the left wall.
  for (const t of S.TARGETS) rect(7, t.y / PX - 7, 6, 14, pal.wood[0]);

  // The rails: logs.
  for (const pts of S.rails) log(a(pts), pts.length > 10 ? 2 : 1.5, pal);

  // Bamboo posts between the rollover lanes.
  for (const x of [124, 164, 204, 244]) {
    const ax = x / PX;
    rect(ax - 1, 30, 3, 20, "#6d8a2a");
    rect(ax - 1, 30, 1, 20, "#b8cf5a");
    for (let y = 33; y < 50; y += 6) rect(ax - 1, y, 3, 1, "#3e5418");
  }

  treehouse(pal);
}

/** The treehouse in the corner over the shooter lane. */
function treehouse(pal) {
  const x = 166;
  const y = 12;
  // Its trunk, where the lane's ladder climbs.
  rect(x + 14, y + 20, 14, 40, pal.bark[0]);
  // The platform.
  rect(x - 2, y + 18, 36, 3, pal.wood[0]);
  rect(x - 1, y + 18, 34, 1, pal.wood[3]);
  // Plank walls, a door, and a lit window.
  rect(x + 2, y + 6, 26, 12, pal.wood[1]);
  for (let k = 0; k < 12; k += 3) rect(x + 2, y + 6 + k, 26, 1, pal.wood[2]);
  rect(x + 5, y + 10, 5, 8, pal.wood[0]);
  rect(x + 16, y + 9, 6, 5, pal.night ? "#ffcf5a" : "#7a5a22");
  rect(x + 18, y + 9, 1, 5, pal.wood[0]);
  // The thatched roof.
  poly(
    [
      [x - 2, y + 7],
      [x + 15, y - 4],
      [x + 32, y + 7],
    ],
    null,
    (px, py) => pal.straw[(px + py * 2) % 3],
  );
  rect(x - 2, y + 7, 35, 1, pal.straw[0]);
  // The lantern, lit after dark.
  rect(x + 29, y + 8, 3, 4, pal.night ? "#ffd27a" : "#9a6633");
  if (pal.night) {
    g.fillStyle = "rgba(255,210,122,0.25)";
    g.fillRect(x + 26, y + 5, 9, 10);
  }
  // Vines down from the platform.
  for (const vx of [x, x + 6, x + 31]) {
    for (let k = 0; k < 8; k++) dot(vx, y + 21 + k, k % 2 ? pal.fol[3] : pal.stem);
  }
}

/* ---------- What moves ---------- */

/** A lamp's glow: a soft plus around it. */
function glow(x, y, r, pal, alpha) {
  g.fillStyle = `${pal.glow}${alpha})`;
  g.fillRect(Math.round(x - r), Math.round(y - 1), r * 2 + 1, 3);
  g.fillRect(Math.round(x - 1), Math.round(y - r), 3, r * 2 + 1);
}

/** Each waterfall column's phase, shuffled so no two neighbours line up. */
const FALL = [3, 11, 6, 15, 1, 9, 13, 4, 16, 7, 0, 12, 5, 10, 2, 14, 8];

/** The fireflies that come out after dark: fixed places, each blinking in its own time. */
const FLIES = (() => {
  const rnd = seeded(5);
  return Array.from({ length: 22 }, () => [10 + rnd() * 160, 40 + rnd() * 280, rnd() * 6.28, 0.8 + rnd() * 1.6]);
})();

/**
 * One frame: the still art, then everything that moves or lights.
 *
 * @param {CanvasRenderingContext2D} ctx
 * @param {HTMLCanvasElement} still
 * @param {any} pal
 * @param {any} S the table and the game (main.js)
 * @param {number} now ms
 */
export function paintFrame(ctx, still, pal, S, now) {
  g = ctx;
  g.drawImage(still, 0, 0);
  const t = now / 1000;
  const { game } = S;

  // The waterfall, falling, and its foam where it lands.
  for (let x = 13; x < 29; x++) {
    const top = Math.ceil((196 - Math.sqrt(184 * 184 - (x * PX - 200) ** 2)) / PX) + 4;
    // Each column streams at its own phase, so the streaks run straight down.
    const off = FALL[x % FALL.length];
    const fall = Math.floor(t * (44 + (x % 3) * 6));
    for (let y = top; y < 148; y++) {
      const v = (((y - fall + off) % 17) + 17) % 17;
      rect(x, y, 1, 1, v === 0 ? pal.water[3] : v < 5 ? pal.water[2] : pal.water[1]);
    }
  }
  for (let i = 0; i < 10; i++) {
    const fx = 12 + ((i * 7 + Math.floor(t * 12)) % 18);
    dot(fx, 147 + ((i + Math.floor(t * 9)) % 3), pal.water[3]);
  }

  // Ripples on the river.
  for (let i = 0; i < 18; i++) {
    const rx = 8 + ((i * 29 + t * 6 * (i % 3 ? 1 : -1)) % 168 + 168) % 168;
    const ry = 340 + ((i * 5) % 18);
    rect(rx, ry, 3, 1, pal.water[2]);
  }

  // Fireflies by night, motes of light by day.
  for (const [fx, fy, ph, sp] of FLIES) {
    const b = Math.sin(t * sp + ph);
    if (b < 0.4) continue;
    const x = fx + Math.sin(t * 0.7 + ph) * 3;
    const y = fy + Math.cos(t * 0.5 + ph) * 2;
    if (pal.night) glow(x, y, 1, pal, 0.25);
    dot(x, y, pal.night ? pal.fly : "rgba(255,255,220,0.8)");
  }

  // The ring of fireflies round the stump: one lit per five bumper hits.
  const blink = Math.floor(now / 260) % 2 === 0;
  for (let i = 0; i < S.RING; i++) {
    const an = (i / S.RING) * Math.PI * 2 - Math.PI / 2;
    const x = S.SAUCER.x / PX + Math.cos(an) * 20;
    const y = S.SAUCER.y / PX + Math.sin(an) * 20;
    const on = i < game.ring || (game.held > 0 && blink);
    if (on) {
      glow(x, y, 2, pal, 0.35);
      rect(x - 1, y, 3, 1, pal.lamp[2]);
      rect(x, y - 1, 1, 3, pal.lamp[2]);
      dot(x, y, pal.lamp[3]);
    } else {
      dot(x, y, pal.lamp[1]);
    }
  }

  // Lanterns over the rollover lanes: G, O, !.
  for (const r of S.ROLLS) {
    const x = Math.round(r.x / PX) - 3;
    const y = Math.round(r.y / PX) - 5;
    if (r.lit) glow(x + 3, y + 5, 5, pal, 0.3);
    rect(x + 2, y - 1, 3, 1, pal.wood[0]);
    rect(x, y, 7, 10, pal.wood[0]);
    rect(x + 1, y + 1, 5, 8, r.lit ? pal.lamp[2] : pal.lamp[0]);
    glyph(r.ch, x + 2, y + 3, r.lit ? pal.wood[0] : pal.lamp[1]);
  }

  // The targets: buds that bloom when struck.
  for (const tg of S.TARGETS) {
    const x = 10;
    const y = Math.round(tg.y / PX);
    rect(x - 1, y - 5, 3, 10, pal.wood[2]);
    const fx = x + 8;
    if (tg.lit) {
      glow(fx, y, 3, pal, 0.3);
      for (const [dx, dy] of [[0, -2], [2, 0], [0, 2], [-2, 0], [1, -1], [1, 1], [-1, 1], [-1, -1]]) dot(fx + dx, y + dy, pal.bloom[1]);
      dot(fx, y, pal.lamp[3]);
      dot(fx, y - 1, pal.bloom[2]);
    } else {
      rect(fx - 1, y - 1, 2, 3, pal.bud);
      dot(fx, y - 2, pal.bloom[0]);
    }
  }

  // The slingshots' vines flash as they kick.
  S.SLINGS.forEach(([p, , q], i) => {
    if (game.sling[i] <= 0) return;
    stroke(a([q, p]), 1, pal.lamp[3]);
  });

  // Mushrooms for bumpers, their caps flaring when struck.
  for (const b of S.BUMPERS) {
    const x = b.x / PX;
    const y = b.y / PX;
    const c = b.flash > 0 ? pal.capHit : pal.cap;
    disc(x + 1, y + 2, 11, "rgba(0,0,0,0.3)");
    if (pal.night || b.flash > 0) {
      g.fillStyle = `${pal.glow}${b.flash > 0 ? 0.35 : 0.12})`;
      disc(x, y, 14, g.fillStyle);
    }
    disc(x, y, 10.5, c[0]);
    disc(x, y, 9.5, c[1]);
    disc(x - 2, y - 2, 6, c[2]);
    for (const [dx, dy] of [[-4, -5], [3, -3], [-6, 1], [5, 3], [-1, 5], [1, -7]]) {
      rect(x + dx, y + dy, 2, 2, c[3]);
    }
  }

  // The plunger: a wooden block on a spring, drawn back as it is pulled.
  const face = (S.PLUNGER_Y + game.pull * 26) / PX;
  const px = S.PLUNGE_X / PX;
  for (let y = Math.ceil(face) + 4, k = 0; y < AH; y += 2, k++) rect(px - 4 + (k % 2) * 4, y, 4, 1, "#9aa39f");
  rect(px - 7, face, 14, 4, pal.wood[0]);
  rect(px - 6, face, 12, 3, pal.wood[2]);
  rect(px - 6, face, 12, 1, pal.wood[3]);

  // The flippers: logs, lashed at the pivot with a vine.
  for (const f of S.flippers) {
    const x = f.x / PX;
    const y = f.y / PX;
    const len = S.FLIP_LEN / PX;
    const tip = [x + Math.cos(f.a) * len, y + Math.sin(f.a) * len];
    stroke([[x, y], tip], 6, pal.wood[0], 3.6);
    stroke([[x, y], tip], 5, pal.wood[2], 2.6);
    stroke(
      [
        [x - 0.5, y - 1.5],
        [tip[0] - 0.4, tip[1] - 1],
      ],
      1.6,
      pal.wood[3],
      0.6,
    );
    const bx = x + Math.cos(f.a) * 5;
    const by = y + Math.sin(f.a) * 5;
    stroke(
      [
        [bx - Math.sin(f.a) * 4.5, by + Math.cos(f.a) * 4.5],
        [bx + Math.sin(f.a) * 4.5, by - Math.cos(f.a) * 4.5],
      ],
      1,
      pal.fol[3],
    );
    disc(x, y, 1.5, pal.wood[0]);
  }

  butterflies(t, pal);
  frog(t, pal, game.held > 0);

  // The ball: a polished steel ball, lit from the canopy.
  if (S.showBall) {
    const x = S.ball.x / PX;
    const y = S.ball.y / PX;
    disc(x + 1, y + 2, 4.5, "rgba(0,0,0,0.35)");
    disc(x, y, 5, pal.ball[0]);
    disc(x, y, 4, pal.ball[1]);
    disc(x - 0.8, y - 0.8, 2.8, pal.ball[2]);
    rect(x - 2, y - 2, 2, 1, pal.ball[3]);
    dot(x - 2, y - 1, pal.ball[3]);
  }
}

/** Two butterflies, one blue and one amber, wandering over the table. */
function butterflies(t, pal) {
  for (const [ph, wing, body] of [
    [0, "#4aa3ff", "#1b3a6e"],
    [2.4, "#ffb13a", "#6e3a10"],
  ]) {
    const x = 90 + Math.sin(t * 0.31 + ph) * 60 + Math.sin(t * 1.3 + ph) * 8;
    const y = 120 + Math.cos(t * 0.23 + ph * 1.7) * 70 + Math.sin(t * 1.9) * 5;
    const open = Math.floor(t * 8 + ph * 3) % 2 === 0;
    rect(x, y - 1, 1, 3, body);
    if (open) {
      rect(x - 3, y - 2, 3, 2, wing);
      rect(x + 1, y - 2, 3, 2, wing);
      rect(x - 2, y, 2, 2, wing);
      rect(x + 1, y, 2, 2, wing);
    } else {
      rect(x - 1, y - 2, 1, 3, wing);
      rect(x + 1, y - 2, 1, 3, wing);
    }
    if (pal.night) glow(x, y, 2, pal, 0.15);
  }
}

/** The frog on the right bank: it blinks, and sits up while the stump holds the ball. */
function frog(t, pal, alert) {
  const x = 154;
  const y = alert ? 327 : 329;
  const [dk, md, lt] = pal.frog;
  rect(x, y + 2, 11, 4, md);
  rect(x + 1, y + 5, 9, 1, lt);
  rect(x - 1, y + 5, 3, 1, dk);
  rect(x + 9, y + 5, 3, 1, dk);
  rect(x + 1, y, 3, 3, md);
  rect(x + 7, y, 3, 3, md);
  const blink = Math.floor(t * 10) % 37 === 0;
  rect(x + 2, y + 1, 1, 1, blink ? dk : "#fff");
  rect(x + 8, y + 1, 1, 1, blink ? dk : "#fff");
  if (!blink) {
    dot(x + 3, y + 1, "#000");
    dot(x + 9, y + 1, "#000");
  }
  rect(x + 3, y + 4, 5, 1, dk);
}
