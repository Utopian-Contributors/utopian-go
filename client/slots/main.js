/**
 * Fruit Slots: the page. Every spin is played by the server
 * (/api/social/slots, src/social/slots.ts has the rules): this page asks for
 * one, sets the reels going while it waits, and lands each reel on the stop
 * the server sent. It never decides a result, and never sends a score.
 *
 * The reels are the Shop's fruit statuses (/st-<fruit>.svg): a picture for
 * every stop, loaded once, moved by transform and never given another
 * picture. Stop i sits (p - i) cells below the line (taken round the reel to
 * wherever is nearest), so as p grows the reel runs downwards and stop i is
 * on the line when p = i. Recycling a few pictures by changing their src
 * showed fruit that was not there: a browser keeps drawing an image's last
 * picture until the next is decoded, so a reel could come to rest on stale
 * fruit and then change under the player's eyes.
 */
import { STATUSES } from "../../src/social/shop.ts";
import { BETS, CHERRIES, FRUITS, REELS, START, STATUS_PRICE, THREE, lineOf, payout } from "../../src/social/slots.ts";
import { keepOffline } from "../games/offline.js";
import { tone, wakeAudio } from "../games/sound.js";
import { noZoom } from "../js/device.js";
import { tally } from "../games/tally.js";
import { plainSwap } from "../js/plainswap.js";
import { sheetDialog } from "../js/sheet.js";

/** @param {string} id */
const $ = (id) => /** @type {HTMLElement} */ (document.getElementById(id));

const fmt = (n) => Number(n).toLocaleString("en-US");
const src = (fruit) => `/st-${fruit}.svg`;
const mod = (n, m) => ((n % m) + m) % m;
const reduce = matchMedia("(prefers-reduced-motion: reduce)").matches;

const machine = $("sl-mc");
const reelsBox = $("sl-rs");
const creditsOut = $("sl-cr");
const bestOut = $("sl-bs");
/** The same two, large beside the machine on a desktop. */
const creditsBig = $("sl-cr2");
const bestBig = $("sl-bs2");
const jolt = tally(creditsBig);
const msgOut = $("sl-msg");
const goBtn = /** @type {HTMLButtonElement} */ ($("sl-go"));
const buyBtn = /** @type {HTMLButtonElement} */ ($("sl-by"));
const liveOut = $("sl-lv");
const leftOut = $("sl-lf");
const progress = $("sl-pg");
const goalOut = $("sl-gl");
const betsBox = $("sl-bt");
const paysSheet = /** @type {HTMLDialogElement} */ ($("sl-pays"));
const buySheet = /** @type {HTMLDialogElement} */ ($("sl-buy"));

/* ---------- The server ---------- */

class ApiError extends Error {
  /** @param {string} message @param {number} status @param {any} data */
  constructor(message, status, data) {
    super(message);
    this.status = status;
    this.data = data;
  }
}

/**
 * The slots API. `no-store`, so the service worker passes it straight
 * through: a copy of a game from before the last spin is worse than none.
 * @param {string} path @param {object} [body]
 */
async function api(path, body) {
  const init = body
    ? { method: "POST", headers: { "Content-Type": "application/json", Accept: "application/json" }, body: JSON.stringify(body) }
    : { headers: { Accept: "application/json" } };
  let res;
  try {
    res = await fetch(`/api/social${path}`, { ...init, cache: "no-store", credentials: "same-origin" });
  } catch (err) {
    answered = false;
    paintLive();
    throw err;
  }
  answered = res.status !== 401;
  paintLive();
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new ApiError(data.error || "Something went wrong. Try again.", res.status, data);
  return data;
}

/* ---------- State ---------- */

/** The last answer to GET /slots: your best, today's fresh start, the statuses you have. */
let state = /** @type {any} */ (null);
/** The game in play, or the one that just ended, as the server last told it. */
let game = /** @type {any} */ (null);
let busy = false;
let offline = false;
/** Whether the server answered the last request, with the session still good. */
let answered = false;
/** The credits as shown: they count up to a win rather than jump. */
let shown = START;

const BET_KEY = "ug.slb";
let bet = (() => {
  try {
    const saved = Number(localStorage.getItem(BET_KEY));
    return BETS.includes(/** @type {any} */ (saved)) ? saved : BETS[1];
  } catch {
    return BETS[1];
  }
})();

/* ---------- Reels ---------- */

/** Cells a second at full speed. */
const SPEED = 22;
/** How far past its stop a reel runs before it settles back, in cells. */
const OVER = 0.16;
const SETTLE_MS = 190;

