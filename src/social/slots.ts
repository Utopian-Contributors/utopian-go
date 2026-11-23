/**
 * Fruit Slots: the rules, shared by the server, which plays every spin, and
 * the page (client/slots), which only shows them.
 *
 * Three reels of the Shop's ten fruit statuses (src/social/shop.ts STATUSES,
 * drawn as /st-<fruit>.svg), one line across the middle. A game starts with
 * START credits; each spin stakes one of BETS and pays the bet times what the
 * line shows (THREE, CHERRIES). The balance is kept, from visit to visit,
 * until it is too small for the smallest bet: then the game is lost, and a
 * fresh START comes once a day (UTC, GAMES_A_DAY). Every STATUS_PRICE credits
 * buy one of the ten fruit statuses, to wear or to give. The board is each
 * account's highest balance.
 *
 * The odds, worked out exactly over every stop (src/social/social.test.ts
 * checks them): the line pays back 93.9% of what is staked, and pays
 * something on 42% of spins, most of it a cherry's bet back. From START, a
 * balance reaches 1,000 about one time in 40 at the smallest bet and one in
 * 20 at the largest: possible, never easy.
 */

export const FRUITS = ["cherry", "lime", "orange", "apple", "grape", "peach", "mango", "avocado", "vanilla", "banana"] as const;
export type Fruit = (typeof FRUITS)[number];

/** How many of each fruit are on a reel: 31 stops, the commoner fruits paying less. */
export const WEIGHTS: Record<Fruit, number> = {
  cherry: 5,
  lime: 5,
  orange: 4,
  apple: 4,
  grape: 3,
  peach: 3,
  mango: 3,
  avocado: 2,
  vanilla: 1,
  banana: 1,
};

/** Three of a fruit on the line pays the bet this many times. Top Banana is the rarest. */
export const THREE: Record<Fruit, number> = {
  banana: 500,
  vanilla: 200,
  avocado: 75,
  mango: 30,
  peach: 30,
  grape: 30,
  cherry: 25,
  apple: 15,
  orange: 15,
  lime: 10,
};

/** Short of three, cherries anywhere on the line pay: none, one (the bet back), two. */
export const CHERRIES = [0, 1, 4] as const;

export const BETS = [5, 10, 25] as const;
export type Bet = (typeof BETS)[number];

export const START = 100;
/** What one fruit status costs, in credits. */
export const STATUS_PRICE = 1000;
/** No balance grows past this; it keeps every sum a safe integer in Postgres. */
export const MAX_CREDITS = 1_000_000_000;
/** Fresh starts an account, a day. */
export const GAMES_A_DAY = 1;
export const DAY_MS = 86_400_000;

/** A small fixed generator, so every reel is laid out the same on the server and the page. */
function mulberry(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/**
 * One reel: every fruit WEIGHTS times, in an order fixed by `seed`, with no
 * fruit next to itself (round the loop too), so a reel never looks stuck.
 */
function reel(seed: number): Fruit[] {
  const rand = mulberry(seed);
  const stops = FRUITS.flatMap((fruit) => Array<Fruit>(WEIGHTS[fruit]).fill(fruit));
  for (;;) {
    for (let i = stops.length - 1; i > 0; i--) {
      const j = Math.floor(rand() * (i + 1));
      [stops[i], stops[j]] = [stops[j], stops[i]];
    }
    if (stops.every((fruit, i) => fruit !== stops[(i + 1) % stops.length])) return stops;
  }
}

/** The three reels. Each holds the same fruits, so each fruit is as likely on all three; only the order differs. */
export const REELS: readonly (readonly Fruit[])[] = [reel(11), reel(23), reel(37)];

export function isBet(value: unknown): value is Bet {
  return (BETS as readonly unknown[]).includes(value);
}

/** The fruits on the line when the reels stop at `stops`. */
export function lineOf(stops: readonly number[]): Fruit[] {
  return stops.map((stop, i) => REELS[i][stop]);
}

/** What a line pays, as a multiple of the bet. */
export function payout(line: readonly Fruit[]): number {
  if (line[0] === line[1] && line[1] === line[2]) return THREE[line[0]];
  return CHERRIES[line.filter((fruit) => fruit === "cherry").length] ?? 0;
}

/** The credits after a spin: the bet staked, what it won added. */
export function settle(credits: number, bet: number, times: number): number {
  return Math.min(MAX_CREDITS, credits - bet + bet * times);
}

/** Whether a game with these credits is lost: too few left for the smallest bet. */
export function isOver(credits: number): boolean {
  return credits < BETS[0];
}

/** The day, counted from 1970 in UTC, that `at` falls on; an account's games are counted per day. */
export function dayOf(at: number): number {
  return Math.floor(at / DAY_MS);
}
