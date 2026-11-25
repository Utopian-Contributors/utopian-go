/**
 * A game played live (src/social/play.ts): how a Snake or Pinball game gets
 * onto the board, and how a Shotgun game's credits are banked. Signed in, a session is opened before a game starts (so
 * Snake has its apple seed the moment the first swipe lands), synced every
 * couple of seconds while it runs, and closed when it ends. Only a game kept
 * in sync from start to end counts; one that falls out of sync plays on and
 * counts on this device alone.
 *
 * The header says which it is: "Synced" while the session is open and every
 * sync is answered, "Offline" otherwise (signed out, no network, or a game
 * that stopped counting).
 *
 * Syncs go one at a time, in order: the server replays them in the order
 * sent, and a sync that has not been answered is never overtaken.
 */
import { readName } from "../js/me.js";

/**
 * @param {"snake" | "pinball" | "shotgun"} game
 * @param {HTMLElement} badge the header's Synced / Offline
 */
export function live(game, badge) {
  /** A session opened for the next game, and when. @type {{id: string, apples: string, every: number, at: number} | null} */
  let armed = null;
  /** The session the game in play runs under. @type {{id: string, apples: string, every: number} | null} */
  let cur = null;
  /** What a sync says: the game so far. @type {(first: boolean) => object} */
  let read = () => ({});
  /** Given back a payload a sync could not deliver, so the next one carries it. @type {(body: any) => void} */
  let unread = () => {};
  let timer = 0;
  let chain = Promise.resolve();
  let busy = false;
  let first = true;

  /** @param {boolean} on */
  function show(on) {
    badge.dataset.on = on ? "1" : "";
    badge.textContent = on ? "Synced" : "Offline";
    badge.title =
      game === "shotgun"
        ? on
          ? "In sync: this game’s credits go to your account"
          : "Not in sync: this game’s credits won’t be banked"
        : on
          ? "In sync: this game counts for the board"
          : readName()
            ? "Not in sync: this game counts on this device only"
            : "Log in to put games on the board";
  }

  /** @param {string} path @param {object} body @param {boolean} [keepalive] */
  async function post(path, body, keepalive = false) {
    const res = await fetch(`/api/social/${game}/${path}`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Accept: "application/json" },
      body: JSON.stringify(body),
      cache: "no-store",
      credentials: "same-origin",
      keepalive,
    });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) throw Object.assign(new Error(data.error || "Out of sync"), { status: res.status });
    return data;
  }

  /** Open a session for the next game, when signed in and online. */
  async function arm() {
    if (cur || !readName() || !navigator.onLine) {
      if (!cur) show(false);
      return;
    }
    try {
      armed = { ...(await post("start", {})), at: Date.now() };
      show(true);
    } catch {
      armed = null;
      show(false);
    }
  }

  /** The session stops counting: the game goes on, on this device. */
  function lose() {
    clearInterval(timer);
    timer = 0;
    cur = null;
    show(false);
  }

  /**
   * One sync, after any before it. A network failure keeps the session (the
   * next sync tries again, with this one's turns given back); a refusal ends
   * it, as the server has.
   * @param {object} [extra] @param {boolean} [keepalive]
   */
  function sync(extra = {}, keepalive = false) {
    const s = cur;
    if (!s) return chain;
    busy = true;
    chain = chain.then(async () => {
      if (cur !== s) return;
      const body = { ...read(first), ...extra };
      try {
        await post("sync", { id: s.id, ...body }, keepalive);
        // Only once one is answered: a first sync lost on the way is sent again as the first.
        first = false;
        if (cur === s) show(true);
      } catch (err) {
        if (cur !== s) return;
        if (/** @type {any} */ (err).status) lose();
        else {
          unread(body);
          show(false);
        }
      } finally {
        busy = false;
      }
    });
    return chain;
  }

  /**
   * A game starts. Returns its session (Snake seeds its apples from it), or
   * null when it will not count.
   * @param {(first: boolean) => object} payload @param {(body: any) => void} [giveBack]
   */
  function begin(payload, giveBack = () => {}) {
    read = payload;
    unread = giveBack;
    first = true;
    // A session left open too long is gone on the server: this game will not count.
    cur = armed && Date.now() - armed.at < 20 * 60_000 ? armed : null;
    armed = null;
    if (!cur) {
      show(false);
      return null;
    }
    sync();
    timer = window.setInterval(() => {
      // One at a time: a slow answer delays the next sync rather than racing it.
      if (!busy) sync();
    }, cur.every);
    return cur;
  }

  /** The game is paused, or goes on; said at once, so the wait is not a missed sync. */
  const pause = () => sync({ p: 1 }, true);
  const resume = () => sync({ p: 0 });

  /**
   * The game ended: the last sync, and its place on the board when it counts.
   * Resolves to the server's answer, or null when the game did not count.
   * Opens the next game's session after.
   * @param {object} last
   */
  async function end(last) {
    const s = cur;
    clearInterval(timer);
    timer = 0;
    if (!s) {
      arm();
      return null;
    }
    await chain;
    let result = null;
    if (cur === s) {
      try {
        result = await post("end", { id: s.id, ...read(first), ...last });
      } catch {
        result = null;
      }
    }
    cur = null;
    await arm();
    return result;
  }

  show(false);
  arm();
  // A session waiting long for its game is renewed before it lapses.
  setInterval(() => {
    if (!cur && (!armed || Date.now() - armed.at > 10 * 60_000)) arm();
  }, 60_000);
  window.addEventListener("online", () => {
    if (!cur && !armed) arm();
  });
  window.addEventListener("offline", () => show(false));

  return { begin, end, pause, resume, playing: () => !!cur };
}