let cell = 96;

/**
 * @typedef {{
 *   strip: readonly string[], box: HTMLElement, imgs: HTMLImageElement[],
 *   p: number, mode: "idle" | "spin" | "stop" | "settle",
 *   t0: number, from: number, to: number, dur: number, done: null | (() => void)
 * }} Reel
 */

/** @type {Reel[]} */
const reels = REELS.map((strip) => {
  const box = document.createElement("div");
  box.className = "sl-reel";
  // One picture per stop, its fruit for good.
  const imgs = strip.map((fruit) => {
    const img = new Image();
    img.alt = "";
    img.draggable = false;
    img.src = src(fruit);
    img.dataset.f = fruit;
    box.append(img);
    return img;
  });
  reelsBox.append(box);
  return { strip, box, imgs, p: Math.floor(Math.random() * strip.length), mode: "idle", t0: 0, from: 0, to: 0, dur: 0, done: null };
});

/** @param {Reel} reel */
function drawReel(reel) {
  const size = reel.strip.length;
  reel.imgs.forEach((img, j) => {
    // Stop j's place nearest the line, round the loop.
    const off = reel.p - j - size * Math.round((reel.p - j) / size);
    const seen = Math.abs(off) < 2.5;
    img.style.visibility = seen ? "" : "hidden";
    if (seen) img.style.transform = `translateY(${(off * cell).toFixed(2)}px)`;
  });
}

const easeOut = (t) => 1 - (1 - t) ** 3;
const easeInOut = (t) => (t < 0.5 ? 2 * t * t : 1 - (-2 * t + 2) ** 2 / 2);

let raf = 0;
let last = 0;

/** @param {number} now */
function frame(now) {
  raf = 0;
  const dt = Math.min(0.05, (now - (last || now)) / 1000);
  last = now;
  let moving = false;
  for (const reel of reels) {
    if (reel.mode === "spin") {
      // Up to speed over a quarter of a second.
      reel.p += SPEED * Math.min(1, (now - reel.t0) / 250) * dt;
    } else if (reel.mode === "stop" || reel.mode === "settle") {
      const t = Math.min(1, (now - reel.t0) / reel.dur);
      reel.p = reel.from + (reel.to - reel.from) * (reel.mode === "stop" ? easeOut(t) : easeInOut(t));
      if (t >= 1) {
        if (reel.mode === "stop") {
          // Past the stop: back onto it.
          reel.mode = "settle";
          reel.from = reel.p;
          reel.to = reel.p - OVER;
          reel.t0 = now;
          reel.dur = SETTLE_MS;
          reel.box.classList.remove("fast");
          tick();
        } else {
          reel.mode = "idle";
          reel.p = Math.round(reel.p);
          reel.done?.();
          reel.done = null;
        }
      }
    }
    if (reel.mode !== "idle") moving = true;
    drawReel(reel);
  }
  if (moving) run();
  else last = 0;
}

function run() {
  if (!raf) raf = requestAnimationFrame(frame);
}

function startReels() {
  const now = performance.now();
  for (const reel of reels) {
    reel.mode = "spin";
    reel.t0 = now;
    if (!reduce) reel.box.classList.add("fast");
    else reel.box.style.opacity = "0.4";
  }
  machine.classList.remove("won");
  for (const reel of reels) for (const img of reel.imgs) img.classList.remove("hit");
  run();
}

/**
 * Land `reel` on `stop`. It is moved a whole number of cells first, so the
 * picture does not jump, to a point a few cells short of the stop; from
 * there it eases in at the speed it was running, so nothing lurches either.
 * @param {Reel} reel @param {number} stop
 */
function landReel(reel, stop) {
  return new Promise((resolve) => {
    const finish = () => {
      reel.box.style.opacity = "";
      reel.box.classList.remove("fast");
      resolve(undefined);
    };
    if (reduce || reel.mode === "idle") {
      reel.mode = "idle";
      reel.p = stop;
      drawReel(reel);
      if (reduce) tick();
      finish();
      return;
    }
    const frac = (x) => x - Math.floor(x);
    const travel = 5 + frac(stop - reel.p);
    reel.p = stop - travel;
    reel.mode = "stop";
    reel.from = reel.p;
    reel.to = stop + OVER;
    reel.t0 = performance.now();
    // An ease-out leaves at three times its average speed: that is SPEED.
    reel.dur = (3 * (travel + OVER) * 1000) / SPEED;
    reel.done = finish;
    run();
  });
}

