/**
 * Pictures are scaled in the browser, before they are uploaded: the server
 * only checks the result, and the aspect ratio is kept by scaling both sides
 * together. The composer, Edit profile and Messenger each bundle this; none of
 * them is on Social's first load.
 */

/** Below this on its short side a copy is too small to be worth posting; the photo is refused instead. */
const MIN_EDGE = 48;
/** The lowest JPEG quality tried before a copy is made smaller instead. */
const FLOOR = 0.5;

/**
 * The picture at halves of its size, each drawn from the one above, so the
 * last step to any size is never more than 2x. One draw straight from a 12 or
 * 48 megapixel photo to a few hundred pixels samples a fraction of them, and
 * Safari's does: fine detail turns to noise, which a JPEG holds worst of all,
 * and a phone's photo came out several times the bytes it should.
 */
function pyramid(bmp) {
  const levels = [bmp];
  return (w) => {
    let top = levels[levels.length - 1];
    while (top.width / 2 >= w && top.width >= 2) {
      const half = document.createElement("canvas");
      half.width = Math.max(1, Math.round(top.width / 2));
      half.height = Math.max(1, Math.round(top.height / 2));
      const hc = half.getContext("2d");
      hc.imageSmoothingQuality = "high";
      hc.drawImage(top, 0, 0, half.width, half.height);
      levels.push((top = half));
    }
    // The smallest level still at least as wide as the copy.
    for (let i = levels.length - 1; i > 0; i--) if (levels[i].width >= w) return levels[i];
    return bmp;
  };
}

/**
 * One picture, several JPEGs of it, one per `[edge, byWidth, maxBytes, quality]`.
 *
 * `under` makes it a profile photo. It paints the owner's background
 * (client/avatar) where the picture is transparent, which is white otherwise;
 * and wider than tall is refused before any draw, so every copy keeps the
 * shape the profile shows. Each copy starts at its edge and its quality, steps
 * the quality down to FLOOR, then aims its size at the bytes it may have: a
 * JPEG's bytes go roughly with its pixels, so the next try is scaled by how far
 * over the last one came out. Busy or quiet, a photo fits in a few tries.
 * @param {File} file
 * @param {(ctx: CanvasRenderingContext2D, w: number, h: number) => void} [under]
 * @returns {Promise<Blob[]>}
 */
export async function shrink(file, sizes, under) {
  let bmp;
  try {
    bmp = await createImageBitmap(file, { imageOrientation: "from-image" });
  } catch {
    bmp = await createImageBitmap(file);
  }
  try {
    if (under && bmp.width > bmp.height) throw new Error("Use a square or portrait photo.");
    const canvas = document.createElement("canvas");
    const ctx = canvas.getContext("2d", { alpha: false });
    if (!ctx) throw new Error("Could not read that photo.");
    const source = pyramid(bmp);
    const out = [];
    next: for (let [edge, byWidth, maxBytes, quality] of sizes) {
      // The timeline face caps width, not the long side, so a portrait stays tall.
      const scale = Math.min(1, edge / (byWidth ? bmp.width : Math.max(bmp.width, bmp.height)));
      let w = Math.max(1, Math.round(bmp.width * scale));
      let h = Math.max(1, Math.round(bmp.height * scale));
      while (Math.min(w, h) >= MIN_EDGE) {
        canvas.width = w;
        canvas.height = h;
        ctx.fillStyle = "#fff";
        ctx.fillRect(0, 0, w, h);
        under?.(ctx, w, h);
        ctx.imageSmoothingQuality = "high";
        ctx.drawImage(source(w), 0, 0, w, h);
        const blob = await new Promise((resolve) => canvas.toBlob(resolve, "image/jpeg", quality));
        if (!blob) throw new Error("Could not read that photo.");
        if (blob.size <= maxBytes) {
          out.push(blob);
          continue next;
        }
        if (quality > FLOOR) {
          quality = Math.max(FLOOR, Math.round((quality - 0.12) * 100) / 100);
          continue;
        }
        // Aimed a little under, so the next try lands inside rather than just over.
        const k = Math.min(0.9, Math.sqrt(maxBytes / blob.size) * 0.95);
        w = Math.max(1, Math.round(w * k));
        h = Math.max(1, Math.round(h * k));
      }
      throw new Error("Could not fit that photo.");
    }
    return out;
  } finally {
    bmp.close();
  }
}

/** Two big-endian u32 lengths, the header in front of each pair of JPEGs. */
export function lens(a, b) {
  const view = new DataView(new ArrayBuffer(8));
  view.setUint32(0, a.size);
  view.setUint32(4, b.size);
  return view;
}

/** The Blob holds the parts by reference, so no JPEG is copied to pack it. */
export function bin(parts) {
  return new Blob(parts, { type: "application/octet-stream" });
}
