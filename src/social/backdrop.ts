/**
 * A person's colours, and the dithered gradient drawn in them.
 *
 * Pure on purpose: no Node, no DOM. The server draws it once, under a head
 * and shoulders, as the profile picture a new account starts with
 * (./avatar.ts). The browser draws the same one under a profile photo with
 * transparent parts before it is compressed, so a cut-out keeps its owner's
 * background rather than turning white (client/avatar, bundled from here).
 *
 * The hue comes from the name, so it never changes and needs nothing stored.
 * FNV-1a rather than SHA-256: the same answer everywhere, synchronously, and a
 * phone reaching a dev box over plain http has no crypto.subtle to ask.
 */

export type Rgb = [number, number, number];

/**
 * 32-bit FNV-1a over the name's UTF-16 code units, then murmur3's finaliser:
 * FNV alone leaves the low bits of short, similar names alike, and the hue is
 * taken from those.
 */
function hash(text: string): number {
  let h = 0x811c9dc5;
  for (let i = 0; i < text.length; i++) {
    h ^= text.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  h ^= h >>> 16;
  h = Math.imul(h, 0x85ebca6b);
  h ^= h >>> 13;
  h = Math.imul(h, 0xc2b2ae35);
  h ^= h >>> 16;
  return h >>> 0;
}

function rgb(h: number, s: number, l: number): Rgb {
  const a = s * Math.min(l, 1 - l);
  const f = (n: number) => {
    const k = (n + h / 30) % 12;
    return Math.round(255 * (l - a * Math.max(-1, Math.min(k - 3, 9 - k, 1))));
  };
  return [f(0), f(8), f(4)];
}

/**
 * Two ends of the gradient in the name's hue, and a pastel figure in the
 * opposite one. Lightness stays between 42% and 85% and saturation at half or
 * more, so no name comes out black, white, or a grey that reads as either.
 */
export function palette(name: string): { from: Rgb; to: Rgb; figure: Rgb } {
  const n = hash(name);
  const hue = n % 360;
  // A second draw from the same hash nudges the shade, so neighbouring hues still differ.
  const shade = ((n >>> 9) % 100) / 100;
  return {
    from: rgb(hue, 0.6, 0.7 + shade * 0.06),
    to: rgb((hue + 40) % 360, 0.55, 0.42 + shade * 0.06),
    figure: rgb((hue + 180) % 360, 0.5, 0.85),
  };
}

/** Ordered-dither thresholds, a 4 × 4 Bayer matrix. */
const BAYER = [0, 8, 2, 10, 12, 4, 14, 6, 3, 11, 1, 9, 15, 7, 13, 5];
/**
 * Four shades from one end to the other, in cells big enough to read as a
 * pattern: 20 px across a 480 px picture, 4 px across the 80 px timeline copy.
 * Coarse and few is also what lets both JPEGs fit an upload's limits.
 */
const LEVELS = 4;
const CELLS = 24;
const MIN_CELL = 4;

/**
 * The gradient, top-left to bottom-right, into `out` as RGBA at w × h. Square
 * cells, sized off the width, so a portrait gets more rows, not taller cells.
 */
export function backdrop(name: string, w: number, h: number, out: Uint8Array | Uint8ClampedArray): void {
  const { from, to } = palette(name);
  const cols = Math.max(1, Math.min(CELLS, Math.floor(w / MIN_CELL)));
  const cell = w / cols;
  const rows = Math.ceil(h / cell);
  const span = Math.max(1, cols + rows - 2);
  const shades: Rgb[] = [];
  for (let i = 0; i < LEVELS; i++) {
    const t = i / (LEVELS - 1);
    shades.push([0, 1, 2].map((c) => Math.round(from[c] + (to[c] - from[c]) * t)) as Rgb);
  }
  for (let y = 0; y < h; y++) {
    const cy = Math.floor(y / cell);
    for (let x = 0; x < w; x++) {
      const cx = Math.floor(x / cell);
      const at = ((cx + cy) / span) * (LEVELS - 1);
      const base = Math.floor(at);
      const step = at - base > (BAYER[(cy % 4) * 4 + (cx % 4)] + 0.5) / 16 ? 1 : 0;
      const [r, g, b] = shades[Math.min(LEVELS - 1, base + step)];
      const i = (y * w + x) * 4;
      out[i] = r;
      out[i + 1] = g;
      out[i + 2] = b;
      out[i + 3] = 255;
    }
  }
}
