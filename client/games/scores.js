/**
 * A game's scores, offline first. Every finished game is kept on this device,
 * and the device's own list is the one the page shows first: it needs no
 * network and no account. The shared leaderboard is a copy of the server's,
 * kept here too so it reads offline, and refreshed whenever the network
 * answers.
 *
 * Nothing here posts a score. A game reaches the board only by being played
 * in sync with the server (live.js, src/social/play.ts); a game played
 * offline stays on this device.
 */

const KEEP = 10;

/** @typedef {{score: number, at: number}} Game */
/** @typedef {{games: Game[]}} Mine */
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

/**
 * One game's scores.
 *
 * @param {string} key where this device keeps them; the board copy is `${key}b`
 * @param {string} game the API's name for it, /api/social/<game>
 */
export function scores(key, game) {
  const boardKey = `${key}b`;
  const api = `/api/social/${game}`;

  /** @returns {Mine} */
  function mine() {
    const m = read(key, null);
    return { games: Array.isArray(m?.games) ? m.games.filter((g) => Number.isInteger(g?.score)) : [] };
  }

  /** @returns {Board | null} */
  function board() {
    const b = read(boardKey, null);
    return b && Array.isArray(b.top) ? b : null;
  }

  /** This device's best game; 0 before its first. */
  function best() {
    return mine().games[0]?.score ?? 0;
  }

  /**
   * A finished game, kept on this device.
   * @param {number} score
   */
  function record(score) {
    const m = mine();
    if (score <= 0) return;
    m.games.push({ score, at: Date.now() });
    m.games.sort((a, b) => b.score - a.score || a.at - b.at);
    write(key, { games: m.games.slice(0, KEEP) });
  }

  /** @param {any} data @param {number} at */
  function keepBoard(data, at) {
    const b = { top: Array.isArray(data?.top) ? data.top : [], best: Number(data?.best) || 0, at };
    write(boardKey, b);
    return b;
  }

  /** The board as the server answers it, kept for offline. @param {any} data */
  function keep(data) {
    return keepBoard(data, Date.now());
  }

  /**
   * Read the board: the fresh one, or the kept one when the network does not
   * answer, and whether it is fresh.
   * @returns {Promise<{board: Board | null, live: boolean}>}
   */
  async function sync() {
    try {
      const res = await fetch(api, { headers: { Accept: "application/json" } });
      // With no network the worker answers too, a 200 from its last copy, and
      // says so with the time of it (client/sw).
      const copy = Number(res.headers.get("ug-at"));
      if (res.ok) return { board: keepBoard(await res.json(), copy || Date.now()), live: !copy };
    } catch {
      // Offline, and the worker had nothing: the copy below.
    }
    return { board: board(), live: false };
  }

  return { mine, board, best, record, sync, keep };
}