const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/**
 * Land the reels on `stops`, left to right, the first no sooner than
 * `minSpin` after they started. Two fruit alike on the line holds the last
 * reel a moment longer.
 * @param {number[]} stops @param {number} started
 */
async function landAll(stops, started) {
  const line = lineOf(stops);
  await wait(Math.max(0, started + (reduce ? 150 : 600) - performance.now()));
  for (let i = 0; i < reels.length; i++) {
    const landing = landReel(reels[i], stops[i]);
    if (i === reels.length - 1) {
      await landing;
      break;
    }
    const tease = i === 1 && line[0] === line[1] && !reduce ? 450 : 0;
    await wait((reduce ? 60 : 280) + tease);
  }
}

/** Show `stops` at once, as on loading. @param {number[]} stops */
function setReels(stops) {
  reels.forEach((reel, i) => {
    reel.mode = "idle";
    if (stops.length === reels.length) reel.p = stops[i];
    drawReel(reel);
  });
}

function fitReels() {
  const width = reelsBox.clientWidth;
  if (!width) return;
  cell = Math.min(112, Math.floor((width - 16) / 3));
  machine.style.setProperty("--cell", `${cell}px`);
  reelsBox.style.setProperty("--cell", `${cell}px`);
  reels.forEach(drawReel);
}

/* ---------- Sound ---------- */

const tick = () => tone(180, 0.05, "triangle", 120, 0.05);
const SOUNDS = {
  small: () => [660, 880].forEach((f, i) => tone(f, 0.12, "sine", f, 0.05, i * 0.08)),
  big: () => [523, 659, 784, 1047].forEach((f, i) => tone(f, 0.16, "triangle", f, 0.06, i * 0.09)),
  top: () => [523, 659, 784, 1047, 784, 1047, 1319].forEach((f, i) => tone(f, 0.2, "triangle", f, 0.07, i * 0.11)),
  out: () => tone(260, 0.5, "sine", 80, 0.05),
};

/* ---------- What the page says ---------- */

/** @param {string} text @param {boolean} [dim] */
function say(text, dim = false) {
  msgOut.textContent = text;
  msgOut.classList.toggle("dim", dim);
}

let counting = 0;

/** Count the credits up (or down) to `to`. @param {number} to */
function countTo(to) {
  cancelAnimationFrame(counting);
  const from = shown;
  const t0 = performance.now();
  const dur = reduce || Math.abs(to - from) < 2 ? 0 : Math.min(900, 250 + Math.abs(to - from) * 4);
  if (to !== from) jolt(to - from, dur);
  const step = (now) => {
    const t = dur ? Math.min(1, (now - t0) / dur) : 1;
    shown = Math.round(from + (to - from) * easeOut(t));
    paintCredits();
    if (t < 1) counting = requestAnimationFrame(step);
  };
  counting = requestAnimationFrame(step);
}

function paintCredits() {
  creditsOut.textContent = creditsBig.textContent = fmt(shown);
}

function paintBest() {
  const best = state?.best || 0;
  bestOut.textContent = bestBig.textContent = best ? `Best ${fmt(best)}` : "";
}

const open = () => game && !game.over;

function untilTomorrow() {
  const ms = Math.max(0, (state?.resets ?? 0) - Date.now());
  const h = Math.floor(ms / 3_600_000);
  const m = Math.ceil((ms % 3_600_000) / 60_000);
  return h ? `${h}h ${m}m` : `${m}m`;
}

/** Synced while the server answers for a signed-in account: every spin is the server's, so then the game is in step. */
function paintLive() {
  const on = answered && !!state?.signed;
  liveOut.dataset.on = on ? "1" : "";
  liveOut.textContent = on ? "Synced" : "Offline";
}

/** The bet, Spin, Buy a status and today's fresh start, as things stand. */
function paintControls() {
  const signed = !!state?.signed;
  const left = state?.left ?? 0;
  const credits = open() ? game.credits : START;
  for (const btn of betsBox.children) {
    const value = Number(/** @type {HTMLElement} */ (btn).dataset.bet);
    btn.setAttribute("aria-checked", String(value === bet));
    /** @type {HTMLButtonElement} */ (btn).disabled = busy || !signed || value > credits;
  }
  buyBtn.disabled = busy || !open() || game.credits < STATUS_PRICE;
  if (offline) {
    goBtn.textContent = "Offline";
    goBtn.disabled = true;
    leftOut.textContent = "";
    return;
  }
  if (!state) {
    goBtn.disabled = true;
    return;
  }
  if (!signed) {
    goBtn.textContent = "Log in to play";
    goBtn.disabled = false;
    leftOut.textContent = `Free · ${fmt(START)} credits a day`;
    return;
  }
  if (open()) {
    goBtn.textContent = "Spin";
    goBtn.disabled = busy;
    leftOut.textContent = "Kept until you run out";
  } else if (left > 0) {
    goBtn.textContent = "Spin";
    goBtn.disabled = busy;
    leftOut.textContent = `Start with ${fmt(START)} credits`;
  } else {
    goBtn.textContent = "Back tomorrow";
    goBtn.disabled = true;
    leftOut.textContent = `Fresh start in ${untilTomorrow()}`;
  }
}

