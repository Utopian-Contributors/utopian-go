/**
 * A game's leaderboard on its page: this device's games first, the shared
 * board when the network answers. Each game's page has the four elements and
 * says how to read a score; everything else about them is the same.
 */
import { onName, readName } from "../js/me.js";

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
 * return what to call with each finished game's score.
 *
 * @param {ReturnType<typeof import("./scores.js").scores>} store
 * @param {string} page where Log in comes back to
 * @param {{myList: HTMLElement, myNote: HTMLElement, boardList: HTMLElement, meOut: HTMLElement}} els
 * @returns {(score: number) => void}
 */
export function leaderboard(store, page, { myList, myNote, boardList, meOut }) {
  /** @param {{board: import("./scores.js").Board | null, live: boolean, refused: boolean}} [state] */
  function paint(state = { board: store.board(), live: false, refused: false }) {
    const games = store.mine().games;
    paintList(myList, games);
    myNote.textContent = games.length ? "" : "Your games are kept on this device.";
    const me = readName();
    const b = state.board;
    paintList(boardList, (b?.top ?? []).slice(0, 10), me);
    const pending = store.mine().pending;
    if (!me || state.refused) {
      meOut.textContent = "";
      const a = document.createElement("a");
      a.href = `/login?next=${page}`;
      a.textContent = "Log in";
      meOut.append(a, " to put your best on the board.");
    } else if (pending) meOut.textContent = `${fmt(pending)} goes on the board when you are back online.`;
    else if (!b) meOut.textContent = "The board shows once you are online.";
    else if (!state.live) meOut.textContent = `As of ${new Date(b.at).toLocaleString(undefined, { dateStyle: "medium", timeStyle: "short" })}.`;
    else meOut.textContent = b.top.length ? "" : "No games on the board yet.";
  }

  let syncing = false;

  async function syncBoards() {
    if (syncing) return;
    syncing = true;
    try {
      paint(await store.sync(!!readName()));
    } finally {
      syncing = false;
    }
  }

  paint();
  syncBoards();
  onName(syncBoards);
  window.addEventListener("online", syncBoards);

  return (score) => {
    store.record(score, !!readName());
    paint();
    syncBoards();
  };
}
