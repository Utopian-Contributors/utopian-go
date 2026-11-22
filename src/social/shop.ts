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
  grape: "Grape Expectations",
  orange: "Main Squeeze",
  peach: "Feeling Peachy",
  avocado: "Holy Guacamole",
  apple: "Apple of My Eye",
  lime: "In the Limelight",
} as const;

export type Pack = "checks" | "fruit" | "custom";

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
export function badgeFor(choice: unknown, owned: Pack[], rev: number): string | null {
  if (choice === "") return "";
  if (choice === "u") return owned.includes("custom") && rev > 0 ? `u${rev}` : null;
  return (BADGES as readonly unknown[]).includes(choice) && owned.includes("checks") ? (choice as string) : null;
}

export function statusFor(choice: unknown, owned: Pack[]): string | null {
  if (choice === "") return "";
  return typeof choice === "string" && Object.hasOwn(STATUSES, choice) && owned.includes("fruit") ? choice : null;
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
export function badgeSrc(name: string, badge: string): string {
  return badge[0] === "u" ? `/social/k/${name}?v=${badge.slice(1)}` : `/bd-${badge}.svg`;
}
