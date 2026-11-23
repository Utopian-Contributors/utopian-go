/**
 * Snake's rules, one copy for the page (client/snake/game.js wraps it) and
 * the server (src/social/play.ts), which replays every synced game from its
 * turns: a score on the board is one these rules produced, step by step.
 *
 * The snake moves one cell a step. An apple grows it by one, scores 10 and
 * speeds it up. Off one edge it comes back on at the opposite one, so only its
 * own body ends the game. Filling the board ends it too, the best way. Apples
 * land where `rand` says: Math.random offline, the server's seed (seeded())
 * in a game that counts, so the server can place them the same.
 */

export const COLS = 15;
export const ROWS = 23;

/** The snake's first length, and what an apple is worth. */
export const LENGTH = 3;
export const APPLE = 10;

/** Milliseconds a step takes: the first game's pace, the fastest it gets, and what each apple takes off. */
export const SLOWEST = 170;
export const FASTEST = 80;
export const PER_APPLE = 3;

/** The most a game can score: an apple on every free cell. */
export const SNAKE_MAX = (COLS * ROWS - LENGTH) * APPLE;

export type Dir = "up" | "down" | "left" | "right";
export interface Cell {
  x: number;
  y: number;
}

export const DIRS: Record<Dir, [number, number]> = { up: [0, -1], down: [0, 1], left: [-1, 0], right: [1, 0] };
export const BACK: Record<Dir, Dir> = { up: "down", down: "up", left: "right", right: "left" };

export interface SnakeState {
  state: "idle" | "play" | "over";
  /** Head first. */
  snake: Cell[];
  dir: Dir;
  apple: Cell | null;
  score: number;
  /** The cell the tail left on the last step, so it can be drawn leaving it; none when the snake grew. */
  trail: Cell | null;
  /** The apple the last step ate, so it can be drawn going down. */
  eaten: Cell | null;
}

export type Step = "move" | "apple" | "over" | "full";

const same = (a: Cell, b: Cell) => a.x === b.x && a.y === b.y;

/** A free cell at random; none on a full board. */
function place(s: SnakeState, rand: () => number): Cell | null {
  const taken = new Uint8Array(COLS * ROWS);
  for (const cell of s.snake) taken[cell.y * COLS + cell.x] = 1;
  const free: Cell[] = [];
  for (let y = 0; y < ROWS; y++) for (let x = 0; x < COLS; x++) if (!taken[y * COLS + x]) free.push({ x, y });
  return free.length ? free[Math.floor(rand() * free.length)] : null;
}

/**
 * The start of a game: the snake mid-board, laid out behind its head so that
 * any first direction leads away from its body.
 */
export function lay(s: SnakeState, dir: Dir, rand: () => number): void {
  const [dx, dy] = DIRS[dir];
  const x = COLS >> 1;
  const y = ROWS >> 1;
  s.snake = Array.from({ length: LENGTH }, (_, i) => ({ x: x - dx * i, y: y - dy * i }));
  s.dir = dir;
  s.score = 0;
  s.trail = null;
  s.eaten = null;
  s.apple = place(s, rand);
}

export function fresh(): SnakeState {
  return { state: "idle", snake: [], dir: "up", apple: null, score: 0, trail: null, eaten: null };
}

/** How long a step takes at this length. */
export function stepMsAt(length: number): number {
  return Math.max(FASTEST, SLOWEST - PER_APPLE * (length - LENGTH));
}

/** Whether the snake, going `from`, may turn to `to`: a real turn, never back into its neck. */
export function canTurn(from: Dir, to: Dir): boolean {
  return to !== from && to !== BACK[from];
}

/** One step, going `s.dir`. */
export function advance(s: SnakeState, rand: () => number): Step {
  const [dx, dy] = DIRS[s.dir];
  // Over an edge and in at the opposite one.
  const head = { x: (s.snake[0].x + dx + COLS) % COLS, y: (s.snake[0].y + dy + ROWS) % ROWS };
  const ate = !!s.apple && same(head, s.apple);
  // The tail moves out of the way, so its cell is free to step into, unless this step grows.
  const body = ate ? s.snake : s.snake.slice(0, -1);
  if (body.some((cell) => same(cell, head))) {
    s.state = "over";
    return "over";
  }
  s.snake.unshift(head);
  s.eaten = ate ? s.apple : null;
  if (!ate) {
    s.trail = s.snake.pop() ?? null;
    return "move";
  }
  s.trail = null;
  s.score += APPLE;
  s.apple = place(s, rand);
  if (s.apple) return "apple";
  s.state = "over";
  return "full";
}

/**
 * A generator both sides run alike from a seed (hex, the server's): sfc32,
 * whose arithmetic is all 32-bit integers, so a browser and Node give the
 * same numbers.
 */
export function seeded(seed: string): () => number {
  let a = parseInt(seed.slice(0, 8), 16) >>> 0;
  let b = parseInt(seed.slice(8, 16), 16) >>> 0;
  let c = parseInt(seed.slice(16, 24), 16) >>> 0;
  let d = parseInt(seed.slice(24, 32), 16) >>> 0 || 1;
  const next = () => {
    const t = (((a + b) | 0) + d) | 0;
    d = (d + 1) | 0;
    a = b ^ (b >>> 9);
    b = (c + (c << 3)) | 0;
    c = (c << 21) | (c >>> 11);
    c = (c + t) | 0;
    return (t >>> 0) / 4294967296;
  };
  for (let i = 0; i < 12; i++) next();
  return next;
}

/** The letter each direction is sent as, in a synced game's turns ("12u40l": up at step 12, left at 40). */
export const LETTER: Record<Dir, string> = { up: "u", down: "d", left: "l", right: "r" };
export const FROM_LETTER: Record<string, Dir> = { u: "up", d: "down", l: "left", r: "right" };
