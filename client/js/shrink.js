/**
 * Pictures are scaled in the browser, before they are uploaded: the server
 * only checks the result, and the aspect ratio is kept by scaling both sides
 * together. The composer, Edit profile and Messenger each bundle this; none of
 * them is on Social's first load.
 */

/**
 * One picture, several JPEGs of it, one per `[edge, byWidth, maxBytes, quality]`.
 *
 * `under` makes it a profile photo. It paints the owner's background
 * (client/avatar) where the picture is transparent, which is white otherwise;
 * and wider than tall is refused before any draw, so every copy keeps the
 * shape the profile shows. Each copy starts at its edge and steps quality
 * down, then size, until it fits.
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
    const out = [];
    next: for (let [edge, byWidth, maxBytes, quality] of sizes) {
      // The timeline face caps width, not the long side, so a portrait stays tall.
      const scale = Math.min(1, edge / (byWidth ? bmp.width : Math.max(bmp.width, bmp.height)));
      let w = Math.max(1, Math.round(bmp.width * scale));
      let h = Math.max(1, Math.round(bmp.height * scale));
      for (let i = 0; i < 12; i++) {
        canvas.width = w;
        canvas.height = h;
        ctx.fillStyle = "#fff";
        ctx.fillRect(0, 0, w, h);
        under?.(ctx, w, h);
        ctx.drawImage(bmp, 0, 0, w, h);
        const blob = await new Promise((resolve) => canvas.toBlob(resolve, "image/jpeg", quality));
        if (blob && blob.size <= maxBytes) {
          out.push(blob);
          continue next;
        }
        if (quality > 0.45) quality = Math.round((quality - 0.1) * 100) / 100;
        else {
          w = Math.max(1, Math.round(w * 0.8));
          h = Math.max(1, Math.round(h * 0.8));
          quality = 0.6;
        }
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