/** How far the credits are from the next status. */
function paintGoal() {
  const credits = open() ? game.credits : shown;
  progress.style.width = `${Math.min(100, (credits / STATUS_PRICE) * 100)}%`;
  goalOut.textContent =
    credits >= STATUS_PRICE
      ? `You can buy ${Math.floor(credits / STATUS_PRICE) > 1 ? `${Math.floor(credits / STATUS_PRICE)} fruit statuses` : "a fruit status"}`
      : `${fmt(STATUS_PRICE - credits)} to a fruit status · ${fmt(STATUS_PRICE)} credits each`;
}

/* ---------- Buying a status ---------- */

/** @param {string} text @param {string} className */
function button(text, className) {
  const btn = document.createElement("button");
  btn.type = "button";
  btn.className = className;
  btn.textContent = text;
  return btn;
}

/** The status picked in the sheet, and who it is for: "" for me. */
let pick = "";
let gift = false;

/** The sheet: the ten statuses (yours marked), For me or A gift, and Buy. */
function paintBuy() {
  const mine = new Set(state?.statuses ?? []);
  $("sl-fr").replaceChildren(
    ...FRUITS.map((fruit) => {
      const had = !gift && mine.has(fruit);
      const tile = button("", "sl-ft");
      tile.disabled = had;
      tile.setAttribute("aria-pressed", String(pick === fruit));
      const img = new Image();
      img.src = src(fruit);
      img.alt = "";
      const words = document.createElement("span");
      words.textContent = had ? "Yours" : STATUSES[fruit];
      tile.append(img, words);
      tile.onclick = () => {
        pick = fruit;
        paintBuy();
      };
      return tile;
    }),
  );
  for (const btn of $("sl-wh").children) btn.setAttribute("aria-checked", String((btn.dataset.gift === "1") === gift));
  const to = /** @type {HTMLInputElement} */ ($("sl-to"));
  to.hidden = !gift;
  const buy = /** @type {HTMLButtonElement} */ ($("sl-bb"));
  buy.disabled = !pick || (!gift && mine.has(pick)) || !open() || game.credits < STATUS_PRICE;
  buy.textContent = pick ? `${gift ? "Give" : "Buy"} ${STATUSES[pick]} · ${fmt(STATUS_PRICE)}` : "Pick a status";
}

function openBuy() {
  if (!open() || game.credits < STATUS_PRICE) return;
  const mine = new Set(state?.statuses ?? []);
  if (mine.has(pick)) pick = "";
  $("sl-be").textContent = "";
  paintBuy();
  buySheet.showModal();
}

async function buy() {
  if (!pick || busy) return;
  const err = $("sl-be");
  const to = /** @type {HTMLInputElement} */ ($("sl-to")).value.trim();
  if (gift && !to) {
    err.textContent = "Who is it for?";
    return;
  }
  busy = true;
  const btn = /** @type {HTMLButtonElement} */ ($("sl-bb"));
  btn.disabled = true;
  err.textContent = "";
  try {
    const res = await api("/slots/buy", { status: pick, ...(gift ? { for: to } : {}) });
    game = res.game;
    state.statuses = res.statuses;
    countTo(game.credits);
    say(gift ? `${STATUSES[pick]} sent. They unlock it free in the Shop.` : `${STATUSES[pick]} is yours. Wear it from the Shop.`);
    SOUNDS.big();
    buySheet.close();
    pick = "";
    if (game.over) refresh();
  } catch (cause) {
    err.textContent = /** @type {Error} */ (cause).message;
  } finally {
    busy = false;
    paintControls();
    paintGoal();
    if (buySheet.open) paintBuy();
  }
}

/* ---------- Pays ---------- */

