/**
 * The background under a profile photo: its owner's dithered gradient.
 *
 * Painted onto the canvas before the photo is drawn and compressed, so where
 * a picture is transparent (a cut-out PNG) it keeps its owner's colours
 * rather than turning white. It is the same gradient the server drew under
 * the account's first picture, from the same code (src/social/backdrop.ts,
 * bundled from there). Fetched when someone picks a profile photo, so no one
 * else downloads it.
 */
import { backdrop } from "../../src/social/backdrop.ts";

/**
 * @param {string} name whose colours
 * @returns {(ctx: CanvasRenderingContext2D, w: number, h: number) => void} paints the whole canvas
 */
function under(name) {
  return (ctx, w, h) => {
    const image = ctx.createImageData(w, h);
    backdrop(name, w, h, image.data);
    ctx.putImageData(image, 0, 0);
  };
}

window.__avatar = { under };
