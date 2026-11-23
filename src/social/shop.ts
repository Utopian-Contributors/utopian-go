/**
 * The Shop: what can be worn after a name. A badge (a coloured check, or a
 * picture of one's own) and a status (a fruit and its words), one of each.
 * Each is sold in a pack, paid by Solana Pay as an ad is (src/social/adPay.ts).
 *
 * Every id here is also a file name: /bd-<badge>.svg and /st-<status>.svg are
 * drawn by scripts/skeu-icons.mjs, and client/js/marks.js has the words.
 */

export const BADGES = ["blue", "green", "red", "orange", "yellow", "purple", "pink", "black", "white"] as const;

export const STATUSES = {
  vanilla: "Chilling Vanilla",
  mango: "Good Mango",
  banana: "Top Banana",
  cherry: "Cherry on Top",
  grape: "Grape Job",
  orange: "Main Squeeze",
  peach: "Feeling Peachy",
  avocado: "Holy Guacamole",
  apple: "Apple of My Eye",
  lime: "In the Limelight",
} as const;

export type Pack = "checks" | "fruit" | "custom";

/**
 * Badges won, not bought: a set for each game with a leaderboard, earned by a
 * place on it when a game ends (src/social/play.ts). Each is worn as a badge
 * is, /bd-<id>.svg. The first is the rarest; see TIERS.
 */
export const GAME_BADGES = {
  snake: [
    { id: "sn1", name: "Golden Cobra" },
    { id: "sn2", name: "Ruby Viper" },
    { id: "sn3", name: "Emerald Mamba" },
    { id: "sn4", name: "Sapphire Python" },
    { id: "sn5", name: "Garden Snake" },
  ],
  pinball: [
    { id: "pb1", name: "Gold Shroom" },
    { id: "pb2", name: "Fly Agaric" },
    { id: "pb3", name: "Amethyst Cap" },
    { id: "pb4", name: "Blue Bumper" },
    { id: "pb5", name: "Porcini" },
  ],
} as const;

export type BoardGame = keyof typeof GAME_BADGES;

/**
 * How each game wears its badges: equipped, a snake badge colours the snake
 * (body and eyes) and a mushroom badge the pinball table's mushroom bumpers
 * (their caps, and whether they are spotted), as the badge is drawn.
 */
export const SNAKE_SKINS: Record<string, { body: string; eye: string }> = {
  sn1: { body: "#f2b51c", eye: "#ff4b3a" },
  sn2: { body: "#e0213a", eye: "#ffd23a" },
  sn3: { body: "#22b84a", eye: "#f4ff6a" },
  sn4: { body: "#2f7fe0", eye: "#ffb13a" },
  sn5: { body: "#7f9a2e", eye: "#f5c542" },
};
export const MUSHROOM_SKINS: Record<string, { cap: string; spots: boolean }> = {
  pb1: { cap: "#f0b41a", spots: true },
  pb2: { cap: "#e5262a", spots: true },
  pb3: { cap: "#9a4ae0", spots: true },
  pb4: { cap: "#2f8ae8", spots: true },
  pb5: { cap: "#9a5b2c", spots: false },
};

/** The places each badge of a set is for: #1, #2, #3, #4–6 and #7–10, the top ten. */
export const TIERS = [
  { from: 1, to: 1 },
  { from: 2, to: 2 },
  { from: 3, to: 3 },
  { from: 4, to: 6 },
  { from: 7, to: 10 },
] as const;

/**
 * The badges a place on `game`'s board unlocks: its own tier's and every
 * commoner one's, so a better place later unlocks the rarer ones too. None
 * past tenth.
 */
export function badgesForRank(game: BoardGame, rank: number): string[] {
  const tier = TIERS.findIndex((t) => rank >= t.from && rank <= t.to);
  return tier < 0 ? [] : GAME_BADGES[game].slice(tier).map((badge) => `bd:${badge.id}`);
}

/** Every won badge's id, with the game and the places it is for. */
export const WON_BADGES: Record<string, { game: BoardGame; name: string; from: number; to: number }> = Object.fromEntries(
  (Object.keys(GAME_BADGES) as BoardGame[]).flatMap((game) =>
    GAME_BADGES[game].map((badge, i) => [badge.id, { game, name: badge.name, ...TIERS[i] }]),
  ),
);

/** What each pack costs, in cents. */
export const PACKS: Record<Pack, { cents: number; title: string }> = {
  checks: { cents: 500, title: "Checkmarks" },
  fruit: { cents: 500, title: "Fruit statuses" },
  custom: { cents: 300, title: "Your own badge" },
};

/** A custom badge: a square PNG, this wide, and no heavier. */
export const BADGE_PX = 64;
export const BADGE_BYTES = 20 * 1024;

export function isPack(value: unknown): value is Pack {
  return typeof value === "string" && Object.hasOwn(PACKS, value);
}

/**
 * The badge column a choice becomes, or null when it is not one `owned`
 * allows. "u" is one's own picture, kept as "u" and its revision so the
 * picture's address changes with it; "" wears none.
 */
export function badgeFor(choice: unknown, owned: Pack[], rev: number, items: string[] = []): string | null {
  if (choice === "") return "";
  if (choice === "u") return owned.includes("custom") && rev > 0 ? `u${rev}` : null;
  if (typeof choice === "string" && Object.hasOwn(WON_BADGES, choice)) return items.includes(`bd:${choice}`) ? choice : null;
  return (BADGES as readonly unknown[]).includes(choice) && owned.includes("checks") ? (choice as string) : null;
}

/** A status is worn from the Fruit statuses pack, or on its own: bought with Fruit Slots credits, or given (`st:<fruit>` in `items`). */
export function statusFor(choice: unknown, owned: Pack[], items: string[] = []): string | null {
  if (choice === "") return "";
  if (typeof choice !== "string" || !Object.hasOwn(STATUSES, choice)) return null;
  return owned.includes("fruit") || items.includes(`st:${choice}`) ? choice : null;
}

export function isStatus(value: unknown): value is keyof typeof STATUSES {
  return typeof value === "string" && Object.hasOwn(STATUSES, value);
}

/** Whether `bytes` are a PNG `BADGE_PX` square: its signature, then IHDR's width and height. */
export function isBadgePng(bytes: Buffer): boolean {
  const SIGNATURE = "89504e470d0a1a0a";
  if (bytes.length < 24 || bytes.length > BADGE_BYTES) return false;
  if (bytes.subarray(0, 8).toString("hex") !== SIGNATURE || bytes.subarray(12, 16).toString("latin1") !== "IHDR") return false;
  return bytes.readUInt32BE(16) === BADGE_PX && bytes.readUInt32BE(20) === BADGE_PX;
}

/** What `user` wears after their name, as MARK in db.ts spells it; undefined for nothing. */
export function markOf(user: { badge?: string; status?: string }): string | undefined {
  const mark = `${user.badge ?? ""} ${user.status ?? ""}`;
  return mark === " " ? undefined : mark;
}

/** Where a badge's picture is: a colour's drawing, or `name`'s own at its revision. */
/**
 * The badge drawings' version, in every address they are linked by. The files
 * are cached for a week (by the CDN, browsers and the service worker) under
 * their address, so a redrawn badge only reaches anyone under a new one: bump
 * this whenever a client/bd-*.svg changes.
 */
export const BADGE_ART = 4;

export function badgeSrc(name: string, badge: string): string {
  return badge[0] === "u" ? `/social/k/${name}?v=${badge.slice(1)}` : `/bd-${badge}.svg?v=${BADGE_ART}`;
}
