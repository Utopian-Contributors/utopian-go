/**
 * Shotgun's wheel of fortune. Twelve equal segments: three guns to start a
 * game with (a little luck: one spin in four), six of credits, paid at once,
 * and three multipliers on the credits the next game earns. The pointer is at the top; a spin eases the wheel
 * to a segment chosen before it starts, ticking past each one.
 */
import { GUNS } from "./game.js";

/** @typedef {import("./game.js").GunId} GunId */
/** @typedef {{kind: "gun", gun: GunId} | {kind: "credits", n: number} | {kind: "mult", x: number}} Prize */

/** @type {Prize[]} */
export const SEGMENTS = [
  { kind: "gun", gun: "shotgun" },
  { kind: "credits", n: 5 },
  { kind: "mult", x: 2 },
  { kind: "credits", n: 10 },
  { kind: "gun", gun: "smg" },
  { kind: "credits", n: 5 },
  { kind: "mult", x: 1.5 },
  { kind: "credits", n: 20 },
  { kind: "gun", gun: "rifle" },
  { kind: "credits", n: 10 },
  { kind: "mult", x: 3 },
  { kind: "credits", n: 40 },
];

const N = SEGMENTS.length;
const SEG = 360 / N;

/** What a prize says, on the wheel and after a spin. @param {Prize} p */
export function label(p) {
  if (p.kind === "gun") return GUNS[p.gun].name;
  if (p.kind === "credits") return `+${p.n}`;
  return `×${p.x}`;
}

const FILL = {
  gun: ["#f5b82e", "#e09a12"],
  credits: ["#fdf3e1", "#f2e2c4"],
  mult: ["#8f5ae8", "#6a35c9"],
};
const INK = { gun: "#3a2400", credits: "#7e1a17", mult: "#ffffff" };

/**
 * Draw the wheel, still, into its canvas at the canvas's CSS size.
 * @param {HTMLCanvasElement} canvas
 */
export function paintWheel(canvas) {
  const css = canvas.clientWidth || 220;
  const dpr = Math.min(3, window.devicePixelRatio || 1);
  const px = Math.round(css * dpr);
  if (canvas.width !== px) canvas.width = canvas.height = px;
  const ctx = /** @type {CanvasRenderingContext2D} */ (canvas.getContext("2d"));
  const c = px / 2;
  const r = c - 4 * dpr;
  ctx.clearRect(0, 0, px, px);

  // The rim, studded.
  ctx.fillStyle = "#2b1a12";
  ctx.beginPath();
  ctx.arc(c, c, r + 3 * dpr, 0, Math.PI * 2);
  ctx.fill();

  SEGMENTS.forEach((p, i) => {
    // Segment i is centred i·SEG clockwise from the top.
    const a0 = ((i - 0.5) * SEG - 90) * (Math.PI / 180);
    const a1 = ((i + 0.5) * SEG - 90) * (Math.PI / 180);
    const [hi, lo] = FILL[p.kind];
    const g = ctx.createRadialGradient(c, c, r * 0.2, c, c, r);
    g.addColorStop(0, hi);
    g.addColorStop(1, lo);
    ctx.fillStyle = g;
    ctx.beginPath();
    ctx.moveTo(c, c);
    ctx.arc(c, c, r, a0, a1);
    ctx.closePath();
    ctx.fill();
    ctx.strokeStyle = "rgba(43, 26, 18, 0.55)";
    ctx.lineWidth = 1.2 * dpr;
    ctx.stroke();

    ctx.save();
    ctx.translate(c, c);
    ctx.rotate((i * SEG - 90) * (Math.PI / 180));
    ctx.fillStyle = INK[p.kind];
    const text = p.kind === "gun" ? label(p).toUpperCase() : label(p);
    const size = (p.kind === "gun" ? 0.085 : 0.1) * r;
    ctx.font = `800 ${size}px -apple-system, system-ui, sans-serif`;
    ctx.textAlign = "right";
    ctx.textBaseline = "middle";
    ctx.fillText(text, r - 10 * dpr, 0, r * 0.62);
    ctx.restore();
  });

  for (let i = 0; i < N; i++) {
    const a = ((i + 0.5) * SEG - 90) * (Math.PI / 180);
    ctx.fillStyle = "#ffe9a8";
    ctx.beginPath();
    ctx.arc(c + Math.cos(a) * (r + 0.5 * dpr), c + Math.sin(a) * (r + 0.5 * dpr), 2.2 * dpr, 0, Math.PI * 2);
    ctx.fill();
  }

  // The hub.
  const hub = ctx.createRadialGradient(c - r * 0.04, c - r * 0.04, 1, c, c, r * 0.16);
  hub.addColorStop(0, "#ff8a7a");
  hub.addColorStop(1, "#8c1a14");
  ctx.fillStyle = hub;
  ctx.beginPath();
  ctx.arc(c, c, r * 0.15, 0, Math.PI * 2);
  ctx.fill();
  ctx.strokeStyle = "#2b1a12";
  ctx.lineWidth = 2 * dpr;
  ctx.stroke();
}

const reduce = matchMedia("(prefers-reduced-motion: reduce)");

/** The wheel's turn, in degrees clockwise, kept across spins. */
let turned = 0;

/**
 * Spin the wheel (its element turned by CSS transform) to a random segment.
 * @param {HTMLElement} el
 * @param {() => void} tick a segment passed the pointer
 * @returns {Promise<Prize>}
 */
export function spin(el, tick) {
  const i = Math.floor(Math.random() * N);
  // Segment i sits under the pointer when the turn is −i·SEG (mod 360); land
  // somewhere inside it, not always dead centre.
  const jitter = (Math.random() - 0.5) * SEG * 0.7;
  const want = (((-i * SEG + jitter - turned) % 360) + 360) % 360;
  const from = turned;
  const to = turned + (reduce.matches ? 360 : 360 * 5) + want;
  const dur = reduce.matches ? 700 : 4200;
  const t0 = performance.now();
  let lastSeg = Math.floor((from + SEG / 2) / SEG);
  return new Promise((resolve) => {
    /** @param {number} now */
    function frame(now) {
      const t = Math.min(1, (now - t0) / dur);
      const ease = 1 - (1 - t) ** 4;
      turned = from + (to - from) * ease;
      el.style.transform = `rotate(${turned}deg)`;
      const seg = Math.floor((turned + SEG / 2) / SEG);
      if (seg !== lastSeg) {
        lastSeg = seg;
        tick();
      }
      if (t < 1) requestAnimationFrame(frame);
      else {
        turned %= 360;
        el.style.transform = `rotate(${turned}deg)`;
        resolve(SEGMENTS[i]);
      }
    }
    requestAnimationFrame(frame);
  });
}
