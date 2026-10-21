#!/usr/bin/env node
/**
 * The home page's rainforest: client/home-{light,dark}.webp for wide screens
 * (phones get none), made from generated frames dropped into assets/ under
 * these names. They are 2 MB or so apiece
 * and the page never loads them, so they are not checked in (.gitignore) —
 * only what this makes from them is:
 *
 *   jungle-wide-light.png   day, wide: the jungle either side of an empty
 *                           column, cut out to transparency
 *   jungle-wide-dark.png    night, wide, with the empty column drawn in as a
 *                           checkerboard rather than transparent
 *
 * Run by hand (`npm run build:scene`), not on every client build — the same
 * arrangement as og-image.mjs and app-icons.mjs. The output is checked in;
 * `copyStatic` in build-client.mjs ships it to public/. It prints the
 * measurements app.css positions the frames by; when a frame changes, those
 * numbers change with it (see body.home::before in app.css).
 *
 * What it fixes on the way:
 *
 * - The frames cut out to transparency were cut from a green screen, and it
 *   shows: their edges are a soft rim of half-transparent pixels in the
 *   screen's own green, which glows on a dark page and tints a light one. The
 *   edge is made hard — this is pixel art, and a crisp silhouette is how its
 *   leaves are drawn anyway — and every pixel on it takes the colour of the
 *   nearest solid pixel inside.
 * - The night wide frame has its checkerboard keyed out: the light grey
 *   connected to the empty middle, pockets of it the foliage closes off, the
 *   grey blend along the art's edge, and the faint ghost shapes the generator
 *   left in the squares.
 */
import sharp from "sharp";
import { writeFileSync } from "fs";
import path from "path";
import { fileURLToPath } from "url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const assets = path.join(__dirname, "..", "assets");
const outDir = path.resolve(process.argv[2] ?? path.join(__dirname, "..", "client"));

/**
 * Shipped at 0.6 of the generated size, lossy colour over lossless alpha.
 *
 * The frames are painted, thousands of colours in soft runs, which a lossy
 * encoder handles at a fraction of lossless's size; the cut-out edge is a
 * line, which lossless alpha keeps where it is. And the generator drew them
 * larger than their detail: a laptop shows the wide frame about its own size,
 * so a 2× screen magnifies it twice, and at 0.6 the frog's eye and the leaf
 * edges still come through that magnification as they were — at 0.5 they
 * start to go soft. About half the bytes of full size at the same quality.
 */
const SCALE = 0.6;
const WEBP = { quality: 76, alphaQuality: 100, effort: 6, smartSubsample: true };

/**
 * The band of a wide frame the page's contents can sit in, as shares of its
 * height. The column has to clear the art across it; above and below it the
 * art may reach in further, which is where its leaves hang over the column.
 */
const BAND = [0.2, 0.66];

const N4 = [
  [1, 0],
  [-1, 0],
  [0, 1],
  [0, -1],
];

/** Pixels in breadth-first rings out from `seeds`, through those `pass` allows. */
function flood(W, H, seeds, pass, mark) {
  let q = seeds;
  while (q.length) {
    const next = [];
    for (const p of q) {
      const x = p % W;
      const y = (p / W) | 0;
      for (const [dx, dy] of N4) {
        const nx = x + dx;
        const ny = y + dy;
        if (nx < 0 || ny < 0 || nx >= W || ny >= H) continue;
        const n = ny * W + nx;
        if (!pass(n, p)) continue;
        mark(n, p);
        next.push(n);
      }
    }
    q = next;
  }
}

/**
 * Hard alpha, and every edge pixel recoloured from the nearest solid one.
 * `solid` says which pixels' colours can be trusted; `opaque` which stay.
 */
function settle(rgb, channels, W, H, solid, opaque) {
  const N = W * H;
  const from = new Int32Array(N).fill(-1);
  const seeds = [];
  for (let p = 0; p < N; p++) {
    if (solid[p]) {
      from[p] = p;
      seeds.push(p);
    }
  }
  flood(W, H, seeds, (n) => from[n] === -1, (n, p) => (from[n] = from[p]));
  const out = Buffer.alloc(N * 4);
  for (let p = 0; p < N; p++) {
    if (!opaque[p]) continue;
    const s = from[p] === -1 ? p : from[p];
    out[p * 4] = rgb[s * channels];
    out[p * 4 + 1] = rgb[s * channels + 1];
    out[p * 4 + 2] = rgb[s * channels + 2];
    out[p * 4 + 3] = 255;
  }
  return out;
}

/** A day frame: green-screen rim and stray specks out, hard edge. */
async function cutOut(file) {
  const { data, info } = await sharp(file).ensureAlpha().raw().toBuffer({ resolveWithObject: true });
  const W = info.width;
  const H = info.height;
  const N = W * H;
  const solid = new Uint8Array(N);
  const opaque = new Uint8Array(N);
  for (let p = 0; p < N; p++) {
    const [r, g, b, a] = data.subarray(p * 4, p * 4 + 4);
    const screen = g > 150 && g - Math.max(r, b) > 70;
    solid[p] = a >= 240 && !screen ? 1 : 0;
    opaque[p] = a >= 128 ? 1 : 0;
  }
  return { rgba: settle(data, 4, W, H, solid, opaque), W, H };
}

