/**
 * The picture a new account starts with: a head and shoulders over the
 * person's own dithered gradient (./backdrop.ts), a face without being
 * anyone's.
 *
 * Drawn once, at sign-up, into the same two files an upload writes, and from
 * then on only ever served from disk: nothing draws it again on a request,
 * and an upload replaces it like any other photo.
 */
import sharp from "sharp";
import { backdrop, palette, type Rgb } from "./backdrop";
import { SOCIAL_BYTES, TINY_BYTES } from "./limits";

const css = ([r, g, b]: Rgb) => `rgb(${r},${g},${b})`;

/** One square, stepped down in quality until it fits, as the browser's own shrink does. */
async function draw(name: string, size: number, maxBytes: number): Promise<Buffer> {
  const pixels = Buffer.alloc(size * size * 4);
  backdrop(name, size, size, pixels);
  const figure = css(palette(name).figure);
  // Laid out at 480 and scaled, so the timeline copy is the same figure.
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="${size}" height="${size}" viewBox="0 0 480 480">
    <circle cx="240" cy="200" r="92" fill="${figure}"/>
    <path d="M70 480c10-110 80-170 170-170s160 60 170 170z" fill="${figure}"/>
  </svg>`;
  for (let quality = 88; quality >= 40; quality -= 8) {
    const out = await sharp(pixels, { raw: { width: size, height: size, channels: 4 } })
      .composite([{ input: Buffer.from(svg) }])
      .jpeg({ quality, mozjpeg: true })
      .toBuffer();
    if (out.length <= maxBytes) return out;
  }
  throw new Error(`avatar: a ${size}px picture does not fit in ${maxBytes} bytes`);
}

/** The profile copy (480 px) and the timeline copy (80 px), within an upload's limits. */
export async function drawAvatar(name: string): Promise<{ full: Buffer; tiny: Buffer }> {
  const [full, tiny] = await Promise.all([draw(name, 480, SOCIAL_BYTES), draw(name, 80, TINY_BYTES)]);
  return { full, tiny };
}
