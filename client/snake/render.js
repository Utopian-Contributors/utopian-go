/**
 * Snake, drawn: a checked field in the system's theme, a step darker than the
 * page in either so its edges always show, and on it the snake, the logo's
 * green with yellow eyes in both, and the app's skeu-icons apple. The field's
 * cells are a whole number of device pixels so every edge lands on one and
 * stays sharp.
 *
 * The snake is one body through its cells' centres, drawn part of the way
 * through its last step: the head that far into the cell it went to, the tail
 * that far out of the one it left. So it slides from cell to cell, a step
 * behind the rules at most, and a turn shows at the centre of the next cell,
 * which is where the rules make it.
 */
import APPLE_ART from "../ic-apple.svg";
import { COLS, ROWS, game } from "./game.js";

/** @typedef {import("./game.js").Cell} Cell */

/** Each theme's field, and what has to change with it to stay visible. */
const THEMES = {
  light: { field: "#eceadc", check: "#e3e1d1", pupil: "#202124" },
  dark: { field: "#1d181a", check: "#241e21", pupil: "#1d181a" },
};

/** The system's theme; snake/main.js redraws when it changes. */
export const dark = matchMedia("(prefers-color-scheme: dark)");

const GREEN = "#3cc316";
const EYE = "#ffe14d";

/** In cells: how wide the body is, short of a cell so a snake folded on itself still shows its folds; the head's radius, a little wider; and the apple. */
const BODY = 0.78;
const HEAD = 0.45;
const APPLE = 0.92;

/** The apple's drawing, given a size of its own, which some browsers need before they draw an SVG on a canvas. */
const art = new Image();
/** Settles once the apple can be drawn; snake/main.js draws the board again then. */
export const ready = new Promise((done) => art.addEventListener("load", done, { once: true }));
art.src = `data:image/svg+xml,${encodeURIComponent(APPLE_ART.replace("<svg ", '<svg width="128" height="128" '))}`;

/** The apple drawn once at the cell's size, then stamped. @type {HTMLCanvasElement | null} */
let stamp = null;

/** Device pixels: a cell, and the room left of the field. The field sits at the top of the canvas. */
let cell = 1;
let left = 0;
let width = 0;
let height = 0;

/** @param {number} w @param {number} h the canvas, in device pixels */
export function fit(w, h) {
  width = w;
  height = h;
  cell = Math.max(1, Math.floor(Math.min(w / COLS, h / ROWS)));
  left = Math.floor((w - cell * COLS) / 2);
  stamp = null;
}

/** A point in cells to device pixels, at the centre of its cell. @param {Cell} p */
const px = (p) => left + (p.x + 0.5) * cell;
const py = (p) => (p.y + 0.5) * cell;

/** @param {CanvasRenderingContext2D} ctx @param {number} x @param {number} y @param {number} r */
function dot(ctx, x, y, r) {
  ctx.beginPath();
  ctx.arc(x, y, r, 0, Math.PI * 2);
  ctx.fill();
}

/** @param {CanvasRenderingContext2D} ctx @param {typeof THEMES.light} theme */
function field(ctx, theme) {
  ctx.fillStyle = theme.field;
  ctx.fillRect(left, 0, cell * COLS, cell * ROWS);
  ctx.fillStyle = theme.check;
  for (let y = 0; y < ROWS; y++) {
    for (let x = (y + 1) % 2; x < COLS; x += 2) ctx.fillRect(left + x * cell, y * cell, cell, cell);
  }
}

/** @param {CanvasRenderingContext2D} ctx @param {Cell} at @param {number} [size] 0 to 1, as it grows in or goes down */
function apple(ctx, at, size = 1) {
  if (!stamp && art.complete && art.naturalWidth) {
    stamp = document.createElement("canvas");
    stamp.width = stamp.height = Math.round(cell * APPLE);
    /** @type {CanvasRenderingContext2D} */ (stamp.getContext("2d")).drawImage(art, 0, 0, stamp.width, stamp.height);
  }
  if (!stamp || size <= 0) return;
  const w = stamp.width * size;
  // Whole pixels at full size, so it stays as sharp as it was drawn.
  const x = px(at) - w / 2;
  const y = py(at) - w / 2;
  if (size < 1) ctx.drawImage(stamp, x, y, w, w);
  else ctx.drawImage(stamp, Math.round(x), Math.round(y));
}