/** A frame with the transparency drawn in as a checkerboard: keyed out, hard edge. */
async function keyOut(file) {
  const { data, info } = await sharp(file).removeAlpha().raw().toBuffer({ resolveWithObject: true });
  const W = info.width;
  const H = info.height;
  const N = W * H;
  const lo = (p) => Math.min(data[p * 3], data[p * 3 + 1], data[p * 3 + 2]);
  const hi = (p) => Math.max(data[p * 3], data[p * 3 + 1], data[p * 3 + 2]);
  const grey = (p, min, spread) => lo(p) >= min && hi(p) - lo(p) <= spread;
  const square = (p) => grey(p, 150, 30);
  const bg = new Uint8Array(N);

  // The checkerboard connected to the empty middle.
  const seeds = [];
  for (let y = 0; y < H; y++) {
    const p = y * W + (W >> 1);
    if (square(p)) {
      bg[p] = 1;
      seeds.push(p);
    }
  }
  flood(W, H, seeds, (n) => !bg[n] && square(n), (n) => (bg[n] = 1));

  // Pockets of it the foliage closes off: a patch of light grey too big to be
  // a highlight.
  const seen = new Uint8Array(N);
  for (let s = 0; s < N; s++) {
    if (bg[s] || seen[s] || !square(s)) continue;
    const patch = [s];
    seen[s] = 1;
    flood(W, H, [s], (n) => !seen[n] && !bg[n] && square(n), (n) => {
      seen[n] = 1;
      patch.push(n);
    });
    if (patch.length >= 40) for (const p of patch) bg[p] = 1;
  }

  // The grey blend along the art's edge, and grey specks just inside it.
  const near = (p, r) => {
    const x = p % W;
    const y = (p / W) | 0;
    for (let dy = -r; dy <= r; dy++) {
      for (let dx = -r; dx <= r; dx++) {
        const nx = x + dx;
        const ny = y + dy;
        if (nx >= 0 && ny >= 0 && nx < W && ny < H && bg[ny * W + nx]) return true;
      }
    }
    return false;
  };
  for (let pass = 0; pass < 2; pass++) {
    const edge = [];
    for (let p = 0; p < N; p++) if (!bg[p] && grey(p, 95, 48) && near(p, 1)) edge.push(p);
    for (const p of edge) bg[p] = 1;
  }
  const specks = [];
  for (let p = 0; p < N; p++) if (!bg[p] && grey(p, 150, 40) && near(p, 2)) specks.push(p);
  for (const p of specks) bg[p] = 1;

  // Ghosts: grey islands in the middle, attached to no edge of the frame.
  const comp = new Uint8Array(N);
  for (let s = 0; s < N; s++) {
    if (bg[s] || comp[s]) continue;
    const island = [s];
    comp[s] = 1;
    flood(W, H, [s], (n) => !bg[n] && !comp[n], (n) => {
      comp[n] = 1;
      island.push(n);
    });
    const framed = island.some((p) => {
      const x = p % W;
      const y = (p / W) | 0;
      return x === 0 || y === 0 || x === W - 1 || y === H - 1;
    });
    const spread = island.reduce((a, p) => a + hi(p) - lo(p), 0) / island.length;
    if (!framed && island.length < 1500 && spread < 40) for (const p of island) bg[p] = 1;
  }

  const solid = new Uint8Array(N);
  const opaque = new Uint8Array(N);
  for (let p = 0; p < N; p++) {
    opaque[p] = bg[p] ? 0 : 1;
    solid[p] = opaque[p] && !near(p, 1) ? 1 : 0;
  }
  return { rgba: settle(data, 3, W, H, solid, opaque), W, H };
}

/**
 * Where a wide frame's empty column is, across the band the contents sit in:
 * the furthest the left art reaches right and the right art left, measured
 * from the middle outward on every row.
 */
function column({ rgba, W, H }) {
  const a = (x, y) => rgba[(y * W + x) * 4 + 3];
  const mid = W >> 1;
  let left = 0;
  let right = W;
  for (let y = Math.round(BAND[0] * H); y <= Math.round(BAND[1] * H); y++) {
    let l = mid;
    while (l > 0 && !a(l, y)) l--;
    let r = mid;
    while (r < W - 1 && !a(r, y)) r++;
    left = Math.max(left, l + 1);
    right = Math.min(right, r);
  }
  return { W, H, split: mid, left, right };
}

async function save(frame, name) {
  const w = Math.round(frame.W * SCALE);
  const h = Math.round(frame.H * SCALE);
  const buf = await sharp(frame.rgba, { raw: { width: frame.W, height: frame.H, channels: 4 } })
    .resize(w, h, { kernel: "lanczos3" })
    .webp(WEBP)
    .toBuffer();
  writeFileSync(path.join(outDir, name), buf);
  console.log(`${name.padEnd(24)} ${w}×${h}  ${(buf.length / 1024).toFixed(1)} KB`);
}

/** A length in the frame's pixels as app.css spells it: a share of its height, in vh. */
const vh = (px, H) => `${((px / H) * 100).toFixed(2)}vh`;

const frames = {
  light: {
    wide: await cutOut(path.join(assets, "jungle-wide-light.png")),
  },
  dark: {
    wide: await keyOut(path.join(assets, "jungle-wide-dark.png")),
  },
};

for (const [theme, { wide }] of Object.entries(frames)) {
  await save(wide, `home-${theme}.webp`);
  const c = column(wide);
  console.log(`  --w: ${vh(c.W, c.H)}; --split: ${vh(c.split, c.H)}; --reach-l: ${vh(c.left, c.H)}; --reach-r: ${vh(c.right, c.H)};`);
}
