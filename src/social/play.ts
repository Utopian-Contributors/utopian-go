/**
 * Live games: how a Snake or Pinball score earns its place on the board.
 *
 * Signed in, a game is played under a session the server opens before it
 * starts (start), which the page syncs every couple of seconds while it runs
 * (sync) and closes when it ends (end). Only a game synced from first step to
 * last goes on the board; a game that misses a sync carries on, on the
 * device, and counts there alone.
 *
 * - Snake is replayed. Its apples land where the session's seed says, the
 *   page sends the turns it took, and the server plays the same steps by the
 *   same rules (snakeRules.ts): the score is the replay's, never the page's,
 *   and no game may take its steps faster than the snake can move.
 * - Pinball's physics cannot be replayed here (a browser's floating point is
 *   not the server's), so its score is held to the table's limits instead:
 *   it only grows, by whole tens, and never faster than the table pays out
 *   in the time actually played.
 * - Shotgun has no board, but its credits are banked from a synced game
 *   (shotgun.ts): the wave only climbs, never sooner than its zombies could
 *   arrive, and the credits never past what the waves so far could pay.
 *
 * Sessions live in this process's memory, a few hundred bytes each, one per
 * account, swept once they go quiet. Nothing is written per sync; the board
 * is written once, when a counted game ends. A restart forgets every session,
 * and the games in play then simply do not count.
 */
import { randomBytes } from "crypto";
import { SocialError } from "./limits";
import type { BoardGame } from "./shop";
import { MAX_WAVE, maxEarned, reachMs } from "./shotgun";
import { type Dir, FASTEST, FROM_LETTER, SNAKE_MAX, type SnakeState, advance, canTurn, fresh, lay, seeded, stepMsAt } from "./snakeRules";

/** How often the page syncs, and the longest a game in play may go without one. */
export const SYNC_MS = 2000;
export const GAP_MS = 8000;
/** A paused game (the page hidden, or P pressed) may wait this long. */
export const PAUSE_MS = 15 * 60_000;
/** A session opened but never started is dropped after this. */
const IDLE_MS = 30 * 60_000;
/** Latency, and the steps a page takes before its first sync lands. */
const SLACK_MS = 1500;
const MAX_SESSIONS = 5000;

/** The highest a pinball score can be, and how fast the table can pay it: a jackpot at ×10 at once, then this much a second. */
export const PINBALL_MAX = 2_000_000_000;
export const PINBALL_BURST = 60_000_000;
export const PINBALL_RATE = 1_000_000;
/** Over a whole game, no more than this a second on average, beyond one burst. */
export const PINBALL_AVERAGE = 400_000;

/** A game played under a session: the boards' two, and Shotgun, whose credits are banked. */
export type LiveGame = BoardGame | "shotgun";

interface Session {
  id: string;
  name: string;
  game: LiveGame;
  /** Snake: the seed its apples come from. */
  seed: string;
  made: number;
  /** When its first sync arrived; null before. */
  started: number | null;
  last: number;
  paused: boolean;
  pausedMs: number;
  /** Snake: the replay, its steps, and the least time they could have taken. */
  sim: SnakeState | null;
  rand: (() => number) | null;
  steps: number;
  minMs: number;
  /** The score as last synced. */
  score: number;
  /** Pinball: play time at the last sync, for the rate. */
  playedAt: number;
  /** Shotgun: the wave in play, and the kit's multiplier, taken from the bank as the game starts. */
  wave: number;
  mult: number;
}

const sessions = new Map<string, Session>();
const byName = new Map<string, string>();
let swept = 0;

function sweep(now: number): void {
  if (now - swept < 30_000 && sessions.size < MAX_SESSIONS) return;
  swept = now;
  for (const s of sessions.values()) {
    const quiet = s.started == null ? now - s.made > IDLE_MS : now - s.last > (s.paused ? PAUSE_MS : GAP_MS);
    if (quiet) drop(s);
  }
}

function drop(s: Session): void {
  sessions.delete(s.id);
  if (byName.get(s.name) === s.id) byName.delete(s.name);
}

/** How many games are open, for tests and a glance at memory. */
export function openSessions(): number {
  return sessions.size;
}

