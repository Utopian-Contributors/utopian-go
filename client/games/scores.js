/**
 * A game's scores, offline first. Every finished game is kept on this device,
 * and the device's own list is the one the page shows first: it needs no
 * network and no account. The shared leaderboard is a copy of the server's,
 * kept here too so it reads offline, and refreshed whenever the network
 * answers.
 *
 * Signed in, the device's best game not yet on the board waits here as
 * `pending` until a post succeeds: on the next load, the next game, or the
 * moment the browser says it is back online.
 */

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
    return { games: Array.isArray(m?.games) ? m.games.filter((g) => Number.isInteger(g?.score)) : [], pending: Number.isInteger(m?.pending) ? m.pending : 0 };
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
   * A finished game, kept on this device; a new best waits to go on the board.
   * @param {number} score
   * @param {boolean} signed
   */
  function record(score, signed) {
    const m = mine();
    if (score > 0) {
      m.games.push({ score, at: Date.now() });
      m.games.sort((a, b) => b.score - a.score || a.at - b.at);
      m.games = m.games.slice(0, KEEP);
    }
    if (signed && score > m.pending && score >= (board()?.best ?? 0)) m.pending = score;
    write(key, m);
  }

  /** Drop `sent` from waiting, unless a better game arrived while it was on its way. */
  function settle(sent) {
    const m = mine();
    if (m.pending === sent) write(key, { ...m, pending: 0 });
  }

  /** @param {any} data @param {number} at */
  function keepBoard(data, at) {
    const b = { top: Array.isArray(data?.top) ? data.top : [], best: Number(data?.best) || 0, at };
    write(boardKey, b);
    return b;
  }

  /**
   * Bring the board up to date: post a pending best if there is one and the
   * account will take it, then read the board. Resolves to the board, the
   * fresh one or the kept one, and whether it is fresh.
   *
   * @param {boolean} signed
   * @returns {Promise<{board: Board | null, live: boolean, refused: boolean}>}
   */
  async function sync(signed) {
    let refused = false;
    const m = mine();
    if (signed && m.pending) {
      try {
        const res = await fetch(api, {
          method: "POST",
          headers: { "Content-Type": "application/json", Accept: "application/json" },
          body: JSON.stringify({ score: m.pending }),
        });
        if (res.ok) {
          settle(m.pending);
          return { board: keepBoard(await res.json(), Date.now()), live: true, refused };
        }
        // Signed out on the server, or no passkey yet: the score stays here.
        if (res.status === 401 || res.status === 403) refused = true;
        // A score the server will never take is not worth trying again.
        else if (res.status === 400) settle(m.pending);
      } catch {
        return { board: board(), live: false, refused };
      }
    }
    try {
      const res = await fetch(api, { headers: { Accept: "application/json" } });
      // With no network the worker answers too, a 200 from its last copy, and
      // says so with the time of it (client/sw).
      const copy = Number(res.headers.get("ug-at"));
      if (res.ok) return { board: keepBoard(await res.json(), copy || Date.now()), live: !copy, refused };
    } catch {
      // Offline, and the worker had nothing: the copy below.
    }
    return { board: board(), live: false, refused };
  }

  return { mine, board, best, record, sync };
}
