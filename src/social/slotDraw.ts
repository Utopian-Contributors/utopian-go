/**
 * Where a slot game's reels stop: decided by the server alone, from a secret
 * drawn for the game when it starts. Spin n of a game stops where the
 * HMAC-SHA256 of its number under that secret says, so a game is fixed from
 * its first spin (deterministic, and checkable afterwards), yet nobody who
 * lacks the secret can tell what comes next. The page is told only the
 * secret's SHA-256 (`commit`) while the game runs, and the secret itself once
 * it is over, so a player can replay every spin and see nothing was changed.
 */
import { createHash, createHmac, randomBytes } from "crypto";
import { REELS } from "./slots";

export function newSeed(): { seed: string; commit: string } {
  const seed = randomBytes(32).toString("hex");
  return { seed, commit: commitOf(seed) };
}

export function commitOf(seed: string): string {
  return createHash("sha256").update(Buffer.from(seed, "hex")).digest("hex");
}

/**
 * The stops of spin `n` (0 for a game's first). Each reel takes four bytes of
 * the digest; a value past the last whole multiple of the reel's length is
 * passed over rather than folded in, so every stop is exactly as likely.
 */
export function drawStops(seed: string, n: number): number[] {
  const key = Buffer.from(seed, "hex");
  const stops: number[] = [];
  for (let round = 0; stops.length < REELS.length; round++) {
    const digest = createHmac("sha256", key).update(`spin:${n}:${round}`).digest();
    for (let at = 0; at + 4 <= digest.length && stops.length < REELS.length; at += 4) {
      const size = REELS[stops.length].length;
      const value = digest.readUInt32BE(at);
      if (value < Math.floor(0x1_0000_0000 / size) * size) stops.push(value % size);
    }
  }
  return stops;
}
