/**
 * Just enough of a JPEG to know its pixel size.
 *
 * The upload is already compressed in the browser. This only reports the
 * pixel size. Profile photos refuse a landscape file; post photos do not.
 * Parsing the SOF marker is the whole decoder — we never need the pixels.
 */

export function jpegSize(buf: Buffer): { w: number; h: number } | null {
  if (buf.length < 4 || buf[0] !== 0xff || buf[1] !== 0xd8) return null;
  let i = 2;
  while (i + 3 < buf.length) {
    if (buf[i] !== 0xff) return null;
    while (i < buf.length && buf[i] === 0xff) i++;
    if (i >= buf.length) return null;
    const marker = buf[i++];
    // Standalone markers. SOF, which is what we want, is not one of them.
    if (marker === 0xd8 || marker === 0x01 || (marker >= 0xd0 && marker <= 0xd9)) {
      if (marker === 0xd9) return null;
      continue;
    }
    if (i + 1 >= buf.length) return null;
    const len = buf.readUInt16BE(i);
    if (len < 2 || i + len > buf.length) return null;
    // Baseline, extended, progressive. A phone photo can be any of the three.
    if (marker === 0xc0 || marker === 0xc1 || marker === 0xc2) {
      if (len < 7) return null;
      const h = buf.readUInt16BE(i + 3);
      const w = buf.readUInt16BE(i + 5);
      if (w < 1 || h < 1) return null;
      return { w, h };
    }
    if (marker === 0xda) return null;
    i += len;
  }
  return null;
}
