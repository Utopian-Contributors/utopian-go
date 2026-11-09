/**
 * Snake: the rules, with no page in them. One fixed board for everyone, so
 * every score on the leaderboard was played on the same one; src/social/routes.ts
 * works the highest possible score out of it, and has to be told if it changes.
 *
 * The snake moves one cell a step. An apple grows it by one, scores 10 and
 * speeds it up. Off one edge it comes back on at the opposite one, so only its
 * own body ends the game. Filling the board ends it too, the best way.
 */

export const COLS = 15;
export const ROWS = 23;

/** The snake's first length, and what an apple is worth. */
const LENGTH = 3;
const APPLE = 10;

/** Milliseconds a step takes: the first game's pace, the fastest it gets, and what each apple takes off. */
const SLOWEST = 170;
const FASTEST = 80;
const PER_APPLE = 3;

/** Turns held for the steps to come, so two quick ones (a U-turn) both land. */
const QUEUE = 2;

/** @typedef {"up" | "down" | "left" | "right"} Dir */
/** @typedef {{x: number, y: number}} Cell */

/** @type {Record<Dir, [number, number]>} */
export const DIRS = { up: [0, -1], down: [0, 1], left: [-1, 0], right: [1, 0] };

/** @type {Record<Dir, Dir>} */
const BACK = { up: "down", down: "up", left: "right", right: "left" };

export const game = {
  /** @type {"idle" | "play" | "over"} */
  state: "idle",
  /** Head first. @type {Cell[]} */
  snake: [],
  /** @type {Dir} */
  dir: "up",
  /** @type {Dir[]} */
  turns: [],
  /** @type {Cell | null} */
  apple: null,
  score: 0,
  /** The cell the tail left on the last step, so it can be drawn leaving it; none when the snake grew. @type {Cell | null} */
  trail: null,
  /** The apple the last step ate, so it can be drawn going down. @type {Cell | null} */
  eaten: null,
};

/** @param {Cell} a @param {Cell} b */
const same = (a, b) => a.x === b.x && a.y === b.y;

/** A free cell at random; none on a full board. */
function place(rand) {
  const free = [];
  for (let y = 0; y < ROWS; y++) {
    for (let x = 0; x < COLS; x++) {
      if (!game.snake.some((cell) => cell.x === x && cell.y === y)) free.push({ x, y });
    }
  }
  return free.length ? free[Math.floor(rand() * free.length)] : null;
}

/**
 * The start of a game: the snake mid-board, laid out behind its head so that
 * any first direction leads away from its body.
 * @param {Dir} dir
 * @param {() => number} rand
 */
export function lay(dir = "up", rand = Math.random) {
  const [dx, dy] = DIRS[dir];
  const x = COLS >> 1;
  const y = ROWS >> 1;
  game.snake = Array.from({ length: LENGTH }, (_, i) => ({ x: x - dx * i, y: y - dy * i }));
  game.dir = dir;
  game.turns = [];
  game.score = 0;
  game.trail = null;
  game.eaten = null;
  game.apple = place(rand);
}

/** @param {Dir} dir @param {() => number} [rand] */
export function newGame(dir, rand) {
  lay(dir, rand);
  game.state = "play";
}

/**
 * A turn, for the steps to come. It is judged against the last turn asked for,
 * not the way the snake is going now: two quick turns inside one step would
 * otherwise add up to reversing into its own neck.
 * @param {Dir} dir
 */
export function turn(dir) {
  const last = game.turns.at(-1) ?? game.dir;
  if (dir === last || dir === BACK[last] || game.turns.length >= QUEUE) return;
  game.turns.push(dir);
}

/** How long this step takes. */
export function stepMs() {
  return Math.max(FASTEST, SLOWEST - PER_APPLE * (game.snake.length - LENGTH));
}

/**
 * One step.
 * @param {() => number} [rand]
 * @returns {"move" | "apple" | "over" | "full"}
 */
export function step(rand = Math.random) {
  game.dir = game.turns.shift() ?? game.dir;
  const [dx, dy] = DIRS[game.dir];
  // Over an edge and in at the opposite one.
  const head = { x: (game.snake[0].x + dx + COLS) % COLS, y: (game.snake[0].y + dy + ROWS) % ROWS };
  const ate = !!game.apple && same(head, game.apple);
  // The tail moves out of the way, so its cell is free to step into, unless this step grows.
  const body = ate ? game.snake : game.snake.slice(0, -1);
  if (body.some((cell) => same(cell, head))) {
    game.state = "over";
    return "over";
  }
  game.snake.unshift(head);
  game.eaten = ate ? game.apple : null;
  if (!ate) {
    game.trail = game.snake.pop() ?? null;
    return "move";
  }
  game.trail = null;
  game.score += APPLE;
  game.apple = place(rand);
  if (game.apple) return "apple";
  game.state = "over";
  return "full";
}
