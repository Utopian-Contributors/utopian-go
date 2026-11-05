/**
 * Scores, offline first. Every finished game is kept on this device, and the
 * device's own list is the one the page shows first: it needs no network and
 * no account. The shared leaderboard is a copy of the server's, kept here too
 * so it reads offline, and refreshed whenever the network answers.
 *
 * Signed in, the device's best game not yet on the board waits here as
 * `pending` until a post succeeds: on the next load, the next game, or the
 * moment the browser says it is back online.
 */

const MINE = "ug.pb";
const BOARD = "ug.pbb";
const API = "/api/social/pinball";
const KEEP = 10;

/** @typedef {{score: number, at: number}} Game */
/** @typedef {{games: Game[], pending: number}} Mine */
/** @typedef {{top: {name: string, score: number}[], best: number, at: number}} Board */

function read(key, fallback) {
  try {
    const raw = localStorage.getItem(key);
    return raw ? JSON.parse(raw) : fallback;
  } catch {
    return fallback;
  }
}

function write(key, value) {
  try {
    localStorage.setItem(key, JSON.stringify(value));
  } catch {
    // Private mode or a full quota: the list lives as long as the page does.
  }
}

/** @returns {Mine} */
export function mine() {
  const m = read(MINE, null);
  return { games: Array.isArray(m?.games) ? m.games.filter((g) => Number.isInteger(g?.score)) : [], pending: Number.isInteger(m?.pending) ? m.pending : 0 };
}

/** @returns {Board | null} */
export function board() {
  const b = read(BOARD, null);
  return b && Array.isArray(b.top) ? b : null;
}

/** This device's best game; 0 before its first. */
export function best() {
  return mine().games[0]?.score ?? 0;
}

/**
 * A finished game, kept on this device; a new best waits to go on the board.
 * @param {number} score
 * @param {boolean} signed
 */
export function record(score, signed) {
  const m = mine();
  if (score > 0) {
    m.games.push({ score, at: Date.now() });
    m.games.sort((a, b) => b.score - a.score || a.at - b.at);
    m.games = m.games.slice(0, KEEP);
  }
  if (signed && score > m.pending && score >= (board()?.best ?? 0)) m.pending = score;
  write(MINE, m);
}

/**
 * Bring the board up to date: post a pending best if there is one and the
 * account will take it, then read the board. Resolves to the board, the fresh
 * one or the kept one, and whether it is fresh.
 *
 * @param {boolean} signed
 * @returns {Promise<{board: Board | null, live: boolean, refused: boolean}>}
 */
export async function sync(signed) {
  let refused = false;
  const m = mine();
  if (signed && m.pending) {
    try {
      const res = await fetch(API, {
        method: "POST",
        headers: { "Content-Type": "application/json", Accept: "application/json" },
        body: JSON.stringify({ score: m.pending }),
      });
      if (res.ok) {
        write(MINE, { ...mine(), pending: 0 });
        return { board: keepBoard(await res.json()), live: true, refused };
      }
      // Signed out on the server, or no passkey yet: the score stays here.
      if (res.status === 401 || res.status === 403) refused = true;
      // A score the server will never take is not worth trying again.
      else if (res.status === 400) write(MINE, { ...mine(), pending: 0 });
    } catch {
      return { board: board(), live: false, refused };
    }
  }
  try {
    const res = await fetch(API, { headers: { Accept: "application/json" } });
    if (res.ok) return { board: keepBoard(await res.json()), live: true, refused };
  } catch {
    // Offline: the copy below.
  }
  return { board: board(), live: false, refused };
}

/** @param {any} data */
function keepBoard(data) {
  const b = { top: Array.isArray(data?.top) ? data.top : [], best: Number(data?.best) || 0, at: Date.now() };
  write(BOARD, b);
  return b;
}
