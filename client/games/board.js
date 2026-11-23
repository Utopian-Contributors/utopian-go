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
 * @param {{myList: HTMLElement, myNote: HTMLElement, boardList: HTMLElement, meOut: HTMLElement}} els
 */
export function leaderboard(store, page, { myList, myNote, boardList, meOut }) {
  /** @param {{board: import("./scores.js").Board | null, live: boolean}} [state] */
  function paint(state = { board: store.board(), live: false }) {
    const games = store.mine().games;
    paintList(myList, games);
    myNote.textContent = games.length ? "" : "Your games are kept on this device.";
    const me = readName();
    const b = state.board;
    paintList(boardList, (b?.top ?? []).slice(0, 10), me);
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