/** The way from a cell to the one next to it, the short way round where the snake crossed an edge. @param {Cell} a @param {Cell} b */
function toward(a, b) {
  const dx = b.x - a.x;
  const dy = b.y - a.y;
  return [dx > 1 ? dx - COLS : dx < -1 ? dx + COLS : dx, dy > 1 ? dy - ROWS : dy < -1 ? dy + ROWS : dy];
}

/**
 * The snake t of the way through its last step, in cells: lines through its
 * cells' centres from the head back to the tail. Where it crosses an edge one
 * line runs on a cell past that edge and the next starts a cell short of the
 * other, so no point is more than a cell off the field.
 * @param {number} t
 */
function body(t) {
  const s = game.snake;
  const [hx, hy] = toward(s[1], s[0]);
  const head = { x: s[1].x + hx * t, y: s[1].y + hy * t };
  /** @type {Cell[][]} */
  const lines = [[head, s[1]]];
  for (let i = 1; i < s.length - 1; i++) {
    const [dx, dy] = toward(s[i], s[i + 1]);
    const on = { x: s[i].x + dx, y: s[i].y + dy };
    lines.at(-1).push(on);
    if (on.x !== s[i + 1].x || on.y !== s[i + 1].y) lines.push([{ x: s[i + 1].x - dx, y: s[i + 1].y - dy }, s[i + 1]]);
  }
  if (game.trail) {
    const tail = s.at(-1);
    const [dx, dy] = toward(tail, game.trail);
    lines.at(-1).push({ x: tail.x + dx * (1 - t), y: tail.y + dy * (1 - t) });
  }
  return { head, look: [hx, hy], lines };
}

/** The two eyes, yellow, near the front of the head and looking the way it goes. */
function eyes(ctx, cx, cy, [fx, fy], theme) {
  for (const side of [-1, 1]) {
    const x = cx + fx * cell * 0.12 - fy * side * cell * 0.22;
    const y = cy + fy * cell * 0.12 + fx * side * cell * 0.22;
    ctx.fillStyle = EYE;
    dot(ctx, x, y, cell * 0.19);
    ctx.fillStyle = theme.pupil;
    dot(ctx, x + fx * cell * 0.08, y + fy * cell * 0.08, cell * 0.07);
  }
}

/** @param {CanvasRenderingContext2D} ctx @param {number} t @param {typeof THEMES.light} theme */
function snake(ctx, t, theme) {
  const { head, look, lines } = body(t);
  // What runs over an edge is drawn again a board over, so it comes in at the opposite one.
  const points = lines.flat();
  const xs = [0];
  const ys = [0];
  if (points.some((p) => p.x < 0)) xs.push(COLS * cell);
  if (points.some((p) => p.x > COLS - 1)) xs.push(-COLS * cell);
  if (points.some((p) => p.y < 0)) ys.push(ROWS * cell);
  if (points.some((p) => p.y > ROWS - 1)) ys.push(-ROWS * cell);
  const shifts = xs.flatMap((x) => ys.map((y) => [x, y]));

  ctx.save();
  ctx.beginPath();
  ctx.rect(left, 0, cell * COLS, cell * ROWS);
  ctx.clip();
  ctx.beginPath();
  for (const [sx, sy] of shifts) {
    for (const line of lines) {
      ctx.moveTo(px(line[0]) + sx, py(line[0]) + sy);
      for (const p of line.slice(1)) ctx.lineTo(px(p) + sx, py(p) + sy);
    }
  }
  ctx.strokeStyle = GREEN;
  ctx.lineWidth = cell * BODY;
  ctx.lineCap = "round";
  ctx.lineJoin = "round";
  ctx.stroke();
  // The head over all of the body.
  for (const [sx, sy] of shifts) {
    ctx.fillStyle = GREEN;
    dot(ctx, px(head) + sx, py(head) + sy, cell * HEAD);
    eyes(ctx, px(head) + sx, py(head) + sy, look, theme);
  }
  ctx.restore();
}

/**
 * The whole board.
 * @param {CanvasRenderingContext2D} ctx
 * @param {number} [t] how far through its last step the snake is, 0 to 1
 * @param {boolean} [hide] leave the snake out: it blinks as it dies
 */
export function draw(ctx, t = 1, hide = false) {
  const theme = THEMES[dark.matches ? "dark" : "light"];
  ctx.clearRect(0, 0, width, height);
  field(ctx, theme);
  // An apple just eaten goes down as the head goes over it, and the next one grows in meanwhile.
  if (game.eaten && t < 1) apple(ctx, game.eaten, 1 - t);
  if (game.apple) apple(ctx, game.apple, game.eaten ? 1 - (1 - t) ** 2 : 1);
  if (!hide) snake(ctx, t, theme);
}