function paintPays() {
  const rows = [...FRUITS].sort((a, b) => THREE[b] - THREE[a]);
  const icons = (fruit, n) =>
    Array.from({ length: 3 }, (_, i) => {
      if (i >= n) return document.createElement("i");
      const img = new Image();
      img.src = src(fruit);
      img.alt = "";
      return img;
    });
  const li = (fruit, n, words, times) => {
    const row = document.createElement("li");
    const label = document.createElement("span");
    label.textContent = words;
    const pay = document.createElement("b");
    pay.textContent = times === 1 ? "Bet back" : `×${times}`;
    row.append(...icons(fruit, n), label, pay);
    return row;
  };
  $("sl-pt").replaceChildren(
    ...rows.map((fruit) => li(fruit, 3, STATUSES[fruit], THREE[fruit])),
    li("cherry", 2, "Any two cherries", CHERRIES[2]),
    li("cherry", 1, "Any one cherry", CHERRIES[1]),
  );
}

function paintFair() {
  const fair = $("sl-fair");
  const lines = [
    `You start with ${fmt(START)} credits, kept from visit to visit until you run out; then a fresh start comes the next day. A bet comes off every spin, and a line pays the bet times what it shows. Every ${fmt(STATUS_PRICE)} credits buy a fruit status, for you or as a gift.`,
  ];
  if (game?.commit) {
    lines.push(
      game.secret
        ? `Every spin was drawn from this game’s secret, ${game.secret}, whose SHA-256 is ${game.commit}.`
        : `Every spin is drawn on our server from a secret fixed when this balance began. Its SHA-256 is ${game.commit}; the secret is shown here once you run out.`,
    );
  }
  fair.replaceChildren(...lines.flatMap((line, i) => (i ? [document.createElement("br"), document.createElement("br"), line] : [line])));
}

/* ---------- Playing ---------- */

/** What the line paid, in words. @param {{stops: number[], win: number, bet: number}} g */
function describe(g) {
  const line = lineOf(g.stops);
  const times = payout(line);
  if (!times) return "";
  if (line[0] === line[1] && line[1] === line[2]) return `${STATUSES[line[0]]} ×3 · +${fmt(g.win)}`;
  const cherries = line.filter((fruit) => fruit === "cherry").length;
  return cherries === 2 ? `Two cherries · +${fmt(g.win)}` : `Cherry · bet back`;
}

/** Light up what paid on the line. @param {number[]} stops */
function lightUp(stops) {
  const line = lineOf(stops);
  const times = payout(line);
  machine.classList.toggle("won", times > 1);
  if (!times) return;
  const three = line[0] === line[1] && line[1] === line[2];
  reels.forEach((reel, i) => {
    const img = reel.imgs[mod(stops[i], reel.strip.length)];
    if (three || line[i] === "cherry") {
      img.classList.remove("hit");
      void img.offsetWidth;
      img.classList.add("hit");
    }
  });
}

/**
 * A spin's answer, once the reels are on it: what it paid, the credits, and
 * the end of the game when it is one.
 * @param {any} next
 */
function reveal(next) {
  const before = game?.credits ?? 0;
  game = next;
  lightUp(game.stops);
  const times = payout(lineOf(game.stops));
  if (times >= 10) SOUNDS.big();
  else if (times > 1) SOUNDS.small();
  countTo(game.credits);
  const paid = describe(game);
  if (game.over) {
    SOUNDS.out();
    say("Out of credits. A fresh start tomorrow.", true);
  } else if (before < STATUS_PRICE && game.credits >= STATUS_PRICE) {
    SOUNDS.top();
    say(`${fmt(game.credits)} · Buy a fruit status`);
  } else say(paid || "No win", !paid);
  paintGoal();
  if (game.over) refresh();
}

async function spin() {
  if (busy || !state?.signed || offline) return;
  if (!open() && (state.left ?? 0) <= 0) return;
  wakeAudio();
  busy = true;
  say("");
  paintControls();
  let n = -1;
  let started = 0;
  try {
    if (!open()) {
      const fresh = await api("/slots/new", {});
      game = fresh.game;
      state.left = fresh.left;
      state.resets = fresh.resets;
      shown = game.credits;
      paintCredits();
      paintGoal();
    }
    if (bet > game.credits) bet = [...BETS].reverse().find((b) => b <= game.credits) ?? BETS[0];
    n = game.spins;
    startReels();
    started = performance.now();
    const res = await api("/slots/spin", { bet, n });
    await landAll(res.game.stops, started);
    reveal(res.game);
  } catch (cause) {
    await recover(/** @type {ApiError} */ (cause), n, started);
  } finally {
    busy = false;
    paintControls();
  }
}

