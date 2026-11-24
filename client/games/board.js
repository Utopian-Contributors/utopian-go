/**
 * A game's leaderboard on its page: this device's games first, the shared
 * board when the network answers. Each game's page has the four elements and
 * says how to read a score; everything else about them is the same.
 */
import { WON_BADGES } from "../../src/social/shop.ts";
import { onName, readName } from "../js/me.js";

/**
 * What a counted game earned, in a line: its place, and the badges it
 * unlocked (rarest first). Empty when it placed nowhere new.
 * @param {{rank: number | null, unlocked: string[]} | null} result
 */
export function placed(result) {
  if (!result?.rank || result.rank > 10) return "";
  const names = result.unlocked.map((item) => WON_BADGES[item.slice(3)]?.name).filter(Boolean);
  if (!names.length) return `#${result.rank} on the board`;
  const more = names.length - 1;
  return `#${result.rank} · ${names[0]}${more ? ` and ${more} more` : ""} unlocked in the Shop`;
}

const fmt = (n) => n.toLocaleString("en-US");

/**
 * The tier `score` is racing through: the next mark to pass, the player's own
 * best or a place on the board, each passed by beating its score (an equal
 * one ranks below the older); the points still needed; and how far it has
 * come from the mark it last passed (or nought). The player's own row on the
 * board is left out, since their best is a mark of its own. Past every mark
 * it is done, with nothing to go; null with no mark at all.
 * @param {{name: string, score: number}[]} top best first
 * @param {number} score
 * @param {number} best the player's best, 0 before their first
 * @param {string} [me]
 * @returns {{key: string, label: string, need: number, done: number} | null}
 */
export function nextPlace(top, score, best, me) {
  const others = top.filter((row) => row.name !== me).slice(0, 10);
  /** @type {{at: number, key: string, label: string}[]} */
  const marks = others.map((row, i) => ({ at: row.score + 1, key: `#${i + 1}`, label: `#${i + 1}` }));
  // A best level with a place is that place.
  if (best > 0 && !marks.some((m) => m.at === best + 1)) marks.push({ at: best + 1, key: "best", label: "best" });
  if (!marks.length) return null;
  marks.sort((x, y) => x.at - y.at);
  const i = marks.findIndex((m) => m.at > score);
  if (i < 0) return { key: "top", label: others.length ? "#1 on the board" : "New best", need: 0, done: 1 };
  const from = marks[i - 1]?.at ?? 0;
  const to = marks[i].at;
  return { ...marks[i], need: to - score, done: Math.max(0, Math.min(1, (score - from) / (to - from))) };
}

/** How long the bar takes to fill or to run out, in ms (the CSS transition's). */
const FILL = 350;

/**
 * Paint the next-place bars: each a track holding an <i> as the fill, and
 * each label a line saying what is left of the tier. A mark passed fills the
 * bar to its end, then the next tier's starts from empty; a new game's fall
 * back to nought empties it at once. Hidden with no mark to race.
 * @param {HTMLElement[]} bars @param {HTMLElement[]} labels
 * @param {ReturnType<typeof nextPlace>} next
 * @param {boolean} up the score rose since the last paint
 */
function paintNext(bars, labels, next, up) {
  const text = !next ? "" : next.need ? `${fmt(next.need)} to ${next.label}` : next.label;
  for (const bar of bars) {
    bar.hidden = !next;
    if (!next) continue;
    const fill = /** @type {HTMLElement} */ (bar.firstElementChild);
    const pct = `${(next.done * 100).toFixed(1)}%`;
    const tier = bar.dataset.tier;
    bar.dataset.tier = next.key;
    // What the bar ends at; a fill still running to a passed tier's end reads it when it is done.
    bar.dataset.pct = pct;
    /** @param {string} width */
    const jump = (width) => {
      fill.style.transition = "none";
      fill.style.width = width;
      void fill.offsetWidth;
      fill.style.transition = "";
    };
    const stop = () => {
      clearTimeout(Number(bar.dataset.timer));
      delete bar.dataset.timer;
      bar.classList.remove("passed");
    };
    if (tier === undefined || tier === next.key) {
      if (!bar.dataset.timer) fill.style.width = pct;
    } else if (!up) {
      stop();
      jump(pct);
    } else {
      // The tier passed fills up and glows, and the next one starts from empty.
      stop();
      fill.style.width = "100%";
      bar.classList.add("passed");
      bar.dataset.timer = String(
        setTimeout(() => {
          stop();
          jump("0%");
          fill.style.width = bar.dataset.pct ?? "0%";
        }, FILL + 150),
      );
    }
    bar.setAttribute("aria-valuenow", String(Math.round(next.done * 100)));
    bar.setAttribute("aria-valuetext", text);
  }
  for (const label of labels) label.textContent = text;
}

