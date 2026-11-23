/**
 * Snake: the rules, with no page in them. They are src/social/snakeRules.ts,
 * shared with the server, which replays a synced game from its turns; this
 * wraps them in the one game the page plays, with the queue of turns asked
 * for and the log of the turns taken that a synced game sends.
 */
import { BACK, COLS, DIRS, LETTER, ROWS, advance, fresh, lay as layOut, stepMsAt } from "../../src/social/snakeRules.ts";

export { COLS, DIRS, ROWS };

/** Turns held for the steps to come, so two quick ones (a U-turn) both land. */
const QUEUE = 2;

/** @typedef {"up" | "down" | "left" | "right"} Dir */
/** @typedef {{x: number, y: number}} Cell */

export const game = Object.assign(fresh(), {
  /** @type {Dir[]} */
  turns: [],
  /** Steps taken this game. */
  steps: 0,
  /** Turns taken and not yet sent, as "<step><letter>". */
  log: "",
  /** Where apples land: the server's seeded generator in a game that counts. */
  rand: Math.random,
});

/**
 * The start of a game: the snake mid-board, laid out behind its head.
 * @param {Dir} [dir] @param {() => number} [rand]
 */
export function lay(dir = "up", rand = Math.random) {
  game.rand = rand;
  game.turns = [];
  game.steps = 0;
  game.log = "";
  layOut(game, dir, rand);
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
  return stepMsAt(game.snake.length);
}

/** Take the turns not yet sent, for a sync. */
export function takeLog() {
  const log = game.log;
  game.log = "";
  return log;
}

/**
 * One step.
 * @returns {"move" | "apple" | "over" | "full"}
 */
export function step() {
  const next = game.turns.shift();
  if (next && next !== game.dir) {
    game.dir = next;
    game.log += `${game.steps}${LETTER[next]}`;
  }
  game.steps++;
  return advance(game, game.rand);
}
