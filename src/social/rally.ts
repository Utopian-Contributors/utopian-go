/**
 * Rally: the course, and the rules its races and credits are kept by, shared
 * by the server, which keeps a signed-in driver's credits and the board of
 * lap times, and the page (client/rally), which drives it.
 *
 * The course itself, and the limits that hang on it, are rallyTrack.ts; this
 * file is only the rules, so the Shop can name the badges without the course.
 *
 * A race is one lap from a standing start. Every coin on the course is a
 * credit, and finishing pays FINISH_BONUS more. Signed in, the race is played
 * under a live session (play.ts), synced every couple of seconds with the
 * checkpoints passed and the coins collected, held to what the course allows:
 * no checkpoint sooner than the car could get there flat out, no more coins
 * than lie before the next one. Its time goes on the board, its credits into
 * the bank, which buys the cars and the badges.
 */

/* ---------------------------------------------------------------- the rules */

/** A car's body style (client/rally/scene.js draws each): a rally hatch, a sports coupe, a GT racer, a hypercar, a Le Mans prototype. */
export type CarShape = "rally" | "coupe" | "gt" | "hyper" | "lmp";

/** A car: its body style and its paint, what the store sells and the page draws. */
export interface CarDesign {
  id: string;
  name: string;
  price: number;
  shape: CarShape;
  body: string;
  stripe: string;
  roof: string;
  /** The wing in the stripe's colour rather than the body's (the hypercars'). */
  wing?: boolean;
}

/** The cars, the first everyone's from the start. */
export const CARS: readonly CarDesign[] = [
  { id: "red", name: "Rally Red", price: 0, shape: "rally", body: "#e5262a", stripe: "#ffffff", roof: "#e5262a" },
  { id: "sky", name: "Sky Blue", price: 150, shape: "coupe", body: "#2f8ae8", stripe: "#ffd23a", roof: "#ffffff" },
  { id: "lime", name: "Lime Rush", price: 300, shape: "gt", body: "#7bd62a", stripe: "#1c1f24", roof: "#1c1f24" },
  { id: "sunset", name: "Sunset", price: 600, shape: "hyper", body: "#ff8a1f", stripe: "#ff3d7f", roof: "#1c1f24" },
  { id: "night", name: "Midnight", price: 1000, shape: "lmp", body: "#1d2230", stripe: "#3ee6ff", roof: "#1d2230" },
  { id: "gold", name: "Gold Rush", price: 2000, shape: "hyper", body: "#f0b41a", stripe: "#1c1f24", roof: "#1c1f24", wing: true },
];

export const carById = (id: unknown): CarDesign | undefined => CARS.find((car) => car.id === id);

/**
 * Badges bought with Rally credits, one at a time, worn as any badge is,
 * /bd-<id>.svg (drawn by hand as Shotgun's are).
 */
export const RALLY_BADGES = [
  { id: "rl1", name: "Checkered Flag" },
  { id: "rl2", name: "Steering Wheel" },
  { id: "rl3", name: "Speedometer" },
  { id: "rl4", name: "Rally Tyre" },
  { id: "rl5", name: "Trophy" },
] as const;

/** What one Rally badge costs, in credits. */
export const BADGE_PRICE = 2500;

export function isRallyBadge(value: unknown): boolean {
  return RALLY_BADGES.some((badge) => badge.id === value);
}

/**
 * What `item` costs, as the store names it: `car:<id>` or `bd:<id>`; null
 * for nothing it sells (the free car is never bought).
 */
export function priceOf(item: unknown): number | null {
  if (typeof item !== "string") return null;
  if (item.startsWith("car:")) {
    const car = carById(item.slice(4));
    return car && car.price > 0 ? car.price : null;
  }
  if (item.startsWith("bd:") && isRallyBadge(item.slice(3))) return BADGE_PRICE;
  return null;
}

/** Finishing a lap pays this on top of its coins. */
export const FINISH_BONUS = 25;
/** No bank grows past this; it keeps every sum a safe integer in Postgres. */
export const MAX_CREDITS = 1_000_000_000;
/** The checkpoints a lap is cut into; the last is the line. */
export const CHECKPOINTS = 16;
/**
 * Faster than any car goes, boosting downhill: no checkpoint is believed
 * reached sooner than this would take, in metres a second.
 */
export const FLAT_OUT = 90;
/** How long a race may take and still go on the board: ten minutes. */
export const MAX_LAP_MS = 10 * 60_000;

/** A lap time as the board shows it: 1:04.37. */
export function lapTime(ms: number): string {
  const cs = Math.max(0, Math.round(ms / 10));
  const m = Math.floor(cs / 6000);
  const s = Math.floor(cs / 100) % 60;
  return `${m}:${String(s).padStart(2, "0")}.${String(cs % 100).padStart(2, "0")}`;
}