/** Forget every session (tests). */
export function resetSessions(): void {
  sessions.clear();
  byName.clear();
  swept = 0;
}

/**
 * A new session for `name`'s next game; any other of theirs ends uncounted.
 * `apples` is Snake's apple seed: the page needs it to play, and knowing
 * where apples will fall plays no game for anyone. (Not called `seed`: every
 * `seed` is scrubbed from every answer by guard.ts.)
 */
export function startSession(name: string, game: LiveGame, now = Date.now()): { id: string; apples: string; every: number } {
  sweep(now);
  const old = byName.get(name);
  if (old) drop(sessions.get(old)!);
  if (sessions.size >= MAX_SESSIONS) throw new SocialError(503, "Too many games at once. Try again in a minute.");
  const s: Session = {
    id: randomBytes(16).toString("base64url"),
    name,
    game,
    seed: randomBytes(16).toString("hex"),
    made: now,
    started: null,
    last: now,
    paused: false,
    pausedMs: 0,
    sim: null,
    rand: null,
    steps: 0,
    minMs: 0,
    score: 0,
    playedAt: 0,
    wave: 0,
    mult: 1,
  };
  sessions.set(s.id, s);
  byName.set(name, s.id);
  return { id: s.id, apples: s.seed, every: SYNC_MS };
}

/** A session that no longer counts: dropped, and the page told why (409, `broken`). */
function broken(s: Session, why: string): never {
  drop(s);
  throw new SocialError(409, why, { broken: true });
}

function sessionOf(name: string, game: LiveGame, id: unknown): Session {
  const s = typeof id === "string" ? sessions.get(id) : undefined;
  // Someone else's, or gone: the same answer, so an id tells nobody anything.
  if (!s || s.name !== name || s.game !== game) throw new SocialError(409, "This game isn’t synced any more.", { broken: true });
  return s;
}

/** Milliseconds actually played: since the first sync, less the time paused. */
const played = (s: Session, now: number) => now - (s.started ?? now) - s.pausedMs;

const TURNS = /^(?:\d{1,6}[udlr]){0,400}$/;

/** Play the snake on from the last sync to step `k`, taking the turns in `log`. */
function replay(s: Session, k: unknown, log: unknown, now: number): void {
  if (!Number.isSafeInteger(k) || (k as number) < s.steps) broken(s, "That game went backwards.");
  if (typeof log !== "string" || !TURNS.test(log)) broken(s, "Those turns make no sense.");
  const to = k as number;
  // Before any work: steps that could not fit in the time played, at the snake's fastest.
  if ((to - s.steps) * FASTEST > played(s, now) - s.minMs + SLACK_MS) broken(s, "That snake moved faster than snakes can.");
  const turns = new Map<number, Dir>();
  let after = s.steps - 1;
  for (const [, n, letter] of log.matchAll(/(\d+)([udlr])/g)) {
    const at = Number(n);
    if (at <= after || at >= to) broken(s, "Those turns make no sense.");
    turns.set(at, FROM_LETTER[letter]);
    after = at;
  }
  const sim = s.sim!;
  for (let i = s.steps; i < to; i++) {
    if (sim.state === "over") broken(s, "That game had already ended.");
    const dir = turns.get(i);
    if (dir) {
      if (!canTurn(sim.dir, dir)) broken(s, "That snake turned back on itself.");
      sim.dir = dir;
    }
    s.minMs += stepMsAt(sim.snake.length);
    advance(sim, s.rand!);
  }
  s.steps = to;
  if (s.minMs > played(s, now) + SLACK_MS) broken(s, "That snake moved faster than snakes can.");
  s.score = sim.score;
}

/** A pinball score as synced: only up, by tens, and no faster than the table pays. */
function bound(s: Session, score: unknown, now: number): void {
  if (!Number.isSafeInteger(score) || (score as number) % 10 || (score as number) < s.score || (score as number) > PINBALL_MAX) {
    broken(s, "That is not a pinball score.");
  }
  const total = played(s, now) + SLACK_MS;
  const window = total - s.playedAt;
  const gained = (score as number) - s.score;
  if (gained > PINBALL_BURST + (PINBALL_RATE * window) / 1000 || (score as number) > PINBALL_BURST + (PINBALL_AVERAGE * total) / 1000) {
    broken(s, "That score came faster than the table pays.");
  }
  s.score = score as number;
  s.playedAt = Math.max(0, total - SLACK_MS);
}

