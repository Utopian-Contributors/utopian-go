/**
 * Snake, drawn: square cells on a checked field in the system's theme, a step
 * darker than the page in either so its edges, the walls, always show. The
 * snake is the logo's green with yellow eyes in both. Cells are a whole number
 * of device pixels so every edge lands on one and stays sharp.
 */
import { COLS, DIRS, ROWS, game } from "./game.js";

/** Each theme's field, and what has to change with it to stay visible. */
const THEMES = {
  light: { field: "#eceadc", check: "#e3e1d1", pupil: "#202124", leaf: "#39a11c" },
  dark: { field: "#1d181a", check: "#241e21", pupil: "#1d181a", leaf: "#75ffbe" },
};

/** The system's theme; snake/main.js redraws when it changes. */
export const dark = matchMedia("(prefers-color-scheme: dark)");

const GREEN = "#3cc316";
const EYE = "#ffe14d";
const APPLE = "#e53935";
const SHINE = "#ff8f85";

/** Device pixels: a cell, the room left of the field, and the gap between a snake's squares. The field sits at the top of the canvas. */
let cell = 1;
let left = 0;
let gap = 1;
let width = 0;
let height = 0;

/** @param {number} w @param {number} h the canvas, in device pixels */
export function fit(w, h) {
  width = w;
  height = h;
  cell = Math.max(1, Math.floor(Math.min(w / COLS, h / ROWS)));
  left = Math.floor((w - cell * COLS) / 2);
  gap = Math.max(1, Math.round(cell * 0.05));
}

/** @param {CanvasRenderingContext2D} ctx @param {number} x @param {number} y @param {number} w @param {number} h @param {number} r */
function round(ctx, x, y, w, h, r) {
  ctx.beginPath();
  ctx.moveTo(x + r, y);
  ctx.arcTo(x + w, y, x + w, y + h, r);
  ctx.arcTo(x + w, y + h, x, y + h, r);
  ctx.arcTo(x, y + h, x, y, r);
  ctx.arcTo(x, y, x + w, y, r);
  ctx.closePath();
}

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

/** @param {CanvasRenderingContext2D} ctx @param {{x: number, y: number}} at @param {typeof THEMES.light} theme */
function apple(ctx, at, theme) {
  const x = left + (at.x + 0.5) * cell;
  const y = (at.y + 0.54) * cell;
  ctx.fillStyle = APPLE;
  dot(ctx, x, y, cell * 0.36);
  ctx.fillStyle = SHINE;
  dot(ctx, x - cell * 0.12, y - cell * 0.12, cell * 0.08);
  ctx.fillStyle = theme.leaf;
  ctx.beginPath();
  ctx.ellipse(x + cell * 0.11, y - cell * 0.37, cell * 0.14, cell * 0.07, -0.5, 0, Math.PI * 2);
  ctx.fill();
}

/** The two eyes, yellow, near the front of the head and looking the way it goes. */
function eyes(ctx, head, theme) {
  const [fx, fy] = DIRS[game.dir];
  const cx = left + (head.x + 0.5) * cell;
  const cy = (head.y + 0.5) * cell;
  for (const side of [-1, 1]) {
    const x = cx + fx * cell * 0.12 - fy * side * cell * 0.22;
    const y = cy + fy * cell * 0.12 + fx * side * cell * 0.22;
    ctx.fillStyle = EYE;
    dot(ctx, x, y, cell * 0.19);
    ctx.fillStyle = theme.pupil;
    dot(ctx, x + fx * cell * 0.08, y + fy * cell * 0.08, cell * 0.07);
  }
}

/** @param {CanvasRenderingContext2D} ctx @param {typeof THEMES.light} theme */
function snake(ctx, theme) {
  // Tail first, so the head is drawn over the body.
  ctx.fillStyle = GREEN;
  for (let i = game.snake.length - 1; i >= 0; i--) {
    const seg = game.snake[i];
    round(ctx, left + seg.x * cell + gap, seg.y * cell + gap, cell - gap * 2, cell - gap * 2, cell * (i ? 0.16 : 0.26));
    ctx.fill();
  }
  eyes(ctx, game.snake[0], theme);
}

/**
 * The whole board.
 * @param {CanvasRenderingContext2D} ctx
 * @param {boolean} [hide] leave the snake out: it blinks as it dies
 */
export function draw(ctx, hide = false) {
  const theme = THEMES[dark.matches ? "dark" : "light"];
  ctx.clearRect(0, 0, width, height);
  field(ctx, theme);
  if (game.apple) apple(ctx, game.apple, theme);
  if (!hide) snake(ctx, theme);
}
