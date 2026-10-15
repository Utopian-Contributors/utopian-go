/**
 * The portfolio by kind, once it holds three kinds or more: Total, then a row
 * for each kind, largest first. The rows are the legend of the chart above,
 * which draws all of their lines at once; hovering it reads that moment into
 * every row. Picking a row brings its line forward and hands its kind to the
 * page, which narrows the holdings to it; picking it again, or Total, goes
 * back to everything.
 */
import { el } from "../js/dom.js";
import { KINDS } from "../js/kinds.js";
import { dollars, percent } from "../js/num.js";

function dirOf(v) {
  return v > 0 ? "up" : v < 0 ? "dn" : "";
}

/** A slice's part of the whole, as a whole percent; a sliver still says it is there. */
function share(part, whole) {
  if (!(whole > 0)) return "";
  const pct = (part / whole) * 100;
  return pct < 1 ? "<1%" : `${Math.round(pct)}%`;
}

function paintMove(cell, move) {
  cell.className = `wl-d ${dirOf(move)}`;
  cell.textContent = move == null ? "" : percent(move, true);
}

/**
 * @param {HTMLElement} box
 * @param {(kind: string) => void} onPick the kind picked, "" for Total
 */
export function mountBreakdown(box, onPick) {
  let picked = "";
  /** Each row's figures as painted, so a hovered moment can be read in and taken back out. */
  let rows = /** @type {{ key: string, usd: number, move?: number, value: HTMLElement, delta: HTMLElement }[]} */ ([]);

  function pick(kind) {
    picked = kind === picked ? "" : kind;
    for (const line of box.children) {
      line.setAttribute("aria-pressed", String(/** @type {HTMLElement} */ (line).dataset.kind === picked));
    }
    onPick(picked);
  }

  /** `key` names the line in the chart; `drawn` says whether it has one to key. */
  function line(kind, key, name, part, usd, move, drawn) {
    const value = el("span", { class: "wl-bk-v", text: dollars(usd) });
    const delta = el("span", {});
    paintMove(delta, move);
    rows.push({ key, usd, move, value, delta });
    return el(
      "button",
      {
        type: "button",
        class: "wl-bk-r",
        "data-kind": kind,
        "aria-pressed": String(kind === picked),
        onclick: () => pick(kind),
      },
      el("i", { class: drawn ? `wl-key k-${key}` : "wl-key", "aria-hidden": "true" }),
      el("span", { class: "wl-bk-n" }, name, part ? el("small", { text: part }) : null),
      value,
      delta,
    );
  }

  return {
    /** The kind on show, "" for Total. */
    get picked() {
      return picked;
    },
    /** @param {import('../../src/types').Holdings} data */
    paint(data) {
      const slices = data.slices ?? [];
      // A re-read after a trade can sell the last of a kind.
      if (!slices.some((s) => s.kind === picked)) picked = "";
      rows = [];
      box.replaceChildren(
        line("", "total", "Total", "", data.total, data.change, !!data.series),
        ...slices.map((s) =>
          line(s.kind, s.kind, KINDS[s.kind] ?? s.kind, share(s.usd, data.total), s.usd, s.change, !!s.series),
        ),
      );
      box.hidden = !slices.length;
    },
    /**
     * Every row's worth at point `i`, and its change from the first point to
     * it; -1 puts back what the rows said before the pointer came.
     * @param {number} i
     * @param {Map<string, number[]>} lines each line's dollars, by key
     */
    at(i, lines) {
      for (const row of rows) {
        const values = lines.get(row.key);
        const now = i >= 0 && values ? values[i] : null;
        row.value.textContent = dollars(now ?? row.usd);
        paintMove(row.delta, now == null || !values ? row.move : (now / values[0] - 1) * 100);
      }
    },
    clear() {
      box.hidden = true;
      box.replaceChildren();
      rows = [];
    },
  };
}