/** A Shotgun game as synced: the wave only up, no sooner than it can come, and the credits within what the waves pay. */
function boundShotgun(s: Session, wave: unknown, earned: unknown, now: number): void {
  if (!Number.isSafeInteger(wave) || (wave as number) < s.wave || (wave as number) > MAX_WAVE) broken(s, "That is not a wave.");
  if (!Number.isSafeInteger(earned) || (earned as number) < s.score) broken(s, "Those are not the game’s credits.");
  if (reachMs(wave as number) > played(s, now) + SLACK_MS) broken(s, "That wave came sooner than zombies can.");
  if ((earned as number) > maxEarned(wave as number)) broken(s, "Those waves don’t pay that much.");
  s.wave = wave as number;
  s.score = earned as number;
}

/**
 * Whether `id` is `name`'s Shotgun session and its game has yet to start:
 * the first sync is when the bank's kit is spent on it (setMult).
 */
export function unstarted(name: string, id: unknown): boolean {
  const s = typeof id === "string" ? sessions.get(id) : undefined;
  return !!s && s.name === name && s.game === "shotgun" && s.started == null;
}

/** The multiplier a Shotgun game's credits are banked at, as its kit had it. */
export function setMult(id: string, mult: number): void {
  const s = sessions.get(id);
  if (s) s.mult = mult;
}

/**
 * A sync: {id, p?, ...} with, for Snake, `k` (steps taken), `t` (the turns
 * since the last sync) and on the first, `d` (the first direction); for
 * Pinball, `s` (the score); for Shotgun, `w` (the wave) and `e` (the credits
 * earned, before the multiplier). `p: 1` says the game is paused until the next.
 */
export function syncSession(name: string, game: LiveGame, body: Record<string, unknown>, now = Date.now()): { score: number } {
  const s = sessionOf(name, game, body.id);
  if (s.started == null) {
    s.started = now;
    if (game === "snake") {
      const d = typeof body.d === "string" ? FROM_LETTER[body.d] : undefined;
      if (!d) broken(s, "Which way did it start?");
      s.rand = seeded(s.seed);
      s.sim = fresh();
      lay(s.sim, d, s.rand);
      s.sim.state = "play";
    }
  } else if (now - s.last > (s.paused ? PAUSE_MS : GAP_MS)) {
    broken(s, "A sync was missed, so this game no longer counts.");
  } else if (s.paused) {
    s.pausedMs += now - s.last;
  }
  if (game === "snake") replay(s, body.k, body.t ?? "", now);
  else if (game === "shotgun") boundShotgun(s, body.w, body.e, now);
  else bound(s, body.s, now);
  s.paused = body.p === 1;
  s.last = now;
  return { score: s.score };
}

/**
 * The end of a game: the last sync, then the score it counts with, if it
 * counts. A snake has to have died (or filled the board) where the replay
 * says it did. The session is gone after this either way.
 */
export function endSession(name: string, game: BoardGame, body: Record<string, unknown>, now = Date.now()): number {
  const { score } = syncSession(name, game, { ...body, p: 0 }, now);
  const s = sessions.get(body.id as string)!;
  drop(s);
  if (game === "snake") {
    if (s.sim?.state !== "over") throw new SocialError(409, "That game hasn’t ended.", { broken: true });
    if (score > SNAKE_MAX) throw new SocialError(409, "That is not a snake score.", { broken: true });
  }
  if (body.s !== undefined && body.s !== score) throw new SocialError(409, "That score isn’t the game’s.", { broken: true });
  return score;
}

/**
 * The end of a Shotgun game: the last sync, then what it banks: its credits
 * times the kit's multiplier, and the wave it reached. The session is gone
 * after this either way.
 */
export function endShotgun(name: string, body: Record<string, unknown>, now = Date.now()): { earned: number; wave: number; banked: number } {
  syncSession(name, "shotgun", { ...body, p: 0 }, now);
  const s = sessions.get(body.id as string)!;
  drop(s);
  return { earned: s.score, wave: s.wave, banked: Math.floor(s.score * s.mult) };
}