/** @param {HTMLElement} list @param {{name?: string, score: number, at?: number}[]} rows @param {string} [me] */
function paintList(list, rows, me) {
  list.replaceChildren(
    ...rows.map((row) => {
      const li = document.createElement("li");
      if (me && row.name === me) li.className = "me";
      const name = document.createElement("span");
      name.textContent = row.name ?? new Date(row.at ?? 0).toLocaleDateString(undefined, { month: "short", day: "numeric" });
      const score = document.createElement("b");
      score.textContent = fmt(row.score);
      li.append(name, score);
      return li;
    }),
  );
}

/**
 * Paint the board, keep it current as the name and the network change, and
 * return what to call as games end: `finished` with every game's score (kept
 * on this device), and `counted` with the server's answer for one played in
 * sync (its place, and the badges that place unlocked).
 *
 * @param {ReturnType<typeof import("./scores.js").scores>} store
 * @param {string} page where Log in comes back to
 * @param {{myList: HTMLElement, myNote: HTMLElement, boardList: HTMLElement, meOut: HTMLElement, nextBars?: HTMLElement[], nextLabels?: HTMLElement[]}} els
 */
export function leaderboard(store, page, { myList, myNote, boardList, meOut, nextBars = [], nextLabels = [] }) {
  /** The board the bars race, and the score they show. */
  let top = store.board()?.top ?? [];
  let current = 0;
  /**
   * The best the bars race: this device's or the account's, whichever is
   * higher, as it stood when the game began, so a game that just set a new
   * one still reads as past it.
   */
  const bestNow = () => Math.max(store.best(), store.board()?.best ?? 0);
  let best = bestNow();
  /** @param {boolean} [up] */
  const paintBars = (up = false) => paintNext(nextBars, nextLabels, nextPlace(top, current, best, readName()), up);

  /** @param {{board: import("./scores.js").Board | null, live: boolean}} [state] */
  function paint(state = { board: store.board(), live: false }) {
    const games = store.mine().games;
    paintList(myList, games);
    myNote.textContent = games.length ? "" : "Your games are kept on this device.";
    const me = readName();
    const b = state.board;
    paintList(boardList, (b?.top ?? []).slice(0, 10), me);
    top = b?.top ?? [];
    if (!current) best = bestNow();
    paintBars();
    if (!me) {
      meOut.textContent = "";
      const a = document.createElement("a");
      a.href = `/login?next=${page}`;
      a.textContent = "Log in";
      meOut.append(a, " to put your best on the board. A top-ten place unlocks badges in the Shop.");
    } else if (!b) meOut.textContent = "The board shows once you are online.";
    else if (!state.live) meOut.textContent = `As of ${new Date(b.at).toLocaleString(undefined, { dateStyle: "medium", timeStyle: "short" })}.`;
    else meOut.textContent = `Only games played in sync count. ${b.top.length ? "" : "No games on the board yet."}`.trim();
  }

  let syncing = false;

  async function syncBoards() {
    if (syncing) return;
    syncing = true;
    try {
      paint(await store.sync());
    } finally {
      syncing = false;
    }
  }

  paint();
  syncBoards();
  onName(syncBoards);
  window.addEventListener("online", syncBoards);

  return {
    /** The score as it goes, for the next-place bars. @param {number} score */
    score(score) {
      if (score === current) return;
      const up = score > current;
      current = score;
      // A new game races the best as it stands now.
      if (!up) best = bestNow();
      paintBars(up);
    },
    /** @param {number} score */
    finished(score) {
      store.record(score);
      paint();
    },
    /** @param {{top: any[], best: number}} result */
    counted(result) {
      paint({ board: store.keep(result), live: true });
    },
  };
}
