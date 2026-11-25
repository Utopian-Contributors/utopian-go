/**
 * Shotgun: the rules its credits are kept by, shared by the server, which
 * keeps a signed-in player's credits (the bank), and the page (client/shotgun),
 * which plays the waves.
 *
 * Signed in, the wheel is spun on the server: the page asks for a spin and is
 * told which segment it stopped on, and the gun or multiplier it won goes into
 * the bank's kit for the next game. A game is played under a live session
 * (play.ts), synced every couple of seconds with the wave it is on and the
 * credits it has earned before the multiplier. The waves cannot be replayed on
 * the server (they are random and played in floating point), so a game's
 * credits are held to what the waves can pay: no more than every zombie sent
 * so far were blue and the wave in play already cleared (maxEarned), and no
 * wave reached sooner than its zombies can even arrive (reachMs). Banked at the
 * end, times the kit's multiplier drawn on the server.
 *
 * Signed out, the page keeps it all on the device, as it always has; those
 * credits are the device's and buy nothing in the Shop.
 *
 * The numbers here are the game's own (client/shotgun/game.js waveSize,
 * blueShare, nextWave and the spawn timer); a change there is a change here.
 */

/** A gun the wheel can win. */
export type WheelGun = "shotgun" | "smg" | "rifle";
export type Prize = { kind: "gun"; gun: WheelGun } | { kind: "credits"; n: number } | { kind: "mult"; x: number };

/** The wheel's twelve equal segments, clockwise from the top. */
export const SEGMENTS: readonly Prize[] = [
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

/** What a gun won at the wheel starts the game with: twice a crate's ammo (game.js GUNS). */
export const WHEEL_AMMO: Record<WheelGun, number> = { shotgun: 48, smg: 320, rifle: 60 };

/** What the wheel has won for the next game. */
export interface Kit {
  gun: WheelGun | null;
  ammo: number;
  mult: number;
}

export const emptyKit = (): Kit => ({ gun: null, ammo: 0, mult: 1 });

/** The most a kit's multiplier may grow to; past it, more multipliers add nothing. */
export const MAX_MULT = 1000;
/** No bank grows past this; it keeps every sum a safe integer in Postgres. */
export const MAX_CREDITS = 1_000_000_000;
/** What one Shotgun badge costs, in credits (shop.ts SHOTGUN_BADGES). */
export const BADGE_PRICE = 10_000;

/** The next spin's price after `spins` since the last game: the first free, then 20, 40, 80… */
export function spinPrice(spins: number): number {
  return spins === 0 ? 0 : 20 * 2 ** (spins - 1);
}

/**
 * A bank after a spin that stopped on `prize`: credits paid at once, a gun
 * into the kit (more ammo when it is the gun already there), or a multiplier
 * multiplied in.
 */
export function applyPrize(bank: { credits: number; kit: Kit }, prize: Prize): { credits: number; kit: Kit } {
  const kit = { ...bank.kit };
  let credits = bank.credits;
  if (prize.kind === "gun") {
    kit.ammo = kit.gun === prize.gun ? kit.ammo + WHEEL_AMMO[prize.gun] : WHEEL_AMMO[prize.gun];
    kit.gun = prize.gun;
  } else if (prize.kind === "credits") {
    credits = Math.min(MAX_CREDITS, credits + prize.n);
  } else {
    kit.mult = Math.min(MAX_MULT, Math.round(kit.mult * prize.x * 100) / 100);
  }
  return { credits, kit };
}

/** How many zombies wave `w` sends. */
export const waveSize = (w: number) => 5 + w * 3;
/** Whether wave `w` sends any blue zombies (3 credits each; the rest are 1). */
const hasBlue = (w: number) => w >= 3;

/** The most a game can have earned, before its multiplier, by the end of wave `w`: every zombie blue where any can be, and each wave's bonus. */
export function maxEarned(w: number): number {
  let sum = 0;
  for (let k = 1; k <= w; k++) sum += waveSize(k) * (hasBlue(k) ? 3 : 1) + k;
  return sum;
}

/** Seconds from a game's start to its first wave, and between a cleared wave and the next (game.js BETWEEN). */
const FIRST = 0.9;
const BETWEEN = 2.6;

/**
 * The least time, in milliseconds, before wave `w` can start: every earlier
 * wave's zombies have to arrive, each at the spawn timer's quickest, and the
 * pause after each be waited out. Killing them takes no time at all here.
 */
export function reachMs(w: number): number {
  let s = w >= 1 ? FIRST : 0;
  for (let k = 1; k < w; k++) {
    const gap = Math.max(0.3, 1.5 - k * 0.11) * 0.6;
    s += 0.4 + (waveSize(k) - 1) * gap + BETWEEN;
  }
  return s * 1000;
}

/** No game is believed past this wave. */
export const MAX_WAVE = 400;