/**
 * A spin that failed, or whose answer never came: ask how the game stands.
 * If the server played it after all, land on what it played.
 * @param {ApiError} cause @param {number} n @param {number} started
 */
async function recover(cause, n, started) {
  let fresh = null;
  try {
    fresh = await api("/slots");
  } catch {
    // Still offline.
  }
  if (fresh) {
    state = fresh;
    const played = fresh.game && n >= 0 && fresh.game.spins > n ? fresh.game : null;
    if (played) {
      await landAll(played.stops, started);
      reveal(played);
      paintAll();
      return;
    }
    game = fresh.game ?? game;
  } else offline = !(cause instanceof ApiError);
  await landAll(game?.stops?.length ? game.stops : reels.map((reel) => mod(Math.round(reel.p), reel.strip.length)), started);
  say(offline ? "You’re offline. Fruit Slots plays online." : cause.message, true);
  paintAll();
}

/* ---------- Loading ---------- */

function paintAll() {
  paintBest();
  paintCredits();
  paintGoal();
  paintControls();
  paintLive();
}

/** Ask how things stand: your best, your balance, today's fresh start, the statuses you have. */
async function refresh() {
  try {
    const fresh = await api("/slots");
    offline = false;
    state = fresh;
    // A game that just ended stays on show until the next one starts.
    if (fresh.game) game = fresh.game;
  } catch (cause) {
    offline = !(cause instanceof ApiError);
    if (!state) state = { signed: false, best: 0 };
  }
  if (!busy && !open()) shown = game?.credits ?? START;
  paintAll();
}

/* ---------- Wiring ---------- */

for (const value of BETS) {
  const btn = button(String(value), "");
  btn.dataset.bet = String(value);
  btn.setAttribute("role", "radio");
  btn.onclick = () => {
    bet = value;
    try {
      localStorage.setItem(BET_KEY, String(value));
    } catch {
      // Remembered for this visit only.
    }
    paintControls();
  };
  betsBox.append(btn);
}

goBtn.addEventListener("click", () => {
  if (state && !state.signed && !offline) location.href = "/login?next=/slots";
  else spin();
});
buyBtn.addEventListener("click", openBuy);
$("sl-bb").addEventListener("click", buy);
for (const btn of $("sl-wh").children) {
  /** @type {HTMLElement} */ (btn).addEventListener("click", () => {
    gift = /** @type {HTMLElement} */ (btn).dataset.gift === "1";
    paintBuy();
    if (gift) $("sl-to").focus();
  });
}

$("sl-py").addEventListener("click", () => {
  paintFair();
  paysSheet.showModal();
});

for (const sheet of [paysSheet, buySheet]) {
  // iOS's sheet (js/ios-sheet.js): the X, a drag down and a tap on the dimmed
  // page around it close it, as Done and Cancel do.
  sheetDialog(sheet);
  sheet.addEventListener("click", (e) => {
    if (/** @type {Element} */ (e.target).closest("[data-close]")) sheet.close();
  });
}

window.addEventListener("keydown", (e) => {
  if (e.metaKey || e.ctrlKey || e.altKey || e.repeat) return;
  if (paysSheet.open || buySheet.open) return;
  const target = /** @type {Element} */ (e.target);
  if (target.closest?.("input, textarea")) return;
  if (e.code === "Space" || (e.code === "Enter" && !target.closest?.("a, button"))) {
    e.preventDefault();
    if (state?.signed) spin();
  }
  const digit = ["Digit1", "Digit2", "Digit3"].indexOf(e.code);
  if (digit >= 0 && !busy) {
    /** @type {HTMLButtonElement} */ (betsBox.children[digit]).click();
  }
});

/** Back: where the visitor came from on this site, else the games list. */
$("sl-bk").addEventListener("click", () => {
  if (history.length > 1 && document.referrer.startsWith(location.origin)) history.back();
  else location.href = "/games";
});

window.addEventListener("online", () => {
  if (offline) refresh();
});

noZoom();
new ResizeObserver(fitReels).observe(reelsBox);
fitReels();
paintPays();
paintAll();
refresh().then(() => {
  if (game?.stops?.length) setReels(game.stops);
});
keepOffline();

// Back to the list at once: no fade of its header in (js/plainswap.js).
plainSwap();
// Every fruit, early, so no reel waits on a picture mid-spin.
for (const fruit of FRUITS) new Image().src = src(fruit);
